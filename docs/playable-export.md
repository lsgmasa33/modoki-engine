# Playable-ad export

A `VITE_PLAYABLE=1` build that collapses one game into a single self-contained `index.html`
(≤ `build.playableMaxBytes`, default 5 MB) for ad networks (AppLovin/ironSource) — fully **offline**
(no network), loaded in a strict ad webview, gated by an injected `window.mraid`. Trigger it from the
editor's **Build → Playable Ad**, or `MODOKI_PROJECT=games/<id> npm run build -- --target playable` →
`games/<id>/ads/index.html` (`--target` sets `VITE_PLAYABLE=1` itself — passing it directly instead
of `--target playable` is refused, #40). (Grew out of the `advideo-playable-export-plan` tracker, now landed.)

## Key files

| File | Role |
|---|---|
| `engine/vite.config.ts` (the `isPlayable` branch) | `outDir=ads/`, `inlineDynamicImports` (single JS chunk), sets `MODOKI_PLAYABLE=1`, the `__MODOKI_PLAYABLE__` / `__MODOKI_PLAYABLE_CLICK_URL__` defines, and the playable-only aliases (`@zappar/msdf-generator` + `@<game>/app-services` → stubs) |
| `engine/plugins/playable-profile.ts` | `isPlayableBuild()` (reads `MODOKI_PLAYABLE`) + the asset-shrink overrides — WebP @ ≤512, downscaled HDR, KTX2-transcoder skip |
| `engine/plugins/inlinePlayable.ts` | The single-file inliner — gzip+base64 the `{js,css,assets}` payload, a self-extract bootstrap (`DecompressionStream` + inlined `fflate` fallback) that rehydrates assets as `blob:` URLs on `__PLAYABLE_ASSETS__`, and the hard `≤ playableMaxBytes` gate |
| `engine/plugins/vite-asset-scanner.ts` | Applies the playable profile inside `computeKeptAssets().kept` copy loops; bakes `loadType:'buffer'` for all audio in a playable |
| `engine/app/main.tsx` | Behind `__MODOKI_PLAYABLE__`, dynamically imports `bootPlayable`; the debug-bridge import is `!__MODOKI_PLAYABLE__`-gated so it DCEs |
| `engine/app/playable/bootPlayable.tsx` | The runtime entry — audio gate, overlay mount, `playable:end` latch |
| `engine/app/playable/mraid.ts` | MRAID v2 shim — `whenReady`/`whenViewable`/`onViewableChange`/`installClick`/`startTimeCap`/`isInAdContainer` |
| `engine/app/playable/PlayableOverlay.tsx` | The CTA — a persistent Install pill + an end-card (Install + Replay) |
| `engine/app/playable/playableEnd.ts` | Latches `window 'playable:end'` so an end fired before the overlay mounts isn't lost |
| `engine/scripts/smoke-playable.mjs` | `npm run smoke:playable` — the headless-Chromium artifact smoke |

## How it works

**Build.** `MODOKI_PLAYABLE=1` layers aggressive asset overrides (WebP-only textures @ 512, downscaled
HDR) on the reachable set, and `inlineDynamicImports` collapses the whole graph — including the
flag-gated lazy renderers — into ONE JS chunk. The asset scanner copies the reachable assets into
`ads/`; the inliner then JSON-stringifies `{js, css, assets}`, gzips + base64s it into a `<script>`
bootstrap, deletes the now-inlined files, and fails the build if the result exceeds the byte cap.

**Runtime.** The bootstrap inflates the payload (`DecompressionStream`, or the inlined `fflate.gunzipSync`
fallback), turns every asset into a `blob:` URL on `globalThis.__PLAYABLE_ASSETS__`, and imports the JS.
`assetUrl()` resolves a root-absolute path to that blob, so THREE's loaders / `fetch` / `img.src` all
load offline uniformly. `main.tsx` (behind `__MODOKI_PLAYABLE__`) runs `bootPlayable`; `App.tsx` skips
`registerAppServices()` (no native SDKs in an ad).

**Gating.** `bootPlayable` mutes audio at boot and unmutes only when the ad is **both viewable AND the
user has interacted** (re-muting whenever it scrolls off-screen); it withholds the CTA overlay until
viewable, routes Install through `mraid.open(storeUrl)`, caps a rewarded playable at 30 s, and shows
the end-card on the cap or a game-dispatched `window 'playable:end'`.

## Engine module toggles (`build.modules`)

A build can include/exclude the heavy engine SDKs (three.js, PixiJS, Rapier 2D/3D) and the video
payload so an unused one is dead-code-eliminated. This is a **general build feature** (it shrinks
web builds too), but its headline win is fitting a game under the playable's 5 MB ceiling. `project.config.json`
`build.modules.<key>` is `'auto' | boolean` per module (`render3d`, `render2d`, `physics2d`, `physics3d`,
`video`; all `'auto'` by default). **Every key here is read by real gating code** — see "A toggle that
removes nothing" below for the two that were not, and why they are gone rather than wired.

- **Resolution** (`engine/plugins/detect-modules.ts`, Node-only): `resolveModules` turns each toggle into a
  concrete boolean. `'auto'` → `detectModules` scans the project's included scene JSON for trait signals
  (`Renderable3D`/`Light`/`Camera`/`Environment`/`ModelSource` → `render3d`; `Canvas2D`/`Renderable2D`/`Sprite`
  → `render2d`; `RigidBody2D`/`Collider2D` → `physics2d`; `VideoPlayer` → `video`; `layer:'3d'|'2d'` on
  `EntityAttributes`). Broad on purpose — a false-positive just ships an unused SDK
  (safe); a false-negative is loud (a build-time warn + the guard below). An explicit `true`/`false` forces
  it and logs a warning if `false` contradicts a used module.
- **Wiring**: the resolved booleans become `__MODOKI_MODULE_RENDER3D__` / `…_RENDER2D__` / … Vite defines
  (`vite.config.ts`), which flag-gate the renderers' lazy imports in `App.tsx` (`Scene3D`/`Game`) so Rolldown
  DCEs the excluded SDK — the same mechanism the debug menu + journal use.
- **UI**: **Project Settings → General → Developer → Engine modules** — a tri-state **Auto | On | Off** per
  module (`ModuleTogglesEditor`, the `'module-toggles'` field), persisted through `/api/project-settings`.
- **Also readable at runtime, by the editor itself.** `resolveModules` isn't build-only anymore: the running
  editor's dev-server backend exposes `GET /api/build-modules`, which reuses this exact resolution (real
  `projectRoot`, not the always-all-true `null` the editor's own Vite build passes) so the browser-side
  editor can ask "does this project actually render 3D?" — used to suppress a renderer-health warning for
  2D/UI-only projects that never mount a 3D viewport (see
  [editor.md](./editor.md#createeditor--host-configuration)).

## Gotchas (the load-bearing, hard-won ones)

- **Gating `App.tsx`'s entry is NOT enough — one other reachable import re-roots the whole SDK**
  (#214). `games/space-invader` sets `render3d: false`, and the toggle genuinely reached the shell
  (the built bundle folds the boot condition, `Scene3D` really is `null`) — yet it still shipped a
  **546 KB `three.webgpu` chunk**, because `textureResolver`'s KTX2 caps probe kept an *ungated*
  `import('../rendering/capsProbeRenderer')`, and that module pulls `scene3DSync` → `three/webgpu`.
  A dynamic import is a graph edge whether or not anything ever calls it, so the SDK shipped while
  being unreachable at runtime. Gating it took the bundle from **3025 kB → 2443 kB** of JS (gzip
  931 → 767 kB). Two things follow:
  - **The DCE gate has a SHAPE**: the `__MODOKI_MODULE_*__` check must return *before* the import,
    in the same function (see `ensureKtx2Caps`, and `materialPresets`' `fileShaderBuilder` gate).
    A flag consulted after the `import(...)` folds nothing.
  - **`npm test` could not see this class, so a guard now does.**
    `engine/packages/modoki/tests/runtime/render3dBoundary.test.ts` walks the import closure from
    the 2D boot entries and fails if anything reaches `three/webgpu`/`three/tsl`; gated edges are
    listed explicitly and each is re-checked to still carry its gate. Adding a new one is a
    deliberate line in `GATED_EDGES`, not a silent 546 KB.

- **The SAME symptom had a SECOND mechanism, and #214's gate does not touch it** (#254). Post-#214
  `space-invader` still carried three's **example loaders** — `GLTFLoader`, `HDRLoader`,
  `UltraHDRLoader`, `KTX2Loader` and the meshopt decoder — because they were *static* imports in
  modules the `runtime/index.ts` barrel keeps alive (`loadGLB`, `meshTemplateCache`,
  `riggedModelCache`, `textureResolver`). Nothing reached `three/webgpu`, so the #214 guard was
  green and correct; a 2D game simply shipped four loaders it can never call.
  - **Attribution first, refactor second.** Each group was stubbed out and rebuilt to get a real
    number before anything was designed: KTX2Loader **−60.2 kB raw / −24.4 kB gzip**, and
    GLTF+meshopt+HDR+UltraHDR **−126.3 kB / −34.9 kB**, of a 2458 kB / 779 kB baseline. Together
    they release 2.9 kB *more* than the sum of their parts — the three core only they retained —
    which is the measurement that says the rest of that chunk is core a 2D build genuinely uses
    (`Object3D`/`Matrix4`/`BufferGeometry`). **A barrel/registration refactor is therefore NOT
    justified**; the loaders were the whole recoverable win.
  - **One module owns all four gates**: `runtime/loaders/threeLoaderModules.ts`. Landed result
    **2269 kB raw / 719 kB gzip** (−184.2 / −58.7), within 850 bytes of the stub prediction.
  - **A 3D build pays one round-trip it did not before** — the loader chunk must arrive before the
    first GLB fetch can start. So `setActiveRenderer` (the one call every 3D viewport makes) fires
    `prewarmGlbLoaders()`; GLTF+meshopt only, since an HDR or KTX2 chunk is speculative in a way
    those two are not.
  - **Making a lazy singleton async opens a window it never had — memoise the PROMISE, not the
    value.** `riggedModelCache.getLoader()` assigned its loader, *then* awaited `getKTX2Loader()`
    to attach the transcoder. A second caller arriving in that gap saw a truthy field and got the
    loader back **unconfigured**, so an optimized `.processed.glb` carrying KTX2 textures throws
    "setKTX2Loader must be called before loading KTX2 textures". Found reviewing the #254 diff,
    not by a failing test. ⚠️ **Latent, not routine** — the first write-up of this said
    "concurrent rigged acquires within one scene load are the normal case", and an independent
    re-read disproved it: the sole caller is `ensureKtx2Caps().then(getLoader)`, and every way
    caps become ready has already awaited `getKTX2Loader()`, so the exposed window is one
    microtask rather than a chunk fetch. Fixed anyway — the shape is wrong regardless and the fix
    is free — but do not cite it as a bug that was firing. The same shape is in `meshTemplateCache`'s HDR loaders (benign there —
    nothing is configured post-construction) and was written correctly in `ModelPreview`; they
    are all `??= (async () => …)()` now, so the class is closed rather than one instance of it.
  - **A promise CACHE has the same trap as a promise memo, and a `??=` sweep will not find it.**
    `meshTemplateCache`'s `loading` map stores each in-flight parse and is also what makes a
    second acquire dedupe — so nothing removed a REJECTED entry, and every later acquire of that
    GLB got the same rejection back with no new attempt. Survivable while the only cause was a
    missing/corrupt GLB; #254 added a transient one (the loader's own chunk fetch) and the
    self-healing built into `threeLoaderModules` stopped one layer short of the caller. Evict on
    rejection only, identity-checked, so a successful entry still dedupes.
  - **And do not memoise the REJECTION.** A failed chunk fetch stored in the memo leaves every
    later load rejecting for the life of the page, recoverable only by a reload. Each accessor
    clears its slot in a `.catch` — the rule `textureResolver`'s texture cache already states.
  - **It also moved every loader call in the TEST suite behind an await, and a fixed task hop is
    not a wait.** `.load()` used to run synchronously; it now lands after the on-demand import
    resolves, so tests grew a `flushLoaderImport()` — one `setTimeout(0)`, which drains microtask
    chains but NOT a real I/O hop. `vi.resetModules()` per test forces a genuine re-resolve of
    `GLTFLoader.js`, and on the Windows CI leg that outran the hop: two tests that park hanging
    loads on a `GLTFLoader.prototype` spy restored the spy early, and their 7 pending `.load`
    calls landed on the NEXT test's spy — `expected 8 to be 1`, on a docs-only commit
    (`32458507466`). The tests now `await waitForLoaderImport()`, which waits on
    `makeGltfLoader()` itself and then flushes. **Deliberately count-free**: waiting for "N calls
    to land" reintroduces the bug the moment a test grows an N+1th load, and it lets a `toBe(1)`
    assertion pass with a second load still in flight — both reproduced before choosing this
    shape. ⚠️ **Wait on `makeGltfLoader()`, not on `gltfLoaderCtor()`** — the first attempt did
    the latter and went red on the very next `npm run verify`: `makeGltfLoader` is
    `Promise.all([gltfLoaderCtor(), meshoptDecoder()])`, TWO independent on-demand imports, and
    the second can land after the first. It hid from a perturbation that delayed every accessor
    by the SAME amount (symmetric delays resolve in one microtask batch) and only showed up once
    the meshopt import was delayed *more* than the GLTF one. Wait on exactly what the code
    awaits. Same caveat one layer up: if that chain ever grows a timer, this needs a real
    condition again.
    ⚠️ Do NOT dry these up into a shared `lazyOnce(() => import(…))`: that captures the
    `import()` in a module-scope arrow Rolldown can no longer prove unreachable, the gate stops
    folding, and every chunk comes back. The repetition buys the DCE.
  - **The knock-on is that `getKTX2Loader()` and `setActiveRenderer()` are async.** That was
    affordable only because every KTX2 call site was already behind `ensureKtx2Caps()` — a property
    `ktx2CapsGuard.test.ts` enforces. The ordering inside `setActiveRenderer` is unchanged
    (detect → register); it is deferred, not reordered.

- **A toggle that removes nothing is worse than no toggle — `npr` and `gpuParticles` were DELETED,
  not wired** (#256, 2026-08-19). Both were resolved by `resolveModules`, given dedicated ride-along
  logic in `detectModules`, emitted as `__MODOKI_MODULE_NPR__` / `__MODOKI_MODULE_GPU_PARTICLES__`
  defines, and offered to the owner as Auto | On | Off rows — and **no source file ever branched on
  either define**. Setting `npr: false` shipped the outline pass unchanged, reported nothing, and
  looked exactly like a working switch. This is CLAUDE.md's "every field you expose must be READ"
  applied to a build setting instead of a prefab field: an unwired field is a lie with a tooltip.
  - **Measured before deciding** (`demos/particle-demo`, `--target web`, 3,785,929 B of JS baseline),
    because "wire it" and "delete it" are both defensible until you know the number. Writing the real
    gate for `gpuParticles` (a flag check in `gpuEligible` + the router's `new GpuComputeBackend()`
    behind the flag) removed **16.7 KB minified / 4.8 KB gzip** — `Scene3D` 80.3 → 63.9 KB. For `npr`
    the *upper bound* — emptying the NPR-only modules outright, more than any real gate could remove —
    was **3.2 KB minified / ~1 KB gzip**.
  - **Neither drops an SDK.** `three.webgpu` moved 8 bytes and `three.tsl` 45: both features live
    inside the `Scene3D` chunk that only exists when `render3d` is already on, and the CPU TSL particle
    backend pulls the same TSL surface the GPU one does. So the win is each feature's own code, against
    a floor of 178 KB gzipped of `three.webgpu`. **Do not re-propose these toggles** on the intuition
    that a compute backend "must be big" — it was measured, and it is 4.8 KB.
  - **Deleting a key needs no migration.** `project.config.json` files in the wild (published demo repos
    included) still carry `"npr": "auto"`; `project-config.ts`'s `modules: { ...d.build.modules,
    ...p.build?.modules }` spread carries an unknown key through inertly and `resolveModules` iterates
    `MODULE_KEYS`, so it is ignored rather than rejected.
  - **The inverse defect was in the same panel**: `video` — a fully-wired module with 8 consumers, and
    the only one carrying a *media* payload (`video: false` on `demos/video-demo` cuts the dist from
    8,684 → 5,920 KB, ~2.7 MB, against just 6.1 KB of JS) — had **no row at all**, reachable only by
    hand-editing JSON. It was added when the dead two came out. A module surface can lie in both
    directions; check the panel against `MODULE_KEYS`, not against itself.

- **Single chunk = `inlineDynamicImports`, NOT `codeSplitting`.** `codeSplitting` is not a real Rollup
  option — Rollup silently ignores it, the lazy renderer chunk stays split, and the inliner's stray-JS
  guard aborts every 3D-game playable. Only `inlineDynamicImports:true` folds dynamic imports into the entry.
- **A playable never runs the boot ramp probe** (#221) — `main.tsx` sets
  `setBootProbeAllowed(!__MODOKI_PLAYABLE__)` at module scope, and `tierResolve` refuses on BOTH its
  probe call sites. It is not covered by "one config ⇒ no probe": that short-circuit needs the
  project to have authored exactly one tier config (the default is two), and the measure-and-log
  EVIDENCE path ignores it entirely — so a playable exported from any of the ten projects shipping
  `build.debugBuild: true` used to pay **1.6-1.8 s of blocked launch** to log a verdict it discarded.
  Every cheaper layer (player pin, project pin, single-config, iOS model table, GPU identity) still
  answers; unrecognised hardware starts `calibrating` and the live loop corrects it in seconds.
  ⚠️ Set it SYNCHRONOUSLY in `main.tsx`, never from `bootPlayable` — that arrives via a dynamic
  import and the tier is resolved without waiting for it. Guarded by
  `tests/architecture/playableSkipsProbe.test.ts`, because no unit test can see that wiring.
- **You cannot `grep` the artifact.** The payload is gzip+base64 inside the bootstrap — plaintext search
  finds nothing (two false "no audio inlined" diagnoses came from this). Decompress it to inspect (see
  `smoke-playable.mjs` / the `inlinePlayable.test.ts` round-trip).
- **`String.replace(x, str)` `$`-corruption.** The replacement STRING (especially the minified `fflate`
  UMD, full of `$` idents) has `$&`/`$1`/`` $` `` treated as substitution patterns → corrupted JS →
  "Invalid regular expression flags" at load, dead fflate fallback. Use **function replacers** (`() => str`).
- **`DecompressionStream` isn't universal** (iOS < 16.4 / old Android WebView) — the bootstrap inlines
  `fflate.gunzipSync` as a feature-detected fallback and wraps in try/catch (surfaces `data-playable-error`
  instead of a silent blank).
- **Audio must never auto-play.** The browser's autoplay policy is NOT a reliable "wait for a tap" gate
  (a `file://` open or lenient webview starts the AudioContext with no gesture). Unmute is gated on
  viewable **AND** the first `pointerdown`/`touchstart`/`keydown`.
- **Stream audio is unreliable in ad webviews.** A `stream` clip plays via `HTMLMediaElement`, whose
  gesture-gated `play()` + `resume()` re-kick is flaky (Android WebView: music stayed silent until a full
  reload). Playable builds force **`loadType:'buffer'`** for every clip (decodeAudioData → the same path
  the SFX use) — the source `.meta.json` is untouched, so the real game still streams.
- **KTX2 needs a transcoder the profile skips.** The WebP-only profile drops the Basis/pixi-ktx
  transcoders, so rigged/skeletal GLBs and sprite-atlas pages MUST also take the playable WebP override
  or they bake KTX2 (`KHR_texture_basisu`) with no transcoder → black textures offline.
- **PixiJS 2D textures need a FORCED parser for `blob:` URLs.** Pixi v8 picks its texture loadParser by
  EXTENSION (`loadTextures.test` → `checkExtension` → `path.extname`, which strips BOTH `?query` and
  `#hash` — a URL hint can't smuggle it in), and an inlined asset is an extension-less `blob:` URL → "we
  don't know how to parse it" → the 2D render callback reads a null texture, frameDriver kills `render2d`,
  the whole game renders blank. All Pixi loads go through **`loadPixiTexture`** (`runtime/rendering/`),
  which forces `Assets.load({src, parser:'texture'})` for `blob:` URLs (playable textures are always
  browser-decodable — WebP/PNG, never KTX2). 3D is unaffected (THREE uses explicit loaders).
- **`file://` blob loads must decode on the MAIN thread.** Opening the built `ads/index.html` straight
  from Finder (the "reveal ads/" step invites it) is a `file://` NULL origin → the inlined assets become
  `blob:null/…` URLs, and Pixi's default texture **worker** cannot `fetch` a null-origin blob ("Failed to
  fetch") even though the same blob fetches fine on the main thread (so http:// served fine, the
  double-click didn't). `loadPixiTexture` calls `Assets.setPreferences({preferWorkers:false})` once before
  the first blob load.
- **ISOLATE the game + overlay stacking, or the container's chrome hides behind you.** An ad container
  (verified against AppLovin's preview) appends its OWN UI to the creative's `<body>` at `z-index:auto` —
  its close/info button AND its "You have successfully clicked" confirmation. The engine layers renderers
  with z-index (the 2D Canvas host is `position:absolute; z-index:2`) and the CTA overlay used a near-max
  z-index; since `#root` isn't positioned, those LEAK into the `<body>` stacking context and paint over the
  container's chrome — so `mraid.open` fires but its confirmation (and, on a real device, the close button)
  is invisible. `bootPlayable` sets **`isolation:isolate`** on `#root` and the overlay host, collapsing each
  to one `z-auto` `<body>` layer under the container's chrome. Internal 3D<2D<UI ordering is unchanged.
- **Dead SDK / debug weight.** A game's `@<game>/app-services` (AppLovin/Adjust/Firebase) and the
  debug/MCP bridge are inlined into the one chunk unless explicitly cut — the app-services package is
  aliased to a no-op stub, and the bridge import is `!__MODOKI_PLAYABLE__`-gated, so both DCE out.
  ⚠️ **That alias means the stub must export EVERY name a game imports from its app-services
  package, and a missing one fails the build rather than degrading.** Rollup reports
  `[MISSING_EXPORT] "track" is not exported by ".../playable-appservices-stub.ts"` — and only on
  `--target playable`, which no routine gate runs, so the web build, the native build and the
  whole test suite stay green while this target is dead. That is exactly how it broke when
  `games/court` added `track`/`setTrackProperty` (#269). `engine/tests/architecture/playableAppServicesStub.test.ts`
  derives the required set from the games' own imports, so a hand-kept list cannot go stale;
  it also covers `import('@<game>/app-services').then((m) => m.foo())`, which Rollup does NOT
  catch at build time — that one fails at runtime, inside the ad.
- **The editor renders two Canvas2D canvases** (GameView + SceneView UI-preview), so a game that maps
  raw `window` pointer events to design space must pick the canvas UNDER the pointer
  (`@modoki/engine/runtime` `hostCanvasUnder`), not `querySelector`'s first match.

## Testing

- **`npm run smoke:playable`** — builds the `space-invader` artifact and drives it in headless Chromium:
  self-extract, WebGL render, the `fflate` fallback, no-autoplay + unmute-on-tap, the MRAID viewable gate,
  `mraid.open` CTA, and orientation reflow. Keep it in the loop for changes under `inlinePlayable.ts`,
  `app/playable/**`, or the `VITE_PLAYABLE` path in `vite.config.ts` — it has caught bugs the unit suite missed.
- **Unit:** `inlinePlayable.test.ts`, `bootPlayable.test.tsx`, `mraid.test.ts`, `playableOverlay.test.tsx`,
  `hostCanvas.test.tsx`, `audioCueRetry.test.ts`.
- **On device:** upload `index.html` to the AppLovin preview at **https://p.applov.in/playablePreview?create=1**
  (the `?create=1` query is required — the bare path doesn't show the upload flow), or serve `ads/` over the
  LAN and open it in the device browser (a good render/audio/touch proxy; no MRAID container → standalone path).

## Deferred — per-network adapters (gated on demand)

Only `applovin` is wired today (`build.playableNetwork`). Full per-network coverage — `installClick()`
adapters for ironSource / Meta (`FbPlayableAd`) / TikTok (`dapi`) / Pangle, plus the ZIP packagers each
SDK wants — is deliberately deferred until a campaign actually targets those networks.

## Related

- [audio-plan.md](./audio-plan.md) — the audio subsystem (`AudioSource`, cue bus, buffer/stream fork)
- [textures.md](./textures.md) · [model-pipeline.md](./model-pipeline.md) — the asset conversion the profile overrides
- [build.md](./build.md) — the `MODOKI_PROJECT` build pipeline this rides on
