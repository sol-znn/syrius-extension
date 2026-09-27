import { getSettings, setAddressInfo } from '../utils/storage';
import selection from './selection';
import vault from './vault';

const { sessionKey, publicStateKey } = selection;
const deadlineFromNow = () => {
  const minutes = Number(getSettings().autoLockMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? Date.now() + minutes * 60000 : 0;
};
const load = () => selection.transaction(stored => {
  const record = selection.current(stored);
  // On close never resumes in a new document; retain its nonsecret account
  // so a connected site's prompt can explicitly wait for that account.
  return selection.live(record) && record.mode === 'timed' && record.entropy ? record : null;
});
const clear = expectedId => selection.transaction(stored => {
  const record = selection.current(stored);
  return expectedId !== undefined && record?.id !== expectedId ? null : selection.revoke(record);
});
const touch = () => {
  const binding = vault.getBinding();
  return selection.use(binding, async record => {
    vault.assertBinding(binding);
    const expiresAt = deadlineFromNow();
    const next = { ...record, expiresAt, lastActiveAt: Date.now(), mode: expiresAt ? 'timed' : 'local', ownerId: binding.ownerId };
    if (expiresAt) next.entropy = vault.getEntropy(); else delete next.entropy;
    await chrome.storage.session.set({ [sessionKey]: next });
    return true;
  });
};
const selectAddress = (index, maxAddressIndex) => {
  const binding = vault.getBinding();
  return selection.use(binding, async record => {
    vault.assertBinding(binding);
    if (!Number.isSafeInteger(index) || index < 0 || index >= maxAddressIndex) throw selection.ended();
    const address = await vault.getAddress(index);
    vault.assertBinding(binding);
    const next = { ...record, id: crypto.randomUUID(), resumeFrom: null,
      selectedAddressIndex: index, scope: { ...record.scope, index, address } };
    await selection.write(next);
    if (!setAddressInfo(record.walletName, { selectedAddressIndex: index, maxAddressIndex })) {
      await selection.revoke(next); vault.lock(); throw new Error('Could not save the selected account. Unlock and try again.');
    }
    vault.setSelectedIndex(index); vault.bind(next);
    return { address, binding: vault.getBinding() };
  });
};
const publish = (binding, value) => selection.use(binding, async () => {
  vault.assertBinding(binding);
  await chrome.storage.session.set({ [publicStateKey]: { ...value, address: binding.scope.address, scope: binding.scope, selectionId: binding.id } });
  return binding.id;
});
const session = { load, touch, clear, selectAddress, publish, deadlineFromNow, sessionKey, publicStateKey };
export default session;
