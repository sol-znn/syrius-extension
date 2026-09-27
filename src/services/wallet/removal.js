import { Primitives } from 'znn-ts-sdk';
import { keys } from '../utils/storage';
import { walletStorageKey } from '../utils/utils';
import vault from './vault';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const changed = () => new Error('The wallet or its saved data changed. Try removing it again.');
const invalid = () => new Error('Wallet metadata could not be read safely. No wallet was removed.');
const readMap = (key) => {
  const raw = localStorage.getItem(key);
  if (raw === null) return {};
  let value;
  try { value = JSON.parse(raw); } catch (error) { throw invalid(); }
  if (!object(value)) throw invalid();
  return value;
};
const address = (value) => {
  try {
    if (typeof value === 'string') return Primitives.Address.parse(value).toString();
    const data = value?.core?.data;
    if (value?.hrp !== 'z' || value?.core?.type !== 'Buffer' || !Array.isArray(data) ||
      data.length !== 20 || !data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw invalid();
    return new Primitives.Address('z', Buffer.from(data)).toString();
  } catch (error) { throw invalid(); }
};
const indexValid = (value) => Number.isSafeInteger(value) && value >= 0 && value < 0x80000000;
const countValid = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 0x80000000;
const infoFor = (all, name) => {
  if (!own(all, name)) return { selectedAddressIndex: 0, maxAddressIndex: 1 };
  const info = all[name];
  if (!object(info) || !indexValid(info.selectedAddressIndex) || !countValid(info.maxAddressIndex) ||
    info.selectedAddressIndex >= info.maxAddressIndex ||
    (own(info, 'labelAddressCount') && !countValid(info.labelAddressCount))) throw invalid();
  return info;
};
const infoSnapshot = (all, name) => own(all, name) ? JSON.stringify(all[name]) : null;
const assertCurrent = (captured) => {
  if (!captured.isCurrent() || !vault.isUnlocked() || vault.getWalletName() !== captured.name ||
    vault.getKeyPair(0) !== captured.key || vault.getSelectedIndex() !== captured.index ||
    localStorage.getItem(walletStorageKey) !== captured.walletsRaw ||
    infoSnapshot(readMap(keys.addressInfo), captured.name) !== captured.infoRaw) throw changed();
};

// Capture before password verification, including an opaque per-adoption key
// handle. Returning to the same wallet name after another adoption is stale too.
const captureWalletRemoval = ({ walletName, maxAddressIndex, selectedAddressIndex }, isCurrent) => {
  if (typeof walletName !== 'string' || !walletName || !countValid(maxAddressIndex) ||
    !indexValid(selectedAddressIndex) || typeof isCurrent !== 'function') throw invalid();
  const walletsRaw = localStorage.getItem(walletStorageKey);
  const wallets = readMap(walletStorageKey);
  if (!own(wallets, walletName)) throw changed();
  const bases = Object.keys(wallets).map((name) => {
    if (!object(wallets[name])) throw invalid();
    return { name, address: address(wallets[name].baseAddress) };
  });
  const allInfo = readMap(keys.addressInfo), info = infoFor(allInfo, walletName);
  const baseAddress = bases.find((item) => item.name === walletName).address;
  const captured = Object.freeze({ name: walletName, walletsRaw,
    infoRaw: infoSnapshot(allInfo, walletName), key: vault.getKeyPair(0), index: selectedAddressIndex,
    count: Math.max(info.maxAddressIndex, info.labelAddressCount || 1, maxAddressIndex, selectedAddressIndex + 1),
    baseAddress, lastWallet: bases.length === 1,
    sharedNames: Object.freeze(bases.filter((item) => item.name !== walletName && item.address === baseAddress).map((item) => item.name)),
    isCurrent });
  assertCurrent(captured);
  return captured;
};

const prepareWalletRemoval = async (captured) => {
  const addresses = [];
  // Last-wallet deletion can remove the whole label map. A retained same-seed
  // import owns every derived address, even if its recorded count is smaller.
  const count = captured.lastWallet || captured.sharedNames.length ? 1 : captured.count;
  for (let index = 0; index < count; index += 1) {
    assertCurrent(captured);
    // The pinned SDK resolves its derivation promises synchronously. Yield a
    // browser task between small batches so Cancel/navigation can actually run.
    if (index % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    assertCurrent(captured);
    // Do not use vault.getAddress(): its base implementation writes an async
    // cache after derivation and could contaminate a replacement vault.
    const pair = vault.getKeyPair(index);
    const value = address((await pair.getAddress()).toString());
    assertCurrent(captured);
    if (index === 0 && value !== captured.baseAddress) throw changed();
    addresses.push(value);
  }
  return Object.freeze({ captured, addresses: Object.freeze(addresses) });
};

const writeMap = (key, value) => {
  if (Object.keys(value).length) localStorage.setItem(key, JSON.stringify(value));
  else localStorage.removeItem(key);
};

// No await between the final guard and these local writes. Read global metadata
// afresh so unrelated changes during derivation survive. localStorage is not a
// multi-key transaction: failures keep the encrypted wallet available for retry.
const commitWalletRemoval = ({ captured, addresses }) => {
  assertCurrent(captured);
  const wallets = readMap(walletStorageKey), allInfo = readMap(keys.addressInfo), labels = readMap(keys.labels);
  if (!Object.values(labels).every((label) => typeof label === 'string')) throw invalid();
  const lastName = localStorage.getItem(keys.lastWalletName);
  const nextLabels = captured.lastWallet ? {} : { ...labels };
  if (!captured.sharedNames.length) for (const value of addresses) delete nextLabels[value];
  // Transfer label ownership knowledge without changing a retained import's
  // visible address count/selection. Otherwise its later deletion could orphan
  // higher-index labels that this removal correctly preserved as shared.
  for (const name of captured.sharedNames) {
    const info = infoFor(allInfo, name);
    Object.defineProperty(allInfo, name, { enumerable: true, configurable: true, writable: true,
      value: { ...info, labelAddressCount: Math.max(info.labelAddressCount || 1, info.maxAddressIndex, captured.count) } });
  }
  delete allInfo[captured.name];
  delete wallets[captured.name];
  assertCurrent(captured);
  // Labels first: never discard the derivation inventory while known labels
  // still need removal. Encrypted keyfile last: every earlier failure is retryable.
  if (JSON.stringify(nextLabels) !== JSON.stringify(labels)) writeMap(keys.labels, nextLabels);
  if (captured.infoRaw !== null || captured.sharedNames.length) writeMap(keys.addressInfo, allInfo);
  if (lastName === captured.name) localStorage.removeItem(keys.lastWalletName);
  writeMap(walletStorageKey, wallets);
};

export { captureWalletRemoval, prepareWalletRemoval, commitWalletRemoval };
