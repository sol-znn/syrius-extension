'use strict';
// Corrected-candidate regression fixtures only: no real keys, external nodes,
// browser profiles, vulnerable baseline execution, or submitted transactions.
//
// Ported onto the integrated session layer. The selection generation is the
// session record's `selectionId` (its `id` is the lease), and a selection is
// made the way the wallet makes one: a real password unlock, or selectAddress.
// Approvals run through the queue's deadlines and the relay acknowledgement
// that activates a connection grant; site consent is granted the same way.
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const babel = require('@babel/core');
const { journalStubs } = require('./fixtures/journal-stub');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.join(__dirname, '..'), compiled = new Map();
const liveDocument = require('./fixtures/document-binding-stub');
const clone = value => value === undefined ? value : structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 20; i++) await tick(); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const loader = (environment, overrides = () => undefined) => {
  const cache = new Map();
  const load = file => {
    const filename = path.resolve(root, file);
    if (filename.endsWith('.json')) return require(filename); // e.g. contract-call schemas
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    if (!compiled.has(filename)) compiled.set(filename, babel.transformFileSync(filename, { presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'], configFile: false, babelrc: false }).code);
    const req = id => {
      const replacement = overrides(id); if (replacement !== undefined) return replacement;
      // The journal has its own suite; see fixtures/journal-stub.js.
      const journaled = journalStubs(id); if (journaled !== undefined) return journaled;
      if (!id.startsWith('.')) return require(id);
      const target = path.resolve(path.dirname(filename), id); return load(path.extname(target) ? target : target + '.js');
    };
    new Function('module', 'exports', 'require', ...Object.keys(environment), compiled.get(filename))(module, module.exports, req, ...Object.values(environment));
    return module.exports;
  };
  return load;
};
const fixture = () => {
  let now = 1000000;
  class Clock extends Date { static now() { return now; } }
  const local = {}, session = {}, disk = new Map(), locks = new Map(), listeners = {}, messages = [];
  const faults = {}, calls = { sign: 0, publish: 0, windows: 0 }, waits = new Map();
  const hold = name => { const gate = { started: deferred(), release: deferred() }; waits.set(name, gate); return gate; };
  const pause = async name => { const gate = waits.get(name); if (gate) { waits.delete(name); gate.started.resolve(); await gate.release.promise; } };
  const locksApi = { request: async (name, fn) => {
    const previous = locks.get(name) || Promise.resolve(); const done = deferred(); locks.set(name, done.promise);
    await previous; try { return await fn(); } finally { done.resolve(); if (locks.get(name) === done.promise) locks.delete(name); }
  } };
  let faultWrite = null;
  const changeListeners = [];
  const storage = (area, values) => ({
    get: async keys => { await pause(area + ':get'); if (faults[area + ':get']) throw Error('storage read failed'); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, clone(values[key])])); },
    set: async patch => {
      await pause(area + ':set');
      if (faultWrite?.area === area && --faultWrite.remaining === 0) { faultWrite = null; throw Error('storage write failed'); }
      if (faults[area + ':set']) throw Error('storage write failed'); Object.assign(values, clone(patch));
      // Chrome reports every write; the vault follows the shared session through it.
      const delta = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { newValue: clone(value) }]));
      for (const listener of changeListeners) listener(delta, area);
    },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
  });
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  const chrome = {
    runtime: { id: 'fixture', getURL: name => 'chrome-extension://fixture/' + name,
      onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup') },
    storage: { session: storage('session', session), local: storage('local', local), onChanged: { addListener: listener => changeListeners.push(listener),
      removeListener: listener => { const at = changeListeners.indexOf(listener); if (at >= 0) changeListeners.splice(at, 1); } } },
    windows: { getCurrent: async () => ({ id: 10 }), getLastFocused: async () => ({}), update: async id => ({ id }), get: async id => ({ id }),
      create: async () => ({ id: 10 + ++calls.windows }), remove: async () => {}, onRemoved: event('windowRemoved') },
    // Responses are acknowledged as the content relay does.
    // A live relay: probes answered (not deliveries), responses acknowledged.
    tabs: { sendMessage: async (tabId, message, options) => {
      if (message?.kind !== 'probe') messages.push({ tabId, message: clone(message), options });
      return liveDocument.relayReply(message, () => now); }, onRemoved: event('tabRemoved') },
    webNavigation: { onBeforeNavigate: event('navigate') },
    alarms: { create() {}, onAlarm: event('alarm') },
  };
  const localStorage = { getItem: key => disk.get(key) ?? null, setItem: (key, value) => { if (faults.disk) throw Error('disk write failed'); disk.set(key, value); }, removeItem: key => disk.delete(key) };
  const addressFor = (seed, index) => `${seed}-address-${index}`;
  const key = (seed, index) => ({ getAddress: async () => { await pause('address'); return { toString: () => addressFor(seed, index) }; },
    generateKeyPair: async () => { await pause('derive'); return key(seed, index); },
    getPublicKey: async () => new Uint8Array(32).fill(index + 1), sign: async () => { calls.sign++; await pause('sign'); return new Uint8Array(64); } });
  // A wallet's seed is its name unless registered otherwise (duplicate imports).
  const seeds = new Map(), stores = new Map();
  const manager = { readKeyStore: async (password, walletName) => { await pause('password'); if (password !== 'fixture') throw Error('Error decrypting');
    return stores.get(walletName) || new sdk.KeyStore().fromEntropy(seeds.get(walletName) || walletName.split('-')[0]); } };
  const zenon = { initialize: async () => pause('node'), clearSocketConnection() {}, ledger: { publishRawTransaction: async () => { calls.publish++; await pause('publish'); } },
    embedded: { plasma: { getRequiredPoWForAccountBlock: async () => ({ requiredDifficulty: 0, basePlasma: 0, availablePlasma: 1 }) } } };
  const sdk = { KeyStore: class { fromEntropy(seed) { this.entropy = seed; this.mnemonic = 'fixture only'; return this; } getKeyPair(index) { return key(this.entropy, index); } },
    KeyStoreManager: function () { return manager; }, Constants: {}, Primitives: { Address: { parse: value => ({ toString: () => value }) } },
    Zenon: { getSingleton: () => zenon, getChainIdentifier: () => 1 }, Enums: { PowStatus: { generating: 0, done: 1 } } };
  // Like the SDK's, autofill sets the public key and toJson emits it as base64.
  const makeTemplate = json => ({ ...json, address: json.address || null,
    hash: { toString: () => 'fixture-block-hash' }, toJson() {
      const publicKey = this.publicKey && typeof this.publicKey !== 'string' ? Buffer.from(this.publicKey).toString('base64') : this.publicKey;
      return { ...json, address: this.address?.toString(), ...(publicKey ? { publicKey } : {}) };
    } });
  sdk.Primitives.TokenStandard = { parse: value => ({ toString: () => value }) };
  sdk.Primitives.AccountBlockTemplate = { fromJson: makeTemplate,
    send: (to, token, amount) => makeTemplate({ toAddress: to.toString(), tokenStandard: token.toString(), amount }) };
  sdk.Primitives.GetRequiredParam = class { constructor(...args) { this.args = args; } };
  // The approval pipeline's steps (approvalBlock.js); the gates sit where the
  // SDK's own send takes the key and where it has signed.
  sdk.utils = { BlockUtils: {
    _checkAndSetFields: async (context, template, pair) => { await pause('sdkBeforeKey'); template.address = await pair.getAddress(); template.publicKey = await pair.getPublicKey(); return template; },
    // As in the pinned SDK, signing uses only the key's sign().
    _setHashAndSignature: async (template, pair) => { template.signature = await pair.sign(new Uint8Array([1, 2, 3])); await pause('sdkBeforePublish'); return template; },
    send: async (context, template, pair) => {
      await pause('sdkBeforeKey'); template.address = await pair.getAddress();
      await pair.getPublicKey(); await pair.sign(new Uint8Array([1, 2, 3]));
      await pause('sdkBeforePublish'); await context.ledger.publishRawTransaction(template); return template;
    },
  } };
  // Real timers, unref'd: the vault arms one per lease and the fixture clock drives expiry.
  const timer = (fn, ms) => { const handle = setTimeout(fn, Math.min(ms, 2147483647)); handle.unref?.(); return handle; };
  const env = { chrome, navigator: { locks: locksApi }, crypto: crypto.webcrypto, Date: Clock, localStorage,
    setTimeout: timer, clearTimeout, TextEncoder, Uint8Array };
  const load = loader(env, id => (liveDocument.isNavigation(id) ? liveDocument.navigationStub : id === 'znn-ts-sdk' ? sdk : undefined));
  const selection = load('src/services/wallet/selection.js').default;
  const permissions = load('src/sections/Background/permissions.js').default;
  const requests = load('src/sections/Background/requests.js').default;
  const identity = load('src/services/utils/approvalIdentity.js');
  const vault = load('src/services/wallet/vault.js').default;
  const sessionApi = load('src/services/wallet/session.js').default;
  const lease = load('src/services/wallet/sessionLease.js').default;
  load('src/sections/Background/index.js');
  const sender = (origin = 'https://fixture.invalid') => ({ id: 'fixture', origin, url: origin + '/app', tab: { id: 1 }, frameId: 0, documentId: 'doc-one' });
  const internal = async (method, params = {}) => {
    await pause('internal:' + method);
    return new Promise((resolve, reject) => {
    listeners.message({ channel: 'internal', method, params }, { id: 'fixture', url: 'chrome-extension://fixture/popup.html' }, response => response.error ? reject(Error(response.error)) : resolve(response.result));
  });
  };
  chrome.runtime.sendMessage = (message, callback) => internal(message.method, message.params).then(result => callback({ result }), error => callback({ error: error.message }));
  let responseId = 0;
  const provider = async (method, params, origin) => {
    const id = ++responseId;
    listeners.message({ channel: 'znn', kind: 'request', method, params, id, ...liveDocument.documentFields() }, sender(origin), () => {});
    await flush(); return messages.find(item => item.message.kind === 'response' && item.message.id === id)?.message;
  };
  const scope = (seed = 'A', index = 0, walletName = seed) => ({ walletName, walletId: addressFor(seed, 0), address: addressFor(seed, index), index });
  // A selection the way the wallet makes one: a password unlock of `seed`'s
  // wallet on `index`, under the lock policy `mode` names, then publication.
  const activate = async (seed = 'A', index = 0, mode = 'timed', extra = {}) => {
    const walletName = extra.walletName || seed;
    seeds.set(walletName, seed);
    disk.set('syrius.settings', JSON.stringify({ autoLockMinutes: mode === 'timed' ? 15 : 0 }));
    await vault.unlockWithPassword(walletName, 'fixture', index);
    await load('src/services/wallet/announce.js').announceAddress();
    return clone(session['znn.unlock']);
  };
  // Consent granted as the worker grants it: the relay accepts before expiry.
  const grant = (origin, value) => permissions.grant(origin, value, {}, {
    expiresAt: now + 60000, confirm: async () => ({ accepted: true, acceptedAt: now }) });
  const lock = () => lease.clear();
  const register = async origin => { listeners.message({ channel: 'znn', kind: 'hello', activation: liveDocument.activation }, sender(origin), () => {}); await flush(); };
  const ui = () => {
    const states = [], refs = [], effects = [], callbacks = [], notices = [], navigations = [];
    const navigate = (...args) => navigations.push(args);
    let si, ri, ei, ci, tree;
    const state = { wallet: { address: vault.getBinding().scope.address, isUnlocked: true }, connectionParameters: { chainIdentifier: 1, nodeUrl: 'wss://fixture.invalid' } };
    const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
    const hooks = { ...React,
      useState: initial => { const i = si++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
      useRef: initial => { const i = ri++; return refs[i] ||= { current: initial }; },
      useCallback: (fn, deps) => { const i = ci++; if (!same(callbacks[i]?.deps, deps)) callbacks[i] = { fn, deps }; return callbacks[i].fn; },
      useEffect: (fn, deps) => { const i = ei++; if (!same(effects[i]?.deps, deps)) effects[i] = { fn, deps, cleanup: effects[i]?.cleanup, pending: true }; },
    };
    const uiLoad = loader({ ...env, window: { close() {} }, setTimeout: (fn, ms) => setTimeout(fn, ms === 1200 ? 0 : ms) }, id => {
      if (liveDocument.isNavigation(id)) return liveDocument.navigationStub;
      if (id === 'react') return hooks;
      if (id === 'react-router-dom') return { useNavigate: () => navigate };
      if (id === 'react-redux') return { useSelector: select => select(state) };
      if (id === 'znn-ts-sdk') return sdk;
      if (id === './vault' || id.endsWith('/wallet/vault')) return { __esModule: true, default: vault };
      if (id === './useAccount' || id.endsWith('/hooks/useAccount')) return { __esModule: true, default: () => ({ balanceMap: {} }), invalidateAccountCache() {} };
      if (id.endsWith('/utils/notify')) return { notify: { success: value => notices.push({ success: value }), error: value => notices.push({ error: String(value) }) } };
    });
    const Component = uiLoad('src/layouts/siteIntegrationLayout/siteIntegrationLayout.js').default;
    const render = () => { si = ri = ei = ci = 0; tree = Component(); for (const effect of effects) if (effect.pending) { effect.pending = false; effect.cleanup?.(); effect.cleanup = effect.fn(); } return tree; };
    const settle = async () => { for (let i = 0; i < 20; i++) { await tick(); render(); } };
    const flatten = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(flatten) : [node, ...flatten(node.props?.children)];
    render();
    return { settle, render, state, notices, navigations, button: text => flatten(tree).find(node => node.type === 'button' && node.props.children === text), markup: () => renderToStaticMarkup(tree), dispose: () => effects.forEach(effect => effect.cleanup?.()) };
  };
  return { ui, env, sdk, load, selection, permissions, requests, identity, vault, sessionApi, lease, local, session, disk, faults, calls, messages, waits, hold, pause, scope, activate, grant, lock, seeds, stores, internal, provider, register, listeners,
    now: () => now, removeWallet: async (binding, walletName) => {
      // The removal screen's sequence: the binding must still be current, the
      // worker withdraws the wallet's consent, then the lock deletes the saved
      // wallet inside the revocation (see reset-wallet.js).
      vault.assertBinding(binding);
      if (!(await internal('permissions.revokeWallet', { scope: binding.scope }))) throw Error('revocation failed');
      await load('src/services/wallet/lock.js').default({ afterRevoke: () => {
        const wallets = JSON.parse(disk.get('znn.ts-wallet') || '{}'); delete wallets[walletName];
        disk.set('znn.ts-wallet', JSON.stringify(wallets));
      } });
    },
    advance: ms => { now += ms; }, failWrite: (area, remaining = 1) => { faultWrite = { area, remaining }; } };
};
const watchdog = setTimeout(() => { console.error('Wallet scoping checks timed out'); process.exit(1); }, 45000);
(async () => {
  const origin = 'https://fixture.invalid';
  {
    const f = fixture(); await f.activate();
    f.local['syrius.permissions'] = { [origin]: { origin } };
    assert.deepEqual((await f.provider('znn_accounts')).result, []);
    assert.equal((await f.provider('znn_chainId')).result, null);
    assert.equal((await f.provider('znn_sendTransaction', {})).error.code, 4100);
    await f.grant(origin, f.scope());
    assert.deepEqual((await f.provider('znn_accounts')).result, ['A-address-0']);
    assert.deepEqual((await f.provider('znn_connect')).result, ['A-address-0']);
    await f.activate('B'); assert.deepEqual((await f.provider('znn_accounts')).result, []);
    assert.equal((await f.provider('znn_chainId')).result, null);
    assert.equal((await f.provider('znn_nodeUrl')).result, null);
    await f.activate('A', 1); assert.deepEqual((await f.provider('znn_accounts')).result, []);
    await f.grant(origin, f.scope('A', 1));
    assert.deepEqual((await f.provider('znn_accounts')).result, ['A-address-1']);
    await f.activate('A'); assert.deepEqual((await f.provider('znn_accounts')).result, ['A-address-0']);
    await f.activate('A', 0, 'timed', { walletName: 'duplicate-import' });
    assert.deepEqual((await f.provider('znn_accounts')).result, []);
    assert.equal((await f.permissions.list()).length, 2);
    await f.activate('A'); await f.register(origin);
    await f.internal('events.accountsChanged', { selectionId: f.vault.getBinding().id });
    assert.deepEqual(f.messages.at(-1).message.data, ['A-address-0']);
    const oldId = f.vault.getBinding().id;
    await f.activate('B'); await f.internal('events.accountsChanged', { selectionId: f.vault.getBinding().id });
    assert.deepEqual(f.messages.at(-1).message.data, []);
    const count = f.messages.length;
    await f.internal('events.nodeChanged', { selectionId: f.vault.getBinding().id });
    await f.internal('events.accountsChanged', { selectionId: oldId });
    assert.equal(f.messages.length, count);
    await f.activate('A'); await f.internal('permissions.revoke', { origin, scope: f.scope() });
    assert.deepEqual(f.messages.at(-1).message.data, []);
    assert.equal(f.messages.at(-1).options.documentId, 'doc-one');
    assert.equal(await f.permissions.isConnected(origin, f.scope()), false);
    assert.equal(await f.permissions.isConnected(origin, f.scope('A', 1)), true);
  }
  {
    const f = fixture(); await f.activate(); await f.grant(origin, f.scope());
    await Promise.all([f.permissions.touch(origin, f.scope()), f.permissions.revoke(origin, f.scope())]);
    assert.equal(await f.permissions.isConnected(origin, f.scope()), false);
    f.failWrite('local', 2);
    await assert.rejects(f.grant(origin, f.scope()), /write failed/); // the promotion write fails
    // Full session loss plus a fresh permissions realm cannot activate a
    // durable pending grant whose final promotion failed.
    for (const name of Object.keys(f.session)) delete f.session[name];
    const fresh = loader(f.env)('src/sections/Background/permissions.js').default;
    assert.equal(await fresh.isConnected(origin, f.scope()), false);
    await fresh.grant(origin, f.scope(), {}, { expiresAt: f.now() + 60000, confirm: async () => ({ accepted: true, acceptedAt: f.now() }) });
    assert.equal(await fresh.isConnected(origin, f.scope()), true);
  }
  {
    const f = fixture(); await f.activate(); await f.grant(origin, f.scope());
    for (const method of ['znn_sign', 'znn_sendTransaction', 'znn_signAndSendBlock', 'znn_connect']) {
      const record = f.session['znn.unlock'];
      if (method === 'znn_connect') await f.permissions.revoke(origin);
      await f.provider(method, method === 'znn_sign' ? { message: 'A safe fixture message' } : {});
      const request = await f.internal('approvals.next', { binding: f.vault.getBinding() });
      assert.equal(request.binding.id, record.selectionId);
      assert.equal(request.binding.scope.address, 'A-address-0');
      const claimed = await f.internal('approvals.claim', { identity: f.identity.identityOf(request), windowId: 10 });
      assert.ok(claimed);
      assert.equal(await f.internal('approvals.claim', { identity: f.identity.identityOf(request), windowId: 11 }), null);
      assert.equal(await f.internal('approvals.checkClaim', { identity: claimed }), true);
      const oldBinding = f.vault.getBinding();
      await f.activate('B'); await f.activate('A');
      assert.equal(await f.internal('approvals.checkClaim', { identity: claimed }), false);
      assert.equal(await f.internal('approvals.resolve', { identity: claimed, result: ['B-address-0'] }), false);
      assert.throws(() => f.vault.assertBinding(oldBinding));
      await f.internal('approvals.reject', { identity: claimed });
      await f.grant(origin, f.scope());
    }
  }
  {
    const f = fixture();
    assert.equal((await f.provider('znn_sign', { message: 'fixture' })).error.code, 4900);
    await f.provider('znn_connect');
    await f.activate('A');
    let request = await f.internal('approvals.next', { binding: f.vault.getBinding() });
    assert.equal(request.binding.scope.address, 'A-address-0');
    const claim = await f.internal('approvals.claim', { identity: f.identity.identityOf(request), windowId: 10 });
    assert.equal(await f.internal('approvals.resolve', { identity: claim, result: ['forged-local-result'] }), true);
    assert.deepEqual(f.messages.at(-1).message.result, ['A-address-0']);
    const local = await f.activate('A', 0, 'local');
    assert.deepEqual((await f.provider('znn_accounts')).result, []);
    assert.equal(await f.sessionApi.load(), null);
    await f.provider('znn_sign', { message: 'Fixture waiting for the same account' });
    await f.activate('A', 0, 'local'); // resumes from `local`'s generation: same account
    assert.equal(f.session['znn.unlock'].resumeFrom, local.selectionId);
    request = await f.internal('approvals.next', { binding: f.vault.getBinding() }); assert.ok(request);
    await f.internal('approvals.reject', { identity: f.identity.identityOf(request) });
    const another = await f.activate('A', 0, 'local');
    await f.provider('znn_sign', { message: 'Fixture wrong account resume' });
    await f.activate('B', 0, 'local'); // a different account never resumes `another`
    assert.notEqual(f.session['znn.unlock'].resumeFrom, another.selectionId);
    assert.equal(await f.internal('approvals.next', { binding: f.vault.getBinding() }), null);
    assert.equal((await f.requests.list()).length, 0);
  }
  {
    const f = fixture(); await f.activate(); await f.grant(origin, f.scope());
    const binding = f.vault.getBinding();
    const key = await f.vault.getSigningKeyPair(binding.scope.index, binding);
    const scoped = f.load('src/services/wallet/requestSigningKey.js').default(key, async () => {});
    assert.equal((await scoped.getAddress()).toString(), binding.scope.address);
    await scoped.sign(new Uint8Array([1, 2, 3])); assert.equal(f.calls.sign, 1);
    // Another account's key is refused for this binding before it can sign.
    await assert.rejects(f.vault.getSigningKeyPair(1, binding), /account changed/); assert.equal(f.calls.sign, 1);
    const gate = f.hold('sign'); const pending = scoped.sign(new Uint8Array([5])); await gate.started.promise;
    let changed = false; const change = f.vault.selectAddress(1, 2).then(() => { changed = true; });
    await flush(); assert.equal(changed, false); gate.release.resolve(); await pending; await change;
    await assert.rejects(scoped.sign(new Uint8Array([6])), /account changed/); assert.equal(f.calls.sign, 2);
    // Both address and generated signing caches discard asynchronous results
    // belonging to a keystore that has since been replaced.
    // Derivation runs under the session lock, so a replacing unlock waits for
    // it and the result belongs to the keystore current while it ran. What
    // matters is that it is unusable afterwards and never reaches the new
    // keystore's caches.
    await f.activate(); const derived = f.hold('derive'); const old = f.vault.getSigningKeyPair(7);
    await derived.started.promise; const replacing = f.activate('B'); derived.release.resolve();
    const stale = await old; await replacing;
    await assert.rejects(stale.sign(new Uint8Array([7])), /account changed|session ended/);
    assert.equal((await (await f.vault.getSigningKeyPair(7)).getAddress()).toString(), 'B-address-7');
    const addressed = f.hold('address'); const oldAddress = f.vault.getAddress(8);
    await addressed.started.promise; const adopting = f.activate('C'); addressed.release.resolve();
    assert.equal(await oldAddress, 'B-address-8'); await adopting;
    assert.equal(await f.vault.getAddress(8), 'C-address-8');
  }
  {
    const f = fixture(); await f.activate();
    const boot = f.load('src/services/wallet/bootstrap.js').completeUnlock;
    const old = await f.sessionApi.load();
    await f.activate('B'); await assert.rejects(boot({ walletName: 'A', sessionRecord: old, dispatch() {} }), /account changed|session ended/);
    await f.sessionApi.clear(old.id); assert.equal(f.session['znn.unlock'].scope.walletName, 'B');
    const password = f.hold('password'); const late = boot({ walletName: 'A', password: 'fixture', dispatch() {} });
    await password.started.promise; await f.activate('B'); password.release.resolve(); await assert.rejects(late, /account changed|session ended/);
    const node = f.hold('node'); const delayed = boot({ walletName: 'A', password: 'fixture', dispatch() {} });
    await node.started.promise; await f.activate('B'); node.release.resolve(); await assert.rejects(delayed, /account changed|session ended/);
    assert.equal(f.session['znn.publicState'].scope.walletName, 'B');
    const restored = await f.sessionApi.load(); await boot({ walletName: 'B', sessionRecord: restored, dispatch() {} });
    assert.equal(f.vault.getBinding().id, restored.selectionId);
    f.disk.set('syrius.settings', JSON.stringify({ autoLockMinutes: 0 }));
    await boot({ walletName: 'B', password: 'fixture', dispatch() {} });
    assert.equal(f.session['znn.unlock'].entropy, undefined); assert.equal(await f.sessionApi.load(), null);
  }
  {
    const f = fixture(); await f.activate(); await f.grant(origin, f.scope()); await f.grant(origin, f.scope('B'));
    f.disk.set('znn.ts-wallet', JSON.stringify({ A: { encrypted: 'fixture-A' }, B: { encrypted: 'fixture-B' } }));
    await f.provider('znn_sign', { message: 'Pending removal fixture' });
    const remove = f.removeWallet;
    const binding = f.vault.getBinding();
    await remove(binding, 'A');
    assert.deepEqual(JSON.parse(f.disk.get('znn.ts-wallet')), { B: { encrypted: 'fixture-B' } });
    assert.equal(await f.permissions.isConnected(origin, f.scope()), false);
    assert.equal(await f.permissions.isConnected(origin, f.scope('B')), true);
    assert.equal((await f.requests.list()).length, 0);
    await f.activate('A'); assert.equal(await f.permissions.isConnected(origin, f.scope()), false);
    await assert.rejects(remove(binding, 'A'), /account changed/);
  }
  for (const [method, label, params] of [
    ['znn_connect', 'Connect', {}], ['znn_sign', 'Sign', { message: 'Approved account fixture, for unit testing only.' }],
    ['znn_sendTransaction', 'Confirm', { to: 'fixture-recipient', tokenStandard: 'zts1znnxxxxxxxxxxxxx9z4ulx', amount: '0' }],
    ['znn_signAndSendBlock', 'Sign and send', { toAddress: 'fixture-recipient', tokenStandard: 'zts1znnxxxxxxxxxxxxx9z4ulx', amount: '0' }],
  ]) {
    const f = fixture(); await f.activate('A', 1);
    if (method !== 'znn_connect') await f.grant(origin, f.scope('A', 1));
    await f.provider(method, params);
    const ui = f.ui(); await ui.settle();
    assert.match(ui.markup(), /A-address-1/);
    const button = ui.button(label);
    assert.ok(button, 'Missing button ' + label + ': ' + ui.markup());
    assert.equal(button.props.disabled, false);
    await button.props.onClick(); await ui.settle();
    assert.equal(ui.notices.filter(value => value.error).length, 0, JSON.stringify(ui.notices));
    const response = f.messages.filter(item => item.message.kind === 'response').at(-1).message;
    assert.equal(response.error, undefined);
    if (method === 'znn_sign') { assert.equal(response.result.address, 'A-address-1'); assert.equal(f.calls.sign, 1); }
    if (method === 'znn_connect') assert.deepEqual(response.result, ['A-address-1']);
    if (method.includes('Transaction') || method.includes('Block')) assert.equal(f.calls.publish, 1);
    ui.dispose();
  }
  for (const phase of ['sdkBeforeKey', 'sdkBeforePublish']) {
    const f = fixture(); await f.activate(); await f.grant(origin, f.scope());
    await f.provider('znn_sendTransaction', { to: 'fixture-recipient', tokenStandard: 'zts1znnxxxxxxxxxxxxx9z4ulx', amount: '0' });
    const ui = f.ui(); await ui.settle(); const copied = ui.button('Confirm').props.onClick;
    const gate = f.hold(phase); const pending = copied(); await gate.started.promise;
    await f.activate('B'); await f.activate('A'); gate.release.resolve(); await pending;
    assert.equal(f.calls.publish, 0);
    assert.equal(f.calls.sign, phase === 'sdkBeforeKey' ? 0 : 1);
    await copied(); assert.equal(f.calls.publish, 0); ui.dispose();
  }
  {
    const f = fixture(); await f.activate(); await f.register(origin);
    await f.grant(origin, f.scope()); await f.permissions.revokeWallet(f.scope());
    // A fresh worker grants again; the removing popup still conservatively
    // denies its earlier local grant. Cleanup must nevertheless target it.
    const fresh = loader(f.env)('src/sections/Background/permissions.js').default;
    await fresh.grant(origin, f.scope(), {}, { expiresAt: f.now() + 60000, confirm: async () => ({ accepted: true, acceptedAt: f.now() }) });
    f.disk.set('znn.ts-wallet', JSON.stringify({ A: { encrypted: 'fixture' } }));
    await f.removeWallet(f.vault.getBinding(), 'A');
    const cleared = f.messages.filter(item => item.message.kind === 'event').at(-1);
    assert.deepEqual(cleared.message.data, []);
    assert.equal(await fresh.isConnected(origin, f.scope()), false);
  }
  // Once publication starts, account changes, expiry, revocation and final
  // response races must never describe the operation as safely rejected.
  for (const method of ['znn_sendTransaction', 'znn_signAndSendBlock']) {
    for (const change of ['selection', 'expiry', 'revoke', 'resolve']) {
      const f = fixture(); await f.activate(); await f.grant(origin, f.scope());
      await f.provider(method, { to: 'fixture-recipient', toAddress: 'fixture-recipient', tokenStandard: 'zts1znnxxxxxxxxxxxxx9z4ulx', amount: '0' });
      const ui = f.ui(); await ui.settle();
      const gate = f.hold(change === 'resolve' ? 'internal:approvals.resolve' : 'publish');
      const pending = ui.button(method === 'znn_sendTransaction' ? 'Confirm' : 'Sign and send').props.onClick();
      await gate.started.promise; assert.equal(f.calls.publish, 1);
      if (change === 'expiry') f.advance(900001);
      else if (change === 'revoke') await f.internal('permissions.revoke', { origin });
      else { await f.activate('B'); await f.activate('A'); }
      gate.release.resolve(); await pending;
      const replies = f.messages.filter(item => item.message.kind === 'response');
      assert.equal(replies.length, 1);
      assert.match(replies[0].message.error.message, /outcome is unknown/);
      assert.match(replies[0].message.error.message, /before retrying/);
      assert.notEqual(replies[0].message.error.code, 4001);
      assert.ok(ui.notices.some(value => /outcome is unknown/.test(value.error)));
      assert.equal(f.calls.publish, 1); ui.dispose();
    }
  }
  // The direct predecessor remains attached to the same timed selection
  // across popup restores, including requests not yet displayed.
  {
    const f = fixture(); await f.activate(); await f.grant(origin, f.scope());
    await f.lock();
    await f.provider('znn_sign', { message: 'First queued unit fixture' });
    await f.provider('znn_sign', { message: 'Second queued unit fixture' });
    const boot = f.load('src/services/wallet/bootstrap.js').completeUnlock;
    await boot({ walletName: 'A', password: 'fixture', dispatch() {} });
    const first = await f.internal('approvals.next', { binding: f.vault.getBinding() });
    const unlock = await f.sessionApi.load();
    await boot({ walletName: 'A', sessionRecord: unlock, dispatch() {} });
    assert.equal(f.session['znn.unlock'].resumeFrom, unlock.resumeFrom);
    await f.internal('approvals.reject', { identity: f.identity.identityOf(first) });
    const second = await f.internal('approvals.next', { binding: f.vault.getBinding() });
    assert.equal(second.params.message, 'Second queued unit fixture');
  }
  {
    const f = fixture(); await f.activate(); await f.grant(origin, f.scope());
    await f.provider('znn_sign', { message: 'Expiry recovery unit fixture' });
    const ui = f.ui(); await ui.settle(); const approve = ui.button('Sign').props.onClick;
    f.advance(900001); await approve(); await ui.settle();
    assert.equal((await f.requests.list()).length, 0);
    assert.equal(f.calls.sign, 0);
    assert.ok(f.messages.some(item => item.message.kind === 'response' && item.message.error));
    assert.ok(ui.navigations.some(args => args[0] === '/password' && args[1].state.returnTo === '/site-integration'));
    ui.dispose();
  }
  // Execute the installed pinned SDK's actual autofill/hash/sign/publication
  // sequence with public test entropy and an entirely inert ledger facade.
  // No SDK connection is initialized and no native RPC transport is created.
  {
    global.window = { crypto: crypto.webcrypto }; global.self = global.window;
    const sdkDisk = new Map();
    global.localStorage = { getItem: key => sdkDisk.get(key) ?? null, setItem: (key, value) => sdkDisk.set(key, value) };
    const realSdk = require('znn-ts-sdk');
    const actualSetSignature = realSdk.utils.BlockUtils._setHashAndSignature;
    const testStore = new realSdk.KeyStore().fromEntropy('00'.repeat(32));
    const first = (await testStore.getKeyPair(0).getAddress()).toString();
    const selected = (await testStore.getKeyPair(1).getAddress()).toString();
    for (const phase of ['control', 'sdkBeforeSignature', 'sdkBeforePublish', 'sdkPublicationReply']) {
      const f = fixture(); const fixtureManager = f.sdk.KeyStoreManager; Object.assign(f.sdk, realSdk);
      f.sdk.KeyStoreManager = fixtureManager; f.stores.set('public-unit-fixture', testStore);
      const scope = { walletName: 'public-unit-fixture', walletId: first, address: selected, index: 1 };
      await f.vault.unlockWithPassword(scope.walletName, 'fixture', 1);
      await f.load('src/services/wallet/announce.js').announceAddress();
      await f.grant(origin, scope);
      const zenon = realSdk.Zenon.getSingleton();
      zenon.ledger.getFrontierBlock = async () => null;
      zenon.ledger.getFrontierMomentum = async () => ({ hash: realSdk.Primitives.Hash.parse('00'.repeat(32)), height: 1 });
      zenon.embedded.plasma.getRequiredPoWForAccountBlock = async () => ({ requiredDifficulty: 0, basePlasma: 0, availablePlasma: 1 });
      zenon.ledger.publishRawTransaction = async template => {
        f.calls.publish++; assert.equal(template.address.toString(), selected); assert.equal(template.signature.length, 64);
        await f.pause('sdkPublicationReply');
      };
      realSdk.utils.BlockUtils._setHashAndSignature = async (...args) => {
        await f.pause('sdkBeforeSignature'); const signed = await actualSetSignature(...args);
        await f.pause('sdkBeforePublish'); return signed;
      };
      await f.provider('znn_sendTransaction', { to: first, tokenStandard: 'zts1znnxxxxxxxxxxxxx9z4ulx', amount: '0' });
      const ui = f.ui(); await ui.settle();
      const gate = phase === 'control' ? null : f.hold(phase);
      const sending = ui.button('Confirm').props.onClick();
      if (gate) {
        await gate.started.promise;
        await f.lock(); f.vault.lock(); gate.release.resolve();
      }
      await sending; assert.equal(f.calls.publish, ['control', 'sdkPublicationReply'].includes(phase) ? 1 : 0, JSON.stringify(ui.notices));
      if (phase === 'sdkPublicationReply') assert.ok(ui.notices.some(value => /outcome is unknown/.test(value.error)));
      if (phase === 'control') assert.equal(ui.notices.filter(value => value.error).length, 0, JSON.stringify(ui.notices));
      ui.dispose();
    }
    realSdk.utils.BlockUtils._setHashAndSignature = actualSetSignature;
    delete global.localStorage; delete global.window; delete global.self;
  }
  console.log('wallet scoping: consent, worker reads/events/queue, ABA, On close, key guards, cache races, restore, removal, four UI flows, and pinned SDK publication passed');
})().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
