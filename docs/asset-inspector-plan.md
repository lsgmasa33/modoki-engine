# Asset Inspector Overhaul — Plan & Tracker

> Living plan. Status checkboxes updated as phases land. Addresses a four-dimension audit of
> the editor's asset Inspector: **previews**, **launch-an-editor buttons**, **converter-parameter
> exposure**, and **HDR conversion**.

## Context

The editor's asset Inspector (`engine/packages/modoki/src/editor/panels/Inspector.tsx` → per-type
`assetViews/*AssetView.tsx`) is the surface a designer uses to preview an asset, tune its import
settings, and jump into a dedicated editor. An audit found it strong in places (model 3D preview,
audio waveform, full model/texture/audio converter controls) but with concrete gaps: two asset
types have no preview, one editor has no launch button, several converter controls are dead/locked/
missing, and HDR environment maps have no conversion pipeline at all (they ship raw, 5–30 MB).

This plan fixes all of it, phased so each slice is independently committable/testable/reviewable.

## Audit findings (the work-list)

### A. Previews — 3 gaps
- **Mesh** (`MeshAssetView.tsx`) — stats only, no visual. Feasible: reuse `ModelPreview` on the
  resolved mesh template (`whenMeshTemplate(path)` / `data.model` already available).
- **Material** (`MaterialAssetView.tsx`) — color swatches only, no rendered material. Feasible:
  `ModelPreview` already builds a lit IBL scene (`RoomEnvironment` + key/fill + ACES); render the
  assembled `MeshStandardMaterial` on a sphere. Needs a geometry+material variant of `ModelPreview`.
- **AnimSet** (`AnimSetAssetView.tsx`) — numeric clip params only, no playback. Heaviest lift:
  needs an `AnimationMixer`-driven viewer (not built today; `ModelPreview` loads GLBs statically).

### B. Launch-an-editor buttons — 1 bug, review the rest
- **spriteanim GAP (bug):** `SpriteAnimEditor` (dockable), `openSpriteAnimEditor` (`editorStore.ts:490`),
  and `openAssetInEditor('spriteanim')` (`openAssetInEditor.ts:51`) all exist, but the Inspector
  switch (`Inspector.tsx:1210-1264`) has **no `spriteanim` case** → a selected `.spriteanim.json`
  shows *"No actions for spriteanim assets."* Only openable via Assets double-click today.
- Working today (keep as reference): particle / animation / rig2d dockable buttons
  (`Inspector.tsx:1216-1241` → `openAssetInEditor`), texture Sprite/9-slice modals
  (`TextureAssetView.tsx:271,289`). sprite correctly defers to its parent texture's editor.

### C. Converter parameters — dead / locked / hidden
- **Font `atlasMax` is a dead control** (`FontAssetView.tsx:118`) — never passed to msdf-atlas-gen
  (`-potr` auto-sizes, `font-convert.ts:102`); only affects runtime dynamic pages + cache key. It
  reads as a bake setting but isn't one.
- **Font `fieldType` locked to `mtsdf`** — `msdf` exists in the type (`fontSettings.ts:13`) but the
  inspector renders static text, not a control (`FontAssetView.tsx:102`).
- **Rigged/skinned models have NO conversion UI** — the LOD panel is hidden when `isRigged`
  (`ModelAssetView.tsx:306`); their KTX2/meshopt settings are hardcoded and unreachable
  (`rigged-model-optimize.ts:124-125`). Also an **inconsistency**: rigged uses UASTC RDO-lambda
  **4**, standalone textures use **1.0** (`texture-convert.ts:68`).
- **High-value hardcoded knobs not exposed:** texture UASTC RDO-lambda / Zstd level / **WebP
  quality (80)** (`texture-convert.ts:68,207`); ETC1S clevel/qlevel; ASTC block/quality; audio
  **loudnorm target** (`audio-convert.ts:67`), **no sample-rate control**, WAV fixed 16-bit
  (`audio-convert.ts:92`); model gltfpack structural flags (leave hardcoded), **no Draco option**.
- **Note (not a bug):** texture `wrapS/wrapT` are exposed but runtime-only (sampler state, not a
  conversion param) — correct as-is; just don't confuse them with converter inputs.

### D. HDR conversion — no pipeline
- `.hdr` classifies as `environment` (`assetTypeClassifier.ts:54`), gets a **GUID-only**
  `.meta.json`, and loads **raw uncompressed** via `HDRLoader` (`meshTemplateCache.ts:1441`). No
  settings block, no manifest `environment` block, no reimport handler, no variant resolver.
  `EnvironmentAssetView` is preview + a preview-local exposure slider only.
- The generic plumbing already accepts a new type with near-zero shared change (reimport-registry,
  meta sidecar, `/api/reimport` + `/api/reimport-types` + cache-miss bake, per-type AssetView
  dispatch). The **one real gap is the encoder** — `toktx` is present but driven LDR-through-PNG,
  and `sharp` can't decode HDR. The **runtime decode side is already vendored**: `UltraHDRLoader.js`,
  `EXRLoader.js`, and `KTX2Loader` (ASTC caps).

## Working conventions (every phase)
- Work directly on `work-ai`, no PRs/branches (project rule). Commit per phase.
- **Tests at the END of every phase** — unit (pure: settings resolution, variant selection,
  converter-arg building) + integration (DOM: render the AssetView, assert the new control/preview/
  button) under `engine/tests/` (`ui/`, `plugins/`, `assets/`).
- **Review at the END of every phase** — correctness + the editor/runtime boundary (asset views are
  editor-only; any new runtime resolver/settings must live in `runtime/loaders/` and stay import-clean).
- **Live-verify** in the Electron editor (this clone: `MODOKI_BACKEND_PORT=5180 editor-ai`), driving
  the Inspector via the `modoki` MCP.
- `npm run verify` green before each push.

## Phases

### Phase 1 — Quick wins (small, low-risk, high-signal) — ✅ DONE
- [x] **spriteanim launch button** — `Inspector.tsx`: added the `asset.type === 'spriteanim'` case
      ("Open in Sprite Animation Window" → `openAssetInEditor`) + `'spriteanim'` in the known-types
      allowlist (was printing "No actions").
- [x] **Font `fieldType` control** — `FontAssetView.tsx`: static "MTSDF" text → an editable msdf/mtsdf
      `<select>` (converter already honors `settings.fieldType`).
- [x] **Font `atlasMax` honesty** — moved out of "Atlas" into the Mode section, relabeled "Runtime
      page size (px)", shown ONLY in dynamic mode (option a — baked atlas auto-sizes via `-potr`).
- [x] **Expose WebP quality** — new optional `webpQuality` + `DEFAULT_WEBP_QUALITY`/`resolveWebpQuality`
      (clamp 1–100) in `textureSettings.ts`; `texture-convert.ts` encodes at `resolveWebpQuality(...)`;
      `TextureSettingsControls` shows the control only when a WebP variant is emitted.
- [x] **Review caught + fixed a HIGH bug:** `webpQuality` was absent from the texture **cache key**
      (`texture-cache.ts` `stableSettings` hashes an explicit field list, not the whole object), so a
      quality edit would hit the cache and never re-encode. Added it to the key (conditional, so
      existing WebP textures don't mass re-convert) + a regression test asserting the key changes.
- [x] Tests: `textureSettings.test.ts` (`resolveWebpQuality`), `textureCache.test.ts` (hash includes
      webpQuality + backward-compat), `assetInspectorPhase1.test.tsx` (WebP control visibility +
      clamp), `fontAssetView.test.tsx` (fieldType select + atlasMax baked/dynamic). `npm run verify`
      green (0 errors; 1411 app + 3986 package tests).

### Phase 2 — Mesh + Material previews — ✅ DONE
- [x] **Shared preview primitive** — `previewScene.ts` `createPreviewScene(container, opts)`:
      WebGLRenderer + RoomEnvironment IBL + key/fill lights + OrbitControls + render-on-demand loop
      + `contentRoot`/`frameContent`/`setWireframe`/`clearContent`/`dispose` (extracted from
      ModelPreview's setup). `Preview3DShell.tsx` wraps it (populate-on-resetKey, wireframe/reset,
      graceful "no WebGL"). (ModelPreview itself left intact — refactoring it onto the primitive is
      a low-risk follow-up.)
- [x] **Mesh preview** — `MeshPreview` renders the mesh template's geometry (CLONED — cache owns the
      original) on a neutral material; wired into `MeshAssetView`.
- [x] **Material preview** — `MaterialPreview` renders a sphere with `buildPreviewMaterial(data)`,
      which reuses the engine's own pbr/unlit builders (faithful color/roughness/metalness/emissive);
      custom→pbr approximation (no async WebGPU NodeMaterial); wired into `MaterialAssetView`.
- [x] **Material preview texture maps** (follow-up landed) — `loadPreviewMaps(material, data, signal)`
      resolves the map GUIDs (`texture`/`normalTexture`/`roughnessTexture`/…) via the shared refcounted
      `loadTexture3D` (KTX2-variant aware, same path ModelPreview uses) and assigns the slots the
      material actually has (skips PBR-only slots on unlit MeshBasic). Deliberate cuts vs the runtime:
      no `textureRepeat` (the texture is SHARED — mutating `.repeat` would retile the live scene) and
      no envMap (RoomEnvironment IBL already lights the sphere). `MaterialPreview` releases every loaded
      texture via the populate `AbortSignal` (fires on data-edit rebuild AND unmount) — the single
      correct place to drop refs. Fixes the "textured material previews as a white sphere" report.
- [x] Tests: `assetInspectorPhase2.test.tsx` (buildPreviewMaterial ×5; loadPreviewMaps ×3 — map slots/
      unlit-skip/invalid-ref; Preview3DShell populate/frame/
      wireframe/rebuild/dispose; MaterialPreview sphere; MeshPreview clone-ownership + load-failure) +
      `Preview3DShell.graceful.test.tsx` (WebGL-unavailable). `npm run verify` green (0 errors).
- [x] **Review caught + fixed:** HIGH — `dispose()` now calls `renderer.forceContextLoss()` before
      `dispose()` (previews mount per asset-click → would hit Chrome's ~16-context cap and black out
      the whole editor); MEDIUM — restored ModelPreview's `wireframeRef` so a toggle mid-async-load
      isn't lost; LOW — dispose the `RoomEnvironment` after PMREM bake; LOW — documented the
      fixed-size populate/resetKey coupling.
- **Live-verify:** deferred to the human (no headless "select-asset" MCP op; the editor renderer was
      disconnected during this phase) — relaunch `editor-ai`, click a mesh/material asset → the 3D
      preview shows at the top of the Inspector.
- [x] **AnimSet playback preview DEFERRED** (needs an `AnimationMixer` loop) — tracked in follow-ups.

### Phase 3 — Expose converter parameters (texture UASTC + audio rate/depth) — ✅ DONE
- [x] **Texture UASTC knobs** — `uastcLevel` (0–4) + `uastcRdoLambda` in `textureSettings.ts`
      (+ `resolveUastcLevel`/`resolveUastcRdoLambda` clamps, defaults 2/1.0). `buildToktxArgs` emits
      them (λ=0 ⇒ RDO off, omit `--uastc_rdo_l`); `texture-cache.ts` hashes them conditionally;
      inspector control shown when a `uastc` variant is emitted.
- [x] **Audio sample-rate + WAV bit-depth** — `sampleRate` (`-ar`, 0=source) + `bitDepth`
      (`wavPcmCodec` → pcm_s16le/s24le/f32le) in `audioSettings.ts`; `buildFfmpegArgs` emits them;
      `audio-cache.ts` hashes them conditionally (bitDepth wav-only). Inspector: sample-rate always,
      bit-depth wav-only.
- [x] Tests: converter arg-building (incl. λ=0 omit, opus rate snap, wav codec) + cache-key
      backward-compat (unset ⇒ identical hash) + UASTC UI visibility/commit/clamp. `npm run verify` green.
- [x] **Review verified the load-bearing cache backward-compat contract sound** + fixed: MEDIUM —
      opus rejects a forced non-legal `-ar` (would crash ffmpeg) → snap to nearest legal opus rate in
      the converter + gate the UI options; LOW — exclude audio `bitDepth` from the hash for non-wav
      (dead input) to avoid cache thrash on a stale value.
- **DEFERRED to follow-ups:** texture Zstd level / ETC1S clevel-qlevel / ASTC block-quality; audio
      loudnorm target + silence thresholds (tuned defaults kept). Draco (new codec path).

### Phase 3b — Rigged-model conversion UI — ✅ DONE
- [x] **Rigged texture-compression UI** — `ModelAssetView` rigged branch now has a "Texture
      Compression" section (Format uastc/etc1s/raw · Max Size · Mipmaps · UASTC Level + RDO λ),
      persisted to `meta.texture` (the block `reimport-model.ts` already reads via
      `resolveTextureSettings(meta)` → `convertRiggedModel`). Replaced the old misleading
      "controlled per texture in the Texture Inspector" note.
- [x] **Reconciled the UASTC RDO-lambda inconsistency** — `rigged-model-optimize.ts` `ktxFlags` now
      reads the SHARED `resolveUastcLevel`/`resolveUastcRdoLambda` (default 1.0, was a hardcoded 4),
      λ=0 ⇒ RDO off. The flags feed `ktxSignature`→`riggedHash`, so existing rigged caches
      auto-regenerate on next reimport (no version bump needed — invalidates exactly the affected
      models). `ktxFlags` exported for tests.
- [x] Tests: `ktxFlags` reconciled default/honor/λ=0-omit/etc1s-ignores; `riggedHash` changes for
      uastc knobs + inert for etc1s/png. `npm run verify` green.
- [x] **Review: no correctness bugs** (verified the cache-invalidation contract, `meta.type` can't
      hijack `resolveTextureSettings`, `meta.texture` on a model doesn't collide with the scanner/dist
      verifier, static models stay inert). Added a png no-thrash test + a hint for the pre-rig-import
      window (a bare "Re-import all" before Import takes the static path).
- **Live-verify:** deferred to the human (heavy `ModelAssetView`; no headless asset-select) — open a
      rigged model (e.g. games/alien-animal), set the texture-compression knobs, Re-import.

### Phase 4 — HDR conversion (downscale, dependency-free) — ✅ DONE
Encoder investigation (documented): toktx CAN'T read `.hdr` (only 16-bit int → clamps HDR); `ktx create`
does NOT do ASTC encode + can't read EXR; no `ultrahdr` CLI. So GPU-compressed HDR (ASTC-HDR) is
blocked with current tooling + is device-spotty + untestable headlessly. **Shipped the dependency-free
downscale** (the real download win: 2K→1K ≈ 3×, →512 ≈ 12×; area-average in linear radiance space →
**0.10% mean-luminance error**), with the Format dropdown ready for a compressed variant later
(**UltraHDR/gainmap = Phase 4b, browser-side encode** — `@monogrid/gainmap-js`, universal device support).
- [x] **Settings** — `runtime/loaders/environmentSettings.ts`: `EnvImportSettings { format:'hdr'; maxSize }`,
      defaults, `resolveEnvSettings`, `ENV_VARIANT_SUFFIX` (`~env.hdr`), `EnvManifestBlock`, `EnvCacheInfo`.
- [x] **Codec + converter** — `hdr-codec.ts` (dependency-free RGBE encode + area-average downscale,
      round-trip unit-tested against three's HDRLoader), `env-convert.ts` (decode via HDRLoader.parse →
      downscale → encode → cache), `env-cache.ts` (content hash).
- [x] **Reimport handler** — `reimport-environment.ts`; registered in `vite-asset-scanner.ts` +
      `engine/electron/main.ts`. Auto-surfaces in `/api/reimport-types` + the cache-miss bake.
- [x] **Serving** — `staticAssets.ts` `~env.hdr` branch (+ `'environment'` in `autoBakeThenServe`);
      **build-gen** downscales into `dist/` + drops the multi-MB source; **dist verifier** checks the
      variant; **manifest** `AssetEntry.environment` populated in the scanner + runtime (`assetManifest.ts`).
- [x] **Runtime resolver** — `resolveEnvVariantUrl(ref)` (source fallback + cache-bust); env loader
      (`meshTemplateCache.ts`) loads the variant; `invalidateEnvironment` evicts on re-import.
- [x] **UI** — `EnvironmentAssetView`: Format + Max Size + Apply + downscaled-size stats (replaced the
      "no import settings" note). Dispatch already routed `environment` → this view.
- [x] Tests: `hdrCodec` (round-trip within RGBE quantization + downscale math), `envCache` (hash
      stability/sensitivity), `environmentSettings` (resolve + `resolveEnvVariantUrl` variant/fallback/
      by-path). End-to-end reimport probe on a real HDR: 6.49 MB → 0.53 MB @512. `npm run verify` green.

### Phase 4b — Compressed HDR (UltraHDR/gainmap, browser-side) — ✅ DONE + LIVE-VERIFIED
- [x] Added `@monogrid/gainmap-js` (v3.4.0; the audit warnings it surfaced are all pre-existing
      transitive deps, not from this package). `EnvFormat += 'ultrahdr'`, `envVariantSuffix(format)`
      (`~ultrahdr.jpg` vs `~env.hdr`).
- [x] **Browser-side encode** — `encodeUltraHDR.ts` (editor-only, dynamic-imports gainmap-js so it
      never touches game bundles): HDRLoader → `findTextureMinMax` → `encodeAndCompress` →
      `encodeJPEGMetadata` (libultrahdr WASM). `EnvironmentAssetView` Apply, for `ultrahdr`, encodes +
      writes the **committed** `~ultrahdr.jpg` (base64 `/api/write-file`) + meta.
- [x] **Runtime decode** — env loader dispatches `UltraHDRLoader` for `ultrahdr` (else HDRLoader);
      `resolveEnvVariantUrl` uses the per-format suffix; `getEnvFormat` drives the dispatch.
- [x] **Scanner** — `detectType` EXCLUDES the committed `~ultrahdr.jpg` (a derived file, not a texture);
      build-gen copies the committed variant + drops source; verifier checks the per-format variant.
- [x] Node-side tests: `envVariantSuffix`/`resolveEnvVariantUrl`/`getEnvFormat` for ultrahdr;
      `detectType` excludes `~ultrahdr.jpg`. `npm run verify` green (1461 app + 3995 package).
- **Encode is browser-only** (WebGL + createImageBitmap) → not auto-testable, so **live-verified via
      CDP** in the running Electron editor: `encodeUltraHDR` on the 3d-test HDR produced a valid
      UltraHDR JPEG (`file`: JPEG 2048×1024, **14 gainmap/XMP markers** — a real embedded gainmap),
      **6.53 MB → 0.53 MB (~11.7×)**, encode ~183 ms, committed via `/api/write-file` (200), and NO
      stray `.meta.json` (the detectType exclusion holds). Node-side fully tested/typechecked.
- **Review verified** the untested gainmap-js API usage against the library's own v3.4.0 source
      (correct); fixes applied: FloatType decode (avoid half-float Infinity clip), tree-shaker
      `classify()` lockstep, `hashBytes`/`bytesToBase64` unit tests.
- Follow-up: `maxSize` downscale is currently `hdr`-only; UltraHDR encodes at source resolution.

### Phase 5 — Docs + polish — [ ]
- [ ] Fold this into the asset docs (`docs/textures.md` / a new `docs/environment-maps.md` for the
      HDR pipeline; note the converter-params surface in `docs/model-pipeline.md`/`docs/textures.md`).
- [ ] Update this tracker + `CLAUDE.md` where the texture/HDR pipeline is described.
- [ ] Final full-feature review + `npm run verify`.

## Deferred follow-ups (tracked, not in the phases above)
- **AnimSet playback preview** (needs an `AnimationMixer` viewer).
- **Draco mesh compression** option (new codec path alongside meshopt).
- **KTX2 ASTC-HDR** as a second HDR variant (after UltraHDR lands).
- Persist the Environment **exposure** slider (currently preview-local UI state, not saved).

## Critical files
- **Inspector + views:** `engine/packages/modoki/src/editor/panels/Inspector.tsx`,
  `panels/assetViews/{Texture,Material,Mesh,Model,Audio,Font,Environment,AnimSet,Sprite,Atlas}AssetView.tsx`,
  `panels/assetViews/widgets.tsx`, `panels/ModelPreview.tsx`, `editorStore.ts`, `openAssetInEditor.ts`.
- **Converters/settings:** `engine/plugins/{texture-convert,audio-convert,font-convert,model-convert,
  rigged-model-optimize,reimport-texture,reimport-registry,vite-asset-scanner}.ts`,
  `engine/electron/main.ts`; `runtime/loaders/{textureSettings,audioSettings,fontSettings,modelSettings,
  textureResolver,meshTemplateCache}.ts`.
- **New (Phase 4):** `runtime/loaders/environmentSettings.ts`, `engine/plugins/env-convert.ts`,
  `engine/plugins/reimport-environment.ts`, a `resolveEnvVariantUrl` in `textureResolver.ts` (or a
  sibling), `EnvironmentAssetView` settings UI.
