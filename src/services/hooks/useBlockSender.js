import { useCallback, useState } from 'react';
import { Enums, Zenon, utils as sdkUtils } from 'znn-ts-sdk';

import vault from '../wallet/vault';
import requestSigningKey, { withRequestScope } from '../wallet/requestSigningKey';
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
  const [isGeneratingPlasma, setIsGeneratingPlasma] = useState(false);

  const send = useCallback(async (template, { addressIndex, assertRequest, binding, onSubmitted } = {}) => {
    const zenon = Zenon.getSingleton();
    let submitted = false;
    await assertRequest?.();
    const keyPair = requestSigningKey(await vault.getSigningKeyPair(addressIndex), assertRequest, binding);
    await assertRequest?.();

    setIsSending(true);

    try {
      const context = Object.create(zenon);
      context.ledger = Object.create(zenon.ledger);
      context.ledger.publishRawTransaction = async block => {
        const started = await withRequestScope(binding, assertRequest, () => {
          if (binding && block.address?.toString() !== binding.scope.address) throw new Error('The signing account changed.');
          // Begin the actual RPC while selection is locked; do not hold the
          // lock waiting on a remote node. A submitted block cannot be undone.
          submitted = true;
          onSubmitted?.();
          const promise = Promise.resolve(zenon.ledger.publishRawTransaction(block));
          // A later scope check can stop awaiting the reply. Keep that
          // response rejection handled while preserving it for its waiter.
          promise.catch(() => {});
          return { promise };
        });
        return started.promise;
      };
      const signed = await sdkUtils.BlockUtils.send(context, template, keyPair, (status) => {
        // `PowStatus.generating` is 0, so this has to compare rather than test
        // for truth — the obvious `if (status)` reads it as "done".
        if (status === Enums.PowStatus.generating) {
          setIsGeneratingPlasma(true);
        }
        if (status === Enums.PowStatus.done) {
          setIsGeneratingPlasma(false);
        }
      });

      // The balance on screen is now stale by definition.
      invalidateAccountCache();
      await assertRequest?.();
      return signed;
    } catch (error) {
      if (submitted) throw new Error('The transaction may have been submitted. Its outcome is unknown. Check the original account before retrying.');
      throw error;
    } finally {
      // In `finally`, so an error cannot leave the screen saying it is working.
      setIsGeneratingPlasma(false);
      setIsSending(false);
    }
  }, []);

  return { send, isSending, isGeneratingPlasma };
};

export default useBlockSender;
