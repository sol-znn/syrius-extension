'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const babel = require('@babel/core');
const { walletStorageState } = require('./fixtures/wallet-storage-state');

const root = path.join(__dirname, '..');
const fixture = (raw, unreadable = false) => {
  const state = { reads: 0, writes: 0, sdkReads: 0, raw };
  const storage = {
    getItem: key => {
      state.reads++;
      assert.equal(key, 'znn.ts-wallet');
      if (unreadable) throw new Error('Synthetic private storage diagnostic');
      return state.raw;
    },
    setItem: () => { state.writes++; throw new Error('A read must not write'); },
    removeItem: () => { state.writes++; throw new Error('A read must not remove'); },
  };
  const sdk = { KeyStoreManager: class {
    listAllKeyStores() { state.sdkReads++; return JSON.parse(storage.getItem('znn.ts-wallet') || '{}'); }
  } };
  const cache = new Map();
  const load = file => {
    const filename = path.resolve(root, file);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} }; cache.set(filename, mod);
    const { code } = babel.transformFileSync(filename, { presets: [['@babel/preset-env',
      { targets: { node: 'current' }, modules: 'commonjs' }]], babelrc: false, configFile: false });
    const resolve = id => id === 'znn-ts-sdk' ? sdk : id.startsWith('.')
      ? load(path.resolve(path.dirname(filename), id) + '.js') : require(id);
    new Function('module', 'exports', 'require', 'localStorage', code)(mod, mod.exports, resolve, storage);
    return mod.exports;
  };
  return { state, storage, ...load('src/services/utils/utils.js') };
};

let cases = 0;
for (const [raw, expected, diagnostic] of [[null, [], 'ABSENT'], ['{}', [], 'EMPTY_OBJECT'],
  ['{"A":{},"B":{}}', ['A', 'B'], 'NONEMPTY_OBJECT'],
  ['{"__proto__":{},"constructor":{}}', ['__proto__', 'constructor'], 'NONEMPTY_OBJECT']]) {
  const f = fixture(raw);
  assert.deepEqual(f.loadStorageWalletNames({ strict: true }), expected);
  assert.equal(f.state.sdkReads, 0);
  assert.equal(f.state.raw, raw); assert.equal(f.state.writes, 0);
  assert.equal(walletStorageState(f.storage), diagnostic); cases++;
}
for (const [raw, diagnostic] of [['', 'INVALID_JSON'], ['{broken', 'INVALID_JSON'],
  ['null', 'INVALID_SHAPE'], ['false', 'INVALID_SHAPE'], ['0', 'INVALID_SHAPE'],
  ['"private saved content"', 'INVALID_SHAPE'], ['[]', 'INVALID_SHAPE'], ['[{}]', 'INVALID_SHAPE']]) {
  const f = fixture(raw);
  assert.throws(() => f.loadStorageWalletNames({ strict: true }), error =>
    error.errorId === 225 && (raw === '' || !error.message.includes(raw)) && !error.message.includes('private saved content'));
  assert.equal(f.state.sdkReads, 0);
  assert.equal(f.state.raw, raw); assert.equal(f.state.writes, 0);
  assert.equal(walletStorageState(f.storage), diagnostic); cases++;
}
{
  const f = fixture('{"retained":{}}', true);
  assert.throws(() => f.loadStorageWalletNames({ strict: true }), error =>
    error.errorId === 225 && !error.message.includes('Synthetic private storage diagnostic'));
  assert.equal(walletStorageState(f.storage), 'UNREADABLE');
  assert.equal(f.state.raw, '{"retained":{}}'); assert.equal(f.state.writes, 0); cases++;
}
// Existing optional UI reads keep their contract. Only startup opts into the
// strict routing decision, so an unrelated validation flow is not rewritten.
for (const raw of ['{"A":{}}', '{broken']) {
  const f = fixture(raw);
  assert.deepEqual(f.loadStorageWalletNames(), raw === '{broken' ? [] : ['A']);
  assert.equal(f.state.sdkReads, 1); assert.equal(f.state.writes, 0); cases++;
}
console.log(JSON.stringify({ wallet_storage_read_controls: true, cases, passed: true }));
