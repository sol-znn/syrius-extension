import { isLive, sameDocument, validTarget } from '../../services/utils/documentBinding';

// Which frames currently have this wallet injected, and what origin each one
// is.
//
// Events like "the selected address changed" have to reach every connected
// page. The obvious way to find them is `chrome.tabs.query({})` and filter by
// `tab.url` — but reading a tab's URL requires either the `tabs` permission or
// host permissions, and a wallet should not be reading the URL of every tab.
//
// So the frames announce themselves instead. Each content script says hello as
// it loads, and Chrome tells us its tab, its frame and its origin as part of
// delivering that message — all facts about the sender, none of them something
// a page can claim for itself.
//
// This no longer keeps "Read your browsing history" off the install prompt:
// the navigation fence (nativeNavigation.js) needs `webNavigation`, which
// Chrome describes with the same words as `tabs`.

const storageKey = 'znn.frames';

const keyOf = (tabId, frameId) => `${tabId}:${frameId}`;

const readAll = async () => {
  try {
    const stored = await chrome.storage.session.get(storageKey);
    return stored[storageKey] || {};
  } catch (err) {
    return {};
  }
};

const writeAll = async (frames) => {
  try {
    await chrome.storage.session.set({ [storageKey]: frames });
  } catch (err) {
    // A missed registration costs an event, not correctness.
  }
};

const serialized = (operation) => navigator.locks.request(storageKey, operation);

// `target` is the frame's bound document (documentBinding.targetFrom, then the
// navigation generation it was captured in). The relay is probed inside the
// registration ordering: a delayed hello cannot replace a newer activation, and
// the map still holds one entry per tab and frame.
const register = (target, origin) => serialized(async () => {
  if (!validTarget(target) || !(await isLive(target))) return false;
  const frames = await readAll();
  frames[keyOf(target.tabId, target.frameId)] = { ...target, origin };
  await writeAll(frames);
  return true;
});

// Only frames bound to a live document relay; a legacy frame-only record has
// no fallback, since a new document can reuse the same frame.
const forTabs = async (origins) => {
  const frames = await readAll();
  return Object.values(frames).filter((frame) => origins.has(frame.origin) && validTarget(frame));
};

const forget = (predicate) => serialized(async () => {
  const frames = await readAll();
  let changed = false;

  Object.keys(frames).forEach((key) => {
    if (predicate(frames[key])) {
      delete frames[key];
      changed = true;
    }
  });
  if (changed) {
    await writeAll(frames);
  }
});

const forgetTarget = (target) => forget((frame) => sameDocument(frame, target));

const forgetTab = (tabId) => forget((frame) => frame.tabId === tabId);

const frames = { storageKey, register, forTabs, forget, forgetTab, forgetTarget };

export default frames;
