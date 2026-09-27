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
  const binding = vault.getBinding();
  vault.lock();
  const id = await session.clear(binding?.id);
  if (id) await announceLock(id);
  // Nothing left over from the unlocked wallet should still be on screen once
  // the password prompt is.
  notify.dismissAll();

  try {
    Zenon.getSingleton().clearSocketConnection();
  } catch (err) {
    // Already down.
  }
};

export default lockWallet;
