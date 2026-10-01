import { Enums, Primitives, utils as sdkUtils } from 'znn-ts-sdk';
import approvalPow from './approvalPow';

// Keep the pinned SDK's typed preparation and hash/signature logic. This is its
// send sequence with operation-owned RPC timeouts and a cancellable PoW worker.
// `startPublication(block, publish)` may wrap the moment of sending (an
// approval checks its wallet account there); it must call `publish` to send.
//
// `prepared` is a begun, reviewed preparation (blockApproval.beginPreparedSend).
// With it the block is not filled in again: it is signed exactly as reviewed,
// and its reviewed fields are re-checked around every stage that follows.
const sendApprovalBlock = async (zenon, template, key, operation, onPow,
  startPublication = (block, publish) => publish(), prepared = null) => {
  const context = operation.context(zenon);
  const assertFields = prepared ? prepared.assertFields : () => {};
  let block;
  if (prepared) {
    await prepared.verifyKey(key);
    block = prepared.template;
  } else {
    block = await sdkUtils.BlockUtils._checkAndSetFields(context, template, key);
  }
  await operation.assertActive(); assertFields();
  const plasma = await context.embedded.plasma.getRequiredPoWForAccountBlock(
    new Primitives.GetRequiredParam(block.address, block.blockType, block.toAddress, block.data));
  await operation.assertActive(); assertFields();
  if (plasma.requiredDifficulty !== 0) {
    block.fusedPlasma = plasma.availablePlasma;
    block.difficulty = plasma.requiredDifficulty;
    const hash = await sdkUtils.BlockUtils._getPoWData(block);
    await operation.assertActive(); assertFields(); onPow?.(Enums.PowStatus.generating);
    block.nonce = await approvalPow(hash, block.difficulty, operation);
    onPow?.(Enums.PowStatus.done);
  } else {
    block.fusedPlasma = plasma.basePlasma; block.difficulty = 0; block.nonce = '0000000000000000';
  }
  await operation.assertActive(); assertFields();
  // The key signs only while the block still carries the reviewed fields.
  const signer = prepared ? {
    sign: async (bytes) => {
      assertFields();
      const signature = await key.sign(bytes);
      assertFields();
      return signature;
    },
  } : key;
  block = await sdkUtils.BlockUtils._setHashAndSignature(block, signer);
  await operation.assertActive(); assertFields();
  // Only a failure after sending began is an unknown outcome; a refusal to
  // start (the account changed, say) is reported as itself.
  let started = false;
  try {
    await startPublication(block, () => { started = true; return context.ledger.publishRawTransaction(block); });
    await operation.assertActive();
  } catch (error) {
    if (!started) throw error;
    throw new Error('The submitted transaction outcome is unknown. Verify it before retrying.');
  }
  return block;
};
export default sendApprovalBlock;
