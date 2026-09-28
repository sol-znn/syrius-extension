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
  setCurrentNodeUrl(nodeUrl);
  dispatch(storeNodeUrl(nodeUrl));

  try {
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
  const lifetime = sessionRecord
    ? await vault.restore(sessionRecord, addressInfo.selectedAddressIndex)
    : await vault.unlockWithPassword(walletName, password, addressInfo.selectedAddressIndex);
  const address = await vault.getAddress(addressInfo.selectedAddressIndex, lifetime);
  await vault.assertSession(lifetime);
  setLastWalletName(walletName);
  dispatch(walletUnlocked({
    walletName, address,
    selectedAddressIndex: addressInfo.selectedAddressIndex,
    maxAddressIndex: addressInfo.maxAddressIndex,
  }));
  dispatch(storeChainIdentifier(Zenon.getChainIdentifier()));
  const isConnected = await connectToNode(dispatch, () => vault.isCurrent(lifetime));
  await vault.assertSession(lifetime);
  await announceUnlock(address, lifetime);
  return { address, isConnected };
};

export { completeUnlock, connectToNode };
