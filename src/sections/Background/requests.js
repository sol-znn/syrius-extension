import { validApproval, identityOf, matchesApproval, copy } from '../../services/utils/approvalIdentity';

// Pending authority and single-use claims persist across MV3 worker restarts.
// Every writer uses the same origin-wide lock, including close/attach cleanup.
const pendingKey = 'znn.pendingRequests';
const windowKey = 'znn.approvalWindowId';
const own = (pending, id) => Object.hasOwn(pending, id) ? pending[id] : null;
const readPending = async () => {
  const stored = (await chrome.storage.session.get(pendingKey))[pendingKey] || {};
  // Old page-keyed records cannot acquire the new approval authority. They
  // require a fresh request and are removed on the next successful mutation.
  return Object.fromEntries(Object.entries(stored).filter(([id, request]) => validApproval(request) && request.id === id));
};
const writePending = pending => chrome.storage.session.set({ [pendingKey]: pending });
const serialized = operation => navigator.locks.request(pendingKey, async () => operation(await readPending()));
const withWindow = operation => navigator.locks.request(windowKey, operation);
const list = async () => Object.values(await readPending()).sort((a, b) => a.createdAt - b.createdAt);
const oldest = async () => (await list()).find(request => !request.claimId && Number.isInteger(request.windowId)) || null;
const get = async id => own(await readPending(), id);
const correlationOf = request => JSON.stringify([request.origin, request.tabId, request.frameId, request.documentId, request.responseId]);
const add = request => {
  // Copy before the first await; page-owned correlation can never choose id.
  const entry = { ...copy(request), version: 1, id: crypto.randomUUID(), createdAt: Date.now() };
  if (!validApproval(entry)) return Promise.reject(Object.assign(new Error('Invalid approval request identity.'), { code: -32602 }));
  return serialized(async pending => {
    if (own(pending, entry.id) || Object.values(pending).some(other => correlationOf(other) === correlationOf(entry))) {
      throw Object.assign(new Error('A request with this response ID is already pending in this document.'), { code: -32602 });
    }
    pending[entry.id] = entry;
    await writePending(pending);
    return copy(entry);
  });
};
const isOwner = (request, identity) => matchesApproval(request, identity) &&
  typeof identity.claimId === 'string' && identity.claimId.length > 0 && request.claimId === identity.claimId;
const claim = (identity, windowId) => serialized(async pending => {
  const request = own(pending, identity?.id);
  if (!matchesApproval(request, identity) || request.claimId || !Number.isInteger(request.windowId) || !Number.isInteger(windowId)) return null;
  request.claimId = crypto.randomUUID();
  request.windowId = windowId;
  await writePending(pending);
  return { ...identityOf(request), claimId: request.claimId };
});
const checkClaim = identity => serialized(pending => isOwner(own(pending, identity?.id), identity));
const remove = (identity, requireClaim) => serialized(async pending => {
  const request = own(pending, identity?.id);
  if (!matchesApproval(request, identity)) return null;
  if (requireClaim || request.claimId) {
    if (!isOwner(request, identity)) return null;
  } else if (identity.claimId) return null;
  delete pending[request.id];
  await writePending(pending);
  return request;
});
const resolve = identity => remove(identity, true);
const reject = identity => remove(identity, false);
const attachWindow = (identity, windowId) => serialized(async pending => {
  const request = own(pending, identity?.id);
  if (!matchesApproval(request, identity) || request.claimId || !Number.isInteger(windowId)) return false;
  request.windowId = windowId;
  await writePending(pending);
  return true;
});

const popupSize = { width: 376, height: 628 };
const getWindowId = async () => (await chrome.storage.session.get(windowKey))[windowKey] ?? null;
const setWindowId = id => id === null ? chrome.storage.session.remove(windowKey) : chrome.storage.session.set({ [windowKey]: id });
const openWindow = async () => {
  const existingId = await getWindowId();
  if (existingId !== null) {
    try {
      await chrome.windows.update(existingId, { focused: true, drawAttention: true });
      return existingId;
    } catch (error) { await setWindowId(null); }
  }
  let position = {};
  try {
    const current = await chrome.windows.getLastFocused();
    position = { top: Math.max(0, Math.round((current.top || 0) + 80)),
      left: Math.max(0, Math.round((current.left || 0) + (current.width || 1280) - popupSize.width - 32)) };
  } catch (error) { /* Browser can select the position. */ }
  const created = await chrome.windows.create({ url: chrome.runtime.getURL('popup.html#/site-integration'),
    type: 'popup', focused: true, ...popupSize, ...position });
  try { await setWindowId(created.id); }
  catch (error) { await chrome.windows.remove(created.id).catch(() => {}); throw error; }
  return created.id;
};
// Lock order is window -> pending; neither lock spans user input, signing,
// network calls or response delivery. Close cannot overtake initial attachment.
const present = identity => withWindow(async () => {
  const request = await get(identity?.id);
  if (!matchesApproval(request, identity) || request.claimId) return false;
  const windowId = await openWindow();
  return attachWindow(identity, windowId);
});
const closeWindow = windowId => withWindow(async () => {
  if (await getWindowId() === windowId) await setWindowId(null);
  return serialized(async pending => {
    const removed = Object.values(pending).filter(request => request.windowId === windowId);
    for (const request of removed) delete pending[request.id];
    if (removed.length) await writePending(pending);
    return removed;
  });
});
const requests = { pendingKey, windowKey, list, oldest, get, add, claim, checkClaim, resolve, reject, attachWindow, present, closeWindow };
export default requests;
