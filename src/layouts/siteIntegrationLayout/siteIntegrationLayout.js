import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { Primitives } from 'znn-ts-sdk';

import useAccount from '../../services/hooks/useAccount';
import useBlockSender from '../../services/hooks/useBlockSender';
import { prepareBlockApproval, isCurrentBlockApproval } from '../../services/wallet/blockApproval';
import { signMessage } from '../../services/wallet/signMessage';
import { sendInternal } from '../../services/utils/messaging';
import {
  formatAmount,
  formatExact,
  toBigNumber,
  truncateAddress,
} from '../../services/utils/format';
import { readableError } from '../../services/utils/errors';
import { notify } from '../../services/utils/notify';
import { embeddedContractName } from '../../services/utils/contracts';
import { decodeCall, describeCall, contractDisplayName } from '../../services/utils/contractCalls';

// What a site is asking for, and the choice about it.
//
// The old version was one component holding a three-flow, three-step state
// machine in Redux, with nine nested ternaries in its render and three copies
// of the signing code. It also never showed which site was asking — the whole
// screen said "this website" — so the only way to know what you were approving
// was to remember what you had just clicked. And it indexed
// `balanceInfoMap[tokenStandard]` without a guard, so a request for a token the
// account did not hold threw before the screen drew at all.

const hostOf = (origin) => {
  try {
    return new URL(origin).host;
  } catch (err) {
    return origin || 'Unknown site';
  }
};

// What a raw account block actually does, in words, for the "sign this block?"
// screen — the one place a site can ask for literally anything.
//
// A block sent to an embedded contract is a call, not a transfer: "1 ZNN to
// the HTLC contract" is really "authorize an HTLC swap, funded with 1 ZNN",
// and describing it as a transfer buries the part that matters. A call this
// build cannot decode has to look like a warning rather than like an ordinary
// approval, because "unknown" is exactly the case where reading the raw data
// below is not optional.
const describeBlock = (json, tokenFor) => {
  const contract = embeddedContractName(json?.toAddress);
  const entry = tokenFor(json?.tokenStandard);
  const amount = json?.amount;
  const hasAmount = Boolean(amount) && amount !== '0';

  if (!contract) {
    return {
      kind: 'transfer',
      to: json?.toAddress,
      amount,
      hasAmount,
      decimals: entry?.token?.decimals,
      symbol: entry?.token?.symbol,
      tokenStandard: json?.tokenStandard,
    };
  }

  const method = decodeCall(contract, json?.data);
  const contractName = contractDisplayName(contract);

  return {
    kind: method ? 'knownCall' : 'unknownCall',
    contract: contractName,
    label: method ? describeCall(contract, method) : null,
    amount,
    hasAmount,
    decimals: entry?.token?.decimals,
    symbol: entry?.token?.symbol,
    tokenStandard: json?.tokenStandard,
  };
};

const SiteHeader = ({ request }) => (
  <div className="site-header">
    {request.favicon ? (
      <img
        className="site-favicon"
        alt=""
        src={request.favicon}
        width="28"
        height="28"
      />
    ) : (
      <div className="site-favicon site-favicon-blank" />
    )}
    <div className="site-header-text">
      <div className="site-host">{hostOf(request.origin)}</div>
      {/* Many pages title themselves after their own URL, and printing the host
          twice is noise rather than information. */}
      {request.title && request.title !== hostOf(request.origin) && (
        <div className="site-title">{request.title}</div>
      )}
    </div>
  </div>
);

const SiteIntegrationLayout = () => {
  const navigate = useNavigate();
  const { address, isUnlocked } = useSelector((state) => state.wallet);
  const { chainIdentifier, nodeUrl } = useSelector(
    (state) => state.connectionParameters
  );
  const { balanceMap } = useAccount();
  const { send, sendPrepared, isSending, isGeneratingPlasma } = useBlockSender();

  const [request, setRequest] = useState(undefined);
  const [preview, setPreview] = useState(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isWaitingForMore, setIsWaitingForMore] = useState(false);
  const live = useRef();
  live.current = { request, address, chainIdentifier, nodeUrl, isUnlocked };
  const activePreparation = useRef(null);
  const approvalInFlight = useRef(false);

  useEffect(() => () => {
    activePreparation.current = null;
  }, []);

  // A locked wallet cannot answer anything. The password screen is told where
  // to come back to so the request is not lost.
  useEffect(() => {
    if (!isUnlocked) {
      navigate('/password', {
        replace: true,
        state: { returnTo: '/site-integration' },
      });
    }
  }, [isUnlocked, navigate]);

  // How long to hold the window open on an empty queue before closing it.
  //
  // A site almost never asks for one thing. Connecting is the prelude to
  // whatever it actually wanted — a signature, a block — and it sends that the
  // instant the connect is answered, because being answered is what it was
  // waiting for. Closing on the spot meant the second request always arrived to
  // a window that had already gone: a visible flash as another one opened, and,
  // until the close handler learned which requests were its own, an outright
  // rejection of a prompt nobody had seen.
  //
  // So the window waits a beat and looks again. Long enough to cover the round
  // trip out to the page and back, short enough that a genuinely finished queue
  // does not leave an empty window sitting there.
  const CLOSE_GRACE_MS = 1200;

  const loadNext = useCallback(async () => {
    try {
      activePreparation.current = null;
      setPreview(null);
      const next = await sendInternal('approvals.next');

      if (next) {
        setRequest(next);
        return next;
      }
      setRequest(null);
      setIsWaitingForMore(true);
      await new Promise((resolve) => {
        setTimeout(resolve, CLOSE_GRACE_MS);
      });

      const late = await sendInternal('approvals.next');
      setIsWaitingForMore(false);

      if (late) {
        setRequest(late);
        return late;
      }
      // Nothing left to answer means this window was only ever open for the
      // queue, and the queue is empty.
      window.close();
      return null;
    } catch (err) {
      setIsWaitingForMore(false);
      setRequest(null);
      return null;
    }
  }, []);

  useEffect(() => {
    if (isUnlocked) {
      loadNext();
    }
  }, [isUnlocked, loadNext]);

  // A prepared approval belongs to one request and one live wallet context.
  // Identity checks in rendering and submission also cover the render before
  // this effect runs, so clearing state in the effect is not the only guard.
  useEffect(() => {
    const token = {};
    activePreparation.current = token;
    setPreview(null);
    if (!request || request.type !== 'signAndSendBlock' || !isUnlocked) return undefined;
    const isCurrent = () => activePreparation.current === token &&
      live.current.request === request && live.current.address === address &&
      live.current.chainIdentifier === chainIdentifier && live.current.nodeUrl === nodeUrl &&
      live.current.isUnlocked;
    prepareBlockApproval(request.params, { address, nodeUrl, isCurrent }).then(
      (approval) => {
        if (isCurrent()) setPreview({ request, approval });
      },
      (error) => {
        if (isCurrent()) setPreview({ request, error: readableError(error) });
      }
    );
    return () => {
      if (activePreparation.current === token) activePreparation.current = null;
    };
  }, [request, address, chainIdentifier, nodeUrl, isUnlocked]);

  const approval = preview && preview.request === request ? preview.approval : null;
  const approvalReady = isCurrentBlockApproval(approval);
  const preparedBlock = approval && (approvalReady || approvalInFlight.current) ? approval.block : null;

  const finish = async (id, result, grantOrigin = false, identity = {}) => {
    await sendInternal('approvals.resolve', { id, result, grantOrigin, ...identity });
    await loadNext();
  };

  const reject = async () => {
    if (!request || approvalInFlight.current) {
      return;
    }
    activePreparation.current = null;
    setPreview(null);
    await sendInternal('approvals.reject', { id: request.id, approvalId: request.approvalId });
    await loadNext();
  };

  //
  // Connect
  //
  const approveConnect = async () => {
    setIsBusy(true);
    try {
      await finish(request.id, [address], true);
    } finally {
      setIsBusy(false);
    }
  };

  //
  // Send a plain transfer
  //
  const tokenFor = (tokenStandard) => balanceMap[tokenStandard];

  const approveSendTransaction = async () => {
    setIsBusy(true);

    try {
      const { to, tokenStandard, amount } = request.params;
      const template = Primitives.AccountBlockTemplate.send(
        Primitives.Address.parse(to),
        Primitives.TokenStandard.parse(tokenStandard),
        amount
      );
      const signed = await send(template);

      await finish(request.id, {
        hash: signed.hash?.toString(),
        block: signed.toJson?.() ?? null,
      });
      notify.success('Transaction sent');
    } catch (err) {
      notify.error(err);
      await sendInternal('approvals.reject', {
        id: request.id,
        error: { code: -32603, message: readableError(err) },
      });
      await loadNext();
    } finally {
      setIsBusy(false);
    }
  };

  //
  // Sign a message
  //
  // The only approval here that does not touch the network: no plasma, no
  // block, nothing to broadcast. It is over as fast as an Ed25519 signature,
  // and the site gets the answer the moment the button is pressed.
  //
  const approveSignMessage = async () => {
    setIsBusy(true);

    try {
      const signed = await signMessage(request.params.message);

      await finish(request.id, signed);
      notify.success('Message signed');
    } catch (err) {
      notify.error(err);
      await sendInternal('approvals.reject', {
        id: request.id,
        error: { code: -32603, message: readableError(err) },
      });
      await loadNext();
    } finally {
      setIsBusy(false);
    }
  };

  //
  // Sign and send an arbitrary block
  //
  const approveSignAndSend = async () => {
    if (approvalInFlight.current || !isCurrentBlockApproval(approval)) return;
    approvalInFlight.current = true;
    setIsBusy(true);
    const approvedRequest = request;
    const identity = { approvalId: approvedRequest.approvalId, claimId: crypto.randomUUID() };
    let claimed = false;
    try {
      const { id: windowId } = await chrome.windows.getCurrent();
      claimed = await sendInternal('approvals.claimBlock', {
        id: approvedRequest.id, ...identity, windowId,
      });
      if (!claimed) throw new Error('This request was already answered or changed.');
      const signed = await sendPrepared(approval);
      await finish(approvedRequest.id, {
        hash: signed.hash?.toString(),
        block: signed.toJson?.() ?? null,
      }, false, identity);
      notify.success('Block sent');
    } catch (err) {
      notify.error(err);
      if (claimed) {
        await sendInternal('approvals.reject', {
          id: approvedRequest.id, ...identity,
          error: { code: -32603, message: readableError(err) },
        });
      }
      await loadNext();
    } finally {
      approvalInFlight.current = false;
      setIsBusy(false);
    }
  };

  if (request === undefined) {
    return (
      <div className="page approval-screen">
        <p className="empty-note">Loading request…</p>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="page approval-screen">
        {/* The queue is empty, but a site that has just been answered usually
            has one more thing to ask. Saying so beats flashing "Nothing to
            approve" at somebody for a second on the way to the next prompt. */}
        <p className="empty-note">
          {isWaitingForMore ? 'Waiting for the site…' : 'Nothing to approve.'}
        </p>
      </div>
    );
  }

  const busy = isBusy || isSending;
  // The site is blocked on the signed block, so this screen is the one place
  // that still waits — but it waits in place, on its own button, rather than
  // behind a modal that hides what is being approved.
  const busyLabel = isGeneratingPlasma ? 'Generating plasma…' : 'Sending…';

  // A site can ask for more than the account holds, and the wallet used to sign
  // it and let the node do the refusing — after the proof of work. Both request
  // shapes carry the amount and the token the same way, so one check covers a
  // plain transfer and an arbitrary block; a contract call with no value has an
  // amount of zero and never trips it.
  const shortfall = (() => {
    const { tokenStandard, amount } = (request.type === 'signAndSendBlock' ? preparedBlock : request.params) || {};
    const wanted = toBigNumber(amount);

    if (wanted.isZero()) {
      return null;
    }
    const entry = tokenFor(tokenStandard);

    if (!entry) {
      return 'This account holds none of that token.';
    }
    const balance = toBigNumber(entry.balance);

    if (!wanted.gt(balance)) {
      return null;
    }
    return `This account holds only ${formatAmount(
      balance,
      entry.token?.decimals
    )} ${entry.token?.symbol || ''}.`.trim();
  })();

  return (
    <div className="page approval-screen">
      <SiteHeader request={request} />

      {request.type === 'connect' && (
        <>
          <div className="approval-body">
            <h2 className="approval-title">Connect this wallet?</h2>
            <p className="approval-note">
              {hostOf(request.origin)} will be able to see your address, the
              chain you are signing for and your node URL. It cannot move
              anything without asking again.
            </p>

            <dl className="confirm-details">
              <dt>Address</dt>
              <dd className="word-break-all">{address}</dd>
              <dt>Chain</dt>
              <dd>{chainIdentifier}</dd>
              <dt>Node</dt>
              <dd className="word-break-all">{nodeUrl}</dd>
            </dl>
          </div>

          <div className="action-row sticky-actions">
            <button
              type="button"
              className="button secondary w-100"
              onClick={reject}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button primary w-100 text-white"
              onClick={approveConnect}
              disabled={busy}
            >
              Connect
            </button>
          </div>
        </>
      )}

      {request.type === 'sendTransaction' && (
        <>
          <div className="approval-body">
            <h2 className="approval-title">Confirm transfer</h2>

            {(() => {
              const { to, tokenStandard, amount } = request.params;
              // Guarded, unlike before: a token this account holds none of is a
              // perfectly ordinary request, not a crash.
              const entry = tokenFor(tokenStandard);
              const decimals = entry?.token?.decimals;
              const symbol = entry?.token?.symbol;

              return (
                <dl className="confirm-details">
                  <dt>Amount</dt>
                  <dd
                    title={
                      decimals !== undefined
                        ? formatExact(amount, decimals)
                        : undefined
                    }
                  >
                    {decimals !== undefined ? (
                      `${formatAmount(amount, decimals)} ${symbol}`
                    ) : (
                      <>
                        {amount?.toString()}{' '}
                        <span className="text-gray">base units</span>
                      </>
                    )}
                  </dd>
                  {decimals === undefined && (
                    <>
                      <dt>Token</dt>
                      <dd className="word-break-all">{tokenStandard}</dd>
                    </>
                  )}
                  <dt>To</dt>
                  <dd className="word-break-all">{to}</dd>
                  <dt>From</dt>
                  <dd title={address}>{truncateAddress(address, 10, 6)}</dd>
                </dl>
              );
            })()}

            {shortfall && (
              <p className="approval-warning" role="alert">
                Not enough balance for this transfer. {shortfall}
              </p>
            )}
          </div>

          <div className="action-row sticky-actions">
            <button
              type="button"
              className="button secondary w-100"
              onClick={reject}
              disabled={busy}
            >
              Reject
            </button>
            <button
              type="button"
              className="button primary w-100 text-white"
              onClick={approveSendTransaction}
              disabled={busy || Boolean(shortfall)}
            >
              {busy ? busyLabel : 'Confirm'}
            </button>
          </div>
        </>
      )}

      {request.type === 'signMessage' && (
        <>
          <div className="approval-body">
            <h2 className="approval-title">Sign this message?</h2>
            <p className="approval-note">
              A signature proves this address is yours. It moves nothing, costs
              no plasma and is never published — but only sign what you can
              read, and only for a site you meant to sign in to.
            </p>

            {/* Verbatim, wrapped, and never interpreted: the point of this
                panel is that what gets signed is what is on screen. */}
            <pre className="message-preview">{request.params.message}</pre>

            <dl className="confirm-details">
              <dt>Signing as</dt>
              <dd title={address}>{truncateAddress(address, 10, 6)}</dd>
            </dl>
          </div>

          <div className="action-row sticky-actions">
            <button
              type="button"
              className="button secondary w-100"
              onClick={reject}
              disabled={busy}
            >
              Reject
            </button>
            <button
              type="button"
              className="button primary w-100 text-white"
              onClick={approveSignMessage}
              disabled={busy}
            >
              {isBusy ? 'Signing…' : 'Sign'}
            </button>
          </div>
        </>
      )}

      {request.type === 'signAndSendBlock' && (
        <>
          <div className="approval-body">
            <h2 className="approval-title">Sign this block?</h2>

            {preparedBlock ? (() => {
              const json = preparedBlock;
              const info = describeBlock(json, tokenFor);
              const amountRow = info.hasAmount && (
                <>
                  <dt>Amount</dt>
                  <dd
                    title={
                      info.decimals !== undefined
                        ? formatExact(info.amount, info.decimals)
                        : undefined
                    }
                  >
                    {info.decimals !== undefined ? (
                      `${formatAmount(info.amount, info.decimals)} ${info.symbol}`
                    ) : (
                      <>
                        {info.amount?.toString()}{' '}
                        <span className="text-gray">base units</span>
                      </>
                    )}
                  </dd>
                </>
              );

              if (info.kind === 'unknownCall') {
                return (
                  <>
                    <p className="approval-warning" role="alert">
                      This calls the {info.contract} contract with a method
                      this wallet does not recognize. Read the raw data below
                      before approving.
                    </p>
                    <dl className="confirm-details">
                      <dt>Contract</dt>
                      <dd>{info.contract}</dd>
                      {amountRow}
                    </dl>
                  </>
                );
              }

              if (info.kind === 'knownCall') {
                return (
                  <>
                    <p className="approval-note">
                      This calls the embedded {info.contract} contract.
                    </p>
                    <dl className="confirm-details">
                      <dt>Action</dt>
                      <dd>{info.label}</dd>
                      <dt>Contract</dt>
                      <dd>{info.contract}</dd>
                      {amountRow}
                    </dl>
                  </>
                );
              }

              return (
                <>
                  <p className="approval-note">
                    This is a plain transfer to an ordinary address. Not a
                    contract call.
                  </p>
                  <dl className="confirm-details">
                    {amountRow || (
                      <>
                        <dt>Amount</dt>
                        <dd>Nothing</dd>
                      </>
                    )}
                    <dt>To</dt>
                    <dd className="word-break-all">{info.to}</dd>
                    <dt>From</dt>
                    <dd title={address}>{truncateAddress(address, 10, 6)}</dd>
                  </dl>
                </>
              );
            })() : (
              <p className="approval-warning" role="status">
                {preview?.request === request && preview.error
                  ? `Unable to prepare this block: ${preview.error}`
                  : preview?.request === request && preview.approval
                    ? 'The wallet or connection changed. Reject this request and review a new one.'
                    : 'Preparing this block for review…'}
              </p>
            )}

            {preparedBlock && (
              <>
                <dl className="confirm-details">
                  <dt>Signing as</dt>
                  <dd className="word-break-all">{preparedBlock.address}</dd>
                  <dt>Chain</dt>
                  <dd>{JSON.stringify(preparedBlock.chainIdentifier)}</dd>
                  <dt>Node</dt>
                  <dd className="word-break-all">{approval.nodeUrl}</dd>
                </dl>
                <details className="block-preview-details">
                  <summary>Raw transaction data</summary>
                  <pre className="block-preview">
                    {JSON.stringify(approval.details, null, 2)}
                  </pre>
                </details>
                <p className="approval-note">Plasma proof, transaction hash and signature are generated after approval.</p>
              </>
            )}

            {shortfall && (
              <p className="approval-warning" role="alert">
                Not enough balance for this block. {shortfall}
              </p>
            )}
          </div>

          <div className="action-row sticky-actions">
            <button
              type="button"
              className="button secondary w-100"
              onClick={reject}
              disabled={busy}
            >
              Reject
            </button>
            <button
              type="button"
              className="button warning w-100"
              onClick={approveSignAndSend}
              disabled={busy || !approvalReady || Boolean(shortfall)}
            >
              {busy ? busyLabel : 'Sign and send'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default SiteIntegrationLayout;
