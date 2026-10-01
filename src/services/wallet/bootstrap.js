import { Zenon } from 'znn-ts-sdk';
import {
  storeChainIdentifier,
  storeIsConnected,
  storeNodeUrl,
} from '../redux/connectionParametersSlice';
import { walletUnlocked } from '../redux/walletSlice';
import {
  defaultNodeUrl,
  getAddressInfo,
  getCurrentNodeUrl,
  setCurrentNodeUrl,
  setLastWalletName,
} from '../utils/storage';
import { announceUnlock } from './announce';
import vault from './vault';

// Everything that has to happen between "this is the right password" and "the
// wallet is on screen", in the one order that works.
//
// It was inline in the password screen, and the node connection was awaited in
// the middle of it: if the node was unreachable, `zenon.initialize` threw, the
// catch showed a toast, and the unlock was abandoned — a wallet that would not
// open because a server was down, with no way to reach the node settings that
// would have fixed it. Connecting is attempted here but is not allowed to fail
// the unlock; the header reports the connection separately.

const connectToNode = async (dispatch, isCurrent = () => true) => {
  const nodeUrl = getCurrentNodeUrl() || defaultNodeUrl;
  dispatch(storeNodeUrl(nodeUrl));

  try {
    // Inside the try: remembering the node is optional, and a storage failure
    // here must not undo an unlock that has already been adopted.
    setCurrentNodeUrl(nodeUrl);
    await Zenon.getSingleton().initialize(nodeUrl, false, 8000);
    if (isCurrent()) dispatch(storeIsConnected(true));
    return true;
  } catch (err) {
    if (isCurrent()) dispatch(storeIsConnected(false));
    return false;
  }
};

// Restore carries the original lease identity; only a password creates a new
// one. Slow address/node work cannot re-publish a revoked unlock.
const completeUnlock = async ({ walletName, password, sessionRecord, dispatch }) => {
  const addressInfo = getAddressInfo(walletName);
  // Recorded once the password (or session) has checked out — a wrong guess
  // must never become the screen's next default — and before the keys are
  // adopted, so a failed write leaves nothing half unlocked.
  const prepare = () => setLastWalletName(walletName);
  // A resumed session keeps the account it was on; the shared selection, not
  // this window's saved default, is what sites and approvals are bound to.
  const index = sessionRecord ? sessionRecord.scope?.index : addressInfo.selectedAddressIndex;
  const lifetime = sessionRecord
    ? await vault.restore(sessionRecord, prepare)
    : await vault.unlockWithPassword(walletName, password, index, prepare);
  const address = await vault.getAddress(index, lifetime);
  await vault.assertSession(lifetime);
  dispatch(walletUnlocked({
    walletName, address,
    selectedAddressIndex: index,
    // A saved selection past the saved count would draw no selected row.
    maxAddressIndex: Math.max(addressInfo.maxAddressIndex, index + 1),
  }));
  dispatch(storeChainIdentifier(Zenon.getChainIdentifier()));
  const isConnected = await connectToNode(dispatch, () => vault.isCurrent(lifetime));
  await vault.assertSession(lifetime);
  await announceUnlock(address, lifetime);
  return { address, isConnected };
};

export { completeUnlock, connectToNode };
