import { getSettings, setAddressInfo, setSetting } from '../utils/storage';
import lease from './sessionLease';

// The owner token never leaves this document except in its trusted session
// marker. Other documents receive fresh tokens and cannot resume On close.
const ownerId = crypto.randomUUID();
// Read when the lease is created, under its lock, not when the caller started.
const preferredMinutes = () => {
  const minutes = getSettings().autoLockMinutes;
  return lease.validMinutes(minutes) ? minutes : 15;
};
// Failure to read is not evidence that the shared wallet is locked.
const load = () => lease.load();
// Both explicit lock and startup recovery must observe a committed revocation.
// Keep the expected identity (a lease id, or `{id, revision}`) on every retry
// so recovery cannot clear a newer password unlock in another document.
// Only storage unavailability is retried; an `afterRevoke` failure is its own.
const clear = async (expected, afterRevoke) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await lease.clear(expected, afterRevoke); }
    catch (error) {
      if (error.code !== 'WALLET_SESSION_UNAVAILABLE') throw error;
      if (attempt === 1) {
        throw Object.assign(new Error('Could not lock all wallet windows. Try again or close the browser.'), {
          code: 'WALLET_LOCK_FAILED',
        });
      }
    }
  }
};
const create = (expectedId, values, adopt) => lease.create(expectedId, { ...values, ownerId, minutes: preferredMinutes }, adopt);
const restore = (record, scope, adopt) => lease.renew(record.id, {
  ownerId, walletName: record.walletName, scope, resumable: true,
}, (current, entropy) => adopt(current, entropy));
const use = (id, operation, check) => lease.use(id, ownerId, operation, check);
const touch = (id, values, operation) => lease.renew(id, { ...values, ownerId }, operation);
const publish = (id, publicState) => lease.publish(id, ownerId, publicState);
// The wallet's saved selection is written inside the same transaction, first.
const select = (id, choice, walletName, maxAddressIndex) => lease.select(id, ownerId, choice, () => {
  if (!setAddressInfo(walletName, { selectedAddressIndex: choice.index, maxAddressIndex })) {
    throw new Error('Could not save the selected address. Try again.');
  }
});
// The preference is saved between the stricter stage and the relaxed record;
// see sessionLease.setPolicy. `setSetting` throws when it cannot save.
const setPolicy = (id, minutes, entropy) => lease.setPolicy(id, ownerId, minutes, entropy,
  () => setSetting('autoLockMinutes', minutes));
const session = {
  sessionKey: lease.sessionKey, publicStateKey: lease.publicStateKey,
  ended: lease.ended, changed: lease.changed, begin: lease.begin, create, restore, use, touch, select, load,
  clear, publish, setPolicy, isLockedGeneration: lease.isLockedGeneration,
};
export default session;
