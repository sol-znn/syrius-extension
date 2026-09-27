// Which sites this wallet has been connected to.
//
// The old bridge had no concept of a connected site: every call from a page
// opened a popup asking the same question again, and answering it granted
// nothing that outlived the answer. That is why the content script had to be
// pinned to a single hard-coded domain — there was no other way to bound who
// could ask.
//
// A connection here is read access to the selected address, the chain
// identifier and the public node host, granted per origin and remembered. It is never
// permission to move anything: signing and sending are prompted every time,
// the way they are in every wallet a person is likely to have used.

const storageKey = 'syrius.permissions';

// Reads and every read/modify/write share one extension-wide lock. A delayed
// touch or unrelated grant must never restore a completed revocation.
const serialized = operation => navigator.locks.request(storageKey, operation);
const own = (all, origin) => Object.hasOwn(all, origin) ? all[origin] : null;
const readAll = async () => (await chrome.storage.local.get(storageKey))[storageKey] || {};
const writeAll = async all => {
  await chrome.storage.local.set({ [storageKey]: all });
  return true;
};

// A page can claim to be any origin it likes in a postMessage, so the origin
// used for a permission decision is always the one Chrome reports for the
// sender, never one the page supplied.
const originOf = (sender) => {
  if (sender && sender.origin) {
    return sender.origin;
  }
  try {
    return sender && sender.url ? new URL(sender.url).origin : null;
  } catch (err) {
    return null;
  }
};

// A session denial survives MV3 restart if durable revocation temporarily
// fails. Management still lists the saved row so the user can retry.
const revocationsKey = 'syrius.permissionRevocations';
let emergencyDenial = false;
const readRevocations = async () => {
  const value = (await chrome.storage.session.get(revocationsKey))[revocationsKey];
  if (!value) return { all: false, origins: {} };
  if (typeof value.all !== 'boolean' || !value.origins || typeof value.origins !== 'object' || Array.isArray(value.origins)) {
    throw new Error('Connected-site revocations are unavailable. Retry disconnecting.');
  }
  return value;
};
const writeRevocations = async origins => {
  try {
    await chrome.storage.session.set({ [revocationsKey]: origins });
    emergencyDenial = false;
  } catch (error) {
    // If neither storage area can save a withdrawal, the operation fails and
    // this worker denies access. Durable completion is never reported then.
    emergencyDenial = true;
    throw error;
  }
};
const denied = (state, origin) => emergencyDenial || state.all || Boolean(own(state.origins, origin));
const pendingOrigins = (state, all) => Object.fromEntries(Object.keys(all)
  .filter(origin => denied(state, origin)).map(origin => [origin, true]));
const saveOrigins = origins => writeRevocations({ all: false, origins });

// Public reads fail closed; management and mutation callers receive errors.
const isConnected = async origin => {
  try { return await serialized(async () => Boolean(origin && own(await readAll(), origin) && !denied(await readRevocations(), origin))); }
  catch (error) { return false; }
};
const get = origin => serialized(async () => {
  const all = await readAll();
  return denied(await readRevocations(), origin) ? null : own(all, origin);
});
const list = () => serialized(async () => {
  const all = await readAll(), revoked = await readRevocations();
  return Object.values(all).map(entry => ({ ...entry, revocationPending: denied(revoked, entry.origin) }))
    .sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));
});

const grant = (origin, { title = '', favicon = '' } = {}) => serialized(async () => {
  if (!origin) return false;
  const all = await readAll(), pending = pendingOrigins(await readRevocations(), all);
  // A failed grant commit cannot become new authority. Publish it only after
  // both the durable record and the corresponding session decision succeed.
  await saveOrigins({ ...pending, [origin]: true });
  all[origin] = { origin, title, favicon,
    connectedAt: own(all, origin)?.connectedAt || Date.now(), lastUsedAt: Date.now() };
  await writeAll(all);
  delete pending[origin];
  await saveOrigins(pending);
  return true;
});
const revoke = origin => serialized(async () => {
  const all = await readAll(), pending = pendingOrigins(await readRevocations(), all);
  if (own(all, origin)) {
    // Still attempt durable removal if session storage fails; a successful
    // local removal is sufficient to revoke across a browser restart.
    await saveOrigins({ ...pending, [origin]: true }).catch(() => {});
    delete all[origin];
    await writeAll(all);
  }
  delete pending[origin];
  await saveOrigins(pending).catch(() => {}); // Redundant-denial cleanup only.
  return true;
});
const revokeAll = () => serialized(async () => {
  await writeRevocations({ all: true, origins: {} }).catch(() => {});
  await writeAll({});
  await saveOrigins({}).catch(() => {});
  return true;
});
// The returned decision and timestamp update share the revocation lock.
const touch = origin => serialized(async () => {
  const all = await readAll();
  if (!own(all, origin) || denied(await readRevocations(), origin)) return false;
  all[origin].lastUsedAt = Date.now();
  return writeAll(all);
});

const permissions = { storageKey, originOf, isConnected, get, list, grant, revoke, revokeAll, touch };

export default permissions;
