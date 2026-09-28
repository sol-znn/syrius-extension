import { getSettings } from '../utils/storage';
import lease from './sessionLease';

// The owner token never leaves this document except in its trusted session
// marker. Other documents receive fresh tokens and cannot resume On close.
const ownerId = crypto.randomUUID();
const options = (values = {}) => ({ ...values, ownerId, minutes: getSettings().autoLockMinutes });
// Failure to read is not evidence that the shared wallet is locked.
const load = () => lease.load();
// Both explicit lock and startup recovery must observe a committed revocation.
// Keep the expected identity on every retry so recovery cannot clear a newer
// password unlock in another document.
const clear = async (expectedId) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await lease.clear(expectedId); }
    catch (error) {
      if (attempt === 1) {
        throw Object.assign(new Error('Could not lock all wallet windows. Try again or close the browser.'), {
          code: 'WALLET_LOCK_FAILED',
        });
      }
    }
  }
};
const create = (expectedId, values, adopt) => lease.create(expectedId, options(values), adopt);
const restore = (record, selectedAddressIndex, adopt) => lease.renew(record.id, options({
  walletName: record.walletName, selectedAddressIndex, resumable: true,
}), (current, entropy) => adopt(current, entropy));
const use = (id, operation) => lease.use(id, ownerId, operation);
const touch = (id, values, operation) => lease.renew(id, options(values), operation);
const publish = (id, publicState) => lease.publish(id, ownerId, publicState);
const session = {
  sessionKey: lease.sessionKey, publicStateKey: lease.publicStateKey,
  ended: lease.ended, begin: lease.begin, create, restore, use, touch, load,
  clear, publish, isLockedGeneration: lease.isLockedGeneration,
};
export default session;
