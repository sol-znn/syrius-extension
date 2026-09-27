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
const lockWallet = async () => {
  // Capture the bound shared session before immediately clearing local keys.
  // Storage failure must never leave this document's decrypted vault usable.
  const clearing = session.clear();
  vault.lock();
  notify.dismissAll();
  try { Zenon.getSingleton().clearSocketConnection(); } catch (err) { /* Already down. */ }
  let ended;
  try { ended = await clearing; }
  catch (error) {
    throw new Error('Could not lock the shared wallet session. Try locking again or close the browser.');
  }
  await announceLock(ended);
};

export default lockWallet;
