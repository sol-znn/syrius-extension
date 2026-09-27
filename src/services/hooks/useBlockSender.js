import { useCallback, useState } from 'react';
import { Enums, Zenon } from 'znn-ts-sdk';

import vault from '../wallet/vault';
import { sendBlockApproval } from '../wallet/blockApproval';
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

  const send = useCallback(async (template, { addressIndex } = {}) => {
    const zenon = Zenon.getSingleton();
    const keyPair = await vault.getSigningKeyPair(addressIndex);

    setIsSending(true);

    try {
      const signed = await zenon.send(template, keyPair, (status) => {
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
      return signed;
    } finally {
      // In `finally`, so an error cannot leave the screen saying it is working.
      setIsGeneratingPlasma(false);
      setIsSending(false);
    }
  }, []);

  const sendPrepared = useCallback(async (approval) => {
    setIsSending(true);
    try {
      const signed = await sendBlockApproval(approval, (status) => {
        setIsGeneratingPlasma(status === Enums.PowStatus.generating);
      });
      invalidateAccountCache();
      return signed;
    } finally {
      setIsGeneratingPlasma(false);
      setIsSending(false);
    }
  }, []);

  return { send, sendPrepared, isSending, isGeneratingPlasma };
};

export default useBlockSender;
