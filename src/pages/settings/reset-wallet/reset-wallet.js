import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';

import { removeStorageWallet, loadStorageWalletNames } from '../../../services/utils/utils';
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
  const walletName = useSelector((state) => state.wallet.walletName);

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isRemoving, setIsRemoving] = useState(false);

  const canRemove = password.length > 0 && confirmation.trim().toUpperCase() === confirmationWord;

  const remove = async () => {
    if (!canRemove) {
      return;
    }
    setIsRemoving(true);

    try {
      if (!(await vault.verifyPassword(password))) {
        notify.error('Wrong password.');
        return;
      }

      await lockWallet();
      if (!removeStorageWallet(walletName)) {
        throw new Error('Could not remove that wallet.');
      }

      invalidateAccountCache();
      dispatch(resetWalletState());
      dispatch(resetPendingTransactions());

      notify.success(`Removed ${walletName}`);
      navigate(
        loadStorageWalletNames().length ? '/password' : '/auth/onboarding',
        { replace: true }
      );
    } catch (err) {
      notify.error(err);
      if (!vault.isUnlocked()) {
        invalidateAccountCache();
        dispatch(resetWalletState());
        dispatch(resetPendingTransactions());
        navigate('/password', { replace: true });
      }
    } finally {
      setIsRemoving(false);
    }
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
        <button type="button" className="button secondary w-100" onClick={() => navigate(-1)}>
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
