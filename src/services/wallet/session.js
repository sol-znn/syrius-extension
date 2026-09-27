import { Zenon } from 'znn-ts-sdk';
import { getSettings, getCurrentNodeUrl, setSetting as persistSetting, setAddressInfo } from '../utils/storage';
import { sendInternalQuietly } from '../utils/messaging';
import state from './sessionState';
import vault from './vault';

const ownerId = crypto.randomUUID();
let binding = null;
const changed = () => new Error('The wallet session changed. Try again or unlock the wallet.');
const minutesValid = (minutes) => [0, 5, 15, 60].includes(minutes);
const preferredMinutes = () => {
  const minutes = getSettings().autoLockMinutes;
  return minutesValid(minutes) ? minutes : 15;
};
const sameVault = (value) => Boolean(value && vault.isUnlocked() &&
  value.walletName === vault.getWalletName() && value.key === vault.getKeyPair(0));
const bind = (record) => {
  binding = Object.freeze({ ...state.token(record), walletName: record.walletName,
    index: record.selectedAddressIndex, key: vault.getKeyPair(0) });
};
// Synchronous capture matters: a caller must retain this value across its first
// await, rather than obtaining a fresh policy revision after its work finishes.
const capture = () => sameVault(binding) ? binding : null;
const assert = (record, expected) => {
  if (!sameVault(expected) || !state.matches(record, expected) || !state.live(record, ownerId) ||
    expected.index !== vault.getSelectedIndex() || expected.index !== record.selectedAddressIndex) throw changed();
};
// New deliberate activity in a still-open timed document may use a changed
// policy. Already-running callbacks keep their immutable earlier token.
chrome.storage.onChanged.addListener((changes, area) => {
  const record = changes[state.sessionKey]?.newValue;
  if (area === 'session' && sameVault(binding) && record?.id === binding.id &&
    record.selectedAddressIndex === vault.getSelectedIndex() && state.live(record, ownerId)) bind(record);
});
const advance = async (current, next) => {
  const previous = await state.publicValue(current);
  if (!state.live(current, ownerId)) throw changed();
  return state.write(next, previous && state.timed(next) && current.selectedAddressIndex === next.selectedAddressIndex
    ? { ...previous, token: state.token(next) } : null);
};
const begin = () => state.run(async () => state.token(await state.read()));
const load = () => state.run(async () => {
  const current = await state.read();
  if (state.timed(current)) return current;
  // An On close owner's marker has no entropy and is never resumable. Reading
  // it from a fresh document must not revoke that owner's private session.
  if (current && ((current.mode !== 'local' && current.mode !== 'ended') ||
    (current.mode === 'local' && current.privateUntil && current.privateUntil <= Date.now()))) await state.write(state.ended());
  return null;
});
const clear = (expected) => {
  // Failed restore cleanup is exact-revision conditional. Explicit Lock revokes
  // this document's session ID even if another window advanced its revision.
  if (expected !== undefined) return state.clear(expected ? state.token(expected) : null);
  const owned = binding;
  return state.run(async () => {
    const current = await state.read();
    if (!owned || current?.id !== owned.id) return null;
    return state.write(state.ended());
  });
};
const recordFor = (values, minutes, id = crypto.randomUUID()) => ({
  version: 1, id, revision: crypto.randomUUID(), ownerId, minutes,
  walletName: values.walletName, selectedAddressIndex: values.selectedAddressIndex,
  lastActiveAt: Date.now(), expiresAt: minutes ? Date.now() + minutes * 60000 : 0,
  mode: minutes ? 'timed' : 'local', ...(minutes ? { entropy: values.entropy } : {}),
  ...(!minutes && values.privateUntil ? { privateUntil: values.privateUntil } : {}),
});
const adopt = (record, keyStore) => {
  vault.adopt(record.walletName, keyStore);
  vault.setSelectedIndex(record.selectedAddressIndex);
  bind(record);
};
const create = (expected, values, keyStore, commit, prepare = () => {}) => state.run(async () => {
  if (!state.matches(await state.read(), expected)) throw changed();
  const next = recordFor(values, preferredMinutes());
  prepare();
  await state.write(next);
  adopt(next, keyStore);
  commit();
  return capture();
});
const restore = (original, keyStore, commit, prepare = () => {}) => state.run(async () => {
  const current = await state.read();
  if (!state.matches(current, original) || !state.timed(current)) throw changed();
  const next = recordFor(current, current.minutes, current.id);
  prepare();
  await advance(current, next);
  adopt(next, keyStore);
  commit();
  return capture();
});
const isCurrent = (expected) => state.run(async () => {
  try { assert(await state.read(), expected); return true; } catch (error) { return false; }
});
const touch = async (expected) => {
  // Password persistence has already succeeded before this optional renewal.
  // Preserve the base boolean contract for stale authority AND storage failure.
  try {
    return await state.run(async () => {
      const current = await state.read();
      assert(current, expected);
      const next = recordFor({ ...current, entropy: vault.getEntropy() }, current.minutes, current.id);
      await advance(current, next);
      bind(next);
      return true;
    });
  } catch (error) { return false; }
};

const select = async (expected, index, maxAddressIndex, commit) => {
  if (!sameVault(expected) || !Number.isInteger(index) || index < 0 || index >= maxAddressIndex) throw changed();
  const key = vault.getKeyPair(index);
  const address = (await key.getAddress()).toString();
  return state.run(async () => {
    const current = await state.read();
    assert(current, expected);
    if (!setAddressInfo(current.walletName, { selectedAddressIndex: index, maxAddressIndex })) {
      throw new Error('Could not save the selected address. Try again.');
    }
    const next = recordFor({ ...current, selectedAddressIndex: index, entropy: vault.getEntropy() }, current.minutes, current.id);
    await state.write(next);
    vault.setSelectedIndex(index);
    bind(next);
    commit(address);
    return capture();
  });
};
const publish = async (expected, values) => {
  // Public advertisement is best-effort. Its storage/hash failures must not
  // turn an already-committed unlock into an apparent password failure.
  try {
    if (!sameVault(expected)) return false;
    const key = vault.getKeyPair(expected.index);
    const address = (await key.getAddress()).toString();
    return await state.run(async () => {
      const current = await state.read();
      assert(current, expected);
      if (!state.timed(current)) return false;
      await state.write(current, { ...values, address, token: state.token(current) });
      return true;
    });
  } catch (error) { return false; }
};

const updateSetting = async (key, value) => {
  const expected = capture();
  const address = key === 'autoLockMinutes' && expected ?
    (await vault.getKeyPair(expected.index).getAddress()).toString() : null;
  let updatedToken;
  try {
    return await state.run(async () => {
      if (key !== 'autoLockMinutes') return persistSetting(key, value);
      if (!minutesValid(value)) throw new Error('Choose a supported lock duration.');
      const current = await state.read();
      if (!state.timed(current) && (current?.mode !== 'local' ||
        (current.privateUntil && current.privateUntil <= Date.now()))) {
        const ended = await state.write(state.ended());
        updatedToken = state.token(ended);
        return persistSetting(key, value);
      }
      assert(current, expected);
      const entropy = vault.getEntropy();
      const previousDeadline = current.mode === 'timed' ? current.expiresAt : current.privateUntil;
      const next = { ...current, revision: crypto.randomUUID(), ownerId, minutes: value,
        mode: value ? 'timed' : 'local',
        expiresAt: value ? (previousDeadline ? Math.min(previousDeadline, Date.now() + value * 60000) : Date.now() + value * 60000) : 0 };
      delete next.entropy;
      delete next.privateUntil;
      if (value) next.entropy = entropy;
      const publicValue = state.timed(next) ? { address, chainId: Zenon.getChainIdentifier(),
        nodeUrl: getCurrentNodeUrl(), token: state.token(next) } : null;
      // Before preference persistence only tighten authority. If a relaxation's
      // second write fails, the stored policy may be newer but the current
      // session remains stricter; report failure and allow an explicit retry.
      const removesDeadline = value === 0 && Boolean(previousDeadline);
      const relaxing = removesDeadline || (value > 0 && (current.mode === 'local' || value > current.minutes));
      // Timed -> On close both removes resumability and relaxes the owner's
      // lifetime. The intermediate state must keep the intersection: no entropy
      // and the original private deadline until preference persistence succeeds.
      // Conversely, local -> timed must install the new private deadline before
      // saving that finite preference, while still withholding resumable entropy.
      const stage = removesDeadline ? { ...next, revision: crypto.randomUUID(), privateUntil: previousDeadline } :
        current.mode === 'local' && value > 0 ? { ...current, revision: crypto.randomUUID(), privateUntil: next.expiresAt } :
          relaxing ? { ...current, revision: crypto.randomUUID() } : next;
      if (relaxing) await advance(current, stage);
      else await state.write(stage, publicValue);
      bind(stage);
      updatedToken = state.token(stage);
      const settings = persistSetting(key, value);
      if (relaxing) {
        if (!state.live(stage, ownerId)) throw changed();
        await state.write(next, publicValue);
        bind(next);
        updatedToken = state.token(next);
      }
      return settings;
    });
  } finally {
    if (updatedToken) await sendInternalQuietly('events.accountsChanged', { token: updatedToken });
  }
};

const session = { sessionKey: state.sessionKey, publicStateKey: state.publicStateKey,
  capture, begin, load, clear, create, restore, isCurrent, touch, select, publish, updateSetting };
export default session;
