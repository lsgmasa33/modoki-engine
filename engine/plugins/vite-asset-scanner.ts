/** Vite plugin: scans all assets/ folders in the project and serves them via /api/scan-assets.
 *  Convention: any directory named "assets" is a scannable asset root.
 *  Also writes assets.manifest.json on build so production builds have a static manifest. */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';
import crypto, { randomUUID } from 'crypto';
import type { Plugin } from 'vite';
import { computeKeptAssets, enumerateRefEdges, formatBytes } from './asset-tree-shaker';
import { assertNoConversionFallback, type ConversionFailure } from './asset-conversion-strict';
import { loadProjectConfig, loadProjectUserConfig, validateBuildConfig, projectConfigUnionErrors } from './load-project-config';
import { stripPrivateBuildFields } from '../project-config';
import { resolveModules } from './detect-modules';
import { findGamesEntry } from './findGamesEntry';
import { resolveGcloudDir, deriveGcsBucketFromBaseUrl, OTA_SAFE_TOKEN, OTA_SAFE_BUCKET } from './backend/gcloud';
import { projectAssetRoots } from '../scripts/projectRoots.mjs';
import { listAndroidDevices, resolveBuildAndroidSerial } from './backend/androidDevices';
// Through the typed shell, not the .mjs directly: TypeScript consumers all enter the claim store
// by one door, so a future caller cannot pick up a differently-typed view of the same rules.
import { foreignClaimFor, describeConflict, adbDeviceId, adbSerialOf, iosDeviceId, ownAdbClaim } from './backend/deviceClaims';
import { acquireBuild, releasePolicy } from './backend/buildLock';
import { detect as detectTool, detectAdb, ensureNode, preflight as preflightBuild, install as installTool, isInstallable, cocoapodsEnv, goIosBinFor, wdaTeamId, writeToolchainSettings, type BuildTarget, type ToolId } from '../toolchain';
import { registerReimportHandler, type ReimportContext } from './reimport-registry';
import { textureReimportHandler } from './reimport-texture';
import { modelReimportHandler, resolvePostprocessorForId, validatePostprocessorRegistry, isRiggedMeta } from './reimport-model';
import { atlasReimportHandler } from './reimport-atlas';
import { audioReimportHandler } from './reimport-audio';
import { fontReimportHandler } from './reimport-font';
import { environmentReimportHandler } from './reimport-environment';
import { convertFont } from './font-convert';
import { getFontCacheDir, atlasCachePath, metricsCachePath, instanceCachePath } from './font-cache';
import { resolveFontSettings, FONT_ATLAS_SUFFIX, FONT_METRICS_SUFFIX, FONT_INSTANCE_SUFFIX, type FontImportSettings, type FontManifestBlock, type FontCacheInfo } from '../packages/modoki/src/runtime/core/fontSettings';
import { readMetaSidecar } from './meta-sidecar';
import { classifyJsonAssetSuffix, ID_BEARING_TYPES, BINARY_EXT_TYPE } from './assetTypes';
import { getCacheDir, cachePathFor } from './texture-cache';
import { getAudioCacheDir, audioCachePathFor } from './audio-cache';
import { convertAudio } from './audio-convert';
import { resolveAudioSettings, audioFormatExtension, audioVariantSuffix, type AudioImportSettings } from '../packages/modoki/src/runtime/loaders/audioSettings';
import type { AudioCacheInfo } from '../packages/modoki/src/runtime/loaders/audioSettings';
import { videoReimportHandler } from './reimport-video';
import { getVideoCacheDir, videoCachePathFor } from './video-cache';
import { convertVideo } from './video-convert';
import {
  resolveVideoSettings, videoVariantSuffix, VIDEO_EXTENSION,
  type VideoImportSettings, type VideoCacheInfo,
} from '../packages/modoki/src/runtime/loaders/videoSettings';
import { resolveEnvSettings, ENV_VARIANT_SUFFIX, ULTRAHDR_VARIANT_SUFFIX, envVariantSuffix, type EnvImportSettings, type EnvManifestBlock, type EnvCacheInfo } from '../packages/modoki/src/runtime/core/environmentSettings';
import { convertEnvironment } from './env-convert';
import { getEnvCacheDir, envCachePathFor } from './env-cache';
import { atlasPageUrlPath } from './atlas-cache';
import { getModelCacheDir, lodCachePath } from './model-cache';
import { convertTexture } from './texture-convert';
import { convertModel } from './model-convert';
import { convertRiggedModel } from './rigged-model-optimize';
import { resolveTextureSettings, resolveTextureType, variantSuffix, variantsToEmit, sizesToEmit, type TextureImportSettings, type TextureType, type TextureVariant } from '../packages/modoki/src/runtime/loaders/textureSettings';
import { isPlayableBuild, playableTextureSettings, playableEnvSettings } from './playable-profile';
import { shouldEmitTextureTierVariants } from './textureTierEmit';
import { deriveGuid } from '../packages/modoki/src/runtime/core/assetRefRules';
import { resolveModelSettings, lodUrlSuffix, type ModelImportSettings, type ModelCacheInfo } from '../packages/modoki/src/runtime/loaders/modelSettings';
import { type SpriteSlice, type SpriteAssetRef } from '../packages/modoki/src/runtime/loaders/spriteSheet';
import { type AtlasCacheBlock } from '../packages/modoki/src/runtime/loaders/spriteAtlas';
import { type SceneSchema } from '../packages/modoki/src/runtime/loaders/sceneValidation';
import { handleBackendRequest, type BackendContext, type BackendResult } from './backend/editorBackendRouter';
import { reclaimStaleDeviceStateAtStartup } from './backend/deviceConnection';
import { vendorEnginePlugins, writeVendorMarker } from './vendorPlugins';
import { spawnBuildCommand, killBuildProcess, resolveBuildStep, type BuildStep } from './buildStepShell';
import { healNativeConfig } from './healNativeConfig';
import {
  parseBuildVariant, keystoreRefusal, renderKeystoreProperties, renderExportOptionsPlist,
  androidReleaseSteps, iosReleaseSteps, debugBuildReleaseWarning,
  IOS_EXPORT_OPTIONS_PATH, IOS_EXPORT_DIR, ANDROID_AAB_PATH, ANDROID_RELEASE_APK_PATH,
} from './releaseBuild';
import { PROJECT_USER_CONFIG_FILENAME } from '../project-config';
import { iconIsUpToDate, iconStampValue } from './iconAssets';
import { ensureCapacitorDeps, scaffoldNativeTarget, isNativeTargetScaffolded, type NativePlatform } from './addNativeTarget';
import { discoverSigningTeams, type SigningTeam } from './signingTeams';
import { serveProjectAsset } from './backend/staticAssets';
import { writeBackendResult } from './backend/writeResult';



// The editor's OWN built-in engine assets (fonts, favicon). Resolved from this
// plugin file (engine/plugins/) so findAssetRoots can serve them even when the
// open project is an external folder that has no engine/ of its own.
//
// import.meta.url is the real file URL in the Vite ESM plugin context. This
// module also gets bundled into the esbuild CJS Electron backend, where
// import.meta.url is undefined — fall back to '' there (the font fallback is
// unused on that path: the Vite dev server serves engine fonts in dev, and a
// repo-rooted backend resolves them via the projectRoot branch below).
const EDITOR_MODOKI_ASSETS = (() => {
  try {
    const metaUrl = (import.meta as { url?: string })?.url;
    if (!metaUrl) return '';
    return path.resolve(path.dirname(fileURLToPath(metaUrl)), '../packages/modoki/src/runtime/assets');
  } catch {
    return '';
  }
})();

// Engine package source root (engine/packages/modoki/src) + repo root, derived
// from this file's location (engine/plugins/). Used to give the BUILD-time Stage A
// postprocessor SSR server the `@modoki/engine` alias + fs access it needs — that
// server has `configFile: false` rooted at the project, so it inherits none of
// engine/vite.config.ts's resolution. '' when import.meta.url is unavailable (the
// esbuild CJS backend bundle), which never runs the build-time bake.
const ENGINE_PKG_SRC = (() => {
  try {
    const metaUrl = (import.meta as { url?: string })?.url;
    if (!metaUrl) return '';
    return path.resolve(path.dirname(fileURLToPath(metaUrl)), '../packages/modoki/src');
  } catch { return ''; }
})();
// src → modoki → packages → engine → <repo>
const ENGINE_REPO_ROOT = ENGINE_PKG_SRC ? path.resolve(ENGINE_PKG_SRC, '../../../..') : '';

const PROJECT_CONFIG_VIRTUAL_ID = 'virtual:modoki-project-config';
const PROJECT_CONFIG_RESOLVED_ID = '\0' + PROJECT_CONFIG_VIRTUAL_ID;

// The open project's game(s). The engine imports games through this virtual
// module rather than a hard-coded path, so it stays game-agnostic: the plugin
// synthesizes the set from whichever project is open (`<projectRoot>/game.ts`,
// one project = one game). A project with no game.ts gets an empty set.
const GAMES_VIRTUAL_ID = 'virtual:modoki-games';
const GAMES_RESOLVED_ID = '\0' + GAMES_VIRTUAL_ID;

/** Source of the `virtual:modoki-games` module for the open project (one project = one
 *  game, #29). Pure so the Windows separator handling is unit-testable from any host.
 *  MUST forward-slash the path: on Windows entry.path is `C:\…\game.ts`, and JSON.stringify
 *  ESCAPES backslashes (`\\`) rather than converting them — so a bare embed emits
 *  `import { game } from "C:\\…\\game"`, a backslash specifier Vite/Rollup can't resolve
 *  (ESM specifiers are POSIX). No game.ts → empty sets so the engine still mounts. */
export function gamesModuleSource(entry: { kind: string; path: string } | null | undefined): string {
  if (entry?.kind === 'single') {
    const noExt = entry.path.replace(/\.tsx?$/, '').replace(/\\/g, '/');
    return `import { game } from ${JSON.stringify(noExt)};\nexport const ALL_GAMES = [game];\nexport const GAMES = [game];\n`;
  }
  return `export const ALL_GAMES = [];\nexport const GAMES = [];\n`;
}

interface AssetEntry {
  guid?: string;
  path: string;
  name: string;
  type: string;
  /** Internal: absolute filesystem path. Used by collision auto-heal to rewrite
   *  the source file's id; stripped from the serialized manifest. */
  absPath?: string;
  /** Baked texture import settings (texture assets that have been converted) —
   *  lets the runtime resolver pick a variant + configure the texture. */
  texture?: TextureImportSettings;
  /** Authored texture usage type (`3d`/`2d`/`ui`) — drives 2D reference type-checking. */
  textureType?: TextureType;
  /** Baked model import settings + cache info (model assets that have been
   *  converted) — lets the runtime mesh-template cache build a `THREE.LOD`
   *  without reading the meta sidecar separately. */
  model?: ModelImportSettings;
  modelCache?: ModelCacheInfo;
  /** Model postprocessor id (from the `.meta.json` `postprocessor` field) — the
   *  rigged/skinned loader reads this to apply `filterMesh` (e.g. drop a baked
   *  ground "Plane"), since a SkinnedModel has no ModelSource trait to carry it. */
  postprocessor?: string;
  /** Content hash of the converted asset — appended to served variant URLs as
   *  `?v=<hash>` so a re-import busts immutable browser/CDN caches. */
  hash?: string;
  /** Sliced-sprite block (`'sprite'` sub-entries derived from a texture's
   *  `.meta.json` `sprites[]`) — the parent texture GUID + rect/pivot. */
  sprite?: SpriteAssetRef;
  /** Built-atlas block (`'atlas'` assets) — page hashes/dims + frame map, read from
   *  the atlas's `.meta.json` sidecar. Absent until the atlas is packed. */
  atlas?: AtlasCacheBlock;
  /** Baked audio block (`'audio'` assets) — the `loadType` (buffer/stream) fork
   *  always, plus the converted variant's `ext` once the clip has been through the
   *  ffmpeg converter (so the runtime resolver can build the `~audio.<ext>` URL). */
  audio?: { loadType?: 'buffer' | 'stream'; format?: string; ext?: string };
  /** Baked video block (`'video'` assets) — the delivery fork (`delivery`/`policy`)
   *  always, plus the converted variant's `ext` + measured `bytes`/`durationSec` once
   *  the clip has been through the ffmpeg converter. `bytes` is load-bearing, not
   *  cosmetic: it resolves `policy: 'auto'` and feeds the per-game remote-footprint
   *  budget, so the runtime must not have to fetch the file to learn its size. */
  video?: {
    delivery?: 'bundled' | 'remote';
    policy?: 'stream' | 'download' | 'auto';
    /** Where a remote clip's bytes live. Host MUST send CORS — see videoSettings. */
    remoteUrl?: string;
    ext?: string;
    bytes?: number;
    durationSec?: number;
    width?: number;
    height?: number;
    hasAudio?: boolean;
  };
  /** Baked font block (`'font'` assets) — mode/fieldType/distanceRange + atlas dims,
   *  written at build time once the font has been through msdf-atlas-gen (so the
   *  runtime resolves the `~atlas.png`/`~metrics.json` variants + picks a provider). */
  font?: FontManifestBlock;
  /** Baked environment block (`'environment'` HDR assets) — present once the HDR has
   *  been downscaled (environmentCache set), so the runtime resolver builds the
   *  `~env.hdr` variant URL instead of loading the multi-MB source. */
  environment?: EnvManifestBlock;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isGuidShape = (s: unknown): s is string => typeof s === 'string' && GUID_RE.test(s);
// An "ID_BEARING_TYPES" JSON asset stamps its guid into a top-level `id` field —
// only possible when the parsed JSON is a plain object. A top-level ARRAY (e.g. a
// hand-authored level-index manifest that isn't itself one of the recognized JSON
// asset kinds) silently drops non-index properties on JSON.stringify, so `json.id =
// guid` writes nothing back to disk while still reporting success. Anything that
// isn't a stampable object falls back to the same `<file>.meta.json` sidecar used
// by binary assets instead.
const isStampableObject = (json: unknown): json is Record<string, unknown> =>
  !!json && typeof json === 'object' && !Array.isArray(json);

/** Read the GUID for an asset file.
 *  - JSON assets (.mesh/.mat/.prefab/.scene/.animset): top-level `id` field.
 *  - Binary assets: sidecar `<file>.meta.json` with `{ id }`.
 *  Returns undefined if the file has no id yet (pre-migration). */
export function readAssetGuid(absPath: string, type: string): string | undefined {
  try {
    if (ID_BEARING_TYPES.has(type)) {
      const json = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
      if (isStampableObject(json)) return isGuidShape(json?.id) ? json.id : undefined;
      // Top-level array (or other non-object shape, e.g. a level-index manifest) —
      // falls through to the sidecar below, mirroring writeAssetGuid's fallback.
    }
    // Binary (or non-object ID-bearing JSON): read sidecar
    const sidecar = absPath + '.meta.json';
    if (!fs.existsSync(sidecar)) return undefined;
    const meta = JSON.parse(fs.readFileSync(sidecar, 'utf-8'));
    return isGuidShape(meta?.id) ? meta.id : undefined;
  } catch {
    return undefined;
  }
}

/** Atomic write: tmp file + rename. Same pattern as `plugins/meta-sidecar.ts`,
 *  inlined to avoid a circular import with this module. */
function writeJsonAtomic(absPath: string, json: unknown): void {
  const tmp = absPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2));
  fs.renameSync(tmp, absPath);
}

/** Copy the three.js Basis transcoder (KTX2Loader runtime dep) into `dist/basis`.
 *  Needed by every build that renders KTX2 textures — the game web build and the
 *  editor build alike. No-op if three isn't present. */
function shipBasisTranscoder(projectRoot: string, distDir: string, ...fallbackRoots: string[]): void {
  // Resolve three's transcoder from the project's node_modules, falling back to
  // the editor root's. A FLAT in-repo project (projectRoot = games/<id>) has no
  // node_modules of its own — three lives at the editor/repo root — so without
  // the fallback dist/basis is never written and the deployed build 404s on
  // /basis/basis_transcoder.{js,wasm}, failing every KTX2 texture.
  const basisSrc = [projectRoot, ...fallbackRoots]
    .map((r) => path.join(r, 'node_modules/three/examples/jsm/libs/basis'))
    .find((p) => fs.existsSync(p));
  if (!basisSrc) return;
  const basisDest = path.join(distDir, 'basis');
  fs.mkdirSync(basisDest, { recursive: true });
  for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
    const s = path.join(basisSrc, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(basisDest, f));
  }
}

/** Copy the PixiJS KTX2 transcoder (libktx — `loadKTX2`'s runtime dep) into
 *  `dist/pixi-ktx`, mirroring {@link shipBasisTranscoder}. Needed by every build
 *  that renders KTX2 *sprites* (2D path). Bundled in pixi.js's `transcoders/` dir;
 *  falls back to the editor root for FLAT projects with no local node_modules. */
function shipPixiKtxTranscoder(projectRoot: string, distDir: string, ...fallbackRoots: string[]): void {
  const ktxSrc = [projectRoot, ...fallbackRoots]
    .map((r) => path.join(r, 'node_modules/pixi.js/transcoders/ktx'))
    .find((p) => fs.existsSync(p));
  if (!ktxSrc) return;
  const ktxDest = path.join(distDir, 'pixi-ktx');
  fs.mkdirSync(ktxDest, { recursive: true });
  for (const f of ['libktx.js', 'libktx.wasm']) {
    const s = path.join(ktxSrc, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(ktxDest, f));
  }
}

/** Write a fresh GUID into an asset's source file (JSON `id`) or its sidecar
 *  (`<file>.meta.json` for binaries). Returns true on success. Used by collision
 *  auto-heal. Preserves the existing JSON shape, only replacing `id`. Atomic —
 *  a crash mid-write leaves the old file intact so we don't lose either the
 *  asset's id or its sidecar metadata. */
export function writeAssetGuid(absPath: string, type: string, guid: string): boolean {
  try {
    if (ID_BEARING_TYPES.has(type)) {
      const json = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
      if (isStampableObject(json)) {
        json.id = guid;
        writeJsonAtomic(absPath, json);
        return true;
      }
      // Not a stampable object (e.g. a top-level array) — fall through to the
      // sidecar branch below instead of silently no-op'ing via JSON.stringify.
    }
    const sidecar = absPath + '.meta.json';
    let meta: Record<string, unknown> = { version: 2 };
    if (fs.existsSync(sidecar)) {
      try { meta = JSON.parse(fs.readFileSync(sidecar, 'utf-8')); } catch { /* recreate */ }
    }
    meta.id = guid;
    writeJsonAtomic(sidecar, meta);
    return true;
  } catch {
    return false;
  }
}

/** Known asset roots: maps URL prefix → absolute directory path.
 *  Built by findAssetRoots() at startup. */
export interface AssetRoot {
  urlPrefix: string;   // e.g., "/modoki/assets" or "/games/3d-test/assets"
  absDir: string;      // absolute filesystem path to the assets/ directory
}

const EXT_TYPE: Record<string, string> = {
  // Shared shippable binary kinds (single source of truth — assetTypes.ts), so the
  // scanner and the build tree-shaker can't disagree on a binary asset's type.
  ...BINARY_EXT_TYPE,
  // Scanner-only import sources: OBJ/DAE are convertible model sources classified as
  // 'model' so the Assets panel offers "Import Model" (normalized to GLB on import).
  // They are NOT in BINARY_EXT_TYPE because scenes reference the converted GLB, never
  // the source — the tree-shaker must not try to ship them.
  '.obj': 'model', '.dae': 'model',
};

/** Strip a filename's asset suffix for display-name derivation. `.scene.json`
 *  carries TWO dots, so naively stripping just the last extension leaves the
 *  middle segment behind (`main.scene.json` → `main.scene`, displayed as
 *  "Main.Scene") — a regression introduced by issue #54's `.scene.json`
 *  migration, since scenes previously had no compound suffix to strip. Handled
 *  narrowly here (only `.scene.json`, not a general compound-suffix table): the
 *  other JSON asset kinds (`.prefab.json`, `.mesh.json`, …) already strip only the
 *  last extension today, pre-existing behavior this migration leaves untouched. */
function stripAssetSuffix(filename: string): string {
  if (filename.endsWith('.scene.json')) return filename.slice(0, -'.scene.json'.length);
  return filename.replace(/\.[^.]+$/, '');
}

/** Derive a human-readable name from a filename */
function nameFromFile(filename: string): string {
  return stripAssetSuffix(filename)
    .replace(/[_-]/g, ' ')           // underscores/hyphens → spaces
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → spaces
    .replace(/\b\w/g, c => c.toUpperCase()) // capitalize words
    .trim();
}

/** Detect type from file extension + directory convention */
export function detectType(relPath: string, ext: string): string | null {
  // Both sidecar forms are METADATA about an asset, never assets themselves. The
  // `.meta.local.json` half (gitignored machine-local byte-stats — see meta-sidecar.ts)
  // must be listed explicitly: it does NOT end with `.meta.json`, so it used to fall
  // through to the `.json` catch-all below and get classified as a SCENE, which minted a
  // GUID into it and registered it in the manifest as a scene.
  if (relPath.endsWith('.meta.json') || relPath.endsWith('.meta.local.json')) return null;
  // Committed UltraHDR variant (`<src>.hdr~ultrahdr.jpg`) — a DERIVED file next to its
  // source HDR, NOT a standalone texture asset. Exclude it from the scan (else it'd be
  // classified `.jpg` → texture and get its own meta/manifest entry).
  if (relPath.endsWith(ULTRAHDR_VARIANT_SUFFIX)) return null;
  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') return null;
  if (ext === '.css') return null;

  if (ext === '.json') {
    if (relPath.endsWith('.layout.json')) return 'layout';
    // Shared JSON asset-kind classifier (see plugins/assetTypes.ts) — the single
    // list the tree-shaker's classify() also uses, so the two can't drift. Scenes
    // are matched here too, by the `.scene.json` suffix (issue #54).
    const jsonAssetType = classifyJsonAssetSuffix(relPath);
    if (jsonAssetType) return jsonAssetType;
    // LEGACY fallback (issue #54): before the `.scene.json` suffix existed, a scene
    // was any plain `.json` under a `/scenes/` directory (or a top-level `scene.json`).
    // Keep honoring that convention so an externally-authored OSS project, or an
    // already-published demo snapshot, whose scenes are still plain `.json` under
    // `/scenes/` keeps working. New scenes are always `.scene.json`.
    if (relPath.includes('/scenes/') || relPath.endsWith('/scene.json')) return 'scene';
    if (relPath.includes('/materials/')) return 'material';
    return null;
  }
  return EXT_TYPE[ext] || null;
}

/** Decide whether a changed `.json` file should trigger a live hot-reload
 *  broadcast, and as what kind. The watcher (`onChange`) classifies via the same
 *  `detectType` the scanner uses: a `'scene'` verdict is now positively identified
 *  (the `.scene.json` suffix, or the legacy `/scenes/` directory convention —
 *  issue #54), so it can be trusted directly, no separate refinement needed.
 *  `prefab` always broadcasts. Returns null for everything else (no broadcast).
 *  `rel` is the forward-slash relative/url path. Pure — exported for unit testing. */
/** What a watched .json change asks the live renderer to do. 'scene'/'prefab' hot-reload the
 *  world; 'animation', 'timeline' and 'particle' only invalidate their asset cache (reloading
 *  the scene would be wrong — and would discard unsaved work). */
export type LiveReloadKind = 'scene' | 'prefab' | 'animation' | 'timeline' | 'particle' | 'spriteanim' | 'rig2d' | 'animset';

export function classifySceneChange(rel: string): LiveReloadKind | null {
  const type = detectType(rel, '.json');
  if (type === 'prefab') return 'prefab';
  // An .anim.json edit must INVALIDATE the renderer's animation-clip cache. Without this
  // the cache held the pre-edit clip forever (invalidateAnimationClip had ZERO callers), so
  // a read-modify-write tool like anim_add_key re-read the STALE clip and wrote it back —
  // silently REVERTING whatever had just been written to the file. That hits both
  // modoki_write_asset and the headline case for this whole feature: the user's own Claude
  // Code editing the .anim.json with a plain file Write. (C7)
  if (type === 'animation') return 'animation';
  // A .timeline.json edit must INVALIDATE the renderer's timeline cache, for exactly the same
  // reason (and with exactly the same history) as the animation clip above: `invalidateTimeline`
  // was exported, tested, and had ZERO production callers, so `timelineCache` held the pre-edit
  // definition forever. The failure mode is especially misleading — the OLD markers keep firing
  // on schedule, so captions still update and effects still toggle; it just looks like the new
  // marker params are ignored. Only a renderer reload cleared it.
  if (type === 'timeline') return 'timeline';
  // A .particle.json edit must invalidate `particleCache` for the THIRD instance of the same
  // defect (independent review, 2026-07-30): `invalidateParticleEffect` was exported and had
  // ZERO production callers, so the cache held the pre-edit def forever. Animation and timeline
  // each got this case after the same bug; particle was simply missed. It matters more here than
  // it looks, because `read_asset_def` reports the LIVE cache as authoritative (`source:'live'`)
  // — so after a `modoki_write_asset` the read tool handed back the OLD document, and any
  // read-modify-write reverted the file that had just been written.
  if (type === 'particle') return 'particle';
  // `.spriteanim.json` / `.rig2d.json` — the FOURTH and FIFTH instances of the same defect as the
  // three above (#74). Both invalidators were exported, tested, and had ZERO production callers,
  // because `detectType` typed the files correctly while this function had no case for them, so the
  // verdict fell through to `null` and no broadcast ever fired. Everything downstream then held the
  // pre-edit definition forever — worst on the read-modify-write path, where `read_asset_def`
  // reports the live cache as authoritative, so a write followed by a read hands back the OLD
  // document and the round-trip reverts the file that was just written.
  if (type === 'spriteanim') return 'spriteanim';
  if (type === 'rig2d') return 'rig2d';
  // `.animset.json` — the SIXTH, and NOT the same shape as the five above, which is why it
  // survived the guard they left behind. `invalidateAnimSet` is not an orphan: the Inspector's
  // own `AnimSetAssetView` drives it through `assetViews/persist.ts`. So an animset edited IN
  // THE EDITOR has always invalidated correctly, and only the EXTERNAL-write half was dead —
  // `modoki_write_asset`, or the user's own Claude Code editing the file with a plain Write,
  // which is the headline case this whole broadcast exists for. The cache then kept the
  // pre-edit clip params (speed/loop/fade) and the skinned model went on playing them.
  //
  // ⚠️ `liveReloadKinds.test.ts` could not catch this one: it cross-checks the PRODUCER union
  // against the CONSUMER union, and `animset` was absent from BOTH, so the two agreed with each
  // other while agreeing on the wrong set. `invalidatorsAreReachable.test.ts` is the guard that
  // closes that blind spot, by asking the question from the invalidator's end instead.
  if (type === 'animset') return 'animset';
  if (type === 'scene') return 'scene';
  return null;
}

/** True if `url` targets one of the SSE routes (which own their own streaming
 *  handlers and MUST be excluded from the catch-all `/api/*` backend dispatch).
 *  Exact-match the bare route OR `route?query` so a sibling like `/api/build-status`
 *  is NOT swallowed by a prefix match, while a query-less `/api/build` still reaches
 *  its handler. Pure — exported for unit testing (D5 regression guard). */
export function isSseRoute(url: string, sseRoutes: string[]): boolean {
  return sseRoutes.some((r) => url === r || url.startsWith(r + '?'));
}

/** The build-platform values `/api/build?platform=` accepts. 'ios'/'android' are native (preflight
 *  a toolchain); 'web'/'playable' are toolless browser builds. Exported so the routing acceptance is
 *  unit-testable (the guard rejects anything else with a 400). */
export const BUILD_PLATFORMS = ['ios', 'android', 'web', 'playable'] as const;
export type BuildPlatform = typeof BUILD_PLATFORMS[number];
export function isValidBuildPlatform(p: string | null | undefined): p is BuildPlatform {
  return p != null && (BUILD_PLATFORMS as readonly string[]).includes(p);
}

/** How an iOS build gets its freshly-built `.app` onto the phone.
 *  - `devicectl`    — `xcrun devicectl device install|launch`, hands-free. iOS 17+ ONLY.
 *  - `go-ios`       — the provisioned `ios install|launch`, hands-free on iOS 12–16.
 *  - `xcode-handoff`— open the Xcode project and let the human press Run (⌘R). */
export type IosInstallMode = 'devicectl' | 'go-ios' | 'xcode-handoff';

/** The single decision behind an iOS device build: may it run, and how does it install?
 *
 *  ⚠️ **Only `iosDeviceId` is required**; `iosDevicectlId` is optional because `devicectl` is
 *  CoreDevice-only (iOS 17+) and a legacy device has no such id in existence. The two ids,
 *  where they live, and the Xcode-handoff fallback are documented in
 *  docs/build.md § "iOS Device" — don't restate them here.
 *
 *  `goIos` is "go-ios is present, or this editor can provision it" — the caller's answer, because
 *  it depends on the toolchain dir and the running platform, which a pure function can't see. It is
 *  consulted ONLY when devicectl can't be used: an iOS 17+ device stays on Apple's own tool, so we
 *  never need go-ios's sudo tunnel, and the ONE case go-ios serves is the one that used to demand a
 *  human at the keyboard.
 *
 *  Kept as one pure function, and exported, because these two answers must not drift apart:
 *  when the preflight required more than the step plan consumed, the guard rejected the very
 *  case the plan's own Xcode-handoff branch existed to serve. */
export function planIosInstall(o: { iosDeviceId: string; iosDevicectlId: string; goIos?: boolean }):
  | { ok: false; missing: 'iosDeviceId' }
  | { ok: true; mode: IosInstallMode } {
  if (!o.iosDeviceId.trim()) return { ok: false, missing: 'iosDeviceId' };
  if (o.iosDevicectlId.trim()) return { ok: true, mode: 'devicectl' };
  return { ok: true, mode: o.goIos ? 'go-ios' : 'xcode-handoff' };
}

/** /api/ota/publish only ever builds+publishes the CURRENTLY OPEN project as ITSELF — see
 *  the route's own comment and ota-updates.md's Gotchas for why an override to a different
 *  bundleName used to be a silent publish-corruption risk (it would ship this project's
 *  plain shell dist/ under a DIFFERENT bundle's identity). Pure — extracted so this
 *  invariant is unit-testable without a live editor/gcloud. */
export function otaPublishBundleNameAllowed(requestedBundleName: string, projectOtaBundleName: string): boolean {
  return requestedBundleName === projectOtaBundleName;
}

// otaSigningKeyRefusal moved to engine/scripts/ota/publishGuards.mjs (#582) — it now runs in
// TWO places (this route's own early check below, and ota-publish.mjs itself, the by-hand path
// this route's refusal message sends a human to), so it lives once and both import it.
export { otaSigningKeyRefusal } from '../scripts/ota/publishGuards.mjs';
import { otaSigningKeyRefusal } from '../scripts/ota/publishGuards.mjs';

/** The build steps for a `playable` target: the single-file inliner build (VITE_PLAYABLE=1 →
 *  games/<id>/ads/index.html) then reveal the ads/ dir. No favicon/deploy/native — the one HTML IS
 *  the artifact. Pure — extracted from the /api/build handler so the routing is unit-testable. */
export function playableBuildSteps(buildCwd: string, webCwd: string): BuildStep[] {
  const adsDir = path.join(webCwd, 'ads');
  return [
    { label: 'Building playable ad (single HTML)...', cmd: 'node engine/scripts/build-web.mjs --target playable', env: { VITE_PLAYABLE: '1' }, cwd: buildCwd },
    { label: 'Revealing ads/...', cmd: `open ${JSON.stringify(adsDir)}`, winCmd: `start "" "${adsDir}"`, cwd: webCwd },
  ];
}

/** Env for the OTA publish pipeline's `--target native` web-asset build step. Layers
 *  `MODOKI_OTA_PUBLISH=1` on top of the caller's (gcloud-augmented) base env — the trap
 *  `shouldEmitTextureTierVariants` exists to avoid: this step always passes `--target native`
 *  (an OTA bundle replaces the web content INSIDE an installed app, so it must be served from
 *  the app root, never the web sub-path — see the `--target native` comment above), which would
 *  otherwise be indistinguishable from a plain native package build that should NOT emit tier
 *  variants. Pure — extracted from the `/api/ota/publish` handler so this is unit-testable
 *  without spawning a real build. */
export function otaPublishBuildStepEnv(gcloudEnv: NodeJS.ProcessEnv, projectRoot: string): NodeJS.ProcessEnv {
  return { ...gcloudEnv, MODOKI_PROJECT: projectRoot, MODOKI_OTA_PUBLISH: '1' };
}

// resolveGcloudDir moved to ./backend/gcloud.ts (shared with editorBackendRouter.ts,
// which must stay host-agnostic / Vite-import-free) — re-exported here so existing
// imports of it from this module (incl. tests) keep working unchanged.
export { resolveGcloudDir };

/** Env for a /api/build step, prepending the toolchain-provisioned Node's bin dir to PATH so the
 *  step's bash `npm`/`npx`/`node` run on it. The build pipeline runs in THIS Vite process, which is
 *  spawned before main provisions Node (project-open) and can't inherit main's MODOKI_NODE — so
 *  main shares MODOKI_TOOLCHAIN_DIR + MODOKI_PROVISION_NODE (see main.ts) and we ensureNode() into
 *  the same dir here (idempotent). No-op (system Node) when provisioning isn't requested (dev
 *  without opt-in) or the download fails (offline). Awaited ONCE per build request. Exported for
 *  unit testing (the no-provision branches). */
export async function buildStepEnv(extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const base: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const dir = process.env.MODOKI_TOOLCHAIN_DIR;
  if (process.env.MODOKI_PROVISION_NODE !== '1' || !dir) return base;
  try {
    const { nodeBin, npmCli } = await ensureNode(path.join(dir, 'node'));
    const sep = process.platform === 'win32' ? ';' : ':';
    return { ...base, MODOKI_NODE: nodeBin, MODOKI_NPM_CLI: npmCli, PATH: `${path.dirname(nodeBin)}${sep}${base.PATH ?? ''}` };
  } catch {
    return base; // offline / provisioning failed → fall back to system Node
  }
}

/** Canonicalize a path for use as a self-write-guard key. Windows paths are
 *  case-INSENSITIVE on the drive letter and reach the guard through two spellings:
 *  the editor's save resolves an OPENED scene's `/@fs/<abs>` URL (whose drive-letter
 *  case comes from wherever that URL was minted — `path.resolve` preserves it, so a
 *  lowercase `e:` stays lowercase), while chokidar reports the SAME file with the
 *  drive case of the watched `absDir` (derived from `projectRoot`, typically
 *  uppercase `E:`). Keying the guard Map by the raw string then MISSES — the editor's
 *  own save looks external and bounces the live scene (the Windows Ctrl+S full-reload
 *  bug). Fold the drive letter to a single case and unify separators so both spellings
 *  collapse to one key. A no-op on POSIX paths (no drive letter, no backslashes), so
 *  Linux/macOS keying is unchanged. */
export function normalizeWriteGuardKey(absPath: string): string {
  return absPath.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
}

/** The self-write guard: scene/prefab files the editor just saved itself (via
 *  /api/write-file) are recorded here so the watcher skips the hot-reload broadcast
 *  for them — an editor Cmd+S must not bounce the live scene, while external edits
 *  (an agent's write, /api/scene-mutate) still reload. Gated by expiry only — NEVER
 *  delete on read, because chokidar emits several events per save (add+change,
 *  write+rename) and deleting on the first would let later events of the same save
 *  bounce the scene; the TTL covers the burst, and a second `mark` for the same
 *  file extends it. A self-cleaning timer drops entries that never re-fire a watcher
 *  event so the map can't leak. Factored out (+ injectable clock) for unit testing
 *  the TTL behavior (editor-core F9). */
export function createEditorWriteGuard(ttlMs = 1500, now: () => number = Date.now) {
  // Per path: the TTL expiry (fast path for chokidar's add+change burst) PLUS an
  // optional content fingerprint of the exact bytes the editor wrote. The hash is
  // the timing-independent fallback the fixed TTL couldn't give: if a rename event
  // lands AFTER the TTL (heavy disk latency, the F9 failure) but the file's current
  // bytes still equal what we wrote, it's unmistakably our own save — skip the
  // bounce. The instant the bytes diverge (a genuine external edit / agent write),
  // the fingerprint stops matching and the reload proceeds, so this can't mask a
  // real change. (editor-core F9)
  const recent = new Map<string, { exp: number; hash: string | null }>();
  const mark = (absPathRaw: string, hash: string | null = null) => {
    const absPath = normalizeWriteGuardKey(absPathRaw);
    recent.set(absPath, { exp: now() + ttlMs, hash });
    setTimeout(() => {
      const e = recent.get(absPath);
      // Drop expired entries — but keep a hash-tagged one resident past its TTL so
      // the timing-independent fingerprint check above still works for a very-late
      // rename. It's evicted by isWrite the moment the bytes diverge, or replaced by
      // the next mark; the residual set is bounded by the distinct files saved this
      // session (a handful of scenes/prefabs).
      if (e && e.exp <= now() && e.hash == null) recent.delete(absPath);
    }, ttlMs + 100);
  };
  const isWrite = (absPathRaw: string, currentHash?: () => string | null) => {
    const absPath = normalizeWriteGuardKey(absPathRaw);
    const e = recent.get(absPath);
    if (!e) return false;
    if (e.exp > now()) return true; // fast path: still inside the burst window
    if (e.hash != null && currentHash) {
      const cur = currentHash();
      if (cur != null && cur === e.hash) return true; // bytes still ours → self-write
      recent.delete(absPath); // diverged → a genuine external edit; stop guarding it
    }
    return false;
  };
  return { mark, isWrite };
}

/** In-flight browser-request bookkeeping for `requestBrowser` — the dev server
 *  relays an op over the HMR socket and awaits the browser's `modoki:response`.
 *  Factored out (with injectable timers) because the lifecycle is the regression-
 *  prone part: every request must settle EXACTLY once and never leak its timeout,
 *  across three exits — reply, timeout, and a synchronous send failure (socket mid-
 *  teardown). The IO (`ws.send`) is injected via the `send` callback so this is pure.
 *  See `requestBrowser` / the `modoki:response` handler in `configureServer`. */
export function createBrowserRequestRegistry(
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
) {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: unknown }>();

  /** Begin a request: allocate an id, arm the timeout, register the settlers, then
   *  run `send(id)` (the actual ws.send). If `send` throws, clean up immediately
   *  instead of leaking the timer + entry until the timeout fires. */
  function request(send: (id: number) => void, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = timers.set(() => {
        pending.delete(id);
        reject(new Error('timed out waiting for the browser — is the app open at the dev URL?'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        send(id);
      } catch (e) {
        timers.clear(timer);
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Settle a pending request from a browser reply. No-op (returns false) if the id
   *  is unknown or already settled — so a duplicate/late response can't double-reject. */
  function settle(id: number, result?: unknown, error?: string): boolean {
    const p = pending.get(id);
    if (!p) return false;
    timers.clear(p.timer);
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
    return true;
  }

  return { request, settle, get size() { return pending.size; } };
}

/** Handle `GET/POST /api/exit` — write the shutdown ack, then schedule the process
 *  exit AFTER the response flushes. Factored out (with injectable `scheduleExit` +
 *  `log`) so the response shape + ordering are unit-testable without the irreducible
 *  `process.exit` actually firing. The default schedules `process.exit(0)` 100ms out,
 *  matching the prior inline behavior. Dev-only by construction (this middleware only
 *  runs under `vite` dev). */
export function handleExitRequest(
  res: { setHeader: (k: string, v: string) => void; end: (body: string) => void },
  opts?: { scheduleExit?: () => void; log?: (msg: string) => void },
): void {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, message: 'Vite dev server shutting down' }));
  // eslint-disable-next-line no-console
  (opts?.log ?? ((m) => console.log(m)))('[asset-scanner] /api/exit received — shutting down.');
  (opts?.scheduleExit ?? (() => { setTimeout(() => process.exit(0), 100); }))();
}

/** Recursively scan a directory for asset files, attaching a GUID when present. */
function scanDir(dir: string, base: string, urlPrefix: string): AssetEntry[] {
  const assets: AssetEntry[] = [];
  if (!fs.existsSync(dir)) return assets;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      assets.push(...scanDir(fullPath, base, urlPrefix));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      const relPath = (urlPrefix + '/' + path.relative(base, fullPath).replace(/\\/g, '/'))
        .normalize('NFC');
      const type = detectType(relPath, ext);
      if (!type) continue;

      const guid = readAssetGuid(fullPath, type);
      // Bake import settings for converted textures so the runtime resolver can
      // pick a variant without a per-file meta fetch. Only set when a conversion
      // exists (textureCache present) — otherwise the runtime uses the source PNG.
      let texture: TextureImportSettings | undefined;
      let model: ModelImportSettings | undefined;
      let modelCache: ModelCacheInfo | undefined;
      let postprocessor: string | undefined;
      // Content hash of the converted asset → appended to served variant URLs as
      // `?v=<hash>` so a re-import busts immutable browser/CDN caches.
      let hash: string | undefined;
      // Sliced sprites carved out of a texture (texture "multiple" mode) — each
      // becomes its own `'sprite'` sub-entry pointing at the parent texture GUID.
      let sprites: SpriteSlice[] | undefined;
      let sheet: { width: number; height: number } | undefined;
      // A 2D/UI texture's authored type + converted dims — used to auto-emit a
      // whole-image `'sprite'` sub-entry (so every 2D texture is sprite-referenceable
      // and atlas-able) when it has no explicit slices.
      let textureType: TextureType | undefined;
      let texDims: { w: number; h: number } | undefined;
      // 9-slice border insets authored on a UI texture — carried onto its auto
      // whole-image sprite so `UINode` can emit a CSS `border-image`.
      let texBorder: { l: number; r: number; t: number; b: number; scale?: number } | undefined;
      // Built-atlas bookkeeping (page hashes/dims + frame map) from the atlas sidecar.
      let atlas: AtlasCacheBlock | undefined;
      // Baked audio block — loadType always (drives the runtime buffer/stream fork,
      // even for unconverted source clips); format+ext only once converted.
      let audio: { loadType?: 'buffer' | 'stream'; format?: string; ext?: string } | undefined;
      // Baked video block — delivery/policy always (they drive the runtime
      // bundled-vs-fetched and stream-vs-download forks even for an unconverted
      // source); ext + measured size only once converted.
      let video: AssetEntry['video'] | undefined;
      // Baked font block — mode (baked/dynamic) drives runtime provider selection;
      // fieldType/distanceRange/atlas dims feed the shader + variant URLs.
      let font: FontManifestBlock | undefined;
      // Baked environment block — present once the HDR has been downscaled
      // (environmentCache set), so the runtime resolves the `~env.hdr` variant URL.
      let environment: EnvManifestBlock | undefined;
      if (type === 'texture') {
        const meta = readMetaSidecar(fullPath);
        if (meta.textureCache) {
          texture = resolveTextureSettings(meta as { type?: TextureType; texture?: Partial<TextureImportSettings> });
          hash = (meta.textureCache as { hash?: string }).hash;
          // Prefer the ORIGINAL source dims: the auto whole-image sprite carves from
          // the source file, whose size can differ from the converted (mult-of-4
          // snapped / maxSize-downscaled) dims. Fall back to converted for legacy
          // metas that predate srcWidth/srcHeight.
          const tc = meta.textureCache as { width?: number; height?: number; srcWidth?: number; srcHeight?: number };
          const w = tc.srcWidth ?? tc.width, h = tc.srcHeight ?? tc.height;
          if (w && h) texDims = { w, h };
        }
        textureType = resolveTextureType(meta as { type?: TextureType; texture?: Partial<TextureImportSettings> });
        const b = (meta as { border?: { l?: number; r?: number; t?: number; b?: number; scale?: number } }).border;
        if (b && [b.l, b.r, b.t, b.b].some((n) => typeof n === 'number' && n > 0)) {
          texBorder = {
            l: b.l || 0, r: b.r || 0, t: b.t || 0, b: b.b || 0,
            ...(b.scale && b.scale > 0 && b.scale !== 1 ? { scale: b.scale } : {}),
          };
        }
        const metaSprites = (meta as { sprites?: SpriteSlice[] }).sprites;
        if (Array.isArray(metaSprites) && metaSprites.length > 0) sprites = metaSprites;
        const metaSheet = (meta as { spriteSheet?: { width: number; height: number } }).spriteSheet;
        if (metaSheet && metaSheet.width > 0 && metaSheet.height > 0) sheet = metaSheet;
      } else if (type === 'model') {
        // Bake model import settings + cache info so the runtime mesh-template
        // cache can decide whether to wrap a mesh in `THREE.LOD` without an extra
        // sidecar fetch. Only set when modelCache is present (i.e. the model has
        // been through the new pipeline at least once); otherwise the runtime
        // falls back to single-mesh load + the legacy runtime fixupMesh path.
        const meta = readMetaSidecar(fullPath);
        if (meta.modelCache) {
          model = resolveModelSettings(meta as { model?: Partial<ModelImportSettings> });
          modelCache = meta.modelCache as ModelCacheInfo;
          hash = (meta.modelCache as ModelCacheInfo).hash;
        }
        // Postprocessor id (rigged models have no ModelSource trait to carry it).
        if (typeof meta.postprocessor === 'string' && meta.postprocessor !== 'none') {
          postprocessor = meta.postprocessor;
        }
      } else if (type === 'atlas') {
        // The atlas's derived pages/frames live in its `.meta.json` sidecar (written
        // by the atlas reimport handler). Absent until first pack — members then
        // resolve to their source sprite.
        const meta = readMetaSidecar(fullPath);
        const cache = (meta as { atlasCache?: AtlasCacheBlock }).atlasCache;
        if (cache && Array.isArray(cache.pages) && cache.frames) { atlas = cache; hash = cache.hash; }
      } else if (type === 'audio') {
        // Bake the loadType fork always; the converted-variant ext + content hash
        // only once the clip has been through the ffmpeg converter (audioCache set).
        const meta = readMetaSidecar(fullPath);
        const a = (meta as { audio?: Partial<AudioImportSettings> }).audio;
        const cache = (meta as { audioCache?: AudioCacheInfo }).audioCache;
        if (a || cache) {
          // Playable: force `buffer` (decodeAudioData → AudioBufferSourceNode) regardless of the
          // authored loadType. A `stream` clip plays via HTMLMediaElement, whose autoplay/gesture
          // re-kick is unreliable in ad webviews (Android WebView: music stays silent until a full
          // reload). Buffer clips route through the resumed AudioContext like SFX and just work.
          audio = { loadType: isPlayableBuild() ? 'buffer' : a?.loadType };
          if (cache) {
            const settings = resolveAudioSettings(meta as { audio?: Partial<AudioImportSettings> });
            audio.format = settings.format;
            audio.ext = cache.ext ?? audioFormatExtension(settings.format);
            hash = cache.hash;
          }
        }
      } else if (type === 'video') {
        // Bake the delivery fork always; the converted-variant ext + measured size
        // only once the clip has been through the ffmpeg converter (videoCache set).
        const meta = readMetaSidecar(fullPath);
        const v = (meta as { video?: Partial<VideoImportSettings> }).video;
        const cache = (meta as { videoCache?: VideoCacheInfo }).videoCache;
        if (v || cache) {
          const settings = resolveVideoSettings(meta as { video?: Partial<VideoImportSettings> });
          video = {
            delivery: settings.delivery, policy: settings.policy,
            // Carried for a remote clip only — it's where the bytes come from, and
            // without it "remote" silently degrades to the local path.
            ...(settings.delivery === 'remote' && settings.remoteUrl ? { remoteUrl: settings.remoteUrl } : {}),
          };
          if (cache) {
            video.ext = cache.ext ?? VIDEO_EXTENSION;
            // Size/duration are what let `policy: 'auto'` decide without a network
            // round-trip, so carry them even though they read as "stats".
            if (cache.bytes != null) video.bytes = cache.bytes;
            if (cache.durationSec != null) video.durationSec = cache.durationSec;
            if (cache.width != null) video.width = cache.width;
            if (cache.height != null) video.height = cache.height;
            if (cache.hasAudio != null) video.hasAudio = cache.hasAudio;
            hash = cache.hash;
          }
        }
      } else if (type === 'font') {
        // Font `mode` (baked vs dynamic) selects the runtime provider — without this
        // the manifest entry has no `font` block and every font loads baked. Always
        // emit the block when the meta carries settings; the content hash (cache-bust
        // for the ~atlas/~metrics variants) comes from fontCache once baked.
        const meta = readMetaSidecar(fullPath);
        const f = (meta as { font?: Partial<FontImportSettings> }).font;
        const cache = (meta as { fontCache?: FontCacheInfo }).fontCache;
        if (f || cache) {
          const settings = resolveFontSettings(meta as { font?: Partial<FontImportSettings> });
          font = {
            mode: settings.mode,
            fieldType: settings.fieldType,
            distanceRange: settings.pxRange,
            // Dev serves every variant off the content cache, so an axis-bearing font
            // always HAS its `~instance.ttf` here — the flag just tells the dynamic
            // loader to fetch that rather than the un-instanced source.
            ...(Object.keys(settings.variationAxes ?? {}).length > 0 ? { instanced: true } : {}),
            // Dynamic-only: the runtime generator needs the authored knobs the baked
            // path consumes at build time. Omitted for baked fonts (dead weight).
            ...(settings.mode === 'dynamic' ? {
              size: settings.size,
              atlasMax: settings.atlasMax,
              charset: settings.charset,
              ...(settings.customChars ? { customChars: settings.customChars } : {}),
            } : {}),
            ...(cache?.atlasWidth && cache?.atlasHeight ? { atlasWidth: cache.atlasWidth, atlasHeight: cache.atlasHeight } : {}),
          };
          if (cache?.hash) hash = cache.hash;
        }
      } else if (type === 'environment') {
        // Emit the environment block only once the HDR has been downscaled
        // (environmentCache set); its content hash cache-busts the ~env.hdr variant.
        // Until then the runtime loads the raw source HDR.
        const meta = readMetaSidecar(fullPath);
        const cache = (meta as { environmentCache?: EnvCacheInfo }).environmentCache;
        if (cache) {
          const settings = resolveEnvSettings(meta as { environment?: Partial<EnvImportSettings> });
          environment = { format: settings.format, maxSize: settings.maxSize };
          if (cache.hash) hash = cache.hash;
        }
      }
      assets.push({
        ...(guid ? { guid } : {}),
        path: relPath,
        name: nameFromFile(entry.name),
        type,
        absPath: fullPath,
        ...(texture ? { texture } : {}),
        ...(textureType && type === 'texture' ? { textureType } : {}),
        ...(model ? { model } : {}),
        ...(modelCache ? { modelCache } : {}),
        ...(postprocessor ? { postprocessor } : {}),
        ...(hash ? { hash } : {}),
        ...(atlas ? { atlas } : {}),
        ...(audio ? { audio } : {}),
        ...(video ? { video } : {}),
        ...(font ? { font } : {}),
        ...(environment ? { environment } : {}),
      });
      // Emit a `'sprite'` sub-entry per slice. No absPath (no file of its own) so the
      // collision-heal skips it; its GUID lives in the parent texture's meta. The
      // synthetic `path#guid` keeps each slice unique in the path index.
      if (sprites && guid) {
        for (const s of sprites) {
          if (!isGuidShape(s.guid)) continue;
          const spriteRef: SpriteAssetRef = {
            texture: guid, name: s.name, rect: s.rect, pivot: s.pivot,
            ...(s.border ? { border: s.border } : {}),
            ...(sheet ? { sheetW: sheet.width, sheetH: sheet.height } : {}),
          };
          assets.push({
            guid: s.guid,
            path: `${relPath}#${s.guid}`,
            name: s.name || nameFromFile(entry.name),
            type: 'sprite',
            sprite: spriteRef,
          });
        }
      } else if (guid && texDims && (textureType === '2d' || textureType === 'ui')) {
        // No explicit slices → auto-emit ONE whole-image `'sprite'` for a 2D/UI
        // texture. This is what lets 2D content reference a sprite (not the raw
        // texture) and be atlas-able with the packer unchanged. The GUID is
        // DERIVED from the texture GUID (stable across scans, so migrated refs
        // never break) and the rect covers the CONVERTED dims (matches the loaded
        // variant 1:1, so no sheetW scaling). 3D textures emit nothing.
        const defaultGuid = deriveGuid('sprite:' + guid);
        const spriteRef: SpriteAssetRef = {
          texture: guid, name: nameFromFile(entry.name),
          rect: { x: 0, y: 0, w: texDims.w, h: texDims.h },
          pivot: { x: 0.5, y: 0.5 },
          // Rect is in SOURCE px; the loaded 2D variant may be downscaled/snapped,
          // so carry the source dims as the sheet so the render path scales the
          // frame to the loaded variant (matches how sliced sprites resolve).
          sheetW: texDims.w, sheetH: texDims.h,
          ...(texBorder ? { border: texBorder } : {}),
        };
        assets.push({
          guid: defaultGuid,
          path: `${relPath}#default`,
          name: nameFromFile(entry.name),
          type: 'sprite',
          sprite: spriteRef,
        });
      }
    }
  }

  // Empty-folder visibility: a directory whose entire subtree holds NO file assets
  // would otherwise vanish from the editor Assets tree (the tree is built from file
  // paths). Emit a guid-less `'folder'` entry so it still shows — covers dirs created
  // externally (git checkout, another worktree) that the client's pendingFolders set
  // doesn't know about. Skip the scan ROOT itself (only sub-directories get an entry).
  // The runtime resolver ignores guid-less entries, so this is editor-only.
  if (dir !== base && !assets.some((a) => a.type !== 'folder')) {
    const relPath = (urlPrefix + '/' + path.relative(base, dir).replace(/\\/g, '/')).normalize('NFC');
    assets.push({ path: relPath, name: path.basename(dir), type: 'folder' });
  }
  return assets;
}

/** Filter a full scan down to a tree-shaker keep-set (NFC-normalized real file paths).
 *  A sliced sprite (type 'sprite') has NO file of its own — its path is the synthetic
 *  `<textureVirtualPath>#<guid>`, so it never appears in the keep-set. Keep each slice iff
 *  its PARENT texture survived: the prod manifest must carry the slice rect/pivot for the
 *  runtime to resolve a `Renderable2D.sprite` / `SpriteAnimator` frame GUID (the source
 *  `.meta.json` is dropped from the build). Without this a sprite-sheet renders BLANK in the
 *  deployed build — its GUID resolves to nothing. */
export function filterKeptAssets(assets: AssetEntry[], keepNfc: Set<string>): AssetEntry[] {
  return assets.filter((a) => {
    if (keepNfc.has(a.path.normalize('NFC'))) return true;
    if (a.type === 'sprite') return keepNfc.has(a.path.split('#')[0].normalize('NFC'));
    return false;
  });
}

/** Build a serializable manifest from a scan. Detects GUID collisions (two
 *  files sharing an id — usually a raw `cp` that bypassed the editor's Duplicate
 *  flow). When `heal` is true (dev scans), the collision is resolved by keeping
 *  the id on the file whose path sorts FIRST (lexicographically) and regenerating
 *  a fresh id for the rest. The keeper is chosen by path — not mtime — so every
 *  machine heals identically (mtime is reset by git clone/checkout, which would
 *  otherwise make different machines rewrite different files and churn git).
 *  Otherwise it only warns. The internal `absPath` field is stripped from the
 *  returned (serialized) entries. */
export function buildManifest(assets: AssetEntry[], heal = false): { version: 2; assets: AssetEntry[]; folders: string[] } {
  // Pull empty-folder marker entries (guid-less, editor-only) into a separate
  // `folders` list so the serialized `assets` array stays files-only (no guid/collision
  // bookkeeping applies to them). The editor's Assets panel seeds these into its tree.
  const folders = assets.filter((a) => a.type === 'folder').map((a) => a.path).sort();
  const fileAssets = assets.filter((a) => a.type !== 'folder');
  // Keep a parallel list pairing each serialized entry with its source path so
  // healing can rewrite the right file. Entries are shared by reference, so
  // mutating entry.guid below updates the returned manifest too.
  const items = fileAssets.map((a) => { const { absPath, ...entry } = a; return { entry, absPath }; });

  // Heal MISSING guids: mint + persist a stable id for any asset that has none,
  // so every reference can be a GUID. The runtime rejects raw-path refs, so an
  // asset without a guid (e.g. a texture moved into a folder, or one that never
  // went through an import/convert) is undroppable onto a ref field — dragging
  // it would write an unresolvable path. Persisting here (dev scans only) means
  // the manifest, the draggable asset row, and the runtime all agree on the id.
  if (heal) {
    for (const it of items) {
      if (it.entry.guid || !it.absPath || !fs.existsSync(it.absPath)) continue;
      // ⚠️ Fonts used to be SKIPPED here, on the premise that they were "referenced by CSS
      // family name, never by GUID". That premise was already half-wrong — `Text2D.font` /
      // `Text3D.font` are manifest GUIDs — and #231 made it wholly wrong by turning
      // `UIElement.fontFamily` into a GUID ref too. With the skip in place a font a user
      // drops into their project has NO guid, so it cannot be assigned to any font field at
      // all: the Inspector refuses the drop (it will not write a raw path) and the picker
      // has nothing to offer. The engine's nine bundled families all carry COMMITTED
      // sidecars, so nothing is minted for them and the "pure churn" the skip avoided does
      // not arise; a game's own font mints one sidecar, exactly as a texture does.
      const fresh = randomUUID();
      if (writeAssetGuid(it.absPath, it.entry.type, fresh)) {
        it.entry.guid = fresh;
        console.warn(`[asset-scanner] minted missing GUID for ${it.entry.path} → ${fresh}`);
      }
    }
  }

  // Group by guid (only guid-bearing entries can collide).
  const groups = new Map<string, typeof items>();
  for (const it of items) {
    if (!it.entry.guid) continue;
    const g = groups.get(it.entry.guid);
    if (g) g.push(it); else groups.set(it.entry.guid, [it]);
  }

  for (const [guid, group] of groups) {
    // Collapse entries that point at the same file (e.g. an NFC/NFD path twin) —
    // those aren't a real collision.
    const distinct: typeof group = [];
    const seenPaths = new Set<string>();
    for (const it of group) {
      if (!seenPaths.has(it.entry.path)) { seenPaths.add(it.entry.path); distinct.push(it); }
    }
    if (distinct.length <= 1) continue;

    // Lexicographically-first path keeps the id; the rest get regenerated.
    // Path-based ordering is stable across machines (unlike mtime).
    distinct.sort((a, b) => a.entry.path.localeCompare(b.entry.path));
    const original = distinct[0];
    for (let i = 1; i < distinct.length; i++) {
      const copy = distinct[i];
      if (heal && copy.absPath && fs.existsSync(copy.absPath)) {
        const fresh = randomUUID();
        if (writeAssetGuid(copy.absPath, copy.entry.type, fresh)) {
          console.warn(`[asset-scanner] GUID collision healed: ${copy.entry.path}\n  was a copy of ${original.entry.path} (id ${guid})\n  new id ${fresh}`);
          copy.entry.guid = fresh;
          continue;
        }
      }
      console.warn(`[asset-scanner] GUID collision: ${guid}\n  ${original.entry.path}\n  ${copy.entry.path}`);
    }
  }

  return { version: 2, assets: items.map((it) => it.entry), folders };
}

/** Resolve the engine built-in assets dir (/modoki/assets) from the first
 *  candidate anchor that exists on disk. PURE (fs check injectable) so the
 *  fallback ORDER is unit-testable. The order matters because `EDITOR_MODOKI_ASSETS`
 *  (derived from import.meta.url) is WRONG whenever this module is bundled —
 *  esbuild for the Electron backend AND Vite's own config bundling both drop the
 *  `engine/` segment, so relying on it alone silently skips the whole engine root
 *  (every /modoki asset then 404s + is absent from the manifest). Candidates:
 *    1. the open project's own engine/ (repo-as-project),
 *    2. the import.meta.url copy (correct only when loaded as true ESM),
 *    3. cwd/engine/… — the Vite server + editor both run cwd = repo root. */
const MODOKI_ASSETS_REL = 'engine/packages/modoki/src/runtime/assets';
export function resolveModokiAssetsDir(
  projectRoot: string,
  editorModokiAssets: string | undefined = EDITOR_MODOKI_ASSETS,
  cwd: string = process.cwd(),
  exists: (d: string) => boolean = fs.existsSync,
): string | undefined {
  return [
    path.join(projectRoot, MODOKI_ASSETS_REL),
    editorModokiAssets,
    path.resolve(cwd, MODOKI_ASSETS_REL),
  ].find((d): d is string => !!d && exists(d));
}

/** Walk the project tree to find all directories named "assets".
 *  Returns URL prefix → absolute path mappings. */
export function findAssetRoots(projectRoot: string): AssetRoot[] {
  const roots: AssetRoot[] = [];

  // engine/packages/modoki/src/runtime/assets/ → /modoki/assets. The engine's
  // built-in assets (fonts, favicon, icons, white.hdr, …) must be served +
  // GUID-resolvable regardless of which project is open. See resolveModokiAssetsDir.
  const modokiAssets = resolveModokiAssetsDir(projectRoot);
  if (modokiAssets) {
    roots.push({ urlPrefix: '/modoki/assets', absDir: modokiAssets });
  }

  // Flat one-game project: <projectRoot>/runtime/assets → /assets. A single-game
  // project IS the game, so there's no redundant /games/<id>/ segment — asset
  // refs resolve under a clean /assets/ prefix. (Refs are GUIDs, so the manifest
  // simply maps each GUID to its /assets/ URL; scene files need no rewrite.)
  const flatAssets = path.join(projectRoot, 'runtime/assets');
  if (fs.existsSync(flatAssets)) {
    roots.push({ urlPrefix: '/assets', absDir: flatAssets });
  }

  // <root>/<id>/runtime/assets/ → /<root>/<id>/assets, for every project root
  // (games/ + demos/ — see engine/scripts/projectRoots.mjs). Multi-project repos only.
  roots.push(...projectAssetRoots(projectRoot));

  return roots;
}

/** Scan all discovered asset roots */
export function scanAllAssets(roots: AssetRoot[]): AssetEntry[] {
  const assets: AssetEntry[] = [];
  for (const root of roots) {
    assets.push(...scanDir(root.absDir, root.absDir, root.urlPrefix));
  }
  return assets;
}

/** Resolve an asset path (URL) to an absolute file path.
 *  Returns null if the path is outside allowed roots. */
export function resolveAssetPath(assetPath: string, roots: AssetRoot[]): string | null {
  const cleaned = decodeURIComponent(assetPath.startsWith('/') ? assetPath : '/' + assetPath);

  for (const root of roots) {
    if (cleaned.startsWith(root.urlPrefix + '/')) {
      const rel = cleaned.substring(root.urlPrefix.length + 1);
      const absPath = path.resolve(root.absDir, rel);
      // Path-traversal guard: reject anything that resolves outside the root.
      // A bare startsWith() check is unsafe — it would accept a sibling dir that
      // shares the prefix (e.g. `<root>-evil`). Use path.relative and reject
      // results that escape upward (`..`) or are absolute (different drive).
      const relToRoot = path.relative(root.absDir, absPath);
      if (relToRoot === '..' || relToRoot.startsWith('..' + path.sep) || path.isAbsolute(relToRoot)) {
        return null;
      }
      return absPath;
    }
  }
  return null;
}

/** Reverse of resolveAssetPath: map an absolute file path back to its asset-root
 *  URL path, or null if it lives outside every root. */
export function absToAssetUrl(absPath: string, roots: AssetRoot[]): string | null {
  for (const root of roots) {
    const rel = path.relative(root.absDir, absPath);
    if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) continue;
    return (root.urlPrefix + '/' + rel.split(path.sep).join('/')).replace(/\/+/g, '/');
  }
  return null;
}

/** True when `file` sits inside one of the asset roots. Separators are normalized on
 *  BOTH sides before the prefix test, which is the whole point on Windows: Vite normalizes
 *  an HMR `ctx.file` to POSIX (forward slashes), but `absDir` comes from `path.join` →
 *  backslashes on Windows. A raw `file.startsWith(absDir)` therefore NEVER matched there,
 *  so `handleHotUpdate` failed to suppress HMR and a scene Cmd+S full-reloaded the whole
 *  editor. The `+ '/'` boundary keeps a sibling like `<root>-evil` from matching `<root>`. */
export function isUnderAssetRoot(file: string, roots: readonly Pick<AssetRoot, 'absDir'>[]): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const f = norm(file);
  return roots.some((r) => {
    const base = norm(r.absDir);
    return f === base || f.startsWith(base + '/');
  });
}

/** True when `file` is the open project's GAME CODE — the .ts/.tsx that Vite compiles
 *  but the running editor never re-imports (see the handleHotUpdate comment below).
 *
 *  `gameCodeRoot` MUST be the dir holding the project's `game.{ts,tsx}` entry, NOT
 *  `projectRoot`: in monorepo mode (no MODOKI_PROJECT) projectRoot is the REPO root, so
 *  anchoring there would match `engine/**` and force-reload the editor on every engine
 *  edit. findGamesEntry returns null at the repo root, which makes this inert there.
 *
 *  Containment is delegated to isUnderAssetRoot for its separator normalization — a
 *  hand-rolled startsWith re-breaks Windows (see that function's comment). Asset-root
 *  files are excluded a SECOND time here so a .ts ever authored under an asset root can
 *  never reach the reload branch; the caller already returns early for them.
 *
 *  Pure — exported for unit testing. */
export function isGameCodeFile(
  file: string,
  gameCodeRoot: string | null,
  assetRoots: readonly Pick<AssetRoot, 'absDir'>[],
): boolean {
  if (!gameCodeRoot) return false;
  if (!isUnderAssetRoot(file, [{ absDir: gameCodeRoot }])) return false;
  if (isUnderAssetRoot(file, assetRoots)) return false;
  const norm = file.replace(/\\/g, '/');
  if (!/\.(ts|tsx)$/i.test(norm)) return false;
  // A game's own unit tests don't run in the editor, so reloading on them is pure noise.
  // Match against the path RELATIVE to the game root, never the absolute path: a project
  // that merely LIVES under some ancestor named `test/` (e.g. ~/tests/mygame) would
  // otherwise have game-code reload silently disabled for every file it contains.
  const root = gameCodeRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const rel = norm.slice(root.length + 1);
  if (/(^|\/)tests?\//i.test(rel)) return false;
  return true;
}

/** True for an engine SHADER-GRAPH module — anything under `runtime/rendering/postfx/` or
 *  `runtime/rendering/npr/`. These are the TSL files whose node instances BAKE INTO a compiled
 *  WGSL pipeline, so hot-patching the module leaves the renderer running the PREVIOUSLY compiled
 *  graph and the edit appears to do nothing.
 *
 *  Why a path rule here instead of `import.meta.hot.invalidate()` in each file (which is what
 *  these modules used to do, and what this replaces): `invalidate()` does NOT force a reload — it
 *  propagates the update to importers and stops at the first one that ACCEPTS. The only importer
 *  is `runtime/rendering/Scene3D.tsx`, a React Fast Refresh boundary that self-accepts, so the
 *  reload was swallowed; Fast Refresh then re-ran the component but not its `[]`-deps effect, so
 *  the already-constructed PostFXStack — holding the old compiled WGSL — survived untouched. That
 *  is the whole bug: a CORRECT shader fix reads as "didn't work" (measured three times in a row
 *  while fixing a DOF viewZ bug), so it gets reverted and the real cause is chased elsewhere.
 *  Deciding it by path on the server can't be swallowed by anything in the module graph.
 *
 *  Matched against the path RELATIVE to nothing in particular — these directories are unique to
 *  the engine package, and the check is anchored on `runtime/rendering/` so an unrelated project
 *  folder merely NAMED `npr/` can't trigger a reload. Pure — exported for unit testing. */
export function isShaderGraphFile(file: string): boolean {
  const norm = file.replace(/\\/g, '/');
  if (!/\.(ts|tsx)$/i.test(norm)) return false;
  return norm.includes('/runtime/rendering/postfx/') || norm.includes('/runtime/rendering/npr/');
}

export function assetScannerPlugin(): Plugin {
  let projectRoot = '';
  // The EDITOR's own root (the Vite root is engine/, so its parent is the repo
  // root, where the editor's node_modules live). Used to serve editor-shipped
  // runtime deps (the Basis/KTX2 transcoder) to a FLAT project that has none.
  let editorRoot = '';
  let assetRoots: AssetRoot[] = [];
  /** Dir holding the open project's `game.{ts,tsx}` entry, or null when there is no
   *  project game (monorepo mode at the repo root). Anchors the game-code HMR rule —
   *  see isGameCodeFile. */
  let gameCodeRoot: string | null = null;
  /** Cached manifest, rebuilt on file changes. Avoids re-scanning on every fetch. */
  let cachedManifest: { version: 2; assets: AssetEntry[]; folders: string[] } = { version: 2, assets: [], folders: [] };
  /** Server reference so the watcher can push HMR updates. */
  let viteServer: { ws: { send: (m: object) => void } } | null = null;

  // ── Agent bridge state (dev-only AI/tooling helpers) ──
  // The live trait-registry schema, pushed by the browser over the HMR socket
  // (see app/debug/agentBridge.ts). Used to validate scene/trait JSON server-side.
  let cachedSchema: SceneSchema | undefined;
  // In-flight browser requests (e.g. /api/scene-state relays to the browser and
  // waits for its modoki:response). Lifecycle + timer bookkeeping live in
  // createBrowserRequestRegistry (above), factored out so it's unit-testable.
  const browserRequests = createBrowserRequestRegistry();
  // Scene/prefab files the editor just saved itself (via /api/write-file). The
  // watcher skips the hot-reload broadcast for these so an editor Cmd+S doesn't
  // bounce the live scene — external edits (an agent's file write, /api/scene-
  // mutate) still reload.
  // The 1500ms TTL covers chokidar's add+change burst (the common case); the F9
  // late-rename gap is closed by a content fingerprint — markEditorWrite records a
  // hash of the bytes it wrote, and the watcher (below) hands isEditorWrite a lazy
  // re-hash of the on-disk file, so a rename event that lands past the TTL is still
  // recognized as a self-write as long as the bytes are unchanged. The TTL behavior,
  // fingerprint fallback, and self-cleaning timer all live in createEditorWriteGuard
  // (above), factored out so they're unit-testable with an injectable clock.
  const { mark: markEditorWrite, isWrite: isEditorWrite } = createEditorWriteGuard();
  /** sha1 of a file's bytes, or null if it can't be read (e.g. an unlink event).
   *  Cheap on the small JSON scenes/prefabs this guards; only called on a TTL miss. */
  const hashFileSync = (file: string): string | null => {
    try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); }
    catch { return null; }
  };

  /** Relay an op to the browser over the HMR socket and await its reply. Rejects
   *  on timeout (no app open / no agent bridge connected). */
  function requestBrowser(op: string, params: unknown, timeoutMs = 3000): Promise<unknown> {
    if (!viteServer) return Promise.reject(new Error('dev server websocket not ready'));
    return browserRequests.request((id) => {
      viteServer!.ws.send({ type: 'custom', event: 'modoki:request', data: { id, op, params } });
    }, timeoutMs);
  }

  /** Re-scan all roots, rebuild the cached manifest, and broadcast a custom
   *  HMR event to any connected clients. Clients call loadManifestJson with
   *  the fresh payload so guid → path lookups stay current after moves. */
  function rebuildManifest(): { version: 2; assets: AssetEntry[]; folders: string[] } {
    assetRoots = findAssetRoots(projectRoot);
    const assets = scanAllAssets(assetRoots);
    cachedManifest = buildManifest(assets, true); // dev: auto-heal id collisions
    if (viteServer) {
      try { viteServer.ws.send({ type: 'custom', event: 'asset-manifest-updated', data: cachedManifest }); }
      catch { /* ws not ready */ }
    }
    return cachedManifest;
  }

  return {
    name: 'asset-scanner',

    // The editor writes data assets (scenes, particles, materials, .meta sidecars, …)
    // to disk via /api/write-file. Those JSON files aren't ES modules, but a write
    // under an asset root otherwise makes Vite hot-update the importing chain — which
    // bubbles up to the root App component, re-mounting it (and the editor) and
    // reloading the scene on every Cmd+S save. Suppress HMR for asset-root files:
    // returning [] tells Vite there are no modules to update. The manifest rebuild +
    // `asset-manifest-updated` broadcast (see configureServer's watcher) still run
    // independently, so the client's guid→path map stays current after moves/renames.
    // GAME CODE gets a full reload, because nothing else can apply it. Vite DOES watch
    // and recompile games/<id>/**.ts — measured: the update propagates up the static
    // virtual:modoki-games chain to /app/App.tsx, which is a Fast Refresh boundary and
    // SELF-ACCEPTS, so returning undefined here reloads nothing. Meanwhile the running
    // editor got its game from a SEPARATE @vite-ignore dynamic import (app/projectGames.ts)
    // whose URL never changes, so ESM keeps serving the cached instance forever: the new
    // code is compiled, served, and never asked for. Re-registering in place can't fix it
    // either — registerAll() is a one-shot, createEditor returns a component App.tsx
    // already resolved through React.lazy, registerDebugCommand duplicates on re-run, and
    // App.tsx's GAMES is a different (baked) module. Hence: reload, matching what Open
    // Project already does (electron/main.ts reloadIgnoringCache).
    //
    // ORDER IS LOAD-BEARING: the asset-root check must stay FIRST so a scene Cmd+S can
    // never reach the reload branch (games/<id>/runtime/assets/** sits INSIDE the runtime
    // dir). Send + return [] rather than returning undefined, so we own the reload instead
    // of also letting Vite propagate one.
    handleHotUpdate(ctx: { file: string }) {
      if (isUnderAssetRoot(ctx.file, assetRoots)) return [];
      if (isGameCodeFile(ctx.file, gameCodeRoot, assetRoots)) {
        if (viteServer) {
          // The RENDERER decides whether to reload now or surface a banner — an
          // unconditional reload would silently destroy unsaved scene edits (there is no
          // beforeunload guard anywhere). See app/debug/hmrStaleness.ts.
          try { viteServer.ws.send({ type: 'custom', event: 'modoki:game-code-changed', data: { file: ctx.file } }); }
          catch { /* ws not ready */ }
        }
        return [];
      }
      // Engine SHADER GRAPH (postfx/npr TSL): same "only a reload can apply this" situation as
      // game code, for a different reason — the old node graph is already baked into a compiled
      // pipeline. Reuses the SAME renderer-decides handshake, so a shader edit can't silently
      // destroy unsaved scene edits either. See isShaderGraphFile + app/debug/hmrStaleness.ts.
      if (isShaderGraphFile(ctx.file)) {
        if (viteServer) {
          try { viteServer.ws.send({ type: 'custom', event: 'modoki:shader-code-changed', data: { file: ctx.file } }); }
          catch { /* ws not ready */ }
        }
        return [];
      }
      return undefined;
    },

    configResolved(config) {
      // The vite root is engine/ (C3), but the open PROJECT (games/, project
      // assets, project.config.json) is the repo root — engine/'s parent — or an
      // explicit MODOKI_PROJECT. Keep projectRoot pointed at the project, not the
      // engine vite root, so findAssetRoots / virtual:modoki-games resolve games.
      projectRoot = process.env.MODOKI_PROJECT
        ? path.resolve(process.env.MODOKI_PROJECT)
        : path.dirname(config.root);
      // The Vite root is engine/ (vite.config `root: engineDir`); its parent is the
      // editor's repo root, regardless of which project is open.
      editorRoot = path.dirname(config.root);
      assetRoots = findAssetRoots(projectRoot);
      // null at the repo root (no game.ts there), which makes the game-code reload rule
      // inert in monorepo mode — see isGameCodeFile.
      const gameEntry = findGamesEntry(projectRoot);
      gameCodeRoot = gameEntry ? path.dirname(gameEntry.path) : null;
      registerReimportHandler('texture', textureReimportHandler);
      registerReimportHandler('model', modelReimportHandler);
      registerReimportHandler('atlas', atlasReimportHandler);
      registerReimportHandler('audio', audioReimportHandler);
      registerReimportHandler('video', videoReimportHandler);
      registerReimportHandler('font', fontReimportHandler);
      registerReimportHandler('environment', environmentReimportHandler);
      cachedManifest = buildManifest(scanAllAssets(assetRoots), true); // dev: auto-heal id collisions
    },

    // Expose the resolved project config to the browser. Inlined at build time;
    // invalidated on write (see /api/project-settings) so a reload picks up edits.
    resolveId(id) {
      if (id === PROJECT_CONFIG_VIRTUAL_ID) return PROJECT_CONFIG_RESOLVED_ID;
      if (id === GAMES_VIRTUAL_ID) return GAMES_RESOLVED_ID;
    },
    load(id) {
      if (id === PROJECT_CONFIG_RESOLVED_ID) {
        // stripPrivateBuildFields, NOT the raw resolved config: this string is inlined into the
        // browser bundle of every built game, and a built game is deployed to a public URL — so
        // the Apple Team ID and the internal bucket/CDN names would be downloadable by anyone who
        // can load the page. Nothing client-side reads them (they are signing/deploy inputs), so
        // blanking costs nothing. See stripPrivateBuildFields in project-config.ts.
        return `export default ${JSON.stringify(stripPrivateBuildFields(loadProjectConfig(projectRoot)))};`;
      }
      if (id === GAMES_RESOLVED_ID) {
        // Expose the open project's game (one project = one game, #29) — see
        // gamesModuleSource (pure + Windows-separator-safe).
        return gamesModuleSource(findGamesEntry(projectRoot));
      }
    },

    configureServer(server) {
      // The OTHER backend host — see startBackendServer in electron/backendServer.ts (#160).
      reclaimStaleDeviceStateAtStartup();
      viteServer = server as unknown as { ws: { send: (m: object) => void } };

      // Agent bridge: cache the trait schema the browser pushes, and resolve
      // pending requestBrowser() promises when the browser replies. (See
      // app/debug/agentBridge.ts for the client half.)
      const ws = server.ws as unknown as { on: (e: string, cb: (data: any) => void) => void };
      ws.on('modoki:schema', (data: SceneSchema) => { cachedSchema = data; });
      ws.on('modoki:response', (data: { id: number; result?: unknown; error?: string }) => {
        browserRequests.settle(data.id, data.result, data.error);
      });

      // Sanity-check the project's declared postprocessors against the runtime
      // registry once per server start. Drift surfaces as a warning here so
      // a new postprocessor that forgot to add itself doesn't silently
      // passthrough Stage A bakes.
      validatePostprocessorRegistry({
        projectRoot,
        resolveAssetPath: (p) => resolveAssetPath(p, assetRoots),
        ssrLoadModule: (id) => (server as unknown as { ssrLoadModule: (id: string) => Promise<Record<string, unknown>> }).ssrLoadModule(id),
      }).catch(() => { /* validation is best-effort */ });

      // Watch asset roots for changes. Vite's chokidar instance already runs;
      // we just add our directories. add/unlink/change all trigger a rebuild,
      // since changes to .id or sidecar files affect the manifest. Debounce
      // with a short timer so a bulk write (e.g. importer) only fires one update.
      let pendingRebuild: NodeJS.Timeout | null = null;
      // Scene/prefab files edited since the last flush → broadcast to the browser
      // so it hot-reloads the active scene (app/debug/agentBridge.ts).
      const pendingSceneChanges = new Map<string, LiveReloadKind>();
      const flushPending = () => {
        pendingRebuild = null;
        rebuildManifest();
        // Broadcast after the manifest rebuild so guid→path changes are already
        // live on the client before it re-loads the scene.
        if (pendingSceneChanges.size && viteServer) {
          for (const [urlPath, kind] of pendingSceneChanges) {
            try { viteServer.ws.send({ type: 'custom', event: 'modoki:scene-changed', data: { urlPath, kind } }); }
            catch { /* ws not ready */ }
          }
          pendingSceneChanges.clear();
        }
      };
      const scheduleRebuild = () => {
        if (pendingRebuild) clearTimeout(pendingRebuild);
        pendingRebuild = setTimeout(flushPending, 150);
      };
      for (const root of assetRoots) server.watcher.add(root.absDir);
      const onChange = (file: string) => {
        if (!isUnderAssetRoot(file, assetRoots)) return;
        // Classify via the same detector the scanner uses — new scenes are
        // `.scene.json`; a plain `.json` under a `scenes/` dir is the legacy fallback (#54).
        if (path.extname(file).toLowerCase() === '.json' && !isEditorWrite(file, () => hashFileSync(file))) {
          const rel = file.split(path.sep).join('/');
          // classifySceneChange just forwards detectType's verdict for 'scene' now that
          // the catch-all is gone (#54) — every 'scene' is positively identified (suffix
          // or legacy /scenes/ dir), so no further gating is needed. 'prefab' always broadcasts.
          const kind = classifySceneChange(rel);
          if (kind) {
            const urlPath = absToAssetUrl(file, assetRoots);
            if (urlPath) pendingSceneChanges.set(urlPath, kind);
          }
        }
        scheduleRebuild();
      };
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);
      server.watcher.on('change', onChange);

      // Minimal ctx for the shared static-asset server. `autoConvert` opts the dev/
      // editor server into on-demand variant baking: a model/texture whose
      // optimized variant isn't in the local (gitignored) `.cache/` is auto-
      // imported on first request instead of 404ing. `ssrLoadModule` lets a static
      // model's postprocessor Stage-A bake run during that auto-import.
      const staticCtx = {
        projectRoot, editorRoot,
        resolveAssetPath: (p: string) => resolveAssetPath(p, assetRoots),
        autoConvert: true,
        ssrLoadModule: (url: string) => server.ssrLoadModule(url) as Promise<Record<string, unknown>>,
        // The atlas handler resolves member sprites → their parent textures via this.
        listAssets: () => scanAllAssets(assetRoots),
      };

      server.middlewares.use(async (req, res, next) => {
        // Serve project asset bytes (files, Basis transcoder, cached LOD GLB /
        // texture variants) via the SAME shared function the Electron backend
        // uses — parity. Returns null ⇒ fall through to Vite module serving.
        if (req.url && req.method === 'GET') {
          const urlPath = req.url.split('?')[0]; // strip query params
          const result = await serveProjectAsset(staticCtx, urlPath);
          if (result) {
            writeBackendResult(res, result, req.headers['if-none-match']);
            return;
          }
        }

        // GET/POST /api/exit — shut this dev server down cleanly. Lets tooling
        // (and Claude) stop a previously-spawned server with a curl instead of
        // hunting PIDs. Dev-only by construction (this middleware only runs under
        // `vite` dev, never in a production build).
        if (req.url === '/api/exit') {
          handleExitRequest(res); // writes the ack, then schedules process.exit(0) after flush
          return;
        }

        // GET /api/dev-server-identity — WHO is on this port: the pid to kill, the project
        // this server is rooted at, and the editor tree it serves.
        //
        // main needs this because a reachable port is NOT proof the server on it is the one
        // main just started (#190). The guard it replaces was timing-based — "did our child
        // exit yet?" — and a stale server answers in <50ms while a fresh Vite takes ~2s to
        // fail its bind, so that check lost the race every time: the editor reported "dev
        // server up (project B)" about somebody else's server still rooted at project A, and
        // the renderer then loaded A's game code and assets under B's name.
        //
        // `repoRoot` is what scopes main's reclaim to OUR install: a sibling clone's dev
        // server answers here too, and it must be refused, never killed.
        //
        // Handled HERE, ahead of the shared /api router, because the answer is about THIS
        // PROCESS — mounted in the Electron host the same route would describe the wrong one.
        // (`editorRoot` is the repo root; it is `path.dirname(config.root)` — see its
        // assignment and the `repoRootAbs` derivation in the build SSR server below.)
        if (req.url === '/api/dev-server-identity') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          // `ppid` is the editor that spawned this server. It is what tells a LEAKED server
          // (its editor is gone — reclaimable) apart from one a second live editor of the same
          // install is legitimately using (must not be touched).
          res.end(JSON.stringify({ modoki: true, pid: process.pid, ppid: process.ppid, projectRoot, repoRoot: editorRoot }));
          return;
        }

        // Delegate router-owned /api routes to the transport-agnostic backend
        // (ELECTRON_PLAN Phase 1). Everything except /api/exit (above) and the
        // SSE streams (/api/build, /api/add-native-target — handled below) flows
        // through handleBackendRequest, so the exact same router can be mounted in
        // the Electron main process later. The SSE routes MUST be excluded here or
        // this catch-all shadows their dedicated handlers.
        const isApiRoute = req.url?.startsWith('/api/') ?? false;
        // Exact-match the SSE routes (bare OR with a query) so a sibling like
        // `/api/build-status` is NOT swallowed by a prefix match, and a query-less
        // `/api/build` still reaches its handler (which 400s) instead of falling
        // through to SPA HTML. Keep identical to the dedicated handlers below. (D5)
        const sseRoutes = ['/api/build', '/api/add-native-target', '/api/toolchain/install', '/api/ota/publish'];
        if ((isApiRoute && !isSseRoute(req.url!, sseRoutes)) || req.url === '/assets.manifest.json') {
          const u = new URL(req.url!, 'http://localhost');
          const ctx: BackendContext = {
            projectRoot,
            editorRoot,
            resolveAssetPath: (p) => resolveAssetPath(p, assetRoots),
            absToAssetUrl: (p) => absToAssetUrl(p, assetRoots),
            firstRootDir: () => assetRoots[0]?.absDir ?? null,
            getManifest: () => cachedManifest,
            rebuildManifest,
            requestBrowser,
            getSchema: () => cachedSchema,
            markEditorWrite,
            ssrLoadModule: (url) => server.ssrLoadModule(url) as Promise<Record<string, unknown>>,
            invalidateProjectConfig: () => {
              const mod = server.moduleGraph.getModuleById(PROJECT_CONFIG_RESOLVED_ID);
              if (mod) server.moduleGraph.invalidateModule(mod);
            },
            computeUnused: () => computeKeptAssets(projectRoot, assetRoots),
            computeRefEdges: () => enumerateRefEdges(projectRoot, assetRoots),
          };
          // Read the request body (empty for GET) before dispatch.
          let raw = '';
          req.on('data', (chunk: Buffer) => { raw += chunk; });
          req.on('end', async () => {
            let body: unknown;
            try { body = raw.trim() ? JSON.parse(raw) : undefined; }
            catch (e) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}` }));
              return;
            }
            try {
              const result: BackendResult | null = await handleBackendRequest(ctx, {
                method: req.method || 'GET',
                urlPath: u.pathname,
                query: u.searchParams,
                body,
              });
              if (!result) {
                // An UNMATCHED /api/* route must 404 as JSON, never fall through to Vite.
                //
                // `next()` handed it to Vite's htmlFallbackMiddleware, which accepts node fetch's
                // default `accept: */*` and rewrote the URL to /index.html — so a missing (or
                // misspelled) API route answered **200 with the editor's HTML page**, and every
                // GET client read that as a successful call whose payload happened to be a string.
                // The MCP transport now detects the HTML shape defensively (V3), but the route
                // that produced it is here, and a `curl` user got the same lie. A missing route
                // must look missing. (mirrors backendServer.ts, which already 404s.)
                if (u.pathname.startsWith('/api/')) {
                  res.statusCode = 404;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({
                    error: `no such API route: ${req.method || 'GET'} ${u.pathname}`,
                    hint: 'Check the path and method. This backend is the Vite dev server; some routes exist only on the Electron host (see docs/debug-tools-mcp.md).',
                  }));
                  return;
                }
                next();
                return;
              }
              writeBackendResult(res, result);
            } catch (e) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
            }
          });
          return;
        }

        // GET /api/add-native-target?platform=ios|android — scaffold a flat game
        // project's native target in one action (SSE stream): ensure Capacitor
        // deps + capacitor.config.json, vendor engine plugins (copies), install,
        // build web, `npx cap add`, then heal native config + flag missing
        // Firebase. Turns the manual per-game checklist into one Build-menu click.
        if ((req.url === '/api/add-native-target' || req.url?.startsWith('/api/add-native-target?')) && req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost');
          const platform = url.searchParams.get('platform') as NativePlatform | null;
          if (platform !== 'ios' && platform !== 'android') {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'platform must be ios or android' }));
            return;
          }
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          const send = (d: string) => { try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch { /* disconnected */ } };
          const sendStatus = (s: string) => { try { res.write(`event: status\ndata: ${JSON.stringify(s)}\n\n`); } catch { /* disconnected */ } };
          const sendStep = (step: number, total: number) => { try { res.write(`event: step\ndata: ${JSON.stringify({ step, total })}\n\n`); } catch { /* disconnected */ } };

          const cfg = loadProjectConfig(projectRoot);
          // #39: union errors come from a SEPARATE pass because validateBuildConfig sees the
          // already-resolved config, where a bad value has been coerced to its default and is no
          // longer visible. Load stays forgiving so a typo can't make a project un-openable; the
          // build is where it's fatal, because it's the last moment before the value ships.
          const cfgErrors = [...projectConfigUnionErrors(projectRoot), ...validateBuildConfig(cfg, loadProjectUserConfig(projectRoot))];
          if (cfgErrors.length) {
            sendStatus(`FAILED:Invalid project settings\n${cfgErrors.join('\n')}`);
            send('Aborted — fix these Project Settings fields:\n' + cfgErrors.join('\n'));
            res.end();
            return;
          }
          const buildCwd = editorRoot || projectRoot;
          const nativeDir = path.join(projectRoot, platform);

          // The SAME slot /api/build and /api/ota/publish take (#173 close-out). The scaffold runs
          // the identical `build-web.mjs --target native` into the identical `<project>/dist`
          // (addNativeTarget.ts), and additionally `npm install`s and `cap add`s into the project —
          // so racing a build corrupts dist, and racing ITSELF corrupts node_modules. Nothing
          // deduped two calls for the same platform before this. This lock stops two scaffolds
          // racing each other; it does nothing about ONE scaffold getting killed mid-`cap add` —
          // that's #581, and the half-written folder it leaves behind is no longer read as
          // "already scaffolded" (see isNativeTargetScaffolded + the repair step it drives in
          // scaffoldNativeTarget, below).
          const scaffoldSlot = acquireBuild(`${platform} native scaffold`);
          if (!scaffoldSlot.ok) {
            send(`[native] ${scaffoldSlot.message}`);
            sendStatus(`FAILED:Another job is already running\n${scaffoldSlot.message}`);
            res.end();
            return;
          }
          const scaffoldRelease = releasePolicy(scaffoldSlot.release);
          res.on('close', scaffoldRelease.onResponseClose);

          // Kill the in-flight child if the client disconnects (closed the dialog /
          // reloaded the renderer) so a long npm install / cap add isn't orphaned. (D6)
          // `killBuildProcess` signals the process GROUP, so a compound step's grandchildren
          // die with the shell rather than outliving it (#176) — this comment used to claim
          // that outcome while `proc.kill()` delivered only the shell.
          let activeProc: ReturnType<typeof spawn> | null = null;
          let aborted = false;
          req.on('close', () => { aborted = true; killBuildProcess(activeProc); });

          // Provision Node ONCE so the scaffold's npm install / cap add run on it (no system npm).
          const buildEnv = await buildStepEnv({ MODOKI_PROJECT: projectRoot });
          const runShell = (label: string, cmd: string, cwd: string) => new Promise<boolean>((resolve) => {
            if (aborted) return resolve(false);
            send(`\n── ${label} ──`);
            // Scaffold steps (npm install / npm run build / npx cap add) are pure
            // program+args, so they run on the Windows shell unchanged (no winCmd needed).
            const proc = spawnBuildCommand(cmd, { cwd, env: buildEnv });
            activeProc = proc;
            proc.stdout?.on('data', (d: Buffer) => send(d.toString().trimEnd()));
            proc.stderr?.on('data', (d: Buffer) => send(d.toString().trimEnd()));
            proc.on('close', (code) => { activeProc = null; resolve(code === 0); });
            proc.on('error', (e) => { activeProc = null; send(`ERROR: ${e.message}`); resolve(false); });
          });

          scaffoldRelease.onPipelineStart();
          (async () => {
            const TOTAL = 5;
            try {
              // #581: existsSync(nativeDir) alone can't tell a genuine target from a folder a
              // killed `cap add`/`cap sync` left half-written — isNativeTargetScaffolded checks
              // for the platform's real project file. An incomplete folder falls through into
              // scaffoldNativeTarget below, which removes it and re-scaffolds cleanly.
              if (isNativeTargetScaffolded(projectRoot, platform)) {
                sendStatus(`FAILED:${platform}/ already exists`);
                send(`This project already has a ${platform}/ folder — nothing to do.`);
                res.end();
                return;
              }
              if (fs.existsSync(nativeDir)) {
                send(`Found an incomplete ${platform}/ folder from an earlier interrupted scaffold — repairing it.`);
              }
              // Progress is coarse-grained here (the shared helper streams its own
              // per-step `── label ──` lines); nudge the step bar around the phases.
              sendStep(1, TOTAL); sendStatus('Scaffolding native target…');
              const { warnings: fb } = await scaffoldNativeTarget({ projectRoot, platform, buildCwd, cfg, send, runShell });
              for (const w of fb) send(`⚠️  ${w}`);

              sendStep(TOTAL, TOTAL);
              sendStatus('DONE');
              send(`✅ ${platform} target added for "${cfg.app.appName}" (${cfg.app.appId}).${fb.length ? ' See Firebase warning(s) above.' : ''}`);
              res.end();
            } catch (e) {
              sendStatus(`FAILED:${e instanceof Error ? e.message : String(e)}`);
              res.end();
            }
          })().finally(scaffoldRelease.onPipelineEnd);
          return;
        }

        // GET /api/toolchain/install?id=<tool> — auto-install one INSTALLABLE build
        // tool into the userData toolchain dir (SSE stream of npm/download output).
        // The status sibling GET /api/toolchain is the JSON router route; this stream
        // is host-owned like /api/build. Backs the Build-Support dialog's Install
        // buttons. Guided-only tools (Xcode) reject here — the dialog shows guide()
        // steps instead of an Install button for those.
        if ((req.url === '/api/toolchain/install' || req.url?.startsWith('/api/toolchain/install?')) && req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost');
          const id = url.searchParams.get('id') as ToolId | null;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          const send = (d: string) => { try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch { /* disconnected */ } };
          const sendStatus = (s: string) => { try { res.write(`event: status\ndata: ${JSON.stringify(s)}\n\n`); } catch { /* disconnected */ } };

          const toolchainDir = process.env.MODOKI_TOOLCHAIN_DIR;
          // Use isInstallable (DYNAMIC) not the static INSTALLABLE set — CocoaPods is installable on
          // macOS (provisioned Ruby) but deliberately NOT in INSTALLABLE, so the static check wrongly
          // rejected it here even though the dialog offered an Install button.
          if (!id || !isInstallable(id as ToolId)) {
            sendStatus(`FAILED:${id ? `${id} can't be auto-installed` : 'missing id'}`);
            send(id ? `${id} is not auto-installable — follow its setup guide instead.` : 'Pass ?id=<tool>.');
            res.end();
            return;
          }
          if (!toolchainDir) {
            // No userData dir shared into this process ⇒ a dev editor without provisioning.
            // Installs land in the packaged editor (where main shares MODOKI_TOOLCHAIN_DIR);
            // opt in for dev with MODOKI_PROVISION_NODE=1 + MODOKI_TOOLCHAIN_DIR.
            sendStatus('FAILED:No toolchain dir');
            send('No toolchain directory configured (MODOKI_TOOLCHAIN_DIR). This is expected in a plain dev editor — tool installs run in the packaged app.');
            res.end();
            return;
          }

          (async () => {
            try {
              // Ensure a provisioned Node first so install()'s npm runs on it (not system
              // npm) in the packaged editor — the Vite process can't inherit main's
              // MODOKI_NODE, so mirror buildStepEnv's ensureNode and publish the result onto
              // process.env (idempotent; npmSpawnSpec reads it).
              const stepEnv = await buildStepEnv();
              if (stepEnv.MODOKI_NODE) process.env.MODOKI_NODE = stepEnv.MODOKI_NODE;
              if (stepEnv.MODOKI_NPM_CLI) process.env.MODOKI_NPM_CLI = stepEnv.MODOKI_NPM_CLI;
              // WebDriverAgent is signed per MACHINE, but the Team ID is only ever authored
              // per PROJECT — so seed the machine setting from the open project the first time,
              // HERE rather than inside install(). install() deliberately takes no project
              // context (no other installer does, and threading it through would widen the
              // toolchain contract for one tool); this route already knows the project.
              // Only seeds when unset, so a team chosen in Build Support is never overwritten
              // by whichever project happens to be open.
              if (id === 'webdriveragent' && !wdaTeamId()) {
                const team = loadProjectConfig(projectRoot).build.appleTeamId.trim();
                if (team) {
                  writeToolchainSettings({ wdaTeamId: team });
                  send(`Signing WebDriverAgent with Apple Team ${team} (from this project; it is now the machine default).`);
                }
              }
              sendStatus(`Installing ${id}…`);
              const result = await installTool(id, { toolchainDir, onLog: (line) => send(line) });
              sendStatus('DONE');
              send(`✅ Installed ${id} → ${result.path}`);
            } catch (e) {
              sendStatus(`FAILED:${e instanceof Error ? e.message : String(e)}`);
              send(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
              res.end();
            }
          })();
          return;
        }

        // GET /api/build?platform=ios|android|web|playable[&variant=debug|release] — build + deploy
        // (SSE stream)
        if ((req.url === '/api/build' || req.url?.startsWith('/api/build?')) && req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost');
          const platform = url.searchParams.get('platform');
          if (!isValidBuildPlatform(platform)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'platform must be ios, android, web, or playable' }));
            return;
          }
          // #370. An ABSENT variant is `debug` — every caller that predates release builds must keep
          // meaning exactly what it meant before. A release variant is only meaningful for the two
          // NATIVE platforms: `web`/`playable` have no signed artifact, and silently ignoring the
          // param there would report a "release web build" that is the ordinary one.
          const variantParse = parseBuildVariant(url.searchParams.get('variant'));
          if (!variantParse.ok) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: variantParse.message }));
            return;
          }
          const variant = variantParse.variant;
          if (variant === 'release' && platform !== 'ios' && platform !== 'android') {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: `variant=release applies to ios and android only, not ${platform}` }));
            return;
          }
          const isRelease = variant === 'release';

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          const send = (data: string) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ } };
          const sendStatus = (status: string) => { try { res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`); } catch { /* client disconnected */ } };
          const sendStep = (step: number, total: number) => { try { res.write(`event: step\ndata: ${JSON.stringify({ step, total })}\n\n`); } catch { /* client disconnected */ } };

          // ONE build at a time (#173). #170's client guard covers the Build MENU; it cannot cover
          // `modoki_build`, which arrives here directly while a human's build is mid-flight. Taken
          // AFTER the SSE headers so the refusal reaches the client as a `FAILED:` status (the
          // route's convention for a deliberate refusal — a bare status is pushed into the log by
          // `consumeBuildStream` and then surfaces as "stream ended without a final status", i.e. an
          // actionable refusal disguised as a protocol anomaly), and BEFORE any config load or
          // preflight so a refused build does nothing at all.
          const slot = acquireBuild(`${platform}${isRelease ? ' release' : ''} build`);
          if (!slot.ok) {
            send(`[build] ${slot.message}`);
            sendStatus(`FAILED:Another job is already running\n${slot.message}`);
            res.end();
            return;
          }
          // Releasing the slot has TWO owners, because the handler has two halves and only one of
          // them is the build.
          //
          //  - Everything above the pipeline (config validation, the iOS device/team gates, the
          //    webBucket gate, the toolchain preflight) returns SYNCHRONOUSLY with a `res.end()`.
          //    Those paths spawn nothing, so `close` is the right release: it fires on a normal end
          //    AND on a client disconnect, covering all six of them (and a throw) without a
          //    `finally` around each.
          //  - Once the PIPELINE starts, `close` is the WRONG signal, and the first version of this
          //    used it anyway. A disconnect fires `close` immediately while the step loop is still
          //    awaiting a spawned child — so the slot went free with `npm run build` mid-flush into
          //    `<project>/dist`, and a retry starting right then wrote the same dist from two
          //    processes: exactly the interleaving the lock exists to prevent, reachable through the
          //    editor's own force-reload (a game `.ts` edit reloads the page, tearing down the
          //    EventSource mid-build). So once started, the pipeline owns the release and gives it
          //    back when it actually stops.
          //
          // "When the pipeline stops" means when the step's `bash` exits — which USED to be a
          // weaker statement than "when the WORK stops". `bash -c` exec-replaces itself for a
          // SIMPLE command but FORKS for a compound one (the iOS `Installing on device...` step,
          // icon generation, the web deploy's per-extension loop), so the old `proc.kill()` hit
          // the shell and left `devicectl`/`gcloud` running, orphaned, holding no slot. Closed in
          // #176: steps spawn `detached` and abort via `killBuildProcess`, which signals the
          // process GROUP — grandchildren included, plus a tool's own workers (xcodebuild's
          // clang, gradle's `--no-daemon` JVM) without relying on that tool to forward a signal.
          //
          // ⚠️ Still bounded by the backend being ALIVE to run a handler. A SIGKILL'd backend
          // orphans whatever was mid-step; nothing in-process can close that.
          // See docs/build.md § "One build at a time".
          const slotRelease = releasePolicy(slot.release);
          res.on('close', slotRelease.onResponseClose);

          // Web deploy target: a game-only build served under modoki-engine.com/demo
          // from the GCS bucket gs://modoki-www-site/demo. Assets are fetched at
          // runtime with the /demo base prefix (see assetUrl()). gcloud storage is
          // used instead of `gsutil -m` (which hangs via Python multiprocessing on
          // macOS). Entry points get no-cache so redeploys are picked up immediately.
          // All machine/project-specific values come from project.config.json
          // (editable via the editor's Project Settings window).
          const cfg = loadProjectConfig(projectRoot);
          // Per-machine settings (device UDIDs, SDK paths) live in gitignored
          // project.user.json — merged in here at build time.
          const user = loadProjectUserConfig(projectRoot);
          // These values are interpolated into `bash -c` below — reject anything
          // with shell metacharacters before building any command string.
          // #39: union errors come from a SEPARATE pass because validateBuildConfig sees the
          // already-resolved config, where a bad value has been coerced to its default and is no
          // longer visible. Load stays forgiving so a typo can't make a project un-openable; the
          // build is where it's fatal, because it's the last moment before the value ships.
          const cfgErrors = [...projectConfigUnionErrors(projectRoot), ...validateBuildConfig(cfg, user)];
          if (cfgErrors.length) {
            sendStatus(`FAILED:Invalid project settings\n${cfgErrors.join('\n')}`);
            send('Build aborted — fix these Project Settings fields:\n' + cfgErrors.join('\n'));
            res.end();
            return;
          }
          const WEB_BUCKET = cfg.build.webBucket;
          const APP_ID = cfg.app.appId;
          const IOS_DEST = user.device.iosDeviceId;
          const IOS_DEVICECTL = user.device.iosDevicectlId;
          // go-ios: the hands-free install path for a device `devicectl` cannot reach (iOS ≤16).
          // Resolved to an ABSOLUTE path where possible, and QUOTED at every use — the provisioned
          // one lives under "…/Application Support/Modoki Editor/toolchain/…" (spaces), and these
          // commands are interpolated into a bash string, the same trap `adb` documents below.
          //
          // `goIosUsable` is "present, or we can get it": the toolchain dir is where install() puts
          // it, so being able to provision counts. The async phase before the steps run does the
          // actual provisioning if it's missing — resolving the PATH here, before that, is safe
          // precisely because the install lands at exactly this path.
          const goIosDetected = detectTool('go-ios');
          const goIosToolchainDir = process.env.MODOKI_TOOLCHAIN_DIR;
          const GO_IOS = goIosDetected.command
            ?? (goIosToolchainDir ? goIosBinFor(path.join(goIosToolchainDir, 'go-ios')) : 'ios');
          const goIosUsable = goIosDetected.present || (!!goIosToolchainDir && isInstallable('go-ios'));
          // ONE decision, consumed by both the step plan (below) and the preflight guard
          // (further down) — see planIosInstall for why they must not diverge.
          const iosInstall = planIosInstall({ iosDeviceId: IOS_DEST, iosDevicectlId: IOS_DEVICECTL, goIos: goIosUsable });
          // adb: an absolute path resolved from the SHARED toolchain (<android-sdk>/platform-tools/
          // adb) so it works even when platform-tools isn't on PATH (a packaged/no-PATH machine);
          // bare `adb` only as a fallback. -s <id> targets the configured device.
          // QUOTE adb's absolute path: the provisioned SDK lives under
          // "…/Library/Application Support/Modoki Editor/toolchain/…" (spaces), and `adb` is
          // interpolated into a bash command string (`${adb} install …`), so an unquoted path
          // word-splits → `bash: /Users/…/Library/Application: No such file or directory`. The
          // `-s <serial>` flag stays outside the quotes (serials are [A-Za-z0-9._:-], no spaces).
          const adbBin = JSON.stringify(detectAdb().path ?? 'adb');
          // WHICH phone, when several are attached (#149). The project pin still wins — it is
          // explicit config the human typed in Project Settings — but an UNPINNED project no longer
          // falls through to a bare `adb`: with two handsets on USB that install failed with adb's
          // own `more than one device/emulator` and no hint that a pin even existed. `androidSerialError`
          // is carried to the Android preflight gate below rather than thrown here, so it surfaces
          // as a friendly named-candidates failure alongside every other missing-prerequisite, and
          // so it can never break a WEB or iOS build that has no business consulting adb at all.
          let androidSerialError: string | null = null;
          let androidSerial = user.device.androidDeviceId;
          // `!isRelease`: a release build produces an AAB + APK and installs NOTHING, so it must not
          // consult adb at all. Without this exclusion a release build could be refused because two
          // handsets were plugged in, or because a sibling clone held the phone — a device conflict
          // blocking a build that never touches a device.
          if (platform === 'android' && !isRelease) {
            // The HELD LEASE's phone is consulted too (#235). The refusal this can produce
            // offers `device_connect {useAdb:true, serial}` and the AI panel's picker as
            // remedies — both of which act by opening a lease — so without this the build
            // advertised two actions it then ignored, and an agent that followed the advice
            // got the identical refusal on the next build. The lease is read HERE rather than
            // inside resolveBuildAndroidSerial because androidDevices.ts must not import the
            // lease manager (deviceConnection.ts imports IT; see that module's header).
            //
            // ⚠️ Read from the CLAIMS FILE, never `deviceConnection.status()`. That singleton is
            // per-PROCESS, and this router is mounted in two of them (here, and Electron's
            // `backendServer.ts`). `device_connect` opens the lease in the ELECTRON process, so the
            // copy visible HERE is permanently `disconnected` and #235's fix never fired at all —
            // the build kept advertising the two remedies it ignored. The claims file is the state
            // both processes share; `foreignClaimFor` below already reads it for the sibling-clone
            // check. Only an adb claim carries a serial — a WiFi/IP lease has none (`ip:`), and
            // two claimed handsets report null so the ordinary rule refuses with both named.
            const ownClaim = ownAdbClaim();
            const leaseSerial = ownClaim ? adbSerialOf(ownClaim.deviceId) : undefined;
            const picked = resolveBuildAndroidSerial(listAndroidDevices(), { projectPin: user.device.androidDeviceId, leaseSerial });
            if ('error' in picked) androidSerialError = picked.error;
            else {
              androidSerial = picked.serial;
              // #285 sibling: a resolved serial can still be a SIBLING CLONE's claimed phone — the
              // lease check just above only catches a device THIS clone leased; it says nothing
              // about one leased elsewhere. Refused through the same androidSerialError channel as
              // every other "can't pick a device" case, so it costs no gradle build first.
              const foreign = foreignClaimFor(adbDeviceId(androidSerial));
              if (foreign) {
                androidSerialError = `${describeConflict(foreign)} (refused by the build, not just device_connect).`;
              }
            }
          }
          const adb = androidSerial ? `${adbBin} -s ${androidSerial}` : adbBin;
          // JAVA_HOME / ANDROID_HOME come from the SHARED toolchain (an explicit user.sdk override,
          // else `detect()`), resolved in JS and injected into the gradle step's spawn `env` (NOT a
          // bash `export` prefix — that's bash-only, and would SHADOW the shared detection with a
          // looser probe: the java one used to accept an unversioned brew `openjdk` — JDK 25 — which
          // now contradicts the version-strict `detect('java')`, the single-source-of-truth trap
          // CLAUDE.md warns against). detect('java') is version-strict (JDK 21 — Android/AGP can't
          // read newer bytecode); detect('android-sdk') is the same candidate list healNativeConfig
          // uses. The Android preflight gate below GUARANTEES both are present before gradle runs
          // (fails FRIENDLY when missing), so an unset value here is unreachable post-preflight.
          const detectedJavaHome = user.sdk.javaHome || detectTool('java').path;
          const detectedAndroidHome = user.sdk.androidHome || detectTool('android-sdk').path;
          const androidBuildEnv: Record<string, string> = {};
          if (detectedJavaHome) androidBuildEnv.JAVA_HOME = detectedJavaHome;
          if (detectedAndroidHome) androidBuildEnv.ANDROID_HOME = detectedAndroidHome;
          // Build steps run from the EDITOR root, not the open project: the build
          // infrastructure (dist/, engine/, ios/, android/, package.json,
          // capacitor.config) lives at the repo/editor root, and `npm run build`
          // already writes dist there (npm runs scripts from the package root). For
          // a FLAT in-repo project (projectRoot = games/<id>) the raw steps (favicon
          // cp, gcloud rsync of dist, cap sync, gradlew) would otherwise resolve
          // engine/ + dist/ under the project and fail. MODOKI_PROJECT (inherited by
          // the build subprocess) still steers vite at the open project's assets.
          // (Truly external projects with their own native/ are the #29 rework.)
          const buildCwd = editorRoot || projectRoot;
          // #29: the build emits to the OPEN PROJECT's dist (games/<id>/dist; see
          // vite.config buildProjectRoot). The favicon cp + gcloud rsync run from
          // buildCwd (repo root), so reference that dist relative to buildCwd
          // (e.g. "games/3d-test/dist"); falls back to "dist" for a repo-root build.
          // #29: the web DEPLOY (favicon, rsync, cache) belongs to the game root —
          // run it from the project (its dist is games/<id>/dist, so `dist` is
          // project-relative) and deploy to the project's own bucket. Only the
          // `npm run build` COMPILE stays at the editor root (shared vite/engine,
          // steered by MODOKI_PROJECT). The favicon is an engine asset, so its
          // source is resolved absolutely against the editor root.
          const webCwd = projectRoot;
          const faviconSrc = path.join(buildCwd, 'engine/packages/modoki/src/runtime/assets/favicon.png');
          // #29 per-game native: each flat project OWNS its native folders
          // (games/<id>/ios | android) — the shared repo-root native scaffold was
          // removed in the teardown. cap sync + the native build run FROM the
          // project root (its capacitor.config + ios/android live there). The WEB
          // build still runs from the editor root — package.json / vite /
          // MODOKI_PROJECT are there — and emits to <project>/dist, which the
          // project's own capacitor.config (webDir: dist) then syncs. A project
          // missing the platform's native folder is caught by the precondition
          // below (there's no repo-root native to fall back to anymore).
          const iosCwd = projectRoot;
          const androidCwd = projectRoot;
          // xcodebuild target: a CocoaPods game (mediation adapters etc.) gets an
          // App.xcworkspace from `pod install` → build with -workspace. An SPM-only
          // game (Firebase/SPM, no CocoaPods — e.g. 3d-test, alien-animal) has only
          // App.xcodeproj → build with -project. Auto-detect so the editor build
          // works for both (the hardcoded -workspace previously failed SPM games).
          const iosXcodeTarget = fs.existsSync(path.join(iosCwd, 'ios/App/App.xcworkspace'))
            ? '-workspace ios/App/App.xcworkspace'
            : '-project ios/App/App.xcodeproj';
          // App-icon generation: the project's configured source (project-relative
          // or absolute), else the bundled Modoki icon. `@capacitor/assets` (Easy
          // Mode) resizes it into every iOS AppIcon / Android mipmap size. The
          // source is copied to <project>/assets/icon.png (the tool's convention).
          // Non-fatal: an icon failure logs a hint but never aborts the app build.
          const iconSrcRaw = cfg.app.iconSource.trim();
          const iconSrcAbs = iconSrcRaw
            ? (path.isAbsolute(iconSrcRaw) ? iconSrcRaw : path.join(projectRoot, iconSrcRaw))
            // Default = the bundled 1024² Modoki icon (the editor's own app icon).
            : path.join(buildCwd, 'build/icon.png');
          // `--<plat>` (a FLAG, not the positional arg) makes the platform list
          // exclusive — the positional form still tries PWA and fails on a missing
          // www/manifest.json. The tool version is PINNED (scripts/iconAssets.mjs); the
          // flag does NOT keep the run inside that platform, which is what the wrapper
          // below is for.
          // The staging, the run, the freshness stamp and the SIDE-EFFECT CLEANUP all live in
          // `engine/scripts/generate-icons.mjs` — one portable Node step instead of two
          // hand-kept shell variants. It exists because the generator does not stay inside the
          // platform it is given: `generate --android` also rewrites `ios/…/project.pbxproj`
          // (mangling `LastUpgradeCheck = 0920` → `920`) and re-serializes AndroidManifest.xml
          // (#236). The script restores every pre-existing NON-image file the run touched and
          // reports what it restored; images — its actual product — are left alone.
          // #396/#397 — the splash master, its dark twin, the title wordmark and the three icon
          // variant overrides all resolve the same way as `iconSource`: project-relative unless
          // absolute, and EMPTY MEANS UNSET rather than meaning a default path, so an
          // unconfigured project generates exactly what it generated before.
          const projectFile = (raw: string): string | undefined => {
            const t = raw?.trim();
            if (!t) return undefined;
            return path.isAbsolute(t) ? t : path.join(projectRoot, t);
          };
          const splashSrcAbs = projectFile(cfg.app.splashSource);
          const splashDarkSrcAbs = projectFile(cfg.app.splashDarkSource);
          const titleSrcAbs = projectFile(cfg.app.splashTitleSource);
          const iconDarkSrcAbs = projectFile(cfg.app.iconDarkSource);
          const iconTintedSrcAbs = projectFile(cfg.app.iconTintedSource);
          const iconMonochromeSrcAbs = projectFile(cfg.app.iconMonochromeSource);
          // Engine-owned badge artwork, committed so no build depends on system fonts.
          // ⚠️ Under `engine/`, NOT `build/`. `electron-builder.yml`'s `files:` ships
          // `engine/**` + `dist/**` + `package.json` and nothing else — `build/` reaches the
          // package only as `build/bin` via extraResources. Resolved under `build/`, these were
          // MISSING in the packaged editor, and because `overlayLayersFor` builds the title layer
          // before it reads the badge, one unreadable badge discarded the title too: a packaged
          // -editor build produced title-less, badge-less splashes.
          const badgeLightArt = path.join(buildCwd, 'engine/assets/splash-badge-light.png');
          const badgeDarkArt = path.join(buildCwd, 'engine/assets/splash-badge-dark.png');
          // The orientation decides the CROP-SAFE box the overlays are placed in, so it is a
          // generation input, not just a runtime setting — see splashLayout.mjs.
          const splashOrientation = cfg.capacitor.orientation;
          // ⚠️ Every one of these is in the stamp. `iconStep` drops itself from the build plan
          // on a stamp match, so an input the hash cannot see changes nothing until someone
          // deletes `.cache/icon-stamp-*` by hand — the silent no-op both issues called out.
          const stampExtras = {
            splashSrcAbs,
            splashDarkSrcAbs,
            titleSrcAbs,
            badgeArtAbs: cfg.app.splashBadge ? badgeLightArt : undefined,
            badgeDarkArtAbs: cfg.app.splashBadge ? badgeDarkArt : undefined,
            iconDarkSrcAbs,
            iconTintedSrcAbs,
            iconMonochromeSrcAbs,
            titleWidthPct: cfg.app.splashTitleWidthPct,
            titleOffsetPct: cfg.app.splashTitleOffsetPct,
            badge: cfg.app.splashBadge,
            orientation: splashOrientation,
            // Anchors the post-processing-source hash; see splashPipelineVersion.
            engineRootAbs: buildCwd,
          };
          const iconStep = (plat: 'ios' | 'android'): BuildStep | null => {
            if (iconIsUpToDate(projectRoot, iconSrcAbs, plat, stampExtras)) return null;
            const stamp = iconStampValue(iconSrcAbs, plat, stampExtras);
            const script = path.join(buildCwd, 'engine/scripts/generate-icons.mjs');
            const opt = (flag: string, value: string | undefined) =>
              (value ? ` ${flag} ${JSON.stringify(value)}` : '');
            return {
              label: 'Generating app icons...',
              cmd: `node ${JSON.stringify(script)} --project ${JSON.stringify(projectRoot)} --platform ${plat} --icon ${JSON.stringify(iconSrcAbs)} --stamp ${stamp}`
                + opt('--splash', splashSrcAbs)
                + opt('--splash-dark', splashDarkSrcAbs)
                + opt('--title', titleSrcAbs)
                + ` --title-width ${cfg.app.splashTitleWidthPct} --title-offset ${cfg.app.splashTitleOffsetPct}`
                + ` --badge ${cfg.app.splashBadge ? 'true' : 'false'}`
                + (cfg.app.splashBadge ? `${opt('--badge-light', badgeLightArt)}${opt('--badge-dark', badgeDarkArt)}` : '')
                + ` --orientation ${splashOrientation}`
                + opt('--icon-dark', iconDarkSrcAbs)
                + opt('--icon-tinted', iconTintedSrcAbs)
                + opt('--icon-monochrome', iconMonochromeSrcAbs),
              cwd: plat === 'ios' ? iosCwd : androidCwd,
            };
          };
          // OTA Phase 5a: embed this build's own manifest into dist so the very FIRST
          // OTA check on a fresh install has something local to diff against (see
          // engine/scripts/ota-embed-manifest.mjs's header). Must run AFTER the web
          // build, BEFORE `cap sync` — cap sync copies dist/ into the native project's
          // bundled assets, so the manifest needs to already be there. `--dist` is
          // absolute (unlike the other steps' project-relative paths) since this step
          // doesn't otherwise need buildCwd-relative resolution. Gated on `ota.enabled`
          // so a project that hasn't opted in pays zero extra build cost.
          const projectDist = path.join(projectRoot, 'dist');
          const otaEmbedStep: BuildStep | null = cfg.ota.enabled ? {
            label: 'Embedding OTA manifest...',
            cmd: `node engine/scripts/ota-embed-manifest.mjs --dist ${JSON.stringify(projectDist)} --name ${JSON.stringify(cfg.ota.bundleName)} --engine-api ${cfg.ota.engineApi} --project ${JSON.stringify(projectRoot)}`,
            cwd: buildCwd,
          } : null;
          // Resolved once: `null` means the icons are already current for that platform,
          // and the step is dropped from the plan entirely rather than run as a no-op.
          const iosIconStep = iconStep('ios');
          const androidIconStep = iconStep('android');
          // ── How the built .app reaches the phone (see planIosInstall for the 3 modes) ──
          // The freshly-built bundle: newest matching DerivedData product. Shared by both
          // hands-free modes so they can never disagree about WHICH .app was just built.
          const iosAppPath = 'APP_PATH=$(ls -dt ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Debug-iphoneos/App.app 2>/dev/null | head -1)';
          const iosProjPath = iosXcodeTarget.replace(/^-(workspace|project) /, '');
          // The shared bail-out: the app BUILT, only the push failed, so say that and hand the
          // project to Xcode rather than reporting a raw tool error that reads as a broken build.
          const iosHandoff = (why: string) =>
            `echo ""; echo "${why}"; echo "   The app BUILT fine; only the command-line install is unavailable."; echo "   Opening the Xcode project — press Run (⌘R) there to deploy."; open "${iosProjPath}" 2>/dev/null || true`;
          const GO_IOS_Q = JSON.stringify(GO_IOS);
          const iosDeploySteps: BuildStep[] =
            // ⚠️ The failure message names CANDIDATES, not a verdict — the same correction the
            // go-ios launch step below carries. It used to assert "it requires iOS 17+", which is
            // wrong-by-construction on the path almost everyone takes: `iosDevicectlId` is filled
            // from the Build menu's device picker, and the picker sets it ONLY for a device
            // devicectl can see, i.e. one that is already iOS 17+. So a failure here is a locked
            // or untrusted phone far more often than a version problem, and the old copy sent the
            // reader to fix the one thing that could not be the cause. The version note survives
            // because the id CAN also be hand-typed in Project Settings, where it is reachable.
            //
            // `devicectl` is CoreDevice-only — it REFUSES anything below iOS 17 with
            // "This device does not support acquiring a usage assertion" (error 1010) or a
            // bare "device was not found". The xcodebuild step works fine on an old device,
            // so the build genuinely succeeded and only the CLI handoff is impossible.
            // Measured on an iPhone 7 / iOS 15.8.2, where devicectl cannot install but Xcode's
            // Run does. iOS 17+ deliberately STAYS here rather than moving to go-ios: go-ios
            // needs a sudo `ios tunnel start` on 17+, and Apple's own tool needs nothing.
            iosInstall.ok && iosInstall.mode === 'devicectl' ? [
              { label: 'Installing on device...', cmd: `${iosAppPath} && { xcrun devicectl device install app --device ${IOS_DEVICECTL} "$APP_PATH" || { ${iosHandoff('⚠️  devicectl could not install to this device. Check it is unlocked, awake and trusted; devicectl also cannot reach anything below iOS 17.')}; exit 1; }; }`, cwd: iosCwd },
              { label: 'Launching app...', cmd: `xcrun devicectl device process launch --device ${IOS_DEVICECTL} ${APP_ID}`, cwd: iosCwd },
            ]
            // go-ios: the iOS ≤16 device that has no devicectl id in EXISTENCE (it isn't a
            // CoreDevice, so `devicectl list devices` reports it `unavailable`). This used to be
            // the dead end that ended every such build with a human pressing ⌘R. go-ios talks to
            // the device over usbmuxd and installs the `.app` FOLDER directly — no Payload/ + zip
            // step, unlike the libimobiledevice recipe in docs/build.md. Verified end to end on
            // an iPhone 8 / iOS 16.7.16: kill → install → launch → a new pid that outlives the
            // tool, 4s for the whole cycle.
            : iosInstall.ok && iosInstall.mode === 'go-ios' ? [
              { label: 'Installing on device (go-ios)...', cmd: `${iosAppPath} && { ${GO_IOS_Q} install --path="$APP_PATH" --udid=${IOS_DEST} || { ${iosHandoff('⚠️  go-ios could not install to this device.')}; exit 1; }; }`, cwd: iosCwd },
              // A launch failure is NOT worth failing the build over: the new build is already on
              // the phone, which is the part that can't be redone by tapping an icon. Say what
              // happened and exit 0.
              //
              // ⚠️ **LEAD WITH THE INSTALL HAVING SUCCEEDED, and do not blame the lock screen.** This
              // used to read "unlock the device and tap the icon", which names the ONE cause an
              // agent or a human can act on and is wrong on the hardware that actually hits this.
              // `go-ios launch` drives Apple's INSTRUMENTS service (`processcontrol` over
              // `com.apple.instruments.remoteserver.DVTSecureSocketProxy`), and on an older handset
              // that service can be permanently unavailable — measured on the iPhone 8 / iOS 16.7.16
              // under Xcode 26.5, where it fails with a handshake EOF that no unlock, replug or
              // Developer-Disk-Image mount changes (one is already mounted; `ios image auto` is a
              // no-op there). It is the same dead instruments stack that stops WebDriverAgent on
              // that phone and hides it from `xctrace` — see docs/trusted-device-input.md, and do
              // not re-diagnose it.
              //
              // The failure therefore reads as "the build did not deploy" while the app is sitting
              // on the phone, freshly installed. The one thing the reader needs is that the INSTALL
              // landed; the cause is second, and go-ios's own error is already on the build stream
              // above this line for the detail.
              { label: 'Launching app...', cmd: `${GO_IOS_Q} launch ${APP_ID} --udid=${IOS_DEST} || { echo ""; echo "✅ Installed — the new build IS on the device."; echo "⚠️  Auto-launch failed, so it did not come to the foreground. Tap the app icon to run it."; echo "   Launching goes through Apple's instruments service, which some older devices do not"; echo "   provide (iOS ≤16 on a recent Xcode) — there the install is hands-free but the launch"; echo "   never will be. A locked or asleep device causes this too, so check that first."; }`, cwd: iosCwd },
            ]
            // Neither tool can reach it: an iOS ≤16 device on an editor with no go-ios and no way
            // to provision one. The build DID succeed, so report success and hand off — exiting
            // non-zero here would label a healthy legacy-device build "failed".
            : [
              { label: 'Handing off to Xcode (no CLI install available)...', cmd: `echo "ℹ️  No devicectl id set (that needs iOS 17+), and go-ios is not available to install to an older device."; echo "   Install go-ios from Build Support to make this hands-free."; ${iosHandoff('ℹ️  Deploying from Xcode instead.')}`, cwd: iosCwd },
            ];
          // Everything a native build does BEFORE it compiles: the web bundle, the OTA manifest, the
          // icons, `cap sync`. Identical for debug and release (#370) and named once so the release
          // tail cannot drift out of step with the debug one — a release build that quietly skipped
          // `cap sync` would ship the previous run's web assets, which is invisible until players
          // report a stale game.
          const iosPrefixSteps: BuildStep[] = [
            { label: 'Building web assets...', cmd: 'node engine/scripts/build-web.mjs --target native', cwd: buildCwd },
            ...(otaEmbedStep ? [otaEmbedStep] : []),
            ...(iosIconStep ? [iosIconStep] : []),
            { label: 'Syncing Capacitor iOS...', cmd: 'npx cap sync ios', cwd: iosCwd },
          ];
          const androidPrefixSteps: BuildStep[] = [
            { label: 'Building web assets...', cmd: 'node engine/scripts/build-web.mjs --target native', cwd: buildCwd },
            ...(otaEmbedStep ? [otaEmbedStep] : []),
            ...(androidIconStep ? [androidIconStep] : []),
            { label: 'Syncing Capacitor Android...', cmd: 'npx cap sync android', cwd: androidCwd },
          ];
          const stepsByPlatform: Record<string, BuildStep[]> = {
            // iOS is macOS-only (preflight blocks it off-darwin), so its bash-only steps
            // (`$(…)`, `~`, xcodebuild/xcrun) never run on Windows — no winCmd needed.
            ios: isRelease ? [
              ...iosPrefixSteps,
              ...iosReleaseSteps({ iosCwd, iosXcodeTarget }),
            ] : [
              ...iosPrefixSteps,
              { label: 'Building Xcode project...', cmd: `xcodebuild ${iosXcodeTarget} -scheme App -configuration Debug -destination 'id=${IOS_DEST}' -allowProvisioningUpdates build`, cwd: iosCwd },
              ...iosDeploySteps,
            ],
            android: isRelease ? [
              ...androidPrefixSteps,
              ...androidReleaseSteps({ androidCwd, buildCwd, env: androidBuildEnv, ota: cfg.ota.enabled }),
            ] : [
              ...androidPrefixSteps,
              // gradlew wrapper: posix `android/gradlew` vs Windows `android\gradlew.bat`.
              // JAVA_HOME/ANDROID_HOME are injected via env (not a bash export prefix).
              // --no-daemon: don't leave a persistent Gradle daemon (a java.exe running from the
              // provisioned JDK) after the build. On Windows that daemon keeps the JDK's files LOCKED,
              // so "Remove Java SDK" (and any manual delete) fails half-way. The build JVM exits when
              // the build finishes, releasing the lock. Small perf cost on repeat builds; worth it.
              // `clean` when ota.enabled: Gradle's incremental asset-merge task has been observed to
              // miss a NEW file (ota-embedded-manifest.json) added to dist/ between builds, serving a
              // stale merged-assets APK with no error (plan doc's "Gradle asset-merge staleness"
              // gotcha) — costs a slower build only for OTA-enabled projects.
              { label: 'Building Android APK...', cmd: `android/gradlew -p android ${cfg.ota.enabled ? 'clean ' : ''}assembleDebug --no-daemon`, winCmd: `android\\gradlew.bat -p android ${cfg.ota.enabled ? 'clean ' : ''}assembleDebug --no-daemon`, env: androidBuildEnv, cwd: androidCwd },
              // adb path + apk-relative path use forward slashes, which adb accepts on
              // Windows too; adb is an absolute exe path, so these run on both shells.
              { label: 'Installing on device...', cmd: `${adb} install -r android/app/build/outputs/apk/debug/app-debug.apk`, cwd: androidCwd },
              { label: 'Launching app...', cmd: `${adb} shell am start -n ${APP_ID}/.MainActivity`, cwd: androidCwd },
            ],
            // Web build ALWAYS compiles to <project>/dist + favicon. Deploy is
            // appended below per precedence: custom command > built-in gcloud (if a
            // bucket is set) > none (stop at dist). "Not everyone has a GCS bucket."
            web: [
              // env-var prefixes → spawn env (cross-platform; bash-only `FOO=bar cmd` fails on cmd).
              { label: 'Building web assets (game-only)...', cmd: 'node engine/scripts/build-web.mjs --target web', env: { BASE_PATH: cfg.build.webBasePath, VITE_GAME_ONLY: 'true' }, cwd: buildCwd },
              { label: 'Adding favicon...', cmd: `cp ${JSON.stringify(faviconSrc)} dist/favicon.png`, winCmd: `copy /y "${faviconSrc}" dist\\favicon.png`, cwd: webCwd },
            ],
            // Playable ad: a single self-contained HTML (VITE_PLAYABLE=1 → the asset
            // profile inlines every reachable asset + the single-file inliner emits
            // games/<id>/ads/index.html). No favicon/deploy — the whole ad IS the one
            // file, delivered to an ad network. Skips every web-deploy gate below
            // (those are `platform==='web'`-only). Reveal the ads/ dir when done.
            playable: playableBuildSteps(buildCwd, webCwd),
          };
          // ── Web deploy by mode ─────────────────────────────────────────────
          // custom → run the author's command; gcs → built-in gcloud (needs a
          // bucket); none/anything else → stop at dist. The bucket + CDN fields
          // apply ONLY to gcs; the command ONLY to custom.
          const distDir = path.join(webCwd, 'dist');
          const deployMode = cfg.build.webDeployMode;
          if (deployMode === 'custom' && cfg.build.webDeployCommand.trim()) {
            // Custom deploy command the project author wrote — trusted, run as-is
            // with placeholders substituted. Bypasses the built-in gcloud steps so
            // non-GCS targets (rsync, Netlify, scp, …) work.
            const deployCmd = cfg.build.webDeployCommand
              .replaceAll('{dist}', distDir)
              .replaceAll('{base}', cfg.build.webBasePath);
            stepsByPlatform.web.push({ label: 'Deploying (custom command)...', cmd: deployCmd, cwd: webCwd });
          } else if (deployMode === 'gcs' && WEB_BUCKET) {
            // Built-in gcloud deploy. gcloud storage is used instead of `gsutil -m`
            // (which hangs via Python multiprocessing on macOS). Entry points get
            // no-cache so redeploys are picked up immediately.
            stepsByPlatform.web.push(
              { label: `Uploading to ${WEB_BUCKET}...`, cmd: `gcloud storage rsync --recursive --delete-unmatched-destination-objects dist ${WEB_BUCKET}`, cwd: webCwd },
              // No-cache the entry point AND every data JSON (scene/particle/mesh/
              // mat/prefab/shader + assets.manifest.json). These keep stable
              // filenames across redeploys, so without no-cache an authoring tweak
              // (e.g. a particle color) stays stale for up to max-age. Big binaries
              // (glb/ktx2/webp) keep the default long cache — they rarely change and
              // texture variants are content-hashed in their names.
              { label: 'Setting cache headers...', cmd: `gcloud storage objects update ${WEB_BUCKET}/index.html "${WEB_BUCKET}/**.json" --cache-control="no-cache, max-age=0"`, cwd: buildCwd },
              // Hashed build outputs under /assets/ (JS/CSS + content-hashed JSON
              // chunks) have content-addressed filenames that change every build, so
              // they're safe to cache forever — repeat visitors skip re-fetching and
              // re-validating them entirely. Runs AFTER the no-cache step so the
              // **.json rule above doesn't downgrade the hashed JSON chunks here.
              { label: 'Caching hashed bundles (immutable)...', cmd: `gcloud storage objects update "${WEB_BUCKET}/assets/**" --cache-control="public, max-age=31536000, immutable"`, cwd: buildCwd },
            );
          } else {
            // No bucket, no custom command → local build only. Reveal the dist dir
            // (macOS `open`, Windows `start` → Explorer). The gcloud/CDN deploy steps
            // below stay posix-only (bash `find`/`for` + gcloud) — a Windows user doing
            // a GCS deploy is out of W-6 scope; local web + Android are covered.
            stepsByPlatform.web.push({ label: 'Revealing dist/...', cmd: `open ${JSON.stringify(distDir)}`, winCmd: `start "" "${distDir}"`, cwd: webCwd });
          }
          // B1: the model/texture binaries (glb/ktx2/webp) keep STABLE filenames
          // across edits but are fetched with a content-hash `?v=<hash>` query in
          // prod (modelGlbUrl / resolveTextureVariantUrl). That only busts caches
          // when the CDN keys on the query string — so mark them immutable ONLY
          // when a backend-bucket is configured AND we've set its cache-key policy
          // to include the query (next step). Only applies to the built-in gcloud
          // path (a custom deploy command owns its own caching).
          if (deployMode === 'gcs' && WEB_BUCKET && cfg.build.webCdnBackendBucket) {
            stepsByPlatform.web.push(
              {
                label: 'Enabling CDN query-string cache key (v only)...',
                // Idempotent: re-running just re-asserts the policy. Whitelist ONLY
                // the `v` cache-bust param (our sole query) so a distinct
                // `?v=<hash>` keys a distinct edge object (B1) without fragmenting
                // the cache on incidental/unknown query params.
                cmd: `gcloud compute backend-buckets update ${cfg.build.webCdnBackendBucket} --cache-key-query-string-whitelist=v`,
                cwd: buildCwd,
              },
              {
                label: 'Caching content-hashed binaries (immutable)...',
                // Only update the extensions the build actually produced — a game
                // with no models/compressed textures (e.g. all-primitives) has no
                // .glb/.ktx2/.webp, and `gcloud storage objects update` FAILS the
                // whole deploy when a glob matches zero objects. Scan dist/ at run
                // time (the same tree we just rsynced) and update per-present-type.
                cmd: `for ext in glb ktx2 webp; do if [ -n "$(find ${JSON.stringify(distDir)} -type f -name "*.$ext" 2>/dev/null | head -1)" ]; then gcloud storage objects update "${WEB_BUCKET}/**.$ext" --cache-control="public, max-age=31536000, immutable"; fi; done`,
                cwd: buildCwd,
              },
            );
          }
          // Cloud CDN fronts the bucket: re-upload + no-cache headers don't help
          // until the edge is flushed (it had cached the old object and ignores
          // query strings in its cache key). Invalidate the deploy path so a
          // redeploy is visible immediately. Skipped when no url-map is configured
          // or a custom deploy command owns the deploy.
          if (deployMode === 'gcs' && WEB_BUCKET && cfg.build.webCdnUrlMap) {
            stepsByPlatform.web.push({
              // `--async`: submit the invalidation and return immediately instead of
              // blocking on operation-polling. The synchronous form polls the op via
              // extra gcloud API calls that can hang for minutes in the spawned build
              // subprocess (observed: the dialog froze on this step while the op was
              // never even created), even though the same command run interactively
              // completes in ~3s. The edge flush still finishes server-side in seconds.
              label: 'Invalidating CDN cache...',
              cmd: `gcloud compute url-maps invalidate-cdn-cache ${cfg.build.webCdnUrlMap} --path "${cfg.build.webBasePath}*" --async`,
              cwd: buildCwd,
            });
          }
          const steps = stepsByPlatform[platform];

          // #29: native builds require the project's OWN ios/android folder (no
          // shared repo-root native to fall back to). Rather than dead-end, we
          // AUTO-SCAFFOLD it on the first build (same pipeline as the explicit
          // "Add Native Target" action) below, inside the SSE stream — then pause
          // if it surfaces a warning the user must act on (missing Firebase).
          const needsNativeScaffold =
            (platform === 'ios' || platform === 'android') &&
            !isNativeTargetScaffolded(projectRoot, platform as NativePlatform);

          // iOS device builds need a target device: the xcodebuild -destination interpolates
          // the configured id (the devicectl install/launch steps interpolate the SEPARATE,
          // optional devicectl id). An empty id yields a
          // cryptic `-destination 'id='` → `xcodebuild: error: missing value for key 'id'`
          // + a full usage dump (not an obvious "set your device" hint) — so fail fast with
          // guidance instead. (Android's `adb` degrades to auto-selecting the one device, so
          // it needs no such check.) The simulator isn't a target of this device pipeline.
          // Which ids are required, and why devicectl's is not, is documented once on
          // `planIosInstall` — this guard only reports its verdict.
          // `!isRelease`: the same exclusion the Android serial resolution takes above. A release
          // archive targets `generic/platform=iOS` and exports an .ipa — no device is involved, so
          // demanding a configured `iosDeviceId` would refuse an App Store build for want of a
          // plugged-in phone.
          if (platform === 'ios' && !isRelease && !iosInstall.ok) {
            // project.USER.json, not project.config.json: these are per-MACHINE device ids
            // (gitignored, never committed). The message named the committed file until this
            // close-out caught it — sending anyone who hit it to edit the wrong file.
            const msg = `[build] No iOS device configured — iosDeviceId (xcodebuild -destination) is empty in ` +
              `${path.relative(buildCwd, path.join(projectRoot, 'project.user.json'))}. ` +
              `Set it in Project Settings → Build: iosDeviceId = the xcodebuild UDID from ` +
              `\`xcrun xctrace list devices\`. Without it the build can't target your iPhone. ` +
              `(iosDevicectlId is optional — set it from \`xcrun devicectl list devices\` for a ` +
              `hands-free install/launch on iOS 17+; leave it empty on older devices and the ` +
              `build hands off to Xcode instead.)`;
            send(msg);
            // A DELIBERATE REFUSAL must be `FAILED:…`, not a bare status. `consumeBuildStream`
            // pushes any non-DONE/non-FAILED status into the log and, when the stream then closes,
            // reports "build stream ended without a final status" — so a clear, actionable config
            // refusal reached the agent disguised as an SSE protocol anomaly, and the reader went
            // looking for a wedge instead of setting a device id. The sibling refusals a few
            // hundred lines up (invalid project settings, platform exists) already use FAILED:.
            sendStatus(`FAILED:No iOS device configured\n${msg}`);
            res.end();
            return;
          }

          // #285 sibling: IOS_DEST is confirmed non-empty by the `iosInstall.ok` guard just above —
          // check it against the machine-wide claims the same way the Android leg does, before the
          // build spends minutes on `xcodebuild` only to install over a sibling clone's phone.
          if (platform === 'ios' && !isRelease) {
            const foreign = foreignClaimFor(iosDeviceId(IOS_DEST));
            if (foreign) {
              const msg = `[build] Cannot build to this iOS device: ${describeConflict(foreign)} `
                + '(refused by the build, not just device_connect).';
              send(msg);
              sendStatus(`FAILED:iOS device is claimed by another clone\n${msg}`);
              res.end();
              return;
            }
          }

          // iOS signing needs a Team ID that maps to a signed-in Xcode account.
          // Discover the teams on this Mac once (profiles + certs) so we can catch
          // the common misconfigs with an actionable message instead of the
          // cryptic "No Account for Team X" xcodebuild throws — and enrich a
          // signing failure below with the same list.
          const signingTeams: SigningTeam[] = platform === 'ios' ? discoverSigningTeams() : [];
          const fmtSigningTeams = () => signingTeams.length
            ? signingTeams.map((t) => `  • ${t.name} (${t.id})${t.hasProfile ? '' : ' — cert only, may need Xcode sign-in'}`).join('\n')
            : '  (none found — add your Apple ID in Xcode → Settings → Accounts)';
          if (platform === 'ios') {
            const teamId = cfg.build.appleTeamId.trim();
            if (!teamId) {
              send(`[build] No Apple Team ID set. Pick one in Project Settings → iOS → Signing.\nTeams found on this Mac:\n${fmtSigningTeams()}`);
              sendStatus(`FAILED:No Apple Team ID set\n${fmtSigningTeams()}`);
              res.end();
              return;
            }
            // Not a hard fail — a just-signed-in team may not be cached yet — but flag it.
            if (signingTeams.length && !signingTeams.some((t) => t.id === teamId)) {
              send(`[build] ⚠️  Apple Team ID "${teamId}" isn't among the teams found on this Mac:\n${fmtSigningTeams()}\nIf signing fails, pick one above in Project Settings → iOS → Signing, or sign into that team in Xcode → Settings → Accounts.`);
            }
          }

          // ── Release-build gates (#370) ────────────────────────────────────────────────────────
          // Both checked BEFORE the pipeline spends minutes on a web build + `cap sync` + gradle,
          // because neither failure would otherwise surface as a build failure at all: an unsigned
          // AAB builds clean and is refused by Play at UPLOAD, and a debug-instrumented release
          // builds clean and ships a JS-eval bridge to players.
          if (isRelease && platform === 'android') {
            const refusal = keystoreRefusal(
              user.keystore,
              (p) => fs.existsSync(p),
              path.relative(buildCwd, path.join(projectRoot, PROJECT_USER_CONFIG_FILENAME)),
            );
            if (refusal) {
              send(`[build] ${refusal}`);
              sendStatus(`FAILED:No Android upload key configured\n${refusal}`);
              res.end();
              return;
            }
          }
          if (isRelease) {
            const warn = debugBuildReleaseWarning(cfg.build.debugBuild === true);
            if (warn) send(`[build] ${warn}`);
          }

          // A GCS deploy needs a destination bucket. Without it, `gcloud storage rsync dist`
          // would be missing its DESTINATION arg and fail with a cryptic usage error — so
          // fail fast with an actionable message instead. Gate on `gcs` mode ONLY: `none`
          // (local build → reveal dist) and `custom` (its own command) do NOT deploy to a
          // bucket, so an empty webBucket must NOT block them (else the local-build escape
          // hatch is broken exactly for the bucket-less projects that need it).
          if (platform === 'web' && deployMode === 'gcs' && !WEB_BUCKET) {
            const msg = `[build] GCS web deploy has no destination. Set "build.webBucket" in ` +
              `${path.relative(buildCwd, path.join(projectRoot, 'project.config.json'))} ` +
              `(e.g. "gs://modoki-www-site/<project-id>"), or set build.webDeployMode to "none" ` +
              `for a local build. 3d-test is the reference.`;
            send(msg);
            // FAILED: (not a bare status) so the client shows this actionable message + closes
            // cleanly — a bare status leaves the stream to close and surface as "Connection lost".
            sendStatus('FAILED:No build.webBucket configured — see log');
            res.end();
            return;
          }

          // Toolchain preflight: fail FRIENDLY before running any step when a REQUIRED native
          // build tool is missing — else a bare java/adb/xcodebuild surfaces as a cryptic
          // mid-stream "command not found". Uses the shared toolchain (same detection as
          // healNativeConfig / the build env). A user.sdk override (Project Settings) satisfies the
          // tool it points at, so a valid custom-path setup isn't wrongly blocked. npm/node aren't
          // checked (provisioned on demand). Web + playable have no native tool to preflight — only
          // ios/android do, and narrowing to those (rather than casting `platform as BuildTarget`,
          // which would silently mis-preflight 'playable' if preflight ever grew a default branch)
          // keeps this sound.
          const pf = (platform === 'ios' || platform === 'android')
            ? preflightBuild(platform)
            : { target: 'web' as BuildTarget, ready: true, tools: [] };
          const overridden = new Set<string>();
          if (user.sdk.javaHome) overridden.add('java');
          if (user.sdk.androidHome) { overridden.add('android-sdk'); overridden.add('adb'); }
          const missingTools = pf.tools.filter((t) => !t.present && !overridden.has(t.id));
          if (missingTools.length) {
            send(`[build] Missing build tool(s) for ${platform}:\n${missingTools.map((t) => `  • ${t.id}: ${t.message}`).join('\n')}`);
            sendStatus(`FAILED:Missing ${platform} build tool(s) — see log`);
            res.end();
            return;
          }
          // Which Android to install onto (#149) — refused HERE, in the same place as every other
          // unmet prerequisite, so it costs no gradle build first. The message names the attached
          // candidates and how to pin one; see `resolveBuildAndroidSerial`.
          if (androidSerialError) {
            send(`[build] Cannot choose an Android device: ${androidSerialError}\n`
              + '  • Pin one in Project Settings → Device → "Android serial", or unplug the others.');
            sendStatus('FAILED:Cannot choose an Android device — see log');
            res.end();
            return;
          }

          // Kill the in-flight build child + stop launching steps if the client
          // disconnects (closed the Build dialog / reloaded), so gradle/xcodebuild/
          // gcloud aren't left running for minutes. (D6)
          // "Can't conflict with a retry" is what this claimed for a long time while `proc.kill()`
          // could not deliver it: `bash -c` FORKS for a compound command (the iOS `Installing on
          // device...` step is one), so the signal killed the shell and orphaned the real child.
          // The build slot (#173) narrowed the window by holding until this loop settles; #176
          // closed it — `killBuildProcess` signals the process GROUP, so the orphan can no longer
          // outlive the slot. docs/build.md § "One build at a time".
          let activeProc: ReturnType<typeof spawn> | null = null;
          let aborted = false;
          req.on('close', () => { aborted = true; killBuildProcess(activeProc); });

          // Provision Node ONCE for this build so every step's bash `npm`/`npx`/`node` runs on the
          // toolchain-provisioned Node (packaged: no system npm). Shared by scaffold + build steps.
          const buildEnv = await buildStepEnv({ MODOKI_PROJECT: projectRoot });

          // CocoaPods: an iOS build's `npx cap sync ios` shells out to `pod install`. When
          // CocoaPods was provisioned into the editor toolchain (portable Ruby + isolated gems),
          // prepend its bins + GEM_HOME onto every iOS step's env so `pod` resolves to the
          // provisioned one — no system `pod` / Homebrew. Prepend onto buildEnv.PATH so the
          // provisioned Node stays first-in-line for `npx`/`cap` too.
          if (platform === 'ios') {
            const podEnv = cocoapodsEnv();
            if (podEnv) {
              const basePath = (buildEnv as Record<string, string>).PATH ?? process.env.PATH ?? '';
              for (const step of steps) {
                step.env = { ...step.env, GEM_HOME: podEnv.GEM_HOME, GEM_PATH: podEnv.GEM_PATH, PATH: `${podEnv.binPath}:${step.env?.PATH ?? basePath}` };
              }
            }
          }

          // gcloud (web GCS deploy): a Finder-launched packaged editor has a minimal PATH without the
          // Google Cloud SDK, so the `gcloud` deploy steps would fail "command not found". Resolve
          // gcloud (Project Settings sdk.gcloudPath override → well-known dirs → login shell) and
          // prepend its dir onto every web step's PATH. If it's genuinely absent, fail fast with an
          // actionable install hint (gcloud can't be provisioned — it carries the user's cloud auth).
          if (platform === 'web' && deployMode === 'gcs' && WEB_BUCKET) {
            const gcloudDir = resolveGcloudDir(user.sdk.gcloudPath);
            if (!gcloudDir) {
              send('[build] gcloud not found — the web GCS deploy needs the Google Cloud SDK. Install it ' +
                '(https://cloud.google.com/sdk/docs/install) and run `gcloud auth login`, set the gcloud ' +
                'path in Project Settings, or use a custom deploy command.');
              sendStatus('FAILED:gcloud not found — see log');
              res.end();
              return;
            }
            const basePath = (buildEnv as Record<string, string>).PATH ?? process.env.PATH ?? '';
            for (const step of steps) {
              step.env = { ...step.env, PATH: `${gcloudDir}:${step.env?.PATH ?? basePath}` };
            }
          }

          // Spawn wrapper for the auto-scaffold phase — streams like a build step,
          // honors the same abort/disconnect handling, and steers vite at the open
          // project (MODOKI_PROJECT) so its `npm run build` emits the right dist.
          const runScaffoldShell = (label: string, cmd: string, cwd: string) => new Promise<boolean>((resolve) => {
            if (aborted) return resolve(false);
            send(`\n── ${label} ──`);
            const proc = spawnBuildCommand(cmd, { cwd, env: buildEnv });
            activeProc = proc;
            proc.stdout?.on('data', (d: Buffer) => send(d.toString().trimEnd()));
            proc.stderr?.on('data', (d: Buffer) => send(d.toString().trimEnd()));
            proc.on('close', (code) => { activeProc = null; resolve(code === 0); });
            proc.on('error', (e) => { activeProc = null; send(`ERROR: ${e.message}`); resolve(false); });
          });

          // From here the pipeline owns the build slot (see the two-owners note above) — set
          // SYNCHRONOUSLY, before the first `await`, so a disconnect can never observe a started
          // pipeline as un-started and release the slot out from under it.
          slotRelease.onPipelineStart();
          (async () => {
            // First native build with no ios/android folder → scaffold it inline,
            // then PAUSE if it flags something the user must supply (missing
            // Firebase config) so they can act before the build runs against it.
            if (needsNativeScaffold) {
              sendStatus(`Adding ${platform} target…`);
              if (fs.existsSync(path.join(projectRoot, platform))) {
                send(`\nFound an incomplete ${platform}/ folder from an earlier interrupted scaffold — repairing it before building.`);
              } else {
                send(`\nThis project has no ${platform}/ folder yet — scaffolding it before building.`);
              }
              let warnings: string[];
              try {
                ({ warnings } = await scaffoldNativeTarget({ projectRoot, platform: platform as NativePlatform, buildCwd, cfg, send, runShell: runScaffoldShell }));
              } catch (e) {
                if (aborted) return; // disconnected mid-scaffold — child already killed
                sendStatus(`FAILED:Add ${platform} target\n${e instanceof Error ? e.message : String(e)}`);
                send(`Could not scaffold the ${platform} target — see log above.`);
                res.end();
                return;
              }
              if (aborted) return;
              if (warnings.length) {
                for (const w of warnings) send(`⚠️  ${w}`);
                // First status line → the dialog's headline; the rest → its detail
                // box. Surface the warnings there (not just the console stream) so
                // the user sees WHAT to fix without opening the log.
                sendStatus(`FAILED:${platform} target added — action needed before building\n${warnings.join('\n')}`);
                send(`\n✅ ${platform}/ scaffolded, but the build was paused — resolve the warning(s) above, then run the build again.`);
                res.end();
                return;
              }
              // The scaffold already ran `npm run build` against unchanged source,
              // so drop the build's leading web-build step — dist is current; cap
              // sync / xcodebuild / gradle still run on it.
              if (steps[0]?.cmd?.startsWith('node engine/scripts/build-web.mjs')) steps.shift();
              send(`\n✅ ${platform}/ scaffolded — continuing the build.`);
            }
            // Re-heal the native config before building so machine/identity settings
            // edited AFTER the folder was scaffolded actually land in the generated
            // project — notably iOS DEVELOPMENT_TEAM from build.appleTeamId (else
            // xcodebuild dies with "Signing … requires a development team"). Idempotent
            // + cheap; a no-op when nothing changed (or already healed by the scaffold).
            if (platform === 'ios' || platform === 'android') {
              for (const n of healNativeConfig(projectRoot).notes) send(`[heal] ${n}`);
            }
            // #370: write the two GENERATED, GITIGNORED inputs a release build needs. Both are
            // re-derived every run rather than hand-maintained, so the upload key and the Team ID
            // each have exactly one home (`project.user.json`) and the native files that consume
            // them cannot go stale. Placed HERE — after the auto-scaffold and the heal — because
            // `android/` or `ios/` may not have existed when the request arrived.
            //
            // ⚠️ Both files hold private values (the key passwords; the Apple Team ID, which is a
            // PRIVATE_BUILD_FIELDS value). They are written to paths the project's own `.gitignore`
            // covers — `android/keystore.properties` and `ios/App/build/` — and `verify:publish` is
            // the backstop for that, not the defence. Do not relocate either without checking the
            // ignore rules first.
            if (isRelease && platform === 'android') {
              const propsPath = path.join(projectRoot, 'android', 'keystore.properties');
              // `mode` applies only when writeFileSync CREATES the file, so a keystore.properties
              // that already exists keeps whatever mode it had (0644 from an earlier engine, or
              // from a hand-written one). chmod unconditionally afterwards — this file holds the
              // upload key's passwords, and "it was already there" is not a reason to leave it
              // world-readable. Best-effort: a filesystem without POSIX modes must not fail a build.
              fs.writeFileSync(propsPath, renderKeystoreProperties(user.keystore), { mode: 0o600 });
              try { fs.chmodSync(propsPath, 0o600); } catch { /* non-POSIX fs — the write still landed */ }
              send(`[build] wrote ${path.relative(buildCwd, propsPath)} from project.user.json (user.keystore)`);
            }
            if (isRelease && platform === 'ios') {
              const optsPath = path.join(projectRoot, IOS_EXPORT_OPTIONS_PATH);
              fs.mkdirSync(path.dirname(optsPath), { recursive: true });
              fs.writeFileSync(optsPath, renderExportOptionsPlist({
                teamId: cfg.build.appleTeamId.trim(),
                method: cfg.build.iosExportMethod,
              }));
              send(`[build] wrote ${path.relative(buildCwd, optsPath)} (method: ${cfg.build.iosExportMethod})`);
            }
            // Provision go-ios the moment a build actually needs it — this build targets an iOS
            // device `devicectl` cannot reach, and without go-ios the deploy ends in a manual ⌘R.
            // Deliberately NOT in AUTO_INSTALL: 17 MB down / 45 MB on disk, useless to anyone whose
            // phone is iOS 17+, so it is fetched here (once) rather than by every editor at
            // onboarding. A failure is NOT fatal — the steps still run, `ios install` fails, and
            // the step's own bail-out hands the project to Xcode exactly as it did before go-ios
            // existed. That is why this can't strand a build it was only ever trying to improve.
            // `!isRelease` (#370): go-ios exists to INSTALL onto a device, and a release build
            // installs nothing. Without this, an editor whose configured phone is iOS ≤16 (the
            // iPhone 8 here) downloads 17 MB / 45 MB-on-disk of go-ios during an App Store archive
            // that never touches a device — and announces "the build needs go-ios to install
            // hands-free", which is false for this variant.
            if (platform === 'ios' && !isRelease && iosInstall.ok && iosInstall.mode === 'go-ios' && !goIosDetected.present && goIosToolchainDir) {
              send('\nThis device predates devicectl (iOS 17+), so the build needs go-ios to install hands-free.');
              try {
                await installTool('go-ios', { toolchainDir: goIosToolchainDir, onLog: (line) => send(line) });
                send('✅ go-ios provisioned — the app will install and launch without Xcode.');
              } catch (e) {
                send(`⚠️  Could not provision go-ios (${e instanceof Error ? e.message : String(e)}) — falling back to the Xcode handoff.`);
              }
              if (aborted) return;
            }
            // Heal engine-REQUIRED Capacitor plugins on EVERY native build. A project
            // scaffolded before an engine feature added a runtime plugin — @capacitor/preferences
            // (PlayerPrefs), @capacitor/app (App.tsx), @capacitor/keyboard (useKeyboardShift) — or
            // by an OLDER editor is missing it in its own package.json. The web build still inlines
            // the plugin's JS proxy (resolved from the editor's node_modules), so the build
            // SUCCEEDS, but `cap sync` (run in the project dir) never registers a native impl →
            // `"<Plugin>" plugin is not implemented on <platform>` at LAUNCH. ensureCapacitorDeps is
            // idempotent (adds only what's missing); if it added anything, vendor + install it so
            // the cap sync step below registers the native side. This is what makes an EXISTING
            // native game self-heal (the scaffold path already ran this; existing builds skipped it).
            if (platform === 'ios' || platform === 'android') {
              const depHeal = ensureCapacitorDeps(projectRoot, platform as NativePlatform, buildCwd);
              for (const n of depHeal.notes) send(`[heal] ${n}`);
              // Re-vendor UNCONDITIONALLY (#90). This used to be gated on `depHeal.changed`, but
              // `ensureCapacitorDeps` only adds MISSING deps — a plugin already depended on is
              // never missing, so editing `engine/packages/capacitor-*/**` had NO path into an
              // existing native game. The build succeeded, the APK installed, and it silently
              // contained the PREVIOUS native code: a failure in the direction that looks like
              // success. Measured 2026-08-02 while fixing #88 — the first build compiled the old
              // Java, caught only by hand-checking the tarball hash.
              //
              // Running it every build is safe by design: `vendorEnginePlugins` is idempotent and
              // content-addressed, so an unchanged plugin maps to the SAME committed tarball and
              // re-packs nothing. Only a real content change yields a new filename, and only then
              // does `needsInstall` force the (slow) install.
              const v = vendorEnginePlugins(projectRoot, buildCwd);
              if (v.vendored.length) send(`[heal] vendored engine plugin(s): ${v.vendored.join(', ')}`);
              if (depHeal.changed || v.needsInstall) {
                const why = depHeal.changed ? 'healed Capacitor plugins' : 'engine plugin changed';
                if (!(await runScaffoldShell(`npm install (${why})`, 'npm install', projectRoot))) {
                  if (aborted) return;
                  sendStatus(`FAILED:npm install (${why})`);
                  send('Build failed — could not install the added/updated Capacitor plugin(s).');
                  res.end();
                  return;
                }
                writeVendorMarker(projectRoot, v.expectedVendor);
              }
            }
            const total = steps.length;
            for (let i = 0; i < steps.length; i++) {
              if (aborted) return; // client gone — don't start the next step
              const step = steps[i];
              sendStep(i, total);
              sendStatus(step.label);
              send(`\n── ${step.label} ──`);
              // Ring-buffer the tail of BOTH streams — many tools (notably `tsc`)
              // write their errors to stdout, not stderr, so an stderr-only summary
              // comes back empty and the editor can't show why a build failed.
              const recentOutput: string[] = [];
              const keep = (line: string) => { recentOutput.push(line); if (recentOutput.length > 25) recentOutput.shift(); };
              const ok = await new Promise<boolean>((resolve) => {
                const { cmd: stepCmd, env: stepEnv } = resolveBuildStep(step, buildEnv);
                const proc = spawnBuildCommand(stepCmd, { cwd: step.cwd, env: stepEnv });
                activeProc = proc;
                proc.stdout?.on('data', (d: Buffer) => { const line = d.toString().trimEnd(); send(line); keep(line); });
                proc.stderr?.on('data', (d: Buffer) => { const line = d.toString().trimEnd(); send(line); keep(line); });
                proc.on('close', (code) => { activeProc = null; resolve(code === 0); });
                proc.on('error', (e) => { activeProc = null; send(`ERROR: ${e.message}`); keep(`ERROR: ${e.message}`); resolve(false); });
              });
              if (aborted) return; // disconnected during the step
              if (!ok) {
                // Prefer lines that look like real errors; else fall back to the tail.
                const errLines = recentOutput.filter((l) => /error|fail|cannot find|not found|exception/i.test(l));
                let errorSummary = (errLines.length ? errLines : recentOutput).join('\n').slice(-1500);
                // Turn a cryptic code-signing failure into something actionable by
                // appending the teams found on this Mac (the fix is almost always
                // "wrong team / not signed in", not a code error).
                if (platform === 'ios' && /No Account for Team|requires a development team|No profiles for|Signing for .* requires/i.test(errorSummary)) {
                  errorSummary += `\n\nSigning teams found on this Mac (set in Project Settings → iOS → Signing):\n${fmtSigningTeams()}`;
                  // Team is often correct but NO provisioning profile exists yet — xcodebuild
                  // can't always mint the first one headlessly. The one-time fix is to open the
                  // (now-generated) Xcode project and let Xcode auto-create it, then rebuild.
                  errorSummary += `\n\nIf the Team ID is correct but there's no provisioning profile yet, this first build had to CREATE the Xcode project — open it in Xcode ONCE so Xcode mints the profile:\n` +
                    `  1. open ${path.join(projectRoot, 'ios/App/App.xcodeproj')} in Xcode\n` +
                    `  2. select the App target → Signing & Capabilities → tick “Automatically manage signing” and pick your Team\n` +
                    `  3. run Build → iOS again (it now reuses the profile Xcode created).`;
                }
                sendStatus(`FAILED:${step.label}\n${errorSummary}`);
                send('Build failed.');
                res.end();
                return;
              }
            }
            sendStep(total, total);
            sendStatus('DONE');
            // A RELEASE build deploys nowhere and installs nothing — it leaves an artifact on disk —
            // so it gets its own wording plus the PATH. Saying "build deployed successfully" for a
            // build whose entire product is a file you must now go and upload would be the same
            // class of lie the playable's "built" wording already exists to avoid.
            if (isRelease) {
              const artifacts = platform === 'android'
                ? [ANDROID_AAB_PATH, ANDROID_RELEASE_APK_PATH]
                : [`${IOS_EXPORT_DIR}/`];
              send(`\n✅ ${platform === 'ios' ? 'iOS' : 'Android'} RELEASE build succeeded — nothing was installed or deployed.`);
              send(`   Artifacts (under ${path.relative(buildCwd, projectRoot) || '.'}):\n${artifacts.map((a) => `     • ${a}`).join('\n')}`);
              res.end();
              return;
            }
            const label = platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : platform === 'playable' ? 'Playable Ad (ads/index.html)' : 'Web (modoki-engine.com/demo)';
            // "built" for the playable (nothing is deployed — the one HTML file IS the artifact); "deployed" for the rest.
            send(`\n✅ ${label} ${platform === 'playable' ? 'built' : 'build deployed'} successfully!`);
            res.end();
            // `finally`, not a tail call: the body has ~9 early `return`s (an aborted step, a failed
            // step, a paused scaffold) and can reject, and every one of them must give the slot
            // back — a leaked slot refuses every future build until the editor restarts.
          })().finally(slotRelease.onPipelineEnd);
          return;
        }

        // /api/ota/status (GET, JSON) and /api/ota/keygen (POST, JSON) are plain
        // request/response — they live in the transport-agnostic editorBackendRouter.ts
        // (handleBackendRequest, called from this middleware's dispatcher above) so they
        // work identically in a packaged Electron editor, not just this dev server. Only
        // the SSE publish pipeline below stays host-owned, same as /api/build.

        // GET /api/ota/publish?version=v18[&mandatory=1|0][&bundleName=][&key=][&bucket=] (SSE stream)
        // `mandatory` is tri-state: 1 sets it, 0 clears it, omitted inherits the existing
        // release's value (sticky — see ota-publish.mjs's own header comment).
        // Wraps engine/scripts/ota-publish.mjs with the safety rails the plan doc calls
        // for: build FRESH from the current project.config.json (never accept a stale
        // pre-built dist/), verify/set bucket CORS. The version-collision decision
        // belongs to ota-publish.mjs alone, not this route (#577) — see Step 3 below.
        if ((req.url === '/api/ota/publish' || req.url?.startsWith('/api/ota/publish?')) && req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost');
          const version = url.searchParams.get('version');
          // Tri-state, matching ota-publish.mjs's own sticky-mandatory contract:
          // "1" sets it, "0" clears it, absent inherits the existing release's value —
          // `mandatoryParam` is `undefined` in that last case, distinct from `false`.
          const mandatoryRaw = url.searchParams.get('mandatory');
          const mandatoryParam = mandatoryRaw === '1' ? true : mandatoryRaw === '0' ? false : undefined;
          const keyName = url.searchParams.get('key') || 'default';
          const cfg = loadProjectConfig(projectRoot);
          const bundleName = url.searchParams.get('bundleName') || cfg.ota.bundleName;
          const bucket = url.searchParams.get('bucket') ?? deriveGcsBucketFromBaseUrl(cfg.ota.baseUrl);

          if (!cfg.ota.enabled) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'ota.enabled is false for this project — turn it on in Project Settings first.' }));
            return;
          }
          if (!version || !OTA_SAFE_TOKEN.test(version)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: `version is required and must match ${OTA_SAFE_TOKEN}` }));
            return;
          }
          if (!OTA_SAFE_TOKEN.test(bundleName) || !OTA_SAFE_TOKEN.test(keyName)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: `bundleName/key must match ${OTA_SAFE_TOKEN}` }));
            return;
          }
          // This route only ever builds via build-web.mjs (a normal standalone web build)
          // and publishes the CURRENTLY OPEN project's own dist/ — never build-subgame.mjs's
          // special sub-game-module format (subgame.json + globalThis.__MODOKI_SUBGAME__
          // IIFE) that subgameLoader.ts actually expects to fetch. Overriding `bundleName`
          // to anything other than this project's own configured name would silently
          // publish this project's plain shell dist/ under a DIFFERENT bundle's identity —
          // e.g. a sub-game's manifest/files overwritten with unrelated shell content, with
          // no error until every device that loads it fails belt-and-suspenders check #2 (or
          // worse, doesn't). Automated sub-game build+publish isn't wired into this route yet
          // (docs/ota-subgame-modules.md) — refuse rather than proceed with the wrong
          // bytes under someone else's name.
          if (!otaPublishBundleNameAllowed(bundleName, cfg.ota.bundleName)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: `bundleName ("${bundleName}") does not match this project's own ota.bundleName ("${cfg.ota.bundleName}"). This route only builds+publishes the CURRENTLY OPEN project as itself — publishing under a different bundle name would ship this project's plain web build under that bundle's identity, not a real sub-game module build. Open the sub-game's own project to publish it, or build it via build-subgame.mjs and publish by hand.` }));
            return;
          }
          if (!bucket || !OTA_SAFE_BUCKET.test(bucket)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: `Could not derive a gs:// bucket from ota.baseUrl ("${cfg.ota.baseUrl}"). Pass ?bucket=gs://... explicitly.` }));
            return;
          }
          const buildCwd = editorRoot || projectRoot;
          const keyPath = path.join(buildCwd, 'build', 'ota-keys', `${keyName}.json`);
          if (!fs.existsSync(keyPath)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: `Signing key "${keyName}" not found. Generate one first: POST /api/ota/keygen?name=${keyName}` }));
            return;
          }
          // The key must be the one the SHIPPED APP verifies against, not merely a key that
          // exists (independent review, 2026-07-30). `ota.publicKey` is baked into the binary and
          // is the ONLY key `verifyReleaseSignature` will accept. Signing with any other keypair
          // produces a perfectly well-formed, signed release.json that every installed app
          // silently refuses (`outcome: 'signature-invalid'`) — while this route reported success
          // and `/api/ota/status` then CONFIRMED the version as published. A release that no
          // device can install, reported as a successful ship, is the worst failure this route
          // has: it is remote, silent, and looks fine from here.
          //
          // #582: `ota-publish.mjs` (spawned below) now enforces this SAME refusal from the same
          // pure `otaSigningKeyRefusal` — this is NOT the #577 duplicate-guard shape. #577's
          // duplicate was a DIFFERENT decision procedure (existence vs content) that ran FIRST
          // and refused a case the real guard allows. This is the identical pure function over
          // the identical two inputs (the same key file, the same project.config.json), so it
          // cannot refuse anything ota-publish.mjs would allow — it stays here only to return a
          // clean HTTP 400 before the SSE stream opens and the multi-minute build starts.
          {
            let keyPub: string | null;
            try {
              keyPub = (JSON.parse(fs.readFileSync(keyPath, 'utf8')) as { publicKey?: string }).publicKey ?? null;
            } catch {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: `Signing key "${keyName}" (${keyPath}) could not be parsed as JSON — regenerate it: POST /api/ota/keygen?name=${keyName}` }));
              return;
            }
            const cfgPub = cfg.ota.publicKey;
            const refusal = otaSigningKeyRefusal(keyPub, cfgPub);
            if (refusal) {
              const why = {
                'no-key-public-half': `Signing key "${keyName}" has no publicKey field — regenerate it: POST /api/ota/keygen?name=${keyName}`,
                'project-public-key-empty': `This project's ota.publicKey is EMPTY, so no installed app can verify a release. Set it to the signing key's public half ("${keyPub}") in Project Settings → OTA, rebuild + ship the native app so the new key is baked in, and publish then.`,
                mismatch: `Signing key "${keyName}" does NOT match this project's ota.publicKey — every installed app would reject the release as signature-invalid, while this publish reported success. Key "${keyName}" public half: "${keyPub}". project.config.json ota.publicKey: "${cfgPub}". Publish with the key that matches (?key=<name>), or — only if you intend to ROTATE the key — set ota.publicKey to the new value and ship a native build carrying it BEFORE publishing, or installed apps will be stranded.`,
              }[refusal];
              res.statusCode = 400;
              res.end(JSON.stringify({ error: why }));
              return;
            }
          }
          const user = loadProjectUserConfig(projectRoot);
          const gcloudDir = resolveGcloudDir(user.sdk.gcloudPath);
          if (!gcloudDir) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'gcloud not found — install the Google Cloud SDK and run `gcloud auth login`, or set its path in Project Settings.' }));
            return;
          }

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          const send = (data: string) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ } };
          const sendStatus = (status: string) => { try { res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`); } catch { /* client disconnected */ } };

          // Build the step env through `buildStepEnv` like /api/build does, THEN prepend gcloud.
          // It was raw `process.env`, so on a PACKAGED editor — which ships its own node and has
          // none on the system PATH — the very first step died with a bare
          // `node: command not found`, i.e. the publish was impossible in the one build where the
          // editor is most likely to be used and the failure said nothing about why. (§9: the
          // build family should not have two different notions of "the environment a step runs in".)
          // The SAME slot the build takes (#173 close-out). This route runs the byte-identical
          // `build-web.mjs --target native` into the byte-identical `<project>/dist` as
          // /api/build's web step — and then UPLOADS that dist. So a publish racing a build does not
          // merely corrupt a local artifact: it ships the torn bundle to every installed device that
          // checks for an update, with no review step in between. Strictly worse than the case the
          // lock was written for, and reachable by one human doing two ordinary things in one window
          // (start Build → iOS, then open Publish OTA while it runs).
          const otaSlot = acquireBuild('OTA publish');
          if (!otaSlot.ok) {
            send(`[ota] ${otaSlot.message}`);
            sendStatus(`FAILED:Another job is already running\n${otaSlot.message}`);
            res.end();
            return;
          }
          const otaRelease = releasePolicy(otaSlot.release);
          res.on('close', otaRelease.onResponseClose);

          const baseEnv = await buildStepEnv({ MODOKI_PROJECT: projectRoot });
          const gcloudEnv = { ...baseEnv, PATH: `${gcloudDir}:${baseEnv.PATH ?? ''}` };
          const distDir = path.join(projectRoot, 'dist');

          let activeProc: ReturnType<typeof spawn> | null = null;
          let aborted = false;
          req.on('close', () => { aborted = true; killBuildProcess(activeProc); });

          const runStep = (label: string, cmd: string, cwd: string, env: NodeJS.ProcessEnv) => new Promise<{ ok: boolean; output: string }>((resolve) => {
            send(`\n── ${label} ──`);
            const proc = spawnBuildCommand(cmd, { cwd, env });
            activeProc = proc;
            let out = '';
            proc.stdout?.on('data', (d: Buffer) => { const l = d.toString(); send(l.trimEnd()); out += l; });
            proc.stderr?.on('data', (d: Buffer) => { const l = d.toString(); send(l.trimEnd()); out += l; });
            proc.on('close', (code) => { activeProc = null; resolve({ ok: code === 0, output: out }); });
            proc.on('error', (e) => { activeProc = null; send(`ERROR: ${e.message}`); resolve({ ok: false, output: e.message }); });
          });

          // From here the publish pipeline owns the slot, not the socket — see the two-owners note
          // on /api/build's acquire. Set synchronously, before the first `await`.
          otaRelease.onPipelineStart();
          (async () => {
            // Step 1: build FRESH from the CURRENTLY OPEN project's project.config.json.
            // Never publish an arbitrary pre-built dist/ — that's how a stale pre-fix
            // build once silently overwrote a freshly-fixed native install over the air.
            // `--target native` despite the GCS upload below: an OTA bundle replaces the web
            // content INSIDE an installed native app, so it is served from the app root — never
            // `--target web`, which would bake in the project's sub-path webBasePath (#40).
            sendStatus('Building web assets...');
            const build = await runStep('Building web assets...', 'node engine/scripts/build-web.mjs --target native', buildCwd, otaPublishBuildStepEnv(gcloudEnv, projectRoot));
            if (aborted) return;
            if (!build.ok) { sendStatus(`FAILED:Building web assets\n${build.output.slice(-1500)}`); res.end(); return; }

            // Step 2: verify/set bucket CORS (GCS sets none by default; `gcloud`/`curl`
            // ignore CORS entirely, so nothing catches a missing policy until a real
            // WebView fetch() fails — and checkForUpdate reports that as the generic
            // no-release-for-bundle, i.e. silently). Non-fatal: a permissions error here
            // shouldn't block publishing, just gets logged as a warning.
            // ⚠️ This write now happens before the collision check INSIDE ota-publish.mjs
            // (Step 3) — the route itself has no such check; #577 deleted it, it was not
            // reordered. So a publish about to be refused for a genuine version collision
            // has already REPLACED the bucket's whole CORS config (`--cors-file` is not a
            // merge) with the `origin:['*']` policy below, clobbering any hand-tuned origin
            // list. Accepted, not an oversight — but note the reason is NOT that moving CORS
            // below Step 3 is impossible: Step 3 returns early on `!publish.ok`, so a refused
            // publish would simply never reach the write. The real cost of moving it is a
            // window where a BRAND-NEW bucket serves the just-published release with no CORS
            // until the write lands, and a device polling in that window sees the generic
            // no-release-for-bundle — i.e. a silent failure on the first publish, traded for
            // a recoverable config clobber on a refused one. Worth revisiting, not settled.
            sendStatus('Verifying bucket CORS...');
            const bucketRoot = bucket.match(/^gs:\/\/[^/]+/)?.[0];
            if (bucketRoot) {
              const corsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-cors-')), 'cors.json');
              fs.writeFileSync(corsFile, JSON.stringify([{ origin: ['*'], method: ['GET', 'HEAD'], responseHeader: ['Content-Type'], maxAgeSeconds: 3600 }]));
              try {
                execFileSync('gcloud', ['storage', 'buckets', 'update', bucketRoot, `--cors-file=${corsFile}`], { env: gcloudEnv, stdio: 'ignore' });
                send(`CORS verified on ${bucketRoot}.`);
              } catch (e) {
                send(`⚠️  Could not set CORS on ${bucketRoot} (non-fatal, continuing): ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            if (aborted) return;

            // Step 3: the actual publish. This route has NO version-collision guard of its
            // own on purpose — `ota-publish.mjs` is the single source of truth for that
            // decision, and it decides by manifest CONTENT (identical bytes → a legitimate
            // retry of a publish that died after upload; different bytes → refuse). This
            // route used to duplicate that check by manifest EXISTENCE and, running first,
            // never let the content-based guard get reached — refusing exactly the
            // identical-contents retry it exists to allow (#577). A guard here would have to
            // recompute what THIS publish would produce (hash dist/, build the zip, build
            // the manifest, canonicalize) to compare against — i.e. re-implement the script
            // — and the two implementations drifting is this bug. Don't re-add it.
            sendStatus('Publishing...');
            const mandatoryFlag = mandatoryParam === true ? ' --mandatory' : mandatoryParam === false ? ' --no-mandatory' : '';
            const publish = await runStep(
              'Publishing OTA bundle...',
              `node engine/scripts/ota-publish.mjs --dist ${JSON.stringify(distDir)} --bucket ${JSON.stringify(bucket)} --name ${JSON.stringify(bundleName)} --version ${JSON.stringify(version)} --engine-api ${cfg.ota.engineApi} --key ${JSON.stringify(keyName)} --repo-root ${JSON.stringify(buildCwd)} --project ${JSON.stringify(projectRoot)}${mandatoryFlag}`,
              buildCwd,
              gcloudEnv,
            );
            if (aborted) return;
            if (!publish.ok) { sendStatus(`FAILED:Publishing\n${publish.output.slice(-1500)}`); res.end(); return; }

            // Echo the EFFECTIVE parameters, not just a tick. `mandatory` and `key` are optional
            // and were echoed nowhere, so "publish v19 as mandatory, signed with prod" could
            // silently publish a NON-mandatory bundle signed with the default key and still read
            // as success — and an OTA release is the one artifact you cannot quietly re-do.
            // (The misspelled-arg half of this is now caught by strict validation; this is the
            // half that needs the RESULT to be checkable.)
            // `mandatory` is sticky now (inherited when the param is absent), so echo the
            // INTENT this call passed — printing a resolved true/false here would print "false"
            // for an inherit-and-stay-mandatory publish while the release stays mandatory, which
            // is the exact silent-mismatch class this echo exists to prevent. ota-publish.mjs's
            // own "Published ..." log line (above, in the streamed step output) carries the
            // resulting effective value.
            sendStatus('DONE');
            const mandatoryIntent = mandatoryParam === true ? 'set' : mandatoryParam === false ? 'cleared' : 'unchanged';
            send(
              `\n✅ Published — effective parameters: bundleName=${bundleName} version=${version} ` +
              `mandatory=${mandatoryIntent} key=${keyName} bucket=${bucket}. ` +
              `Verify with modoki_ota_status.`,
            );
            res.end();
          })().finally(otaRelease.onPipelineEnd);
          return;
        }

        next();
      });
    },

    // On build: tree-shake assets, convert textures, copy only what's referenced
    // into dist/, write a filtered manifest with baked texture settings.
    async writeBundle(_options, _bundle) {
      assetRoots = findAssetRoots(projectRoot);
      // Use Rollup's authoritative output dir, not `projectRoot/dist`. For a FLAT
      // in-repo project (projectRoot = games/<id>) Vite still emits to <repo>/dist
      // (vite.config `build.outDir`); `projectRoot/dist` doesn't exist, so writing
      // the manifest + copying game assets there would silently land in the wrong
      // place (or bail on the existsSync below), shipping a build with no manifest.
      const distDir = _options.dir || path.join(projectRoot, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Playable profile (MODOKI_PLAYABLE=1): a single-file ad build. Forces WebP
      // textures + a tiny HDR over the reachable set (applied at each converter's
      // resolve site below), so ~12 MB of assets collapse to ~1 MB.
      const playable = isPlayableBuild();

      // Ship the Basis transcoder for KTX2Loader. This is an ENGINE runtime
      // dependency (not a game asset), so it's needed by both the game web
      // build and the editor build — the editor renders project KTX2 textures
      // live and fetches `/basis/*` from its own dist. SKIP in a playable build:
      // its texture set is WebP-only (browser-decoded), so it emits zero KTX2
      // variants and nothing loads the ~1.2 MB of transcoder wasm.
      if (!playable) {
        shipBasisTranscoder(projectRoot, distDir, editorRoot);
        shipPixiKtxTranscoder(projectRoot, distDir, editorRoot);
      }

      // Editor builds (`MODOKI_EDITOR=true vite build`, the packaged Electron
      // editor) ship NO game assets. The Electron editor serves the opened
      // project's assets live from disk via the backend at runtime, so baking
      // games/ textures/models/scenes into the editor dist is wasted work — and
      // it breaks the release build, where game assets are Git-LFS pointer files
      // the CI runner can't transcode (sharp/toktx choke on the LFS stubs). The
      // editor uses a live manifest scan (getManifest), not the baked
      // assets.manifest.json, so omitting it here is safe.
      if (process.env.MODOKI_EDITOR === 'true') {
        // eslint-disable-next-line no-console
        console.log('[asset-shaker] editor build — skipping game asset bundling (assets served live from the opened project).');
        return;
      }

      // Resolve the module flags the same way vite.config.ts does, so the shaker and the
      // bundle agree on what is in this build. `video: false` drops the clips — the toggle's
      // real payload, since video's JS is engine code the runtime barrel keeps alive anyway.
      const projectConfig = loadProjectConfig(projectRoot);
      const buildModules = resolveModules(
        projectConfig.build.modules,
        projectRoot,
        { playable: process.env.VITE_PLAYABLE === '1' },
      );
      // Texture LOD by quality tier (#212): the DISTINCT non-zero `textureMaxSize` caps this
      // project's `mid`/`low` tiers author, if any. Read ONCE here (not project's `high`/default —
      // that tier ships the source size, nothing to shrink). An unauthored project (no `tiers`,
      // the common case today) yields an empty array and the emit loop below is a no-op — a
      // byte-identical build to before this feature existed.
      //
      // Gated on `shouldEmitTextureTierVariants` (owner decision): every size ships INSIDE the
      // package, so a plain native install pays the +19% dist cost for nothing it will ever
      // fetch. Emit only when the payload travels over the wire (web, or an OTA publish) unless
      // the project's `build.textureTierVariants` overrides it — see `plugins/textureTierEmit.ts`.
      const tierTextureMaxSizeCaps = shouldEmitTextureTierVariants(projectConfig.build.textureTierVariants)
        ? Array.from(new Set(
          [projectConfig.rendering.three.tiers?.mid?.textureMaxSize, projectConfig.rendering.three.tiers?.low?.textureMaxSize]
            .filter((v): v is number => typeof v === 'number' && v > 0),
        ))
        : [];
      const result = computeKeptAssets(projectRoot, assetRoots, { excludeVideo: !buildModules.video });
      // Build-time guard (#237): fail rather than ship a ref the structured walk could not see.
      // computeKeptAssets' unreachableRefs is empty on every committed project today — a
      // non-empty entry means probeTraitRefs (plugins/asset-tree-shaker.ts) has a blind spot
      // like #237's (SkinnedMeshRenderer.materials, a nested Record no field-shape handler
      // covered), and the asset it names resolves to nothing at runtime: dropped from the build,
      // 404ing on-device with no dev-mode symptom to catch it first (dev serves everything off
      // disk regardless of the shake). Deliberately BUILD-ONLY — the editor's own
      // computeUnused() call (the "Clean Up Unused Assets" dialog, above in this file) must stay
      // non-throwing, since it runs on every keystroke-adjacent editor action, not just a build.
      if (result.unreachableRefs.length > 0) {
        const detail = result.unreachableRefs
          .map((r) => `  ${r.guid} → ${r.target} (referenced by ${r.referencedBy})`)
          .join('\n');
        throw new Error(
          `[asset-shaker] found ${result.unreachableRefs.length} ref(s) the tree-shaker could not see:\n${detail}\n` +
          `Each of these resolves to nothing at runtime — the asset is dropped from the build and the ` +
          `value silently does not apply. Either teach the walker this ref shape (probeTraitRefs in ` +
          `plugins/asset-tree-shaker.ts), remove the ref, or list the asset in this project's asset-keep.json.`,
        );
      }
      const CONVERTIBLE = new Set(['.png', '.jpg', '.jpeg']);
      const MODEL_EXTS = new Set(['.glb', '.gltf']);
      const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac']);
      const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
      const FONT_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2']);

      // Copy kept non-texture, non-converted-model files verbatim. Textures
      // and converted GLBs are handled below — their source is dropped in
      // favour of the derived variants.
      let copiedCount = 0;
      // Strict conversion gate: an asset whose conversion FAILS (missing encoder
      // CLI, converter crash) is still copied as raw source below so it loads,
      // but the build FAILS at the end unless MODOKI_ALLOW_ASSET_FALLBACK=1 — so
      // prod never silently ships unoptimized PNGs/GLBs. Collected (not thrown
      // inline) so one build surfaces every failure at once.
      const allowAssetFallback = process.env.MODOKI_ALLOW_ASSET_FALLBACK === '1';
      const conversionFailures: ConversionFailure[] = [];
      for (const virtualPath of result.kept) {
        const ext = path.extname(virtualPath).toLowerCase();
        if (CONVERTIBLE.has(ext)) continue;
        if (MODEL_EXTS.has(ext)) continue; // handled by the model branch below
        if (AUDIO_EXTS.has(ext)) continue; // handled by the audio branch below
        if (VIDEO_EXTS.has(ext)) continue; // handled by the video branch below
        if (FONT_EXTS.has(ext)) continue; // handled by the font branch below
        if (ext === '.hdr') continue; // handled by the environment branch below (it
        //   ships the downscaled ~env.hdr variant + drops the multi-MB source, or
        //   ships the source verbatim when unconverted). Without this skip the
        //   generic loop ALSO copies the source → double-ship + double-count.
        const srcAbs = resolveAssetPath(virtualPath, assetRoots);
        if (!srcAbs || !fs.existsSync(srcAbs)) continue;
        const destPath = path.join(distDir, virtualPath.replace(/^\//, ''));
        if (!fs.existsSync(path.dirname(destPath))) fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcAbs, destPath);
        copiedCount++;
      }

      // Convert each kept texture (cache-aware) and copy its variants into dist
      // at deterministic variant URLs. The source PNG/JPG is NOT shipped.
      const convertedSettings = new Map<string, TextureImportSettings>(); // NFC virtualPath → settings
      const convertedHashes = new Map<string, string>(); // NFC virtualPath → content hash (manifest ?v= cache-bust)
      let variantCount = 0;
      for (const virtualPath of result.kept) {
        if (!CONVERTIBLE.has(path.extname(virtualPath).toLowerCase())) continue;
        const srcAbs = resolveAssetPath(virtualPath, assetRoots);
        if (!srcAbs || !fs.existsSync(srcAbs)) continue;
        const meta = readMetaSidecar(srcAbs) as { type?: TextureType; texture?: Partial<TextureImportSettings> };
        const settings = playable ? playableTextureSettings(resolveTextureSettings(meta)) : resolveTextureSettings(meta);
        const textureType = resolveTextureType(meta);
        try {
          const conv = await convertTexture({ projectRoot, sourceUrlPath: virtualPath, absSource: srcAbs, settings, textureType });
          for (const v of conv.variants) {
            const cacheFile = cachePathFor(getCacheDir(projectRoot), virtualPath, conv.hash, v);
            const destPath = path.join(distDir, (virtualPath + variantSuffix(v)).replace(/^\//, ''));
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(cacheFile, destPath);
            variantCount++;
          }
          // Texture LOD by quality tier (#212) — additional derived files at the project's
          // authored tier caps, ORTHOGONAL to the primary conversion above (same source, same
          // format, only `maxSize` differs). `sizesToEmit` is the pure decision (unit-tested on
          // its own); a cap that cannot shrink this texture further than it already is emits
          // nothing, so a texture already below every tier cap costs zero extra files. Skipped
          // entirely for a project that authors no tiers (`tierTextureMaxSizeCaps` is empty) —
          // the whole point being that such a project's build stays byte-identical.
          const capSizes = sizesToEmit(tierTextureMaxSizeCaps, settings.maxSize, conv.srcWidth, conv.srcHeight);
          for (const cap of capSizes) {
            const capSettings: TextureImportSettings = { ...settings, maxSize: cap as TextureImportSettings['maxSize'] };
            const capConv = await convertTexture({ projectRoot, sourceUrlPath: virtualPath, absSource: srcAbs, settings: capSettings, textureType });
            for (const v of capConv.variants) {
              const cacheFile = cachePathFor(getCacheDir(projectRoot), virtualPath, capConv.hash, v);
              const destPath = path.join(distDir, (virtualPath + variantSuffix(v, cap)).replace(/^\//, ''));
              fs.mkdirSync(path.dirname(destPath), { recursive: true });
              fs.copyFileSync(cacheFile, destPath);
              variantCount++;
            }
          }
          // Bake which caps actually got a variant onto the manifest-bound settings — the runtime
          // resolver must never GUESS a capped URL that wasn't emitted (see textureResolver.ts).
          if (capSizes.length > 0) settings.sizes = capSizes;
          convertedSettings.set(virtualPath.normalize('NFC'), settings);
          convertedHashes.set(virtualPath.normalize('NFC'), conv.hash);
        } catch (e) {
          // Fall back to shipping the source so the texture still loads — but
          // record it so the strict gate fails the build (unless allowed).
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[asset-shaker] texture convert failed for ${virtualPath} — shipping source. ${msg}`);
          conversionFailures.push({ virtualPath, kind: 'texture', error: msg });
          const destPath = path.join(distDir, virtualPath.replace(/^\//, ''));
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcAbs, destPath);
          copiedCount++;
        }
      }

      // Convert each kept audio clip that has been through the ffmpeg converter
      // (its meta has an `audioCache` block, written by the Audio Inspector Apply)
      // and copy the single variant into dist/ at `<src>~audio.<ext>` — the source
      // is NOT shipped. A clip with NO conversion settings (loadType-only or
      // untouched) is copied verbatim so it still loads. On conversion FAILURE
      // (ffmpeg missing/crash) we ship the source + record it so the strict gate
      // fails the build (unless MODOKI_ALLOW_ASSET_FALLBACK=1) — parity with textures.
      const convertedAudio = new Map<string, { settings: AudioImportSettings; ext: string; hash: string }>(); // NFC virtualPath → blocks
      let audioVariantCount = 0;
      for (const virtualPath of result.kept) {
        if (!AUDIO_EXTS.has(path.extname(virtualPath).toLowerCase())) continue;
        const srcAbs = resolveAssetPath(virtualPath, assetRoots);
        if (!srcAbs || !fs.existsSync(srcAbs)) continue;
        const meta = readMetaSidecar(srcAbs);
        const hasCache = !!(meta as { audioCache?: AudioCacheInfo }).audioCache;
        const shipSource = () => {
          const destPath = path.join(distDir, virtualPath.replace(/^\//, ''));
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcAbs, destPath);
          copiedCount++;
        };
        if (!hasCache) { shipSource(); continue; } // unconverted — ship source verbatim
        const settings = resolveAudioSettings(meta as { audio?: Partial<AudioImportSettings> });
        try {
          const conv = await convertAudio({ projectRoot, sourceUrlPath: virtualPath, absSource: srcAbs, settings });
          const cacheFile = audioCachePathFor(getAudioCacheDir(projectRoot), virtualPath, conv.hash, conv.ext);
          const destPath = path.join(distDir, (virtualPath + audioVariantSuffix(settings.format)).replace(/^\//, ''));
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(cacheFile, destPath);
          audioVariantCount++;
          convertedAudio.set(virtualPath.normalize('NFC'), { settings, ext: conv.ext, hash: conv.hash });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[asset-shaker] audio convert failed for ${virtualPath} — shipping source. ${msg}`);
          conversionFailures.push({ virtualPath, kind: 'audio', error: msg });
          shipSource();
        }
      }
      if (audioVariantCount) console.log(`[asset-shaker] converted ${audioVariantCount} audio clip(s).`);

      // Convert each kept video that has been through the ffmpeg converter (its meta
      // has a `videoCache` block) and copy the single variant into dist/ at
      // `<src>~video.mp4` — the source is NOT shipped. Unconverted video is copied
      // verbatim so it still plays. On conversion FAILURE we ship the source + record
      // it so the strict gate fails the build — parity with audio/textures.
      //
      // A `delivery: 'remote'` clip is NOT shipped: it lives on a CDN and the runtime
      // streams or downloads it (see docs/video.md § "Remote delivery"). Its SOURCE stays
      // in the project so the asset is importable, previewable and probeable like any
      // other — but the build emits only the manifest entry, which is the whole point of
      // the delivery mode. The manifest-vs-disk check skips remote entries for the same
      // reason. (This shipped remote clips verbatim while P2 was unbuilt; that note is
      // now stale and the behaviour with it.)
      const convertedVideo = new Map<string, { settings: VideoImportSettings; ext: string; hash: string; bytes: number; durationSec?: number; width?: number; height?: number; hasAudio?: boolean }>();
      let videoVariantCount = 0;
      for (const virtualPath of result.kept) {
        if (!VIDEO_EXTS.has(path.extname(virtualPath).toLowerCase())) continue;
        const srcAbs = resolveAssetPath(virtualPath, assetRoots);
        if (!srcAbs || !fs.existsSync(srcAbs)) continue;
        const meta = readMetaSidecar(srcAbs);
        const hasCache = !!(meta as { videoCache?: VideoCacheInfo }).videoCache;
        const settings = resolveVideoSettings(meta as { video?: Partial<VideoImportSettings> });
        // Remote: emit nothing at all. Checked BEFORE the unconverted fallback, or a
        // remote clip that had never been through the converter would ship verbatim —
        // which is exactly how it slipped through the first time.
        if (settings.delivery === 'remote') continue;
        const shipSource = () => {
          const destPath = path.join(distDir, virtualPath.replace(/^\//, ''));
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcAbs, destPath);
          copiedCount++;
        };
        if (!hasCache) { shipSource(); continue; } // unconverted — ship source verbatim
        try {
          const conv = await convertVideo({ projectRoot, sourceUrlPath: virtualPath, absSource: srcAbs, settings });
          const cacheFile = videoCachePathFor(getVideoCacheDir(projectRoot), virtualPath, conv.hash);
          const destPath = path.join(distDir, (virtualPath + videoVariantSuffix()).replace(/^\//, ''));
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(cacheFile, destPath);
          videoVariantCount++;
          convertedVideo.set(virtualPath.normalize('NFC'), {
            settings, ext: conv.ext, hash: conv.hash, bytes: conv.bytes,
            durationSec: conv.durationSec, width: conv.width, height: conv.height,
            hasAudio: conv.hasAudio,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[asset-shaker] video convert failed for ${virtualPath} — shipping source. ${msg}`);
          conversionFailures.push({ virtualPath, kind: 'video', error: msg });
          shipSource();
        }
      }
      if (videoVariantCount) console.log(`[asset-shaker] converted ${videoVariantCount} video clip(s).`);

      // Downscale each kept environment HDR that has been through the converter (its
      // meta has an `environmentCache` block, written by the Environment Inspector
      // Apply / reimport) and copy the single variant into dist/ at `<src>~env.hdr`
      // — the multi-MB source is NOT shipped. An HDR with NO conversion settings is
      // copied verbatim so it still loads. On conversion FAILURE we ship the source +
      // record it so the strict gate fails the build — parity with audio/textures.
      const convertedEnvs = new Map<string, { settings: EnvImportSettings; hash: string }>(); // NFC virtualPath → blocks
      let envVariantCount = 0;
      for (const virtualPath of result.kept) {
        if (path.extname(virtualPath).toLowerCase() !== '.hdr') continue;
        const srcAbs = resolveAssetPath(virtualPath, assetRoots);
        if (!srcAbs || !fs.existsSync(srcAbs)) continue;
        const meta = readMetaSidecar(srcAbs);
        const hasCache = !!(meta as { environmentCache?: EnvCacheInfo }).environmentCache;
        const shipSource = () => {
          const destPath = path.join(distDir, virtualPath.replace(/^\//, ''));
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcAbs, destPath);
          copiedCount++;
        };
        // Unconverted (no Environment-Inspector cache block) → ship source verbatim…
        // UNLESS this is a playable build, where a multi-MB raw HDR would blow the
        // budget: force a downscale-to-256 convert from the resolved defaults instead.
        if (!hasCache && !playable) { shipSource(); continue; }
        const settings = playable
          ? playableEnvSettings(resolveEnvSettings(meta as { environment?: Partial<EnvImportSettings> }))
          : resolveEnvSettings(meta as { environment?: Partial<EnvImportSettings> });
        try {
          if (settings.format === 'ultrahdr') {
            // UltraHDR is encoded browser-side (the Node build can't regenerate it), so
            // the `~ultrahdr.jpg` variant is COMMITTED next to the source — copy it from
            // the source dir into dist + drop the source. Missing ⇒ throw → ship source.
            const committed = srcAbs + ULTRAHDR_VARIANT_SUFFIX;
            if (!fs.existsSync(committed)) throw new Error('committed ~ultrahdr.jpg variant not found (re-encode in the Environment Inspector)');
            const destPath = path.join(distDir, (virtualPath + ULTRAHDR_VARIANT_SUFFIX).replace(/^\//, ''));
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(committed, destPath);
            envVariantCount++;
            const hash = (meta as { environmentCache?: EnvCacheInfo }).environmentCache?.hash ?? '';
            convertedEnvs.set(virtualPath.normalize('NFC'), { settings, hash });
          } else {
            const conv = await convertEnvironment({ projectRoot, sourceUrlPath: virtualPath, absSource: srcAbs, settings });
            const cacheFile = envCachePathFor(getEnvCacheDir(projectRoot), virtualPath, conv.hash);
            const destPath = path.join(distDir, (virtualPath + ENV_VARIANT_SUFFIX).replace(/^\//, ''));
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(cacheFile, destPath);
            envVariantCount++;
            convertedEnvs.set(virtualPath.normalize('NFC'), { settings, hash: conv.hash });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[asset-shaker] environment convert failed for ${virtualPath} — shipping source. ${msg}`);
          conversionFailures.push({ virtualPath, kind: 'environment', error: msg });
          shipSource();
        }
      }
      if (envVariantCount) console.log(`[asset-shaker] downscaled ${envVariantCount} environment HDR(s).`);

      // Bake each kept font that has been through the msdf-atlas-gen importer (its
      // meta has a `font` block, written by the Font Inspector Apply / reimport) and
      // copy the two derived files into dist/ at `<src>~atlas.png` + `<src>~metrics.json`.
      //
      // The source `.ttf`/`.otf` ships ONLY when something needs it. There are two
      // distinct consumers, and only one needs the real outlines: CANVAS text
      // (`Text2D.font`, a GUID) renders from the atlas alone, while DOM/PixiJS text
      // (`UIElement.fontFamily`, a font-asset GUID since #231) goes through the browser's
      // FontFace API — and the manifest entry for a font IS its source path, so
      // `loadAllFonts` FontFace-loads exactly that. Shipping it unconditionally wastes
      // ~300KB/font on a canvas-only game; never shipping it 404s at boot
      // ("[FontLoader] N/N fonts failed to load") for a DOM-using one. So: ship the
      // source iff `result.domFontFiles` (computed by the shaker's font-family walk —
      // see resolveFontsByFamily in asset-tree-shaker.ts) says a scene/prefab named
      // this font in `fontFamily` (by GUID, or by family name in a pre-#231 scene),
      // UNLESS `shipSource` overrides the call —
      // `'always'` for a family named from CODE (a runtime string, not a scene field,
      // which the static scan can't see) or `'never'` to force-drop despite detected
      // DOM usage. The decision is recorded as `sourceShipped` on the manifest's `font`
      // block so `loadAllFonts` knows not to fetch a path that was never shipped.
      //
      // A plain CSS-family-name font (no `font`
      // block) is copied verbatim so `fontFamily` still resolves. On bake FAILURE
      // (msdf-atlas-gen missing/crash) we ship the source + record it so the strict
      // gate fails the build (unless MODOKI_ALLOW_ASSET_FALLBACK=1) — parity with audio:
      // a failed bake means no atlas, so the source is the ONLY way the font renders
      // at all, regardless of the shipSource decision.
      const convertedFonts = new Map<string, { settings: FontImportSettings; hash: string; atlasWidth?: number; atlasHeight?: number; sourceShipped: boolean; instanced: boolean }>(); // NFC virtualPath → blocks
      let fontVariantCount = 0;
      for (const virtualPath of result.kept) {
        if (!FONT_EXTS.has(path.extname(virtualPath).toLowerCase())) continue;
        const srcAbs = resolveAssetPath(virtualPath, assetRoots);
        if (!srcAbs || !fs.existsSync(srcAbs)) continue;
        const meta = readMetaSidecar(srcAbs);
        const hasFont = !!(meta as { font?: Partial<FontImportSettings> }).font;
        const shipSource = () => {
          const destPath = path.join(distDir, virtualPath.replace(/^\//, ''));
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcAbs, destPath);
          copiedCount++;
        };
        if (!hasFont) { shipSource(); continue; } // plain CSS font — ship source verbatim
        const settings = resolveFontSettings(meta as { font?: Partial<FontImportSettings> });
        try {
          const conv = await convertFont({ projectRoot, sourceUrlPath: virtualPath, absSource: srcAbs, settings });
          for (const [suffix, cacheFile] of [
            [FONT_ATLAS_SUFFIX, atlasCachePath(getFontCacheDir(projectRoot), virtualPath, conv.hash)],
            [FONT_METRICS_SUFFIX, metricsCachePath(getFontCacheDir(projectRoot), virtualPath, conv.hash)],
          ] as const) {
            const destPath = path.join(distDir, (virtualPath + suffix).replace(/^\//, ''));
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(cacheFile, destPath);
            fontVariantCount++;
          }
          // TWO independent consumers of real outlines, and conflating them drops files:
          //  - DOM text (`UIElement.fontFamily`) wants the RAW source — the browser's
          //    FontFace API needs it, and CSS `font-weight` instances a variable font
          //    natively, so our pinned instance is not a substitute.
          //  - a DYNAMIC font's runtime generator rasterizes outlines itself, so it needs
          //    the instance when axes are authored, else the raw source. This half used to
          //    be missing entirely: the decision keyed only on DOM usage, so a dynamic
          //    font referenced solely by `Text2D.font` (a GUID) had its source dropped and
          //    404'd at boot in a production build. Dev never showed it — it serves
          //    everything off disk.
          const domUsed = result.domFontFiles.has(virtualPath.normalize('NFC'));
          const domWants = settings.shipSource === 'always' || (settings.shipSource !== 'never' && domUsed);
          const genWants = settings.mode === 'dynamic';
          const shipInstance = genWants && !!conv.instanced;
          const shipTtf = domWants || (genWants && !shipInstance);
          if (shipTtf) shipSource();
          if (shipInstance) {
            const destPath = path.join(distDir, (virtualPath + FONT_INSTANCE_SUFFIX).replace(/^\//, ''));
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(instanceCachePath(getFontCacheDir(projectRoot), virtualPath, conv.hash), destPath);
            fontVariantCount++;
          }
          const why = [
            domWants ? (settings.shipSource === 'always' ? "source (shipSource:'always')" : 'source (DOM fontFamily usage)') : null,
            shipInstance ? 'instance (dynamic + variationAxes)' : null,
            !domWants && genWants && !shipInstance ? 'source (dynamic runtime generation)' : null,
          ].filter(Boolean);
          console.log(`[asset-shaker] font ${virtualPath}: ${['atlas', ...why].join(' + ')}`);
          convertedFonts.set(virtualPath.normalize('NFC'), { settings, hash: conv.hash, atlasWidth: conv.atlasWidth, atlasHeight: conv.atlasHeight, sourceShipped: shipTtf, instanced: shipInstance });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[asset-shaker] font bake failed for ${virtualPath} — shipping source. ${msg}`);
          conversionFailures.push({ virtualPath, kind: 'font', error: msg });
          shipSource();
        }
      }
      if (fontVariantCount) console.log(`[asset-shaker] baked ${fontVariantCount / 2} font atlas(es).`);

      // Convert each kept model (cache-aware) and copy its LOD GLBs into
      // dist/ at deterministic URL suffixes. Source GLB is NOT shipped.
      // On failure (CLI missing, simplify crash) we fall back to shipping the
      // raw source so the scene still loads — visible perf hit, not a build break.
      const convertedModels = new Map<string, { settings: ModelImportSettings; cache: ModelCacheInfo }>(); // NFC virtualPath → blocks
      let lodCount = 0;

      // Pre-scan: collect (virtualPath, srcAbs, settings, postprocessorId) for
      // every kept model so we can decide whether to pay the cost of spinning
      // up a Vite SSR server for Stage A postprocessor baking. The dev path
      // resolves postprocessors via the running dev server's ssrLoadModule;
      // the build path has no such server, so writeBundle stands up a
      // short-lived one in middleware mode whenever a non-none postprocessor
      // is referenced.
      const modelJobs: Array<{
        virtualPath: string;
        srcAbs: string;
        settings: ModelImportSettings;
        postprocessorId: string;
        recipeVersion: number;
      }> = [];
      let needsSsrLoader = false;
      // Rigged (skeletal) GLBs take the "parallel path" — loaded WHOLE by
      // riggedModelCache (bones + skeleton + clips intact). convertModel is
      // wrong for them (it strips textures + flattens for the static .mesh.json
      // path), so they run through convertRiggedModel instead: a single
      // optimized variant (resize + KTX2 + meshopt) derived into the model cache
      // at the SAME `processed.glb` layout, then copied to dist + dropped-raw +
      // manifested exactly like a static LOD0. Detected via the `.meta.json`
      // `rig` block written by importRiggedModel.
      const riggedJobs: Array<{ virtualPath: string; srcAbs: string; settings: TextureImportSettings }> = [];
      // Postprocessors are declared by the PROJECT (project.config.json), not a
      // hardcoded engine table — see reimport-model.ts.
      const declaredPostprocessors = loadProjectConfig(projectRoot).postprocessors ?? {};
      for (const virtualPath of result.kept) {
        const ext = path.extname(virtualPath).toLowerCase();
        if (!MODEL_EXTS.has(ext)) continue;
        const srcAbs = resolveAssetPath(virtualPath, assetRoots);
        if (!srcAbs || !fs.existsSync(srcAbs)) continue;
        const meta = readMetaSidecar(srcAbs);
        if (isRiggedMeta(meta)) {
          // Playable: force the WebP override so the rig's EMBEDDED textures aren't KTX2-compressed
          // (ktxCommandFor('webp') → null → they stay raw/browser-decodable). Otherwise the default
          // ktx2-uastc bakes KHR_texture_basisu into the GLB while the playable profile skips the
          // Basis transcoder → the model can't decode its textures offline.
          const rigTex = resolveTextureSettings(meta as { texture?: Partial<TextureImportSettings> });
          riggedJobs.push({ virtualPath, srcAbs, settings: playable ? playableTextureSettings(rigTex) : rigTex });
          continue;
        }
        const settings = resolveModelSettings(meta as { model?: Partial<ModelImportSettings> });
        const postprocessorId = typeof meta.postprocessor === 'string' ? meta.postprocessor : 'none';
        const reg = declaredPostprocessors[postprocessorId];
        const recipeVersion = reg?.recipeVersion ?? 0;
        if (postprocessorId !== 'none' && reg?.file) needsSsrLoader = true;
        modelJobs.push({ virtualPath, srcAbs, settings, postprocessorId, recipeVersion });
      }

      // Derive each rigged GLB's optimized variant and copy it to dist/ at the
      // `<src>.glb.processed.glb` URL — the SAME convention static LOD0 uses, so
      // the runtime resolves it via modelCache.processedPath. The raw GLB is
      // NOT shipped. On failure, fall back to shipping the raw source so the
      // model still loads (unoptimized) rather than 404ing.
      for (const { virtualPath, srcAbs, settings } of riggedJobs) {
        try {
          const conv = await convertRiggedModel({ projectRoot, sourceUrlPath: virtualPath, absSource: srcAbs, settings });
          const destPath = path.join(distDir, (virtualPath + lodUrlSuffix(0)).replace(/^\//, ''));
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(conv.processedPath, destPath);
          lodCount++;
          convertedModels.set(virtualPath.normalize('NFC'), {
            settings: resolveModelSettings({}),
            cache: {
              hash: conv.hash,
              processedPath: virtualPath + lodUrlSuffix(0),
              lodPaths: [virtualPath + lodUrlSuffix(0)],
              lodDistances: [0],
              triCounts: [0],
              lodBytes: [conv.bytes],
            },
          });
          console.log(`[asset-shaker] rigged GLB optimized → ${virtualPath}${lodUrlSuffix(0)} (${(fs.statSync(srcAbs).size / 1e6).toFixed(1)} → ${(conv.bytes / 1e6).toFixed(1)} MB)`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[asset-shaker] rigged convert failed for ${virtualPath} — shipping raw source. ${msg}`);
          conversionFailures.push({ virtualPath, kind: 'rigged model', error: msg });
          const destPath = path.join(distDir, virtualPath.replace(/^\//, ''));
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcAbs, destPath);
          copiedCount++;
        }
      }

      // Lazily start a Vite SSR-only server. Heavy (~1-2s startup) — only
      // pay the cost when at least one kept model uses a non-none postprocessor.
      // We import vite dynamically so the plugin doesn't need a top-level
      // dependency on vite's runtime API surface beyond `type { Plugin }`.
      // Engine source + repo root for the build SSR server. Derive from editorRoot
      // (= dirname(config.root) = repoRoot; the favicon copy below trusts the same
      // editorRoot+'engine/...' join) — NOT the module-level import.meta.url consts,
      // which Vite breaks by relocating the bundled plugin into node_modules/.vite-temp
      // (so `../packages/...` resolves to engine/node_modules/packages/...). Fall back
      // to the consts only if editorRoot is somehow unset.
      const enginePkgSrcAbs = editorRoot ? path.join(editorRoot, 'engine/packages/modoki/src') : ENGINE_PKG_SRC;
      const repoRootAbs = editorRoot || ENGINE_REPO_ROOT;

      let ssrServer: { ssrLoadModule: (url: string) => Promise<Record<string, unknown>>; close: () => Promise<void> } | null = null;
      if (needsSsrLoader) {
        try {
          const { createServer } = await import('vite');
          // configFile:false ⇒ none of engine/vite.config.ts's resolution. The
          // postprocessor imports `@modoki/engine/runtime` + `three`, and we load
          // the postprocessor registry from engine source — so alias @modoki/engine
          // to the engine package source (mirroring its exports map), dedupe three,
          // and allow fs access to the engine tree + the project. (`three` resolves
          // via the importer's upward node_modules walk for an in-repo project.)
          const aliasFor = (sub: string, file: string) =>
            ({ find: new RegExp(`^@modoki/engine${sub}$`), replacement: path.join(enginePkgSrcAbs, file) });
          const inner = await createServer({
            configFile: false,
            root: projectRoot,
            // The engine runtime modules this SSR bake pulls in (via the postprocessor's
            // `@modoki/engine/runtime` import) reference the `__MODOKI_MODULE_*__` flag
            // globals for build-time DCE (e.g. materialInstanceSystem's RENDER2D gate,
            // materialPresets' RENDER3D gate). configFile:false means engine/vite.config.ts's
            // `define` block does NOT apply here, so those globals would be undefined →
            // ReferenceError → the model bake silently degrades to passthrough. Define them
            // all-on: this is build tooling running a THREE.Mesh fixup, not a shipped bundle,
            // so it should see the FULL engine (mirrors the editor/dev all-modules-on context).
            define: {
              __MODOKI_MODULE_RENDER3D__: 'true',
              __MODOKI_MODULE_RENDER2D__: 'true',
              __MODOKI_MODULE_PHYSICS2D__: 'true',
              __MODOKI_MODULE_PHYSICS3D__: 'true',
              __MODOKI_MODULE_VIDEO__: 'true',
            },
            resolve: {
              alias: [
                aliasFor('/runtime/rendering', 'runtime/rendering/index.ts'),
                aliasFor('/runtime', 'runtime/index.ts'),
                aliasFor('/editor/rendering', 'editor/rendering/index.ts'),
                aliasFor('/editor', 'editor/index.ts'),
                aliasFor('/three', 'three/index.ts'),
              ],
              dedupe: ['three'],
            },
            server: { middlewareMode: true, hmr: false, fs: { allow: [repoRootAbs, projectRoot].filter(Boolean) } },
            appType: 'custom',
            logLevel: 'warn',
          });
          ssrServer = {
            ssrLoadModule: (url) => inner.ssrLoadModule(url) as Promise<Record<string, unknown>>,
            close: () => inner.close().then(() => undefined),
          };
          console.log(`[asset-shaker] Stage A bake server up — ${modelJobs.filter((j) => j.postprocessorId !== 'none').length} model(s) need postprocessor fixups.`);
        } catch (e) {
          console.warn(`[asset-shaker] failed to start SSR postprocessor server — Stage A bake will passthrough. ${e instanceof Error ? e.message : e}`);
        }
      }

      const ssrCtx: ReimportContext | null = ssrServer
        ? { projectRoot, resolveAssetPath: (p) => resolveAssetPath(p, assetRoots), ssrLoadModule: ssrServer.ssrLoadModule, enginePkgSrc: enginePkgSrcAbs || undefined }
        : null;
      const resolvePostprocessorBuild = ssrCtx ? (id: string) => resolvePostprocessorForId(id, ssrCtx) : undefined;

      for (const { virtualPath, srcAbs, settings, postprocessorId, recipeVersion } of modelJobs) {
        // Track every LOD GLB we copy into dist/ so a mid-loop ENOENT can
        // roll back the partial set — otherwise the catch's source-fallback
        // ships alongside half-baked LOD copies, and the manifest claims
        // URLs that don't all resolve.
        const writtenLodDest: string[] = [];
        try {
          const conv = await convertModel({ projectRoot, sourceUrlPath: virtualPath, absSource: srcAbs, settings, postprocessorId, recipeVersion, resolvePostprocessor: resolvePostprocessorBuild });
          for (let i = 0; i < conv.lodPaths.length; i++) {
            const cacheFile = lodCachePath(getModelCacheDir(projectRoot), virtualPath, conv.hash, i);
            const destPath = path.join(distDir, (virtualPath + lodUrlSuffix(i)).replace(/^\//, ''));
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(cacheFile, destPath);
            writtenLodDest.push(destPath);
            lodCount++;
          }
          convertedModels.set(virtualPath.normalize('NFC'), {
            settings,
            cache: {
              hash: conv.hash,
              processedPath: virtualPath + lodUrlSuffix(0),
              lodPaths: conv.lodPaths.map((_, i) => virtualPath + lodUrlSuffix(i)),
              lodDistances: conv.lodDistances,
              triCounts: conv.triCounts,
              lodBytes: conv.lodBytes,
            },
          });
        } catch (e) {
          // Roll back partial LOD copies before falling back to the source —
          // otherwise the manifest entry (recorded only on the success branch)
          // is absent but the dist still contains orphan `*.lod*.glb` files
          // from a previous iteration of this build (or worse: bytes from a
          // previous build).
          for (const p of writtenLodDest) {
            try { fs.rmSync(p, { force: true }); } catch { /* best-effort */ }
          }
          // Fall back to shipping the source GLB so the runtime can still load it.
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[asset-shaker] model convert failed for ${virtualPath} — shipping source. ${msg}`);
          conversionFailures.push({ virtualPath, kind: 'model', error: msg });
          const destPath = path.join(distDir, virtualPath.replace(/^\//, ''));
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcAbs, destPath);
          copiedCount++;
        }
      }

      // Shut down the build-time SSR server; the dev path keeps its own.
      if (ssrServer) {
        try { await ssrServer.close(); }
        catch (e) { console.warn(`[asset-shaker] SSR server close warning: ${e instanceof Error ? e.message : e}`); }
      }

      // Pack each kept atlas and copy its page variants into dist/. Runs BEFORE the
      // manifest scan below so the freshly-written sidecar `atlasCache` is read into the
      // atlas's manifest entry (scanDir picks it up). The fully-packed member source
      // textures are already absent from `result.kept` (the tree-shaker redirected their
      // refs to the atlas), so they aren't copied — the pages replace them.
      const atlasReCtx: ReimportContext = {
        projectRoot,
        resolveAssetPath: (p) => resolveAssetPath(p, assetRoots),
        listAssets: () => scanAllAssets(assetRoots),
      };
      let atlasPageCount = 0;
      for (const virtualPath of result.kept) {
        if (!virtualPath.endsWith('.atlas.json')) continue;
        const srcAbs = resolveAssetPath(virtualPath, assetRoots);
        if (!srcAbs || !fs.existsSync(srcAbs)) continue;
        try {
          await atlasReimportHandler(virtualPath, srcAbs, atlasReCtx);
          const cache = (readMetaSidecar(srcAbs) as { atlasCache?: AtlasCacheBlock }).atlasCache;
          if (!cache) continue;
          for (let p = 0; p < cache.pages.length; p++) {
            for (const v of cache.pages[p].variants) {
              const cacheFile = cachePathFor(getCacheDir(projectRoot), atlasPageUrlPath(virtualPath, p), cache.pages[p].hash, v as TextureVariant);
              const destPath = path.join(distDir, (atlasPageUrlPath(virtualPath, p) + variantSuffix(v as TextureVariant)).replace(/^\//, ''));
              fs.mkdirSync(path.dirname(destPath), { recursive: true });
              fs.copyFileSync(cacheFile, destPath);
              atlasPageCount++;
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[asset-shaker] atlas pack failed for ${virtualPath} — ${msg}`);
          conversionFailures.push({ virtualPath, kind: 'atlas', error: msg });
        }
      }
      if (atlasPageCount) console.log(`[asset-shaker] packed ${atlasPageCount} atlas page variant(s).`);

      // Strict gate: fail the build if any asset fell back to raw source
      // (default). Keeps prod from silently shipping unoptimized assets when an
      // encoder CLI is missing. MODOKI_ALLOW_ASSET_FALLBACK=1 opts out.
      assertNoConversionFallback(conversionFailures, { allowFallback: allowAssetFallback });

      // Write a filtered manifest containing only kept assets, with baked texture
      // settings so the runtime resolves variant URLs in production (no source PNG
      // present to fall back to). Normalize to NFC so macOS APFS NFD filenames
      // match the NFC paths in the keep set.
      const keepNfc = new Set<string>();
      for (const p of result.kept) keepNfc.add(p.normalize('NFC'));
      // Keep the tree-shaken files PLUS each surviving texture's sprite slices (see
      // filterKeptAssets) so a sprite-sheet's GUIDs still resolve in the deployed build.
      const keptAssets = filterKeptAssets(scanAllAssets(assetRoots), keepNfc);
      const manifestObj = buildManifest(keptAssets);
      for (const entry of manifestObj.assets) {
        const s = convertedSettings.get(entry.path.normalize('NFC'));
        if (s) entry.texture = s;
        // Set the cache-bust hash from the BUILD-TIME conversion (textures) / cache
        // (models), not the possibly-stale meta sidecar — so ?v=<hash> always
        // matches the variant actually shipped into dist/.
        const h = convertedHashes.get(entry.path.normalize('NFC'));
        if (h) entry.hash = h;
        const m = convertedModels.get(entry.path.normalize('NFC'));
        if (m) { entry.model = m.settings; entry.modelCache = m.cache; entry.hash = m.cache.hash; }
        // Audio: bake the converted variant's ext + loadType + build-time hash so the
        // runtime resolves `<src>~audio.<ext>?v=<hash>` (source dropped from dist).
        const a = convertedAudio.get(entry.path.normalize('NFC'));
        if (a) {
          entry.audio = { loadType: a.settings.loadType, format: a.settings.format, ext: a.ext };
          entry.hash = a.hash;
        } else if (entry.audio?.ext) {
          // Conversion did NOT run/succeed this build (e.g. ffmpeg missing +
          // MODOKI_ALLOW_ASSET_FALLBACK=1 shipped the raw source): drop the
          // sidecar-baked variant fields so the manifest advertises — and the
          // dist verifier checks — the raw source that was actually shipped,
          // not a `~audio.<ext>` variant that was never written.
          entry.audio = { loadType: entry.audio.loadType };
          entry.hash = undefined;
        }
        // Video: bake the converted variant's ext + measured size + build-time hash so
        // the runtime resolves `<src>~video.mp4?v=<hash>` (source dropped from dist).
        const vid = convertedVideo.get(entry.path.normalize('NFC'));
        if (vid) {
          entry.video = {
            delivery: vid.settings.delivery,
            policy: vid.settings.policy,
            ...(vid.settings.delivery === 'remote' && vid.settings.remoteUrl
              ? { remoteUrl: vid.settings.remoteUrl } : {}),
            ext: vid.ext,
            bytes: vid.bytes,
            ...(vid.durationSec != null ? { durationSec: vid.durationSec } : {}),
            ...(vid.width != null ? { width: vid.width } : {}),
            ...(vid.height != null ? { height: vid.height } : {}),
            ...(vid.hasAudio != null ? { hasAudio: vid.hasAudio } : {}),
          };
          entry.hash = vid.hash;
        } else if (entry.video?.ext) {
          // Conversion did NOT run/succeed this build (ffmpeg missing +
          // MODOKI_ALLOW_ASSET_FALLBACK=1 shipped the raw source): drop the
          // sidecar-baked variant fields so the manifest advertises the raw source
          // that was actually shipped, not a `~video.mp4` that was never written.
          // `bytes` goes too — a stale size would make `policy: 'auto'` decide against
          // a file that isn't there.
          entry.video = {
            delivery: entry.video.delivery, policy: entry.video.policy,
            ...(entry.video.remoteUrl ? { remoteUrl: entry.video.remoteUrl } : {}),
          };
          entry.hash = undefined;
        }
        // Font: bake the manifest block (mode/fieldType/distanceRange/atlas dims) +
        // the build-time hash so the runtime resolves `<src>~atlas.png?v=<hash>` +
        // `~metrics.json`, plus `sourceShipped` recording whether the source `.ttf`
        // was ALSO shipped this build (see the ship-source decision above) — absent
        // that flag `loadAllFonts` can't tell a dropped-on-purpose source from a
        // real 404. A font that fell back to raw source (bake failed + fallback
        // allowed) keeps no `font` block, so the verifier below checks the shipped
        // source instead.
        const f = convertedFonts.get(entry.path.normalize('NFC'));
        if (f) {
          const block: FontManifestBlock = {
            mode: f.settings.mode,
            fieldType: f.settings.fieldType,
            distanceRange: f.settings.pxRange,
            ...(f.atlasWidth != null ? { atlasWidth: f.atlasWidth } : {}),
            ...(f.atlasHeight != null ? { atlasHeight: f.atlasHeight } : {}),
            sourceShipped: f.sourceShipped,
            ...(f.instanced ? { instanced: true } : {}),
            // Dynamic-only: the runtime generator needs the authored knobs the baked
            // path consumes at build time. Omitted for baked fonts (dead weight).
            ...(f.settings.mode === 'dynamic' ? {
              size: f.settings.size,
              atlasMax: f.settings.atlasMax,
              charset: f.settings.charset,
              ...(f.settings.customChars ? { customChars: f.settings.customChars } : {}),
            } : {}),
          };
          entry.font = block;
          entry.hash = f.hash;
        } else if (entry.font) {
          entry.font = undefined;
          entry.hash = undefined;
        }
        // Environment: bake the block (format/maxSize) + build-time hash so the
        // runtime resolves `<src>~env.hdr?v=<hash>` (source HDR dropped from dist). An
        // HDR that fell back to raw source (convert failed + fallback allowed) keeps
        // no `environment` block, so the verifier checks the shipped source instead.
        const ev = convertedEnvs.get(entry.path.normalize('NFC'));
        if (ev) {
          entry.environment = { format: ev.settings.format, maxSize: ev.settings.maxSize };
          entry.hash = ev.hash;
        } else if (entry.environment) {
          entry.environment = undefined;
          entry.hash = undefined;
        }
      }
      fs.writeFileSync(path.join(distDir, 'assets.manifest.json'), JSON.stringify(manifestObj, null, 2));

      // Verify every URL the runtime will resolve from the manifest is backed
      // by a real, non-empty file in dist/. Catches torn LOD/variant copies
      // (N6 / C13 fallout) and stray manifest entries whose source files were
      // dropped after this build's keep set was computed.
      {
        const missing: Array<{ path: string; reason: string }> = [];
        const checkFile = (relUrl: string, label: string) => {
          const abs = path.join(distDir, relUrl.replace(/^\//, ''));
          try {
            const stat = fs.statSync(abs);
            if (!stat.isFile()) missing.push({ path: relUrl, reason: `${label}: not a file` });
            else if (stat.size === 0) missing.push({ path: relUrl, reason: `${label}: empty (0 bytes)` });
          } catch {
            missing.push({ path: relUrl, reason: `${label}: missing` });
          }
        };
        for (const entry of manifestObj.assets) {
          // Sliced sprites have no file of their own — they resolve through the parent
          // texture's variant (verified via that texture entry). Skip the file check.
          if (entry.type === 'sprite') continue;
          if (entry.texture) {
            // Variant files are a pure function of (format, textureType) — the same
            // derivation the emitter + runtime resolver use — so derive it here rather
            // than storing a variant list. A 2d/ui texture also emits a WebP sibling.
            for (const v of variantsToEmit(entry.texture.format, entry.textureType ?? resolveTextureType({ texture: entry.texture }))) {
              checkFile(entry.path + variantSuffix(v), 'variant');
              // Texture LOD by quality tier (#212) — verify every size the manifest CLAIMS was
              // emitted actually landed in dist. `entry.texture.sizes` is baked by the emitter
              // above, so a mismatch here is a real bug (a cap the runtime would 404 on), not a
              // derivable set like the base variants above it.
              for (const cap of entry.texture.sizes ?? []) {
                checkFile(entry.path + variantSuffix(v, cap), 'tier-sized variant');
              }
            }
          } else if (entry.modelCache) {
            for (const lodPath of entry.modelCache.lodPaths) {
              checkFile(lodPath, 'LOD');
            }
          } else if (entry.atlas) {
            // Each generated page variant must be backed by a real dist file.
            for (let p = 0; p < entry.atlas.pages.length; p++) {
              for (const v of entry.atlas.pages[p].variants) {
                checkFile(atlasPageUrlPath(entry.path, p) + variantSuffix(v as TextureVariant), 'atlas page');
              }
            }
          } else if (entry.audio?.ext) {
            // Converted audio — the source was dropped; verify the single variant.
            checkFile(entry.path + `~audio.${entry.audio.ext}`, 'audio variant');
          } else if (entry.video?.delivery === 'remote') {
            // Nothing on disk BY DESIGN: a remote clip lives on the CDN and is streamed or
            // downloaded at runtime. Checked before the `ext` case below because a remote
            // entry never HAS an ext — it is never converted — so gating on ext alone let it
            // fall through to the plain-copy check and fail the build.
          } else if (entry.video?.ext) {
            // Converted video — the source was dropped, so the SOURCE path in `entry.path` is
            // never on disk; verify the emitted variant instead. Without this branch the entry
            // fell through to the plain-copy check below and every video failed the build.
            checkFile(entry.path + `~video.${entry.video.ext}`, 'video variant');
          } else if (entry.font) {
            // Baked font — verify both derived files. The source .ttf may or may not
            // have shipped too (`entry.font.sourceShipped`); either way it isn't what
            // the atlas/dynamic-gen path resolves, so it's not checked here.
            checkFile(entry.path + FONT_ATLAS_SUFFIX, 'font atlas');
            checkFile(entry.path + FONT_METRICS_SUFFIX, 'font metrics');
            // A DYNAMIC font also generates glyphs at runtime from real outlines, so the
            // file it will fetch must exist: the pinned instance when axes are authored,
            // else the source itself. (A BAKED font renders from the atlas alone; its
            // source ships only for DOM consumers, which is not checked here.)
            if (entry.font.mode === 'dynamic') {
              if (entry.font.instanced) checkFile(entry.path + FONT_INSTANCE_SUFFIX, 'font instance (dynamic + variationAxes)');
              else checkFile(entry.path, 'font source (dynamic runtime generation)');
            }
          } else if (entry.environment) {
            // Converted HDR — the source was dropped; verify the format's variant
            // (`~env.hdr` downscaled, or the committed `~ultrahdr.jpg` gainmap).
            checkFile(entry.path + envVariantSuffix(entry.environment.format ?? 'hdr'), 'environment variant');
          } else {
            // Plain copy — source was shipped verbatim.
            checkFile(entry.path, 'asset');
          }
        }
        if (missing.length > 0) {
          const shown = missing.slice(0, 20);
          const detail = shown.map((m) => `  ${m.path} — ${m.reason}`).join('\n');
          const extra = missing.length > shown.length ? `\n  …and ${missing.length - shown.length} more` : '';
          throw new Error(
            `[asset-shaker] manifest references ${missing.length} missing/empty file(s) in dist/:\n${detail}${extra}`,
          );
        }
      }

      // Report.
      const stats = result.stats;
      const totalShippable =
        Object.values(stats.totalByType).reduce((a, b) => a + b, 0);
      const keptCount = copiedCount + convertedSettings.size + convertedModels.size + convertedAudio.size + convertedFonts.size + convertedEnvs.size;
      const droppedCount = totalShippable - keptCount;
      const typeLines = Object.keys(stats.totalByType)
        .sort()
        .map(t => `${t} ${stats.keptByType[t] ?? 0}/${stats.totalByType[t]}`)
        .join(', ');

      // eslint-disable-next-line no-console
      console.log(
        `[asset-shaker] scenes: ${stats.scenes}  kept: ${copiedCount} files + ` +
        `${convertedSettings.size} textures→${variantCount} variants + ` +
        `${convertedModels.size} models→${lodCount} LODs ` +
        `(source ${formatBytes(stats.keptBytes)})  dropped: ${droppedCount} files`
      );
      if (typeLines) {
        // eslint-disable-next-line no-console
        console.log(`[asset-shaker] by type: ${typeLines}`);
      }
      for (const warning of result.warnings) {
        // eslint-disable-next-line no-console
        console.warn(`[asset-shaker] WARN: ${warning}`);
      }
      // Surface dropped files so drift is visible. Limit to 10 to avoid log spam.
      if (result.orphans.length > 0) {
        const shown = result.orphans.slice(0, 10);
        // eslint-disable-next-line no-console
        console.log(
          `[asset-shaker] dropped files (first ${shown.length} of ${result.orphans.length}):\n` +
          shown.map(o => `  ${o}`).join('\n')
        );
      }
    },
  };
}
