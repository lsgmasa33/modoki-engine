# Playable-ad export

A `VITE_PLAYABLE=1` build that collapses one game into a single self-contained `index.html`
(≤ `build.playableMaxBytes`, default 5 MB) for ad networks (AppLovin/ironSource) — fully **offline**
(no network), loaded in a strict ad webview, gated by an injected `window.mraid`. Trigger it from the
editor's **Build → Playable Ad**, or `MODOKI_PROJECT=games/<id> VITE_PLAYABLE=1 npm run build` →
`games/<id>/ads/index.html`. (Grew out of the `advideo-playable-export-plan` tracker, now landed.)

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

A build can include/exclude the heavy engine SDKs (three.js, PixiJS, Rapier 2D/3D, NPR, GPU
particles) so an unused one is dead-code-eliminated. This is a **general build feature** (it shrinks
web builds too), but its headline win is fitting a game under the playable's 5 MB ceiling. `project.config.json`
`build.modules.<key>` is `'auto' | boolean` per module (`render3d`, `render2d`, `physics2d`, `physics3d`,
`npr`, `gpuParticles`; all `'auto'` by default).

- **Resolution** (`engine/plugins/detect-modules.ts`, Node-only): `resolveModules` turns each toggle into a
  concrete boolean. `'auto'` → `detectModules` scans the project's included scene JSON for trait signals
  (`Renderable3D`/`Light`/`Camera`/`Environment`/`ModelSource` → `render3d`; `Canvas2D`/`Renderable2D`/`Sprite`
  → `render2d`; `RigidBody2D`/`Collider2D` → `physics2d`; `layer:'3d'|'2d'` on `EntityAttributes`; NPR +
  GPU-particles ride along with `render3d`). Broad on purpose — a false-positive just ships an unused SDK
  (safe); a false-negative is loud (a build-time warn + the guard below). An explicit `true`/`false` forces
  it and logs a warning if `false` contradicts a used module.
- **Wiring**: the resolved booleans become `__MODOKI_MODULE_RENDER3D__` / `…_RENDER2D__` / … Vite defines
  (`vite.config.ts`), which flag-gate the renderers' lazy imports in `App.tsx` (`Scene3D`/`Game`) so Rolldown
  DCEs the excluded SDK — the same mechanism the debug menu + journal use.
- **UI**: **Project Settings → Rendering & Physics → Engine Modules** — a tri-state **Auto | On | Off** per
  module (`ModuleTogglesEditor`, the `'module-toggles'` field), persisted through `/api/project-settings`.

## Gotchas (the load-bearing, hard-won ones)

- **Single chunk = `inlineDynamicImports`, NOT `codeSplitting`.** `codeSplitting` is not a real Rollup
  option — Rollup silently ignores it, the lazy renderer chunk stays split, and the inliner's stray-JS
  guard aborts every 3D-game playable. Only `inlineDynamicImports:true` folds dynamic imports into the entry.
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
