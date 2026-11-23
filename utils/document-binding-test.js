'use strict';
// Document binding (#6) against the integrated worker, relay and provider:
// every page realm is the real content relay and page provider, and the worker
// is the real one. The wallet is always unlocked on one scoped account (#11),
// consent is scoped to that account, and the popup binds, claims and resolves
// (#8); `approvals.current` became the queue's own `current` check. Browser
// storage, messaging, RPC and publication are inert.
const assert = require('node:assert/strict');
const path = require('node:path');
const babel = require('@babel/core');
const { journalStubs } = require('./fixtures/journal-stub');
const React = require('react');
global.window = { crypto: require('node:crypto').webcrypto }; global.self = global.window;
const sdkStorage = new Map();
global.localStorage = { getItem: key => sdkStorage.get(key) ?? null, setItem: (key, value) => sdkStorage.set(key, String(value)), removeItem: key => sdkStorage.delete(key) };
const sdk = require('znn-ts-sdk');
const { BigNumber } = require('ethers');
const root = path.join(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const uuid = () => crypto.randomUUID();
const pendingKey = 'znn.pendingRequests';
const compile = file => babel.transformFileSync(path.join(root, file), { presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }], ['@babel/preset-react', { runtime: 'classic' }]], configFile: false, babelrc: false }).code;
const compiled = new Map();
const loader = (environment, override = () => undefined) => {
  const cache = new Map();
  const load = name => {
    const filename = path.resolve(root, name);
    if (filename.endsWith('.json')) return require(filename); // e.g. contract-call schemas
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    if (!compiled.has(filename)) compiled.set(filename, compile(path.relative(root, filename)));
    const requireModule = id => {
      const replacement = override(id); if (replacement !== undefined) return replacement;
      // The journal has its own suite; see fixtures/journal-stub.js.
      const journaled = journalStubs(id); if (journaled !== undefined) return journaled;
      if (!id.startsWith('.')) return require(id);
      const target = path.resolve(path.dirname(filename), id);
      return load(path.extname(target) ? target : target + '.js');
    };
    new Function('module', 'exports', 'require', ...Object.keys(environment), compiled.get(filename))(module, module.exports, requireModule, ...Object.values(environment));
    return module.exports;
  };
  return load;
};

const address = sdk.Primitives.Address.parse('z1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsggv2f');
const account = address.toString();
const token = sdk.Primitives.TokenStandard.parse('zts1znnxxxxxxxxxxxxx9z4ulx');
const emptyHash = sdk.Primitives.Hash.parse('00'.repeat(32));
// The unlocked session every scenario runs under, and the popup's binding to it.
const scope = { walletName: 'fixture', walletId: account, address: account, index: 0 };
const selectionId = 'fixture-selection';
const binding = { id: selectionId, ownerId: 'owner', scope };
// A signature is the bound account's; the queue refuses any other (#11).
const signed = signature => ({ address: account, publicKey: '07', signature, message: 'inert' });
// The queue's admission limits (#10) are exercised by approval-queue-test.
// Several scenarios here open more than one approval window in quick
// succession, so the numeric limits and attention throttles are lifted. The
// one-pending-connect-per-origin rule still applies, which is why sibling
// frames and second tabs below use a second origin.
const realLimits = loader({})('src/services/utils/approvalLimits.js');
const relaxedLimits = id => (id.endsWith('/utils/approvalLimits')
  ? { ...realLimits, limits: Object.freeze({ ...realLimits.limits, pending: 1000, perOrigin: 1000, perTab: 1000, globalAttention: 0, originAttention: 0, tabAttention: 0 }) }
  : undefined);

// firefox: no native document IDs (nativeNavigation.relayDocuments). Senders and
// frames carry none, tabs.sendMessage takes only a frame, and a committed
// navigation is reported on its own.
const fixture = ({ firefox = false } = {}) => {
  const now = Date.now();
  const session = {
    'znn.unlock': { version: 2, id: 'lease', revision: 'r', walletName: 'fixture', minutes: 15, mode: 'timed', entropy: 'fixture',
      ownerId: 'owner', selectedAddressIndex: 0, selectionId, scope, resumeFrom: null, lastActiveAt: now, expiresAt: now + 3600000 },
    'znn.publicState': { address: account, scope, selectionId, leaseId: 'lease', chainId: 69, nodeUrl: 'wss://node.invalid' },
  }, local = {}, documents = [], deliveries = [], incoming = [], storageListeners = [];
  const timers = new Map(); let nextTimer = 0, windowCount = 0, worker, heldWrite, heldProbe, heldResponse, heldPermissionWrite, failPermissionWrites = false;
  const tails = new Map();
  const navigator = { locks: { request: (name, operation) => {
    const result = (tails.get(name) || Promise.resolve()).then(operation);
    tails.set(name, result.catch(() => {})); return result;
  } } };
  const setTimer = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; };
  const clearTimer = id => timers.delete(id);
  const storage = { onChanged: { addListener: fn => storageListeners.push(fn), removeListener: fn => storageListeners.splice(storageListeners.indexOf(fn), 1) } };
  for (const [area, data] of [['session', session], ['local', local]]) {
    storage[area] = {
      get: async keys => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]]))),
      set: async values => {
        if (area === 'local' && 'syrius.permissions' in values) {
          if (heldPermissionWrite && heldPermissionWrite.matches(values['syrius.permissions'].entries)) {
            const gate = heldPermissionWrite; heldPermissionWrite = null; gate.started.resolve(); await gate.release.promise;
          }
          if (failPermissionWrites) throw Error('Synthetic permission storage failure');
        }
        if (heldWrite && area === 'session' && pendingKey in values) {
          const gate = heldWrite; heldWrite = null; gate.started.resolve(); await gate.release.promise;
        }
        const changes = {};
        for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: structuredClone(data[key]), newValue: structuredClone(value) }; data[key] = structuredClone(value); }
        queueMicrotask(() => storageListeners.forEach(fn => fn(changes, area)));
      },
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    };
  }
  const runtime = { id: 'document-test', getURL: value => 'chrome-extension://document-test/' + value };
  const openWindows = new Set();
  const chrome = { storage, webNavigation: {
    onBeforeNavigate: { addListener: fn => { chrome.beforeNavigate = fn; } },
    onCommitted: { addListener: fn => { chrome.committed = fn; } },
    getFrame: async ({ tabId, frameId }) => { const doc = documents.findLast(d => d.tabId === tabId && d.frameId === frameId && d.routable);
      if (firefox) return doc ? { frameId, parentFrameId: frameId ? 0 : -1, url: doc.sender.url } : null;
      return doc && { documentId: doc.documentId, documentLifecycle: 'active' }; },
  }, runtime: { ...runtime, onMessage: { addListener: fn => { chrome.listener = fn; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    tabs: { onRemoved: { addListener: fn => { chrome.closeTab = fn; } }, sendMessage: async (tabId, message, options) => {
      deliveries.push({ tabId, message: structuredClone(message), options: structuredClone(options) });
      assert(Number.isInteger(options.frameId));
      if (firefox) assert.equal(Object.hasOwn(options, 'documentId'), false); else assert.equal(typeof options.documentId, 'string');
      const doc = firefox ? documents.findLast(item => item.tabId === tabId && item.frameId === options.frameId && item.routable)
        : documents.find(item => item.tabId === tabId && item.frameId === options.frameId && item.documentId === options.documentId && item.routable);
      if (!doc) throw Error('Target document has left');
      if (heldResponse && message.kind === 'response' && heldResponse.matches(message)) {
        const gate = heldResponse; heldResponse = null; gate.started.resolve(); await gate.release.promise;
      }
      let reply;
      doc.listener(message, { id: runtime.id }, value => { reply = value; });
      if (heldProbe && message.kind === 'probe') {
        const gate = heldProbe; heldProbe = null; gate.started.resolve(); await gate.release.promise;
      }
      return reply;
    } },
    windows: { onRemoved: { addListener: fn => { chrome.closeWindow = fn; } }, getLastFocused: async () => ({ width: 1280 }),
      // The queue reuses an open window without refocusing it (#10).
      get: async id => { if (!openWindows.has(id)) throw Error('window gone'); return { id }; },
      update: async id => { if (!openWindows.has(id)) throw Error('window gone'); return { id }; },
      create: async () => { const id = ++windowCount; openWindows.add(id); return { id }; },
      remove: async id => { openWindows.delete(id); } }, alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const environment = { chrome, navigator, crypto, setTimeout: setTimer, clearTimeout: clearTimer };
  const restart = () => {
    const load = loader(environment, relaxedLimits);
    // The platform is read once, as the worker's modules load.
    const platform = process.env.SYRIUS_PLATFORM;
    if (firefox) process.env.SYRIUS_PLATFORM = 'firefox'; else delete process.env.SYRIUS_PLATFORM;
    try { load('src/sections/Background/index.js'); }
    finally { if (platform === undefined) delete process.env.SYRIUS_PLATFORM; else process.env.SYRIUS_PLATFORM = platform; }
    worker = { listener: chrome.listener, load };
  };
  restart();
  const extensionSender = { id: runtime.id, url: runtime.getURL('popup.html') };
  chrome.runtime.sendMessage = (message, callback) => worker.listener(message, extensionSender, callback);
  const flush = async () => { for (let i = 0; i < 16; i++) await tick(); };
  const internal = (method, params = {}) => new Promise((resolve, reject) => worker.listener({ channel: 'internal', method, params },
    extensionSender, response => response.error ? reject(Error(response.error)) : resolve(response.result)));
  const queue = () => worker.load('src/sections/Background/requests.js').default;
  const identityOf = request => worker.load('src/services/utils/approvalIdentity.js').identityOf(request);
  // What the old `approvals.current` answered: the request as shown is still
  // pending and its document is still the live one that made it.
  const current = async request => Boolean(await queue().current(request));
  // The popup's path to a result: bind the next request, claim it, resolve it.
  // Requests ahead of the one wanted are claimed on the way past, as a second
  // popup would; they stay pending. False if the wanted one is gone.
  const approve = async (request, result) => {
    for (let i = 0; i < 8; i++) {
      if (!(await queue().get(request.id))) return false;
      const next = await internal('approvals.next', { binding });
      if (!next) return false;
      const claim = await internal('approvals.claim', { identity: identityOf(next), windowId: next.windowId });
      if (next.id !== request.id) continue;
      if (!claim) return false;
      return internal('approvals.resolve', { identity: claim, result });
    }
    return false;
  };
  const page = ({ tabId = 1, frameId = 0, origin = 'https://site.invalid', documentId = uuid().replaceAll('-', '').toUpperCase(), missingIdentity = false } = {}) => {
    const handlers = new Map(), posted = [], observers = [];
    const document = { documentElement: { nodeType: 1 } };
    class MutationObserver {
      constructor(callback) { this.callback = callback; this.records = []; observers.push(this); }
      observe() {}
      takeRecords() { const records = this.records; this.records = []; return records; }
    }
    const window = { location: { origin }, postMessage: message => {
      posted.push(structuredClone(message)); queueMicrotask(() => emit('message', { source: window, data: structuredClone(message) }));
    }, addEventListener: (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); if (!handlers.get(name).includes(fn)) handlers.get(name).push(fn); }, dispatchEvent: event => emit(event.type, event) };
    const emit = (name, event = {}) => (handlers.get(name) || []).forEach(fn => fn({ type: name, ...event }));
    const sender = { id: runtime.id, tab: { id: tabId, title: 'Synthetic page' }, frameId, url: origin + '/fixture', origin, ...(missingIdentity || firefox ? {} : { documentId }) };
    const doc = { tabId, frameId, documentId, routable: true, posted, emit, window, sender };
    const docChrome = { runtime: { ...runtime, onMessage: { addListener: fn => { doc.listener = fn; } }, sendMessage: (message, callback) => {
      incoming.push({ message: structuredClone(message), sender: structuredClone(sender) });
      if (doc.dropBye && message.kind === 'bye') { callback({ accepted: true }); return; }
      if (doc.transportFailure) { docChrome.runtime.lastError = { message: 'Synthetic disconnected transport' }; callback(); delete docChrome.runtime.lastError; return; }
      worker.listener(structuredClone(message), sender, callback);
    } } };
    const env = { window, document, MutationObserver, chrome: docChrome, crypto: { getRandomValues: array => crypto.getRandomValues(array), randomUUID: () => crypto.randomUUID() }, setTimeout: setTimer, clearTimeout: clearTimer, Event };
    documents.push(doc);
    const loadPage = loader(env);
    for (const file of ['src/sections/Inpage/index.js', 'src/sections/Content/index.js']) loadPage(file);
    doc.rewrite = (reinsert = false) => {
      const old = document.documentElement; handlers.clear();
      if (!reinsert) document.documentElement = { nodeType: 1 };
      for (const observer of observers) observer.records.push({ target: document, removedNodes: [old] });
      queueMicrotask(() => { for (const observer of observers) { const records = observer.takeRecords(); if (records.length) observer.callback(records); } });
    };
    doc.hide = () => emit('pagehide', { persisted: true });
    doc.show = () => emit('pageshow', { persisted: true });
    return doc;
  };
  // Consent for the fixture account, as the permission store saves it (#11).
  const connected = origin => {
    const entries = (local['syrius.permissions']?.entries || []).filter(entry => entry.origin !== origin);
    local['syrius.permissions'] = { version: 2, entries: [...entries, { active: true, origin, scope, title: '', favicon: '', connectedAt: 1, lastUsedAt: 1 }] };
  };
  const permissions = () => worker.load('src/sections/Background/permissions.js').default;
  const isConnected = origin => permissions().isConnected(origin, scope);
  const permissionRow = origin => (local['syrius.permissions']?.entries || []).find(entry => entry.origin === origin);
  const gate = () => ({ started: deferred(), release: deferred() });
  return { session, local, documents, deliveries, incoming, timers, chrome, page, internal, restart, flush, connected, current, approve,
    queue, identityOf, permissions, isConnected, permissionRow, environment,
    next: () => internal('approvals.next', { binding }),
    load: file => worker.load(file), get windowCount() { return windowCount; },
    holdWrite: () => heldWrite = gate(), holdProbe: () => heldProbe = gate(),
    holdResponse: matches => heldResponse = { ...gate(), matches },
    holdPermissionWrite: matches => heldPermissionWrite = { ...gate(), matches },
    failPermissionWrites: value => { failPermissionWrites = value; },
    timeout: ms => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } },
  };
};

// The real approval screen and signing hooks on the real SDK, with every node
// call, key and publication held or answered here (as in request-identity).
const approvalUI = (f, windowId) => {
  const states = [], refs = [], callbacks = [], effects = [];
  let si, ri, ci, ei, tree, closed = 0;
  const counters = { signs: 0, signedBytes: [], published: 0, notices: [] };
  const gates = {};
  const pause = async phase => { const gate = gates[phase]; if (gate) { delete gates[phase]; gate.started.resolve(); await gate.release.promise; } };
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = { ...React,
    useState: initial => { const i = si++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef: initial => { const i = ri++; return refs[i] ||= { current: initial }; },
    useCallback: (fn, deps) => { const i = ci++; if (!sameDeps(callbacks[i]?.deps, deps)) callbacks[i] = { fn, deps }; return callbacks[i].fn; },
    useEffect: (fn, deps) => { const i = ei++; if (!sameDeps(effects[i]?.deps, deps)) effects[i] = { fn, deps, cleanup: effects[i]?.cleanup, pending: true }; },
  };
  const key = { getAddress: async () => address, getPublicKey: async () => Buffer.alloc(32, 7),
    sign: async bytes => {
      counters.signs++;
      counters.signedBytes.push(Buffer.from(bytes));
      await pause('sign');
      return Buffer.alloc(64, 9);
    } };
  const vault = { getKeyPair: () => key, getSigningKeyPair: async () => { await pause('key'); return key; },
    getBinding: () => binding, whileBound: async (_, operation) => operation(),
    isUnlocked: () => true, getWalletName: () => 'fixture' };
  const zenon = sdk.Zenon.getSingleton();
  zenon.ledger.getFrontierBlock = async () => { await pause('rpc'); return null; };
  zenon.ledger.getFrontierMomentum = async () => ({ hash: emptyHash, height: 1 });
  zenon.embedded.plasma.getRequiredPoWForAccountBlock = async () => { await pause('pow'); return { requiredDifficulty: 0, basePlasma: 0, availablePlasma: 0 }; };
  zenon.ledger.publishRawTransaction = async () => { await pause('publish'); counters.published++; };
  const state = { wallet: { address: account, isUnlocked: true }, connectionParameters: { chainIdentifier: 1, nodeUrl: 'wss://node.invalid' } };
  const uiChrome = { ...f.chrome, windows: { ...f.chrome.windows, getCurrent: async () => ({ id: windowId }) } };
  const navigate = () => {};
  const load = loader({ ...f.environment, chrome: uiChrome, window: { close: () => closed++ } }, id => {
    if (id === 'react') return hooks;
    if (id === 'react-router-dom') return { useNavigate: () => navigate };
    if (id === 'react-redux') return { useSelector: selector => selector(state) };
    if (id.endsWith('/wallet/vault') || id === './vault') return { __esModule: true, default: vault };
    if (id.endsWith('/hooks/useAccount') || id === './useAccount') return { __esModule: true, default: () => ({ balanceMap: { [token.toString()]: { balance: BigNumber.from('1000000000'), token: { decimals: 8, symbol: 'ZNN' } } } }), invalidateAccountCache() {}, markAccountStale() {} };
    if (id.endsWith('/utils/notify')) return { notify: { success: value => counters.notices.push({ success: value }), error: value => counters.notices.push({ error: String(value) }) } };
  });
  const Component = load('src/layouts/siteIntegrationLayout/siteIntegrationLayout.js').default;
  const render = () => {
    si = ri = ci = ei = 0; tree = Component();
    for (const effect of effects) if (effect.pending) { effect.pending = false; effect.cleanup?.(); effect.cleanup = effect.fn(); }
    return tree;
  };
  const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? [value, ...flatten(value.props?.children)] : [];
  const drain = async () => { for (let i = 0; i < 6; i++) { await f.flush(); render(); f.timeout(1200); } };
  render();
  return { counters, drain, render,
    messagePreview: () => flatten(tree).find(element => element.type === 'pre' &&
      element.props['aria-label'] === 'Message to sign'),
    // The screen's approving button: the one that is not Reject.
    approve: () => { const buttons = flatten(tree).filter(element => element.type === 'button'); assert.equal(buttons.length, 2); return buttons[1].props.onClick; },
    hold: phase => gates[phase] = { started: deferred(), release: deferred() },
    dispose: () => effects.forEach(effect => effect.cleanup?.()), get closed() { return closed; },
  };
};

const watchdog = setTimeout(() => { console.error('Document regression fixture timed out'); process.exit(1); }, 60000);
(async () => {
  // Every immediate reply is native-document-targeted, including frame zero.
  {
    const f = fixture(), a = f.page();
    assert.deepEqual(await a.window.zenon.getAccounts(), []);
    const bad = f.page({ tabId: 2, missingIdentity: true });
    await assert.rejects(bad.window.zenon.connect(), error => error.code === 4900);
    a.transportFailure = true;
    await assert.rejects(a.window.zenon.connect(), error => error.code === 4900);
    assert(f.deliveries.every(item => item.options.frameId === 0 && item.options.documentId === a.documentId));
  }
  // Consent and long approval survive focus/history changes and worker restart.
  {
    const f = fixture(), a = f.page();
    const promise = a.window.zenon.connect(); await f.flush();
    const request = await f.next(); assert(request);
    a.emit('blur'); a.emit('visibilitychange'); a.emit('popstate'); f.timeout(30000);
    f.restart();
    assert.equal(await f.current(request), true);
    assert.equal(await f.approve(request), true);
    assert.deepEqual(await promise, [account]);
    assert(await f.isConnected('https://site.invalid'));
  }
  // Departed top frames and subframes cannot return inert results to a new
  // document, on the same or a different origin. No raw signing is involved.
  for (const frameId of [0, 3]) for (const replacementOrigin of ['https://site.invalid', 'https://other.invalid']) {
    const f = fixture(), a = f.page({ frameId }); f.connected('https://site.invalid');
    const promise = a.window.zenon.signMessage('inert lifecycle fixture'); const denied = assert.rejects(promise, error => error.code === 4900);
    await f.flush(); const old = await f.next(); assert(old);
    a.hide(); a.routable = false; await denied;
    const b = f.page({ frameId, origin: replacementOrigin }); await f.flush();
    assert.equal(await f.approve(old, signed('inert-old-result')), false);
    assert.equal(b.posted.some(message => message.result?.signature === 'inert-old-result'), false);
    assert.equal((await f.load('src/services/utils/documentBinding.js').deliver(old, { channel: 'znn', kind: 'response', id: old.responseId, result: 'inert-old-result' }))?.accepted === true, false);
    assert.deepEqual(await f.internal('approvals.list'), []);
  }
  // BFCache keeps native identity but starts a fresh private activation. A
  // delayed old bye and response cannot cancel or settle a new request.
  {
    const f = fixture(), a = f.page(); f.connected('https://site.invalid');
    const first = a.window.zenon.signMessage('before history navigation'); const denied = assert.rejects(first);
    await f.flush(); const old = await f.next(); a.hide(); await denied;
    const bye = f.incoming.filter(item => item.message.kind === 'bye').at(-1); await f.flush(); a.show();
    const second = a.window.zenon.signMessage('after history navigation'); await f.flush(); const fresh = await f.next();
    assert.equal(fresh.documentId, old.documentId); assert.notEqual(fresh.activation, old.activation); assert.notEqual(fresh.requestToken, old.requestToken);
    f.chrome.listener(bye.message, bye.sender, () => {}); await f.flush();
    assert.equal(await f.current(fresh), true);
    // The same document is still routable after BFCache; its relay refuses the old token.
    assert.equal((await f.load('src/services/utils/documentBinding.js').deliver(old, { channel: 'znn', kind: 'response', result: 'inert-stale' }))?.accepted, false);
    assert.equal(await f.approve(fresh, signed('inert-fresh')), true); assert.equal((await second).signature, 'inert-fresh');
    assert.equal(a.posted.some(message => message.result === 'inert-stale'), false);
  }
  // Dropped eager cleanup still fails the use-time liveness check. A delayed
  // old hello cannot replace a fresh activation in the frame registry.
  {
    const f = fixture(), a = f.page();
    const response = a.window.zenon.connect(); const denied = assert.rejects(response);
    await f.flush(); const old = await f.next();
    const hello = f.incoming.find(item => item.message.kind === 'hello');
    a.dropBye = true; a.hide(); await denied;
    assert(Object.values(f.session[pendingKey]).some(r => r.requestToken === old.requestToken));
    assert.equal(await f.current(old), false);
    a.show(); await f.flush(); const freshFrames = structuredClone(f.session['znn.frames']);
    f.chrome.listener(hello.message, hello.sender, () => {}); await f.flush();
    assert.deepEqual(f.session['znn.frames'], freshFrames);
  }
  // Failed persistence is surfaced, with no executable false-success record.
  {
    const f = fixture(), a = f.page(); await f.flush();
    const original = f.chrome.storage.session.set;
    f.chrome.storage.session.set = async values => { if (pendingKey in values) throw Error('Synthetic quota failure'); return original(values); };
    await assert.rejects(a.window.zenon.connect(), error => error.code === -32603);
    assert.equal(f.windowCount, 0); assert.deepEqual(f.session[pendingKey] || {}, {});
  }
  // Browser navigation invalidates approvals even without any DOM notification,
  // and that cancellation survives worker restart. Sibling frames stay usable.
  // The sibling is another origin's frame: one origin has one pending connect.
  for (const frameId of [0, 3]) {
    const f = fixture(), a = f.page({ frameId }), other = f.page({ frameId: 4, origin: 'https://other.invalid' });
    await other.window.zenon.getAccounts();
    a.window.zenon.connect().catch(() => {}); other.window.zenon.connect().catch(() => {}); await f.flush();
    const pending = await f.internal('approvals.list');
    const old = pending.find(r => r.frameId === frameId), sibling = pending.find(r => r.frameId === 4);
    assert(old); assert(sibling);
    f.chrome.beforeNavigate({ tabId: 1, frameId }); await f.flush(); f.restart();
    assert.equal(await f.current(old), false);
    assert.equal(await f.approve(old), false);
    assert.deepEqual(await f.internal('permissions.list'), []);
    assert.equal(await f.current(sibling), frameId !== 0);
    const promise = a.window.zenon.connect(); await f.flush();
    const fresh = (await f.internal('approvals.list')).find(r => r.frameId === frameId);
    assert.notDeepEqual([fresh.navigationTab, fresh.navigationFrame], [old.navigationTab, old.navigationFrame]);
    assert.equal(await f.approve(fresh), true);
    assert.deepEqual(await promise, [account]);
  }
  // A failed generation write still cancels the affected queue. A restarted
  // worker must not recover the pre-navigation approval from older storage.
  {
    const f = fixture(), a = f.page(); a.window.zenon.connect().catch(() => {}); await f.flush();
    const old = await f.next(), set = f.chrome.storage.session.set;
    f.chrome.storage.session.set = async values => { if ('znn.navigation' in values) throw Error('Synthetic navigation write failure'); return set(values); };
    f.chrome.beforeNavigate({ tabId: 1, frameId: 0 }); await f.flush();
    assert.equal(await f.current(old), false);
    f.restart(); assert.equal(await f.current(old), false);
  }
  // A native navigation also fences an in-flight provisional connection write.
  {
    const f = fixture(), a = f.page(); a.window.zenon.connect().catch(() => {}); await f.flush();
    const old = await f.next(), gate = f.holdPermissionWrite(() => true);
    const result = f.approve(old);
    await gate.started.promise; f.chrome.beforeNavigate({ tabId: 1, frameId: 0 }); await f.flush();
    gate.release.resolve(); assert.equal(await result, false); assert.deepEqual(await f.internal('permissions.list'), []);
  }
  // In-place document rewrites erase DOM listeners, but the private observer
  // cancels old tokens and restores provider/relay handlers for fresh requests.
  for (const reinsert of [false, true]) {
    const f = fixture(), a = f.page();
    const first = a.window.zenon.connect(); const denied = assert.rejects(first, error => error.code === 4900);
    await f.flush(); const old = await f.next();
    a.rewrite(reinsert); await denied; await f.flush();
    assert.equal(await f.current(old), false);
    const second = a.window.zenon.connect(); await f.flush(); const fresh = await f.next();
    assert.equal(fresh.documentId, old.documentId); assert.notEqual(fresh.activation, old.activation);
    assert.equal(await f.approve(fresh), true);
    assert.deepEqual(await second, [account]);
    a.hide(); a.show(); await f.flush(); assert.deepEqual(await a.window.zenon.getAccounts(), [account]);
  }
  // A departure while persistence is pending cannot resurrect a queued entry.
  {
    const f = fixture(), a = f.page(); f.connected('https://site.invalid'); await f.flush();
    const gate = f.holdWrite(); const pending = a.window.zenon.signMessage('canceled during persistence'); const denied = assert.rejects(pending);
    await gate.started.promise; a.hide(); gate.release.resolve(); await denied; await f.flush();
    assert.deepEqual(await f.internal('approvals.list'), []); assert.equal(f.windowCount, 0);
  }
  // Connection permission is provisional until the exact relay accepts it.
  // Cancel before persistence or delivery for a top frame, subframe, and the
  // same native document restored from BFCache: no new origin consent appears.
  for (const phase of ['persistence', 'delivery']) for (const mode of ['top', 'subframe', 'bfcache']) {
    const f = fixture(), a = f.page({ frameId: mode === 'subframe' ? 3 : 0 });
    const promise = a.window.zenon.connect(); const denied = assert.rejects(promise, error => error.code === 4900);
    await f.flush(); const request = await f.next();
    const gate = phase === 'persistence' ? f.holdPermissionWrite(() => true) : f.holdResponse(() => true);
    const resolving = f.approve(request);
    await gate.started.promise; a.hide(); await denied; await f.flush();
    let replacement;
    if (mode === 'bfcache') { a.show(); replacement = a; }
    else { a.routable = false; replacement = f.page({ frameId: request.frameId }); }
    gate.release.resolve(); assert.equal(await resolving, false);
    assert.equal(await f.isConnected('https://site.invalid'), false);
    assert.deepEqual(await replacement.window.zenon.getAccounts(), []);
    const freshPromise = replacement.window.zenon.connect(); await f.flush();
    const fresh = await f.next(); assert(fresh); assert.notEqual(fresh.requestToken, request.requestToken);
    assert.equal(await f.approve(fresh), true);
    assert.deepEqual(await freshPromise, [account]);
  }
  // If cleanup cannot persist, a stranded provisional is still inactive after
  // worker restart. Reconnection cancellation preserves any prior consent.
  for (const hadPrevious of [false, true]) {
    const f = fixture(), a = f.page();
    const promise = a.window.zenon.connect(); const denied = assert.rejects(promise); await f.flush();
    // A connected site's connect is answered at once, so the prior grant is
    // one saved while this prompt was open; the tentative row carries it.
    if (hadPrevious) f.connected('https://site.invalid');
    const request = await f.next(); const gate = f.holdResponse(() => true);
    const resolving = f.approve(request);
    await gate.started.promise; a.hide(); await denied; f.failPermissionWrites(true); gate.release.resolve();
    assert.equal(await resolving, false); assert(f.permissionRow('https://site.invalid').pendingApproval);
    f.failPermissionWrites(false); f.restart();
    assert.equal(await f.isConnected('https://site.invalid'), hadPrevious);
  }
  // Accepted delivery commits the connection before later navigation. Readers
  // wait for final persistence, and a concurrent revoke cannot be overwritten.
  {
    const f = fixture(), a = f.page(); f.connected('https://other.invalid');
    const promise = a.window.zenon.connect(); await f.flush(); const request = await f.next();
    const gate = f.holdPermissionWrite(entries => entries.some(entry => entry.origin === 'https://site.invalid' && entry.active === true));
    const resolving = f.approve(request);
    await gate.started.promise; assert.deepEqual(await promise, [account]); a.hide(); a.routable = false;
    const permissions = f.permissions();
    let readFinished = false; const reading = permissions.isConnected('https://site.invalid', scope).then(value => { readFinished = true; return value; });
    const revoking = permissions.revoke('https://other.invalid'); await f.flush(); assert.equal(readFinished, false);
    gate.release.resolve(); assert.equal(await resolving, true); assert.equal(await reading, true); await revoking;
    assert.equal(await permissions.isConnected('https://other.invalid', scope), false);
    const b = f.page(); assert.deepEqual(await b.window.zenon.connect(), [account]);
  }
  // An unacknowledged response cannot hold permission readers indefinitely or
  // activate a grant. A later page departure also prevents a delayed delivery.
  {
    const f = fixture(), a = f.page(); const promise = a.window.zenon.connect(); const denied = assert.rejects(promise);
    await f.flush(); const request = await f.next(); const gate = f.holdResponse(() => true);
    const resolving = f.approve(request);
    await gate.started.promise; f.timeout(5000); await f.flush(); assert.equal(await resolving, false);
    assert.equal(await f.isConnected('https://site.invalid'), false);
    a.hide(); await denied; gate.release.resolve(); await f.flush();
    assert.equal(a.posted.some(m => m.kind === 'response' && m.result), false);
  }
  // A failed promotion cannot leave fresh active consent across worker restart.
  // The worker reports the failure to the page, and the approval as failed.
  {
    const f = fixture(), a = f.page(); const promise = a.window.zenon.connect(); await f.flush(); const request = await f.next();
    const gate = f.holdPermissionWrite(entries => entries.some(entry => entry.origin === 'https://site.invalid' && entry.active === true));
    const resolving = f.approve(request);
    await gate.started.promise; assert.deepEqual(await promise, [account]); f.failPermissionWrites(true); gate.release.resolve();
    assert.equal(await resolving, false);
    f.failPermissionWrites(false); f.restart(); assert.equal(await f.isConnected('https://site.invalid'), false);
  }
  // Fresh per-operation wrappers preserve receiver binding and reject before
  // crypto or discard a late result; they never mutate the cached raw key.
  {
    const f = fixture(); const wrap = f.load('src/services/wallet/requestSigningKey.js').default;
    let live = true, calls = 0; const gate = deferred();
    const key = { address: 'synthetic', getAddress() { return this.address; }, getPublicKey: () => new Uint8Array([1]), sign: async () => { calls++; await gate.promise; return new Uint8Array([2]); } };
    const check = async () => { if (!live) throw Error('inactive'); };
    const guarded = wrap(key, check); assert.equal(await guarded.getAddress(), 'synthetic'); assert.equal(wrap(key), key);
    live = false; await assert.rejects(guarded.sign(new Uint8Array([1]))); assert.equal(calls, 0);
    live = true; const result = guarded.sign(new Uint8Array([1])); await tick(); live = false; gate.resolve(); await assert.rejects(result); assert.equal(calls, 1);
    assert.equal(key.address, 'synthetic'); assert.notEqual(guarded, key);
  }
  // Legacy success decoration remains compatible, but cannot cross an
  // activation change while its internal chain/node reads are pending.
  {
    const f = fixture(), a = f.page();
    a.window.postMessage({ method: 'znn.requestWalletAccess' }); await f.flush();
    const request = await f.next();
    assert.equal(await f.approve(request), true); await f.flush();
    const grant = a.posted.find(message => message.method === 'znn.grantedWalletRead');
    assert.deepEqual(grant.data, { address: account, chainId: 69, nodeUrl: 'wss://node.invalid' });
    const gate = f.holdResponse(message => String(message.id).startsWith('znn-cs-'));
    a.window.postMessage({ method: 'znn.requestWalletAccess' }); await gate.started.promise;
    a.hide(); a.show(); gate.release.resolve(); await f.flush();
    assert.equal(a.posted.filter(message => message.method === 'znn.grantedWalletRead').length, 1);
    a.window.postMessage({ method: 'znn.requestWalletAccess' }); await f.flush();
    assert.equal(a.posted.filter(message => message.method === 'znn.grantedWalletRead').length, 2);
  }
  // Independent legacy calls from two tabs retain separate queue records. The
  // second tab is another origin, since one origin has one pending connect (#10).
  {
    const f = fixture(), a = f.page(), b = f.page({ tabId: 2, origin: 'https://other.invalid' });
    for (const page of [a, b]) page.window.postMessage({ method: 'znn.requestWalletAccess' });
    await f.flush(); const pending = await f.internal('approvals.list');
    assert.equal(pending.length, 2); assert.notEqual(pending[0].id, pending[1].id);
    for (const request of pending) assert.equal(await f.approve(request), true);
    await f.flush();
    for (const page of [a, b]) assert.equal(page.posted.filter(m => m.method === 'znn.grantedWalletRead').length, 1);
  }
  // A positive probe that returns late cannot validate a replaced record.
  {
    const f = fixture(), a = f.page(); f.connected('https://site.invalid');
    const raw = { target: 'znn-contentscript', kind: 'request', id: 'ordinary-retry', method: 'znn_sign', params: { message: 'inert' } };
    a.window.postMessage(raw); await f.flush(); const old = await f.next();
    const gate = f.holdProbe(); const checking = f.current(old);
    await gate.started.promise; a.hide(); await f.flush(); a.show(); a.window.postMessage(raw); await f.flush();
    const [fresh] = await f.internal('approvals.list'); assert.notEqual(fresh.activation, old.activation);
    gate.release.resolve(); assert.equal(await checking, false);
    assert.equal(await f.current(fresh), true);
    f.chrome.closeTab(1); await f.flush(); assert.deepEqual(await f.internal('approvals.list'), []);
  }
  // Reusing public correlation after BFCache cannot revive an old token;
  // page-supplied binding fields never become the isolated relay's identity.
  {
    const f = fixture(), a = f.page(); f.connected('https://site.invalid');
    const raw = { target: 'znn-contentscript', kind: 'request', id: 'reused-correlation', method: 'znn_sign', params: { message: 'inert' }, activation: uuid(), requestToken: uuid() };
    a.window.postMessage(raw); await f.flush(); const old = await f.next();
    assert.notEqual(old.activation, raw.activation); assert.notEqual(old.requestToken, raw.requestToken);
    a.hide(); await f.flush(); a.show(); a.window.postMessage(raw); await f.flush(); const fresh = await f.next();
    assert.equal(old.responseId, fresh.responseId); assert.notEqual(old.activation, fresh.activation);
    assert.equal(await f.approve(old, signed('old')), false);
    assert.equal(await f.current(fresh), true);
    assert.equal(await f.approve(fresh, signed('fresh')), true); await f.flush();
    assert.equal(a.posted.filter(m => m.kind === 'response').length, 1); assert.equal(a.posted.at(-1).result.signature, 'fresh');
  }
  // The actual approval component runs all four legitimate paths once despite
  // two immediate button invocations. Node, key and publication are synthetic.
  const block = sdk.Primitives.AccountBlockTemplate.send(address, token, BigNumber.from(1)).toJson();
  const message = 'Review "Caf\u00e9"\nOriginal \\u200b separator\t\u200b\u202e';
  const preview = 'Review "Caf\u00e9"\nOriginal \\\\u200b separator\\u0009\\u200b\\u202e';
  const paramsFor = method => method === 'signMessage' ? message
    : method === 'sendAccountBlock' ? block : { to: account, tokenStandard: token.toString(), amount: '1' };
  for (const method of ['connect', 'signMessage', 'sendTransaction', 'sendAccountBlock']) {
    const f = fixture(), a = f.page(); if (method !== 'connect') f.connected('https://site.invalid');
    const result = a.window.zenon[method](paramsFor(method)); await f.flush();
    const [row] = await f.internal('approvals.list'); assert(row, 'queued ' + method);
    const ui = approvalUI(f, row.windowId); await ui.drain(); const approve = ui.approve();
    if (method === 'signMessage') {
      const rendered = ui.messagePreview();
      assert.equal(rendered?.props.children, preview);
      assert.equal(rendered?.props['aria-describedby'], 'message-preview-format');
    }
    const one = approve(), duplicate = approve(); await ui.drain(); await Promise.all([one, duplicate]);
    const value = await result;
    assert.equal(ui.counters.signs, method === 'connect' ? 0 : 1);
    assert.equal(ui.counters.published, ['sendTransaction', 'sendAccountBlock'].includes(method) ? 1 : 0);
    if (method === 'connect') assert.deepEqual(value, [account]);
    else if (method === 'signMessage') {
      assert.equal(value.signature, '09'.repeat(64));
      assert.equal(value.message, message);
      assert.deepEqual(ui.counters.signedBytes, [Buffer.from(message, 'utf8')]);
    }
    else assert.equal(typeof value.hash, 'string');
    ui.dispose();
  }
  // A copied callback and held key/RPC/PoW/crypto work cannot answer a departed
  // document. The crypto-in-progress case discards its result before publish.
  for (const phase of ['copied', 'key', 'rpc', 'pow', 'sign']) {
    const f = fixture(), a = f.page(); f.connected('https://site.invalid');
    const result = a.window.zenon.sendTransaction(paramsFor('sendTransaction'));
    const denied = assert.rejects(result, error => error.code === 4900); await f.flush();
    const [row] = await f.internal('approvals.list');
    const ui = approvalUI(f, row.windowId); await ui.drain(); const approve = ui.approve(); let running, gate;
    if (phase !== 'copied') { gate = ui.hold(phase); running = approve(); await gate.started.promise; }
    a.hide(); await denied; await ui.drain();
    if (gate) gate.release.resolve(); else running = approve();
    await ui.drain(); await running;
    assert.equal(ui.counters.signs, phase === 'sign' ? 1 : 0, phase); assert.equal(ui.counters.published, 0, phase);
    assert.equal(a.posted.some(message => message.kind === 'response' && message.result?.hash), false);
    ui.dispose();
  }
  // Manual Settings signing preserves its output using the real pinned SDK.
  {
    const key = await new sdk.KeyStore().fromEntropy('00112233445566778899aabbccddeeff').getKeyPair(0).generateKeyPair();
    const load = loader({}, id => id === './vault' ? { __esModule: true, default: { getSigningKeyPair: async () => key } } : undefined);
    const sign = load('src/services/wallet/signMessage.js').signMessage;
    const signature = await sign('Benign compatibility fixture');
    assert.equal(signature.address, (await key.getAddress()).toString());
    const cryptoModule = require('node:crypto');
    const publicKey = cryptoModule.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(signature.publicKey, 'hex')]), format: 'der', type: 'spki' });
    assert(cryptoModule.verify(null, Buffer.from(signature.message), publicKey, Buffer.from(signature.signature, 'hex')));
    assert.deepEqual(await sign(signature.message, { assertRequest: async () => {} }), signature);
  }
  // Firefox: no native document IDs. The relay's private per-document token
  // stands in, admitted only while the frame's current relay holds the
  // activation sent with it (nativeNavigation.relayDocuments).
  const hellos = (f, doc) => f.incoming.filter(item => item.message.kind === 'hello' && item.sender.tab.id === doc.tabId && item.sender.frameId === doc.frameId);
  const replay = (f, from, method = 'znn_accounts') => new Promise(resolve => f.chrome.listener({ channel: 'znn', kind: 'request', id: 'replayed',
    method, params: {}, activation: from.message.activation, requestToken: uuid(), document: from.message.document }, from.sender, resolve));
  {
    const f = fixture({ firefox: true }); f.connected('https://site.invalid'); const a = f.page();
    // A request is answered, not refused as from a departed document, and no
    // delivery names a documentId.
    assert.deepEqual(await a.window.zenon.getAccounts(), [account]);
    assert(f.deliveries.length > 0 && f.deliveries.every(item => !Object.hasOwn(item.options, 'documentId')));
    const token = hellos(f, a)[0].message.document;
    // An approval waits on its document across a worker restart, and settles.
    const signing = a.window.zenon.signMessage('firefox fixture'); await f.flush();
    const request = await f.next(); assert.equal(request.documentId, 'relay:' + token);
    f.restart(); assert.equal(await f.current(request), true);
    assert.equal(await f.approve(request, signed('firefox-signed')), true);
    assert.equal((await signing).signature, 'firefox-signed');
    // A page cannot reach the token or the activation.
    assert(a.posted.every(message => !JSON.stringify(message).includes(token)));
  }
  // A request sent before its hello is handled is admitted by the probe, so a
  // page that asks at once is not refused.
  {
    const f = fixture({ firefox: true }); f.connected('https://site.invalid'); const a = f.page();
    f.session['znn.navigation'] = {};
    assert.deepEqual(await a.window.zenon.getAccounts(), [account]);
  }
  // A committed navigation ends the frame's document, with no bye and no
  // onBeforeNavigate: its approvals and registration go, and its token is
  // refused afterwards. A top-frame commit ends every frame in the tab.
  for (const frameId of [0, 3]) {
    const f = fixture({ firefox: true }); f.connected('https://site.invalid'); f.connected('https://other.invalid');
    const a = f.page({ frameId }), sibling = f.page({ frameId: 4, origin: 'https://other.invalid' });
    await a.window.zenon.getAccounts(); await sibling.window.zenon.getAccounts();
    a.window.zenon.signMessage('before commit').catch(() => {}); sibling.window.zenon.signMessage('sibling').catch(() => {}); await f.flush();
    const pending = await f.internal('approvals.list');
    const old = pending.find(r => r.frameId === frameId), other = pending.find(r => r.frameId === 4);
    assert(old); assert(other);
    const oldHello = hellos(f, a)[0];
    a.dropBye = true; a.routable = false; f.chrome.committed({ tabId: 1, frameId }); await f.flush();
    if (frameId === 0) sibling.routable = false;
    assert.equal((await f.internal('approvals.list')).some(r => r.id === old.id), false);
    assert.equal(await f.current(old), false); assert.equal(await f.approve(old, signed('inert-old')), false);
    assert.equal(await f.current(other), frameId !== 0);
    assert.equal(Object.values(f.session['znn.frames'] || {}).some(frame => frame.documentId === old.documentId), false);
    const b = f.page({ frameId }); await f.flush();
    assert.deepEqual(await b.window.zenon.getAccounts(), [account]);
    assert.notEqual(hellos(f, b).at(-1).message.document, oldHello.message.document);
    // The departed document's token is refused, as a request or a late hello,
    // and a late hello does not displace the frame's current document.
    const refused = await replay(f, oldHello); assert.equal(refused.accepted, false); assert.equal(refused.error.code, 4900);
    const admitted = structuredClone(f.session['znn.navigation']);
    await new Promise(resolve => f.chrome.listener(oldHello.message, oldHello.sender, resolve)); await f.flush();
    assert.deepEqual(f.session['znn.navigation'], admitted);
    assert.deepEqual(await b.window.zenon.getAccounts(), [account]);
  }
  // Bye (pagehide) removes the admission; the old activation stays refused, and
  // the document's next activation is admitted again.
  {
    const f = fixture({ firefox: true }); f.connected('https://site.invalid'); const a = f.page();
    const signing = a.window.zenon.signMessage('before history'); const denied = assert.rejects(signing);
    await f.flush(); const old = await f.next(); const before = hellos(f, a)[0];
    a.hide(); await denied; await f.flush();
    assert.equal(f.session['znn.navigation'][1]?.documents?.[0], undefined);
    assert.equal(await f.current(old), false); assert.equal((await replay(f, before)).accepted, false);
    a.show(); await f.flush();
    assert.deepEqual(await a.window.zenon.getAccounts(), [account]);
    assert.equal(hellos(f, a).at(-1).message.document, before.message.document);
  }
  // Another tab cannot use a document's token: the frame it names is the
  // sender's own, whose relay does not hold that activation.
  {
    const f = fixture({ firefox: true }); f.connected('https://site.invalid');
    const a = f.page(), b = f.page({ tabId: 2 }); await a.window.zenon.getAccounts(); await b.window.zenon.getAccounts();
    const forged = { ...hellos(f, a)[0], sender: hellos(f, b)[0].sender };
    assert.equal((await replay(f, forged)).accepted, false);
    assert.equal(f.session['znn.navigation'][2].documents[0], 'relay:' + hellos(f, b)[0].message.document);
  }
  // A navigation that never commits (a 204, a download) leaves the document
  // admitted; closing the tab forgets it.
  {
    const f = fixture({ firefox: true }); f.connected('https://site.invalid'); const a = f.page();
    await a.window.zenon.getAccounts(); f.chrome.beforeNavigate({ tabId: 1, frameId: 0 }); await f.flush();
    assert.deepEqual(await a.window.zenon.getAccounts(), [account]);
    f.chrome.closeTab(1); await f.flush(); assert.equal(f.session['znn.navigation'][1], undefined);
  }
  console.log('document binding: actual worker/relay/provider routing, lifecycle cancellation, BFCache activation, restart, conditional queue mutation, actual approval callbacks, delayed SDK stages, real-SDK manual signing and Firefox relay document identity checks passed');
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
