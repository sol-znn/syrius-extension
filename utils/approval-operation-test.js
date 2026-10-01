'use strict';
// Corrected operation cleanup against the pinned SDK and an inert loopback RPC
// fixture. It never connects to a real node, derives keys or signs a transaction.
const assert = require('node:assert/strict');
const path = require('node:path');
const babel = require('@babel/core');
const { WebSocketServer } = require('ws');
const root = path.join(__dirname, '..');
const load = (file, environment = {}) => {
  const module = { exports: {} };
  const code = babel.transformFileSync(path.join(root, file), { presets: [['@babel/preset-env', { targets: { node: 'current' } }]], configFile: false, babelrc: false }).code;
  new Function('module', 'exports', ...Object.keys(environment), code)(module, module.exports, ...Object.values(environment));
  return module.exports;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(5); } throw Error('Fixture condition timed out'); };
const watchdog = setTimeout(() => { console.error('Operation cleanup checks timed out'); process.exit(1); }, 15000);
let server, native;
(async () => {
  const { runApprovalOperation, maxOperations, rpcTimeoutMs } = load('src/services/wallet/approvalOperation.js');
  assert.equal(maxOperations, 2); assert.equal(rpcTimeoutMs, 10000);
  global.window = { WebSocket: global.WebSocket, crypto: require('node:crypto').webcrypto }; global.self = global.window;
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const { Zenon, Primitives } = require('znn-ts-sdk');
  const zenon = Zenon.getSingleton(), received = [];
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.on('listening', resolve));
  server.on('connection', socket => socket.on('message', raw => {
    const request = JSON.parse(String(raw)); received.push(request);
    if (request.method === 'ledger.getFrontierAccountBlock' && request.params[0] === 'legitimate') {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }));
    }
  }));
  await zenon.initialize('ws://127.0.0.1:' + server.address().port, false, 1000);
  native = zenon.wsClient._wsRpc2Client;
  assert(native && typeof native.call === 'function');
  assert(native.queue && typeof native.queue === 'object', 'Pinned RPC client queue is inspectable');
  const ledger = zenon.ledger, client = ledger.client;
  const keyCount = () => Object.keys(native.queue).length;
  const legitimate = await runApprovalOperation(Date.now() + 1000, operation => operation.context(zenon).ledger.getFrontierBlock({ toString: () => 'legitimate' }));
  assert.equal(legitimate, null); assert.equal(keyCount(), 0);
  // Two canceled previews retain two native queue entries and both operation
  // reservations. A third operation is denied until the SDK cleans the entries.
  const controllers = Array.from({ length: maxOperations }, () => new AbortController());
  const deadline = Date.now() + 400;
  const jobs = controllers.map(controller => runApprovalOperation(deadline,
    operation => operation.context(zenon).ledger.getFrontierBlock(Primitives.Address.parse('z1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsggv2f')),
    { signal: controller.signal }).then(() => null, error => error));
  await until(() => keyCount() === maxOperations);
  controllers.forEach(controller => controller.abort());
  assert((await Promise.all(jobs)).every(error => /expired|canceled/.test(error.message)));
  assert.equal(keyCount(), maxOperations);
  await assert.rejects(runApprovalOperation(Date.now() + 1000, () => true), /still stopping/);
  await until(() => keyCount() === 0);
  assert.equal(await runApprovalOperation(Date.now() + 1000, () => 'recovered'), 'recovered');
  assert.equal(zenon.ledger, ledger); assert.equal(ledger.client, client); assert.equal(client._wsRpc2Client, native);
  // Callback timeout is an actual rejection and cleanup in the bundled client,
  // including with a still-open socket that provides no result.
  await assert.rejects(runApprovalOperation(Date.now() + 80, operation =>
    operation.context(zenon).ledger.getFrontierBlock({ toString: () => 'deadline' })), /expired|canceled|timeout/i);
  await until(() => keyCount() === 0);
  assert.equal(received.length, 4);
  // Cross the deadline between the awaited assertion and the native-call
  // boundary. Exercise the corrected RPC wrapper; no vulnerable code is run.
  for (const remaining of [-1, 0, 1]) {
    let clockReads = 0, calls = 0, timeout;
    class Clock extends Date { static now() { return ++clockReads < 6 ? 0 : 100 - remaining; } }
    const boundary = load('src/services/wallet/approvalOperation.js', { Date: Clock }).runApprovalOperation;
    const client = { _wsRpc2Client: { call: (method, params, ms) => { calls++; timeout = ms; return Promise.resolve(null); } } };
    const api = { ledger: { client }, embedded: { plasma: { client } } };
    const result = boundary(100, operation => operation.context(api).ledger.client.sendRequest('ledger.publishRawTransaction', []));
    if (remaining <= 0) { await assert.rejects(result, /expired|canceled/); assert.equal(calls, 0); }
    else { assert.equal(await result, null); assert.equal(calls, 1); assert.equal(timeout, 1); }
  }
  const workers = [];
  class WorkerFixture {
    constructor(url) { this.url = url; this.terminated = 0; workers.push(this); }
    postMessage(value) { this.input = value; }
    terminate() { this.terminated++; }
  }
  const pow = load('src/services/wallet/approvalPow.js', { Worker: WorkerFixture, chrome: { runtime: { getURL: file => 'chrome-extension://fixture/' + file } } }).default;
  for (const mode of ['success', 'abort', 'error', 'messageerror', 'invalid', 'expiry']) {
    const controller = new AbortController();
    const result = pow('00'.repeat(32), 1, { signal: controller.signal, expiresAt: Date.now() + (mode === 'expiry' ? 20 : 1000) }).then(value => ({ value }), error => ({ error }));
    const worker = workers.at(-1); assert.match(worker.url, /approval-pow-worker\.js$/);
    worker.onmessage({ data: { ready: true } }); assert.equal(worker.input.difficulty, '1');
    if (mode === 'success') worker.onmessage({ data: { nonce: '0000000000000000' } });
    if (mode === 'abort') controller.abort();
    if (mode === 'error') worker.onerror({});
    if (mode === 'messageerror') worker.onmessageerror({});
    if (mode === 'invalid') worker.onmessage({ data: { nonce: 'not-a-nonce' } });
    const outcome = await result;
    assert.equal(Boolean(outcome.error), mode !== 'success'); assert.equal(worker.terminated, 1);
    assert.equal(worker.onmessage, null); assert.equal(worker.onerror, null); assert.equal(worker.onmessageerror, null);
  }
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(pow('00'.repeat(32), 1, { signal: canceled.signal, expiresAt: Date.now() + 1000 }), /canceled/);
  assert.equal(workers.length, 6);
  console.log('approval operations: actual pinned SDK native RPC queue cleanup, slot retention/recovery, unmodified shared client, static worker termination on six outcomes passed');
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; }).finally(async () => {
  clearTimeout(watchdog); native?.close();
  if (server) { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); }
});
