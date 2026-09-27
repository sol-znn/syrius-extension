// One popup may have a preview and a submitted operation. Keep their resource
// reservations until the native RPC promises actually settle, even when the UI
// stops waiting. The pinned rpc-websockets call timeout deletes its queue entry.
const maxOperations = 2, rpcTimeoutMs = 10000;
let activeOperations = 0;
const ended = () => new Error('Approval expired or was canceled. Verify any submitted result before retrying.');
const runApprovalOperation = async (expiresAt, execute, { signal, assertRequest } = {}) => {
  if (activeOperations >= maxOperations) throw new Error('Earlier wallet work is still stopping. Wait a few seconds and retry.');
  activeOperations++;
  const controller = new AbortController(), outstanding = new Set();
  let closed = false, released = false, timer;
  const release = () => {
    if (closed && !outstanding.size && !released) { released = true; activeOperations--; }
  };
  const abort = () => controller.abort();
  const check = () => {
    if (controller.signal.aborted || !Number.isFinite(expiresAt) || Date.now() >= expiresAt) throw ended();
  };
  const wait = promise => new Promise((resolve, reject) => {
    const canceled = () => { cleanup(); reject(ended()); };
    const cleanup = () => controller.signal.removeEventListener('abort', canceled);
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    controller.signal.addEventListener('abort', canceled, { once: true });
    if (controller.signal.aborted) canceled();
  });
  const track = promise => {
    outstanding.add(promise);
    const complete = () => { outstanding.delete(promise); release(); };
    promise.then(complete, complete);
    return promise;
  };
  const assertActive = async () => { check(); if (assertRequest) await wait(assertRequest()); check(); };
  const rpc = async (client, method, params) => {
    await assertActive();
    // This is the pinned SDK's rpc-websockets client, whose third call argument
    // installs a native queue-cleanup timeout. Do not invoke the SDK's unbounded
    // sendRequest wrapper or mutate the client shared by other wallet screens.
    if (!client || typeof client.call !== 'function') throw new Error('The wallet node is not connected.');
    const remaining = expiresAt - Date.now();
    // The awaited assertion and native call are separate continuations. Never
    // turn an already-expired authorization into a new one-millisecond RPC.
    if (controller.signal.aborted || remaining <= 0) throw ended();
    const timeout = Math.min(rpcTimeoutMs, remaining);
    const result = await wait(track(Promise.resolve(client.call(method, params, timeout))));
    check(); return result;
  };
  const context = zenon => {
    const copyApi = api => {
      const target = Object.create(api);
      const client = api.client?._wsRpc2Client;
      target.client = { sendRequest: (method, params) => rpc(client, method, params) };
      return target;
    };
    const target = Object.create(zenon);
    target.ledger = copyApi(zenon.ledger);
    target.embedded = Object.create(zenon.embedded);
    target.embedded.plasma = copyApi(zenon.embedded.plasma);
    return target;
  };
  try {
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, Math.max(0, expiresAt - Date.now()));
    await assertActive();
    return await wait(execute({ signal: controller.signal, expiresAt, check, assertActive, context, wait }));
  } finally {
    closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); abort(); release();
  }
};
export { runApprovalOperation, maxOperations, rpcTimeoutMs };
