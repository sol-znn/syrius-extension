'use strict';
// Optional native coordination check. Actual queue/identity modules, synthetic
// metadata, a fresh MV3 profile and inert test pages only. No wallet or node.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.join(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syrius-approval-queue-'));
const ext = path.join(dir, 'extension'); fs.mkdirSync(ext);
// Actual modules with their import closure (see fixtures/extension-modules).
const { copyModules, documentFields } = require('./fixtures/extension-modules');
copyModules(ext, 'src/sections/Background/requests.js', 'src/services/utils/approvalIdentity.js', 'src/sections/Content/index.js', 'src/sections/Inpage/index.js', 'src/services/wallet/approvalPow.js');
// Build this fixture's worker from current source, independent of stale or
// differently minified ignored build artifacts. Production packaging is separate.
fs.writeFileSync(path.join(ext, 'approval-pow-worker.js'), require('./approval-pow-worker')());
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Isolated approval queue checks', version: '1.0', minimum_chrome_version: '112', permissions: ['storage'], content_security_policy: JSON.parse(fs.readFileSync(path.join(root, 'src/manifest.json'), 'utf8')).content_security_policy, background: { service_worker: 'worker.js', type: 'module' } }));
fs.writeFileSync(path.join(ext, 'worker.js'), `import requests from './src/sections/Background/requests.js'; let expired=0,relayRequest=null; requests.onExpired(rows=>{expired+=rows.length}); chrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message.channel==='znn'&&['hello','bye'].includes(message.kind)){reply({accepted:true});return false;}if(message.channel==='znn'&&message.kind==='request'){relayRequest=message;reply({accepted:true});return false;}if(message.kind!=='fixture')return false;if(message.method==='deliver'){chrome.tabs.sendMessage(sender.tab.id,{...message.args[0],activation:relayRequest?.activation,requestToken:relayRequest?.requestToken},{documentId:sender.documentId}).then(result=>reply({result}),error=>reply({error:String(error)}));return true;}if(message.method==='advance'){const now=Date.now();Date.now=()=>now+message.args[0];reply({result:true});return false;}if(message.method==='expired'){reply({result:expired});return false;}if(message.method==='relayed'){reply({result:relayRequest?.id??null});return false;}Promise.resolve(requests[message.method](...message.args)).then(result=>reply({result}),error=>reply({error:String(error)}));return true;});`);
fs.writeFileSync(path.join(ext, 'page.html'), '<!doctype html><title>Isolated approval checks</title><script type="module" src="page.js"></script>');
fs.writeFileSync(path.join(ext, 'page.js'), `import requests from './src/sections/Background/requests.js';import {identityOf} from './src/services/utils/approvalIdentity.js';import approvalPow from './src/services/wallet/approvalPow.js';import './src/sections/Content/index.js';import './src/sections/Inpage/index.js';window.fixtureMessages=[];window.addEventListener('message',event=>{if(event.source===window)window.fixtureMessages.push(event.data)});const NativeWorker=Worker;let terminated=0;window.Worker=class extends NativeWorker{terminate(){terminated++;super.terminate()}};Object.assign(window,{requests,identityOf,approvalPow,terminated:()=>terminated,worker:(method,...args)=>new Promise((resolve,reject)=>chrome.runtime.sendMessage({kind:'fixture',method,args},response=>chrome.runtime.lastError?reject(Error(chrome.runtime.lastError.message)):response.error?reject(Error(response.error)):resolve(response.result)))});`);
const browser = spawn(process.env.CHROMIUM_PATH || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + path.join(dir, 'profile'), '--enable-unsafe-extension-debugging', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '', launchError, socket, cdp;
browser.stderr.on('data', value => { stderr += value; }); browser.on('error', error => { launchError = error; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error('Native approval queue checks timed out'); socket?.close(); browser.kill(); process.exit(1); }, 60000);
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
  const base = { responseId: 'native', documentId: 'doc-a', type: 'signAndSendBlock', params: { data: { type: 'Buffer', data: Array(16384).fill(255) }, amount: '0' }, tabId: 1, frameId: 0, origin: 'https://fixture.invalid', title: '', favicon: '', ...documentFields() };
  const results = await Promise.all(Array.from({ length: 17 }, (_, i) => evaluate(pages[i % 2], `${i % 3 === 0 ? "worker('add'," : 'requests.add('}${JSON.stringify({ ...base, responseId: i, origin: 'https://slot-' + i + '.invalid' })}).then(value=>({ok:true,id:value.id}),error=>({ok:false,error:String(error)}))`)));
  assert.equal(results.filter(x=>x.ok).length,16); assert.equal(results.filter(x=>!x.ok).length,1);
  const rows = await evaluate(pages[0], 'requests.list()'); assert.equal(rows.length,16);
  assert(rows.every(row=>row.params.data.data.length===16384 && row.params.data.data.every(x=>x===255)));
  const bytesInUse = await evaluate(pages[0], 'chrome.storage.session.getBytesInUse()');
  const a = rows[0], identity = await evaluate(pages[0], `identityOf(${JSON.stringify(a)})`);
  await evaluate(pages[0], `requests.attachWindow(${JSON.stringify(identity)},${windowId})`);
  const claims = await Promise.all([
    evaluate(pages[0], `requests.claim(${JSON.stringify(identity)},${windowId})`),
    evaluate(pages[1], `requests.claim(${JSON.stringify(identity)},${windowId})`),
    evaluate(pages[0], `worker('claim',${JSON.stringify(identity)},${windowId})`),
  ]);
  assert.equal(claims.filter(Boolean).length,1); const winner=claims.find(Boolean);
  const fresh = await createPage();
  assert.equal(await evaluate(fresh, `requests.checkClaim(${JSON.stringify(winner)})`),true);
  await evaluate(pages[0], "worker('advance',30*60*1000)");
  await evaluate(pages[0], "worker('prune')");
  assert.equal(await evaluate(pages[0], "worker('expired')"),16);
  assert.equal((await evaluate(fresh,'requests.list()')).length,0);
  assert.equal(await evaluate(fresh,`requests.checkClaim(${JSON.stringify(winner)})`),false);
  // The generated static SDK WASM worker runs under the product's MV3 CSP.
  // Difficulty one is a tiny synthetic compatibility calculation, not a node
  // operation. The actual helper terminates the native worker after success.
  const powResult = await evaluate(fresh, `(async()=>{const controller=new AbortController();const nonce=await approvalPow('00'.repeat(32),1,{signal:controller.signal,expiresAt:Date.now()+10000});return {nonce,terminated:terminated()};})()`);
  assert.match(powResult.nonce,/^[0-9a-f]{16}$/i); assert.equal(powResult.terminated,1);
  // Only this page may hold a relay now. The others loaded one too, and an
  // extension page receives every other extension page's runtime message: their
  // relays answered this relay's own request `accepted: false` before the
  // worker could, a race real content scripts are never in. The response is
  // then delivered only once the worker holds this request's private token.
  for (const page of pages) await cdp('Target.closeTarget', { targetId: page.targetId });
  // Actual isolated-relay/provider code acknowledges an exact native-document
  // delivery. These disposable extension pages contain no wallet or live node.
  for (const expired of [false, true]) {
    const response = await evaluate(fresh, `(async()=>{window.fixtureMessages=[];const outcome=zenon.connect().then(result=>({result}),error=>({error}));for(let i=0;i<100&&!fixtureMessages.some(message=>message.method==='znn_connect');i++)await new Promise(resolve=>setTimeout(resolve,5));const request=fixtureMessages.find(message=>message.method==='znn_connect');if(!request)throw Error('Provider request missing');for(let i=0;i<100&&await worker('relayed')!==request.id;i++)await new Promise(resolve=>setTimeout(resolve,5));const expiresAt=Date.now()+${expired ? -1 : 5000};const receipt=await worker('deliver',{channel:'znn',kind:'response',id:request.id,result:['synthetic-account'],expiresAt});return {receipt,outcome:await outcome,expiresAt};})()`);
    assert.equal(response.receipt.accepted,!expired);
    if(expired)assert.equal(response.outcome.error.code,-32603);
    else {assert(response.receipt.acceptedAt<response.expiresAt);assert.deepEqual(response.outcome.result,['synthetic-account']);}
  }
  const result = { browser:version.Browser, nativeRelayAcceptanceBeforeExpiry:true, nativeRelayRejectsExpiredResponse:true, staticPowWorkerUnderProductCsp:true, proofOfWorkNonceFormat:true, nativeWorkerTerminated:true, concurrentNativeAdmissions:16, nextAdmissionRejected:true, fullCalldataEntriesRetained:16, bytesInUse, sessionQuota:10485760, oneClaimAcrossPagesAndWorker:true, freshRealmReadsPersistedClaim:true, workerExpiryRemoved:16, expiredClaimDeniedInFreshRealm:true, profile:dir };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  await cdp('Browser.close'); socket.close();
})().catch(async error => { console.error(error.stack || String(error)); if (cdp) await cdp('Browser.close').catch(() => {}); socket?.close(); browser.kill(); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
