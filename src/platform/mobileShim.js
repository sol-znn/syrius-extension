// The `chrome.*` the wallet needs, for the Android and iOS app.
//
// The app is the popup and the background script loaded into one WebView page
// (Capacitor), with no browser extension around them. This file runs first and
// provides the part of the extension API they use, with the same shapes and
// the same storage semantics:
//
//   storage.local    survives restarts, in the WebView's localStorage
//   storage.session  memory only, gone when the app is killed, as the
//                    extension's is when the browser closes: an unlocked
//                    session must never reach disk
//   runtime          messages from the popup reach the background script's
//                    listener as an extension page's would (sender.url is this
//                    page), never the sender's own
//   alarms           timers, while the app runs
//
// Tabs, windows and webNavigation serve site connections. No web page can
// reach the app; the only "sites" are other apps' syrius://request links, each
// a document of its own (./appRequests.js), and the approval window is a route
// of this page.

/* eslint-disable no-undef */

import { fail } from '../services/utils/errors';
import installAppLinks from './appLinks';
import installNativeFeatures from './nativeFeatures';

const manifest = process.env.SYRIUS_MANIFEST;
// The directory this page is served from: https://localhost/ in the app, and
// the build folder when the page is opened from disk to check it.
const origin = new URL('./', window.location.href).href;
const platformId = `syrius-${process.env.SYRIUS_PLATFORM}`;

const event = () => {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    hasListener: (listener) => listeners.has(listener),
    hasListeners: () => listeners.size > 0,
    dispatch: (...args) => [...listeners].map((listener) => {
      try { return listener(...args); } catch (error) { console.error(error); return undefined; }
    }),
  };
};

// chrome.storage stores JSON: undefined members vanish, Dates become strings.
const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// The callback form and the promise form, as the extension API offers both.
const api = (fn) => (...args) => {
  const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
  const promise = Promise.resolve().then(() => fn(...args));
  if (!callback) return promise;
  promise.then((value) => callback(value), (error) => {
    runtime.lastError = { message: error?.message || String(error) };
    try { callback(undefined); } finally { runtime.lastError = undefined; }
  });
  return undefined;
};

const storageChanged = event();

const area = (name, backend) => {
  const onChanged = event();
  const keysOf = (keys) => (keys == null ? backend.keys()
    : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys));
  const announce = (changes) => {
    if (!Object.keys(changes).length) return;
    onChanged.dispatch(changes);
    storageChanged.dispatch(changes, name);
  };
  return {
    onChanged,
    get: api((keys) => {
      const result = keys && typeof keys === 'object' && !Array.isArray(keys) ? copy(keys) : {};
      for (const key of keysOf(keys)) {
        const value = backend.read(key);
        if (value !== undefined) result[key] = copy(value);
      }
      return result;
    }),
    set: api((items) => {
      const changes = {};
      for (const [key, value] of Object.entries(copy(items) || {})) {
        const oldValue = backend.read(key);
        backend.write(key, value);
        changes[key] = { oldValue: copy(oldValue), newValue: copy(value) };
      }
      announce(changes);
    }),
    remove: api((keys) => {
      const changes = {};
      for (const key of keysOf(keys)) {
        const oldValue = backend.read(key);
        if (oldValue === undefined) continue;
        backend.delete(key);
        changes[key] = { oldValue: copy(oldValue) };
      }
      announce(changes);
    }),
    clear: api(() => {
      const changes = {};
      for (const key of backend.keys()) changes[key] = { oldValue: copy(backend.read(key)) };
      for (const key of backend.keys()) backend.delete(key);
      announce(changes);
    }),
    setAccessLevel: api(() => {}),
  };
};

const memory = () => {
  const map = new Map();
  return {
    keys: () => [...map.keys()],
    read: (key) => map.get(key),
    write: (key, value) => map.set(key, value),
    delete: (key) => map.delete(key),
  };
};

const prefix = 'chrome.storage.local:';
const persistent = {
  keys: () => Object.keys(localStorage).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
  read: (key) => {
    const raw = localStorage.getItem(prefix + key);
    return raw === null ? undefined : JSON.parse(raw);
  },
  write: (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value)),
  delete: (key) => localStorage.removeItem(prefix + key),
};

const onMessage = event();

const runtime = {
  id: platformId,
  lastError: undefined,
  getURL: (path = '') => origin + String(path).replace(/^\//, ''),
  getManifest: () => manifest,
  onMessage,
  onInstalled: event(),
  onStartup: event(),
  onUpdateAvailable: event(),
  reload: () => window.location.reload(),
  // An app is updated by installing the next APK (services/utils/selfUpdate.js).
  requestUpdateCheck: () => { throw fail(130); },
  sendMessage: api((message) => post(message, { id: platformId, url: window.location.href, origin: window.location.origin })),
};

// A runtime message from `sender`: the wallet's own page, or an app request's
// document (./appRequests.js), which the background must see as a site's.
function post(message, sender) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const sendResponse = (response) => {
      if (answered) return;
      answered = true;
      resolve(copy(response));
    };
    const kept = onMessage.dispatch(copy(message), copy(sender), sendResponse);
    // A listener that returned true answers later; one that did neither, never.
    if (!answered && !kept.includes(true)) {
      reject(fail(131));
    }
  });
}

const alarmTimers = new Map();
const onAlarm = event();
const alarms = {
  onAlarm,
  create: api((name, info = {}) => {
    clearInterval(alarmTimers.get(name));
    clearTimeout(alarmTimers.get(name));
    const period = info.periodInMinutes ? info.periodInMinutes * 60000 : null;
    const delay = info.when ? Math.max(0, info.when - Date.now())
      : info.delayInMinutes ? info.delayInMinutes * 60000 : period || 0;
    const fire = () => onAlarm.dispatch({ name, scheduledTime: Date.now(), periodInMinutes: info.periodInMinutes });
    alarmTimers.set(name, setTimeout(() => {
      fire();
      if (period) alarmTimers.set(name, setInterval(fire, period));
      else alarmTimers.delete(name);
    }, delay));
  }),
  clear: api((name) => {
    clearTimeout(alarmTimers.get(name));
    clearInterval(alarmTimers.get(name));
    return alarmTimers.delete(name);
  }),
  get: api((name) => (alarmTimers.has(name) ? { name } : undefined)),
  getAll: api(() => [...alarmTimers.keys()].map((name) => ({ name }))),
};

// The app's own window is 1. Each approval opening gets a fresh identity, as
// real browser windows do, so late calls cannot target a reopened screen.
// Closing comes back to the previous route and tells the background.
const appWindow = { id: 1, type: 'normal', focused: true, state: 'fullscreen' };
let approvalWindow = { id: 2, type: 'popup', focused: true, state: 'fullscreen' };
let nextApprovalWindowId = 2;
let approvalReturn = null;
const windowsRemoved = event();
const approvalOpen = () => approvalReturn !== null;
// The background attaches the request to the window only after creating it
// (Background/requests.js present), and then checks once more that the
// request is unchanged (Background/index.js handleProviderRequest). A browser
// window takes long enough to load that both are done before it asks for the
// request. A route renders at once: it found nothing and closed, or it bound
// the request before that last check, which then saw a changed request and
// ended it. So the route opens a moment after a pending request names this
// window (requests.pendingKey), which is a window's loading time, or after a
// few seconds regardless.
const pendingKey = 'znn.pendingRequests';
const windowLoadMs = 400;
const openApproval = ({ url }) => {
  if (!approvalOpen()) {
    approvalWindow = { ...approvalWindow, id: nextApprovalWindowId++ };
    approvalReturn = window.location.hash || '#/tabs/dashboard';
  }
  const windowId = approvalWindow.id;
  const route = new URL(url).hash;
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    storageChanged.removeListener(watch);
    clearTimeout(fallback);
    if (approvalOpen() && approvalWindow.id === windowId) window.location.hash = route;
  };
  const watch = (changes, area) => {
    const pending = area === 'session' ? changes[pendingKey]?.newValue : null;
    if (pending && Object.values(pending).some((request) => request?.windowId === windowId)) {
      storageChanged.removeListener(watch);
      setTimeout(show, windowLoadMs);
    }
  };
  storageChanged.addListener(watch);
  const fallback = setTimeout(show, 3000);
  return approvalWindow;
};
const closeApproval = () => {
  if (!approvalOpen()) return;
  const back = approvalReturn;
  approvalReturn = null;
  window.location.hash = back.startsWith('#/site-integration') ? '#/tabs/dashboard' : back;
  windowsRemoved.dispatch(approvalWindow.id);
};
// The approval screen closes itself with window.close(), which a WebView ignores.
window.close = closeApproval;
const windowById = (id) => {
  if (id === appWindow.id) return appWindow;
  if (id === approvalWindow.id && approvalOpen()) return approvalWindow;
  throw fail(130);
};
const currentWindow = () => (approvalOpen() && window.location.hash.startsWith('#/site-integration')
  ? approvalWindow : appWindow);

// The wallet's own pages are routes of this page; anything else is the
// system browser's (Capacitor hands a navigation away from the app's origin to
// it).
const openUrl = (url) => {
  if (String(url).startsWith(origin)) {
    window.location.hash = new URL(url).hash;
    return { id: 1, windowId: 1, url };
  }
  window.open(url, '_blank');
  return { id: 3, windowId: 1, url };
};

// The documents of app requests, by tab ID: what the background reaches with
// tabs.sendMessage and webNavigation.getFrame.
const documents = new Map();
const tabsRemoved = event();
const sendToDocument = (tabId, message, options = {}) => {
  const target = documents.get(tabId);
  if (!target || (options.frameId ?? 0) !== 0 || (options.documentId && options.documentId !== target.documentId)) {
    throw fail(131);
  }
  return target.receive(copy(message));
};
const frameOf = ({ tabId, frameId }) => {
  const target = documents.get(tabId);
  return target && frameId === 0 ? { frameId: 0, parentFrameId: -1, documentId: target.documentId,
    documentLifecycle: 'active', frameType: 'outermost_frame', url: '' } : null;
};
const appRequestHost = {
  post,
  open: (target) => documents.set(target.tabId, target),
  close: (tabId) => {
    if (documents.delete(tabId)) tabsRemoved.dispatch(tabId, { windowId: appWindow.id, isWindowClosing: false });
  },
};

window.chrome = {
  runtime,
  storage: {
    local: area('local', persistent),
    session: area('session', memory()),
    onChanged: storageChanged,
  },
  alarms,
  tabs: {
    create: api(({ url }) => openUrl(url)),
    query: api(() => []),
    sendMessage: api(sendToDocument),
    onRemoved: tabsRemoved,
  },
  windows: {
    get: api(windowById),
    getCurrent: api(currentWindow),
    getLastFocused: api(() => appWindow),
    create: api(openApproval),
    remove: api((id) => { if (id === approvalWindow.id) closeApproval(); }),
    onRemoved: windowsRemoved,
  },
  webNavigation: {
    getFrame: api(frameOf),
    onBeforeNavigate: event(),
  },
  management: {
    getSelf: api(() => ({ id: platformId, installType: 'normal', version: manifest.version })),
  },
  permissions: {
    request: api(() => true),
    remove: api(() => true),
    contains: api(() => true),
  },
};

// Before the popup's bundle runs, so its first screen can ask for a fingerprint.
installNativeFeatures();

// The background script has registered its listeners by the time the page
// has loaded: start it as a browser start would.
window.addEventListener('DOMContentLoaded', () => {
  runtime.onStartup.dispatch();
  installAppLinks(appRequestHost);
}, { once: true });
