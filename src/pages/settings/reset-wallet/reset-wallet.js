import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector, useStore } from 'react-redux';

import { loadStorageWalletNames } from '../../../services/utils/utils';
import { captureWalletRemoval, prepareWalletRemoval, commitWalletRemoval } from '../../../services/wallet/removal';
import { notify } from '../../../services/utils/notify';
import { resetWalletState } from '../../../services/redux/walletSlice';
import { resetPendingTransactions } from '../../../services/redux/pendingTransactionsSlice';
import { invalidateAccountCache } from '../../../services/hooks/useAccount';
import lockWallet from '../../../services/wallet/lock';
import vault from '../../../services/wallet/vault';

// Removing a wallet from this browser.
//
// The extension had no way to do this. The encrypted keystore sat in
// localStorage for the life of the profile, and the only way to get it out was
// the browser's own "clear site data" — which is not something a person is
// going to find, and takes the node list and everything else with it.
//
// It is deliberately awkward: the password has to be re-entered, and the
// confirmation is typed rather than clicked, because the keystore is the only
// copy of the key that exists in this browser.

const confirmationWord = 'REMOVE';

const ResetWallet = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const store = useStore();
  const walletName = useSelector((state) => state.wallet.walletName);
  const operation = useRef(null);
  useEffect(() => () => { operation.current = null; }, []);

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isRemoving, setIsRemoving] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);

  const canRemove = password.length > 0 && confirmation.trim().toUpperCase() === confirmationWord;

  const remove = async () => {
    if (!canRemove || operation.current) {
      return;
    }
    const active = { committing: false };
    operation.current = active;
    setIsRemoving(true);

    try {
      const live = store.getState().wallet;
      if (live.walletName !== walletName) throw new Error('The selected wallet changed. Try again.');
      const current = { walletName: live.walletName, maxAddressIndex: live.maxAddressIndex,
        selectedAddressIndex: live.selectedAddressIndex };
      const isCurrent = () => {
        const latest = store.getState().wallet;
        return operation.current === active && latest.walletName === current.walletName &&
          latest.maxAddressIndex === current.maxAddressIndex && latest.selectedAddressIndex === current.selectedAddressIndex;
      };
      const captured = captureWalletRemoval(current, isCurrent);
      const verified = await vault.verifyPassword(password);
      if (!isCurrent()) throw new Error('The wallet removal was canceled or the selected wallet changed.');
      if (!verified) {
        if (operation.current === active) notify.error('Wrong password.');
        return;
      }
      const prepared = await prepareWalletRemoval(captured);
      active.committing = true;
      setIsCommitting(true);
      commitWalletRemoval(prepared);
      // Invoke the lock synchronously after deletion; do not insert another
      // await that could let a different wallet become current before locking.
      const locking = lockWallet();
      invalidateAccountCache();
      dispatch(resetWalletState());
      dispatch(resetPendingTransactions());
      await locking;
      if (operation.current !== active) return;

      notify.success(`Removed ${walletName}`);
      navigate(
        loadStorageWalletNames().length ? '/password' : '/auth/onboarding',
        { replace: true }
      );
    } catch (err) {
      if (operation.current === active) notify.error(err);
    } finally {
      if (operation.current === active) {
        operation.current = null;
        setIsRemoving(false);
        setIsCommitting(false);
      }
    }
  };

  const cancel = () => {
    if (operation.current?.committing) return;
    operation.current = null;
    navigate(-1);
  };

  return (
    <div className="page">
      <div className="warning-panel">
        <strong>This deletes {walletName} from this browser.</strong>
        <p>
          Anything in it is unreachable afterwards unless you have the recovery phrase. Check that
          you have it written down before you continue.
        </p>
      </div>

      <div className="custom-control">
        <input
          className="w-100 custom-label"
          placeholder="Wallet password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <div className="custom-control">
        <input
          className="w-100 custom-label"
          placeholder={`Type ${confirmationWord} to confirm`}
          type="text"
          spellCheck="false"
          autoComplete="off"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </div>

      <div className="action-row">
        <button type="button" className="button secondary w-100" disabled={isCommitting} onClick={cancel}>
          Cancel
        </button>
        <button
          type="button"
          className="button warning w-100"
          disabled={!canRemove || isRemoving}
          onClick={remove}
        >
          {isRemoving ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </div>
  );
};

export default ResetWallet;
