import { Primitives, Zenon, utils as sdkUtils } from 'znn-ts-sdk';
import vault from './vault';

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const copy = value => JSON.parse(JSON.stringify(value));
const fields = json => JSON.stringify([json.blockType, json.toAddress, json.data, json.tokenStandard, json.amount]);
const changed = () => new Error('The contract call changed. Review a new request before signing.');
const assertCallApproval = (approval, template, isCurrent) => {
  if (!approval || !isCurrent() || fields(template.toJson()) !== approval.fields) throw changed();
};
const templateForCallApproval = approval => Primitives.AccountBlockTemplate.fromJson({ ...approval.block,
  // The SDK's fromJson does not decode its own base64 publicKey/signature output.
  publicKey: Uint8Array.from(atob(approval.block.publicKey || ''), char => char.charCodeAt(0)), signature: new Uint8Array(),
});
const prepareCallApproval = async params => {
  // Normalize and copy before awaiting RPC. Only these exact bytes can be
  // displayed as known arguments, including SDK array/object input formats.
  const template = Primitives.AccountBlockTemplate.fromJson(params);
  const initial = freeze(copy(template.toJson())), expected = fields(initial);
  let block = initial, networkPrepared = false;
  try {
    const filled = await sdkUtils.BlockUtils._checkAndSetFields(Zenon.getSingleton(), template, vault.getKeyPair());
    block = freeze(copy(filled.toJson()));
    networkPrepared = true;
  } catch (error) {
    // Preserve the existing offline/raw-block review path, but use its canonical
    // copied SDK representation, never the caller-owned page input.
  }
  if (fields(block) !== expected) throw changed();
  return Object.freeze({ block, fields: expected, networkPrepared });
};
const callSigningKey = (key, approval, template, isCurrent) => {
  const assert = () => assertCallApproval(approval, template, isCurrent);
  const invoke = async (method, ...args) => {
    assert(); const value = await key[method](...args); assert(); return value;
  };
  return Object.freeze({
    getAddress: () => invoke('getAddress'), getPublicKey: () => invoke('getPublicKey'),
    sign: bytes => invoke('sign', Uint8Array.from(bytes)),
  });
};
export { prepareCallApproval, templateForCallApproval, assertCallApproval, callSigningKey };
