import { Zenon } from 'znn-ts-sdk';
import { sendInternalQuietly } from '../utils/messaging';
import { getCurrentNodeUrl } from '../utils/storage';
import session from './session';

const announce = async (method, token) => {
  try {
    if (await session.publish(token, { chainId: Zenon.getChainIdentifier(), nodeUrl: getCurrentNodeUrl() })) {
      await sendInternalQuietly(method, { token: { id: token.id, revision: token.revision } });
    }
  } catch (error) { /* Public advertisement must not undo a completed unlock. */ }
};
const announceUnlock = (token) => announce('events.accountsChanged', token);
const announceAddress = (token) => announce('events.accountsChanged', token);
const announceChain = (token) => announce('events.chainChanged', token);
const announceNode = (token) => announce('events.nodeChanged', token);
const announceLock = (record) => record ? sendInternalQuietly('session.locked', {
  token: { id: record.id, revision: record.revision },
}) : Promise.resolve();
export { announceUnlock, announceAddress, announceChain, announceNode, announceLock };
