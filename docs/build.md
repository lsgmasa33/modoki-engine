# Build & deploy

How a Modoki game goes from source to a running app — web compile, per-game Capacitor
native, and on-device install. `CLAUDE.md` keeps the everyday commands (`npm run dev`,
`MODOKI_PROJECT=… npm run build`, the test/verify gate) and points here for the full
native pipeline and the device build recipes.

Related: [native-and-sdks.md](./native-and-sdks.md) (SPM plugins, SDKs, per-game signing),
[electron-signing-optimization.md](./plans/electron-signing-optimization.md) (desktop-editor
codesign speed).

## One project = one game (#29)

Post-#29 the repo root is **not** a buildable game — it's the engine + Electron editor.
Every `games/<id>` is a fully self-contained Capacitor app with its **own** `ios/`,
`android/`, and `capacitor.config.json`. A bare `npm run build` with no `MODOKI_PROJECT`
fails fast by design.

**`MODOKI_PROJECT=games/<id>`** steers three things in lockstep:
- **Output** → `games/<id>/dist` (`vite.config.ts` `buildProjectRoot`).
- **Identity** → the project's `project.config.json` (`appId`/`appName`).
- **Capacitor** → `webDir` = `games/<id>/dist` (`games/<id>/capacitor.config.json`).

Only the **web compile** (`npm run build`) runs from the repo root (shared vite/engine,
steered by `MODOKI_PROJECT`). `cap sync` and the native build run **from the project dir**,
because its config + native folders live there.

## Creating a new game — use the scaffolder, never hand-craft

```bash
node engine/scripts/scaffold-project.mjs games/<id> "Project Name"
```
This is the same template + token contract the editor's **File → New Project** uses
(`engine/electron/newProject.ts`). It copies `engine/templates/starter`, substitutes identity
tokens, and mints fresh scene GUIDs → a complete, runnable hello-world project (`game.ts` ·
`project.config.json` · `runtime/config.ts` · `runtime/setup.ts` ·
`runtime/assets/scenes/main.scene.json`). **Do NOT hand-write `game.ts` / config / scene JSON** —
you'll miss the GUID/manifest/config wiring.

## Per-clone dependency bootstrap

The engine plugins and each game's Capacitor plugins ship their JS only in a **gitignored
`dist/`**. After `git clone` or any pull that touches a `package.json`/lockfile, a plain
`npm install` does the full setup: the root `postinstall` chains `build:plugins` (engine
native plugins → `dist/`) **and** `engine/scripts/bootstrap-game-deps.mjs`, which for every
`games/<id>` that is a workspace root runs its own `npm install` + `build:plugins`. A missing
`dist/` is what makes `npm test` / the editor fail with `Failed to resolve import
"capacitor-<x>"`. See the Two Clones section of `CLAUDE.md`.

⚠️ **That same error can mean a HALF-built `dist/`, not a missing one — and the install will
have told you it succeeded.** A plugin's `build` is `tsc && rollup`, so a `tsc` failure leaves
`dist/esm` present and `dist/plugin.cjs.js` (the `main` entry) absent; `bootstrap-game-deps.mjs`
swallows the per-game failure and reports a clean install. Measured 2026-08-02: the #57 dep bump
hoisted `minimatch` 3.1.5 → 10.2.5 to the repo root, and `@types/glob@8.1.0` — pulled in
transitively by `@gltf-transform/cli`, deprecated and frozen since glob started shipping its own
types at v9 — still references `minimatch.IOptions`, which v10 dropped. `tsc` auto-includes every
`@types/*` it can see, so the four plugin tsconfigs that set neither `skipLibCheck` nor `types`
died on a package none of them import. **Check `dist/plugin.cjs.js` exists, not just `dist/`**, and
if a plugin build fails, run it directly (`npm --prefix <pkg> run build`) — the root install hides
the real error. Guarded now by `engine/tests/architecture/ambientTypesOptOut.test.ts`.

## Native scaffolding: auto on first build

A game with no `ios/`/`android/` yet is **auto-scaffolded on the first native build** —
`/api/build` runs the same pipeline as **Build → Add iOS/Android Target…**: deps +
`capacitor.config.json` + vendor plugins → `npm install` → web build → `npx cap add` → heal.
It then continues into the build, pausing first only if the scaffold surfaces a warning you
must act on (e.g. missing Firebase config). The explicit **Add … Target** menu items do just
the scaffold. Manual CLI equivalent: `cd games/<id> && npx cap add ios|android`.

`healNativeConfig` (`engine/plugins/healNativeConfig.ts`) runs on project open **and** at the
start of every iOS/Android build — it syncs the project's `build.appleTeamId` into the iOS
project's `DEVELOPMENT_TEAM` (so a Team ID edited after `cap add` still lands) and repairs
other drift. `add-native-target` (`engine/plugins/addNativeTarget.ts`) and the vendor plugin
wire in per-game native plugins. Restart the editor after pulling build-pipeline changes — the
Vite plugin loads once at dev-server start.

## Committing native folders (SOURCE only)

Each game's `ios/` + `android/` are tracked (pbxproj, gradle scripts, `res/`, `Info.plist`,
`Package.swift`, the vendored `plugins/*.tgz`) — 3d-test + 2d-physics-demo are the references.
Build junk is kept out by two layers: Capacitor's own generated `games/<id>/ios/.gitignore` +
`android/.gitignore`, **plus** centralized `games/*/` rules in the repo-root `.gitignore`
(Pods/, `App/build/`, `android/**/build/`, `.gradle/`, `.cxx/`, xcuserdata, Capacitor-regenerated
config copies…). The belt-and-suspenders root rules exist because the OLD anchored `ios/…` +
`android/…` lines are pre-#29 repo-root paths that don't match `games/<id>/…`. After scaffolding
a new game's native, sanity-check:
```bash
git ls-files 'games/*/ios/**' 'games/*/android/**' | git check-ignore --stdin
# must print nothing — no tracked source should be ignored
```

### App icons + splash are GENERATED, but still tracked

`res/` counts as tracked source above, yet its icons and splashes are produced by
`@capacitor/assets` during the native build. That combination is only safe because the build
**skips regeneration when nothing changed** (`engine/plugins/iconAssets.ts`).

Two things went wrong before it did:

- The step ran on **every** native build, rewriting every tracked mipmap/splash PNG each time,
  so any game that had been built carried a permanently dirty working tree — 95 such files
  across two games in one day, burying real diffs in re-encoded binaries.
- The generator was invoked as a bare `npx --yes @capacitor/assets` beneath a comment claiming
  it was "verified against 3.0.5". `npx --yes` installs **latest**, so the comment described a
  version the build never used; a newer release started emitting extra density buckets
  (`drawable-night-*`, `*-ldpi`, `mipmap-ldpi`) that surfaced as mystery untracked directories.

Now: the tool version is **pinned** (`ICON_TOOL`), and a stamp under the project's gitignored
`.cache/` records the tool version + platform + colour flags + the **content hash** of the
source image. Regeneration happens when any of those change, or when the generated output has
been deleted (a sentinel file is checked, so a wiped `res/` still comes back). Content-hashing
means repointing `app.iconSource` at a byte-identical file is correctly a no-op, while editing
an image in place is not.

**Why not just gitignore the icons?** Generation is deliberately non-fatal (`|| echo '[icon]
generation skipped'`) and needs `npx` to reach the network. Untracked icons would let an
offline or upstream-broken build ship an app with no icon and no committed fallback — trading
visible churn for an invisible release defect. To force a rebuild, delete
`<project>/.cache/icon-stamp-<platform>`.

## The canonical path: build from the editor

Open the project, then **Build → iOS Device / Android Device / Web**. `/api/build` runs the
steps below with the right cwd per step (web compile at repo root, native at the project dir) and
consumes the SSE pipeline to completion. This is the validated path; the CLI recipes below are the
manual equivalent.

The editor build path **resolves (and, in a packaged editor, downloads) its toolchain
automatically** — Node, the JDK 21, and the Android SDK — and preflight-gates a build on the tools
it needs, pointing you at **Build → Build Support…** to install anything missing. It exports
`JAVA_HOME`/`ANDROID_HOME` from that shared, version-strict detection, so you don't set them by hand
the way the manual CLI recipes below do. Full detail: [editor-toolchain.md](./editor-toolchain.md).

## Assets the build cannot see — why an asset ref never belongs in code

The build's asset passes are **static**: they read authored DATA, never `.ts`. So an asset
referenced only from game code is dropped, and the game is perfect in dev and broken when built.
This is the single nastiest failure mode in the pipeline, because **dev serves every asset off
disk** — nothing is missing until you ship.

Found on `games/court`, the first project whose content is created almost entirely by game code
rather than authored in a scene. It broke **three independent passes at once**, against a build
whose log was clean:

| Pass | What it walks | What it missed | Symptom in the build |
|---|---|---|---|
| Asset tree-shaker | scene → prefab → mesh → material ref graph | `PIECE_ICON` texture GUIDs, the font | no piece art, no text |
| Asset manifest | filtered to the kept assets | same | `resolveGuidToPath` resolves nothing |
| `detectType` | filename/dir convention | `assets/levels/index.json` typed `scene` | level manifest offered as the BOOT scene |

**The fix is to author the ref, not to patch the keep-list.** Put it on a **resource trait** in
the scene: the tree-shaker's generic sweep (`probeTraitRefs`, `engine/plugins/asset-tree-shaker.ts`)
keeps any GUID on any trait bag that resolves in the asset index — **game-defined traits included,
with no registration** — so the ref becomes visible automatically, gains scene validation, and
becomes editor-editable (drag a texture onto the field to reskin).

`games/<id>/asset-keep.json` is the escape hatch, and it is a **patch, not a fix**: hand-maintained,
and nothing fails when someone forgets an entry. That is precisely why the guard below exists.

**Guard**: `engine/tests/assets/codeAssetRefs.test.ts` (in `npm test`) fails on an asset ref held in
game code, in either form — a GUID **literal**, or an imported **engine constant** such as
`DEFAULT_FONT_GUID`. It discriminates by resolving each candidate against the real asset index: a
GUID a real asset owns is a failure, while an **entity** GUID in code is legitimate and ignored
(addressing a scene-authored entity from code is a normal pattern — `demos/postfx-demo` does it).
That distinction is why this is a vitest guard rather than an ESLint rule: a static rule cannot
consult the asset index, and a blanket "no GUID literals" rule fires on ~10 legitimate entity refs.

**The other half of the trade** (#53): moving a ref off a code constant and onto an authored trait
field buys build visibility at the price of a failure mode a code constant could not have — the
field can be left **blank**. An empty string is neither dangling nor a literal path, so
`assetRefIntegrity.test.ts` passes it and it surfaces only in a production build or on device.
`engine/tests/assets/authoredAssetRefs.test.ts` closes that direction: a `(trait, field)` pair is
**proven** an asset ref when some instance anywhere resolves to a real asset GUID, and every blank
instance of a proven pair then fails. Legitimate blanks (an optional override slot, a field with a
code fallback) are pinned in its `BASELINE` with a reason and a two-way staleness check — a new
blank fails, and so does an exemption that no longer fires. The baseline is a record of what
already existed, not an approval: shrink it, never grow it.

**Companion guard — a code GUID that resolves to NOTHING**:
`engine/tests/assets/danglingCodeGuids.test.ts`. The guard above skips unresolvable GUIDs, by
design (its job is refs the build cannot see, not broken refs), and #70 fell through that gap: a
`thumbnailUrl` GUID whose asset had been deleted sat in `games/3d-test/game.ts` unnoticed. Note the
"~10 legitimate entity refs" caveat above applies to the **asset index alone** — an entity guid is
not an asset, but it *is* defined in committed scene JSON. So resolving against asset `id`s **and**
entity `guid`s makes "unresolvable ⇒ broken" exact rather than noisy: measured across `games/` +
`demos/`, 2319 defined GUIDs, 33 code literals, **0** false positives. A guid minted at runtime
(never serialised) would be the one legitimate exception; there is none today, and the guard has an
`ALLOWED` map that demands a reason rather than a widened rule.

Two things it deliberately does not reach: a GUID assembled at runtime from non-constant parts, and
an asset fetched by PATH rather than GUID (Court's generated `levels/index.json` — a resource trait
cannot enumerate a generated set; that needs `index.json` to become a real ID-bearing asset type).

Pre-existing refs are listed in that file's `PENDING_MIGRATION`, pinned per `file:guid` and
stale-checked both ways so the backlog can only shrink. **Verify any migration with a real
production build** (`MODOKI_PROJECT=games/<id> npm run build -- --target web`) — `npm test` cannot
see this class.

## Packaged editor loop (test the DMG faithfully, fast)

⚠️ **Why the packaged reaper is anchored to a bundle PATH, and must stay that way.** For months,
dev editors across every clone died at random and it read as a GPU fault. The cause was
`killPackaged()` called with no `appDir`, reaping by the bare product name:

    pkill -f "Modoki Editor"

Electron passes the app name to every child in `--user-data-dir`, so that pattern matched every
clone's DEV editor helpers (GPU/network/audio) while MISSING the main process. **That asymmetry is
what disguised it**: the helpers died, the main process survived and dutifully logged their deaths
with nothing to blame. Now anchored to `Modoki Editor.app/Contents/`, which keeps the machine-wide
scope the caller wants while making a dev editor structurally unmatchable, and
`engine/tests/architecture/reapScoping.test.ts` fails any `pkill -f` pattern under
`engine/scripts/**` that is not anchored to `/` or `$`. `main.ts` also dumps a filtered `ps`
snapshot on any `reason=killed`, naming the processes that could have sent it — an EMPTY list is
itself evidence (the killer already exited). Do not "simplify" the pattern back.

Three loops, three jobs — don't conflate them:

- **`editor:main` / `editor:ai` (+ `MODOKI_BACKEND_PORT=5181 …` for ai2)** — the **HMR dev loop**.
  Vite dev server + Electron; edit a file, see it in ~200ms. This is for *building* the software and
  is your default.
- **`npm run test:packaged` / `smoke:packaged`** — the **faithful packaged loop**. Both run
  `electron-builder --dir` to produce the REAL `Modoki Editor.app` (asar packed, workspace symlinks
  dereferenced, devDeps pruned) — it is **the DMG minus code-signing + dmg-packaging** (the only slow
  parts), so ~20–40s, not ~7 min. `test:packaged` launches it interactively (main-process logs stream
  live); `smoke:packaged` launches headless and auto-asserts render, **CSP** (via
  `assert-app-csp.mjs`), and that the app **provisioned its own pinned Node** — see "What the
  packaged smoke asserts" below. This is for *checking that it packages* — a periodic fidelity check, NOT a
  dev environment (the `.app` serves from a FROZEN copy of engine source, so it has **no HMR** — every
  edit needs a rebuild).
  - **Both legs pin a per-clone port, and must keep doing so.** `smoke:packaged` runs two boots — the
    render leg, then the CSP leg — and each derives its own backend port from `clonePort.mjs`
    (render `38600+200`, CSP `38800+200`; the CSP leg also seeds `MODOKI_VITE_PORT`). Separate
    blocks on purpose: the legs run seconds apart against the same clone, so a shared block could
    hand the second boot a port the just-killed first is still releasing. Until 2026-08-02 the CSP
    leg pinned **nothing** and bound whatever was free — measured **5179/5173, the main clone's
    editor lane** — so a throwaway smoke build could silently answer an agent's `modoki_*` calls
    (#68). `engine/tests/architecture/clonePortHardcoding.test.ts` now fails any packaged-app
    spawner that doesn't derive a port.
  - **Per-clone MCP-targetable packaged editor**: `editor:main:packaged` / `editor:ai:packaged` (or
    `MODOKI_BACKEND_PORT=<port> bash engine/scripts/test-packaged.sh games/<id>`) build the `.app` and
    launch it on the clone's pinned backend port — the packaged app honors `MODOKI_BACKEND_PORT`, so
    `MODOKI_BACKEND=http://127.0.0.1:<port>` drives it exactly like the dev editor. It uses the SAME
    port as that clone's dev editor, so run one **or** the other per clone, not both (the packaged app
    pins the port and refuses to drift). The launch stops the local dev editor + any packaged app
    first — it's a **single-instance** check, unlike the coexisting dev editors.
- **Why the `.app` is built to `/tmp`, never in-repo**: the packaged app's Node resolution walks UP
  the tree, so an in-repo `.app` would find the repo's `node_modules` and **mask** the exact
  "dependency excluded from the package" bugs the test exists to catch. Building outside the repo is a
  deliberate correctness property — do NOT relocate the build into the project folder.

⚠️ **`fs.stat` timestamps are FABRICATED for paths inside `app.asar`.** Electron's asar shim
reports a real `size` but synthesizes the times — measured on packaged Windows (2026-08-02),
`fs.statSync(__filename).mtimeMs` returned the current wall-clock on every launch. This silently
broke the Vite dep-cache bust in `engine/electron/main.ts`, whose signature was
`version:size:mtimeMs`: it never matched itself, so the packaged editor wiped and **cold
re-optimized its whole dep graph on every boot** instead of only after an app update — the
opposite of the intent, and it paid the cold-scan race window of #21 on every launch. The
signature is a content hash now, guarded by
`engine/tests/architecture/viteCacheBustSignature.test.ts`. **Never key packaged-build identity on
a file timestamp**; hash the bytes — reading + hashing `main.cjs` measures ~0.5ms (523KB), against
a full cold dep-optimize every launch. Measured after the fix: the wipe fires once per build and
then never again, and boot drops 9.6s → 7.8s across relaunches.

Why this loop exists: packaged-only bugs (minimal Finder PATH, asar-sealed `package.json`,
dereferenced `@modoki/engine` symlink, pruned devDeps, PROD-only CSP) are **invisible to
`npm run dev`** — the dev env has full PATH, live symlinks, no asar, no CSP. Static guards
(`engine/tests/electron/cspContract.test.ts`, `packagingManifest.test.ts`, run every `npm test`)
catch the cheap contract regressions; the `--dir` smoke catches the env-boundary class they can't.

**Before pushing a packaging change** (anything under `engine/electron/**`, `electron-builder.yml`,
`engine/plugins/**`, `engine/scripts/build-web.mjs`, `engine/toolchain/**`): run
**`npm run verify:packaged`** — it's `verify` **plus** `smoke:packaged` (build the faithful `--dir`
`.app` + assert it renders and enforces its prod CSP). This is a **manual** gate (no pre-push hook)
because it does a real `--dir` build + boots an editor window (~1–2 min) — too heavy for
every `verify`. Plain `verify` already runs the cheap static packaging guards, and release CI
(`release.yml`) runs the smoke on a tag, so `verify:packaged` is the local belt-and-suspenders for
the env-boundary class.

⚠️ **It runs on Windows too — it is not a macOS-only gate**, despite having been described as one
until 2026-08-02. `smoke-packaged.sh` carries no platform table: `engine/scripts/packagedAppPaths.mjs`
resolves the output dir, the executable (`.app/Contents/MacOS/…` vs `win-unpacked\….exe`), the
userData/vite-cache location, and the reap mechanism (`pkill -f` vs a `Win32_Process` filter on
`ExecutablePath`). Believing it was macOS-only is part of why a *packaged Windows* bug — the editor
being unable to extract any provisioned toolchain — survived undetected; see "Never assume `tar` is
bsdtar" in [editor-toolchain.md](editor-toolchain.md). Its release-time sibling
`assert-app-renders.sh` genuinely WAS macOS-only until the same date, which is why the Windows
release shipped without a render gate for as long as it did. It is wired in now (#94): the public
repo's `oss/.github/workflows/release-windows.yml` scaffolds a throwaway starter project and runs
`assert-app-renders.sh release/win-unpacked "$RUNNER_TEMP/smoke"` as a **fatal** step, matching
macOS. (The private `.github/workflows/release-windows.yml` was deleted 2026-08-03 — releases are
cut from the public repo now, see docs/engine-oss-publishing.md.) The explicit project argument is
load-bearing: the script defaults to `$REPO/games/3d-test`, and the public snapshot has no `games/`.

It stops the local dev editor and builds a throwaway `.app` on a **per-clone port outside the
5179/5180/5181 human-editor range** — the block and its override live in the harness port table in
[editor.md](editor.md) § "Port selection", not restated here.

### What the packaged smoke asserts

Four things, and the last two exist because this gate has twice reported a cheerful result while the
thing it was watching was broken:

1. **The renderer mounted** — `entityCount > 0` from `/api/scene-state`, which relays through the
   renderer, so a non-zero count already proves it answered.
2. **No Vite resolve/transform error** in the dev-server log, and no renderer console error.
3. **The app provisioned its own pinned Node.** `ensureNodeProvisioned()` catches its own failure and
   falls back to system npm, so on a dev box — which *has* npm — a total provisioning failure is
   invisible and every other assertion still passes. That is not hypothetical: a bare `tar` on Windows
   resolved to Git's GNU tar, which cannot read a zip and treats `C:\…` as a remote host, so the
   packaged Windows editor could **never** extract its toolchain while this gate printed `PASS ✅`.
   The asymmetry that makes it worth guarding: an end user has no system Node, so what degrades
   gracefully here is a dead build for them. The assertion compares against `PINNED_NODE.version`
   read from `engine/toolchain/nodeProvision.ts`, so it also catches a **stale packaged build**
   shipping an older Node than the tree pins.
4. **Nothing leaked in from another clone.** The launch passes `--user-data-dir`, because
   `resolveUserDataDir` scopes the profile per clone only for **dev** — packaged returns the single
   `<appData>/Modoki Editor`, correctly assuming a shipped app is installed once. Our harnesses break
   that assumption: four clones each build and smoke their own packaged app. Since
   `modoki-last-scene:<project name>` is keyed by project NAME with a clone-ABSOLUTE value, a run
   restored another clone's scene, `/@fs` correctly 403'd it, and assertion 2 failed for a reason
   unrelated to the commit. `shouldOverrideUserData()` stands down for that switch precisely so a
   harness can isolate itself. `assert-app-renders.sh` (the release gate) does the same.
   Guarded by `engine/tests/architecture/packagedLaunchIsolation.test.ts`.

### Two packaged-boot flakes, both closed unreproduced (#21, #68)

Both were rare, neither was ever reproduced on demand, and both are **closed** — recorded here
because a closed ticket is where this kind of knowledge goes to die, and because the next person
to see either symptom should not restart the investigation from zero.

They are **different defects** despite a similar smell. Do not merge them in your head: one
*crashes* with a module error, the other *exits 0* without crashing.

**Cold-boot crash (#21)** — the first boot after an install/upgrade could crash the renderer with
`… does not provide an export named …`. Seen 1-in-6 on a real Windows install, never on a warm
relaunch. Two things came out of it:

- **Root-caused and fixed:** Vite keys its dep-optimize cache on the **lockfile**, not on
  `@modoki/engine` source (a symlinked workspace dep), so after an app update the old pre-bundled
  chunk was reused and every import of a newly-added export failed. `main.ts` now busts the cache on
  a build-signature change. That signature must hash the **bytes** of `main.cjs` — never an
  `fs.stat` mtime, because `__filename` lives inside `app.asar` and Electron's asar shim fabricates
  stat times, so an mtime-keyed signature never matches itself and wipes on *every* boot. Guarded by
  `engine/tests/architecture/viteCacheBustSignature.test.ts`.
- **Not root-caused *at the time*:** a residual crash on a genuinely *cold* cache (the wipe fired on
  the same boot that then crashed) — read then as a race during the cold optimize rather than
  staleness. **#110 later explained this shape** (see below) and, in doing so, showed the mitigation
  could not work. `main.log` carries `retryCount=` / `staleDepOptimizeSignature=` / `willRetry=` on
  every catch — that is still the trail to pull.

**Stale HTTP cache across an update (#110)** — the same `does not provide an export named …` crash,
on packaged Windows 0.3.7 opening `demos/postfx-demo`, *with the dep-cache wipe working correctly*.

Wiping `vite-cache` is necessary but **not sufficient**. Vite serves `/deps/*.js?v=<browserHash>`
with `Cache-Control: immutable`, and `browserHash` keys on the **lockfile + optimizeDeps config**,
not on `@modoki/engine` source. An engine-only update therefore leaves the dep URL **byte-identical**,
and Chromium replays the **pre-update body** from its own disk cache — which lives in `userData` and
survives the update exactly like the dep-cache does. The freshly re-optimized, *correct* chunk sits
on disk unread.

What was measured, on the running failed instance:

| Observation | Value |
|---|---|
| `waitForEditorJournal` in the on-disk dep (written **before** the crash) | **present** |
| `browserHash` on disk vs the failing URL's `?v=` | `d000db2e` — **identical** |
| Chromium HTTP-cache entries for that exact URL | **4** |
| Delete the **browser** caches — `Cache/` + `Code Cache/` (vite-cache untouched, same browserHash) | **boots clean** |

⚠️ That repair deleted **both** browser cache dirs, so the evidence does not isolate the HTTP cache
from V8's compiled-code cache. `session.clearCache()` and `session.clearCodeCaches()` are separate
APIs over separate dirs. In principle V8 revalidates its entry against the source it compiled, so
the code cache alone should not resurrect a stale chunk — but that is reasoning, not measurement,
so `clearBrowserCaches()` clears both rather than shipping something narrower than what was proven.

Two things follow, and both were wrong in the code before:

- **The cold-scan-race theory did not fit this failure.** The pre-bundle was complete and correct
  before the renderer ever asked for it — nothing raced. (This does *not* retire the race as an
  explanation for #21's *fresh-install* 1-in-6 rate: a fresh profile has no stale HTTP cache to
  replay. It does explain the "cold cache, still crashed" shape.)
- **`EditorBootBoundary`'s bare `location.reload()` could never clear it** — the reload re-requests
  the same immutable URL and receives the same stale body, so the one capped retry was spent for
  nothing and the red screen was painted anyway. That is exactly what `willRetry=false` after
  `retryCount=1` recorded.

Fixed by clearing the browser caches on a build-signature change (`clearBrowserCaches()` alongside
the `vite-cache` wipe), and by making the boundary's retry clear them over IPC *before* reloading.
Guarded by `viteCacheBustSignature.test.ts` (the clears must stay together, and the helper must
cover the code cache as well as the HTTP one)
and `editorBootBoundary.test.tsx` (which pins the clear-then-reload **order** — a clear that lands
after the reload is indistinguishable from no clear at all).

⚠️ **Why no gate caught it, and still won't:** this only bites on **update-over-install**, where
`userData` carries forward. `smoke:packaged` and `repro-cold-boot.sh` both start from a fresh
profile, so neither exercises the path. Testing an upgrade means installing the *previous* version,
running it once, then installing the new one over it.

Measured 2026-08-03 (v0.3.6, macOS): **30/30 cold boots clean** via
`engine/scripts/repro-cold-boot.sh` — no crash, no boundary fire, no console errors. At the observed
Windows rate that outcome has p≈0.4%, so the rate really is **materially lower on macOS**, which is
consistent with the leading theory (one-time Defender/SmartScreen read latency over a freshly
extracted `app.asar.unpacked` — something a Mac cannot exercise). The same run positively confirmed
the build-signature fix against the real packaged binary: a reused profile wiped on boot 1 and
**not** on boot 2. **So run that loop on the Windows clone, not here.**

Two traps that script encodes, both of which cost a wrong answer while writing it:

- **Cold means a fresh `--user-data-dir`**, not a cache wipe. `vite-cache` lives under userData, so a
  throwaway profile is colder *and* leaves the shared `Modoki Editor` profile alone —
  `clean-packaged-cache.mjs` would have destroyed a human's recents, layouts, and prefs.
- **`$TMPDIR` is not `/tmp` on macOS.** Defaulting the build dir to `${TMPDIR:-/tmp}` resolved a
  *different, day-old* app than the one just built, and reported it green. The script now derives the
  path from `packagedAppPaths.mjs tmpdir` (the same helper `smoke-packaged.sh` uses) and warns when
  the packaged binary is older than `engine/electron/dist/main.cjs`.

**Smoke CSP flake (#68)** — `smoke:packaged` failed its CSP leg once in three runs on identical code:
the app **exited cleanly (code 0)** before the editor page appeared, so there was nothing to
diagnose. Both of its suspects were addressed in `5a663d56`: `assert-app-csp.mjs` now keeps a rolling
tail of the child's stdout/stderr and reports it with the exit code/signal on failure, and
`smoke-packaged.sh` no longer races teardown with a fixed `sleep 1` — it **polls for the first
instance's actual death** (bounded, so a genuinely stuck process still fails loud). Never recurred
in 15+ runs afterwards. If it returns, the failure now self-reports instead of printing `code 0`.

The one thread genuinely shared with #21 — a suspected teardown race on the packaged `userData` /
Vite dep-cache — is a *hypothesis overlap*, not an established common cause. Worth checking both if
either recurs.

## CLI recipes

The examples use `games/<id>`; substitute the project and its appId. Note the **project-dir cwd**
for `cap`/`xcodebuild`/`gradle`. A game's concrete bundle id, Apple Team ID, and device IDs live in
its own `games/<id>/CLAUDE.md`.

### Web
```bash
MODOKI_PROJECT=games/<id> npm run build -- --target web   # TypeScript check + Vite build → games/<id>/dist
```
`--target` is required (#40) — `web` honors the project's `build.webBasePath` (sub-path hosting), so
the SAME command run for an iOS/Android pre-`cap sync` build must say `--target native` instead
(base `"/"`, since Capacitor serves the dist from the app root). There is no default in either
direction: defaulting would be silently wrong for one of the two callers.

#### `--target native` re-vendors the engine Capacitor plugins first (#148)

Games don't build `engine/packages/capacitor-*` from source — they depend on a content-addressed
tarball committed into the project (`"capacitor-game-debug": "file:plugins/…-<hash>.tgz"`). So a
plugin edit only reaches a device once that tarball is re-packed and installed. `build-web.mjs`
now does that on `--target native`, and runs `npm install` in the project when the content actually
changed; on `web`/`playable` it does nothing (a vendored plugin is a native artifact).

It did NOT until #148 — only the editor's `/api/build` re-vendored — so following the recipes below
after a plugin edit produced an IPA/APK containing the PREVIOUS native code while every signal
reported success.

⚠️ **The CLI recipes are still NOT fully equivalent to Build → iOS/Android Device.** Before its
shell steps the editor path runs THREE in-process heals; the CLI runs one:

| In-process heal | Editor `/api/build` | CLI `--target native` |
|---|---|---|
| `vendorEnginePlugins` — re-pack + install a changed engine plugin | ✅ | ✅ *(since #148)* |
| `healNativeConfig` — sync `build.appleTeamId` → iOS `DEVELOPMENT_TEAM`, Android `local.properties` | ✅ | ❌ |
| `ensureCapacitorDeps` — add engine-REQUIRED Capacitor plugins the project predates | ✅ | ❌ |

The second fails LOUDLY (`xcodebuild`: *"Signing … requires a development team"*). The third fails
in the same silent way #148 did: the web build inlines the plugin's JS proxy from the editor's
`node_modules` so the build SUCCEEDS, but `cap sync` never registers a native impl and the app dies
at LAUNCH with `"<Plugin>" plugin is not implemented on <platform>`. Until that closes, open the
project in the editor once (which heals both on open) before relying on a CLI native build.

Two notes worth carrying:
- **`npm` ships `README.md` regardless of the `files` field**, so editing a plugin's DOCS re-hashes
  its tarball. Expect a re-vendor after a docs-only plugin edit.
- To re-vendor **without** building: `node engine/scripts/vendor-plugins.mjs games/<id>`, then
  `npm install` in the project. `engine/tests/architecture/vendoredPluginFreshness.test.ts` fails
  `npm test` on a project whose pin has gone stale.

### iOS Simulator
```bash
MODOKI_PROJECT=games/<id> npm run build -- --target native
(cd games/<id> && npx cap sync ios)
xcodebuild -project games/<id>/ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'id=<SIM_UDID>' build
xcrun simctl boot <SIM_UDID>
xcrun simctl install booted <path-to-App.app>
xcrun simctl launch booted <appId>
```

### iOS Device
```bash
MODOKI_PROJECT=games/<id> npm run build -- --target native
(cd games/<id> && npx cap sync ios)
xcodebuild -project games/<id>/ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'id=<DEVICE_UDID>' -allowProvisioningUpdates build
xcrun devicectl device install app --device <DEVICE_ID> \
  ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Debug-iphoneos/App.app
xcrun devicectl device process launch --device <DEVICE_ID> <appId>
```
First device install requires trusting the developer profile: Settings → General →
VPN & Device Management → Trust.

**Two DIFFERENT ids, and only the first is required.** Both live in the project's gitignored
`project.user.json` (per-machine, never committed — Project Settings → Build → "This Machine"):

| Field | From | Required? | Used by |
|---|---|---|---|
| `iosDeviceId` | `xcrun xctrace list devices` — the hardware UDID | **Yes** | `xcodebuild -destination 'id=…'` |
| `iosDevicectlId` | `xcrun devicectl list devices` — a different GUID | No | `devicectl` install + launch |

They are not interchangeable: `xcodebuild` rejects the devicectl GUID (see
`wdaLauncher.parseIosDevices`, which reads `hardwareProperties.udid` for exactly this reason).

⚠️ **`devicectl` is CoreDevice-only — iOS 17+.** A pre-iOS-17 device has no devicectl id *in
existence*: `xcrun devicectl list devices` lists it `unavailable`, with no
`hardwareProperties.udid` at all. So leave `iosDevicectlId` **empty** for such a device and the
build plans an **Xcode handoff** instead — it builds, opens the `.xcodeproj`, and reports
success; you press Run (⌘R) to deploy. The decision is `planIosInstall`
(`engine/plugins/vite-asset-scanner.ts`), deliberately one exported pure function so the
preflight guard and the step plan cannot disagree.

That disagreement is exactly what shipped for a while: the preflight demanded BOTH ids, so a
build that `xcodebuild` handles perfectly was refused before it started, and the refusal named
`project.config.json` — the wrong file. Caught on an iPhone 8 / iOS 16.7.16, whose build then
succeeded unchanged once the demand was dropped.

### Android Device
```bash
MODOKI_PROJECT=games/<id> npm run build -- --target native
(cd games/<id> && npx cap sync android)
JAVA_HOME=$(/usr/libexec/java_home -v 21) games/<id>/android/gradlew -p games/<id>/android assembleDebug
adb install games/<id>/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n <appId>/.MainActivity
```

## Converted assets: the manifest points at the SOURCE, the build ships the VARIANT

A sibling of the section above, and the same "fine in dev, broken when built" shape. Five asset
kinds go through a converter — **textures, audio, environment HDRs, models, fonts** — and on a
successful conversion the shaker ships only the derived variant and **drops the source**. But a
manifest entry's `path` is still the SOURCE path. So a consumer that does `assetUrl(entry.path)`
gets a URL that resolves in dev (Vite serves everything off disk) and 404s in production.

Every consumer must therefore go through its variant resolver — `resolveTextureVariantUrl` /
`servedAudioUrl` / `modelGlbUrl` — each of which falls back to the bare source **only when the
asset is unconverted**, which is exactly the case where the source *is* shipped.

**Fonts are the exception that proves it**, and the one that shipped broken. A font has two
independent consumers needing different files:

| consumer | authored as | needs |
|---|---|---|
| canvas text (`Text2D.font`) | a **GUID** | `~atlas.png` + `~metrics.json` |
| DOM text (`UIElement.fontFamily`, CSS) | a **family NAME** | the source `.ttf`/`.otf`, via FontFace |

`loadAllFonts` FontFace-loads the manifest path directly, so dropping the source 404'd every baked
font at boot in every game — visible only as `[FontLoader] N/N fonts failed to load`, with the
canvas text still rendering perfectly. It took an iPhone 7 to notice.

The source now ships **iff** a DOM consumer needs it:
`shipTtf = shipSource === 'always' || (shipSource !== 'never' && domUsed)`, where `domUsed` reuses
the tree-shaker's font-family walk (`TreeShakeResult.domFontFiles`). The build logs the decision
per font, and the manifest records `font.sourceShipped`, which `loadAllFonts` reads so a
deliberately-dropped font is skipped rather than fetched-and-warned.

⚠️ **`shipSource: 'auto'` cannot see a family named in CSS or assigned from game code** — a static
scan only reaches scene/prefab `fontFamily`. A game that styles DOM text from a stylesheet must set
`shipSource: 'always'` in the font's `.meta.json`, or its text silently falls back to a system face.
This is the one known blind spot in the rule.

## The shipped platform floors (`build.iosMinVersion` / `build.androidMinSdk`)

**Never let the bundler pick this.** Vite 8's default `build.target` is
`'baseline-widely-available'`, which resolves to `["chrome111","edge111","firefox114",
"safari16.4","ios16.4"]` — silently making **iOS 16.4 the minimum for every game we ship**. esbuild
then emits ES2022 static class blocks (three.js uses them), which are a **parse** error on older
WebKit: the chunk never parses, the eager module graph dies, and the app hangs on the splash screen
with *zero* JavaScript console output. `three.core` is on the eager boot path
(`index → renderSettings → three.core`), so it takes down 2D-only games too.

`build.iosMinVersion` (default **`16.4`**, raised from `15.4` on 2026-08-04 by owner decision —
deliberately dropping the iPhone 7 / 6s / SE1 era) is the single source of truth, with two
consumers that must never disagree.

⚠️ That the floor now *equals* the `ios16.4` the bundler default would have picked is a
coincidence, not a regression. The bug above was never the number — it was the floor being
**implicit**: inherited from a default that moves between bundler majors, and disagreeing with the
native deployment target. A deliberate, pinned 16.4 driving both consumers is the opposite of that.

The **three** consumers:

- **`vite.config.ts`** → `build.target` gets `ios<v>` / `safari<v>`
- **`healNativeConfig`** → `healIosDeploymentTarget` rewrites `IPHONEOS_DEPLOYMENT_TARGET` in the
  pbxproj (every build configuration — patching only the first leaves Release on the old floor)
- **`healNativeConfig`** → `healIosSpmPlatform` rewrites `platforms: [.iOS(.vNN)]` in
  `ios/App/CapApp-SPM/Package.swift` — the SPM package's own floor, **floored to the MAJOR**
  (16.4 → `.v16`), because SPM's `SupportedPlatform` enumerates majors. Coarser than the pbxproj
  target on purpose: a package minimum below the app's target always builds, and this is exactly
  what Capacitor's generator emits from the same value, so the heal agrees with `cap sync` rather
  than fighting it.

They were previously independent literals that DID disagree — pbxproj `15.0` vs a bundle needing
`15.4` — so the App Store would offer the game to a device that installs it and then dies on a
missing API.

⚠️ **The SPM floor was the third consumer, and it was unhealed until 2026-08-07** — so the "single
source of truth" reached two of three places. Raising the default from 15.4 to 16.4 moved the
pbxproj and the bundle and left `Package.swift` behind: **six of nine projects still declared
`.v15`** while every pbxproj read `16.4`. The three that had moved were simply the three someone
had run `cap sync` on since, which is the tell — the floor was tracking *who ran what*, not the
config. Not a build break (SPM tolerates a package minimum under the app target), but precisely
the per-project drift this config value exists to prevent. Both the heal and a
**committed-state** guard now exist; the mechanism-only guard could not see it, since the heal
runs on project open / native build and a project nobody opens stays stale on disk.

Note both files carry `// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands`. We rewrite
them anyway, for the same reason in both cases: regeneration is occasional and manual, and the
floor must not wait for someone to remember.

**15.4 remains the hard LOWER bound, not a round number.** esbuild lowers *syntax* but cannot
polyfill *runtime APIs*; scanning a built bundle for APIs it can't reach finds exactly
`structuredClone`, `Array.at` and `Object.hasOwn` — all three shipped in iOS 15.4. Lowering the
floor below 15.4 therefore needs polyfills, not just a smaller number; `16.4` sits comfortably
above that line, so no polyfills are needed at the current floor.

Guarded by `engine/tests/architecture/buildTargetFloor.test.ts`, which fails if the pin is removed,
replaced by a moving alias, if the two consumers are decoupled, or if the pinned floor value moves
without someone deliberately updating the test.

`build.androidMinSdk` (default **`31`**, Android 12 — reviewed alongside the iOS raise) is the
Android sibling, with the same shape:

- **`healNativeConfig`** → `healAndroidMinSdk` rewrites `minSdkVersion` in
  `android/variables.gradle` (every occurrence, `/g`, on open/build)

`cap add` scaffolds `minSdkVersion = 24` and nothing else ever revisits it, so without the heal a
newly-scaffolded project silently ships API 24 and the floor drifts per-project — the same drift
`iosMinVersion` was introduced to close on iOS. Same test file adds parallel Android coverage.

## iOS build notes

- **`.xcodeproj` vs `.xcworkspace` depends on the game's deps.** A Firebase-only / SPM-only game
  (3d-test) has NO CocoaPods → build with `-project …/App.xcodeproj`. A game that pulls CocoaPods
  mediation adapters (AppLovin MAX, etc.) gets an `App.xcworkspace` from `pod install` → build with
  `-workspace …/App.xcworkspace` instead.
- **Use `-allowProvisioningUpdates`** for device builds (auto-signing). `DEVELOPMENT_TEAM` must be
  the Team ID of an account signed into Xcode — see per-game signing in
  [native-and-sdks.md](./native-and-sdks.md).
- First build is slow — SPM downloads all SDK frameworks.
- If SPM fails with "already exists in file system", clear the cache:
  `rm -rf ~/Library/Caches/org.swift.swiftpm/artifacts/*`.
- Use exact device IDs in `-destination` (not names — they can be ambiguous).
- dSYMs auto-upload to Firebase Crashlytics via a build-phase script.
- Firebase DebugView: add `-FIRAnalyticsDebugEnabled` to the Xcode scheme arguments.

## Android build notes

- Requires **JDK 21** (Capacitor 8 / AGP). Set `JAVA_HOME=$(/usr/libexec/java_home -v 21)` before
  Gradle commands.
- Stock Gradle heap is `-Xmx1536m`; raise it (e.g. `-Xmx4096m`) only when a game bundles the 12
  AppLovin mediation adapters — none do yet.
- Device must show as `device` (not `unauthorized`) in `adb devices`.

**AppLovin SDK 13.x API notes** (only relevant to a game that bundles mediation):
`MaxAdFormat` replaces `AppLovinAdSize` for ad-format comparisons; `setUserIdentifier` moved to
`AppLovinSdk.getSettings()`; `setIsAgeRestrictedUser` / `setTestDeviceAdvertisingIds` removed (use
the dashboard); Adjust SDK v5 sets purchase time via `AdjustPlayStoreSubscription.setPurchaseTime(long)`.
