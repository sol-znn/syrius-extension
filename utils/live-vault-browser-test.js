'use strict';
// Optional Chromium integration check. Uses a disposable profile and synthetic
// keys; actual vault/session code runs in two MV3 pages and the lease in a worker.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const babel = require('@babel/core');
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syrius-live-vault-'));
const ext = path.join(dir, 'extension'); fs.mkdirSync(ext);
const compile = file => babel.transformFileSync(path.join(root, file), { presets: [['@babel/preset-env', { targets: { chrome: '111' } }], '@babel/preset-react'], babelrc: false, configFile: false }).code;
const factory = (name, file) => `${JSON.stringify(name)}: function(module, exports, require) {\n${compile(file)}\n}`;
const sources = [factory('lease', 'src/services/wallet/sessionLease.js'), factory('session', 'src/services/wallet/session.js'), factory('vault', 'src/services/wallet/vault.js'), factory('main', 'src/layouts/mainLayout/mainLayout.js')];
const pageScript = `
const fixture = { settings: { autoLockMinutes: 15 }, signs: 0, locks: 0, pathname: '/site-integration', restores: 0, failRead: false, failWrite: false, readFailures: 0, writeFailures: 0 };
const originalGet = chrome.storage.session.get.bind(chrome.storage.session);
const originalSet = chrome.storage.session.set.bind(chrome.storage.session);
chrome.storage.session.get = (...args) => {
  if (fixture.failRead || fixture.readFailures > 0) { fixture.readFailures--; return Promise.reject(Error('Synthetic session read failure')); }
  return originalGet(...args);
};
chrome.storage.session.set = (...args) => {
  if (fixture.failWrite || fixture.writeFailures > 0) { fixture.writeFailures--; return Promise.reject(Error('Synthetic session write failure')); }
  return originalSet(...args);
};
const dispatch = () => {};
const navigate = to => { fixture.pathname = to; };
const action = () => ({});
const address = text => ({ toString: () => text });
class KeyStore {
  fromEntropy(entropy) { this.entropy = entropy; this.mnemonic = 'synthetic words'; return this; }
  getKeyPair(index) { const entropy = this.entropy; return {
    privateKey: new Uint8Array([123]),
    getAddress: async () => address(entropy + ':' + index),
    getPublicKey: async () => new Uint8Array([index, 65]),
    generateKeyPair: async function() { return this; },
    sign: async () => { fixture.signs++; return new Uint8Array([index, 65]); }
  }; }
}
const sdk = { KeyStore, KeyStoreManager: class { async readKeyStore(password, walletName) { return new KeyStore().fromEntropy(walletName); } }, Primitives: { Address: { parse: address } } };
const factories = { ${sources.join(',\n')} };
const cache = {};
function load(name) {
  if (cache[name]) return cache[name].exports;
  const module = { exports: {} }; cache[name] = module;
  factories[name](module, module.exports, id => {
    if (id === 'znn-ts-sdk') return sdk;
    if (id.endsWith('/utils/storage')) return { getSettings: () => fixture.settings, getCurrentNodeUrl: () => 'wss://example.invalid' };
    if (id === 'react') return React;
    if (id === 'react-router-dom') return { useLocation: () => ({ pathname: fixture.pathname }), useNavigate: () => navigate, Route: () => null, Routes: () => React.createElement('div', { id: 'wallet-routes' }, fixture.pathname) };
    if (id === 'react-redux') return { useDispatch: () => dispatch };
    if (id.endsWith('/wallet/session')) return load('session');
    if (id.endsWith('/wallet/vault')) return load('vault');
    if (id.endsWith('/wallet/bootstrap')) return { completeUnlock: async ({sessionRecord}) => {
      fixture.restores++;
      const lifetime = await vault.restore(sessionRecord);
      if (fixture.holdFirstBoot && fixture.restores === 1) {
        fixture.bootHeld = true;
        await new Promise(resolve => { fixture.releaseBoot = resolve; });
        try { await vault.assertSession(lifetime); }
        finally { fixture.bootReleased = true; }
      }
      if (fixture.restores === 1 && fixture.bootFault) {
        fixture.readFailures = 1;
        if (fixture.bootFault === 'cleanup-read') fixture.failRead = true;
        else if (fixture.bootFault === 'transient') fixture.writeFailures = 1;
        else fixture.failWrite = true;
        // Exercise the actual failed post-adoption authorization and local
        // purge, followed by MainLayout's generation-conditional cleanup.
        await vault.assertSession();
      }
    } };
    if (id.endsWith('/redux/walletSlice')) return { resetWalletState: action };
    if (id.endsWith('/redux/pendingTransactionsSlice')) return { resetPendingTransactions: action };
    if (id.endsWith('/hooks/useAccount')) return { invalidateAccountCache() {} };
    if (id.endsWith('/utils/notify')) return { notify: { dismissAll() {} } };
    if (id.endsWith('/utils/utils')) return { loadStorageWalletNames: () => ['synthetic-boot', 'synthetic-replacement'] };
    if (id.endsWith('/utils/devWallet')) return { isDevWalletBuild: false };
    if (id.includes('Layout/') || id.includes('/pages/') || id.endsWith('/splash/splash')) return () => React.createElement('div', null, 'Loading');
    return load({ './session': 'session', './sessionLease': 'lease' }[id]);
  });
  return module.exports;
}
globalThis.fixture = fixture;
globalThis.vault = load('vault').default;
globalThis.session = load('session').default;
globalThis.lease = load('lease').default;
vault.onLock(() => fixture.locks++);
globalThis.worker = (method, ...args) => new Promise((resolve, reject) => chrome.runtime.sendMessage({kind:'lease-test',method,args}, response => chrome.runtime.lastError ? reject(Error(chrome.runtime.lastError.message)) : response.error ? reject(Error(response.error)) : resolve(response.result)));
globalThis.mountStartup = () => {
  fixture.reactRoot = ReactDOM.createRoot(document.getElementById('root'));
  fixture.reactRoot.render(React.createElement(load('main').default));
};
globalThis.denied = operation => Promise.resolve().then(operation).then(() => false, error => error.code === 'WALLET_LOCKED');
`;
const workerSource = fs.readFileSync(path.join(root, 'src/services/wallet/sessionLease.js'), 'utf8').replace('export default sessionLease;', '');
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Isolated Syrius live vault test', version: '1.0', permissions: ['storage'], background: { service_worker: 'worker.js' } }));
fs.writeFileSync(path.join(ext, 'worker.js'), workerSource + `\nchrome.runtime.onMessage.addListener((message, sender, reply) => { if (message.kind !== 'lease-test') return false; sessionLease[message.method](...message.args).then(result => reply({result}), error => reply({error:String(error)})); return true; });`);
fs.copyFileSync(path.join(root, 'node_modules/react/umd/react.production.min.js'), path.join(ext, 'react.js'));
fs.copyFileSync(path.join(root, 'node_modules/react-dom/umd/react-dom.production.min.js'), path.join(ext, 'react-dom.js'));
fs.writeFileSync(path.join(ext, 'page.html'), '<html><body><div id="root">Isolated vault test</div><script src="react.js"></script><script src="react-dom.js"></script><script src="page.js"></script></body></html>');
fs.writeFileSync(path.join(ext, 'page.js'), pageScript);
const browser = spawn(process.env.CHROMIUM_PATH || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, '--enable-unsafe-extension-debugging', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = ''; browser.stderr.on('data', chunk => { stderr += chunk; });
let launchError; browser.on('error', error => { launchError = error; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, cdp;
(async () => {
  let port;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    const file = path.join(dir, 'profile', 'DevToolsActivePort');
    if (fs.existsSync(file)) { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); break; }
    await sleep(100);
  }
  if (!port) throw Error('Browser failed to start: ' + stderr.slice(-500));
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map();
  socket.onmessage = event => { const message = JSON.parse(event.data); const callback = pending.get(message.id); if (callback) { pending.delete(message.id); message.error ? callback.reject(Error(JSON.stringify(message.error))) : callback.resolve(message.result); } };
  cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const loaded = await cdp('Extensions.loadUnpacked', { path: ext });
  const evaluate = async (page, expression) => { const result = await cdp('Runtime.evaluate', { expression: '(async () => (' + expression + '))()', awaitPromise: true, returnByValue: true }, page.sessionId); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  const openPage = async () => {
    const target = await cdp('Target.createTarget', { url: `chrome-extension://${loaded.id}/page.html` });
    const page = { ...target, ...await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }) };
    for (let i = 0; i < 100; i++) { if (await evaluate(page, "typeof vault === 'object'")) return page; await sleep(50); }
    throw Error('Page vault did not initialize');
  };
  const until = async (page, expression) => {
    for (let i = 0; i < 100; i++) { if (await evaluate(page, expression)) return; await sleep(50); }
    throw Error('Browser state did not settle: ' + expression);
  };
  let a = await openPage(); const b = await openPage();
  const first = await evaluate(a, "(async () => { const scope = await vault.unlockWithPassword('synthetic-A','ok',1); globalThis.old = await vault.getSigningKeyPair(); return scope.id; })()");
  assert.equal(await evaluate(b, "(async () => { const record = await session.load(); await vault.restore(record,1); globalThis.old = await vault.getSigningKeyPair(); return vault.capture().id; })()"), first);
  assert.equal(await evaluate(b, "(await old.getAddress()).toString()"), 'synthetic-A:1');
  assert.equal(await evaluate(a, "(await old.sign(new Uint8Array([1]))).length"), 2);
  await evaluate(b, "worker('clear')");
  await until(a, '!vault.isUnlocked() && fixture.locks === 1');
  await until(b, '!vault.isUnlocked() && fixture.locks === 1');
  for (const page of [a, b]) assert.equal(await evaluate(page, 'denied(() => old.sign(new Uint8Array([2])))'), true);
  assert.equal(await evaluate(a, 'fixture.signs'), 1);
  assert.equal(await evaluate(b, 'fixture.signs'), 0);
  await evaluate(a, "vault.unlockWithPassword('synthetic-B','ok')");
  assert.equal(await evaluate(a, 'denied(() => old.getPublicKey())'), true);
  // An On close owner stays usable; neither another page nor a reopened owner
  // can recover key material from its public marker.
  await evaluate(a, "fixture.settings.autoLockMinutes = 0, vault.unlockWithPassword('synthetic-local','ok')");
  const marker = await evaluate(b, "(await chrome.storage.session.get('znn.unlock'))['znn.unlock']");
  assert.equal(marker.mode, 'local'); assert.equal(marker.entropy, undefined);
  assert.equal(await evaluate(b, 'session.load()'), null);
  await evaluate(a, "session.publish(vault.capture().id, { address: 'synthetic-local:0' })");
  assert.equal(await evaluate(b, "worker('getPublicState')"), null);
  await evaluate(b, "worker('expire')");
  assert.equal(await evaluate(a, '(await (await vault.getSigningKeyPair()).sign(new Uint8Array([3]))).length'), 2);
  await cdp('Target.closeTarget', { targetId: a.targetId }); a = await openPage();
  assert.equal(await evaluate(a, 'session.load()'), null);
  assert.equal(await evaluate(a, 'vault.isUnlocked()'), false);
  // A real wall-clock deadline revokes both live pages and triggers cleanup.
  await evaluate(a, "fixture.settings.autoLockMinutes = 0.03, vault.unlockWithPassword('synthetic-short','ok')");
  await evaluate(b, "fixture.settings.autoLockMinutes = 0.03, (async () => { await vault.restore(await session.load()); globalThis.short = await vault.getSigningKeyPair(); })()");
  await until(a, '!vault.isUnlocked() && fixture.locks > 0');
  await until(b, '!vault.isUnlocked() && fixture.locks > 1');
  assert.equal(await evaluate(b, 'denied(() => short.sign(new Uint8Array([4])))'), true);
  assert.equal(await evaluate(a, "(await chrome.storage.session.get('znn.unlock'))['znn.unlock'].entropy === undefined"), true);
  // Real React MainLayout, actual vault/session/lease modules, native MV3
  // storage in two pages. Only the injected faults and key material are fake.
  for (const mode of ['normal', 'read', 'cleanup-read', 'cleanup-write', 'transient', 'replacement']) {
    await evaluate(b, "fixture.settings.autoLockMinutes = 15");
    const bootId = await evaluate(b, "(async () => { const scope = await vault.unlockWithPassword('synthetic-boot','ok'); globalThis.bootSigner = await vault.getSigningKeyPair(); return scope.id; })()");
    const startup = await openPage();
    await evaluate(startup, `fixture.bootFault = ${JSON.stringify(['normal', 'read'].includes(mode) ? null : mode)}, fixture.failRead = ${mode === 'read'}, mountStartup()`);
    if (['normal', 'transient'].includes(mode)) {
      await until(startup, "Boolean(document.getElementById('wallet-routes'))");
      assert.equal(await evaluate(startup, "Boolean(document.querySelector('[role=alert]'))"), false);
      if (mode === 'normal') assert.equal(await evaluate(startup, 'vault.capture().id'), bootId);
      else {
        assert.equal(await evaluate(startup, 'fixture.pathname'), '/password');
        assert.equal(await evaluate(b, 'denied(() => bootSigner.sign(new Uint8Array([5])))'), true);
      }
    } else {
      await until(startup, "Boolean(document.querySelector('[role=alert]'))");
      assert.equal(await evaluate(startup, "Boolean(document.getElementById('wallet-routes'))"), false);
      assert.match(await evaluate(startup, "document.querySelector('[role=alert]').textContent"), mode === 'read' ? /Other wallet windows may still be unlocked/ : /Could not lock all wallet windows/);
      assert.equal(await evaluate(b, "(await chrome.storage.session.get('znn.unlock'))['znn.unlock'].id"), bootId);
      let replacementId;
      if (mode === 'replacement') replacementId = await evaluate(b, "(await vault.unlockWithPassword('synthetic-replacement','ok')).id");
      await evaluate(startup, "fixture.failRead = fixture.failWrite = false, document.querySelector('button').click()");
      await until(startup, "Boolean(document.getElementById('wallet-routes'))");
      if (replacementId) {
        assert.equal(await evaluate(startup, 'vault.capture().id'), replacementId);
        assert.equal(await evaluate(b, "(await chrome.storage.session.get('znn.unlock'))['znn.unlock'].id"), replacementId);
        assert.equal(await evaluate(b, 'vault.getAddress()'), 'synthetic-replacement:0');
      } else if (mode === 'read') {
        assert.equal(await evaluate(startup, 'vault.capture().id'), bootId);
      } else {
        assert.equal(await evaluate(startup, 'fixture.pathname'), '/password');
        assert.equal(await evaluate(b, 'denied(() => bootSigner.sign(new Uint8Array([6])))'), true);
      }
    }
    await cdp('Target.closeTarget', {targetId: startup.targetId});
  }
  // The same availability failure after startup uses an honest error view;
  // it cannot expose ordinary locked UI without a committed shared revoke.
  for (const mode of ['sign-read', 'public-read', 'touch-write', 'verify-read', 'storage-event', 'replacement']) {
    await evaluate(b, "fixture.settings.autoLockMinutes = 15");
    const originalId = await evaluate(b, "(async () => { const scope = await vault.unlockWithPassword('synthetic-boot','ok'); globalThis.runtimeSigner = await vault.getSigningKeyPair(); return scope.id; })()");
    const affected = await openPage();
    await evaluate(affected, "fixture.pathname = '/tabs/settings/export-mnemonic', mountStartup()");
    await until(affected, "Boolean(document.getElementById('wallet-routes'))");
    await evaluate(affected, "globalThis.runtimeKey = await vault.getSigningKeyPair()");
    if (mode === 'storage-event') {
      await evaluate(affected, 'fixture.failRead = true');
      await evaluate(b, 'vault.touch()');
    } else {
      const call = mode === 'touch-write' ? 'vault.touch()' : mode === 'verify-read' ? "vault.verifyPassword('ok')" : mode === 'public-read' ? 'runtimeKey.getPublicKey()' : 'runtimeKey.sign(new Uint8Array([1]))';
      const code = await evaluate(affected, `(async () => { fixture.${mode === 'touch-write' ? 'failWrite' : 'failRead'} = true; try { await ${call}; return null; } catch(error) { return error.code; } })()`);
      assert.equal(code, 'WALLET_SESSION_UNAVAILABLE');
    }
    await until(affected, "Boolean(document.querySelector('[role=alert]'))");
    assert.equal(await evaluate(affected, "Boolean(document.getElementById('wallet-routes'))"), false);
    assert.match(await evaluate(affected, 'document.body.textContent'), /Other wallet windows may still be unlocked/);
    assert.equal(await evaluate(affected, 'fixture.signs'), 0);
    assert.equal(await evaluate(affected, 'vault.isUnlocked()'), false);
    assert.equal(await evaluate(b, "(await chrome.storage.session.get('znn.unlock'))['znn.unlock'].id"), originalId);
    if (mode === 'verify-read') {
      await evaluate(affected, "document.querySelector('button').click()");
      await until(affected, "Boolean(document.querySelector('[role=alert]'))");
      assert.equal(await evaluate(affected, "Boolean(document.getElementById('wallet-routes'))"), false);
      assert.match(await evaluate(affected, 'document.body.textContent'), /Could not lock all wallet windows/);
      assert.equal(await evaluate(b, "(await chrome.storage.session.get('znn.unlock'))['znn.unlock'].id"), originalId);
    }
    let newer;
    if (mode === 'replacement') newer = await evaluate(b, "(await vault.unlockWithPassword('synthetic-replacement','ok')).id");
    await evaluate(affected, "fixture.failRead = fixture.failWrite = false, document.querySelector('button').click()");
    await until(affected, "Boolean(document.getElementById('wallet-routes'))");
    if (newer) {
      assert.equal(await evaluate(affected, 'vault.capture().id'), newer);
      assert.equal(await evaluate(b, 'vault.getAddress()'), 'synthetic-replacement:0');
    } else {
      assert.equal(await evaluate(affected, 'fixture.pathname'), '/password');
      assert.equal(await evaluate(b, 'denied(() => runtimeSigner.sign(new Uint8Array([2])))'), true);
    }
    await cdp('Target.closeTarget', { targetId: affected.targetId });
  }

  // A retry may complete while the old startup still awaits its node. The
  // old generation must not replace the new recovery state when it resumes.
  for (const replacement of [false, true]) {
    await evaluate(b, "fixture.settings.autoLockMinutes = 15, vault.unlockWithPassword('synthetic-boot','ok')");
    const late = await openPage();
    await evaluate(late, 'fixture.holdFirstBoot = true, mountStartup()');
    await until(late, 'fixture.bootHeld === true');
    await evaluate(late, 'fixture.failRead = true');
    await evaluate(b, 'vault.touch()');
    await until(late, "Boolean(document.querySelector('[role=alert]'))");
    await evaluate(late, 'fixture.failRead = false');
    let newer;
    if (replacement) newer = await evaluate(b, "(await vault.unlockWithPassword('synthetic-replacement','ok')).id");
    await evaluate(late, "document.querySelector('button').click()");
    await until(late, "Boolean(document.getElementById('wallet-routes'))");
    const destination = await evaluate(late, 'fixture.pathname');
    assert.equal(destination, replacement ? '/site-integration' : '/password');
    if (newer) assert.equal(await evaluate(late, 'vault.capture().id'), newer);
    await evaluate(late, 'fixture.releaseBoot()');
    await until(late, 'fixture.bootReleased === true');
    assert.equal(await evaluate(late, "Boolean(document.getElementById('wallet-routes'))"), true);
    assert.equal(await evaluate(late, 'fixture.pathname'), destination);
    if (newer) assert.equal(await evaluate(late, 'vault.capture().id'), newer);
    await cdp('Target.closeTarget', { targetId: late.targetId });
  }
  console.log(JSON.stringify({ browser: version.Browser, sharedTimedRestore: true, workerLockRevokesBothPages: true, staleHandleRejected: true, onCloseOwnerOnly: true, automaticExpiryAndCleanup: true, actualStartupErrorAndRetryUI: true, runtimeAvailabilityErrorAndRetryUI: true, lateStartupPreservesRetry: true, replacementLeasePreserved: true, profile: dir }));
  await cdp('Browser.close'); socket.close();
})().catch(async error => { console.error(error.stack || String(error)); if (cdp) await cdp('Browser.close').catch(() => {}); socket?.close(); browser.kill(); process.exitCode = 1; });
