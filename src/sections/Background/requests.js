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

// All whole-map writers share an origin-wide lock. A per-worker promise queue
// would not survive a worker restart or coordinate another extension context.
const withPending = (operation) => navigator.locks.request('znn.pendingRequests', operation);

const readPending = async () => {
  const stored = await chrome.storage.session.get(pendingKey);
  return stored[pendingKey] || {};
};

// A claim must never succeed unless its single-use state was persisted.
const writePending = (pending) => chrome.storage.session.set({ [pendingKey]: pending });

const list = async () => {
  const pending = await readPending();
  return Object.values(pending).sort((a, b) => a.createdAt - b.createdAt);
};

const oldest = async () => (await list()).find((request) => !request.claimId) || null;

const get = async (id) => (await readPending())[id] || null;

const add = (request) => withPending(async () => {
  const pending = await readPending();
  pending[request.id] = { ...request, approvalId: crypto.randomUUID() };
  await writePending(pending);
});

const remove = (id, { approvalId, claimId } = {}) => withPending(async () => {
  const pending = await readPending();
  const request = pending[id];
  if (!request || (approvalId && request.approvalId !== approvalId) ||
      (request.claimId && request.claimId !== claimId)) return null;
  delete pending[id];
  await writePending(pending);
  return request;
});

// Two popups may display the same request. Only one can consume its block
// approval, and only that claimant can subsequently settle or reject it.
// The queue-generated identity distinguishes replacement records with the
// same page-supplied id; it is captured with the preview, never read at click.
const claimBlock = (id, { approvalId, claimId, windowId }) => withPending(async () => {
  const pending = await readPending();
  const request = pending[id];
  if (!approvalId || !claimId || !Number.isInteger(windowId) ||
      !request || request.type !== 'signAndSendBlock' || request.claimId ||
      request.approvalId !== approvalId) return false;
  request.claimId = claimId;
  request.windowId = windowId;
  await writePending(pending);
  return true;
});

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
const attachWindow = (id, windowId) => withPending(async () => {
  const pending = await readPending();

  if (!pending[id] || pending[id].claimId) {
    return false;
  }
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
  oldest,
  get,
  add,
  remove,
  claimBlock,
  attachWindow,
  getWindowId,
  setWindowId,
  forgetWindow,
  openApprovalWindow,
  closeApprovalWindow,
};

export default requests;
