const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'syrius-validation-gates-'));
const compilerStub = path.join(scratch, 'compiler-stub.cjs');

// Exercise the real build entry point in a separate process. Only the compiler
// boundary is inert; assertions observe the process exit and its diagnostics.
fs.writeFileSync(compilerStub, `
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../webpack.config') return {};
  if (request === 'webpack') {
    return (config, callback) => {
      const scenario = process.env.SYRIUS_TEST_BUILD_CASE;
      if (scenario === 'fatal') {
        callback(new Error('fixture compiler failure'));
        return;
      }
      callback(null, {
        hasErrors: () => scenario === 'errors',
        hasWarnings: () => scenario === 'warnings',
        toString: () => 'fixture compiler diagnostics',
      });
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
`);

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const run = (args, env = {}) => {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
};

const runBuild = (scenario) => run(
  ['--require', compilerStub, 'utils/build.js'],
  { SYRIUS_TEST_BUILD_CASE: scenario },
);

test('fatal compiler errors fail the build process', () => {
  const result = runBuild('fatal');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fixture compiler failure/);
  assert.doesNotMatch(result.stdout, /Build completed successfully/);
});

test('compilation errors fail the build process', () => {
  const result = runBuild('errors');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Build errors/);
  assert.doesNotMatch(result.stdout, /Build completed successfully/);
});

test('warnings alone do not fail a successful build', () => {
  const result = runBuild('warnings');
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Build warnings/);
  assert.match(result.stdout, /Build completed successfully/);
});

test('a clean compilation completes successfully', () => {
  const result = runBuild('clean');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Build completed successfully/);
});

test('missing ABI source fails instead of skipping the comparator', () => {
  const result = run(['utils/contract-calls-test.js'], {
    GO_ZENON_ABI_DIR: path.join(scratch, 'missing'),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ABI definitions are required/);
  assert.doesNotMatch(result.stdout, /skipping/);
});

test('an empty ABI source cannot produce a passing zero-method check', () => {
  const empty = path.join(scratch, 'empty');
  fs.mkdirSync(empty);
  for (const name of [
    'plasma', 'pillars', 'stake', 'sentinel', 'token', 'htlc', 'liquidity',
    'accelerator', 'swap', 'bridge', 'spork',
  ]) {
    fs.writeFileSync(path.join(empty, `${name}.go`), 'package definition\n');
  }
  const result = run(['utils/contract-calls-test.js'], { GO_ZENON_ABI_DIR: empty });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No ABI functions found/);
});

test('the configured Go ABI source runs the real decoder comparison', () => {
  const result = run(['utils/contract-calls-test.js']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\d+\/[1-9]\d* of go-zenon's embedded methods decode correctly/);
  assert.doesNotMatch(result.stdout, /skipping/);
});
