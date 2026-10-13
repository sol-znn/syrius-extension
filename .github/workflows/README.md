# GitHub Actions workflow notes

The executable workflow is `build-and-release.yml` in this directory.

It builds the Manifest V3 extension with Node.js 24, runs the dependency audit,
lint checks, pinned Go-source ABI comparison, validation failure-path checks,
security regression suites and native browser fixtures registered in
`package.json`. A successful build creates a candidate ZIP with
`manifest.json` at its root.

Pushes to `main` automatically create the matching version tag and publish the
ZIP and SHA-256 checksum in a GitHub Release. The repository defaults to
`master`; pushes there, to `development` and to `manifest-v3` create validation
artifacts without an automatic release. A matching version tag provides the
alternate release path. The workflow verifies that the tag matches the manifest
version before building. A successful master run alone does not publish an
update.

Both release paths refuse an existing release for the version tag. Rerunning a
tag workflow cannot replace an already published ZIP or checksum; publish a
new version for different bytes. Before publication, any existing remote version
tag must resolve uniquely to the candidate commit. Tag workflows also reject a
missing tag; the automatic path may create one. This preflight does not lock a
tag against later changes. The publication regression runs the actual workflow
shell and tag query with an inert GitHub boundary. It does not create a release
or establish repository-enforced tag or release immutability.
See `docs/RELEASE-CHECKLIST.md` for the proposed final-candidate,
browser, distribution and maintainer-owned acceptance gates.

The workflow artifact is the extension ZIP itself; it is uploaded with
`archive: false` so GitHub does not wrap it in another ZIP. The checksum is
recreated for the GitHub Release using the ZIP basename and published alongside
the package, so it can be verified from an ordinary download directory.

Release-producing package jobs also generate GitHub-signed build provenance for
the exact Chrome ZIP, unsigned iOS IPA, signed Android APK and signed Firefox
XPI before uploading them. Only those four jobs request `id-token: write` and
`attestations: write`; the attestation steps use the release/signing conditions,
so PR and other validation runs skip them. For release acceptance, verify the
downloaded package against the expected workflow and full source commit:

```sh
gh attestation verify <file> -R sol-znn/syrius-extension \
  --signer-workflow sol-znn/syrius-extension/.github/workflows/build-and-release.yml \
  --source-digest <expected-full-source-commit> \
  --deny-self-hosted-runners --format json
```

Select that expected commit from independent package build records. A platform
attachment run can build a different commit from the release tag; a matching
filename or version is not a source pin. Keep the verified JSON result. These
verification options are documented in the [GitHub CLI manual](https://cli.github.com/manual/gh_attestation_verify).
An attestation binds the package digest to its workflow/source; it does not
establish application safety or retroactively attest an existing manually
uploaded package. Successful release-run generation and independent
verification remain required.

The ABI comparison requires the definitions checked out at the revision pinned
in the workflow. Missing or empty definitions fail rather than skip the check;
no Go compiler or running node is required. The native browser fixtures use the
runner's Chrome/Chromium executable, disposable profiles and synthetic inputs.
They qualify the exercised browser boundaries, not real wallet encryption or a
live network transaction. See `docs/SETUP.md` for local qualification commands.

After the production build, `utils/keyfile-lifecycle-browser-test.js` drives
that exact package in a disposable profile: create, unlock, backup, password
rotation, lock, expiry, restart, import and removal, on the packaged Argon2/AES
path. It waits out a real five-minute session expiry, so it adds about seven
minutes to a run. The fixtures above replace the SDK boundary and passed while
wallet removal was broken in production builds; this check is what would have
failed. See `docs/testing/KEYFILE-LIFECYCLE-TEST.md` for what it does and does not establish.

The pinned `znn-ts-sdk` commit is consumed as an HTTPS source archive rather
than a Git dependency. The upstream Git package runs a non-deterministic
`prepare` command that installs an unversioned `cipher-base` while applying a
patch for `cipher-base@1.0.4`; a fresh npm registry resolution can otherwise
make `npm ci` fail before the workflow reaches its checks.

No custom repository variables or secrets are required for this ZIP workflow.
The release job uses GitHub's built-in `GITHUB_TOKEN` with write permission
only in the release job. A CRX private key is intentionally not used: CRX
signing is not needed for loading the ZIP as an unpacked extension and a
rotating key would change the extension ID.

The audit is deliberately a hard gate for moderate, high and critical
advisories: `npm audit --audit-level=moderate`. Advisory data can change without
a lockfile change, so a previous passing audit does not establish the result at
a new candidate or release head. Run the complete workflow at that exact head.

The local `vendor/bigint-buffer` implementation replaces the old native package,
validates fixed-width conversions and is covered by a focused round-trip/bounds
test. Native Argon2 and its install script remain in the lockfile through the
pinned SDK. Hosted installation uses `npm ci --legacy-peer-deps` without an
explicit `--ignore-scripts` flag. Actual script execution depends on the npm
version and install-script approval policy; inspect the toolchain and install
log rather than inferring native Argon2 execution from a passing install.
Local checks using `--ignore-scripts` do not establish hosted installation or
native lifecycle execution. Browser WASM encryption is a separate qualification
boundary.

Do not lower the audit threshold, add an ignore list, or use
`continue-on-error` to make a real-funds release appear green. Assess any
remaining elliptic advisory against reachable uses in the legacy ethers/SDK
dependency chain. A cryptographic dependency migration requires separate review;
do not replace it with an unreviewed fork or suppress the audit result.

If release creation is denied by repository policy, allow workflows to request
read/write permissions under Settings → Actions → General. The workflow still
grants `contents: write` only to the release job.
