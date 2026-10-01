'use strict';
// Corrected-candidate regression fixtures only: no real keys, external nodes,
// browser profiles, vulnerable baseline execution, or submitted transactions.
//
// Ported onto the integrated session layer (live-vault lease + lock policy in
// the lease record). The branch this came from rejected any callback holding a
// pre-change policy token; here the policy lives in the shared record and every
// renewal reads it under the lease lock, so the property checked is the one
// that matters — a stale or concurrent callback can never extend authority past
// the current policy — rather than the token rejection itself. Scenarios whose
// outcome differs by design (session-storage failure purges this document's
// keys; a failed lock shows MainLayout's retry screen) say so where they are.
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const babel = require('@babel/core');
const React = require('react');
const root = path.join(__dirname, '..'), compiled = new Map();
const binding = require('./fixtures/document-binding-stub');
const clone = value => value === undefined ? value : structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 20; i++) await tick(); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
// `overrides(id, target)` sees the bare id and, for a relative import, the file
// it resolves to — so a UI realm can share the wallet realm's service modules.
const loader = (environment, overrides = () => undefined) => {
  const cache = new Map();
  const load = file => {
    const filename = path.resolve(root, file);
    if (filename.endsWith('.json')) return require(filename); // e.g. contract-call schemas
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    if (!compiled.has(filename)) compiled.set(filename, babel.transformFileSync(filename, { presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'], configFile: false, babelrc: false }).code);
    const req = id => {
      const target = id.startsWith('.') ? path.resolve(path.dirname(filename), id) : null;
      const file = target && (path.extname(target) ? target : target + '.js');
      const replacement = overrides(id, file); if (replacement !== undefined) return replacement;
      if (!file) return require(id);
      return load(file);
    };
    new Function('module', 'exports', 'require', ...Object.keys(environment), compiled.get(filename))(module, module.exports, req, ...Object.values(environment));
    return module.exports;
  };
  return load;
};
const fixture = () => {
  let now = 1000000, failSessionWrite = 0, failingSessionWrites = 0;
  class Clock extends Date { static now() { return now; } }
  const session = {}, local = {}, disk = new Map(), queues = new Map(), handlers = {}, changes = [];
  const messages = [], events = [], faults = {}, waits = new Map();
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
      if (area === 'session' && failingSessionWrites > 0 && 'znn.unlock' in patch) { failingSessionWrites--; throw Error('storage write failed'); }
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
    tabs: { sendMessage: async (tabId, message, options) => {
      if (message.kind !== 'probe') messages.push({ tabId, message: clone(message), options });
      return binding.relayReply(message, () => now);
    }, onRemoved: event('tabRemoved') },
    windows: { onRemoved: event('windowRemoved') }, alarms: { create() {}, onAlarm: event('alarm') },
    webNavigation: { onBeforeNavigate: event('navigate') },
  };
  const localStorage = { getItem: key => disk.get(key) ?? null, setItem: (key, value) => {
    if (faults.disk === true || faults.disk === key) throw Error('disk write failed'); disk.set(key, value);
  }, removeItem: key => disk.delete(key) };
  const savedPassword = name => JSON.parse(disk.get('znn.ts-wallet') || '{}')[name]?.fixturePassword ?? 'fixture';
  const sdk = { KeyStore: class {
    fromEntropy(entropy) { this.entropy = entropy; return this; }
    getKeyPair(index) { const entropy = this.entropy; return { getAddress: async () => { await pause('address'); return { toString: () => entropy + '-address-' + index }; } }; }
  }, KeyStoreManager: function () { return {
    walletPath: 'znn.ts-wallet',
    readKeyStore: async (password, name) => { await pause('password'); if (password !== savedPassword(name)) throw Error('Error decrypting'); return new sdk.KeyStore().fromEntropy(name); },
    listAllKeyStores: () => JSON.parse(disk.get('znn.ts-wallet') || '{}'),
  }; }, KeyFile: { encrypt: async (store, password) => { await pause('savePassword'); events.push('password saved'); return { fixturePassword: password }; } },
  Constants: { defaultChainId: 1 }, Primitives: { Address: { parse: value => ({ toString: () => value }) } }, Zenon: {
    getSingleton: () => ({ initialize: async () => pause('node'), clearSocketConnection() {} }), getChainIdentifier: () => 1,
  } };
  // The vault arms a real expiry timer; the fixture clock drives expiry, so
  // those timers must not keep the process alive.
  const timer = (fn, ms) => { const handle = setTimeout(fn, Math.min(ms, 2147483647)); handle.unref(); return handle; };
  const env = { chrome, navigator: { locks }, crypto: crypto.webcrypto, Date: Clock, localStorage, setTimeout: timer, clearTimeout };
  const realm = () => {
    const load = loader(env, id => {
      if (binding.isNavigation(id)) return binding.navigationStub;
      if (id === 'znn-ts-sdk') return sdk;
      if (id.endsWith('/utils/notify')) return { notify: { dismissAll: () => events.push('notifications cleared') } };
    });
    const session = load('src/services/wallet/session.js').default, vault = load('src/services/wallet/vault.js').default;
    const boot = ({ record, ...rest }) => load('src/services/wallet/bootstrap.js').completeUnlock({ ...rest, sessionRecord: record });
    const { updateSetting } = load('src/services/wallet/preferences.js');
    // The same step as the Settings > Addresses screen: a new selection
    // generation, with the saved selection written first.
    const select = async (index, maxAddressIndex) => {
      await vault.selectAddress(index, maxAddressIndex);
      return vault.capture();
    };
    const api = {
      capture: () => { try { return vault.capture(); } catch (error) { return null; } },
      touch: () => vault.touch().then(() => true, () => false),
      isCurrent: () => vault.assertSession().then(() => true, () => false),
      load: () => session.load(), clear: expected => session.clear(expected), updateSetting, select,
    };
    const unlock = async (name = 'A', extra = {}) => boot({ walletName: name, password: 'fixture', dispatch: action => events.push(action), ...extra });
    return { load, api, session, vault, boot, unlock };
  };
  const first = realm();
  first.load('src/sections/Background/index.js');
  const internal = async (method, params = {}) => {
    await pause('internal:' + method);
    return new Promise((resolve, reject) => handlers.message({ channel: 'internal', method, params },
      { id: 'fixture', url: 'chrome-extension://fixture/popup.html' }, response => response.error ? reject(Error(response.error)) : resolve(response.result)));
  };
  chrome.runtime.sendMessage = (message, callback) => internal(message.method, message.params).then(result => callback({ result }), error => callback({ error: error.message }));
  // Chrome's native document identity: replies are bound to it (#8).
  const sender = { id: 'fixture', url: 'https://fixture.invalid/app', origin: 'https://fixture.invalid', tab: { id: 1 }, frameId: 0, documentId: 'fixture-document' };
  // Consent is per wallet account (#11); the scenarios read accounts 0 and 1
  // of wallet A. A fixture wallet's seed is its name, so its addresses follow.
  const scopeFor = (name, index) => ({ walletName: name, walletId: name + '-address-0', address: name + '-address-' + index, index });
  local['syrius.permissions'] = { version: 2, entries: [0, 1].map(index => ({ active: true, origin: sender.origin,
    scope: scopeFor('A', index), title: '', favicon: '', connectedAt: 1, lastUsedAt: 1 })) };
  let responseId = 0;
  const provider = async method => {
    const id = ++responseId; handlers.message({ channel: 'znn', kind: 'request', method, id, ...binding.documentFields() }, sender, () => {});
    await flush(); return messages.find(item => item.message.kind === 'response' && item.message.id === id)?.message;
  };
  const register = async () => { handlers.message({ channel: 'znn', kind: 'hello', activation: binding.activation }, sender, () => {}); await flush(); };
  const ui = (file, context = first, extra = () => undefined) => {
    const states = [], notices = [], navigations = [], refs = [], effects = []; let cursor, refCursor, effectCursor, tree;
    const hooks = { ...React,
      useRef: initial => { const i = refCursor++; return refs[i] ||= { current: initial }; },
      useEffect: (fn, deps) => { const i = effectCursor++; if (!effects[i]) effects[i] = { fn, pending: true }; },
      useCallback: fn => fn,
      useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; } };
    const load = loader(env, (id, file) => {
      const replaced = extra(id); if (replaced !== undefined) return replaced;
      if (binding.isNavigation(id)) return binding.navigationStub;
      if (id === 'react') return hooks;
      if (id === 'react-router-dom') return { Routes: 'div', Route: 'div', useLocation: () => ({ pathname: '/' }), useNavigate: () => (...args) => navigations.push(args) };
      if (id === 'react-redux') return { useDispatch: () => action => events.push(action), useSelector: select => select({ wallet: { walletName: 'A' } }),
        useStore: () => ({ getState: () => ({ wallet: { walletName: 'A', maxAddressIndex: 1, selectedAddressIndex: 0 } }) }) };
      if (id === 'react-hook-form') return { useForm: () => ({ register: () => ({}), handleSubmit: fn => fn, formState: { errors: {} }, setError: (...args) => notices.push(args), setValue() {} }) };
      if (id === 'znn-ts-sdk') return sdk;
      if (id.endsWith('/utils/notify')) return { notify: { dismissAll() {}, success: value => notices.push({ success: value }), error: value => notices.push({ error: String(value?.message || value) }) } };
      if (id.endsWith('/hooks/useAccount')) return { invalidateAccountCache: () => events.push('cache cleared') };
      if (id.endsWith('/utils/devWallet')) return { isDevWalletBuild: false };
      if (/authLayout|tabsLayout|siteIntegrationLayout|dashboard-password|initial-node-selection|components\/splash/.test(id)) return { __esModule: true, default: () => null };
      // Services are the wallet realm's own instances, not fresh copies.
      if (file && file.includes(path.join('src', 'services', path.sep).slice(0, -1) + path.sep) && !file.includes('redux')) return context.load(file);
    });
    const Component = load(file).default;
    const render = () => { cursor = refCursor = effectCursor = 0; tree = Component({}); for (const effect of effects) if (effect.pending) { effect.pending = false; effect.fn(); } return tree; };
    const flatten = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(flatten) : [node, ...flatten(node.props?.children)];
    render(); return { render, notices, navigations, find: predicate => flatten(tree).find(predicate), all: () => flatten(tree), tree: () => tree };
  };
  return { ...first, realm, ui, session, disk, env, sdk, messages, events, faults, hold, provider, internal, register, handlers,
    record: () => clone(session['znn.unlock']), public: () => clone(session['znn.publicState']),
    advance: ms => { now += ms; }, now: () => now,
    // failWrite(n): the nth session write from now fails. failWrites(n): the
    // next n writes of the session record itself all fail.
    failWrite: (count = 1) => { failSessionWrite = count; }, failWrites: count => { failingSessionWrites = count; } };
};
const ended = record => record?.locked === true;
const watchdog = setTimeout(() => { console.error('Session policy checks timed out'); process.exit(1); }, 45000);
(async () => {
  // A shorter duration clamps the running deadline without resetting activity;
  // any later renewal is bounded by the new policy.
  for (const choice of [5, 15, 60]) {
    const f = fixture(); f.disk.set('syrius.settings', JSON.stringify({ autoLockMinutes: 60 })); await f.unlock();
    const before = f.record(); f.advance(10 * 60000);
    await f.api.updateSetting('autoLockMinutes', choice);
    assert.equal(f.record().expiresAt, Math.min(before.expiresAt, f.now() + choice * 60000));
    assert.equal(f.record().lastActiveAt, before.lastActiveAt);
    assert.deepEqual((await f.provider('znn_accounts')).result, ['A-address-0']);
    f.advance(1000); assert.equal(await f.api.touch(), true);
    assert.equal(f.record().expiresAt, f.now() + choice * 60000);
  }
  {
    const f = fixture(); await f.unlock(); f.advance(13 * 60000); const before = f.record();
    await f.api.updateSetting('autoLockMinutes', 5); assert.equal(f.record().expiresAt, before.expiresAt);
    f.advance(2 * 60000); assert.equal(await f.api.load(), null);
    assert.equal(await f.api.touch(), false);
    await f.api.updateSetting('autoLockMinutes', 60); assert(ended(f.record()));
    assert.deepEqual((await f.provider('znn_accounts')).result, []);
  }
  // Timed -> On close: no shared entropy or public state, sites told there is
  // no account, a fresh document cannot resume or change it, and only the
  // still-open owner can make it timed again.
  {
    const f = fixture(); await f.unlock(); await f.register(); const original = f.record();
    await f.api.updateSetting('autoLockMinutes', 0);
    assert.equal(f.record().mode, 'local'); assert.equal('entropy' in f.record(), false); assert.equal(f.public(), null);
    assert.deepEqual(f.messages.at(-1).message.data, []); assert.equal(f.vault.isUnlocked(), true);
    const fresh = f.realm(); assert.equal(await fresh.api.load(), null);
    await assert.rejects(fresh.boot({ walletName: 'A', record: original, dispatch() {} }), /session ended/);
    // A locked document only saves its preference; the owner's session is untouched.
    await fresh.api.updateSetting('autoLockMinutes', 15); assert.equal(f.record().mode, 'local');
    await f.handlers.alarm({ name: 'znn.autoLock' }); assert.equal(f.record().mode, 'local');
    assert.equal(await f.api.touch(), true); assert.equal('entropy' in f.record(), false);
    await f.api.updateSetting('autoLockMinutes', 5); assert.equal(f.record().entropy, 'A');
    assert.equal(f.record().expiresAt, f.now() + 300000); assert.deepEqual((await f.provider('znn_accounts')).result, ['A-address-0']);
    await fresh.boot({ walletName: 'A', record: await fresh.api.load(), dispatch() {} });
    assert.equal(fresh.vault.getWalletName(), 'A');
  }
  // Another window's renewal after the change is bounded by the new policy.
  {
    const f = fixture(); await f.unlock(); const second = f.realm();
    await second.boot({ walletName: 'A', record: await second.api.load(), dispatch() {} });
    await f.api.updateSetting('autoLockMinutes', 5);
    f.advance(1000); assert.equal(await second.api.touch(), true);
    assert.equal(f.record().expiresAt, f.now() + 300000);
  }
  // A preference that cannot be saved is reported. A reduction is kept (it is
  // stricter); nothing else changes.
  for (const key of ['autoLockMinutes', 'hideBalances']) {
    const f = fixture(); await f.unlock(); const before = f.record(); f.faults.disk = 'syrius.settings';
    await assert.rejects(f.api.updateSetting(key, key === 'autoLockMinutes' ? 5 : true), /save settings/);
    assert.equal(f.api.capture() !== null, true);
    assert.equal(f.disk.has('syrius.settings'), false);
    if (key === 'autoLockMinutes') {
      assert.equal(f.record().expiresAt, f.now() + 300000);
      await f.api.touch(); assert.equal(f.record().expiresAt, f.now() + 300000);
    } else assert.deepEqual(f.record(), before);
  }
  // A relaxation whose preference cannot be saved never takes effect.
  for (const original of [0, 5]) {
    const f = fixture(); f.disk.set('syrius.settings', JSON.stringify({ autoLockMinutes: original })); await f.unlock();
    f.faults.disk = 'syrius.settings'; await assert.rejects(f.api.updateSetting('autoLockMinutes', 60), /save settings/);
    assert.equal(f.record().minutes, original); assert.equal(Boolean(f.record().entropy), original > 0);
    await f.api.touch(); assert.equal(f.record().expiresAt, original ? f.now() + original * 60000 : 0);
  }
  // Session storage failing under a policy change is unavailability, not a
  // known outcome: this document's keys are purged (live-vault rule) and the
  // shared record is never left looser than the stricter policy.
  {
    const f = fixture(); await f.unlock(); const before = f.record(); f.failWrite();
    await assert.rejects(f.api.updateSetting('autoLockMinutes', 5), error => error.code === 'WALLET_SESSION_UNAVAILABLE');
    assert.deepEqual(f.record(), before); assert.equal(f.disk.has('syrius.settings'), false);
    assert.equal(f.vault.isUnlocked(), false);
  }
  {
    const f = fixture(); f.disk.set('syrius.settings', JSON.stringify({ autoLockMinutes: 0 })); await f.unlock();
    f.failWrite(2);
    await assert.rejects(f.api.updateSetting('autoLockMinutes', 60), error => error.code === 'WALLET_SESSION_UNAVAILABLE');
    assert.equal(f.record().mode, 'local'); assert.equal('entropy' in f.record(), false);
    assert.equal(JSON.parse(f.disk.get('syrius.settings')).autoLockMinutes, 60);
    assert.equal(f.vault.isUnlocked(), false);
  }
  // A restore racing the owner's switch to On close fails, and its cleanup
  // (scoped to the revision it read) leaves the owner's session alone.
  {
    const f = fixture(); await f.unlock(); const original = f.record(), second = f.realm();
    // Held in the node connection: address derivation runs inside the lease
    // lock, so a policy change simply waits for it; the connection does not.
    const gate = f.hold('node'); const restoring = second.boot({ walletName: 'A', record: original, dispatch() {} });
    await gate.started.promise; await f.api.updateSetting('autoLockMinutes', 0); gate.release.resolve();
    await assert.rejects(restoring, /session ended/); assert.equal(second.vault.isUnlocked(), false);
    assert.equal(await second.api.clear({ id: original.id, revision: original.revision }), null); assert.equal(f.record().mode, 'local');
    assert.equal(f.vault.isUnlocked(), true);
  }
  // A password unlock that was checking the password while the preference
  // changed starts under the new preference (read under the lease lock).
  {
    const f = fixture(); const gate = f.hold('password'); const unlocking = f.unlock();
    await gate.started.promise; await f.api.updateSetting('autoLockMinutes', 5); gate.release.resolve();
    await unlocking; assert.equal(f.record().expiresAt, f.now() + 300000);
    const old = f.record(); const fresh = f.realm(); await fresh.unlock('B');
    assert.equal(await f.api.clear(old.id), null); assert.equal(f.record().walletName, 'B');
  }
  // Selection after a policy change keeps the new deadline and advertises the
  // newly selected account.
  {
    const f = fixture(); await f.unlock(); await f.api.updateSetting('autoLockMinutes', 5);
    f.advance(1000); await f.api.select(1, 2);
    assert.equal(f.record().selectedAddressIndex, 1); assert.equal(f.record().expiresAt, f.now() + 300000);
    await f.load('src/services/wallet/announce.js').announceAddress();
    assert.deepEqual((await f.provider('znn_accounts')).result, ['A-address-1']);
  }
  // Node and address announcements that were in flight when On close was
  // chosen cannot republish public state.
  {
    const f = fixture(); await f.unlock(); const announce = f.load('src/services/wallet/announce.js');
    const activity = announce.captureLifetime(), gate = f.hold('node');
    const work = f.load('src/services/wallet/bootstrap.js').connectToNode(() => {}).then(() => announce.announceNode(activity));
    await gate.started.promise; await f.api.updateSetting('autoLockMinutes', 0); gate.release.resolve(); await work;
    assert.equal(f.public(), null); assert.equal('entropy' in f.record(), false);
  }
  // Address derivation and publication run under the lease lock, so the
  // announcement and the change serialise; in either order none survives.
  for (const announceFirst of [true, false]) {
    const f = fixture(); await f.unlock(); const announce = f.load('src/services/wallet/announce.js');
    const activity = announce.captureLifetime();
    const change = () => f.api.updateSetting('autoLockMinutes', 0), publish = () => announce.announceAddress(activity);
    await Promise.all(announceFirst ? [publish(), change()] : [change(), publish()]);
    assert.equal(f.public(), null); assert.equal('entropy' in f.record(), false);
  }
  // Late events for an On close lease reveal nothing: no address, no node.
  {
    const f = fixture(); await f.unlock(); await f.register(); const leaseId = f.record().id;
    await f.api.updateSetting('autoLockMinutes', 0); const count = f.messages.length;
    await f.internal('events.accountsChanged', { leaseId, address: 'old address' });
    await f.internal('events.nodeChanged', { leaseId, nodeUrl: 'old node' });
    const late = f.messages.slice(count);
    assert(late.every(item => item.message.event === 'accountsChanged' && item.message.data.length === 0));
    assert.equal((await f.provider('znn_nodeUrl')).result, null);
  }
  // A renewal queued behind a reduction runs under the reduced policy; two
  // settings saved together both persist.
  {
    const f = fixture(); await f.unlock(); const gate = f.hold('session:get');
    const reduction = f.api.updateSetting('autoLockMinutes', 5); await gate.started.promise;
    const renewal = f.api.touch(); gate.release.resolve();
    await reduction; assert.equal(await renewal, true); assert.equal(f.record().expiresAt, f.now() + 300000);
    await Promise.all([f.api.updateSetting('hideBalances', true), f.api.updateSetting('autoLockMinutes', 0)]);
    assert.deepEqual(JSON.parse(f.disk.get('syrius.settings')), { autoLockMinutes: 0, hideBalances: true, autoReceive: true, explorer: 'zenonhub' });
  }
  // A renewal that reaches the lock after expiry revokes rather than extends;
  // the alarm then leaves a newer unlock alone.
  {
    const f = fixture(); await f.unlock(); f.advance(14 * 60000); const gate = f.hold('session:get');
    const renewal = f.api.touch(); await gate.started.promise; f.advance(60000); gate.release.resolve();
    assert.equal(await renewal, false); await f.handlers.alarm({ name: 'znn.autoLock' }); assert(ended(f.record()));
    await f.unlock('B'); const current = f.record(); await f.handlers.alarm({ name: 'znn.autoLock' }); assert.deepEqual(f.record(), current);
  }
  // The real Settings screen reports a failed change and does not show it as
  // selected. (Session storage failed, so the keys were purged; the retry then
  // saves the preference for the next unlock.)
  {
    const f = fixture(); await f.unlock(); const ui = f.ui('src/pages/settings/settings/settings.js');
    f.failWrite(); await ui.find(node => node.type === 'button' && node.props.children === '5 min').props.onClick(); ui.render();
    assert(ui.notices.some(item => item.error)); assert(ui.find(node => node.type === 'button' && node.props.children === '15 min').props.className.includes('is-selected'));
    assert.equal(f.vault.isUnlocked(), false);
    await ui.find(node => node.type === 'button' && node.props.children === '5 min').props.onClick(); ui.render();
    assert(ui.find(node => node.type === 'button' && node.props.children === '5 min').props.className.includes('is-selected'));
  }
  // Changing the password does not renew the session: a reduction made while
  // it was encrypting stands.
  {
    const f = fixture(); await f.unlock(); const ui = f.ui('src/pages/settings/change-password/change-password.js');
    ui.find(node => node.type === 'input' && node.props.placeholder === 'Current password').props.onChange({ target: { value: 'fixture' } });
    ui.find(node => node.type === 'input' && node.props.placeholder === 'New password').props.onChange({ target: { value: 'New-fixture-0!' } }); ui.render();
    const gate = f.hold('savePassword'); const saving = ui.find(node => node.type === 'form').props.onSubmit();
    await gate.started.promise; await f.api.updateSetting('autoLockMinutes', 5); const shorter = f.record(); gate.release.resolve(); await saving;
    assert.deepEqual(f.record(), shorter); assert(ui.notices.some(item => item.success === 'Password changed'));
    assert(f.events.includes('password saved'));
  }
  // Lock purges this document's keys at once, even when shared revocation
  // fails; the failure is reported and a retry revokes the same lease.
  for (const failure of ['session:get', 'session:set']) {
    const f = fixture(); await f.unlock(); const lock = f.load('src/services/wallet/lock.js').default;
    // Two failures: session.clear retries a transient fault once by itself.
    if (failure.endsWith('get')) f.faults[failure] = true; else f.failWrites(2);
    const locking = lock(); assert.equal(f.vault.isUnlocked(), false);
    await assert.rejects(locking, /Could not lock all wallet windows/);
    assert(f.events.includes('notifications cleared')); assert.equal(f.record().mode, 'timed');
    delete f.faults[failure]; f.failWrites(0); await lock(); assert(ended(f.record()));
  }
  // Lock is scoped to the document's own lease: selection in another window
  // does not move it, and a window whose lease was replaced locks nothing.
  {
    const f = fixture(); await f.unlock(); const second = f.realm();
    await second.boot({ walletName: 'A', record: await second.api.load(), dispatch() {} });
    await second.api.select(1, 2);
    assert.equal(f.vault.getSelectedIndex(), 0); assert.equal(f.record().selectedAddressIndex, 1);
    await f.load('src/services/wallet/lock.js').default(); assert(ended(f.record()));
    await flush(); await second.unlock('B'); const current = f.record();
    await f.load('src/services/wallet/lock.js').default(); assert.deepEqual(f.record(), current);
  }
  // An announcement racing a reduction still publishes the current account,
  // bound to the current lease.
  {
    const f = fixture(); await f.unlock(); await f.api.select(1, 2);
    await Promise.all([f.load('src/services/wallet/announce.js').announceAddress(), f.api.updateSetting('autoLockMinutes', 5)]);
    assert.deepEqual((await f.provider('znn_accounts')).result, ['A-address-1']);
    assert.equal(f.public().leaseId, f.record().id);
  }
  // The real menu: a failed lock reports an error and purges keys; it does not
  // claim the password screen (MainLayout shows its retry screen instead).
  {
    const f = fixture(); await f.unlock(); const ui = f.ui('src/components/burger-popover/burger-popover.js');
    f.failWrites(2); await ui.find(node => node.props?.children === 'Lock wallet').props.onClick();
    assert.equal(f.vault.isUnlocked(), false); assert(ui.notices.some(item => item.error));
    assert.equal(ui.navigations.length, 0);
  }
  // The real removal screen keeps the saved wallet when the lock fails.
  {
    const f = fixture(); await f.unlock(); f.disk.set('znn.ts-wallet', JSON.stringify({ A: { encrypted: 'fixture' } }));
    // Removal's inventory rules are wallet-deletion-test's; the stand-in
    // deletes the saved wallet only when the revocation commits.
    const ui = f.ui('src/pages/settings/reset-wallet/reset-wallet.js', undefined, id => id.endsWith('/wallet/removal') ? {
      captureWalletRemoval: () => ({}), prepareWalletRemoval: async () => ({}), assertWalletRemovalCurrent() {},
      commitRevokedWalletRemoval: () => f.disk.set('znn.ts-wallet', '{}'),
    } : undefined);
    ui.find(node => node.type === 'input' && node.props.placeholder === 'Wallet password').props.onChange({ target: { value: 'fixture' } });
    ui.find(node => node.type === 'input' && node.props.placeholder === 'Type REMOVE to confirm').props.onChange({ target: { value: 'REMOVE' } }); ui.render();
    f.failWrites(2); await ui.find(node => node.type === 'button' && node.props.children === 'Remove').props.onClick();
    assert.equal(f.vault.isUnlocked(), false); assert(JSON.parse(f.disk.get('znn.ts-wallet')).A);
    assert(ui.notices.some(item => item.error)); assert.equal(ui.navigations.length, 0);
  }
  // Startup that cannot read the session says so, rather than presenting a
  // password screen as though the wallet were known to be locked.
  {
    const f = fixture(); f.disk.set('znn.ts-wallet', JSON.stringify({ A: { encrypted: 'fixture' } }));
    f.disk.set('currentNodeUrl', 'wss://fixture.invalid'); f.faults['session:get'] = true;
    const ui = f.ui('src/layouts/mainLayout/mainLayout.js'); await flush(); ui.render();
    assert.equal(ui.tree().props.role, 'alert'); assert.equal(f.vault.isUnlocked(), false);
  }
  // A failed timed -> On close transition keeps BOTH restrictions: no
  // resumable entropy and the old finite owner deadline, until a saved retry.
  {
    const f = fixture(); await f.unlock(); const before = f.record();
    f.faults.disk = 'syrius.settings';
    await assert.rejects(f.api.updateSetting('autoLockMinutes', 0), /save settings/);
    assert.equal(f.record().mode, 'local'); assert.equal(f.record().privateUntil, before.expiresAt);
    assert.equal('entropy' in f.record(), false); assert.equal(f.public(), null);
    const fresh = f.realm(); assert.equal(await fresh.api.load(), null);
    f.advance(1000); assert.equal(await f.api.touch(), true);
    assert.equal(f.record().privateUntil, before.expiresAt); assert.equal('entropy' in f.record(), false);
    await f.api.select(1, 2);
    assert.equal(f.record().privateUntil, before.expiresAt); assert.equal('entropy' in f.record(), false);
    f.advance(before.expiresAt - f.now());
    assert.equal(await f.api.isCurrent(), false); assert.equal(await f.api.touch(), false);
    await f.handlers.alarm({ name: 'znn.autoLock' }); assert(ended(f.record()));
  }
  // The same when the final (relaxing) session write fails: the staged record
  // stands, and the alarm ends it at its deadline.
  {
    const f = fixture(); await f.unlock(); const before = f.record(); f.failWrite(2);
    await assert.rejects(f.api.updateSetting('autoLockMinutes', 0), error => error.code === 'WALLET_SESSION_UNAVAILABLE');
    assert.equal(f.record().mode, 'local'); assert.equal(f.record().privateUntil, before.expiresAt);
    assert.equal('entropy' in f.record(), false); assert.equal(f.public(), null);
    const fresh = f.realm(); assert.equal(await fresh.api.load(), null);
    f.advance(before.expiresAt - f.now()); await f.handlers.alarm({ name: 'znn.autoLock' }); assert(ended(f.record()));
  }
  {
    const f = fixture(); await f.unlock(); f.faults.disk = 'syrius.settings';
    await assert.rejects(f.api.updateSetting('autoLockMinutes', 0)); delete f.faults.disk;
    await f.api.updateSetting('autoLockMinutes', 0);
    assert.equal('privateUntil' in f.record(), false); assert.equal('entropy' in f.record(), false);
    f.advance(3600000); assert.equal(await f.api.isCurrent(), true);
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
      assert.equal(second.vault.isUnlocked(), false); assert(ended(f.record()));
      assert.equal(ui.navigations.at(-1)[0], '/password');
    } else if (failure === 'publication-read') {
      // A failed read after adoption is unavailability: the live-vault rule
      // purges the document and asks for a retry. It is never a false unlock.
      assert.equal(second.vault.isUnlocked(), false);
    } else {
      assert.equal(second.vault.isUnlocked(), true); assert.equal(f.record().mode, 'timed');
      assert.equal(ui.navigations.at(-1)[0], '/tabs/dashboard'); assert.equal(ui.notices.length, 0);
    }
  }
  // Both directions across local/timed authority stage the intersection.
  // A persisted finite preference must never hide an unbounded local owner.
  {
    const f = fixture(); f.disk.set('syrius.settings', JSON.stringify({ autoLockMinutes: 0 })); await f.unlock();
    const deadline = f.now() + 300000;
    f.faults.disk = 'syrius.settings';
    await assert.rejects(f.api.updateSetting('autoLockMinutes', 5), /save settings/);
    assert.equal(f.record().mode, 'local'); assert.equal(f.record().privateUntil, deadline);
    assert.equal('entropy' in f.record(), false); assert.equal(f.public(), null);
    const remounted = f.ui('src/pages/settings/settings/settings.js');
    assert(remounted.find(node => node.type === 'button' && node.props.children === 'On close').props.className.includes('is-selected'));
    f.advance(1000); await f.api.touch(); assert.equal(f.record().privateUntil, deadline);
    await f.api.select(1, 2); assert.equal(f.record().privateUntil, deadline);
    f.advance(deadline - f.now()); assert.equal(await f.api.isCurrent(), false);
    assert.equal(await f.api.touch(), false);
    await f.handlers.alarm({ name: 'znn.autoLock' }); assert(ended(f.record()));
  }
  {
    const f = fixture(); f.disk.set('syrius.settings', JSON.stringify({ autoLockMinutes: 0 })); await f.unlock();
    f.faults.disk = 'syrius.settings'; await assert.rejects(f.api.updateSetting('autoLockMinutes', 5)); const deadline = f.record().privateUntil;
    delete f.faults.disk; f.advance(1000); await f.api.updateSetting('autoLockMinutes', 5);
    assert.equal(f.record().expiresAt, deadline); assert.equal(f.record().entropy, 'A');
  }
  // Password change completes and reports success even if session storage
  // fails after the encrypted wallet was written; the session is not renewed.
  for (const failure of ['session:get', 'session:set']) {
    const f = fixture(); await f.unlock(); const before = f.record();
    const ui = f.ui('src/pages/settings/change-password/change-password.js');
    ui.find(node => node.type === 'input' && node.props.placeholder === 'Current password').props.onChange({ target: { value: 'fixture' } });
    ui.find(node => node.type === 'input' && node.props.placeholder === 'New password').props.onChange({ target: { value: 'New-fixture-0!' } }); ui.render();
    const gate = f.hold('savePassword'); const saving = ui.find(node => node.type === 'form').props.onSubmit();
    await gate.started.promise;
    if (failure.endsWith('get')) f.faults[failure] = true; else f.failWrite();
    gate.release.resolve(); await saving;
    // The commit needs a fresh lease read; if that read fails nothing is written.
    if (failure === 'session:get') {
      assert(!f.events.includes('password saved') || !JSON.parse(f.disk.get('znn.ts-wallet') || '{}').A);
      assert.equal(ui.notices.some(item => item.success), false);
    } else {
      assert(f.events.includes('password saved')); assert(ui.notices.some(item => item.success === 'Password changed'));
      assert.equal(JSON.parse(f.disk.get('znn.ts-wallet')).A.fixturePassword, 'New-fixture-0!');
    }
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
    await second.api.select(1, 2);
    await second.load('src/services/wallet/announce.js').announceAddress();
    const selected = (await new realSdk.KeyStore().fromEntropy(entropy).getKeyPair(1).getAddress()).toString();
    assert.equal(f.public().address, selected); assert.notEqual(first, selected);
    delete global.localStorage; delete global.window; delete global.self;
  }
  console.log('Session policy regression checks passed: deadlines, owners, staged policy, storage failures, worker reads/events, restore, selection, and real settings/password callbacks.');
})().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
