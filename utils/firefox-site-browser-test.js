'use strict';
// Sites on Firefox, end to end: the built add-on (build-firefox/, from
// `SYRIUS_PLATFORM=firefox npm run build`) in a real Firefox through WebDriver
// BiDi, against pages served here on 127.0.0.1. Firefox reports no document
// IDs, so this is the path nativeNavigation.relayDocuments takes.
//
// Checks that a page and a subframe get answers (until 0.3.7 every request was
// refused with "The requesting document has left"), and that a pending connect
// ends with its document: one origin may hold one pending connect, so a second
// connect from the same document is refused busy, and after a navigation, a
// reload or a history step the new document's connect is admitted.
// No wallet, keys or node: the wallet is new and locked.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { connectFirefox } = require('./fixtures/firefox-bidi');

const root = path.join(__dirname, '..');
const build = path.join(root, 'build-firefox');
if (!process.env.FIREFOX_PATH) { console.log('Firefox site checks: skipped (set FIREFOX_PATH)'); process.exit(0); }
assert(fs.existsSync(path.join(build, 'manifest.json')), 'build-firefox/ is missing: run SYRIUS_PLATFORM=firefox npm run build');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syrius-firefox-site-'));
const ext = path.join(dir, 'extension');
fs.cpSync(build, ext, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const pages = {
  '/a': '<!doctype html><title>A</title><p>A</p><iframe src="/frame"></iframe>',
  '/b': '<!doctype html><title>B</title><p>B</p>',
  '/frame': '<!doctype html><title>Frame</title><p>Frame</p>',
};
const server = http.createServer((request, response) => {
  const page = pages[new URL(request.url, 'http://127.0.0.1').pathname];
  response.writeHead(page ? 200 : 404, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  response.end(page || '');
});

let browser, socket, stderr = '';
const run = async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const site = `http://127.0.0.1:${server.address().port}`;
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'user.js'), [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  ].join('\n'));
  browser = spawn(process.env.FIREFOX_PATH, ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0', '--remote-allow-system-access'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  browser.stderr.on('data', value => { stderr += value; });
  socket = await connectFirefox({ browser, stderr: () => stderr });
  let id = 0; const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data), call = pending.get(message.id);
    if (call) { pending.delete(message.id); message.type === 'error' ? call.reject(Error(`${message.error}: ${message.message}`)) : call.resolve(message.result); }
  };
  const bidi = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })); });
  const version = (await bidi('session.new', { capabilities: {} })).capabilities?.browserVersion;
  await bidi('webExtension.install', { extensionData: { type: 'path', path: ext } });
  const { context } = await bidi('browsingContext.create', { type: 'tab' });
  const evaluate = async (expression, target = context) => {
    const result = await bidi('script.evaluate', { expression, target: { context: target }, awaitPromise: true });
    if (result.type === 'exception') throw Error(result.exceptionDetails?.text || 'Firefox evaluation failed');
    return result.result.value;
  };
  const navigate = url => bidi('browsingContext.navigate', { context, url, wait: 'complete' });
  const frameOf = async () => {
    for (let i = 0; i < 50; i++) {
      const { contexts } = await bidi('browsingContext.getTree', { root: context });
      const child = contexts[0]?.children?.find(entry => entry.url.endsWith('/frame'));
      if (child) return child.context;
      await pause(100);
    }
    throw Error('The subframe did not load');
  };
  // The provider is injected at document_start; give it the page's first turn.
  const provided = async (target = context) => {
    for (let i = 0; i < 100 && !(await evaluate('Boolean(window.zenon)', target)); i++) await pause(50);
  };
  const ask = (method, target) => evaluate(`window.zenon.request({ method: ${JSON.stringify(method)} })
    .then(value => JSON.stringify({ value }), error => JSON.stringify({ error: error.code + ' ' + error.message }))`, target).then(JSON.parse);
  // Settled within the window, or still pending: a pending connect is waiting
  // on its approval window, which is the admitted outcome here.
  const connect = (target = context) => evaluate(`Promise.race([
    window.zenon.request({ method: 'znn_connect' }).then(() => 'resolved', error => 'rejected ' + error.code),
    new Promise(resolve => setTimeout(() => resolve('pending'), 1500))])`, target);

  await navigate(site + '/a'); await provided();
  assert.deepEqual(await ask('znn_accounts'), { value: [] }, 'top frame read');
  assert.deepEqual(await ask('znn_chainId'), { value: null }, 'top frame chain read');
  const frame = await frameOf(); await provided(frame);
  assert.deepEqual(await ask('znn_accounts', frame), { value: [] }, 'subframe read');

  assert.equal(await connect(), 'pending', 'first connect waits for approval');
  assert.equal(await connect(), 'rejected -32005', 'one pending connect per origin');
  for (const [step, action] of [
    ['navigation', () => navigate(site + '/b')],
    ['reload', () => bidi('browsingContext.reload', { context, wait: 'complete' })],
    ['history', () => bidi('browsingContext.traverseHistory', { context, delta: -1 })],
  ]) {
    await action(); await pause(300); await provided();
    assert.deepEqual(await ask('znn_accounts'), { value: [] }, step + ': read');
    assert.equal(await connect(), 'pending', step + ': the departed document\'s connect ended');
  }
  console.log(`Firefox site checks: top frame and subframe reads, connect ended by navigation, reload and history passed${version ? ' (' + version + ')' : ''}`);
};

const watchdog = setTimeout(() => { console.error('Firefox site checks timed out'); process.exit(1); }, 120000);
run().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; }).finally(() => {
  clearTimeout(watchdog);
  socket?.close(); browser?.kill(); server.close();
  // Windows keeps a killed browser's profile files locked for a moment.
  setTimeout(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }), 500);
});
