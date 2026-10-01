'use strict';
// Corrected approval boundaries only. Browser storage, messaging, RPC and
// publication are inert; no existing profile, live node or real wallet is used.
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const babel = require('@babel/core');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
global.window = { crypto: crypto.webcrypto }; global.self = global.window;
const sdkStorage = new Map();
global.localStorage = { getItem: key => sdkStorage.get(key) ?? null, setItem: (key, value) => sdkStorage.set(key, String(value)), removeItem: key => sdkStorage.delete(key) };
const sdk = require('znn-ts-sdk');
const { BigNumber } = require('ethers');
const root = path.join(__dirname, '..'), compiled = new Map();
const liveDocument = require('./fixtures/document-binding-stub');
// Every module realm here sees the requesting document as live (see the stub).
const withBinding = (override = () => undefined) => id => (liveDocument.isNavigation(id) ? liveDocument.navigationStub : override(id));
const clone = value => value === undefined ? value : structuredClone(value);
// What chrome.storage gives back: a copy with every object's keys sorted.
// Identities taken before a write must still match the record read back.
const sortedKeys = value => Array.isArray(value) ? value.map(sortedKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])])) : value;
const stored = value => value === undefined ? value : sortedKeys(structuredClone(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
const navigateStub = () => {};
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const loader = (environment, overrides = () => undefined) => {
  const cache = new Map();
  const load = file => {
    const filename = path.resolve(root, file);
    if (filename.endsWith('.json')) return require(filename); // e.g. contract-call schemas
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    if (!compiled.has(filename)) compiled.set(filename, babel.transformFileSync(filename, { presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'], configFile: false, babelrc: false }).code);
    const requireModule = id => {
      const replacement = overrides(id); if (replacement !== undefined) return replacement;
      if (!id.startsWith('.')) return require(id);
      const target = path.resolve(path.dirname(filename), id); return load(path.extname(target) ? target : target + '.js');
    };
    new Function('module', 'exports', 'require', ...Object.keys(environment), compiled.get(filename))(module, module.exports, requireModule, ...Object.values(environment));
    return module.exports;
  };
  return load;
};
const address = sdk.Primitives.Address.parse('z1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsggv2f');
const token = sdk.Primitives.TokenStandard.parse('zts1znnxxxxxxxxxxxxx9z4ulx');
const emptyHash = sdk.Primitives.Hash.parse('00'.repeat(32));
const message = 'Approval identity: defensive signing fixture.';
const block = () => sdk.Primitives.AccountBlockTemplate.send(address, token, BigNumber.from(1)).toJson();
const paramsFor = type => ({ connect: {}, sendTransaction: { to: address.toString(), tokenStandard: token.toString(), amount: '1' }, signAndSendBlock: block(), signMessage: { message } })[type];
// Wallet scoping (#11): consent, admission and approval are bound to one
// wallet account and selection generation. The fixture wallet is always
// unlocked on this one; these scenarios test identity and claims on top of it.
const scope = { walletName: 'fixture', walletId: address.toString(), address: address.toString(), index: 0 };
const selectionId = 'fixture-selection';
const binding = Object.freeze({ id: selectionId, ownerId: 'owner', scope: Object.freeze({ ...scope }) });
const entry = (responseId = 'same', documentId = 'doc-a', type = 'signMessage') => ({ responseId, documentId, origin: 'https://fixture.invalid', tabId: 1, frameId: 0, type, params: paramsFor(type), title: '', favicon: '',
  admitted: { id: selectionId, scope }, waitForUnlock: false, binding: null, ...liveDocument.documentFields() });
// The queue's admission limits (#10) are exercised by approval-queue-test.
// These scenarios test identity and claims, some with many requests from one
// origin at once, so they run with the numeric limits lifted. The one-pending-
// connect-per-origin rule still applies.
const relaxedLimits = load => id => {
  if (!id.endsWith('/utils/approvalLimits')) return undefined;
  const real = load(path.join('src', 'services', 'utils', 'approvalLimits.js'));
  return { ...real, limits: Object.freeze({ ...real.limits, pending: 1000, perOrigin: 1000, globalAttention: 0, originAttention: 0 }) };
};
const fixture = () => {
  const session = {
    'znn.unlock': { version: 2, id: 'lease', revision: 'r', walletName: 'fixture', minutes: 15, mode: 'timed', entropy: 'fixture',
      ownerId: 'owner', selectedAddressIndex: 0, selectionId, scope, resumeFrom: null, lastActiveAt: Date.now(), expiresAt: Date.now() + 3600000 },
    'znn.publicState': { address: address.toString(), scope, selectionId, leaseId: 'lease', chainId: 1, nodeUrl: 'wss://fixture.invalid' },
  }, local = {}, locks = new Map(), listeners = {}, delivered = [], windows = new Map([[10, {}], [11, {}]]);
  const faults = {}, counts = { created: 0, signs: 0, publishes: 0 }, events = [];
  let storageGate, phaseGate, internalGate;
  const hold = phase => (phaseGate = { phase, started: deferred(), release: deferred() });
  const pause = async phase => { if (phaseGate?.phase === phase) { const held = phaseGate; phaseGate = null; held.started.resolve(); await held.release.promise; } };
  const locksApi = { request: async (name, fn) => {
    const before = locks.get(name) || Promise.resolve(); let release; const after = new Promise(resolve => { release = resolve; }); locks.set(name, after);
    await before; try { return await fn(); } finally { release(); if (locks.get(name) === after) locks.delete(name); }
  } };
  const changeListeners = new Set();
  const storage = (area, data) => ({
    get: async key => { if (faults[area + 'Read']) throw Error(area + ' read unavailable'); return Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, stored(data[k])])); },
    set: async values => {
      if (storageGate?.area === area) { const held = storageGate; storageGate = null; held.started.resolve(); await held.release.promise; }
      if (faults[area + 'Write']) throw Error(area + ' write unavailable');
      Object.assign(data, clone(values));
      // Chrome reports every write; the approval screen watches its queue.
      const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: clone(value) }]));
      for (const listener of [...changeListeners]) listener(changes, area);
    },
    remove: async keys => { if (faults[area + 'Write']) throw Error(area + ' write unavailable'); for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  const event = name => ({ addListener: fn => { listeners[name] = fn; } });
  const chrome = {
    runtime: { id: 'fixture', getURL: value => 'chrome-extension://fixture/' + value, onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup') },
    storage: { session: storage('session', session), local: storage('local', local),
      onChanged: { addListener: fn => changeListeners.add(fn), removeListener: fn => changeListeners.delete(fn) } },
    windows: { onRemoved: event('closedWindow'), getCurrent: async () => ({ id: 10 }),
      getLastFocused: async () => ({ top: 0, left: 0, width: 1200 }),
      update: async id => { if (!windows.has(id)) throw Error('window gone'); return { id }; },
      // The queue reuses an open window without refocusing it (#10).
      get: async id => { if (!windows.has(id)) throw Error('window gone'); return { id }; },
      create: async () => { if (faults.windowCreate) throw Error('window creation unavailable'); const id = 100 + ++counts.created; windows.set(id, {}); return { id }; },
      remove: async id => { windows.delete(id); },
    },
    // A response is acknowledged the way the content relay does (#10): a
    // connection grant activates only once the page's relay has accepted it.
    tabs: { onRemoved: event('closedTab'), sendMessage: async (tabId, value, options) => {
      // A liveness probe is not a delivery.
      if (value?.kind !== 'probe') delivered.push({ tabId, value: clone(value), options: clone(options) });
      return liveDocument.relayReply(value);
    } },
    webNavigation: { onBeforeNavigate: event('navigate') },
    alarms: { onAlarm: event('alarm'), create() {} },
  };
  const environment = { chrome, navigator: { locks: locksApi }, crypto: crypto.webcrypto };
  const plain = loader(environment), load = loader(environment, withBinding(relaxedLimits(plain))), queue = load('src/sections/Background/requests.js').default;
  const identity = load('src/services/utils/approvalIdentity.js');
  load('src/sections/Background/index.js');
  const extensionSender = { id: 'fixture', url: 'chrome-extension://fixture/popup.html' };
  const internal = async (method, params = {}) => {
    events.push({ method, params: clone(params) });
    if (internalGate?.method === method) { const held = internalGate; internalGate = null; held.started.resolve(); await held.release.promise; }
    return new Promise((resolve, reject) => {
      const accepted = listeners.message({ channel: 'internal', method, params }, extensionSender, response => response.error ? reject(Error(response.error)) : resolve(response.result));
      if (!accepted) reject(Error('Internal message refused'));
    });
  };
  chrome.runtime.sendMessage = (request, callback) => internal(request.method, request.params).then(result => callback({ result }), error => callback({ error: error.message }));
  const sender = (documentId = 'doc-a', tabId = 1, frameId = 0) => ({ id: 'fixture', origin: 'https://fixture.invalid', url: 'https://fixture.invalid/app', tab: { id: tabId }, frameId, documentId });
  // The worker acknowledges once it has bound the request to its document.
  const provider = async (method, params, id = 'same', from = sender(), expectAccepted = true) => {
    let ack; listeners.message({ channel: 'znn', kind: 'request', method, params, id, ...liveDocument.documentFields() }, from, value => { ack = value; });
    await flush(); if (expectAccepted) assert.equal(ack?.accepted, true); await flush();
    return ack;
  };
  const key = { getAddress: async () => address, getPublicKey: async () => Buffer.alloc(32, 7), sign: async () => { counts.signs++; await pause('sign'); return Buffer.alloc(64, 9); } };
  const vault = { getKeyPair: () => key, getSigningKeyPair: async () => { await pause('key'); return key; },
    getBinding: () => binding, whileBound: async (_, operation) => operation(),
    // What a prepared block approval checks it is still current against.
    isUnlocked: () => true, getWalletName: () => 'fixture' };
  const zenon = sdk.Zenon.getSingleton();
  zenon.ledger.getFrontierBlock = async () => { await pause('rpc'); return null; };
  zenon.ledger.getFrontierMomentum = async () => ({ hash: emptyHash, height: 1 });
  zenon.embedded.plasma.getRequiredPoWForAccountBlock = async () => { await pause('pow'); return { requiredDifficulty: 0, basePlasma: 0, availablePlasma: 0 }; };
  zenon.ledger.publishRawTransaction = async template => { await pause('publish'); counts.publishes++; assert.equal(template.signature.length, 64); };
  // Scoped consent for the fixture origin.
  const connect = () => { local['syrius.permissions'] = { version: 2, entries: [{ active: true, origin: 'https://fixture.invalid', scope, title: '', favicon: '', connectedAt: 1, lastUsedAt: 1 }] }; };
  const ui = (windowId = 10) => {
    // Every approval-screen flow here is for a site already connected to the
    // fixture account; only a connected account's requests are shown (#11).
    connect();
    const states = [], refs = [], effects = [], callbacks = [], notices = [];
    let si, ri, ei, ci, tree, closes = 0;
    const state = { wallet: { address: address.toString(), isUnlocked: true }, connectionParameters: { chainIdentifier: 1, nodeUrl: 'wss://fixture.invalid' } };
    const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
    const hooks = { ...React,
      useState: initial => { const i = si++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
      useRef: initial => { const i = ri++; return refs[i] ||= { current: initial }; },
      useCallback: (fn, deps) => { const i = ci++; if (!same(callbacks[i]?.deps, deps)) callbacks[i] = { fn, deps }; return callbacks[i].fn; },
      useEffect: (fn, deps) => { const i = ei++; if (!same(effects[i]?.deps, deps)) effects[i] = { fn, deps, cleanup: effects[i]?.cleanup, pending: true }; },
    };
    const uiChrome = { ...chrome, windows: { ...chrome.windows, getCurrent: async () => ({ id: windowId }) } };
    const uiLoad = loader({ ...environment, chrome: uiChrome, window: { close() { closes++; } }, setTimeout: (fn, ms) => setTimeout(fn, ms === 1200 ? 0 : ms) }, id => {
      if (liveDocument.isNavigation(id)) return liveDocument.navigationStub;
      if (id === 'react') return hooks;
      // Stable within a route, as React Router's is: the screen's loaders depend on it.
      if (id === 'react-router-dom') return { useNavigate: () => navigateStub };
      if (id === 'react-redux') return { useSelector: select => select(state) };
      if (id === './vault' || id.endsWith('/wallet/vault')) return { __esModule: true, default: vault };
      if (id === './useAccount' || id.endsWith('/hooks/useAccount')) return { __esModule: true, default: () => ({ balanceMap: { [token.toString()]: { balance: BigNumber.from('1000000000'), token: { decimals: 8, symbol: 'ZNN' } } } }), invalidateAccountCache() {} };
      if (id.endsWith('/utils/notify')) return { notify: { success: value => notices.push({ success: value }), error: value => notices.push({ error: String(value) }) } };
    });
    const Component = uiLoad('src/layouts/siteIntegrationLayout/siteIntegrationLayout.js').default;
    const render = () => { si = ri = ei = ci = 0; tree = Component(); for (const effect of effects) if (effect.pending) { effect.pending = false; effect.cleanup?.(); effect.cleanup = effect.fn(); } return tree; };
    const settle = async () => { for (let i = 0; i < 16; i++) { await tick(); render(); } };
    const flatten = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(flatten) : [node, ...flatten(node.props?.children)];
    render();
    return { settle, render, state, notices, closes: () => closes, button: text => flatten(tree).find(node => node.type === 'button' && node.props.children === text), markup: () => renderToStaticMarkup(tree), dispose: () => effects.forEach(effect => effect.cleanup?.()) };
  };
  const add = async value => { const request = await queue.add(value); await queue.attachWindow(identity.identityOf(request), 10); return queue.get(request.id); };
  // The popup's binding step.
  const bindNext = () => internal('approvals.next', { binding });
  return { connect, bindNext, queue, identity, add, freshQueue: () => loader(environment, withBinding(relaxedLimits(plain)))('src/sections/Background/requests.js').default, session, local, faults, counts, events, windows, delivered, listeners, chrome, internal, sender, provider, hold, ui,
    holdStorage: area => (storageGate = { area, started: deferred(), release: deferred() }),
    holdInternal: method => (internalGate = { method, started: deferred(), release: deferred() }) };
};
const watchdog = setTimeout(() => { console.error('Request identity checks timed out'); process.exit(1); }, 45000);
(async () => {
  // Opaque identities, immutable snapshots, correlation domains and durable claims.
  {
    const f = fixture(), original = entry('__proto__');
    // The duplicate is offered before the second request: with the queue
    // limits (#10) a third request from one origin is refused as busy first.
    const a = await f.add(original);
    await assert.rejects(f.queue.add(entry('__proto__')), /already pending/);
    const b = await f.add(entry('__proto__', 'doc-b'));
    assert.notEqual(a.id, a.responseId); assert.notEqual(a.id, b.id);
    original.params.message = 'changed after admission'; assert.equal((await f.queue.get(a.id)).params.message, message);
    assert.equal((await f.queue.list()).length, 2);
    const frozen = f.identity.freezeApproval(a); assert(Object.isFrozen(frozen.params));
    const expected = f.identity.identityOf(a);
    for (const field of ['type', 'params', 'origin', 'tabId', 'frameId', 'documentId', 'responseId']) {
      const altered = clone(a); altered[field] = ({ type: 'connect', params: {}, origin: 'https://other.invalid', tabId: 4, frameId: 3, documentId: 'different', responseId: 'other' })[field];
      assert.equal(await f.queue.claim(f.identity.identityOf(altered), 10), null);
    }
    const claims = await Promise.all([f.queue.claim(expected, 10), f.freshQueue().claim(expected, 11)]);
    assert.equal(claims.filter(Boolean).length, 1); const winner = claims.find(Boolean);
    assert.equal(await f.freshQueue().checkClaim(winner), true);
    assert.equal(await f.freshQueue().claim(expected, 10), null);
    assert.equal(await f.queue.reject(expected), null);
    assert.equal(await f.queue.resolve({ ...winner, claimId: 'other' }), null);
    assert.equal(await f.queue.attachWindow(expected, 11), false);
    assert.equal((await f.queue.oldest()).id, b.id);
    assert.equal((await f.queue.resolve(winner)).id, a.id);
    assert.equal(await f.queue.checkClaim(winner), false);
    assert.equal(await f.queue.resolve(winner), null);
    const next = await f.add(entry('__proto__')); assert.notEqual(next.id, a.id);
    assert.equal(await f.queue.claim(expected, 10), null);
    // Unversioned page-keyed records never become new approval authority.
    f.session[f.queue.pendingKey].legacy = { ...entry('old'), id: 'old' };
    assert(!(await f.queue.list()).some(x => x.id === 'old'));
  }
  {
    const f = fixture(), row = await f.add(entry()), expected = f.identity.identityOf(row);
    f.faults.sessionWrite = true; await assert.rejects(f.queue.claim(expected, 10), /write unavailable/);
    f.faults.sessionWrite = false; assert.equal((await f.queue.get(row.id)).claimId, undefined);
    f.faults.sessionRead = true; await assert.rejects(f.queue.claim(expected, 10), /read unavailable/);
    f.faults.sessionRead = false;
    await Promise.all(Array.from({ length: 12 }, (_, i) => f.queue.add(entry(i, 'parallel-' + i))));
    assert.equal((await f.queue.list()).length, 13);
    const held = f.holdStorage('session'), claiming = f.queue.claim(expected, 11); await held.started.promise;
    const closing = f.queue.closeWindow(10); held.release.resolve(); const owner = await claiming;
    assert.deepEqual(await closing, []); assert.equal(await f.queue.checkClaim(owner), true);
    assert.equal((await f.queue.closeWindow(11))[0].id, row.id);
    assert.equal(await f.queue.checkClaim(owner), false);
    // Unstamped arrivals survive another window's close.
    assert.equal((await f.queue.list()).length, 12); assert.equal(await f.queue.oldest(), null);
  }
  // Actual worker routing preserves original public IDs, types and doc targets.
  for (const type of ['connect', 'sendTransaction', 'signAndSendBlock', 'signMessage']) {
    const f = fixture(), method = { connect: 'znn_connect', sendTransaction: 'znn_sendTransaction', signAndSendBlock: 'znn_signAndSendBlock', signMessage: 'znn_sign' }[type];
    if (type !== 'connect') f.connect();
    await f.provider(method, type === 'signMessage' ? message : paramsFor(type), 0);
    const row = await f.bindNext(); assert.equal(row.type, type); assert.equal(row.responseId, 0);
    if (type === 'signMessage') assert.deepEqual(row.params, { message });
    assert.equal(await f.internal('approvals.resolve', { identity: f.identity.identityOf(row), result: 'premature' }), false);
    const claim = await f.internal('approvals.claim', { identity: f.identity.identityOf(row), windowId: 10 }); assert(claim);
    // A signature must be the bound account's (#11).
    assert.equal(await f.internal('approvals.resolve', { identity: claim, result: type === 'connect' ? [address.toString()] : type === 'signMessage' ? { address: address.toString() } : { fixture: type } }), true);
    assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].value.id, 0);
    assert.deepEqual(f.delivered[0].options, { frameId: 0, documentId: 'doc-a' });
    assert.equal(await f.internal('approvals.resolve', { identity: claim, result: 'duplicate' }), false);
    assert.equal(f.delivered.length, 1);
  }
  {
    const f = fixture(); await f.provider('znn_connect', {}, 'legacy-like'); const row = await f.bindNext();
    const claim = await f.internal('approvals.claim', { identity: f.identity.identityOf(row), windowId: 10 });
    f.faults.localWrite = true;
    assert.equal(await f.internal('approvals.resolve', { identity: claim, result: [address.toString()] }), false);
    assert.equal(f.delivered[0].value.id, 'legacy-like'); assert.equal(f.delivered[0].value.error.code, -32603);
    assert.deepEqual(f.local['syrius.permissions']?.entries ?? [], []);
  }
  {
    const f = fixture(); f.faults.windowCreate = true; await f.provider('znn_connect', {}, 'window-failure');
    assert.equal((await f.queue.list()).length, 0); assert.equal(f.delivered[0].value.error.code, -32603);
    f.faults.windowCreate = false; await f.provider('znn_connect', {}, 'first', f.sender('doc-one'));
    // A second origin: one origin may have only one pending connect (#10).
    await f.provider('znn_connect', {}, 'second', { ...f.sender('doc-two'), origin: 'https://second.invalid', url: 'https://second.invalid/app' });
    assert.equal(f.counts.created, 1); const rows = await f.queue.list();
    const unstamped = await f.queue.add(entry('arrival', 'doc-three'));
    await f.listeners.closedWindow(rows[0].windowId);
    assert.deepEqual((await f.queue.list()).map(x => x.id), [unstamped.id]);
    assert.deepEqual(f.delivered.slice(1).map(x => x.value.id).sort(), ['first', 'second']);
    assert(f.delivered.slice(1).every(x => x.value.error.code === 4001), 'unclaimed closure remains rejection');
    let callback = false;
    assert.equal(f.listeners.message({ channel: 'internal', method: 'approvals.list' }, f.sender(), () => { callback = true; }), false);
    assert.equal(callback, false);
    // A request with no native document is refused at transport.
    assert.equal((await f.provider('znn_connect', {}, 'unbound', { ...f.sender(), documentId: undefined }, false))?.accepted, false);
    assert.equal((await f.queue.list()).length, 1);
  }
  {
    const f = fixture();
    await f.provider('znn_sign', message, 'denied'); assert.equal(f.delivered[0].value.error.code, 4100);
    f.connect();
    await f.provider('znn_sign', { message: '' }, 'empty'); assert.equal(f.delivered[1].value.error.code, -32602);
    await f.provider('znn_sign', { message: 'a'.repeat(8193) }, 'large'); assert.equal(f.delivered[2].value.error.code, -32602);
    // The fixture's live scoped session and public state answer this directly.
    await f.provider('znn_connect', {}, 'connected'); assert.deepEqual(f.delivered[3].value.result, [address.toString()]);
    assert.equal(f.counts.created, 0); assert.equal((await f.queue.list()).length, 0);
    await assert.rejects(async () => f.queue.add({ ...entry(), documentId: undefined }), error => error.code === -32602);
    const row = await f.add({ ...entry('only-correlation'), origin: 'https://unapproved.invalid' });
    const identity = await f.queue.claim(f.identity.identityOf(row), 10);
    await f.internal('approvals.resolve', { identity, result: {}, grantOrigin: true });
    assert.equal(f.local['syrius.permissions']['https://unapproved.invalid'], undefined, 'only a claimed connect grants consent');
  }
  const label = { connect: 'Connect', sendTransaction: 'Confirm', signAndSendBlock: 'Sign and send', signMessage: 'Sign' };
  for (const type of Object.keys(label)) {
    const f = fixture(); const row = await f.add(entry('ui-' + type, 'doc-a', type));
    const first = f.ui(10), second = f.ui(11); await first.settle(); await second.settle();
    assert(first.button(label[type]), 'approval button for ' + type);
    const a = first.button(label[type]).props.onClick, b = second.button(label[type]).props.onClick;
    await Promise.all([a(), a(), b()]); await first.settle(); await second.settle();
    assert.equal((await f.queue.list()).length, 0); assert.equal(f.delivered.length, 1);
    assert.equal(f.delivered[0].value.id, row.responseId);
    assert.equal(f.counts.signs, type === 'connect' ? 0 : 1);
    assert.equal(f.counts.publishes, ['sendTransaction', 'signAndSendBlock'].includes(type) ? 1 : 0);
    // A losing claimant may ask to retire its view (#11), but the queue refuses
    // an identity another popup has claimed: the winner's result is delivered.
    assert.equal(f.delivered[0].value.error, undefined, 'failed claimant does not reject winner');
    first.dispose(); second.dispose();
  }
  for (const type of ['sendTransaction', 'signAndSendBlock', 'signMessage']) {
    // An arbitrary block's node lookups happen at preparation (#4), before
    // approval; its approval phases start at the key.
    for (const phase of type === 'signMessage' ? ['key', 'sign'] : type === 'signAndSendBlock' ? ['key', 'pow', 'sign'] : ['key', 'rpc', 'pow', 'sign']) {
      const f = fixture(); await f.add(entry(type + phase, 'doc-a', type)); const view = f.ui(); await view.settle();
      const held = f.hold(phase), result = view.button(label[type]).props.onClick(); await held.started.promise;
      await f.queue.closeWindow(10); held.release.resolve(); await result;
      assert.equal(f.counts.publishes, 0);
      if (phase !== 'sign') assert.equal(f.counts.signs, 0);
      assert.equal(f.events.filter(x => x.method === 'approvals.resolve').length, 0);
      view.dispose();
    }
  }
  // Once approved publication has begun, a closed window cannot guarantee
  // cancellation. Keep the saved correlation and report an unknown outcome.
  for (const type of ['sendTransaction', 'signAndSendBlock']) {
    const f = fixture(); await f.add(entry('in-flight-' + type, 'doc-a', type));
    const view = f.ui(); await view.settle();
    const held = f.hold('publish'), result = view.button(label[type]).props.onClick(); await held.started.promise;
    await f.listeners.closedWindow(10);
    assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].value.id, 'in-flight-' + type);
    assert.equal(f.delivered[0].value.error.code, -32603);
    assert.match(f.delivered[0].value.error.message, /outcome is unknown.*before retrying/);
    held.release.resolve(); await result;
    assert.equal(f.counts.publishes, 1); assert.equal(f.delivered.length, 1);
    assert.equal(f.events.filter(x => x.method === 'approvals.resolve').length, 0);
    assert.equal((await f.queue.list()).length, 0); view.dispose();
  }
  // Rejection invalidates a copied callback synchronously; stale buttons cannot
  // approve or reject the next displayed request, even before React renders.
  {
    const f = fixture(); await f.add(entry('reject-first')); const view = f.ui(); await view.settle();
    const approve = view.button('Sign').props.onClick, reject = view.button('Reject').props.onClick;
    const held = f.holdInternal('approvals.reject'), rejecting = reject(); await held.started.promise;
    await approve(); assert.equal(f.counts.signs, 0);
    await f.add(entry('next', 'doc-b')); held.release.resolve(); await rejecting; await view.settle();
    await approve(); await reject(); assert.equal(f.counts.signs, 0);
    assert.equal((await f.queue.list()).length, 1);
    await view.button('Sign').props.onClick(); assert.equal(f.counts.signs, 1); view.dispose();
  }
  {
    const f = fixture(); await f.add(entry('unmounted')); const view = f.ui(); await view.settle();
    const held = f.hold('key'), result = view.button('Sign').props.onClick(); await held.started.promise;
    view.dispose(); held.release.resolve(); await result;
    assert.equal(f.counts.signs, 0); assert.equal(f.counts.publishes, 0); assert.equal(view.closes(), 0);
  }
  // Prepared block approval (#4) on the actual screen: nothing can be
  // approved until the block is prepared; a failed preparation says so; and
  // the block signed is the one reviewed even when the account's frontier has
  // moved since -- there is no second autofill at submission.
  {
    const f = fixture(); await f.add(entry('prepared', 'doc-a', 'signAndSendBlock'));
    const held = f.hold('rpc'); const view = f.ui(); await view.settle(); await held.started.promise;
    assert.equal(view.button('Sign and send').props.disabled, true);
    assert.match(view.markup(), /Preparing this block for review/);
    held.release.resolve(); await view.settle();
    assert.equal(view.button('Sign and send').props.disabled, false);
    const zenon = sdk.Zenon.getSingleton(); let lookups = 0, published;
    zenon.ledger.getFrontierBlock = async () => { lookups++; return { height: 7, hash: emptyHash }; };
    zenon.ledger.publishRawTransaction = async template => { published = template; f.counts.publishes++; };
    await view.button('Sign and send').props.onClick(); await view.settle();
    assert.equal(lookups, 0); assert.equal(f.counts.publishes, 1);
    assert.equal(published.height, 1); assert.equal(f.delivered[0].value.error, undefined);
    view.dispose();
  }
  {
    const f = fixture(); await f.add(entry('unpreparable', 'doc-a', 'signAndSendBlock'));
    sdk.Zenon.getSingleton().ledger.getFrontierBlock = async () => { throw Error('node unavailable'); };
    const view = f.ui(); await view.settle();
    assert.match(view.markup(), /Unable to prepare this block/);
    assert.equal(view.button('Sign and send').props.disabled, true);
    await view.button('Sign and send').props.onClick(); assert.equal(f.counts.signs, 0);
    view.dispose();
  }
  // Contract calls (#7) on the actual screen, from the prepared block: the
  // method and every decoded argument are shown; a call that cannot be decoded
  // strictly is a warning with its raw data.
  {
    const f = fixture(); const embedded = sdk.Zenon.getSingleton().embedded;
    await f.add({ ...entry('contract-call', 'doc-a', 'signAndSendBlock'), params: (await embedded.plasma.fuse(address, BigNumber.from('1000000000'))).toJson() });
    const view = f.ui(); await view.settle(); const html = view.markup();
    assert.match(html, /Plasma beneficiary/); assert(html.includes(address.toString())); assert.match(html, /Fuse/);
    view.dispose();
    const g = fixture();
    await g.add({ ...entry('noncanonical-call', 'doc-a', 'signAndSendBlock'), params: embedded.pillar.delegate('x'.repeat(17)).toJson() });
    const unknownView = g.ui(); await unknownView.settle();
    assert.match(unknownView.markup(), /cannot fully interpret/); assert.match(unknownView.markup(), /Raw transaction data/);
    unknownView.dispose();
  }
  // Real pinned-SDK key and UTF-8 signature compatibility with public fixture
  // entropy; no account block is submitted and no live service is contacted.
  {
    const key = await new sdk.KeyStore().fromEntropy('00112233445566778899aabbccddeeff').getKeyPair(0).generateKeyPair();
    const real = loader({}, id => id === './vault' ? { __esModule: true, default: { getSigningKeyPair: async () => key } } : undefined)('src/services/wallet/signMessage.js');
    const text = 'Benign approval identity signature: 界 🌍'; let checks = 0;
    for (const options of [{}, { assertRequest: async () => { checks++; } }]) {
      const result = await real.signMessage(text, options);
      const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(result.publicKey, 'hex')]), format: 'der', type: 'spki' });
      assert(crypto.verify(null, Buffer.from(text, 'utf8'), publicKey, Buffer.from(result.signature, 'hex')));
      assert.equal(result.address, (await key.getAddress()).toString());
    }
    assert(checks >= 3); await assert.rejects(real.signMessage('x'.repeat(32)), /exactly 32 bytes/);
  }
  console.log('request identity: opaque immutable records; durable single-use claims; four actual worker/UI flows; exact response correlation; competing callbacks; storage/window failures; restart and delayed SDK signing controls passed');
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
