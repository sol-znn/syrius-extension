# Syrius Extension

A non-custodial browser wallet for the Zenon Network of Momentum.

Keys are generated and encrypted on your machine and never leave it. The
extension talks to a Zenon node of your choosing, and to web pages through an
injected provider that does nothing without being asked first.

Version **0.3.6**, Manifest V3, Chrome or Brave 112 or later, Firefox 140 or
later, and Android and iOS apps built from the same source. [What changed](CHANGELOG.md).

## Features

- **Wallet**: create or import a recovery phrase, several named addresses,
  balances of every ZTS token, an approximate value in dollars.
- **Send and receive**, with a history that names what each block did. Every
  signed block is recorded before it is sent, and one account's sends take
  turns, so several sent back to back all land, and an interrupted one is
  settled rather than signed twice.
- **Delegate, stake, fuse plasma**, and collect the rewards.
- **Tokens**: issue, mint, burn and update your own ZTS tokens.
- **Operator modes** (Settings): pillar management with rewards and
  Accelerator-Z voting, sentinels, sporks.
- **Sites**: a `window.zenon` provider with per-site, per-account consent, and
  message signing compatible with desktop Syrius.
- **Settings**: nodes and chain identifier, auto-lock, auto-receive, theme,
  explorer, backup phrase, and an Update row when a newer release is out.
- **Picks up where it left off**: the popup reopens on the screen it closed
  on, with what had been typed, until the wallet locks.
- **Address book** (Settings), offered on Send with the last five recipients.
- **Works in the background**: while the wallet is unlocked, sends and
  receives carry on with the popup closed, proof of work included, and
  incoming transfers are received on every account without opening it.
- **Android and iOS apps**: fingerprint or Face ID unlock, Share on Receive,
  a notification for incoming transfers, and desktop Syrius's `syrius://`
  links, including `syrius://request` for another app to ask for a connection
  or a signature. QR scanning on Send is Android only for now.

## Install

From a release: download the ZIP from the
[releases page](https://github.com/sol-znn/syrius-extension/releases), open
`chrome://extensions`, turn on Developer mode and drag the ZIP in.

Updating: the lock screen says when a newer release is out. Settings, About,
Update opens a tab where you choose the folder the extension was loaded from,
once; Update now then writes the checked release into it and reloads. The
wallet and its settings are kept. "Forget update folder" in About resets the
choice, and "Download the ZIP instead" is there for doing it by hand.

From source (Node.js 24, npm 10):

```bash
git clone https://github.com/sol-znn/syrius-extension.git
cd syrius-extension
npm ci --legacy-peer-deps
npm run build
```

Then **Load unpacked** and pick the `build` folder.

### Firefox

`syrius-extension-<version>-firefox.xpi` is signed by Mozilla for installing
outside its store. Open the file in Firefox 140 or later and confirm. Firefox
then updates it from later signed releases by itself.

A release Mozilla has not signed yet carries only
`syrius-extension-<version>-firefox-unsigned.xpi`. Load it from
`about:debugging`, **This Firefox**, **Load Temporary Add-on**. Firefox
removes it when it closes, so keep the recovery phrase backed up.

```bash
SYRIUS_PLATFORM=firefox npm run build   # into build-firefox/
```

A build from source is unsigned: load it from `about:debugging`, This Firefox,
Load Temporary Add-on.

### Android

Sideload only for now: no store listing. Each release has a signed
`syrius-<version>-android.apk`; open it on the phone to install. The app is
`network.zenon.syrius` and needs Android 7 or later; scanning uses Google Play
services' scanner, so it needs no camera permission.

A debug APK from source needs JDK 21 and the Android SDK as well:

```bash
SYRIUS_PLATFORM=android npm run build   # into build-app/
npx cap sync android
cd android && ./gradlew clean assembleDebug
```

The APK is `android/app/build/outputs/apk/debug/app-debug.apk`. It installs
as `network.zenon.syrius.debug`, "Syrius debug", beside the release. A debug
build from before that change took the release's ID: Android then answers the
release APK with "App not installed", until the debug build is uninstalled.
Uninstalling erases its wallets, so have the recovery phrase first.
`node tools/app-links/serve.mjs` serves a page of `syrius://` links and
requests to open on the phone ([tools/app-links](tools/app-links/README.md)).

### iOS

Each release has an unsigned `syrius-<version>-ios-unsigned.ipa`. Apple lets
an app onto an iPhone only once it is signed, and a free Apple ID's signature
lasts seven days, so install it with [SideStore](https://sidestore.io) or
[AltStore](https://altstore.io): either signs it with your Apple ID and renews
it on the phone before the seven days are up. The app is
`network.zenon.syrius` and needs iOS 15 or later.

CI builds the IPA on a macOS runner beside the Chrome package, and a release
publishes both. Building it yourself needs a Mac with Xcode:

```bash
SYRIUS_PLATFORM=ios npm run build       # into build-app/
npx cap sync ios
npx cap open ios                        # then build and run from Xcode
```

## Documentation

| | |
|---|---|
| [Development](docs/DEVELOPMENT.md) | Build, tests, the dev harness, releasing |
| [Setup](docs/SETUP.md) | A checkout that passes the same checks as CI |
| [Integrating a site](docs/INTEGRATION.md) | The `window.zenon` API, signatures, request limits, consent |
| [Requests from another app](docs/APP-REQUESTS.md) | `syrius://request` and its callback, for web apps and apps on Android |
| [Security notes](docs/SECURITY.md) | Where keys live, what a connection grants, locking |
| [Release checklist](docs/RELEASE-CHECKLIST.md) | Gates for a release candidate |
| [Browser test notes](docs/testing/) | What each browser fixture establishes |
| [Refactor notes](docs/REFACTOR.md) | The working notes behind the 0.3 rewrite |
| [Local test chain](tools/devnet/lab/README.md) | The devnet that harnessed test runs send to |
| [Privacy policy](privacy-policy.md) | |

## Layout

| | |
|---|---|
| `src/` | The extension: `pages`, `components`, `layouts`, `services`, `sections` (popup, worker, content scripts) |
| `src/platform/` | The app's side: the `chrome.*` stand-in, `syrius://` links and requests, fingerprint, scanner, notifications |
| `android/` | The Capacitor Android project, with the app's own QR scanner plugin |
| `ios/` | The Capacitor iOS project |
| `utils/` | The build, the dev harness and the test suites |
| `tools/` | Developer tools: the local test chain, the phone link page, icon generators, deliberate-regression lists, probes |
| `vendor/` | Vendored dependencies |
| `docs/` | Everything in the table above |

## License

MIT, see [LICENSE](LICENSE).

Experimental software. Use at your own risk, and check every transaction before
signing.
