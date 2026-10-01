# Syrius Extension

A non-custodial browser wallet for the Zenon Network of Momentum.

Keys are generated and encrypted locally (BIP-39 mnemonic, Argon2id, AES-256-GCM
through `znn-ts-sdk`) and never leave the machine. The extension talks to a
Zenon node of your choosing over a websocket, and to web pages through an
injected provider that cannot do anything without being asked first.

Current version: **0.3.4**, Manifest V3, Chrome/Brave 112 or later. What changed against the published
`MichZNN/syrius-extension` build is in [CHANGELOG.md](CHANGELOG.md); the working
notes behind it are in [REFACTOR.md](REFACTOR.md).

## Features

- **Wallet** — create or import a 12/24-word recovery phrase (checked against
  the BIP-39 checksum), multiple named addresses per wallet, change password,
  remove a wallet.
- **Balances** — every ZTS the account holds, not just ZNN and QSR, on their own
  Tokens screen.
- **Transfers** — send and receive, with a history that names what each block
  actually did (fused/unfused, staked/unstaked, delegated/undelegated, swap
  created/unlocked/reclaimed) and marks anything the network has not confirmed
  yet. Incoming blocks can be received automatically.
- **Pillars** — delegate, undelegate, collect rewards.
- **Plasma** — fuse and cancel QSR fusions.
- **Staking** — lock ZNN, withdraw matured stakes, collect rewards.
- **Nodes** — keep a list of nodes, switch between them, and set the chain
  identifier the wallet signs for (detected from the node it is connected to).
- **dApp bridge** — a `window.zenon` provider with per-origin permissions and a
  Connected Sites screen.
- **Message signing** — sign a message by hand under Settings, or answer a
  connected site's `znn_sign` request from the approval window. Byte-compatible
  with desktop Syrius, so the same verifier accepts both.
- **Settings** — auto-lock timer, auto-receive, explorer choice, address labels,
  backup phrase export.

## Installation

Requires Chrome/Chromium 112 or later (`minimum_chrome_version` in the manifest):
the approval queue relies on Chrome 112's session-storage quota, and
document-bound provider events and the shared session coordinator on Chrome 111.

### From a release

Every `v*.*.*` tag is built by GitHub Actions and published as a Chrome/Brave
ZIP on the [releases page](https://github.com/MichZNN/syrius-extension/releases).
Open `chrome://extensions/` or `brave://extensions/`, enable "Developer mode",
and drag the ZIP onto the extensions page. Alternatively, extract it and choose
**Load unpacked**.

### From source

1. **Prerequisites**
   - Node.js 18 or higher
   - npm 8 or higher

2. **Build the extension**

   ```bash
   git clone https://github.com/MichZNN/syrius-extension.git
   cd syrius-extension
   npm install
   npm run build
   ```

3. **Load in Chrome**
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the `build` folder

## Development

```bash
npm install
npm run build      # production build into build/
npm run lint
npm run test       # checks the embedded-call decoder against go-zenon's ABIs
npm run prettier
```

`npm test` re-derives every embedded contract's method selectors straight from
`../go-zenon/vm/embedded/definition/*.go` and feeds synthetic blocks through the
decoder the wallet uses. It is the only check on the HTLC labels, since
`znn-ts-sdk` has no HTLC implementation to compare against. It skips itself if
go-zenon is not checked out alongside this repo.

### Dev harness

`utils/dev-harness.js` runs the extension in a Chrome of its own — separate
profile, separate debugging port — with a wallet that unlocks itself, so a
screen can be opened and worked on without clicking through the splash, the
password and the menus every time. It defaults to the
[go-zenon devnet](../go-zenon/docker/devnet) (`ws://localhost:35998`, chain 69)
and that repo's committed dev mnemonic, at address index 1.

```bash
npm run dev:start                     # build, launch Chrome, unlock, screenshot
npm run dev:reload                    # rebuild, reload the extension, screenshot
npm run dev:stop                      # close it again

node utils/dev-harness.js route tabs/settings/change-node
node utils/dev-harness.js shot --full --out node-settings.png
node utils/dev-harness.js click "text=Use chain 69"
node utils/dev-harness.js fill "input[name=chainIdField]" 3
node utils/dev-harness.js text .chain-id-card
node utils/dev-harness.js logs
```

Chrome stays up between commands, so each one lands on the screen the last one
left behind. Screenshots go to `.dev-harness/shots/`. The wallet it unlocks is
written to `.dev-harness/wallet.json` on first run — edit that file to point the
harness at a different mnemonic, node, chain or address index.

`node utils/dapp-test.js` drives a real web page against the injected provider
end to end — connect prompt, approval, reconnecting without a second prompt, and
a message signed through the approval window — against the Chrome the harness is
already running.

The same Chrome can drive any dApp and answer the wallet for it, one command at
a time, which is how a site's wallet integration gets tested against the real
extension rather than a stub:

```bash
node utils/dev-harness.js open http://127.0.0.1:4175/        # the page under test
node utils/dev-harness.js page click "text=Prove Zenon address"
node utils/dev-harness.js approvals                          # what is queued, oldest first
node utils/dev-harness.js approve --expect connect
node utils/dev-harness.js approve --expect signMessage
node utils/dev-harness.js page fill "#some-input" "a value"
node utils/dev-harness.js page shot --full --out page.png
node utils/dev-harness.js reject                             # answer the next one with no
```

`page` acts on the tab `open` last created, or on `--url <part of its
address>`. `approve` prints the approval screen verbatim before it presses
anything, waits for the wallet to let go of the request — a block may mine
plasma first — and fails if the wallet shows an error. It refuses to press
anything unless the wallet's node is on this machine and its chain is not
mainnet's, and `--expect <type>` makes it refuse a request of any other kind.
`page reload` is worth knowing beside `page goto`: on a single-page app an
address that differs only in its hash moves the router without reloading, so
anything the page read at startup stays on screen after it has changed.

Two sides of a trade need two wallets that cannot see each other, which means
two browsers. `--instance <name>` gives each its own profile, wallet, port and
screenshots, and `--address-index` at `start` is what makes the second one
somebody else:

```bash
node utils/dev-harness.js start --instance a --address-index 1
node utils/dev-harness.js start --instance b --address-index 2
node utils/dev-harness.js open --instance b http://127.0.0.1:4175/
node utils/dev-harness.js approve --instance b --expect signAndSendBlock
node utils/dev-harness.js stop --instance b
```

Within one wallet, the Change address screen at `tabs/change-address` switches
account without a second instance.

The auto-unlock only exists in builds made by the harness: it needs
`SYRIUS_DEV_WALLET=true`, which nothing else sets, it refuses to run in a
production build, and even then it does nothing until the harness leaves a
wallet in the browser's own storage. Nothing about it is compiled into
`npm run build`.

### Releasing

`.github/workflows/build-and-release.yml` validates every pull request and push
to the development branches. A successful push to `main` creates the matching
version tag and publishes the Chrome/Brave ZIP plus its SHA-256 checksum. Bump
`src/manifest.json`, `package.json` and `package-lock.json` together before
merging a release. To use the tag-triggered path manually instead of the
automatic `main` release:

```bash
git tag v0.3.4 && git push origin v0.3.4
```

The normal `main` workflow creates the tag itself. The workflow does not
require a CRX private key: Chrome and Brave load the published ZIP as an
unpacked extension.

## Integrating a site

The extension injects `window.zenon` into every page, before the page's own
scripts run. It exposes nothing about the wallet until the person approves the
origin, and it never signs anything without asking.

```js
// The provider is injected at document_start, but a script that runs even
// earlier can wait for it.
const zenon = window.zenon ?? (await new Promise((resolve) =>
  window.addEventListener('zenon#initialized', () => resolve(window.zenon), { once: true })
));

// Read-only, never prompts. Empty until this origin is connected.
await zenon.getAccounts();   // [] | ['z1q…']
await zenon.getChainId();    // null until connected/unlocked; 1 for mainnet
await zenon.getNodeUrl();    // null | ws(s)://host[:port], without private endpoint details

// Opens the connect prompt. Resolves immediately for an origin already
// connected; rejects with {code: 4001} if the person declines.
const [address] = await zenon.connect();

// A transfer. `amount` is in the token's smallest unit.
const { hash } = await zenon.sendTransaction({
  to: 'z1q…',
  tokenStandard: 'zts1znnxxxxxxxxxxxxx9z4ulx',
  amount: '100000000',                    // 1 ZNN
});

// An arbitrary account block, including contract calls. Shown in full before
// anything is signed.
await zenon.sendAccountBlock(block);

// A signature over a message, for a login challenge or a proof of ownership.
// Prompted every time; nothing is broadcast and nothing is spent.
const { publicKey, signature } = await zenon.signMessage(
  `Sign in to example.com at ${new Date().toISOString()}`
);

zenon.on('accountsChanged', (accounts) => {});
zenon.on('chainChanged', (chainId) => {});
zenon.on('nodeChanged', (nodeUrl) => {});

await zenon.disconnect();
```

Chain and node reads are unprompted and return `null` until the origin is
connected and the wallet is unlocked. Node reads, node-change events and legacy
grant fields expose only the WebSocket scheme, host and nondefault port. URL
credentials, paths, query strings and fragments remain private. This public
descriptor may not be a usable connection endpoint; the wallet keeps the full
configured URL for its own SDK connection and reconnect fallback.

Failed disconnections remain visible in Connected Sites for retry. Treat an
error as incomplete and retry until the site is removed. A saved session denial
blocks access while a failed durable removal is pending; it is not a substitute
for completing that removal before restarting the browser.

Errors follow EIP-1193 numbering: `4001` the person declined, `4100` the origin
is not connected, `4200` unknown method, `4900` the wallet is locked, `-32602`
the parameters were malformed.

### Verifying a signature

`signMessage` is desktop Syrius' `znn_sign` under another name — it signs the
message bytes directly with the account's Ed25519 key and answers with the
signature and public key as hex, so one verifier covers both wallets. The
`address` field is a convenience — it is derived from the same public key, and
a verifier that cares should re-derive it rather than take it on trust:

```js
const bytes = (hex) => Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));

const ok = await crypto.subtle.verify(
  'Ed25519',
  await crypto.subtle.importKey('raw', bytes(publicKey), 'Ed25519', false, ['verify']),
  bytes(signature),
  new TextEncoder().encode(message)
);
```

Two things worth knowing:

- The message is encoded as **UTF-8**. Desktop passes UTF-16 code units narrowed
  to bytes, which agrees for ASCII — what a login challenge is made of — and
  differs for anything else.
- A message whose UTF-8 encoding is **exactly 32 bytes** is refused. That is the
  size of an account block hash, and signing raw bytes of that length would let
  a site have a transaction signed by calling it a message. Pad the challenge to
  any other length.

The flat `window.postMessage({method: 'znn.requestWalletAccess'})` protocol the
2023 build used is still relayed, so sites written against it keep working.

## Security notes

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

`npm run test:security` includes corrected-candidate wallet-removal checks for
metadata ownership, shared seeds, legacy names, storage faults/retries, stale
identity, cancellation, actual removal-screen callbacks, and pinned SDK address
serialization/derivation. The tests use in-memory storage and public fixture
data, with no real wallet, existing browser profile, or network transaction.

## License

MIT License - see the [LICENSE](LICENSE) file for details.

---

**Disclaimer**: This is experimental software. Use at your own risk. Always verify transactions before signing.

### Lock-duration changes

Changing **Lock after** applies to the current session immediately. A shorter
positive duration clamps its deadline without extending any time already left;
selecting the same or a longer duration does not reset that deadline. Later
activity can renew it under the selected policy. The policy is held in the
shared session record and every renewal reads it under the session lock, so an
operation that began before the setting changed cannot extend the session past
it.

**On close** removes resumable key material and public wallet state from shared
session storage, retaining only a marker for the current document. A new popup
must ask for the password. Only that still-open owner may convert its session
back to a timed duration. Settings errors are reported; a partial persistence
failure may leave the current session stricter until the setting is retried.
A failure to reach shared session storage is treated as unavailability: the
affected window's keys are purged and it offers a retry. Existing legacy unlock
records require a password once after this update.

The shared popup/worker session coordinator needs Chrome 111 or newer; the
extension as a whole requires 112 (see Installation).
`npm run test:security` includes inert session-policy regression checks; they
use no live node, real wallet, funds, or existing browser profile.

## Wallet request limits

Approval requests expire 30 minutes after admission; another request never renews that deadline. The queue holds at most 16 pending requests globally, two per origin and one pending connection request per origin. Requests must fit 128 KiB of UTF-8 JSON including their queue metadata, depth 32 and 20,000 values. Correlation IDs are finite numbers or nonempty strings up to 128 characters; site titles are limited to 1,024 characters and favicon URLs to 4,096. Supported 16 KiB calldata in Base64, byte-array and Buffer-JSON forms remains accepted. Inputs exceeding a limit are rejected without truncation.

Capacity/attention limits return retryable code `-32005`; invalid or oversized requests use `-32602`. An invalid correlation ID is not echoed. Unapproved expiry returns `-32006`. If processing has already begun, expiry or closure reports unknown outcome: check the result before retrying, since an already-started publication cannot be recalled. Provider and legacy transport fallbacks settle missing replies after 31 minutes with the same caution.

A new approval window is limited to one per five seconds globally and one per 30 seconds per origin. Existing windows are reused without refocusing. A successful human approval permits that origin one follow-up opening within 30 seconds, including connect-then-sign after the empty-window grace; rejection does not grant that allowance. These decisions survive worker restarts within the browser session. At most 32 provider handlers/transports are active at each boundary. Chrome necessarily decodes messages before these checks, so these are wallet admission bounds, not a general browser traffic guarantee.

Chrome 112 is required for the 10 MB session-storage quota. JSON size is not Chrome's exact memory accounting; native quota/storage failures remain errors and never authorize signing. Expired requests are pruned on queue access and the worker alarm. Old unversioned queue entries require a fresh request after an extension update. Queue deadlines, claim ownership and key/publication checks fail closed; the wallet's other session and document-lifetime policies still apply independently.

Approval preparation and submission use at most two operation slots per popup. Each node RPC has a native client cleanup timeout of at most 10 seconds, shortened by the approval deadline. Canceled operations keep their slot until outstanding native RPC promises settle. The automatic block preview is canceled when its view is replaced or submission begins. Approval proof of work uses a static, operation-owned worker terminated on completion, cancellation, error or expiry. A submitted transaction whose response is lost has an unknown outcome; check the ledger before retrying.

Permission finalization first saves a durably inactive pending record, preserving prior consent. The exact isolated relay must accept the connection response before the fixed deadline; its timestamp marks completion of that consent decision. Durable promotion may finish after the acknowledgement, while immediate follow-up reads wait on the permission lock. A failed promotion leaves the pending record inactive and requires reconnecting, even if the reply already reached the page. Pending records remain inactive after a browser restart even if rollback fails and all session state is lost. The relay timestamp also distinguishes an accepted response from a late response when the page event queue runs later.

Requests are bound to the document that made them, and any cross-document navigation cancels them, even one that never commits. Provider events are bound to the document alone: a page whose navigation is aborted (a 204 response, a download) keeps receiving them. A page Chrome prerenders (address-bar prediction, speculation rules) sends nothing until it is shown, and its load-time reads are answered then. The `webNavigation` permission behind the navigation fence is shown on the install prompt as "Read your browsing history".

### Wallet and account consent

Site connections are stored per origin, exact wallet import, and exact derived
account. The first derived address identifies the seed; the stored wallet name
separates duplicate imports. Reusing a name for another seed never transfers
consent. Older origin-only connections require reconnection. Switching A → B → A
restores A's saved consent, but never revives an approval shown before a switch.
The approval screen shows the wallet, account number, and full address. Signing
and publication check that same selection and use its explicit address index.

On close keeps public reads empty and stores no resumable entropy. A connected
site may queue a request for the known account and wait for that account's next
immediate unlock; an unknown or changed account is refused. Once displayed, the
request cannot rebind. Timed session reopening preserves the selection identity.
Connected sites lists each wallet/account grant; its Disconnect all button covers
all wallets and accounts. Removing a wallet withdraws its consent and queued
approvals before deleting the local keystore. Duplicate imports remain separate.

Run `npm run test:security` for corrected-candidate scope, worker, session, storage
fault, key-facade and approval-screen fixtures. These tests use inert SDK boundaries
and generated fixture state, and exercise the pinned SDK with public test entropy
and an inert ledger; they do not send transactions or access real wallets.
