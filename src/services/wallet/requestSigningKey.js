import selection from './selection';
import vault from './vault';

// One facade per approval. Selection changes/revocation wait for an operation
// already started under the lock; a later SDK call must reacquire and recheck.
const withRequestScope = async (binding, assertRequest, operation) => {
  await assertRequest?.();
  if (!binding) return operation();
  return selection.use(binding, async record => {
    vault.assertBinding(binding);
    await assertRequest?.();
    vault.assertBinding(binding);
    selection.assert(record, binding, true);
    const result = await operation(record);
    await assertRequest?.();
    vault.assertBinding(binding);
    return result;
  });
};
const requestSigningKey = (key, assertRequest, binding) => {
  if (!assertRequest && !binding) return key;
  const invoke = (method, ...args) => withRequestScope(binding, assertRequest, async record => {
    if (binding && (await key.getAddress()).toString() !== binding.scope.address) throw selection.ended();
    if (binding) { vault.assertBinding(binding); selection.assert(record, binding, true); }
    return key[method](...args);
  });
  return Object.freeze({ getAddress: () => invoke('getAddress'), getPublicKey: () => invoke('getPublicKey'),
    sign: bytes => invoke('sign', new Uint8Array(bytes)) });
};
export { withRequestScope };
export default requestSigningKey;
