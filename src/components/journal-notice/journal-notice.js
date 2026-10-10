import React, { useContext, useEffect, useState } from 'react';
import { Zenon } from 'znn-ts-sdk';

import AlertModal from '../modals/alert-modal';
import { ModalContext } from '../../services/hooks/modal/modalContext';
import journal from '../../services/wallet/journal';
import { notify } from '../../services/utils/notify';

// What the dashboard says about blocks whose outcome the wallet does not know.
//
// This is also where the journal gets settled: while it is on screen it asks
// the node about every block this account has sent and not yet seen in a
// momentum. Nothing is shown while every answer is known, which is nearly
// always. A block the node cannot account for holds up the account's next
// send, so the person is told, and is given the one decision that is theirs:
// to stop waiting for it.
const settledPollMs = 30000, unsettledPollMs = 8000, failedPollMs = 15000;

const JournalNotice = ({ address, refreshKey }) => {
  const { openModal } = useContext(ModalContext);
  const [unknown, setUnknown] = useState([]);
  const [isUnreadable, setIsUnreadable] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!address) return undefined;
    let cancelled = false, timer;
    const check = async () => {
      let wait = failedPollMs;
      try {
        const result = await journal.reconcile(Zenon.getSingleton(), address);
        if (cancelled) return;
        const unsettled = result.records.some((record) =>
          record.state === journal.state.publishing || record.state === journal.state.accepted);
        setUnknown(result.unknown);
        setIsUnreadable(false);
        wait = unsettled ? unsettledPollMs : settledPollMs;
      } catch (error) {
        if (cancelled) return;
        // Locked, or the node is away: the header already says so.
        if (error?.code === 'JOURNAL_UNAVAILABLE') setIsUnreadable(true);
      }
      timer = setTimeout(check, wait);
    };
    check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [address, refreshKey, round]);

  const discard = (record) => openModal(
    <AlertModal
      type="warning"
      title="Stop waiting"
      confirmLabel="Stop waiting"
      onSuccess={async () => {
        try { await journal.discard(record.id); } catch (error) { notify.error(error); }
        setRound((value) => value + 1);
      }}
    >
      <p>This transaction may still confirm. Check the account's history before sending it again.</p>
      <p className="word-break-all">{record.hash}</p>
    </AlertModal>
  );

  const reset = () => openModal(
    <AlertModal
      type="warning"
      title="Clear transaction records"
      confirmLabel="Clear records"
      onSuccess={async () => {
        try { await journal.reset(); } catch (error) { notify.error(error); }
        setRound((value) => value + 1);
      }}
    >
      <p>Sending stays paused until the records are cleared. Check the account's history before sending again.</p>
    </AlertModal>
  );

  if (isUnreadable) {
    return (
      <div className="warning-panel journal-notice" role="status">
        Transaction records cannot be read. Sending is paused.
        <button type="button" className="button secondary w-100 mt-2" onClick={reset}>Clear records</button>
      </div>
    );
  }
  if (!unknown.length) return null;

  return (
    <div className="warning-panel journal-notice" role="status">
      {unknown.length === 1
        ? 'The outcome of one transaction is not known yet. Sending is paused.'
        : `The outcome of ${unknown.length} transactions is not known yet. Sending is paused.`}
      {unknown.map((record) => (
        <button key={record.id} type="button" className="button secondary w-100 mt-2" onClick={() => discard(record)}>
          Stop waiting for {record.hash.slice(0, 8)}…
        </button>
      ))}
    </div>
  );
};

export default JournalNotice;
