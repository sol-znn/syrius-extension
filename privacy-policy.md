# Privacy Policy for Syrius Extension

**Effective Date:** July 28, 2025
**Last Updated:** October 5, 2026

## Scope

This document describes the browser extension maintained in
[sol-znn/syrius-extension](https://github.com/sol-znn/syrius-extension).
It covers the extension's local storage and network requests. Websites, RPC
operators, price providers and block explorers have their own data practices.

## Wallet and local storage

Wallet creation, recovery, key derivation and signing happen in the extension.
Persisted wallet keyfiles are encrypted with the password through the pinned
Zenon SDK. The extension does not send passwords, private keys or recovery
phrases to its RPC or price providers.

An unlocked wallet holds decrypted key material in its extension context.
Timed sessions also keep recovery entropy in `chrome.storage.session` so a
trusted extension window can restore the current unlock. That temporary record
is not encrypted with the wallet password. An **On close** session is restricted
to the window that unlocked it. Locking or expiry revokes the unlock authority
and removes the saved unlock record. These controls do not guarantee secure
erasure from browser or operating-system memory.

Other local records include preferences, node URLs, wallet and address labels,
connected-site origins and account permissions. Temporary approval requests
contain the requesting origin, document metadata and request parameters and
are held in session storage until completion, cancellation or expiry.
These records are not all encrypted. Removing a wallet cleans its associated
metadata and permissions; browser extension removal clears its local storage.

The wallet also keeps a record of the account blocks it has signed and sent:
the signed block, the account, an identifier of the network and whether the
node has confirmed it. It exists so that an interrupted send can be checked
against the node instead of being signed a second time. It is encrypted with a
key derived from the wallet's own recovery seed, so it can be read only while
that wallet is unlocked. A record is deleted 24 hours after its outcome is
known, and all of a wallet's records are deleted when the wallet is removed.

## Network requests

- **Configured RPC node:** the extension queries account addresses, balances,
  transaction history and contract state, and sends signed account blocks.
  The node receives those requests and the connection's network metadata,
  including the IP address. Operators may log requests. Signed transactions
  published to the blockchain are public.
- **CoinGecko:** USD price requests identify the supported ZNN and QSR tokens.
  The price URL does not include a wallet address or balance. CoinGecko still
  receives the connection's network metadata, including the IP address.
- **Requesting-site icons:** an approval screen can load a site's favicon URL.
  The icon server receives the browser request and its network metadata.
- **Block explorers:** opening an explorer link sends the linked public address
  or block identifier to the selected explorer through the browser.

The reviewed source does not include a dedicated analytics or crash-reporting
service. This does not make RPC, price, icon or explorer requests anonymous,
and it does not describe what those providers do with received data.

## Websites and permissions

The manifest injects the `window.zenon` provider into HTTP and HTTPS pages,
including frames. A page does not receive wallet permission simply because the
provider is present. The extension checks the origin, current document, wallet
account and consent before releasing account information or accepting signing
requests. Review each approval's origin and transaction details.

The Manifest V3 extension requests:

- `storage` for encrypted keyfiles, preferences, permissions and temporary
  unlock and approval records;
- `alarms` for session and approval expiry;
- `webNavigation` to bind requests and events to the browser's current document
  and invalidate stale navigation contexts.

Document tracking supports authorization checks. The reviewed source does not
upload a browsing-history log to a maintainer service. The browser may display
a broad permission warning because the provider is injected across websites.

## Controls and limits

Use **Settings → Connected sites** to revoke a site's access, **Auto-lock** to
choose the unlock policy, and **Node management** to choose the RPC endpoint.
Hiding balances changes their display; it does not prevent account queries to
the configured node. Exporting or copying recovery content intentionally exposes
it to the screen or system clipboard; handle it privately.

Keep a private recovery backup before removing a wallet or uninstalling the
extension. Do not include passwords, recovery phrases, private keys, keyfiles
or identifying wallet records in public bug reports.

## Changes and contact

Updates to this document will change the date above. For questions, use
[the repository's issues](https://github.com/sol-znn/syrius-extension/issues).
The extension ID depends on how the package is distributed or loaded, so this
document does not assign one ID to every installation.
