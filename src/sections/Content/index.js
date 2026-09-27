import { limits, validateEnvelope, validResponseId, busy } from '../../services/utils/approvalLimits';

// The relay between the page and the extension.
//
// It runs in the isolated world: it can see the page's DOM and its
// postMessages, and it can talk to the service worker, but the page cannot
// reach into it. That makes it the only place the two can meet, and the reason
// it stays this thin — it forwards, it never decides. Every decision that
// matters is taken in the background against the origin Chrome reports for this
// frame, not against anything a page says about itself.
//
// Two protocols come in. The current one is the request/response transport
// behind `window.zenon` (see src/sections/Inpage). The other is the flat
// `{method: "znn.requestWalletAccess"}` postMessage the old build used, which
// is kept working here so sites written against it do not break.

const inpageTarget = 'znn-inpage';
const contentTarget = 'znn-contentscript';

const postToPage = (message) => window.postMessage(message, window.location.origin);

let activeTransports = 0;
const localFailure = (id, error) => {
  // An oversized/invalid ID is not echoed. Standard and legacy IDs fit this
  // contract; malformed callers cannot force an unbounded error payload.
  if (validResponseId(id)) receiveResponse({ id, error });
};
const sendToBackground = message => {
  const provider = message.kind === 'request';
  if (provider) {
    try {
      if (activeTransports >= limits.activeHandlers) throw busy();
      validateEnvelope(message);
    } catch (error) { localFailure(message.id, { code: error.code, message: error.message }); return; }
    activeTransports++;
  }
  const id = message.id;
  try {
    chrome.runtime.sendMessage(message, response => {
      if (provider) activeTransports--;
      if (chrome.runtime.lastError) {
        if (provider) localFailure(id, { code: 4900, message: 'The wallet transport is unavailable.' });
      } else if (provider && response?.error) localFailure(id, response.error);
    });
  } catch (error) {
    if (provider) { activeTransports--; localFailure(id, { code: 4900, message: 'The wallet transport is unavailable.' }); }
  }
};

//
// Legacy protocol
//
// The old bridge had no request ids, so a reply could only be matched to a
// request by its message name. That is preserved exactly: one legacy call of
// each kind can be in flight, and its reply is republished under the name the
// old code listens for.
//
const legacyRequests = {
  'znn.requestWalletAccess': {
    method: 'znn_connect',
    onSuccess: (accounts) => ({
      method: 'znn.grantedWalletRead',
      data: { address: accounts?.[0] || null },
    }),
    onError: (error) => ({ method: 'znn.deniedWalletRead', error: error?.message, data: {} }),
  },
  'znn.sendTransactionToSigning': {
    method: 'znn_sendTransaction',
    onSuccess: (data) => ({ method: 'znn.signedTransaction', data }),
    onError: (error) => ({ method: 'znn.deniedSignTransaction', error: error?.message, data: {} }),
  },
  'znn.sendAccountBlockToSend': {
    method: 'znn_signAndSendBlock',
    onSuccess: (data) => ({ method: 'znn.accountBlockSent', data }),
    onError: (error) => ({ method: 'znn.deniedSendAccountBlock', error: error?.message, data: {} }),
  },
};

// Ids issued for legacy calls, so the background can stay on one protocol.
const legacyInFlight = new Map();
let legacyCounter = 0;

// The legacy grant reply carried the chain and node alongside the address, and
// they are read-only calls, so they are gathered before the reply goes out.
const decorateLegacyGrant = async (payload) => {
  if (payload.method !== 'znn.grantedWalletRead') {
    return payload;
  }
  const [chainId, nodeUrl] = await Promise.all([
    requestValue('znn_chainId'),
    requestValue('znn_nodeUrl'),
  ]);
  return { ...payload, data: { ...payload.data, chainId, nodeUrl } };
};

// A small promise wrapper for the read-only methods this file needs itself.
const valueWaiters = new Map();

const requestValue = (method) =>
  new Promise((resolve) => {
    if (valueWaiters.size >= limits.activeHandlers) { resolve(null); return; }
    legacyCounter += 1;
    const id = `znn-cs-${Date.now().toString(36)}-${legacyCounter}`;
    const timer = setTimeout(() => {
      valueWaiters.delete(id);
      resolve(null);
    }, 10000);

    valueWaiters.set(id, { resolve, timer });
    sendToBackground({ channel: 'znn', kind: 'request', id, method, params: {} });
  });

// Announce this frame so the worker can deliver events to it later. Doing it
// this way is what keeps the `tabs` permission — "Read your browsing history"
// on the install prompt — off this extension.
sendToBackground({ channel: 'znn', kind: 'hello' });

//
// Page -> background
//
window.addEventListener(
  'message',
  (event) => {
    if (event.source !== window) {
      return;
    }
    const message = event.data;

    if (!message || typeof message !== 'object') {
      return;
    }

    // Current protocol.
    if (message.target === contentTarget && message.kind === 'request') {
      sendToBackground({
        channel: 'znn',
        kind: 'request',
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }

    // Legacy protocol.
    const legacy = Object.hasOwn(legacyRequests, message.method) ? legacyRequests[message.method] : null;

    if (legacy) {
      legacyCounter += 1;
      const id = `znn-legacy-${Date.now().toString(36)}-${legacyCounter}`;
      if (legacyInFlight.size >= limits.activeHandlers) { postToPage(legacy.onError(busy())); return; }
      const timer = setTimeout(() => {
        const pending = legacyInFlight.get(id);
        if (!pending) return;
        legacyInFlight.delete(id);
        postToPage(pending.legacy.onError({ message: 'The wallet did not finish. Verify the outcome before retrying.' }));
      }, limits.ttl + 60000);
      legacyInFlight.set(id, { legacy, timer });
      sendToBackground({
        channel: 'znn',
        kind: 'request',
        id,
        method: legacy.method,
        params: message.params || {},
      });
    }
  },
  false
);

//
// Background -> page
//
const receiveResponse = (message, reply = () => {}) => {
  // Acceptance belongs to the isolated relay, before posting into the page's
  // event queue. The native acknowledgement can reach the worker later.
  const acceptedAt = Date.now();
  if (!message.error && Number.isFinite(message.expiresAt) && acceptedAt >= message.expiresAt) {
    message = { ...message, result: undefined, error: { code: -32603,
      message: 'Approval expired. The outcome is unknown; verify it before retrying.' } };
  }
  const acknowledge = () => reply({ accepted: !message.error, acceptedAt });
  const waiter = valueWaiters.get(message.id);

  if (waiter) {
    valueWaiters.delete(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve(message.error ? null : message.result);
    acknowledge(); return false;
  }

  const pendingLegacy = legacyInFlight.get(message.id);

  if (pendingLegacy) {
    const { legacy, timer } = pendingLegacy;
    clearTimeout(timer);
    legacyInFlight.delete(message.id);
    const payload = message.error ? legacy.onError(message.error) : legacy.onSuccess(message.result);
    decorateLegacyGrant(payload).then(postToPage);
    // Decoration reads may wait on the permission lock; acknowledge now so
    // they cannot deadlock the pending grant's durable promotion.
    acknowledge(); return false;
  }

  postToPage({
    target: inpageTarget,
    kind: 'response',
    id: message.id,
    result: message.result,
    error: message.error,
    expiresAt: message.expiresAt,
    acceptedAt,
  });
  acknowledge(); return false;
};

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || message.channel !== 'znn') {
    return false;
  }

  if (message.kind === 'response') return receiveResponse(message, reply);

  if (message.kind === 'event') {
    postToPage({ target: inpageTarget, kind: 'event', event: message.event, data: message.data });

    // The same events under the names the old bridge published them by.
    const legacyEvents = {
      accountsChanged: () => ({
        method: 'znn.addressChanged',
        data: { newAddress: message.data?.[0] || null },
      }),
      chainChanged: () => ({ method: 'znn.chainIdChanged', data: { newChainId: message.data } }),
      nodeChanged: () => ({ method: 'znn.nodeChanged', data: { newNode: message.data } }),
    };
    const asLegacy = legacyEvents[message.event];

    if (asLegacy) {
      postToPage(asLegacy());
    }
    return false;
  }

  return false;
});
