import React, { useState } from 'react';
import { useForm } from 'react-hook-form';

import MnemonicWord from '../../../components/mnemonic-word/mnemonic-word';
import vault from '../../../services/wallet/vault';
import { copyToClipboard, notify } from '../../../services/utils/notify';
import './export-mnemonic.scss';

// Revealing the recovery phrase.
//
// The password re-entry is the point of this screen — an unlocked wallet left
// on a desk should not hand over the seed to whoever walks past — so it is kept,
// but it now verifies rather than re-deriving a second key store, and the words
// come from the one already open.

const ExportMnemonic = () => {
  const [password, setPassword] = useState('');
  const [words, setWords] = useState(null);
  const [isChecking, setIsChecking] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    setError,
  } = useForm();

  const reveal = async () => {
    setIsChecking(true);

    try {
      if (!(await vault.verifyPassword(password))) {
        setError('inputPasswordField', { message: 'Wrong password' });
        return;
      }
      const mnemonic = await vault.getMnemonic();

      if (!mnemonic) {
        notify.error('This wallet has no recovery phrase stored.');
        return;
      }
      setWords(mnemonic.split(' '));
    } catch (err) {
      notify.error(err);
    } finally {
      setIsChecking(false);
    }
  };

  if (words) {
    return (
      <div className="page">
        <div className="warning-panel">
          Anyone with these words owns this wallet. Never type them into a website.
        </div>

        <div className="mnemonic-words">
          {words.map((word, index) => (
            <MnemonicWord key={`${word}-${index}`} word={word} index={index + 1} />
          ))}
        </div>

        <button
          type="button"
          className="button secondary w-100 mt-2"
          onClick={() => copyToClipboard(words.join(' '), 'Recovery phrase copied')}
        >
          Copy phrase
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <form onSubmit={handleSubmit(reveal)}>
        <div className="custom-control">
          <input
            {...register('inputPasswordField', { required: 'Enter your password' })}
            className={`w-100 custom-label ${
              errors.inputPasswordField ? 'custom-label-error' : ''
            }`}
            placeholder="Wallet password"
            type="password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <div className={`input-error ${errors.inputPasswordField ? '' : 'invisible'}`}>
            {errors.inputPasswordField?.message || ' '}
          </div>
        </div>

        <button type="submit" className="button primary w-100 text-white" disabled={isChecking}>
          {isChecking ? 'Checking…' : 'Reveal phrase'}
        </button>
      </form>
    </div>
  );
};

export default ExportMnemonic;
