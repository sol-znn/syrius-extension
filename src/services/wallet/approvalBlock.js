import { Enums, Primitives, utils as sdkUtils } from 'znn-ts-sdk';
import approvalPow from './approvalPow';

// Keep the pinned SDK's typed preparation and hash/signature logic. This is its
// send sequence with operation-owned RPC timeouts and a cancellable PoW worker.
const sendApprovalBlock = async (zenon, template, key, operation, onPow) => {
  const context = operation.context(zenon);
  let block = await sdkUtils.BlockUtils._checkAndSetFields(context, template, key);
  await operation.assertActive();
  const plasma = await context.embedded.plasma.getRequiredPoWForAccountBlock(
    new Primitives.GetRequiredParam(block.address, block.blockType, block.toAddress, block.data));
  await operation.assertActive();
  if (plasma.requiredDifficulty !== 0) {
    block.fusedPlasma = plasma.availablePlasma;
    block.difficulty = plasma.requiredDifficulty;
    const hash = await sdkUtils.BlockUtils._getPoWData(block);
    await operation.assertActive(); onPow?.(Enums.PowStatus.generating);
    block.nonce = await approvalPow(hash, block.difficulty, operation);
    onPow?.(Enums.PowStatus.done);
  } else {
    block.fusedPlasma = plasma.basePlasma; block.difficulty = 0; block.nonce = '0000000000000000';
  }
  await operation.assertActive();
  block = await sdkUtils.BlockUtils._setHashAndSignature(block, key);
  await operation.assertActive();
  try {
    await context.ledger.publishRawTransaction(block);
    await operation.assertActive();
  } catch (error) {
    throw new Error('The submitted transaction outcome is unknown. Verify it before retrying.');
  }
  return block;
};
export default sendApprovalBlock;
