# Texture Pipeline

Unity-style per-texture import: a source PNG/JPG is converted into
GPU-optimized variants (KTX2 for 3D, WebP for 2D), with settings living in the
texture's `.meta.json` sidecar. See also [Architecture](./architecture.md),
[Rendering](./rendering.md), and the [Model Import & LOD](./model-pipeline.md)
pipeline.

## Prerequisite

The **KTX-Software CLI** (`toktx`) must be on `PATH` for KTX2 encoding. It is
**not in Homebrew** — install the macOS package from the
[KhronosGroup/KTX-Software releases](https://github.com/KhronosGroup/KTX-Software/releases)
(`toktx` + `ktx` land in `/usr/local/bin`). `ensureKtxCli()` probes `toktx
--version` and throws a clear install hint when it's missing; without it,
conversion falls back to shipping the source PNG and the build logs a hint.

`sharp` (an npm devDependency) handles the WebP encode + resize — no external
install needed.

The dev/CLI path resolves the binary via `toktxBinary()` in
`plugins/texture-convert.ts`: an explicit `MODOKI_TOKTX` path wins, else the bare
name `toktx` (resolved on `PATH`).

### Bundling `toktx` in the packaged editor

The packaged Electron editor has no `PATH` guarantee, so the KTX CLI is bundled
into the app bundle (macOS-only — the only signed target today):

- **`engine/scripts/stage-toktx.cjs`** is electron-builder's `beforePack` hook. It
  copies `toktx` + its one non-system dependency (`libktx.4.dylib`) into
  `build/bin/`, `chmod +x`es both, and sanity-runs the staged copy (`toktx
  --version`) to confirm the sibling dylib resolves. `toktx` already carries an
  `@executable_path` rpath, so `libktx` resolves next to it with no
  `install_name_tool` surgery. The hook resolves its own source binary via
  `MODOKI_TOKTX` → `which toktx` → `/usr/local/bin/toktx`.
- **`electron-builder.yml`** ships `build/bin` as `extraResources` →
  `Contents/Resources/bin`. The signing pass signs both binaries; the
  `disable-library-validation` entitlement lets `toktx` load the sibling `libktx`
  under the hardened runtime.
- **`engine/electron/main.ts`** (`app.isPackaged`) points
  `process.env.MODOKI_TOKTX` at `<resourcesPath>/bin/toktx` when the env isn't
  already set, so `toktxBinary()` picks up the bundled copy.
- **Graceful degradation**: if `toktx`/`libktx` aren't installed on the *build*
  machine, the hook logs a warning and skips — the packaged app then falls back to
  shipping source textures, exactly as a dev build without `toktx` does.

## Per-texture settings

Settings live in the texture's `.meta.json` sidecar (`texture` block), edited
via the Texture Inspector (`TextureAssetView` in `editor/panels/assetViews/TextureAssetView.tsx`, rendered by `Inspector.tsx`). The schema is
`TextureImportSettings` in `runtime/loaders/textureSettings.ts`:

| field | type | notes |
|-------|------|-------|
| `format` | `'ktx2-uastc' \| 'ktx2-etc1s' \| 'ktx2-astc' \| 'webp' \| 'png'` | output target |
| `maxSize` | `256 \| 512 \| 1024 \| 2048 \| 4096` | longest-edge cap (downscale only) |
| `mipmaps` | `boolean` | bake mip levels |
| `wrapS` / `wrapT` | `'repeat' \| 'clamp' \| 'mirror'` | wrap mode |
| `colorspace` | `'srgb' \| 'linear'` | `srgb` = color map, `linear` = data/normal |
| `flipY` | `boolean?` | bake a vertical flip into every variant (needed because `Texture.flipY` is ignored for compressed KTX2). Default false |
| `flipGreen` | `boolean?` | invert green (tangent-space Y) — OpenGL↔DirectX normal-map convention. Default false |
| `webpQuality` | `number?` | WebP encode quality 1–100 (the `webp` format or a `2d`/`ui` KTX2 texture's browser sibling). Default 80 |
| `uastcLevel` | `number?` | UASTC quality level 0–4 (`--uastc`) for the `uastc` variant. Default 2 |
| `uastcRdoLambda` | `number?` | UASTC RDO lambda (`--uastc_rdo_l`); higher = smaller, 0 = off. Default 1.0 |

`DEFAULT_TEXTURE_SETTINGS`: `format: 'ktx2-uastc'`, `maxSize: 2048`, `mipmaps:
true`, `wrapS/wrapT: 'repeat'`, `colorspace: 'srgb'` (the optional knobs above
are unset).

The authored **`TextureType`** (`'3d' | '2d' | 'ui'`) is the source-of-truth an
artist edits; `deriveSettingsForType(type, overrides?)` maps it to the codec /
mipmap / wrap defaults the conversion + cache layers consume (`3d` → KTX2-UASTC,
mipmapped, repeat; `2d` → KTX2-UASTC, no mips, clamp; `ui` → WebP, no mips,
clamp — CSS/DOM can't decode KTX2), and drives whether a WebP browser sibling is
emitted. Explicit per-field `overrides` (the inspector's Advanced section, the
2D WebP-vs-KTX2 toggle) win.

**Format guide:**

- `ktx2-uastc` (default) — UASTC+RDO+Zstd; high quality, cheap transcode to
  ASTC/BC7 at load.
- `ktx2-etc1s` — smaller download (ETC1S/BasisLZ).
- `ktx2-astc` — native ASTC, zero-transcode override for hot textures. Emits
  both `astc` and a universal `uastc` sibling for GPUs without ASTC support.
- `webp` / `png` — the 2D/UI formats (browser-decodable for DOM/Canvas/PixiJS).

`variantsForFormat(format)` maps a format to its derived files:
`ktx2-uastc → [uastc]`, `ktx2-etc1s → [etc1s]`, `ktx2-astc → [astc, uastc]`,
`webp → [webp]`, `png → [png]`.

## Conversion

Conversion runs in Node (dev server + `vite build`) via `execFileSync`, driven
by `convertTexture()` in `plugins/texture-convert.ts`:

1. `sharp` downscales the source to fit `maxSize` (never upscales), preserving
   aspect, then **snaps each axis to a multiple of 4** (Lanczos3, normalized to
   PNG so the KTX encoder reads a known format).
2. For each variant:
   - **KTX2** (`uastc` / `etc1s` / `astc`) → `toktx` via `buildToktxArgs()`,
     which emits `--t2`, `--genmipmap --filter lanczos4` (when mipmaps on),
     `--assign_oetf srgb|linear`, then per-variant flags:
     - `uastc`: `--uastc 2 --uastc_rdo_l 1.0 --zcmp 18`
     - `etc1s`: `--bcmp --clevel 4 --qlevel 128`
     - `astc`: `--encode astc --astc_blk_d 4x4 --astc_quality thorough`
   - **WebP** → `sharp(...).webp({ quality: 80, effort: 4 })`.
   - **PNG** → the resized buffer, written as-is.

Conversion is triggered by the Inspector **Apply** or the Assets panel
**Re-import all**, both routed through the per-asset-type handler registry in
`plugins/reimport-registry.ts` (the `texture` handler is
`reimport-texture.ts`).

Post-conversion stats (`width`, `height`, `mipLevels`, `variantBytes`) are
read back from the produced files and persisted to the `.meta.json`
`textureCache` block (`TextureCacheInfo`) for display in the Inspector.

## Reimport dispatch

Textures aren't the only asset with a source → derived-files step, so the
per-type handling is generic. `plugins/reimport-registry.ts` holds a
`Map<type, ReimportHandler>`: each asset type calls `registerReimportHandler(type,
handler)` and the `/api/reimport` endpoint walks a file or folder (recursively),
dispatching per detected type. A `ReimportHandler` is `(sourceUrlPath, absPath,
ctx) => Promise<void>`; the `ReimportContext` carries `projectRoot`,
`resolveAssetPath`, an optional `ssrLoadModule` (dev-server SSR loader, undefined
on the build path), `enginePkgSrc` (build-time absolute engine source root), and
`listAssets` (the project-wide asset index — the atlas handler is the first
reimport that resolves *other* assets' GUIDs).

**Live refresh (no restart).** After a successful bake, `/api/reimport` pushes the
freshly-baked `model`/`texture` paths to the renderer via `requestBrowser(
'invalidate-assets', …)` (the M→R channel — Vite HMR socket in dev, Electron IPC
when packaged). The `invalidate-assets` agent op (`app/debug/agentBridge.ts`) calls
`invalidateModel` / `invalidateTexture`, which evict the path-keyed GPU caches and
fire `onModelInvalidated` → `scene3DSync` drops the live meshes so the next frame
re-instantiates the new variant. So an MCP `modoki_reimport_asset` or a bare
`curl /api/reimport` now refreshes the **live** viewport with **no editor restart**
— identical to the Assets-panel "Re-import" button (which also invalidates
client-side in `assetViews/reimport.ts`; the two paths are idempotent). One caveat:
the offscreen `render_scene` renders the live scene graph without forcing a sync, so
a `render_scene` issued in the *same tick* as the reimport can catch the one frame
where meshes are evicted-but-not-yet-rebuilt — it self-heals on the next frame
(render again). Best-effort: a disconnected/headless renderer just times out; the
bake is on disk regardless, so a later scene load still picks it up.

Both the dev server (`vite-asset-scanner.ts` `configResolved`) and the packaged
editor (`engine/electron/main.ts` at startup) register the same seven handlers so
`/api/reimport` has them in either host: `texture`, `model`, `atlas`, `audio`,
`video`, `font`, `environment`. `getReimportTypes()` exposes the
set over `GET /api/reimport-types`, so the editor derives its "what can be
re-imported" menu from the live server registry instead of a hardcoded client
constant — a newly-registered handler surfaces without a client edit.

## Local-only cache

`plugins/texture-cache.ts` is content-addressed under the project's own
`.cache/modoki-textures/<urlPath>/<hash>/<variant>.<ext>` (`getCacheDir()` =
`<projectRoot>/.cache/modoki-textures` — project-root, not `node_modules/.cache`,
so a flat one-game project with no `node_modules` of its own still gets a
writable cache). The hash
(`hashKey()`) mixes source bytes + settings + `ENCODER_VERSION` (`'tex-2'`), so
an unchanged texture is never re-encoded and a settings change invalidates only
that texture. `cacheHit()` is true when every variant the format produces
already exists for the hash.

Derived files are **LOCAL-ONLY and gitignored**. `vite build` regenerates the
variants into `dist/` and **drops the source PNG**; per-texture settings are
baked into the dist `assets.manifest.json` so the runtime resolves variant URLs
without a per-file fetch.

## Committed vs machine-local sidecar fields

`plugins/meta-sidecar.ts` (`readMetaSidecar`/`writeMetaSidecar`, used by every
asset type's `.meta.json`, not just textures) splits each write into two files:
the committed `<asset>.meta.json` and a gitignored `<asset>.meta.local.json`
sibling holding this host's regenerated values, merged back on read (local
wins). What's committed: the GUID, import **settings** (the `texture`/`model`/
`font`/... block an editor authors), and the STRUCTURAL cache fields the
runtime/build actually consume (`lodPaths`, `lodDistances`, `variants`, `width`/
`height`, `glyphCount`, ...) — these are stable across a shared provisioned
toolchain. What's NOT committed: the volatile byte-SIZE stats
(`variantBytes`/`lodBytes`/`triCounts`/`bytes` — Inspector-display only, a
native encoder like `toktx`/`msdf-atlas-gen`/`ffmpeg` emits a slightly
different-sized file per host from identical input) and, as of #127,
**`modelCache.hash`** specifically. That hash is machine-dependent BY
CONSTRUCTION, not merely volatile: `hashKey()` (`plugins/model-cache.ts`) mixes
in local gltfpack/gltf-transform/meshopt CLI versions, and `riggedHash`
(`plugins/rigged-model-optimize.ts`) additionally encodes whether `toktx`
exists on PATH at all — a manual, per-machine install. With four+ clones the
hash never converges: each rewrites it back on its own next build (measured:
commit 471ca0cf's entire GLB-sidecar diff was 7 `"hash"` lines and nothing
else). The other cache blocks' hashes (`textureCache.hash`, `fontCache.hash`,
...) stay committed — they mix only source bytes + settings + an in-repo
encoder version, so they ARE reproducible across machines.

A fresh checkout has no `.meta.local.json` (gitignored), so it self-heals for
free: the serving path already treats a missing/stale model hash as a cache
miss and re-bakes (`autoBakeThenServe`, `plugins/backend/staticAssets.ts`,
written for the same "fresh checkout, no local cache" case). Existing
committed sidecars with a stale `modelCache.hash` are cleaned up by
`engine/scripts/migrate-meta-sidecars.mjs`, which round-trips every tracked
`.meta.json` through the real read/write functions; `engine/tests/assets/
metaSidecarChurn.test.ts` guards against a regression re-introducing one.

### Reproducible is not the same as up to date (#161)

`textureCache.hash` being pure buys nothing if the committed value was written under *different*
settings and never regenerated. That is the failure this section did not anticipate: a `maxSize`
reduction pass over `games/sling` left all 25 of its texture sidecars recording an artifact the
pipeline had stopped producing — one of them claiming `2048×2048 / 12 mips` under a `maxSize: 512`
block three lines above it.

Nothing caught it, because a `textureCache` record is only ever consulted as a **cache key**: a
wrong one costs a re-encode, never a failure. It surfaces instead as **tree churn** — opening the
project serves the textures, misses the cache on the stale hash, auto-bakes
(`autoBakeThenServe`), and rewrites the sidecars. That is the worst place for it to show up: a tree
that is dirty before you have typed anything is what makes `git diff -- games/ demos/` — the manual
stand-in for #18's declined pre-commit hook — stop being a signal, so a genuine stray edit rides
along unnoticed.

The guard is in the same file (`metaSidecarChurn.test.ts`) and is **exact, not heuristic**,
precisely because the hash is pure: it recomputes every tracked texture sidecar's hash from the
committed source bytes + the committed settings and fails on a mismatch, naming the file and both
values. It subsumes the dimension case — a record cannot be stale in its `width`/`mipLevels` while
its hash still reproduces. Measured at 211 sidecars in ~220 ms, and it imports `hashKey` /
`resolveTextureSettings` rather than restating them, so an `ENCODER_VERSION` bump or a new key
ingredient cannot leave it checking a formula the pipeline no longer uses.

The fix when it fires is always the same: reimport the named assets (editor, or
`POST /api/reimport {path, recursive:true}`) and commit the sidecars.

## Sprite atlas packing

An `.atlas.json` names an explicit set of member sprite GUIDs (Phase-1 slices
carved from one or more source textures); re-packing relocates each member's
pixels onto one or a few generated **pages** so they share a single base texture —
the prerequisite for PixiJS `ParticleContainer` batching and a 2D draw-call win.
The authored source (`AtlasSource` — `id`, `members`, `pageSize`, `padding`,
`extrude`, optional `maxPages`/`texture`) is committed; all derived bookkeeping
lives in the `.meta.json` sidecar's `atlasCache` block, never in the source.

- **Packer (pure)** — `runtime/loaders/spriteAtlas.ts` `packAtlas()` is a
  MaxRects **Best-Short-Side-Fit** bin-packer with zero THREE/DOM/sharp/Vite
  imports, so it runs in Node tooling and headless tests. Each member reserves a
  footprint of `w + 2·extrude + padding` × the same in height; the returned `rect`
  is the **inner** content rect (offset by `extrude`), so adjacent frames are
  separated by `padding + 2·extrude` and each frame owns an `extrude`-px gutter.
  Pages are trimmed to used extent, snapped up to a multiple of 4 (`ceil4`).
  Deterministic order — area desc, GUID asc, **no `Math.random`** — so the same
  members + options always produce the same layout (the content hash depends on
  it). Members larger than a page, or beyond `maxPages`, are returned in
  `overflow` (surfaced with a warning, never silently dropped).
- **Compositor (build/reimport)** — `plugins/reimport-atlas.ts`
  (`atlasReimportHandler`, registered for the `atlas` type) resolves each member
  GUID → its parent texture + slice rect via `ctx.listAssets`, runs `packAtlas`,
  then `sharp`-composites each page: it `extract`s the slice, then in a **second**
  `sharp` pass `extend`s it by `extrude` px with `extendWith: 'copy'`
  (edge-replication bleed — chaining extract+extend in one pipeline mis-orders the
  ops), and composites at `(rect.x − extrude, rect.y − extrude)`. Each page PNG is
  encoded through **`convertTexture`** into the shared texture cache under a
  synthetic per-page url path (`atlasPageUrlPath` = `<atlasUrl>~page<N>`), so pages
  reuse the whole texture-cache/variant-serving machinery unchanged. Pages default
  to **WebP** (2D, no mipmaps — mips would cross-bleed between frames beyond the
  extrude gutter — clamp wrap), with a `maxSize` forced ≥ `pageSize` so the
  converter never downscales a page and shifts every frame rect.
- **Cache gate** — `plugins/atlas-cache.ts` `atlasHashKey()` is a stable 16-hex
  key over every member's source **bytes** + slice rect/pivot + the pack options +
  `ATLAS_ENCODER_VERSION` (`'atlas-1'`), members sorted by GUID so reordering
  doesn't churn. The handler skips the whole pack when the atlas hash is unchanged
  **and** every page variant is still cached (`cacheHit` over the `'2d'` variant
  set). The written `atlasCache` block records `hash`, per-page `{hash, variants,
  w, h}`, the page `texture` settings, and a `frames` map (member GUID → `{page,
  rect, pivot}`) the runtime resolver indexes.

## Runtime resolution

`runtime/loaders/textureResolver.ts` picks the best variant for the call site +
GPU:

- `selectVariant(settings, usage, caps)` chooses — for `3d`, native-ASTC
  `.ktx2` when the GPU supports ASTC (`caps.astc`) else universal UASTC; for
  `2d`, the same universal KTX2 variant (`ktx2-uastc`/`ktx2-astc` → `uastc`,
  `ktx2-etc1s` → `etc1s`) or `webp`/`png` when authored that way. Both usages
  now serve KTX2 — PixiJS registers its own KTX2/Basis transcoder for the 2D
  path — so `selectVariant` **never returns `null`** (every format produces a
  variant for both usages).
- `resolveTextureVariantUrl(ref, usage)` resolves the ref → served variant URL
  (or the source URL when unconverted). The deterministic suffix is
  `variantSuffix(v)` = `~<variant>.<ext>` (e.g. `rock.png~uastc.ktx2`).
- `loadTexture3D(ref, { flipY })` loads KTX2 via a singleton `KTX2Loader`
  (transcodes UASTC→ASTC/BC7; native ASTC uploads with no transcode) or the raw
  source via `THREE.TextureLoader`, then applies wrap / colorspace / mipmaps.

`setActiveRenderer(renderer)` must be called after `renderer.init()` (both at
renderer creation and in the editor SceneView) so `KTX2Loader.detectSupport()`
can read GPU formats — otherwise the first ASTC-variant load throws "Missing
initialization with .detectSupport()". This dependency is **narrower than a
whole scene load**: it only gates the three-side call sites that actually
touch `KTX2Loader` (`loadTexture3D`, rigged-GLB loading, 2D-skinning billboard
pages), each via `ensureKtx2Caps()` (`runtime/loaders/textureResolver.ts`).
`ensureKtx2Caps()` resolves immediately once a real viewport registers a
renderer; if none ever does, it stands up a throwaway probe renderer after a
short delay, runs `detectSupport` on it, and disposes it. The editor's scene
load itself does **not** wait on any of this (it once did — a `rendererReady`
gate before `loadScene()` — which is why a layout with no 3D viewport used to
fail the scene load outright on a 2D-only project; see
[Editor](./editor.md#createeditor--host-configuration)).

`invalidateTexture(ref)` evicts the cached bytes for every variant from
`THREE.Cache` so a re-import re-fetches the freshly-converted files.

### 2D KTX2 sprites (PixiJS)

The 2D path decodes `.ktx2` sprites/atlas-pages through PixiJS's own KTX2 parser,
not `KTX2Loader` — so 2D has **zero** dependency on `detectSupport`/GPU caps:
`selectVariant(settings, '2d', caps)` ignores the `caps` argument entirely (the
ASTC capability only affects the `'3d'` branch), and `ensureKtx2Caps()` above is
never on a 2D/UI-only project's load path. `runtime/loaders/pixiKtxTranscoder.ts`
`ensurePixiKtxTranscoder()` (idempotent, called during 2D startup by
`Scene2D.tsx` and `pixiParticleBackend.ts`) does two things PixiJS v8 does **not**
do on its own:

1. `extensions.add(loadKTX2)` — v8's umbrella `pixi.js` import does **not**
   auto-register the `loadKTX2` parser, so without this
   `Assets.load('…~uastc.ktx2')` fails with *"we don't know how to parse it"*.
2. `setKTXTranscoderPath({ jsUrl, wasmUrl })` redirects libktx from PixiJS's
   default **jsdelivr CDN** to a **locally-served** `/pixi-ktx/{libktx.js,
   libktx.wasm}`, so 2D KTX2 sprites decode **offline** and in the packaged
   Electron editor (no network guarantee).

`/pixi-ktx/*` is served in dev by the backend static-asset handler
(`plugins/backend/staticAssets.ts`, from `node_modules/pixi.js/transcoders/ktx`,
project-root-then-editor fallback) and copied into `dist/pixi-ktx/` at build time
by `shipPixiKtxTranscoder()` in `vite-asset-scanner.ts` — mirroring how the
three.js Basis transcoder is provided at `/basis/` for the 3D KTX2 path.

## Texture LOD by quality tier (#212)

Textures are 67% of a shipped build (measured on `demos/postfx-demo`: 21.8 MB of KTX2 in a
32.4 MB dist). Everything above this section is format-aware (KTX2 vs WebP) but **size-blind** —
a `low`-tier phone downloaded the identical full-resolution texture a flagship did. This section
is the orthogonal axis: it never touches codec/format selection (`selectVariant`), only how many
pixels a device downloads and uploads.

- **Authored**: a project's `rendering.three.tiers.{mid,low}.textureMaxSize`
  (`TierRenderOverrides.textureMaxSize` — `runtime/rendering/qualityTier.ts`, docs/rendering.md §
  "Quality tiers"). **0 = no cap.** Seeded `low: 512`, `mid: 1024` alongside every other tier
  knob (`engine/scripts/seed-quality-tiers.mjs`).
- **Build** (`vite-asset-scanner.ts`, inside the same loop that runs the primary
  `convertTexture()` pass): reads the project's DISTINCT non-zero authored caps, and for each one
  strictly below the texture's own `maxSize` **and** below its source's longest edge, runs
  `convertTexture()` again with that cap as `maxSize` — reusing the converter's existing
  downscale-then-encode path, not a second resizer. `sizesToEmit(caps, maxSize, srcWidth,
  srcHeight)` (`runtime/loaders/textureSettings.ts`) is the pure decision behind "strictly
  below both": a cap that cannot shrink the texture further emits nothing, so a texture already
  smaller than every authored cap costs zero extra files, and a project that authors no tiers
  gets a byte-identical build. The caps actually emitted are baked onto the manifest as
  `texture.sizes: number[]` (`AssetManifestEntry.texture`, `assetManifest.ts`) — the runtime
  never guesses a size that wasn't built.
- ⭐ **WHEN they are emitted — `build.textureTierVariants`, owner decision 2026-08-14.** Every size
  ships INSIDE the package, so the +19% install-size cost (`demos/postfx-demo` 32,428 → 38,736 KB)
  is paid by nobody on a wire delivery — the device downloads only the variant it picks — and is
  pure growth for an APK/IPA where every size is already on disk. So `'auto'` (the default) emits
  only when the payload travels over the wire, `'always'` is the native opt-IN, `'never'` forces
  it off. One predicate, `shouldEmitTextureTierVariants` (`engine/plugins/textureTierEmit.ts`);
  the scanner calls it once and must not re-derive the condition inline.

  ⚠️ **"Over the wire" is NOT `--target web`, and that trap is the reason the predicate exists:
  an OTA publish builds with `--target native`** and must (an OTA bundle replaces the web content
  INSIDE an installed app, so it is served from the app root, never the web sub-path — #40). It is
  wire delivery and it must emit, so the publish route layers `MODOKI_OTA_PUBLISH=1` onto its build
  step (`otaPublishBuildStepEnv`) and the predicate reads that as well as `MODOKI_BUILD_TARGET`.
  A **playable** build never emits regardless of mode — `playableTextureSettings` already clamps
  every texture to ≤512, so a second size axis is waste, and `'always'` does not override it.

  Measured on `demos/postfx-demo`, same tree: `--target web` → 21 `@512` files, 21 `sizes` entries,
  dist 39,384 KB; `--target native` → **0** files, **0** `sizes` entries, dist 33,828 KB. The
  5,556 KB difference is exactly the capped-variant payload measured on device, which is the
  cross-check that the gate drops the right bytes and nothing else.

- **URL**: `variantSuffix(v, sizeCap?)` appends `@<size>` before the extension —
  `rock.png~uastc.ktx2` uncapped, `rock.png~uastc@512.ktx2` at the 512 cap. Omitting `sizeCap`
  (or passing `0`) reproduces exactly today's suffix, so every asset that shipped before this
  feature exists keeps its URL byte-for-byte — no re-import needed anywhere in the fleet.
- **Runtime**: the resolved tier's `textureMaxSize` is written to `runtime/core/textureSizeCap.ts`
  — a tiny **L0** module, not the usual `runtime/core/playerTierStore.ts`-style provider slot,
  because both ends of this seam already live in the engine (`tierCalibration.ts`, L2, writes;
  `textureResolver.ts`, L3, reads) — see that module's header for why it isn't a plain import
  from `rendering/` instead (the same "no static L3→L2 edge" discipline the KTX2 caps probe
  already follows with a dynamic import). `resolveTextureVariantUrl` uses the active cap **only**
  when the texture's own baked `texture.sizes` lists it; otherwise it falls straight through to
  the uncapped URL — no tier resolved, or the manifest doesn't confirm the size, both mean
  "today's behaviour, unchanged". A texture already in flight keeps whatever variant it started
  loading; a live tier change is picked up by the NEXT load, not an in-place swap.

## Environment maps (HDR / UltraHDR)

`.hdr` classifies as asset type `environment`, gets a GUID-only `.meta.json`, and goes through the
same generic reimport/manifest/cache plumbing as every other asset type (reimport-registry, meta
sidecar, `/api/reimport` + `/api/reimport-types`, cache-miss bake, its own `EnvironmentAssetView`
Inspector panel) — the one real gap was the encoder: `toktx` can't read `.hdr` (only 16-bit int,
clamps HDR), `ktx create` doesn't do ASTC encode and can't read EXR either, and there is no
`ultrahdr` CLI. GPU-compressed HDR (ASTC-HDR) stays blocked on current tooling.

Two formats ship instead, both selectable per-asset (`EnvImportSettings.format` in
`runtime/core/environmentSettings.ts`):

- **`hdr` (default) — dependency-free downscale.** `plugins/hdr-codec.ts` decodes via three's
  `HDRLoader`, area-averages down to `maxSize` in linear radiance space, and re-encodes RGBE —
  measured **0.10% mean-luminance error**, and the real download win (2K→1K ≈ 3×, →512 ≈ 12×).
  `env-convert.ts` drives it; `env-cache.ts` content-hashes the result; served as `~env.hdr`.
- **`ultrahdr` — browser-side gainmap encode.** `@monogrid/gainmap-js` (editor-only, dynamically
  imported so it never reaches a game bundle) encodes an UltraHDR JPEG with an embedded gainmap
  (`encodeUltraHDR.ts`: HDRLoader → `findTextureMinMax` → `encodeAndCompress` →
  `encodeJPEGMetadata`, libultrahdr WASM); the committed `~ultrahdr.jpg` is written via
  `/api/write-file`. Runtime decode is `UltraHDRLoader` (already vendored). Measured on a real
  asset: 6.53 MB → 0.53 MB (**~11.7×**), ~183 ms encode, 2048×1024, 14 gainmap/XMP markers
  confirming a real embedded gainmap. Because the encode needs WebGL +
  `createImageBitmap`, it isn't auto-testable — it was live-verified via CDP in the running
  Electron editor rather than in `npm test`. `maxSize` downscale is currently `hdr`-only;
  `ultrahdr` encodes at source resolution (deferred, see below).
- The scanner's `detectType` excludes the committed `~ultrahdr.jpg` from re-classification as a
  fresh texture (it's a derived file, not a source asset) — build-gen copies the committed variant
  and drops the multi-MB HDR source; the dist verifier checks the per-format variant exists.

**Deferred follow-ups** (tracked, not scheduled):
- **KTX2 ASTC-HDR** as a second GPU-compressed HDR variant, once tooling exists to produce it.
- Persist the Environment Inspector's **exposure** slider — currently preview-local UI state, not
  saved to the asset.

## ⛔ Invalidation must never DESTROY a texture something still binds

`invalidateTexture` used to `dispose()` every matching cache entry **regardless of
`refCount`** — so an editor re-import destroyed a shared texture while live materials still
had `mat.map` pointing at it. The next encoded command buffer bound the destroyed instance and
WebGPU raised **`Destroyed texture used in a submit`** (owner-reported on a `3d-test` island
re-import). `releaseTexture3D` even documented the bypass as expected behaviour, and a unit
test asserted the force-dispose as the contract, so nothing flagged it.

**It is a use-after-free, not a timing race.** Deferring the dispose by a frame does not fix it:
the material keeps the binding until it re-resolves, so a later frame hits the same fault.

**The rule: freshness comes from RE-RESOLVING, never from freeing memory out from under a
holder.** Invalidation must do three things and no more:

1. Remove the entry from the lookup map, so the next `loadTexture3D` misses and fetches the
   re-imported bytes.
2. Announce via `emitAssetInvalidated`, so holders re-resolve.
3. **Retire** a still-referenced texture — unreachable to new lookups, still reachable to the
   refcount — and let the LAST `releaseTexture3D` free it. That release arrives through
   `meshTemplateCache.disposeMaterial` when the material rebuilds, which is what makes the
   texture and material invalidations order-independent instead of implicitly coupled.

⚠️ **Retirement is keyed by TEXTURE INSTANCE, never by cache key.** A re-load after
invalidation builds a new entry under the *same* key — the URL is unchanged in dev, since the
`?v=` cache-bust only moves when the content hash does — so a key-keyed map lets a stale release
decrement the NEW entry and destroy a texture that is in use, trading one use-after-free for
another. `releaseTexture3D` also refuses to decrement an entry whose `texture` is not the
instance being released, for the same reason.

`getSharedTextureStats` and `disposeAllSharedTextures` both account for retired entries: the
first would otherwise under-report a re-imported scene (the opposite of what a leak check
wants), and the second would leak exactly the textures an editing session re-imported.

**The announcement needs a MATERIAL-SIDE CONSUMER, or retirement silently trades one bug for
another.** Retiring means the texture is freed by the last `releaseTexture3D` — which arrives
through `disposeMaterial` when a material rebuilds. Nothing consumed
`emitAssetInvalidated('texture', …)` on the material side, so a **standalone** texture re-import
(the Inspector's Convert/Re-import, and the batch `reimportPaths`) left the material bound to the
old instance: the viewport kept sampling the pre-reimport bytes *and* the retired texture was
never freed. A MODEL re-import hid it, because `modelImport` also calls `invalidateMaterial` per
deduped material — which is why a model-path check cannot catch this. `meshTemplateCache` now
subscribes to `kind: 'texture'` and invalidates any cached material holding a retired texture.

⚠️ That consumer runs on a **microtask**, deliberately: `invalidateTexture` announces BEFORE it
evicts (so path-keyed panels see the event), so a synchronous listener would read the
pre-retirement state and match nothing.

### The MATERIAL cache too — and this one was measured live (#317)

`invalidateMaterial` disposed the cached `THREE.Material` synchronously, and `disposeMaterial`
also **releases the material's shared textures** — while `mesh.material` still pointed at that
instance. `syncMaterial` cannot save it: a re-import keeps the same GUID, so it takes the
unchanged-ref branch, where `resolveMaterial` returns `undefined` until the async refetch lands
and the re-bind body is skipped entirely.

**Two of the four callers reach it with no eviction guard**: the material-side texture consumer
above, and the Inspector's live material edit (`persist.ts` → `invalidateMaterialFile`).
`modelImport` is safe only because it calls `invalidateModel` first, which evicts the meshes.

⚠️ **Unlike the env case, this one reproduces.** Probing the rotating cube in `games/3d-test`
across a texture re-import: the bound material was disposed and **4 rendered frames** drew the
destroyed instance before the rebuild landed (recorded per-rAF, 1199 frames sampled). After the
fix, the same probe reports **0** — and the material is still eventually freed, so no leak was
traded in. If you need to re-measure this class, that probe (wrap `mat.dispose`, count rAFs where
`mesh.material` is still the wrapped instance) is the instrument; an uncaptured-GPU-error watch is
not — WebGPU-on-Metal here tolerated all four frames silently.

The fix is the #315 shape — retire, then free once no live surface binds it — with the sweep one
level deeper: a material binds to a **mesh**, so `sweepRetiredMaterials` traverses each
registered surface, and it reads `mesh.material` arrays as well as the single-material case.
It runs at the tail of `syncSceneRenderables3D`, guarded on `retiredMaterials3D().size`, so an
ordinary frame does no traverse at all.

`fetchMaterial`'s load callback retires an occupied slot for the same reason
`fetchEnvironment` does: `invalidateMaterial` clears `materialLoadPromises`, which is the ONLY
thing `fetchMaterial` dedupes on, so an in-flight fetch stops deduping a second one and both
reach `materialCache.set`. Orphaned, the loser is unreachable to the cache, to the sweep *and* to
`disposeAllCachedResources` — leaking the material and every shared-texture ref it holds.

**One consequence worth knowing: a retired texture's release is now deferred behind its
material's sweep.** `disposeMaterial` is what releases the material's texture refs, and it no
longer runs at invalidation time — in production that is a few frames, and freeing earlier would
be the same use-after-free one level down.

**The sweep backs off when a retiree is legitimately PINNED.** A retiree can be held forever and
correctly so: if the refetch after an invalidation fails, `fetchMaterial` caches
`MATERIAL_FAILED`, `resolveMaterial` returns undefined for that path permanently, and
`syncMaterial` can never rebind — so the mesh keeps drawing the retiree. Without a backoff
`retired.size` never returns to 0 and every surface pays a full `scene.traverse()` on every frame
for the rest of the session. ⚠️ The grace before backing off is **3 fruitless sweeps, not 1**, and
the tests caught why: a retiree is still bound on the sweep right after its invalidation almost by
definition, so backing off immediately skipped the very frame the mesh rebound on and delayed
every ordinary free.

#### The CLONES are the other half (#318)

Three caches bind a `base.clone()` to a mesh rather than the shared cached material — tint
(`scene3DSync.tintedMaterial`), per-entity MaterialInstance prop clones
(`materialInstanceClones.ts`) and light-mask variants (`lightMaskVariants.ts`) — and a THREE clone
copies **texture references**. That gave two defects with one root cause: nothing told a clone its
base had been replaced.

**Defect 1 — staleness.** A re-import keeps the GUID, so the tint key `basePath|color|amount` never
moves and the cache kept serving a clone of the dead base for the rest of the session, while an
untinted mesh on the same `.mat.json` updated correctly. Light-mask variants had it worse:
`syncMaterial` deliberately skips its per-frame re-bind for a masked entity, so nothing ever hands
that mesh the fresh instance, and `applyLightMask` re-derives from the base it recovers out of the
bound variant's `userData` — the **retired** one — landing on the same `${uuid}|${sel}` key.

**Defect 2 — textures freed under a live clone.** `sweepRetiredMaterials` only sees what a MESH
binds, and none of those caches is reachable from a `scene.traverse`: the clone is what the mesh
binds, the base is in a module Map or in `userData`. So a base whose sole remaining holders were
clones was swept, and `disposeMaterial` released the textures the clones were still sampling. The
reproducible trigger is *deactivate an entity carrying a prop override → re-import the `.mat.json`
→ reactivate*: `materialInstanceSystem` returns early for an entity with no live 3D objects, so
the base stops being refreshed while the clone stays in the Map.

The fix is two mechanisms, and it takes **both** — announce-and-evict alone does not fix the
light-mask half, because the eviction leaves the holder re-deriving from the same dead pointer:

- **`rendering/derivedMaterials.ts`** — every clone site stamps `userData.__derivedBase`, and the
  sweep walks that chain up from each bound material, so a base held only *through* a clone counts
  as bound. That is defect 2, for all three caches at once. It also owns a separate retirement
  queue for **clones**, because a clone must never go through `disposeMaterial`: that walks the
  texture slots and `releaseTexture3D`s each one, which for a clone means releasing the base's refs
  a second time.
- **`refreshedMaterial(mat)`** in `meshTemplateCache` — `invalidateMaterial` records
  `retired base → the path it was evicted from`, so a holder that only has the dead instance can
  find its successor once the async refetch lands. `applyLightMask` routes through it; the tint
  cache does not need it, because it re-resolves by ref every frame and simply compares the
  resolved base to the one it cloned.

**The close-out sweep found two more clone sites the fix itself had missed**, and both are now
stamped: the prewarm's side-pinned variants (`scene3DSync`) and the per-entity video-surface clone
(`videoTextureSync`). Only the video one is a live-mesh binding, and only the lifetime half applied
to it — `syncMaterial` does re-bind a video entity's resolved material, so its rebuild path already
handled staleness. `engine/tests/architecture/materialCloneStamp.test.ts` now fails on an
unstamped one.

⚠️ **Any further clone site must `markDerived` at the clone.** This is the same discipline
`registerRenderSurface` needed in #315/#317 and for the same reason: a stamp written anywhere but
the clone site is one a later site will forget, and the failure is silent — textures released under
a live material, which WebGPU-on-Metal tolerates for several frames before anything looks wrong.

⚠️ **A superseded clone is RETIRED, not disposed** — a mesh is binding it right now, and the caller
rebinds only after the cache hands back the new one. Same rule as the base: never `dispose()` a
retiree, use `disposeRetiredDerivedMaterial`.

Not fixed here, deliberately: `invalidateMaterial` still announces nothing on the
`assetInvalidation` channel. With the forwarding pointer nothing needs the push, and a new kind
with no subscriber is a [mechanism that cannot fire](../CLAUDE.md).

### The env cache retires too — but it is freed by a SWEEP, not a refcount (#315)

`invalidateEnvironment` had the same defect: it disposed the cached HDR unconditionally while
its own contract "KEEPS the scene owners", and `scene3DSync` binds that instance as
`scene.environment` (and, with `showAsBackground`, `scene.background`). Re-importing an HDR a
scene was using reproduced the same `Destroyed texture used in a submit`.

**The fix is deliberately NOT a copy of the one above.** The env cache has owner-*sets*
(`envOwners`) and no per-holder release, so there is no refcount for the last releaser to drop.
So `invalidateEnvironment` retires into `retiredEnvs`, and `syncEnvironment` — the only function
that *binds* an env texture, and therefore the only one every 3D surface must call to hold one —
runs a sweep at the end of each frame: it asks every registered live `THREE.Scene` what it is
**actually** binding right now, and frees a retiree that nobody binds.

⚠️ **The sweep reads the live property instead of tracking bind/unbind calls, on purpose.** Five
sites outside `syncEnvironment` clear `scene.environment`/`scene.background` (`Scene3D`'s
teardown, `SceneView`'s UI-mode and unmount paths). An explicit acquire/release would have to be
threaded through every one of them and would go silently wrong the moment a sixth appeared —
the partially-wired-mechanism failure this repo keeps hitting. Reading the property cannot go
stale.

**The multi-surface case is what forces the design**: the editor renders SceneView and the Game
panel from two different `THREE.Scene`s off one env cache, so freeing when the *first* surface
rebinds would still destroy a texture the second one binds.

**Two more paths were routed through the retirement in the same pass**, because the sweep is the
only thing that can answer "does anything still bind this?":

- **`releaseEnvironmentByPath`** (the scene swap). "Last OWNER" is not "nothing binds it" — a
  render-on-demand SceneView that has not redrawn since the swap still has the instance on
  `scene.environment`, so the frames between the release and its next sync drew a destroyed
  texture. It retires now; the sweep frees it on that surface's very next `syncEnvironment`.
- **`fetchEnvironment`'s load callback.** `invalidateEnvironment` clears `envLoadPromises`, so a
  fetch already in flight stops deduping a second one and BOTH callbacks reach
  `envCache.set(path, …)`. The loser used to be overwritten silently — unreachable to every
  lookup *and* to the sweep, i.e. an HDR-sized leak. It is retired instead. Disposing it there
  would not have been safe either: a surface may be binding it.

⚠️ **Every site that binds a `getCachedEnvironment` result to a `THREE.Scene` must call
`registerEnvSurface` first.** There are exactly two: `syncEnvironment`, and
`prewarmShadersForWorld`'s throwaway compile scene — which was missed in the first cut of this
fix and is the reason the warning is here. That binding outlives an `await compileAsync`, so an
unregistered prewarm let a re-import during the compile free the texture the compile was still
sampling. Pinned by `prewarmShaders.test.ts` § "registers its compile scene with the
retired-env sweep".

⚠️ **`showAsBackground` used to be wired in ONE direction, and that pinned retirees.**
`syncEnvironment` set `scene.background` to the HDR but nothing ever took it back — not when the
box was unticked, not when the Environment was removed. `syncCamera` could not undo it either: it
deliberately "leaves a TEXTURE background alone" *because this sync owns it*, which is exactly
what made the stale one permanent. Observed live on `games/3d-test`: unticking the box left the
sky on screen across frames. Two failures in one — the visible authoring bug (an
[exposed field nothing reads](../CLAUDE.md)), and a live surface holding a retired texture the
sweep could then never free. `clearTextureBackground` closes both. It clears to `null` rather
than to the camera's clearColor, because `syncCamera` owns that value and re-applies it on
`bg == null`; in `Scene3D` it runs first, so the authored colour lands one frame later.

The residual failure mode is a **leak, never a use-after-free**: a surface that stops rendering
while still bound keeps its texture alive (which is correct), and `disposeAllCachedResources`
drains whatever is left with the cache generation. Do not "fix" this by deleting the retirement
and disposing directly — and never call `dispose()` on a retiree; use `disposeRetiredEnvironment`.

⚠️ **The live editor path does NOT discriminate here, and a green run through it proves nothing.**
Driving the Inspector's Environment **Re-import** on `games/3d-test` (WebGPU/Metal, this Mac)
raised no uncaptured error and rebound to fresh bytes **with the fix reverted** as well as with it
in place — measured both ways, including with `showAsBackground` forced on so the HDR was sampled
directly as `scene.background` rather than only through PMREM. The window between the dispose and
the rebind is short (the bake is awaited first, and `fireDirtyListeners` wakes the surface), and
three's WebGPU backend frees lazily, so the fault does not surface on this hardware. **The unit
tests are the proof** (`environmentInvalidationRetires.test.ts` — all three fail against the
pre-fix code); the live run is a non-regression check only. Do not read "I could not reproduce
it in the editor" as evidence the defect is not there.

**Verifying a fix here needs the right path.** `modoki_reimport_asset` drives the backend bake
only and never runs the browser-side `importModel` that calls `invalidateTexture` — it cannot
reproduce this, and a green run through it is not evidence. Drive the Inspector's **Re-import**
button and confirm `[Import] Extracted N textures` in the console; `modoki_get_editor_state`
reports a `gpu.uncapturedErrors` counter (absent when zero) that is a cleaner signal than
scraping the log.


## Gotchas

- **Multiple-of-4 dimensions are mandatory** for block-compressed KTX2
  (ASTC/UASTC/ETC). Non-mult-4 + mipmaps renders **solid black on Adreno /
  mobile GPUs** — the converter snaps each axis to a multiple of 4
  (`m4 = max(4, round(n/4)*4)`).
- **KTX2/Basis is bottom-origin**, so KTX2 textures use `flipY = false`
  (matches the GLB convention) and `generateMipmaps = false` (mips are baked).
  `applyTextureSettings()` enforces this.
- **A SLICED texture has NO whole-image sprite, and nothing says so out loud.** The scanner
  auto-emits a whole-image `'sprite'` (guid `deriveGuid('sprite:' + textureGuid)`, path
  `<tex>#default`) for a 2D/UI texture in the branch **mutually exclusive** with the sliced one
  (`vite-asset-scanner.ts`) — so a texture with `spriteMode:'multiple'` never gets one. Deriving
  that guid anyway yields a ref with no manifest entry: it renders nothing and logs nothing.
  Two editor surfaces did exactly that and shipped dead refs — the SpritePicker's "whole" button
  for any sliced sheet (QA-INSP-0011, reproduced on `games/sling`'s 200-slice slime sheet) and
  SkinEditor's drag-drop of a texture onto a rig part. **Ask the manifest whether the sprite
  exists** (`wholeImageSpriteRef` in `editor/panels/spritePickerGroups.ts`, shared by both) rather
  than re-deriving the emit rule — a second derivation of the rule is how the two drift. Do NOT
  fall back to the raw texture guid when it is absent: 2D refs are sprites-only, and that trades a
  dead ref for a different invariant violation. `assetRefIntegrity.test.ts` now models the same
  exclusion; it used to add the derived guid unconditionally, which made the guard vouch for
  precisely the dead ref it exists to catch.
- **The IMPORT DEFAULT is `3d`, so a freshly imported PNG has no sprite either — and that is
  the surprising half** (#293). The bullet above is about a *sliced* texture; this one is about
  doing nothing at all. `DEFAULT_TEXTURE_SETTINGS.format` is `ktx2-uastc`, and
  `resolveTextureType` infers `'3d'` from any non-`webp`/`png` format when `meta.type` is unset
  — so import an image, touch nothing, and the whole-image sprite is never emitted. Every
  surface then failed silently in a different way: the SpritePicker did not list the texture at
  all *and* told you to slice it (slicing a 3D texture emits nothing), and dropping it on a
  sprite-accepting field hit a bare `return` in `AssetRefField`. **Setting Type → 2D is only
  half the fix**: `changeType` writes the sidecar, and the sprite is minted by the *re-import*,
  so the Inspector's Apply is a required second step. The picker now carries a collapsed
  "N textures have no sprite" section with a **Make 2D** button that does both
  (`editor/panels/makeTexture2D.ts`), and the rejected drop warns instead of vanishing.
  ⚠️ **That button is destructive on 3D content and is deliberately two-click.** `2d` derives
  `mipmaps:false` + `wrapS/wrapT:'clamp'`, so converting a tiling terrain albedo or a normal map
  degrades the material that uses it — with no error, and not undoable (it writes the sidecar and
  re-imports on disk, outside the editor undo stack). `makeTexture2D` therefore carries the
  authored knobs that are NOT type-derived (`colorspace`, `flipY`, `flipGreen`, `maxSize`, the
  encoder settings) rather than resetting the whole block the way `changeType` does — forcing a
  normal map's `colorspace:'linear'` back to `'srgb'` is gamma-decoded data, i.e. wrong lighting
  with nothing to see.
  **Measured, per the live manifest** (`/api/rescan-assets`, 2026-08-21) — a 3D project's texture
  set is essentially ALL spriteless, because GLB-imported material maps are `3d` by definition:
  `demos/forest-camp` 22 of 22 textures (zero sprite groups at all), `games/3d-test` 22 of 24,
  against `games/court` at 1 of 60 (59 are explicitly `ui`). That is why the section is collapsed
  — ~22 rows overflow the 350px popup and push the sprite groups out of view — and why the 30-row
  cap is a guard for a larger project rather than something that fires routinely.
  ⚠️ **Count texture ASSETS, not image FILES.** An earlier revision of this bullet claimed 130 /
  ~395 / ~147 from `find`-counting `*.png`; the scanner registers far fewer as texture assets
  (Court: 454 files, 60 textures), so those figures were wrong by up to two orders of magnitude.
  Ask the manifest.
- **DOM image refs** (`UIElement.imageSrc` in `UINode.tsx`) MUST resolve via
  `resolveDomImageUrl` → `resolveBrowserImageUrl` (the WebP/PNG browser
  sibling), **not** `resolveImageUrl` / `resolveTextureVariantUrl(ref, '2d')`
  (which now return the **KTX2 GPU variant** for the PixiJS path — the DOM can't
  decode it), and **not** raw `resolveRef` + `assetUrl` — the source PNG is
  dropped from production builds, so a raw ref 404s on device. In prod, a
  `3d`-typed KTX2 texture (no WebP sibling) referenced from the DOM logs a loud
  (deduped) error pointing you to set the texture type to `2d`/`ui` so a WebP is
  emitted.
- ⚠️ **The authored TYPE has to reach the RUNTIME manifest, and for a long time it did not**
  (QA-ASSET-0007). `browserVariant(format, type)` decides whether a WebP sibling exists, and an
  absent `type` is **not neutral** — it re-infers the type from the FORMAT, and every `ktx2-*`
  format infers `3d`, i.e. "no sibling". `AssetEntry.textureType` was declared, read in exactly
  that one place, and written by **nobody**: `loadManifestJson` dropped the scanner's
  `textureType` on the floor. So every `ui`/`2d`-typed KTX2 texture — the ones the build DOES
  emit a WebP for — resolved in the DOM to the raw source PNG that production strips. The failure
  is silent in dev (the source is served off disk) and the `warnKtx` path stays quiet because the
  runtime believes the texture is `3d`. What made it *look* like a different bug: re-typing a
  texture and re-importing it correctly fixed the sidecar, the scanner's manifest and
  `/api/rescan-assets`' own response, and changed nothing in the running editor — because the
  field never crossed into the client's map at all, at any point, ever. If a manifest field is
  read anywhere, check something WRITES it: `registerAsset` takes each block explicitly, so a new
  one is opt-in and its absence is invisible. Guarded now by
  `engine/tests/architecture/manifestBlockPlumbing.test.ts`, which asserts every `AssetEntry`
  field is written by `registerAsset`, forwarded by `loadManifestJson`, and emitted by
  `serializeManifest` — a source scan rather than a round-trip, because a round-trip can only
  exercise a field it knows how to SET, which is exactly the field nobody plumbed.

## Key files

- `plugins/texture-convert.ts` — `convertTexture()`, `buildToktxArgs()`,
  `ensureKtxCli()`.
- `plugins/texture-cache.ts` — content cache + hash key (`ENCODER_VERSION`).
- `plugins/reimport-texture.ts` — `texture` reimport handler.
- `plugins/reimport-registry.ts` — per-asset-type handler dispatch.
- `plugins/reimport-atlas.ts` — `atlas` reimport handler (pack + composite + encode).
- `plugins/atlas-cache.ts` — atlas content hash + synthetic page url path.
- `runtime/loaders/spriteAtlas.ts` — pure MaxRects packer + atlas schema types.
- `scripts/stage-toktx.cjs` — electron-builder `beforePack`: bundles `toktx` + `libktx`.
- `runtime/loaders/pixiKtxTranscoder.ts` — registers PixiJS `loadKTX2` +
  locally-served libktx (2D KTX2 sprite decode).
- `vite-asset-scanner.ts` — variant/transcoder serving + build-time generation.
  (The `/api/reimport` + `/api/reimport-types` endpoints live in
  `plugins/backend/editorBackendRouter.ts`.)
- `asset-tree-shaker.ts` — drops source PNGs from the production build.
- `runtime/loaders/textureResolver.ts` — variant selection + KTX2 loading.
- `runtime/loaders/textureSettings.ts` — settings schema + `selectVariant`.
- `runtime/rendering/derivedMaterials.ts` — the `__derivedBase` stamp + the retirement queue for
  material CLONES (#318). Read it before adding a fourth clone site.
