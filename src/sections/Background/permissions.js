import selection from '../../services/wallet/selection';

// Which sites may see which wallet account.
//
// A connection is read access to one wallet import's one account (`scope`),
// its chain identifier and node, granted per origin and remembered. It is never
// permission to move anything: signing and sending are prompted every time.
// Consent that named only an origin followed whichever wallet or account was
// selected later; grants from those versions are not carried over.
//
// Rows are `{active: true, origin, scope, ...}`, or a tentative row that is
// inactive by itself — `{active: false, pendingApproval, previous}` — written
// while a new connection waits for the page's relay to accept its response.
// Readers and writers share a lock, so an immediate follow-up waits for the
// accepted connection's durable promotion, and stale writes cannot undo a
// revocation. A revocation is also recorded as a session denial before the
// durable row is removed, so a failed removal still withdraws access.
const storageKey = 'syrius.permissions';
const deniedKey = 'syrius.permissionDenials';
const revoked = new Set();
const keyOf = (origin, scope) => JSON.stringify([origin, selection.scopeKey(scope)]);
const validRow = (entry) => Boolean(entry && typeof entry.origin === 'string' && selection.validScope(entry.scope) &&
  (entry.active === true || (entry.active === false && entry.pendingApproval)));
const readRaw = async () => {
  const value = (await chrome.storage.local.get(storageKey))[storageKey];
  return value?.version === 2 && Array.isArray(value.entries) ? value.entries.filter(validRow) : [];
};
const writeAll = (entries) => chrome.storage.local.set({ [storageKey]: { version: 2, entries } });
const serialized = (operation) => navigator.locks.request(storageKey, async () => operation(await readRaw()));
// A tentative row stands for the grant it would replace, if any.
const activeOf = (entry) => (entry.active === true ? entry : entry.previous?.active === true ? entry.previous : null);
const activeEntries = (raw) => raw.map(activeOf).filter(Boolean);
const checkDeadline = (expiresAt) => {
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) throw new Error('Approval expired during finalization.');
};
// A denial record that cannot be read as one withholds everything (callers
// fail closed) rather than being read as "nothing revoked".
const readDenials = async () => {
  const stored = (await chrome.storage.session.get(deniedKey))[deniedKey];
  if (stored === undefined) return [];
  if (!Array.isArray(stored) || !stored.every((item) => typeof item === 'string')) {
    throw new Error('Connected-site revocations are unavailable. Retry disconnecting.');
  }
  return stored;
};
const denied = async (origin, scope) => {
  const stored = await readDenials();
  return revoked.has('*') || revoked.has(origin) || revoked.has(keyOf(origin, scope)) ||
    stored.includes('*') || stored.includes(origin) || stored.includes(keyOf(origin, scope));
};
const find = (entries, origin, scope) => entries.find((entry) => entry.origin === origin && selection.sameScope(entry.scope, scope));
const connected = async (raw, origin, scope) => Boolean(find(activeEntries(raw), origin, scope)) && !(await denied(origin, scope));

// A page can claim to be any origin it likes in a postMessage, so the origin
// used for a permission decision is always the one Chrome reports for the
// sender, never one the page supplied.
const originOf = (sender) => {
  try { return sender?.origin || (sender?.url ? new URL(sender.url).origin : null); }
  catch (error) { return null; }
};
// Fails closed: an unreadable store is not consent.
const isConnected = async (origin, scope) => {
  try { return await serialized((raw) => connected(raw, origin, scope)); }
  catch (error) { return false; }
};
// The active grant for exactly this account, whether or not a session denial
// currently withholds it.
const get = (origin, scope) => serialized((raw) => find(activeEntries(raw), origin, scope) || null);
// Every saved grant, including one whose revocation did not complete: it stays
// visible (`revocationPending`, access already withheld) so it can be retried.
const list = () => serialized(async (raw) => {
  const entries = activeEntries(raw);
  const pending = await Promise.all(entries.map((entry) => denied(entry.origin, entry.scope).catch(() => true)));
  return entries.map((entry, index) => ({ ...entry, revocationPending: pending[index] }))
    .sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));
});
// Saves a tentative (inactive) row first, preserving any prior consent. The
// exact isolated relay must accept the connection response before the fixed
// deadline (`confirm` returns its receipt); that acceptance is the consent
// commitment point, and the durable promotion completes it. Any failure puts
// the prior state back, and a stranded tentative row stays inactive — even
// after a browser restart loses every session-only record.
const grant = (origin, scope, { title = '', favicon = '' } = {}, { expiresAt, confirm } = {}) => serialized(async (raw) => {
  if (!origin || !selection.validScope(scope)) throw selection.ended();
  if (typeof confirm !== 'function') return false;
  checkDeadline(expiresAt);
  const same = (entry) => entry.origin === origin && selection.sameScope(entry.scope, scope);
  const others = raw.filter((entry) => !same(entry));
  const previous = raw.filter(same).map(activeOf).find(Boolean) || null;
  const restored = previous ? [...others, previous] : others;
  await writeAll([...others, { active: false, origin, scope: { ...scope }, pendingApproval: { id: crypto.randomUUID(), expiresAt }, previous }]);
  try {
    checkDeadline(expiresAt);
    const receipt = await confirm();
    if (receipt?.accepted !== true || !Number.isFinite(receipt.acceptedAt) || receipt.acceptedAt >= expiresAt) {
      throw new Error('The connection was not accepted before its approval expired.');
    }
    await writeAll([...others, { active: true, origin, scope: { ...scope }, title, favicon,
      connectedAt: previous?.connectedAt || Date.now(), lastUsedAt: Date.now(), approvalAcceptedAt: receipt.acceptedAt }]);
  } catch (error) {
    await writeAll(restored).catch(() => {}); // A stranded tentative row stays inactive.
    throw error;
  }
  // Explicit reconnection clears an earlier revocation of exactly this grant.
  // Only now, once the new grant is durable: lifting it first would let a
  // failed reconnect restore a revoked grant whose durable removal had failed.
  // Written only when there is a denial to lift, so a grant that needed no
  // session write is not reported as failed after it took effect. If one
  // cannot be lifted, the grant is reported failed and stays withheld.
  const key = keyOf(origin, scope);
  const stored = await readDenials();
  const lifted = stored.filter((item) => !['*', origin, key].includes(item));
  if (lifted.length !== stored.length) await chrome.storage.session.set({ [deniedKey]: lifted });
  revoked.delete('*'); revoked.delete(origin); revoked.delete(key);
  return true;
});
// Withdrawal denies in this realm at once, then installs a session denial,
// then removes the durable row. Removal is attempted even when the denial
// cannot be saved: on its own it revokes across a browser restart. Only a
// failed removal is reported, and the grant then stays listed as pending.
const withdraw = (predicate) => serialized(async (raw) => {
  const affected = activeEntries(raw).filter(predicate);
  const keys = raw.filter(predicate).map((entry) => keyOf(entry.origin, entry.scope));
  keys.forEach((key) => revoked.add(key));
  try {
    const stored = await readDenials();
    await chrome.storage.session.set({ [deniedKey]: [...new Set([...stored, ...keys])] });
  } catch (error) {
    // This realm's denial above still holds; the durable removal decides.
  }
  await writeAll(raw.filter((entry) => !predicate(entry)));
  return affected;
});
const revoke = (origin, scope) => withdraw((entry) => entry.origin === origin && (!scope || selection.sameScope(entry.scope, scope)));
const revokeAll = () => withdraw(() => true);
const revokeWallet = (scope) => withdraw((entry) => selection.sameWallet(entry.scope, scope));
// Cleanup needs every durable target, including a grant conservatively denied
// in this realm. Another worker realm may have reconnected it meanwhile.
const forWallet = (scope) => serialized((raw) => activeEntries(raw).filter((entry) => selection.sameWallet(entry.scope, scope)));
const touch = (origin, scope) => serialized(async (raw) => {
  if (!(await connected(raw, origin, scope))) return false;
  const entry = raw.find((row) => row.active === true && row.origin === origin && selection.sameScope(row.scope, scope));
  if (!entry) return false;
  entry.lastUsedAt = Date.now();
  await writeAll(raw);
  return true;
});

const permissions = { storageKey, deniedKey, originOf, isConnected, get, list, grant, revoke, revokeAll, revokeWallet, forWallet, touch };
export default permissions;
