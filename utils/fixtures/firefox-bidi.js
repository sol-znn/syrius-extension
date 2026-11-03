'use strict';

// Firefox chooses its own free port. Only the endpoint announced by this
// owned child is used; never expose its stderr or relax Firefox's origins.
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const failure = code => Object.assign(new Error('Firefox BiDi connection failed.'), { code });

const announcedEndpoint = stderr => {
  const announcement = /WebDriver BiDi listening on (ws:\/\/[^\s]+)/.exec(stderr);
  if (!announcement) return null;
  let url;
  try { url = new URL(announcement[1]); } catch { throw failure('FIREFOX_BIDI_ENDPOINT_INVALID'); }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' ||
      !/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535 ||
      url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw failure('FIREFOX_BIDI_ENDPOINT_INVALID');
  }
  return 'ws://127.0.0.1:' + url.port + '/session';
};

const connectFirefox = async ({ browser, stderr, timeoutMs = 60000, handshakeMs = 5000 }) => {
  const deadline = Date.now() + timeoutMs;
  let launchFailed = false;
  const failed = () => { launchFailed = true; };
  browser.on('error', failed);
  try {
    while (Date.now() < deadline) {
      if (launchFailed || browser.exitCode !== null || browser.signalCode !== null) {
        throw failure('FIREFOX_BIDI_BROWSER_EXITED');
      }
      const endpoint = announcedEndpoint(stderr());
      if (endpoint) {
        const socket = new WebSocket(endpoint);
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(failure('FIREFOX_BIDI_HANDSHAKE_TIMEOUT')),
              Math.max(1, Math.min(handshakeMs, deadline - Date.now())));
            const finish = callback => { clearTimeout(timer); callback(); };
            socket.onopen = () => finish(resolve);
            socket.onerror = () => finish(() => reject(failure('FIREFOX_BIDI_HANDSHAKE_FAILED')));
            socket.onclose = () => finish(() => reject(failure('FIREFOX_BIDI_HANDSHAKE_CLOSED')));
          });
          socket.onopen = socket.onerror = socket.onclose = null;
          return socket;
        } catch {
          // An abandoned connection must not open later beside its successor.
          socket.onopen = () => socket.close();
          socket.onerror = () => {};
          socket.onclose = null;
          try { socket.close(); } catch { /* The attempt is already abandoned. */ }
        }
      }
      await pause(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    throw failure('FIREFOX_BIDI_STARTUP_TIMEOUT');
  } finally {
    browser.off('error', failed);
  }
};

module.exports = { announcedEndpoint, connectFirefox };
