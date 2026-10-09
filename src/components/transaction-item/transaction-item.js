import React from 'react';
import { useSelector } from 'react-redux';

import ExternalLinkIcon from '../../animated-icons/external-link/external-link';
import Icon from '../icon/icon';
import { copyToClipboard } from '../../services/utils/notify';
import { formatAmount, truncateAddress } from '../../services/utils/format';
import { transactionUrl, currentExplorerLabel } from '../../services/utils/explorer';

// One row of account history.
//
// The icon used to be picked by a twenty-line block of conditionals duplicated
// once for ZNN and once for everything else, the explorer link pointed at
// mainnet regardless of the chain the wallet was signing for, and a block the
// network had not yet settled looked exactly like one it had.

const TransactionItem = ({
  type,
  label,
  icon = 'send',
  amount,
  decimals,
  tokenSymbol,
  address,
  counterpartyName,
  hash,
  isUnconfirmed = false,
  confirmations = 0,
  displayFullAddress = false,
  isGeneratingPlasma = false,
  isFailed = false,
  error = '',
  onDismiss,
}) => {
  const chainId = useSelector((state) => state.connectionParameters.chainIdentifier);
  const explorerLink = transactionUrl(hash, chainId);
  // Naming the explorer beats "Open in explorer": it tells the user where the
  // click lands and doubles as confirmation that the setting took effect.
  const explorerHint = `Open in ${currentExplorerLabel()}${
    confirmations ? ` · ${confirmations} confirmations` : ''
  }`;

  const isIncoming = type === 'received';
  // A contract call moves no coins of its own — an unfuse, a delegation, a
  // collected reward all carry a zero-value block — so printing "0 QSR" beside
  // one reads as a transfer that failed. Zero is never worth showing.
  const shownAmount = formatAmount(amount, decimals);
  const hasAmount = amount !== null && amount !== undefined && shownAmount !== '0';

  // A call to an embedded contract is shown by the contract's name rather than
  // by forty characters of `z1qxemdedded…`, which tells nobody anything.
  const counterparty =
    counterpartyName || (displayFullAddress ? address : truncateAddress(address));

  return (
    <div
      className={`transaction ${isUnconfirmed ? 'is-unconfirmed' : ''} ${
        isGeneratingPlasma ? 'is-generating-plasma' : ''
      } ${isFailed ? 'is-failed' : ''}`}
    >
      {/* The halo is on the icon rather than beside it: while proof of work is
          running this row is the only thing happening, and a 6px dot said that
          too quietly to be read as "still working". */}
      <div className={`transaction-icon is-${type}`}>
        <Icon name={icon} size={15} />
      </div>

      <div className="transaction-data">
        <div className="transaction-line">
          <span className="transaction-label">
            {label}
            {/* Proof of work takes real seconds and says so in words, because a
                silent pulse leaves "is it stuck?" unanswered. It replaces the
                unconfirmed dot rather than sitting next to it: a block still
                being signed is not yet waiting on the network. */}
            {isGeneratingPlasma && (
              <span className="plasma-note" role="status">
                Generating plasma…
              </span>
            )}
            {/* Only while the network has not settled it. A permanent badge on
                every row would be noise; this one goes away on its own. */}
            {isUnconfirmed && !isGeneratingPlasma && !isFailed && (
              <span
                className="pending-dot"
                role="status"
                aria-label="Unconfirmed"
                data-tooltip="Unconfirmed"
              >
                <span className="pending-label" aria-hidden="true">Unconfirmed</span>
              </span>
            )}
          </span>
          {hasAmount && (
            <span className="transaction-amount">
              {shownAmount} {tokenSymbol}
            </span>
          )}
        </div>

        <button
          type="button"
          className="transaction-counterparty"
          title={address}
          onClick={() => copyToClipboard(address, 'Address copied')}
        >
          {isIncoming ? 'From ' : 'To '}
          {counterparty}
        </button>

        {/* A send can fail minutes after it was started, by which time the
            toast that announced it has gone. The row keeps the reason. */}
        {isFailed && error && <div className="transaction-error">{error}</div>}
      </div>

      {/* Only rendered when the current chain actually has an explorer.
          It sat at 40% opacity with no label and no border, which read as
          decoration rather than as something to press — hence the chip. */}
      {/* A failed block is the one row the user has to be able to clear: it
          will never confirm, so nothing else will ever remove it. */}
      {onDismiss && (
        <button type="button" className="transaction-dismiss" onClick={onDismiss} title="Dismiss">
          <Icon name="close" size={13} />
        </button>
      )}

      {explorerLink && (
        <a
          className="transaction-explorer"
          href={explorerLink}
          target="_blank"
          rel="noreferrer"
          title={explorerHint}
          aria-label={explorerHint}
          data-tooltip={explorerHint}
        >
          <ExternalLinkIcon />
        </a>
      )}
    </div>
  );
};

export default TransactionItem;
