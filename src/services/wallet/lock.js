import { Zenon } from 'znn-ts-sdk';
import { announceLock } from './announce';
import { notify } from '../utils/notify';
import session from './session';
import vault from './vault';

// Locking, in one place.
//
// It used to be three lines in the burger menu — clear the socket, ask the
// background to forget the password, navigate — which meant that locking from
// anywhere else (the auto-lock, removing a wallet, switching wallets) did some
// subset of that. In particular nothing ever cleared the decrypted keystore or
// told connected sites the address was gone, so a site kept showing an account
// for a wallet the person believed they had just shut.
// A lease whose revocation failed after this document's keys were purged. A
// retry has no live lease to name, so it names this one instead of reporting a
// lock that never reached the other windows.
let unconfirmed = null;

// `afterRevoke` is a synchronous step to run inside the revocation itself (see
// sessionLease.clear). Its failure does not undo the lock: the wallet is locked
// either way, and the error is thrown once the lock has been reported.
const lockWallet = async ({ afterRevoke } = {}) => {
  // Revocation is queued on the shared lease lock before anything else, so no
  // key operation from this or any window can slip in ahead of it. It targets
  // this document's own lease: a window whose lease was already replaced must
  // not lock a newer unlock that another window made since.
  const leaseId = vault.getLeaseId() || unconfirmed;
  let afterError = null;
  const after = afterRevoke && (() => {
    try { afterRevoke(); } catch (error) { afterError = error; }
  });
  const clearing = leaseId ? session.clear(leaseId, after) : Promise.resolve(null);
  // This document's keys go now, whatever shared storage does next: a failed
  // revocation must never leave them usable here. The UI is told afterwards,
  // and only then, because the password screen claims a global lock that has
  // not happened until `clearing` commits. On failure the lock listeners get
  // the error instead, and MainLayout shows its retry screen for that lease.
  const announceLocked = vault.seal();
  notify.dismissAll();
  try {
    Zenon.getSingleton().clearSocketConnection();
  } catch (err) {
    // Already down.
  }
  let generation;
  try {
    generation = await clearing;
  } catch (error) {
    unconfirmed = leaseId;
    announceLocked(error);
    throw error;
  }
  // The shared record holds one lease: whichever this revoked, an older
  // unconfirmed one is gone too.
  unconfirmed = null;
  announceLocked();
  // Provider notification is best effort and generation-checked by the worker.
  // Do not let its timeout keep an old menu/removal continuation alive after
  // the password screen is already available for a new unlock.
  announceLock(generation);
  if (leaseId && afterRevoke && !afterError && generation === null) {
    // The lease was replaced before this lock ran; nothing was revoked, so the
    // step that depended on revocation did not run either.
    throw new Error('The wallet changed before it could be locked. Try again.');
  }
  if (afterError) throw afterError;
};

export default lockWallet;
