'use strict';
// Corrected-candidate regression fixtures only: no real keys, external nodes,
// browser profiles, vulnerable baseline execution, or submitted transactions.
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const babel = require('@babel/core');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.join(__dirname, '..'), compiled = new Map();
const clone = value => value === undefined ? value : structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 20; i++) await tick(); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const loader = (environment, overrides = () => undefined) => {
  const cache = new Map();
  const load = file => {
    const filename = path.resolve(root, file);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    if (!compiled.has(filename)) compiled.set(filename, babel.transformFileSync(filename, { presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'], configFile: false, babelrc: false }).code);
    const req = id => {
      const replacement = overrides(id); if (replacement !== undefined) return replacement;
      if (!id.startsWith('.')) return require(id);
      const target = path.resolve(path.dirname(filename), id); return load(path.extname(target) ? target : target + '.js');
    };
    new Function('module', 'exports', 'require', ...Object.keys(environment), compiled.get(filename))(module, module.exports, req, ...Object.values(environment));
    return module.exports;
  };
  return load;
};
const fixture = () => {
  let now = 1000000, failSessionWrite = 0;
  class Clock extends Date { static now() { return now; } }
  const session = {}, local = {}, disk = new Map(), queues = new Map(), handlers = {}, changes = [];
  const messages = [], events = [], faults = {}, waits = new Map(), credentials = new Map();
  const hold = name => { const gate = { started: deferred(), release: deferred() }; waits.set(name, gate); return gate; };
  const pause = async name => { const gate = waits.get(name); if (gate) { waits.delete(name); gate.started.resolve(); await gate.release.promise; } };
  const locks = { request: async (name, fn) => {
    const previous = queues.get(name) || Promise.resolve(), done = deferred(); queues.set(name, done.promise);
    await previous; try { return await fn(); } finally { done.resolve(); if (queues.get(name) === done.promise) queues.delete(name); }
  } };
  const storage = (area, values) => ({
    get: async keys => { await pause(area + ':get'); if (faults[area + ':get']) throw Error('storage read failed'); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, clone(values[key])])); },
    set: async patch => {
      await pause(area + ':set');
      if (area === 'session' && failSessionWrite && --failSessionWrite === 0) throw Error('storage write failed');
      const delta = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { oldValue: clone(values[key]), newValue: clone(value) }]));
      Object.assign(values, clone(patch));
      for (const callback of changes) callback(delta, area);
    },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
  });
  const event = name => ({ addListener(fn) { handlers[name] = fn; } });
  const chrome = {
    runtime: { id: 'fixture', getURL: value => 'chrome-extension://fixture/' + value, onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup') },
    storage: { session: storage('session', session), local: storage('local', local), onChanged: { addListener(fn) { changes.push(fn); } } },
    tabs: { sendMessage: async (tabId, message, options) => { messages.push({ tabId, message: clone(message), options }); }, onRemoved: event('tabRemoved') },
    windows: { onRemoved: event('windowRemoved') }, alarms: { create() {}, onAlarm: event('alarm') },
  };
  const localStorage = { getItem: key => disk.get(key) ?? null, setItem: (key, value) => {
    if (faults.disk === true || faults.disk === key) throw Error('disk write failed'); disk.set(key, value);
  }, removeItem: key => disk.delete(key) };
  const sdk = { KeyStore: class {
    fromEntropy(entropy) { this.entropy = entropy; return this; }
    getKeyPair(index) { const entropy = this.entropy; return { getAddress: async () => { await pause('address'); return { toString: () => entropy + '-address-' + index }; } }; }
  }, KeyStoreManager: function () { return {
    readKeyStore: async (password, name) => { await pause('password'); if (password !== (credentials.has(name) ? credentials.get(name) : 'fixture')) throw Error('Error decrypting'); return new sdk.KeyStore().fromEntropy(name); },
    listAllKeyStores: () => JSON.parse(disk.get('znn.ts-wallet') || '{}'),
    saveKeyStore: async (store, password, name) => { await pause('savePassword'); credentials.set(name, password); events.push('password saved'); },
  }; }, Constants: { defaultChainId: 1 }, Primitives: { Address: { parse: value => ({ toString: () => value }) } }, Zenon: {
    getSingleton: () => ({ initialize: async () => pause('node'), clearSocketConnection() {} }), getChainIdentifier: () => 1,
  } };
  const env = { chrome, navigator: { locks }, crypto: crypto.webcrypto, Date: Clock, localStorage, setTimeout, clearTimeout };
  const realm = () => {
    const load = loader(env, id => {
      if (id === 'znn-ts-sdk') return sdk;
      if (id.endsWith('/utils/notify')) return { notify: { dismissAll: () => events.push('notifications cleared') } };
    });
    const api = load('src/services/wallet/session.js').default, vault = load('src/services/wallet/vault.js').default;
    const boot = load('src/services/wallet/bootstrap.js').completeUnlock;
    const unlock = async (name = 'A', extra = {}) => boot({ walletName: name, password: 'fixture', dispatch: action => events.push(action), ...extra });
    return { load, api, vault, boot, unlock };
  };
  const first = realm();
  first.load('src/sections/Background/index.js');
  const internal = async (method, params = {}) => {
    await pause('internal:' + method);
    return new Promise((resolve, reject) => handlers.message({ channel: 'internal', method, params },
      { id: 'fixture', url: 'chrome-extension://fixture/popup.html' }, response => response.error ? reject(Error(response.error)) : resolve(response.result)));
  };
  chrome.runtime.sendMessage = (message, callback) => internal(message.method, message.params).then(result => callback({ result }), error => callback({ error: error.message }));
  const sender = { id: 'fixture', url: 'https://fixture.invalid/app', origin: 'https://fixture.invalid', tab: { id: 1 }, frameId: 0 };
  local['syrius.permissions'] = { [sender.origin]: { origin: sender.origin } };
  let responseId = 0;
  const provider = async method => {
    const id = ++responseId; handlers.message({ channel: 'znn', kind: 'request', method, id }, sender, () => {});
    await flush(); return messages.find(item => item.message.kind === 'response' && item.message.id === id)?.message;
  };
  const register = async () => { handlers.message({ channel: 'znn', kind: 'hello' }, sender, () => {}); await flush(); };
  const ui = (file, context = first) => {
    const states = [], notices = [], navigations = [], refs = [], effects = []; let cursor, refCursor, effectCursor, tree;
    const hooks = { ...React,
      useRef: initial => { const i = refCursor++; return refs[i] ||= { current: initial }; },
      useEffect: fn => { const i = effectCursor++; if (!effects[i]) effects[i] = { fn, pending: true }; },
      useCallback: fn => fn,
      useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; } };
    const load = loader(env, id => {
      if (id === 'react') return hooks;
      if (id === 'react-router-dom') return { Routes: 'div', Route: 'div', useLocation: () => ({ pathname: '/' }), useNavigate: () => (...args) => navigations.push(args) };
      if (id === 'react-redux') return { useDispatch: () => action => events.push(action), useSelector: select => select({ wallet: { walletName: 'A' } }) };
      if (id === 'react-hook-form') return { useForm: () => ({ register: () => ({}), handleSubmit: fn => fn, formState: { errors: {} }, setError: (...args) => notices.push(args) }) };
      if (id === 'znn-ts-sdk') return sdk;
      if (id.endsWith('/wallet/lock')) return { __esModule: true, default: context.load('src/services/wallet/lock.js').default };
      if (id.endsWith('/wallet/bootstrap')) return context.load('src/services/wallet/bootstrap.js');
      if (id.endsWith('/hooks/useAccount')) return { invalidateAccountCache: () => events.push('cache cleared') };
      if (id.endsWith('/utils/devWallet')) return { isDevWalletBuild: false };
      if (/authLayout|tabsLayout|siteIntegrationLayout|dashboard-password|initial-node-selection|components\/splash/.test(id)) return { __esModule: true, default: () => null };
      if (id.endsWith('/wallet/session')) return { __esModule: true, default: context.api };
      if (id.endsWith('/wallet/vault')) return { __esModule: true, default: context.vault };
      if (id.endsWith('/utils/notify')) return { notify: { success: value => notices.push({ success: value }), error: value => notices.push({ error: String(value) }) } };
    });
    const Component = load(file).default;
    const render = () => { cursor = refCursor = effectCursor = 0; tree = Component({}); for (const effect of effects) if (effect.pending) { effect.pending = false; effect.fn(); } return tree; };
    const flatten = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(flatten) : [node, ...flatten(node.props?.children)];
    render(); return { render, notices, navigations, find: predicate => flatten(tree).find(predicate), all: () => flatten(tree) };
  };
  return { ...first, realm, ui, session, disk, env, sdk, messages, events, faults, hold, provider, internal, register, handlers,
    record: () => clone(session['znn.unlock']), public: () => clone(session['znn.publicState']),
    advance: ms => { now += ms; }, now: () => now, failWrite: (count = 1) => { failSessionWrite = count; } };
};
const watchdog = setTimeout(() => { console.error('Session policy checks timed out'); process.exit(1); }, 45000);
(async () => {
  for (const choice of [5, 15, 60]) {
    const f = fixture(); f.disk.set('syrius.settings', JSON.stringify({ autoLockMinutes: 60 })); await f.unlock();
    const before = f.record(); f.advance(10 * 60000); const old = f.api.capture();
    await f.api.updateSetting('autoLockMinutes', choice);
    assert.equal(f.record().expiresAt, Math.min(before.expiresAt, f.now() + choice * 60000));
    assert.equal(f.record().lastActiveAt, before.lastActiveAt);
    assert.equal(await f.api.touch(old), false);
    assert.deepEqual((await f.provider('znn_accounts')).result, ['A-address-0']);
    f.advance(1000); assert.equal(await f.api.touch(f.api.capture()), true);
    assert.equal(f.record().expiresAt, f.now() + choice * 60000);
  }
  {
    const f = fixture(); await f.unlock(); f.advance(13 * 60000); const before = f.record();
    await f.api.updateSetting('autoLockMinutes', 5); assert.equal(f.record().expiresAt, before.expiresAt);
    f.advance(2 * 60000); assert.equal(await f.api.load(), null);
    assert.equal(await f.api.touch(f.api.capture()), false);
    await f.api.updateSetting('autoLockMinutes', 60); assert.equal(f.record().mode, 'ended');
    assert.deepEqual((await f.provider('znn_accounts')).result, []);
  }
  {
    const f = fixture(); await f.unlock(); await f.register(); const original = f.record(), before = f.api.capture();
    await f.api.updateSetting('autoLockMinutes', 0);
    assert.equal(f.record().mode, 'local'); assert.equal('entropy' in f.record(), false); assert.equal(f.public(), null);
    assert.deepEqual(f.messages.at(-1).message.data, []); assert.equal(f.vault.isUnlocked(), true);
    const fresh = f.realm(); assert.equal(await fresh.api.load(), null);
    await assert.rejects(fresh.boot({ walletName: 'A', record: original, dispatch() {} }), /session changed/);
    await assert.rejects(fresh.api.updateSetting('autoLockMinutes', 15), /session changed/);
    assert.equal(await f.api.touch(before), false);
    await f.handlers.alarm({ name: 'znn.autoLock' }); assert.equal(f.record().mode, 'local');
    assert.equal(await f.api.touch(f.api.capture()), true); assert.equal('entropy' in f.record(), false);
    await f.api.updateSetting('autoLockMinutes', 5); assert.equal(f.record().entropy, 'A');
    assert.equal(f.record().expiresAt, f.now() + 300000); assert.deepEqual((await f.provider('znn_accounts')).result, ['A-address-0']);
    await fresh.boot({ walletName: 'A', record: await fresh.api.load(), dispatch() {} });
    assert.equal(fresh.vault.getWalletName(), 'A');
  }
  {
    const f = fixture(); await f.unlock(); const second = f.realm();
    await second.boot({ walletName: 'A', record: await second.api.load(), dispatch() {} });
    const oldFirst = f.api.capture(), oldSecond = second.api.capture();
    await f.api.updateSetting('autoLockMinutes', 5);
    assert.equal(await second.api.touch(oldSecond), false); assert.equal(await f.api.touch(oldFirst), false);
    assert.equal(await second.api.touch(second.api.capture()), true);
    assert.equal(f.record().expiresAt, f.now() + 300000);
  }
  for (const key of ['autoLockMinutes', 'hideBalances']) {
    const f = fixture(); await f.unlock(); const before = f.record(); f.faults.disk = 'syrius.settings';
    await assert.rejects(f.api.updateSetting(key, key === 'autoLockMinutes' ? 5 : true), /save settings/);
    assert.equal(f.api.capture() !== null, true);
    assert.equal(f.disk.has('syrius.settings'), false);
    if (key === 'autoLockMinutes') {
      assert.equal(f.record().expiresAt, f.now() + 300000);
      await f.api.touch(f.api.capture()); assert.equal(f.record().expiresAt, f.now() + 300000);
    } else assert.deepEqual(f.record(), before);
  }
  for (const original of [0, 5]) {
    const f = fixture(); f.disk.set('syrius.settings', JSON.stringify({ autoLockMinutes: original })); await f.unlock();
    f.faults.disk = 'syrius.settings'; await assert.rejects(f.api.updateSetting('autoLockMinutes', 60), /save settings/);
    assert.equal(f.record().minutes, original); assert.equal(Boolean(f.record().entropy), original > 0);
    await f.api.touch(f.api.capture()); assert.equal(f.record().expiresAt, original ? f.now() + original * 60000 : 0);
  }
  {
    const f = fixture(); await f.unlock(); const before = f.record(); f.failWrite();
    await assert.rejects(f.api.updateSetting('autoLockMinutes', 5), /storage write failed/);
    assert.deepEqual(f.record(), before); assert.equal(f.disk.has('syrius.settings'), false);
    await f.api.updateSetting('autoLockMinutes', 0); f.failWrite(2);
    await assert.rejects(f.api.updateSetting('autoLockMinutes', 60), /storage write failed/);
    assert.equal(f.record().mode, 'local'); assert.equal('entropy' in f.record(), false);
    assert.equal(JSON.parse(f.disk.get('syrius.settings')).autoLockMinutes, 60);
    await f.api.updateSetting('autoLockMinutes', 60); assert.equal(f.record().mode, 'timed');
  }
  {
    const f = fixture(); await f.unlock(); const original = f.record(), second = f.realm();
    const gate = f.hold('address'); const restoring = second.boot({ walletName: 'A', record: original, dispatch() {} });
    await gate.started.promise; await f.api.updateSetting('autoLockMinutes', 0); gate.release.resolve();
    await assert.rejects(restoring, /session changed/); assert.equal(second.vault.isUnlocked(), false);
    assert.equal(await second.api.clear(original), null); assert.equal(f.record().mode, 'local');
  }
  {
    const f = fixture(); const gate = f.hold('password'); const unlocking = f.unlock();
    await gate.started.promise; await f.api.updateSetting('autoLockMinutes', 5); gate.release.resolve();
    await assert.rejects(unlocking, /session changed/); assert.equal(f.vault.isUnlocked(), false);
    await f.unlock(); assert.equal(f.record().expiresAt, f.now() + 300000);
    const old = f.record(); const fresh = f.realm(); await fresh.unlock('B');
    assert.equal(await f.api.clear(old), null); assert.equal(f.record().walletName, 'B');
  }
  {
    const f = fixture(); await f.unlock(); const activity = f.api.capture(), gate = f.hold('address');
    let committed = false; const selecting = f.api.select(activity, 1, 2, () => { committed = true; });
    await gate.started.promise; await f.api.updateSetting('autoLockMinutes', 5); gate.release.resolve();
    await assert.rejects(selecting, /session changed/); assert.equal(committed, false); assert.equal(f.vault.getSelectedIndex(), 0);
    const token = await f.api.select(f.api.capture(), 1, 2, address => assert.equal(address, 'A-address-1'));
    await f.load('src/services/wallet/announce.js').announceAddress(token);
    assert.deepEqual((await f.provider('znn_accounts')).result, ['A-address-1']);
  }
  for (const type of ['node', 'address']) {
    const f = fixture(); await f.unlock(); const activity = f.api.capture(), gate = f.hold(type);
    const work = type === 'node' ? f.load('src/services/wallet/bootstrap.js').connectToNode(() => {}, activity).then(() => f.load('src/services/wallet/announce.js').announceNode(activity)) :
      f.load('src/services/wallet/announce.js').announceAddress(activity);
    await gate.started.promise; await f.api.updateSetting('autoLockMinutes', 0); gate.release.resolve(); await work;
    assert.equal(f.public(), null); assert.equal('entropy' in f.record(), false);
  }
  {
    const f = fixture(); await f.unlock(); await f.register(); const token = f.api.capture();
    await f.api.updateSetting('autoLockMinutes', 0); const count = f.messages.length;
    await f.internal('events.accountsChanged', { token, address: 'old address' });
    await f.internal('events.nodeChanged', { token, nodeUrl: 'old node' });
    assert.equal(f.messages.length, count); assert.equal((await f.provider('znn_nodeUrl')).result, null);
  }
  {
    const f = fixture(); await f.unlock(); const gate = f.hold('session:get');
    const reduction = f.api.updateSetting('autoLockMinutes', 5); await gate.started.promise;
    const stale = f.api.capture(); const renewal = f.api.touch(stale); gate.release.resolve();
    await reduction; assert.equal(await renewal, false); assert.equal(f.record().expiresAt, f.now() + 300000);
    await Promise.all([f.api.updateSetting('hideBalances', true), f.api.updateSetting('autoLockMinutes', 0)]);
    assert.deepEqual(JSON.parse(f.disk.get('syrius.settings')), { autoLockMinutes: 0, hideBalances: true, autoReceive: true, explorer: 'zenonhub' });
  }
  {
    const f = fixture(); await f.unlock(); f.advance(14 * 60000); const gate = f.hold('session:get');
    const renewal = f.api.touch(f.api.capture()); await gate.started.promise; f.advance(60000); gate.release.resolve();
    assert.equal(await renewal, false); await f.handlers.alarm({ name: 'znn.autoLock' }); assert.equal(f.record().mode, 'ended');
    await f.unlock('B'); const current = f.record(); await f.handlers.alarm({ name: 'znn.autoLock' }); assert.deepEqual(f.record(), current);
  }
  {
    const f = fixture(); await f.unlock(); const ui = f.ui('src/pages/settings/settings/settings.js');
    f.failWrite(); await ui.find(node => node.type === 'button' && node.props.children === '5 min').props.onClick(); ui.render();
    assert(ui.notices.some(item => item.error)); assert(ui.find(node => node.type === 'button' && node.props.children === '15 min').props.className.includes('is-selected'));
    await ui.find(node => node.type === 'button' && node.props.children === '5 min').props.onClick(); ui.render();
    assert(ui.find(node => node.type === 'button' && node.props.children === '5 min').props.className.includes('is-selected'));
  }
  {
    const f = fixture(); await f.unlock(); const ui = f.ui('src/pages/settings/change-password/change-password.js');
    ui.find(node => node.type === 'input' && node.props.placeholder === 'Current password').props.onChange({ target: { value: 'fixture' } }); ui.render();
    const gate = f.hold('savePassword'); const saving = ui.find(node => node.type === 'form').props.onSubmit();
    await gate.started.promise; await f.api.updateSetting('autoLockMinutes', 5); const shorter = f.record(); gate.release.resolve(); await saving;
    assert.deepEqual(f.record(), shorter); assert(ui.notices.some(item => item.success === 'Password changed'));
    assert(f.events.includes('password saved'));
  }
  for (const failure of ['session:get', 'session:set']) {
    const f = fixture(); await f.unlock(); const lock = f.load('src/services/wallet/lock.js').default;
    if (failure.endsWith('get')) f.faults[failure] = true; else f.failWrite();
    const locking = lock(); assert.equal(f.vault.isUnlocked(), false);
    await assert.rejects(locking, /Could not lock the shared/);
    assert(f.events.includes('notifications cleared')); assert.equal(f.record().mode, 'timed');
    delete f.faults[failure]; await lock(); assert.equal(f.record().mode, 'ended');
  }
  {
    const f = fixture(); await f.unlock(); const second = f.realm();
    await second.boot({ walletName: 'A', record: await second.api.load(), dispatch() {} });
    await second.api.select(second.api.capture(), 1, 2, () => {});
    assert.equal(f.vault.getSelectedIndex(), 0); assert.equal(f.record().selectedAddressIndex, 1);
    await f.load('src/services/wallet/lock.js').default(); assert.equal(f.record().mode, 'ended');
    await second.unlock('B'); const current = f.record();
    await f.load('src/services/wallet/lock.js').default(); assert.deepEqual(f.record(), current);
  }
  {
    const f = fixture(); await f.unlock(); const token = await f.api.select(f.api.capture(), 1, 2, () => {});
    assert.equal(f.public(), null); const gate = f.hold('address');
    const announcing = f.load('src/services/wallet/announce.js').announceAddress(token);
    await gate.started.promise; await f.api.updateSetting('autoLockMinutes', 5); gate.release.resolve(); await announcing;
    assert.deepEqual((await f.provider('znn_accounts')).result, ['A-address-1']);
    assert.equal(f.public().token.revision, f.record().revision);
  }
  {
    const f = fixture(); await f.unlock(); const ui = f.ui('src/components/burger-popover/burger-popover.js');
    f.failWrite(); await ui.find(node => node.props?.children === 'Lock wallet').props.onClick();
    assert.equal(f.vault.isUnlocked(), false); assert(ui.notices.some(item => item.error));
    assert.equal(ui.navigations.at(-1)[0], '/password');
  }
  {
    const f = fixture(); await f.unlock(); f.disk.set('znn.ts-wallet', JSON.stringify({ A: { encrypted: 'fixture' } }));
    const ui = f.ui('src/pages/settings/reset-wallet/reset-wallet.js');
    ui.find(node => node.type === 'input' && node.props.placeholder === 'Wallet password').props.onChange({ target: { value: 'fixture' } });
    ui.find(node => node.type === 'input' && node.props.placeholder === 'Type REMOVE to confirm').props.onChange({ target: { value: 'REMOVE' } }); ui.render();
    f.failWrite(); await ui.find(node => node.type === 'button' && node.props.children === 'Remove').props.onClick();
    assert.equal(f.vault.isUnlocked(), false); assert(JSON.parse(f.disk.get('znn.ts-wallet')).A);
    assert(ui.notices.some(item => item.error)); assert.equal(ui.navigations.at(-1)[0], '/password');
  }
  {
    const f = fixture(); f.disk.set('znn.ts-wallet', JSON.stringify({ A: { encrypted: 'fixture' } }));
    f.disk.set('currentNodeUrl', 'wss://fixture.invalid'); f.faults['session:get'] = true;
    const ui = f.ui('src/layouts/mainLayout/mainLayout.js'); await flush(); ui.render();
    assert(ui.notices.some(item => item.error)); assert.equal(ui.navigations.at(-1)[0], '/password');
    assert.equal(f.vault.isUnlocked(), false);
  }
  // A failed timed -> On close transition keeps BOTH restrictions: no
  // resumable entropy and the old finite owner deadline, until a saved retry.
  for (const failure of ['preference', 'final-session']) {
    const f = fixture(); await f.unlock(); const before = f.record();
    if (failure === 'preference') f.faults.disk = 'syrius.settings'; else f.failWrite(2);
    await assert.rejects(f.api.updateSetting('autoLockMinutes', 0), /save settings|storage write failed/);
    assert.equal(f.record().mode, 'local'); assert.equal(f.record().privateUntil, before.expiresAt);
    assert.equal('entropy' in f.record(), false); assert.equal(f.public(), null);
    const fresh = f.realm(); assert.equal(await fresh.api.load(), null);
    f.advance(1000); assert.equal(await f.api.touch(f.api.capture()), true);
    assert.equal(f.record().privateUntil, before.expiresAt); assert.equal('entropy' in f.record(), false);
    await f.api.select(f.api.capture(), 1, 2, () => {});
    assert.equal(f.record().privateUntil, before.expiresAt); assert.equal('entropy' in f.record(), false);
    f.advance(before.expiresAt - f.now());
    assert.equal(await f.api.isCurrent(f.api.capture()), false); assert.equal(await f.api.touch(f.api.capture()), false);
    await f.handlers.alarm({ name: 'znn.autoLock' }); assert.equal(f.record().mode, 'ended');
  }
  {
    const f = fixture(); await f.unlock(); f.faults.disk = 'syrius.settings';
    await assert.rejects(f.api.updateSetting('autoLockMinutes', 0)); delete f.faults.disk;
    await f.api.updateSetting('autoLockMinutes', 0);
    assert.equal('privateUntil' in f.record(), false); assert.equal('entropy' in f.record(), false);
    f.advance(3600000); assert.equal(await f.api.isCurrent(f.api.capture()), true);
  }
  {
    const f = fixture(); await f.unlock(); const before = f.record(); f.faults.disk = 'syrius.settings';
    await assert.rejects(f.api.updateSetting('autoLockMinutes', 0)); delete f.faults.disk;
    f.advance(1000); await f.api.updateSetting('autoLockMinutes', 60);
    assert.equal(f.record().expiresAt, before.expiresAt); assert.equal(f.record().entropy, 'A');
  }
  {
    const f = fixture(); await f.unlock(); const ui = f.ui('src/pages/settings/settings/settings.js');
    f.faults.disk = 'syrius.settings'; await ui.find(node => node.type === 'button' && node.props.children === 'On close').props.onClick(); ui.render();
    assert(ui.notices.some(item => item.error)); assert(ui.find(node => node.type === 'button' && node.props.children === '15 min').props.className.includes('is-selected'));
    assert(f.record().privateUntil); assert.equal('entropy' in f.record(), false);
  }
  // Required startup persistence fails before adoption. Optional node/public
  // advertisement failure leaves a successful, truthful unlocked screen.
  for (const failure of ['last-wallet', 'node-url', 'publication-read', 'publication-write']) {
    const f = fixture(); await f.unlock(); f.disk.set('znn.ts-wallet', JSON.stringify({ A: { encrypted: 'fixture' } }));
    const second = f.realm(); let gate;
    if (failure === 'last-wallet') f.faults.disk = 'syrius.lastWalletName';
    if (failure === 'node-url') f.faults.disk = 'currentNodeUrl';
    if (failure.startsWith('publication')) gate = f.hold('node');
    const ui = f.ui('src/layouts/mainLayout/mainLayout.js', second);
    if (gate) {
      await gate.started.promise; assert.equal(second.vault.isUnlocked(), true);
      if (failure === 'publication-read') f.faults['session:get'] = true; else f.failWrite();
      gate.release.resolve();
    }
    await flush(); ui.render();
    if (failure === 'last-wallet') {
      assert.equal(second.vault.isUnlocked(), false); assert.equal(f.record().mode, 'ended');
      assert.equal(ui.navigations.at(-1)[0], '/password');
    } else {
      assert.equal(second.vault.isUnlocked(), true); assert.equal(f.record().mode, 'timed');
      assert.equal(ui.navigations.at(-1)[0], '/tabs/dashboard'); assert.equal(ui.notices.length, 0);
    }
  }
  // Both directions across local/timed authority stage the intersection.
  // A persisted finite preference must never hide an unbounded local owner.
  for (const failure of ['preference', 'final-session']) {
    const f = fixture(); f.disk.set('syrius.settings', JSON.stringify({ autoLockMinutes: 0 })); await f.unlock();
    const deadline = f.now() + 300000;
    if (failure === 'preference') f.faults.disk = 'syrius.settings'; else f.failWrite(2);
    await assert.rejects(f.api.updateSetting('autoLockMinutes', 5), /save settings|storage write failed/);
    assert.equal(f.record().mode, 'local'); assert.equal(f.record().privateUntil, deadline);
    assert.equal('entropy' in f.record(), false); assert.equal(f.public(), null);
    const remounted = f.ui('src/pages/settings/settings/settings.js');
    const shown = failure === 'preference' ? 'On close' : '5 min';
    assert(remounted.find(node => node.type === 'button' && node.props.children === shown).props.className.includes('is-selected'));
    f.advance(1000); await f.api.touch(f.api.capture()); assert.equal(f.record().privateUntil, deadline);
    await f.api.select(f.api.capture(), 1, 2, () => {}); assert.equal(f.record().privateUntil, deadline);
    f.advance(deadline - f.now()); assert.equal(await f.api.isCurrent(f.api.capture()), false);
    assert.equal(await f.api.touch(f.api.capture()), false);
    await f.handlers.alarm({ name: 'znn.autoLock' }); assert.equal(f.record().mode, 'ended');
  }
  {
    const f = fixture(); f.disk.set('syrius.settings', JSON.stringify({ autoLockMinutes: 0 })); await f.unlock();
    f.failWrite(2); await assert.rejects(f.api.updateSetting('autoLockMinutes', 5)); const deadline = f.record().privateUntil;
    f.advance(1000); await f.api.updateSetting('autoLockMinutes', 5);
    assert.equal(f.record().expiresAt, deadline); assert.equal(f.record().entropy, 'A');
  }
  for (const failure of ['session:get', 'session:set']) {
    const f = fixture(); await f.unlock(); const before = f.record();
    const ui = f.ui('src/pages/settings/change-password/change-password.js');
    ui.find(node => node.type === 'input' && node.props.placeholder === 'Current password').props.onChange({ target: { value: 'fixture' } });
    ui.find(node => node.type === 'input' && node.props.placeholder === 'New password').props.onChange({ target: { value: 'new-fixture-password' } }); ui.render();
    const gate = f.hold('savePassword'); const saving = ui.find(node => node.type === 'form').props.onSubmit();
    await gate.started.promise;
    if (failure.endsWith('get')) f.faults[failure] = true; else f.failWrite();
    gate.release.resolve(); await saving;
    assert(f.events.includes('password saved')); assert(ui.notices.some(item => item.success === 'Password changed'));
    assert.equal(ui.notices.filter(item => item.error).length, 0); assert.equal(ui.navigations.at(-1)[0], '/tabs/settings');
    assert.equal(await f.vault.verifyPassword('fixture'), false); assert.equal(await f.vault.verifyPassword('new-fixture-password'), true);
    assert.deepEqual(f.record(), before);
  }
  // Installed pinned SDK derivation/entropy compatibility with public fixture
  // entropy only. The SDK connection remains an inert facade; no RPC exists.
  {
    global.window = { crypto: crypto.webcrypto }; global.self = global.window;
    const sdkDisk = new Map();
    global.localStorage = { getItem: key => sdkDisk.get(key) ?? null, setItem: (key, value) => sdkDisk.set(key, value) };
    const realSdk = require('znn-ts-sdk'), f = fixture();
    f.sdk.KeyStore = realSdk.KeyStore;
    const entropy = '00'.repeat(32); await f.unlock(entropy);
    const first = (await new realSdk.KeyStore().fromEntropy(entropy).getKeyPair(0).getAddress()).toString();
    assert.equal(f.public().address, first);
    await f.api.updateSetting('autoLockMinutes', 0); assert.equal('entropy' in f.record(), false);
    await f.api.updateSetting('autoLockMinutes', 5);
    const second = f.realm(); await second.boot({ walletName: entropy, record: await second.api.load(), dispatch() {} });
    const token = await second.api.select(second.api.capture(), 1, 2, () => {});
    await second.load('src/services/wallet/announce.js').announceAddress(token);
    const selected = (await new realSdk.KeyStore().fromEntropy(entropy).getKeyPair(1).getAddress()).toString();
    assert.equal(f.public().address, selected); assert.notEqual(first, selected);
    delete global.localStorage; delete global.window; delete global.self;
  }
  console.log('Session policy regression checks passed: deadlines, owners, revisions, storage failures, worker reads/events, restore, selection, and real settings/password callbacks.');
})().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
