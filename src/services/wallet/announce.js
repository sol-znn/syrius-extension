import { Zenon } from 'znn-ts-sdk';
import { sendInternalQuietly } from '../utils/messaging';
import { getCurrentNodeUrl } from '../utils/storage';
import session from './session';
import vault from './vault';

// Ignore Redux/caller address strings. Publish only the captured vault's
// coherent selection, then tell the worker which generation it may announce.
const announce = async (event, binding = vault.getBinding()) => {
  const selectionId = await session.publish(binding, { chainId: Zenon.getChainIdentifier(), nodeUrl: getCurrentNodeUrl() });
  await sendInternalQuietly(event, { selectionId });
};
const announceUnlock = binding => announce('events.accountsChanged', binding);
const announceAddress = binding => announce('events.accountsChanged', binding);
const announceChain = () => announce('events.chainChanged');
const announceNode = () => announce('events.nodeChanged');
const announceLock = selectionId => sendInternalQuietly('session.locked', { selectionId });
export { announceUnlock, announceAddress, announceChain, announceNode, announceLock };
