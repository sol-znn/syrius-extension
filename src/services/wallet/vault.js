import { KeyFile, KeyStore, KeyStoreManager, Primitives } from 'znn-ts-sdk';
import session from './session';
import { validateWalletPassword } from './password';
import { sameScope, scopeKey } from './walletScope';

// Raw keystores/keys never leave this module. Every exported key handle is a
// revocable facade, including the public derivation handle used by previews.
//
// `binding` is this document's view of the shared selection (see
// sessionLease.js): `{id: selectionId, ownerId, scope}`. It is one frozen
// object per selection, so a screen can tell by identity whether the selection
// it rendered is still the current one. `selectedIndex` is this window's own
// account; another window choosing an account moves the binding, not it.
const state = {
  generation: 0, walletName: null, keyStore: null, lease: null, binding: null, selectedIndex: 0,
  rawKeys: new Map(), rawSigningKeys: new Map(), publicKeys: new Map(), signingKeys: new Map(), addresses: new Map(),
};
const listeners = new Set();
let timer;
const isCurrent = (scope) => Boolean(scope && state.keyStore &&
  scope.generation === state.generation && scope.id === state.lease?.id);
// Clears this document's keys without telling the UI. Explicit lock uses it to
// purge secrets before shared revocation is confirmed, then reports the
// outcome through `announce` once it is known.
const revokeLocal = (expectedId) => {
  if (expectedId !== undefined && state.lease?.id !== expectedId) return null;
  const wasUnlocked = Boolean(state.keyStore);
  const leaseId = state.lease?.id;
  state.generation += 1;
  state.walletName = null; state.keyStore = null; state.lease = null; state.binding = null; state.selectedIndex = 0;
  state.rawKeys.clear(); state.rawSigningKeys.clear(); state.publicKeys.clear(); state.signingKeys.clear(); state.addresses.clear();
  clearTimeout(timer);
  return wasUnlocked ? { leaseId } : null;
};
const announce = (event, error) => {
  if (event) listeners.forEach((listener) => {
    try { listener({ leaseId: event.leaseId, error }); } catch (error) { /* UI cleanup cannot block key revocation. */ }
  });
};
const lock = (expectedId, error) => announce(revokeLocal(expectedId), error);
const seal = () => {
  const event = revokeLocal();
  return (error) => announce(event, error);
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
const bindingOf = (record) => [record.selectionId, scopeKey(record.scope), record.mode === 'local' ? record.ownerId : null];
const setLease = (record) => {
  const previous = state.lease;
  state.lease = record;
  const before = previous && bindingOf(previous), after = bindingOf(record);
  if (!state.binding || !before || before.some((value, index) => value !== after[index])) {
    state.binding = Object.freeze({ id: record.selectionId, ownerId: record.ownerId, scope: Object.freeze({ ...record.scope }) });
  }
};
// Runs inside the lease transaction (sessionLease.use's check): the selection
// the approval was bound to is still the shared one, for this account.
const bindingCheck = (binding, index) => (record) => {
  if (!binding || record.selectionId !== binding.id || !sameScope(record.scope, binding.scope) ||
      (index !== undefined && binding.scope.index !== index) ||
      (record.mode === 'local' && record.ownerId !== binding.ownerId)) throw session.changed();
};
const schedule = () => {
  clearTimeout(timer);
  if (state.lease?.mode !== 'timed') return;
  const scope = capture();
  timer = setTimeout(() => { authorize(scope, () => true).catch(() => {}); },
    Math.max(0, Math.min(2147483647, state.lease.expiresAt - Date.now())));
};
const authorize = async (scope, operation, check) => {
  assertLocal(scope);
  try {
    const result = await session.use(scope.id, async (record) => {
      assertLocal(scope);
      setLease(record);
      schedule();
      const result = await operation();
      assertLocal(scope);
      return result;
    }, check);
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
  state.walletName = walletName; state.keyStore = keyStore; state.lease = null; state.binding = null; setLease(record);
  state.selectedIndex = Number.isInteger(selectedIndex) && selectedIndex >= 0 ? selectedIndex : 0;
  schedule();
  return capture();
};
// The wallet and account a session is on, derived from the keys themselves:
// the first address identifies the import, so a new seed reusing a wallet name
// is a different wallet.
const scopeOf = async (keyStore, walletName, index) => ({
  walletName, walletId: (await keyStore.getKeyPair(0).getAddress()).toString(),
  address: (await keyStore.getKeyPair(index).getAddress()).toString(), index,
});
// `prepare` runs under the lease lock after the password checks out and before
// the keys are adopted; if it throws, the new lease is revoked and nothing is
// adopted. Startup uses it for the persistence an unlock requires.
const unlockWithPassword = async (walletName, password, selectedIndex = 0, prepare = () => {}) => {
  const generation = state.generation;
  const expectedId = await session.begin();
  if (generation !== state.generation) throw session.ended();
  const keyStore = await new KeyStoreManager().readKeyStore(password, walletName);
  if (!keyStore) throw new Error('Error decrypting');
  if (generation !== state.generation) throw session.ended();
  const scope = await scopeOf(keyStore, walletName, selectedIndex);
  if (generation !== state.generation) throw session.ended();
  return session.create(expectedId, { walletName, entropy: keyStore.entropy, selectedAddressIndex: selectedIndex, scope }, (record) => {
    if (generation !== state.generation) throw session.ended();
    prepare();
    return adopt(walletName, keyStore, record, selectedIndex);
  });
};
// Resumes the shared selection as recorded: its account, checked against the
// keys it would resume, so a record cannot pair one wallet's name and scope
// with another's entropy.
const restore = async (record, prepare = () => {}) => {
  const generation = state.generation;
  const index = record?.scope?.index;
  if (!record?.entropy || !Number.isSafeInteger(index)) throw session.ended();
  const scope = await scopeOf(new KeyStore().fromEntropy(record.entropy), record.walletName, index);
  if (generation !== state.generation || !sameScope(scope, record.scope)) throw session.ended();
  return session.restore(record, scope, (current, entropy) => {
    if (generation !== state.generation) throw session.ended();
    prepare();
    return adopt(current.walletName, new KeyStore().fromEntropy(entropy), current, current.scope.index);
  });
};
const getSelectedIndex = () => state.selectedIndex;
const setSelectedIndex = (index) => {
  capture();
  state.selectedIndex = Number.isInteger(index) && index >= 0 ? index : 0;
};
const getWalletName = () => state.walletName;
const getLeaseId = () => state.lease?.id ?? null;
const getBinding = () => state.binding;
const assertBinding = (binding) => {
  if (!binding || binding !== state.binding || !isUnlocked()) throw session.changed();
};
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
// A binding-scoped handle checks the selection under the lease lock at every
// use. Approvals sign through one, so an account switch in any window stops
// them at their next key operation rather than letting them sign as whoever is
// selected by then.
const signingHandle = (scope, index, check) => Object.freeze({
  getAddress: () => authorize(scope, async () => {
    if (!state.addresses.has(index)) {
      const address = (await rawKey(scope, index).getAddress()).toString();
      assertLocal(scope);
      state.addresses.set(index, address);
    }
    return Primitives.Address.parse(state.addresses.get(index));
  }, check),
  getPublicKey: () => authorize(scope, async () => {
    const publicKey = await rawKey(scope, index).getPublicKey();
    // Preserve the SDK Buffer type: its transaction JSON calls
    // toString('base64'). Copy through that type without an app polyfill.
    return publicKey.constructor.from(publicKey);
  }, check),
  sign: (bytes) => {
    const message = new Uint8Array(bytes);
    return authorize(scope, () => state.rawSigningKeys.get(index).sign(message), check);
  },
});
const getSigningKeyPair = async (index = state.selectedIndex, binding) => {
  const scope = capture();
  const check = binding ? bindingCheck(binding, index) : undefined;
  return authorize(scope, async () => {
    if (!state.signingKeys.has(index)) {
      const raw = await rawKey(scope, index).generateKeyPair();
      assertLocal(scope);
      state.rawSigningKeys.set(index, raw);
      state.signingKeys.set(index, signingHandle(scope, index));
    }
    return binding ? signingHandle(scope, index, check) : state.signingKeys.get(index);
  }, check);
};
// Runs `operation` under the lease lock while `binding` is still the shared
// selection. Starting a block's publication goes through here: the account it
// was approved for is checked at the moment it is sent.
const whileBound = (binding, operation) => authorize(capture(), operation, bindingCheck(binding));
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
  // The strength policy belongs to the encrypted-wallet commit, not only the
  // form in front of it: a bypassed submit must not save a weak password.
  const validation = validateWalletPassword(newPassword);
  if (validation !== true) throw new Error(validation);
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
const lockOn = (scope, error) => {
  if (['WALLET_LOCKED', 'WALLET_SESSION_UNAVAILABLE'].includes(error.code) && isCurrent(scope)) lock(scope.id, error);
};
const touch = async (scope = capture()) => {
  assertLocal(scope);
  try {
    return await session.touch(scope.id, {
      walletName: state.walletName, entropy: state.keyStore.entropy,
    }, (record) => {
      assertLocal(scope); setLease(record); schedule(); return true;
    });
  } catch (error) { lockOn(scope, error); throw error; }
};
// Chooses this window's account and makes it the shared selection: a new
// selection generation, saved as the wallet's selected address first.
const selectAddress = async (index, maxAddressIndex, scope = capture()) => {
  assertLocal(scope);
  try {
    const address = await getAddress(index, scope);
    const record = await session.select(scope.id, { index, address, entropy: state.keyStore.entropy }, state.walletName, maxAddressIndex);
    assertLocal(scope); setLease(record); schedule();
    state.selectedIndex = index;
    return { address, binding: state.binding };
  } catch (error) { lockOn(scope, error); throw error; }
};
// Applies a changed lock duration to this running session; the preference is
// saved inside the same lease transaction. A failed preference write leaves the
// staged (stricter) record in place and is reported for an explicit retry.
const setLockPolicy = async (minutes, scope = capture()) => {
  assertLocal(scope);
  try {
    const { record, settings } = await session.setPolicy(scope.id, minutes, state.keyStore.entropy);
    assertLocal(scope); setLease(record); schedule();
    return settings;
  } catch (error) {
    if (['WALLET_LOCKED', 'WALLET_SESSION_UNAVAILABLE'].includes(error.code) && isCurrent(scope)) {
      lock(scope.id, error);
    } else if (isCurrent(scope)) {
      // The stage may already be committed; pick it up for local expiry.
      authorize(scope, () => true).catch(() => {});
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
  isUnlocked, getWalletName, getLeaseId, getBinding, assertBinding, getSelectedIndex, setSelectedIndex, getEntropy,
  getMnemonic, unlockWithPassword, restore, getKeyPair, getSigningKeyPair, whileBound, getAddress, getAddressObject,
  getAddresses, verifyPassword, changePassword, touch, selectAddress, setLockPolicy, capture, isCurrent, assertSession,
  lock, seal, onLock,
};
export default vault;
