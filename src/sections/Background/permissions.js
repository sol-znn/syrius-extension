// Readers and writers share a lock: an immediate follow-up waits for the
// accepted connection's durable promotion, and stale writes cannot undo revoke.
const storageKey = 'syrius.permissions';
const serialized = operation => navigator.locks.request(storageKey, operation);
const own = (all, key) => Object.hasOwn(all, key) ? all[key] : null;
const readAll = async () => (await chrome.storage.local.get(storageKey))[storageKey] || {};
const writeAll = all => chrome.storage.local.set({ [storageKey]: all });
// Tentative state is durably inactive by itself, including after session loss.
// Preserve prior consent; old tentative formats require a fresh connection.
const activeEntry = entry => entry?.pendingApproval ? entry.previous || null
  : entry?.approvalAttempt ? null : entry || null;
const checkDeadline = expiresAt => {
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) throw new Error('Approval expired during finalization.');
};

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

const isConnected = async origin => {
  try { return await serialized(async () => Boolean(origin && activeEntry(own(await readAll(), origin)))); }
  catch (error) { return false; }
};
const get = origin => serialized(async () => activeEntry(own(await readAll(), origin)));
const list = () => serialized(async () => Object.values(await readAll()).map(activeEntry).filter(Boolean)
  .sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0)));

const grant = (origin, { title = '', favicon = '' } = {}, { expiresAt, confirm } = {}) => serialized(async () => {
  if (!origin || typeof confirm !== 'function') return false;
  checkDeadline(expiresAt);
  const all = await readAll(); checkDeadline(expiresAt);
  const previous = activeEntry(own(all, origin));
  const restored = { ...all }; if (previous) restored[origin] = previous; else delete restored[origin];
  const completed = { origin, title, favicon,
    connectedAt: previous?.connectedAt || Date.now(), lastUsedAt: Date.now() };
  // A failed write cannot leave unmarked new authority. No session-only denial
  // is needed to interpret this row after a browser restart.
  await writeAll({ ...all, [origin]: { pendingApproval: { id: crypto.randomUUID(), expiresAt }, previous } });
  try {
    checkDeadline(expiresAt);
    const receipt = await confirm();
    if (receipt?.accepted !== true || !Number.isFinite(receipt.acceptedAt) || receipt.acceptedAt >= expiresAt) {
      throw new Error('The connection was not accepted before its approval expired.');
    }
    // The exact isolated relay accepted the response before expiry. This is
    // the consent commitment point, even if its native acknowledgement arrives
    // later. Durable promotion completes that already-accepted decision. If it
    // fails, the provisional row remains inactive and reconnect is required.
    await writeAll({ ...all, [origin]: { ...completed, approvalAcceptedAt: receipt.acceptedAt } });
    return true;
  } catch (error) {
    await writeAll(restored).catch(() => {}); // Stranded provisional stays inactive.
    throw error;
  }
});
const revoke = origin => serialized(async () => {
  const all = await readAll(); delete all[origin]; await writeAll(all); return true;
});
const revokeAll = () => serialized(async () => { await writeAll({}); return true; });
const touch = origin => serialized(async () => {
  const all = await readAll(), entry = activeEntry(own(all, origin));
  if (!entry) return false;
  all[origin] = { ...entry, lastUsedAt: Date.now() }; await writeAll(all); return true;
});
const permissions = { storageKey, originOf, isConnected, get, list, grant, revoke, revokeAll, touch };
export default permissions;
