import { utils as sdkUtils } from 'znn-ts-sdk';
import journal from './journal';

// The wallet's own sends and receives, through the journal.
//
// These are the pinned SDK's `send` stages in the SDK's order: fill in the
// account fields, pay for the block, hash and sign. The one difference is what
// happens between signing and publishing, where the SDK did nothing: the signed
// block is recorded first, under this account's turn. The approval window does
// the same through its own staged sender (approvalBlock.js, useBlockSender.js).
const sendJournaled = async (zenon, template, keyPair, { path = 'send', onPow, waitMs } = {}) => {
  const address = (await keyPair.getAddress()).toString();
  return journal.run(zenon, address, { path, waitMs }, async (entry) => {
    // Filled in only once the turn is held: the height and previous hash read
    // here are the ones no other window of this wallet is about to use.
    let block = await sdkUtils.BlockUtils._checkAndSetFields(zenon, template, keyPair);
    block = await sdkUtils.BlockUtils._setDifficulty(zenon, block, onPow, false);
    block = await sdkUtils.BlockUtils._setHashAndSignature(block, keyPair);
    await entry.publish(block, () => zenon.ledger.publishRawTransaction(block));
    return block;
  });
};

export default sendJournaled;
