import observeDocumentLifetime from '../../services/utils/documentLifetime';

// The isolated relay owns activation and request tokens. Page messages supply
// only correlation, method and parameters; they cannot select these bindings.
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
let active = Boolean(document.documentElement);
let activation = privateToken();
let legacyCounter = 0;
const outstanding = new Map();
const approvalMethods = new Set(['znn_connect', 'znn_sendTransaction', 'znn_signAndSendBlock', 'znn_sign']);
const transportError = message => ({ code: 4900, message });
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

const sendToBackground = (message, requestToken) => {
  try {
    chrome.runtime.sendMessage(message, response => {
      const failure = chrome.runtime.lastError;
      if (requestToken && (failure || response?.accepted !== true)) {
        settle(requestToken, { error: response?.error || transportError(failure?.message || 'The wallet did not accept the request. Reload the page.') });
      }
    });
  } catch (error) {
    if (requestToken) settle(requestToken, { error: transportError('The wallet connection ended. Reload the page.') });
  }
};
const begin = (entry) => {
  lifetime.check();
  if (!active || (entry.activation && entry.activation !== activation)) {
    entry.resolve?.(null);
    return;
  }
  const requestToken = privateToken();
  const current = { ...entry, activation };
  outstanding.set(requestToken, current);
  const timeout = entry.kind === 'value' ? 10000 : approvalMethods.has(entry.method) ? null : 30000;
  if (timeout) current.timer = setTimeout(() => settle(requestToken, { error: transportError('The wallet did not respond') }), timeout);
  sendToBackground({ channel: 'znn', kind: 'request', id: entry.id, method: entry.method,
    params: entry.params, activation, requestToken }, requestToken);
};
const requestValue = (method, expectedActivation) => new Promise(resolve => {
  legacyCounter += 1;
  begin({ id: `znn-cs-${legacyCounter}`, kind: 'value', method, params: {}, resolve, activation: expectedActivation });
});
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
const settle = (requestToken, message) => {
  const entry = outstanding.get(requestToken);
  if (!active || !entry || entry.activation !== activation) return false;
  outstanding.delete(requestToken);
  clearTimeout(entry.timer);
  if (entry.kind === 'value') entry.resolve(message.error ? null : message.result);
  else if (entry.kind === 'legacy') publishLegacy(entry, message).catch(() => {});
  else postToPage({ target: inpageTarget, kind: 'response', id: entry.id, result: message.result, error: message.error });
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
  if (message.kind === 'probe') {
    const entry = outstanding.get(message.requestToken);
    accepted = current && (!message.requireRequest || Boolean(entry && entry.activation === activation));
  } else if (current && message.kind === 'response') {
    // No unmatched response reaches either page protocol, even if its public
    // correlation ID happens to match a request in a replacement document.
    accepted = settle(message.requestToken, message);
  } else if (current && message.kind === 'event') {
    postToPage({ target: inpageTarget, kind: 'event', event: message.event, data: message.data });
    const legacyEvents = {
      accountsChanged: () => ({ method: 'znn.addressChanged', data: { newAddress: message.data?.[0] || null } }),
      chainChanged: () => ({ method: 'znn.chainIdChanged', data: { newChainId: message.data } }),
      nodeChanged: () => ({ method: 'znn.nodeChanged', data: { newNode: message.data } }),
    };
    if (Object.hasOwn(legacyEvents, message.event)) postToPage(legacyEvents[message.event]());
    accepted = true;
  }
  sendResponse({ accepted });
  return false;
});

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
const enter = event => {
  if (!document.documentElement) return;
  if (event.persisted || !active) activation = privateToken();
  active = true;
  sendToBackground({ channel: 'znn', kind: 'hello', activation });
};
const listen = window.addEventListener.bind(window);
const lifetime = observeDocumentLifetime({
  onHide: leave, onShow: enter,
  onReset: () => { leave(); enter({ persisted: true }); },
  install: () => listen('message', receivePageMessage),
});
sendToBackground({ channel: 'znn', kind: 'hello', activation });
