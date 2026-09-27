import { KeyStore, KeyStoreManager, Zenon } from 'znn-ts-sdk';
import { storeChainIdentifier, storeIsConnected, storeNodeUrl } from '../redux/connectionParametersSlice';
import { walletUnlocked } from '../redux/walletSlice';
import { defaultNodeUrl, getAddressInfo, getCurrentNodeUrl, setCurrentNodeUrl, setLastWalletName } from '../utils/storage';
import { announceUnlock } from './announce';
import session from './session';

const connectToNode = async (dispatch, expected = session.capture()) => {
  let connected = false;
  try {
    const nodeUrl = getCurrentNodeUrl() || defaultNodeUrl;
    setCurrentNodeUrl(nodeUrl);
    dispatch(storeNodeUrl(nodeUrl));
    await Zenon.getSingleton().initialize(nodeUrl, false, 8000);
    connected = true;
  } catch (err) { /* Wallet access remains available when node setup fails. */ }
  if (await session.isCurrent(expected)) dispatch(storeIsConnected(connected));
  return connected;
};

// Preparation never adopts key material. Recheck the original revision under
// the same lock as policy updates before publishing it into the live document.
const completeUnlock = async ({ walletName, password, record, dispatch, isCancelled = () => false }) => {
  const expected = record || await session.begin();
  const keyStore = record ? new KeyStore().fromEntropy(record.entropy) :
    await new KeyStoreManager().readKeyStore(password, walletName);
  if (!keyStore) throw new Error('Error decrypting');
  const addressInfo = getAddressInfo(walletName);
  const index = record ? record.selectedAddressIndex : addressInfo.selectedAddressIndex;
  const address = (await keyStore.getKeyPair(index).getAddress()).toString();
  if (isCancelled()) throw new Error('Wallet startup was cancelled');
  const chainId = Zenon.getChainIdentifier();
  const prepare = () => setLastWalletName(walletName);
  const commit = () => {
    dispatch(walletUnlocked({ walletName, address, selectedAddressIndex: index,
      maxAddressIndex: Math.max(addressInfo.maxAddressIndex, index + 1) }));
    dispatch(storeChainIdentifier(chainId));
  };
  const token = record ? await session.restore(record, keyStore, commit, prepare) :
    await session.create(expected, { walletName, entropy: keyStore.entropy, selectedAddressIndex: index }, keyStore, commit, prepare);
  const isConnected = await connectToNode(dispatch, token);
  await announceUnlock(token);
  return { address, isConnected };
};
export { completeUnlock, connectToNode };
