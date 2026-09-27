'use strict';
// Optional browser integration check: CHROMIUM_PATH=/path/to/chromium node
// utils/approval-claims-browser-test.js. Uses a new disposable profile and a
// synthetic MV3 extension containing the actual request-queue module. No wallet.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syrius-approval-claims-'));
const ext = path.join(dir, 'extension'); fs.mkdirSync(ext);
const source = fs.readFileSync(path.join(root, 'src/sections/Background/requests.js'), 'utf8');
assert.equal(source.split('export default requests;').length, 2);
const script = source.replace('export default requests;', 'globalThis.requests = requests;');
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Isolated Syrius approval claim test', version: '1.0', permissions: ['storage'], background: { service_worker: 'worker.js' } }));
fs.writeFileSync(path.join(ext, 'worker.js'), script + `\nchrome.runtime.onMessage.addListener((message, sender, reply) => { if (message.kind !== 'queue-test') return false; requests[message.method](...message.args).then(result => reply({result}), error => reply({error:String(error)})); return true; });`);
fs.writeFileSync(path.join(ext, 'page.html'), '<html><body>Isolated approval test<script src="page.js"></script></body></html>');
fs.writeFileSync(path.join(ext, 'page.js'), script + `\nwindow.worker = (method, ...args) => new Promise((resolve, reject) => chrome.runtime.sendMessage({kind:'queue-test',method,args}, response => chrome.runtime.lastError ? reject(Error(chrome.runtime.lastError.message)) : response.error ? reject(Error(response.error)) : resolve(response.result)));`);
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
  const pages = [];
  for (let i = 0; i < 2; i++) { const target = await cdp('Target.createTarget', { url: `chrome-extension://${loaded.id}/page.html` }); const attached = await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }); pages.push({ ...target, ...attached }); }
  const evaluate = async (page, expression) => { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page.sessionId); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  for (const page of pages) for (let i = 0; i < 60; i++) { if (await evaluate(page, "typeof requests === 'object'")) break; await sleep(50); }
  const base = { id: 'A', type: 'signAndSendBlock', createdAt: 1, params: { amount: '100' } };
  await evaluate(pages[0], `requests.add(${JSON.stringify(base)})`);
  const request = await evaluate(pages[0], "requests.get('A')");
  const claims = Array.from({ length: 3 }, (_, i) => ({ approvalId: request.approvalId, claimId: `claim-${i}`, windowId: 100 + i }));
  const results = await Promise.all(claims.map((claim, i) => evaluate(pages[i % 2], i === 2 ? `worker('claimBlock','A',${JSON.stringify(claim)})` : `requests.claimBlock('A',${JSON.stringify(claim)})`)));
  assert.equal(results.filter(Boolean).length, 1);
  const winner = claims[results.indexOf(true)];
  const loser = claims[results.indexOf(false)];
  assert.equal(await evaluate(pages[1], `requests.remove('A',${JSON.stringify(loser)})`), null);
  assert.equal(await evaluate(pages[1], "requests.attachWindow('A',999)"), false);
  const persisted = await evaluate(pages[1], "requests.get('A')");
  assert.equal(persisted.claimId, winner.claimId); assert.equal(persisted.windowId, winner.windowId);
  assert.equal(await evaluate(pages[1], "requests.oldest()"), null);
  const removed = await evaluate(pages[0], `worker('remove','A',${JSON.stringify(winner)})`);
  assert.equal(removed.approvalId, request.approvalId);
  await evaluate(pages[1], `requests.add(${JSON.stringify(base)})`);
  assert.equal(await evaluate(pages[0], `requests.claimBlock('A',${JSON.stringify(winner)})`), false);
  await Promise.all(Array.from({ length: 30 }, (_, i) => evaluate(pages[i % 2], `${i % 3 === 0 ? "worker('add'," : 'requests.add('}${JSON.stringify({ ...base, id: `parallel-${i}`, createdAt: i + 2 })})`)));
  assert.equal((await evaluate(pages[0], 'requests.list()')).length, 31);
  console.log(JSON.stringify({ browser: version.Browser, oneClaimAcrossTwoPagesAndWorker: true, claimantOnlySettlement: true, replacementRejectsOldApproval: true, concurrentAddsRetained: 30, profile: dir }));
  await cdp('Browser.close'); socket.close();
})().catch(async error => { console.error(String(error)); if (cdp) await cdp('Browser.close').catch(() => {}); socket?.close(); browser.kill(); process.exitCode = 1; });
