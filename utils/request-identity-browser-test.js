'use strict';
// Optional native coordination check. Actual queue/identity modules, synthetic
// metadata, a fresh MV3 profile and inert test pages only. No wallet or node.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.join(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syrius-request-identity-'));
const ext = path.join(dir, 'extension'); fs.mkdirSync(ext);
fs.writeFileSync(path.join(ext, 'requests.js'), fs.readFileSync(path.join(root, 'src/sections/Background/requests.js'), 'utf8').replace("'../../services/utils/approvalIdentity'", "'./approvalIdentity.js'"));
fs.copyFileSync(path.join(root, 'src/services/utils/approvalIdentity.js'), path.join(ext, 'approvalIdentity.js'));
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Isolated approval identity checks', version: '1.0', minimum_chrome_version: '111', permissions: ['storage'], background: { service_worker: 'worker.js', type: 'module' } }));
fs.writeFileSync(path.join(ext, 'worker.js'), `import requests from './requests.js'; chrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message.kind!=='fixture')return false;Promise.resolve(requests[message.method](...message.args)).then(result=>reply({result}),error=>reply({error:String(error)}));return true;});`);
fs.writeFileSync(path.join(ext, 'page.html'), '<!doctype html><title>Isolated approval checks</title><script type="module" src="page.js"></script>');
fs.writeFileSync(path.join(ext, 'page.js'), `import requests from './requests.js';import {identityOf} from './approvalIdentity.js';Object.assign(window,{requests,identityOf,worker:(method,...args)=>new Promise((resolve,reject)=>chrome.runtime.sendMessage({kind:'fixture',method,args},response=>chrome.runtime.lastError?reject(Error(chrome.runtime.lastError.message)):response.error?reject(Error(response.error)):resolve(response.result)))});`);
const browser = spawn(process.env.CHROMIUM_PATH || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + path.join(dir, 'profile'), '--enable-unsafe-extension-debugging', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '', launchError, socket, cdp;
browser.stderr.on('data', value => { stderr += value; }); browser.on('error', error => { launchError = error; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error('Native identity checks timed out'); socket?.close(); browser.kill(); process.exit(1); }, 60000);
(async () => {
  let port;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    const file = path.join(dir, 'profile', 'DevToolsActivePort');
    if (fs.existsSync(file)) { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); break; }
    await pause(100);
  }
  assert(port, 'Browser started: ' + stderr.slice(-400));
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map();
  socket.onmessage = event => { const message = JSON.parse(event.data), call = pending.get(message.id); if (call) { pending.delete(message.id); message.error ? call.reject(Error(JSON.stringify(message.error))) : call.resolve(message.result); } };
  cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const extension = await cdp('Extensions.loadUnpacked', { path: ext });
  const evaluate = async (page, expression) => { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page.sessionId); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  const createPage = async () => {
    const target = await cdp('Target.createTarget', { url: `chrome-extension://${extension.id}/page.html` });
    const page = { ...target, ...await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }) };
    for (let i = 0; i < 60; i++) { if (await evaluate(page, "typeof requests === 'object'")) return page; await pause(50); }
    throw Error('Actual queue module did not initialize');
  };
  const pages = [await createPage(), await createPage()];
  const windowId = await evaluate(pages[0], 'chrome.windows.getCurrent().then(value=>value.id)');
  const base = { responseId: 'same', documentId: 'doc-a', type: 'signMessage', params: { message: 'Synthetic approval metadata only' }, tabId: 1, frameId: 0, origin: 'https://fixture.invalid', title: '', favicon: '' };
  const a = await evaluate(pages[0], `requests.add(${JSON.stringify(base)})`);
  const b = await evaluate(pages[1], `worker('add',${JSON.stringify({ ...base, documentId: 'doc-b' })})`);
  assert.notEqual(a.id, b.id); assert.notEqual(a.id, a.responseId);
  const identity = await evaluate(pages[0], `identityOf(${JSON.stringify(a)})`);
  await evaluate(pages[0], `requests.attachWindow(${JSON.stringify(identity)},${windowId})`);
  const claims = await Promise.all([
    evaluate(pages[0], `requests.claim(${JSON.stringify(identity)},${windowId})`),
    evaluate(pages[1], `requests.claim(${JSON.stringify(identity)},${windowId})`),
    evaluate(pages[0], `worker('claim',${JSON.stringify(identity)},${windowId})`),
  ]);
  assert.equal(claims.filter(Boolean).length, 1); const winner = claims.find(Boolean);
  assert.equal(await evaluate(pages[1], `requests.reject(${JSON.stringify(identity)})`), null);
  assert.equal(await evaluate(pages[0], `worker('resolve',${JSON.stringify({ ...winner, claimId: 'other' })})`), null);
  const fresh = await createPage();
  assert.equal(await evaluate(fresh, `requests.checkClaim(${JSON.stringify(winner)})`), true, 'fresh module realm sees durable ownership');
  await Promise.all(Array.from({ length: 12 }, (_, i) => evaluate(pages[i % 2], `${i % 3 === 0 ? "worker('add'," : 'requests.add('}${JSON.stringify({ ...base, responseId: i, documentId: 'parallel-' + i })})`)));
  assert.equal((await evaluate(fresh, 'requests.list()')).length, 14);
  const removed = await evaluate(pages[0], `worker('closeWindow',${windowId})`); assert.equal(removed.length, 1); assert.equal(removed[0].id, a.id);
  assert.equal(await evaluate(fresh, `requests.checkClaim(${JSON.stringify(winner)})`), false);
  assert.equal((await evaluate(fresh, 'requests.list()')).length, 13, 'unstamped arrivals survive close');
  const result = { browser: version.Browser, oneClaimAcrossTwoPagesAndWorker: true, distinctDocumentCorrelation: true, claimantOnlySettlement: true, freshRealmReadsPersistedClaim: true, concurrentAddsRetained: 12, atomicClosePreservesUnstamped: true, profile: dir };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  await cdp('Browser.close'); socket.close();
})().catch(async error => { console.error(error.stack || String(error)); if (cdp) await cdp('Browser.close').catch(() => {}); socket?.close(); browser.kill(); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
