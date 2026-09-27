import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { useForm } from 'react-hook-form';
import { KeyStore, KeyStoreManager } from 'znn-ts-sdk';

import { notify } from '../../../services/utils/notify';
import fallbackValues from '../../../services/utils/fallbackValues';
import vault from '../../../services/wallet/vault';
import session from '../../../services/wallet/session';

// Changing the wallet password.
//
// Marked "ToDo" in the settings list since 2023 and absent from the extension,
// while desktop Syrius has always had it — which left anyone who suspected
// their password was known with no option but to move their funds.
//
// It is a re-encryption, not a key change: the same entropy is written back
// under a new password, so the addresses and the recovery phrase are unchanged.
// The old password still has to be proven first, because the keystore in memory
// would otherwise let anyone at an unlocked wallet lock its owner out of it.

const ChangePassword = () => {
  const navigate = useNavigate();
  const walletName = useSelector((state) => state.wallet.walletName);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    setError,
  } = useForm({ mode: 'onSubmit' });

  const { strongRegex, mediumRegex } = fallbackValues.passwordValidationInfo;

  const validateNewPassword = (value) => {
    if (!strongRegex.test(value) && !mediumRegex.test(value)) {
      return 'Use at least 8 characters with upper case, lower case and a digit';
    }
    return true;
  };

  const save = async () => {
    const activity = session.capture();
    setIsSaving(true);

    try {
      if (!activity || activity.walletName !== walletName) throw new Error('Unlock this wallet again.');
      // Verifying rather than trusting the open keystore: this is exactly the
      // moment to make somebody prove they are the owner.
      if (!(await vault.verifyPassword(currentPassword))) {
        setError('currentPasswordField', { message: 'Wrong password' });
        return;
      }

      const manager = new KeyStoreManager();
      await manager.saveKeyStore(
        new KeyStore().fromEntropy(vault.getEntropy()),
        newPassword,
        walletName
      );

      // The session holds entropy, not the password, so it survives this
      // unchanged — but its deadline is worth pushing out after the work.
      await session.touch(activity);

      notify.success('Password changed');
      navigate('/tabs/settings', { replace: true });
    } catch (err) {
      notify.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="page">
      <form onSubmit={handleSubmit(save)}>
        <div className="custom-control">
          <input
            {...register('currentPasswordField', { required: 'Enter your current password' })}
            className={`w-100 custom-label ${
              errors.currentPasswordField ? 'custom-label-error' : ''
            }`}
            placeholder="Current password"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          <div className={`input-error ${errors.currentPasswordField ? '' : 'invisible'}`}>
            {errors.currentPasswordField?.message || ' '}
          </div>
        </div>

        <div className="custom-control">
          <input
            {...register('newPasswordField', {
              required: 'Choose a new password',
              validate: validateNewPassword,
            })}
            className={`w-100 custom-label ${errors.newPasswordField ? 'custom-label-error' : ''}`}
            placeholder="New password"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <div className={`input-error ${errors.newPasswordField ? '' : 'invisible'}`}>
            {errors.newPasswordField?.message || ' '}
          </div>
        </div>

        <div className="custom-control">
          <input
            {...register('confirmPasswordField', {
              required: 'Repeat the new password',
              validate: (value) => value === newPassword || 'The passwords do not match',
            })}
            className={`w-100 custom-label ${
              errors.confirmPasswordField ? 'custom-label-error' : ''
            }`}
            placeholder="Repeat new password"
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
          <div className={`input-error ${errors.confirmPasswordField ? '' : 'invisible'}`}>
            {errors.confirmPasswordField?.message || ' '}
          </div>
        </div>

        <p className="text-gray text-xs">
          Your recovery phrase does not change. Keep it safe — it opens this wallet whatever the
          password is.
        </p>

        <button type="submit" className="button primary w-100 text-white" disabled={isSaving}>
          {isSaving ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </div>
  );
};

export default ChangePassword;
