'use strict';

// Native CI diagnostic, using inert fixtures and public synthetic markers.
// No SDK, production wallet, account, node, private payload or profile export.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startBrowser } = require('./fixtures/production-browser');

const key = 'syrius.qualification.persistence';
const report = { storage_lifetime_diagnostic: true, source_commit: process.env.GITHUB_SHA || null,
  node: process.version, observations: [], passed: false, historical_root_cause: 'NOT_ESTABLISHED' };
let temporary, browser, stage = 'fixture setup';

const network = stats => ({ externalResponses: stats.externalResponses,
  externalWebSocketHandshakes: stats.externalWebSocketHandshakes,
  runtimeErrors: stats.runtimeErrors, cspErrors: stats.cspErrors,
  guardFailure: stats.guardFailure, guardChecks: stats.guardChecks, shutdownClean: stats.shutdownClean });
const stop = async () => {
  const current = browser; browser = null;
  if (!current) return null;
  await current.stop();
  assert(current.stats.shutdownClean, 'Owned browser must exit normally');
  return network(current.stats);
};
const cleanup = async () => {
  try { await stop(); }
  finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    report.profile_removed = !temporary || !fs.existsSync(temporary);
  }
};

// Select only the inert fixture's numeric/boolean registration metadata.
// Never retain the raw preferences, extension ID, profile paths or checksums.
const preferences = (profileDir, extensionDir, id) => {
  const result = {};
  for (const name of ['Preferences', 'Secure Preferences']) {
    const file = path.join(profileDir, 'Default', name);
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { result[name] = { readable: false }; continue; }
    const own = value.extensions?.settings?.[id];
    result[name] = { readable: true, registration_present: Boolean(own),
      ...(own ? { creation_flags: Number.isInteger(own.creation_flags) ? own.creation_flags : null,
        installed_via_cdp: Number.isInteger(own.creation_flags) ? Boolean(own.creation_flags & (1 << 15)) : null,
        location: Number.isInteger(own.location) ? own.location : null,
        state: Number.isInteger(own.state) ? own.state : null,
        path_matches: typeof own.path === 'string' && path.resolve(own.path) === extensionDir } : {}) };
  }
  return result;
};

const writeProbe = async (page, marker) => browser.evaluate(page, `(async () => {
  const key = ${JSON.stringify(key)}, marker = ${JSON.stringify(marker)};
  localStorage.setItem(key, marker);
  await chrome.storage.local.set({ [key]: marker });
  await chrome.storage.sync.set({ [key]: marker });
  await chrome.storage.session.set({ [key]: marker });
  return true;
})()`);
const readProbe = async (page, marker) => browser.evaluate(page, `(async () => {
  const key = ${JSON.stringify(key)}, marker = ${JSON.stringify(marker)};
  const allowed = ['SecurityError', 'QuotaExceededError', 'InvalidStateError', 'SyntaxError'];
  const result = {};
  try {
    const raw = localStorage.getItem(key);
    result.dom_present = raw !== null;
    result.dom_matches = raw === marker;
    result.dom_read_error = null;
  } catch (error) {
    result.dom_read_error = allowed.includes(error.name) ? error.name : 'OTHER';
  }
  for (const area of ['local', 'sync', 'session']) {
    try {
      const raw = (await chrome.storage[area].get(key))[key];
      result[area + '_present'] = raw !== undefined;
      result[area + '_matches'] = raw === marker;
      result[area + '_read_error'] = null;
    } catch (error) { result[area + '_read_error'] = allowed.includes(error.name) ? error.name : 'OTHER'; }
  }
  return result;
})()`);

const main = async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'syrius-storage-lifetime-'));
  fs.chmodSync(temporary, 0o700);
  report.helper_sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'fixtures/production-browser.js'))).digest('hex');
  for (const prepared of [false, true]) {
    for (let round = 0; round < 3; round++) {
      stage = prepared ? 'prepared fixture startup' : 'unprepared fixture startup';
      const owned = path.join(temporary, String(Number(prepared)) + '-' + round);
      const extensionDir = path.join(owned, 'extension'), profileDir = path.join(owned, 'profile');
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, 'manifest.json'), JSON.stringify({ manifest_version: 3,
        name: 'Inert storage lifetime diagnostic', version: '1.0', permissions: ['storage'],
        background: { service_worker: 'background.js' } }));
      fs.writeFileSync(path.join(extensionDir, 'background.js'), 'chrome.runtime.onMessage.addListener(() => false);');
      fs.writeFileSync(path.join(extensionDir, 'popup.html'), '<!doctype html><title>Inert storage diagnostic</title>');
      browser = await startBrowser({ extensionDir, profileDir });
      report.browser ||= browser.browserVersion;
      assert.equal(browser.browserVersion, report.browser);
      const id = browser.id;
      const bootstrap = prepared ? await stop() : null;
      if (prepared) browser = await startBrowser({ extensionDir, profileDir, expectedExtensionId: id });
      const page = await browser.openPage();
      const marker = 'owned-public-marker-' + Number(prepared) + '-' + round;
      await writeProbe(page, marker);
      const before = await readProbe(page, marker);
      assert(before.dom_matches && before.local_matches && before.sync_matches && before.session_matches);
      const identity = fs.statSync(profileDir);
      const firstNetwork = await stop();
      const beforePreferences = preferences(profileDir, extensionDir, id);
      stage = prepared ? 'prepared fixture restart' : 'unprepared fixture restart';
      browser = await startBrowser({ extensionDir, profileDir, expectedExtensionId: id });
      const reused = browser.id === id && browser.stats.persistentInstallReused;
      const restarted = await browser.openPage();
      const after = await readProbe(restarted, marker);
      const afterIdentity = fs.statSync(profileDir);
      const secondNetwork = await stop();
      const afterPreferences = preferences(profileDir, extensionDir, id);
      const observation = { prepared, round, before, after, install_reused: reused,
        profile_identity_unchanged: identity.dev === afterIdentity.dev && identity.ino === afterIdentity.ino,
        preferences_before: beforePreferences, preferences_after: afterPreferences,
        bootstrap_network: bootstrap, first_network: firstNetwork, second_network: secondNetwork };
      report.observations.push(observation);
      console.log(JSON.stringify({ storage_lifetime_observation: observation }));
      assert(reused && observation.profile_identity_unchanged);
      assert.equal(after.session_present, false, 'Session storage must end at the browser boundary');
      if (prepared) assert(after.dom_matches && after.local_matches && after.sync_matches,
        'The prepared inert profile must retain all persistent sentinels');
    }
  }
  report.unprepared_loss_reproduced = report.observations.some(item => !item.prepared &&
    (!item.after.dom_matches || !item.after.local_matches || !item.after.sync_matches));
  report.prepared_persistence_passed = report.observations.filter(item => item.prepared).every(item =>
    item.after.dom_matches && item.after.local_matches && item.after.sync_matches);
  report.passed = true;
};

const watchdog = setTimeout(() => {
  console.error('Storage lifetime diagnostic timed out'); process.exitCode = 1;
  cleanup().finally(() => process.exit(1));
}, 10 * 60 * 1000);
main().catch(error => {
  report.passed = false; report.failed_stage = stage;
  report.failure_code = /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : 'ASSERTION_FAILED';
  process.exitCode = 1;
}).finally(async () => {
  clearTimeout(watchdog);
  try { await cleanup(); } catch { report.cleanup_failed = true; report.passed = false; process.exitCode = 1; }
  console.log(JSON.stringify(report));
});
