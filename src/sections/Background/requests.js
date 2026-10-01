import selection from '../../services/wallet/selection';
import { isLive, sameDocument } from '../../services/utils/documentBinding';
import { validApproval, identityOf, matchesApproval, copy } from '../../services/utils/approvalIdentity';
import { limits, boundedJson, validResponseId, invalid, busy } from '../../services/utils/approvalLimits';

const pendingKey = 'znn.pendingRequests', windowKey = 'znn.approvalWindowId', attentionKey = 'znn.approvalAttention';
const own = (pending, id) => Object.hasOwn(pending, id) ? pending[id] : null;
const readPending = async () => (await chrome.storage.session.get(pendingKey))[pendingKey] || {};
const writePending = pending => chrome.storage.session.set({ [pendingKey]: pending });
let expiredHandler = async () => {};
const onExpired = handler => { expiredHandler = handler; };
// Lock order is window -> pending. No lock spans user input, RPC, signing or
// delivery. Expiry is enforced on every read/mutation, including key checks.
const serialized = async operation => {
  let expired = [];
  try {
    return await navigator.locks.request(pendingKey, async () => {
      const stored = await readPending(), pending = {}, removed = [];
      let changed = false;
      for (const [id, request] of Object.entries(stored)) {
        if (!validApproval(request) || request.id !== id || request.expiresAt <= Date.now()) {
          changed = true;
          if (validApproval(request)) removed.push(request);
        } else pending[id] = request;
      }
      if (changed) { await writePending(pending); expired = removed; }
      return operation(pending);
    });
  } finally { if (expired.length) await expiredHandler(expired); }
};
const withWindow = operation => navigator.locks.request(windowKey, operation);
const list = () => serialized(pending => Object.values(pending).sort((a, b) => a.createdAt - b.createdAt));
const oldest = async () => (await list()).find(request => !request.claimId && Number.isInteger(request.windowId)) || null;
const get = id => serialized(pending => own(pending, id));
const prune = () => serialized(() => true);
const correlationOf = request => JSON.stringify([request.origin, request.tabId, request.frameId, request.documentId, request.responseId]);
const add = request => {
  // Budget before copying, stringifying or retaining a closure behind a lock.
  if (!validResponseId(request.responseId) || typeof request.origin !== 'string' || request.origin.length > 2048 ||
      typeof request.documentId !== 'string' || request.documentId.length > 128 ||
      typeof request.title !== 'string' || request.title.length > 1024 ||
      typeof request.favicon !== 'string' || request.favicon.length > 4096) throw invalid();
  const createdAt = Date.now();
  const entry = { ...request, version: 4, id: crypto.randomUUID(), createdAt, expiresAt: createdAt + limits.ttl };
  boundedJson(entry);
  if (!validApproval(entry)) throw invalid();
  const saved = copy(entry);
  return serialized(async pending => {
    const rows = Object.values(pending), sameOrigin = rows.filter(other => other.origin === saved.origin);
    if (rows.length >= limits.pending || sameOrigin.length >= limits.perOrigin ||
        (saved.type === 'connect' && sameOrigin.some(other => other.type === 'connect'))) throw busy();
    if (own(pending, saved.id) || rows.some(other => correlationOf(other) === correlationOf(saved))) {
      throw Object.assign(new Error('This response ID is already pending in this document.'), { code: -32602 });
    }
    if (saved.expiresAt <= Date.now()) throw busy();
    pending[saved.id] = saved;
    await writePending(pending);
    return copy(saved);
  });
};
const isOwner = (request, identity) => matchesApproval(request, identity) &&
  typeof identity.claimId === 'string' && identity.claimId.length > 0 && request.claimId === identity.claimId;
const claim = (identity, windowId) => serialized(async pending => {
  const request = own(pending, identity?.id);
  if (!matchesApproval(request, identity) || request.claimId || !Number.isInteger(request.windowId) || !Number.isInteger(windowId)) return null;
  request.claimId = crypto.randomUUID(); request.windowId = windowId;
  await writePending(pending);
  return { ...identityOf(request), claimId: request.claimId };
});
const checkClaim = identity => serialized(pending => isOwner(own(pending, identity?.id), identity));
const remove = (identity, requireClaim) => serialized(async pending => {
  const request = own(pending, identity?.id);
  if (!matchesApproval(request, identity)) return null;
  if (requireClaim || request.claimId) { if (!isOwner(request, identity)) return null; }
  else if (identity.claimId) return null;
  delete pending[request.id]; await writePending(pending); return request;
});
const resolve = identity => remove(identity, true);
const reject = identity => remove(identity, false);
const attachWindow = (identity, windowId) => serialized(async pending => {
  const request = own(pending, identity?.id);
  if (!matchesApproval(request, identity) || request.claimId || !Number.isInteger(windowId)) return false;
  request.windowId = windowId; await writePending(pending); return true;
});
const forgetTab = tabId => serialized(async pending => {
  const removed = Object.values(pending).filter(request => request.tabId === tabId);
  for (const request of removed) delete pending[request.id];
  if (removed.length) await writePending(pending);
  return removed.length;
});

// Binding happens once before the request is shown. Only an unshown request
// that explicitly waited for unlock may follow the immediate predecessor.
// `record` is the session record; its `selectionId` is the generation that
// admission and binding refer to.
const nextFor = record => serialized(async pending => {
  const removed = [];
  let next = null;
  for (const request of Object.values(pending).sort((a, b) => a.createdAt - b.createdAt)) {
    if (request.claimId || !Number.isInteger(request.windowId)) continue;
    const admitted = request.admitted;
    const allowed = request.binding ? selection.matches(record, request.binding) :
      (!admitted && request.type === 'connect') ||
      (selection.sameScope(record.scope, admitted?.scope) && (record.selectionId === admitted.id ||
        (request.waitForUnlock && record.resumeFrom === admitted.id)));
    if (!allowed) { removed.push(request); delete pending[request.id]; continue; }
    if (!next) {
      request.binding = request.binding || { id: record.selectionId, scope: { ...record.scope } };
      next = copy(request);
    }
  }
  if (removed.length || next) await writePending(pending);
  return { next, removed };
});
// The request as stored, if it is still the one expected and its document is
// still live: the exact relay still holds its private request token, and the
// tab or frame has not navigated. A request whose document has gone is removed.
const current = async expected => {
  const request = await get(expected?.id);
  if (!matchesApproval(request, identityOf(expected))) return null;
  if (!(await isLive(request, true))) {
    await cancelWhere(item => item.id === request.id && sameDocument(item, request));
    return null;
  }
  // Navigation, a bye or a replacement can commit while the probe is pending.
  const after = await get(expected.id);
  return matchesApproval(after, identityOf(expected)) ? after : null;
};
const cancelDocument = target => cancelWhere(request => sameDocument(request, target));
const cancelWhere = predicate => serialized(async pending => {
  const removed = Object.values(pending).filter(predicate);
  for (const request of removed) delete pending[request.id];
  if (removed.length) await writePending(pending);
  return removed;
});

const popupSize = { width: 376, height: 628 };
const getWindowId = async () => (await chrome.storage.session.get(windowKey))[windowKey] ?? null;
const setWindowId = id => id === null ? chrome.storage.session.remove(windowKey) : chrome.storage.session.set({ [windowKey]: id });
const readAttention = async () => {
  const saved = (await chrome.storage.session.get(attentionKey))[attentionKey] || {};
  const now = Date.now();
  const origins = Object.fromEntries(Object.entries(saved.origins || {}).filter(([, at]) => Number.isFinite(at) && now - at < limits.originAttention).slice(-limits.history));
  const allowances = Object.fromEntries(Object.entries(saved.allowances || {}).filter(([, until]) => Number.isFinite(until) && until > now).slice(-limits.history));
  return { globalAt: Number.isFinite(saved.globalAt) ? saved.globalAt : 0, origins, allowances };
};
const writeAttention = state => chrome.storage.session.set({ [attentionKey]: state });
// A successful human approval gives this origin one short follow-up opening,
// including connect -> sign after the empty-window grace. Rejection gives none.
const allowFollowup = (origin, expiresAt) => withWindow(async () => {
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return false;
  const state = await readAttention();
  if (Date.now() >= expiresAt) return false;
  delete state.allowances[origin];
  state.allowances[origin] = Math.min(expiresAt, Date.now() + limits.originAttention);
  state.allowances = Object.fromEntries(Object.entries(state.allowances).slice(-limits.history));
  await writeAttention(state);
});
const openWindow = async origin => {
  const existingId = await getWindowId();
  if (existingId !== null) {
    try { await chrome.windows.get(existingId); return existingId; }
    catch (error) { await setWindowId(null); }
  }
  const state = await readAttention(), now = Date.now();
  const followup = own(state.allowances, origin) > now;
  if (!followup && ((state.globalAt && now - state.globalAt < limits.globalAttention) ||
      (own(state.origins, origin) && now - state.origins[origin] < limits.originAttention))) throw busy();
  delete state.allowances[origin]; delete state.origins[origin];
  state.origins[origin] = now; state.globalAt = now;
  state.origins = Object.fromEntries(Object.entries(state.origins).slice(-limits.history));
  // Persist the attention decision before opening. A failed browser operation
  // may require a cooldown retry, but cannot allow repeated opening attempts.
  await writeAttention(state);
  let position = {};
  try {
    const current = await chrome.windows.getLastFocused();
    position = { top: Math.max(0, Math.round((current.top || 0) + 80)),
      left: Math.max(0, Math.round((current.left || 0) + (current.width || 1280) - popupSize.width - 32)) };
  } catch (error) { /* Browser can choose the position. */ }
  const created = await chrome.windows.create({ url: chrome.runtime.getURL('popup.html#/site-integration'),
    type: 'popup', focused: true, ...popupSize, ...position });
  try { await setWindowId(created.id); }
  catch (error) { await chrome.windows.remove(created.id).catch(() => {}); throw error; }
  return created.id;
};
const present = identity => withWindow(async () => {
  const request = await get(identity?.id);
  if (!matchesApproval(request, identity) || request.claimId) return false;
  const windowId = await openWindow(request.origin);
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
const requests = { pendingKey, windowKey, attentionKey, list, oldest, get, add, claim, checkClaim, resolve, reject,
  attachWindow, present, closeWindow, forgetTab, prune, onExpired, allowFollowup, nextFor, cancelWhere, current, cancelDocument };
export default requests;
