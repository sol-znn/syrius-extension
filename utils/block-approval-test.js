'use strict';
// Ported onto the integrated approval pipeline: preparation is
// blockApproval.prepareBlockApproval, and sending is the approval operation's
// sendApprovalBlock given a begun preparation (beginPreparedSend), exactly as
// useBlockSender runs it. The worker's single-use claims across windows are
// request-identity-test's; the approval-screen behaviour is covered there too.
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
  state.binding = Object.freeze({ id: 'selection', scope: Object.freeze({ index: 0, address: address.toString() }) });
  const vault = {
    getBinding: () => state.binding,
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
  const load = loadModules(override);
  const service = load('src/services/wallet/blockApproval.js');
  const pipeline = load('src/services/wallet/approvalBlock.js').default;
  const prepare = (params = blockJson()) => service.prepareBlockApproval(params, { address: address.toString(), index: 0, nodeUrl: state.node, isCurrent: () => state.current });
  // useBlockSender's order: consume the preparation, then look up the key.
  const operation = { context: value => value, assertActive: async () => {}, signal: new AbortController().signal, expiresAt: Infinity };
  service.sendBlockApproval = async approval => {
    const begun = service.beginPreparedSend(approval);
    const key = await vault.getSigningKeyPair();
    return pipeline(zenon, null, key, operation, undefined, undefined, begun);
  };
  const hold = phase => { state.pause = phase; state.gate = { started: deferred(), release: deferred() }; return state.gate; };
  return { state, zenon, vault, service, prepare, hold, override };
};


(async () => {
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
    f => { f.state.binding = { ...f.state.binding }; }, f => { f.state.wallet = 'different'; },
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
  }  console.log('block approval: exact prepared fields, real SDK send/receive/embedded controls, current-context guards, delayed lifecycle, single use and signer identity passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
