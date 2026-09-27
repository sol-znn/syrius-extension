// A fresh facade for one dApp operation. Never modify the vault's cached key.
// A check after async crypto discards results if the requesting page left.
const requestSigningKey = (key, assertRequest) => {
  if (!assertRequest) return key;
  const use = async (method, ...args) => {
    await assertRequest();
    const result = await key[method](...args);
    await assertRequest();
    return result;
  };
  return Object.freeze({
    getAddress: () => use('getAddress'),
    getPublicKey: () => use('getPublicKey'),
    sign: bytes => use('sign', new Uint8Array(bytes)),
  });
};
export default requestSigningKey;
