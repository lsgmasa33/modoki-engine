# OTA updates

Ship a new version of a game — engine JS, game code, and assets — to already-installed
mobile apps without a store release. Modoki games run in a WebView, so an update can
replace *everything* the app renders; a native engine cannot do this for compiled scripts.
That asymmetry is the point of the feature.

All phases (0 through 5b — publish format + signing, the whole-bundle client + rollback
watchdog, delta transfer, the `rejected` quarantine, blocking/mandatory mode, sub-game
modules, the editor publish UX, and the public how-to guide) are shipped and device-verified
on iOS and Android. Sub-game modules get their own doc,
[ota-subgame-modules.md](./ota-subgame-modules.md); remaining open design questions and
follow-up work are tracked in
[plans/mobile-ota-updates-plan.md](./plans/mobile-ota-updates-plan.md).

## What it is

Three capabilities that turn out to be one mechanism: a **whole-bundle swap** is the
degenerate case of a **delta update** where nothing is cached locally, and a
**per-sub-game update** is a delta scoped to a named bundle. One client, one code path.

An update is a set of content-addressed files on a CDN plus a signed manifest. The running
app fetches the manifest, verifies its signature, works out which files it doesn't already
have, and asks native code to assemble the new version on disk. Nothing is swapped
mid-session: the native boot hook decides what the WebView serves, re-derived from
`state.json` on **every** launch, and a new version must boot successfully **twice** before
it is trusted. A version that fails to boot three times is reverted and permanently
quarantined on that device.

## Key files

| File | Role |
|---|---|
| `engine/scripts/ota/schema.mjs` | `release.json` / `manifest.json` schemas + `signingPayload` (sorted-key canonical JSON, so a signature is stable regardless of field order) |
| `engine/scripts/ota/signing.mjs` | Ed25519 via Node's built-in `node:crypto`; keys are raw 32-byte values, base64url via JWK export — so a public key bakes into an app as one string constant |
| `engine/scripts/ota-publish.mjs` | CLI: hash a `dist/`, upload content-addressed files + `bundle.zip`, merge/re-sign `release.json` |
| `engine/scripts/ota-keygen.mjs` | CLI: mint a signing keypair (refuses to overwrite — see Gotchas) |
| `engine/scripts/ota-embed-manifest.mjs` | CLI: write `ota-embedded-manifest.json` into a built `dist/`, enabling delta on a fresh install |
| `engine/packages/modoki/src/runtime/ota/otaClient.ts` | `checkForUpdate` — fetch, verify, diff, delegate to native. All the trusted decisions |
| `engine/packages/capacitor-modoki-ota/core/Sources/ModokiOtaCore/OtaCore.swift` | The pure boot/confirm/revert state machine (iOS) — every decision, zero I/O |
| `.../android/src/main/java/…/OtaCore.java` | The Java port of the same state machine — must behave identically |
| `.../ios/Sources/ModokiOtaPlugin/OtaPlugin.swift`, `.../OtaPlugin.java` | The I/O halves: download, SHA-256 verify, unzip, stage, activate, boot hook |
| `.../core/Sources/ModokiOtaCore/OtaZip.swift` | A from-scratch, narrowly-scoped ZIP reader (Foundation ships no ZIP-container parser) |
| `.../test-vectors/*.json` | The shared spec both platforms replay — see Testing |
| `engine/app/ota.ts` | Shell-owned check + `OtaGateState` pub/sub — the thing `App.tsx` actually calls |
| `engine/app/ui/components/LoadingOverlay.tsx`, `OtaRestartGate.tsx` | The download-progress bar and the "restart to continue" dead end (Phase 3b) |
| `engine/app/subgameLoader.ts`, `engine/app/gameRegistry.ts`, `engine/app/sharedRegistry.ts` | Sub-game discovery/loading, the baked+dynamic game registry, the shell-side shared-singleton registry — see ota-subgame-modules.md |
| `engine/plugins/backend/gcloud.ts` | Host-agnostic `gcloud` helpers shared by the publish route and the JSON status/keygen routes |
| `engine/packages/modoki/src/editor/panels/PublishOtaDialog.tsx`, `OtaKeysDialog.tsx` | The Build-menu publish + key-management dialogs |

## How it works

### Publish format

```
CDN/
  release.json                          # signed; the only no-cache entry point
  bundles/<name>/<version>/manifest.json
  bundles/<name>/<version>/files/<hash>  # content-addressed, immutable
  bundles/<name>/<version>/bundle.zip    # whole-bundle fallback
```

`release.json` — `{schema, bundles: {shell: "v12", …}, mandatory, minEngineApi, sig}`.
Per-bundle `manifest.json` — `{schema, name, version, engineApi, files: {"<path>": {hash, size}}, bundleZip?}`.

Only `release.json` is signed; it is the single trusted root. Everything else is reached by
content hash, so tampering with a file changes its address and fails verification.

### Signing

Ed25519. The private key lives outside the repo; the public key is baked into the app
binary. **Verification happens in JS** (`@noble/curves`), not native code — deliberately:
this JS is already running and already trusted (it shipped in a signed binary, or is itself
a previously-verified update), and Android's minSdk 31 predates native EdDSA (API 33), so
native verification would need a minSdk bump or a second hand-rolled curve implementation.
One audited library shared by both platforms is strictly better.

### The client flow

`checkForUpdate` (`otaClient.ts`) fetches `release.json`, verifies its signature, and
short-circuits if the target version is already `active` or `pending`. It then enforces
**two independent** engine-API gates — the release-level `release.minEngineApi` (checked
here, before any manifest fetch) and the per-bundle `manifest.engineApi` (checked after
fetching the target manifest) — before picking a **delta base** and calling native. Every
failure mode is a discriminated result, never a throw — an OTA check failing must never
crash a game the player is already looking at:

`up-to-date` · `no-release-for-bundle` · `signature-invalid` · `engine-api-too-old` ·
`manifest-invalid` · `no-bundle-zip-in-manifest` · `version-rejected` · `staged` (carries
`mandatory: boolean`, mirroring `release.mandatory`) · `pending-restart` (target is already
`pending` natively but never served — carries `version` + `mandatory`; see #509 below)

**Called from the app shell, not game code** (`engine/app/App.tsx` → `engine/app/ota.ts`),
BEFORE the scene loads — deliberately, so the blocking gate below has a call site that runs
before anything is on screen. Connection info (`baseUrl`, `publicKey`, `bundleName`,
`engineApi`) comes from the project's `project.config.json` `ota` block (`ota.enabled: false`
by default — an unconfigured project skips the check and the native plugin's dynamic import
entirely), not a per-game constant file.

**Progress + the mandatory blocking gate (Phase 3b).** `stageUpdate`/`stageUpdateDelta` emit
`otaProgress` (`{name, version, bytesDone, bytesTotal, filesDone, filesTotal}`) via
`notifyListeners` on both platforms — real byte-level ticks on Android (its chunked download
loop) and on iOS (a 200ms poll of the returned `URLSessionTask`'s
`countOfBytesReceived`/`Expected`, kept as a small diff on the existing `dataTask` rather
than a delegate-based `downloadTask` rewrite); iOS's delta path only reports
file-granularity, a deliberate platform asymmetry. `checkForUpdate` also takes an
`onWillStage` callback, fired once — right after the release is verified as genuinely
actionable, BEFORE the manifest fetch — with `{version, mandatory}`, so a caller can arm a
blocking UI for the WHOLE download instead of only after it completes. `engine/app/ota.ts`
wires both into a tiny pub/sub `OtaGateState` (`'downloading'` with live progress, or
`'ready-to-restart'`) that `App.tsx` subscribes to: `checkAppOtaUpdate()` resolves `false`
when a mandatory update just finished staging **on this call, or is already staged
(`pending-restart`) and awaiting a restart**, and the caller must never load the scene for
the rest of that app launch — `LoadingOverlay` (now with a `progress` prop: a determinate bar
when `bytesTotal>0`, an indeterminate sliding one otherwise) shows the download, then
`OtaRestartGate` takes over as a dead end ("Please close and reopen the app to continue.") —
never a mid-session hot-swap, which would bypass the two-boot confirm the watchdog is built
around. A routine (non-mandatory) release, any error, or a target already `active`/genuinely
`up-to-date` all resolve `true` — boot proceeds normally, staging (if any) continues in the
background exactly as before Phase 3b.

**`ready-to-restart` is sticky and terminal (#437).** Once `setGate` has been called with
`{phase: 'ready-to-restart', ...}`, a subsequent `setGate(null)` is refused regardless of
caller — clearing it would leave a dead-end shell with no gate and no content, so the
`OtaRestartGate` is the last screen for the rest of this app launch, full stop. This matters
because `checkAppOtaUpdate()` can be re-entered: `App.tsx`'s `[gameId]` boot effect can call it
again (a game swap) while an earlier call is still awaiting `checkForUpdate`, and the earlier
call is never cancelled. Two guards close that race:
- **A per-call generation counter** (`otaCheckGeneration`, bumped once per `checkAppOtaUpdate()`
  call) makes every gate write from a superseded call a no-op — the same epoch idiom as
  `loaders/fontLoader.ts`, `loaders/timelineCache.ts`, and `app/editor/setup.ts`'s
  `deviceListGeneration`.
- **`checkAppOtaUpdate()` short-circuits to `false` on entry once the gate is already
  `'ready-to-restart'`** — without it, a re-entrant call would find nothing left to stage,
  resolve `true`, and let `App.tsx` load a scene and run the whole game underneath a gate the
  user cannot dismiss.

**A staged mandatory update outlives the call that staged it (#509).** The two guards above
close the re-entrancy race for a call that finds nothing left to stage — but a re-entrant call
CAN still find something: call A arms the gate and is mid-download when call B (the same
`[gameId]` boot effect, re-running on a game swap) starts. The `ready-to-restart` guard doesn't
stop it — the gate is only `'downloading'` at that point — and B's `++otaCheckGeneration` makes
every later gate write from A a permanent no-op. A then `activate()`s, writing `pending[bundle]`;
B's `checkForUpdate` sees `pending === target`, and under the old code that collapsed to
`up-to-date`, so B resolved `true` and cleared the gate out from under A — the game booted past
a mandatory update. The shape is #501's: the code asked *"did THIS call stage something
mandatory?"* to answer *"is there a mandatory update this launch must not boot past?"* — the
second question is about durable native state, not a per-call return value. Severity, so nobody
re-derives it: native serves the `pending` bundle on the next cold start regardless, so the
torn-down gate cost one session on the old bundle, not a brick.

⚠️ **The trap in the fix** — `pending === target` is NOT the same as "waiting for a restart",
because `pending` survives the restart until two `confirmBoot`s across two launches promote it
to `active` (`OtaCore.requiredConfirms = 2`). Gating on `pending` alone would hold
`ready-to-restart` on the first two launches actually RUNNING the mandatory update — a permanent
brick, the exact failure `version-rejected`'s own contract warns against. `bootAttempts` is the
discriminator: `activate()` clears it when it writes `pending`, and the native boot hook
increments it when it SERVES the pending bundle, before the WebView loads — so 0/absent means
"staged, never run" (`pending-restart`) and `>= 1` means "running it now" (`up-to-date`). It was
already in the `state.json` blob `getState()` returns, just missing from the TS `NativeState`
interface, so this needed no native change. `release.mandatory` is already in hand at the
short-circuit (the release is fetched and verified earlier in `checkForUpdate`), which is why
`pending-restart` carries it with no extra fetch.

⚠️ **The native boot hook is now a HARD PREREQUISITE for any OTA-enabled project, and omitting it
bricks the app rather than degrading it.** The hook is a MANUAL per-game integration — one line in
`games/ota-test/ios/App/App/MyViewController.swift:21` (`OtaBootHook.run(name:)`) and one in the
Android `MainActivity.java:15` (`OtaPlugin.runBootHook(...)`) — and `engine/plugins/healNativeConfig.ts`
does **not** install it. A project that sets `ota.enabled` in `project.config.json` and forgets that
line still stages perfectly well: the plugin methods work, `activate()` writes `pending`, the gate
arms. But nothing ever increments `bootAttempts`, so `checkForUpdate` returns `pending-restart` on
every launch and a MANDATORY release holds `ready-to-restart` forever — an app that can never boot
again. Before #509 the same misconfiguration merely reported `up-to-date` and ran the old bundle, so
this is a failure mode the discriminator INTRODUCED at the far end of the range it protects.
`games/ota-test` is the only OTA-enabled project today and it is wired correctly; check this line
first when a second project adopts OTA.

⚠️ **The shell's confirm is NOT unconditional, and the reason is subtle** (found by #553's
close-out sweep, 2026-09-01). `App.tsx`'s boot effect calls `checkAppOtaUpdate()` and then, on
the "fully booted" signal, confirms. For a **routine (non-mandatory)** release those two happen
in the SAME launch: the check stages vNew and `activate()`s it, which writes `pending = vNew`
and clears `confirmedBoots` — so `pending` now names a version that is **not** the one
rendering. An unconditional `confirmBoot({name})` promotes whatever is pending, crediting vNew
with vOld's successful boot. vNew then reached `active` after **one** boot of itself instead of
the two `requiredConfirms` exists to demand. A MANDATORY release was never affected: the gate
returns early and this signal never fires.

`engine/app/ota.ts`'s `decideShellConfirm` (pure, unit-tested) gates it on the same
discriminator `checkForUpdate`'s `alreadyServed` check already uses — `bootAttempts > 0` means
the native hook SERVED the pending bundle before the WebView loaded, so this launch's frame
really is evidence about it. When it is, the confirm NAMES that version, so the native side
re-checks the attribution rather than trusting the caller. Same defect class as #553 (a
promotion decoupled from the version being promoted), one level up.

**The native splash is also dismissed on this same "fully booted" render** (`App.tsx`, right
alongside `confirmBoot`) — `@capacitor/splash-screen` is now in the engine's required-plugin
set (self-heals into every native project's `package.json` the same way `@capacitor/app`/
`keyboard`/`preferences` already do) and a FRESH `capacitor.config.json` sets
`plugins.SplashScreen.launchAutoHide: false` so the native splash waits for the explicit
`.hide()` call instead of racing Capacitor's own fixed ~3s timer. A project whose
`capacitor.config.json` predates this field keeps the old timer behavior (this function never
clobbers an existing config) — the `.hide()` call is a harmless no-op there.

### Delta transfer

`diffManifests(current, target)` is a pure path+hash diff. No rename detection is needed —
Vite's content-hashed filenames mean an unchanged chunk keeps its exact name, so a
path-level diff is already a content-level one.

The base to diff against is the currently-`active` OTA version if there is one, otherwise
the sentinel `"embedded"` — the bundle inside the app binary. That second case is why even
the **first** update on a fresh install doesn't need a whole-bundle download: the app ships
`ota-embedded-manifest.json` in its own assets, fetched over a bare relative URL with zero
network round-trip. Native resolves `"embedded"` specially — iOS copies from
`Bundle.main.resourceURL/public`, Android streams via `AssetManager.open("public/" + path)`,
since APK assets are not ordinary `File`s the way an OTA snapshot folder is.

If either base manifest can't be fetched (an older build with no embedded manifest, a CDN
blip), it silently falls back to the whole-`bundle.zip` path. **Delta is an optimization,
never a requirement for an update to succeed.**

### Staging and activation

Native downloads/copies into a `.tmp` directory and only renames it into place once every
file has been written and hash-verified — a partial version folder must never be visible to
the boot watchdog. `activate()` marks the version **pending**; it takes effect on the next
launch. There is no mid-session swap.

### The boot watchdog

This is the highest-stakes code in the feature: a bundle that crashes on boot must be
reverted *natively*, before the WebView loads, or the app is bricked permanently.

`OtaCore` (both platforms) owns every decision and does zero I/O, so it is unit-testable on
a plain host with no device. The rules:

- **Two-boot confirm** (`requiredConfirms = 2`). Promotion to `active` requires the app to
  reach its own "fully booted" signal on two *separate* launches. One rendered frame is not
  proof a bundle works.
- **Three attempts** (`maxAttempts = 3`). A single failed launch (OS-killed under memory
  pressure, an impatient force-quit during a slow first load) is not proof it's broken.
- **Per-bundle-name maps** for attempts/confirms, so two bundles pending at once can't roll
  each other back.
- **Every fallback terminates at the embedded bundle** — missing/corrupt `state.json`, a
  missing active folder, a missing pending folder are all explicit, tested cases.
- **`confirm()` is a no-op when nothing is pending**, so a normal launch can't wipe `active`.

### Quarantine (`rejected`)

When a version exhausts its boot attempts, `revert()` records it in
`rejected: {name: [versions]}` and `checkForUpdate` will never stage it again on that
device. Without this, revert erased all memory of the failure and the next launch re-staged
the same broken bundle — forever.

Three rules that look arbitrary and are not:

- **Only attempt exhaustion quarantines.** A *missing staged folder* reverts without
  quarantining: a vanished folder isn't proof the bundle is bad (OS disk-pressure cleanup, a
  cleaned-up partial stage), and re-staging is the correct heal there. Quarantining would
  permanently block a good version over a transient disk event.
- **It gates staging, never booting.** A version that reached `active` booted successfully
  twice and must keep booting — letting the list veto it at boot could strand a device with
  nothing to run.
- **FIFO-capped** (10 per bundle); this file is read on every cold boot.

**Recovery is fix-forward only: publish a NEW version number.** Quarantine is keyed by
version string.

`rejected` lives in `state.json`, which lives in app-private storage — an uninstall (or
`xcrun devicectl device uninstall app`) wipes it along with everything else. A device that
quarantined a version, gets fully uninstalled, then reinstalled has no memory of that
rejection and will happily re-stage the same broken version again. This is correct, not a
bug: quarantine is per-installation state, not a permanent device-level ban.

### Native integration — using Capacitor's own mechanism, not a parallel one

Capacitor 8 core already has an "OTA-served content" concept (the primitive Ionic Live
Updates / Appflow / Capgo build on). Modoki's boot hook does not reimplement path
resolution; it decides the one persisted value Capacitor's own shipped code already reads.
Read from Capacitor's source, not guessed:

- **iOS** — `persistServerBasePath()` writes `KeyValueStore["serverBasePath"]`, but
  `instanceDescriptor()` (the sanctioned override point, called before the WKWebView exists)
  trusts only that value's **last path component**, reconstructing the directory as
  `<Library>/NoCloud/ionic_built_snapshots/<lastPathComponent>`. OTA folders **must** live
  there, named by last component only — a free-form directory silently would not work.
  Hook: `OtaBootHook.run` from `MyViewController.instanceDescriptor()`.
- **Android** — `Bridge.loadWebView()` reads a **full absolute path** from
  `SharedPreferences("CapWebViewSettings")["serverBasePath"]`, verified with
  `File.exists()`. No fixed-base convention; folders can live anywhere under the app's files
  dir. Hook: `OtaPlugin.runBootHook()` from `MainActivity.onCreate()`, before `super`.
- **Both** gate on `isNewBinary()` (comparing `CFBundleVersion`/versionCode against what was
  last seen), so a genuine store update automatically falls back to the embedded bundle
  before our code runs. A free safety net — but see Gotchas.

`state.json` lives natively beside the bundles, **not** in PlayerPrefs: PlayerPrefs is
namespaced per game and rehydrated on game swap, its writes are debounced, and on Android
its backend uses `apply()` so an awaited `set` isn't on disk. OTA state must outlive game
swaps, be durable, and be readable by native code **before the WebView loads**.

### Sub-game modules

A `games/<id>` project can ship as its own OTA bundle instead of being baked into the shell —
one release can carry several independently-updatable games. Full design (the `globalThis`
shared-singleton registry, the per-sub-game Vite build target, dynamic `GAMES` discovery, the
`ENGINE_API_VERSION` exact-equality contract) lives in its own doc:
**[ota-subgame-modules.md](./ota-subgame-modules.md)**. Key runtime files:
`engine/app/sharedRegistry.ts` (the shell-side registry), `engine/app/subgameLoader.ts`
(discovers + loads staged sub-game bundles, sequentially — see that doc's §3 for why),
`engine/app/gameRegistry.ts` (baked + dynamic game lookup), `engine/plugins/subgameBuild.ts` +
`engine/scripts/build-subgame.mjs` (the sub-game build target).

### Publishing

`engine/scripts/ota-publish.mjs` hashes a built `dist/` into a content-addressed manifest,
uploads it additively to a GCS bucket, then merges/signs/re-uploads `release.json`. It's
wrapped by a safety-railed pipeline reachable two ways:

- **Editor UI** — Build menu → **Publish OTA Update…** (`PublishOtaDialog.tsx`) and **OTA
  Keys…** (`OtaKeysDialog.tsx`), both gated by `editorStore` open/close pairs.
- **MCP tools** — `modoki_ota_publish` / `modoki_ota_status` / `modoki_ota_keygen`
  (`engine/tools/modoki-mcp/src/index.ts`), thin wrappers over the same backend routes.

Both surfaces hit `GET /api/ota/publish` (SSE, `engine/plugins/vite-asset-scanner.ts`) which:
(1) builds **fresh** from the currently-open project's `project.config.json` via
`build-web.mjs` — never accepts a stale pre-built `dist/`; (2) refuses a version-string
collision by checking whether `bundles/<name>/<version>/manifest.json` already exists, and
suggests the next free `vN`; (3) verifies/sets bucket CORS as a non-fatal preflight; (4) runs
`ota-publish.mjs`. `GET /api/ota/status` and `POST /api/ota/keygen` are plain JSON, served
from the transport-agnostic `editorBackendRouter.ts` so they also work in a packaged Electron
editor. `engine/plugins/backend/gcloud.ts` holds the shared, Vite-import-free helpers both
routes need: `resolveGcloudDir` (locates the `gcloud` CLI even in a Finder-launched packaged
editor's minimal `PATH`), `deriveGcsBucketFromBaseUrl` (reverses `ota.baseUrl`'s
`https://storage.googleapis.com/…` form to the `gs://…` form `gcloud` needs), and
`OTA_SAFE_TOKEN`/`OTA_SAFE_BUCKET` (regexes every interpolated value is checked against before
it touches a `bash -c` string).

**This pipeline only ever builds and publishes the shell bundle** — see the Gotchas entry
below on the bundleName restriction; publishing a sub-game bundle is still a manual
`build-subgame.mjs` + `ota-publish.mjs` invocation, not wired into the UI/MCP surface.

## Gotchas

- **The OTA bucket needs CORS** (`origin:["*"], method:["GET","HEAD"]`). Object storage
  typically sets none by default, and `curl`/CLI tools ignore CORS entirely — so nothing
  catches this until a real WebView `fetch()` fails, and `checkForUpdate` reports it as the
  generic `no-release-for-bundle`. Silent.
- **Never reuse a version string.** Any device that quarantined `v12` refuses a republished
  `v12` forever. It looks fine to the publisher and silently isn't for affected players.
- **Never regenerate the signing key** for a published app. Every installed binary has the
  old public key baked in and will reject everything you publish afterwards. `ota-keygen.mjs`
  refuses to overwrite for this reason.
- **The deploy step must be additive.** The normal site deploy uses
  `--delete-unmatched-destination-objects`, which would wipe bundles that already-shipped
  clients are still fetching. `ota-publish.mjs` deliberately does not.
- **Publish only a `dist/` built from the current project config.** `ota-publish.mjs` uploads
  whatever directory you point it at — it does not build, and does not read
  `project.config.json`. Publishing a stale `dist/` will silently overwrite a freshly-fixed
  native install over the air.
- **Android: a stale Gradle incremental asset-merge** can produce an APK that contains
  `ota-embedded-manifest.json` per `unzip -l` while the WebView's `fetch` 404s it. A
  `gradlew clean` fixes it. Fails silently — a missing embedded manifest is an expected
  "fall back to whole-zip" case, so you just quietly lose delta. Not observed on iOS, but not
  proven immune either.
- **iOS: native `print()` is invisible** without an attached debugger — no `os_log`, nothing
  in device log tools. Verify via the JS-level result, pulled `state.json`, and staged-folder
  contents instead. (Android's `Log.d` *does* surface via `logcat`.)
- **Android: `adb install -r` over an existing install can serve stale WebView-cached JS**,
  even after a `gradlew clean` rebuild and a fresh `install -r` of the new APK — observed
  during the Phase 3a call-site move (2026-07-25): the freshly-built + freshly-installed APK
  kept logging the OLD (deleted) code's console message. `adb uninstall` first, then a plain
  `install` (no `-r`), fixed it. Same failure family as the documented iOS WKWebView
  stale-cache-on-redeploy issue — assume BOTH platforms need a clean uninstall when a
  native-JS change doesn't seem to take, not just iOS.
- **A crash-looping app cannot discover its own fix.** `checkForUpdate` runs after the scene
  is ready, which a broken bundle never reaches. Self-healing is necessarily two-phase: the
  watchdog reverts first, and only the next successful boot can see a new release. This
  matches how CodePush/Appflow-style clients behave.
- **`state.json` is reset on a detected new-binary event** (fixed 2026-07-26).
  `OtaCore.resetForNewBinary` compares a persisted `lastSeenBinaryVersion` (the app's own
  `CFBundleVersion`/`versionCode`, stamped every boot) against the CURRENT one, called from
  `OtaBootHook.run`/`OtaPlugin.runBootHook` before every `boot()` decision. A genuine change
  clears `active`/`pending`/`bootAttempts`/`confirmedBoots` (a fresh binary already ships
  its own latest embedded code — there's nothing meaningful left to resume) but **preserves
  `rejected`** — a version already proven bad has no reason to become stageable again just
  because the binary changed. A `nil`/absent `lastSeenBinaryVersion` (fresh install, or a
  state.json written before this field existed) does NOT trigger a reset — it only starts
  tracking from that point, so an upgrading device's real, still-valid state is never nuked
  just because the field was never populated before. Unit-verified (both platforms replay
  4 new golden-vector scenarios via `swift test` / the Java self-test — see Testing below)
  AND **device-verified on BOTH platforms** (2026-07-26, `games/ota-test`, real
  pre-existing state on each device — Android had `active:{shell:v17,
  ota-subgame-test:v1}`, `pending:{shell:v18}`; iOS had `active:{shell:v17}`,
  `pending:{ota-subgame-test:v1}`): bumping the binary version (`versionCode` on Android,
  `CURRENT_PROJECT_VERSION` on iOS) and reinstalling (not uninstalling — the whole point is
  testing app-data persistence across a binary change) first left that state UNTOUCHED on
  BOTH devices and only stamped `lastSeenBinaryVersion` — the "never seen a version before"
  no-reset case, proven live twice, not just in a vector. A SECOND version bump then reset
  `active` to `{}` on the next boot, on BOTH platforms — a state no other code path in
  `boot()`/`confirm()` ever produces (they only ever move entries between `active`/
  `pending`, never wipe `active` to empty), so this is decisive evidence the reset actually
  fired rather than a coincidental side effect of normal boot progression.
- **Out of scope by construction:** a bundle that boots fine and breaks hours later in a
  gameplay path. Catching that needs crash-loop telemetry against an already-confirmed
  version and N-2 fallback retention — a boot-time watchdog cannot see it.
- **`/api/ota/publish`'s `bundleName` must equal the currently-open project's own
  `ota.bundleName`** (fixed 2026-07-26). A fresh-eyes review caught that the route always
  builds via `build-web.mjs` (a normal shell build) and always publishes the open project's
  own `dist/` — it never runs `build-subgame.mjs`. Before this was guarded, overriding
  `bundleName` to a different bundle (e.g. a sub-game's) would silently publish this
  project's plain shell content under that OTHER bundle's identity, corrupting it with no
  error at publish time. The route (and `PublishOtaDialog`'s now-disabled Bundle field)
  refuse any mismatch instead. Publishing a sub-game bundle still needs a manual
  `build-subgame.mjs` + `ota-publish.mjs` invocation — see ota-subgame-modules.md. The
  check itself is `otaPublishBundleNameAllowed` (`vite-asset-scanner.ts`) — extracted as a
  pure function, same convention as this file's other route-logic helpers
  (`isValidBuildPlatform`, `isSseRoute`, …), so it's unit-tested without needing a live
  editor/gcloud (`viteAssetScanner.test.ts`).
- **`release.json`'s read-merge-write is now an optimistic-concurrency loop** (fixed
  2026-07-26). Two publishes racing for different bundle names (e.g. `shell` and a sub-game)
  used to be able to both read the same pre-publish `release.json`, with the second writer's
  merge silently dropping the first's just-published entry. `ota-publish.mjs` now reads the
  object's generation alongside its content and uploads with `gcloud storage cp
  --if-generation-match=<generation>` (`=0` idiomatically means "must not exist yet", for
  the first-ever-publish case); a precondition failure (real `GcsPreconditionFailedError`,
  confirmed against the actual bucket) re-fetches + re-merges + retries, up to 5 times,
  instead of silently losing the loser's write. Verified against a real GCS bucket AND with
  a deterministic fake-`gcloud` subprocess test that injects one race
  (`engine/tests/plugins/otaPublishReleaseRace.test.ts`).
- **The version-collision check now distinguishes "never published" from "gcloud call
  failed"** (fixed 2026-07-26). The `/api/ota/publish` preflight used to catch ANY
  `gcloud storage cat` error and treat it as "no collision, proceed" — a transient
  auth/network blip could let a publish past the one guard meant to stop a rejected version
  from being silently republished. It now inspects stderr: only "not found: 404" / "matched
  no objects or files" (the real "never published" cases) are treated as safe; anything else
  fails the publish loudly with the actual error. The classification is
  `isGcloudObjectNotFoundError` (`vite-asset-scanner.ts`), extracted the same way and
  unit-tested alongside `otaPublishBundleNameAllowed`.
- **Key-path resolution is no longer duplicated** (fixed 2026-07-26). `ota-publish.mjs`
  used to always derive its own repo root from `import.meta.url`, independently of the
  `/api/ota/publish` route's OWN key-existence precheck (`editorRoot || projectRoot`) — two
  resolutions with nothing enforcing they agree. The script now accepts `--repo-root`, and
  the route passes its own `buildCwd` through explicitly, so both sides always resolve the
  signing key from the same value.
- **A sub-game's script-load ordering race** (fixed 2026-07-26). `subgameLoader.ts` used to
  load every staged sub-game concurrently (`Promise.all`); now sequential — see
  ota-subgame-modules.md §3 for why concurrent loading raced a single shared global.

## Testing

The pure state machine is replayed by **both** platforms against the same shared vectors —
`ota-golden-vectors.json` (boot/confirm/revert, plus `resetForNewBinary`),
`ota-gate-vectors-phase3.json` (quarantine) and `ota-subgame-vectors-553.json` (the sub-game
load-failure dispositions and the versioned confirm), 40 scenarios total. A native divergence
between Swift and Java fails there instead of shipping.

⚠️ **A device observation about OTA proves nothing until you pin which bundle is running.** The
app boots a PUBLISHED shell bundle, not your working tree, so a phone can be internally
consistent and describe code that is months old — #553's first three device runs all measured a
shell predating #540 and every conclusion had to be retracted. Before trusting any result:
rebuild the shell from your branch and install it, then grep the built bundle for a string your
branch added or removed and confirm the running bundle's filename in logcat matches what the
build emitted. Then cold starts only (`am start -W` reporting `LaunchState: COLD`, empty `pidof`
beforehand — `monkey` on a live process merely foregrounds it and yields no boot logs), full
`logcat -d` to a file rather than `-t` (which truncates past the startup window on a chatty
device), and assert a positive control before believing any negative result.

**Both replays are legs of `npm run test:native`** (`engine/scripts/test-native.mjs`) — the
on-demand native gate, added in #376. Until then they existed only as the two hand-typed recipes
below, so they ran when somebody remembered; the runner reports a leg it cannot run on this machine
as a loud SKIP rather than a silent absence. `npm run verify` is vitest and can run neither, so
their silence there is deliberate. The equivalent by hand:

```
cd engine/packages/capacitor-modoki-ota/core && swift test
cd engine/packages/capacitor-modoki-ota && javac -d /tmp/x \
  android/src/main/java/.../OtaCore.java android/src/test/java/.../{MinimalJson,OtaCoreSelfTest}.java \
  && java -cp /tmp/x ...OtaCoreSelfTest test-vectors/ota-golden-vectors.json
```

Both harnesses have been sanity-checked by deliberately sabotaging a constant and
confirming the suite catches it — they are real assertions, not passing scaffolding. The
JS client has its own unit suite (`engine/packages/modoki/tests/runtime/ota/`).

Two gaps found while wiring the runner (2026-08-27), one closed and one open:

- **Closed.** The vector files declare a `constants` block (`maxAttempts`, `requiredConfirms`) that
  NOTHING read: setting `maxAttempts: 4` in the fixture left both implementations on 3 and all 27
  scenarios still passed. Both replays now assert the fixture's constants against `OtaCore`'s own
  (`testFixtureConstantsMatchImplementation` / `checkConstants`), and that check was verified to go
  red under exactly that edit.
- **Open.** `OtaZipTests.testRoundTripAgainstNodeProducedZip` XCTSkips unless `/tmp/ota-test.zip`
  exists, and its header's regeneration command is elided (`...`). So the cross-tool ZIP check —
  the one that proves `OtaZip` parses authentic ZIP structure rather than its own writer's output —
  does not run in the gate. Restoring the exact fixture command, or building it in-test, would
  close it.

`games/ota-test` is the committed device-verification fixture (both native targets, a
full-screen "OTA TEST vN" scene so a glance at the phone identifies the running bundle).
The device loop, current key/bucket state, and per-platform relaunch recipes live in the
plan doc — they involve private infrastructure and are deliberately not duplicated here.

## Related

- [ota-subgame-modules.md](./ota-subgame-modules.md) — the sub-game module mechanism this doc only summarizes
- [plans/mobile-ota-updates-plan.md](./plans/mobile-ota-updates-plan.md) — open design questions, known follow-up gaps, the device-test loop
- [build.md](./build.md) — the build pipeline an OTA payload comes out of
- [native-and-sdks.md](./native-and-sdks.md) — the Capacitor plugin pattern this follows
- [player-prefs.md](./player-prefs.md) — the other persistence store, and why OTA state isn't in it
