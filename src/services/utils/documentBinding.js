import nativeNavigation from './nativeNavigation';

// Browser-authenticated document identity plus an isolated-relay activation.
// Keep this shared transport module independent of the wallet and SDK.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
// Chrome document IDs are opaque (Chromium currently uses 32 hex characters).
// Preserve the native value exactly; relay tokens use our own UUID format.
const validTarget = target => Boolean(target && Number.isInteger(target.tabId) && target.tabId >= 0 &&
  Number.isInteger(target.frameId) && target.frameId >= 0 && typeof target.documentId === 'string' && target.documentId.length > 0 && uuid(target.activation));
const targetFrom = (sender, relay) => {
  const target = { tabId: sender?.tab?.id, frameId: sender?.frameId ?? 0,
    documentId: sender?.documentId, activation: relay?.activation, requestToken: relay?.requestToken };
  return validTarget(target) ? target : null;
};
const validRequest = request => validTarget(request) && uuid(request.requestToken) &&
  typeof request.navigationTab === 'string' && typeof request.navigationFrame === 'string';
const sameDocument = (a, b) => validTarget(a) && validTarget(b) &&
  ['tabId', 'frameId', 'documentId', 'activation'].every(field => a[field] === b[field]);
const sameRequest = (a, b) => sameDocument(a, b) && validRequest(a) && validRequest(b) &&
  a.id === b.id && a.requestToken === b.requestToken &&
  a.navigationTab === b.navigationTab && a.navigationFrame === b.navigationFrame;
const bindingOf = request => request && Object.fromEntries(
  ['id', 'tabId', 'frameId', 'documentId', 'activation', 'requestToken', 'navigationTab', 'navigationFrame'].map(field => [field, request[field]])
);
const requestEnded = () => Object.assign(new Error('This page request is no longer active. Ask the site to request it again.'), { code: 4900 });

// Never retry against just a frame: a new document can reuse that frame.
// Resolves to the relay's receipt (`{accepted, acceptedAt}`), or null when it
// could not be delivered to exactly this document and relay.
const deliver = async (target, message) => {
  if (!validTarget(target) || !(await nativeNavigation.matches(target))) return null;
  let timer;
  try {
    const reply = await Promise.race([
      chrome.tabs.sendMessage(target.tabId, {
        ...message, activation: target.activation, requestToken: target.requestToken,
      }, { frameId: target.frameId, documentId: target.documentId }),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); }),
    ]);
    return reply && typeof reply === 'object' ? reply : null;
  } catch (error) { return null; }
  finally { clearTimeout(timer); }
};
const isLive = async (target, requireRequest = false) => {
  if (requireRequest && !validRequest(target)) return false;
  return (await deliver(target, { channel: 'znn', kind: 'probe', requireRequest }))?.accepted === true &&
    await nativeNavigation.matches(target);
};

export { validTarget, validRequest, targetFrom, sameDocument, sameRequest, bindingOf, requestEnded, deliver, isLive };
