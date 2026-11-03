# Production keyfile lifecycle check

This optional test loads a copy of an existing production extension package and drives its UI in disposable Chromium extension pages through CDP. It exercises the packaged SDK's browser Argon2/AES path without replacing the SDK, rebuilding the package, injecting a wallet, or enabling the development wallet bridge. These pages load `popup.html`; they are not native toolbar-action popups.

The expected input is the combined candidate containing [PR #15](https://github.com/sol-znn/syrius-extension/pull/15) (recovery form submission), [PR #23](https://github.com/sol-znn/syrius-extension/pull/23) (awaited encryption before create/import persistence), and [PR #24](https://github.com/sol-znn/syrius-extension/pull/24) (browser-native address reconstruction for wallet removal), together with the wallet lifecycle implementation. Adding this test does not imply that the target repository's current `master` passes it. This document records the procedure, not a successful run.

## Run manually

Use Node.js 24 on `PATH` and a Chromium executable supporting CDP extension loading. Point to an already extracted production package containing `manifest.json`, `popup.html`, and its original bundles. No dependency installation or package rebuild is required for this test.

```sh
CHROMIUM_PATH="/path/to/chromium-or-chrome-for-testing" \
SYRIUS_EXTENSION_DIR="/path/to/extracted-production-package" \
SYRIUS_LIFECYCLE_REPORT="/path/to/keyfile-lifecycle-report.json" \
node utils/keyfile-lifecycle-browser-test.js
```

`SYRIUS_LIFECYCLE_REPORT` is optional. The input defaults to `build/` when `SYRIUS_EXTENSION_DIR` is omitted. Allow several minutes for actual encryption/decryption and the natural five-minute expiry case. The output contains case names, booleans, package/browser identifiers, and network counters; failed runs exit unsuccessfully without dumping evaluated expressions or underlying exception contents.

### Optional minimum-runtime transport

An optional headful transport supports the legacy unpacked-extension loading boundary in Playwright's Chromium revision 1055, version 112.0.5615.29. This is **Chromium**, not a Google Chrome release. Obtain that pinned official browser archive, verify its integrity, and extract it with native `unzip`; the older installer extraction observed during preparation produced a truncated executable. A successful `--version` probe alone does not qualify browser startup or this matrix.

```sh
CHROMIUM_PATH="/path/to/chromium-112.0.5615.29" \
SYRIUS_EXTENSION_DIR="/path/to/extracted-production-package" \
SYRIUS_LIFECYCLE_REPORT="/path/to/minimum-runtime-report.json" \
node utils/keyfile-lifecycle-minimum-browser-test.js
```

Use a normal graphical session, or run the same command under `xvfb-run -a` on a compatible Linux runner. The wrapper replaces only the test helper's browser transport before requiring the unchanged lifecycle fixture. It does not replace the SDK, cryptography, UI or storage implementation. A different reported browser version is rejected with a sanitized error after the owned browser is stopped, before any lifecycle or wallet case. Unsupported startup, protocol or reload stages fail explicitly.

The legacy transport loads the untouched extension through CLI arguments, discovers its identity through the owned extension settings page, and uses actual `chrome.runtime.reload()` with old-context invalidation and the same enabled extension ID. It does not use modern CDP re-registration. CLI-loaded extension worker startup occurs before CDP attachment: the denying proxy exists before process spawn, but post-attachment counters do not certify that earlier interval. Product popup navigation waits for that page's network guards. This startup limit and the Chromium distribution are recorded in sanitized stats/report metadata.

The minimum-runtime procedure is optional. On 2026-10-09, [own-fork run 37916350400](https://github.com/edgepillar/Syrius-Extension/actions/runs/37916350400) passed the complete fifteen-case matrix in [minimum job 113776709961](https://github.com/edgepillar/Syrius-Extension/actions/runs/37916350400/job/113776709961), using Chromium 112.0.5615.29 under Linux/Xvfb at combined source head `444e226c2c460ee58eb68599521e1857ff90db50`. The downloaded ZIP's SHA-256 was `420f13865b1d900b7699f04c22f9fb6b2303cc950e225fb609ec218be5783e96`; its tested member digest was `44f8fded8395c13995e5088b78d14f78bab060252cea0956dc16b2e808e48934`. Both browser epochs recorded zero observed external HTTP/WebSocket responses and runtime/CSP errors, and the disposable profile was removed.

This result applies to that package and Chromium executable, with the earlier CLI startup observation limit retained. The desktop preparation did not reach CDP startup. The expected combined candidate still includes #15, #23 and #24. Actual Google Chrome minimum-version support and store/CRX installation, update delivery and permission consent remain separate gates.

## Cases and evidence

| Case | Required observation |
| --- | --- |
| Create | Generated phrase confirmation, encrypted SDK keyfile persistence, successful unlock, and expected encrypted keyfile shape. Confirmation supports generated 12- or 24-word phrases, including repeated words; the pinned SDK's random creation uses 32-byte entropy and is expected to produce 24 words. |
| Unlock | Incorrect password rejected without a live shared unlock; correct password accepted. |
| Startup read failure | An instrumented read refusal shows E225 and Retry, preserves the encrypted keyfile, and cannot become onboarding. Removing the fault permits a normal retry. |
| Backup | Incorrect password reveals no phrase DOM; correct password recovers the generated phrase. |
| Explicit lock | Backup DOM removed from two extension pages, shared secret revoked, and public state withdrawn. A non-secret locked tombstone is permitted. |
| Password rotation | Incorrect current password preserves the keyfile; valid rotation changes encrypted bytes while preserving account identity. Old password rejected, new password accepted, and recovered phrase unchanged. |
| Timed document closure | Reopening an extension document resumes the timed session without changing the encrypted entry. |
| On close | Completed policy stores no resumable entropy or public unlock; closing its owner document makes the next document require a password. |
| Natural five-minute expiry | Actual elapsed time revokes both extension pages and removes backup DOM. No clocks or session records are shortened by the harness. |
| Install preparation | A clean empty-profile browser restart retains the enabled extension before any wallet is generated. |
| Browser restart | Same disposable profile and install directory retain the encrypted wallet, but require its password again. |
| Runtime reload | `chrome.runtime.reload()` invalidates the old extension generation. Both transports verify the same enabled ID without a replacement registration. Both preserve encrypted data and require another password unlock. |
| Recovery import | The generated backup imports under another name with matching account identity and independently encrypted bytes. |
| Removal | Incorrect password preserves the wallet. Removing one import revokes its session, preserves the other encrypted entry, and leaves that other wallet unlockable. Removing the last wallet returns to onboarding and withdraws shared secrets. |

The startup-read case instruments `Storage.prototype.getItem` for the wallet map in one test page, then restores it and retries. It never supplies or reconstructs a wallet value. This is a controlled storage-boundary refusal, not evidence that the historical CI failure had the same cause.

One case intentionally instruments `Storage.prototype.setItem` to reject the wallet write **after real encryption**. It confirms that the fault was reached, restores the original method, checks that no wallet or live unlock was created, and retries. This is a storage fault-injection case, separate from ordinary real-crypto lifecycle qualification; it does not replace Argon2, AES, or the application callback.

The expiry case initially requires a finite deadline more than 290 seconds and at most 305 seconds away. An observed lock must occur between that deadline minus a two-second observation tolerance and the deadline plus 30 seconds; reaching the upper bound without observing a lock fails. The second page must then lose its backup DOM within 15 seconds. These are harness observation bounds, not a precise browser scheduling guarantee or proof that pointer/keyboard activity renews the session.

## Isolation and privacy

The input package is copied without modifying its files or CSP. The harness compares a file-tree digest before and after use. That digest identifies the tested members; it is not a ZIP checksum, reproducible-build result, or release attestation. Only connection and receive/lock preferences are initialized in application storage. Chrome's developer mode is enabled through its normal profile configuration API solely in the owned disposable profile. The modern transport reads it back before its initial CDP load and native developer reload; the legacy transport configures it after CLI startup. Before the UI creates any wallet data, an empty-profile cold restart must retain the same enabled install after a clean browser exit. The preparation browser's network counters are retained separately. The later wallet-bearing restart remains mandatory. A restart that expects an existing modern install refuses a missing or replaced ID before attempting any load. Reload requires the same extension ID to be enabled; no wallet or storage is restored by the harness.

A local denying proxy, CDP request blocking, and offline conditions guard browser targets before product execution in the modern transport. The optional legacy transport has the earlier CLI worker-startup boundary described above. Local HTTP/WebSocket guard checks must fail, and observed external responses or WebSocket handshake responses fail the run. These are browser-level network guards, not an OS firewall or a claim of zero network attempts. No live node, transaction, or user wallet is used.

On macOS, both browser transports use Chromium's `--use-mock-keychain` for their disposable profiles. This avoids host login-keychain prompts that can stall browser startup. It changes browser credential storage only; the packaged wallet's Argon2/AES implementation remains in use.

The separate fixture regression below runs six cases against inert classic and module service workers: cold startup, actual runtime reload, and browser restart. Each worker attempts HTTP and WebSocket requests at startup and again after debugger attachment. Both attempts must be refused, and an owned loopback listener must receive neither a request nor a handshake. This check uses no SDK or wallet and does not replace the production lifecycle matrix. CI runs it before building the production package.

```sh
CHROMIUM_PATH="/path/to/chromium-or-chrome-for-testing" \
node utils/service-worker-guard-browser-test.js
```

Fresh passwords and UI-generated wallet material stay inside the test process/browser during execution. The harness does not log phrases, passwords, addresses, encrypted keyfiles, raw CDP payloads, DOM dumps, or screenshots. Persistent `localStorage`, `chrome.storage.local`, and `chrome.storage.sync` values are sampled in memory for the known phrase, chosen passwords, and current session entropy. Timed `chrome.storage.session` legitimately contains resumable entropy; the test instead requires its withdrawal on lock and its absence under On close. These checks do not prove absence in every encoding, heap zeroization, forensic erasure, or protection from browser/OS backups and crash recovery.

The harness owns a fresh temporary profile, attempts browser shutdown, and removes the profile on normal completion, caught failure, SIGINT, and SIGTERM. Cleanup failures make the run unsuccessful. SIGKILL or abrupt machine/process termination cannot run those handlers; do not retain or publish a leftover profile as a test artifact.

## Remaining qualification boundaries

Run results apply only to the reported package and browser version. This test does not qualify native toolbar-popup closure/geometry, the minimum Chrome version or Brave without separate runs, a real old-version-to-new-version upgrade, storefront permission/update consent, Node native Argon2, independent KDF/AES conformance vectors, live-chain behavior, persistent writer concurrency, or transaction recovery. Same-path runtime reload and re-registration are explicitly not a version migration. The current matrix imports the generated phrase; independent 12-word imports, invalid import input, and weak/mismatched new-password browser cases remain separate gates.
