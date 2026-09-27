import { Primitives, Zenon, utils as sdkUtils } from 'znn-ts-sdk';
import { getCurrentNodeUrl } from '../utils/storage';
import vault from './vault';

const consumed = new WeakSet();
const computedFields = new Set(['hash', 'signature', 'fusedPlasma', 'difficulty', 'nonce']);
const approvalFields = (json) => Object.fromEntries(
  Object.entries(json).filter(([name]) => !computedFields.has(name))
);
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const base64ToBytes = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
const changed = () => new Error('This approval is no longer current. Review a new request.');

// Capture the local vault lifetime by its memoized derivation handle. Lock or
// adoption clears that handle, even if the same wallet is unlocked again.
const prepareBlockApproval = async (params, { address, nodeUrl, isCurrent }) => {
  const zenon = Zenon.getSingleton();
  const index = vault.getSelectedIndex();
  const walletName = vault.getWalletName();
  const keyPair = vault.getKeyPair(index);
  const chain = Zenon.getChainIdentifier();
  const socket = zenon.wsClient;
  const ledgerClient = zenon.ledger.client;
  const plasmaClient = zenon.embedded.plasma.client;
  const storedNode = getCurrentNodeUrl();
  const assertCurrent = () => {
    if (!isCurrent() || !vault.isUnlocked() || vault.getWalletName() !== walletName ||
        vault.getSelectedIndex() !== index || vault.getKeyPair(index) !== keyPair ||
        Zenon.getChainIdentifier() !== chain || getCurrentNodeUrl() !== storedNode ||
        zenon.wsClient !== socket || zenon.ledger.client !== ledgerClient ||
        zenon.embedded.plasma.client !== plasmaClient) {
      throw changed();
    }
  };
  assertCurrent();
  // Copy request data before the first await; never retain caller-owned fields.
  const template = Primitives.AccountBlockTemplate.fromJson(JSON.parse(JSON.stringify(params)));
  const prepared = await sdkUtils.BlockUtils._checkAndSetFields(zenon, template, keyPair);
  assertCurrent();
  if (prepared.address.toString() !== address) {
    throw changed();
  }
  const block = freeze(JSON.parse(JSON.stringify(prepared.toJson())));
  return Object.freeze({
    block,
    details: freeze(approvalFields(block)),
    nodeUrl,
    index,
    assertCurrent,
  });
};

const isCurrentBlockApproval = (approval) => {
  if (!approval || consumed.has(approval)) return false;
  try {
    approval.assertCurrent();
    return true;
  } catch (err) {
    return false;
  }
};

const sendBlockApproval = async (approval, onPow) => {
  if (!isCurrentBlockApproval(approval)) throw changed();
  // React state updates are asynchronous. Consume before key lookup or any
  // other await so two calls cannot send the same approval twice.
  consumed.add(approval);
  const { block, details, assertCurrent, index } = approval;
  const zenon = Zenon.getSingleton();
  const keyPair = await vault.getSigningKeyPair(index);
  assertCurrent();
  const [address, publicKey] = await Promise.all([keyPair.getAddress(), keyPair.getPublicKey()]);
  assertCurrent();
  if (address.toString() !== block.address || bytesToBase64(publicKey) !== block.publicKey) {
    throw changed();
  }
  // The SDK's fromJson does not decode the base64 emitted by toJson for key
  // bytes. Preserve them explicitly when copying the reviewed preparation.
  const template = Primitives.AccountBlockTemplate.fromJson({
    ...block,
    publicKey: base64ToBytes(block.publicKey),
    signature: new Uint8Array(),
  });
  const assertFields = () => {
    assertCurrent();
    if (JSON.stringify(approvalFields(template.toJson())) !== JSON.stringify(details)) throw changed();
  };
  assertFields();
  // zenon.send would autofill again, changing the displayed chain references.
  // Keep that preparation and run only the remaining SDK stages. If another
  // block advances this account, the node may reject it; never silently rebase.
  await sdkUtils.BlockUtils._setDifficulty(zenon, template, onPow);
  assertFields();
  const guardedKey = {
    sign: async (bytes) => {
      assertFields();
      const signature = await keyPair.sign(bytes);
      assertFields();
      return signature;
    },
  };
  await sdkUtils.BlockUtils._setHashAndSignature(template, guardedKey);
  assertFields();
  await zenon.ledger.publishRawTransaction(template);
  return template;
};

export { prepareBlockApproval, isCurrentBlockApproval, sendBlockApproval };
