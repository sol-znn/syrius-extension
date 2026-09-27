import frames from './frames';
import selection from '../../services/wallet/selection';
import permissions from './permissions';
import requests from './requests';
import { identityOf } from '../../services/utils/approvalIdentity';

// The service worker.
//
// It routes between three parties that never touch each other directly: the
// page (through its content script), the popup, and persistent storage. It
// deliberately holds no key material and does not link the SDK — everything it
// needs to answer a site is published by the popup into `chrome.storage.session`
// as plain, non-secret state.
//
// Nothing here keeps state in a module-level variable. Under manifest v3 this
// file runs as a worker that Chrome unloads whenever it feels like it, and an
// approval that takes a person thirty seconds outlives that easily. The
// previous version cached the wallet password in a `const` up here, which both
// evaporated at random and answered `internal.getCredentialsFromBackgroundScript`
// for any sender at all.

// Kept in step with `services/wallet/signMessage.js`, and duplicated rather
// than imported: this file is a service worker that deliberately does not link
// the SDK, and that module reaches the vault through it.
const maxSignMessageLength = 8192;

//
// Errors a page sees. The numbering follows EIP-1193 so that anything written
// against a browser wallet before behaves the way its author expected.
//
const errors = {
  userRejected: { code: 4001, message: 'User rejected the request' },
  approvalInterrupted: { code: -32603, message: 'Approval was interrupted after it began. The outcome is unknown; check the original account before retrying.' },
  unauthorized: { code: 4100, message: 'The site is not connected to this wallet' },
  unsupportedMethod: { code: 4200, message: 'Unsupported method' },
  disconnected: { code: 4900, message: 'The wallet is locked' },
  internal: { code: -32603, message: 'Internal error' },
};

// A malformed call, said in the caller's own terms. `-32602` is JSON-RPC's
// invalid-params, which is what EIP-1193 leaves this case to.
const invalidParams = (message) => ({ code: -32602, message });

//
// Sender checks. Every handler below starts from one of these two, because the
// difference between "the popup asked" and "a web page asked" is the whole
// security boundary.
//
// The test is the sender's own URL, not the absence of a tab. `sender.id` alone
// is not enough — this extension's content scripts run under the same id on
// every page the user visits — but only a document served from the extension's
// own origin can be one of its pages. Testing `!sender.tab` instead would be
// both weaker and wrong: an extension page opened in a tab rather than as a
// toolbar popup has a `sender.tab`, and would be refused.
const extensionOrigin = chrome.runtime.getURL('');

const isFromExtension = (sender) =>
  Boolean(sender) &&
  sender.id === chrome.runtime.id &&
  typeof sender.url === 'string' &&
  sender.url.startsWith(extensionOrigin);

const isFromContentScript = (sender) =>
  Boolean(sender) &&
  sender.id === chrome.runtime.id &&
  Boolean(sender.tab) &&
  typeof sender.url === 'string' &&
  !sender.url.startsWith(extensionOrigin);

//
// Talking back to pages
//
const sendToTab = async (tabId, message, frameId, documentId) => {
  try {
    if (!documentId) return;
    let timer;
    try {
      await Promise.race([chrome.tabs.sendMessage(tabId, message, { frameId, documentId }),
        new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    } finally { clearTimeout(timer); }
  } catch (err) {
    // The tab navigated away or closed. Nothing to deliver to and nothing to
    // do about it.
  }
};

const respond = (target, id, result, error) => {
  if (typeof target.documentId !== 'string' || !target.documentId) return false;
  return sendToTab(target.tabId, { channel: 'znn', kind: 'response', id, result, error }, target.frameId, target.documentId);
};

// Caller holds selection. Payload and recipients share one generation.
const announceToSites = async (stored, event, expectedId, clearOrigins = []) => {
  const record = selection.current(stored);
  if (expectedId !== undefined && record?.id !== expectedId) return false;
  const value = selection.publicValue(stored);
  const sites = await permissions.list();
  const origins = new Set([...sites.map(site => site.origin), ...clearOrigins]);
  const targets = await frames.forTabs(origins);
  await Promise.all(targets.map(async frame => {
    const allowed = value && await permissions.isConnected(frame.origin, value.scope) && selection.publicValue(stored);
    const data = event === 'accountsChanged' ? (allowed ? [value.address] : []) :
      allowed ? (event === 'chainChanged' ? value.chainId : value.nodeUrl) : undefined;
    if (data !== undefined) await sendToTab(frame.tabId, { channel: 'znn', kind: 'event', event, data }, frame.frameId, frame.documentId);
  }));
  return true;
};
const rejectRemoved = removed => Promise.all(removed.map(request => respond(request, request.responseId, undefined,
  request.claimId ? errors.approvalInterrupted : errors.userRejected)));
const revokeOrigin = async (stored, origin, scope) => {
  await permissions.revoke(origin, scope);
  await rejectRemoved(await requests.cancelWhere(request => request.origin === origin &&
    (!scope || !request.admitted || selection.sameScope(request.admitted.scope, scope))));
  await announceToSites(stored, 'accountsChanged', undefined, [origin]);
  return true;
};

//
// Queuing something for a person to approve
//
const queueApproval = async (type, { id, target, origin, sender, params, stored }) => {
  const record = selection.current(stored);
  if (type !== 'connect') {
    if (!selection.validScope(record?.scope)) throw errors.disconnected;
    if (!(await permissions.isConnected(origin, record.scope))) throw errors.unauthorized;
  }
  const queued = await requests.add({
    responseId: id,
    admitted: selection.validScope(record?.scope) && (type !== 'connect' || selection.live(record)) ? { id: record.id, scope: record.scope } : null,
    waitForUnlock: !selection.live(record) || record.mode === 'local',
    binding: null,
    type,
    params: params || {},
    origin,
    tabId: target.tabId,
    frameId: target.frameId,
    documentId: target.documentId,
    title: sender.tab?.title || '',
    favicon: sender.tab?.favIconUrl || '',
    createdAt: Date.now(),
  });
  return { settled: false, present: identityOf(queued) };
};

//
// Page-facing methods
//
const readFor = async (stored, origin) => {
  const value = selection.publicValue(stored);
  return value && await permissions.isConnected(origin, value.scope) ? selection.publicValue(stored) : null;
};
const providerMethods = {
  znn_accounts: async ({ origin, stored }) => { const value = await readFor(stored, origin); return value ? [value.address] : []; },
  znn_chainId: async ({ origin, stored }) => (await readFor(stored, origin))?.chainId ?? null,
  znn_nodeUrl: async ({ origin, stored }) => (await readFor(stored, origin))?.nodeUrl ?? null,
  znn_connect: async args => {
    const value = await readFor(args.stored, args.origin);
    if (value && await permissions.touch(args.origin, value.scope) && selection.publicValue(args.stored)) return { settled: true, result: [value.address] };
    return queueApproval('connect', args);
  },
  znn_disconnect: async ({ origin, stored }) => ({ settled: true, result: await revokeOrigin(stored, origin) }),
  znn_sendTransaction: args => queueApproval('sendTransaction', args),
  znn_signAndSendBlock: args => queueApproval('signAndSendBlock', args),
  znn_sign: async args => {
    const message = typeof args.params === 'string' ? args.params : args.params?.message;
    if (typeof message !== 'string' || !message.length || message.length > maxSignMessageLength) throw invalidParams('znn_sign expects a nonempty message of at most 8192 characters');
    return queueApproval('signMessage', { ...args, params: { message } });
  },
};

const handleProviderRequest = async (request, sender) => {
  const origin = permissions.originOf(sender);
  const target = { tabId: sender.tab.id, frameId: sender.frameId ?? 0, documentId: sender.documentId };
  const { id, method, params } = request;

  if (!origin || typeof target.documentId !== 'string' || !target.documentId) {
    await respond(target, id, undefined, errors.internal);
    return;
  }

  const handler = providerMethods[method];

  if (!handler) {
    await respond(target, id, undefined, errors.unsupportedMethod);
    return;
  }

  try {
    const pending = await selection.transaction(async stored => {
      const outcome = await handler({ id, origin, target, sender, params, stored });
      if (outcome && typeof outcome === 'object' && 'settled' in outcome) {
        if (outcome.settled) await respond(target, id, outcome.result);
        return outcome.present;
      }
      await respond(target, id, outcome);
      return null;
    });
    // Window operations take window -> pending; never hold selection while
    // awaiting popup startup, which will itself need the selection lock.
    if (pending) {
      try { if (!(await requests.present(pending))) throw selection.ended(); }
      catch (error) { await requests.reject(pending); throw error; }
    }
  } catch (err) {
    const error = err && err.code ? err : { ...errors.internal, message: err?.message || 'Internal error' };
    await respond(target, id, undefined, error);
  }
};

//
// Popup-facing methods
//
const requestAllowed = async (record, request) => selection.matches(record, request?.binding) &&
  (request.type === 'connect' || await permissions.isConnected(request.origin, request.binding.scope));
const internalMethods = {
  'approvals.list': () => requests.list(),
  'approvals.next': ({ binding }) => selection.transaction(async stored => {
    const record = selection.current(stored);
    selection.assert(record, binding, true);
    const { next, removed } = await requests.nextFor(record);
    await rejectRemoved(removed);
    if (next && !(await requestAllowed(record, next))) {
      await rejectRemoved(await requests.cancelWhere(item => item.id === next.id));
      return null;
    }
    return next;
  }),
  'approvals.claim': ({ identity, windowId }) => selection.transaction(async stored => {
    const request = await requests.get(identity?.id);
    if (!(await requestAllowed(selection.current(stored), request))) return null;
    return requests.claim(identity, windowId);
  }),
  // Read-only check may run inside a popup's selection-locked key operation.
  'approvals.checkClaim': async ({ identity }) => {
    const request = await requests.get(identity?.id);
    return await requestAllowed(selection.current(await selection.read()), request) && await requests.checkClaim(identity);
  },
  'approvals.resolve': ({ identity, result }) => selection.transaction(async stored => {
    const candidate = await requests.get(identity?.id);
    if (!(await requestAllowed(selection.current(stored), candidate))) return false;
    const request = await requests.resolve(identity);
    if (!request) return false;
    if (request.type === 'connect') {
      try { await permissions.grant(request.origin, request.binding.scope, request); }
      catch (error) { await respond(request, request.responseId, undefined, errors.internal); throw error; }
      result = [request.binding.scope.address];
    } else if (request.type === 'signMessage' && result?.address !== request.binding.scope.address) {
      await respond(request, request.responseId, undefined, errors.internal); return false;
    }
    await respond(request, request.responseId, result);
    return true;
  }),
  'approvals.reject': async ({ identity, error }) => {
    const request = await requests.reject(identity);
    if (!request) return false;
    await respond(request, request.responseId, undefined, error || errors.userRejected);
    return true;
  },
  'permissions.list': () => permissions.list(),
  'permissions.revoke': ({ origin, scope }) => selection.transaction(stored => revokeOrigin(stored, origin, scope)),
  'permissions.revokeAll': () => selection.transaction(async stored => {
    const sites = await permissions.revokeAll();
    await rejectRemoved(await requests.cancelWhere(() => true));
    await announceToSites(stored, 'accountsChanged', undefined, sites.map(site => site.origin));
    return true;
  }),
  'events.accountsChanged': ({ selectionId }) => selection.transaction(stored => announceToSites(stored, 'accountsChanged', selectionId)),
  'events.chainChanged': ({ selectionId }) => selection.transaction(stored => announceToSites(stored, 'chainChanged', selectionId)),
  'events.nodeChanged': ({ selectionId }) => selection.transaction(stored => announceToSites(stored, 'nodeChanged', selectionId)),
  'session.locked': ({ selectionId, origins = [], cancelled = [] }) => selection.transaction(async stored => {
    await rejectRemoved(cancelled);
    return announceToSites(stored, 'accountsChanged', selectionId, origins);
  }),
};

//
// The one listener
//
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  // A content script announcing itself, so events can be delivered to it later
  // without the `tabs` permission. Nothing is trusted from the message body —
  // the origin is the one Chrome attributes to the sender.
  if (message.channel === 'znn' && message.kind === 'hello') {
    if (isFromContentScript(sender)) {
      frames.register(sender, permissions.originOf(sender));
    }
    return false;
  }

  if (message.channel === 'znn' && message.kind === 'request') {
    // Only ever from a content script, and the origin comes from `sender`.
    if (!isFromContentScript(sender)) {
      return false;
    }
    handleProviderRequest(message, sender);
    // Answered later over `chrome.tabs.sendMessage`, not through this callback:
    // an approval outlives the message channel and, often, the worker itself.
    sendResponse({ accepted: true });
    return false;
  }

  if (message.channel === 'internal') {
    // The check the audit found missing. Without it, anything that could reach
    // the runtime could drive the wallet's own control surface.
    if (!isFromExtension(sender)) {
      return false;
    }
    const handler = internalMethods[message.method];

    if (!handler) {
      sendResponse({ error: 'Unknown method' });
      return false;
    }
    Promise.resolve(handler(message.params || {}))
      .then((result) => sendResponse({ result }))
      .catch((err) => sendResponse({ error: err?.message || 'Internal error' }));
    return true;
  }

  return false;
});

//
// Housekeeping
//

// Closing the approval window is an answer: it means no. Without this the page
// waits forever on a promise nobody is ever going to settle.
//
// It answers for the requests THAT window was showing, and only those. The
// queue as a whole is not the same thing: a site whose connect has just been
// approved sends its next request immediately — that is what being connected is
// for — and it arrives while this window is closing, having been drawn to
// nobody. Answering it "user rejected" told the page a person had declined a
// prompt that never appeared, and it did so every time, on the first attempt,
// for exactly the connect-then-sign shape every site uses.
chrome.windows.onRemoved.addListener(async (windowId) => {
  try {
    const abandoned = await requests.closeWindow(windowId);
    // A claimed operation may already have reached publication. Closing its
    // window cannot promise cancellation or invite an automatic retry.
    await Promise.all(abandoned.map(request => respond(request, request.responseId, undefined,
      request.claimId ? errors.approvalInterrupted : errors.userRejected)));
  } catch (error) {
    // Storage failure cannot be treated as a successful removal or approval.
    console.error('Unable to close pending wallet approvals', error);
  }
});

// A closed tab has no frames left to deliver to.
chrome.tabs.onRemoved.addListener((tabId) => {
  frames.forgetTab(tabId);
});

// The popup enforces the auto-lock whenever it opens, but the popup is usually
// closed. This is what actually ends a session while nobody is looking.
const autoLockAlarm = 'znn.autoLock';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(autoLockAlarm, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(autoLockAlarm, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== autoLockAlarm) {
    return;
  }
  await selection.transaction(async stored => {
    const record = selection.current(stored);
    if (!record || record.locked || record.mode === 'local' || selection.live(record)) return;
    const id = await selection.revoke(record);
    await announceToSites(await selection.read(), 'accountsChanged', id);
  });
});
