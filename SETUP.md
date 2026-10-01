# Syrius Extension setup

This guide covers building and loading the Manifest V3 extension in Chrome,
Brave and other Chromium-based browsers on Windows.

## 1. Required runtime

Install Node.js 24.x. The repository pins the major version in .nvmrc and
expects npm 10 or newer:

~~~powershell
& 'C:\Program Files\nodejs\node.exe' --version
& 'C:\Program Files\nodejs\npm.cmd' --version
~~~

Run all commands from the repository root. Do not use a second Node.js
installation for this project.

## 2. Install and build

~~~powershell
git clone https://github.com/MichZNN/syrius-extension.git
Set-Location syrius-extension
& 'C:\Program Files\nodejs\npm.cmd' ci --legacy-peer-deps
& 'C:\Program Files\nodejs\npm.cmd' run lint
& 'C:\Program Files\nodejs\npm.cmd' test
& 'C:\Program Files\nodejs\npm.cmd' run test:security
& 'C:\Program Files\nodejs\npm.cmd' run build
~~~

The generated production extension is in the build directory. The browser
loads the generated files, not the source directory.

## 3. Load in Chrome or Brave

1. Open chrome://extensions/ in Chrome or brave://extensions/ in Brave.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository's build directory.
5. Open the Syrius popup and create or unlock the local wallet.

Other Chromium-based browsers use the same procedure with their own extensions
page URL.

## 4. GitHub Actions package and release

The workflow in .github/workflows/build-and-release.yml uses .nvmrc, installs
the lockfile with npm ci --legacy-peer-deps, runs the audit, lint and
regression checks, and creates a Chrome/Brave-ready ZIP with a SHA-256
checksum. The workflow artifact is the ZIP itself, without a second artifact
archive; the checksum is attached to the GitHub Release.

The current extension version is 0.3.4. A push to `main` automatically creates
the matching `v0.3.4` tag and publishes the ZIP assets to a GitHub Release.
Pushes to `development` and `manifest-v3` only create validation artifacts.

For a manual tag-triggered release instead of the automatic `main` release:

~~~powershell
git tag v0.3.4
git push origin v0.3.4
~~~

No custom repository variables or secrets are required. The release job uses
GitHub's built-in GITHUB_TOKEN. Repository settings must allow workflows to
request read/write permissions for the release job.

The workflow intentionally publishes a ZIP rather than a CRX. Load the ZIP's
extracted directory with **Load unpacked**. A CRX signing key is not required
and should not be introduced without a deliberate extension-ID/key-management
plan.

## 5. Session, auto-lock and balance privacy

Closing the popup keeps the wallet session active. By default, the temporary
unlocked session is locked after 30 minutes without activity. The period can be
changed under **Settings → Auto-lock**. Auto-lock clears only the temporary
session credentials; the encrypted wallet remains in extension storage.

Use the eye button on the dashboard to hide or show balance amounts. Hidden
amounts are displayed as *** and the preference is stored locally.

## 6. Nodes and Chain ID

Use **Settings → Node management** to select a reachable WebSocket endpoint or
add a custom node. The Chain ID must match the network the node serves; the
mainnet default is 1 and the testnet endpoint uses 3.

The maintained endpoints are:

- wss://127.0.0.1:35998 (local node, when configured)
- wss://node.zenonhub.io:35998 (mainnet)
- wss://my.hc1node.com:35998 (mainnet)
- wss://node.atsocy.com:35998 (mainnet)
- wss://rpc.testnet.zenon.info (testnet, Chain ID 3)

Only use a node you trust. Test a custom node with a harmless testnet action
before signing a mainnet transaction.

## 7. Bridge testing

Test with staging or testnet first. The extension only activates on origins
listed in src/manifest.json. Refresh the bridge tab after reloading the
extension so its content scripts are injected again.

For every signing request, verify the origin, destination, token, exact amount,
node and Chain ID in the approval screen before approving.

https://bridge.mainnet.zenon.community/ and
http://testnet.bridge.0x3639.com/ remain listed for future compatibility, but
their deployments may be offline.

## 8. Troubleshooting

### The extension does not appear on a bridge page

Check that the scheme and hostname exactly match an origin in the manifest.
HTTPS and HTTP are different origins. Rebuild, reload the extension, and
refresh the bridge page.

### The popup or service worker reports an error

Open the extension's service-worker inspector from the extensions page. Do not
use browser flags such as --disable-ipc-flooding-protection; they hide the
symptom and weaken the browser's protection. Rebuild and reload the unpacked
extension after correcting the source.

### The bridge does not receive a result

Keep the originating bridge tab open while approving. Reloading or closing that
tab cancels the temporary integration context. Check Settings → Connected sites
and revoke/reconnect the origin if necessary.

### A node connection fails

Confirm that the endpoint is reachable, uses the correct wss:// scheme, and
has the correct Chain ID. A local endpoint only works when a compatible local
WSS node is running and trusted by the browser.
