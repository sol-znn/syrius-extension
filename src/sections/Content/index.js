import observeDocumentLifetime from '../../services/utils/documentLifetime';
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
// It owns two private tokens the page never sees: an activation for this
// document's lifetime (renewed when the page comes back from the back/forward
// cache or its document is rewritten), and one per request. The worker answers
// only to both, so a reply can never land in a replacement document or be
// matched to a different request that happens to reuse a public ID. Page
// messages supply only correlation, method and parameters.
//
// Two protocols come in. The current one is the request/response transport
// behind `window.zenon` (see src/sections/Inpage). The other is the flat
// `{method: "znn.requestWalletAccess"}` postMessage the old build used, which
// is kept working here so sites written against it do not break.
const inpageTarget = 'znn-inpage';
const contentTarget = 'znn-contentscript';
const postToPage = message => window.postMessage(message, window.location.origin);
// getRandomValues is also available on HTTP pages. randomUUID requires a
// secure context, while this relay is intentionally injected on HTTP too.
const privateToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
// A prerendered page (an address-bar prediction, a site's speculation rules)
// runs this relay before anyone has seen it, and the worker answers only an
// active document (nativeNavigation.capture). Sent at once, its first read
// failed with "the requesting document has left", and its hello, which is
// sent at load and not again, never registered it for events. So both wait
// for activation. Callers re-check `document.prerendering`: the page can
// dispatch a `prerenderingchange` of its own.
const afterActivation = run => document.addEventListener('prerenderingchange', run, { once: true });
let active = Boolean(document.documentElement);
let activation = privateToken();
let legacyCounter = 0;
let activeTransports = 0;
const outstanding = new Map();
const approvalMethods = new Set(['znn_connect', 'znn_sendTransaction', 'znn_signAndSendBlock', 'znn_sign']);
const transportError = message => ({ code: 4900, message });
// An approval lasts up to its 30-minute deadline; one more minute lets the
// worker's own expiry arrive first. This only settles a lost worker/transport.
const approvalFallbackMs = limits.ttl + 60000;
const legacyRequests = {
  'znn.requestWalletAccess': {
    method: 'znn_connect',
    onSuccess: accounts => ({ method: 'znn.grantedWalletRead', data: { address: accounts?.[0] || null } }),
    onError: error => ({ method: 'znn.deniedWalletRead', error: error?.message, data: {} }),
  },
  'znn.sendTransactionToSigning': {
    method: 'znn_sendTransaction',
    onSuccess: data => ({ method: 'znn.signedTransaction', data }),
    onError: error => ({ method: 'znn.deniedSignTransaction', error: error?.message, data: {} }),
  },
  'znn.sendAccountBlockToSend': {
    method: 'znn_signAndSendBlock',
    onSuccess: data => ({ method: 'znn.accountBlockSent', data }),
    onError: error => ({ method: 'znn.deniedSendAccountBlock', error: error?.message, data: {} }),
  },
};

// Admission is bounded here too, before anything reaches the worker: a page
// cannot queue unbounded transport work or oversized messages.
const sendToBackground = (message, requestToken) => {
  const request = message.kind === 'request';
  if (request) {
    try {
      if (activeTransports >= limits.activeHandlers) throw busy();
      validateEnvelope(message);
    } catch (error) {
      settle(requestToken, { error: { code: error.code, message: error.message } });
      return;
    }
    activeTransports++;
  }
  try {
    chrome.runtime.sendMessage(message, response => {
      if (request) activeTransports--;
      const failure = chrome.runtime.lastError;
      if (requestToken && (failure || response?.accepted !== true)) {
        settle(requestToken, { error: response?.error || transportError(failure?.message || 'The wallet did not accept the request. Reload the page.') });
      }
    });
  } catch (error) {
    if (request) activeTransports--;
    if (requestToken) settle(requestToken, { error: transportError('The wallet connection ended. Reload the page.') });
  }
};
const begin = (entry) => {
  if (document.prerendering) { afterActivation(() => begin(entry)); return; }
  lifetime.check();
  if (!active || (entry.activation && entry.activation !== activation)) {
    entry.resolve?.(null);
    return;
  }
  if (outstanding.size >= limits.activeHandlers) {
    if (entry.kind === 'value') entry.resolve(null);
    else if (entry.kind === 'legacy') postToPage(entry.legacy.onError(busy()));
    // An invalid correlation ID is not echoed back to the page.
    else if (validResponseId(entry.id)) postToPage({ target: inpageTarget, kind: 'response', id: entry.id, error: { code: busy().code, message: busy().message } });
    return;
  }
  const requestToken = privateToken();
  const current = { ...entry, activation };
  outstanding.set(requestToken, current);
  const timeout = entry.kind === 'value' ? 10000 : approvalMethods.has(entry.method) ? approvalFallbackMs : 30000;
  current.timer = setTimeout(() => settle(requestToken, { error: transportError(approvalMethods.has(entry.method)
    ? 'The wallet did not finish. Verify the outcome before retrying.' : 'The wallet did not respond') }), timeout);
  sendToBackground({ channel: 'znn', kind: 'request', id: entry.id, method: entry.method,
    params: entry.params, activation, requestToken }, requestToken);
};
const requestValue = (method, expectedActivation) => new Promise(resolve => {
  legacyCounter += 1;
  begin({ id: `znn-cs-${legacyCounter}`, kind: 'value', method, params: {}, resolve, activation: expectedActivation });
});
// The legacy grant reply carried the chain and node alongside the address.
// Those reads may wait on the permission lock, so they run after the grant's
// response has been acknowledged, never before.
const publishLegacy = async (entry, message) => {
  let payload = message.error ? entry.legacy.onError(message.error) : entry.legacy.onSuccess(message.result);
  if (payload.method === 'znn.grantedWalletRead') {
    const [chainId, nodeUrl] = await Promise.all([
      requestValue('znn_chainId', entry.activation), requestValue('znn_nodeUrl', entry.activation),
    ]);
    payload = { ...payload, data: { ...payload.data, chainId, nodeUrl } };
  }
  if (active && activation === entry.activation) postToPage(payload);
};
// Answers the one outstanding request this token names, in this activation.
// Returns whether it did.
const settle = (requestToken, message) => {
  const entry = outstanding.get(requestToken);
  if (!active || !entry || entry.activation !== activation) return false;
  outstanding.delete(requestToken);
  clearTimeout(entry.timer);
  if (entry.kind === 'value') entry.resolve(message.error ? null : message.result);
  else if (entry.kind === 'legacy') publishLegacy(entry, message).catch(() => {});
  else postToPage({ target: inpageTarget, kind: 'response', id: entry.id, result: message.result, error: message.error,
    expiresAt: message.expiresAt, acceptedAt: message.acceptedAt });
  return true;
};

const receivePageMessage = event => {
  lifetime.check();
  if (!active || event.source !== window || !event.data || typeof event.data !== 'object') return;
  const message = event.data;
  if (message.target === contentTarget && message.kind === 'request') {
    begin({ kind: 'modern', id: message.id, method: message.method, params: message.params });
    return;
  }
  const legacy = Object.hasOwn(legacyRequests, message.method) ? legacyRequests[message.method] : null;
  if (legacy) {
    legacyCounter += 1;
    begin({ kind: 'legacy', id: `znn-legacy-${privateToken()}`, legacy, method: legacy.method, params: message.params || {} });
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  lifetime.check();
  if (sender.id !== chrome.runtime.id || !message || message.channel !== 'znn') return false;
  const current = active && message.activation === activation;
  let accepted = false;
  // Acceptance belongs to this isolated relay, before posting into the page's
  // event queue: its time is the consent commitment point for a connection.
  const acceptedAt = Date.now();
  if (message.kind === 'probe') {
    const entry = outstanding.get(message.requestToken);
    accepted = current && (!message.requireRequest || Boolean(entry && entry.activation === activation));
  } else if (current && message.kind === 'response') {
    // An approval that arrives after its deadline is an unknown outcome, never
    // a success the page can act on.
    let answer = message;
    if (!answer.error && Number.isFinite(answer.expiresAt) && acceptedAt >= answer.expiresAt) {
      answer = { ...answer, result: undefined, error: { code: -32603,
        message: 'Approval expired. The outcome is unknown; verify it before retrying.' } };
    }
    // No unmatched response reaches either page protocol, even if its public
    // correlation ID happens to match a request in a replacement document.
    accepted = settle(message.requestToken, { ...answer, acceptedAt }) && !answer.error;
  } else if (current && message.kind === 'event') {
    postToPage({ target: inpageTarget, kind: 'event', event: message.event, data: message.data });
    // The same events under the names the old bridge published them by.
    const legacyEvents = {
      accountsChanged: () => ({ method: 'znn.addressChanged', data: { newAddress: message.data?.[0] || null } }),
      chainChanged: () => ({ method: 'znn.chainIdChanged', data: { newChainId: message.data } }),
      nodeChanged: () => ({ method: 'znn.nodeChanged', data: { newNode: message.data } }),
    };
    if (Object.hasOwn(legacyEvents, message.event)) postToPage(legacyEvents[message.event]());
    accepted = true;
  }
  sendResponse({ accepted, acceptedAt });
  return false;
});

// Leaving (pagehide, or the document being rewritten) ends every outstanding
// request of this activation at once; returning starts a new activation.
const leave = () => {
  const departed = activation;
  active = false;
  for (const entry of outstanding.values()) {
    clearTimeout(entry.timer);
    if (entry.kind === 'value') entry.resolve(null);
  }
  outstanding.clear();
  sendToBackground({ channel: 'znn', kind: 'bye', activation: departed });
};
const hello = () => {
  if (document.prerendering) { afterActivation(hello); return; }
  sendToBackground({ channel: 'znn', kind: 'hello', activation });
};
const enter = event => {
  if (!document.documentElement) return;
  if (event.persisted || !active) activation = privateToken();
  active = true;
  hello();
};
const listen = window.addEventListener.bind(window);
const lifetime = observeDocumentLifetime({
  onHide: leave, onShow: enter,
  onReset: () => { leave(); enter({ persisted: true }); },
  install: () => listen('message', receivePageMessage),
});
// Announce this frame so the worker can deliver events to it later, without
// the worker reading tab URLs (see Background/frames.js).
hello();
