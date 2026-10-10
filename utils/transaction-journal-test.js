'use strict';

// The real journal and publisher modules, with real Web Crypto, against a
// simulated node. The vault, localStorage, Web Locks and the clock are
// fixtures; no wallet, key, browser profile or network is used.
const assert = require('node:assert/strict');
const path = require('node:path');
const babel = require('@babel/core');

const root = path.join(__dirname, '..');
const compiled = new Map();
const genesisA = 'a'.repeat(64), genesisB = 'b'.repeat(64);
const hashOf = (label) => require('node:crypto').createHash('sha256').update(label).digest('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));

// One browser profile: a localStorage, a lock manager and a clock that several
// "windows" (separately loaded copies of the module) share.
const profile = () => {
  const stored = new Map();
  let chain = Promise.resolve(), now = 1_800_000_000_000;
  return {
    stored,
    localStorage: {
      getItem: (key) => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => { stored.set(key, String(value)); },
      removeItem: (key) => { stored.delete(key); },
    },
    navigator: { locks: { request: (name, operation) => {
      const run = chain.then(() => operation());
      chain = run.then(() => {}, () => {});
      return run;
    } } },
    Date: { now: () => now },
    advance: (ms) => { now += ms; },
  };
};

// A window: its own copy of the modules, its own unlocked (or locked) vault.
const windowOf = (shared, { entropy = 'fixture-entropy-one', chain = 69 } = {}) => {
  const session = { entropy, id: 'lease-1', generation: 1, locked: false, lockListeners: [] };
  const vault = {
    capture: () => {
      if (session.locked) throw Object.assign(new Error('Wallet is locked'), { code: 'WALLET_LOCKED' });
      return { id: session.id, generation: session.generation };
    },
    isCurrent: (scope) => !session.locked && scope.id === session.id && scope.generation === session.generation,
    getEntropy: async () => { vault.capture(); return session.entropy; },
    onLock: (listener) => { session.lockListeners.push(listener); },
  };
  const intervals = new Set();
  const sdk = { Zenon: { getChainIdentifier: () => chain }, utils: { BlockUtils: {} } };
  const cache = new Map();
  const load = (file) => {
    const filename = path.join(root, file);
    if (cache.has(filename)) return cache.get(filename).exports;
    if (!compiled.has(filename)) compiled.set(filename, babel.transformFileSync(filename, {
      presets: [['@babel/preset-env', { targets: { node: 'current' } }]], configFile: false, babelrc: false,
    }).code);
    const module = { exports: {} };
    cache.set(filename, module);
    const resolve = (id) => {
      if (id === 'znn-ts-sdk') return sdk;
      if (id === './vault') return { __esModule: true, default: vault };
      if (id === './journal') return load('src/services/wallet/journal.js');
      throw new Error('Unexpected import: ' + id);
    };
    new Function('module', 'exports', 'require', 'localStorage', 'navigator', 'crypto', 'Date', 'setInterval', 'clearInterval',
      compiled.get(filename))(module, module.exports, resolve, shared.localStorage, shared.navigator, globalThis.crypto,
      shared.Date, (callback) => { const handle = { callback }; intervals.add(handle); return handle; },
      (handle) => intervals.delete(handle));
    return module.exports;
  };
  return {
    journal: load('src/services/wallet/journal.js').default,
    publisher: () => load('src/services/wallet/publisher.js').default,
    sdk, session, intervals,
    lock: () => { session.locked = true; session.lockListeners.forEach((listener) => listener()); },
    unlock: () => { session.locked = false; session.generation += 1; },
    setChain: (value) => { chain = value; },
  };
};

// The node, as far as the journal can see it: one chain per address, pooled or
// confirmed blocks at each height, and a publish call that can be told to
// accept and stay silent, to drop the block, or to refuse it.
const nodeOf = (genesis = genesisA) => {
  const chains = new Map(), calls = [];
  const node = {
    genesis, calls, mode: 'accept', published: [],
    at: (address, height) => (chains.get(address) || new Map()).get(height) || null,
    put: (address, height, hash, confirmed) => {
      if (!chains.has(address)) chains.set(address, new Map());
      chains.get(address).set(height, { hash, height, address, confirmationDetail: confirmed ? { numConfirmations: 3 } : null });
    },
    confirm: (address, height) => { node.at(address, height).confirmationDetail = { numConfirmations: 3 }; },
    sendRequest: async (method, params) => {
      calls.push(method);
      if (node.offline) throw new Error('socket not ready');
      if (node.mute === 'all' || (node.mute === 'publish' && method === 'ledger.publishRawTransaction')) return new Promise(() => {});
      if (method === 'ledger.getMomentumsByHeight') return { list: [{ hash: node.genesis, height: 1 }] };
      if (method === 'ledger.getAccountBlocksByHeight') {
        const found = node.at(params[0], params[1]);
        return { list: found ? [found] : [], count: found ? 1 : 0 };
      }
      if (method === 'ledger.publishRawTransaction') {
        const [json] = params;
        node.published.push(JSON.stringify(json));
        if (node.mode === 'refuse') throw { code: -32000, message: 'account-block previous block is missing' };
        if (node.mode === 'drop') throw new Error('reply timeout');
        const held = node.at(json.address, json.height);
        if (held && held.hash !== json.hash) throw { code: -32000, message: 'hash tie-break is worse for current block' };
        node.put(json.address, json.height, json.hash, false);
        if (node.mode === 'silent') throw new Error('reply timeout');
        return null;
      }
      throw new Error('Unexpected RPC: ' + method);
    },
  };
  const zenon = { ledger: { client: node, publishRawTransaction: (block) => node.sendRequest('ledger.publishRawTransaction', [block.toJson()]) } };
  return { node, zenon };
};
const blockOf = (address, height, label = `${address}#${height}`) => {
  const json = { address, height, hash: hashOf(label), previousHash: hashOf(label + 'p'), data: label, signature: 'fixture-signature' };
  return { hash: { toString: () => json.hash }, address: { toString: () => json.address }, height, toJson: () => ({ ...json }) };
};
const sendOnce = async (journal, zenon, address, height, label) => {
  const block = blockOf(address, height, label);
  await journal.run(zenon, address, {}, (entry) => entry.publish(block, () => zenon.ledger.publishRawTransaction(block)));
  return block;
};
const statesOf = async (journal, zenon, address) =>
  (await journal.reconcile(zenon, address)).records.map((record) => record.state);
const rejectsWith = (promise, code) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  return true;
});

const alice = 'z1qfixtureaccountalice', bob = 'z1qfixtureaccountbob';

(async () => {
  // Encrypted at rest: the stored value names no account, hash or wallet, and
  // only the same seed, unlocked, reads it back.
  {
    const shared = profile(), a = windowOf(shared), { zenon, node } = nodeOf();
    const block = await sendOnce(a.journal, zenon, alice, 1);
    assert.equal(shared.stored.size, 1);
    const [[key, raw]] = [...shared.stored];
    assert.match(key, /^syrius\.journal\.[0-9a-f]{32}$/);
    for (const secret of [alice, block.hash.toString(), 'fixture-entropy-one', 'fixture-signature', 'publishing', 'accepted', genesisA]) {
      assert(!raw.includes(secret) && !key.includes(secret), `stored journal exposes ${secret}`);
    }
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['data', 'iv', 'version']);
    assert.deepEqual(await statesOf(a.journal, zenon, alice), ['accepted']);

    // Another wallet in the same browser gets its own file and cannot open this one.
    const other = windowOf(shared, { entropy: 'fixture-entropy-two' });
    assert.deepEqual(await statesOf(other.journal, zenon, alice), []);
    assert.notEqual(await other.journal.storageKey(), key);
    shared.stored.set(await other.journal.storageKey(), raw);
    await rejectsWith(other.journal.reconcile(zenon, alice), 'JOURNAL_UNAVAILABLE');
    // A failed read is never followed by a write over what could not be read.
    assert.equal(shared.stored.get(await other.journal.storageKey()), raw);

    // Locked: no key, no read, no turn.
    a.lock();
    await rejectsWith(a.journal.reconcile(zenon, alice), 'WALLET_LOCKED');
    await rejectsWith(a.journal.begin(zenon, alice), 'WALLET_LOCKED');
    a.unlock();
    assert.deepEqual(await statesOf(a.journal, zenon, alice), ['accepted']);
    node.confirm(alice, 1);
    assert.deepEqual(await statesOf(a.journal, zenon, alice), ['observed']);
  }

  // The signed block is on record before the node is contacted.
  {
    const shared = profile(), a = windowOf(shared), reader = windowOf(shared), { zenon } = nodeOf();
    const block = blockOf(alice, 1);
    let seen;
    await a.journal.run(zenon, alice, {}, (entry) => entry.publish(block, async () => {
      // Read without the lock this call sits under: the record is already there.
      seen = shared.stored.size;
      return zenon.ledger.publishRawTransaction(block);
    }));
    assert.equal(seen, 1, 'nothing was recorded before sending began');
    const [record] = (await reader.journal.reconcile(zenon, alice)).records;
    assert.equal(record.hash, block.hash.toString());
    assert.equal(record.block, undefined, 'summaries do not carry the signed block');
  }

  // A lost reply: the block is looked up, never signed again.
  for (const scenario of ['landed', 'never-arrived', 'still-silent', 'superseded', 'contested']) {
    const shared = profile(), a = windowOf(shared), { zenon, node } = nodeOf();
    const block = blockOf(alice, 5);
    node.mode = scenario === 'landed' ? 'silent' : 'drop';
    await rejectsWith(a.journal.run(zenon, alice, {}, (entry) => entry.publish(block, () => zenon.ledger.publishRawTransaction(block))),
      'JOURNAL_UNKNOWN_OUTCOME');
    assert.equal(node.published.length, 1);
    const original = node.published[0];

    // A fresh window after a restart has only the record to go on.
    const b = windowOf(shared);
    if (scenario === 'landed') {
      node.mode = 'accept';
      const entry = await b.journal.begin(zenon, alice);
      await entry.release();
      assert.equal(node.published.length, 1, 'a block the node already holds was sent again');
      assert.deepEqual(await statesOf(b.journal, zenon, alice), ['accepted']);
    } else if (scenario === 'never-arrived') {
      node.mode = 'accept';
      const entry = await b.journal.begin(zenon, alice);
      await entry.release();
      assert.equal(node.published.length, 2);
      assert.equal(node.published[1], original, 'recovery must resend the recorded bytes exactly');
      assert.deepEqual(await statesOf(b.journal, zenon, alice), ['accepted']);
    } else if (scenario === 'still-silent') {
      await rejectsWith(b.journal.begin(zenon, alice), 'JOURNAL_UNRESOLVED');
      assert(node.published.every((sent) => sent === original));
      const result = await b.journal.reconcile(zenon, alice);
      assert.equal(result.unknown.length, 1);
      // The account stays held until the person lets go of it.
      await rejectsWith(b.journal.begin(zenon, alice), 'JOURNAL_UNRESOLVED');
      const discarded = await b.journal.discard(result.unknown[0].id);
      assert.equal(discarded.state, 'rejected');
      assert.match(discarded.note, /may still be confirmed/);
      await (await b.journal.begin(zenon, alice)).release();
      // Another account was never held.
    } else if (scenario === 'superseded') {
      node.put(alice, 5, hashOf('someone-else'), true);
      const entry = await b.journal.begin(zenon, alice);
      await entry.release();
      assert.equal(node.published.length, 1, 'a block that can never land was sent again');
      const [record] = (await b.journal.reconcile(zenon, alice)).records;
      assert.equal(record.state, 'superseded');
      assert.equal(record.note, hashOf('someone-else'));
    } else {
      // Another block is pooled at the height but not confirmed: it may yet be
      // displaced, so the answer is to wait, not to give up or to resend.
      node.put(alice, 5, hashOf('someone-else'), false);
      await rejectsWith(b.journal.begin(zenon, alice), 'JOURNAL_UNRESOLVED');
      assert.equal(node.published.length, 1);
      assert.deepEqual(await statesOf(b.journal, zenon, alice), ['publishing']);
    }
    if (scenario !== 'contested') await (await b.journal.begin(zenon, bob)).release();
  }

  // A publish call that never answers at all: the wait is bounded, the turn is
  // given back, and the record is left for the next look at the node.
  {
    const shared = profile(), a = windowOf(shared), { zenon, node } = nodeOf();
    const block = blockOf(alice, 7);
    const started = Date.now();
    await rejectsWith(a.journal.run(zenon, alice, { replyMs: 40 }, (entry) => entry.publish(block, () => {
      node.put(alice, 7, block.hash.toString(), false);
      return new Promise(() => {});
    })), 'JOURNAL_UNKNOWN_OUTCOME');
    assert(Date.now() - started < 5000);
    assert.equal(a.intervals.size, 0);
    await (await a.journal.begin(zenon, bob, { waitMs: 0 })).release();
    assert.deepEqual(await statesOf(a.journal, zenon, alice), ['accepted']);
  }

  // Settling is bounded too. A resend that is never answered leaves the block
  // unknown and says so; a node that answers nothing at all is an error, not
  // a wallet that waits for good.
  {
    const shared = profile(), a = windowOf(shared), b = windowOf(shared), { zenon, node } = nodeOf();
    const block = blockOf(alice, 6);
    node.mode = 'drop';
    await rejectsWith(a.journal.run(zenon, alice, {}, (entry) => entry.publish(block, () => zenon.ledger.publishRawTransaction(block))),
      'JOURNAL_UNKNOWN_OUTCOME');
    node.mute = 'publish';
    const started = Date.now();
    const result = await b.journal.reconcile(zenon, alice, { rpcMs: 40 });
    assert(Date.now() - started < 5000);
    assert.equal(result.unknown.length, 1);
    assert.equal(result.unknown[0].hash, block.hash.toString());
    await rejectsWith(b.journal.begin(zenon, alice, { rpcMs: 40 }), 'JOURNAL_UNRESOLVED');
    node.mute = 'all';
    await assert.rejects(b.journal.reconcile(zenon, alice, { rpcMs: 40 }), /did not answer/);
    const fresh = windowOf(shared), silent = nodeOf();
    silent.node.mute = 'all';
    await assert.rejects(fresh.journal.begin(silent.zenon, alice, { rpcMs: 40 }), /did not answer/);
    node.mute = null; node.mode = 'accept';
    assert.deepEqual(await statesOf(b.journal, zenon, alice), ['accepted']);
  }

  // What the node itself refuses is final, reported as it came, and frees the account.
  {
    const shared = profile(), a = windowOf(shared), { zenon, node } = nodeOf();
    node.mode = 'refuse';
    const block = blockOf(alice, 2);
    await assert.rejects(a.journal.run(zenon, alice, {}, (entry) => entry.publish(block, () => zenon.ledger.publishRawTransaction(block))),
      (error) => error.code === -32000 && /previous block is missing/.test(error.message));
    const [record] = (await a.journal.reconcile(zenon, alice)).records;
    assert.equal(record.state, 'rejected');
    assert.match(record.note, /previous block is missing/);
    node.mode = 'accept';
    await sendOnce(a.journal, zenon, alice, 2, 'retry-after-review');
    // A connection that was already closed never carried the block.
    node.offline = true;
    const closed = blockOf(alice, 3);
    await assert.rejects(a.journal.run(zenon, alice, {}, (entry) => entry.publish(closed, () => zenon.ledger.publishRawTransaction(closed))));
    node.offline = false;
    assert.deepEqual((await a.journal.reconcile(zenon, alice)).unknown, []);
  }

  // One block at a time per account, across windows; other accounts do not wait.
  {
    const shared = profile(), a = windowOf(shared), b = windowOf(shared), { zenon } = nodeOf();
    const order = [];
    const first = await a.journal.begin(zenon, alice);
    const second = b.journal.begin(zenon, alice, { waitMs: 5000 }).then((entry) => { order.push('second-began'); return entry; });
    await (await b.journal.begin(zenon, bob)).release();
    order.push('other-account-done');
    await new Promise((resolve) => setTimeout(resolve, 60));
    order.push('first-releasing');
    await first.release();
    await (await second).release();
    assert.deepEqual(order, ['other-account-done', 'first-releasing', 'second-began']);

    const held = await a.journal.begin(zenon, alice);
    await rejectsWith(b.journal.begin(zenon, alice, { waitMs: 0 }), 'JOURNAL_BUSY');
    // A window that died holding the turn loses it when the reservation runs
    // out, and cannot record or send anything if it comes back.
    shared.advance(61 * 1000);
    const successor = await b.journal.begin(zenon, alice, { waitMs: 0 });
    let sent = false;
    await rejectsWith(held.publish(blockOf(alice, 9), () => { sent = true; }), 'JOURNAL_STALE');
    assert.equal(sent, false, 'a stale owner reached the node');
    assert.deepEqual((await a.journal.reconcile(zenon, alice)).records, []);
    // Its late release cannot free the turn the successor now holds.
    await held.release();
    await rejectsWith(a.journal.begin(zenon, alice, { waitMs: 0 }), 'JOURNAL_BUSY');
    await successor.release();
    // A live owner renews, so slow proof of work does not lose the turn.
    const slow = await a.journal.begin(zenon, alice);
    shared.advance(40 * 1000);
    for (const handle of a.intervals) handle.callback();
    await tick(); await tick(); await tick();
    shared.advance(40 * 1000);
    await rejectsWith(b.journal.begin(zenon, alice, { waitMs: 0 }), 'JOURNAL_BUSY');
    await slow.release();
    assert.equal(a.intervals.size, 0, 'a released turn left its renewal running');
  }

  // A send the person started goes ahead of the next receive: a receive loop
  // asks again the moment it lets go, and must not keep a send waiting behind
  // every block still to be received.
  {
    const shared = profile(), a = windowOf(shared), b = windowOf(shared), { zenon } = nodeOf();
    const receiving = await a.journal.begin(zenon, alice, { path: 'receive' });
    let sendBegan = false;
    const send = b.journal.begin(zenon, alice, { path: 'send', waitMs: 5000 }).then((entry) => { sendBegan = true; return entry; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await receiving.release();
    // The turn is free, and the loop is first to ask. It still waits.
    await rejectsWith(a.journal.begin(zenon, alice, { path: 'receive', waitMs: 0 }), 'JOURNAL_BUSY');
    assert.equal(sendBegan, false);
    const sending = await send;
    await rejectsWith(a.journal.begin(zenon, alice, { path: 'receive', waitMs: 0 }), 'JOURNAL_BUSY');
    await sending.release();
    await (await a.journal.begin(zenon, alice, { path: 'receive', waitMs: 0 })).release();
    // A waiting send whose window has gone holds nobody up for long, and two
    // receives do not queue behind each other's place.
    const held = await a.journal.begin(zenon, alice, { path: 'receive' });
    await rejectsWith(b.journal.begin(zenon, alice, { path: 'send', waitMs: 0 }), 'JOURNAL_BUSY');
    await rejectsWith(b.journal.begin(zenon, alice, { path: 'receive', waitMs: 0 }), 'JOURNAL_BUSY');
    await held.release();
    await rejectsWith(a.journal.begin(zenon, alice, { path: 'receive', waitMs: 0 }), 'JOURNAL_BUSY');
    shared.advance(3001);
    await (await a.journal.begin(zenon, alice, { path: 'receive', waitMs: 0 })).release();
  }

  // A window that died mid-send never gives its turn back. Once its block's
  // outcome is known the turn is spent, and the next send does not wait out
  // the reservation; while the outcome is unknown, it is the record that
  // holds the account, not the dead window.
  {
    const shared = profile(), a = windowOf(shared), b = windowOf(shared), { zenon, node } = nodeOf();
    const dead = await a.journal.begin(zenon, alice);
    const block = blockOf(alice, 3);
    await dead.start(block);
    await rejectsWith(dead.start(blockOf(alice, 4)), 'JOURNAL_STALE');
    // Never sent, never released. The reopened wallet resends and moves on at once.
    const next = await b.journal.begin(zenon, alice, { waitMs: 0 });
    assert.equal(node.published.length, 1);
    assert.equal(node.published[0], JSON.stringify(block.toJson()));
    await next.release();
    // The same with a window that died before it recorded anything: there is
    // nothing to settle, so its reservation is all there is, and it runs out.
    const idle = await a.journal.begin(zenon, alice);
    await rejectsWith(b.journal.begin(zenon, alice, { waitMs: 0 }), 'JOURNAL_BUSY');
    shared.advance(61 * 1000);
    await (await b.journal.begin(zenon, alice, { waitMs: 0 })).release();
    await idle.release();
    // A live owner whose block was settled from another window can no longer
    // record under that turn, and its release does not disturb the next one.
    const live = await a.journal.begin(zenon, alice);
    const first = blockOf(alice, 4);
    await live.start(first);
    node.put(alice, 4, first.hash.toString(), false);
    const successor = await b.journal.begin(zenon, alice, { waitMs: 0 });
    await live.release();
    await rejectsWith(a.journal.begin(zenon, alice, { waitMs: 0 }), 'JOURNAL_BUSY');
    await successor.release();
  }

  // The cap, and retention.
  {
    const shared = profile(), a = windowOf(shared), { zenon, node } = nodeOf();
    assert.equal(a.journal.maxRecordsPerAccount, 100);
    for (let height = 1; height <= 100; height += 1) await sendOnce(a.journal, zenon, alice, height);
    await rejectsWith(a.journal.begin(zenon, alice), 'JOURNAL_FULL');
    await sendOnce(a.journal, zenon, bob, 1);
    // Settled records leave a day later; unsettled ones stay however old.
    for (let height = 1; height <= 60; height += 1) node.confirm(alice, height);
    assert.equal((await statesOf(a.journal, zenon, alice)).filter((value) => value === 'observed').length, 60);
    await rejectsWith(a.journal.begin(zenon, alice), 'JOURNAL_FULL');
    shared.advance(a.journal.retentionMs + 1);
    await (await a.journal.begin(zenon, alice)).release();
    const remaining = await statesOf(a.journal, zenon, alice);
    assert.equal(remaining.length, 40);
    assert(remaining.every((value) => value === 'accepted'));
  }

  // A chain identifier is not a network. Records of another network are
  // neither settled against this one nor allowed to hold it up.
  {
    const shared = profile(), a = windowOf(shared), one = nodeOf(genesisA), two = nodeOf(genesisB);
    one.node.mode = 'drop';
    const block = blockOf(alice, 4);
    await rejectsWith(a.journal.run(one.zenon, alice, {}, (entry) => entry.publish(block, () => one.zenon.ledger.publishRawTransaction(block))),
      'JOURNAL_UNKNOWN_OUTCOME');
    await sendOnce(a.journal, two.zenon, alice, 4, 'other-network');
    assert.equal(two.node.published.length, 1, 'a block signed for one network was sent to another');
    assert.deepEqual(await statesOf(a.journal, two.zenon, alice), ['accepted']);
    assert.deepEqual(await statesOf(a.journal, one.zenon, alice), ['publishing']);
    // Same network behind another endpoint: the records follow.
    const mirror = nodeOf(genesisA);
    mirror.node.put(alice, 4, block.hash.toString(), true);
    assert.deepEqual(await statesOf(a.journal, mirror.zenon, alice), ['observed']);
    // A node that will not name its network gets nothing signed for it.
    const mute = nodeOf('not-a-hash');
    await rejectsWith(a.journal.begin(mute.zenon, alice), 'JOURNAL_OFFLINE');
  }

  // A record from a newer wallet is left alone, and clearing it is explicit.
  {
    const shared = profile(), a = windowOf(shared), { zenon } = nodeOf();
    await sendOnce(a.journal, zenon, alice, 1);
    const key = await a.journal.storageKey();
    const newer = JSON.stringify({ ...JSON.parse(shared.stored.get(key)), version: 2 });
    shared.stored.set(key, newer);
    await rejectsWith(a.journal.begin(zenon, alice), 'JOURNAL_UNAVAILABLE');
    await rejectsWith(a.journal.reconcile(zenon, alice), 'JOURNAL_UNAVAILABLE');
    assert.equal(shared.stored.get(key), newer);
    await a.journal.reset();
    assert.equal(shared.stored.has(key), false);
    await sendOnce(a.journal, zenon, alice, 1);
  }

  // The wallet's own sender: the turn is taken before the account's frontier
  // is read, the block is recorded before it is sent, and the turn is given
  // back when signing fails.
  {
    const shared = profile(), a = windowOf(shared), b = windowOf(shared), { zenon, node } = nodeOf();
    const steps = [];
    const key = { getAddress: async () => ({ toString: () => alice }) };
    let fail = null;
    Object.assign(a.sdk.utils.BlockUtils, {
      _checkAndSetFields: async (context, template) => {
        steps.push('fill');
        await rejectsWith(b.journal.begin(zenon, alice, { waitMs: 0 }), 'JOURNAL_BUSY');
        return blockOf(alice, template.height, template.label);
      },
      _setDifficulty: async (context, block, onPow) => { steps.push('plasma'); onPow?.(1); return block; },
      _setHashAndSignature: async (block) => { steps.push('sign'); if (fail) throw fail; return block; },
    });
    const send = a.publisher();
    const pow = [];
    const signed = await send(zenon, { height: 1, label: 'own-send' }, key, { onPow: (status) => pow.push(status) });
    assert.deepEqual(steps, ['fill', 'plasma', 'sign']);
    assert.deepEqual(pow, [1]);
    assert.equal(signed.hash.toString(), hashOf('own-send'));
    assert.equal(node.published.length, 1);
    assert.deepEqual(await statesOf(a.journal, zenon, alice), ['accepted']);
    fail = new Error('Synthetic signing failure');
    await assert.rejects(send(zenon, { height: 2, label: 'unsigned' }, key), (error) => error === fail);
    assert.equal(node.published.length, 1, 'an unsigned block reached the node');
    await (await b.journal.begin(zenon, alice, { waitMs: 0 })).release();
    assert.deepEqual(await statesOf(a.journal, zenon, alice), ['accepted']);
  }

  // The node's refusal of a block that lost its place is worded for the person.
  {
    const { code } = babel.transformFileSync(path.join(root, 'src/services/utils/errors.js'), {
      presets: [['@babel/preset-env', { targets: { node: 'current' } }]], configFile: false, babelrc: false });
    const module = { exports: {} };
    new Function('module', 'exports', code)(module, module.exports);
    const { readableError } = module.exports;
    for (const refusal of ['account-block prevHash exists but it has a cemented block on top of it',
      'account-block prevHeight is cemented but has different hash', 'account-block previous block is missing',
      'plasma ratio is smaller for current block', 'hash tie-break is worse for current block']) {
      assert.match(readableError({ code: -32000, message: refusal }), /landed first.*Nothing was sent/);
    }
    assert.match(readableError(new Error('not enough plasma')), /Fuse QSR/);
    assert.match(readableError(Object.assign(new Error('The transaction was sent but the node did not answer. The wallet will check its outcome; do not send it again.'), { code: 'JOURNAL_UNKNOWN_OUTCOME' })), /do not send it again/);
  }

  console.log('transaction journal: encrypted records, record-before-send, lost-reply recovery without re-signing, ' +
    'node refusals, per-account turns across windows, stale owners, cap and retention, network identity, ' +
    'unknown versions and the wallet sender passed');
})().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
