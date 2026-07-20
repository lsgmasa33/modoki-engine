# Signing & Notarizing the Modoki Editor (macOS)

The packaging pipeline is signing-ready: `electron-builder`
auto-signs when a **Developer ID Application** certificate is in the keychain, and
the `afterSign` hook (`scripts/notarize.cjs`) notarizes + staples when Apple
credentials are in the environment. Both are **one-time setup** you do once on your
machine (and/or in CI secrets); after that `npm run dist:mac` produces a signed,
notarized, stapled `.dmg` + `.zip`.

> **Account / Team ID:** use whichever Apple Developer account ships the desktop
> editor — it does **not** have to be the iOS app's team (`KQ6FQ2BS8H`). With the
> API-key notarization method below, the **issuer ID identifies the account**, so no
> team ID is needed for notarization; for *signing*, electron-builder picks the
> "Developer ID Application" cert in the keychain (if more than one account's cert
> is installed, set `mac.identity: "Developer ID Application: <Name> (<TEAMID>)"`
> in `electron-builder.yml` to disambiguate). Replace `<TEAMID>` below with that
> account's team id.

---

## Step 1 — Developer ID Application certificate (signing)

This cert is for distributing a Mac app **outside** the App Store (the right choice
for a desktop editor). Easiest path via Xcode:

1. **Xcode → Settings → Accounts** → make sure your Apple ID (the one on the
   the desktop-editor account's team) is added.
2. Select the team → **Manage Certificates…** → **＋** → **Developer ID Application**.
3. It's created and installed into your login keychain.

Verify:

```bash
security find-identity -v -p codesigning
# expect a line like:  1) ABC… "Developer ID Application: <Name> (<TEAMID>)"
```

(CLI alternative without Xcode: create a CSR in *Keychain Access → Certificate
Assistant → Request a Certificate from a Certificate Authority*, upload it at
developer.apple.com → Certificates → ＋ → *Developer ID Application*, download the
`.cer`, and double-click to install.)

---

## Step 2 — Notarization credentials

Pick **one** method and export the vars before building.

### A. App-specific password (simplest)

1. appleid.apple.com → **Sign-In and Security → App-Specific Passwords** → ＋ →
   name it "modoki-notarize" → copy the password.
2. Export:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="<TEAMID>"   # the desktop-editor account's team id
```

### B. App Store Connect API key (better for CI)

1. appstoreconnect.apple.com → **Users and Access → Integrations → App Store
   Connect API** → generate a key (role: *Developer*) → download the `.p8` (once!).
2. Export:

```bash
export APPLE_API_KEY="/path/to/AuthKey_XXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
```

---

## Step 3 — Build

```bash
npm run dist:mac
```

- Signing: automatic (cert in keychain). To force-skip for a quick unsigned build:
  `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir`.
- Notarization + stapling: automatic when Step-2 vars are set (the hook submits via
  `notarytool` and runs `xcrun stapler staple`). Without the vars it logs
  `[notarize] skipped` and produces an unsigned/un-notarized build.

Output: `release/Modoki-Editor-<ver>-arm64.dmg` (+ a `-mac.zip` for auto-update) —
a space-free, arch-tagged name (`artifactName` in `electron-builder.yml`), because
GitHub mangled the spaced `Modoki Editor-…` default to a dot on upload.

Verify the result:

```bash
codesign -dv --verbose=4 "release/mac-arm64/Modoki Editor.app"   # Authority: Developer ID Application…
spctl -a -vvv -t install "release/mac-arm64/Modoki Editor.app"    # source=Notarized Developer ID
xcrun stapler validate "release/mac-arm64/Modoki Editor.app"      # The validate action worked!
```

---

## Done

- **toktx binary bundling** — `scripts/stage-toktx.cjs` (beforePack) stages
  `toktx` + `libktx.4.dylib` into `build/bin`, shipped as `extraResources` →
  `Contents/Resources/bin`. toktx's existing `@executable_path` rpath resolves the
  sibling dylib (no `install_name_tool` needed); both are covered by the Developer
  ID signature, and `disable-library-validation` lets toktx load the dylib under
  hardened runtime. In-app texture *re-import* therefore works in a distributed
  build (model re-import still needs an external mesh toolchain — see
  `electron-builder.yml`).
- **App icon** — `build/icon.icns` (electron-builder auto-detects it).
- **Notarization verification** — the release workflow asserts `spctl` +
  `stapler validate` on the `.app` and `.dmg`, so a green release can't ship an
  un-notarized/un-stapled artifact.
- **Auto-update** — `electron-updater` against a release feed (`autoUpdate.ts`:
  `autoDownload` + `autoInstallOnAppQuit`, `quitAndInstall` on the interactive
  "Restart Now"). electron-builder emits the `.zip` + `latest-mac.yml` and publishes
  via `provider: generic` to the public GCS feed; `release.yml`'s "Set version from
  tag" step (`npm version` from `GITHUB_REF_NAME`) makes `latest-mac.yml` carry a
  real increasing version, and its "Publish update feed to GCS" step gsutil-uploads
  `latest-mac.yml` + zip + blockmap on a `v*` tag.
