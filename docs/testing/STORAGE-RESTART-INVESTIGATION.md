# Storage after a browser restart

## Historical evidence

The second attempt of [master run 41707334522](https://github.com/sol-znn/syrius-extension/actions/runs/41707334522/attempts/2), at source `1db739cb4c566d4001e8dffd2f1fd7e38ce68ef6`, reached onboarding after a browser restart. It reported the same enabled installation and a normal prior browser exit. The fixture had already passed creation, password rotation and natural five-minute expiry. The production package member digest was `f8f4d8bb0460ced98420ad90ee707b070a36a6e53394c036099a30fa3ff65d39`.

That report recorded the route, not whether the saved-wallet key was absent, unreadable or malformed. Its owned profile was removed by cleanup. The log therefore does not establish that bytes were deleted, or permit a forensic attribution of that historical event.

## Matched-runtime control

[Inert diagnostic run 41725616957](https://github.com/edgepillar/Syrius-Extension/actions/runs/41725616957), at `936454cfb6754da98583939848f1144b2b826119`, used Chrome `156.0.8078.47` and Node `24.22.1`. Its production-browser helper digest was `8993e8cc77df14441c774d6c1fd6ff68f4e88dc7fdc6d770e41a531a14c644af`, matching the helper in PR #97's `225fbdfdc28648e5dac19a7227656067b8f4dcc7`.

The fixture uses no SDK, wallet, account, node or private material. Six fresh profiles were tested: three wrote public synthetic markers in the initial session, and three first completed an empty-profile preparation restart. Each then compared its markers across a clean browser restart.

- `localStorage`, `chrome.storage.local` and `chrome.storage.sync` retained their markers in all six observations.
- `chrome.storage.session` ended at the browser boundary in all six observations.
- The enabled installation, directory identity and path comparison remained consistent. The selected preference record had creation flags `38`, without the `INSTALLED_VIA_CDP` bit, before and after each measured restart.
- Every browser epoch reported active network guards, zero observed external responses and zero runtime/CSP errors. The owned fixtures were removed.

This control did not reproduce a generic storage deletion on the first post-reload restart. It does not prove that an empty-profile preparation restart caused the earlier successful wallet run. The historical root cause remains `NOT_ESTABLISHED`.

Chromium tag `156.0.8078.47` resolved to `1d17a2e2ee147bb7d6ae2ab6abdb3a2510c17775` during source inspection. Its [CDP loader](https://github.com/chromium/chromium/blob/1d17a2e2ee147bb7d6ae2ab6abdb3a2510c17775/chrome/browser/devtools/protocol/extensions_handler.cc) marks CDP installations, and [extension preference startup](https://github.com/chromium/chromium/blob/1d17a2e2ee147bb7d6ae2ab6abdb3a2510c17775/extensions/browser/extension_prefs.cc) contains `CleanUpCdpInstalledExtensions`. Those mechanisms exist, but the observed inert registrations did not retain that bit after the native reload. Their existence alone does not identify the historical failure.

## Confirmed application failure and correction

At `225fbdfdc28648e5dac19a7227656067b8f4dcc7`, `loadStorageWalletNames()` caught SDK/JSON read failures and returned an empty list. Startup used that result to choose onboarding. Controlled access and parse errors both reproduced this false fresh-wallet decision. This establishes a handling defect; it does not establish which condition occurred in the historical browser run.

Startup now opts into a strict read. Only an absent key or a valid empty object establishes an empty wallet store. An unreadable key, invalid JSON or invalid map shape produces the fixed E225 message and a Retry action. The read does not write, remove or repair saved data. Existing optional UI reads keep their previous contract.

The production lifecycle fixture separately injects a read refusal into one page, verifies that startup cannot show onboarding or the underlying diagnostic, removes the fault, and retries against the real encrypted wallet. This case is explicitly instrumented. Future failed lifecycle reports record only one of `ABSENT`, `UNREADABLE`, `INVALID_JSON`, `INVALID_SHAPE`, `EMPTY_OBJECT` or `NONEMPTY_OBJECT`, never saved values, names or exception contents.

The inert diagnostic can be run in a native qualification lane with `CHROMIUM_PATH` set:

```sh
node utils/storage-lifetime-browser-test.js
```

Its native profiles can contain links and sockets. Use the authorized hosted lane when local managed scratch permits only regular files. The regular-file read controls are `node utils/wallet-storage-read-test.js`; they do not execute a browser or establish native persistence.

Results remain tied to the named source, package and runtime. They do not qualify a version migration, a real device, live-chain behavior or a signed release.
