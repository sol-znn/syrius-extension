'use strict';
// Corrected-candidate controls using in-memory storage and public fixture data.
// No real wallet/profile, encryption round-trip, RPC, or transaction is used.
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const babel = require('@babel/core');
const React = require('react');
const sdkReal = require('znn-ts-sdk');
const root = path.join(__dirname, '..'), compiled = new Map();
const W = 'znn.ts-wallet', I = 'addressInfo', L = 'syrius.addressLabels', N = 'syrius.lastWalletName';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const fixtureAddress = (seed, index) => new sdkReal.Primitives.Address('z', Buffer.concat([
  Buffer.from([0]), crypto.createHash('sha256').update(seed + ':' + index).digest().subarray(0, 19),
]));
const fixture = () => {
  const disk = new Map(), seeds = new Map(), writes = [], waits = new Map(), notices = [], navigations = [], events = [];
  const state = { wallet: { walletName: 'A', maxAddressIndex: 3, selectedAddressIndex: 0 } };
  let fault = null, hooks = React, passwordReads = 0, onDerive = () => {};
  const hold = name => { const gate = { started: deferred(), release: deferred() }; waits.set(name, gate); return gate; };
  const pause = async name => { const gate = waits.get(name); if (gate) { waits.delete(name); gate.started.resolve(); await gate.release.promise; } };
  const localStorage = { getItem: key => { if (fault === 'get:' + key) { fault = null; throw Error('read failed'); } return disk.get(key) ?? null; },
    setItem: (key, value) => { writes.push(['set', key]); if (fault === key) { fault = null; throw Error('write failed'); } disk.set(key, String(value)); },
    removeItem: key => { writes.push(['remove', key]); if (fault === key) { fault = null; throw Error('write failed'); } disk.delete(key); } };
  const sdk = { ...sdkReal, KeyStore: class {
    fromEntropy(seed) { this.entropy = seed; return this; }
    getKeyPair(index) { const seed = this.entropy; return { getAddress: async () => { await pause('derive:' + index); if (fault === 'derive') { fault = null; throw Error('derive failed'); } onDerive(index); return fixtureAddress(seed, index); } }; }
  }, KeyStoreManager: function () { return {
    readKeyStore: async (password, name) => { passwordReads++; await pause('password'); if (password !== 'fixture' || !Object.hasOwn(JSON.parse(disk.get(W) || '{}'), name)) throw Error('Error decrypting'); return new sdk.KeyStore().fromEntropy(seeds.get(name)); },
    listAllKeyStores: () => JSON.parse(disk.get(W) || '{}'),
  }; } };
  const modules = new Map();
  const load = file => {
    const filename = path.resolve(root, file); if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    if (!compiled.has(filename)) compiled.set(filename, babel.transformFileSync(filename, { presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'], configFile: false, babelrc: false }).code);
    const req = id => {
      if (id === 'znn-ts-sdk') return sdk;
      if (id === 'react') return hooks;
      if (id === 'react-router-dom') return { useNavigate: () => (...args) => navigations.push(args) };
      if (id === 'react-redux') return { useSelector: fn => fn(state), useStore: () => ({ getState: () => state }), useDispatch: () => action => events.push(action.type) };
      if (id.endsWith('/utils/notify')) return { notify: { success: value => notices.push({ success: value }), error: error => notices.push({ error: String(error) }) } };
      if (id.endsWith('/hooks/useAccount')) return { invalidateAccountCache: () => events.push('cache cleared') };
      if (id.endsWith('/components/change-address-item/change-address-item')) return { __esModule: true, default: 'address-item' };
      if (id.endsWith('/wallet/session')) return { __esModule: true, default: { touch: async () => {} } };
      if (id.endsWith('/wallet/announce')) return { announceAddress: async () => {} };
      if (id.endsWith('/wallet/lock')) return { __esModule: true, default: async () => { events.push('lock'); vault.lock(); await pause('lock'); } };
      if (!id.startsWith('.')) return require(id);
      const target = path.resolve(path.dirname(filename), id); return load(path.extname(target) ? target : target + '.js');
    };
    new Function('module', 'exports', 'require', 'localStorage', compiled.get(filename))(module, module.exports, req, localStorage);
    return module.exports;
  };
  const vault = load('src/services/wallet/vault.js').default;
  const api = load('src/services/wallet/removal.js');
  const read = key => JSON.parse(disk.get(key) || '{}');
  const put = (key, value) => disk.set(key, JSON.stringify(value));
  const add = (name, seed = name, count = 3, base = fixtureAddress(seed, 0)) => {
    seeds.set(name, seed);
    put(W, { ...read(W), [name]: { baseAddress: JSON.parse(JSON.stringify(base)), crypto: { fixture: name } } });
    put(I, { ...read(I), [name]: { selectedAddressIndex: 0, maxAddressIndex: count } });
  };
  const activate = (name = 'A', count = 3, index = 0) => {
    vault.unlockWithEntropy(name, seeds.get(name)); vault.setSelectedIndex(index);
    state.wallet = { walletName: name, maxAddressIndex: count, selectedAddressIndex: index };
  };
  const capture = () => { const before = { ...state.wallet }; return api.captureWalletRemoval(before, () => Object.keys(before).every(key => before[key] === state.wallet[key])); };
  const remove = async () => api.commitWalletRemoval(await api.prepareWalletRemoval(capture()));
  const ui = (file = 'src/pages/settings/reset-wallet/reset-wallet.js') => {
    const values = [], refs = [], effects = []; let cursor, refCursor, effectCursor, tree;
    hooks = { ...React,
      useCallback: fn => fn,
      useState: initial => { const i = cursor++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], value => { values[i] = value; }]; },
      useRef: initial => refs[refCursor++] ||= { current: initial },
      useEffect: fn => { const i = effectCursor++; if (!effects[i]) effects[i] = { fn }; },
    };
    const Component = load(file).default;
    const render = () => { cursor = refCursor = effectCursor = 0; tree = Component(); for (const effect of effects) if (!effect.ran) { effect.ran = true; effect.cleanup = effect.fn(); } };
    const flatten = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(flatten) : [node, ...flatten(node.props?.children)];
    const find = fn => flatten(tree).find(fn);
    const button = text => find(node => node.type === 'button' && node.props.children === text);
    render();
    const fill = (password = 'fixture') => {
      find(node => node.type === 'input' && node.props.type === 'password').props.onChange({ target: { value: password } });
      find(node => node.type === 'input' && node.props.type === 'text').props.onChange({ target: { value: 'REMOVE' } }); render();
    };
    return { render, find, button, fill, unmount: () => effects.forEach(effect => effect.cleanup?.()) };
  };
  add('A'); add('B'); activate(); disk.set(N, 'A');
  put(L, { [fixtureAddress('A', 0)]: 'A first', [fixtureAddress('A', 2)]: 'A highest', [fixtureAddress('B', 0)]: 'B label', unknown: 'unattributed' });
  for (const key of ['nodeList', 'currentNodeUrl', 'syrius.settings', 'znn.ts-chainId']) disk.set(key, 'unchanged ' + key);
  return { disk, state, writes, notices, navigations, events, vault, api, sdk, read, put, add, activate, capture, remove, hold, ui,
    storage: load('src/services/utils/storage.js'),
    onDerive: fn => { onDerive = fn; },
    fail: key => { fault = key; }, passwordReads: () => passwordReads, snapshot: () => [...disk.entries()] };
};
const watchdog = setTimeout(() => { console.error('Wallet deletion checks timed out'); process.exit(1); }, 45000);
(async () => {
  {
    const f = fixture(), other = f.read(W).B, globals = f.snapshot().filter(([key]) => ![W,I,L,N].includes(key));
    await f.remove(); assert.deepEqual(f.read(W), { B: other }); assert.equal(Object.hasOwn(f.read(I), 'A'), false); assert.equal(f.disk.has(N), false);
    assert.deepEqual(f.read(L), { [fixtureAddress('B', 0)]: 'B label', unknown: 'unattributed' });
    assert.deepEqual(f.snapshot().filter(([key]) => ![W,I,L,N].includes(key)), globals);
    assert.equal(f.writes.at(-1)[1], W); assert(f.writes.findIndex(([,key]) => key === L) < f.writes.findIndex(([,key]) => key === I));
  }
  {
    const f = fixture(); f.disk.set(N, 'B'); f.put(I, { ...f.read(I), A: { selectedAddressIndex: 0, maxAddressIndex: 1 } });
    f.activate('A', 4, 3); f.put(L, { ...f.read(L), [fixtureAddress('A', 3)]: 'live count ahead' });
    await f.remove(); assert.equal(f.disk.get(N), 'B'); assert.equal(f.read(L)[fixtureAddress('A', 3)], undefined);
  }
  {
    const f = fixture(); f.add('A duplicate', 'A', 1); const labels = f.disk.get(L); await f.remove();
    assert.equal(f.disk.get(L), labels); assert.equal(f.writes.some(([,key]) => key === L), false);
    assert.deepEqual(f.storage.getAddressInfo('A duplicate'), { selectedAddressIndex: 0, maxAddressIndex: 1 });
    assert.equal(f.read(I)['A duplicate'].labelAddressCount, 3);
    assert.equal(f.storage.setAddressInfo('A duplicate', { selectedAddressIndex: 0, maxAddressIndex: 1 }), true);
    assert.equal(f.read(I)['A duplicate'].labelAddressCount, 3);
    f.vault.lock(); f.activate('A duplicate', f.storage.getAddressInfo('A duplicate').maxAddressIndex);
    await f.remove(); assert.equal(f.read(L)[fixtureAddress('A', 2)], undefined); assert.equal(f.read(L)[fixtureAddress('B', 0)], 'B label');
  }
  {
    const f = fixture(); f.put(W, { A: f.read(W).A }); f.put(I, { A: f.read(I).A });
    await f.remove(); assert.equal(f.disk.has(W), false); assert.equal(f.disk.has(I), false); assert.equal(f.disk.has(L), false); assert.equal(f.disk.has(N), false);
  }
  for (const name of ['__proto__', 'constructor']) {
    const f = fixture(); f.add(name, 'A', 1); const info = f.read(I); delete info[name]; f.put(I, info);
    await f.remove(); assert.equal(Object.hasOwn(f.read(I), name), true); assert.equal(f.read(I)[name].labelAddressCount, 3);
    assert.equal(f.storage.setAddressInfo(name, { selectedAddressIndex: 0, maxAddressIndex: 1 }), true);
    f.activate(name, 1); await f.remove(); assert.equal(f.read(L)[fixtureAddress('A', 2)], undefined);
  }
  {
    const f = fixture(); f.add('duplicate-one', 'A', 1); f.add('duplicate-two', 'A', 2);
    f.fail(I); await assert.rejects(f.remove(), /write failed/); assert(Object.hasOwn(f.read(W), 'A'));
    await f.remove(); f.activate('duplicate-one', 1); await f.remove();
    assert.equal(f.read(I)['duplicate-two'].maxAddressIndex, 2); assert.equal(f.read(I)['duplicate-two'].labelAddressCount, 3);
    f.activate('duplicate-two', 2); await f.remove(); assert.equal(f.read(L)[fixtureAddress('A', 2)], undefined);
  }
  for (const name of ['wallet with spaces', 'wallet-with-spaces', '__proto__', 'constructor']) {
    const f = fixture(); f.add(name, 'legacy'); f.activate(name, 1); f.disk.set(N, name);
    f.put(L, { ...f.read(L), [fixtureAddress('legacy', 0)]: 'legacy' });
    await f.remove(); assert.equal(Object.hasOwn(f.read(W), name), false); assert(Object.hasOwn(f.read(W), 'A')); assert.equal(f.read(L)[fixtureAddress('legacy', 0)], undefined);
  }
  // Every persistence failure retains a password-verifiable encrypted wallet;
  // a new attempt can finish even after earlier metadata keys were removed.
  for (const failure of [L, I, N, W]) {
    const f = fixture(), encrypted = f.disk.get(W); f.fail(failure);
    await assert.rejects(f.remove(), /write failed/); assert.equal(f.disk.get(W), encrypted); assert.equal(await f.vault.verifyPassword('fixture'), true);
    await f.remove(); assert.equal(Object.hasOwn(f.read(W), 'A'), false); assert.equal(f.read(L)[fixtureAddress('A', 2)], undefined);
  }
  for (const alter of [
    f => f.disk.set(W, '[]'), f => f.disk.set(W, '{'), f => f.put(W, { B: f.read(W).B }),
    f => f.put(W, { ...f.read(W), A: null }), f => f.put(W, { ...f.read(W), B: { baseAddress: { hrp: 'z', core: { type: 'Buffer', data: [0] } } } }),
    f => f.put(I, { A: { selectedAddressIndex: -1, maxAddressIndex: 3 } }),
    f => f.disk.set(L, 'null'), f => f.put(L, { invalid: 7 }),
    f => f.put(W, { ...f.read(W), A: { ...f.read(W).A, baseAddress: fixtureAddress('different', 0).toString() } }),
  ]) {
    const f = fixture(); alter(f); const before = f.snapshot(); await assert.rejects(f.remove()); assert.deepEqual(f.snapshot(), before); assert.equal(f.writes.length, 0);
  }
  {
    const f = fixture(); const before = f.snapshot(); f.fail('derive'); await assert.rejects(f.remove(), /derive failed/); assert.deepEqual(f.snapshot(), before); assert.equal(f.writes.length, 0);
  }
  for (const key of [W, I, L, N]) {
    const f = fixture(), before = f.snapshot(); f.fail('get:' + key); await assert.rejects(f.remove(), /read failed/);
    assert.deepEqual(f.snapshot(), before); assert.equal(f.writes.length, 0);
  }
  {
    const f = fixture(); f.put(I, { ...f.read(I), A: { ...f.read(I).A, labelAddressCount: 0 } }); const before = f.disk.get(I);
    assert.equal(f.storage.setAddressInfo('A', { selectedAddressIndex: 0, maxAddressIndex: 1 }), false); assert.equal(f.disk.get(I), before);
    await assert.rejects(f.remove(), /metadata/); assert.equal(f.writes.length, 0);
  }
  for (const failed of [false, true]) {
    const f = fixture(), ui = f.ui('src/pages/settings/change-address/change-address.js');
    await new Promise(resolve => setImmediate(resolve)); ui.render(); assert.equal(ui.button('Add address').props.disabled, false);
    if (failed) f.fail(I);
    ui.button('Add address').props.onClick();
    assert.equal(f.read(I).A.maxAddressIndex, failed ? 3 : 4);
    assert.equal(f.events.includes('wallet/storeMaxAddressIndex'), !failed);
    assert.equal(f.notices.some(x => x.error?.includes('Could not save the new address')), failed);
    // A failed addition leaves no new account available to label. Reload and
    // deletion still cover every address that was exposed by the account list.
    if (failed) {
      ui.render(); assert.equal(ui.find(node => node.type === 'address-item' && node.props.index === 3), undefined);
      f.activate('A', f.storage.getAddressInfo('A').maxAddressIndex); await f.remove();
      assert.equal(f.read(L)[fixtureAddress('A', 2)], undefined);
    }
  }
  {
    const f = fixture(), prepared = await f.api.prepareWalletRemoval(f.capture()); f.add('late duplicate', 'A', 1); const before = f.snapshot();
    assert.throws(() => f.api.commitWalletRemoval(prepared), /changed/); assert.deepEqual(f.snapshot(), before); assert.equal(f.writes.length, 0);
  }
  {
    const f = fixture(); f.state.wallet = { walletName: 'toString', maxAddressIndex: 1, selectedAddressIndex: 0 }; const before = f.snapshot();
    assert.throws(f.capture); assert.deepEqual(f.snapshot(), before); assert.equal(f.writes.length, 0);
  }
  {
    const f = fixture(); f.put(W, { ...f.read(W), A: { ...f.read(W).A, baseAddress: fixtureAddress('A', 0).toString() } }); await f.remove(); assert.equal(Object.hasOwn(f.read(W), 'A'), false);
  }
  // Delayed derivation cannot cross an adoption, import, or derivation-count change.
  for (const change of [f => { f.activate('B'); f.activate('A'); }, f => f.add('new duplicate', 'A', 1),
    f => { f.state.wallet = { ...f.state.wallet, maxAddressIndex: 4 }; },
    f => f.put(I, { ...f.read(I), A: { selectedAddressIndex: 0, maxAddressIndex: 4 } })]) {
    const f = fixture(), gate = f.hold('derive:1'); const result = f.remove(); await gate.started.promise; change(f); const before = f.snapshot(); gate.release.resolve();
    await assert.rejects(result, /changed/); assert.deepEqual(f.snapshot(), before); assert.equal(f.writes.length, 0);
  }
  {
    const f = fixture(), gate = f.hold('derive:1'); const result = f.remove(); await gate.started.promise;
    f.put(L, { ...f.read(L), newest: 'preserve fresh unrelated label' }); f.put(I, { ...f.read(I), C: { selectedAddressIndex: 0, maxAddressIndex: 7 } }); f.disk.set(N, 'B');
    gate.release.resolve(); await result; assert.equal(f.read(L).newest, 'preserve fresh unrelated label'); assert.equal(f.read(I).C.maxAddressIndex, 7); assert.equal(f.disk.get(N), 'B');
  }
  {
    const f = fixture(), gate = f.hold('derive:1'); const result = f.remove(); await gate.started.promise;
    f.activate('B'); gate.release.resolve(); await assert.rejects(result, /changed/);
    assert.equal(await f.vault.getAddress(1), fixtureAddress('B', 1).toString());
    assert.equal(f.writes.length, 0);
  }
  // Actual ResetWallet callbacks: success, validation, failure, cancellation,
  // single-flight, unmount, live store reads, and no post-commit cancel fiction.
  {
    const f = fixture(), ui = f.ui(); ui.fill(); await ui.button('Remove').props.onClick();
    assert(f.notices.some(x => x.success === 'Removed A')); assert.equal(f.navigations.at(-1)[0], '/password'); assert.equal(f.vault.isUnlocked(), false); assert(f.events.includes('lock')); assert(f.events.includes('wallet/resetWalletState'));
  }
  {
    const f = fixture(); f.put(W, { A: f.read(W).A }); const ui = f.ui(); ui.fill(); await ui.button('Remove').props.onClick(); assert.equal(f.navigations.at(-1)[0], '/auth/onboarding');
  }
  {
    const f = fixture(), ui = f.ui(); ui.fill('wrong'); const before = f.snapshot(); await ui.button('Remove').props.onClick(); assert.deepEqual(f.snapshot(), before); assert(f.notices.some(x => x.error.includes('Wrong password')));
  }
  {
    const f = fixture(), ui = f.ui(); ui.fill(); f.fail(L); await ui.button('Remove').props.onClick();
    assert(Object.hasOwn(f.read(W), 'A')); assert.equal(f.navigations.length, 0); assert.equal(f.notices.some(x => x.success), false); ui.render(); assert.equal(ui.button('Remove').props.disabled, false);
  }
  for (const stage of ['password', 'derive:1']) for (const action of ['cancel', 'unmount', 'count', 'aba']) {
    const f = fixture(), ui = f.ui(); ui.fill(); const gate = f.hold(stage); const removing = ui.button('Remove').props.onClick(); await gate.started.promise;
    if (action === 'cancel') ui.button('Cancel').props.onClick();
    if (action === 'unmount') ui.unmount();
    if (action === 'count') f.state.wallet = { ...f.state.wallet, maxAddressIndex: 4 };
    if (action === 'aba') { f.activate('B'); f.activate('A'); }
    const before = f.snapshot(); gate.release.resolve(); await removing; assert.deepEqual(f.snapshot(), before); assert.equal(f.writes.length, 0); assert.equal(f.notices.some(x => x.success), false);
  }
  {
    // A real event-loop task must get a chance to cancel a long inventory, even
    // when every address promise resolves without an I/O pause as in the SDK.
    const f = fixture(); f.add('A', 'A', 33); f.activate('A', 33); const ui = f.ui(); ui.fill();
    let derived = 0, canceled = false;
    f.onDerive(index => { derived++; if (index === 1) setTimeout(() => { canceled = true; ui.button('Cancel').props.onClick(); }, 0); });
    const before = f.snapshot(); await ui.button('Remove').props.onClick();
    assert.equal(canceled, true); assert(derived > 1 && derived < 33); assert.deepEqual(f.snapshot(), before);
    assert.equal(f.writes.length, 0); assert.equal(f.notices.some(x => x.success), false);
  }
  {
    const f = fixture(), ui = f.ui(); ui.fill(); const callback = ui.button('Remove').props.onClick, gate = f.hold('password');
    const removing = callback(); await gate.started.promise; await callback(); assert.equal(f.passwordReads(), 1); gate.release.resolve(); await removing;
  }
  {
    const f = fixture(), ui = f.ui(); ui.fill(); f.activate('B'); const before = f.snapshot(); await ui.button('Remove').props.onClick(); assert.deepEqual(f.snapshot(), before); assert.equal(f.passwordReads(), 0);
  }
  {
    const f = fixture(), ui = f.ui(); ui.fill(); const cancel = ui.button('Cancel').props.onClick, gate = f.hold('lock');
    const removing = ui.button('Remove').props.onClick(); await gate.started.promise; cancel(); ui.render(); assert.equal(ui.button('Cancel').props.disabled, true); assert.equal(f.navigations.length, 0); gate.release.resolve(); await removing; assert(f.notices.some(x => x.success));
  }
  {
    const f = fixture(), ui = f.ui(); ui.fill(); const gate = f.hold('lock');
    const removing = ui.button('Remove').props.onClick(); await gate.started.promise; ui.unmount();
    assert(f.events.includes('cache cleared')); assert(f.events.includes('wallet/resetWalletState'));
    assert(f.events.includes('pendingTransactions/resetPendingTransactions')); assert.equal(f.vault.isUnlocked(), false);
    gate.release.resolve(); await removing; assert.equal(f.navigations.length, 0); assert.equal(f.notices.some(x => x.success), false);
  }
  // Installed pinned SDK Address serialization and deterministic derivation.
  // This public all-zero entropy is test data, with an inert password manager.
  {
    const f = fixture(); f.sdk.KeyStore = sdkReal.KeyStore; const entropy = '00'.repeat(32), store = new sdkReal.KeyStore().fromEntropy(entropy);
    const first = await store.getKeyPair(0).getAddress(), highest = (await store.getKeyPair(2).getAddress()).toString();
    f.add('SDK', entropy, 3, first); f.activate('SDK'); f.put(L, { ...f.read(L), [first.toString()]: 'SDK first', [highest]: 'SDK third' });
    assert.equal(await f.vault.verifyPassword('fixture'), true); await f.remove(); assert.equal(f.read(L)[first.toString()], undefined); assert.equal(f.read(L)[highest], undefined); assert(Object.hasOwn(f.read(W), 'A'));
  }
  console.log('Wallet deletion regression checks passed');
})().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
