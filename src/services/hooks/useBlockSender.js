import { useCallback, useRef, useState } from 'react';
import { Enums, Zenon } from 'znn-ts-sdk';

import vault from '../wallet/vault';
import requestSigningKey from '../wallet/requestSigningKey';
import { runApprovalOperation } from '../wallet/approvalOperation';
import sendApprovalBlock from '../wallet/approvalBlock';
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

  const send = useCallback(async (template, { addressIndex, assertRequest, expiresAt } = {}) => {
    const current = ++generation.current;
    const zenon = Zenon.getSingleton();
    setIsSending(true);
    const progress = status => {
      if (generation.current !== current || (Number.isFinite(expiresAt) && expiresAt <= Date.now())) return;
      if (status === Enums.PowStatus.generating) setIsGeneratingPlasma(true);
      if (status === Enums.PowStatus.done) setIsGeneratingPlasma(false);
    };
    try {
      const execute = async operation => {
        await operation.assertActive();
        const keyPair = requestSigningKey(await vault.getSigningKeyPair(addressIndex), operation.assertActive);
        await operation.assertActive();
        return sendApprovalBlock(zenon, template, keyPair, operation, progress);
      };
      const signed = assertRequest
        ? await runApprovalOperation(expiresAt, execute, { assertRequest })
        : await zenon.send(template, await vault.getSigningKeyPair(addressIndex), progress);

      // The balance on screen is now stale by definition.
      invalidateAccountCache();
      await assertRequest?.();
      return signed;
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
