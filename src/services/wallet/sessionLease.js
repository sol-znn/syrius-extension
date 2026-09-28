// Shared by extension pages and the service worker. Keep this module SDK-free.
const sessionKey = 'znn.unlock';
const publicStateKey = 'znn.publicState';
const lockName = 'znn.walletSession';
const ended = () => Object.assign(new Error('The wallet session ended. Unlock it again.'), { code: 'WALLET_LOCKED' });
const unavailable = () => Object.assign(new Error('Could not confirm the wallet session. Other wallet windows may still be unlocked. Try again or close the browser.'), {
  code: 'WALLET_SESSION_UNAVAILABLE',
});
const storage = async (method, value) => {
  try { return await chrome.storage.session[method](value); }
  catch (error) { throw unavailable(); }
};
const transaction = (operation) => navigator.locks.request(lockName, async () =>
  operation(await storage('get', [sessionKey, publicStateKey])));
const identity = (record) => record?.id ?? null;
const live = (record) => Boolean(record?.id && record.walletName && (
  record.mode === 'local' ? record.ownerId :
    record.mode === 'timed' && record.entropy && Number.isFinite(record.expiresAt) && Date.now() < record.expiresAt
));
const allowed = (record, id, ownerId) => live(record) && record.id === id &&
  (record.mode !== 'local' || record.ownerId === ownerId);
const revoke = async () => {
  const id = crypto.randomUUID();
  // Keep a non-secret generation after clearing. An in-flight unlock that
  // began before lock must not mistake an empty store for its original state.
  await storage('set', { [sessionKey]: { id, locked: true }, [publicStateKey]: null });
  return id;
};
const assertLease = async (record, id, ownerId) => {
  if (!allowed(record, id, ownerId)) {
    if (record?.id === id && record.mode === 'timed' && !live(record)) await revoke();
    throw ended();
  }
};
const recordFrom = ({ id, walletName, entropy, selectedAddressIndex, ownerId, minutes }) => {
  if (!walletName || !entropy || !ownerId) throw ended();
  const duration = Number(minutes) * 60 * 1000;
  const timed = Number.isFinite(duration) && duration > 0;
  return {
    id, walletName, selectedAddressIndex, ownerId,
    mode: timed ? 'timed' : 'local',
    lastActiveAt: Date.now(),
    expiresAt: timed ? Date.now() + duration : 0,
    // On close has no resumable key material outside its owning document.
    ...(timed ? { entropy } : {}),
  };
};
const begin = () => transaction((stored) => identity(stored[sessionKey]));
const create = (expectedId, values, adopt) => transaction(async (stored) => {
  if (identity(stored[sessionKey]) !== expectedId) throw ended();
  const record = recordFrom({ ...values, id: crypto.randomUUID() });
  await storage('set', { [sessionKey]: record, [publicStateKey]: null });
  try { return await adopt(record); }
  catch (error) { await revoke(); throw error; }
});
const use = (id, ownerId, operation) => transaction(async (stored) => {
  const record = stored[sessionKey];
  await assertLease(record, id, ownerId);
  const result = await operation(record);
  // Includes time spent in async crypto. Never release a result after expiry.
  await assertLease(record, id, ownerId);
  return result;
});
const renew = (id, values, operation) => transaction(async (stored) => {
  const current = stored[sessionKey];
  await assertLease(current, id, values.ownerId);
  if ((values.walletName && values.walletName !== current.walletName) ||
      (values.resumable && current.mode !== 'timed')) throw ended();
  const record = recordFrom({
    ...current, ...values, id,
    entropy: values.entropy || current.entropy,
  });
  await storage('set', { [sessionKey]: record });
  return operation(record, current.entropy);
});
const load = () => transaction(async (stored) => {
  const record = stored[sessionKey];
  if (!record || record.locked || record.mode === 'local') return null;
  if (!live(record)) { await revoke(); return null; }
  return record;
});
const clear = (expectedId) => transaction((stored) =>
  expectedId !== undefined && identity(stored[sessionKey]) !== expectedId ? null : revoke());
const publish = (id, ownerId, value) => use(id, ownerId, async () => {
  await storage('set', { [publicStateKey]: { ...value, leaseId: id } });
  return true;
});
const getPublicState = (expectedId, allowLocal = false) => transaction((stored) => {
  const record = stored[sessionKey];
  const value = stored[publicStateKey];
  if (!live(record) || (!allowLocal && record.mode === 'local') ||
      (expectedId !== undefined && record.id !== expectedId) || value?.leaseId !== record.id) return null;
  return value;
});
const isLockedGeneration = (id) => transaction((stored) =>
  identity(stored[sessionKey]) === id && !stored[publicStateKey]);
const expire = () => transaction(async (stored) => {
  const record = stored[sessionKey];
  if (!record || record.locked) return null;
  if (record.mode === 'local') {
    // Preserve the existing On close public-state behavior without revoking
    // the owning document's private lifetime while it is still open.
    if (!stored[publicStateKey]) return null;
    await storage('set', { [publicStateKey]: null });
    return record.id;
  }
  return live(record) ? null : revoke();
});

const sessionLease = { sessionKey, publicStateKey, ended, unavailable, begin, create, use, renew, load, clear, publish, getPublicState, isLockedGeneration, expire };
export default sessionLease;
