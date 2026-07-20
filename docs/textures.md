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
editor (`engine/electron/main.ts` at startup) register the handlers so
`/api/reimport` has them in either host. The dev server registers `texture`,
`model`, `atlas`, `audio`, `font`, `environment`; the packaged editor registers
the same set except `atlas`. `getReimportTypes()` exposes the
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
initialization with .detectSupport()". The first call resolves the exported
`rendererReady` promise, which the editor bootstrap awaits before
`loadScene()`.

`invalidateTexture(ref)` evicts the cached bytes for every variant from
`THREE.Cache` so a re-import re-fetches the freshly-converted files.

### 2D KTX2 sprites (PixiJS)

The 2D path decodes `.ktx2` sprites/atlas-pages through PixiJS's own KTX2 parser,
not `KTX2Loader`. `runtime/rendering/pixiKtxTranscoder.ts`
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

## Gotchas

- **Multiple-of-4 dimensions are mandatory** for block-compressed KTX2
  (ASTC/UASTC/ETC). Non-mult-4 + mipmaps renders **solid black on Adreno /
  mobile GPUs** — the converter snaps each axis to a multiple of 4
  (`m4 = max(4, round(n/4)*4)`).
- **KTX2/Basis is bottom-origin**, so KTX2 textures use `flipY = false`
  (matches the GLB convention) and `generateMipmaps = false` (mips are baked).
  `applyTextureSettings()` enforces this.
- **DOM image refs** (`UIElement.imageSrc` in `UINode.tsx`) MUST resolve via
  `resolveDomImageUrl` → `resolveBrowserImageUrl` (the WebP/PNG browser
  sibling), **not** `resolveImageUrl` / `resolveTextureVariantUrl(ref, '2d')`
  (which now return the **KTX2 GPU variant** for the PixiJS path — the DOM can't
  decode it), and **not** raw `resolveRef` + `assetUrl` — the source PNG is
  dropped from production builds, so a raw ref 404s on device. In prod, a
  `3d`-typed KTX2 texture (no WebP sibling) referenced from the DOM logs a loud
  (deduped) error pointing you to set the texture type to `2d`/`ui` so a WebP is
  emitted.

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
- `runtime/rendering/pixiKtxTranscoder.ts` — registers PixiJS `loadKTX2` +
  locally-served libktx (2D KTX2 sprite decode).
- `vite-asset-scanner.ts` — variant/transcoder serving + build-time generation.
  (The `/api/reimport` + `/api/reimport-types` endpoints live in
  `plugins/backend/editorBackendRouter.ts`.)
- `asset-tree-shaker.ts` — drops source PNGs from the production build.
- `runtime/loaders/textureResolver.ts` — variant selection + KTX2 loading.
- `runtime/loaders/textureSettings.ts` — settings schema + `selectVariant`.
