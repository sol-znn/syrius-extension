// Each approval owns its static worker. No Blob URL, shared Worker monkey patch
// or uncancelled SDK PoW worker survives this promise's completion.
const approvalPow = (hash, difficulty, { signal, expiresAt }) => new Promise((resolve, reject) => {
  let worker, timer, settled = false, started = false;
  const finish = (error, nonce) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer); signal.removeEventListener('abort', cancel);
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); }
    if (error) reject(error); else resolve(nonce);
  };
  const cancel = () => finish(new Error('Approval proof of work was canceled.'));
  try {
    if (signal.aborted || expiresAt <= Date.now()) { cancel(); return; }
    worker = new Worker(chrome.runtime.getURL('approval-pow-worker.js'));
    signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(cancel, Math.max(0, expiresAt - Date.now()));
    worker.onerror = () => finish(new Error('Approval proof of work failed.'));
    worker.onmessageerror = () => finish(new Error('Invalid proof-of-work worker response.'));
    worker.onmessage = ({ data }) => {
      if (signal.aborted || expiresAt <= Date.now()) { cancel(); return; }
      if (data?.ready && !started) {
        started = true; worker.postMessage({ hash: hash.toString(), difficulty: difficulty.toString() });
      } else if (started && typeof data?.nonce === 'string' && /^[0-9a-f]{16}$/i.test(data.nonce)) finish(null, data.nonce);
      else finish(new Error('Invalid proof-of-work worker response.'));
    };
  } catch (error) { finish(error); }
});
export default approvalPow;
