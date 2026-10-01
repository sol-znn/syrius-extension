import { Zenon } from 'znn-ts-sdk';
import { sendInternalQuietly } from '../utils/messaging';
import { getCurrentNodeUrl } from '../utils/storage';
import publicNodeUrl from '../utils/publicNodeUrl';
import session from './session';
import vault from './vault';

// The address published is the shared selection's own, read from the session
// record, never one a screen retained before an asynchronous connection or
// unlock. The worker is told which selection generation the event is about and
// announces only that one; a stale event reveals nothing.
const announce = async (event, expectedLifetime) => {
  if (!vault.isUnlocked() || (expectedLifetime && !vault.isCurrent(expectedLifetime))) return false;
  try {
    const lifetime = expectedLifetime || vault.capture();
    await vault.assertSession(lifetime);
    // Sites learn the node's scheme and host, never credentials or a private
    // endpoint's path; the wallet keeps the full URL for its own connection.
    const { selectionId } = await session.publish(lifetime.id, {
      chainId: Zenon.getChainIdentifier(), nodeUrl: publicNodeUrl(getCurrentNodeUrl()),
    });
    await sendInternalQuietly(event, { leaseId: lifetime.id, selectionId });
    return true;
  } catch (error) { return false; }
};
// Captured before a screen's own slow work (a node connection, say), so the
// announcement that follows is bound to the session that started it and not
// to whatever unlocked in the meantime. Null when there is nothing to bind to.
const captureLifetime = () => (vault.isUnlocked() ? vault.capture() : null);
const announceUnlock = (address, lifetime) => announce('events.accountsChanged', lifetime);
const announceAddress = (lifetime) => announce('events.accountsChanged', lifetime);
const announceChain = (lifetime) => announce('events.chainChanged', lifetime);
const announceNode = (lifetime) => announce('events.nodeChanged', lifetime);
const announceLock = (leaseId) => sendInternalQuietly('session.locked', { leaseId });

export { captureLifetime, announceUnlock, announceAddress, announceChain, announceNode, announceLock };
