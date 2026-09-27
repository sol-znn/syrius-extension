import { isLive, sameDocument } from '../../services/utils/documentBinding';

// Which frames currently have this wallet injected, and what origin each one
// is.
//
// Frames announce their presence with browser-provided sender identity. The
// separate webNavigation generation invalidates these records across navigation;
// no browsing URLs or history are persisted by that listener.

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

const serialized = operation => navigator.locks.request(storageKey, operation);
const register = (target, origin) => serialized(async () => {
  // Probe inside the registration ordering: a delayed hello cannot replace a
  // newer activation, and the map still has only one entry per tab/frame.
  if (!(await isLive(target))) return false;
  const frames = await readAll();
  frames[keyOf(target.tabId, target.frameId)] = { ...target, origin };
  await writeAll(frames);
  return true;
});

const forTabs = async (origins) => {
  const frames = await readAll();
  return Object.values(frames).filter((frame) => origins.has(frame.origin));
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

const forgetTarget = target => forget(frame => sameDocument(frame, target));

const forgetTab = (tabId) => forget((frame) => frame.tabId === tabId);

const frames = { storageKey, register, forTabs, forget, forgetTab, forgetTarget };

export default frames;
