// Shared by extension pages and the service worker. Keep this module SDK-free.
//
// One record under `znn.unlock` is the wallet's shared authority. It carries
// two identities, for two different things:
//
// - `id`, the lease. Every live key handle is bound to it, and it changes only
//   when the wallet is unlocked with a password or locked. Revoking it is what
//   ends every window's access at once.
// - `selectionId`, the selection generation: which wallet import and which of
//   its accounts (`scope`) the person has chosen. Site consent, request
//   admission, the request shown for approval and its result are all bound to
//   it, so it also changes when the account changes. Keeping it separate from
//   the lease means switching account in one window does not lock the others.
//
// The lock policy (`minutes`, and `privateUntil` for an On close owner) lives
// in the record too, so a renewal computes its deadline from the policy current
// under the lock rather than from a preference some caller read earlier.
import { sameScope, validScope } from './walletScope';

const sessionKey = 'znn.unlock';
const publicStateKey = 'znn.publicState';
const lockName = 'znn.walletSession';
// Records from before the policy and scope moved into the record are not live:
// they require one password unlock after this update.
const version = 2;
const lockChoices = [0, 5, 15, 60];
const ended = () => Object.assign(new Error('The wallet session ended. Unlock it again.'), { code: 'WALLET_LOCKED' });
const unavailable = () => Object.assign(new Error('Could not confirm the wallet session. Other wallet windows may still be unlocked. Try again or close the browser.'), {
  code: 'WALLET_SESSION_UNAVAILABLE',
});
// The selection moved on: not a lock, and not a reason to purge keys.
const changed = () => Object.assign(new Error('The wallet or account changed. Unlock and review a new request.'), {
  code: 'WALLET_SELECTION_CHANGED',
});
const storage = async (method, value) => {
  try { return await chrome.storage.session[method](value); }
  catch (error) { throw unavailable(); }
};
const read = () => storage('get', [sessionKey, publicStateKey]);
// Lock order across the extension: session -> permissions -> pending requests.
// Nothing that holds this lock may wait on a message to another context that
// would itself need it.
const transaction = (operation) => navigator.locks.request(lockName, async () => operation(await read()));
const identity = (record) => record?.id ?? null;
// `expected` is a lease id, or `{id, revision}` to also require that no policy
// change has happened since it was read. Cleanup after a failed restore uses
// the second form: a record its owner has since switched to On close keeps its
// id, and must not be revoked by a window that merely failed to resume it.
const matchesExpected = (record, expected) => (expected && typeof expected === 'object'
  ? identity(record) === expected.id && record?.revision === expected.revision
  : identity(record) === expected);
const validMinutes = (minutes) => lockChoices.includes(minutes);
const live = (record) => Boolean(record?.id && record.version === version && record.walletName &&
  record.selectionId && validScope(record.scope) && validMinutes(record.minutes) && (
    record.mode === 'local' ? record.ownerId && (!record.privateUntil || Date.now() < record.privateUntil) :
      record.mode === 'timed' && record.entropy && Number.isFinite(record.expiresAt) && Date.now() < record.expiresAt
  ));
const allowed = (record, id, ownerId) => live(record) && record.id === id &&
  (record.mode !== 'local' || record.ownerId === ownerId);
// Keep a non-secret generation after clearing. An in-flight unlock that began
// before lock must not mistake an empty store for its original state. The
// tombstone keeps the scope and a selection generation of its own, so a request
// admitted while locked can follow the next unlock of the same account.
const revoke = async (record) => {
  const id = crypto.randomUUID();
  await storage('set', { [sessionKey]: {
    id, locked: true, selectionId: crypto.randomUUID(), scope: validScope(record?.scope) ? record.scope : null,
  }, [publicStateKey]: null });
  return id;
};
// A deadline that has passed is revoked by whoever notices: a timed record's
// entropy, or an On close owner's staged finite deadline.
const lapsed = (record) => Boolean(record && !record.locked && !live(record) &&
  (record.mode === 'timed' || (record.mode === 'local' && record.privateUntil)));
const assertLease = async (record, id, ownerId) => {
  if (!allowed(record, id, ownerId)) {
    if (record?.id === id && lapsed(record)) await revoke(record);
    throw ended();
  }
};
// On close has no resumable key material outside its owning document. A
// staged `privateUntil` bounds that owner while a policy change is pending.
const recordFrom = ({
  id, revision, walletName, entropy, selectedAddressIndex, ownerId, minutes, privateUntil, selectionId, scope, resumeFrom,
}) => {
  if (!walletName || !entropy || !ownerId || !validMinutes(minutes) || !validScope(scope)) throw ended();
  const timed = minutes > 0;
  return {
    version, id, revision: revision || crypto.randomUUID(), walletName, selectedAddressIndex, ownerId, minutes,
    selectionId: selectionId || crypto.randomUUID(), scope, resumeFrom: resumeFrom ?? null,
    mode: timed ? 'timed' : 'local',
    lastActiveAt: Date.now(),
    expiresAt: timed ? Date.now() + minutes * 60000 : 0,
    ...(timed ? { entropy } : privateUntil ? { privateUntil } : {}),
  };
};
const begin = () => transaction((stored) => identity(stored[sessionKey]));
const create = (expectedId, values, adopt) => transaction(async (stored) => {
  const current = stored[sessionKey];
  if (identity(current) !== expectedId) throw ended();
  // The preference is read inside the lock, so a policy change that committed
  // while the password was being checked is the one this session starts under.
  // Unlocking the account that was just locked (or is still unlocked) resumes
  // from its generation: see requests.nextFor.
  const record = recordFrom({ ...values, minutes: values.minutes(), id: crypto.randomUUID(), selectionId: null,
    resumeFrom: sameScope(current?.scope, values.scope) ? current.selectionId : null });
  await storage('set', { [sessionKey]: record, [publicStateKey]: null });
  try { return await adopt(record); }
  catch (error) { await revoke(record); throw error; }
});
// `check(record)` runs inside the transaction before and after the operation;
// a selection binding uses it (see vault's bound handles).
const use = (id, ownerId, operation, check) => transaction(async (stored) => {
  const record = stored[sessionKey];
  await assertLease(record, id, ownerId);
  check?.(record);
  const result = await operation(record);
  // Includes time spent in async crypto. Never release a result after expiry.
  await assertLease(record, id, ownerId);
  check?.(record);
  return result;
});
// Activity and restore renew under the record's own policy. A caller that
// captured an older preference cannot extend the session past the current one.
const renew = (id, values, operation) => transaction(async (stored) => {
  const current = stored[sessionKey];
  await assertLease(current, id, values.ownerId);
  if ((values.walletName && values.walletName !== current.walletName) ||
      (values.resumable && current.mode !== 'timed') ||
      (values.scope && !sameScope(values.scope, current.scope))) throw ended();
  const record = recordFrom({
    ...current, id, ownerId: values.ownerId,
    entropy: values.entropy || current.entropy,
  });
  await storage('set', { [sessionKey]: record });
  return operation(record, current.entropy);
});
// Choosing another account starts a new selection generation: consent, public
// state and anything admitted under the old account no longer apply to it. The
// saved selection (`persist`) is written first; if it fails nothing changes.
// `entropy` is the caller's: an On close record holds none (recordFrom keeps it
// only for a timed session).
const select = (id, ownerId, { index, address, entropy }, persist) => transaction(async (stored) => {
  const current = stored[sessionKey];
  await assertLease(current, id, ownerId);
  if (!Number.isSafeInteger(index) || index < 0 || typeof address !== 'string' || !address) throw changed();
  persist();
  const record = recordFrom({
    ...current, id, ownerId, selectedAddressIndex: index, entropy: entropy || current.entropy,
    scope: { ...current.scope, index, address }, selectionId: crypto.randomUUID(), resumeFrom: null,
  });
  await storage('set', { [sessionKey]: record, [publicStateKey]: null });
  return record;
});
// Applies a changed lock duration to the running session.
//
// A shorter duration clamps the deadline without extending time already left.
// Anything that relaxes authority — a longer duration, leaving On close for a
// timed duration, or entering On close from a finite deadline — is staged: the
// stricter intersection is written first, the preference is saved, and only
// then is the relaxed record written. A failure at any step leaves the session
// no less strict than both the old and the new policy.
const setPolicy = (id, ownerId, minutes, entropy, persist) => transaction(async (stored) => {
  if (!validMinutes(minutes)) throw new Error('Choose a supported lock duration.');
  const current = stored[sessionKey];
  await assertLease(current, id, ownerId);
  const now = Date.now();
  const previousDeadline = current.mode === 'timed' ? current.expiresAt : current.privateUntil || 0;
  const timed = minutes > 0;
  const deadline = timed ? Math.min(previousDeadline || Infinity, now + minutes * 60000) : 0;
  const { entropy: _entropy, privateUntil: _privateUntil, ...kept } = current;
  // Every policy write gets a new revision; see matchesExpected.
  const next = { ...kept, revision: crypto.randomUUID(), ownerId, minutes, mode: timed ? 'timed' : 'local',
    expiresAt: deadline, ...(timed ? { entropy } : {}) };
  const removesDeadline = !timed && Boolean(previousDeadline);
  const relaxing = removesDeadline || (timed && (current.mode === 'local' || minutes > current.minutes));
  const stage = removesDeadline ? { ...next, privateUntil: previousDeadline } :
    current.mode === 'local' && timed ? { ...kept, revision: crypto.randomUUID(), ownerId, privateUntil: deadline } :
      relaxing ? null : next;
  // Public wallet state is never readable under On close, so leaving timed
  // withdraws it in the same commit.
  const write = (record) => storage('set', { [sessionKey]: record,
    ...(record.mode === 'local' ? { [publicStateKey]: null } : {}) });
  if (stage) await write(stage);
  const settings = persist();
  if (relaxing) await write(next);
  return { record: relaxing ? next : stage, settings };
});
const load = () => transaction(async (stored) => {
  const record = stored[sessionKey];
  if (!record || record.locked || record.mode === 'local') return null;
  if (!live(record)) { await revoke(record); return null; }
  return record;
});
// `afterRevoke` runs synchronously inside the same transaction, after the
// revocation is written: nothing can unlock between the two. Wallet removal
// deletes the keyfile there, so it is never deleted while any window can still
// sign with it, and never left deletable by a lock that did not happen.
const clear = (expected, afterRevoke) => transaction(async (stored) => {
  if (expected !== undefined && !matchesExpected(stored[sessionKey], expected)) return null;
  const id = await revoke(stored[sessionKey]);
  afterRevoke?.();
  return id;
});
// Only a timed session advertises public state. The worker cannot tell whether
// an On close owner is still open, so it never answers a site out of one. The
// address and scope are the record's own, never a caller's, and the snapshot
// is bound to both identities. Returns the selection generation the event that
// follows is about.
const publish = (id, ownerId, value) => use(id, ownerId, async (record) => {
  if (record.mode !== 'timed') return { published: false, selectionId: record.selectionId };
  await storage('set', { [publicStateKey]: { ...value, address: record.scope.address, scope: record.scope,
    selectionId: record.selectionId, leaseId: id } });
  return { published: true, selectionId: record.selectionId };
});
// The public view of the current selection, or null. `stored` is a snapshot
// read inside this module's transaction.
const publicValue = (stored, expectedSelectionId) => {
  const record = stored[sessionKey];
  const value = stored[publicStateKey];
  if (!live(record) || record.mode !== 'timed' || value?.leaseId !== record.id ||
      value.selectionId !== record.selectionId || !sameScope(value.scope, record.scope) ||
      (expectedSelectionId !== undefined && record.selectionId !== expectedSelectionId)) return null;
  return value;
};
const getPublicState = (expectedSelectionId) => transaction((stored) => publicValue(stored, expectedSelectionId));
const isLockedGeneration = (id) => transaction((stored) =>
  identity(stored[sessionKey]) === id && !stored[publicStateKey]);
const expire = () => transaction(async (stored) => {
  const record = stored[sessionKey];
  if (!record || record.locked) return null;
  if (lapsed(record)) return revoke(record);
  if (record.mode === 'local') {
    // An open On close owner keeps its private lifetime; it never has public
    // state, and a leftover snapshot from before the change is withdrawn.
    if (!stored[publicStateKey]) return null;
    await storage('set', { [publicStateKey]: null });
    return record.id;
  }
  return null;
});

const sessionLease = {
  sessionKey, publicStateKey, lockChoices, validMinutes, ended, unavailable, changed, live, read, transaction,
  begin, create, use, renew, select, setPolicy, load, clear, publish, publicValue, getPublicState,
  isLockedGeneration, expire,
};
export default sessionLease;
