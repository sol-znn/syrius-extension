import selection from '../../services/wallet/selection';

const storageKey = 'syrius.permissions';
const deniedKey = 'syrius.permissionDenials';
const revoked = new Set();
const keyOf = (origin, scope) => JSON.stringify([origin, selection.scopeKey(scope)]);
const readAll = async () => {
  const value = (await chrome.storage.local.get(storageKey))[storageKey];
  // Origin-only grants from previous versions never become scoped grants.
  return value?.version === 2 && Array.isArray(value.entries) ? value.entries.filter(entry =>
    entry.active === true && typeof entry.origin === 'string' && selection.validScope(entry.scope)) : [];
};
const writeAll = entries => chrome.storage.local.set({ [storageKey]: { version: 2, entries } });
const serialized = operation => navigator.locks.request(storageKey, async () => operation(await readAll()));
const denied = async (origin, scope) => {
  const stored = (await chrome.storage.session.get(deniedKey))[deniedKey] || [];
  return revoked.has('*') || revoked.has(origin) || revoked.has(keyOf(origin, scope)) ||
    stored.includes('*') || stored.includes(origin) || stored.includes(keyOf(origin, scope));
};
const find = (entries, origin, scope) => entries.find(entry => entry.origin === origin && selection.sameScope(entry.scope, scope));
const connected = async (entries, origin, scope) => Boolean(find(entries, origin, scope)) && !(await denied(origin, scope));
const originOf = sender => {
  try { return sender?.origin || (sender?.url ? new URL(sender.url).origin : null); }
  catch (error) { return null; }
};
const isConnected = (origin, scope) => serialized(entries => connected(entries, origin, scope));
const list = () => serialized(async entries => {
  const allowed = await Promise.all(entries.map(entry => connected(entries, entry.origin, entry.scope)));
  return entries.filter((_, index) => allowed[index]).sort((a, b) => b.connectedAt - a.connectedAt);
});
const grant = (origin, scope, { title = '', favicon = '' } = {}) => serialized(async entries => {
  if (!origin || !selection.validScope(scope)) throw selection.ended();
  const next = entries.filter(entry => entry.origin !== origin || !selection.sameScope(entry.scope, scope));
  const granted = { active: true, origin, scope: { ...scope }, title, favicon, connectedAt: Date.now(), lastUsedAt: Date.now() };
  next.push(granted);
  // Local permission is saved before denial is lifted. Failed persistence can
  // never report a grant. Explicit reconnection may clear an older revocation.
  const key = keyOf(origin, scope);
  revoked.add(key);
  const before = (await chrome.storage.session.get(deniedKey))[deniedKey] || [];
  await chrome.storage.session.set({ [deniedKey]: [...new Set([...before, key])] });
  await writeAll([...entries, { ...granted, active: false }]);
  const stored = (await chrome.storage.session.get(deniedKey))[deniedKey] || [];
  await chrome.storage.session.set({ [deniedKey]: stored.filter(key => !['*', origin, keyOf(origin, scope)].includes(key)) });
  await writeAll(next);
  revoked.delete('*'); revoked.delete(origin); revoked.delete(keyOf(origin, scope));
  return true;
});
const withdraw = predicate => serialized(async entries => {
  const affected = entries.filter(predicate);
  const keys = affected.map(entry => keyOf(entry.origin, entry.scope));
  keys.forEach(key => revoked.add(key));
  const stored = (await chrome.storage.session.get(deniedKey))[deniedKey] || [];
  await chrome.storage.session.set({ [deniedKey]: [...new Set([...stored, ...keys])] });
  await writeAll(entries.filter(entry => !predicate(entry)));
  return affected;
});
const revoke = (origin, scope) => withdraw(entry => entry.origin === origin && (!scope || selection.sameScope(entry.scope, scope)));
const revokeAll = () => withdraw(() => true);
const revokeWallet = scope => withdraw(entry => selection.sameWallet(entry.scope, scope));
// Cleanup needs every durable target, including a grant conservatively denied
// in this document. Another worker realm may have reconnected it meanwhile.
const forWallet = scope => serialized(entries => entries.filter(entry => selection.sameWallet(entry.scope, scope)));
const touch = (origin, scope) => serialized(async entries => {
  if (!(await connected(entries, origin, scope))) return false;
  find(entries, origin, scope).lastUsedAt = Date.now();
  await writeAll(entries);
  return true;
});
const permissions = { storageKey, originOf, isConnected, list, grant, revoke, revokeAll, revokeWallet, forWallet, touch };
export default permissions;
