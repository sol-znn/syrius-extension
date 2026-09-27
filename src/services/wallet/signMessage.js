import vault from './vault';
import requestSigningKey from './requestSigningKey';

// Signing a message with the account's key, rather than signing a block with it.
//
// Desktop Syrius exposes exactly this over WalletConnect as `znn_sign`: the
// message bytes are signed directly with the account's Ed25519 key, and what
// comes back is the signature and the public key, both hex
// (`lib/utils/functions.dart`, `walletSign`). The same bytes and the same
// encoding are used here, so a signature this extension makes verifies against
// anything already written to check a desktop one, and vice versa.
//
// Two deliberate differences from desktop, both noted where they happen: the
// message is encoded as UTF-8, and one message length is refused outright.

// Desktop passes `message.codeUnits` — UTF-16 code units narrowed to bytes,
// which silently mangles anything outside Latin-1 and is not a byte sequence
// any other tool would reproduce from the same string. UTF-8 is what every
// verifier reaches for and agrees with desktop for the ASCII messages that
// login challenges and proofs of ownership are actually made of.
//
// A `Uint8Array` rather than a `Buffer`, deliberately. `KeyPair.sign` hands the
// message straight to noble-ed25519, which takes either — and `Buffer` is not
// actually a global in this bundle: package.json maps `buffer` to `false` for
// this package's own modules, so webpack's ProvidePlugin leaves the identifier
// undefined here and `Buffer.from` throws where nothing would explain why.
const encodeMessage = (message) => new TextEncoder().encode(message);

// An account block is signed over its hash, and that hash is 32 bytes of
// SHA3-256: `BlockUtils._getTransactionSignature` signs `hash.getBytes()` and
// nothing else. Raw message signing with the same key therefore has one hole in
// it — a site that can get 32 arbitrary bytes signed can get a *transaction*
// signed, by sending the hash of a block it built itself and publishing the
// answer as that block. Nothing in the request would look like a transfer.
//
// Prefixing the message the way Ethereum's `personal_sign` does would close it
// too, but it would also mean nothing this wallet signs can be verified by
// anything written for desktop Syrius, which is the point of matching it. So
// the bytes stay raw and the single length that could be a block hash is
// refused instead. It costs the ability to sign a 32-byte message and buys back
// the only forgery raw signing allows.
const blockHashLength = 32;

// A page can send whatever it likes, and the request is held in
// `chrome.storage.session` until somebody answers it. This is far past any
// message a person would be asked to read and approve.
const maxMessageLength = 8192;

const bytesToHex = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

// Why a message cannot be signed, or null when it can. Separate from signing so
// the screens can disable a button and say why rather than only failing on the
// press.
const messageProblem = (message) => {
  if (typeof message !== 'string' || message.length === 0) {
    return 'There is no message to sign.';
  }
  if (message.length > maxMessageLength) {
    return `A message can be at most ${maxMessageLength} characters.`;
  }
  if (encodeMessage(message).length === blockHashLength) {
    return (
      'This message is exactly 32 bytes long, the size of an account block ' +
      'hash, so signing it could produce a valid transaction signature. Add ' +
      'or remove a character.'
    );
  }
  return null;
};

// Signs with the selected address unless told otherwise. A site never gets to
// choose the address: it asked the wallet to sign, and the wallet signs as
// whoever the person has selected.
const signMessage = async (message, { addressIndex, assertRequest } = {}) => {
  const problem = messageProblem(message);

  if (problem) {
    throw new Error(problem);
  }
  await assertRequest?.();
  const keyPair = requestSigningKey(await vault.getSigningKeyPair(addressIndex), assertRequest);
  await assertRequest?.();
  const [signature, publicKey, address] = await Promise.all([
    keyPair.sign(encodeMessage(message)),
    keyPair.getPublicKey(),
    keyPair.getAddress(),
  ]);

  await assertRequest?.();
  return {
    message,
    address: address.toString(),
    publicKey: bytesToHex(publicKey),
    signature: bytesToHex(signature),
  };
};

export { signMessage, messageProblem, maxMessageLength };
export default signMessage;
