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
| `engine/scripts/ota-publish.mjs` | CLI: hash a `dist/`, upload content-addressed files + `bundle.zip`, merge/re-sign `release.json`. Requires `--project <dir>` (#582) — reads that project's `project.config.json` to enforce the signing-key-identity + dist-kind guards itself |
| `engine/scripts/ota-keygen.mjs` | CLI: mint a signing keypair (refuses to overwrite — see Gotchas) |
| `engine/scripts/ota-embed-manifest.mjs` | CLI: write `ota-embedded-manifest.json` into a built `dist/`, enabling delta on a fresh install. Requires `--project <dir>` (#582) — refuses a `--name` that doesn't match the project's resolved `ota.bundleName`, and a `--dist` outside `--project` |
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

`release.json` — `{schema, bundles: {shell: "v12", …}, mandatory, minEngineApi, manifests?, seq?, sig}`.
Per-bundle `manifest.json` — `{schema, name, version, engineApi, files: {"<path>": {hash, size}}, bundleZip?}`.

Only `release.json` is signed; it is the single trusted root. Everything else is reached by
content hash **chained back to that root** — see § The trust chain.

### Signing

Ed25519. The private key lives outside the repo; the public key is baked into the app
binary. **Verification happens in JS** (`@noble/curves`), not native code — deliberately:
this JS is already running and already trusted (it shipped in a signed binary, or is itself
a previously-verified update), and Android's minSdk 31 predates native EdDSA (API 33), so
native verification would need a minSdk bump or a second hand-rolled curve implementation.
One audited library shared by both platforms is strictly better.

### The trust chain

The signature answers *"which version should this device run"*. On its own that does **not**
answer *"what is in that version"* — and every integrity check in the staging path verifies
downloaded bytes against hashes that come out of `manifest.json`. So the release also commits
to the manifest itself:

```
release.json  (Ed25519-signed)
  └─ manifests[<name>] = sha256 of that bundle's CURRENT manifest.json
       └─ manifest.files[<path>].hash  →  the staged tree, verified natively
       └─ manifest.bundleZip.hash      →  the whole-zip download
```

`manifests` is a map of bundle name → the sha256 of that bundle's manifest, in lowercase hex.
The hash is taken over the manifest's **canonical serialization** —
`JSON.stringify(sortKeysDeep(manifest))`, the same canonicalization `signingPayload` uses for
the release — not over the raw file bytes, so reformatting the JSON in the bucket cannot break
an update. `signingPayload` has no field allowlist, so the map is covered by the existing
signature with no new key material and no `schema` bump.

**What this closes.** Exploiting the gap needs *write access to the bucket*, not a network
position (HTTPS covers the wire). Such an attacker still cannot forge a version pointer — they
lack the key — but before #570 they could rewrite an existing version's `manifest.json` plus
the content-addressed files it names, and the client would stage it, verify it against the
attacker's own hashes, and be satisfied. Now the manifest is pinned by the signature too.

**The field is optional, and the client enforces it only when present.** It is optional purely
for schema compatibility: both validators compare `schema` with exact equality, so bumping the
version would make every already-shipped client reject every future release, permanently. (Same
additive-compat reasoning as `manifest.bundleZip`.) An attacker cannot simply *strip* the field —
`release.json` is signed, so removing it invalidates the signature.

**Anti-rollback (#571) closes release REPLAY.** `release.json` carries an optional monotonic
`seq`, bumped by `ota-publish.mjs` on every publish (`(existingRelease?.seq ?? 0) + 1`, recomputed
inside the same `--if-generation-match` retry loop `bundles`/`mandatory`/`manifests` already use,
so two racing publishes still produce two distinct, strictly increasing values). Each device
persists the highest `seq` it has ever seen natively (`OtaState.highestSeenSeq`, a single
device-wide counter — unlike every other `OtaState` field it is not per-bundle, because `seq` is a
property of the release *document* as a whole). `checkForUpdate` refuses any release whose `seq` is
lower than that high-water mark (`seq-rollback`), **before** any bundle-version comparison — so a
replayed release is refused outright rather than merely folding into an unremarkable `up-to-date`.
Recording happens on **every** signature-valid, non-rollback release, including an up-to-date one
(`ModokiOtaPlugin.recordSeq`, called right after signature verification) — skipping that on the
common up-to-date path would leave the high-water mark stuck at whatever it was when a bundle last
actually staged, reopening the replay window for any release published while the device stayed
current.

An absent `seq` (a pre-#571 release, or one from a publisher predating this feature) is treated as
`0` — the same additive-compat contract `manifests` uses, and it means a device that has already
recorded `seq > 0` refuses a pre-#571 replay too, closing exactly the "restores the exact gap #570
closed" flavor of the original issue. **This has a bootstrap limit, by design**: a device's very
first-ever check has `highestSeenSeq = 0`, so it cannot yet detect a rollback — no different from
`rejected` starting empty on a fresh install. And a publisher checkout predating #571 disarms this
per-publish exactly like the `manifests`-disarming case above, for the same reason (an old
publisher never sets `seq` at all, so the field stays absent going forward until re-published by a
current publisher) — same tool-version-skew caveat, not a coding mistake.

⚠️ **A publisher older than #570 disarms the guard for EVERY bundle in one publish.** A checkout,
branch or tag predating this change re-signs `release.json` without the field and without
spreading the existing map — validly signed, no error, every client silently back to unverified
manifests. Tool-version skew, not a coding mistake, and nothing detects it.

**Coverage is per-bundle and starts empty.** Publishing writes `manifests[<name>]` only for the
bundle being published, so on a multi-bundle bucket every other bundle stays unenforced until it
is next republished. `ota-publish` warns about the gap; nothing errors on it.

**What is deliberately NOT verified this way.** The release commits to the *current* version's
manifest only, so the delta path's **base** manifest — an older OTA version's, or the one
embedded in the app binary — is not covered. On a **#556-or-later native plugin** that is not a
hole: a lying base manifest cannot forge contents, because native verifies the whole staged tree
against `files`, which comes from the now-authenticated *target* manifest, so the worst it can do
is make verification fail and fall back to a whole-zip download.

⚠️ That argument is conditional on the native binary, and **native cannot be OTA-updated**. Both
plugins skip staged-tree verification entirely when `files` is absent (the pre-#556 legacy
tolerance), and a plugin predating #556 ignores the parameter altogether. On an app already
installed with such a binary, a tampered base manifest can still claim its hash for a path equals
the target's — so that file is copied off local disk, never downloaded and never verified. #570
does not reach that; only shipping a new native build does.

⚠️ **Publishing merges `manifests` the same way it merges `bundles`.** Dropping another
bundle's entry would silently switch that bundle's already-shipped clients back to unverified
manifests — the failure would be invisible, since nothing errors when the field is simply
absent.

### The client flow

`checkForUpdate` (`otaClient.ts`) fetches `release.json`, verifies its signature, and
short-circuits if the target version is already `active` or `pending`. It then enforces
**two independent** engine-API gates — the release-level `release.minEngineApi` (checked
here, before any manifest fetch) and the per-bundle `manifest.engineApi` (checked after
fetching the target manifest) — before picking a **delta base** and calling native. The target
manifest is checked against `release.manifests[<name>]` immediately after `validateManifest` and
before the per-bundle `manifest.engineApi` gate (the release-level gate has already run, before
the manifest was even fetched), so a tampered manifest is refused (`manifest-untrusted`) without
ever reaching native. Every
failure mode is a discriminated result, never a throw — an OTA check failing must never
crash a game the player is already looking at:

`up-to-date` · `no-release-for-bundle` · `signature-invalid` · `seq-rollback` (release `seq` is
below this device's recorded high-water mark — see § The trust chain's anti-rollback section) ·
`engine-api-too-old` · `manifest-invalid` · `manifest-untrusted` · `no-bundle-zip-in-manifest` ·
`version-rejected` · `staged` (carries `mandatory: boolean`, mirroring `release.mandatory`) ·
`pending-restart` (target is already `pending` natively but never served — carries `version` +
`mandatory`; see #509 below)

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
- **A per-call supersession token** (`otaCheckEpoch`, `createSupersessionToken` from
  `runtime/core/liveness.ts`, `begin()` called once per `checkAppOtaUpdate()` call) makes every gate
  write from a superseded call a no-op — the same shape as `app/editor/setup.ts`'s
  `deviceListEpoch`. ⚠️ Not the same as `loaders/fontLoader.ts` / `loaders/timelineCache.ts`, which
  this once claimed: those are `createTeardownToken` — they bump when the cache is CLEARED, not when
  a new attempt starts, so an outstanding load survives a newer one there and loses here. The two
  read alike and answer different questions; see [async-lifetime.md](./async-lifetime.md).
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
`games/ota-test/ios/App/App/MyViewController.swift` (`OtaBootHook.run(name:)`) and one in the
Android `MainActivity.java` (`OtaPlugin.runBootHook(...)`) — and `engine/plugins/healNativeConfig.ts`
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

A **failed delta stage falls back the same way** (#556). This matters more than it looks:
a delta's `copy` entries come off the local disk, so a device-local corruption can fail
verification even though the PUBLISHED bytes are perfectly good — and re-staging genuinely
might fix it, unlike the whole-zip case. Failing the update there would let one bad local
file block a good published version. The fallback is reported through `onDeltaFallback`
rather than swallowed, because it silently turns a small delta into a full bundle download
and an unexplained bandwidth spike is undiagnosable after the fact.

⚠️ `activate()` sits deliberately OUTSIDE that try. Inside it, a failed activate would fall
through and re-download a whole bundle for a version that had already staged correctly —
and the retry would hit the same failing activate anyway.

### Staging and activation

Native downloads/copies into a `.tmp` directory and only renames it into place once every
file has been written and hash-verified — a partial version folder must never be visible to
the boot watchdog. `activate()` marks the version **pending**; it takes effect on the next
launch. There is no mid-session swap.

⚠️ **That sentence was aspirational until #556.** `copy` entries were taken byte-for-byte
off disk and hashed by NOBODY — only `download` entries were verified, each against its own
hash — and the whole-zip path hashed the zip but never the files it then wrote. Both paths
now verify the **whole staged tree** against the target manifest before the rename: strict
set equality plus a hash per file. Strict is provably safe rather than hopeful —
`ota-publish.mjs` builds the zip from `Object.keys(files)` and `diffManifests` partitions
that same key set into `copy`+`download`, so the staged set must equal the manifest's on
both paths. The decision half is pure in `OtaCore` (case-insensitive hex, deterministic
first-problem-by-sorted-path) so the two ports cannot report different failures for one
input.

Why it mattered: the quarantine ruling below rests on "a staged bundle's bytes are exactly
what was published, so retrying fetches identical broken bytes." That premise simply did not
hold on the delta path, and the honest fix was to close the hole rather than weaken the
quarantine.

⚠️ **The `files` parameter is a compatibility trap: making native REJECT its absence bricked
a real device.** #556 made `files` required on `stageUpdate`/`stageUpdateDelta` and had
native reject a call missing it. But **the JS calling these methods is itself delivered over
OTA**, so it can be OLDER than the native binary that's running it — a device that had
`shell-v26` staged before #556 shipped, then received a native update, was running post-#556
native against pre-#556 JS. Measured on a real Galaxy A23: every `checkForUpdate` failed with
`stageUpdateDelta requires name, version, baseVersion, copy, files`, and since the boot hook
always prefers OTA-staged content over the freshly-installed embedded bundle, **no new app
binary could ever rescue that device** — it was stuck on its pre-#556 version permanently.

The fix: native tolerates an **absent** `files` (treats it as a pre-#556 legacy caller, skips
the whole-tree verification, logs loudly, and stages exactly as pre-#556 code did) but still
**rejects** a `files` that is present-but-malformed — that's a genuine bad payload, not a
compatibility case. The TS definitions keep `files` required — our own JS must always send
it; only the native runtime tolerates its absence, and only because a JS bundle published
before the field existed cannot possibly send it. This is the mirror image of
`isPluginUnimplemented` in `engine/app/subgameLoader.ts` (old native + new JS); this is new
native + old JS. Any future required parameter added to either of these two methods needs the
same tolerance on the native side, for the same reason.

⚠️ **The staging contract is a COMPATIBILITY surface, because the JS that calls it ships over
OTA and can be older than the native binary.** #556 made `files` a required native parameter and
that bricked every device holding a pre-#556 bundle: `stageUpdateDelta requires ... files`, no
update could stage, and a new app binary did not rescue it because the boot hook prefers staged
content over embedded. Native now tolerates an absent `files` (skips verification, logs loudly);
a malformed one still rejects. The TypeScript type keeps it REQUIRED — our own JS must always
send it, and only the runtime tolerates a caller older than itself. Mirror of
`isPluginUnimplemented` in `subgameLoader.ts`, which handles the opposite skew. **Every gate was
green throughout: `verify` and `test:native` only ever pair new JS with new native, which is the
one combination that cannot fail.**

**Superseded version folders are reclaimed** (#563; device-verified on a Galaxy A23,
2026-09-02 — a phone holding `shell-v20` alongside an `active` of `shell-v26` dropped the
orphan on the next boot, 11 MB to 6.6 MB, while the unrelated bundle `ota-subgame-test-v1`
was left untouched and `state.json` came back byte-identical; and on an iPhone 8, where
`shell-v28` was reclaimed once `v29` went active). ⚠️ The reclaim lands on the boot AFTER a
promotion, not the boot that promotes it — `confirmBoot` runs mid-session, long after the boot
hook's prune has already decided, so the outgoing version is still `active` at prune time. One
boot too few reads exactly like "pruning is broken". Nothing used to delete them, so every
update permanently added a full bundle copy to device storage. Everything except `active`
and `pending` is prunable — `revert()` falls back to `active`, and to embedded only if that
is gone, so those two are the only folders the state machine can ever target. The prune runs
off the boot critical path and can never throw out of boot.

⚠️ **Version folders are flat and named `"<name>-<version>"`, and bundle names contain
hyphens.** Splitting on the pruning bundle's own `name-` prefix made `ota` parse `ota-test-v1`
as version `test-v1` and delete a LIVE folder belonging to another bundle. Ownership is
therefore decided in `OtaCore` by **longest** known-bundle-name prefix, over every bundle
appearing anywhere in state; a folder belonging to no known bundle is never touched. Note
`folderExists` composes names the same ambiguous way — it is merely not destructive about it.

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
- **At most one confirm per counted boot attempt** (`confirmedBoots[name] >= bootAttempts[name]`
  → no-op). Without it the bullet above was aspirational rather than enforced: a webview reload
  gives a brand-new JS realm and so a second `confirmBoot`, but it does NOT re-enter the native
  boot hook that counts an attempt — so one real launch plus a `location.reload()` satisfied
  `requiredConfirms = 2` and promoted a bundle that had booted exactly once (#584). Keyed on the
  attempt COUNTER rather than a per-process latch in the plugin, because a sub-game's attempt
  genuinely *is* counted on a reload (`beginBundleLoad` runs again against re-executing JS) and
  because Android can re-run `MainActivity.onCreate` — hence the boot hook — inside one process,
  so “per process” is not “per boot” there.

  ⚠️ **This fully closes the SHELL case and not the sub-game one.** The shell's attempt is
  counted only in the native boot hook, which a reload never re-enters, so the shell genuinely
  needs two separate launches to promote. A **sub-game is different**: `beginBundleLoad` counts
  a real attempt on every reload and its bundle JS genuinely re-executes, so a sub-game can still
  reach `active` after one cold launch plus one background/resume reload — `useResumeReload.ts`
  (#574) makes that routine, not hypothetical. The watchdog still works in the sense that matters
  most (a bundle that fails to *load* never confirms), but two rapid loads inside one process are
  weaker evidence than two separate launches, which is what `requiredConfirms = 2` was written to
  demand. Closing this needs native process identity, which is deliberately not what this fix
  uses — left open on purpose, not overlooked.

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
`build-web.mjs` — never accepts a stale pre-built `dist/`; (2) verifies/sets bucket CORS as a
non-fatal preflight; (3) runs `ota-publish.mjs --project <projectRoot>`. The route deliberately
carries **no version-collision guard of its own** — that decision belongs entirely to
`ota-publish.mjs` (see "Republishing a version string" below, and the #577 Gotchas entry for
what happened when the route had a second, weaker one). It DOES keep its own early
signing-key-identity check (`otaSigningKeyRefusal`, imported from
`engine/scripts/ota/publishGuards.mjs`) as a fast HTTP 400 before the SSE stream opens and the
multi-minute build starts — but `ota-publish.mjs` enforces the SAME check itself now (#582), so
the route's copy can never refuse anything the script would allow; see the #582 Gotchas entry.
`GET /api/ota/status` and `POST /api/ota/keygen` are plain JSON, served
from the transport-agnostic `editorBackendRouter.ts` so they also work in a packaged Electron
editor. `engine/plugins/backend/gcloud.ts` holds the shared, Vite-import-free helpers both
routes need: `resolveGcloudDir` (locates the `gcloud` CLI even in a Finder-launched packaged
editor's minimal `PATH`), `deriveGcsBucketFromBaseUrl` (reverses `ota.baseUrl`'s
`https://storage.googleapis.com/…` form to the `gs://…` form `gcloud` needs), and it re-exports
`OTA_SAFE_TOKEN`/`OTA_SAFE_BUCKET` — the regexes every interpolated value is checked against
before it touches a `bash -c` string.

⚠️ **Those two regexes LIVE in `engine/scripts/ota/otaSafeTokens.mjs`, not in `gcloud.ts` (#649).**
They moved for the same reason `otaSigningKeyRefusal` did in #582: `ota-publish.mjs` is a plain
`.mjs` CLI that cannot import a `.ts` module, so while they lived on the TS side **only the two
route surfaces enforced them and the CLI enforced nothing** — it checked `--name`/`--version` for
presence and `--bucket` for a `gs://` prefix, and no charset check existed anywhere downstream.
`gcloud.ts` now re-exports from the `.mjs`, so all three entry points share ONE definition and
`editorBackendRouter.ts` / `vite-asset-scanner.ts` / `otaGcloud.test.ts` import as before.

**This pipeline only ever builds and publishes the shell bundle** — see the Gotchas entry
below on the bundleName restriction; publishing a sub-game bundle is still a manual
`build-subgame.mjs` + `ota-publish.mjs` invocation, not wired into the UI/MCP surface. That
by-hand path is guarded identically to the route now (#582): `ota-publish.mjs` requires
`--project <dir>` and reads its `project.config.json` itself to enforce both the signing-key
guard above and a dist-kind guard (a plain shell `dist/` may only publish under the project's
own `ota.bundleName`; a `subgame-dist/` — `build-subgame.mjs`'s output — may only publish under
a DIFFERENT name). See the #582 Gotchas entry for why that guard is not a port of the route's
`otaPublishBundleNameAllowed`.

**Republishing a version string: identical is fine, different is refused.** `ota-publish.mjs`
owns this decision — it is the **only** collision guard in the repo, and it decides by CONTENT
rather than by existence: it canonically hashes the already-published `manifest.json` and
compares it to the one it just built. Equal → this is a retry of an identical publish, and it
resumes. Different → it refuses, because the version string would silently come to mean
something else. A probe that cannot read the existing object fails **loudly**; it is never read
as "no collision". Every surface — the editor dialog, the MCP tool, a human running the CLI —
reaches that one guard.

This matters more since #570 than it did before. A publish that fails partway (auth expiry, the
precondition retry budget exhausted) used to be harmless to retry. Now a version whose
`manifest.json` landed while its `release.json` entry did not would, under an existence-only
guard, be permanently burned — you would be forced to bump the version and leave an orphan tree
behind. Hashing instead of merely looking makes the retry the safe operation it should be. No
existence-only guard survives anywhere in the pipeline (#577). For the same reason `manifest.json` is uploaded **last**, after `files/` and
`bundle.zip`, so that its presence genuinely means "this version's contents were committed"
rather than "an upload got partway". `release.json` is still written after everything.

## Gotchas

- **`ota-publish.mjs`'s `q()` was NOT a shell quote, and a `/` in `--name` defeated #577** (#649).
  `q = (s) => JSON.stringify(s)` emits a DOUBLE-quoted word and escapes only `"`, `\` and control
  chars — and POSIX shells expand `$(…)`, backticks and `${…}` *inside* double quotes, so it
  never actually neutralised interpolation for the 11 `execSync` sites it feeds. The reachable,
  non-malicious half: `--name "shell/v2"` wrote objects under a NESTED bucket path while
  `release.json` recorded the flat name, so the version-collision guard read back a path nothing
  would ever collide with — **the same version could be republished with different bytes and no
  refusal**, which is precisely what #577 exists to prevent.
  Fixed in two layers: the CLI now applies `OTA_SAFE_TOKEN`/`OTA_SAFE_BUCKET` (see Key files), which
  makes the three tainted inputs metacharacter-free on both `sh` and `cmd.exe`; and `q()` is now
  platform-split — POSIX single-quoting with the `'\''` escape, win32 keeping the double-quote form
  because `cmd.exe` does not treat `'` as a quote character at all.
  ⚠️ Two things deliberately NOT done. `execFileSync` (no shell at all) was rejected: the test
  harness installs a fake `gcloud.cmd` on Windows and Node refuses to spawn `.cmd` without a shell
  (CVE-2024-27980). And the win32 quoting branch is **unvalidated against a real Windows shell**
  from a Mac — the same caveat `engine/plugins/buildStepShell.ts` already carries for its `winCmd`
  forms.
- **`ota-embed-manifest.mjs` did not read `ota.enabled`** (#649) — its own sibling
  `ota-publish.mjs` did, and so did the route (`vite-asset-scanner.ts` makes the embed step
  conditional on it), so a hand run wrote `ota-embedded-manifest.json` into the dist of a project
  that had opted OUT. Inert today (nothing calls `checkForUpdate` there), fixed for the asymmetry.
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
- **The version-collision check distinguishes "never published" from "gcloud call failed"**
  (fixed 2026-07-26). The preflight used to catch ANY `gcloud storage cat` error and treat it
  as "no collision, proceed" — a transient auth/network blip could let a publish past the one
  guard meant to stop a rejected version from being silently republished. It inspects stderr
  instead: only "not found: 404" / "matched no objects or files" (the real "never published"
  cases) are safe; anything else fails the publish loudly with the actual error. "Could not
  check" and "definitely absent" are different answers, and conflating them fails **open** on
  exactly the errors the guard most needs to catch. The classification is
  `isGcloudObjectNotFoundError` in `engine/scripts/ota/gcloud.mjs`, unit-tested in
  `engine/tests/plugins/ota/gcloud.test.ts`.
- **Two guards disagreeing beat the better one** (#577, fixed 2026-09-02). #570 upgraded
  `ota-publish.mjs`'s guard from existence to content — but the editor route kept its OWN
  existence-only copy, and it ran *first*. So the fixed guard was unreachable from the editor
  dialog and the MCP tool: a partially-failed publish still refused its own identical retry
  with "Version collision", burning the version string through the primary workflow, while the
  docs described the problem as solved. The route's check is deleted, not repaired — a guard
  there would have to recompute what the publish would produce (hash `dist/`, build the zip,
  build and canonicalize the manifest), i.e. re-implement the script, and the two
  implementations drifting **is** the bug. `ota-publish.mjs`'s failure message carries the
  `Try vN+1.` hint and reaches the dialog's log panel and its status line unchanged, so
  removing the route's copy costs no affordance. The lesson generalizes: **fixing one of two
  duplicated guards leaves the weaker one deciding**, and the duplication is what to remove.
  A structural test in `engine/tests/plugins/viteAssetScanner.test.ts` now asserts the route
  makes no `gcloud storage cat` manifest preflight.
- **Key-path resolution is no longer duplicated** (fixed 2026-07-26). `ota-publish.mjs`
  used to always derive its own repo root from `import.meta.url`, independently of the
  `/api/ota/publish` route's OWN key-existence precheck (`editorRoot || projectRoot`) — two
  resolutions with nothing enforcing they agree. The script now accepts `--repo-root`, and
  the route passes its own `buildCwd` through explicitly, so both sides always resolve the
  signing key from the same value.
- **The by-hand publish path had neither publish-identity guard** (#582, fixed 2026-09-02).
  `otaPublishBundleNameAllowed` and `otaSigningKeyRefusal` lived ONLY in the `/api/ota/publish`
  route — but that route's own refusal message sends a human to `build-subgame.mjs` + a manual
  `ota-publish.mjs` invocation for exactly the case its bundleName guard blocks (a sub-game
  publish), and the CLI enforced neither guard. `otaSigningKeyRefusal` moved to
  `engine/scripts/ota/publishGuards.mjs` and is now imported by BOTH surfaces (the route
  re-exports it unchanged for its existing callers/tests) — this is NOT another #577 (that
  duplicate ran a DIFFERENT, weaker decision procedure FIRST and refused a case the real one
  allowed; this is the identical pure function over the identical inputs, so the route's copy
  can never refuse anything the script would allow — it stays only for a fast HTTP 400 before
  the SSE stream). `otaPublishBundleNameAllowed` was deliberately **not** ported — it's a
  strict equality guard that's correct only because the route always builds a plain shell
  `dist/`; porting it into the CLI verbatim would refuse the sub-game publish the route sends
  people here for. `ota-publish.mjs` instead gained a NEW guard, `otaBundleDistKindRefusal`
  (same module): the dist's KIND (plain shell vs. a `subgame-dist/`, detected by
  `subgame.json`'s presence) must match the identity it's published under. `--project <dir>` is
  now a required flag, read for exactly these two checks (never for bucket/version/engine-api,
  which stay explicit args) — an unreadable/malformed `project.config.json` aborts loudly
  rather than degrading to "unguarded". `engine/scripts/ota-keygen.mjs` also gained an explicit
  `--repo-root` (mirroring `ota-publish.mjs`'s own flag), and `/api/ota/keygen` now passes it as
  `ctx.editorRoot || ctx.projectRoot` — the SAME expression `/api/ota/keys` reads back with —
  closing a latent desync the two used to avoid only by the route invoking the script with a
  cwd-relative path.
  ⚠️ **`otaBundleDistKindRefusal` is weaker than it can sound**: it pins the dist's kind to the
  SHAPE of the identity (plain shell vs. subgame-dist), not to a SPECIFIC sub-game's identity —
  `subgame.json` carries no name, and neither the guard nor its caller ever checks that
  `--dist` belongs to `--project`, so `--dist games/A/subgame-dist --name B` is allowed. Still
  strictly better than the prior no-guard state, and left that way deliberately: a sub-game
  publish legitimately pairs a sub-game's own dist with the shell project it's staged from.
- **The regression the #582 fix itself introduced, plus two siblings** (fixed 2026-09-02).
  `ota-publish.mjs`'s new `ota.bundleName` check refused a config with the `ota` block PRESENT
  but no `bundleName` key — but `pruneProjectConfig` (called on every Project Settings save)
  omits a field equal to its default when the on-disk file didn't already carry that key, and
  the default `ota.bundleName` IS `"shell"`. So a project that enabled OTA through Project
  Settings and left the bundle name at its placeholder got a perfectly valid config that this
  guard nonetheless refused — AFTER the build ran and the bucket's CORS policy was overwritten,
  blaming a valid config as malformed. Fixed by resolving an absent `bundleName` to
  `OTA_DEFAULT_BUNDLE_NAME` (a second authored copy of `DEFAULT_PROJECT_CONFIG.ota.bundleName`,
  since a `.mjs` script can't import the TS module that defines it; a guard test asserts the
  two stay equal) before the identity checks run, so only a bundleName that is PRESENT but not
  a non-empty string is treated as a genuine config defect. `publicKey` keeps the opposite
  treatment on purpose: its default `''` means "unset" and must still refuse.
  Two siblings found in the same review: (1) `ota-publish.mjs` never checked `ota.enabled` at
  all, so a hand publish for a project that opted OUT of OTA in Project Settings (the route
  itself refuses this with a 400) would still write a real, inert `release.json` entry into
  the shared bucket — fixed with the same `enabled` refusal the route has, `enabled` defaulting
  to `false` so an absent field correctly means "not enabled" (no default-resolution subtlety
  there, unlike `bundleName`). (2) `ota-embed-manifest.mjs` had the same route-only-guard shape
  as the original #582 bug: the route always pairs `--dist <projectRoot>/dist` with
  `--name cfg.ota.bundleName` from ONE project, but the script itself validated only that
  `--dist` existed and `--name` was non-empty — mixing project A's dist with project B's name
  would embed a manifest describing another app's files, silently forcing every OTA check on
  that install into a whole-zip download forever (the delta path fails against the wrong
  manifest). Fixed with the same `--project <dir>` + resolved-bundleName-match treatment as
  `ota-publish.mjs` (importing `OTA_DEFAULT_BUNDLE_NAME`, not re-deriving it), PLUS a
  containment check (`--dist` must resolve inside `--project`) that `ota-publish.mjs`
  deliberately does NOT have — a sub-game publish legitimately pairs a sub-game's dist with the
  shell project it's staged from, but an embedded manifest always describes the shipping app's
  own dist, so the containment check is valid there and would be wrong here.
- **A sub-game's script-load ordering race** (fixed 2026-07-26). `subgameLoader.ts` used to
  load every staged sub-game concurrently (`Promise.all`); now sequential — see
  ota-subgame-modules.md §3 for why concurrent loading raced a single shared global.

## Testing

The pure decision layer is replayed by **both** platforms against the same shared vectors —
`ota-golden-vectors.json` (boot/confirm/revert, plus `resetForNewBinary`),
`ota-gate-vectors-phase3.json` (quarantine), `ota-subgame-vectors-553.json` (the sub-game
load-failure dispositions and the versioned confirm), `ota-stage-verify-vectors.json` (#556's
whole-tree staging check) and `ota-prune-vectors.json` (#563's folder reclamation, including
the hyphenated-bundle-name ownership rule), 62 scenarios at the time of writing — the
runner prints the live count, so trust that over this number. A native divergence between
Swift and Java fails there instead of shipping.

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
- **Closed (#565).** `OtaZipTests.testRoundTripAgainstNodeProducedZip` XCTSkipped unless
  `/tmp/ota-test.zip` existed — and nothing ever created it, so the cross-tool ZIP check (the one
  proving `OtaZip` parses authentic ZIP structure rather than its own writer's output) had never
  run, while `test-native.mjs` still printed `PASS ios/ota-core`. Its header's regeneration command
  was elided to `...`, so the fixture could not even be rebuilt from the instructions given.
  `test-native.mjs` now BUILDS the fixture with the Node writer (`engine/scripts/ota/zip.mjs`) and
  passes its path to that leg as `MODOKI_OTA_ZIP_FIXTURE`; the test falls back to
  `/tmp/ota-test.zip` so a bare `swift test` still behaves as before, and the real regeneration
  command is restored in the file's header. Verified by mutation, not by green: flipping one byte
  of the generated zip turns the test red (`decompressionFailed("expected 240 bytes, got 15")`).

  ⚠️ A fixture the runner is responsible for producing is **not** an environmental reason to skip,
  so a failure to build it is recorded as FAIL — but only after the platform/tool checks, since on
  a non-macOS runner the leg cannot run at all and must stay a SKIP.

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
