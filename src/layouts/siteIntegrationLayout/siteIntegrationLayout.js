import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { Primitives } from 'znn-ts-sdk';

import TokenAmount from '../../components/token-amount/token-amount';
import { authorizationMetadata, normalizeBaseUnits } from '../../services/wallet/tokenMetadata';
import useAccount from '../../services/hooks/useAccount';
import useBlockSender from '../../services/hooks/useBlockSender';
import vault from '../../services/wallet/vault';
import selection from '../../services/wallet/selection';
import ContractCallArguments from '../../components/contract-call-arguments/contract-call-arguments';
import { signMessage } from '../../services/wallet/signMessage';
import { sendInternal } from '../../services/utils/messaging';
import publicNodeUrl from '../../services/utils/publicNodeUrl';
import { identityOf, freezeApproval, approvalEnded, matchesApproval } from '../../services/utils/approvalIdentity';
import withApprovalDeadline from '../../services/utils/approvalDeadline';
import { runApprovalOperation } from '../../services/wallet/approvalOperation';
import { prepareBlockApproval, isCurrentBlockApproval } from '../../services/wallet/blockApproval';
import {
  formatExact,
  toBigNumber,
  truncateAddress,
} from '../../services/utils/format';
import { readableError } from '../../services/utils/errors';
import { notify } from '../../services/utils/notify';
import { decodeApprovalCall } from '../../services/utils/approvalContractCalls';

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
//
// Every argument of a known call is decoded exactly (approvalContractCalls.js);
// anything it cannot decode strictly is an unknown call. Token details come
// from the canonical metadata (TokenAmount), never from the node.
const describeBlock = (json) => ({
  ...decodeApprovalCall(json),
  amount: json?.amount,
  hasAmount: Boolean(json?.amount) && json.amount !== '0',
  tokenStandard: json?.tokenStandard,
});

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
  const { address: selectedAddress, isUnlocked } = useSelector((state) => state.wallet);
  const { chainIdentifier, nodeUrl } = useSelector(
    (state) => state.connectionParameters
  );
  const { balanceMap } = useAccount();
  const { send, isSending, isGeneratingPlasma } = useBlockSender();

  const [request, setRequest] = useState(undefined);
  const address = request?.binding?.scope.address || selectedAddress;
  const [preview, setPreview] = useState(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isWaitingForMore, setIsWaitingForMore] = useState(false);
  const rendered = useRef(null), operation = useRef(null), discarded = useRef(null), mounted = useRef(true), previewOwner = useRef(null);
  rendered.current = { request, address, isUnlocked, chainIdentifier, nodeUrl };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // The view is current only while the wallet account the request is bound to
  // is still this window's view of the shared selection, and before its deadline.
  const currentView = selected => selected?.binding && vault.getBinding() === selected.binding &&
    selected.binding.id === selected.request?.binding?.id && selection.sameScope(selected.binding.scope, selected.request.binding.scope) &&
    mounted.current && selected?.request && discarded.current !== selected.request &&
    selected.request.expiresAt > Date.now() &&
    rendered.current.request === selected.request && rendered.current.isUnlocked &&
    rendered.current.address === selected.address && rendered.current.chainIdentifier === selected.chainIdentifier &&
    rendered.current.nodeUrl === selected.nodeUrl;


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
      const value = await sendInternal('approvals.next', { binding: vault.getBinding() });
      if (!mounted.current) return null;
      const next = value ? freezeApproval(value) : null;

      if (next) {
        setRequest(next);
        return next;
      }
      setRequest(null);
      setIsWaitingForMore(true);
      await new Promise((resolve) => {
        setTimeout(resolve, CLOSE_GRACE_MS);
      });

      const lateValue = await sendInternal('approvals.next', { binding: vault.getBinding() });
      if (!mounted.current) return null;
      const late = lateValue ? freezeApproval(lateValue) : null;
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
      if (!mounted.current) return null;
      setIsWaitingForMore(false);
      setRequest(null);
      notify.error(err);
      navigate('/password', { replace: true, state: { returnTo: '/site-integration' } });
      return null;
    }
  }, [navigate]);

  useEffect(() => {
    if (isUnlocked) {
      loadNext();
    }
  }, [isUnlocked, selectedAddress, loadNext]);

  // The worker removes a request whose page navigated away, was closed or
  // left. Drop it from view at once rather than offer an approval for a page
  // that is gone; an approval already under way settles on its own.
  useEffect(() => {
    if (!isUnlocked) return undefined;
    const changed = (changes, area) => {
      if (area !== 'session' || !changes['znn.pendingRequests']) return;
      const shown = rendered.current.request;
      if (!shown || operation.current) return;
      const stored = changes['znn.pendingRequests'].newValue?.[shown.id];
      if (!matchesApproval(stored, identityOf(shown))) {
        discarded.current = shown;
        loadNext();
      }
    };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, [isUnlocked, loadNext]);

  useEffect(() => {
    if (!request) return undefined;
    const timer = setTimeout(() => {
      // A saved callback and a busy SDK operation lose local authority too.
      discarded.current = request;
      if (!operation.current) {
        notify.error(new Error('This approval expired. Ask the site for a new request.'));
        loadNext();
      }
    }, Math.max(0, request.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [request, loadNext]);

  // For an arbitrary account block, what will actually be signed: prepared
  // once, with the fields the SDK fills in (chain, height, previous hash)
  // resolved, frozen, and bound to this request and wallet account. There is
  // no fallback to the page's own JSON: approval waits for the preparation, and
  // it is that preparation which is signed (blockApproval.js).
  useEffect(() => {
    setPreview(null);
    if (!request || request.type !== 'signAndSendBlock' || !isUnlocked) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    previewOwner.current = controller;
    const binding = vault.getBinding();
    const isCurrent = () => !cancelled && rendered.current.request === request &&
      vault.getBinding() === binding && binding?.id === request.binding?.id;
    prepareBlockApproval(request.params, {
      address: request.binding.scope.address, index: request.binding.scope.index, nodeUrl,
      isCurrent, expiresAt: request.expiresAt, signal: controller.signal,
    }).then(
      (approval) => { if (!cancelled) setPreview({ request, approval }); },
      (error) => { if (!cancelled) setPreview({ request, error: readableError(error) }); }
    );

    return () => {
      cancelled = true;
      controller.abort();
      if (previewOwner.current === controller) previewOwner.current = null;
    };
  }, [request, isUnlocked, chainIdentifier, nodeUrl]);
  const previewed = preview && request && preview.request === request ? preview : null;
  const blockApproval = previewed?.approval ?? null;
  const approvalReady = isCurrentBlockApproval(blockApproval);
  const preparedBlock = blockApproval && (approvalReady || isBusy) ? blockApproval.block : null;

  const approve = async (execute, success) => {
    const selected = { request, address, chainIdentifier, nodeUrl, binding: vault.getBinding() };
    if (operation.current || !currentView(selected)) return;
    previewOwner.current?.abort();
    const active = { kind: 'approval', selected, identity: identityOf(request), claimed: false, submitted: false };
    operation.current = active;
    setIsBusy(true);
    const localCurrent = () => operation.current === active && currentView(selected);
    const assertRequest = async () => {
      if (!localCurrent() || !active.claimed) throw approvalEnded();
      if (!(await sendInternal('approvals.checkClaim', { identity: active.identity })) || !localCurrent()) throw approvalEnded();
    };
    try {
      const { id: windowId } = await chrome.windows.getCurrent();
      if (!localCurrent()) throw approvalEnded();
      const claim = await sendInternal('approvals.claim', { identity: active.identity, windowId });
      if (!claim) throw approvalEnded();
      active.identity = claim;
      active.claimed = true;
      await assertRequest();
      const result = await withApprovalDeadline(
        execute(selected.request, assertRequest, selected.binding, () => { active.submitted = true; }),
        selected.request.expiresAt);
      await assertRequest();
      if (!(await sendInternal('approvals.resolve', { identity: active.identity, result }))) throw approvalEnded();
      if (success) notify.success(success);
    } catch (error) {
      // Selection/permission may change after publication starts, including
      // between the SDK returning and the worker settling this request.
      const reported = active.submitted
        ? new Error('The transaction may have been submitted. Its outcome is unknown. Check the original account before retrying.') : error;
      notify.error(reported);
      // Unclaimed stale requests can be retired too. The queue refuses an
      // unclaimed identity if another popup owns it, preserving the winner.
      try {
        await sendInternal('approvals.reject', { identity: active.identity,
          error: { code: -32603, message: readableError(reported) } });
      } catch (cleanupError) { notify.error(cleanupError); }
    } finally {
      if (operation.current === active) {
        discarded.current = selected.request;
        if (mounted.current) await loadNext();
        operation.current = null;
        if (mounted.current) setIsBusy(false);
      }
    }
  };
  const reject = async () => {
    const selected = { request, address, chainIdentifier, nodeUrl, binding: vault.getBinding() };
    if (operation.current || !currentView(selected)) return;
    const active = { kind: 'rejection', selected };
    operation.current = active;
    discarded.current = request; // Invalidate copied callbacks before messaging/render.
    setIsBusy(true);
    try {
      if (!(await sendInternal('approvals.reject', { identity: identityOf(request) }))) throw approvalEnded();
    } catch (error) { notify.error(error); }
    finally {
      if (operation.current === active) {
        if (mounted.current) await loadNext();
        operation.current = null;
        if (mounted.current) setIsBusy(false);
      }
    }
  };

  const tokenFor = tokenStandard => balanceMap[tokenStandard];
  const approveConnect = () => approve(async () => [address]);
  const blockResult = signed => ({ hash: signed.hash?.toString(), block: signed.toJson?.() ?? null });
  // Token identity and amount go through the canonical metadata path: the
  // amount is exact base units, never reinterpreted by RPC token metadata. Keys
  // are the bound account's, checked against the selection at every use.
  const approveSendTransaction = () => approve(async (selected, assertRequest, binding, onSubmitted) => {
    const { to, tokenStandard, amount } = selected.params;
    authorizationMetadata(tokenStandard);
    const template = Primitives.AccountBlockTemplate.send(Primitives.Address.parse(to),
      Primitives.TokenStandard.parse(tokenStandard), toBigNumber(normalizeBaseUnits(amount)));
    return blockResult(await send(template, { assertRequest, expiresAt: selected.expiresAt,
      binding, onSubmitted, addressIndex: binding.scope.index }));
  }, 'Transaction sent');
  // The only approval here that does not touch the network: no plasma, no
  // block, nothing to broadcast.
  const approveSignMessage = () => approve((selected, assertRequest, binding) =>
    runApprovalOperation(selected.expiresAt, active => signMessage(selected.params.message,
      { assertRequest: active.assertActive, binding, addressIndex: binding.scope.index }),
    { assertRequest }), 'Message signed');
  // Signs the reviewed preparation, never the page's JSON filled in again.
  const approveSignAndSend = () => {
    const prepared = approvalReady ? blockApproval : null;
    if (!prepared) return undefined;
    return approve(async (selected, assertRequest, binding, onSubmitted) =>
      blockResult(await send(null, { assertRequest, expiresAt: selected.expiresAt,
        binding, onSubmitted, addressIndex: binding.scope.index, prepared })), 'Block sent');
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
    if (!['sendTransaction', 'signAndSendBlock'].includes(request.type)) {
      return null;
    }
    // An arbitrary block is judged by the block that will be signed.
    const { tokenStandard, amount } = (request.type === 'signAndSendBlock' ? preparedBlock : request.params) || {};
    if (request.type === 'signAndSendBlock' && !preparedBlock) return null;
    let wanted;
    let metadata;
    try {
      metadata = authorizationMetadata(tokenStandard);
      wanted = toBigNumber(normalizeBaseUnits(amount));
    } catch (err) {
      return 'Invalid amount or token identifier.';
    }

    if (wanted.isZero()) {
      return null;
    }
    const entry = tokenFor(metadata.tokenStandard);

    if (!entry) {
      return 'This account holds none of that token.';
    }
    const balance = toBigNumber(entry.balance);

    if (!wanted.gt(balance)) {
      return null;
    }
    return `This account holds only ${formatExact(balance, metadata.decimals)} ${metadata.symbol}.`;
  })();

  return (
    <div className="page approval-screen">
      <SiteHeader request={request} />
      <div className="approval-body">
        <strong>{request.binding.scope.walletName} · Account {request.binding.scope.index + 1}</strong>
        <p className="word-break-all">{request.binding.scope.address}</p>
      </div>
      <p className="approval-note">This request expires at {new Date(request.expiresAt).toLocaleTimeString()}.</p>
      {busy && operation.current?.kind === 'approval' && <p className="approval-note" role="status">Your approval is being processed and can no longer be rejected.</p>}

      {request.type === 'connect' && (
        <>
          <div className="approval-body">
            <h2 className="approval-title">Connect this wallet?</h2>
            <p className="approval-note">
              {hostOf(request.origin)} will be able to see your address, the
              chain you are signing for and your node host. Private endpoint
              details stay in your wallet. It cannot move anything without
              asking again.
            </p>

            <dl className="confirm-details">
              <dt>Address</dt>
              <dd className="word-break-all">{address}</dd>
              <dt>Chain</dt>
              <dd>{chainIdentifier}</dd>
              <dt>Node host</dt>
              <dd className="word-break-all">{publicNodeUrl(nodeUrl) || 'Unavailable'}</dd>
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
              return (
                <dl className="confirm-details">
                  <TokenAmount amount={amount} tokenStandard={tokenStandard} />
                  <dt>To</dt>
                  <dd className="word-break-all">{to}</dd>
                  <dt>From</dt>
                  <dd title={address}>{truncateAddress(address, 10, 6)}</dd>
                </dl>
              );
            })()}

            {shortfall && (
              <p className="approval-warning" role="alert">
                {shortfall}
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

            {!preparedBlock ? (
              <p className={previewed?.error ? 'approval-warning' : 'approval-note'} role="status">
                {previewed?.error
                  ? `Unable to prepare this block: ${previewed.error}`
                  : blockApproval
                    ? 'The wallet or connection changed. Reject this request and review a new one.'
                    : 'Preparing this block for review…'}
              </p>
            ) : (() => {
              const json = preparedBlock;
              const info = describeBlock(json);
              const amountRow = info.hasAmount && (
                <TokenAmount amount={info.amount} tokenStandard={info.tokenStandard} />
              );

              if (info.kind === 'unknownCall') {
                return (
                  <>
                    <p className="approval-warning" role="alert">
                      This wallet cannot fully interpret this call or its data.
                      Verify the complete raw data before approving.
                    </p>
                    <dl className="confirm-details">
                      <dt>Contract</dt>
                      <dd>{info.contract}</dd>
                      <dt>Destination</dt>
                      <dd className="word-break-all">{info.to}</dd>
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
                      <dt>Method</dt>
                      <dd>{info.method}</dd>
                      <dt>Contract</dt>
                      <dd>{info.contract}</dd>
                      <dt>Destination</dt>
                      <dd className="word-break-all">{info.to}</dd>
                      {amountRow}
                    </dl>
                    <ContractCallArguments args={info.args} />
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
            })()}

            {preparedBlock && (
              <details className="block-preview-details">
                <summary>Raw transaction data</summary>
                <pre className="block-preview">
                  {JSON.stringify(preparedBlock, null, 2)}
                </pre>
              </details>
            )}

            {shortfall && (
              <p className="approval-warning" role="alert">
                {shortfall}
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
