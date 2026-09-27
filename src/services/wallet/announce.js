import { Zenon } from 'znn-ts-sdk';
import { sendInternalQuietly } from '../utils/messaging';
import { getCurrentNodeUrl } from '../utils/storage';
import session from './session';
import publicNodeUrl from '../utils/publicNodeUrl';

// Telling the rest of the world what the wallet is pointed at.
//
// Two audiences, and the old code only served one of them badly. Connected
// sites need an event when the address, chain or node changes — that used to be
// a `chrome.runtime.sendMessage({message: "znn.addressChanged"})` scattered
// through four screens. And the service worker needs the current values so it
// can answer a page's read-only call without waking the popup; that did not
// exist at all, which is why every single site call opened a window.
//
// Both are updated together here, because a site being told an address changed
// while the worker still reports the old one is worse than neither.

const publicState = async (address) => ({
  address: address || null,
  chainId: Zenon.getChainIdentifier(),
  nodeUrl: publicNodeUrl(getCurrentNodeUrl()),
});

// Publishing is awaited because the service worker answers a site's read-only
// call out of it. Telling the open pages is not: it is a courtesy to whatever
// tabs happen to be open, and the person unlocking their wallet should never
// wait on it.
const announceUnlock = async (address) => {
  await session.publish(await publicState(address));
  sendInternalQuietly('events.accountsChanged', { address });
};

const announceAddress = async (address) => {
  await session.publish(await publicState(address));
  await sendInternalQuietly('events.accountsChanged', { address });
};

const announceChain = async (chainId, address) => {
  await session.publish(await publicState(address));
  await sendInternalQuietly('events.chainChanged', { chainId });
};

const announceNode = async (nodeUrl, address) => {
  await session.publish(await publicState(address));
  await sendInternalQuietly('events.nodeChanged', { nodeUrl: publicNodeUrl(nodeUrl) });
};

// Locking has to reach the pages, or a site keeps showing an address for a
// wallet that is shut.
const announceLock = async () => {
  await session.unpublish();
  await sendInternalQuietly('session.locked', {});
};

export { announceUnlock, announceAddress, announceChain, announceNode, announceLock };
