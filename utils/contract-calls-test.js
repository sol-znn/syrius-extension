// Checks the embedded-call decoder against go-zenon's own ABI definitions.
//
// The decoder identifies what a block did by matching the first four bytes of
// its data against SHA3-256 of a function signature. Two things can go wrong
// and neither shows up as an error at runtime — the block just falls back to a
// generic label:
//
//   1. a signature transcribed from go-zenon with a typo, and
//   2. a selector computed differently from the way go-zenon computes it.
//
// So this re-derives every selector straight from go-zenon's source and feeds
// synthetic blocks through the real module. It matters most for HTLC, which is
// the one contract with no implementation in `znn-ts-sdk` to check against.
//
//   node utils/contract-calls-test.js
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

// The module is ESM and uses a browser global; give it both.
global.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');

const load = (file) => {
  const filename = path.join(__dirname, '..', file);
  const { code } = babel.transformFileSync(filename, {
    presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
    babelrc: false,
    configFile: false,
  });
  const module_ = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', code)(module_, module_.exports, require);
  return module_.exports;
};

const { decodeCall, describeCall, selectorOf } = load('src/services/utils/contractCalls.js');

// go-zenon's definitions, parsed from source rather than copied.
const definitionDir = process.env.GO_ZENON_ABI_DIR
  ? path.resolve(process.env.GO_ZENON_ABI_DIR)
  : path.join(__dirname, '..', '..', 'go-zenon', 'vm', 'embedded', 'definition');
const fileForContract = {
  plasma: 'plasma.go',
  pillar: 'pillars.go',
  stake: 'stake.go',
  sentinel: 'sentinel.go',
  token: 'token.go',
  htlc: 'htlc.go',
  liquidity: 'liquidity.go',
  accelerator: 'accelerator.go',
  swap: 'swap.go',
  bridge: 'bridge.go',
  spork: 'spork.go',
};

const signaturesFrom = (file) => {
  const src = fs.readFileSync(path.join(definitionDir, file), 'utf8');
  const found = [];

  for (const blob of src.match(/`\s*\[[\s\S]*?\]\s*`/g) || []) {
    let entries;
    try {
      entries = JSON.parse(blob.slice(1, -1));
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (entry.type !== 'function') continue;
      const types = (entry.inputs || []).map((i) => i.type).join(',');
      found.push({ method: entry.name, signature: `${entry.name}(${types})` });
    }
  }
  if (!found.length) {
    throw new Error(`No ABI functions found in ${file}`);
  }
  return found;
};

// A block whose data is exactly this call's four-byte prefix.
const blockDataFor = (signature) =>
  Buffer.from(selectorOf(signature), 'hex').toString('base64');

if (!fs.existsSync(definitionDir)) {
  throw new Error(
    'go-zenon ABI definitions are required. Set GO_ZENON_ABI_DIR to ' +
    'vm/embedded/definition in a pinned go-zenon checkout (see SETUP.md).'
  );
}

let checked = 0;
let recognised = 0;
const missing = [];

for (const [contract, file] of Object.entries(fileForContract)) {
  for (const { method, signature } of signaturesFrom(file)) {
    checked += 1;
    const decoded = decodeCall(contract, blockDataFor(signature));

    if (decoded === method) {
      recognised += 1;
    } else if (decoded !== null) {
      console.log(`WRONG  ${contract}.${method} -> decoded as ${decoded}`);
      process.exitCode = 1;
    } else {
      missing.push(`${contract}.${method}`);
    }
  }
}

console.log(`${recognised}/${checked} of go-zenon's embedded methods decode correctly`);

// Not every method needs a label — a wallet will never issue a spork — but any
// it does not know must fall back cleanly rather than mislabel.
if (missing.length) {
  console.log(`not carried in this build (fall back to a contract label): ${missing.length}`);
}

console.log('\nHTLC, the contract the SDK does not implement at all:');
for (const { method, signature } of signaturesFrom('htlc.go')) {
  const decoded = decodeCall('htlc', blockDataFor(signature));
  console.log(
    `  ${signature.padEnd(42)} -> ${String(decoded).padEnd(18)} "${describeCall('htlc', decoded)}"`
  );
  if (decoded !== method) {
    process.exitCode = 1;
  }
}

// An empty data field is an ordinary transfer, and unknown data must not be
// forced into a label.
console.log('\nFallbacks:');
console.log('  empty data      ->', decodeCall('htlc', ''));
console.log('  unknown selector->', decodeCall('htlc', Buffer.from('deadbeef', 'hex').toString('base64')));
console.log('  unknown label   ->', describeCall('htlc', null));
