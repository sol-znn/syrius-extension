import { useCallback, useRef, useState } from 'react';
import { Enums, Zenon } from 'znn-ts-sdk';

import vault from '../wallet/vault';
import requestSigningKey from '../wallet/requestSigningKey';
import { runApprovalOperation } from '../wallet/approvalOperation';
import sendApprovalBlock from '../wallet/approvalBlock';
import { beginPreparedSend } from '../wallet/blockApproval';
import journal from '../wallet/journal';
import sendJournaled from '../wallet/publisher';
import { invalidateAccountCache } from './useAccount';

// Signing and broadcasting one account block, for the one caller that has to
// wait for it.
//
// Every screen that could move something had its own copy of this: show a
// spinner, build a `generatingPowCallback` that swapped one spinner message for
// another, call `zenon.send`, then a catch that rebuilt a readable error and a
// nine-line `toast` options object. Six copies, subtly different, and several
// of them left the spinner up on the error path.
//
// The wallet's own screens do not use this any more — they hand the block to
// `useBackgroundSender` and go back to the dashboard, because proof of work
// takes seconds and nobody should watch a modal for them. What is left is the
// dApp approval flow, where the requesting site is genuinely blocked on the
// signed block and there is nothing else for that screen to do.
//
// Even there the modal spinner is gone. This reports plasma generation as
// state, and the approval screen says so on itself — a full-screen dialog for
// something the user already asked for and can see the details of is a lie
// about how much attention it deserves.

const useBlockSender = () => {
  const [isSending, setIsSending] = useState(false);
  const generation = useRef(0);
  const [isGeneratingPlasma, setIsGeneratingPlasma] = useState(false);

  // `binding` (an approval's wallet account) is checked under the session lock
  // at every key use and again at the instant publication starts; after that
  // point a failure means the outcome is unknown, and `onSubmitted` says so.
  // `prepared` (an approval's reviewed block, blockApproval.js) is signed as
  // reviewed; `template` is then unused.
  const send = useCallback(async (template, { addressIndex, assertRequest, expiresAt, binding, onSubmitted, prepared } = {}) => {
    const current = ++generation.current;
    const zenon = Zenon.getSingleton();
    setIsSending(true);
    let submitted = false;
    // The signed block is recorded under the account's turn before the
    // selection lock is taken: the journal derives its key through that same
    // lock, and nothing may wait on storage while holding it. If the block is
    // then never sent (the account changed), the record says so.
    const startPublication = entry => async (block, publish) => {
      await entry.start(block);
      let promise;
      try {
        if (binding) {
          promise = (await vault.whileBound(binding, () => {
            if (block.address?.toString() !== binding.scope.address) throw new Error('The signing account changed.');
            // Begin the RPC while the selection is locked; never hold the lock
            // waiting on a remote node. A submitted block cannot be undone.
            submitted = true;
            onSubmitted?.();
            const sending = Promise.resolve(publish());
            // A later check can stop awaiting the reply; keep its rejection
            // handled while preserving it for the waiter below.
            sending.catch(() => {});
            return { sending };
          })).sending;
        } else {
          promise = Promise.resolve(publish());
          promise.catch(() => {});
        }
      } catch (error) {
        await entry.settle(Promise.reject(error), { sent: false }).catch(() => {});
        throw error;
      }
      // The journal learns the outcome even if this window stops waiting.
      const settled = entry.settle(promise);
      settled.catch(() => {});
      return promise;
    };
    const progress = status => {
      if (generation.current !== current || (Number.isFinite(expiresAt) && expiresAt <= Date.now())) return;
      if (status === Enums.PowStatus.generating) setIsGeneratingPlasma(true);
      if (status === Enums.PowStatus.done) setIsGeneratingPlasma(false);
    };
    try {
      const execute = async operation => {
        // Consumed before any key lookup or other await: one send per review.
        const begun = prepared ? beginPreparedSend(prepared) : null;
        await operation.assertActive();
        const keyPair = requestSigningKey(await vault.getSigningKeyPair(addressIndex, binding), operation.assertActive);
        await operation.assertActive();
        const address = (await keyPair.getAddress()).toString();
        await operation.assertActive();
        // The wait for a turn is bounded by the approval's own deadline. A
        // transfer is filled in once the turn is held; a reviewed block was
        // filled in at review, so if the block ahead of it lands, the frontier
        // has moved and the node refuses it, which is the answer it should get.
        return journal.run(operation.context(zenon), address,
          { path: 'approval', waitMs: Math.max(0, Math.min(journal.defaultWaitMs, expiresAt - Date.now())) },
          entry => sendApprovalBlock(zenon, template, keyPair, operation, progress, startPublication(entry), begun));
      };
      const signed = assertRequest
        ? await runApprovalOperation(expiresAt, execute, { assertRequest })
        : await sendJournaled(zenon, template, await vault.getSigningKeyPair(addressIndex), { onPow: progress });

      // The balance on screen is now stale by definition.
      invalidateAccountCache();
      await assertRequest?.();
      return signed;
    } catch (error) {
      if (submitted) throw new Error('The transaction may have been submitted. Its outcome is unknown. Check the original account before retrying.');
      throw error;
    } finally {
      // In `finally`, so an error cannot leave the screen saying it is working.
      if (generation.current === current) {
        setIsGeneratingPlasma(false);
        setIsSending(false);
      }
    }
  }, []);

  return { send, isSending, isGeneratingPlasma };
};

export default useBlockSender;
