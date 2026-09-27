// Chrome navigation events survive page-side removal of DOM listeners. Keep
// their generation in session storage so pending approvals survive worker sleep
// but cannot survive a browser navigation, even if a relay misses pagehide.
const storageKey = 'znn.navigation';
const serialized = operation => navigator.locks.request(storageKey, operation);
const read = async () => (await chrome.storage.session.get(storageKey))[storageKey] || {};
const stamp = (state, target) => ({ navigationTab: state[target.tabId]?.epoch || 'initial',
  navigationFrame: state[target.tabId]?.frames?.[target.frameId] || 'initial' });
const same = (a, b) => a.navigationTab === b.navigationTab && a.navigationFrame === b.navigationFrame;
let failed = false;
const activeDocument = async target => {
  const frame = await chrome.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId });
  return frame?.documentId === target.documentId && frame.documentLifecycle === 'active';
};
const capture = target => serialized(async () => {
  if (failed || !target || !(await activeDocument(target))) throw Error('The requesting document has left');
  return { ...target, ...stamp(await read(), target) };
});
const matches = target => serialized(async () => {
  if (failed || typeof target?.navigationTab !== 'string' || typeof target?.navigationFrame !== 'string') return false;
  return same(target, stamp(await read(), target)) && await activeDocument(target);
}).catch(() => false);
const invalidate = details => serialized(async () => {
  const state = await read();
  const previous = stamp(state, details);
  const entry = state[details.tabId] || { epoch: 'initial', frames: {} };
  if (details.frameId === 0) { entry.epoch = crypto.randomUUID(); entry.frames = {}; }
  else entry.frames[details.frameId] = crypto.randomUUID();
  state[details.tabId] = entry;
  try { await chrome.storage.session.set({ [storageKey]: state }); }
  catch (error) { failed = true; throw error; }
  return request => request.tabId === details.tabId && request.navigationTab === previous.navigationTab &&
    (details.frameId === 0 || (request.frameId === details.frameId && request.navigationFrame === previous.navigationFrame));
}).catch(error => { failed = true; throw error; });
const forgetTab = tabId => serialized(async () => {
  const state = await read(); delete state[tabId]; await chrome.storage.session.set({ [storageKey]: state });
});
const nativeNavigation = { capture, matches, invalidate, forgetTab };
export default nativeNavigation;
