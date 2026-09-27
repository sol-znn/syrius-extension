import { KeyStore, Zenon } from 'znn-ts-sdk';
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
import session from './session';
import vault from './vault';
import selection from './selection';

// Everything that has to happen between "this is the right password" and "the
// wallet is on screen", in the one order that works.
//
// It was inline in the password screen, and the node connection was awaited in
// the middle of it: if the node was unreachable, `zenon.initialize` threw, the
// catch showed a toast, and the unlock was abandoned — a wallet that would not
// open because a server was down, with no way to reach the node settings that
// would have fixed it. Connecting is attempted here but is not allowed to fail
// the unlock; the header reports the connection separately.

const connectToNode = async (dispatch) => {
  const nodeUrl = getCurrentNodeUrl() || defaultNodeUrl;
  setCurrentNodeUrl(nodeUrl);
  dispatch(storeNodeUrl(nodeUrl));

  try {
    await Zenon.getSingleton().initialize(nodeUrl, false, 8000);
    dispatch(storeIsConnected(true));
    return true;
  } catch (err) {
    dispatch(storeIsConnected(false));
    return false;
  }
};

// `unlock` is either `{password}` for somebody typing one, or `{entropy}` for
// resuming a session that has not expired. The entropy path skips Argon2id
// entirely, which is the difference between a popup that opens instantly and
// one that hangs for a second every time.
const ownerId = crypto.randomUUID();
const completeUnlock = async ({ walletName, password, unlock, dispatch, isCurrent = () => true }) => {
  const expected = await selection.transaction(stored => selection.current(stored));
  if (unlock && (expected?.id !== unlock.id || !selection.live(expected) || expected.mode !== 'timed')) throw selection.ended();
  const keyStore = unlock ? new KeyStore().fromEntropy(unlock.entropy) : await vault.preparePassword(walletName, password);
  const addressInfo = getAddressInfo(walletName);
  const index = unlock ? unlock.scope.index : addressInfo.selectedAddressIndex;
  const walletId = (await keyStore.getKeyPair(0).getAddress()).toString();
  const address = (await keyStore.getKeyPair(index).getAddress()).toString();
  const scope = { walletName, walletId, address, index };
  if (unlock && !selection.sameScope(unlock.scope, scope)) throw selection.ended();
  const binding = await selection.transaction(async stored => {
    const current = selection.current(stored);
    if (!isCurrent() || (current?.id ?? null) !== (expected?.id ?? null) ||
        (unlock && (!selection.live(current) || current.mode !== 'timed'))) throw selection.ended();
    const expiresAt = session.deadlineFromNow();
    const next = { id: unlock ? current.id : crypto.randomUUID(), walletName, scope,
      selectedAddressIndex: index, ownerId, lastActiveAt: Date.now(), expiresAt,
      mode: expiresAt ? 'timed' : 'local',
      resumeFrom: unlock ? current.resumeFrom || null : selection.sameScope(current?.scope, scope) ? current.id : null,
      ...(expiresAt ? { entropy: keyStore.entropy } : {}) };
    await selection.write(next);
    vault.adopt(walletName, keyStore); vault.setSelectedIndex(index); vault.bind(next);
    setLastWalletName(walletName);
    dispatch(walletUnlocked({ walletName, address, selectedAddressIndex: index, maxAddressIndex: addressInfo.maxAddressIndex }));
    dispatch(storeChainIdentifier(Zenon.getChainIdentifier()));
    return vault.getBinding();
  });
  const isConnected = await connectToNode(dispatch);
  if (!isCurrent()) throw selection.ended();
  await announceUnlock(binding);
  return { address, isConnected };
};

export { completeUnlock, connectToNode };
