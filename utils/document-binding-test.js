'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const babel = require('@babel/core');
const React = require('react');
const { BigNumber } = require('ethers');
const root = path.join(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const uuid = () => crypto.randomUUID();
const pendingKey = 'znn.pendingRequests';
const compile = file => babel.transformFileSync(path.join(root, file), { presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'], configFile: false, babelrc: false }).code;
const compiled = new Map();
const loader = (environment, override = () => undefined) => {
  const cache = new Map();
  const load = name => {
    const filename = path.resolve(root, name);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    if (!compiled.has(filename)) compiled.set(filename, compile(path.relative(root, filename)));
    const requireModule = id => {
      const replacement = override(id); if (replacement !== undefined) return replacement;
      if (!id.startsWith('.')) return require(id);
      const target = path.resolve(path.dirname(filename), id);
      return load(target.endsWith('.js') ? target : target + '.js');
    };
    new Function('module', 'exports', 'require', ...Object.keys(environment), compiled.get(filename))(module, module.exports, requireModule, ...Object.values(environment));
    return module.exports;
  };
  return load;
};
const fixture = () => {
  const session = {}, local = {}, documents = [], deliveries = [], incoming = [], storageListeners = [];
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
          if (heldPermissionWrite && heldPermissionWrite.matches(values['syrius.permissions'])) {
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
  const chrome = { storage, webNavigation: {
    onBeforeNavigate: { addListener: fn => { chrome.beforeNavigate = fn; } },
    getFrame: async ({ tabId, frameId }) => { const doc = documents.findLast(d => d.tabId === tabId && d.frameId === frameId && d.routable);
      return doc && { documentId: doc.documentId, documentLifecycle: 'active' }; },
  }, runtime: { ...runtime, onMessage: { addListener: fn => { chrome.listener = fn; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    tabs: { onRemoved: { addListener: fn => { chrome.closeTab = fn; } }, sendMessage: async (tabId, message, options) => {
      deliveries.push({ tabId, message: structuredClone(message), options: structuredClone(options) });
      assert(Number.isInteger(options.frameId)); assert.equal(typeof options.documentId, 'string');
      const doc = documents.find(item => item.tabId === tabId && item.frameId === options.frameId && item.documentId === options.documentId && item.routable);
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
    windows: { onRemoved: { addListener: fn => { chrome.closeWindow = fn; } }, update: async id => ({ id }), getLastFocused: async () => ({ width: 1280 }),
      create: async () => ({ id: ++windowCount }), remove: async () => {} }, alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const restart = () => {
    const load = loader({ chrome, navigator, crypto, setTimeout: setTimer, clearTimeout: clearTimer });
    load('src/sections/Background/index.js');
    worker = { listener: chrome.listener, load };
  };
  restart();
  chrome.runtime.sendMessage = (message, callback) => worker.listener(message,
    { id: runtime.id, url: runtime.getURL('popup.html') }, callback);
  const flush = async () => { for (let i = 0; i < 16; i++) await tick(); };
  const internal = (method, params = {}) => new Promise((resolve, reject) => worker.listener({ channel: 'internal', method, params },
    { id: runtime.id, url: runtime.getURL('popup.html') }, response => response.error ? reject(Error(response.error)) : resolve(response.result)));
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
    const sender = { id: runtime.id, tab: { id: tabId, title: 'Synthetic page' }, frameId, url: origin + '/fixture', origin, ...(missingIdentity ? {} : { documentId }) };
    const doc = { tabId, frameId, documentId, routable: true, posted, emit, window, sender };
    const docChrome = { runtime: { ...runtime, onMessage: { addListener: fn => { doc.listener = fn; } }, sendMessage: (message, callback) => {
      incoming.push({ message: structuredClone(message), sender: structuredClone(sender) });
      if (doc.dropBye && message.kind === 'bye') { callback({ accepted: true }); return; }
      if (doc.transportFailure) { docChrome.runtime.lastError = { message: 'Synthetic disconnected transport' }; callback(); delete docChrome.runtime.lastError; return; }
      worker.listener(structuredClone(message), sender, callback);
    } } };
    const env = { window, document, MutationObserver, chrome: docChrome, crypto: { getRandomValues: array => crypto.getRandomValues(array) }, setTimeout: setTimer, clearTimeout: clearTimer, Event };
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
  const connected = origin => { local['syrius.permissions'] = { ...(local['syrius.permissions'] || {}), [origin]: { origin } }; };
  const gate = () => ({ started: deferred(), release: deferred() });
  return { session, local, documents, deliveries, incoming, timers, chrome, page, internal, restart, flush, connected,
    environment: { chrome, navigator, crypto, setTimeout: setTimer, clearTimeout: clearTimer },
    load: file => worker.load(file), get windowCount() { return windowCount; },
    holdWrite: () => heldWrite = gate(), holdProbe: () => heldProbe = gate(),
    holdResponse: matches => heldResponse = { ...gate(), matches },
    holdPermissionWrite: matches => heldPermissionWrite = { ...gate(), matches },
    failPermissionWrites: value => { failPermissionWrites = value; },
    timeout: ms => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } },
  };
};

// Real approval component and real signing hooks, with controlled SDK I/O.
const approvalUI = f => {
  const states = [], refs = [], callbacks = [], effects = [];
  let si, ri, ci, ei, tree, closed = 0;
  const counters = { signs: 0, published: 0, keys: 0, invalidations: 0, successes: [], errors: [] };
  const gates = {};
  const pause = async phase => { const gate = gates[phase]; if (gate) { delete gates[phase]; gate.started.resolve(); await gate.release.promise; } };
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = { ...React,
    useState: initial => { const i = si++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef: initial => { const i = ri++; return refs[i] ||= { current: initial }; },
    useCallback: (fn, deps) => { const i = ci++; if (!sameDeps(callbacks[i]?.deps, deps)) callbacks[i] = { fn, deps }; return callbacks[i].fn; },
    useEffect: (fn, deps) => { const i = ei++; if (!sameDeps(effects[i]?.deps, deps)) effects[i] = { fn, deps, cleanup: effects[i]?.cleanup, pending: true }; },
  };
  const address = { toString: () => 'synthetic-account' };
  const rawKey = { getAddress: async () => address, getPublicKey: async () => new Uint8Array([1, 2]),
    sign: async () => { counters.signs++; await pause('sign'); return new Uint8Array([3, 4]); } };
  const vault = { getKeyPair: () => rawKey, getSigningKeyPair: async () => { counters.keys++; await pause('key'); return rawKey; } };
  const zenon = { send: async (template, key, onPow) => {
    await pause('rpc'); await key.getAddress(); await key.getPublicKey(); onPow(0);
    await pause('pow'); onPow(1); await key.sign(new Uint8Array([9]));
    counters.published++; await pause('publish');
    return { hash: { toString: () => 'inert-hash' }, toJson: () => ({ fixture: 'inert-block' }) };
  } };
  const template = value => ({ ...value, toJson: () => value });
  const sdk = { Enums: { PowStatus: { generating: 0, done: 1 } }, Zenon: { getSingleton: () => zenon },
    Primitives: { Address: { parse: x => x }, TokenStandard: { parse: x => x }, AccountBlockTemplate: { fromJson: template, send: (to, tokenStandard, amount) => template({ to, tokenStandard, amount }) } },
    utils: { BlockUtils: { _checkAndSetFields: async (client, block) => block } } };
  const useAccount = () => ({ balanceMap: {} });
  const load = loader({ ...f.environment, window: { close: () => closed++ } }, id => {
    if (id === 'react') return hooks;
    if (id === 'react-router-dom') return { useNavigate: () => () => {} };
    if (id === 'react-redux') return { useSelector: selector => selector({ wallet: { address: 'synthetic-account', isUnlocked: true }, connectionParameters: { chainIdentifier: 69, nodeUrl: 'wss://node.invalid' } }) };
    if (id === 'znn-ts-sdk') return sdk;
    if (id.endsWith('/wallet/vault') || id === './vault') return { __esModule: true, default: vault };
    if (id.endsWith('/hooks/useAccount') || id === './useAccount') return { __esModule: true, default: useAccount, invalidateAccountCache: () => counters.invalidations++ };
    if (id.endsWith('/utils/notify')) return { notify: { success: value => counters.successes.push(value), error: value => counters.errors.push(value) } };
    if (id.endsWith('/utils/format')) return { formatAmount: String, formatExact: String, truncateAddress: String, toBigNumber: value => BigNumber.from(value || 0) };
    if (id.endsWith('/utils/contracts')) return { embeddedContractName: () => null };
    if (id.endsWith('/utils/contractCalls')) return { decodeCall: () => null, describeCall: () => null, contractDisplayName: String };
    if (id.endsWith('/utils/errors')) return { readableError: value => value?.message || String(value) };
  });
  const Component = load('src/layouts/siteIntegrationLayout/siteIntegrationLayout.js').default;
  const render = () => {
    si = ri = ci = ei = 0; tree = Component();
    for (const effect of effects) if (effect.pending) { effect.pending = false; effect.cleanup?.(); effect.cleanup = effect.fn(); }
    return tree;
  };
  const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? [value, ...flatten(value.props?.children)] : [];
  const drain = async () => { for (let i = 0; i < 4; i++) { await f.flush(); render(); f.timeout(1200); } };
  render();
  return { counters, drain, render,
    approve: () => { const buttons = flatten(tree).filter(element => element.type === 'button'); assert.equal(buttons.length, 2); return buttons[1].props.onClick; },
    hold: phase => gates[phase] = { started: deferred(), release: deferred() },
    dispose: () => effects.forEach(effect => effect.cleanup?.()), get closed() { return closed; },
  };
};

const watchdog = setTimeout(() => { console.error('Document regression fixture timed out'); process.exit(1); }, 30000);
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
    const request = await f.internal('approvals.next'); assert(request);
    a.emit('blur'); a.emit('visibilitychange'); a.emit('popstate'); f.timeout(30000);
    f.restart();
    assert.equal(await f.internal('approvals.current', { binding: request }), true);
    assert.equal(await f.internal('approvals.resolve', { binding: request, result: ['synthetic-account'], grantOrigin: true }), true);
    assert.deepEqual(await promise, ['synthetic-account']);
    assert(f.local['syrius.permissions']['https://site.invalid']);
  }
  // Departed top frames and subframes cannot return inert results to a new
  // document, on the same or a different origin. No raw signing is involved.
  for (const frameId of [0, 3]) for (const replacementOrigin of ['https://site.invalid', 'https://other.invalid']) {
    const f = fixture(), a = f.page({ frameId }); f.connected('https://site.invalid');
    const promise = a.window.zenon.signMessage('inert lifecycle fixture'); const denied = assert.rejects(promise, error => error.code === 4900);
    await f.flush(); const old = await f.internal('approvals.next');
    a.hide(); a.routable = false; await denied;
    const b = f.page({ frameId, origin: replacementOrigin }); await f.flush();
    assert.equal(await f.internal('approvals.resolve', { binding: old, result: 'inert-old-result' }), false);
    assert.equal(b.posted.some(message => message.result === 'inert-old-result'), false);
    assert.equal(await f.load('src/services/utils/documentBinding.js').deliver(old, { channel: 'znn', kind: 'response', id: old.id, result: 'inert-old-result' }), false);
    assert.deepEqual(await f.internal('approvals.list'), []);
  }
  // BFCache keeps native identity but starts a fresh private activation. A
  // delayed old bye and response cannot cancel or settle a new request.
  {
    const f = fixture(), a = f.page(); f.connected('https://site.invalid');
    const first = a.window.zenon.signMessage('before history navigation'); const denied = assert.rejects(first);
    await f.flush(); const old = await f.internal('approvals.next'); a.hide(); await denied;
    const bye = f.incoming.filter(item => item.message.kind === 'bye').at(-1); await f.flush(); a.show();
    const second = a.window.zenon.signMessage('after history navigation'); await f.flush(); const fresh = await f.internal('approvals.next');
    assert.equal(fresh.documentId, old.documentId); assert.notEqual(fresh.activation, old.activation); assert.notEqual(fresh.requestToken, old.requestToken);
    f.chrome.listener(bye.message, bye.sender, () => {}); await f.flush();
    assert.equal(await f.internal('approvals.current', { binding: fresh }), true);
    assert.equal(await f.load('src/services/utils/documentBinding.js').deliver(old, { channel: 'znn', kind: 'response', result: 'inert-stale' }), false);
    await f.internal('approvals.resolve', { binding: fresh, result: 'inert-fresh' }); assert.equal(await second, 'inert-fresh');
    assert.equal(a.posted.some(message => message.result === 'inert-stale'), false);
  }
  // Dropped eager cleanup still fails the use-time liveness check. A delayed
  // old hello cannot replace a fresh activation in the frame registry.
  {
    const f = fixture(), a = f.page();
    const response = a.window.zenon.connect(); const denied = assert.rejects(response);
    await f.flush(); const old = await f.internal('approvals.next');
    const hello = f.incoming.find(item => item.message.kind === 'hello');
    a.dropBye = true; a.hide(); await denied;
    assert(Object.values(f.session[pendingKey]).some(r => r.requestToken === old.requestToken));
    assert.equal(await f.internal('approvals.current', { binding: old }), false);
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
  for (const frameId of [0, 3]) {
    const f = fixture(), a = f.page({ frameId }), other = f.page({ frameId: 4 });
    // Keep public correlation IDs distinct; global ID ownership is a separate branch.
    await other.window.zenon.getAccounts();
    a.window.zenon.connect().catch(() => {}); other.window.zenon.connect().catch(() => {}); await f.flush();
    const pending = await f.internal('approvals.list');
    const old = pending.find(r => r.frameId === frameId), sibling = pending.find(r => r.frameId === 4);
    assert(old); assert(sibling);
    f.chrome.beforeNavigate({ tabId: 1, frameId }); await f.flush(); f.restart();
    assert.equal(await f.internal('approvals.current', { binding: old }), false);
    assert.equal(await f.internal('approvals.resolve', { binding: old, result: ['synthetic-account'], grantOrigin: true }), false);
    assert.deepEqual(await f.internal('permissions.list'), []);
    assert.equal(await f.internal('approvals.current', { binding: sibling }), frameId !== 0);
    const promise = a.window.zenon.connect(); await f.flush();
    const fresh = (await f.internal('approvals.list')).find(r => r.frameId === frameId);
    assert.notDeepEqual([fresh.navigationTab, fresh.navigationFrame], [old.navigationTab, old.navigationFrame]);
    assert.equal(await f.internal('approvals.resolve', { binding: fresh, result: ['synthetic-account'] }), true);
    assert.deepEqual(await promise, ['synthetic-account']);
  }
  // A failed generation write still cancels the affected queue. A restarted
  // worker must not recover the pre-navigation approval from older storage.
  {
    const f = fixture(), a = f.page(); a.window.zenon.connect().catch(() => {}); await f.flush();
    const old = await f.internal('approvals.next'), set = f.chrome.storage.session.set;
    f.chrome.storage.session.set = async values => { if ('znn.navigation' in values) throw Error('Synthetic navigation write failure'); return set(values); };
    f.chrome.beforeNavigate({ tabId: 1, frameId: 0 }); await f.flush();
    assert.equal(await f.internal('approvals.current', { binding: old }), false);
    f.restart(); assert.equal(await f.internal('approvals.current', { binding: old }), false);
  }
  // A native navigation also fences an in-flight provisional connection write.
  {
    const f = fixture(), a = f.page(); a.window.zenon.connect().catch(() => {}); await f.flush();
    const old = await f.internal('approvals.next'), gate = f.holdPermissionWrite(() => true);
    const result = f.internal('approvals.resolve', { binding: old, result: ['synthetic-account'], grantOrigin: true });
    await gate.started.promise; f.chrome.beforeNavigate({ tabId: 1, frameId: 0 }); await f.flush();
    gate.release.resolve(); assert.equal(await result, false); assert.deepEqual(await f.internal('permissions.list'), []);
  }
  // In-place document rewrites erase DOM listeners, but the private observer
  // cancels old tokens and restores provider/relay handlers for fresh requests.
  for (const reinsert of [false, true]) {
    const f = fixture(), a = f.page();
    const first = a.window.zenon.connect(); const denied = assert.rejects(first, error => error.code === 4900);
    await f.flush(); const old = await f.internal('approvals.next');
    a.rewrite(reinsert); await denied; await f.flush();
    assert.equal(await f.internal('approvals.current', { binding: old }), false);
    const second = a.window.zenon.connect(); await f.flush(); const fresh = await f.internal('approvals.next');
    assert.equal(fresh.documentId, old.documentId); assert.notEqual(fresh.activation, old.activation);
    await f.internal('approvals.resolve', { binding: fresh, result: ['synthetic-account'], grantOrigin: true });
    assert.deepEqual(await second, ['synthetic-account']);
    a.hide(); a.show(); await f.flush(); assert.deepEqual(await a.window.zenon.getAccounts(), []);
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
    await f.flush(); const request = await f.internal('approvals.next');
    const gate = phase === 'persistence' ? f.holdPermissionWrite(() => true) : f.holdResponse(() => true);
    const resolving = f.internal('approvals.resolve', { binding: request, result: ['synthetic-account'], grantOrigin: true });
    await gate.started.promise; a.hide(); await denied; await f.flush();
    let replacement;
    if (mode === 'bfcache') { a.show(); replacement = a; }
    else { a.routable = false; replacement = f.page({ frameId: request.frameId }); }
    gate.release.resolve(); assert.equal(await resolving, false);
    assert.equal(await f.load('src/sections/Background/permissions.js').default.isConnected('https://site.invalid'), false);
    f.session['znn.unlock'] = { expiresAt: Date.now() + 60000 };
    f.session['znn.publicState'] = { address: 'synthetic-account' };
    assert.deepEqual(await replacement.window.zenon.getAccounts(), []);
    const freshPromise = replacement.window.zenon.connect(); await f.flush();
    const fresh = await f.internal('approvals.next'); assert(fresh); assert.notEqual(fresh.requestToken, request.requestToken);
    await f.internal('approvals.resolve', { binding: fresh, result: ['synthetic-account'], grantOrigin: true });
    assert.deepEqual(await freshPromise, ['synthetic-account']);
  }
  // If cleanup cannot persist, a stranded provisional is still inactive after
  // worker restart. Reconnection cancellation preserves any prior consent.
  for (const hadPrevious of [false, true]) {
    const f = fixture(), a = f.page(); if (hadPrevious) f.connected('https://site.invalid');
    const promise = a.window.zenon.connect(); const denied = assert.rejects(promise); await f.flush();
    const request = await f.internal('approvals.next'); const gate = f.holdResponse(() => true);
    const resolving = f.internal('approvals.resolve', { binding: request, result: ['synthetic-account'], grantOrigin: true });
    await gate.started.promise; a.hide(); await denied; f.failPermissionWrites(true); gate.release.resolve();
    assert.equal(await resolving, false); assert(f.local['syrius.permissions']['https://site.invalid'].pendingApproval);
    f.restart();
    assert.equal(await f.load('src/sections/Background/permissions.js').default.isConnected('https://site.invalid'), hadPrevious);
  }
  // Accepted delivery commits the connection before later navigation. Readers
  // wait for final persistence, and a concurrent revoke cannot be overwritten.
  {
    const f = fixture(), a = f.page(); f.connected('https://other.invalid');
    f.session['znn.unlock'] = { expiresAt: Date.now() + 60000 };
    f.session['znn.publicState'] = { address: 'synthetic-account' };
    const promise = a.window.zenon.connect(); await f.flush(); const request = await f.internal('approvals.next');
    const gate = f.holdPermissionWrite(all => Boolean(all['https://site.invalid'] && !all['https://site.invalid'].pendingApproval));
    const resolving = f.internal('approvals.resolve', { binding: request, result: ['synthetic-account'], grantOrigin: true });
    await gate.started.promise; assert.deepEqual(await promise, ['synthetic-account']); a.hide(); a.routable = false;
    const permissions = f.load('src/sections/Background/permissions.js').default;
    let readFinished = false; const reading = permissions.isConnected('https://site.invalid').then(value => { readFinished = true; return value; });
    const revoking = permissions.revoke('https://other.invalid'); await f.flush(); assert.equal(readFinished, false);
    gate.release.resolve(); assert.equal(await resolving, true); assert.equal(await reading, true); await revoking;
    assert.equal(await permissions.isConnected('https://other.invalid'), false);
    const b = f.page(); assert.deepEqual(await b.window.zenon.connect(), ['synthetic-account']);
  }
  // An unacknowledged response cannot hold permission readers indefinitely or
  // activate a grant. A later page departure also prevents a delayed delivery.
  {
    const f = fixture(), a = f.page(); const promise = a.window.zenon.connect(); const denied = assert.rejects(promise);
    await f.flush(); const request = await f.internal('approvals.next'); const gate = f.holdResponse(() => true);
    const resolving = f.internal('approvals.resolve', { binding: request, result: ['synthetic-account'], grantOrigin: true });
    await gate.started.promise; f.timeout(5000); await f.flush(); assert.equal(await resolving, false);
    assert.equal(await f.load('src/sections/Background/permissions.js').default.isConnected('https://site.invalid'), false);
    a.hide(); await denied; gate.release.resolve(); await f.flush();
    assert.equal(a.posted.some(m => m.kind === 'response' && m.result), false);
  }
  // A failed promotion cannot leave fresh active consent across worker restart.
  {
    const f = fixture(), a = f.page(); const promise = a.window.zenon.connect(); await f.flush(); const request = await f.internal('approvals.next');
    const gate = f.holdPermissionWrite(all => Boolean(all['https://site.invalid'] && !all['https://site.invalid'].pendingApproval));
    const resolving = f.internal('approvals.resolve', { binding: request, result: ['synthetic-account'], grantOrigin: true });
    const failed = assert.rejects(resolving, /Synthetic permission storage failure/);
    await gate.started.promise; assert.deepEqual(await promise, ['synthetic-account']); f.failPermissionWrites(true); gate.release.resolve(); await failed;
    f.restart(); assert.equal(await f.load('src/sections/Background/permissions.js').default.isConnected('https://site.invalid'), false);
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
    f.session['znn.unlock'] = { expiresAt: Date.now() + 60000 };
    f.session['znn.publicState'] = { address: 'synthetic-account', chainId: 69, nodeUrl: 'wss://node.invalid' };
    a.window.postMessage({ method: 'znn.requestWalletAccess' }); await f.flush();
    const request = await f.internal('approvals.next');
    await f.internal('approvals.resolve', { binding: request, result: ['synthetic-account'], grantOrigin: true }); await f.flush();
    const grant = a.posted.find(message => message.method === 'znn.grantedWalletRead');
    assert.deepEqual(grant.data, { address: 'synthetic-account', chainId: 69, nodeUrl: 'wss://node.invalid' });
    const gate = f.holdResponse(message => String(message.id).startsWith('znn-cs-'));
    a.window.postMessage({ method: 'znn.requestWalletAccess' }); await gate.started.promise;
    a.hide(); a.show(); gate.release.resolve(); await f.flush();
    assert.equal(a.posted.filter(message => message.method === 'znn.grantedWalletRead').length, 1);
    a.window.postMessage({ method: 'znn.requestWalletAccess' }); await f.flush();
    assert.equal(a.posted.filter(message => message.method === 'znn.grantedWalletRead').length, 2);
  }
  // Independent legacy calls from two tabs retain separate queue records.
  {
    const f = fixture(), a = f.page(), b = f.page({ tabId: 2 });
    for (const page of [a, b]) page.window.postMessage({ method: 'znn.requestWalletAccess' });
    await f.flush(); const pending = await f.internal('approvals.list');
    assert.equal(pending.length, 2); assert.notEqual(pending[0].id, pending[1].id);
    for (const request of pending) await f.internal('approvals.resolve', { binding: request, result: ['synthetic-account'] });
    await f.flush();
    for (const page of [a, b]) assert.equal(page.posted.filter(m => m.method === 'znn.grantedWalletRead').length, 1);
  }
  // A positive probe that returns late cannot validate a replaced record.
  {
    const f = fixture(), a = f.page(); f.connected('https://site.invalid');
    const raw = { target: 'znn-contentscript', kind: 'request', id: 'ordinary-retry', method: 'znn_sign', params: { message: 'inert' } };
    a.window.postMessage(raw); await f.flush(); const old = await f.internal('approvals.next');
    const gate = f.holdProbe(); const checking = f.internal('approvals.current', { binding: old });
    await gate.started.promise; a.hide(); await f.flush(); a.show(); a.window.postMessage(raw); await f.flush();
    const fresh = await f.internal('approvals.next'); assert.notEqual(fresh.activation, old.activation);
    gate.release.resolve(); assert.equal(await checking, false);
    assert.equal(await f.internal('approvals.current', { binding: fresh }), true);
    f.chrome.closeTab(1); await f.flush(); assert.deepEqual(await f.internal('approvals.list'), []);
  }
  // Reusing public correlation after BFCache cannot revive an old token;
  // page-supplied binding fields never become the isolated relay's identity.
  {
    const f = fixture(), a = f.page(); f.connected('https://site.invalid');
    const raw = { target: 'znn-contentscript', kind: 'request', id: 'reused-correlation', method: 'znn_sign', params: { message: 'inert' }, activation: uuid(), requestToken: uuid() };
    a.window.postMessage(raw); await f.flush(); const old = await f.internal('approvals.next');
    assert.notEqual(old.activation, raw.activation); assert.notEqual(old.requestToken, raw.requestToken);
    a.hide(); await f.flush(); a.show(); a.window.postMessage(raw); await f.flush(); const fresh = await f.internal('approvals.next');
    assert.equal(old.id, fresh.id); assert.notEqual(old.activation, fresh.activation);
    await f.internal('approvals.resolve', { binding: old, result: 'old' });
    assert.equal(await f.internal('approvals.current', { binding: fresh }), true);
    await f.internal('approvals.resolve', { binding: fresh, result: 'fresh' }); await f.flush();
    assert.equal(a.posted.filter(m => m.kind === 'response').length, 1); assert.equal(a.posted.at(-1).result, 'fresh');
  }
  // The actual approval component runs all four legitimate paths once despite
  // two immediate button invocations. SDK activity is entirely synthetic.
  for (const method of ['connect', 'signMessage', 'sendTransaction', 'sendAccountBlock']) {
    const f = fixture(), a = f.page(); if (method !== 'connect') f.connected('https://site.invalid');
    const params = method === 'signMessage' ? 'synthetic approved message' : { to: 'synthetic-destination', toAddress: 'synthetic-destination', tokenStandard: 'synthetic-token', amount: '0' };
    const result = a.window.zenon[method](params); await f.flush();
    const ui = approvalUI(f); await ui.drain(); const approve = ui.approve();
    const one = approve(), duplicate = approve(); await ui.drain(); await Promise.all([one, duplicate]);
    const value = await result;
    assert.equal(ui.counters.signs, method === 'connect' ? 0 : 1);
    assert.equal(ui.counters.published, ['sendTransaction', 'sendAccountBlock'].includes(method) ? 1 : 0);
    assert.equal(ui.counters.successes.length, method === 'connect' ? 0 : 1);
    if (method === 'connect') assert.deepEqual(value, ['synthetic-account']);
    else if (method === 'signMessage') assert.equal(value.signature, '0304');
    else assert.equal(value.hash, 'inert-hash');
    ui.dispose();
  }
  // A copied callback and held key/RPC/PoW/crypto work cannot answer a departed
  // document. The crypto-in-progress case discards its result before publish.
  for (const phase of ['copied', 'key', 'rpc', 'pow', 'sign']) {
    const f = fixture(), a = f.page(); f.connected('https://site.invalid');
    const result = a.window.zenon.sendTransaction({ to: 'synthetic', tokenStandard: 'synthetic', amount: '0' });
    const denied = assert.rejects(result, error => error.code === 4900); await f.flush();
    const ui = approvalUI(f); await ui.drain(); const approve = ui.approve(); let running, gate;
    if (phase !== 'copied') { gate = ui.hold(phase); running = approve(); await gate.started.promise; }
    a.hide(); await denied; await ui.drain();
    if (gate) gate.release.resolve(); else running = approve();
    await ui.drain(); await running;
    assert.equal(ui.counters.signs, phase === 'sign' ? 1 : 0); assert.equal(ui.counters.published, 0);
    assert.equal(a.posted.some(message => message.kind === 'response' && message.result?.hash), false);
    ui.dispose();
  }
  // Manual Settings signing preserves its output using the real pinned SDK.
  {
    global.window = { crypto: require('node:crypto').webcrypto }; global.self = global.window;
    const sdk = require('znn-ts-sdk');
    const key = await new sdk.KeyStore().fromEntropy('00112233445566778899aabbccddeeff').getKeyPair(0).generateKeyPair();
    const load = loader({}, id => id === './vault' ? { __esModule: true, default: { getSigningKeyPair: async () => key } } : undefined);
    const sign = load('src/services/wallet/signMessage.js').signMessage;
    const signed = await sign('Benign compatibility fixture');
    assert.equal(signed.address, (await key.getAddress()).toString());
    const cryptoModule = require('node:crypto');
    const publicKey = cryptoModule.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(signed.publicKey, 'hex')]), format: 'der', type: 'spki' });
    assert(cryptoModule.verify(null, Buffer.from(signed.message), publicKey, Buffer.from(signed.signature, 'hex')));
    assert.deepEqual(await sign(signed.message, { assertRequest: async () => {} }), signed);
  }
  console.log('document binding: actual worker/relay/provider routing, lifecycle cancellation, BFCache activation, restart, conditional queue mutation, actual approval callbacks, delayed SDK stages and real-SDK manual signing checks passed');
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
