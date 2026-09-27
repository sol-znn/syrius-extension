'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const babel = require('@babel/core');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
global.chrome = { windows: { getCurrent: async () => ({ id: 1 }) } };
global.window = { crypto: require('node:crypto').webcrypto, close() {} };
const memory = new Map();
global.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)) };
const sdk = require('znn-ts-sdk');
const { BigNumber } = require('ethers');
const root = path.join(__dirname, '..');
const loadModules = (override) => {
  const cache = new Map();
  const load = (file) => {
    const filename = path.resolve(root, file);
    if (cache.has(filename)) return cache.get(filename);
    const mod = { exports: {} };
    const { code } = babel.transformFileSync(filename, { presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'], babelrc: false, configFile: false });
    const resolve = name => {
      // Match this package's actual webpack browser mapping.
      if (name === 'buffer') return {};
      const value = override(name);
      if (value !== undefined) return value;
      if (name.startsWith('.')) {
        const target = path.resolve(path.dirname(filename), name);
        return load(target.endsWith('.js') ? target : `${target}.js`);
      }
      return require(name);
    };
    new Function('module', 'exports', 'require', code)(mod, mod.exports, resolve);
    cache.set(filename, mod.exports);
    return mod.exports;
  };
  return load;
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const address = sdk.Primitives.Address.parse('z1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsggv2f');
const hash = sdk.Primitives.Hash.parse('1'.repeat(64));
const zts = 'zts1znnxxxxxxxxxxxxx9z4ulx';
const keyBytes = Buffer.alloc(32, 7);
const blockJson = (amount = '100000000') => sdk.Primitives.AccountBlockTemplate.send(address, sdk.Primitives.TokenStandard.parse(zts), BigNumber.from(amount)).toJson();

const fixture = () => {
  sdk.Zenon.setChainIdentifier(69);
  const state = { current: true, unlocked: true, index: 0, wallet: 'fixture', chain: 69, node: 'wss://example.invalid', height: 4, signs: 0, fills: 0, publishes: [], pause: null, gate: null, badKey: false };
  const pause = async phase => {
    if (state.pause === phase) {
      const gate = state.gate;
      gate.started.resolve();
      await gate.release.promise;
    }
  };
  const key = { getAddress: async () => address, getPublicKey: async () => keyBytes };
  state.key = key;
  const signer = {
    getAddress: async () => { await pause('signer'); return state.badAddress ? sdk.Primitives.Address.parse('z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp') : address; },
    getPublicKey: async () => state.badKey ? Buffer.alloc(32, 9) : keyBytes,
    sign: async bytes => { state.signs++; state.signedBytes = Buffer.from(bytes); await pause('sign'); return Buffer.alloc(64, 1); },
  };
  const vault = {
    isUnlocked: () => state.unlocked,
    getWalletName: () => state.wallet,
    getSelectedIndex: () => state.index,
    getKeyPair: () => { if (!state.unlocked) throw Error('locked'); return state.key; },
    getSigningKeyPair: async () => { await pause('key'); return signer; },
  };
  const client = {};
  const zenon = {
    wsClient: client,
    ledger: {
      client,
      getFrontierBlock: async () => { state.fills++; await pause('prepare'); return { height: state.height, hash }; },
      getFrontierMomentum: async () => ({ height: 100 + state.height, hash }),
      getBlockByHash: async () => ({ toAddress: address }),
      publishRawTransaction: async template => { state.publishes.push(template.toJson()); },
    },
    embedded: { plasma: { client, getRequiredPoWForAccountBlock: async () => { await pause('pow'); return { requiredDifficulty: 0, basePlasma: 21000 }; } } },
  };
  const sdkFacade = { ...sdk, Zenon: { getSingleton: () => zenon, getChainIdentifier: () => state.chain } };
  const override = name => {
    if (name === 'znn-ts-sdk') return sdkFacade;
    if (name === './vault') return vault;
    if (name === '../utils/storage') return { getCurrentNodeUrl: () => state.node };
    return undefined;
  };
  const service = loadModules(override)('src/services/wallet/blockApproval.js');
  const prepare = (params = blockJson()) => service.prepareBlockApproval(params, { address: address.toString(), nodeUrl: state.node, isCurrent: () => state.current });
  const hold = phase => { state.pause = phase; state.gate = { started: deferred(), release: deferred() }; return state.gate; };
  return { state, zenon, vault, service, prepare, hold, override };
};

const elements = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(elements) : [tree, ...elements(tree.props?.children)];
const component = (f, first, broker) => {
  const states = [first, null, false, false];
  const refs = [];
  let cursor = 0;
  let refCursor = 0;
  let effects = [];
  const errors = [];
  const mockReact = { ...React,
    useState: initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
    useRef: initial => { const i = refCursor++; return refs[i] ??= { current: initial }; },
    useCallback: fn => fn,
    useEffect: (fn, deps) => effects.push({ fn, deps }),
  };
  const Component = loadModules(name => {
    if (name === 'react') return mockReact;
    if (name === 'react-router-dom') return { useNavigate: () => () => {} };
    if (name === 'react-redux') return { useSelector: fn => fn({ wallet: { address: address.toString(), isUnlocked: f.state.unlocked }, connectionParameters: { chainIdentifier: f.state.chain, nodeUrl: f.state.node } }) };
    if (name.endsWith('/wallet/blockApproval')) return f.service;
    if (name.endsWith('/hooks/useAccount')) return () => ({ balanceMap: { [zts]: { balance: BigNumber.from('1000000000000'), token: { decimals: 8, symbol: 'ZNN' } } } });
    if (name.endsWith('/hooks/useBlockSender')) return () => ({ sendPrepared: f.service.sendBlockApproval, isSending: false, isGeneratingPlasma: false });
    if (name.endsWith('/wallet/signMessage')) return {};
    if (name.endsWith('/utils/messaging')) return { sendInternal: broker || (async type => type === 'approvals.next' ? { id: 'next', type: 'connect', params: {} } : true) };
    if (name.endsWith('/utils/notify')) return { notify: { success() {}, error: err => errors.push(err) } };
    return f.override(name);
  })('src/layouts/siteIntegrationLayout/siteIntegrationLayout.js').default;
  const render = () => { cursor = 0; refCursor = 0; effects = []; return Component(); };
  const prepare = () => effects.find(effect => effect.deps?.length === 5 && effect.deps[0] === states[0]).fn();
  const unmount = () => effects.find(effect => effect.deps?.length === 0).fn()();
  return { states, errors, render, prepare, unmount };
};
const action = tree => elements(tree).find(el => el.type === 'button' && el.props.onClick?.name === 'approveSignAndSend');
const reject = tree => elements(tree).find(el => el.type === 'button' && el.props.children === 'Reject');
const request = (id, amount) => ({ id, approvalId: `approval-${id}`, type: 'signAndSendBlock', origin: 'https://example.invalid', params: blockJson(amount) });


// Chrome returns independent structured clones; a successful write is the
// security boundary. The central lock fixture models the browser's origin-wide
// Web Lock and coordinates independently loaded copies of requests.js.
const queueFixture = () => {
  const memory = {};
  const tails = new Map();
  const faults = { read: false, write: false };
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: (name, callback) => {
      const operation = (tails.get(name) || Promise.resolve()).then(callback);
      tails.set(name, operation.catch(() => {}));
      return operation;
    },
  } });
  chrome.storage = { session: {
    get: async key => { if (faults.read) throw Error('storage read unavailable'); await tick(); return structuredClone({ [key]: memory[key] }); },
    set: async values => { if (faults.write) throw Error('storage write unavailable'); await tick(); Object.assign(memory, structuredClone(values)); },
    remove: async key => { delete memory[key]; },
  } };
  const fresh = () => loadModules(() => undefined)('src/sections/Background/requests.js').default;
  const queue = fresh();
  const broker = async (method, { id, ...params } = {}) => {
    if (method === 'approvals.claimBlock') return queue.claimBlock(id, params);
    if (method === 'approvals.resolve' || method === 'approvals.reject') return Boolean(await queue.remove(id, params));
    if (method === 'approvals.next') return (await queue.oldest()) || { id: 'next', type: 'connect', params: {} };
    throw Error('Unexpected internal method: ' + method);
  };
  return { queue, fresh, broker, faults };
};

(async () => {
  for (const initial of [undefined, null, { id: 'connect', type: 'connect', params: {} }]) {
    const f = fixture();
    const page = component(f, initial);
    const tree = page.render();
    assert(renderToStaticMarkup(tree));
    assert.equal(action(tree), undefined);
    assert.equal(f.state.signs, 0);
  }
  for (const type of ['send', 'receive', 'embedded']) {
    const f = fixture();
    let params = blockJson();
    if (type === 'receive') params = sdk.Primitives.AccountBlockTemplate.receive(hash).toJson();
    if (type === 'embedded') { params.toAddress = 'z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp'; params.data = Buffer.from([1, 2, 3, 4]).toString('base64'); }
    const approval = await f.prepare(params);
    assert(Object.isFrozen(approval.block));
    assert(Object.isFrozen(approval.block.momentumAcknowledged));
    assert.throws(() => { approval.block.amount = '999'; }, TypeError);
    params.amount = '999';
    f.state.height = 8; // later frontier must not silently replace reviewed fields
    const sent = await f.service.sendBlockApproval(approval);
    assert.equal(f.state.fills, 1);
    assert.equal(sent.height, 5);
    assert.equal(sent.momentumAcknowledged.height, 104);
    assert.equal(sent.amount.toString(), approval.block.amount);
    assert.equal(sent.publicKey.toString('base64'), approval.block.publicKey);
    for (const [name, value] of Object.entries(approval.details)) assert.deepEqual(f.state.publishes[0][name], value);
    assert.equal(f.state.signs, 1);
    assert.equal(f.state.publishes.length, 1);
    await assert.rejects(f.service.sendBlockApproval(approval));
  }
  for (const explicit of [undefined, 123]) {
    const f = fixture();
    const params = blockJson();
    if (explicit === undefined) delete params.chainIdentifier; else params.chainIdentifier = explicit;
    const approval = await f.prepare(params);
    assert.equal(approval.block.chainIdentifier, explicit ?? 69);
    const sent = await f.service.sendBlockApproval(approval);
    assert.equal(sent.chainIdentifier, explicit ?? 69);
  }
  for (const invalidReceive of ['data', 'destination']) {
    const f = fixture();
    const params = sdk.Primitives.AccountBlockTemplate.receive(hash).toJson();
    if (invalidReceive === 'data') params.data = Buffer.from('not empty').toString('base64');
    else f.zenon.ledger.getBlockByHash = async () => ({ toAddress: sdk.Primitives.Address.parse('z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp') });
    await assert.rejects(f.prepare(params));
    assert.equal(f.state.signs, 0);
  }
  const mutations = [
    f => { f.state.current = false; }, f => { f.state.unlocked = false; },
    f => { f.state.index = 1; }, f => { f.state.wallet = 'different'; },
    f => { f.state.key = { ...f.state.key }; }, f => { f.state.chain = 2; },
    f => { f.state.node = 'wss://other.invalid'; }, f => { f.zenon.wsClient = {}; },
    f => { f.zenon.ledger.client = {}; }, f => { f.zenon.embedded.plasma.client = {}; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    const approval = await f.prepare();
    mutate(f);
    assert.equal(f.service.isCurrentBlockApproval(approval), false);
    await assert.rejects(f.service.sendBlockApproval(approval));
    assert.equal(f.state.signs, 0);
    assert.equal(f.state.publishes.length, 0);
  }
  for (const phase of ['prepare', 'key', 'signer', 'pow', 'sign']) {
    const f = fixture();
    const approval = phase === 'prepare' ? null : await f.prepare();
    const gate = f.hold(phase);
    const operation = phase === 'prepare' ? f.prepare() : f.service.sendBlockApproval(approval);
    await gate.started.promise;
    f.state.current = false;
    gate.release.resolve();
    await assert.rejects(operation);
    assert.equal(f.state.signs, phase === 'sign' ? 1 : 0);
    assert.equal(f.state.publishes.length, 0);
  }
  for (const mismatch of ['badKey', 'badAddress']) {
    const f = fixture();
    const approval = await f.prepare();
    f.state[mismatch] = true;
    await assert.rejects(f.service.sendBlockApproval(approval));
    assert.equal(f.state.signs, 0);
  }
  {
    const f = fixture();
    const approval = await f.prepare();
    const gate = f.hold('key');
    const first = f.service.sendBlockApproval(approval);
    await gate.started.promise;
    await assert.rejects(f.service.sendBlockApproval(approval));
    gate.release.resolve();
    await first;
    assert.equal(f.state.signs, 1);
  }
  // Actual JSX/effect/callback regression for A -> B, including the render
  // before B's effect and then B's pending preparation. Real SDK fills/signs.
  {
    const f = fixture();
    const page = component(f, request('A', '100000000'));
    assert.equal(action(page.render()).props.disabled, true);
    page.prepare(); await tick();
    const readyA = page.render();
    assert(renderToStaticMarkup(readyA).includes('1 ZNN'));
    page.states[0] = request('B', '10000000000');
    const beforeEffect = page.render();
    assert(!renderToStaticMarkup(beforeEffect).includes('1 ZNN'));
    assert.equal(action(beforeEffect).props.disabled, true);
    await action(beforeEffect).props.onClick();
    await action(readyA).props.onClick(); // callback retained from the old ready render
    assert.equal(f.state.signs, 0);
    const gate = f.hold('prepare');
    page.prepare(); await gate.started.promise;
    assert.equal(action(page.render()).props.disabled, true);
    gate.release.resolve(); await tick();
    const ready = page.render();
    assert(renderToStaticMarkup(ready).includes('100 ZNN'));
    assert.equal(action(ready).props.disabled, false);
    const signing = f.hold('key');
    const first = action(ready).props.onClick();
    await signing.started.promise;
    assert(renderToStaticMarkup(page.render()).includes('100 ZNN'));
    await action(ready).props.onClick();
    await reject(ready).props.onClick(); // reject cannot advance during a send
    assert.equal(page.states[0].id, 'B');
    signing.release.resolve(); await first;
    assert.equal(f.state.signs, 1);
    assert.equal(f.state.publishes[0].amount, '10000000000');
    assert.equal(page.errors.length, 0);
  }
  for (const scenario of ['failed', 'outOfOrder', 'unmount', 'reject']) {
    const f = fixture();
    const page = component(f, request('A', '100000000'));
    const gate = f.hold('prepare');
    page.render(); page.prepare(); await gate.started.promise;
    if (scenario === 'outOfOrder') {
      f.state.pause = null;
      page.states[0] = request('B', '200000000');
      page.render(); page.prepare(); await tick();
      gate.release.resolve(); await tick();
      const html = renderToStaticMarkup(page.render());
      assert(html.includes('2 ZNN') && !html.includes('1 ZNN'));
    } else if (scenario === 'failed') {
      gate.release.reject(Error('node unavailable')); await tick();
      const tree = page.render();
      assert(renderToStaticMarkup(tree).includes('Unable to prepare'));
      assert.equal(action(tree).props.disabled, true);
      await action(tree).props.onClick();
    } else if (scenario === 'unmount') {
      page.unmount(); gate.release.resolve(); await tick();
      assert.equal(page.states[1], null);
    } else {
      await reject(page.render()).props.onClick();
      gate.release.resolve(); await tick();
      assert.equal(page.states[1], null);
    }
    assert.equal(f.state.signs, 0);
    assert.equal(f.state.publishes.length, 0);
  }

  {
    const { queue, fresh, faults } = queueFixture();
    await queue.add({ ...request('A', '100000000'), createdAt: 1 });
    const original = await queue.get('A');
    const claim = { approvalId: original.approvalId, claimId: 'owner', windowId: 11 };
    const results = await Promise.all([
      queue.claimBlock('A', claim),
      fresh().claimBlock('A', { ...claim, claimId: 'competitor', windowId: 12 }),
      fresh().attachWindow('A', 99),
      fresh().add({ ...request('B', '200000000'), createdAt: 2 }),
    ]);
    assert.deepEqual(results.slice(0, 2), [true, false]);
    assert.equal((await queue.get('A')).claimId, 'owner');
    assert.equal((await queue.get('A')).windowId, 11);
    assert.equal((await queue.oldest()).id, 'B');
    assert.equal(await queue.remove('A'), null);
    assert.equal(await queue.remove('A', { ...claim, claimId: 'competitor' }), null);
    assert.equal(await queue.remove('A', { ...claim, approvalId: 'replacement' }), null);
    assert.equal((await queue.remove('A', claim)).id, 'A');
    assert.equal(await queue.claimBlock('A', claim), false);
    await queue.add({ ...request('A', '100000000'), createdAt: 1 });
    assert.notEqual((await queue.get('A')).approvalId, original.approvalId);
    assert.equal(await queue.claimBlock('A', claim), false);
    const current = await queue.get('A');
    const nextClaim = { ...claim, approvalId: current.approvalId };
    faults.write = true;
    await assert.rejects(queue.claimBlock('A', nextClaim), /write unavailable/);
    faults.write = false;
    assert.equal((await queue.get('A')).claimId, undefined);
    faults.read = true;
    await assert.rejects(queue.claimBlock('A', nextClaim), /read unavailable/);
    faults.read = false;
    assert.equal(await queue.claimBlock('A', nextClaim), true);
    assert.equal(await fresh().claimBlock('A', nextClaim), false); // restart/realm replay
    await Promise.all(Array.from({ length: 20 }, (_, i) => fresh().add({ ...request(`parallel-${i}`, '1'), createdAt: i })));
    assert.equal((await queue.list()).length, 22);
  }

  // The real worker listener retains its extension-sender gate. Window-close
  // cleanup carries the captured record identity and cannot delete a request
  // that was claimed by another live window while that cleanup was waiting.
  {
    const q = queueFixture();
    const listeners = {}; const delivered = [];
    const event = name => ({ addListener: fn => { listeners[name] = fn; } });
    chrome.runtime = { id: 'fixture', getURL: p => 'chrome-extension://fixture/' + p, onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup') };
    chrome.windows.onRemoved = event('windowRemoved');
    chrome.tabs = { onRemoved: event('tabRemoved'), sendMessage: async (tabId, message, options) => { delivered.push({ tabId, message, options }); } };
    chrome.alarms = { onAlarm: event('alarm'), create() {} };
    const workerQueue = { ...q.queue };
    loadModules(name => {
      if (name === './requests') return workerQueue;
      if (name === './frames') return { forTabs: async () => [], forgetTab() {} };
      if (name === './permissions') return { list: async () => [] };
    })('src/sections/Background/index.js');
    await q.queue.add({ ...request('A', '1'), tabId: 10, frameId: 0, windowId: 101, createdAt: 1 });
    const stored = await q.queue.get('A');
    const params = { id: 'A', approvalId: stored.approvalId, claimId: 'claim', windowId: 202 };
    const message = { channel: 'internal', method: 'approvals.claimBlock', params };
    assert.equal(listeners.message(message, { id: 'fixture', url: 'https://example.invalid', tab: { id: 10 } }, () => { throw Error('untrusted sender answered'); }), false);
    assert.equal((await q.queue.get('A')).claimId, undefined);
    const call = (method, params) => new Promise(resolve => {
      assert.equal(listeners.message({ channel: 'internal', method, params }, { id: 'fixture', url: 'chrome-extension://fixture/popup.html' }, resolve), true);
    });
    const gate = { started: deferred(), release: deferred() };
    workerQueue.list = async () => { const snapshot = await q.queue.list(); gate.started.resolve(); await gate.release.promise; return snapshot; };
    const closingOldWindow = listeners.windowRemoved(101);
    await gate.started.promise;
    assert.deepEqual(await call('approvals.claimBlock', params), { result: true });
    gate.release.resolve(); await closingOldWindow;
    assert.equal((await q.queue.get('A')).windowId, 202);
    assert.equal(delivered.length, 0);
    assert.deepEqual(await call('approvals.reject', { ...params, claimId: 'loser' }), { result: false });
    assert.deepEqual(await call('approvals.resolve', { ...params, result: { synthetic: true } }), { result: true });
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].message.result, { synthetic: true });
    workerQueue.list = q.queue.list;
    for (const claimed of [false, true]) {
      await q.queue.add({ ...request('close', '1'), tabId: 10, frameId: 0, windowId: 303, createdAt: 1 });
      const entry = await q.queue.get('close');
      if (claimed) assert.equal(await q.queue.claimBlock('close', { approvalId: entry.approvalId, claimId: 'closing-owner', windowId: 303 }), true);
      await listeners.windowRemoved(303);
      assert.equal(await q.queue.get('close'), null);
      assert.equal(delivered.at(-1).message.error.code, 4001);
    }
    assert.equal(delivered.length, 3);
  }

  // Actual two-component/SDK replay schedule from Daybreak: the second popup
  // finishes preparing against the successor frontier after the first has
  // published and removed A. Its local preview is ready, but the worker claim
  // rejects it before a second signature or publication is possible.
  {
    const q = queueFixture();
    await q.queue.add({ ...request('A', '100000000'), createdAt: 1 });
    const shared = await q.queue.get('A');
    const one = fixture(); const two = fixture();
    const first = component(one, structuredClone(shared), q.broker);
    const second = component(two, structuredClone(shared), q.broker);
    first.render(); first.prepare(); await tick();
    const gate = two.hold('prepare');
    second.render(); second.prepare(); await gate.started.promise;
    await action(first.render()).props.onClick();
    assert.equal(one.state.publishes.length, 1);
    assert.equal(await q.queue.get('A'), null);
    two.state.height = 5;
    gate.release.resolve(); await tick();
    assert.equal(second.states[1].approval.block.height, 6);
    const ready = second.render();
    assert.equal(action(ready).props.disabled, false);
    await action(ready).props.onClick();
    assert.equal(two.state.signs, 0);
    assert.equal(two.state.publishes.length, 0);
    assert(second.errors.some(error => /already answered or changed/.test(error.message)));
  }
  // Competing ready popups and a failed claim write both fail before signing;
  // a losing popup cannot reject the winner's persisted claim.
  for (const scenario of ['competing', 'storageFailure', 'replacement']) {
    const q = queueFixture();
    await q.queue.add({ ...request('A', '100000000'), createdAt: 1 });
    const shared = await q.queue.get('A');
    const one = fixture(); const two = fixture();
    const first = component(one, structuredClone(shared), q.broker);
    const second = component(two, structuredClone(shared), q.broker);
    first.render(); first.prepare(); second.render(); second.prepare(); await tick();
    if (scenario === 'storageFailure') q.faults.write = true;
    if (scenario === 'replacement') await q.queue.add({ ...request('A', '100000000'), createdAt: 1 });
    if (scenario === 'competing') {
      const gate = one.hold('key');
      const sending = action(first.render()).props.onClick();
      await gate.started.promise;
      await action(second.render()).props.onClick();
      assert((await q.queue.get('A')).claimId);
      gate.release.resolve(); await sending;
      assert.equal(one.state.signs, 1);
      assert.equal(one.state.publishes.length, 1);
    } else {
      await action(first.render()).props.onClick();
      assert.equal(one.state.signs, 0);
      assert.equal(one.state.publishes.length, 0);
    }
    assert.equal(two.state.signs, 0);
    assert.equal(two.state.publishes.length, 0);
  }

  console.log('block approval: exact prepared fields, real SDK send/receive/embedded controls, current-context guards, delayed lifecycle, single use, signer identity, actual JSX races, shared claims and worker lifecycle passed');
})().catch(err => { console.error(String(err)); console.error(err.stack?.split('\n').slice(0, 6).join('\n')); process.exitCode = 1; });
