import observeDocumentLifetime from '../../services/utils/documentLifetime';

// The wallet as a page sees it: `window.zenon`.
//
// This file runs in the page's own world, injected by the browser rather than
// by the document. That matters: the previous build set `window.zenon` by
// appending a <script> element from the content script, and such an element is
// executed by the page, so the page's Content-Security-Policy governs it. Any
// site whose `script-src` omits 'unsafe-inline' silently refused to run it —
// the element landed in the DOM, the assignment never happened, and the wallet
// was invisible to exactly the security-conscious sites most likely to want it.
// A manifest v3 content script declared `"world": "MAIN"` has no such problem.
//
// What was here was a single boolean, `isSyriusExtension: true`. Every site had
// to hand-roll `window.postMessage` calls against an undocumented set of string
// constants and correlate the replies itself — with no request ids, so two
// overlapping calls could not be told apart. This is a promise-returning
// provider of the shape anyone who has integrated a browser wallet expects.
//
// Nothing here is trusted by anything. It runs in the page's world, where the
// page could replace it outright; every decision that matters is taken in the
// popup, against an origin the browser reports rather than one this file claims.

(() => {
  const inboundTarget = 'znn-inpage';
  const outboundTarget = 'znn-contentscript';

  const pending = new Map();
  const listeners = new Map();
  let requestCounter = 0;
  let active = Boolean(document.documentElement);

  const nextId = () => {
    requestCounter += 1;
    return `znn-${Date.now().toString(36)}-${requestCounter}`;
  };

  // A request that is waiting on a person has no useful deadline — somebody may
  // be looking for their password — so only the transport is bounded. If the
  // content script never answers at all, the promise still settles.
  const transportTimeoutMs = 30000;

  const request = ({ method, params }) =>
    new Promise((resolve, reject) => {
      lifetime.check();
      if (!active) { reject({ code: 4900, message: 'This document is no longer active. Make a new request after returning.' }); return; }
      const id = nextId();
      const needsApproval = method !== 'znn_accounts' && method !== 'znn_chainId' && method !== 'znn_nodeUrl';

      const timer = needsApproval
        ? null
        : setTimeout(() => {
            pending.delete(id);
            reject({ code: 4900, message: 'The wallet did not respond' });
          }, transportTimeoutMs);

      pending.set(id, { resolve, reject, timer });
      window.postMessage({ target: outboundTarget, kind: 'request', id, method, params }, window.location.origin);
    });

  const emit = (event, data) => {
    const handlers = listeners.get(event);

    if (!handlers) {
      return;
    }
    // Copied before iterating: a handler is allowed to remove itself.
    [...handlers].forEach((handler) => {
      try {
        handler(data);
      } catch (err) {
        console.error('[zenon] listener for', event, 'threw', err);
      }
    });
  };

  const receiveMessage = (event) => {
    lifetime.check();
    // Only messages this window posted to itself. Anything from a frame or
    // another origin is not the content script.
    if (event.source !== window) {
      return;
    }
    const message = event.data;

    if (!message || message.target !== inboundTarget) {
      return;
    }

    if (message.kind === 'response') {
      const waiting = pending.get(message.id);

      if (!waiting) {
        return;
      }
      pending.delete(message.id);
      if (waiting.timer) {
        clearTimeout(waiting.timer);
      }
      if (message.error) {
        waiting.reject(message.error);
      } else {
        waiting.resolve(message.result);
      }
      return;
    }

    if (message.kind === 'event') {
      if (message.event === 'accountsChanged') {
        provider.accounts = Array.isArray(message.data) ? message.data : [];
      }
      if (message.event === 'chainChanged') {
        provider.chainId = message.data;
      }
      emit(message.event, message.data);
    }
  };

  const provider = {
    // Kept from the old shape so anything that sniffed for it still works.
    isSyriusExtension: true,
    isZenon: true,
    version: 2,

    // Last known values, updated by events, so a site can render without
    // awaiting. `accounts` is empty until the site is connected.
    accounts: [],
    chainId: null,

    request,

    // Opens the connect prompt, or resolves immediately for an origin that has
    // already been connected and is still unlocked.
    async connect() {
      const accounts = await request({ method: 'znn_connect' });
      provider.accounts = accounts || [];
      return provider.accounts;
    },

    async disconnect() {
      await request({ method: 'znn_disconnect' });
      provider.accounts = [];
      return true;
    },

    // Read-only and never prompts: returns [] when the site is not connected.
    async getAccounts() {
      provider.accounts = (await request({ method: 'znn_accounts' })) || [];
      return provider.accounts;
    },

    async getChainId() {
      provider.chainId = await request({ method: 'znn_chainId' });
      return provider.chainId;
    },

    async getNodeUrl() {
      return request({ method: 'znn_nodeUrl' });
    },

    async isConnected() {
      return (await provider.getAccounts()).length > 0;
    },

    // A plain transfer. `amount` is in the token's smallest unit, matching what
    // the ledger stores and what the SDK returns for a balance.
    sendTransaction({ to, tokenStandard, amount }) {
      return request({ method: 'znn_sendTransaction', params: { to, tokenStandard, amount } });
    },

    // An arbitrary account block, including contract calls. Shown to the person
    // in full before anything is signed.
    sendAccountBlock(block) {
      return request({ method: 'znn_signAndSendBlock', params: block });
    },

    // Signs a plain message with the account's key and resolves to
    // `{message, address, publicKey, signature}` — the last two hex, the same
    // pair desktop Syrius answers `znn_sign` with over WalletConnect. Nothing
    // is broadcast and nothing is spent; it proves the address is this
    // person's, which is what a login challenge or an ownership proof needs.
    signMessage(message) {
      return request({ method: 'znn_sign', params: { message } });
    },

    on(event, handler) {
      if (typeof handler !== 'function') {
        return provider;
      }
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event).add(handler);
      return provider;
    },

    removeListener(event, handler) {
      listeners.get(event)?.delete(handler);
      return provider;
    },
  };

  // Reject actual provider promises synchronously when leaving. A posted
  // cancellation message could itself wait in the BFCache task queue.
  const leave = () => {
    active = false;
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject({ code: 4900, message: 'The page left before this request completed. Make a new request after returning.' });
    }
    pending.clear();
    provider.accounts = [];
    provider.chainId = null;
  };
  const enter = () => { active = Boolean(document.documentElement); };
  const listen = window.addEventListener.bind(window);
  const lifetime = observeDocumentLifetime({
    onHide: leave, onShow: enter, onReset: () => { leave(); enter(); },
    install: () => listen('message', receiveMessage),
  });

  // A page that loaded before the wallet did gets told, rather than having to
  // poll for `window.zenon`.
  try {
    Object.defineProperty(window, 'zenon', { value: provider, writable: false, configurable: false });
  } catch (err) {
    window.zenon = provider;
  }

  window.dispatchEvent(new Event('zenon#initialized'));
})();
