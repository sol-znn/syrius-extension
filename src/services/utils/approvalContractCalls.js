/* global BigInt */
import { Primitives } from 'znn-ts-sdk';
import abi from './contractCallSchemas.json';
import { selectorOf, contractDisplayName, describeCall } from './contractCalls';

// This approval decoder is intentionally separate from the selector-only
// transaction-history API. Known means every argument was decoded exactly.
// Schemas/addresses: go-zenon at the revision retained in contractCallSchemas.
const contracts = Object.fromEntries(Object.entries(abi.contracts).map(([name, contract]) => [contract.address, {
  name,
  methods: Object.fromEntries(contract.methods.map(method => [
    selectorOf(`${method.name}(${method.inputs.map(input => input.type).join(',')})`), method,
  ])),
}]));
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const uint = bytes => BigInt('0x' + hex(bytes));
const invalid = () => { throw new Error('Unsupported or noncanonical contract arguments'); };
const labels = {
  address: 'Plasma beneficiary', id: 'Request ID', name: 'Name', description: 'Description', url: 'URL',
  producerAddress: 'Producer address', rewardAddress: 'Reward address',
  giveBlockRewardPercentage: 'Block reward share (%)', giveDelegateRewardPercentage: 'Delegate reward share (%)',
  publicKey: 'Public key', signature: 'Signature', durationInSec: 'Duration (seconds)',
  tokenName: 'Token name', tokenSymbol: 'Token symbol', tokenDomain: 'Token domain',
  totalSupply: 'Total supply (base units)', maxSupply: 'Maximum supply (base units)', decimals: 'Token decimals',
  isMintable: 'Minting enabled', isBurnable: 'Burning enabled', isUtility: 'Utility token',
  tokenStandard: 'Token ID', amount: 'Amount (base units)', receiveAddress: 'Recipient', owner: 'New token owner',
  hashLocked: 'Hash-lock beneficiary', expirationTime: 'Expiry (Unix seconds)', hashType: 'Hash algorithm code',
  keyMaxSize: 'Maximum key size (bytes)', hashLock: 'Hash lock', preimage: 'Unlock preimage',
  znnReward: 'ZNN rewards (base units)', qsrReward: 'QSR rewards (base units)', burnAmount: 'ZNN to burn (base units)',
  znnFundsNeeded: 'ZNN requested (base units)', qsrFundsNeeded: 'QSR requested (base units)', vote: 'Vote code',
  networkClass: 'Network class', chainId: 'Chain ID', toAddress: 'Recipient', transactionHash: 'Transaction hash',
  logIndex: 'Log index', tokenAddress: 'Remote token address',
  tokenStandards: 'Token IDs (ordered list)', znnPercentages: 'ZNN reward shares (basis points, ordered list)',
  qsrPercentages: 'QSR reward shares (basis points, ordered list)', minAmounts: 'Minimum amounts (base units, ordered list)',
  guardians: 'Guardian addresses', administrator: 'New administrator', isHalted: 'Halted',
  contractAddress: 'Remote contract address', metadata: 'Metadata', bridgeable: 'Bridging enabled',
  redeemable: 'Redemption enabled', owned: 'Bridge-owned token', minAmount: 'Minimum amount (base units)',
  feePercentage: 'Fee (basis points)', redeemDelay: 'Redemption delay (momentums)',
  pubKey: 'New TSS ECDSA public key', oldPubKeySignature: 'Current key signature', newPubKeySignature: 'New key signature',
  allowKeyGen: 'Key generation enabled', windowSize: 'Signing window (momentums)',
  keyGenThreshold: 'Key generation participant threshold', confirmationsToFinality: 'Confirmations to finality (momentums)',
  estimatedMomentumTime: 'Estimated momentum time (protocol value)',
};
// Quotes preserve empty strings and whitespace. Formatting controls are escaped
// visibly, including a leading BOM, rather than changing the apparent value.
const displayString = text => JSON.stringify(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
  char => Array.from({ length: char.length }, (_, index) => '\\u' + char.charCodeAt(index).toString(16).padStart(4, '0')).join(''));
// All 77 pinned methods use scalar words, strings/bytes, or these one-level
// arrays. Offsets must describe sequential, non-overlapping canonical tails.
const dynamic = type => type === 'string' || type === 'bytes' || type.endsWith('[]');
const decodeScalar = (word, type) => {
  if (/^uint(?:8|32|64|256)$/.test(type)) {
    const number = uint(word), bits = BigInt(type.slice(4));
    if (number >= 1n << bits) return invalid();
    return number.toString();
  }
  if (type === 'int64') {
    const number = uint(word), signed = number & (1n << 255n) ? number - (1n << 256n) : number;
    if (signed < -(1n << 63n) || signed >= 1n << 63n) return invalid();
    return signed.toString();
  }
  if (type === 'bool') {
    const number = uint(word); if (number > 1n) return invalid();
    return number === 1n ? 'true' : 'false';
  }
  if (type === 'hash') return hex(word);
  if (type === 'address' || type === 'tokenStandard') {
    const size = type === 'address' ? 20 : 10;
    if (word.slice(0, 32 - size).some(byte => byte !== 0)) return invalid();
    const core = word.slice(32 - size);
    return type === 'address' ? new Primitives.Address('z', core).toString() : new Primitives.TokenStandard(core).toString();
  }
  return invalid();
};
const decodeTail = (bytes, type) => {
  if (bytes.length < 32) return invalid();
  const length = uint(bytes.slice(0, 32)), content = bytes.slice(32);
  if (type.endsWith('[]')) {
    const element = type.slice(0, -2);
    if (!['string', 'uint32', 'uint256', 'address'].includes(element) || length > BigInt(Math.floor(content.length / 32))) return invalid();
    const decoded = decodeValues(content, Array.from({ length: Number(length) }, () => element));
    return { value: Object.freeze(decoded.values), size: 32 + decoded.size };
  }
  if (type !== 'string' && type !== 'bytes') return invalid();
  if (length > BigInt(content.length)) return invalid();
  const size = Number(length), padded = Math.ceil(size / 32) * 32;
  if (padded > content.length || content.slice(size, padded).some(byte => byte !== 0)) return invalid();
  const value = type === 'bytes' ? '0x' + hex(content.slice(0, size)) : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content.slice(0, size));
  return { value, size: 32 + padded };
};
const decodeValues = (bytes, types) => {
  if (bytes.length < types.length * 32 || bytes.length % 32) return invalid();
  let end = types.length * 32;
  const values = types.map((type, index) => {
    const word = bytes.slice(index * 32, (index + 1) * 32);
    if (!dynamic(type)) return decodeScalar(word, type);
    if (uint(word) !== BigInt(end)) return invalid();
    const decoded = decodeTail(bytes.slice(end), type);
    end += decoded.size;
    return decoded.value;
  });
  return { values, size: end };
};
const displayValue = (type, value) => {
  if (type.endsWith('[]')) return value.length ? value.map((entry, index) =>
    `${index + 1}. ${type === 'string[]' ? displayString(entry) : entry}`).join('\n') : '(empty list)';
  return type === 'string' ? displayString(value) : value;
};
const decodeArguments = (bytes, method) => {
  const decoded = decodeValues(bytes, method.inputs.map(input => input.type));
  if (decoded.size !== bytes.length) return invalid();
  return Object.freeze(method.inputs.map(({ name, type }, index) => {
    const value = decoded.values[index];
    const label = name === 'address' && method.name === 'ProposeAdministrator' ? 'Proposed administrator' : labels[name] || name;
    return Object.freeze({ name, type, value, label, display: displayValue(type, value) });
  }));
};
const actions = {
  SetTokenTuple: 'Set liquidity token rewards', NominateGuardians: 'Nominate guardians',
  ProposeAdministrator: 'Propose administrator', ChangeAdministrator: 'Change administrator',
  Emergency: 'Enter emergency mode', SetIsHalted: 'Set halt state', SetAdditionalReward: 'Set additional rewards',
  SetNetwork: 'Set bridge network', RemoveNetwork: 'Remove bridge network',
  SetTokenPair: 'Set bridge token pair', RemoveTokenPair: 'Remove bridge token pair',
  SetNetworkMetadata: 'Set network metadata', Halt: 'Halt bridge', Unhalt: 'Unhalt bridge',
  ChangeTssECDSAPubKey: 'Change TSS ECDSA public key', SetAllowKeyGen: 'Set key generation permission',
  SetRedeemDelay: 'Set redemption delay', SetBridgeMetadata: 'Set bridge metadata', SetOrchestratorInfo: 'Set orchestrator parameters',
};

const decodeApprovalCall = json => {
  let contract;
  try {
    const address = Primitives.Address.parse(json.toAddress);
    const destination = address.toString();
    contract = contracts[destination];
    const unknown = { kind: 'unknownCall', contract: contract ? contractDisplayName(contract.name) : 'unrecognized', to: destination };
    if (json.blockType !== 2) return unknown;
    const binary = atob(json.data || '');
    if (btoa(binary) !== (json.data || '')) return unknown;
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (!contract) return address.getBytes()[0] === 0 && bytes.length === 0 ? { kind: 'transfer', to: destination } : unknown;
    if (bytes.length < 4) return unknown;
    const method = contract.methods[hex(bytes.slice(0, 4))];
    if (!method) return unknown;
    const args = decodeArguments(bytes.slice(4), method);
    return Object.freeze({ kind: 'knownCall', contract: contractDisplayName(contract.name), to: destination,
      method: method.name, label: actions[method.name] || describeCall(contract.name, method.name), args });
  } catch (error) {
    return { kind: 'unknownCall', contract: contract ? contractDisplayName(contract.name) : 'unrecognized', to: json?.toAddress };
  }
};
export { decodeApprovalCall, displayString };
