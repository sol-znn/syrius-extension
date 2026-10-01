import { Primitives, Zenon, utils as sdkUtils } from 'znn-ts-sdk';
import { getCurrentNodeUrl } from '../utils/storage';
import { runApprovalOperation } from './approvalOperation';
import { authorizationMetadata, normalizeBaseUnits } from './tokenMetadata';
import vault from './vault';

// An arbitrary block is prepared once, for review, and that preparation is
// what gets signed.
//
// The SDK's send fills in the chain, height, previous hash and momentum
// reference itself. Doing that a second time at submission meant the block
// signed was not the block shown: another block landing on the account in
// between moved the height and the references, silently. So the reviewed
// block is frozen, the approval is disabled until it exists, and submission
// runs only the remaining stages — plasma, proof of work, hash and signature,
// publication — checking the reviewed fields around every one of them. A
// changed account frontier is the node's to reject, never ours to rebase.
//
// A preparation belongs to one live context: the approval's wallet account,
// this window's key handles, the chain and node it was made against. Any of
// those changing makes it stale. It can be sent once (see beginPreparedSend);
// the worker's claim makes it once across windows too.
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
// Browser-native: the app's Buffer polyfill is not in every bundle.
const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const base64ToBytes = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
const changed = () => new Error('This approval is no longer current. Review a new request.');

// `address` and `index` are the approval's bound account; `expiresAt` and
// `signal` bound the preparation's node calls (approvalOperation).
const prepareBlockApproval = async (params, { address, index = vault.getSelectedIndex(), nodeUrl, isCurrent, expiresAt, signal }) => {
  const zenon = Zenon.getSingleton();
  const binding = vault.getBinding();
  const keyPair = vault.getKeyPair(index);
  const walletName = vault.getWalletName();
  const chain = Zenon.getChainIdentifier();
  const socket = zenon.wsClient;
  const ledgerClient = zenon.ledger.client;
  const plasmaClient = zenon.embedded.plasma.client;
  const storedNode = getCurrentNodeUrl();
  const assertCurrent = () => {
    if (!isCurrent() || !vault.isUnlocked() || vault.getWalletName() !== walletName ||
        vault.getBinding() !== binding || vault.getKeyPair(index) !== keyPair ||
        Zenon.getChainIdentifier() !== chain || getCurrentNodeUrl() !== storedNode ||
        zenon.wsClient !== socket || zenon.ledger.client !== ledgerClient ||
        zenon.embedded.plasma.client !== plasmaClient) {
      throw changed();
    }
  };
  assertCurrent();
  // Copy request data before the first await; never retain caller-owned
  // fields. Token identity and amount go through the canonical metadata path:
  // the amount is exact base units, never reinterpreted by RPC token metadata.
  const copied = JSON.parse(JSON.stringify(params));
  if (copied.tokenStandard !== undefined) authorizationMetadata(copied.tokenStandard);
  if (params.amount !== undefined) copied.amount = normalizeBaseUnits(params.amount);
  const template = Primitives.AccountBlockTemplate.fromJson(copied);
  const fill = (context) => sdkUtils.BlockUtils._checkAndSetFields(context, template, keyPair);
  const prepared = Number.isFinite(expiresAt)
    ? await runApprovalOperation(expiresAt, (active) => fill(active.context(zenon)), { signal })
    : await fill(zenon);
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

// Consumes the approval — before any key lookup or other await, so two
// callers cannot both send it — and rebuilds the reviewed template.
// `assertFields` re-checks that the template still carries exactly the
// reviewed fields; `verifyKey` that the signing key is the one reviewed.
const beginPreparedSend = (approval) => {
  if (!isCurrentBlockApproval(approval)) throw changed();
  consumed.add(approval);
  const { block, details, assertCurrent } = approval;
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
  const verifyKey = async (key) => {
    const [address, publicKey] = await Promise.all([key.getAddress(), key.getPublicKey()]);
    assertFields();
    if (address.toString() !== block.address || bytesToBase64(publicKey) !== block.publicKey) throw changed();
  };
  assertFields();
  return Object.freeze({ template, assertFields, verifyKey });
};

export { prepareBlockApproval, isCurrentBlockApproval, beginPreparedSend };
