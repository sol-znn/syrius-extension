import { setSetting } from '../utils/storage';
import { announceAddress } from './announce';
import lease from './sessionLease';
import vault from './vault';

// Saving a setting. Every setting throws when it cannot be saved, so a screen
// never shows a choice that did not stick.
//
// The lock duration is also the running session's policy, so an unlocked
// wallet applies it to its lease in the same step (vault.setLockPolicy). Sites
// are then told what they may now see: nothing under On close.
const updateSetting = async (key, value) => {
  if (key !== 'autoLockMinutes') return setSetting(key, value);
  if (!lease.validMinutes(value)) throw new Error('Choose a supported lock duration.');
  if (!vault.isUnlocked()) return setSetting(key, value);
  try {
    return await vault.setLockPolicy(value);
  } finally {
    await announceAddress();
  }
};

export { updateSetting };
