// Everything this wallet keeps on disk, in one place.
//
// The keys were spread across a dozen files as bare `localStorage.getItem`
// calls with the name spelled out each time and no agreement on what a missing
// or corrupt value meant — `JSON.parse(localStorage.getItem("addressInfo"))`
// throws on a truncated write and returns null on a missing one, and different
// callers handled one case or the other but never both.
//
// The encrypted keystore itself is not here: the SDK owns `znn.ts-wallet` and
// `znn.ts-chainId` through its own StorageController, and this module never
// touches key material.

const keys = {
  nodeList: 'nodeList',
  currentNodeUrl: 'currentNodeUrl',
  addressInfo: 'addressInfo',
  labels: 'syrius.addressLabels',
  settings: 'syrius.settings',
  lastWalletName: 'syrius.lastWalletName',
};

const readJson = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === undefined) {
      return fallback;
    }
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (err) {
    // A corrupt value is not worth taking a screen down for; the wallet falls
    // back to the default and overwrites it on the next write.
    return fallback;
  }
};

const writeJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    return false;
  }
};

//
// Node list
//
const defaultNodes = [
  'wss://my.hc1node.com:35998',
  'wss://node.zenonhub.io:35998',
  'wss://secure.deeznnodez.com:35998',
  'ws://127.0.0.1:35998',
];

const getNodeList = () => {
  const stored = readJson(keys.nodeList, null);
  return Array.isArray(stored) && stored.length ? stored : [...defaultNodes];
};

const setNodeList = (nodes) => writeJson(keys.nodeList, nodes);

// The node the wallet connects to before anyone has ever picked one.
const defaultNodeUrl = defaultNodes[0];

const getCurrentNodeUrl = () => localStorage.getItem(keys.currentNodeUrl) || null;

const setCurrentNodeUrl = (url) => localStorage.setItem(keys.currentNodeUrl, url);

// Which wallet unlocked last, so the unlock screen can default to it instead
// of an empty dropdown. Unlike `services/wallet/session.js`, this survives the
// session expiring or the browser closing — it is exactly what is still
// around on the screen that asks for a password again.
const getLastWalletName = () => localStorage.getItem(keys.lastWalletName) || null;

const setLastWalletName = (walletName) => {
  if (walletName) {
    localStorage.setItem(keys.lastWalletName, walletName);
  }
};

//
// Per-wallet address bookkeeping: which index is selected and how many have
// been derived.
//
const defaultSelectedAddressIndex = 0;
const defaultMaxAddressIndex = 1;

const getAddressInfo = (walletName) => {
  const all = readJson(keys.addressInfo, {});
  const entry = all[walletName];

  // `selectedAddressIndex` is legitimately 0, so this cannot test truthiness —
  // the old code did, and reset any wallet sitting on its first address back to
  // defaults on every read.
  if (
    !entry ||
    !Number.isInteger(entry.selectedAddressIndex) ||
    !Number.isInteger(entry.maxAddressIndex) ||
    entry.maxAddressIndex < 1
  ) {
    return {
      selectedAddressIndex: defaultSelectedAddressIndex,
      maxAddressIndex: defaultMaxAddressIndex,
    };
  }
  return {
    selectedAddressIndex: Math.min(entry.selectedAddressIndex, entry.maxAddressIndex - 1),
    maxAddressIndex: entry.maxAddressIndex,
  };
};

const setAddressInfo = (walletName, info) => {
  const all = readJson(keys.addressInfo, {});
  // A same-seed import can inherit knowledge of labels beyond its visible
  // account list. Keep that deletion inventory across selection/count writes.
  const previous = Object.prototype.hasOwnProperty.call(all, walletName) ? all[walletName] : null;
  const hasLabelCount = previous && Object.prototype.hasOwnProperty.call(previous, 'labelAddressCount');
  if (hasLabelCount && (!Number.isSafeInteger(previous.labelAddressCount) ||
    previous.labelAddressCount < 1 || previous.labelAddressCount > 0x80000000)) return false;
  const next = { ...all, [walletName]: {
    selectedAddressIndex: info.selectedAddressIndex,
    maxAddressIndex: info.maxAddressIndex,
    ...(hasLabelCount ? { labelAddressCount: Math.max(previous.labelAddressCount, info.maxAddressIndex) } : {}),
  } };
  return writeJson(keys.addressInfo, next);
};

const forgetAddressInfo = (walletName) => {
  const all = readJson(keys.addressInfo, {});
  delete all[walletName];
  return writeJson(keys.addressInfo, all);
};

//
// Address labels. Desktop Syrius lets an account be named; a list of
// indistinguishable z1q… strings is the main reason the address picker is hard
// to use. Keyed by address so a label survives re-deriving.
//
const getLabels = () => readJson(keys.labels, {});

const getLabel = (address) => getLabels()[address] || '';

const setLabel = (address, label) => {
  const all = getLabels();
  const trimmed = (label || '').trim().slice(0, 24);

  if (trimmed) {
    all[address] = trimmed;
  } else {
    delete all[address];
  }
  return writeJson(keys.labels, all);
};

//
// Settings
//
const defaultSettings = {
  // Minutes of inactivity before the wallet locks itself. The old build cached
  // the password for a fixed hour with no way to change it and no way to know.
  autoLockMinutes: 15,
  // Whether the dashboard should receive pending blocks on its own. It always
  // did, silently, and that is a transaction the user did not ask for — it
  // costs plasma and can block the screen on proof of work.
  autoReceive: true,
  // Hide balances, for using the wallet in public.
  hideBalances: false,
  // Which block explorer the history links to. See services/utils/explorer.js.
  explorer: 'zenonhub',
};

const getSettings = () => ({ ...defaultSettings, ...readJson(keys.settings, {}) });

const setSetting = (key, value) => {
  const next = { ...getSettings(), [key]: value };
  if (!writeJson(keys.settings, next)) throw new Error('Could not save settings. Try again.');
  return next;
};

export {
  keys,
  defaultNodes,
  defaultNodeUrl,
  defaultSettings,
  defaultSelectedAddressIndex,
  defaultMaxAddressIndex,
  getNodeList,
  setNodeList,
  getCurrentNodeUrl,
  setCurrentNodeUrl,
  getLastWalletName,
  setLastWalletName,
  getAddressInfo,
  setAddressInfo,
  forgetAddressInfo,
  getLabels,
  getLabel,
  setLabel,
  getSettings,
  setSetting,
};
