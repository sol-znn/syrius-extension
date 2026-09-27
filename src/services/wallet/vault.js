import { KeyStore, KeyStoreManager, Primitives } from 'znn-ts-sdk';
import selection from './selection';

// The unlocked wallet, held once.
//
// Every screen used to open the keystore for itself: `readKeyStore(password,
// name)` on mount in the dashboard, in send, in receive, in plasma, in
// delegate, in stake, in change-address, and twice more per signature in the
// dApp flow. That call is Argon2id at 64 MiB, which is deliberately expensive —
// it is the thing standing between a stolen keystore and the coins in it. Doing
// it on every navigation cost about a second of frozen popup each time and
// meant the wallet password had to be kept in Redux, in plain text, so that any
// screen could redo it.
//
// It happens once here, at unlock. Screens ask this module for a key pair.

const state = {
  generation: 0,
  binding: null,
  walletName: null,
  keyStore: null,
  // Which of the wallet's derived addresses is in use.
  //
  // This is the default for every accessor below, and it exists because the
  // alternative — defaulting to index 0 and asking each caller to pass the
  // selected one — was tried and did not hold: six call sites across the
  // dashboard, plasma, delegate, stake and the dApp approval screen asked for a
  // key pair without an index, and every one of them silently got address 0.
  // The visible effect was a wallet that showed the balance of the address you
  // had chosen and signed with a different one.
  selectedIndex: 0,
  // Deriving a key pair is Ed25519 over a BIP-44 path — cheap next to Argon2id
  // but not free, and the address for one is an async hash. Both are memoised
  // per index because a screen that renders a list of addresses asks for the
  // same ones repeatedly.
  keyPairs: new Map(),
  addresses: new Map(),
};

const isUnlocked = () => state.keyStore !== null;

const getWalletName = () => state.walletName;

// The seed material, for handing to the session store so that reopening the
// popup does not mean running the key derivation again. Never leaves the
// extension's own trusted contexts.
const getEntropy = () => (state.keyStore ? state.keyStore.entropy : null);

const getMnemonic = () => (state.keyStore ? state.keyStore.mnemonic : null);

const clear = () => {
  state.generation += 1;
  state.binding = null;
  signingKeyPairs.clear();
  state.walletName = null;
  state.keyStore = null;
  state.selectedIndex = 0;
  state.keyPairs.clear();
  state.addresses.clear();
};

const adopt = (walletName, keyStore) => {
  clear();
  state.walletName = walletName;
  state.keyStore = keyStore;
  return keyStore;
};

// The slow path, used once when somebody types their password. Throws when the
// password is wrong — the SDK's own error, which `readableError` turns into
// "Wrong password."
const preparePassword = async (walletName, password) => {
  const manager = new KeyStoreManager();
  const keyStore = await manager.readKeyStore(password, walletName);

  if (!keyStore) {
    throw new Error('Error decrypting');
  }
  return keyStore;
};
const unlockWithPassword = async (walletName, password) => adopt(walletName, await preparePassword(walletName, password));

// The fast path, used when the popup reopens inside an unexpired session. No
// key derivation function runs at all.
const unlockWithEntropy = (walletName, entropy) => {
  if (!entropy) {
    throw new Error('No session key material');
  }
  return adopt(walletName, new KeyStore().fromEntropy(entropy));
};

const requireKeyStore = () => {
  if (!state.keyStore) {
    throw new Error('The wallet is locked');
  }
  return state.keyStore;
};

const getSelectedIndex = () => state.selectedIndex;

const setSelectedIndex = (index) => {
  state.selectedIndex = Number.isInteger(index) && index >= 0 ? index : 0;
};

const getKeyPair = (index = state.selectedIndex) => {
  const keyStore = requireKeyStore();

  if (!state.keyPairs.has(index)) {
    state.keyPairs.set(index, keyStore.getKeyPair(index));
  }
  return state.keyPairs.get(index);
};

const getAddress = async (index = state.selectedIndex) => {
  if (!state.addresses.has(index)) {
    const generation = state.generation;
    const address = (await getKeyPair(index).getAddress()).toString();
    if (state.generation !== generation) throw selection.ended();
    state.addresses.set(index, address);
  }
  return state.addresses.get(index);
};

// `Primitives.Address` is what every SDK call actually wants; the string form
// is only for display and the clipboard.
const getAddressObject = async (index = state.selectedIndex) =>
  Primitives.Address.parse(await getAddress(index));

// Deriving n addresses for the address picker. Sequential because each one is
// an async hash over the previous derivation's output in the SDK.
const getAddresses = async (count) => {
  const addresses = [];
  for (let index = 0; index < count; index += 1) {
    addresses.push(await getAddress(index));
  }
  return addresses;
};

// Signing wants a generated pair rather than the derivation handle. Also
// memoised: `generateKeyPair` was being called inline on the send path.
const signingKeyPairs = new Map();

const getSigningKeyPair = async (index = state.selectedIndex) => {
  if (!signingKeyPairs.has(index)) {
    const generation = state.generation;
    const pair = await getKeyPair(index).generateKeyPair();
    if (state.generation !== generation) throw selection.ended();
    signingKeyPairs.set(index, pair);
  }
  return signingKeyPairs.get(index);
};

const lock = () => {
  signingKeyPairs.clear();
  clear();
};

// Confirms a password against the wallet already open, for the screens that
// have to re-authorise — showing the mnemonic, changing the password, removing
// a wallet. Deliberately runs the full key derivation: that is the point.
const verifyPassword = async (password) => {
  if (!state.walletName) {
    return false;
  }
  try {
    const manager = new KeyStoreManager();
    const keyStore = await manager.readKeyStore(password, state.walletName);
    return Boolean(keyStore && keyStore.entropy === state.keyStore?.entropy);
  } catch (err) {
    return false;
  }
};

const bind = record => {
  state.binding = Object.freeze({ id: record.id, ownerId: record.ownerId, scope: Object.freeze({ ...record.scope }) });
};
const getBinding = () => state.binding;
const assertBinding = binding => {
  if (!binding || state.binding !== binding || !isUnlocked() || state.selectedIndex !== binding.scope.index) throw selection.ended();
};

const vault = {
  preparePassword, adopt, bind, getBinding, assertBinding,
  isUnlocked,
  getWalletName,
  getSelectedIndex,
  setSelectedIndex,
  getEntropy,
  getMnemonic,
  unlockWithPassword,
  unlockWithEntropy,
  getKeyPair,
  getSigningKeyPair,
  getAddress,
  getAddressObject,
  getAddresses,
  verifyPassword,
  lock,
};

export default vault;
