import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import SettingsItem from '../../../components/settings-item/settings-item';
import { getSettings } from '../../../services/utils/storage';
import { updateSetting } from '../../../services/wallet/preferences';
import { notify } from '../../../services/utils/notify';
import { explorerChoices } from '../../../services/utils/explorer';

// The settings index.
//
// It listed two items and carried a commented-out third with a "ToDo: Add
// change password functionality" note against it. Changing a wallet password
// and removing a wallet are both things desktop Syrius has always had, and the
// absence of the second one meant there was no way to get a wallet off a shared
// machine from inside the extension at all.

const autoLockChoices = [
  { minutes: 5, label: '5 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 0, label: 'On close' },
];

const Settings = () => {
  const navigate = useNavigate();
  const [settings, setSettings] = useState(() => getSettings());

  const [isSaving, setIsSaving] = useState(false);
  const update = async (key, value) => {
    setIsSaving(true);
    try { setSettings(await updateSetting(key, value)); }
    catch (error) { notify.error(error); }
    finally { setIsSaving(false); }
  };

  return (
    <div className="page">
      <div className="settings-group">
        <SettingsItem
          icon="view-mnemonic"
          title="Backup phrase"
          description="Reveal the recovery phrase for this wallet"
          url="export-mnemonic"
        />
        <SettingsItem
          icon="change-password"
          title="Change password"
          description="Re-encrypt this wallet under a new password"
          url="change-password"
        />
        <SettingsItem
          icon="change-network"
          title="Node"
          description="Node URL and chain identifier"
          url="change-node"
        />
      </div>

      <h3 className="section-title">Security</h3>

      <div className="setting-row">
        <div className="setting-row-text">
          <div className="setting-row-title">Lock after</div>
        </div>
        <div className="segmented">
          {autoLockChoices.map((choice) => (
            <button
              key={choice.minutes}
              type="button"
              className={`segmented-option ${
                settings.autoLockMinutes === choice.minutes ? 'is-selected' : ''
              }`}
              disabled={isSaving}
              onClick={() => update('autoLockMinutes', choice.minutes)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>

      <label className="setting-row">
        <div className="setting-row-text">
          <div className="setting-row-title">Receive automatically</div>
          <div className="setting-row-note">Claims incoming transfers when the wallet opens</div>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={settings.autoReceive}
          disabled={isSaving}
          onChange={(event) => update('autoReceive', event.target.checked)}
        />
      </label>

      <div className="setting-row">
        <div className="setting-row-text">
          <div className="setting-row-title">Explorer</div>
          <div className="setting-row-note">Where the link on each transaction opens</div>
        </div>
        <div className="segmented">
          {explorerChoices.map((choice) => (
            <button
              key={choice.key}
              type="button"
              className={`segmented-option ${
                settings.explorer === choice.key ? 'is-selected' : ''
              }`}
              disabled={isSaving}
              onClick={() => update('explorer', choice.key)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-group mt-3">
        <SettingsItem
          icon="change-chainId"
          title="Connected sites"
          description="Sites that can see this address"
          url="connected-sites"
        />
        <SettingsItem
          icon="sign-message"
          title="Sign message"
          description="Prove this address is yours, without sending anything"
          url="sign-message"
        />
      </div>

      <button
        type="button"
        className="button danger-text w-100 mt-3"
        onClick={() => navigate('reset-wallet')}
      >
        Remove wallet
      </button>
    </div>
  );
};

export default Settings;
