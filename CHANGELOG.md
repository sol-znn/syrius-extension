# Changelog

## Unreleased

- A send that is interrupted is no longer a send that may be signed twice.
  Every block is recorded before it is sent; if the popup closes, the
  connection drops or the node never answers, the wallet looks that block up
  and, if the node never saw it, sends the same bytes again. It does not sign
  a replacement on its own.
- Sends, receives and site-approved sends from one account now take turns,
  across windows. Two of them can no longer build on the same block and have
  one refused or displaced. A send you start goes ahead of blocks still
  waiting to be received.
- While a sent block's outcome is unknown the dashboard says so, holds that
  account's next send, and offers to stop waiting.
- The record is encrypted under a key derived from the wallet's seed, readable
  only while that wallet is unlocked, kept for 24 hours after a block settles,
  limited to 100 per account, and deleted with the wallet.

## 0.3.4

- Locking, expiry and wallet removal now revoke every open wallet window's
  keys, not just the one that locked. Lock durations are 5, 15 or 60 minutes,
  or On close, and a change applies to the running session.
- A site's connection is to one wallet and account. Switching accounts hides
  the address from sites that were not approved for the new one, and every
  approval is bound to the account it was shown for.
- Every dApp approval is single use, expires, and is tied to the page that
  asked: navigating away, going back or rewriting the page cancels it, and an
  answer can never reach a different page.
- The approval screen signs exactly the block it showed, and embedded
  contract calls list every decoded argument.
- Sites see no address, chain or node until they are approved, see only the
  node's host, and a disconnect holds even if the browser restarts.
- The approval window no longer opens repeatedly for one site, and connection
  requests are bounded per site and in total.
- New passwords need at least 8 characters with a lowercase letter, an
  uppercase letter, a digit and one of `!@#$%^&*`. Existing passwords still
  unlock.
- A custom token's amount is entered and confirmed in exact base units: its
  decimals come from the node, which cannot vouch for them. The send dropdown
  still shows its symbol and balance.
- A page Chrome prerenders (an address-bar prediction, a site's speculation
  rules) now reads its account once it is shown and receives events, instead
  of failing its first read with "the requesting document has left".
- A page whose navigation never completes (a 204 response, a download) keeps
  receiving account and chain events; they used to stop until a reload.
- **New permission: `webNavigation`.** Approvals are cancelled when their page
  navigates, even if the page blocks its own unload events, and Chrome only
  reports that to an extension holding this permission. Chrome describes it
  on the install prompt as "Read your browsing history", and asks anyone
  updating from 0.3.3 to accept it before the extension runs again.
- Locked dependencies updated for npm audit advisories (brace-expansion,
  fast-uri, serialize-javascript).

## 0.3.3

- Fixed a receive-history bug where an incoming transfer's "From" address and
  explorer link pointed at the account's own receive block instead of the
  sender and the origin send block.
- Added `wss://node.zenonhub.io:35998` to the default node list, and made the
  wallet's own `wss://my.hc1node.com:35998` the fallback node when none has
  been chosen yet, instead of the SDK's compiled-in `127.0.0.1`.
- The "sign this block" dApp approval screen now shows a human-readable
  summary — a plain transfer, a recognized embedded-contract call, or an
  unrecognized one (rendered as a warning) — above the raw block data, which
  is now collapsed behind a toggle.
- Success alerts (address changed, wallet imported, transaction sent, copied
  to clipboard, etc.) now show as a bottom-center card, like every other
  alert, with a green bar that fills across its top edge over two seconds and
  a small close button.
- Fixed creating or importing a wallet whose name contained a space failing
  right after it was saved with "Given keyFile does not exist": the SDK's own
  save path only replaces the *first* space in the name, so the wallet was
  written under one key and the immediate unlock afterward looked it up under
  another. Wallet names are now fully sanitized before either happens.
- Fixed every toast — not just success — closing almost the instant it opened
  for anyone with reduced motion turned on: react-toastify times a toast's
  display by the progress bar's own CSS animation, and the wallet's
  reduced-motion rule was flattening that animation to near-zero along with
  everything else.
- The "Loading…" label under an account's activity, plasma, delegation and
  staking lists no longer flashes on and off between fast page loads and
  pagination fetches — it now only appears once a fetch has been running for
  three seconds.
- Fixed the Fuse Plasma and Stake ZNN buttons jumping partway up the screen
  once their page's list of entries finished loading: the amount form above
  them was flex-stretching to fill the still-empty page, a layout rule meant
  for screens where the submit button lives inside the form, not outside it.
- Switching addresses repeatedly now reuses the same "Address changed" toast
  instead of stacking a new one per click.
- The unlock screen now defaults to whichever wallet was unlocked last,
  instead of an empty picker, whenever more than one wallet is stored.
- Locking the wallet now clears any toast still on screen instead of leaving
  it over the password prompt, and no longer shows an alarming "The wallet is
  locked" error toast for a background operation (an auto-receive, an
  in-flight send) that was still running and lost the race against the lock
  itself — which is not a failure, since the wallet is locked because it was
  just asked to be.
- The dashboard now polls CoinGecko for live ZNN/QSR prices, but only while
  connected to mainnet (chain id 1) — a devnet or a private chain has no coin
  for CoinGecko to have a price for. Each balance now shows its live USD
  value beside it, and the address that used to sit under both — already
  shown in the header's account pill — is now the two balances' combined
  USD value instead.
- A balance of four figures or more now shows as a whole number rather than
  truncating with an ellipsis once its decimals no longer fit, and the USD
  figures beside it are larger and lighter, especially the combined total.
- Fixed the account balances and their USD figures not lining up with the
  ZNN/QSR ticker text below them — a `<button>`'s own default padding, not
  the flex layout, was the cause.
- Fixed a pillar's weight, delegator cut and produced% sometimes wrapping
  onto a second line depending on how long its numbers happened to be; a
  touch smaller now keeps all three on the one line every time.
- Plasma can now be fused for any address, not only this account's own — a
  recipient field (defaulting to the current address) sits below the amount
  on the Plasma screen.

## 0.3.2

- GitHub Actions now creates the matching version tag and publishes the
  Chrome/Brave ZIP and SHA-256 checksum automatically after a successful push
  to `main`.
- Fixed delegated plasma balance reporting and the send-form dropdown blur
  handling.

## 0.3.1

### Message signing

Desktop Syrius signs messages for a paired dApp over WalletConnect
(`znn_sign` in `lib/blocs/wallet_connect/chains/nom_service.dart`). The
extension has neither WalletConnect nor a way to sign anything that is not an
account block, so the same capability arrives here over the transport it
already has.

- **`zenon.signMessage(message)`** on the injected provider, and `znn_sign` for
  anything speaking the desktop method name — the bare-string `params` desktop
  sends is accepted alongside this extension's `{message}`. It resolves to
  `{message, address, publicKey, signature}`, the last two hex, which is the
  pair desktop answers with. Restricted to connected origins and prompted every
  time, like every other signature.
- **An approval screen** that shows the message verbatim, wrapped and
  unescaped, with the address that will sign it. Nothing is broadcast and no
  plasma is generated, so it settles as fast as an Ed25519 signature.
- **Settings → Sign message**, for proving an address to something that cannot
  ask the wallet itself — a forum post, a support ticket, an exchange's
  ownership form. Type the message, copy back the public key and the signature.
- Two deliberate differences from desktop, both in
  `services/wallet/signMessage.js`: the message is encoded as **UTF-8** rather
  than desktop's UTF-16 code units narrowed to bytes (identical for ASCII), and
  a message whose encoding is **exactly 32 bytes** is refused. 32 bytes is the
  size of an account block hash, and `BlockUtils._getTransactionSignature`
  signs exactly those bytes — so raw signing at that one length would let a
  site have a transfer signed by calling it a message. Prefixing the message
  would close it too, at the cost of every signature being unverifiable by
  anything written for desktop.
- `utils/dapp-test.js` drives the new method end to end and checks the shape of
  what comes back.

## 0.3.0

Everything below is the difference between this tree and
[`MichZNN/syrius-extension`](https://github.com/MichZNN/syrius-extension) at
`8cf005c` ("Added extension id"), which is version **0.1.10**. That build was a
Manifest V3 port of the 2023 DexterLabZ extension: a wallet that worked, wired
into a Create-React-App-shaped extension boilerplate it had outgrown, and
injected into exactly one website.

The reasoning behind each change, and what was measured rather than assumed, is
in [REFACTOR.md](REFACTOR.md).

### Wallet correctness

These were live defects in 0.1.10, not cleanups.

- **Sending signed with the wrong address.** The vault defaulted every accessor
  to address index 0 while balances came from the selected index, so a wallet on
  its second address showed one account and signed with another. Six call sites
  shared the defect; the vault now holds the selected index and it is the
  default everywhere.
- **Amounts lost a base unit.** Send used `parseInt(amount * 10**decimals)` and
  staking used `parseInt(amount) * 1e8` — 4.35 ZNN sent 434999999 instead of
  435000000, and staking 1.5 ZNN staked 1.0. One BigNumber-correct parser and
  formatter (`services/utils/format.js`) replaces about twenty copies of the old
  expression. Confirmed against a devnet node, not by inspection.
- **A mistyped recovery word silently imported a different wallet.** A phrase
  was accepted on word count alone, with no BIP-39 checksum check, and reported
  success on an empty wallet. The checksum is verified now.
- **Wallets were written after the flow moved on.** `saveKeyStore` was never
  awaited in either the create or the import path.
- **A wallet sitting on address 0 was reset to defaults** on every load, because
  the stored index was tested for truthiness.
- **The password prompt reappeared at random.** The credential cache lived in a
  service-worker module variable, which MV3 evaporates whenever it feels like
  it.
- **Recipient addresses were never parsed** — only checked for being non-empty.
  Max send was hardcoded to 999.
- **Plasma's fuse field** wrote a stale value into the form on change, so its
  validation never saw what was typed.
- **Delegate** divided the ZNN reward by the QSR token's decimals and vice versa
  (latent while both are 8).
- **A site asking about a token the account does not hold** threw, from an
  unguarded `balanceInfoMap[tokenStandard]`.
- **A dead message channel hung the wallet forever.** `sendInternal` had no
  deadline and unlock awaited it, so an extension update — which orphans an open
  popup's context — left a blank splash with no error and no way forward. Every
  internal call has a deadline now.
- Token dropdown compared a `TokenStandard` object to a string and so never
  showed the selection; a dropdown effect keyed on `value` re-entered form
  validation on every render; "Staked N ZNN" read a state value that was never
  assigned and so always said zero.

### Transaction history

0.1.10 knew where a block went but never what it did: both halves of every
contract pair rendered as the same word, and anything else rendered as "Sent 0".

- Embedded calls are decoded from their four-byte selector — the first four
  bytes of `SHA3-256` over the canonical signature, the way go-zenon dispatches
  them — so **Fused/Unfused**, **Staked/Unstaked**, **Delegated/Undelegated**
  are distinct rows.
- HTLC calls (`Create`, `Unlock`, `Reclaim`, `AllowProxyUnlock`,
  `DenyProxyUnlock`) are labelled as **Swap created / unlocked / reclaimed**,
  even though `znn-ts-sdk` has no HTLC support of any kind.
- `npm test` re-derives all of it from `go-zenon/vm/embedded/definition/*.go`;
  it is the only check on the HTLC labels.
- Unconfirmed blocks are marked as such (a block with no `confirmationDetail`
  gets a pulsing dot), and the dashboard polls only while a row is pending.
- Explorer links follow the chain instead of pointing at the mainnet explorer
  from every network, and are switchable between zenonhub.io and
  explorer.zenon.network.
- Embedded contracts are named ("From Plasma") rather than printed as forty
  characters of address, and zero amounts are no longer rendered next to
  contract calls.

### dApp bridge

- **`window.zenon` provider**, injected into every page at `document_start` in
  the MAIN world, with `request()`, `connect()`/`disconnect()`, EIP-1193 error
  codes, and `accountsChanged` / `chainChanged` / `nodeChanged` events.
  0.1.10 injected only into `https://bridge.mainnet.zenon.community/*` and spoke
  a flat `postMessage` protocol, which is still relayed so existing sites keep
  working.
- **Per-origin permissions**, persisted, with a Connected Sites screen and
  revocation. Connecting grants read access to the address, chain and node URL
  only; every signature is prompted.
- **Service worker rewritten as a router** with sender validation, a single
  reused approval window instead of stacked popups, and no key material or SDK
  linked into it at all. It answers read-only questions from a small non-secret
  record the popup publishes.

### Security

Against the security audit of 0.1.10 (kept outside this repo, as
`../zenon-docs/security/syrius-extension-audit.md`):

- The unauthenticated plaintext-password oracle in the background script is gone
  with the credential cache itself. The wallet's control surface is gated on the
  sender's extension-origin URL — the previous check tested `!sender.tab`, which
  wrongly refused an extension page opened in a tab.
- MV3 `window.open` in the service worker is gone.
- The audit's suspected CSP break on the plasma PoW blob worker was tested under
  the shipped CSP and does not exist: the blob inherits the extension's origin,
  which `script-src 'self'` covers.
- An unlocked session lives in `chrome.storage.session` (memory-only,
  unreadable by content scripts) and holds the keystore's entropy rather than
  the password, expiring on a real auto-lock timer.

### New screens

Tokens (all ZTS the account holds, not just ZNN and QSR), change password,
remove wallet, connected sites, address labels, auto-receive, auto-lock and
explorer settings.

### Performance and build

| | 0.1.10 | 0.3.0 |
|---|---|---|
| popup entrypoint | 14.9 MiB | 6.1 MiB |
| popup bundle | 7.95 MiB | 146 KiB |
| production build | 33 s | ~21 s |
| keystore decryptions per navigation | 1 (Argon2id, 64 MiB) | 0 |

- Dropped `three` (a 3D ball on the password screen), `react-lottie-player`
  (a three-second intro animation), `framer-motion`, `react-transition-group`,
  `react-hot-loader`, `@hot-loader/react-dom` and `webpack-obj-loader`, plus the
  assets they existed for: 3D models, cyber-eye cubemap textures, ten Lottie
  files.
- `znn-ts-sdk` comes from npm (`0.1.3`) rather than a GitHub tarball.
- Removed the unreachable `newtab`, `options`, `panel` and `devtools` entry
  points and `devtools_page` from the manifest.
- Vendor chunking for the popup only, so the content and page scripts stay
  standalone; `drop_console` and no source maps in production.
- The keystore is decrypted once per unlock and the key pair cached, instead of
  running Argon2id on every screen.
- The stylesheet went from 1801 lines of `!important` utilities and dead classes
  to a token-driven system, with a fixed 360×600 shell and scrolling contained
  to the screen body — previously any screen could scroll the whole document,
  which is why the header slid away mid-transaction.
- Shared code extracted where there had been copies: one signing/plasma-progress
  path (was six), one paginated list (was four, all with the same "more pages"
  bug), one error formatter (was ten), one toast helper (was twenty). The
  spinner and modal hooks were toggles over stale closures and are counted
  show/hide pairs now.
- Three-second splash replaced by a still logo shown only while storage is read.

### Repository

- `npm test` (`utils/contract-calls-test.js`) and `utils/dapp-test.js`, an
  end-to-end drive of a real page against the provider.
- `utils/dev-harness.js`: the extension in its own Chrome, on its own profile
  and debugging port, with a self-unlocking devnet wallet. The auto-unlock
  requires `SYRIUS_DEV_WALLET=true`, which only the harness sets, and is dead
  code in any production build.
- `.github/workflows/release.yml`: builds on a `v*.*.*` tag, refuses a tag that
  does not match the manifest version, and publishes a signed `.crx`.
- Removed the `npm start` webpack-dev-server path with `webpack-dev-server` and
  `cross-env`. Its hot-reload wiring hung off a `chromeExtensionBoilerplate` key
  the webpack config no longer has, and it injected HMR clients into the content
  and page scripts, which breaks them. The dev harness replaced it.
- Deleted a stray `nul` file (a Windows shell redirect that landed as a 2000-line
  copy of the stylesheet); untracked `desktop.ini`.
- Manifest name is "Syrius — Zenon Wallet"; `alarms` added to permissions for
  the auto-lock; `web_accessible_resources` for the old single-site bridge
  removed.

### Not included

Sentinels (excluded by request), Accelerator-Z, P2P/HTLC swaps and
WalletConnect — desktop-shaped features that do not fit a 360px popup.
(WalletConnect's `znn_sign` is covered since, over this extension's own
transport; see Unreleased.)
