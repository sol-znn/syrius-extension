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
  const zenon = sdk.Zenon.getSingleton(), emptyHash = sdk.Primitives.Hash.parse('00'.repeat(32));
  let published = 0, signed = 0, gate, mutate, networkFailure = false;
  const pause = async phase => { if (gate?.phase === phase) { const held = gate; gate = null; held.started.resolve(); await held.release.promise; } };
  const key = { getAddress: async () => account, getPublicKey: async () => Buffer.alloc(32, 7), sign: async bytes => {
    signed++; await pause('sign'); if (mutate) mutate(); return Buffer.alloc(64, 9);
  } };
  const vault = { getKeyPair: () => key, getSigningKeyPair: async () => { await pause('key'); return key; } };
  zenon.ledger.getFrontierBlock = async () => { await pause('rpc'); if (networkFailure) throw Error('Inert offline fixture'); return null; };
  zenon.ledger.getFrontierMomentum = async () => ({ hash: emptyHash, height: 1 });
  zenon.ledger.publishRawTransaction = async block => { await pause('publish'); published++; assert.equal(block.signature.length, 64); };
  zenon.embedded.plasma.getRequiredPoWForAccountBlock = async () => { await pause('pow'); return { requiredDifficulty: 0, basePlasma: 0, availablePlasma: 0 }; };
  const reactHook = { useCallback: fn => fn, useState: initial => [initial, () => {}] };
  const guardedLoad = loader(id => {
    if (id === './vault' || id.endsWith('/wallet/vault')) return { __esModule: true, default: vault };
    if (id === 'react') return reactHook;
    if (id === './useAccount') return { invalidateAccountCache() {} };
  });
  const { prepareCallApproval, templateForCallApproval } = guardedLoad('src/services/wallet/callApproval.js');
  const { send } = guardedLoad('src/services/hooks/useBlockSender.js').default();
  const blockFor = json => {
    const block = sdk.Primitives.AccountBlockTemplate.callContract(sdk.Primitives.Address.parse(json.toAddress), token, BigNumber.from(0), Buffer.from(json.data, 'base64'));
    return block.toJson();
  };
  const call = known('plasma', 'Fuse', [addressHex]);
  for (const data of [call.data, Array.from(Buffer.from(call.data, 'base64')), Buffer.from(call.data, 'base64').toJSON(), Uint8Array.from(Buffer.from(call.data, 'base64'))]) {
    const params = { ...blockFor(call), data };
    const approval = await prepareCallApproval(params);
    assert(Object.isFrozen(approval) && Object.isFrozen(approval.block));
    assert.equal(approval.block.data, call.data); assert.equal(decodeApprovalCall(approval.block).args[0].value, account.toString());
    params.data = ''; params.toAddress = reference.addresses.token;
    const template = templateForCallApproval(approval);
    await send(template, { approvedCall: approval, isCurrent: () => true });
    assert.equal(template.toJson().data, call.data);
  }
  const noncanonical = zenon.embedded.pillar.delegate('x'.repeat(17)).toJson();
  assert.equal(decodeApprovalCall(noncanonical).kind, 'unknownCall');
  const unknown = await prepareCallApproval(noncanonical), unknownTemplate = templateForCallApproval(unknown);
  await send(unknownTemplate, { approvedCall: unknown, isCurrent: () => true });
  assert.equal(unknownTemplate.toJson().data, noncanonical.data, 'Unknown SDK call bytes must be preserved');
  networkFailure = true;
  const offline = await prepareCallApproval(blockFor(call)); assert.equal(offline.networkPrepared, false); assert.equal(offline.block.data, call.data);
  networkFailure = false;
  await send(templateForCallApproval(offline), { approvedCall: offline, isCurrent: () => true });
  for (const phase of ['key', 'rpc', 'pow', 'sign']) {
    const approval = await prepareCallApproval(blockFor(call)), template = templateForCallApproval(approval);
    const held = { phase, started: deferred(), release: deferred() }; gate = held;
    let current = true; const before = published;
    const result = send(template, { approvedCall: approval, isCurrent: () => current });
    const denial = assert.rejects(result, /changed/); await held.started.promise; current = false; held.release.resolve(); await denial;
    assert.equal(published, before);
  }
  for (const field of ['data', 'toAddress', 'amount', 'tokenStandard', 'blockType']) {
    const approval = await prepareCallApproval(blockFor(call)), template = templateForCallApproval(approval);
    const held = { phase: 'pow', started: deferred(), release: deferred() }; gate = held;
    const before = published, beforeSign = signed;
    const result = send(template, { approvedCall: approval, isCurrent: () => true }), denial = assert.rejects(result, /changed/);
    await held.started.promise;
    if (field === 'data') template.data[0] ^= 1;
    else template[field] = ({ toAddress: account, amount: BigNumber.from(1), tokenStandard: sdk.Primitives.TokenStandard.parse('zts1znnxxxxxxxxxxxxx9z4ulx'), blockType: 3 })[field];
    held.release.resolve(); await denial; assert.equal(published, before); assert.equal(signed, beforeSign);
  }
  const duringSign = await prepareCallApproval(blockFor(call)), changedTemplate = templateForCallApproval(duringSign), before = published;
  mutate = () => { changedTemplate.data = Buffer.from([0]); };
  await assert.rejects(send(changedTemplate, { approvedCall: duringSign, isCurrent: () => true }), /changed/); mutate = null;
  assert.equal(published, before);
  // Ordinary transfer callers retain the hook's unguarded optional mode.
  await send(sdk.Primitives.AccountBlockTemplate.send(account, token, BigNumber.from(0)));
  assert.equal(published, before + 1);
  // A real pinned-SDK synthetic key confirms facade receiver/byte compatibility.
  // This signs a fixed benign message only; it never publishes a transaction.
  global.window.crypto = crypto.webcrypto; global.self = global.window;
  const syntheticKey = await new sdk.KeyStore().fromEntropy('00112233445566778899aabbccddeeff').getKeyPair(0).generateKeyPair();
  const realApproval = await prepareCallApproval(blockFor(call)), realTemplate = templateForCallApproval(realApproval);
  const realGuard = guardedLoad('src/services/wallet/callApproval.js').callSigningKey(syntheticKey, realApproval, realTemplate, () => true);
  const message = Buffer.from('Benign contract-approval key compatibility fixture');
  const sig = await realGuard.sign(message), pub = await realGuard.getPublicKey();
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pub)]), format: 'der', type: 'spki' });
  assert(crypto.verify(null, message, publicKey, Buffer.from(sig)));
  assert.equal((await realGuard.getAddress()).toString(), (await syntheticKey.getAddress()).toString());
  // Render the actual approval component and invoke its actual callbacks. React
  // scheduling is explicit; RPC/key/publication are the same inert SDK controls.
  const ui = initial => {
    const states = [], refs = [], callbacks = [], effects = [], notifications = [];
    let si, ri, ci, ei, tree, internalGate, queue = initial;
    const internalCalls = [];
    const state = { wallet: { address: account.toString(), isUnlocked: true }, connectionParameters: { chainIdentifier: 1, nodeUrl: 'wss://fixture.invalid' } };
    const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
    const hooks = { ...React,
      useState: initialValue => { const i = si++; if (!(i in states)) states[i] = initialValue; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
      useRef: initialValue => { const i = ri++; return refs[i] ||= { current: initialValue }; },
      useCallback: (fn, deps) => { const i = ci++; if (!same(callbacks[i]?.deps, deps)) callbacks[i] = { fn, deps }; return callbacks[i].fn; },
      useEffect: (fn, deps) => { const i = ei++; if (!same(effects[i]?.deps, deps)) effects[i] = { fn, deps, cleanup: effects[i]?.cleanup, pending: true }; },
    };
    const internal = async (method, params) => {
      internalCalls.push({ method, params });
      if (internalGate?.method === method) { const held = internalGate; internalGate = null; held.started.resolve(); await held.release.promise; }
      if (method === 'approvals.next') return queue;
      if (method === 'approvals.resolve' || method === 'approvals.reject') { if (params.id === queue?.id) queue = null; return true; }
      throw Error('Unexpected internal method ' + method);
    };
    const componentLoad = loader(id => {
      if (id === 'react') return hooks;
      if (id === 'react-router-dom') return { useNavigate: () => () => {} };
      if (id === 'react-redux') return { useSelector: selector => selector(state) };
      if (id === './vault' || id.endsWith('/wallet/vault')) return { __esModule: true, default: vault };
      if (id === './useAccount' || id.endsWith('/hooks/useAccount')) return { __esModule: true, default: () => ({ balanceMap: {} }), invalidateAccountCache() {} };
      if (id.endsWith('/utils/messaging')) return { sendInternal: internal };
      if (id.endsWith('/utils/notify')) return { notify: { success: x => notifications.push(x), error: x => notifications.push(String(x)) } };
      if (id.endsWith('/wallet/signMessage')) return { signMessage: async () => ({ fixture: true }) };
    }, { window: { close() {} }, setTimeout: (fn, ms) => setTimeout(fn, ms === 1200 ? 0 : ms) });
    const Component = componentLoad('src/layouts/siteIntegrationLayout/siteIntegrationLayout.js').default;
    const render = () => {
      si = ri = ci = ei = 0; tree = Component();
      for (const effect of effects) if (effect.pending) { effect.pending = false; effect.cleanup?.(); effect.cleanup = effect.fn(); }
      return tree;
    };
    const flatten = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(flatten) : [node, ...flatten(node.props?.children)];
    const button = text => flatten(tree).find(node => node.type === 'button' && node.props.children === text);
    const settle = async () => { for (let i = 0; i < 10; i++) { await tick(); render(); } };
    render();
    return { render, settle, state, notifications, internalCalls, holdInternal: method => (internalGate = { method, started: deferred(), release: deferred() }), button, markup: () => ReactDOMServer.renderToStaticMarkup(tree), next: value => { queue = value; },
      dispose: () => effects.forEach(effect => effect.cleanup?.()) };
  };
  const request = (id, json) => ({ id, type: 'signAndSendBlock', origin: 'https://fixture.invalid', params: blockFor(json) });
  {
    const first = request('displayed', call), fixture = ui(first); await fixture.settle();
    assert(fixture.markup().includes('Plasma beneficiary'));
    assert(fixture.markup().includes(account.toString()));
    const approved = fixture.button('Sign and send'); assert.equal(approved.props.disabled, false);
    // Mutating the caller-owned JSON after preparation cannot change signed arguments.
    first.params.data = ''; first.params.toAddress = reference.addresses.token;
    const count = published; await approved.props.onClick(); assert.equal(published, count + 1);
    fixture.dispose();
  }
  {
    const first = request('first', call), second = request('second', known('stake', 'Stake', [86400]));
    const fixture = ui(first); await fixture.settle(); const oldApprove = fixture.button('Sign and send').props.onClick;
    fixture.next(second); await fixture.button('Reject').props.onClick(); fixture.render();
    assert.equal(fixture.button('Sign and send').props.disabled, true, 'new request waits for its own preview');
    assert(!fixture.markup().includes('Plasma beneficiary'));
    const count = published; await oldApprove(); assert.equal(published, count);
    await fixture.settle(); assert(fixture.markup().includes('Duration (seconds)')); assert(fixture.markup().includes('86400'));
    await fixture.button('Sign and send').props.onClick(); assert.equal(published, count + 1); fixture.dispose();
  }
  {
    const first = request('slow-first', call), second = request('fast-second', known('stake', 'Stake', [42]));
    const held = { phase: 'rpc', started: deferred(), release: deferred() }; gate = held;
    const fixture = ui(first); await fixture.settle(); await held.started.promise;
    assert.equal(fixture.button('Sign and send').props.disabled, true);
    fixture.next(second); await fixture.button('Reject').props.onClick(); await fixture.settle();
    assert(fixture.markup().includes('Duration (seconds)'));
    held.release.resolve(); await fixture.settle(); assert(fixture.markup().includes('Duration (seconds)'));
    assert(!fixture.markup().includes('Plasma beneficiary')); fixture.dispose();
  }
  {
    const fixture = ui(request('unknown', { ...call, data: Buffer.from([0,1,2,3]).toString('base64') })); await fixture.settle();
    assert(fixture.markup().includes('cannot fully interpret')); assert.equal(fixture.button('Sign and send').props.disabled, false);
    const count = published; await fixture.button('Sign and send').props.onClick(); assert.equal(published, count + 1); fixture.dispose();
  }
  {
    const malformed = request('invalid-normalization', call); malformed.params.toAddress = 'invalid';
    const fixture = ui(malformed); await fixture.settle(); assert(fixture.markup().includes('Unable to prepare'));
    assert.equal(fixture.button('Sign and send').props.disabled, true); fixture.dispose();
  }
  // Submission is explicitly irrevocable: Reject is disabled and even a
  // captured pre-render callback cannot falsely cancel the approved operation.
  for (const phase of ['key', 'rpc', 'pow', 'sign', 'publish']) {
    const fixture = ui(request('submit-' + phase, call)); await fixture.settle();
    const rejectBeforeRender = fixture.button('Reject').props.onClick;
    const held = { phase, started: deferred(), release: deferred() }; gate = held;
    const count = published, result = fixture.button('Sign and send').props.onClick();
    await rejectBeforeRender(); await held.started.promise; await fixture.settle();
    assert.equal(fixture.button('Reject').props.disabled, true);
    assert(fixture.markup().includes('can no longer be rejected'));
    await fixture.button('Reject').props.onClick();
    assert.equal(fixture.internalCalls.filter(x => x.method === 'approvals.reject').length, 0);
    held.release.resolve(); await result; assert.equal(published, count + 1);
    assert.equal(fixture.internalCalls.filter(x => x.method === 'approvals.resolve').length, 1);
    fixture.dispose();
  }
  // Rejection first invalidates the captured approval before messaging/render.
  {
    const first = request('reject-first', call), fixture = ui(first); await fixture.settle();
    const approveBeforeRender = fixture.button('Sign and send').props.onClick;
    const held = fixture.holdInternal('approvals.reject'), count = signed;
    const result = fixture.button('Reject').props.onClick(); await held.started.promise;
    await approveBeforeRender(); fixture.render(); assert.equal(signed, count);
    assert.equal(fixture.button('Sign and send').props.disabled, true);
    fixture.next(request('after-rejection', known('stake', 'Stake', [42])));
    held.release.resolve(); await result; await fixture.settle();
    assert.equal(fixture.button('Sign and send').props.disabled, false); fixture.dispose();
  }
  // Late network preparation cannot revive a request already rejected locally.
  {
    const held = { phase: 'rpc', started: deferred(), release: deferred() }; gate = held;
    const fixture = ui(request('rejected-preparation', call)); await fixture.settle(); await held.started.promise;
    const rejecting = fixture.holdInternal('approvals.reject'), result = fixture.button('Reject').props.onClick();
    await rejecting.started.promise; held.release.resolve(); await fixture.settle();
    assert.equal(fixture.button('Sign and send').props.disabled, true);
    assert(!fixture.markup().includes('Plasma beneficiary'));
    fixture.next(request('fresh-after-rejection', known('stake', 'Stake', [42])));
    rejecting.release.resolve(); await result; await fixture.settle();
    assert.equal(fixture.button('Sign and send').props.disabled, false); fixture.dispose();
  }
  if (process.env.SYRIUS_CALL_UI_ARTIFACT_DIR) {
    const dir = path.resolve(process.env.SYRIUS_CALL_UI_ARTIFACT_DIR); fs.mkdirSync(dir, { recursive: true });
    const css = require('sass').compile(path.join(root, 'src/sections/Popup/Popup.scss')).css;
    const samples = [
      ['token', known('token', 'IssueToken', ['Community token', 'COMM', 'community.invalid', '100000000000000000000000000001', '200000000000000000000000000000', 8, true, false, false])],
      ['htlc', known('htlc', 'Create', [addressHex, 1900000000, 0, 32, '0x' + '7a'.repeat(32)])],
      ['unicode', known('pillar', 'Delegate', ['Leading BOM: \ufeff and direction: \u202e / ordinary Unicode 界 🌍'])],
      ['arrays', known('liquidity', 'SetTokenTuple', [[token.toString(), 'zts1znnxxxxxxxxxxxxx9z4ulx'], [5000, 5000], [2500, 7500], ['100000000000000000001', '200000000000000000002']])],
      ['guardians', known('bridge', 'NominateGuardians', [[addressHex, '0x00' + '43'.repeat(19), '0x00' + '44'.repeat(19)]])],
      ['administrator', known('bridge', 'ProposeAdministrator', [addressHex])],
    ];
    for (const [name, json] of samples) {
      const fixture = ui(request('layout-' + name, json)); await fixture.settle();
      fs.writeFileSync(path.join(dir, name + '.html'), '<!doctype html><meta charset="utf-8"><style>' + css + '</style><body class="standalone-window"><div id="app-container"><div class="popup"><div class="main-layout">' + fixture.markup() + '</div></div></div></body>');
      fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(decodeApprovalCall(json).args.map(arg => arg.display)));
      fixture.dispose();
    }
    console.log('UI layout fixtures: ' + dir);
  }
  console.log(`contract arguments: ${calls} pinned signatures, ${argumentsChecked} visible arguments, strict ABI/Unicode controls, canonical SDK forms, actual approval callbacks and guarded signing checks passed`);
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
