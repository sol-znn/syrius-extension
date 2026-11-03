'use strict';
// The wallet's proof of work (src/services/wallet/powSearch.js) in a real
// extension page, under the product's content security policy: in Chrome,
// and in Firefox when FIREFOX_PATH names one. Firefox is the reason for the
// module: the SDK's own PoW makes its worker from a blob: URL, which Firefox's
// extension pages refuse, so plasma was never generated there.
//
// Checks that every worker starts and is terminated, that the benchmark gives
// an estimate while the search runs and clears it after, and that the nonce
// really is a proof: SHA3-256 of nonce and hash meets the difficulty's target.
// No wallet, keys or node.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { copyModules } = require('./fixtures/extension-modules');
const { connectFirefox } = require('./fixtures/firefox-bidi');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syrius-pow-'));
const ext = path.join(dir, 'extension');
fs.mkdirSync(ext);
copyModules(ext, 'src/services/wallet/powSearch.js');
fs.writeFileSync(path.join(ext, 'approval-pow-worker.js'), require('./approval-pow-worker')());
const geckoId = 'syrius-pow-check@zenon-network';
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Proof of work checks', version: '1.0',
  content_security_policy: JSON.parse(fs.readFileSync(path.join(root, 'src/manifest.json'), 'utf8')).content_security_policy,
  browser_specific_settings: { gecko: { id: geckoId } },
}));
fs.writeFileSync(path.join(ext, 'page.html'), '<!doctype html><title>PoW checks</title><script type="module" src="page.js"></script>');
fs.writeFileSync(path.join(ext, 'page.js'), `import { generatePow, onPowProgress } from './src/services/wallet/powSearch.js';
const NativeWorker = Worker; let made = 0, terminated = 0;
window.Worker = class extends NativeWorker { constructor(...args) { super(...args); made++; } terminate() { terminated++; super.terminate(); } };
const seen = []; onPowProgress((progress) => seen.push(progress));
window.run = async (hash, difficulty) => {
  const started = performance.now();
  try {
    const nonce = await generatePow(hash, difficulty);
    return JSON.stringify({ nonce, ms: performance.now() - started, made, terminated, cores: navigator.hardwareConcurrency, seen });
  } catch (error) { return JSON.stringify({ error: String(error), made, terminated }); }
};
// What the SDK does instead, reported for the record: a worker from a blob: URL.
window.blobWorker = () => new Promise((resolve) => { try { const worker = new NativeWorker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'application/javascript' }))); worker.onmessage = () => resolve('runs'); worker.onerror = () => resolve('refused'); setTimeout(() => resolve('never started'), 2000); } catch (error) { resolve('refused: ' + error.message); } });
window.ready = true;`);

const hash = crypto.randomBytes(32).toString('hex');
const difficulty = 3000000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// What go-zenon checks: the first 8 bytes of SHA3-256(nonce || hash), little
// endian, reach 2^64 - 2^64/difficulty.
const isProof = (nonce) => {
  const digest = crypto.createHash('sha3-256').update(Buffer.concat([Buffer.from(nonce, 'hex'), Buffer.from(hash, 'hex')])).digest();
  const big = 1n << 64n;
  return digest.readBigUInt64LE(0) >= big - big / BigInt(difficulty);
};

const check = (browserName, raw) => {
  const result = JSON.parse(raw);
  assert(!result.error, `${browserName}: ${result.error}`);
  assert.match(result.nonce, /^[0-9a-f]{16}$/);
  assert(isProof(result.nonce), `${browserName}: the nonce is not a proof of work for the hash`);
  const expected = Math.max(1, Math.min(4, Math.floor((result.cores || 2) / 2)));
  assert.equal(result.made, expected, `${browserName}: workers started`);
  assert.equal(result.terminated, expected, `${browserName}: workers terminated`);
  const estimate = result.seen.find((progress) => progress && progress.estimateMs > 0);
  assert(estimate, `${browserName}: no estimate was reported`);
  assert.equal(result.seen.at(-1), null, `${browserName}: the estimate outlived the search`);
  console.log(`${browserName}: ${result.made} workers, estimate ${(estimate.estimateMs / 1000).toFixed(1)} s, took ${(result.ms / 1000).toFixed(1)} s`);
};

const launch = (executable, args) => {
  const browser = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  browser.stderr.on('data', (value) => { stderr += value; });
  return { browser, stderr: () => stderr };
};

const chromium = async () => {
  const profile = path.join(dir, 'chrome');
  const { browser, stderr } = launch(process.env.CHROMIUM_PATH || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--enable-unsafe-extension-debugging',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', 'about:blank']);
  let socket;
  try {
    let port;
    for (let i = 0; i < 300 && !port; i++) {
      const file = path.join(profile, 'DevToolsActivePort');
      if (fs.existsSync(file)) port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
      else await pause(100);
    }
    assert(port, 'Chromium started: ' + stderr().slice(-400));
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0; const pending = new Map();
    socket.onmessage = (event) => { const message = JSON.parse(event.data), call = pending.get(message.id); if (call) { pending.delete(message.id); message.error ? call.reject(Error(JSON.stringify(message.error))) : call.resolve(message.result); } };
    const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const extension = await cdp('Extensions.loadUnpacked', { path: ext });
    const target = await cdp('Target.createTarget', { url: `chrome-extension://${extension.id}/page.html` });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const evaluate = async (expression) => {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    for (let i = 0; i < 100 && !(await evaluate('window.ready === true')); i++) await pause(50);
    check('Chromium', await evaluate(`run(${JSON.stringify(hash)}, ${difficulty})`));
    console.log(`Chromium: a blob: worker (the SDK's) ${await evaluate('blobWorker()')}`);
  } finally {
    socket?.close();
    browser.kill();
  }
};

// Firefox through WebDriver BiDi: the extension installed temporarily, its
// moz-extension origin fixed through a profile preference so the page has a
// known address. BiDi may not navigate to an extension page, so the
// extension's own background opens it, as the toolbar button would.
const firefox = async () => {
  const firefoxExt = path.join(dir, 'firefox-extension');
  fs.cpSync(ext, firefoxExt, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(firefoxExt, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(firefoxExt, 'manifest.json'), JSON.stringify({ ...manifest, background: { scripts: ['background.js'] } }));
  fs.writeFileSync(path.join(firefoxExt, 'background.js'), "browser.tabs.create({ url: 'page.html' });");
  const profile = path.join(dir, 'firefox');
  fs.mkdirSync(profile);
  const uuid = crypto.randomUUID();
  fs.writeFileSync(path.join(profile, 'user.js'), [
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [geckoId]: uuid }))});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  ].join('\n'));
  const { browser, stderr } = launch(process.env.FIREFOX_PATH, ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0', '--remote-allow-system-access']);
  let socket;
  try {
    socket = await connectFirefox({ browser, stderr });
    let id = 0; const pending = new Map();
    socket.onmessage = (event) => { const message = JSON.parse(event.data), call = pending.get(message.id); if (call) { pending.delete(message.id); message.type === 'error' ? call.reject(Error(`${message.error}: ${message.message}`)) : call.resolve(message.result); } };
    const bidi = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })); });
    await bidi('session.new', { capabilities: {} });
    await bidi('webExtension.install', { extensionData: { type: 'path', path: firefoxExt } });
    let context;
    for (let i = 0; i < 100 && !context; i++) {
      const { contexts } = await bidi('browsingContext.getTree', {});
      context = contexts.find((entry) => entry.url === `moz-extension://${uuid}/page.html`)?.context;
      if (!context) await pause(100);
    }
    assert(context, 'Firefox opened the extension page');
    const evaluate = async (expression) => {
      const result = await bidi('script.evaluate', { expression, target: { context }, awaitPromise: true });
      if (result.type === 'exception') throw Error(result.exceptionDetails?.text || 'Firefox evaluation failed');
      return result.result.value;
    };
    for (let i = 0; i < 100 && !(await evaluate('window.ready === true')); i++) await pause(50);
    check('Firefox', await evaluate(`run(${JSON.stringify(hash)}, ${difficulty})`));
    console.log(`Firefox: a blob: worker (the SDK's) ${await evaluate('blobWorker()')}`);
    await bidi('session.end', {}).catch(() => {});
  } finally {
    socket?.close();
    browser.kill();
  }
};

const watchdog = setTimeout(() => { console.error('Proof of work checks timed out'); process.exit(1); }, 120000);
(async () => {
  await chromium();
  if (process.env.FIREFOX_PATH) await firefox();
  else console.log('Firefox: skipped (set FIREFOX_PATH)');
})().catch((error) => { console.error(error.stack || String(error)); process.exitCode = 1; }).finally(() => {
  clearTimeout(watchdog);
  // Windows keeps a killed browser's profile files locked for a moment.
  setTimeout(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }), 500);
});
