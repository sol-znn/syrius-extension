// One fresh facade per approval. Do not modify the vault's cached SDK key.
const requestSigningKey = (key, assertRequest) => {
  if (!assertRequest) return key;
  const invoke = async (method, ...args) => {
    await assertRequest();
    const result = await key[method](...args);
    await assertRequest();
    return result;
  };
  return Object.freeze({
    getAddress: () => invoke('getAddress'),
    getPublicKey: () => invoke('getPublicKey'),
    sign: bytes => invoke('sign', new Uint8Array(bytes)),
  });
};
export default requestSigningKey;
