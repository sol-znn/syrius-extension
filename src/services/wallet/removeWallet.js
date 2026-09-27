import selection from './selection';
import vault from './vault';
import permissions from '../../sections/Background/permissions';
import requests from '../../sections/Background/requests';
import { removeStorageWallet } from '../utils/utils';
import { sendInternalQuietly } from '../utils/messaging';

const removeWallet = async (binding, walletName) => {
  let update, failure;
  try {
    await selection.transaction(async stored => {
      selection.assert(selection.current(stored), binding, true);
      vault.assertBinding(binding);
      if (walletName !== binding.scope.walletName) throw selection.ended();
      const sites = await permissions.forWallet(binding.scope);
      update = { selectionId: binding.id, origins: sites.map(site => site.origin), cancelled: [] };
      await permissions.revokeWallet(binding.scope);
      // Also remove unbound connects: an old consent prompt must not survive
      // removal and authorize a later import reusing this wallet's name.
      update.cancelled = await requests.cancelWhere(request => !request.admitted || selection.sameWallet(request.admitted.scope, binding.scope));
      update.selectionId = await selection.revoke(selection.current(stored));
      vault.lock();
      if (!removeStorageWallet(walletName)) throw new Error('Could not remove that wallet. Unlock it and try again.');
    });
  } catch (error) { failure = error; }
  if (update) await sendInternalQuietly('session.locked', update);
  if (failure) throw failure;
  return true;
};
export default removeWallet;
