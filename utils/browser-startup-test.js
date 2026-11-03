'use strict';

// Regular-file and loopback protocol controls only. No native browser,
// browser profile, wallet, package install or on-disk socket is created.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { announcedEndpoint, connectFirefox } = require('./fixtures/firefox-bidi');

const liveChild = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
const cases = [];
const watchdog = setTimeout(() => { console.error('Browser startup controls timed out'); process.exit(1); }, 5000);
const failure = code => Object.assign(new Error('Controlled browser startup failure.'), { code });
const installSource = fs.readFileSync(path.join(__dirname, 'fixtures/production-browser.js'), 'utf8');
const first = installSource.indexOf('    let installed = await matchingInstalls();');
const last = installSource.indexOf('\n    await closePage(settings);', first);
assert(first > 0 && last > first, 'Installation source boundaries exist');

const install = async ({ existing = [], loaded = true, enabled = true, expectedExtensionId } = {}) => {
  const commands = [];
  const id = 'a'.repeat(32);
  let calls = 0;
  const context = {
    extensionDir: '/owned/extension', settings: { sessionId: 'owned-settings' }, expectedExtensionId,
    extensionId: undefined, stats: { persistentInstallReused: false }, failure,
    matchingInstalls: async () => calls++ === 0 ? existing : [{ id, enabled }],
    cdp: async (method, params, sessionId) => { commands.push({ method, params, sessionId }); return { id }; },
    evaluate: async (_page, expression) => { commands.push({ method: 'evaluate', expression }); return loaded; },
  };
  const result = await vm.runInNewContext('(async () => {\n' + installSource.slice(first, last) +
    '\nreturn { id: extensionId, reused: stats.persistentInstallReused }; })()', context);
  return { result, commands };
};

(async () => {
  assert.equal(announcedEndpoint('unrelated startup output'), null);
  assert.equal(announcedEndpoint('WebDriver BiDi listening on ws://127.0.0.1:49152\n'), 'ws://127.0.0.1:49152/session');
  for (const endpoint of ['ws://example.invalid:49152', 'ws://user:private@127.0.0.1:49152',
    'ws://127.0.0.1:49152/private', 'ws://127.0.0.1:49152?private', 'ws://[invalid']) {
    assert.throws(() => announcedEndpoint('WebDriver BiDi listening on ' + endpoint), error =>
      error.code === 'FIREFOX_BIDI_ENDPOINT_INVALID' && !error.message.includes('private'));
  }
  cases.push('only the announced loopback endpoint is accepted without diagnostic disclosure');

  const connections = new Set();
  let upgradePath, origin;
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    upgradePath = request.url; origin = request.headers.origin;
    const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] +
      '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\nContent-Length: 0\r\n\r\n');
    socket.on('data', () => socket.end());
  });
  server.on('connection', socket => {
    connections.add(socket); socket.on('error', () => {}); socket.on('close', () => connections.delete(socket));
  });
  let socket;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const started = Date.now();
    socket = await connectFirefox({ browser: liveChild(), timeoutMs: 1000,
      stderr: () => Date.now() - started < 25 ? '' :
        'WebDriver BiDi listening on ws://127.0.0.1:' + server.address().port });
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.equal(upgradePath, '/session');
    assert.equal(origin, undefined, 'Firefox origin policy is not relaxed');
    cases.push('real WebSocket handshake waits for the child announcement on its assigned port');
  } finally {
    socket?.close();
    for (const connection of connections) connection.destroy();
    await new Promise(resolve => server.close(resolve));
  }

  const dead = liveChild(); dead.exitCode = 1;
  await assert.rejects(connectFirefox({ browser: dead, stderr: () => 'private diagnostic' }),
    { code: 'FIREFOX_BIDI_BROWSER_EXITED' });
  assert.equal(dead.listenerCount('error'), 0);
  cases.push('an exited Firefox fails promptly with a sanitized code');

  const NativeWebSocket = global.WebSocket;
  let abandoned = 0;
  try {
    global.WebSocket = class {
      close() { abandoned++; }
    };
    const child = liveChild();
    await assert.rejects(connectFirefox({ browser: child, timeoutMs: 25, handshakeMs: 5,
      stderr: () => 'WebDriver BiDi listening on ws://127.0.0.1:49152' }),
    { code: 'FIREFOX_BIDI_STARTUP_TIMEOUT' });
    assert(abandoned > 0);
    assert.equal(child.listenerCount('error'), 0);
    cases.push('an unresponsive handshake is bounded and its socket is abandoned');
  } finally { global.WebSocket = NativeWebSocket; }

  const id = 'a'.repeat(32);
  const fresh = await install();
  assert.equal(fresh.result.id, id); assert.equal(fresh.result.reused, false);
  assert.deepEqual(fresh.commands.map(command => command.method), ['Extensions.loadUnpacked', 'evaluate']);
  assert.equal(fresh.commands[0].params.path, '/owned/extension');
  assert.match(fresh.commands[1].expression, /developerPrivate\.reload/);
  cases.push('initial registration is prepared through the native developer reload');

  const existing = await install({ existing: [{ id, enabled: true }], expectedExtensionId: id });
  assert.equal(existing.result.reused, true); assert.equal(existing.commands.length, 0);
  cases.push('restart reuses the enabled install without loading or reloading it');
  for (const options of [{ expectedExtensionId: id }, { existing: [{ id: 'b'.repeat(32), enabled: true }], expectedExtensionId: id }]) {
    await assert.rejects(install(options), { code: 'BROWSER_PERSISTENT_INSTALL_MISSING' });
  }
  cases.push('restart refuses a missing or replaced installation');
  await assert.rejects(install({ existing: [{ id, enabled: false }] }), { code: 'BROWSER_EXTENSION_DISABLED' });
  await assert.rejects(install({ existing: [{ id, enabled: true }, { id, enabled: true }] }), { code: 'BROWSER_EXTENSION_AMBIGUOUS' });
  await assert.rejects(install({ loaded: false }), { code: 'BROWSER_PERSISTENT_INSTALL_FAILED' });
  await assert.rejects(install({ enabled: false }), { code: 'BROWSER_PERSISTENT_INSTALL_FAILED' });
  cases.push('disabled, ambiguous and unsuccessful installations fail closed');
  const lifecycle = fs.readFileSync(path.join(__dirname, 'keyfile-lifecycle-browser-test.js'), 'utf8');
  const begin = lifecycle.indexOf("    stage = 'persistent install preparation';");
  const end = lifecycle.indexOf('    report.browser = browser.browserVersion;', begin);
  assert(begin > 0 && end > begin);
  const prepare = async (clean = true) => {
    const actions = [];
    const state = { browser: null, report: {}, stage: '', assert, casePassed: () => {},
      launch: async () => {
        actions.push('launch');
        state.browser = { id, stats: { persistentInstallReused: actions.length > 1 },
          stop: async () => { actions.push('stop'); state.browser.stats.shutdownClean = clean; } };
      } };
    await vm.runInNewContext('(async () => {\n' + lifecycle.slice(begin, end) + '\n})()', state);
    return { actions, report: state.report };
  };
  const prepared = await prepare();
  assert.deepEqual(prepared.actions, ['launch', 'stop', 'launch']);
  assert.equal(prepared.report.bootstrap_browser_network.shutdownClean, true);
  await assert.rejects(prepare(false));
  cases.push('an empty-profile restart completes before any wallet is created and refuses unclean shutdown');
  console.log(JSON.stringify({ browser_startup_controls: true, cases, passed: true }));
})().catch(error => {
  console.log(JSON.stringify({ browser_startup_controls: true, passed: false, failure_code: error.code || 'ASSERTION_FAILED' }));
  process.exitCode = 1;
}).finally(() => clearTimeout(watchdog));
