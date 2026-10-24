# Security notes

- Removing a wallet clears its encrypted copy, saved address selection/count,
  matching last-wallet selection, and labels for its known derived addresses.
  Labels shared with a retained import of the same seed are preserved. Global
  node/settings preferences and other wallets remain. Historical labels beyond
  the known derivation count cannot reliably be attributed when other wallets
  remain; removing the last wallet clears the whole label map. Cleanup failures
  keep the encrypted wallet available for retry, though earlier metadata writes
  may already have succeeded. Nothing is deleted until every open window has
  lost the wallet: the deletion runs inside the same session transaction that
  revokes it, so a lock that fails deletes nothing. This is application-level
  cleanup, with browser backups and forensic storage recovery outside its
  guarantee.
- The encrypted keystore lives in the extension's own storage and is opened once
  per unlock. An unlocked session is held in `chrome.storage.session`, which is
  memory-only, cleared when the browser closes, and unreadable by content
  scripts. It stores the keystore's entropy rather than your password, and it
  expires on the timer set under Settings → Lock after.
- The service worker holds no key material and does not link the SDK. It answers
  a site's read-only questions from a small non-secret record the popup
  publishes.
- Connecting a site grants read access to the selected address, the chain and
  the node URL. It is never permission to move anything: signing and sending are
  prompted every time, and connected origins can be revoked under
  Settings → Connected sites.
- Signing a message is prompted every time too, and the message is shown
  verbatim before the key touches it. It always signs as the address the person
  has selected — a site cannot choose which one answers.

## Lock-duration changes

Changing **Lock after** applies to the current session immediately. A shorter
positive duration clamps its deadline without extending any time already left;
selecting the same or a longer finite duration does not reset that deadline. Later
activity can renew it under the selected policy. The policy is held in the
shared session record and every renewal reads it under the session lock, so an
operation that began before the setting changed cannot extend the session past
it.

**Never** disables automatic expiry for the current session as soon as the
preference and session update succeed; no further activity is needed to remove
the previous deadline. Manual locking still revokes every window's access, and
closing the browser clears its memory-only session storage. It does not keep
the wallet unlocked across a browser restart. Returning to a finite duration
applies that deadline immediately.

**On close** removes resumable key material and public wallet state from shared
session storage, retaining only a marker for the current document. A new popup
must ask for the password. Only that still-open owner may convert its session
back to a timed duration. Settings errors are reported; a partial persistence
failure may leave the current session stricter until the setting is retried.
A failure to reach shared session storage is treated as unavailability: the
affected window's keys are purged and it offers a retry. Existing legacy unlock
records require a password once after this update.

The shared popup/worker session coordinator needs Chrome 111 or newer; the
extension as a whole requires 112 (see the README).

## What the checks cover

`npm run test:security` includes corrected-candidate wallet-removal checks for
metadata ownership, shared seeds, legacy names, storage faults/retries, stale
identity, cancellation, actual removal-screen callbacks, and pinned SDK address
serialization/derivation. The tests use in-memory storage and public fixture
data, with no real wallet, existing browser profile, or network transaction.

`npm run test:security` includes inert session-policy regression checks; they
use no live node, real wallet, funds, or existing browser profile.

Run `npm run test:security` for corrected-candidate scope, worker, session, storage
fault, key-facade and approval-screen fixtures. These tests use inert SDK boundaries
and generated fixture state, and exercise the pinned SDK with public test entropy
and an inert ledger; they do not send transactions or access real wallets.
