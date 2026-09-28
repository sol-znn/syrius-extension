import { KeyFile, KeyStore, KeyStoreManager, Primitives } from 'znn-ts-sdk';
import session from './session';

// Raw keystores/keys never leave this module. Every exported key handle is a
// revocable facade, including the public derivation handle used by previews.
const state = {
  generation: 0, walletName: null, keyStore: null, lease: null, selectedIndex: 0,
  rawKeys: new Map(), rawSigningKeys: new Map(), publicKeys: new Map(), signingKeys: new Map(), addresses: new Map(),
};
const listeners = new Set();
let timer;
const isCurrent = (scope) => Boolean(scope && state.keyStore &&
  scope.generation === state.generation && scope.id === state.lease?.id);
const lock = (expectedId, error) => {
  if (expectedId !== undefined && state.lease?.id !== expectedId) return;
  const wasUnlocked = Boolean(state.keyStore);
  const leaseId = state.lease?.id;
  state.generation += 1;
  state.walletName = null; state.keyStore = null; state.lease = null; state.selectedIndex = 0;
  state.rawKeys.clear(); state.rawSigningKeys.clear(); state.publicKeys.clear(); state.signingKeys.clear(); state.addresses.clear();
  clearTimeout(timer);
  if (wasUnlocked) listeners.forEach((listener) => {
    try { listener({ leaseId, error }); } catch (error) { /* UI cleanup cannot block key revocation. */ }
  });
};
const onLock = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
const isUnlocked = () => Boolean(state.keyStore && state.lease && (
  state.lease.mode === 'local' || Date.now() < state.lease.expiresAt
));
const capture = () => {
  if (!state.keyStore || !state.lease) throw session.ended();
  return Object.freeze({ id: state.lease.id, generation: state.generation });
};
const assertLocal = (scope) => { if (!isCurrent(scope)) throw session.ended(); };
const schedule = () => {
  clearTimeout(timer);
  if (state.lease?.mode !== 'timed') return;
  const scope = capture();
  timer = setTimeout(() => { authorize(scope, () => true).catch(() => {}); },
    Math.max(0, Math.min(2147483647, state.lease.expiresAt - Date.now())));
};
const authorize = async (scope, operation) => {
  assertLocal(scope);
  try {
    const result = await session.use(scope.id, async (record) => {
      assertLocal(scope);
      state.lease = record;
      schedule();
      const result = await operation();
      assertLocal(scope);
      return result;
    });
    assertLocal(scope);
    if (!isUnlocked()) throw session.ended();
    return result;
  } catch (error) {
    if (['WALLET_LOCKED', 'WALLET_SESSION_UNAVAILABLE'].includes(error.code) && isCurrent(scope)) {
      lock(scope.id, error);
    }
    throw error;
  }
};
const assertSession = (scope = capture()) => authorize(scope, () => true);
const adopt = (walletName, keyStore, record, selectedIndex) => {
  // Replacement invalidates old handles/caches without emitting a lock UI
  // event in the middle of a successful password/restore workflow.
  state.generation += 1;
  state.rawKeys.clear(); state.rawSigningKeys.clear(); state.publicKeys.clear(); state.signingKeys.clear(); state.addresses.clear();
  state.walletName = walletName; state.keyStore = keyStore; state.lease = record;
  state.selectedIndex = Number.isInteger(selectedIndex) && selectedIndex >= 0 ? selectedIndex : 0;
  schedule();
  return capture();
};
const unlockWithPassword = async (walletName, password, selectedIndex = 0) => {
  const generation = state.generation;
  const expectedId = await session.begin();
  if (generation !== state.generation) throw session.ended();
  const keyStore = await new KeyStoreManager().readKeyStore(password, walletName);
  if (!keyStore) throw new Error('Error decrypting');
  if (generation !== state.generation) throw session.ended();
  return session.create(expectedId, { walletName, entropy: keyStore.entropy, selectedAddressIndex: selectedIndex }, (record) => {
    if (generation !== state.generation) throw session.ended();
    return adopt(walletName, keyStore, record, selectedIndex);
  });
};
const restore = async (record, selectedIndex = 0) => {
  const generation = state.generation;
  return session.restore(record, selectedIndex, (current, entropy) => {
    if (generation !== state.generation) throw session.ended();
    return adopt(current.walletName, new KeyStore().fromEntropy(entropy), current, selectedIndex);
  });
};
const getSelectedIndex = () => state.selectedIndex;
const setSelectedIndex = (index) => {
  capture();
  state.selectedIndex = Number.isInteger(index) && index >= 0 ? index : 0;
};
const getWalletName = () => state.walletName;
const rawKey = (scope, index) => {
  assertLocal(scope);
  if (!state.rawKeys.has(index)) state.rawKeys.set(index, state.keyStore.getKeyPair(index));
  return state.rawKeys.get(index);
};
const publicHandle = (scope, index) => {
  assertLocal(scope);
  if (!state.publicKeys.has(index)) {
    state.publicKeys.set(index, Object.freeze({
      getAddress: () => authorize(scope, async () => {
        if (!state.addresses.has(index)) {
          const address = (await rawKey(scope, index).getAddress()).toString();
          assertLocal(scope);
          state.addresses.set(index, address);
        }
        return Primitives.Address.parse(state.addresses.get(index));
      }),
      getPublicKey: () => authorize(scope, async () => {
        const publicKey = await rawKey(scope, index).getPublicKey();
        // Preserve the SDK Buffer type: its transaction JSON calls
        // toString('base64'). Copy through that type without an app polyfill.
        return publicKey.constructor.from(publicKey);
      }),
    }));
  }
  return state.publicKeys.get(index);
};
const getKeyPair = (index = state.selectedIndex) => publicHandle(capture(), index);
const getSigningKeyPair = async (index = state.selectedIndex) => {
  const scope = capture();
  return authorize(scope, async () => {
    if (!state.signingKeys.has(index)) {
      const raw = await rawKey(scope, index).generateKeyPair();
      assertLocal(scope);
      state.rawSigningKeys.set(index, raw);
      const handle = publicHandle(scope, index);
      state.signingKeys.set(index, Object.freeze({
        ...handle,
        sign: (bytes) => {
          const message = new Uint8Array(bytes);
          return authorize(scope, () => state.rawSigningKeys.get(index).sign(message));
        },
      }));
    }
    return state.signingKeys.get(index);
  });
};
const getAddress = async (index = state.selectedIndex, scope = capture()) =>
  (await publicHandle(scope, index).getAddress()).toString();
const getAddressObject = async (index = state.selectedIndex) => publicHandle(capture(), index).getAddress();
const getAddresses = async (count) => {
  const scope = capture();
  const addresses = [];
  for (let index = 0; index < count; index += 1) addresses.push(await getAddress(index, scope));
  await assertSession(scope);
  return addresses;
};
const getEntropy = async () => authorize(capture(), () => state.keyStore.entropy);
const getMnemonic = async () => authorize(capture(), () => state.keyStore.mnemonic);
const verifyPassword = async (password) => {
  try {
    const scope = capture();
    const walletName = state.walletName;
    const entropy = await authorize(scope, () => state.keyStore.entropy);
    const keyStore = await new KeyStoreManager().readKeyStore(password, walletName);
    await assertSession(scope);
    return Boolean(keyStore && keyStore.entropy === entropy);
  } catch (error) {
    if (error.code === 'WALLET_SESSION_UNAVAILABLE') throw error;
    return false;
  }
};
// The SDK manager combines slow encryption and an unconditional disk write.
// Separate those phases so a completed lock can cancel a pending password change.
const changePassword = async (currentPassword, newPassword) => {
  const scope = capture();
  const verified = await verifyPassword(currentPassword);
  await assertSession(scope);
  if (!verified) return false;
  const walletName = state.walletName;
  const store = {
    getKeyPair: (index = 0) => publicHandle(scope, index),
    get entropy() {
      assertLocal(scope);
      if (!isUnlocked()) throw session.ended();
      return state.keyStore.entropy;
    },
  };
  // Argon2 must not hold the cross-document lock. The only result retained here
  // is encrypted, and publication to persistent storage requires a fresh lease.
  const encrypted = await KeyFile.encrypt(store, newPassword);
  let committed = false;
  try {
    return await authorize(scope, () => {
      const manager = new KeyStoreManager();
      // Match the pinned SDK manager's storage format and name normalization.
      const wallets = manager.listAllKeyStores();
      wallets[walletName.replace(' ', '-')] = encrypted;
      localStorage.setItem(manager.walletPath, JSON.stringify(wallets));
      committed = true;
      return true;
    });
  } catch (error) {
    // A lock ordered after the synchronous write cannot undo it or turn a
    // successful password change into an apparent failure.
    if (committed) return true;
    throw error;
  }
};
const touch = async (patch = {}, scope = capture()) => {
  assertLocal(scope);
  try {
    return await session.touch(scope.id, {
      walletName: state.walletName, entropy: state.keyStore.entropy,
      selectedAddressIndex: patch.selectedAddressIndex ?? state.selectedIndex,
    }, (record) => {
      assertLocal(scope); state.lease = record; schedule(); return true;
    });
  } catch (error) {
    if (['WALLET_LOCKED', 'WALLET_SESSION_UNAVAILABLE'].includes(error.code) && isCurrent(scope)) {
      lock(scope.id, error);
    }
    throw error;
  }
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[session.sessionKey] || !state.keyStore) return;
  const scope = capture();
  authorize(scope, () => true).catch(() => {});
});

const vault = {
  isUnlocked, getWalletName, getSelectedIndex, setSelectedIndex, getEntropy, getMnemonic,
  unlockWithPassword, restore, getKeyPair, getSigningKeyPair, getAddress, getAddressObject,
  getAddresses, verifyPassword, changePassword, touch, capture, isCurrent, assertSession, lock, onLock,
};
export default vault;
