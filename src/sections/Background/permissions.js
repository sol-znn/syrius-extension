// Which sites this wallet has been connected to.
//
// The old bridge had no concept of a connected site: every call from a page
// opened a popup asking the same question again, and answering it granted
// nothing that outlived the answer. That is why the content script had to be
// pinned to a single hard-coded domain — there was no other way to bound who
// could ask.
//
// A connection here is read access to the selected address, the chain
// identifier and the node URL, granted per origin and remembered. It is never
// permission to move anything: signing and sending are prompted every time,
// the way they are in every wallet a person is likely to have used.

const storageKey = 'syrius.permissions';

// A provisional grant is never new authority, including after worker restart.
// A prior completed grant remains valid if an attempted reconnection is canceled.
const activeEntry = entry => entry?.pendingApproval ? entry.previous || null : entry || null;
const own = (all, origin) => Object.hasOwn(all, origin) ? all[origin] : null;
const serialized = operation => navigator.locks.request(storageKey, operation);
const readAll = async () => (await chrome.storage.local.get(storageKey))[storageKey] || {};
const writeAll = all => chrome.storage.local.set({ [storageKey]: all });

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

const isConnected = origin => serialized(async () =>
  Boolean(origin && activeEntry(own(await readAll(), origin)))
);
const get = origin => serialized(async () => activeEntry(own(await readAll(), origin)));
const list = () => serialized(async () => Object.values(await readAll()).map(activeEntry)
  .filter(Boolean).sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0)));

const grant = (origin, { title = '', favicon = '' } = {}, { binding, confirm } = {}) => serialized(async () => {
  if (!origin || !binding || typeof confirm !== 'function') return false;
  const all = await readAll();
  const previous = activeEntry(own(all, origin));
  const completed = { origin, title, favicon, connectedAt: previous?.connectedAt || Date.now(), lastUsedAt: Date.now() };
  const provisional = { pendingApproval: { ...binding }, previous };
  await writeAll({ ...all, [origin]: provisional });
  let accepted;
  try {
    // The exact relay consumes its outstanding token synchronously with its
    // response acknowledgement. pagehide clears the same token synchronously:
    // cancellation before acceptance wins; a later navigation is after consent.
    accepted = await confirm();
  } catch (error) {
    await writeAll(all).catch(() => {}); // A stranded provisional stays inactive.
    throw error;
  }
  if (!accepted) {
    await writeAll(all).catch(() => {});
    return false;
  }
  // The original document has accepted the completed connection. Readers wait
  // on this lock, so its immediate follow-up sees the persisted outcome. A
  // failed final write leaves only an inactive provisional (or prior consent).
  await writeAll({ ...all, [origin]: completed });
  return true;
});

const revoke = origin => serialized(async () => {
  const all = await readAll();
  delete all[origin];
  await writeAll(all);
  return true;
});
const revokeAll = () => serialized(async () => { await writeAll({}); return true; });
const touch = origin => serialized(async () => {
  const all = await readAll();
  const entry = activeEntry(own(all, origin));
  if (entry) { entry.lastUsedAt = Date.now(); await writeAll(all); }
});

const permissions = { storageKey, originOf, isConnected, get, list, grant, revoke, revokeAll, touch };

export default permissions;
