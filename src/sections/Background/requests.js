import { validRequest, sameRequest, sameDocument, isLive, requestEnded } from '../../services/utils/documentBinding';

// The queue of things a site has asked for and a person has not answered yet.
//
// Two constraints shape this. A manifest v3 service worker is unloaded when
// idle, so nothing about a pending request can live in a module-level variable
// — an approval takes as long as somebody takes to find their password, which
// is far longer than the worker survives. And a site can ask twice before the
// first answer, which under the old code opened a second popup on top of the
// first and left whichever one lost the race waiting forever.
//
// So: the queue lives in `chrome.storage.session`, and there is at most one
// approval window, reused and refocused.

const pendingKey = 'znn.pendingRequests';
const windowKey = 'znn.approvalWindowId';

const readPending = async () => {
  const stored = await chrome.storage.session.get(pendingKey);
  return stored[pendingKey] || {};
};
const writePending = pending => chrome.storage.session.set({ [pendingKey]: pending });
const own = (pending, id) => Object.hasOwn(pending, id) ? pending[id] : null;
const serialized = operation => navigator.locks.request(pendingKey, async () => operation(await readPending()));
const list = async () => Object.values(await readPending()).sort((a, b) => a.createdAt - b.createdAt);
const get = async id => own(await readPending(), id);
const add = request => serialized(async pending => {
  if (!validRequest(request)) throw requestEnded();
  await writePending({ ...pending, [request.id]: request });
});
const remove = (id, expected) => serialized(async pending => {
  const request = own(pending, id);
  if (!sameRequest(request, expected)) return null;
  delete pending[id];
  await writePending(pending);
  return request;
});
const removeWhere = predicate => serialized(async pending => {
  const removed = Object.values(pending).filter(predicate);
  for (const request of removed) delete pending[request.id];
  if (removed.length) await writePending(pending);
  return removed;
});
const cancelDocument = target => removeWhere(request => sameDocument(request, target));
const cancelTab = tabId => removeWhere(request => request.tabId === tabId);
const pruneUnbound = () => serialized(async pending => {
  let changed = false;
  for (const id of Object.keys(pending)) {
    if (!validRequest(pending[id])) { delete pending[id]; changed = true; }
  }
  if (changed) await writePending(pending);
});
const current = async expected => {
  let request = await get(expected?.id);
  if (!sameRequest(request, expected)) return null;
  if (!(await isLive(request, true))) {
    await remove(request.id, request);
    return null;
  }
  // Navigation, a bye, or replacement can commit while the probe is pending.
  request = await get(expected.id);
  return sameRequest(request, expected) ? request : null;
};
const listCurrent = async () => {
  await pruneUnbound();
  const result = [];
  for (const request of await list()) {
    const active = await current(request);
    if (active) result.push(active);
  }
  return result;
};
const oldest = async () => {
  await pruneUnbound();
  for (const request of await list()) {
    const active = await current(request);
    if (active) return active;
  }
  return null;
};

// Records which approval window a request was actually put in front of.
//
// Closing a window means "no" only for the requests that window was showing.
// Without this stamp the close handler had to answer for the whole queue, and a
// request that arrived a millisecond after the window shut was rejected as
// though somebody had read it and declined it.
//
// That is not a rare race, it is the ordinary shape of connecting to a site:
// answering the connect empties the queue, the popup closes itself, and the
// site — which was waiting on exactly that answer — sends its next request in
// the same breath. It reliably came back to the page as "user rejected" for a
// prompt that was never drawn.
//
// A request that has not been stamped yet is deliberately left alone by that
// handler. It is the safe direction: an unstamped request waits for a window of
// its own, where the worst case is a prompt the person can decline themselves.
const attachWindow = (id, windowId, expected) => serialized(async pending => {
  if (!sameRequest(own(pending, id), expected)) return false;
  pending[id].windowId = windowId;
  await writePending(pending);
  return true;
});

//
// The approval window
//
const popupSize = { width: 376, height: 628 };

const getWindowId = async () => {
  try {
    const stored = await chrome.storage.session.get(windowKey);
    return stored[windowKey] ?? null;
  } catch (err) {
    return null;
  }
};

const setWindowId = async (id) => {
  try {
    if (id === null) {
      await chrome.storage.session.remove(windowKey);
    } else {
      await chrome.storage.session.set({ [windowKey]: id });
    }
  } catch (err) {
    // Same as above: worst case a second window opens.
  }
};

// Opens the approval window, or brings the existing one forward. Chrome throws
// when asked about a window that has been closed, which is the signal that the
// remembered id is stale.
const openApprovalWindow = async () => {
  const existingId = await getWindowId();

  if (existingId !== null) {
    try {
      await chrome.windows.update(existingId, { focused: true, drawAttention: true });
      return existingId;
    } catch (err) {
      await setWindowId(null);
    }
  }

  // Centred on the screen the browser is on, rather than the top-left corner
  // Chrome defaults to.
  let position = {};
  try {
    const current = await chrome.windows.getLastFocused();
    position = {
      top: Math.max(0, Math.round((current.top || 0) + 80)),
      left: Math.max(0, Math.round((current.left || 0) + (current.width || 1280) - popupSize.width - 32)),
    };
  } catch (err) {
    position = {};
  }

  // An absolute chrome-extension:// URL, not a bare 'popup.html'. A relative
  // URL is resolved against "the current page within the extension", and a
  // service worker is not a page — so Chrome cannot resolve it, silently falls
  // back, and opens a new tab page. The window appears, correctly sized and
  // positioned, containing none of this extension: the request sits in the
  // queue and the site waits out its own timeout with nothing to approve.
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html#/site-integration'),
    type: 'popup',
    focused: true,
    ...popupSize,
    ...position,
  });
  await setWindowId(created.id);
  return created.id;
};

// Forgets the remembered window, but only if it is still the one being forgotten.
//
// A plain `setWindowId(null)` raced with the window that replaces it: Chrome
// reports a close asynchronously, so by the time that handler runs, a request
// arriving in the meantime may already have opened a new window and stored its
// id. Clearing unconditionally threw that id away and left the next request
// opening a second window beside the one already on screen.
const forgetWindow = async (windowId) => {
  if ((await getWindowId()) !== windowId) {
    return false;
  }
  await setWindowId(null);
  return true;
};

const closeApprovalWindow = async () => {
  const existingId = await getWindowId();
  await setWindowId(null);

  if (existingId !== null) {
    try {
      await chrome.windows.remove(existingId);
    } catch (err) {
      // Already gone.
    }
  }
};

const requests = {
  pendingKey,
  windowKey,
  list,
  listCurrent,
  current,
  cancelDocument,
  removeWhere,
  cancelTab,
  oldest,
  get,
  add,
  remove,
  attachWindow,
  getWindowId,
  setWindowId,
  forgetWindow,
  openApprovalWindow,
  closeApprovalWindow,
};

export default requests;
