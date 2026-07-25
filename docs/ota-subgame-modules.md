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

**Publishing needs no tool change to `ota-publish.mjs`** — it already hashes whatever `dist`
directory it's given, so a sub-game bundle is just another `bundles/<name>` entry with
`--dist games/<id>/subgame-dist` instead of `--dist games/<id>/dist`. **What is NOT built
yet: automated end-to-end sub-game publish.** The editor's `Publish OTA Update…` dialog and
the `/api/ota/publish` route always run `build-web.mjs` (the normal shell build) and always
publish the currently-open project's own `dist/` — never `build-subgame.mjs`/`subgame-dist/`.
The route now explicitly refuses a `bundleName` that doesn't match the open project's own
`ota.bundleName` (rather than silently publishing plain shell content under a different
bundle's identity — a real bug a code review caught: see ota-updates.md's Gotchas). Publishing
a sub-game today means running `build-subgame.mjs` + `ota-publish.mjs` by hand, the way
`games/ota-subgame-test` was verified; wiring that into the editor/route is a real follow-up,
not done.

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
read before it happened). Per bundle: fetch `subgame.json` → `ensure(sharedDeps)` (also
wrapped so a failure here reports through the visible error list rather than propagating
unhandled) → load `subgame.js` via `<script>` tag → engine-API check (§4, against BOTH
`subgame.json` and the module's own export) → `loadManifestJson(fragment, {pathPrefix})` →
`registerDynamicGame()` → `confirmBoot()`.

## 4. Engine-API version contract

`ENGINE_API_VERSION` (`engine/packages/modoki/src/runtime/version.ts`) is the single source of
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
- **Cross-cutting, highest-value guard:** `runtime/instanceGuard.ts` —
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
`<script>` fails through `onerror` → rejection with the URL, never silently.

**§4 engine API.** Hand-edited `engineApi` "fixing" a rejection can't happen — it's stamped
from the constant at build time in two independently-read places, not hand-written.

## Related

- [ota-updates.md](./ota-updates.md) — the publish format and client this builds on; its
  Gotchas section covers the sub-game-publish-automation gap in the publish pipeline.
