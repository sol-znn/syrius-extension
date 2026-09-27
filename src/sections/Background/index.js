import frames from './frames';
import permissions from './permissions';
import requests from './requests';
import publicNodeUrl from '../../services/utils/publicNodeUrl';

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

const unlockKey = 'znn.unlock';
const publicStateKey = 'znn.publicState';

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

const readSession = async (key) => {
  try {
    const stored = await chrome.storage.session.get(key);
    return stored[key] || null;
  } catch (err) {
    return null;
  }
};

// The public view of the unlocked wallet, or null when it is locked or the
// session has aged out. Expiry is enforced here as well as in the popup so a
// site cannot read an address out of a session the person believes is closed.
const getPublicState = async () => {
  const unlock = await readSession(unlockKey);

  if (!unlock || !unlock.expiresAt || Date.now() > unlock.expiresAt) {
    return null;
  }
  return readSession(publicStateKey);
};

// Read consent after the asynchronous state lookup, so a revoke during that
// lookup takes effect before forming any private read response.
const getConnectedPublicState = async origin => {
  const state = await getPublicState();
  return await permissions.isConnected(origin) ? state : null;
};

//
// Talking back to pages
//
const sendToTab = async (tabId, message, frameId, documentId) => {
  try {
    await chrome.tabs.sendMessage(tabId, message, { ...(frameId === undefined ? {} : { frameId }), ...(documentId ? { documentId } : {}) });
  } catch (err) {
    // The tab navigated away or closed. Nothing to deliver to and nothing to
    // do about it.
  }
};

const respond = (target, id, result, error) =>
  sendToTab(target.tabId, { channel: 'znn', kind: 'response', id, result, error }, target.frameId);

// Fans an event out to every frame whose origin is connected, so a site sees
// an address or chain change without polling.
const broadcast = async (event, data) => {
  const connected = await permissions.list();

  if (!connected.length) {
    return;
  }
  const origins = new Set(connected.map((entry) => entry.origin));
  const targets = await frames.forTabs(origins);

  await Promise.all(
    targets.map(async frame => {
      // The initial list can become stale while the frame registry is read.
      if (await permissions.isConnected(frame.origin)) {
        await sendToTab(frame.tabId, { channel: 'znn', kind: 'event', event, data }, frame.frameId, frame.documentId);
      }
    })
  );
};

//
// Queuing something for a person to approve
//
const queueApproval = async (type, { id, target, origin, sender, params }) => {
  await requests.add({
    id,
    type,
    params: params || {},
    origin,
    tabId: target.tabId,
    frameId: target.frameId,
    title: sender.tab?.title || '',
    favicon: sender.tab?.favIconUrl || '',
    createdAt: Date.now(),
  });
  // Stamped with the window it is actually shown in, so that closing that
  // window answers for this request and for no other. See requests.attachWindow
  // — without it, a request queued in the gap between one window closing and
  // the next opening was rejected as "user rejected" without ever being drawn.
  const windowId = await requests.openApprovalWindow();
  await requests.attachWindow(id, windowId);
};

//
// Page-facing methods
//
const providerMethods = {
  // Cheap, unprompted truth about the current state. A site uses this to decide
  // whether to show a "connect" button, so it must never open a window.
  znn_accounts: async ({ origin }) => {
    const state = await getConnectedPublicState(origin);
    return state?.address ? [state.address] : [];
  },

  znn_chainId: async ({ origin }) => (await getConnectedPublicState(origin))?.chainId ?? null,

  // Redact at egress too: a session can retain raw state from an older build.
  znn_nodeUrl: async ({ origin }) => publicNodeUrl((await getConnectedPublicState(origin))?.nodeUrl),

  // Connecting. An origin that has been connected before and is still unlocked
  // is answered straight away — re-asking a question already answered is the
  // single most irritating thing a wallet does.
  znn_connect: async ({ id, origin, target, sender }) => {
    const state = await getPublicState();

    if (state?.address && await permissions.touch(origin)) {
      return { settled: true, result: [state.address] };
    }
    await queueApproval('connect', { id, target, origin, sender });
    return { settled: false };
  },

  znn_disconnect: async ({ origin }) => {
    await permissions.revoke(origin);
    return { settled: true, result: true };
  },

  // Anything that moves value is prompted every time, even for a connected
  // origin, and is refused outright for one that has never connected.
  znn_sendTransaction: async ({ id, origin, target, sender, params }) => {
    if (!(await permissions.isConnected(origin))) {
      throw errors.unauthorized;
    }
    await queueApproval('sendTransaction', { id, target, origin, sender, params });
    return { settled: false };
  },

  znn_signAndSendBlock: async ({ id, origin, target, sender, params }) => {
    if (!(await permissions.isConnected(origin))) {
      throw errors.unauthorized;
    }
    await queueApproval('signAndSendBlock', { id, target, origin, sender, params });
    return { settled: false };
  },

  // Signing a message. Nothing is broadcast and nothing is spent, but it is
  // still the account's key answering a stranger's question, so it is prompted
  // every time exactly like the two above.
  //
  // Desktop Syrius passes the message as the bare `params` string; the provider
  // in this extension sends `{message}` like every other method here. Both are
  // accepted and normalised to one shape, so the queue and the approval screen
  // only ever see the one.
  znn_sign: async ({ id, origin, target, sender, params }) => {
    if (!(await permissions.isConnected(origin))) {
      throw errors.unauthorized;
    }
    const message = typeof params === 'string' ? params : params?.message;

    if (typeof message !== 'string' || !message.length) {
      throw invalidParams('znn_sign expects a message string');
    }
    // Bounded here rather than at the approval screen: the request sits in
    // session storage until somebody answers it, and a page must not be able to
    // fill that with a megabyte nobody asked for. The screen enforces the same
    // limit again before signing.
    if (message.length > maxSignMessageLength) {
      throw invalidParams(`A message can be at most ${maxSignMessageLength} characters`);
    }
    await queueApproval('signMessage', { id, target, origin, sender, params: { message } });
    return { settled: false };
  },
};

const handleProviderRequest = async (request, sender) => {
  const origin = permissions.originOf(sender);
  const target = { tabId: sender.tab.id, frameId: sender.frameId ?? 0 };
  const { id, method, params } = request;

  if (!origin) {
    await respond(target, id, undefined, errors.internal);
    return;
  }

  const handler = providerMethods[method];

  if (!handler) {
    await respond(target, id, undefined, errors.unsupportedMethod);
    return;
  }

  try {
    const outcome = await handler({ id, origin, target, sender, params });

    // Read-only methods return their value directly; the ones that need a
    // person return `{settled: false}` and are answered when the popup does.
    if (outcome && typeof outcome === 'object' && 'settled' in outcome) {
      if (outcome.settled) {
        await respond(target, id, outcome.result);
      }
      return;
    }
    await respond(target, id, outcome);
  } catch (err) {
    const error = err && err.code ? err : { ...errors.internal, message: err?.message || 'Internal error' };
    await respond(target, id, undefined, error);
  }
};

//
// Popup-facing methods
//
const internalMethods = {
  // The approval screens ask what they are being opened for.
  'approvals.list': () => requests.list(),
  'approvals.next': () => requests.oldest(),

  'approvals.resolve': async ({ id, result, grantOrigin }) => {
    const request = await requests.remove(id);

    if (!request) {
      return false;
    }
    if (grantOrigin) {
      try {
        if (!(await permissions.grant(request.origin, { title: request.title, favicon: request.favicon }))) {
          throw new Error('The connection permission could not be saved.');
        }
      } catch (error) {
        // The queue row has already been removed: answer its original caller
        // with the failed grant rather than leaving its connection pending.
        await respond(request, id, undefined, { ...errors.internal, message: error.message });
        return false;
      }
    }
    await respond(request, id, result);
    return true;
  },

  'approvals.reject': async ({ id, error }) => {
    const request = await requests.remove(id);

    if (!request) {
      return false;
    }
    await respond(request, id, undefined, error || errors.userRejected);
    return true;
  },

  //
  // Connected sites
  //
  'permissions.list': () => permissions.list(),
  'permissions.revoke': async ({ origin }) => {
    const revoked = await permissions.revoke(origin);
    await broadcast('disconnect', { origin });
    return revoked;
  },
  'permissions.revokeAll': async () => {
    const sites = await permissions.list();
    const revoked = await permissions.revokeAll();
    await Promise.all(sites.map((site) => broadcast('disconnect', { origin: site.origin })));
    return revoked;
  },

  //
  // State changes the popup makes that sites care about
  //
  'events.accountsChanged': async ({ address }) => {
    await broadcast('accountsChanged', address ? [address] : []);
    return true;
  },
  'events.chainChanged': async ({ chainId }) => {
    await broadcast('chainChanged', chainId);
    return true;
  },
  'events.nodeChanged': async ({ nodeUrl }) => {
    await broadcast('nodeChanged', publicNodeUrl(nodeUrl));
    return true;
  },

  // Locking has to reach the pages too, or a site keeps showing an address for
  // a wallet that is shut.
  'session.locked': async () => {
    await broadcast('accountsChanged', []);
    return true;
  },
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
  // Snapshotted before anything is awaited on the window itself, so a request
  // queued during this handler is not in the list it answers for.
  const pending = await requests.list();
  const abandoned = pending.filter((request) => request.windowId === windowId);

  // Compare-and-clear: a replacement window may already have claimed the slot.
  await requests.forgetWindow(windowId);

  await Promise.all(
    abandoned.map(async (request) => {
      await requests.remove(request.id);
      await respond(request, request.id, undefined, errors.userRejected);
    })
  );
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
  const unlock = await readSession(unlockKey);

  if (unlock && (!unlock.expiresAt || Date.now() > unlock.expiresAt)) {
    await chrome.storage.session.remove([unlockKey, publicStateKey]);
    await broadcast('accountsChanged', []);
  }
});
