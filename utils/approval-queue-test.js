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
const sdkSetHashAndSignature = sdk.utils.BlockUtils._setHashAndSignature;
const root = path.join(__dirname, '..'), compiled = new Map();
const clone = value => value === undefined ? value : structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
const navigateStub = () => {};
const liveDocument = require('./fixtures/document-binding-stub');
// What the relay and page provider need of a page: a document, and a mutation
// observer for their document-lifetime check (a steady page here).
const pageDocument = { documentElement: {} };
class QuietObserver { observe() {} takeRecords() { return []; } }
// The relay answers only to its own activation and request token (#6).
const replyFrom = (pending, body) => ({ channel: 'znn', kind: 'response', id: pending.value.id,
  activation: pending.value.activation, requestToken: pending.value.requestToken, ...body });
// Every module realm here sees the requesting document as live (see the stub).
const withBinding = (override = () => undefined) => id => (liveDocument.isNavigation(id) ? liveDocument.navigationStub : override(id));
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
// wallet account and selection generation. The fixture wallet stays unlocked
// on it; rows built here are admitted and already bound to it, as if shown.
const scope = { walletName: 'fixture', walletId: address.toString(), address: address.toString(), index: 0 };
const selectionId = 'fixture-selection';
const binding = Object.freeze({ id: selectionId, ownerId: 'owner', scope: Object.freeze({ ...scope }) });
const entry = (responseId = 'same', documentId = 'doc-a', type = 'signMessage') => ({ responseId, documentId, origin: 'https://fixture.invalid', tabId: 1, frameId: 0, type, params: paramsFor(type), title: '', favicon: '',
  admitted: { id: selectionId, scope: { ...scope } }, waitForUnlock: false, binding: { id: selectionId, scope: { ...scope } }, ...liveDocument.documentFields() });
const fixture = (requiredDifficulty = 0) => {
  let now = 1000000;
  const deadlineTimers = new Map();
  const schedule = (fn, ms) => {
    if (ms < 60000) return setTimeout(fn, ms);
    const id = {}; deadlineTimers.set(id, { fn, at: now + ms }); return id;
  };
  const cancel = id => { if (!deadlineTimers.delete(id)) clearTimeout(id); };
  const fireDeadlines = async () => {
    for (const [id, timer] of [...deadlineTimers]) if (timer.at <= now) { deadlineTimers.delete(id); timer.fn(); }
    await flush();
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  // A lease long enough to outlast every approval deadline these scenarios advance through.
  const session = {
    'znn.unlock': { version: 2, id: 'lease', revision: 'r', walletName: 'fixture', minutes: 15, mode: 'timed', entropy: 'fixture',
      ownerId: 'owner', selectedAddressIndex: 0, selectionId, scope, resumeFrom: null, lastActiveAt: now, expiresAt: now + 1000 * 60 * 60 * 1000 },
    'znn.publicState': { address: address.toString(), scope, selectionId, leaseId: 'lease', chainId: 1, nodeUrl: 'wss://fixture.invalid' },
  }, local = {}, locks = new Map(), listeners = {}, delivered = [], windows = new Map([[10, {}], [11, {}]]);
  const faults = {}, counts = { created: 0, focused: 0, signs: 0, publishes: 0, workers: 0, terminated: 0 }, events = [];
  let storageGate, phaseGate, internalGate;
  const hold = phase => (phaseGate = { phase, started: deferred(), release: deferred() });
  const pause = async phase => { if (phaseGate?.phase === phase) { const held = phaseGate; phaseGate = null; held.started.resolve(); await held.release.promise; } };
  const locksApi = { request: async (name, fn) => {
    const before = locks.get(name) || Promise.resolve(); let release; const after = new Promise(resolve => { release = resolve; }); locks.set(name, after);
    await before; try { return await fn(); } finally { release(); if (locks.get(name) === after) locks.delete(name); }
  } };
  const changeListeners = new Set();
  const storage = (area, data) => ({
    get: async key => { await pause(area + 'Read'); if (faults[area + 'Read']) throw Error(area + ' read unavailable'); return Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, clone(data[k])])); },
    set: async values => {
      if (storageGate?.area === area && (!storageGate.key || Object.hasOwn(values, storageGate.key)) && --storageGate.remaining === 0) { const held = storageGate; storageGate = null; held.started.resolve(); await held.release.promise; }
      if (faults[area + 'Write']) throw Error(area + ' write unavailable');
      Object.assign(data, clone(values));
      // Chrome reports every write; the approval screen watches its queue.
      const changes = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { newValue: clone(value) }]));
      for (const listener of [...changeListeners]) listener(changes, area);
      await pause(area + 'Written');
    },
    remove: async keys => { if (faults[area + 'Write']) throw Error(area + ' write unavailable'); for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  const event = name => ({ addListener: fn => { listeners[name] = fn; } });
  const chrome = {
    runtime: { id: 'fixture', getURL: value => 'chrome-extension://fixture/' + value, onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup') },
    storage: { session: storage('session', session), local: storage('local', local),
      onChanged: { addListener: fn => changeListeners.add(fn), removeListener: fn => changeListeners.delete(fn) } },
    webNavigation: { onBeforeNavigate: event('navigate') },
    windows: { onRemoved: event('closedWindow'), getCurrent: async () => ({ id: 10 }),
      getLastFocused: async () => ({ top: 0, left: 0, width: 1200 }),
      get: async id => { if (!windows.has(id)) throw Error('window gone'); return { id }; },
      update: async id => { counts.focused++; if (!windows.has(id)) throw Error('window gone'); return { id }; },
      create: async () => { if (faults.windowCreate) throw Error('window creation unavailable'); if (faults.afterCreateWrite) faults.sessionWrite = true; const id = 100 + ++counts.created; windows.set(id, {}); return { id }; },
      remove: async id => { windows.delete(id); },
    },
    tabs: { onRemoved: event('closedTab'), sendMessage: async (tabId, value, options) => {
      // A liveness probe is not a delivery: a live relay answers it at once.
      if (value?.kind === 'probe') return { accepted: true };
      await pause('delivery');
      const accepted = !value.error && (!Number.isFinite(value.expiresAt) || now < value.expiresAt);
      const received = !accepted && !value.error ? { ...value, result: undefined, error: { code: -32603, message: 'Approval expired.' } } : value;
      delivered.push({ tabId, value: clone(received), options: clone(options) });
      const receipt = { accepted, acceptedAt: now }; await pause('acknowledgement'); return receipt;
    } },
    alarms: { onAlarm: event('alarm'), create() {} },
  };
  class PowWorker {
    constructor() { counts.workers++; queueMicrotask(() => this.onmessage?.({ data: { ready: true } })); }
    postMessage() { queueMicrotask(() => this.onmessage?.({ data: { nonce: '0000000000000001' } })); }
    terminate() { counts.terminated++; }
  }
  const environment = { Worker: PowWorker, Date: Clock, setTimeout: schedule, clearTimeout: cancel, chrome, navigator: { locks: locksApi }, crypto: crypto.webcrypto };
  const load = loader(environment, withBinding()), queue = load('src/sections/Background/requests.js').default;
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
  const provider = async (method, params, id = 'same', from = sender()) => {
    let ack; listeners.message({ channel: 'znn', kind: 'request', method, params, id, ...liveDocument.documentFields() }, from, value => { ack = value; });
    await flush(); return ack;
  };
  const key = { getAddress: async () => address, getPublicKey: async () => Buffer.alloc(32, 7), sign: async () => { counts.signs++; await pause('sign'); return Buffer.alloc(64, 9); } };
  const vault = { getKeyPair: () => key, getSigningKeyPair: async () => { await pause('key'); return key; },
    getBinding: () => binding, whileBound: async (_, operation) => operation(),
    // What a prepared block approval checks it is still current against.
    isUnlocked: () => true, getWalletName: () => 'fixture' };
  // Scoped consent for the fixture origin; the approval screen shows only a
  // connected account's requests (#11).
  const connect = () => { local['syrius.permissions'] = { version: 2, entries: [{ active: true, origin: 'https://fixture.invalid', scope, title: '', favicon: '', connectedAt: 1, lastUsedAt: 1 }] }; };
  const zenon = sdk.Zenon.getSingleton();
  zenon.ledger.getFrontierBlock = async () => { await pause('rpc'); return null; };
  zenon.ledger.getFrontierMomentum = async () => ({ hash: emptyHash, height: 1 });
  zenon.embedded.plasma.getRequiredPoWForAccountBlock = async () => { await pause('pow'); return { requiredDifficulty, basePlasma: 0, availablePlasma: 1 }; };
  sdk.utils.BlockUtils._setHashAndSignature = async (...args) => { const result = await sdkSetHashAndSignature(...args); await pause('readyToPublish'); return result; };
  zenon.ledger.publishRawTransaction = async template => { await pause('publish'); counts.publishes++; assert.equal(template.signature.length, 64); };
  const ui = (windowId = 10) => {
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
    const uiLoad = loader({ ...environment, chrome: uiChrome, window: { close() { closes++; } }, setTimeout: (fn, ms) => ms === 1200 ? setTimeout(fn, 0) : schedule(fn, ms) }, id => {
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
  // The popup's binding step, for a request a page created.
  const bindNext = () => internal('approvals.next', { binding });
  return { connect, bindNext, queue, identity, add, load, fireDeadlines, now: () => now, advance: milliseconds => { now += milliseconds; }, freshQueue: () => loader(environment, withBinding())('src/sections/Background/requests.js').default, session, local, faults, counts, events, windows, delivered, listeners, chrome, internal, sender, provider, hold, ui,
    holdStorage: (area, key, remaining = 1) => (storageGate = { area, key, remaining, started: deferred(), release: deferred() }),
    holdInternal: method => (internalGate = { method, started: deferred(), release: deferred() }) };
};
const watchdog = setTimeout(() => { console.error('Approval queue checks timed out'); process.exit(1); }, 45000);
(async () => {
  const policy = loader({})('src/services/utils/approvalLimits.js'), { limits } = policy;
  // Exact UTF-8/JSON accounting and supported full-size calldata representations.
  for (const value of [null, true, false, 0, -1e20, '', '界 🌍\n\t"\\', '\ud800', { title: 'hello', data: [1, 2, 3] }]) {
    assert.equal(policy.boundedJson(value), Buffer.byteLength(JSON.stringify(value)));
  }
  assert.equal(policy.boundedJson('a'.repeat(limits.bytes - 2)), limits.bytes);
  assert.throws(() => policy.boundedJson('a'.repeat(limits.bytes - 1)), error => error.code === -32602);
  assert.throws(() => policy.boundedJson('界'.repeat(limits.bytes / 2)), /limits/);
  let nested = 1; for (let i = 0; i <= limits.depth; i++) nested = { value: nested };
  assert.throws(() => policy.boundedJson(nested), /limits/);
  assert.throws(() => policy.boundedJson(Array(limits.nodes).fill(0)), /limits/);
  const loop = {}; loop.self = loop; assert.throws(() => policy.boundedJson(loop), /limits/);
  for (const data of [Buffer.alloc(16384, 255).toString('base64'), Array(16384).fill(255), { type: 'Buffer', data: Array(16384).fill(255) }]) {
    const f = fixture(), params = { ...block(), data };
    const row = await f.add({ ...entry('full-data', 'doc-a', 'signAndSendBlock'), params });
    assert.deepEqual(row.params, params);
    const template = sdk.Primitives.AccountBlockTemplate.fromJson(row.params);
    assert.equal(template.data.length, 16384); assert(template.data.every(x => x === 255));
  }
  // Admission copies values only after validation, preserves correlation, and
  // serializes independent realms at the last permitted global slot.
  {
    const f = fixture(), input = entry('first'); const row = await f.add(input);
    input.params.message = 'later caller mutation'; assert.equal((await f.queue.get(row.id)).params.message, message);
    await f.add(entry('second', 'doc-b'));
    await assert.rejects(f.queue.add(entry('third', 'doc-c')), error => error.code === -32005);
    assert.equal((await f.queue.list()).length, 2);
    assert.throws(() => f.queue.add({ ...entry(), title: 't'.repeat(1025) }), /limits/);
    assert.throws(() => f.queue.add({ ...entry(), favicon: 'u'.repeat(4097) }), /limits/);
    assert.throws(() => f.queue.add({ ...entry(), responseId: 'r'.repeat(129) }), /limits/);
  }
  {
    const f = fixture(); await f.queue.add(entry('connect-one', 'doc-a', 'connect'));
    await assert.rejects(f.queue.add(entry('connect-two', 'doc-b', 'connect')), error => error.code === -32005);
    await f.queue.add(entry('other-type', 'doc-c')); assert.equal((await f.queue.list()).length, 2);
  }
  {
    const f = fixture(), other = f.freshQueue(), gate = f.holdStorage('session');
    const first = f.queue.add({ ...entry('slot-0'), origin: 'https://slot-0.invalid' }); await gate.started.promise;
    const rest = Array.from({ length: limits.pending }, (_, i) => other.add({ ...entry('slot-' + (i + 1)), origin: 'https://slot-' + (i + 1) + '.invalid' }));
    gate.release.resolve(); const results = await Promise.allSettled([first, ...rest]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, limits.pending);
    assert.equal(results.filter(x => x.status === 'rejected').length, 1);
    assert.equal((await f.queue.list()).length, limits.pending);
  }
  // No admission or attention side effect is reported after storage failure.
  for (const fault of ['sessionRead', 'sessionWrite']) {
    const f = fixture(); f.faults[fault] = true;
    await f.provider('znn_connect', {}, 'storage');
    assert.equal(f.counts.created, 0); assert.equal(f.delivered[0].value.error.code, -32603);
    f.faults[fault] = false; assert.equal((await f.queue.list()).length, 0);
  }
  {
    const f = fixture(); f.faults.windowCreate = true;
    await f.provider('znn_connect', {}, 'window'); assert.equal((await f.queue.list()).length, 0);
    assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].value.error.code, -32603);
    f.faults.windowCreate = false; f.advance(limits.originAttention);
    await f.provider('znn_connect', {}, 'retry'); assert.equal((await f.queue.list()).length, 1);
  }
  {
    const f = fixture(); f.faults.afterCreateWrite = true;
    await f.provider('znn_connect', {}, 'window-persist');
    assert.equal(f.windows.size, 2, 'new window closed when ownership persistence fails');
    f.faults.sessionWrite = false; const rows = await f.queue.list();
    assert(rows.every(row => row.windowId === undefined)); assert.equal(await f.queue.oldest(), null);
    f.advance(limits.ttl); await f.queue.prune(); assert.equal((await f.queue.list()).length, 0);
  }
  // Existing window reuse has no focus side effect, cooldown persists across
  // realms, and one successful approval authorizes the ordinary follow-up.
  {
    const f = fixture(); await f.provider('znn_connect', {}, 'first');
    const row = await f.bindNext(), id = row.windowId; // shown by the popup, as #11 requires before a claim
    await f.queue.add({ ...entry('second'), origin: 'https://other.invalid' }).then(r => f.queue.present(f.identity.identityOf(r)));
    assert.equal(f.counts.created, 1); assert.equal(f.counts.focused, 0);
    const claim = await f.queue.claim(f.identity.identityOf(row), id);
    assert.equal(await f.internal('approvals.resolve', { identity: claim, result: [address.toString()] }), true);
    await f.queue.closeWindow(id); f.windows.delete(id); f.advance(1500);
    await f.provider('znn_sign', { message }, 'followup');
    assert.equal(f.counts.created, 2); const next = await f.queue.oldest(); assert(next);
    await f.internal('approvals.reject', { identity: f.identity.identityOf(next) });
    await f.queue.closeWindow(next.windowId); f.windows.delete(next.windowId);
    await f.provider('znn_sign', { message }, 'too-soon');
    assert.equal(f.delivered.at(-1).value.error.code, -32005); assert.equal(f.counts.created, 2);
    assert.equal((await f.queue.list()).length, 0);
    f.advance(limits.originAttention); await f.provider('znn_sign', { message }, 'after-cooldown');
    assert.equal(f.counts.created, 3);
  }
  {
    const f = fixture(); let old = await f.queue.add(entry('one')); await f.queue.present(f.identity.identityOf(old));
    const first = await f.queue.get(old.id); await f.queue.closeWindow(first.windowId); f.windows.delete(first.windowId);
    const fresh = f.freshQueue(), row = await fresh.add(entry('same-origin'));
    await assert.rejects(fresh.present(f.identity.identityOf(row)), error => error.code === -32005);
    await fresh.reject(f.identity.identityOf(row));
    const other = await fresh.add({ ...entry('different-origin'), origin: 'https://other.invalid' });
    await assert.rejects(fresh.present(f.identity.identityOf(other)), error => error.code === -32005);
    f.advance(limits.globalAttention); assert.equal(await fresh.present(f.identity.identityOf(other)), true);
    const unstamped = await fresh.add({ ...entry('unstamped'), origin: 'https://new.invalid' });
    await fresh.closeWindow(first.windowId); assert(await fresh.get(unstamped.id));
    // Bounded old attention metadata is pruned during a later decision.
    f.session[f.queue.attentionKey].origins['https://stale.invalid'] = f.now() - limits.originAttention;
    await f.queue.allowFollowup('https://follow.invalid', f.now() + limits.ttl);
    assert.equal(f.session[f.queue.attentionKey].origins['https://stale.invalid'], undefined);
  }
  // Absolute expiry never refreshes older entries, and persisted claims lose
  // authority through list, check, settlement and the worker alarm.
  {
    const f = fixture(), early = await f.add(entry('early')); f.advance(1000);
    const later = await f.add(entry('later', 'doc-b')); assert.equal(later.expiresAt - early.expiresAt, 1000);
    f.advance(limits.ttl - 1000);
    assert.deepEqual((await f.queue.list()).map(x => x.responseId), ['later']);
    assert.equal(f.delivered[0].value.id, 'early'); assert.equal(f.delivered[0].value.error.code, -32006);
    assert.equal(await f.queue.claim(f.identity.identityOf(early), 10), null);
    f.advance(1000); await f.listeners.alarm({ name: 'znn.autoLock' });
    assert.equal((await f.queue.list()).length, 0); assert.equal(f.delivered.length, 2);
    await f.queue.prune(); assert.equal(f.delivered.length, 2);
  }
  {
    const f = fixture(), row = await f.add(entry('owner')); const owner = await f.queue.claim(f.identity.identityOf(row), 10);
    assert.equal(await f.freshQueue().checkClaim(owner), true);
    f.advance(limits.ttl); assert.equal(await f.internal('approvals.resolve', { identity: owner, result: 'late' }), false);
    assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].value.error.code, -32603);
    assert.match(f.delivered[0].value.error.message, /outcome is unknown/);
  }
  {
    const f = fixture(), row = await f.add(entry('tab-closed'));
    f.listeners.closedTab(row.tabId); await flush(); assert.equal((await f.queue.list()).length, 0);
    assert.equal(await f.queue.claim(f.identity.identityOf(row), 10), null);
  }
  // Consent here is the scoped form (#11): one wallet account per grant.
  // Finalization checks cover the actual awaited attention, permission read,
  // durable grant and activation writes. A late attempt restores prior consent.
  for (const phase of ['attention', 'read', 'grant', 'delivery']) {
    for (const previous of [null, { active: true, origin: 'https://fixture.invalid', scope, title: 'Earlier consent', connectedAt: 1, lastUsedAt: 2 }]) {
      const f = fixture(), permission = f.load('src/sections/Background/permissions.js').default;
      if (previous) f.local[permission.storageKey] = { version: 2, entries: [previous] };
      const row = await f.add(entry('late-finalization-' + phase, 'doc-a', 'connect'));
      const owner = await f.queue.claim(f.identity.identityOf(row), 10);
      const held = phase === 'attention' ? f.holdStorage('session', f.queue.attentionKey)
        : phase === 'read' ? f.hold('localRead') : phase === 'grant' ? f.holdStorage('local')
          : f.hold('delivery');
      const result = f.internal('approvals.resolve', { identity: owner, result: [address.toString()] });
      await held.started.promise; f.advance(limits.ttl); held.release.resolve();
      assert.equal(await result, false); assert(f.delivered.length >= 1);
      assert(f.delivered.every(delivery => delivery.value.result === undefined));
      assert.equal(f.delivered[0].value.result, undefined); assert.equal(f.delivered[0].value.error.code, -32603);
      assert.deepEqual(await permission.get(row.origin, scope), previous);
      assert.deepEqual(f.local[permission.storageKey]?.entries?.find(entry => entry.active === true && entry.origin === row.origin) || null, previous);
    }
  }
  // A failed local rollback retains a durably inactive row even after the
  // entire browser session disappears, with prior consent preserved.
  for (const previous of [null, { active: true, origin: 'https://fixture.invalid', scope, title: 'Retained consent', connectedAt: 1 }]) {
    const f = fixture(), permission = f.load('src/sections/Background/permissions.js').default;
    if (previous) f.local[permission.storageKey] = { version: 2, entries: [previous] };
    const row = await f.add(entry('rollback-unavailable', 'doc-a', 'connect'));
    const owner = await f.queue.claim(f.identity.identityOf(row), 10), held = f.hold('localWritten');
    const result = f.internal('approvals.resolve', { identity: owner, result: [address.toString()] });
    await held.started.promise; f.advance(limits.ttl); f.faults.localWrite = true; held.release.resolve();
    assert.equal(await result, false); assert.deepEqual(await permission.get(row.origin, scope), previous);
    for (const key of Object.keys(f.session)) delete f.session[key];
    const fresh = loader({ chrome: f.chrome, navigator: { locks: { request: async (name, fn) => fn() } } })('src/sections/Background/permissions.js').default;
    assert.deepEqual(await fresh.get(row.origin, scope), previous);
    f.faults.localWrite = false; await permission.revoke(row.origin); assert.equal(await fresh.isConnected(row.origin, scope), false);
  }
  // Native acknowledgement and durable promotion can finish later than relay
  // acceptance. The fixed deadline applies to that exact acceptance point.
  for (const phase of ['acknowledgement', 'promotion']) {
    const f = fixture(), permission = f.load('src/sections/Background/permissions.js').default;
    const row = await f.add(entry('accepted-before-expiry', 'doc-a', 'connect'));
    const owner = await f.queue.claim(f.identity.identityOf(row), 10);
    const held = phase === 'promotion' ? f.holdStorage('local', permission.storageKey, 2) : f.hold('acknowledgement');
    const result = f.internal('approvals.resolve', { identity: owner, result: [address.toString()] });
    await held.started.promise; assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].value.error, undefined);
    f.advance(limits.ttl); held.release.resolve(); assert.equal(await result, true);
    assert.equal(await permission.isConnected(row.origin, scope), true);
    assert((await permission.get(row.origin, scope)).approvalAcceptedAt < row.expiresAt);
    for (const key of Object.keys(f.session)) delete f.session[key];
    const fresh = loader({ chrome: f.chrome, navigator: { locks: { request: async (name, fn) => fn() } } })('src/sections/Background/permissions.js').default;
    assert.equal(await fresh.isConnected(row.origin, scope), true);
  }
  // A failed promotion and failed rollback cannot turn a prepared record into
  // authority when the browser loses all session-only state.
  {
    const f = fixture(), permission = f.load('src/sections/Background/permissions.js').default;
    const row = await f.add(entry('failed-promotion', 'doc-a', 'connect'));
    const owner = await f.queue.claim(f.identity.identityOf(row), 10), held = f.holdStorage('local', permission.storageKey, 2);
    const result = f.internal('approvals.resolve', { identity: owner, result: [address.toString()] });
    await held.started.promise; f.faults.localWrite = true; held.release.resolve(); assert.equal(await result, false);
    for (const key of Object.keys(f.session)) delete f.session[key];
    const fresh = loader({ chrome: f.chrome, navigator: { locks: { request: async (name, fn) => fn() } } })('src/sections/Background/permissions.js').default;
    assert.equal(await fresh.isConnected(row.origin, scope), false);
  }
  // Work is bounded synchronously even while the first storage read is held.
  {
    const f = fixture(), gate = deferred(), realGet = f.chrome.storage.session.get;
    f.chrome.storage.session.get = async key => { await gate.promise; return realGet(key); };
    const acknowledgements = [];
    for (let i = 0; i <= limits.activeHandlers; i++) f.listeners.message({ channel: 'znn', kind: 'request', id: 'held-' + i, method: 'znn_connect', params: {}, ...liveDocument.documentFields() }, f.sender(), ack => acknowledgements.push(ack));
    // The bound is taken synchronously; admitted requests are acknowledged once
    // bound to their document.
    assert.equal(acknowledgements.length, 1); assert.equal(acknowledgements[0].error.code, -32005);
    await flush();
    assert.equal(acknowledgements.filter(x => x.accepted).length, limits.activeHandlers);
    assert.equal(f.delivered.length, 0);
    gate.resolve(); await flush(); assert((await f.queue.list()).length <= 1);
    const invalid = await f.provider('znn_connect', {}, 'x'.repeat(129)); assert.equal(invalid.error.code, -32602);
  }
  // Actual React approval callbacks and installed SDK paths enforce expiry
  // before execution and after delayed key/RPC/PoW/signature work.
  const label = { connect: 'Connect', sendTransaction: 'Confirm', signAndSendBlock: 'Sign and send', signMessage: 'Sign' };
  for (const type of Object.keys(label)) {
    const f = fixture(); await f.add(entry('legitimate-' + type, 'doc-a', type)); const view = f.ui(); await view.settle();
    await view.button(label[type]).props.onClick(); assert.equal(f.delivered.length, 1);
    assert.equal(f.delivered[0].value.error, undefined); assert.equal((await f.queue.list()).length, 0);
    assert.equal(f.counts.signs, type === 'connect' ? 0 : 1); view.dispose();
    const expired = fixture(); await expired.add(entry('expired-' + type, 'doc-a', type)); const stale = expired.ui(); await stale.settle();
    const copied = stale.button(label[type]).props.onClick; expired.advance(limits.ttl); await copied();
    assert.equal(expired.counts.signs, 0); assert.equal(expired.counts.publishes, 0);
    await expired.queue.prune(); assert.equal(expired.delivered[0].value.error.code, -32006); stale.dispose();
  }
  // Nonzero PoW follows the same actual SDK preparation/signature path, with
  // inert worker output and publication; native WASM compatibility is separate.
  {
    const f = fixture(1); await f.add(entry('nonzero-pow', 'doc-a', 'sendTransaction'));
    const view = f.ui(); await view.settle(); await view.button('Confirm').props.onClick();
    assert.equal(f.delivered[0].value.error, undefined); assert.equal(f.counts.signs, 1);
    assert.equal(f.counts.publishes, 1); assert.equal(f.counts.workers, 1); assert.equal(f.counts.terminated, 1); view.dispose();
  }
  for (const type of ['sendTransaction', 'signAndSendBlock', 'signMessage']) {
    // An arbitrary block's node lookups happen at preparation (#4), before
    // approval; its approval phases start at the key.
    for (const phase of type === 'signMessage' ? ['key', 'sign'] : type === 'signAndSendBlock' ? ['key', 'pow', 'sign', 'readyToPublish'] : ['key', 'rpc', 'pow', 'sign', 'readyToPublish']) {
      const f = fixture(); await f.add(entry('delayed-' + type + phase, 'doc-a', type)); const view = f.ui(); await view.settle();
      const held = f.hold(phase), action = view.button(label[type]).props.onClick(); await held.started.promise;
      f.advance(limits.ttl); held.release.resolve(); await action;
      assert.equal(f.counts.publishes, 0); if (!['sign', 'readyToPublish'].includes(phase)) assert.equal(f.counts.signs, 0);
      assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].value.error.code, -32603); view.dispose();
    }
  }
  {
    const f = fixture(); await f.add(entry('started-publication', 'doc-a', 'signAndSendBlock')); const view = f.ui(); await view.settle();
    const held = f.hold('publish'), action = view.button('Sign and send').props.onClick(); await held.started.promise;
    f.advance(limits.ttl); await f.queue.prune(); held.release.resolve(); await action;
    assert.equal(f.counts.publishes, 1); assert.equal(f.delivered.length, 1);
    assert.match(f.delivered[0].value.error.message, /outcome is unknown/); view.dispose();
  }
  // Expiry frees the approval UI while the old SDK call remains unsettled.
  // Late continuation cannot sign, publish or replace the next approval's state.
  for (const phase of ['key', 'rpc', 'pow', 'sign', 'publish']) {
    const f = fixture(); await f.add(entry('stalled-' + phase, 'doc-a', 'sendTransaction'));
    const view = f.ui(); await view.settle();
    const held = f.hold(phase), action = view.button('Confirm').props.onClick(); await held.started.promise;
    f.advance(limits.ttl - 1000); const next = await f.add(entry('after-stall', 'doc-b', 'signMessage'));
    f.advance(1000); await f.fireDeadlines(); await action; await view.settle();
    assert(view.button('Sign')); assert.equal(view.button('Sign').props.disabled, false);
    const deliveredBefore = f.delivered.length;
    await view.button('Sign').props.onClick(); assert.equal(f.delivered.at(-1).value.id, next.responseId);
    assert.equal(f.delivered.at(-1).value.error, undefined);
    held.release.resolve(); await flush();
    assert.equal(f.delivered.length, deliveredBefore + 1);
    assert.equal(f.counts.publishes, phase === 'publish' ? 1 : 0); view.dispose();
  }
  // Real isolated relay: bounded concurrent transport and legacy bookkeeping,
  // explicit admission errors/expiry, and modern/legacy result compatibility.
  {
    const callbacks = [], posted = [], timers = new Map(), handlers = {}; let timerId = 0;
    const window = { location: { origin: 'https://fixture.invalid' }, postMessage: value => posted.push(clone(value)), addEventListener: (name, fn) => { handlers[name] = fn; } };
    const chrome = { runtime: { id: 'fixture', sendMessage: (value, callback) => { if (value.kind === 'request') callbacks.push({ value, callback }); else callback({}); }, onMessage: { addListener: fn => { handlers.background = fn; } } } };
    loader({ window, chrome, document: pageDocument, MutationObserver: QuietObserver, setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id) })('src/sections/Content/index.js');
    const background = (message, reply = () => {}) => handlers.background(message, { id: 'fixture' }, reply);
    const page = data => handlers.message({ source: window, data });
    for (let i = 0; i <= limits.activeHandlers; i++) page({ target: 'znn-contentscript', kind: 'request', id: 'relay-' + i, method: 'znn_connect', params: {} });
    assert.equal(callbacks.length, limits.activeHandlers); assert.equal(posted.at(-1).error.code, -32005);
    for (const pending of callbacks.splice(0)) pending.callback({ error: { code: -32005, message: 'Wait and retry.' } });
    assert.equal(posted.length, limits.activeHandlers + 1);
    page({ method: 'znn.requestWalletAccess' }); const legacy = callbacks.shift(); legacy.callback({ accepted: true });
    background(replyFrom(legacy, { error: { code: -32006, message: 'The approval expired.' } }));
    await flush(); assert.equal(posted.at(-1).method, 'znn.deniedWalletRead'); assert.equal(timers.size, 0);
    page({ method: 'znn.sendTransactionToSigning', params: paramsFor('sendTransaction') });
    const transaction = callbacks.shift(); transaction.callback({ accepted: true });
    background(replyFrom(transaction, { result: { hash: 'fixture' } }));
    await flush(); assert.deepEqual(posted.at(-1), { method: 'znn.signedTransaction', data: { hash: 'fixture' } });
    page({ target: 'znn-contentscript', kind: 'request', id: 'late-relay', method: 'znn_connect', params: {} });
    const late = callbacks.shift(); late.callback({ accepted: true });
    background(replyFrom(late, { result: [address.toString()], expiresAt: Date.now() - 1 }));
    assert.equal(posted.at(-1).result, undefined); assert.equal(posted.at(-1).error.code, -32603);
    page({ method: 'znn.requestWalletAccess' }); const expiredLegacy = callbacks.shift(); expiredLegacy.callback({ accepted: true });
    background(replyFrom(expiredLegacy, { result: [address.toString()], expiresAt: Date.now() - 1 }));
    await flush(); assert.equal(posted.at(-1).method, 'znn.deniedWalletRead');
    page({ method: 'znn.requestWalletAccess' }); const timeout = callbacks.shift(); timeout.callback({ accepted: true });
    const timer = [...timers.values()].find(x => x.ms === limits.ttl + 60000); timer.fn();
    assert.match(posted.at(-1).error, /Verify the outcome/); timers.clear();
    for (let i = 0; i <= limits.activeHandlers; i++) { page({ method: 'znn.requestWalletAccess' }); callbacks.shift()?.callback({ accepted: true }); }
    assert.equal(timers.size, limits.activeHandlers); assert.equal(posted.at(-1).method, 'znn.deniedWalletRead');
    timers.clear();
  }
  // Legacy decoration waits for permission-gated reads, but acceptance is
  // acknowledged synchronously before those reads can finish or the deadline
  // advances. This prevents a grant/decoration wait cycle.
  {
    let now = 1000, receipt;
    class Clock extends Date { static now() { return now; } }
    const callbacks = [], posted = [], handlers = {};
    const window = { location: { origin: 'https://fixture.invalid' }, postMessage: value => posted.push(value),
      addEventListener: (name, fn) => { handlers[name] = fn; } };
    const chrome = { runtime: { id: 'fixture', sendMessage: (value, callback) => { if (value.kind === 'request') callbacks.push({ value, callback }); else callback({}); },
      onMessage: { addListener: fn => { handlers.background = fn; } } } };
    loader({ window, chrome, Date: Clock, document: pageDocument, MutationObserver: QuietObserver })('src/sections/Content/index.js');
    handlers.message({ source: window, data: { method: 'znn.requestWalletAccess' } });
    const connection = callbacks.shift(); connection.callback({ accepted: true });
    handlers.background(replyFrom(connection, { result: [address.toString()], expiresAt: 1001 }), { id: 'fixture' }, value => { receipt = value; });
    assert.deepEqual(receipt, { accepted: true, acceptedAt: 1000 }); assert.equal(posted.length, 0);
    now = 1002;
    for (const metadata of callbacks.splice(0)) {
      metadata.callback({ accepted: true });
      handlers.background(replyFrom(metadata, { result: metadata.value.method === 'znn_chainId' ? 1 : 'wss://fixture.invalid' }), { id: 'fixture' }, () => {});
    }
    await flush(); assert.equal(posted.at(-1).method, 'znn.grantedWalletRead');
    assert.equal(posted.at(-1).data.chainId, 1);
  }
  // The MAIN-world receiver independently rejects a transport-delayed result.
  {
    const handlers = {}, posted = [];
    const window = { location: { origin: 'https://fixture.invalid' }, dispatchEvent() {},
      addEventListener: (name, fn) => { handlers[name] = fn; }, postMessage: value => posted.push(value) };
    loader({ window, document: pageDocument, MutationObserver: QuietObserver })('src/sections/Inpage/index.js');
    const response = window.zenon.connect().then(value => ({ value }), error => ({ error }));
    handlers.message({ source: window, data: { target: 'znn-inpage', kind: 'response', id: posted[0].id, result: [address.toString()], expiresAt: Date.now() - 1 } });
    assert.equal((await response).error.code, -32603); assert.deepEqual(window.zenon.accounts, []);
  }
  // A receipt accepted by the relay before expiry remains a completed result
  // when the page's own event queue runs later.
  {
    const handlers = {}, posted = [];
    const window = { location: { origin: 'https://fixture.invalid' }, dispatchEvent() {},
      addEventListener: (name, fn) => { handlers[name] = fn; }, postMessage: value => posted.push(value) };
    loader({ window, document: pageDocument, MutationObserver: QuietObserver })('src/sections/Inpage/index.js');
    const response = window.zenon.connect();
    handlers.message({ source: window, data: { target: 'znn-inpage', kind: 'response', id: posted[0].id,
      result: [address.toString()], acceptedAt: Date.now() - 20, expiresAt: Date.now() - 10 } });
    assert.deepEqual(await response, [address.toString()]);
  }
  console.log('approval queue: bounded JSON/capacity/transient work; storage/window failures; persistent attention; absolute expiry including delayed finalization and failed rollback; actual worker/relay/UI/SDK legitimate and delayed controls passed');
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
