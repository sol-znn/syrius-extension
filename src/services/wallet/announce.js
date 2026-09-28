import { Zenon } from 'znn-ts-sdk';
import { sendInternalQuietly } from '../utils/messaging';
import { getCurrentNodeUrl } from '../utils/storage';
import session from './session';
import vault from './vault';

// Derive public values from the captured live vault, never from an address
// argument retained by a screen before an asynchronous connection/unlock.
const announce = async (event, expectedLifetime) => {
  if (!vault.isUnlocked()) return false;
  try {
    const lifetime = expectedLifetime || vault.capture();
    const address = await vault.getAddress(vault.getSelectedIndex(), lifetime);
    await vault.assertSession(lifetime);
    await session.publish(lifetime.id, {
      address, chainId: Zenon.getChainIdentifier(), nodeUrl: getCurrentNodeUrl(),
    });
    await sendInternalQuietly(event, { leaseId: lifetime.id });
    return true;
  } catch (error) { return false; }
};
const announceUnlock = (address, lifetime) => announce('events.accountsChanged', lifetime);
const announceAddress = () => announce('events.accountsChanged');
const announceChain = () => announce('events.chainChanged');
const announceNode = () => announce('events.nodeChanged');
const announceLock = (leaseId) => sendInternalQuietly('session.locked', { leaseId });

export { announceUnlock, announceAddress, announceChain, announceNode, announceLock };
