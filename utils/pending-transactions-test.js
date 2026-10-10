'use strict';

// Actual reducers/hooks and dashboard callback with inert RPC and synthetic
// identities only. No wallet keys, browser storage, network or transactions.
const assert = require('node:assert/strict');
const path = require('node:path');
const babel = require('@babel/core');
const { journalStubs } = require('./fixtures/journal-stub');
const React = require('react');
const root = path.join(__dirname, '..');
const compiled = new Map();
const owner = 'synthetic-account-a';
const otherOwner = 'synthetic-account-b';
const hashes = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(64));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const loader = (override, environment = {}) => {
  const cache = new Map();
  const load = (file) => {
    const filename = path.resolve(root, file);
    if (cache.has(filename)) return cache.get(filename).exports;
    if (!compiled.has(filename)) compiled.set(filename, babel.transformFileSync(filename, {
      presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'],
      configFile: false, babelrc: false,
    }).code);
    const module = { exports: {} };
    cache.set(filename, module);
    const requireModule = (name) => {
      const replacement = override(name);
      if (replacement !== undefined) return replacement;
      // The journal has its own suite; see fixtures/journal-stub.js.
      const journaled = journalStubs(name); if (journaled !== undefined) return journaled;
      if (!name.startsWith('.')) return require(name);
      const target = path.resolve(path.dirname(filename), name);
      return load(path.extname(target) ? target : target + '.js');
    };
    new Function('module', 'exports', 'require', ...Object.keys(environment), compiled.get(filename))(
      module, module.exports, requireModule, ...Object.values(environment));
    return module.exports;
  };
  return load;
};

// Hook state and effect cleanup are retained across explicit rerenders. Remote
// completion is controlled by deferred promises, not by wall-clock delays.
const hookRuntime = () => {
  const states = [], refs = [], effects = [];
  let stateCursor = 0, refCursor = 0;
  const react = { ...React,
    useState: (initial) => {
      const index = stateCursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useRef: (initial) => refs[refCursor++] ??= { current: initial },
    useCallback: (callback) => callback,
    useMemo: (callback) => callback(),
    useEffect: (callback, dependencies) => effects.push({ callback, dependencies }),
  };
  return { react, effects, render: (callback) => {
    stateCursor = 0; refCursor = 0; effects.length = 0;
    return callback();
  } };
};
const networkFixture = () => {
  const state = { nodeUrl: 'wss://node-a.invalid', chainIdentifier: 69 };
  const client = { url: state.nodeUrl };
  const zenon = { wsClient: client, ledger: { client } };
  const sdk = { Zenon: { getSingleton: () => zenon, getChainIdentifier: () => state.chainIdentifier },
    Enums: { PowStatus: { generating: 0, done: 1 } } };
  const override = (name) => {
    if (name === 'znn-ts-sdk') return sdk;
    if (name.endsWith('/utils/storage')) return { getCurrentNodeUrl: () => {
      if (state.failNodeRead) throw new Error('Synthetic context-read failure');
      return state.nodeUrl;
    },
      getSettings: () => ({ hideBalances: false }) };
  };
  return { state, zenon, sdk, override, network: () => ({ nodeUrl: state.nodeUrl, chainIdentifier: state.chainIdentifier }) };
};
const block = (hash, account = owner, extra = {}) => {
  const json = { hash, address: account, toAddress: otherOwner, blockType: 2, amount: '1', ...extra };
  return { ...json, toJson: () => ({ ...json }) };
};
const historyFixture = () => {
  const network = networkFixture();
  const hooks = hookRuntime();
  let address = owner;
  network.zenon.ledger.getBlocksByPage = async () => ({ list: [] });
  const load = loader((name) => {
    const replacement = network.override(name);
    if (replacement !== undefined) return replacement;
    if (name === 'react') return hooks.react;
    if (name.endsWith('/utils/contracts')) return { embeddedContractName: () => null };
    if (name.endsWith('/utils/contractCalls')) return { decodeCall: () => null, describeCall: () => '', contractDisplayName: () => '' };
    if (name.endsWith('/utils/outgoingBlock')) return { iconForContract: {} };
  });
  const useTransactions = load('src/services/hooks/useTransactions.js').default;
  const render = () => hooks.render(() => useTransactions(address, address));
  const cleanup = (() => {
    render();
    const callbacks = hooks.effects.map((effect) => effect.callback()).filter((callback) => typeof callback === 'function');
    return () => callbacks.forEach((callback) => callback());
  })();
  return { ...network, load, hooks, render, cleanup, setAddress: (next) => { address = next; render(); }, getAddress: () => address };
};
const reducerFixture = (network = networkFixture()) => {
  const slice = loader(network.override)('src/services/redux/pendingTransactionsSlice.js');
  let state = slice.default(undefined, { type: 'init' });
  const dispatch = (action) => { state = slice.default(state, action); };
  const add = (id, hash, patch = {}) => dispatch(slice.startPendingTransaction({ id, owner,
    hash, status: slice.pendingStatus.settled, network: network.network(), ...patch }));
  return { slice, dispatch, add, get state() { return state; } };
};

const dashboardFixture = (history, options = {}) => {
  const hooks = hookRuntime();
  const reducer = reducerFixture(history);
  reducer.add('observed', hashes[0]); reducer.add('unseen', hashes[1]);
  const timers = new Map();
  let timerId = 0;
  const load = loader((name) => {
    const replacement = history.override(name);
    if (replacement !== undefined) return replacement;
    if (name === 'react') return hooks.react;
    if (name === 'react-router-dom') return { useNavigate: () => () => {} };
    if (name === 'react-redux') return { useDispatch: () => reducer.dispatch,
      useSelector: (select) => select({ pendingTransactions: reducer.state,
        connectionParameters: { chainIdentifier: 69, isConnected: false } }) };
    if (name.endsWith('/hooks/useAccount')) return () => ({ address: history.getAddress(), balanceMap: {},
      isLoading: false, refresh: options.refresh || (async () => null) });
    if (name.endsWith('/hooks/useTransactions')) return () => history.render();
    if (name.endsWith('/hooks/useDelayedFlag')) return () => false;
    if (name.endsWith('/hooks/usePriceFeed')) return () => ({ znn: null, qsr: null });
    if (name.endsWith('/wallet/vault')) return {};
    if (name.endsWith('/wallet/account')) return { znnZts: 'synthetic-znn', qsrZts: 'synthetic-qsr' };
    if (name.endsWith('/utils/contracts')) return {};
    if (name.endsWith('/utils/contractCalls')) return {};
    if (name.endsWith('/utils/format')) return { formatExact: () => '0', formatAmount: () => '0' };
    if (name.endsWith('/utils/notify')) return {};
    if (name.endsWith('/wallet/preferences')) return {};
    if (name.endsWith('/utils/chainId')) return { mainnetChainId: 1 };
    if (name.includes('/components/')) return () => null;
  }, { setInterval: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearInterval: (id) => timers.delete(id) });
  const Dashboard = load('src/pages/dashboard/dashboard/dashboard.js').default;
  hooks.render(() => Dashboard());
  const effect = hooks.effects.find((item) => item.dependencies.length === 4 && item.dependencies[0] === true);
  assert(effect, 'node-accepted observation effect was not installed');
  const cleanup = effect.callback();
  return { reducer, timers, cleanup };
};

(async () => {
  // Reducer: observing one hash never dismisses another accepted or failed row.
  {
    const f = reducerFixture();
    f.add('observed', hashes[0]); f.add('unseen', hashes[1]);
    f.add('failed', hashes[0], { status: f.slice.pendingStatus.failed });
    f.add('sending', hashes[0], { status: f.slice.pendingStatus.sending });
    f.add('other-account', hashes[0], { owner: otherOwner });
    f.add('other-node', hashes[0], { network: { ...f.state.items[0].network, nodeUrl: 'wss://node-b.invalid' } });
    f.add('other-chain', hashes[0], { network: { nodeUrl: 'wss://node-a.invalid', chainIdentifier: 70 } });
    f.add('legacy', hashes[0], { network: undefined });
    f.dispatch(f.slice.clearSettledTransactions());
    assert.equal(f.state.items.length, 8, 'missing observation cleared rows');
    f.dispatch(f.slice.clearSettledTransactions({ owner, network: { nodeUrl: 'wss://node-a.invalid', chainIdentifier: 69 }, hashes: [] }));
    assert.equal(f.state.items.length, 8, 'empty observation cleared rows');
    f.dispatch(f.slice.clearSettledTransactions({ owner, network: { nodeUrl: 'wss://node-a.invalid', chainIdentifier: 69 }, hashes: [hashes[0]] }));
    assert.deepEqual(f.state.items.map((item) => item.id).sort(),
      ['failed', 'legacy', 'other-account', 'other-chain', 'other-node', 'sending', 'unseen'].sort());
  }

  // Failed/empty reads retain placeholders. A later incomplete page clears
  // only its matching accepted hash through the real dashboard and reducer.
  for (const initial of ['failure', 'empty']) {
    const history = historyFixture();
    history.zenon.ledger.getBlocksByPage = async () => {
      if (initial === 'failure') throw new Error('Synthetic RPC failure');
      return { list: [] };
    };
    const view = dashboardFixture(history);
    await flush();
    assert.equal(view.reducer.state.items.length, 2);
    assert.equal(view.timers.size, 1, 'unobserved accepted rows were not scheduled for another read');
    history.zenon.ledger.getBlocksByPage = async () => ({ list: [block(hashes[0])] });
    await [...view.timers.values()][0]();
    assert.deepEqual(view.reducer.state.items.map((item) => item.id), ['unseen']);
    view.cleanup(); history.cleanup();
    assert.equal(view.timers.size, 0);
  }

  // Delayed old responses are not observation authority after any transition.
  for (const transition of ['node', 'chain', 'client', 'socket', 'singleton', 'context-read', 'address', 'reset', 'unmount']) {
    const f = historyFixture(), gate = deferred();
    f.zenon.ledger.getBlocksByPage = () => gate.promise;
    const pending = f.render().refreshNewest();
    if (transition === 'node') f.state.nodeUrl = 'wss://node-b.invalid';
    if (transition === 'chain') f.state.chainIdentifier = 70;
    if (transition === 'client') f.zenon.ledger.client = {};
    if (transition === 'socket') f.zenon.wsClient = {};
    if (transition === 'singleton') f.sdk.Zenon.getSingleton = () => ({ ledger: { client: {} }, wsClient: {} });
    if (transition === 'context-read') f.state.failNodeRead = true;
    if (transition === 'address') f.setAddress(otherOwner);
    if (transition === 'reset') f.render().reset();
    if (transition === 'unmount') f.cleanup();
    gate.resolve({ list: [block(hashes[0])] });
    assert.equal(await pending, undefined, transition + ' released a stale observation');
    assert.equal(f.render().items.length, 0, transition + ' appended stale history');
    f.cleanup();
  }

  // A transition during receive expansion is stale too, even though the
  // account-history response arrived before the node changed.
  {
    const f = historyFixture(), gate = deferred();
    f.zenon.ledger.getBlocksByPage = async () => ({ list: [
      block(hashes[0], owner, { blockType: 3, fromBlockHash: hashes[2] }),
    ] });
    f.zenon.ledger.getBlockByHash = () => gate.promise;
    const pending = f.render().refreshNewest();
    await flush();
    f.zenon.ledger.client = {};
    gate.resolve(block(hashes[2], otherOwner, { toAddress: owner }));
    assert.equal(await pending, undefined);
    assert.equal(f.render().items.length, 0);
    f.cleanup();
  }

  // A rendered receive uses its send reference for display, but cleanup must
  // use its own account-block hash. Foreign account blocks do not clear rows.
  {
    const f = historyFixture();
    f.zenon.ledger.getBlocksByPage = async () => ({ list: [
      block(hashes[0], owner, { blockType: 3, fromBlockHash: hashes[2] }), block(hashes[3], otherOwner),
    ] });
    f.zenon.ledger.getBlockByHash = async () => block(hashes[2], otherOwner, { toAddress: owner });
    const observation = await f.render().refreshNewest();
    assert.deepEqual(observation.hashes, [hashes[0]]);
    assert.equal(f.render().items[0].hash, hashes[2]);
    f.cleanup();
  }

  // Unexpected balance-read rejection keeps the observation retryable rather
  // than creating an unhandled dashboard promise or dismissing all rows.
  {
    const history = historyFixture();
    let failing = true;
    history.zenon.ledger.getBlocksByPage = async () => ({ list: [block(hashes[0])] });
    const view = dashboardFixture(history, { refresh: async () => {
      if (failing) throw new Error('Synthetic balance-read failure');
      return null;
    } });
    await flush();
    assert.equal(view.reducer.state.items.length, 2);
    failing = false;
    await [...view.timers.values()][0]();
    assert.deepEqual(view.reducer.state.items.map((item) => item.id), ['unseen']);
    view.cleanup(); history.cleanup();
  }

  // A network move while dashboard waits on balances invalidates the result;
  // a cancelled effect likewise cannot dismiss rows after unmount/navigation.
  for (const transition of ['network', 'cancel']) {
    const history = historyFixture(), gate = deferred();
    history.zenon.ledger.getBlocksByPage = async () => ({ list: [block(hashes[0])] });
    const view = dashboardFixture(history, { refresh: () => gate.promise });
    await flush();
    if (transition === 'network') history.state.nodeUrl = 'wss://node-b.invalid';
    else view.cleanup();
    gate.resolve(null);
    await flush();
    assert.equal(view.reducer.state.items.length, 2, transition + ' cleared a stale observation');
    view.cleanup(); history.cleanup();
  }

  // A slow observation does not spawn overlapping reads on subsequent ticks.
  {
    const history = historyFixture(), gate = deferred();
    let reads = 0;
    history.zenon.ledger.getBlocksByPage = () => { reads += 1; return gate.promise; };
    const view = dashboardFixture(history);
    const tick = [...view.timers.values()][0];
    await tick(); await tick();
    assert.equal(reads, 1);
    gate.resolve({ list: [] }); await flush();
    view.cleanup(); history.cleanup();
    await tick();
    assert.equal(reads, 1, 'a queued timer restarted observation after cleanup');
  }

  // Actual sender/reducer: stamp the accepted block's matching context, but
  // retain it without guessed context after a client/account/chain transition.
  for (const transition of ['none', 'client', 'account', 'chain', 'context-read']) {
    const f = networkFixture(), gate = deferred(), hooks = hookRuntime(), reducer = reducerFixture(f);
    f.zenon.send = () => gate.promise;
    const load = loader((name) => {
      const replacement = f.override(name); if (replacement !== undefined) return replacement;
      if (name === 'react') return hooks.react;
      if (name === 'react-redux') return { useDispatch: () => reducer.dispatch };
      if (name.endsWith('/wallet/vault')) return { getSigningKeyPair: async () => ({}) };
      if (name === './useAccount') return { invalidateAccountCache: () => {} };
      if (name.endsWith('/utils/notify')) return { notify: { success: () => {}, error: () => {} } };
      if (name.endsWith('/utils/errors')) return { readableError: String };
      if (name.endsWith('/utils/outgoingBlock')) return { describeOutgoingTemplate: () => ({}) };
    });
    const useSender = load('src/services/hooks/useBackgroundSender.js').default;
    hooks.render(() => useSender()).sendInBackground({ chainIdentifier: 69 }, { row: { owner } });
    assert.deepEqual(reducer.state.items[0].network, f.network());
    await flush();
    if (transition === 'client') f.zenon.ledger.client = {};
    if (transition === 'context-read') f.state.failNodeRead = true;
    gate.resolve({ hash: hashes[0], address: transition === 'account' ? otherOwner : owner,
      chainIdentifier: transition === 'chain' ? 70 : 69 });
    await flush();
    const entry = reducer.state.items[0];
    assert.equal(entry.status, reducer.slice.pendingStatus.settled);
    assert.equal(entry.hash, hashes[0]);
    assert.deepEqual(entry.network, transition === 'none' ? f.network() : null);
    reducer.dispatch(reducer.slice.clearSettledTransactions({ owner, network: f.network(), hashes: [hashes[0]] }));
    assert.equal(reducer.state.items.length, transition === 'none' ? 0 : 1);
  }
  console.log('Pending transaction observation checks passed: exact hashes, account/network scope, failed/empty reads, stale generations, receive references, dashboard retries and sender context.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
