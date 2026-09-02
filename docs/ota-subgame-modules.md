# Sub-game modules

How a `games/<id>` project ships as an independently OTA-updatable module the shell app
discovers and loads at runtime, instead of being baked into the shell's own build — the
mechanism behind [ota-updates.md](./ota-updates.md)'s multi-bundle release format. Shipped
and device-verified on iOS + Android (2026-07-25).

## Decision (locked in, do not revisit without new evidence)

`globalThis` singleton registry, not native `<script type="importmap">`. iOS deployment
target is 15.0 (import maps need Safari 16.4+); multi-map support is Safari 18.4+/Chrome 133+
(too new to rely on); and a URL-keyed import map is fragile against independently-published,
separately-hashed shell/sub-game bundles regardless of iOS version. The registry instead holds
already-loaded singleton **instances**, sidestepping both problems.

## 1. The registry mechanism

**Shell side** — `engine/app/sharedRegistry.ts`, imported for side effects as the first
import of `engine/app/main.tsx` (before `App.tsx`, before any renderer mounts):

```js
globalThis.__MODOKI_SHARED__ = {
  registrySchema: 1,
  engineApi: ENGINE_API_VERSION,
  modules: {                      // module namespace objects, already evaluated
    'three': ns, 'three/tsl': ns, 'three/webgpu': ns,
    'koota': ns, 'zustand': ns, 'zustand/shallow': ns,
    'react': ns, 'react/jsx-runtime': ns, 'react-dom': ns, 'react-dom/client': ns,
    'pixi.js': ns, '@pixi/react': ns, '@capacitor/core': ns,
    '@modoki/engine/runtime': ns, '@modoki/engine/runtime/rendering': ns,
  },
  loaders: {                      // lazily-filled entries
    'three/webgpu': () => import('three/webgpu'), 'pixi.js': () => import('pixi.js'), …
  },
  ensure: (keys: string[]) => Promise<void>,  // awaits loaders, populates modules
}
```

Keyed by exact **subpath, not package** — `@modoki/engine`'s exports map has distinct entries
(`./runtime`, `./runtime/rendering`, `./three`), and `three/webgpu`/`three/tsl` carry their own
TSL node registries. Registering `three` alone while a sub-game imports `three/webgpu` is the
silent double-instance trap the whole design exists to avoid — **spike-verified**: Rollup
externalizes `three` and `three/webgpu` as distinct registry keys, they do not collapse.

Lazy entries exist so eagerly importing `three/webgpu`/`pixi.js` in the shell doesn't defeat the
`__MODOKI_MODULE_RENDER3D__`/`RENDER2D` DCE gates (`engine/app/App.tsx`). Renderer namespaces
register when the shell's own lazy import resolves; `ensure()` forces them for a sub-game that
declares them as a dependency.

**A failed lazy load can be retried (#522).** `ensure()` memoizes an in-flight load per key in a
`pending` map so two overlapping callers share one `import()`, and that entry is now cleared when
the load *settles* (`.finally`), whether it resolved or rejected. Before #522 it was never cleared
at all — the file held no `pending.delete`/`pending.clear` on any path. That went unnoticed
because a *resolved* entry is harmless: `modules[key]`, checked first, short-circuits a repeat
call before the map is ever consulted. So the map only misbehaved on the failure path, where
one rejected dynamic import (a flaky chunk fetch, a mid-deploy asset swap) stayed memoized for
the life of the process — every later `ensure()` for that key re-awaited the same dead rejection,
leaving every sub-game that declares the dep unbootable until an app restart, even though the
browser itself would have permitted the retry.

**Sub-game side** — classic library-externalization via Rollup, same primitive already used
in `engine/packages/capacitor-modoki-ota/rollup.config.mjs` (`external` + `output.globals`):

```js
external: (id) => SHARED_KEYS.has(id) || SHARED_PREFIXES.some(p => id.startsWith(p)),
output: {
  format: 'iife',
  name: '__MODOKI_SUBGAME__',
  inlineDynamicImports: true,
  globals: (id) => `__MODOKI_SHARED__.modules[${JSON.stringify(id)}]`,
}
```

`format: 'iife'` is deliberate: shared resolution is **synchronous at bundle evaluation**, so
every declared dep must already be in `modules` before the bundle runs (hence `ensure()` + a
declared `sharedDeps` list per sub-game). It also means one JS file per sub-game
(`inlineDynamicImports`, same reasoning as the playable build), loadable via a classic
`<script>` tag rather than `import()` — sidestepping MIME/CORS/module-scheme questions in both
WebViews.

## 2. Per-sub-game Vite build target

`engine/scripts/build-subgame.mjs`, a sibling of `build-web.mjs` reusing its scoped typecheck
block, invokes Vite with `MODOKI_SUBGAME=1`. `engine/vite.config.ts` branches on that flag to
load `engine/plugins/subgameBuild.ts`, which supplies:

- **entry**: virtual module `virtual:modoki-subgame-entry` (same pattern as `GAMES_VIRTUAL_ID`
  in `engine/plugins/vite-asset-scanner.ts`) assigning `globalThis.__MODOKI_SUBGAME__ = {
  game, engineApi }` as a genuine side effect — replacing `index.html` as the rollup input, so
  no HTML is emitted. **Rolldown gotcha:** a plain `export const` at the entry does NOT
  survive into an `iife` chunk (this Vite ships Rolldown as its Rollup implementation) —
  measured, it silently produced a 0-byte `subgame.js` regardless of `treeshake`/`minify`
  settings. The `globalThis` assignment sidesteps it because it's a real statement, not a
  named export.
- **outDir**: `<projectRoot>/subgame-dist/` (a third output dir next to `dist/`/`ads/` —
  `subgameOutDir()`).
- externals/globals/format from §1, recording which `SUBGAME_SHARED_KEYS` id the sub-game's
  code actually imports (via the same `resolveId` hook that does the externalizing, not
  `build.rollupOptions.external`) so `subgame.json`'s `sharedDeps` is scoped to what THIS
  bundle needs — a sub-game that only imports `three` shouldn't force the shell's `ensure()`
  to eager-load `pixi.js` too.

Output directory shape:

```
games/<id>/subgame-dist/
  subgame.js            # one IIFE chunk; zero engine/three/react code inside
  subgame.json          # {schema:1, engineApi, sharedDeps:[…], entry:"subgame.js"}
  assets.manifest.json  # this sub-game's asset-manifest fragment
  assets/**             # its own converted assets
```

**Publishing a sub-game module is a hand invocation of `ota-publish.mjs`, and it now enforces
its own identity guards on that dist** (#582) — it already hashes whatever `dist` directory
it's given, so a sub-game bundle is just another `bundles/<name>` entry with `--dist
games/<id>/subgame-dist` instead of `--dist games/<id>/dist`, but `--project` is now REQUIRED
and must point at the **shell project whose app receives the release** (the one that will
`fetch`/verify it at runtime), e.g.:

```
node engine/scripts/ota-publish.mjs \
  --dist games/ota-subgame-test/subgame-dist --bucket gs://modoki-ota/ota-test \
  --name ota-subgame-test --version v1 --engine-api 1 --key default \
  --project games/ota-test
```

The dist must be a REAL `subgame-dist/` (i.e. `build-subgame.mjs`'s output, containing
`subgame.json`) — the script refuses a plain shell `dist/` published under a sub-game name (see
ota-updates.md's #582 Gotchas entry for why, and why that guard is not simply the route's
bundleName-equality check ported over). **What is NOT built yet: automated end-to-end sub-game
publish.** The editor's `Publish OTA Update…` dialog and the `/api/ota/publish` route always
run `build-web.mjs` (the normal shell build) and always publish the currently-open project's
own `dist/` — never `build-subgame.mjs`/`subgame-dist/`. The route explicitly refuses a
`bundleName` that doesn't match the open project's own `ota.bundleName` (rather than silently
publishing plain shell content under a different bundle's identity — a real bug a code review
caught: see ota-updates.md's Gotchas). Publishing a sub-game today means running
`build-subgame.mjs` + `ota-publish.mjs` by hand, the way `games/ota-subgame-test` was verified;
wiring that into the editor/route is a real follow-up, not done.

**Asset paths.** The scanner emits root-absolute paths (`/assets/x.png`), which would collide
across sub-games. `loadManifestJson(json, opts?: {pathPrefix})` in `assetManifest.ts` prefixes
each entry's path at register time with the sub-game's staged root — the manifest is a
guid→path map consumed only through `resolveRef` → `assetUrl`, so prefixing once at merge is
enough.

## 3. Dynamic `GAMES`

**Discovery.** Sub-game bundles are ordinary OTA bundles, discoverable from `release.json`
(which `checkForUpdate` already fetches). `fetchRelease(baseUrl, publicKey)` in `otaClient.ts`
extracts the fetch+verify it does internally; `engine/app/ota.ts`'s `checkAppSubgameUpdates()`
iterates `Object.keys(release.bundles).filter(n => n !== ota.bundleName)` and calls the
existing `checkForUpdate` once per name. No new publish concepts, no new gates — quarantine,
delta, engine-API gating all apply per bundle for free.

**Loading a staged bundle.** `ModokiOta.listBundles(): Promise<{name, version, path}[]>`
returns each staged bundle's folder; `Capacitor.convertFileSrc()` turns that into a loadable
URL — confirmed on real hardware, both platforms: Android
`http://localhost/_capacitor_file_/data/user/0/<pkg>/files/modoki-ota/...`, iOS
`capacitor://localhost/_capacitor_file_/private/var/mobile/.../ionic_built_snapshots/...`. No
blob-URL fallback needed. The shell's own bundle is served from the active shell version
folder, so sub-games cannot simply be dropped into the served webroot without breaking
per-bundle rollback — they load via the script-tag path, not the webroot.

**Registry.** `engine/app/gameRegistry.ts` holds `baked` (from `virtual:modoki-games`) +
`dynamic[]`, with `getGames()`/`registerDynamicGame()`/`subscribeGameRegistry()`. `App.tsx`
reads through it instead of importing `GAMES` directly.

**Loading — `engine/app/subgameLoader.ts`.** `loadStagedSubgames()` (called once from
`App.tsx`, additively in the background, memoized against re-entry — see its own header for
why re-entry would lose a boot confirmation) discovers staged bundles and loads them
**sequentially, not concurrently**: each bundle's `<script>` IIFE writes its module export to
the single global `__MODOKI_SUBGAME__`, which `loadOneSubgame` immediately reads and clears —
two bundles loading in parallel would race that one global (a real bug a fresh-eyes code
review caught: a dynamically-injected `<script>` executes as soon as its OWN download
completes, not in insertion order, so the second bundle's script could clobber the first's
read before it happened). Per bundle NAME: `beginBundleLoad(name)` (§3a — which version, and count the attempt) →
fetch `subgame.json` → `ensure(sharedDeps)` (also wrapped so a failure here reports through
the visible error list rather than propagating unhandled) → load `subgame.js` via `<script>`
tag → engine-API check (§4, against BOTH `subgame.json` and the module's own export) →
`loadManifestJson(fragment, {pathPrefix})` → `registerDynamicGame()` →
`confirmBoot({name, version})`.

## 3a. The sub-game watchdog — which version loads, and what happens when it doesn't

⚠️ **`listBundles()` is DISCOVERY ONLY. It prefers `active` over `pending`, which is the
opposite of what loading needs — never use its `version`/`path` to decide what to run.**

That inversion was #553, and it is worth stating because the old code read as obviously
correct. `loadStagedSubgames` stages updates and then lists, in one pass:
`checkAppSubgameUpdates()` → `checkForUpdate` → `activate({name, version: vNew})`, which sets
`pending[name] = vNew`; then `listBundles()` returns **vOld**, because active is preferred;
then the loader ran vOld, it loaded fine, and called an unconditional `confirmBoot({name})`
— which promotes whatever is *pending*. Two launches of that and **vNew was `active` having
never once executed**. When it was finally served and correctly refused (the fatal manifest
check below), it was already promoted, and a sub-game had no attempt counter, no `revert()`
and no quarantine to demote it with: offline, the game was refused on every launch forever.
Device-verified on a Galaxy S22, 2026-09-01 — and note the shell bundle must be rebuilt from
the branch before any of this is measurable, see ota-updates.md's Testing section.

The fix routes sub-games through the **same `OtaCore.boot()` state machine the shell uses** —
it was never broken for sub-games, it was simply never called with a sub-game name (the
native boot hook is invoked twice in the repo, both with the shell name).

| Step | Native call | What it does |
|---|---|---|
| Decide | `beginBundleLoad({name})` | `OtaCore.boot()`: **`pending` preferred over `active`**, and `bootAttempts` incremented BEFORE the load — so a bundle that takes the page down with it still burns an attempt and is reverted after `maxAttempts` |
| Succeed | `confirmBoot({name, version})` | `version` must equal `pending[name]` or the confirm is a no-op — promotion can no longer be credited to a version that did not run |
| Fail | `reportBundleLoadFailure({name, version, disposition})` | applies the revert/quarantine and returns the version to fall back to this launch |

**⚠️ `folderExists` is NOT the shell's predicate.** The shell's additionally requires
`index.html`, because a shell bundle is what the WebView serves; a sub-game bundle has no
`index.html` at all. Reusing it would make every sub-game look absent, and `boot()` answers an
absent *pending* folder with an immediate revert — every staged sub-game silently discarded on
its first load.

**The fallback is loaded but NEVER confirmed.** It is the version being replaced; confirming
it is the original defect. Exactly one retry: the fallback is `active`, which by construction
already loaded successfully `requiredConfirms` times.

### Dispositions — the load-bearing part

A refusal's *disposition* decides whether the version is blocked on this device forever, so it
is not a severity ranking. `loadOneSubgame` returns one per refusal; `OtaCore.loadFailed`
applies it.

| Disposition | Refusals | Effect |
|---|---|---|
| `fatal` | a non-ok or unparseable `subgame.json` · `<script>` `onerror` · a module with no `game.id` · **a missing/unparseable `assets.manifest.json`** | reverts to the previous version **and quarantines**, immediately — no attempts burned (#550) |
| `transient` | `ensure(sharedDeps)` failed · **a `fetch` that REJECTED** (as opposed to returning non-ok) for either JSON file · **a script that assigned no module** (see below) | for a PENDING version: costs one attempt; three exhaust and quarantine, as for the shell. For an ACTIVE one: clears `active` immediately, never quarantining — see the ⚠️ below. A retry is genuinely possible rather than merely hoped for — §1's #522 note: `ensure()` clears its `pending` entry when a load SETTLES, so a rejected dynamic import is no longer memoized for the life of the process |
| `notEvidence` | `engineApi` mismatch (either check) · `gameId` collision · `__MODOKI_SHARED__` missing | gives the attempt back, **never quarantines** |

⚠️ **Two splits in that table are load-bearing and were both wrong in the first draft** (caught by review, 2026-09-01):

- **A script that loads but assigns nothing must ESCALATE — it was `notEvidence`, which refunds the attempt.** A `<script>` whose
  code THROWS at evaluation fires `load`, not `error` — so the loader resolves and simply finds
  the global unassigned. That is a *crashing bundle*, the likeliest real breakage there is. It
  shared a branch with the `engineApi` mismatch, so it refunded its own attempt: `bootAttempts`
  never passed 1, `boot()`'s exhaustion revert could never fire, and `checkForUpdate`
  short-circuits `up-to-date` on a still-pending version. Refused every launch, forever, never
  quarantined — the exact state this whole mechanism exists to remove. It is now `transient`
  rather than `fatal`, because the evidence is **ambiguous**: `subgameBuild.ts` puts the global
  assignment at the END of the module graph, so any module-scope throw lands here — including
  ones that are facts about the DEVICE (an `AudioContext` built at import, a `navigator.gpu`
  probe, a blocked `localStorage`). Quarantine is permanent, so `transient` escalates without
  betting a good bundle on one launch. #550's fail-fast is not in tension: that was about a
  MISSING manifest, which is unambiguous.
- **A `fetch` that REJECTS is transport, not content.** A missing file returns a clean 404
  through Capacitor's local scheme (device-verified), so non-ok *is* evidence about the bytes; a
  rejection is a WebView-loader `TypeError` and says nothing about them. Charging it `fatal`
  quarantines a perfectly good published version on one blip — permanently, because `rejected`
  survives `resetForNewBinary` and nothing in the codebase un-quarantines. `transient` still
  costs an attempt and still quarantines after `maxAttempts`; a genuinely dead file just has to
  prove it three times.

**Why `fatal` quarantines** (owner ruling, 2026-09-01 — #550 left it open). The bundle zip is
SHA-256-verified before the atomic rename, so re-staging fetches *identical* broken bytes:
retrying cannot help. And without the quarantine, `checkForUpdate` re-stages the same bundle
on every launch — `pending` was cleared, the feed still advertises it, and nothing vetoes it —
an unbounded re-download loop, worse on mobile data than the bug being fixed. The shell's
existing fail-fast precedent (a *vanished folder* → revert without quarantine) deliberately
does not apply: that is a transient disk event, this is hash-verified published content.

**Why `notEvidence` must never quarantine.** `rejected` is deliberately preserved across
`resetForNewBinary`. An `engineApi` mismatch is a fact about the pair (bundle, host) and only
the host is going to change — quarantining it would permanently block a bundle that the *next*
app binary would run perfectly. A `gameId` collision is likewise about this shell's registry,
not the bundle's bytes.

### Verified on hardware

Galaxy S22 (`SM-S901U1`), `com.example.otatest` debug build from this branch, **offline** (wifi +
data disabled, so the release feed could not stage or rescue anything), cold starts only
(`am start -W` reporting `LaunchState: COLD`), full `logcat -d` to file, 2026-09-01.

Provenance pinned first, three ways: the built bundle contains `beginBundleLoad` and no longer
contains the pre-fix comment; the APK carries that same `index-eN-kFHre.js`; and the running
bundle logs that byte-identical filename. Positive control asserted before any negative result.

| Run | Start state | Served | Refusal | `confirmBoot` | End state |
|---|---|---|---|---|---|
| control | `pending: v1` (intact) | v1 | none | `{name, version: "v1"}` | `bootAttempts: 1`, `confirmedBoots: 1` |
| **#553** | `active: v1`, `pending: v2` (no manifest) | **v2 first**, then the v1 fallback | `assets.manifest.json fetch failed (404)` → `disposition: "fatal"` | **none** | `active: v1`, `pending: {}`, **`rejected: ["v2"]`** |
| stability | (as above) | v1 only | none | `{name, version: "v1"}` | unchanged |
| `notEvidence` | `active: v1`, `pending: v2` (engineApi 99) | v2, then v1 | `engineApi mismatch` → `disposition: "notEvidence"` | none | **`rejected: {}`**, `pending: v2` survives, attempt given back |

**Second pass, after review changed the native side** (same method, shell rebuilt again and
re-pinned — the running bundle was `index-8ztQvoGn.js`, and the earlier runs are NOT evidence
about this code):

| Run | Start state | Refusal → disposition | End state |
|---|---|---|---|
| **active slot** | `active: v2`, whose `subgame.js` THROWS at evaluation | `did not assign globalThis.__MODOKI_SUBGAME__` → `transient` | **`active: {}`** — cleared, and `rejected: {}` |
| #553 re-run | `active: v1`, `pending: v2` (no manifest) | 404 → `fatal` | `active: v1`, pending cleared, `rejected: ["v2"]` |

The first row is the one worth having, because it is **self-discriminating**: the escalation it
tests is native, and the previous plugin would have left `active: v2` untouched. It also
exercises the `!mod` split and its `transient` mapping end to end — the message and the
disposition in that row exist only in the post-review code.

Three things that were the whole point: **v2 is fetched before v1** (timestamps 41 ms apart —
pending really is preferred); the fallback loads but is **never confirmed**; and the broken version
is reverted and quarantined **on the first launch**, where the pre-fix behaviour took two launches
to promote it and then never recovered. The shell's own `confirmBoot` still logs as
`{"name":"shell"}` with no version, confirming the argument is genuinely optional.

⚠️ **The fallback load evaluates a second module graph in the live page.** `loadBundleByName`
loads the fallback for ANY non-null disposition, and most refusals happen *after* `loadScriptTag`
resolved — an unassigned module, a missing `game.id`, both `assets.manifest.json` outcomes, the
module `engineApi` mismatch and the `gameId` collision, so the failed version's IIFE has already run
when the fallback's is appended; neither `<script>` is ever removed. Nothing shipped today has an
observable module-scope side effect that would double up (the sub-game bundle inlines its graph
with only the SHARED set externalized), so this is a known consequence rather than a live defect —
but a sub-game that registers something at module scope against a shared singleton would do it
twice, and the integration test for it does not exist yet.

⚠️ **`bootAttempts` is a PENDING-ONLY counter, so the dispositions are not symmetric across the
two slots.** "Costs one attempt, quarantines after `maxAttempts`" describes the `pending` slot
only. An `active` version has nothing to count and nothing to exhaust — so `OtaCore.loadFailed`
escalates it a different way: any failure that is not `notEvidence` clears `active` outright
(never quarantining, since a version that loaded `requiredConfirms` times and then stopped is
evidence about this DEVICE), which lets `checkForUpdate` re-stage and heal. Getting this wrong is
easy and silent: while the `active` branch fired on `fatal` alone, a persistently failing active
bundle was refused on every launch forever with no counter, no revert and no quarantine — the
same never-escalates shape, one branch over. Caught by review, not by the gate.

**Still out of scope, same as the shell:** a version that loads cleanly twice, is promoted, and
only then breaks in a gameplay path. Promotion requires `requiredConfirms` successful loads;
runtime crash-loop detection is not built. The one concession sub-games get is that a `fatal`
failure of an *already-active* version clears `active` (the game is simply not offered) —
without quarantining, because a version that loaded twice and then broke is evidence about
this device's disk, not about what was published.

## 4. Engine-API version contract

`ENGINE_API_VERSION` (`engine/packages/modoki/src/runtime/core/version.ts`) is the single source of
truth; `project-config.ts`'s `ota.engineApi` default is pinned to it by a vitest.

A sub-game declares its expected version **twice, both build-stamped from
`ENGINE_API_VERSION`**, never hand-written: `subgame.json.engineApi` and a static `engineApi`
export in the module. The shell checks both, after evaluation and **before** registering the
game or touching the world:

```
if (mod.engineApi !== ENGINE_API_VERSION || meta.engineApi !== mod.engineApi) → refuse
```

**Exact equality, not `>=`**, until a written compatibility policy exists (open design
question — see ota-updates.md's Related/open-items). The shell-level manifest gate
(`otaClient.ts`) only refuses `manifest.engineApi > running`; a sub-game's own gate is
stricter on purpose, because a sub-game built against a *different* engine (older OR newer)
must refuse to load loudly rather than crash mid-scene.

Refusal is loud, never silent: every failure collects into `subgameLoader.ts`'s
`subscribeSubgameLoadErrors` list — `console.error` plus a visible entry, never a bare
`catch`. A refused sub-game just doesn't appear in `getGames()` — the shell and other
sub-games keep running.

## Failure-mode checklist (what each guard actually catches)

**§1 registry.**
- *Subpath miss* (`three` registered, sub-game imports `three/webgpu`) → not externalized → a
  second copy bundled → TSL node identity splits, WGSL codegen breaks silently. Guarded by
  `external` being a predicate over exact keys **and** prefixes.
- *Missing entry at eval* → `undefined.Vector3`, a loud crash. Guarded by `ensure(sharedDeps)`
  refusing to evaluate when a key is absent.
- **Cross-cutting, highest-value guard:** `runtime/core/instanceGuard.ts` —
  `globalThis.__MODOKI_RUNTIME_INSTANCES__`, incremented on first evaluation of
  `@modoki/engine/runtime`, logs loudly (never throws) if a second copy ever evaluates. Catches
  every duplication route at once — botched externals, a stale registry key, a future Vite
  dedupe regression — turning "breaks in ways that don't look like the cause" into a one-line
  diagnosis.

**§2 build target.** A sub-game built with the *normal* config (not `MODOKI_SUBGAME=1`) works
in isolation and duplicates every singleton — there is no runtime guard against this
specifically beyond the instance guard above catching it once loaded.

**§3 dynamic GAMES.** Duplicate `id` between baked and sub-game → `registerDynamicGame`
refuses loudly (returns `false`, `subgameLoader.ts` reports it), never last-write-wins. A 404
`<script>` fails through `onerror` → rejection with the URL, never silently. `subgameLoader.ts`
also probes this collision itself, SYNCHRONOUSLY and BEFORE fetching `assets.manifest.json` —
`registerAsset` is last-write-wins on a GUID, so merging a fragment ahead of the id check would
repoint the baked game's asset paths at the bundle's staged root before the bundle is refused,
with no un-merge. `registerDynamicGame`'s own check afterward stays the authoritative claim; the
probe is sufficient, not just narrowing, because sub-games load sequentially in a single
memoized pass (`loadStagedSubgames()`'s loop awaits each bundle in turn, and `subgameLoader.ts`
is the only production caller of `registerDynamicGame`) — nothing can register between the probe
and the merge, so a same-id bundle is always caught by the probe.

A non-ok or unparseable `assets.manifest.json` is **fatal**, not a warn-and-continue: the vite
asset scanner writes that file unconditionally on every build, so a missing/broken one means a
genuinely broken bundle. `subgameLoader.ts` reports it through the visible error list and leaves
the sub-game **unregistered**, so it never reaches `confirmBoot`.

⚠️ This paragraph used to end "so the bundle is never confirmed **and rolls back**". There was no
rollback — that was #553. Refusing to confirm only withholds a *promotion*; it demotes nothing,
and by the time a bad bundle was finally served it had already been promoted on the previous
version's successful loads. The rollback now exists, and it is §3a's `reportBundleLoadFailure`,
not a property of declining to confirm.

**§4 engine API.** Hand-edited `engineApi` "fixing" a rejection can't happen — it's stamped
from the constant at build time in two independently-read places, not hand-written.

## Related

- [ota-updates.md](./ota-updates.md) — the publish format and client this builds on; its
  Gotchas section covers the sub-game-publish-automation gap in the publish pipeline.
