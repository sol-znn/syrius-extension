'use strict';

// Loads an untouched production extension in an owned, disposable browser.
// Never include evaluated expressions, protocol payloads, browser console
// messages, profile contents or exception descriptions in diagnostics.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = code => Object.assign(new Error('Production browser stage failed.'), { code });
const external = url => /^(?:https?|wss?):/i.test(url || '');

const findBrowser = () => {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  const executable = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (!executable) throw failure('BROWSER_EXECUTABLE_UNAVAILABLE');
  return executable;
};

const startBrowser = async ({ extensionDir, profileDir, setupScript = '', expectedExtensionId }) => {
  if (!path.isAbsolute(extensionDir || '') || !path.isAbsolute(profileDir || '') ||
      !fs.existsSync(path.join(extensionDir, 'manifest.json')) || typeof setupScript !== 'string' ||
      (expectedExtensionId !== undefined && !/^[a-p]{32}$/.test(expectedExtensionId))) {
    throw failure('BROWSER_CONFIGURATION_INVALID');
  }
  const executable = findBrowser();
  const stats = {
    guardedTargets: 0,
    guardedWorkers: 0,
    silentWorkers: 0,
    deniedProxyConnections: 0,
    attemptedRequests: 0,
    blockedRequests: 0,
    externalResponses: 0,
    externalWebSocketHandshakes: 0,
    wasmModules: 0,
    runtimeErrors: 0,
    cspErrors: 0,
    developerModeEnabled: false,
    persistentInstallReused: false,
    guardFailure: null,
    guardChecks: { http: false, webSocket: false },
  };
  let browser, socket, proxy, stopPromise, stopped = false, stopping = false, fatalError;
  let sequence = 0;
  const pending = new Map();
  const targets = new Map();
  const sessions = new Map();
  const productPages = new Set();
  const wasmScripts = new Set();
  const proxySockets = new Set();

  const assertUsable = () => {
    if (fatalError) throw fatalError;
    if (stopped || stopping || !socket || socket.readyState !== WebSocket.OPEN) {
      throw failure('BROWSER_NOT_AVAILABLE');
    }
  };

  const cdp = (method, params = {}, sessionId, timeoutMs = 15000) => new Promise((resolve, reject) => {
    try { assertUsable(); } catch (error) { reject(error); return; }
    const next = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(next);
      // The method only, never its parameters: a timeout says which command.
      reject(Object.assign(failure('BROWSER_PROTOCOL_TIMEOUT'), { method }));
    }, timeoutMs);
    pending.set(next, {
      sessionId,
      resolve: result => { clearTimeout(timer); fatalError ? reject(fatalError) : resolve(result); },
      reject: () => { clearTimeout(timer); reject(failure('BROWSER_PROTOCOL_FAILED')); },
    });
    try {
      socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
    } catch {
      pending.get(next).reject(); pending.delete(next);
    }
  });

  const evaluateWithLimit = async (page, expression, timeoutMs) => {
    if (!page || typeof expression !== 'string') throw failure('BROWSER_EVALUATION_INVALID');
    const result = await cdp('Runtime.evaluate', {
      expression: '(async () => (' + expression + '))()',
      awaitPromise: true,
      returnByValue: true,
    }, page.sessionId, timeoutMs);
    if (result.exceptionDetails || result.result?.subtype === 'error') {
      throw failure('BROWSER_EVALUATION_FAILED');
    }
    return result.result?.value;
  };
  const evaluate = (page, expression) => evaluateWithLimit(page, expression, 45000);

  const until = async (page, expression, _label, timeoutMs = 45000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluateWithLimit(page, expression, Math.max(1, Math.min(15000, deadline - Date.now())))) return;
      } catch (error) {
        // Navigating/reloading can destroy the current execution context.
        // Retry within the same deadline without reporting its exception.
        if (fatalError || stopped || stopping || !['BROWSER_PROTOCOL_FAILED', 'BROWSER_EVALUATION_FAILED'].includes(error.code)) throw error;
      }
      await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
    }
    throw failure('BROWSER_CONDITION_TIMEOUT');
  };

  const guardTarget = async ({ sessionId, targetInfo }) => {
    const target = { targetId: targetInfo.targetId, sessionId, type: targetInfo.type, contextGeneration: 0,
      extensionHost: /^chrome-extension:\/\/([a-p]{32})\//.exec(targetInfo.url || '')?.[1] };
    targets.set(target.targetId, target);
    sessions.set(sessionId, target);
    let phase;
    const guarded = (method, ...args) => { phase = method; return cdp(method, ...args); };
    const ready = (async () => {
      await guarded('Network.enable', {}, sessionId);
      await guarded('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] }, sessionId);
      // Dedicated workers reject this page/network-state override. Their own
      // URL block list and the browser-wide denying proxy remain mandatory;
      // never resume them until the applicable guards have all succeeded.
      if (target.type !== 'worker') {
        await guarded('Network.emulateNetworkConditions', {
          offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
        }, sessionId);
      }
      await guarded('Runtime.enable', {}, sessionId);
      if (target.type === 'page') {
        await guarded('Page.enable', {}, sessionId);
        await guarded('Debugger.enable', {}, sessionId);
        await guarded('Log.enable', {}, sessionId);
        if (setupScript) await guarded('Page.addScriptToEvaluateOnNewDocument', { source: setupScript }, sessionId);
      }
      await guarded('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
      stats.guardedTargets++;
      if (target.type === 'worker') stats.guardedWorkers++;
      await guarded('Runtime.runIfWaitingForDebugger', {}, sessionId);
      return target;
    })();
    target.ready = ready;
    ready.catch(error => {
      if (!stopping && !stopped && sessions.has(sessionId)) {
        // A service worker that times out having never sent this session a
        // single message has no process: Chrome keeps listing the worker of
        // the registration developerPrivate.reload replaced, attaches it again
        // under each page, and never answers. It was never resumed, so it runs
        // nothing. It is set aside, and any later message from it fails the
        // run (heardFrom). Failing on it made this check flaky in CI.
        if (error.code === 'BROWSER_PROTOCOL_TIMEOUT' && target.type === 'service_worker' && !target.heard) {
          target.silent = true;
          stats.silentWorkers++;
          return;
        }
        // Method/type/code only: never retain target URLs, IDs or payloads.
        stats.guardFailure ||= { targetType: target.type, phase, code: error.code || 'UNKNOWN' };
        fatalError = failure('BROWSER_NETWORK_GUARD_FAILED');
      }
    });
  };

  // Every message carrying a session marks its target as heard from. One from
  // a target set aside as silent means it was alive after all.
  const heardFrom = sessionId => {
    const target = sessions.get(sessionId);
    if (!target) return;
    target.heard = true;
    if (target.silent && !stopping && !stopped) {
      stats.guardFailure ||= { targetType: target.type, phase: 'silent target spoke', code: 'BROWSER_PROTOCOL_TIMEOUT' };
      fatalError = failure('BROWSER_NETWORK_GUARD_FAILED');
    }
  };

  const openTarget = async () => {
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
    const deadline = Date.now() + 15000;
    while (!targets.has(targetId) && Date.now() < deadline) { assertUsable(); await sleep(20); }
    const target = targets.get(targetId);
    if (!target) throw failure('BROWSER_TARGET_UNAVAILABLE');
    return target.ready;
  };

  let extensionId;
  const openPage = async (route = 'popup.html') => {
    if (typeof route !== 'string' || /^[a-z][a-z\d+.-]*:/i.test(route) || route.startsWith('//')) {
      throw failure('BROWSER_ROUTE_INVALID');
    }
    const page = await openTarget();
    const isPopup = /^\/?popup\.html(?:[?#].*)?$/.test(route);
    // Production uses HashRouter. Keep popup.html as the actual document.
    const relative = isPopup ? route.replace(/^\//, '') : 'popup.html' +
      (route && route !== '/' ? '#' + (route.startsWith('/') ? route : '/' + route) : '');
    const url = 'chrome-extension://' + extensionId + '/' + relative;
    const navigation = await cdp('Page.navigate', { url }, page.sessionId);
    if (navigation.errorText) throw failure('BROWSER_NAVIGATION_FAILED');
    const documentUrl = url.split('#')[0];
    await until(page, 'location.href.split("#")[0] === ' + JSON.stringify(documentUrl) +
      ' && document.readyState === "complete"', 'page ready', 30000);
    productPages.add(page.targetId);
    return page;
  };

  const closePage = page => {
    productPages.delete(page.targetId);
    return cdp('Target.closeTarget', { targetId: page.targetId });
  };

  const stop = () => stopPromise || (stopPromise = (async () => {
    if (stopped) return;
    // Request a normal shutdown first so this owned profile can be restarted.
    if (socket?.readyState === WebSocket.OPEN && !fatalError) {
      await cdp('Browser.close', {}, undefined, 3000).catch(() => {});
    }
    stopping = true;
    let shutdownFailed = false;
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      for (let i = 0; i < 30 && browser.exitCode === null && browser.signalCode === null; i++) await sleep(100);
      if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGTERM');
      for (let i = 0; i < 30 && browser.exitCode === null && browser.signalCode === null; i++) await sleep(100);
      if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGKILL');
      for (let i = 0; i < 50 && browser.exitCode === null && browser.signalCode === null; i++) await sleep(100);
      shutdownFailed = browser.exitCode === null && browser.signalCode === null;
    }
    stats.shutdownClean = browser?.exitCode === 0 && !browser?.signalCode;
    socket?.close();
    for (const callback of pending.values()) callback.reject();
    pending.clear();
    for (const connection of proxySockets) connection.destroy();
    if (proxy?.listening) await new Promise(resolve => proxy.close(resolve));
    stopped = true;
    if (stats.externalResponses !== 0 || stats.externalWebSocketHandshakes !== 0) throw failure('BROWSER_EXTERNAL_ACTIVITY');
    if (shutdownFailed) throw failure('BROWSER_SHUTDOWN_TIMEOUT');
  })());

  try {
    // The proxy never parses or stores bytes, URLs or bodies. Even when a
    // target is being created/restarted, there is no forwarding destination.
    proxy = net.createServer(connection => {
      stats.deniedProxyConnections++;
      proxySockets.add(connection);
      connection.on('error', () => {});
      connection.on('close', () => proxySockets.delete(connection));
      connection.destroy();
    });
    await new Promise((resolve, reject) => {
      proxy.once('error', () => reject(failure('BROWSER_PROXY_UNAVAILABLE')));
      proxy.listen(0, '127.0.0.1', resolve);
    });
    const proxyPort = proxy.address().port;
    fs.mkdirSync(profileDir, { recursive: true });
    fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true });
    browser = spawn(executable, [
      // Owned test profiles must not open the user's macOS login keychain.
      // This affects browser storage only, not the wallet's Argon2/AES code.
      ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
      '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--user-data-dir=' + profileDir, '--enable-unsafe-extension-debugging',
      '--proxy-server=http://127.0.0.1:' + proxyPort, '--proxy-bypass-list=<-loopback>',
      '--disable-quic', '--disable-background-networking', '--disable-component-update',
      '--disable-sync', '--no-first-run', '--no-default-browser-check', 'about:blank',
    ], { stdio: 'ignore' });
    let launchFailed = false;
    browser.on('error', () => { launchFailed = true; });
    const deadline = Date.now() + 15000;
    let port;
    while (Date.now() < deadline) {
      if (launchFailed || browser.exitCode !== null || browser.signalCode !== null) throw failure('BROWSER_LAUNCH_FAILED');
      const activePort = path.join(profileDir, 'DevToolsActivePort');
      if (fs.existsSync(activePort)) {
        port = Number(fs.readFileSync(activePort, 'utf8').split('\n')[0]);
        if (Number.isInteger(port) && port > 0) break;
      }
      await sleep(50);
    }
    if (!port) throw failure('BROWSER_LAUNCH_TIMEOUT');
    const version = await fetch('http://127.0.0.1:' + port + '/json/version', {
      signal: AbortSignal.timeout(5000),
    }).then(response => response.json()).catch(() => { throw failure('BROWSER_ENDPOINT_UNAVAILABLE'); });
    if (!version.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:')) throw failure('BROWSER_ENDPOINT_INVALID');
    socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(failure('BROWSER_CONNECTION_TIMEOUT')), 5000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(failure('BROWSER_CONNECTION_FAILED')); };
    });
    socket.onclose = () => {
      for (const callback of pending.values()) callback.reject();
      pending.clear();
    };
    socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { fatalError = failure('BROWSER_PROTOCOL_INVALID'); return; }
      if (message.sessionId) heardFrom(message.sessionId);
      const callback = pending.get(message.id);
      if (callback) {
        pending.delete(message.id);
        message.error ? callback.reject() : callback.resolve(message.result);
        return;
      }
      if (message.method === 'Target.attachedToTarget') {
        guardTarget(message.params).catch(() => { fatalError = failure('BROWSER_NETWORK_GUARD_FAILED'); });
      } else if (message.method === 'Target.detachedFromTarget') {
        const target = sessions.get(message.params.sessionId);
        if (target && target.sessionId === targets.get(target.targetId)?.sessionId) targets.delete(target.targetId);
        sessions.delete(message.params.sessionId);
        // A detached session never answers. Its commands fail now, as a lost
        // target (BROWSER_PROTOCOL_FAILED), instead of each waiting out its
        // timeout: the page chrome.runtime.reload() closes may detach without
        // replying, which reloadExtension expects.
        for (const [id, call] of pending) {
          if (call.sessionId !== message.params.sessionId) continue;
          pending.delete(id);
          call.reject();
        }
      } else if (message.method === 'Runtime.executionContextsCleared') {
        const target = sessions.get(message.sessionId);
        if (target) target.contextGeneration++;
      } else if (message.method === 'Network.requestWillBeSent' && external(message.params.request.url)) {
        stats.attemptedRequests++;
      } else if (message.method === 'Network.webSocketCreated' && external(message.params.url)) {
        stats.attemptedRequests++;
      } else if (message.method === 'Network.loadingFailed' && message.params.blockedReason) {
        stats.blockedRequests++;
      } else if (message.method === 'Network.responseReceived' && external(message.params.response.url)) {
        stats.externalResponses++;
        fatalError = failure('BROWSER_EXTERNAL_RESPONSE');
      } else if (message.method === 'Network.webSocketHandshakeResponseReceived') {
        stats.externalWebSocketHandshakes++;
        fatalError = failure('BROWSER_EXTERNAL_WEBSOCKET_RESPONSE');
      } else if (message.method === 'Debugger.scriptParsed' && message.params.scriptLanguage === 'WebAssembly') {
        const identity = message.sessionId + ':' + message.params.scriptId;
        if (!wasmScripts.has(identity)) { wasmScripts.add(identity); stats.wasmModules++; }
      } else if (message.method === 'Runtime.exceptionThrown') {
        stats.runtimeErrors++;
      } else if (message.method === 'Log.entryAdded' && message.params.entry.source === 'security' &&
                 /content security policy|content-security-policy/i.test(message.params.entry.text || '')) {
        stats.cspErrors++;
      }
    };
    await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    // Both checks use only our local denying listener. No public endpoint is
    // contacted, and a successful response fails closed before product load.
    const guard = await openTarget();
    const check = await evaluate(guard, `Promise.all([
      fetch('http://127.0.0.1:${proxyPort}/guard', {signal:AbortSignal.timeout(2000)}).then(() => false, () => true),
      new Promise(resolve => {
        let done = false;
        const ws = new WebSocket('ws://127.0.0.1:${proxyPort}/guard');
        const finish = value => {if(done)return;done=true;clearTimeout(timer);ws.close();resolve(value);};
        const timer = setTimeout(() => finish(false), 2000);
        ws.onopen = () => finish(false); ws.onerror = () => finish(true);
      })
    ])`);
    stats.guardChecks.http = check?.[0] === true;
    stats.guardChecks.webSocket = check?.[1] === true;
    if (!stats.guardChecks.http || !stats.guardChecks.webSocket) throw failure('BROWSER_NETWORK_GUARD_FAILED');
    await closePage(guard);
    // CDP can initially load an unpacked extension with developer mode off,
    // but a real runtime.reload is then disabled by Chrome's developer-mode
    // policy. Use Chrome's normal profile configuration API in this owned
    // profile; do not bypass that policy or change the production manifest.
    const settings = await openTarget();
    await cdp('Page.navigate', { url: 'chrome://extensions/' }, settings.sessionId);
    await until(settings, 'Boolean(chrome.developerPrivate)', 'owned developer profile', 10000);
    const configured = await evaluate(settings, 'new Promise(resolve => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}, () => resolve(!chrome.runtime.lastError)))');
    stats.developerModeEnabled = configured === true && await evaluate(settings,
      'new Promise(resolve => chrome.developerPrivate.getProfileConfiguration(info => resolve(info.inDeveloperMode)))') === true;
    if (!stats.developerModeEnabled) throw failure('BROWSER_DEVELOPER_PROFILE_UNAVAILABLE');
    const matchingInstalls = async () => {
      const listed = await cdp('Extensions.getExtensions');
      return (listed.extensions || []).filter(extension => typeof extension.path === 'string' &&
        path.resolve(extension.path) === path.resolve(extensionDir));
    };
    let installed = await matchingInstalls();
    if (installed.length > 1) throw failure('BROWSER_EXTENSION_AMBIGUOUS');
    if (expectedExtensionId !== undefined && (installed.length !== 1 || installed[0].id !== expectedExtensionId)) {
      throw failure('BROWSER_PERSISTENT_INSTALL_MISSING');
    }
    if (installed.length === 1) {
      if (installed[0].enabled !== true) throw failure('BROWSER_EXTENSION_DISABLED');
      extensionId = installed[0].id;
      stats.persistentInstallReused = true;
    } else {
      extensionId = (await cdp('Extensions.loadUnpacked', { path: extensionDir })).id;
      if (!/^[a-p]{32}$/.test(extensionId || '')) throw failure('BROWSER_EXTENSION_UNAVAILABLE');
      // Chrome discards CDP-installed registrations at its next startup. Use
      // its ordinary developer reload before creating any test wallet data,
      // then require the same enabled install to survive subsequent starts.
      const reloaded = await evaluate(settings, 'new Promise(resolve => chrome.developerPrivate.reload(' +
        JSON.stringify(extensionId) + ', {failQuietly:true,populateErrorForUnpacked:true}, result => resolve(!chrome.runtime.lastError && !result)))');
      installed = await matchingInstalls();
      if (!reloaded || installed.length !== 1 || installed[0].id !== extensionId || installed[0].enabled !== true) {
        throw failure('BROWSER_PERSISTENT_INSTALL_FAILED');
      }
    }
    await closePage(settings);
    if (!/^[a-p]{32}$/.test(extensionId || '')) throw failure('BROWSER_EXTENSION_UNAVAILABLE');
    return {
      id: extensionId, openPage, evaluate, cdp, until, closePage, stop, stats,
      browserVersion: version.Browser,
      reloadExtension: async () => {
        const pages = [...productPages].map(id => targets.get(id)).filter(Boolean);
        if (!pages.length) throw failure('BROWSER_RELOAD_PAGE_UNAVAILABLE');
        const old = [...pages, ...sessions.values()].filter(target =>
          // A worker never heard from has no context to lose (guardTarget).
          pages.includes(target) || (target.extensionHost === extensionId && target.heard)).map(target => ({
          sessionId: target.sessionId, generation: target.contextGeneration,
        }));
        // Calling the actual API unloads the extension generation. Loss of the
        // command's context/transport is expected, but invalidation must follow.
        await cdp('Runtime.evaluate', { expression: 'chrome.runtime.reload()', returnByValue: true }, pages[0].sessionId)
          .catch(error => { if (fatalError) throw fatalError; if (error.code !== 'BROWSER_PROTOCOL_FAILED') throw error; });
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          assertUsable();
          if (old.every(previous => !sessions.has(previous.sessionId) ||
              sessions.get(previous.sessionId).contextGeneration > previous.generation)) break;
          await sleep(50);
        }
        if (old.some(previous => sessions.has(previous.sessionId) &&
            sessions.get(previous.sessionId).contextGeneration <= previous.generation)) {
          throw failure('BROWSER_RELOAD_INVALIDATION_TIMEOUT');
        }
        productPages.clear();
        // Wait for the real reload to finish. A new CDP registration would
        // make this install ephemeral again and hide a failed native reload.
        const reloadBy = Date.now() + 15000;
        let available = false;
        while (!available && Date.now() < reloadBy) {
          const installed = await matchingInstalls();
          available = installed.length === 1 && installed[0].id === extensionId && installed[0].enabled === true;
          if (!available) await sleep(50);
        }
        if (!available) throw failure('BROWSER_RELOAD_UNAVAILABLE');
        return extensionId;
      },
    };
  } catch (error) {
    await stop();
    throw error?.code?.startsWith('BROWSER_') ? error : failure('BROWSER_START_FAILED');
  }
};

module.exports = { startBrowser };
