// Shared by extension pages and the worker; never imports the SDK or secrets.
// Lock order: selection -> permissions -> pending requests. Never acquire
// selection from a worker check invoked by a key operation holding this lock.
const sessionKey = 'znn.unlock';
const publicStateKey = 'znn.publicState';
const lockName = 'znn.walletSelection';
const ended = () => new Error('The wallet or account changed. Unlock and review a new request.');
const validScope = scope => Boolean(scope && typeof scope.walletId === 'string' && scope.walletId &&
  typeof scope.walletName === 'string' && scope.walletName && typeof scope.address === 'string' && scope.address &&
  Number.isSafeInteger(scope.index) && scope.index >= 0);
// Exact stored name separates duplicate imports of the same seed. The fixed
// first address prevents a replacement seed reusing a name from inheriting it.
const sameWallet = (a, b) => validScope(a) && validScope(b) && a.walletId === b.walletId && a.walletName === b.walletName;
const sameScope = (a, b) => sameWallet(a, b) && a.address === b.address && a.index === b.index;
const scopeKey = scope => validScope(scope) ? JSON.stringify([scope.walletName, scope.walletId, scope.address, scope.index]) : null;
const read = async () => chrome.storage.session.get([sessionKey, publicStateKey]);
const transaction = operation => navigator.locks.request(lockName, async () => operation(await read()));
const current = stored => stored[sessionKey];
const live = record => Boolean(record?.id && validScope(record.scope) && !record.locked &&
  (record.mode === 'local' ? record.ownerId : record.mode === 'timed' && Number.isFinite(record.expiresAt) && Date.now() < record.expiresAt));
const matches = (record, binding, owner = false) => live(record) && record.id === binding?.id &&
  sameScope(record.scope, binding.scope) && (!owner || record.mode !== 'local' || record.ownerId === binding.ownerId);
const assert = (record, binding, owner = false) => { if (!matches(record, binding, owner)) throw ended(); };
const use = (binding, operation) => transaction(async stored => {
  const record = current(stored);
  assert(record, binding, true);
  const result = await operation(record);
  assert(record, binding, true);
  return result;
});
const publicValue = (stored, expectedId) => {
  const record = current(stored), value = stored[publicStateKey];
  if (!live(record) || record.mode === 'local' || value?.selectionId !== record.id ||
      !sameScope(value.scope, record.scope) || (expectedId !== undefined && record.id !== expectedId)) return null;
  return value;
};
const write = record => chrome.storage.session.set({ [sessionKey]: record, [publicStateKey]: null });
const revoke = async record => {
  const tombstone = { id: crypto.randomUUID(), locked: true, scope: validScope(record?.scope) ? record.scope : null };
  await write(tombstone);
  return tombstone.id;
};
const selection = { sessionKey, publicStateKey, validScope, sameWallet, sameScope, scopeKey, read, transaction, current,
  live, matches, assert, use, publicValue, write, revoke, ended };
export default selection;
