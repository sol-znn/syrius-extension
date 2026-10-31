'use strict';
// Exercise the exact workflow filter with synthetic SARIF, without CodeQL,
// repository alerts, credentials, network access or temporary files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/codeql.yml'), 'utf8');
const match = workflow.match(/jq '([\s\S]*?)' "\$file" > "\$file\.kept"/);
assert.ok(match, 'the production SARIF filter must be exercised');
const location = uri => ({ physicalLocation: { artifactLocation: { uri } } });
const vendor = location('node_modules/example/index.js');
const firstParty = location('src/example.js');
const result = (ruleId, extra = {}) => ({ ruleId, message: { text: ruleId }, locations: [vendor], ...extra });
const document = results => ({ version: '2.1.0', runs: [{ tool: { driver: { name: 'Synthetic analyzer' } }, results }] });
const filter = input => {
  const child = spawnSync('jq', [match[1]], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
};
const kept = results => filter(document(results)).runs[0].results;

test('excludes vendor-only primary locations and keeps first-party or mixed primary locations', () => {
  const own = result('own', { locations: [firstParty] });
  const mixed = result('mixed', { locations: [vendor, firstParty] });
  assert.deepEqual(kept([result('vendor'), own, mixed]), [own, mixed]);
});

for (const [name, extra] of [
  ['code flow', { codeFlows: [{ threadFlows: [{ locations: [{ location: firstParty }, { location: vendor }] }] }] }],
  ['related location', { relatedLocations: [firstParty] }],
  ['stack frame', { stacks: [{ frames: [{ location: firstParty }] }] }],
]) {
  test(`keeps a vendor primary location with a first-party ${name}`, () => {
    const finding = result(name, extra);
    assert.deepEqual(kept([finding]), [finding]);
  });
}

test('still excludes results whose primary, related, code-flow and stack locations are all vendor-only', () => {
  assert.deepEqual(kept([result('vendor paths', {
    relatedLocations: [vendor],
    codeFlows: [{ threadFlows: [{ locations: [{ location: vendor }] }] }],
    stacks: [{ frames: [{ location: vendor }] }],
  })]), []);
});

test('keeps missing, indirect and unclassified primary locations', () => {
  const findings = [
    result('missing primary', { locations: undefined }),
    result('empty primary', { locations: [] }),
    result('indirect artifact', { locations: [{ physicalLocation: { artifactLocation: { index: 0 } } }] }),
    result('unclassified URI', { locations: [location('file:///workspace/node_modules/example/index.js')] }),
  ];
  assert.deepEqual(kept(findings), JSON.parse(JSON.stringify(findings)));
});

test('keeps unresolved secondary locations instead of assuming they belong to a vendor', () => {
  const findings = [
    result('indirect related', { relatedLocations: [{ physicalLocation: { artifactLocation: { index: 0 } } }] }),
    result('cached flow', { codeFlows: [{ threadFlows: [{ locations: [{ index: 0 }] }] }] }),
    result('unknown stack', { stacks: [{ frames: [{ location: {} }] }] }),
  ];
  assert.deepEqual(kept(findings), findings);
});

test('preserves retained results, run metadata and ordering without changing unrelated SARIF data', () => {
  const first = result('path result', {
    codeFlows: [{ threadFlows: [{ locations: [{ location: firstParty }, { location: vendor }] }] }],
    partialFingerprints: { primaryLocationLineHash: 'synthetic-fingerprint' },
  });
  const second = result('own', { locations: [firstParty] });
  const input = document([first, result('excluded'), second]);
  input.runs[0].tool.driver.rules = [{ id: 'path result', shortDescription: { text: 'Synthetic rule' } }];
  input.runs[0].automationDetails = { id: '/language/javascript-typescript/' };
  input.runs.push(document([]).runs[0]);
  const expected = structuredClone(input);
  expected.runs[0].results = [first, second];
  assert.deepEqual(filter(input), expected);
});
