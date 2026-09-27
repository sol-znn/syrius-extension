import { KeyStoreManager } from 'znn-ts-sdk';

// `receiveAllBlocks` moved to services/wallet/account.js, where it is bounded
// and reports progress. The address bookkeeping moved to services/utils/storage.js,
// which validates what it reads back. What is left here is the small stuff that
// belongs to no particular screen.

const arrayShuffle = (array) => {
  const result = [...array];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
};

// The SDK's own `KeyStoreManager.saveKeyStore` mangles the name it is given —
// `name.replace(" ", "-")` swaps only the *first* space, not every one —
// before using it as the storage key. A wallet name typed with a space then
// saves under one key and gets looked up under another the moment the wallet
// tries to unlock itself right after creating or importing it, which fails
// with "Given keyFile does not exist" on a perfectly valid wallet. Doing the
// full replacement ourselves before the name ever reaches the SDK leaves its
// own replace with nothing to do, so save and lookup agree on the same key.
const sanitizeWalletName = (name) => (name || '').trim().replace(/\s+/g, '-');

const loadStorageWalletNames = () => {
  try {
    return Object.keys(new KeyStoreManager().listAllKeyStores() || {});
  } catch (err) {
    return [];
  }
};

// Removing a wallet.
//
// The SDK's KeyStoreManager can create and read key stores but has no way to
// delete one, so this reaches the storage key it owns directly rather than
// leaving people with no way to get a wallet off a shared machine. Desktop
// Syrius has had this since the beginning.
const walletStorageKey = 'znn.ts-wallet';

export {
  arrayShuffle,
  loadStorageWalletNames,
  sanitizeWalletName,
  walletStorageKey,
};
