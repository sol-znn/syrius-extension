'use strict';
// Actual corrected provider/publication/relay modules with synthetic state.
// All browser, SDK connection and signing boundaries are inert.
const assert = require('node:assert/strict');
const path = require('node:path');
const babel = require('@babel/core');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.join(__dirname, '..'), compiled = new Map();
const clone = value => value === undefined ? value : structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
const loader = (environment = {}, overrides = () => undefined) => {
  const cache = new Map();
  const load = file => {
    const filename = path.resolve(root, file); if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    if (!compiled.has(filename)) compiled.set(filename, babel.transformFileSync(filename, { presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'], configFile: false, babelrc: false }).code);
    const resolve = id => {
      const replacement = overrides(id); if (replacement !== undefined) return replacement;
      if (!id.startsWith('.')) return require(id);
      const target = path.resolve(path.dirname(filename), id); return load(path.extname(target) ? target : target + '.js');
    };
    new Function('module', 'exports', 'require', ...Object.keys(environment), compiled.get(filename))(module, module.exports, resolve, ...Object.values(environment));
    return module.exports;
  };
  return load;
};
const origin = 'https://approved.invalid', other = 'https://unconnected.invalid';
const privateUrl = 'wss://fixture-user:fixture-password@node.invalid:35998/private-rpc?apiKey=fixture-query#fixture-fragment';
const descriptor = 'wss://node.invalid:35998', address = 'synthetic-address';
const publicNodeUrl = loader()('src/services/utils/publicNodeUrl.js').default;
const cases = [
  [privateUrl, descriptor], ['ws://127.0.0.1:35998/path?token=x', 'ws://127.0.0.1:35998'],
  ['wss://name:pass@[::1]:35998/private', 'wss://[::1]:35998'], ['ws://localhost:80/', 'ws://localhost'],
  ['wss://node.invalid:443/', 'wss://node.invalid'], ['WSS://NODE.INVALID/a', 'wss://node.invalid'],
  ['wss://u%40ser:p%3Ass@node.invalid/a%2Fb?q=%23private#tail', 'wss://node.invalid'],
  ['wss://node.invalid', 'wss://node.invalid'], [' ws://localhost:1234/path ', 'ws://localhost:1234'],
  [null, null], [undefined, null], ['', null], [42, null], [{ toString: () => privateUrl }, null],
  ['https://node.invalid/path', null], ['javascript:fixture', null], ['wss://', null], ['wss://node.invalid:99999', null], ['relative/path', null],
];
for (const [input, expected] of cases) assert.equal(publicNodeUrl(input), expected);
const fixture = () => {
  const session = {}, local = {}, listeners = {}, delivered = [], waiting = new Map(), routes = new Map(), faults = {};
  const disk = new Map(), localStorage = { getItem: key => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, String(value)), removeItem: key => disk.delete(key) };
  let readGate, writeGate, serial = 0, prompts = 0;
  const locks = new Map();
  const navigator = { locks: { request: async (name, operation) => {
    const before = locks.get(name) || Promise.resolve(); let release;
    const after = new Promise(resolve => { release = resolve; }); locks.set(name, after);
    await before;
    try { return await operation(); }
    finally { release(); if (locks.get(name) === after) locks.delete(name); }
  } } };
  const storage = (area, values) => ({
    get: async key => {
      if (faults[area]) throw Error('synthetic storage unavailable');
      const value = Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, clone(values[k])]));
      if (readGate?.key === key) { const gate = readGate; readGate = null; gate.started.resolve(); await gate.release.promise; }
      return value;
    },
    set: async value => {
      if (writeGate && Object.hasOwn(value, writeGate.key)) { const gate = writeGate; writeGate = null; gate.started.resolve(); await gate.release.promise; }
      if (faults[area + 'Write']) throw Error('synthetic write unavailable');
      Object.assign(values, clone(value));
    },
    remove: async key => { for (const k of Array.isArray(key) ? key : [key]) delete values[k]; },
  });
  const event = key => ({ addListener: fn => { listeners[key] = fn; } });
  const sender = (site = origin, tabId = 1, documentId = 'doc-' + tabId) => ({ id: 'fixture', url: site + '/app', origin: site, tab: { id: tabId }, frameId: 0, documentId });
  const extension = { id: 'fixture', url: 'chrome-extension://fixture/popup.html' };
  const chrome = {
    runtime: { id: 'fixture', getURL: p => 'chrome-extension://fixture/' + p, onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup') },
    storage: { session: storage('session', session), local: storage('local', local) },
    windows: { onRemoved: event('windowRemoved'), create: async () => { prompts++; return { id: 10 }; }, getLastFocused: async () => ({}), update: async () => ({}), remove: async () => {} },
    tabs: { onRemoved: event('tabRemoved'), sendMessage: async (tabId, message, options) => {
      const route = routes.get(tabId);
      if (options?.documentId && route && route.documentId !== options.documentId) throw Error('Target document is gone');
      delivered.push({ tabId, message: clone(message), options: clone(options) });
      if (message.kind === 'response' && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
      route?.relay(message);
    } },
    alarms: { onAlarm: event('alarm'), create() {} },
  };
  const environment = { chrome, localStorage, navigator };
  const load = loader(environment); load('src/sections/Background/index.js');
  const internal = (method, params = {}) => new Promise((resolve, reject) => listeners.message({ channel: 'internal', method, params }, extension, response => response.error ? reject(Error(response.error)) : resolve(response.result)));
  chrome.runtime.sendMessage = (message, callback) => { listeners.message(message, extension, callback); };
  const request = (method, site = origin) => new Promise(resolve => {
    const id = ++serial; waiting.set(id, resolve);
    listeners.message({ channel: 'znn', kind: 'request', id, method, params: {} }, sender(site), () => {});
  });
  const permissions = load('src/sections/Background/permissions.js').default;
  const frames = load('src/sections/Background/frames.js').default;
  const unlock = () => { session['znn.unlock'] = { expiresAt: Date.now() + 60000 }; session['znn.publicState'] = { address, chainId: 7, nodeUrl: privateUrl }; };
  const page = (site = origin, tabId = 1, documentId = 'doc-' + tabId) => {
    const events = [], pageListeners = [], posted = []; let relay;
    const window = { location: { origin: site },
      addEventListener: (type, handler) => { if (type === 'message') pageListeners.push(handler); }, dispatchEvent() {},
      postMessage: message => { posted.push(clone(message)); queueMicrotask(() => pageListeners.forEach(fn => fn({ source: window, data: message }))); },
    };
    const contentChrome = { runtime: { ...chrome.runtime, onMessage: { addListener: fn => { relay = fn; } }, sendMessage: (message, callback) => listeners.message(message, sender(site, tabId, documentId), callback) } };
    const contentLoad = loader({ window, chrome: contentChrome }); contentLoad('src/sections/Content/index.js');
    routes.set(tabId, { documentId, relay: message => relay(message) }); contentLoad('src/sections/Inpage/index.js');
    window.zenon.on('nodeChanged', value => events.push(value));
    return { window, posted, events };
  };
  return { chrome, localStorage, session, local, faults, load, internal, request, permissions, frames, sender, delivered, unlock, page,
    prompts: () => prompts, holdRead: key => (readGate = { key, started: deferred(), release: deferred() }),
    holdWrite: key => (writeGate = { key, started: deferred(), release: deferred() }),
    permissionsRealm: () => loader(environment)('src/sections/Background/permissions.js').default };
};
(async () => {
  // Actual mutation methods in independent module realms share one lock. These
  // benign scheduling controls execute only the corrected candidate.
  for (const action of ['revoke', 'revokeAll']) {
    const f = fixture(); await f.permissions.grant(origin); await f.permissions.grant(other);
    const second = f.permissionsRealm(), gate = f.holdWrite('syrius.permissions');
    const updating = f.permissions.touch(origin); await gate.started.promise;
    let completed = false;
    const revoking = second[action](origin).then(value => { completed = true; return value; });
    await flush(); assert.equal(completed, false);
    gate.release.resolve(); assert.equal(await updating, true); assert.equal(await revoking, true);
    assert.equal(await second.isConnected(origin), false);
    assert.equal(await second.isConnected(other), action === 'revoke');
    assert.equal(await f.permissions.touch(origin), false);
  }
  {
    const f = fixture(); await f.permissions.grant(origin); const second = f.permissionsRealm();
    const gate = f.holdRead('syrius.permissions'), revoking = f.permissions.revoke(origin); await gate.started.promise;
    const updating = second.touch(origin); gate.release.resolve(); await revoking; assert.equal(await updating, false);
    assert.equal(await second.isConnected(origin), false);
    await Promise.all([f.permissions.grant(origin), second.grant(other)]); assert.equal((await f.permissions.list()).length, 2);
    const before = clone(f.local['syrius.permissions']); f.faults.local = true;
    await assert.rejects(f.permissions.grant('https://third.invalid'));
    await assert.rejects(f.permissions.revoke(origin)); await assert.rejects(f.permissions.touch(origin));
    assert.deepEqual(f.local['syrius.permissions'], before); assert.equal(await f.permissions.isConnected(origin), false);
    f.faults.local = false; f.faults.localWrite = true;
    await assert.rejects(f.permissions.grant('https://third.invalid')); await assert.rejects(f.permissions.revokeAll());
    assert.deepEqual(f.local['syrius.permissions'], before);
    f.faults.localWrite = false; assert.equal(await f.permissions.revoke(origin), true);
  }
  {
    const f = fixture(); f.unlock(); await f.permissions.grant(origin); f.faults.localWrite = true;
    assert.equal((await f.request('znn_disconnect')).error.code, -32603);
    await assert.rejects(f.internal('permissions.revoke', { origin })); await assert.rejects(f.internal('permissions.revokeAll'));
    assert.equal(await f.permissions.isConnected(origin), false, 'failed durable disconnect is denied by the session record');
    assert.equal(await f.permissionsRealm().isConnected(origin), false, 'fresh realm retains the session denial');
    assert.equal((await f.request('znn_nodeUrl')).result, null);
    assert.equal((await f.permissions.list())[0].revocationPending, true);
    f.faults.localWrite = false; assert.equal((await f.request('znn_disconnect')).result, true);
    assert.equal((await f.request('znn_nodeUrl')).result, null);
  }
  {
    const f = fixture(); f.unlock(); await f.permissions.grant(origin); await f.permissions.grant(other);
    f.faults.localWrite = true; await assert.rejects(f.permissions.revokeAll());
    const fresh = f.permissionsRealm(); assert.equal(await fresh.isConnected(origin), false); assert.equal(await fresh.isConnected(other), false);
    assert((await fresh.list()).every(x => x.revocationPending));
    f.faults.localWrite = false; await fresh.grant(origin);
    assert.equal(await fresh.isConnected(origin), true, 'explicit new consent can restore this origin');
    assert.equal(await fresh.isConnected(other), false, 'other failed withdrawals remain denied');
    assert.equal(await f.permissions.touch(other), false);
    await f.permissions.revokeAll(); assert.equal((await fresh.list()).length, 0);
  }
  {
    const f = fixture(); const gate = f.holdWrite('syrius.permissions');
    const granting = f.permissions.grant(origin); await gate.started.promise;
    f.faults.sessionWrite = true; gate.release.resolve(); await assert.rejects(granting);
    assert(f.local['syrius.permissions'][origin]);
    assert.equal(await f.permissionsRealm().isConnected(origin), false, 'failed grant activation retains persisted denial');
    f.faults.sessionWrite = false; await f.permissions.grant(origin); assert.equal(await f.permissions.isConnected(origin), true);
    f.faults.sessionWrite = true; assert.equal(await f.permissions.revoke(origin), true, 'durable withdrawal still works if session writes fail');
    assert.equal(f.local['syrius.permissions'][origin], undefined);
    assert.equal(await f.permissionsRealm().isConnected(origin), false);
  }
  {
    const f = fixture(); await f.permissions.grant(origin);
    f.faults.localWrite = true; f.faults.sessionWrite = true; await assert.rejects(f.permissions.revoke(origin));
    assert.equal(await f.permissions.isConnected(origin), false, 'the current worker fails closed if both stores refuse writes');
    f.faults.localWrite = false; f.faults.sessionWrite = false; await f.permissions.revoke(origin);
    assert.equal(await f.permissionsRealm().isConnected(origin), false);
  }
  {
    const f = fixture(); f.unlock(); const connecting = f.request('znn_connect'); await flush();
    const row = (await f.load('src/sections/Background/requests.js').default.list())[0]; assert(row);
    f.faults.localWrite = true;
    assert.equal(await f.internal('approvals.resolve', { id: row.id, result: [address], grantOrigin: true }), false);
    assert.equal((await connecting).error.code, -32603); assert.equal(f.local['syrius.permissions'], undefined);
  }
  {
    // Existing Settings handlers keep their rows and show an error when the
    // background cannot persist disconnection; the same buttons support retry.
    const f = fixture(); await f.permissions.grant(origin); await f.permissions.grant(other);
    const states = [], pendingEffects = [], notices = []; let cursor = 0, mounted = false, tree;
    const hooks = { ...React, useState: initial => {
      const i = cursor++; if (!(i in states)) states[i] = initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    }, useCallback: fn => fn, useEffect: fn => { if (!mounted) pendingEffects.push(fn); } };
    const load = loader({ chrome: f.chrome }, id => {
      if (id === 'react') return hooks;
      if (id.endsWith('/utils/notify')) return { notify: { success: value => notices.push({ success: value }), error: value => notices.push({ error: String(value) }) } };
    });
    const Component = load('src/pages/settings/connected-sites/connected-sites.js').default;
    const render = () => { cursor = 0; tree = Component(); mounted = true; while (pendingEffects.length) pendingEffects.shift()(); };
    const buttons = (node, out = []) => { if (Array.isArray(node)) node.forEach(x => buttons(x, out)); else if (node?.props) { if (node.type === 'button') out.push(node); buttons(node.props.children, out); } return out; };
    const click = async label => { const button = buttons(tree).find(x => String(x.props.children).trim() === label); assert(button); await button.props.onClick(); render(); };
    f.faults.local = true; render(); await flush(); render();
    assert(renderToStaticMarkup(tree).includes('Unable to load connected sites'));
    assert(!renderToStaticMarkup(tree).includes('No sites are connected'));
    f.faults.local = false; await click('Retry'); assert.equal(states[0].length, 2); notices.length = 0;
    f.faults.localWrite = true; await click('Disconnect'); await click('Disconnect all');
    assert.equal(states[0].length, 2); assert(renderToStaticMarkup(tree).includes('Access blocked. Retry disconnect.')); assert.equal(notices.filter(x => x.success).length, 0); assert.equal(notices.filter(x => x.error).length, 2);
    f.faults.localWrite = false; await click('Disconnect all'); assert.equal(states[0].length, 0); assert.equal(notices.filter(x => x.success).length, 1);
    assert.equal((await f.permissions.list()).length, 0);
  }
  {
    const f = fixture(); f.unlock();
    for (const method of ['znn_chainId', 'znn_nodeUrl']) assert.equal((await f.request(method)).result, null);
    assert.deepEqual((await f.request('znn_accounts')).result, []); assert.equal(f.prompts(), 0);
    await f.permissions.grant(origin);
    assert.equal((await f.request('znn_chainId')).result, 7); assert.equal((await f.request('znn_nodeUrl')).result, descriptor);
    assert.deepEqual((await f.request('znn_accounts')).result, [address]);
    assert.equal((await f.request('znn_nodeUrl', other)).result, null);
    for (const [input, expected] of cases) {
      if (input && typeof input === 'object') continue;
      f.session['znn.publicState'].nodeUrl = input; assert.equal((await f.request('znn_nodeUrl')).result, expected);
    }
    f.unlock(); await f.request('znn_disconnect');
    assert.equal((await f.request('znn_chainId')).result, null); assert.equal((await f.request('znn_nodeUrl')).result, null);
    await f.permissions.grant(origin); await f.internal('permissions.revoke', { origin }); assert.equal((await f.request('znn_nodeUrl')).result, null);
    await f.permissions.grant(origin); await f.internal('permissions.revokeAll'); assert.equal((await f.request('znn_chainId')).result, null);
    await f.permissions.grant(origin);
    for (const unlock of [undefined, { expiresAt: 0 }, { expiresAt: Date.now() - 1000 }]) {
      f.session['znn.unlock'] = unlock;
      assert.equal((await f.request('znn_chainId')).result, null); assert.equal((await f.request('znn_nodeUrl')).result, null);
    }
    f.unlock(); f.faults.local = true; assert.equal((await f.request('znn_nodeUrl')).result, null);
    f.faults.local = false; f.faults.session = true; assert.equal((await f.request('znn_chainId')).result, null);
    assert.equal(f.prompts(), 0);
  }
  for (const method of ['znn_chainId', 'znn_nodeUrl', 'znn_accounts']) {
    const f = fixture(); f.unlock(); await f.permissions.grant(origin);
    const gate = f.holdRead('znn.publicState'), reading = f.request(method); await gate.started.promise;
    await f.permissions.revoke(origin); gate.release.resolve();
    assert.deepEqual((await reading).result, method === 'znn_accounts' ? [] : null);
  }
  {
    const f = fixture(); f.unlock(); await f.permissions.grant(origin);
    await f.frames.register(f.sender(), origin); await f.frames.register(f.sender(other, 2), other);
    await f.internal('events.nodeChanged', { nodeUrl: privateUrl });
    assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].tabId, 1); assert.equal(f.delivered[0].message.data, descriptor); assert.equal(f.delivered[0].options.documentId, 'doc-1');
    await f.internal('events.nodeChanged', { nodeUrl: 'https://unsupported.invalid' }); assert.equal(f.delivered[1].message.data, null);
    f.delivered.length = 0;
    const gate = f.holdRead('znn.frames'), event = f.internal('events.nodeChanged', { nodeUrl: privateUrl }); await gate.started.promise;
    await f.permissions.revoke(origin); gate.release.resolve(); await event; assert.equal(f.delivered.length, 0);
    await f.internal('events.nodeChanged', { nodeUrl: privateUrl }); assert.equal(f.delivered.length, 0);
  }
  {
    const f = fixture(); f.unlock(); await f.permissions.grant(origin);
    f.page(origin, 1, 'old-document'); await flush(); const stale = clone(f.session['znn.frames']);
    const replacement = f.page(other, 1, 'new-document'); await flush();
    f.session['znn.frames'] = stale; f.delivered.length = 0;
    const emit = async () => {
      await f.internal('events.accountsChanged', { address });
      await f.internal('events.chainChanged', { chainId: 7 });
      await f.internal('events.nodeChanged', { nodeUrl: privateUrl }); await flush();
    };
    await emit(); assert.equal(f.delivered.length, 0); assert.equal(replacement.posted.filter(x => x.kind === 'event').length, 0);
    f.session['znn.frames'] = { '1:0': { origin, tabId: 1, frameId: 0 } };
    await emit(); assert.equal(f.delivered.length, 0, 'unbound legacy registry has no frame-only fallback');
    assert.equal(await f.frames.register({ ...f.sender(), documentId: undefined }, origin), false);
    await f.permissions.grant(other); await f.frames.register(f.sender(other, 1, 'new-document'), other);
    await emit(); assert.equal(f.delivered.length, 3); assert(f.delivered.every(x => x.options.documentId === 'new-document'));
    assert.deepEqual(replacement.events, [descriptor]);
    assert(replacement.posted.some(x => x.method === 'znn.addressChanged'));
    assert(replacement.posted.some(x => x.method === 'znn.chainIdChanged'));
    await f.permissions.revoke(other); f.delivered.length = 0; await emit(); assert.equal(f.delivered.length, 0);
  }
  {
    const f = fixture(); f.unlock(); const page = f.page(); await flush();
    assert.equal(await page.window.zenon.getChainId(), null); assert.equal(await page.window.zenon.getNodeUrl(), null);
    await f.permissions.grant(origin);
    assert.equal(await page.window.zenon.getChainId(), 7); assert.equal(await page.window.zenon.getNodeUrl(), descriptor);
    page.window.postMessage({ method: 'znn.requestWalletAccess' }); await flush();
    const grant = page.posted.find(x => x.method === 'znn.grantedWalletRead');
    assert.deepEqual(grant.data, { address, chainId: 7, nodeUrl: descriptor });
    await f.internal('events.nodeChanged', { nodeUrl: privateUrl }); await flush();
    assert.deepEqual(page.events, [descriptor]); assert.equal(page.posted.find(x => x.method === 'znn.nodeChanged').data.newNode, descriptor);
    assert(!JSON.stringify(page.posted).includes('fixture-password')); assert(!JSON.stringify(page.posted).includes('fixture-query'));
    await page.window.zenon.disconnect(); assert.equal(await page.window.zenon.getNodeUrl(), null);
    await f.internal('events.nodeChanged', { nodeUrl: privateUrl }); await flush(); assert.equal(page.events.length, 1); assert.equal(f.prompts(), 0);
  }
  {
    const f = fixture(); f.unlock(); f.localStorage.setItem('currentNodeUrl', privateUrl);
    const sdk = { Zenon: { getChainIdentifier: () => 7 } };
    const load = loader({ chrome: f.chrome, localStorage: f.localStorage }, id => id === 'znn-ts-sdk' ? sdk : undefined);
    const announce = load('src/services/wallet/announce.js');
    for (const publish of [() => announce.announceUnlock(address), () => announce.announceAddress(address), () => announce.announceChain(7, address), () => announce.announceNode(privateUrl, address)]) {
      await publish(); await flush(); assert.equal(f.session['znn.publicState'].nodeUrl, descriptor);
      assert.equal(f.localStorage.getItem('currentNodeUrl'), privateUrl);
    }
    await announce.announceLock(); assert.equal(f.session['znn.publicState'], undefined);
  }
  {
    const f = fixture(), calls = [], actions = [], failure = new Set(); f.localStorage.setItem('currentNodeUrl', privateUrl);
    const sdk = { Zenon: { getChainIdentifier: () => 7, getSingleton: () => ({ clearSocketConnection() {}, initialize: async url => { calls.push(url); if (failure.has(url)) throw Error('Synthetic connection unavailable'); } }) } };
    const hooks = { ...React, useState: value => [typeof value === 'function' ? value() : value, () => {}], useCallback: fn => fn, useContext: () => ({ showSpinner() {}, hideSpinner() {} }) };
    const load = loader({ chrome: f.chrome, localStorage: f.localStorage }, id => {
      if (id === 'znn-ts-sdk') return sdk;
      if (id === 'react') return hooks;
      if (id === 'react-redux') return { useDispatch: () => action => actions.push(action), useSelector: fn => fn({ wallet: { address } }) };
      if (id.endsWith('/spinnerContext')) return { SpinnerContext: {} };
      if (id.endsWith('/utils/notify')) return { notify: { error() {}, success() {} } };
      if (id === './vault') return { __esModule: true, default: {} };
    });
    const bootstrap = load('src/services/wallet/bootstrap.js');
    assert.equal(await bootstrap.connectToNode(action => actions.push(action)), true); assert.equal(calls.pop(), privateUrl);
    const useNodeList = load('src/services/hooks/useNodeList.js').default;
    const selected = 'wss://select-user:select-pass@second.invalid/private?key=select-query';
    assert.equal(await useNodeList().select(selected), true); assert.equal(calls.pop(), selected); assert.equal(f.localStorage.getItem('currentNodeUrl'), selected);
    assert(actions.some(x => x.type === 'connectionParameters/storeNodeUrl' && x.payload === selected));
    assert.equal(f.session['znn.publicState'].nodeUrl, 'wss://second.invalid');
    const failed = 'wss://failed-user:failed-pass@third.invalid/private?key=failed-query'; failure.add(failed);
    assert.equal(await useNodeList().select(failed), false); assert.deepEqual(calls.slice(-2), [failed, selected]);
    assert.equal(f.localStorage.getItem('currentNodeUrl'), selected); assert.equal(f.session['znn.publicState'].nodeUrl, 'wss://second.invalid');
  }
  {
    let first = true, closed = 0; const notices = [];
    const state = { wallet: { address, isUnlocked: true }, connectionParameters: { chainIdentifier: 7, nodeUrl: privateUrl } };
    const hooks = { ...React, useState: initial => [first ? (first = false, { id: 'consent', type: 'connect', origin, params: {} }) : initial, () => {}], useEffect() {}, useCallback: fn => fn };
    const load = loader({ window: { close: () => { closed++; } }, setTimeout: fn => setTimeout(fn, 0) }, id => {
      if (id === 'react') return hooks;
      if (id === 'react-redux') return { useSelector: fn => fn(state) };
      if (id === 'react-router-dom') return { useNavigate: () => () => {} };
      if (id === 'znn-ts-sdk') return { Zenon: {}, Primitives: {}, utils: {} };
      if (id.endsWith('/hooks/useAccount')) return { __esModule: true, default: () => ({ balanceMap: {} }) };
      if (id.endsWith('/hooks/useBlockSender')) return { __esModule: true, default: () => ({}) };
      if (id.endsWith('/utils/notify')) return { notify: { error: value => notices.push(String(value)) } };
      if (id.endsWith('/utils/messaging')) return { sendInternal: async method => method === 'approvals.resolve' ? false : null };
      if (id.endsWith('/wallet/vault') || id.endsWith('/wallet/signMessage') || id.endsWith('/utils/notify') || id.endsWith('/utils/messaging') || id.endsWith('/utils/contract-calls')) return {};
    });
    const Component = load('src/layouts/siteIntegrationLayout/siteIntegrationLayout.js').default;
    const tree = Component(), html = renderToStaticMarkup(tree);
    assert(html.includes(descriptor)); assert(html.includes('Node host')); assert(!html.includes('fixture-password')); assert(!html.includes('private-rpc'));
    const findConnect = node => Array.isArray(node) ? node.map(findConnect).find(Boolean) : node?.props ?
      (node.type === 'button' && String(node.props.children).trim() === 'Connect' ? node : findConnect(node.props.children)) : null;
    await findConnect(tree).props.onClick(); assert.equal(notices.length, 1); assert.equal(closed, 1);
  }
  console.log('provider state: document-bound events, persisted revocation denials, serialized permission mutations, honest disconnect/grant failures, actual Settings retry, current consent, revoked/locked reads, redacted publication and events, actual modern/legacy relay, private SDK selection/fallback and consent display passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
