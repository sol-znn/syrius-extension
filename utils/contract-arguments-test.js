'use strict';
// Defensive checks against the corrected decoder and signing path. Encodings
// come from ethers, selectors from Node SHA3 and schemas from pinned go-zenon.
// All RPC/PoW/publication services are inert. No live wallet or node is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const babel = require('@babel/core');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const { utils: eth, BigNumber } = require('ethers');
global.window = { crypto: crypto.webcrypto };
global.self = global.window;
const sdk = require('znn-ts-sdk');
const memory = new Map();
global.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key) };
const root = path.join(__dirname, '..');
const reference = require('./fixtures/contract-call-abi-reference.json');
const appSchemas = require('../src/services/utils/contractCallSchemas.json');
const cache = new Map();
const loader = (overrides = () => undefined, environment = {}) => {
  const modules = new Map();
  const load = file => {
    const filename = path.resolve(root, file);
    if (filename.endsWith('.json')) return JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    if (!cache.has(filename)) cache.set(filename, babel.transformFileSync(filename, {
      presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'], configFile: false, babelrc: false,
    }).code);
    const requireModule = id => {
      const replaced = overrides(id); if (replaced !== undefined) return replaced;
      if (!id.startsWith('.')) return require(id);
      const target = path.resolve(path.dirname(filename), id);
      return load(path.extname(target) ? target : target + '.js');
    };
    new Function('module', 'exports', 'require', ...Object.keys(environment), cache.get(filename))(
      module, module.exports, requireModule, ...Object.values(environment));
    return module.exports;
  };
  return load;
};
const load = loader();
const { decodeApprovalCall, displayString } = load('src/services/utils/approvalContractCalls.js');
const { decodeCall, signatures } = load('src/services/utils/contractCalls.js');
const ArgumentRows = load('src/components/contract-call-arguments/contract-call-arguments.js').default;
const signature = method => `${method.name}(${method.inputs.map(x => x.type).join(',')})`;
const selector = text => crypto.createHash('sha3-256').update(text).digest().subarray(0, 4);
const mapping = type => type.endsWith('[]') ? mapping(type.slice(0, -2)) + '[]' : ({ tokenStandard: 'uint80', hash: 'bytes32' })[type] || type;
const encode = (method, values) => Buffer.concat([selector(signature(method)), Buffer.from(eth.defaultAbiCoder.encode(method.inputs.map(x => mapping(x.type)), values).slice(2), 'hex')]);
const addressHex = '0x00' + '42'.repeat(19), tokenHex = '0x' + '13'.repeat(10);
const account = new sdk.Primitives.Address('z', Buffer.from(addressHex.slice(2), 'hex'));
const token = new sdk.Primitives.TokenStandard(Buffer.from(tokenHex.slice(2), 'hex'));
const valueFor = (type, index) => {
  if (type.endsWith('[]')) return [valueFor(type.slice(0, -2), index), valueFor(type.slice(0, -2), index + 1)];
  if (type === 'address') return addressHex;
  if (type === 'tokenStandard') return tokenHex;
  if (type === 'hash') return '0x' + '7a'.repeat(32);
  if (type === 'string') return `Zenon Δ ${index} 🌍`;
  if (type === 'bytes') return '0x0001feff';
  if (type === 'bool') return index % 2 === 0;
  if (type === 'int64') return '86400';
  return BigNumber.from(2).pow(Number(type.slice(4))).sub(index + 1).toString();
};
const expectedFor = (type, value) => {
  if (type.endsWith('[]')) return value.map(entry => expectedFor(type.slice(0, -2), entry));
  if (type === 'address') return account.toString();
  if (type === 'tokenStandard') return token.toString();
  if (type === 'hash') return value.slice(2);
  return String(value);
};
const upstream = contract => reference.definitions[contract === 'pillar' ? 'pillars' : contract];
const methodFor = (contract, name) => upstream(contract).find(x => x.name === name);
const jsonFor = (contract, method, values) => ({ blockType: 2, toAddress: reference.addresses[contract], data: encode(method, values).toString('base64') });
const known = (contract, name, values) => jsonFor(contract, methodFor(contract, name), values);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const watchdog = setTimeout(() => { console.error('Contract argument checks timed out'); process.exit(1); }, 30000);
(async () => {
  let calls = 0, argumentsChecked = 0;
  assert.equal(appSchemas.revision, reference.revision);
  for (const [contract, schema] of Object.entries(appSchemas.contracts)) {
    assert.equal(schema.address, reference.addresses[contract]);
    const expectedMethods = upstream(contract); // Every function in the pinned protocol, independently of the history subset.
    assert.deepEqual(schema.methods, expectedMethods.map(({ name, inputs }) => ({ name, inputs })));
    for (const method of expectedMethods) {
      const values = method.inputs.map((arg, index) => valueFor(arg.type, index));
      const json = jsonFor(contract, method, values), decoded = decodeApprovalCall(json);
      assert.equal(decoded.kind, 'knownCall', contract + '.' + method.name); assert.equal(decoded.method, method.name);
      assert.equal(decoded.to, schema.address); assert.equal(decoded.args.length, method.inputs.length);
      const markup = ReactDOMServer.renderToStaticMarkup(React.createElement(ArgumentRows, { args: decoded.args }));
      method.inputs.forEach((arg, index) => {
        const actual = decoded.args[index], expected = expectedFor(arg.type, values[index]);
        assert.equal(actual.name, arg.name); assert.equal(actual.type, arg.type); assert.deepEqual(actual.value, expected);
        const visible = ReactDOMServer.renderToStaticMarkup(React.createElement('dd', null, actual.display));
        assert(markup.includes(visible), 'Full argument must be visible without details/tooltip');
        if (Array.isArray(expected)) {
          expected.forEach((entry, i) => assert(actual.display.includes(`${i + 1}. ${arg.type === 'string[]' ? JSON.stringify(entry) : entry}`)));
        } else assert.equal(actual.display, arg.type === 'string' ? JSON.stringify(expected) : expected);
        argumentsChecked++;
      });
      if (!method.inputs.length) assert(markup.includes('no arguments'));
      assert(!markup.includes('<details') && !markup.includes(' title='));
      assert.equal(decodeCall(contract, selector(signature(method)).toString('base64')), signatures[contract].includes(signature(method)) ? method.name : null, 'history selector API unchanged');
      const bytes = Buffer.from(json.data, 'base64');
      for (const data of [bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.alloc(32)])]) {
        assert.equal(decodeApprovalCall({ ...json, data: data.toString('base64') }).kind, 'unknownCall');
      }
      calls++;
    }
  }
  assert.equal(calls, 77);
  // Array controls cover empty/nonempty tails and visible ordered values.
  for (const guardians of [[], [addressHex], [addressHex, addressHex, addressHex]]) {
    const decoded = decodeApprovalCall(known('bridge', 'NominateGuardians', [guardians]));
    assert.equal(decoded.kind, 'knownCall'); assert.deepEqual(decoded.args[0].value, guardians.map(() => account.toString()));
    assert(Object.isFrozen(decoded.args[0].value));
    if (!guardians.length) assert.equal(decoded.args[0].display, '(empty list)');
  }
  for (const names of [[], [''], ['\ufeffToken', 'second\u202e', '界🌍']]) {
    const decoded = decodeApprovalCall(known('liquidity', 'SetTokenTuple', [names, names.map(() => 100), names.map(() => 200), names.map(() => '9999999999999999999999')]));
    assert.equal(decoded.kind, 'knownCall'); assert.deepEqual(decoded.args[0].value, names);
    assert(!/[\p{Cf}\p{Zl}\p{Zp}]/u.test(decoded.args[0].display));
    names.forEach((value, i) => assert.equal(JSON.parse(decoded.args[0].display.split('\n')[i].slice(3)), value));
  }
  assert.equal(decodeApprovalCall(known('bridge', 'ProposeAdministrator', [addressHex])).args[0].label, 'Proposed administrator');
  // Signed bounds, empty strings/bytes, Unicode and formatting controls remain exact.
  for (const duration of ['-9223372036854775808', '-1', '0', '9223372036854775807']) {
    assert.equal(decodeApprovalCall(known('stake', 'Stake', [duration])).args[0].value, duration);
  }
  for (const name of ['', 'x'.repeat(17), 'x'.repeat(32), 'x'.repeat(33), '\ufeffA\u202eB\u0000\n\u{e0001}', '界🌍']) {
    const decoded = decodeApprovalCall(known('pillar', 'Delegate', [name]));
    assert.equal(decoded.kind, 'knownCall'); assert.equal(decoded.args[0].value, name);
    assert.equal(JSON.parse(decoded.args[0].display), name);
    assert(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(decoded.args[0].display));
  }
  assert.equal(decodeApprovalCall(known('htlc', 'Unlock', ['0x' + '00'.repeat(32), '0x'])).args[1].display, '0x');
  const mutateWord = (json, index, number) => {
    const bytes = Buffer.from(json.data, 'base64'); Buffer.from(BigInt(number).toString(16).padStart(64, '0'), 'hex').copy(bytes, 4 + index * 32);
    return { ...json, data: bytes.toString('base64') };
  };
  const invalid = [
    mutateWord(known('token', 'UpdateToken', [tokenHex, addressHex, true, false]), 2, 2n),
    mutateWord(known('stake', 'Stake', ['-1']), 0, (1n << 64n) - 1n),
    mutateWord(known('htlc', 'Create', [addressHex, 1, 0, 32, '0x1234']), 2, 256n),
    mutateWord(known('token', 'Mint', [tokenHex, 1, addressHex]), 0, 1n << 80n),
    mutateWord(known('plasma', 'Fuse', [addressHex]), 0, 1n << 160n),
    mutateWord(known('pillar', 'Delegate', ['abc']), 0, 0n),
    mutateWord(known('pillar', 'Delegate', ['abc']), 0, 33n),
    mutateWord(known('pillar', 'Delegate', ['abc']), 1, (1n << 256n) - 1n),
    mutateWord(known('bridge', 'NominateGuardians', [[addressHex]]), 1, (1n << 256n) - 1n),
    mutateWord(known('bridge', 'NominateGuardians', [[addressHex]]), 2, 1n << 160n),
  ];
  const text = known('pillar', 'Delegate', ['abc']);
  for (const [position, value] of [[68, 255], [99, 1]]) {
    const bytes = Buffer.from(text.data, 'base64'); bytes[position] = value; invalid.push({ ...text, data: bytes.toString('base64') });
  }
  const arrays = known('liquidity', 'SetTokenTuple', [['abc', 'def'], [100, 200], [300, 400], ['500', '600']]);
  for (const [index, value] of [[5, 0n], [5, 65n], [6, 64n], [5, (1n << 256n) - 1n]]) invalid.push(mutateWord(arrays, index, value));
  for (const [position, value] of [[260, 255], [291, 1]]) {
    const bytes = Buffer.from(arrays.data, 'base64'); bytes[position] = value; invalid.push({ ...arrays, data: bytes.toString('base64') });
  }
  // Locate the uint32 array through its independently encoded outer offset.
  const uintArrayWord = Number(BigInt('0x' + Buffer.from(arrays.data, 'base64').subarray(36, 68).toString('hex'))) / 32;
  invalid.push(mutateWord(arrays, uintArrayWord + 1, 1n << 32n));
  for (const json of invalid) assert.equal(decodeApprovalCall(json).kind, 'unknownCall');
  assert.equal(decodeApprovalCall({ ...text, blockType: 3 }).kind, 'unknownCall');
  assert.equal(decodeApprovalCall({ ...text, toAddress: account.toString() }).kind, 'unknownCall');
  assert.equal(decodeApprovalCall({ ...text, toAddress: account.toString(), data: '' }).kind, 'transfer');
  assert.equal(decodeApprovalCall({ ...text, data: 'AA=A' }).kind, 'unknownCall');
  assert.equal(decodeApprovalCall({ ...text, toAddress: text.toAddress.slice(0, -1) + 'q' }).kind, 'unknownCall');
  const unsupported = { name: 'SetVariables', inputs: ['uint64','uint64','uint64','uint8','uint8'].map((type, i) => ({ name: 'v' + i, type })) };
  assert.equal(decodeApprovalCall(jsonFor('plasma', unsupported, [1,2,3,4,5])).kind, 'unknownCall');

  // Exercise the actual pinned SDK pipeline with inert ledger/PoW responses.
  //
  // Ported onto the integrated approval path: an arbitrary block is prepared
  // once (blockApproval.prepareBlockApproval) and that frozen preparation is
  // what the approval operation signs (sendApprovalBlock with a begun
  // preparation), so the canonical calldata shown is the calldata signed.
  // There is no offline review: a block that cannot be prepared cannot be
  // approved. The approval screen's argument display and reject-first
  // behaviour are exercised in request-identity-test against the real worker.
  const zenon = sdk.Zenon.getSingleton(), emptyHash = sdk.Primitives.Hash.parse('00'.repeat(32));
  let published = 0, signed = 0, gate, mutate, networkFailure = false, current = true;
  const pause = async phase => { if (gate?.phase === phase) { const held = gate; gate = null; held.started.resolve(); await held.release.promise; } };
  const key = { getAddress: async () => account, getPublicKey: async () => Buffer.alloc(32, 7), sign: async bytes => {
    signed++; await pause('sign'); if (mutate) mutate(); return Buffer.alloc(64, 9);
  } };
  const binding = Object.freeze({ id: 'selection', scope: Object.freeze({ index: 0, address: account.toString() }) });
  const vault = { getKeyPair: () => key, getSigningKeyPair: async () => { await pause('key'); return key; },
    getBinding: () => binding, isUnlocked: () => true, getWalletName: () => 'fixture', getSelectedIndex: () => 0 };
  zenon.ledger.getFrontierBlock = async () => { await pause('rpc'); if (networkFailure) throw Error('Inert offline fixture'); return null; };
  zenon.ledger.getFrontierMomentum = async () => ({ hash: emptyHash, height: 1 });
  zenon.ledger.publishRawTransaction = async block => { await pause('publish'); published++; assert.equal(block.signature.length, 64); };
  zenon.embedded.plasma.getRequiredPoWForAccountBlock = async () => { await pause('pow'); return { requiredDifficulty: 0, basePlasma: 0, availablePlasma: 0 }; };
  const guardedLoad = loader(id => {
    if (id === './vault' || id.endsWith('/wallet/vault')) return { __esModule: true, default: vault };
  });
  const service = guardedLoad('src/services/wallet/blockApproval.js');
  const pipeline = guardedLoad('src/services/wallet/approvalBlock.js').default;
  const prepare = params => service.prepareBlockApproval(params, { address: account.toString(), index: 0, isCurrent: () => current });
  // useBlockSender's order: consume the preparation, then look up the key.
  const operation = { context: value => value, assertActive: async () => {}, signal: new AbortController().signal, expiresAt: Infinity };
  const sendPrepared = async approval => {
    const begun = service.beginPreparedSend(approval);
    const signer = await vault.getSigningKeyPair();
    return { begun, sending: pipeline(zenon, null, signer, operation, undefined, undefined, begun) };
  };
  const send = async approval => (await sendPrepared(approval)).sending;
  const blockFor = json => {
    const block = sdk.Primitives.AccountBlockTemplate.callContract(sdk.Primitives.Address.parse(json.toAddress), token, BigNumber.from(0), Buffer.from(json.data, 'base64'));
    return block.toJson();
  };
  const call = known('plasma', 'Fuse', [addressHex]);
  // Every calldata form that can reach the popup (it arrives through JSON
  // messaging and storage) prepares to the same canonical bytes, and those are
  // the bytes signed however the page's own object changes afterwards.
  for (const data of [call.data, Array.from(Buffer.from(call.data, 'base64')), Buffer.from(call.data, 'base64').toJSON()]) {
    const params = { ...blockFor(call), data };
    const approval = await prepare(params);
    assert(Object.isFrozen(approval) && Object.isFrozen(approval.block));
    assert.equal(approval.block.data, call.data); assert.equal(decodeApprovalCall(approval.block).args[0].value, account.toString());
    params.data = ''; params.toAddress = reference.addresses.token;
    const sentBlock = await send(approval);
    assert.equal(sentBlock.toJson().data, call.data);
  }
  // A raw typed array cannot survive JSON transport; its index-keyed remains
  // are refused rather than read as some other calldata.
  await assert.rejects(prepare({ ...blockFor(call), data: Uint8Array.from(Buffer.from(call.data, 'base64')) }));
  const noncanonical = zenon.embedded.pillar.delegate('x'.repeat(17)).toJson();
  assert.equal(decodeApprovalCall(noncanonical).kind, 'unknownCall');
  const unknown = await prepare(noncanonical);
  assert.equal((await send(unknown)).toJson().data, noncanonical.data, 'Unknown SDK call bytes must be preserved');
  networkFailure = true;
  await assert.rejects(prepare(blockFor(call)), /offline/);
  networkFailure = false;
  // A preparation that stops being current at any stage signs and publishes nothing further.
  for (const phase of ['key', 'pow', 'sign']) {
    const approval = await prepare(blockFor(call));
    const held = { phase, started: deferred(), release: deferred() }; gate = held;
    const before = published;
    const result = send(approval);
    const denial = assert.rejects(result, /no longer current/); await held.started.promise; current = false; held.release.resolve(); await denial;
    current = true; assert.equal(published, before);
  }
  // Any reviewed field changing underneath the signer is refused before signing.
  for (const field of ['data', 'toAddress', 'amount', 'tokenStandard', 'blockType']) {
    const approval = await prepare(blockFor(call));
    const held = { phase: 'pow', started: deferred(), release: deferred() }; gate = held;
    const before = published, beforeSign = signed;
    const { begun, sending } = await sendPrepared(approval); const denial = assert.rejects(sending, /no longer current/);
    await held.started.promise;
    const template = begun.template;
    if (field === 'data') template.data[0] ^= 1;
    else template[field] = ({ toAddress: account, amount: BigNumber.from(1), tokenStandard: sdk.Primitives.TokenStandard.parse('zts1znnxxxxxxxxxxxxx9z4ulx'), blockType: 3 })[field];
    held.release.resolve(); await denial; assert.equal(published, before); assert.equal(signed, beforeSign);
  }
  {
    const approval = await prepare(blockFor(call)), before = published;
    const { begun, sending } = await sendPrepared(approval);
    mutate = () => { begun.template.data = Buffer.from([0]); };
    await assert.rejects(sending, /no longer current/); mutate = null;
    assert.equal(published, before);
  }
  // A real pinned-SDK synthetic key signs through the guarded path: the bytes
  // are the reviewed block's hash, verifiable against the key.
  global.window.crypto = crypto.webcrypto; global.self = global.window;
  const syntheticKey = await new sdk.KeyStore().fromEntropy('00112233445566778899aabbccddeeff').getKeyPair(0).generateKeyPair();
  {
    const syntheticAddress = await syntheticKey.getAddress();
    const syntheticBinding = Object.freeze({ id: 'synthetic', scope: Object.freeze({ index: 0, address: syntheticAddress.toString() }) });
    const realVault = { ...vault, getKeyPair: () => syntheticKey, getSigningKeyPair: async () => syntheticKey, getBinding: () => syntheticBinding };
    const realLoad = loader(id => (id === './vault' || id.endsWith('/wallet/vault') ? { __esModule: true, default: realVault } : undefined));
    const realService = realLoad('src/services/wallet/blockApproval.js');
    const realApproval = await realService.prepareBlockApproval(blockFor(call), { address: syntheticAddress.toString(), index: 0, isCurrent: () => true });
    const realSent = await realLoad('src/services/wallet/approvalBlock.js').default(zenon, null, syntheticKey, operation, undefined, undefined,
      realService.beginPreparedSend(realApproval));
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(await syntheticKey.getPublicKey())]), format: 'der', type: 'spki' });
    assert(crypto.verify(null, Buffer.from(realSent.hash.getBytes()), publicKey, Buffer.from(realSent.signature)));
    assert.equal(realSent.toJson().data, call.data);
  }
  console.log(`contract arguments: ${calls} pinned signatures, ${argumentsChecked} visible arguments, strict ABI/Unicode controls, canonical SDK forms and prepared-block signing checks passed`);
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
