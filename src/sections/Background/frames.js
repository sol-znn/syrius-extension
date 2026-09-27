// Which frames currently have this wallet injected, and what origin each one
// is.
//
// Events like "the selected address changed" have to reach every connected
// page. The obvious way to find them is `chrome.tabs.query({})` and filter by
// `tab.url` — but reading a tab's URL requires either the `tabs` permission or
// host permissions, and `tabs` is the one Chrome describes to the user, on the
// install prompt, as "Read your browsing history". A wallet does not need that.
//
// So the frames announce themselves instead. Each content script says hello as
// it loads, and Chrome tells us its tab, its frame and its origin as part of
// delivering that message — all facts about the sender, none of them something
// a page can claim for itself.

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

const register = async (sender, origin) => {
  if (typeof sender.documentId !== 'string' || !sender.documentId) return false;
  const frames = await readAll();
  frames[keyOf(sender.tab.id, sender.frameId ?? 0)] = {
    tabId: sender.tab.id,
    frameId: sender.frameId ?? 0,
    origin,
    documentId: sender.documentId,
  };
  await writeAll(frames);
};

const forTabs = async (origins) => {
  const frames = await readAll();
  return Object.values(frames).filter((frame) => origins.has(frame.origin) &&
    typeof frame.documentId === 'string' && frame.documentId.length > 0);
};

const forget = async (predicate) => {
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
};

const forgetTab = (tabId) => forget((frame) => frame.tabId === tabId);

const frames = { storageKey, register, forTabs, forget, forgetTab };

export default frames;
