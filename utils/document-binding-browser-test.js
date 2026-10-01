'use strict';
// Native MV3 lifecycle regression checks. Actual patched worker, provider and
// isolated relay; disposable profile, loopback pages and inert approval results.
// No vault, key, signing, wallet node or external service is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const babel = require('@babel/core');
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syrius-document-browser-'));
const extension = path.join(dir, 'extension'); fs.mkdirSync(extension);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = (name, value) => fs.writeFileSync(path.join(extension, name), value);
const compile = file => babel.transformFileSync(path.join(root, file), {
  presets: [['@babel/preset-env', { targets: { chrome: '111' }, modules: 'commonjs' }]], configFile: false, babelrc: false,
}).code;
// Every application module an entry imports, found from its compiled requires.
const closure = entry => {
  const found = [];
  const visit = file => {
    if (found.includes(file)) return; found.push(file);
    for (const [, id] of compile(file).matchAll(/require\("([^"]+)"\)/g)) {
      if (!id.startsWith('.')) throw Error(`${file} imports ${id}; this fixture bundles application modules only`);
      const next = path.posix.join(path.posix.dirname(file), id); visit(path.posix.extname(next) ? next : next + '.js');
    }
  };
  visit(entry); return found;
};
const files = closure('src/sections/Background/index.js');
// The wallet is unlocked on one account (#11): consent and approvals are bound
// to it, and the popup binds, claims and resolves (#8).
const scope = { walletName: 'fixture', walletId: 'inert-approved-account', address: 'inert-approved-account', index: 0 };
const binding = { id: 'fixture-selection', ownerId: 'owner', scope };
const scheduler = `// Fixture-only storage scheduler; the imported application modules are unchanged.
let permissionGate; const nativeSet=chrome.storage.local.set.bind(chrome.storage.local);
chrome.storage.local.set=async values=>{if(permissionGate&&values['syrius.permissions']?.entries?.some(entry=>entry.pendingApproval)){
const gate=permissionGate;gate.entered=true;await gate.wait;permissionGate=null;}return nativeSet(values);};
chrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message.channel!=='fixture'||sender.url!==chrome.runtime.getURL('control.html'))return false;
if(message.method==='hold'){let release;const wait=new Promise(resolve=>{release=resolve;});permissionGate={wait,release,entered:false};reply(true);}
if(message.method==='entered')reply(Boolean(permissionGate?.entered));if(message.method==='release'){permissionGate?.release();reply(true);}return false;});
`;
const bundle = (sources, entry = sources[0], expose) => `(()=>{const factories={${sources.map(file => `${JSON.stringify(file)}:(module,exports,require)=>{${compile(file)}\n}`).join(',')}};
const cache={}; const load=name=>{if(cache[name])return cache[name].exports;const module=cache[name]={exports:{}};
factories[name](module,module.exports,id=>{let p=new URL(id,'https://bundle/'+name).pathname.slice(1);if(!p.endsWith('.js'))p+='.js';return load(p);});return module.exports;};const exported=load(${JSON.stringify(entry)});${expose ? `globalThis[${JSON.stringify(expose)}]=exported;` : ''}})();`;
write('worker.js', scheduler + bundle(files));
for (const [name, section] of [['content.js', 'Content'], ['inpage.js', 'Inpage']]) write(name, bundle(closure(`src/sections/${section}/index.js`)));
write('manifest.json', JSON.stringify({ manifest_version: 3, name: 'Syrius document lifecycle regression', version: '1.0', minimum_chrome_version: '111',
  permissions: ['storage', 'alarms', 'webNavigation'], background: { service_worker: 'worker.js' },
  content_scripts: ['MAIN', 'ISOLATED'].map(world => ({ matches: ['http://*.test/*'], js: [world === 'MAIN' ? 'inpage.js' : 'content.js'], world, all_frames: true, run_at: 'document_start' })) }));
// The control page claims with the application's own approval identity.
write('identity.js', bundle(closure('src/services/utils/approvalIdentity.js'), undefined, 'approvalIdentity'));
write('control.html', '<!doctype html><script src="identity.js"></script><script src="control.js"></script>');
write('popup.html', '<!doctype html><title>Inert approval window</title><p>Lifecycle fixture: no signing UI.</p>');
write('control.js', `globalThis.fixture=method=>chrome.runtime.sendMessage({channel:'fixture',method});
globalThis.internal = async (method,params={})=>{const reply=await chrome.runtime.sendMessage({channel:'internal',method,params});if(reply.error)throw Error(reply.error);return reply.result;};
globalThis.records=async key=>(await chrome.storage.session.get(key))[key];
globalThis.unlock=()=>{const now=Date.now(),scope=${JSON.stringify(scope)};return chrome.storage.session.set({
'znn.unlock':{version:2,id:'lease',revision:'r',walletName:'fixture',minutes:15,mode:'timed',entropy:'fixture',ownerId:'owner',selectedAddressIndex:0,selectionId:'fixture-selection',scope,resumeFrom:null,lastActiveAt:now,expiresAt:now+3600000},
'znn.publicState':{address:scope.address,scope,selectionId:'fixture-selection',leaseId:'lease',chainId:1,nodeUrl:'wss://node.invalid'}}).then(()=>true);};
globalThis.current=async request=>{const stored=(await records('znn.pendingRequests'))?.[request.id];
if(!stored||stored.requestToken!==request.requestToken||stored.activation!==request.activation)return false;
const nav=(await records('znn.navigation'))?.[request.tabId];
if((nav?.epoch||'initial')!==request.navigationTab||(nav?.frames?.[request.frameId]||'initial')!==request.navigationFrame)return false;
return (await target(request,{kind:'probe',requireRequest:true}))?.accepted===true;};
globalThis.approve=async (request,binding)=>{for(let i=0;i<8;i++){const pending=await records('znn.pendingRequests');if(!pending?.[request.id])return false;
const next=await internal('approvals.next',{binding});if(!next)return false;
const claim=await internal('approvals.claim',{identity:approvalIdentity.identityOf(next),windowId:next.windowId});
if(next.id!==request.id)continue;if(!claim)return false;return internal('approvals.resolve',{identity:claim,result:['inert-approved-account']});}return false;};
globalThis.target=async (record,payload)=>{try{return await chrome.tabs.sendMessage(record.tabId,{channel:'znn',activation:record.activation,requestToken:record.requestToken,...payload},{frameId:record.frameId,documentId:record.documentId});}catch{return {accepted:false};}};`);
let browser, socket, cdp, server;
const watchdog = setTimeout(() => { console.error('Native document fixture timed out'); browser?.kill(); server?.close(); process.exit(1); }, 90000);
(async () => {
  // A launching page that prerenders /prerendered and opens it a moment later,
  // and that page, which reads and listens at load like a dApp does.
  const prerenderPages = {
    '/launch': '<!doctype html><title>Inert prerender launcher</title><script type="speculationrules">{"prerender":[{"source":"list","urls":["/prerendered"],"eagerness":"immediate"}]}</script><a id="go" href="/prerendered">Open</a><script>setTimeout(()=>document.getElementById("go").click(),1500)</script>',
    '/prerendered': '<!doctype html><title>Inert prerendered page</title><script>window.prerenderLog=[{prerendering:document.prerendering}];zenon.getAccounts().then(value=>prerenderLog.push({accounts:value}),error=>prerenderLog.push({error:error.code}));zenon.on("accountsChanged",value=>prerenderLog.push({event:value}));</script>',
  };
  server = http.createServer((request, response) => {
    if (request.url === '/nocontent') { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'max-age=300' });
    if (Object.hasOwn(prerenderPages, request.url)) { response.end(prerenderPages[request.url]); return; }
    response.end('<!doctype html><title>Inert lifecycle page</title><p>Local regression fixture</p><script>window.shows=[];addEventListener("pageshow",e=>shows.push(e.persisted),true);for(const type of ["pagehide","pageshow"])addEventListener(type,e=>e.stopImmediatePropagation(),true);</script>' + (request.url === '/frames' ? '<iframe id="child" src="/child-a"></iframe>' : ''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, aOrigin = `http://a.test:${port}`, bOrigin = `http://b.test:${port}`;
  browser = spawn(process.env.CHROMIUM_PATH || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, '--enable-unsafe-extension-debugging',
    '--host-resolver-rules=MAP *.test 127.0.0.1', '--no-proxy-server', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', launchError; browser.stderr.on('data', chunk => { stderr += chunk; }); browser.on('error', error => { launchError = error; });
  let debugPort;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    const file = path.join(dir, 'profile', 'DevToolsActivePort');
    if (fs.existsSync(file)) { debugPort = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); break; }
    await sleep(100);
  }
  if (!debugPort) throw Error('Browser did not start: ' + stderr.slice(-500));
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map();
  socket.onmessage = event => { const value = JSON.parse(event.data), callback = pending.get(value.id); if (callback) { pending.delete(value.id); value.error ? callback.reject(Error(JSON.stringify(value.error))) : callback.resolve(value.result); } };
  cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const open = async url => { const target = await cdp('Target.createTarget', { url }); return { ...target, ...await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }) }; };
  const evaluate = async (page, expression) => { const result = await cdp('Runtime.evaluate', { expression: '(async()=>(' + expression + '))()', awaitPromise: true, returnByValue: true }, page.sessionId); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  const eventually = async (read, predicate, label) => { for (let i = 0; i < 120; i++) { const value = await read(); if (predicate(value)) return value; await sleep(40); } throw Error('Timed out: ' + label); };
  const loaded = await cdp('Extensions.loadUnpacked', { path: extension });
  const control = await open(`chrome-extension://${loaded.id}/control.html`);
  await eventually(() => evaluate(control, 'typeof internal'), v => v === 'function', 'control ready');
  assert.equal(await evaluate(control, 'unlock()'), true);
  const internal = (method, params = {}) => evaluate(control, `internal(${JSON.stringify(method)},${JSON.stringify(params)})`);
  const target = (record, payload) => evaluate(control, `target(${JSON.stringify(record)},${JSON.stringify(payload)})`);
  const queue = () => internal('approvals.list');
  const frameRecords = () => evaluate(control, "records('znn.frames')");
  const ready = async (page, url) => eventually(() => evaluate(page, '({url:location.href,ready:typeof zenon})').catch(() => null), v => v?.url === url && v.ready === 'object', 'provider ready');
  const begin = (page, windowExpression = 'window') => evaluate(page, `(()=>{const w=${windowExpression};w.outcomes=[];w.zenon.connect().then(value=>w.outcomes.push({value}),error=>w.outcomes.push({error:error.code}));return true;})()`);
  // A request is offered to the popup once its approval window is attached;
  // until then approvals.next passes over it.
  const shown = (r, tabId) => (tabId === undefined || r.tabId === tabId) && Number.isInteger(r.windowId);
  const waitRequest = tabId => eventually(queue, value => value.some(r => shown(r, tabId)), 'shown request').then(value => value.find(r => shown(r, tabId)));
  // An unlocked wallet answers a connected origin's connect at once (#11), so
  // each approved connect is disconnected again unless the step keeps it: the
  // next round must prompt, as it did against a locked wallet.
  const resolve = async (request, { keep = false } = {}) => {
    const approved = await evaluate(control, `approve(${JSON.stringify(request)},${JSON.stringify(binding)})`);
    if (approved && request.type === 'connect' && !keep) await internal('permissions.revoke', { origin: request.origin });
    return approved;
  };
  // What the old approvals.current answered: still pending, and its document
  // still the live one that made it (a claim runs the same check).
  // Read-only, from the control page: the stored record is unchanged, its
  // navigation generations are the current ones, and its relay accepts a probe.
  const current = request => evaluate(control, `current(${JSON.stringify(request)})`);
  const page = await open(aOrigin + '/a'); await ready(page, aOrigin + '/a');
  assert.equal(await evaluate(page, 'isSecureContext'), false);
  assert.equal(await evaluate(page, 'typeof crypto.randomUUID'), 'undefined');
  assert.deepEqual(await evaluate(page, 'zenon.getAccounts().catch(error=>({failure:error}))'), []);
  await begin(page); const first = await waitRequest(); assert.equal(first.frameId, 0);
  assert.equal(await current(first), true);
  // Opening an approval changes focus but must not expire its request.
  await evaluate(page, "history.replaceState({},'',location.href+'#same-document')");
  assert.equal(await current(first), true);
  await cdp('Page.navigate', { url: aOrigin + '/b' }, page.sessionId); await ready(page, aOrigin + '/b');
  assert.equal(await resolve(first), false);
  assert.equal((await target(first, { kind: 'response', result: 'inert-old-result' })).accepted, false);
  assert.deepEqual(await queue(), []);
  await begin(page); const replacement = await waitRequest(first.tabId);
  assert.notEqual(replacement.documentId, first.documentId); assert.equal(replacement.frameId, first.frameId);
  assert.equal(await resolve(replacement), true);
  await eventually(() => evaluate(page, 'outcomes'), value => value.length === 1, 'new document completion');
  assert.deepEqual(await evaluate(page, 'outcomes'), [{ value: ['inert-approved-account'] }]);
  // Actual BFCache restoration retains document ID but invalidates old tokens.
  await evaluate(page, 'history.back()');
  await ready(page, aOrigin + '/a#same-document');
  const restored = await evaluate(page, 'shows.at(-1)'); assert.equal(restored, true, 'This browser must exercise BFCache');
  assert.deepEqual(await evaluate(page, 'outcomes'), [{ error: 4900 }]);
  await begin(page); const fresh = await waitRequest(first.tabId);
  assert.equal(fresh.documentId, first.documentId); assert.notEqual(fresh.activation, first.activation);
  assert.equal(await resolve(first), false); assert.equal(await resolve(fresh, { keep: true }), true);
  // Connected event broadcasts use the newly registered activation.
  await evaluate(page, "(window.accountEvents=[],zenon.on('accountsChanged',value=>accountEvents.push(value)),true)");
  await eventually(frameRecords, rows => Object.values(rows || {}).some(r => r.documentId === fresh.documentId && r.activation === fresh.activation), 'fresh frame registration');
  await internal('events.accountsChanged', { selectionId: binding.id });
  await eventually(() => evaluate(page, 'accountEvents'), value => value.length === 1, 'fresh activation event');
  assert.deepEqual(await evaluate(page, 'accountEvents'), [['inert-approved-account']]);
  // A navigation that starts and never commits (a 204 here; a download is the
  // same) leaves the document in place, connected, and still getting events.
  await evaluate(page, "(location.href='/nocontent',true)");
  await eventually(() => evaluate(control, "records('znn.navigation')"), nav => Boolean(nav?.[fresh.tabId]?.epoch) && nav[fresh.tabId].epoch !== fresh.navigationTab, 'aborted navigation seen');
  await internal('events.accountsChanged', { selectionId: binding.id });
  await eventually(() => evaluate(page, 'accountEvents'), value => value.length === 2, 'event after aborted navigation');
  // A transfer's params come back from chrome.storage with their keys sorted.
  // Its identity must still match the stored record, or the request can be
  // neither shown nor rejected (a regression the fixtures could not see).
  await evaluate(page, "(window.transfer=null,zenon.sendTransaction({to:'z1qqjnwjjpnue8xmmpanz6csze6tcmtzzdtfsww7',tokenStandard:'zts1znnxxxxxxxxxxxxx9z4ulx',amount:'1'}).then(value=>{transfer={value};},error=>{transfer={error:error.code};}),true)");
  const transfer = await waitRequest(first.tabId); assert.equal(transfer.type, 'sendTransaction');
  assert.equal(await evaluate(control, `internal('approvals.reject',{identity:approvalIdentity.identityOf(${JSON.stringify(transfer)})})`), true);
  await eventually(() => evaluate(page, 'transfer'), Boolean, 'rejected transfer');
  assert.deepEqual(await evaluate(page, 'transfer'), { error: 4001 }); assert.deepEqual(await queue(), []);
  await internal('permissions.revoke', { origin: aOrigin });
  await begin(page); const beforeCross = await waitRequest(first.tabId);
  await cdp('Page.navigate', { url: bOrigin + '/cross' }, page.sessionId); await ready(page, bOrigin + '/cross');
  assert.equal(await resolve(beforeCross), false);
  await begin(page); const cross = await waitRequest(first.tabId); assert.notEqual(cross.documentId, beforeCross.documentId);
  assert.equal(await resolve(cross), true);
  // Native subframe replacement keeps frame ID while changing document ID.
  await cdp('Page.navigate', { url: aOrigin + '/frames' }, page.sessionId); await ready(page, aOrigin + '/frames');
  await eventually(() => evaluate(page, "typeof document.querySelector('iframe').contentWindow.zenon"), v => v === 'object', 'child provider');
  await begin(page, "document.querySelector('iframe').contentWindow"); const child = await waitRequest(first.tabId); assert(child.frameId > 0);
  await evaluate(page, "(document.querySelector('iframe').src='/child-b',true)");
  await eventually(() => evaluate(page, "document.querySelector('iframe').contentWindow.location.pathname"), v => v === '/child-b', 'child navigation');
  assert.equal(await resolve(child), false);
  await begin(page, "document.querySelector('iframe').contentWindow"); const childFresh = await waitRequest(first.tabId);
  assert.equal(childFresh.frameId, child.frameId); assert.notEqual(childFresh.documentId, child.documentId); assert.equal(await resolve(childFresh), true);
  // The same rewrite boundary applies inside a native subframe.
  await begin(page, "document.querySelector('iframe').contentWindow"); const childRewrite = await waitRequest(first.tabId);
  await evaluate(page, "(()=>{const d=document.querySelector('iframe').contentDocument;d.open();d.write('<!doctype html><p>Inert rewritten child</p>');d.close();return true;})()");
  await eventually(() => evaluate(page, "document.querySelector('iframe').contentWindow.outcomes"), value => value.length === 1, 'child rewrite cancellation');
  assert.deepEqual(await evaluate(page, "document.querySelector('iframe').contentWindow.outcomes"), [{ error: 4900 }]);
  assert.equal(await resolve(childRewrite), false);
  await begin(page, "document.querySelector('iframe').contentWindow"); const childAfterRewrite = await waitRequest(first.tabId);
  assert.equal(childAfterRewrite.documentId, childRewrite.documentId); assert.notEqual(childAfterRewrite.activation, childRewrite.activation);
  assert.equal(await resolve(childAfterRewrite), true);
  // A real in-place rewrite keeps the native document identity but starts a
  // new relay activation, restores erased handlers, and requires fresh consent.
  for (const rewrite of [
    "document.open();document.write('<!doctype html><title>Rewritten inert page</title><p>Fresh local DOM</p>');document.close();",
    "const root=document.documentElement;document.open();document.appendChild(root);document.close();",
  ]) {
    await begin(page); const beforeRewrite = await waitRequest(first.tabId);
    await evaluate(page, `(()=>{${rewrite}return true;})()`);
    await eventually(() => evaluate(page, 'outcomes'), value => value.length === 1, 'rewritten request cancellation');
    assert.deepEqual(await evaluate(page, 'outcomes'), [{ error: 4900 }]);
    assert.equal(await resolve(beforeRewrite), false);
    await begin(page); const afterRewrite = await waitRequest(first.tabId);
    assert.equal(afterRewrite.documentId, beforeRewrite.documentId); assert.notEqual(afterRewrite.activation, beforeRewrite.activation);
    assert.equal(await resolve(afterRewrite), true);
    await eventually(() => evaluate(page, 'outcomes'), value => value.length === 1, 'rewritten provider completion');
  }
  // Reopening an already empty document must not reactivate old requests or
  // strand the provider when a new root is eventually written.
  await begin(page); const beforeEmpty = await waitRequest(first.tabId);
  await evaluate(page, "(document.open(),true)");
  await eventually(() => evaluate(page, 'outcomes'), value => value.length === 1, 'empty document cancellation');
  assert.deepEqual(await evaluate(page, 'outcomes'), [{ error: 4900 }]);
  await evaluate(page, "(document.open(),true)");
  assert.equal(await evaluate(page, "zenon.connect().then(()=>false,error=>error.code===4900)"), true);
  await evaluate(page, "(document.write('<!doctype html><title>Fresh empty-document recovery</title><p>Inert</p>'),document.close(),true)");
  assert.equal(await resolve(beforeEmpty), false);
  await begin(page); const afterEmpty = await waitRequest(first.tabId); assert.equal(await resolve(afterEmpty), true);
  // Ordinary body edits preserve the current approval.
  await begin(page); const beforeBody = await waitRequest(first.tabId);
  await evaluate(page, "(document.body.textContent='Ordinary local body update',true)");
  assert.equal(await current(beforeBody), true); assert.equal(await resolve(beforeBody), true);
  // Chrome's navigation fence also works when a rewritten local page owns its
  // lifecycle listeners. No approval should survive the real history round trip.
  await evaluate(page, "(()=>{document.open();document.write('<!doctype html><p>Inert lifecycle recovery</p>');document.close();window.nativeShows=[];addEventListener('pageshow',e=>nativeShows.push(e.persisted),true);for(const type of ['pagehide','pageshow'])addEventListener(type,e=>e.stopImmediatePropagation(),true);return true;})()");
  await begin(page); const nativeOld = await waitRequest(first.tabId);
  const nativeUrl = await evaluate(page, 'location.href');
  await cdp('Page.navigate', { url: aOrigin + '/native-fence-away' }, page.sessionId); await ready(page, aOrigin + '/native-fence-away');
  await evaluate(page, 'history.back()'); await ready(page, nativeUrl);
  assert.equal(await evaluate(page, 'nativeShows.at(-1)'), true);
  assert.equal(await resolve(nativeOld), false);
  assert.deepEqual(await internal('permissions.list'), []);
  await begin(page); const nativeFresh = await waitRequest(first.tabId);
  assert.equal(nativeFresh.documentId, nativeOld.documentId);
  assert.notEqual(nativeFresh.navigationTab, nativeOld.navigationTab);
  assert.equal(await resolve(nativeFresh), true);
  // Two ordinary legacy tabs remain independently queued and resolvable.
  // Another origin: one origin has one pending connect at a time (#10).
  const second = await open(bOrigin + '/legacy'); await ready(second, bOrigin + '/legacy');
  for (const current of [page, second]) await evaluate(current, "(window.legacy=[],addEventListener('message',e=>{if(e.data?.method==='znn.grantedWalletRead')legacy.push(e.data.data);}),postMessage({method:'znn.requestWalletAccess'},location.origin),true)");
  const legacy = await eventually(queue, value => value.length === 2, 'two legacy approvals');
  assert.notEqual(legacy[0].id, legacy[1].id);
  for (const request of legacy) assert.equal(await resolve(request), true);
  for (const current of [page, second]) await eventually(() => evaluate(current, 'legacy'), value => value.length === 1, 'legacy completion');
  // Hold only provisional permission persistence in the fixture's browser API
  // adapter. Real page navigation/cancellation must prevent its activation.
  await begin(second); const canceledGrant = await waitRequest();
  await evaluate(control, "fixture('hold')");
  await evaluate(control, `(window.grantOutcome=null,approve(${JSON.stringify(canceledGrant)},${JSON.stringify(binding)}).then(value=>{grantOutcome={value};},error=>{grantOutcome={error:String(error)};}),true)`);
  await eventually(() => evaluate(control, "fixture('entered')"), Boolean, 'provisional grant write held');
  await cdp('Page.navigate', { url: bOrigin + '/grant-replacement' }, second.sessionId); await ready(second, bOrigin + '/grant-replacement');
  await eventually(() => evaluate(control, "records('znn.pendingRequests')"), value => !Object.values(value || {}).some(r => r.requestToken === canceledGrant.requestToken), 'native departure cancels held grant');
  await evaluate(control, "fixture('release')");
  await eventually(() => evaluate(control, 'grantOutcome'), Boolean, 'canceled grant completes');
  assert.deepEqual(await evaluate(control, 'grantOutcome'), { value: false });
  assert.deepEqual(await internal('permissions.list'), []);
  await begin(second); const approvedGrant = await waitRequest();
  assert.equal(await resolve(approvedGrant, { keep: true }), true);
  await eventually(() => evaluate(second, 'outcomes'), value => value.length === 1, 'native accepted connection');
  assert.equal((await internal('permissions.list')).length, 1);
  await cdp('Page.navigate', { url: bOrigin + '/after-accepted-grant' }, second.sessionId); await ready(second, bOrigin + '/after-accepted-grant');
  assert.equal((await internal('permissions.list')).length, 1, 'completed consent survives later navigation');
  // A page Chrome prerenders runs its scripts before it is shown, when the
  // worker answers no document. Its load-time read and its hello wait for
  // activation, so once opened it reads the connected account and gets events.
  // Chrome does not prerender under DevTools: the tab stays unattached until
  // it has moved to the prerendered page.
  const launch = await cdp('Target.createTarget', { url: bOrigin + '/launch' });
  await eventually(async () => (await cdp('Target.getTargets')).targetInfos.find(t => t.targetId === launch.targetId)?.url,
    url => url === bOrigin + '/prerendered', 'prerendered page opened');
  const prerendered = { ...launch, ...await cdp('Target.attachToTarget', { targetId: launch.targetId, flatten: true }) };
  assert(await evaluate(prerendered, 'performance.getEntriesByType("navigation")[0].activationStart') > 0, 'This browser must exercise prerendering');
  await eventually(() => evaluate(prerendered, 'prerenderLog'), log => log?.length === 2, 'prerendered read');
  assert.deepEqual(await evaluate(prerendered, 'prerenderLog'), [{ prerendering: true }, { accounts: ['inert-approved-account'] }]);
  // Its hello after activation is asynchronous: announce until it arrives.
  const prerenderEvents = await eventually(async () => {
    await internal('events.accountsChanged', { selectionId: binding.id });
    return (await evaluate(prerendered, 'prerenderLog')).slice(2);
  }, events => events.length > 0, 'prerendered page event');
  assert.deepEqual([...new Set(prerenderEvents.map(JSON.stringify))], [JSON.stringify({ event: ['inert-approved-account'] })]);
  await cdp('Target.closeTarget', { targetId: launch.targetId });
  await internal('permissions.revokeAll');
  await begin(second); const closing = await waitRequest();
  await cdp('Target.closeTarget', { targetId: second.targetId });
  await eventually(() => evaluate(control, "records('znn.pendingRequests')"), value => !Object.values(value || {}).some(r => r.tabId === closing.tabId), 'tab close cleanup');
  const result = { browser: version.Browser, actualModules: [...new Set([...files, ...closure('src/sections/Content/index.js'), ...closure('src/sections/Inpage/index.js')])], nonSecureHttp: true, lifecycleCaptureOrdering: true, nativeNavigationFence: true, documentRewriteRecovery: true, subframeRewriteRecovery: true, emptyRewriteRecovery: true, ordinaryBodyEdits: true, sameOriginNavigation: true,
    crossOriginNavigation: true, nativeSubframeNavigation: true, bfcacheRestored: restored, oldApprovalsCancelled: true, freshRequestsAndEvents: true, multiKeyParamsIdentity: true, independentLegacyTabs: true, provisionalGrantCancellation: true, completedConsentSurvivesNavigation: true, abortedNavigationKeepsEvents: true, prerenderedPageReadsAndEvents: true, tabCloseCleanup: true };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, artifact: path.join(dir, 'result.json') }));
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; }).finally(async () => {
  clearTimeout(watchdog);
  if (cdp && socket?.readyState === WebSocket.OPEN) await cdp('Browser.close').catch(() => {});
  socket?.close(); browser?.kill(); server?.close();
});
