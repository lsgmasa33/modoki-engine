/** Vite plugin: scans all assets/ folders in the project and serves them via /api/scan-assets.
 *  Convention: any directory named "assets" is a scannable asset root.
 *  Also writes assets.manifest.json on build so production builds have a static manifest. */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import crypto, { randomUUID } from 'crypto';
import type { Plugin } from 'vite';
import { computeKeptAssets, formatBytes } from './asset-tree-shaker';
import { assertNoConversionFallback, type ConversionFailure } from './asset-conversion-strict';
import { loadProjectConfig, loadProjectUserConfig, validateBuildConfig } from './load-project-config';
import { findGamesEntry } from './findGamesEntry';
import { projectAssetRoots } from '../scripts/projectRoots.mjs';
import { detect as detectTool, detectAdb, ensureNode, preflight as preflightBuild, install as installTool, isInstallable, cocoapodsEnv, type BuildTarget, type ToolId } from '../toolchain';
import { registerReimportHandler, type ReimportContext } from './reimport-registry';
import { textureReimportHandler } from './reimport-texture';
import { modelReimportHandler, resolvePostprocessorForId, validatePostprocessorRegistry, isRiggedMeta } from './reimport-model';
import { atlasReimportHandler } from './reimport-atlas';
import { audioReimportHandler } from './reimport-audio';
import { fontReimportHandler } from './reimport-font';
import { environmentReimportHandler } from './reimport-environment';
import { convertFont } from './font-convert';
import { getFontCacheDir, atlasCachePath, metricsCachePath } from './font-cache';
import { resolveFontSettings, FONT_ATLAS_SUFFIX, FONT_METRICS_SUFFIX, type FontImportSettings, type FontManifestBlock, type FontCacheInfo } from '../packages/modoki/src/runtime/loaders/fontSettings';
import { readMetaSidecar } from './meta-sidecar';
import { classifyJsonAssetSuffix, ID_BEARING_TYPES, BINARY_EXT_TYPE } from './assetTypes';
import { getCacheDir, cachePathFor } from './texture-cache';
import { getAudioCacheDir, audioCachePathFor } from './audio-cache';
import { convertAudio } from './audio-convert';
import { resolveAudioSettings, audioFormatExtension, audioVariantSuffix, type AudioImportSettings } from '../packages/modoki/src/runtime/loaders/audioSettings';
import type { AudioCacheInfo } from '../packages/modoki/src/runtime/loaders/audioSettings';
import { resolveEnvSettings, ENV_VARIANT_SUFFIX, ULTRAHDR_VARIANT_SUFFIX, envVariantSuffix, type EnvImportSettings, type EnvManifestBlock, type EnvCacheInfo } from '../packages/modoki/src/runtime/loaders/environmentSettings';
import { convertEnvironment } from './env-convert';
import { getEnvCacheDir, envCachePathFor } from './env-cache';
import { atlasPageUrlPath } from './atlas-cache';
import { getModelCacheDir, lodCachePath } from './model-cache';
import { convertTexture } from './texture-convert';
import { convertModel } from './model-convert';
import { convertRiggedModel } from './rigged-model-optimize';
import { resolveTextureSettings, resolveTextureType, variantSuffix, variantsToEmit, type TextureImportSettings, type TextureType, type TextureVariant } from '../packages/modoki/src/runtime/loaders/textureSettings';
import { isPlayableBuild, playableTextureSettings, playableEnvSettings } from './playable-profile';
import { deriveGuid } from '../packages/modoki/src/runtime/loaders/assetRefRules';
import { resolveModelSettings, lodUrlSuffix, type ModelImportSettings, type ModelCacheInfo } from '../packages/modoki/src/runtime/loaders/modelSettings';
import { type SpriteSlice, type SpriteAssetRef } from '../packages/modoki/src/runtime/loaders/spriteSheet';
import { type AtlasCacheBlock } from '../packages/modoki/src/runtime/loaders/spriteAtlas';
import { type SceneSchema } from '../packages/modoki/src/runtime/scene/sceneValidation';
import { handleBackendRequest, type BackendContext, type BackendResult } from './backend/editorBackendRouter';
import { vendorEnginePlugins, writeVendorMarker } from './vendorPlugins';
import { spawnBuildCommand, resolveBuildStep, type BuildStep } from './buildStepShell';
import { healNativeConfig } from './healNativeConfig';
import { ensureCapacitorDeps, ensureCapacitorConfig, detectMissingFirebase, type NativePlatform } from './addNativeTarget';
import { discoverSigningTeams, type SigningTeam } from './signingTeams';
import { serveProjectAsset } from './backend/staticAssets';
import { writeBackendResult } from './backend/writeResult';
import type { ProjectConfig } from '../project-config';

/** The scaffold half of "Add Native Target": the in-process edits (Capacitor
 *  deps + capacitor.config.json + vendored engine plugins) followed by the shell
 *  steps (install → web build → `npx cap add` → heal native config). Shared by
 *  the explicit /api/add-native-target action AND the auto-scaffold that runs on
 *  the first native /api/build for a project with no ios/android folder yet.
 *
 *  `runShell(label, cmd, cwd)` is the caller's spawn wrapper (each SSE handler
 *  owns its own, wired to its abort/disconnect handling); a false return throws.
 *  Returns the missing-Firebase warnings the caller should surface — the build
 *  path pauses on a non-empty list so the user can supply the config first. */
async function scaffoldNativeTarget(opts: {
  projectRoot: string;
  platform: NativePlatform;
  buildCwd: string;
  cfg: ProjectConfig;
  send: (msg: string) => void;
  runShell: (label: string, cmd: string, cwd: string) => Promise<boolean>;
}): Promise<{ warnings: string[] }> {
  const { projectRoot, platform, buildCwd, cfg, send, runShell } = opts;
  // 1. In-process scaffold: deps + capacitor.config.json + vendor plugins.
  for (const n of ensureCapacitorDeps(projectRoot, platform, buildCwd).notes) send(n);
  for (const n of ensureCapacitorConfig(projectRoot, cfg).notes) send(n);
  const v = vendorEnginePlugins(projectRoot, buildCwd);
  if (v.vendored.length) send(`vendored engine plugin(s): ${v.vendored.join(', ')}`);
  // 2. Install (project) — needs the cap CLI + plugin copies present.
  if (!(await runShell('npm install', 'npm install', projectRoot))) throw new Error('npm install failed');
  writeVendorMarker(projectRoot, v.expectedVendor); // record installed tarballs (D3)
  // 3. Web build → games/<id>/dist (cap add needs webDir to exist).
  if (!(await runShell('Building web assets', 'node engine/scripts/build-web.mjs', buildCwd))) throw new Error('web build failed');
  // 4. cap add (project) — generates the native project with the capacitor.config identity baked in.
  if (!(await runShell(`cap add ${platform}`, `npx cap add ${platform}`, projectRoot))) throw new Error(`cap add ${platform} failed`);
  // 5. Heal native config (local.properties / DEVELOPMENT_TEAM) + flag missing Firebase.
  for (const n of healNativeConfig(projectRoot).notes) send(n);
  return { warnings: detectMissingFirebase(projectRoot, platform) };
}


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

/** Read the GUID for an asset file.
 *  - JSON assets (.mesh/.mat/.prefab/.scene/.animset): top-level `id` field.
 *  - Binary assets: sidecar `<file>.meta.json` with `{ id }`.
 *  Returns undefined if the file has no id yet (pre-migration). */
export function readAssetGuid(absPath: string, type: string): string | undefined {
  try {
    if (ID_BEARING_TYPES.has(type)) {
      const json = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
      return isGuidShape(json?.id) ? json.id : undefined;
    }
    // Binary: read sidecar
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
      json.id = guid;
      writeJsonAtomic(absPath, json);
      return true;
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

/** Derive a human-readable name from a filename */
function nameFromFile(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')         // strip extension
    .replace(/[_-]/g, ' ')           // underscores/hyphens → spaces
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → spaces
    .replace(/\b\w/g, c => c.toUpperCase()) // capitalize words
    .trim();
}

/** Detect type from file extension + directory convention */
export function detectType(relPath: string, ext: string): string | null {
  if (relPath.endsWith('.meta.json')) return null;
  // Committed UltraHDR variant (`<src>.hdr~ultrahdr.jpg`) — a DERIVED file next to its
  // source HDR, NOT a standalone texture asset. Exclude it from the scan (else it'd be
  // classified `.jpg` → texture and get its own meta/manifest entry).
  if (relPath.endsWith(ULTRAHDR_VARIANT_SUFFIX)) return null;
  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') return null;
  if (ext === '.css') return null;

  if (ext === '.json') {
    if (relPath.endsWith('.layout.json')) return 'layout';
    // Shared JSON asset-kind classifier (see plugins/assetTypes.ts) — the single
    // list the tree-shaker's classify() also uses, so the two can't drift.
    const jsonAssetType = classifyJsonAssetSuffix(relPath);
    if (jsonAssetType) return jsonAssetType;
    if (relPath.includes('/scenes/') || relPath.endsWith('/scene.json')) return 'scene';
    if (relPath.includes('/materials/')) return 'material';
    // Any .json in an assets folder that isn't categorized above — treat as scene
    if (/\.json$/.test(relPath) && !relPath.endsWith('manifest.json')) return 'scene';
    return null;
  }
  return EXT_TYPE[ext] || null;
}

/** Decide whether a changed `.json` file should trigger a live hot-reload
 *  broadcast, and as what kind. The watcher (`onChange`) classifies via the same
 *  `detectType` the scanner uses, then REFINES it: `detectType`'s catch-all labels
 *  ANY uncategorized `.json` under an asset root as `'scene'`, which would bounce
 *  the live scene on unrelated config edits — so a `'scene'` verdict is only honored
 *  for files that follow the `/scenes/` (or top-level `scene.json`) convention.
 *  `prefab` always broadcasts. Returns null for everything else (no broadcast).
 *  `rel` is the forward-slash relative/url path. Pure — exported for unit testing
 *  the exact regression the inline comment warns about. */
/** What a watched .json change asks the live renderer to do. 'scene'/'prefab' hot-reload the
 *  world; 'animation' only invalidates the clip cache (reloading the scene would be wrong —
 *  and would discard unsaved work). */
export type LiveReloadKind = 'scene' | 'prefab' | 'animation';

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
  if (type === 'scene' && (rel.includes('/scenes/') || rel.endsWith('/scene.json'))) return 'scene';
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

/** The build steps for a `playable` target: the single-file inliner build (VITE_PLAYABLE=1 →
 *  games/<id>/ads/index.html) then reveal the ads/ dir. No favicon/deploy/native — the one HTML IS
 *  the artifact. Pure — extracted from the /api/build handler so the routing is unit-testable. */
export function playableBuildSteps(buildCwd: string, webCwd: string): BuildStep[] {
  const adsDir = path.join(webCwd, 'ads');
  return [
    { label: 'Building playable ad (single HTML)...', cmd: 'node engine/scripts/build-web.mjs', env: { VITE_PLAYABLE: '1' }, cwd: buildCwd },
    { label: 'Revealing ads/...', cmd: `open ${JSON.stringify(adsDir)}`, winCmd: `start "" "${adsDir}"`, cwd: webCwd },
  ];
}

/** Resolve the directory containing the `gcloud` CLI, or null if not installed. The web GCS deploy
 *  shells out to `gcloud`, but a Finder-launched packaged editor gets a minimal PATH without the
 *  Google Cloud SDK — so probe the well-known install dirs (Homebrew, the SDK's own installers) and
 *  fall back to the login shell's `command -v gcloud` (covers a custom location). gcloud is a system
 *  tool the editor can't provision (it carries the user's cloud auth), so this is the sanctioned way
 *  to find it — distinct from the build tools we provision. Exported for unit testing. */
export function resolveGcloudDir(override?: string): string | null {
  // An explicit Project Settings override wins (sdk.gcloudPath — the binary OR its dir).
  if (override) {
    if (fs.existsSync(path.join(override, 'gcloud'))) return override;                 // a bin dir
    if (fs.existsSync(override) && path.basename(override) === 'gcloud') return path.dirname(override); // the binary
  }
  if (process.platform === 'win32') return null; // web deploy steps are posix-only
  const home = process.env.HOME ?? '';
  const dirs = [
    '/opt/homebrew/bin', '/usr/local/bin',
    path.join(home, 'google-cloud-sdk', 'bin'),
    '/usr/local/google-cloud-sdk/bin',
    path.join(home, '.local', 'bin'),
  ];
  for (const d of dirs) {
    if (d && fs.existsSync(path.join(d, 'gcloud'))) return d;
  }
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execSync(`${shell} -ilc 'command -v gcloud'`, { timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out && fs.existsSync(out)) return path.dirname(out);
  } catch { /* not found via the login shell */ }
  return null;
}

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
      // Fonts are the one type referenced by CSS family name, never by GUID
      // (see assetManifest's fontFamily exception) — minting sidecars for the
      // ~140 bundled fonts would be pure churn, so skip them.
      if (it.entry.type === 'font') continue;
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
        return `export default ${JSON.stringify(loadProjectConfig(projectRoot))};`;
      }
      if (id === GAMES_RESOLVED_ID) {
        // Expose the open project's game (one project = one game, #29) — see
        // gamesModuleSource (pure + Windows-separator-safe).
        return gamesModuleSource(findGamesEntry(projectRoot));
      }
    },

    configureServer(server) {
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
        // Classify via the same detector the scanner uses — scene files in this
        // project are plain `.json` under a `scenes/` dir, not `.scene.json`.
        if (path.extname(file).toLowerCase() === '.json' && !isEditorWrite(file, () => hashFileSync(file))) {
          const rel = file.split(path.sep).join('/');
          // classifySceneChange refines detectType: its catch-all labels ANY
          // uncategorized .json under an asset root as 'scene', which would bounce
          // the live scene on unrelated config edits — so 'scene' is gated by the
          // /scenes/ convention. 'prefab' always broadcasts.
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
        const sseRoutes = ['/api/build', '/api/add-native-target', '/api/toolchain/install'];
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
              if (!result) { next(); return; }
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
          const cfgErrors = validateBuildConfig(cfg, loadProjectUserConfig(projectRoot));
          if (cfgErrors.length) {
            sendStatus(`FAILED:Invalid project settings\n${cfgErrors.join('\n')}`);
            send('Aborted — fix these Project Settings fields:\n' + cfgErrors.join('\n'));
            res.end();
            return;
          }
          const buildCwd = editorRoot || projectRoot;
          const nativeDir = path.join(projectRoot, platform);

          // Kill the in-flight child if the client disconnects (closed the dialog /
          // reloaded the renderer) so a long npm install / cap add isn't orphaned. (D6)
          let activeProc: ReturnType<typeof spawn> | null = null;
          let aborted = false;
          req.on('close', () => { aborted = true; try { activeProc?.kill('SIGTERM'); } catch { /* gone */ } });

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

          (async () => {
            const TOTAL = 5;
            try {
              if (fs.existsSync(nativeDir)) {
                sendStatus(`FAILED:${platform}/ already exists`);
                send(`This project already has a ${platform}/ folder — nothing to do.`);
                res.end();
                return;
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
          })();
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

        // GET /api/build?platform=ios|android|web|playable — build + deploy (SSE stream)
        if ((req.url === '/api/build' || req.url?.startsWith('/api/build?')) && req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost');
          const platform = url.searchParams.get('platform');
          if (!isValidBuildPlatform(platform)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'platform must be ios, android, web, or playable' }));
            return;
          }

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          const send = (data: string) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ } };
          const sendStatus = (status: string) => { try { res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`); } catch { /* client disconnected */ } };
          const sendStep = (step: number, total: number) => { try { res.write(`event: step\ndata: ${JSON.stringify({ step, total })}\n\n`); } catch { /* client disconnected */ } };

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
          const cfgErrors = validateBuildConfig(cfg, user);
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
          // adb: an absolute path resolved from the SHARED toolchain (<android-sdk>/platform-tools/
          // adb) so it works even when platform-tools isn't on PATH (a packaged/no-PATH machine);
          // bare `adb` only as a fallback. -s <id> targets the configured device.
          // QUOTE adb's absolute path: the provisioned SDK lives under
          // "…/Library/Application Support/Modoki Editor/toolchain/…" (spaces), and `adb` is
          // interpolated into a bash command string (`${adb} install …`), so an unquoted path
          // word-splits → `bash: /Users/…/Library/Application: No such file or directory`. The
          // `-s <serial>` flag stays outside the quotes (serials are [A-Za-z0-9._:-], no spaces).
          const adbBin = JSON.stringify(detectAdb().path ?? 'adb');
          const adb = user.device.androidDeviceId ? `${adbBin} -s ${user.device.androidDeviceId}` : adbBin;
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
          // www/manifest.json. Verified against @capacitor/assets 3.0.5. Colors are
          // double-quoted (portable across bash + cmd.exe; `#` isn't a comment inside
          // quotes on either). The mkdir+copy prep differs per shell (posix `mkdir -p`/
          // `cp` vs cmd `mkdir`/`copy`); the `|| echo` non-fatal fallback works on both.
          const iconGen = (plat: 'ios' | 'android') =>
            `npx --yes @capacitor/assets generate --${plat} --iconBackgroundColor "#ffffff" --iconBackgroundColorDark "#111111" --splashBackgroundColor "#ffffff" --splashBackgroundColorDark "#111111"`;
          const iconStep = (plat: 'ios' | 'android'): BuildStep => ({
            label: 'Generating app icons...',
            cmd: `mkdir -p assets && cp ${JSON.stringify(iconSrcAbs)} assets/icon.png && ${iconGen(plat)} || echo '[icon] generation skipped (source missing or @capacitor/assets error)'`,
            winCmd: `(if not exist assets mkdir assets) && copy /y "${iconSrcAbs}" assets\\icon.png && ${iconGen(plat)} || echo [icon] generation skipped`,
            cwd: plat === 'ios' ? iosCwd : androidCwd,
          });
          const stepsByPlatform: Record<string, BuildStep[]> = {
            // iOS is macOS-only (preflight blocks it off-darwin), so its bash-only steps
            // (`$(…)`, `~`, xcodebuild/xcrun) never run on Windows — no winCmd needed.
            ios: [
              { label: 'Building web assets...', cmd: 'node engine/scripts/build-web.mjs', cwd: buildCwd },
              iconStep('ios'),
              { label: 'Syncing Capacitor iOS...', cmd: 'npx cap sync ios', cwd: iosCwd },
              { label: 'Building Xcode project...', cmd: `xcodebuild ${iosXcodeTarget} -scheme App -configuration Debug -destination 'id=${IOS_DEST}' -allowProvisioningUpdates build`, cwd: iosCwd },
              { label: 'Installing on device...', cmd: `APP_PATH=$(ls -dt ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Debug-iphoneos/App.app 2>/dev/null | head -1) && xcrun devicectl device install app --device ${IOS_DEVICECTL} "$APP_PATH"`, cwd: iosCwd },
              { label: 'Launching app...', cmd: `xcrun devicectl device process launch --device ${IOS_DEVICECTL} ${APP_ID}`, cwd: iosCwd },
            ],
            android: [
              { label: 'Building web assets...', cmd: 'node engine/scripts/build-web.mjs', cwd: buildCwd },
              iconStep('android'),
              { label: 'Syncing Capacitor Android...', cmd: 'npx cap sync android', cwd: androidCwd },
              // gradlew wrapper: posix `android/gradlew` vs Windows `android\gradlew.bat`.
              // JAVA_HOME/ANDROID_HOME are injected via env (not a bash export prefix).
              // --no-daemon: don't leave a persistent Gradle daemon (a java.exe running from the
              // provisioned JDK) after the build. On Windows that daemon keeps the JDK's files LOCKED,
              // so "Remove Java SDK" (and any manual delete) fails half-way. The build JVM exits when
              // the build finishes, releasing the lock. Small perf cost on repeat builds; worth it.
              { label: 'Building Android APK...', cmd: 'android/gradlew -p android assembleDebug --no-daemon', winCmd: 'android\\gradlew.bat -p android assembleDebug --no-daemon', env: androidBuildEnv, cwd: androidCwd },
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
              { label: 'Building web assets (game-only)...', cmd: 'node engine/scripts/build-web.mjs', env: { BASE_PATH: cfg.build.webBasePath, VITE_GAME_ONLY: 'true' }, cwd: buildCwd },
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
            (platform === 'ios' || platform === 'android') && !fs.existsSync(path.join(projectRoot, platform));

          // iOS device builds need a target device: the xcodebuild -destination AND the
          // install/launch steps all interpolate the configured id. An empty id yields a
          // cryptic `-destination 'id='` → `xcodebuild: error: missing value for key 'id'`
          // + a full usage dump (not an obvious "set your device" hint) — so fail fast with
          // guidance instead. (Android's `adb` degrades to auto-selecting the one device, so
          // it needs no such check.) The simulator isn't a target of this device pipeline.
          if (platform === 'ios' && (!IOS_DEST || !IOS_DEVICECTL)) {
            const missing = !IOS_DEST && !IOS_DEVICECTL ? 'iosDeviceId + iosDevicectlId'
              : !IOS_DEST ? 'iosDeviceId (xcodebuild -destination)' : 'iosDevicectlId (device install/launch)';
            const msg = `[build] No iOS device configured — ${missing} is empty in ` +
              `${path.relative(buildCwd, path.join(projectRoot, 'project.config.json'))}. ` +
              `Set it in Project Settings → Build: iosDeviceId = the xcodebuild UDID from ` +
              `\`xcrun xctrace list devices\`, iosDevicectlId = the id from \`xcrun devicectl list devices\`. ` +
              `Without it the build can't target or install on your iPhone.`;
            send(msg);
            sendStatus('No iOS device configured — see log');
            res.end();
            return;
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

          // Kill the in-flight build child + stop launching steps if the client
          // disconnects (closed the Build dialog / reloaded), so gradle/xcodebuild/
          // gcloud aren't left running for minutes and can't conflict with a retry. (D6)
          let activeProc: ReturnType<typeof spawn> | null = null;
          let aborted = false;
          req.on('close', () => { aborted = true; try { activeProc?.kill('SIGTERM'); } catch { /* gone */ } });

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

          (async () => {
            // First native build with no ios/android folder → scaffold it inline,
            // then PAUSE if it flags something the user must supply (missing
            // Firebase config) so they can act before the build runs against it.
            if (needsNativeScaffold) {
              sendStatus(`Adding ${platform} target…`);
              send(`\nThis project has no ${platform}/ folder yet — scaffolding it before building.`);
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
              if (steps[0]?.cmd === 'node engine/scripts/build-web.mjs') steps.shift();
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
              if (depHeal.changed) {
                const v = vendorEnginePlugins(projectRoot, buildCwd);
                if (v.vendored.length) send(`[heal] vendored engine plugin(s): ${v.vendored.join(', ')}`);
                if (!(await runScaffoldShell('npm install (healed Capacitor plugins)', 'npm install', projectRoot))) {
                  if (aborted) return;
                  sendStatus('FAILED:npm install (healed Capacitor plugins)');
                  send('Build failed — could not install the added Capacitor plugin(s).');
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
            const label = platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : platform === 'playable' ? 'Playable Ad (ads/index.html)' : 'Web (modoki-engine.com/demo)';
            // "built" for the playable (nothing is deployed — the one HTML file IS the artifact); "deployed" for the rest.
            send(`\n✅ ${label} ${platform === 'playable' ? 'built' : 'build deployed'} successfully!`);
            res.end();
          })();
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

      const result = computeKeptAssets(projectRoot, assetRoots);
      const CONVERTIBLE = new Set(['.png', '.jpg', '.jpeg']);
      const MODEL_EXTS = new Set(['.glb', '.gltf']);
      const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac']);
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
      // copy the two derived files into dist/ at `<src>~atlas.png` + `<src>~metrics.json`
      // — the source .ttf is NOT shipped. A plain CSS-family-name font (no `font`
      // block) is copied verbatim so `fontFamily` still resolves. On bake FAILURE
      // (msdf-atlas-gen missing/crash) we ship the source + record it so the strict
      // gate fails the build (unless MODOKI_ALLOW_ASSET_FALLBACK=1) — parity with audio.
      const convertedFonts = new Map<string, { settings: FontImportSettings; hash: string; atlasWidth?: number; atlasHeight?: number }>(); // NFC virtualPath → blocks
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
          convertedFonts.set(virtualPath.normalize('NFC'), { settings, hash: conv.hash, atlasWidth: conv.atlasWidth, atlasHeight: conv.atlasHeight });
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
              __MODOKI_MODULE_NPR__: 'true',
              __MODOKI_MODULE_GPU_PARTICLES__: 'true',
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
        // Font: bake the manifest block (mode/fieldType/distanceRange/atlas dims) +
        // the build-time hash so the runtime resolves `<src>~atlas.png?v=<hash>` +
        // `~metrics.json` (source .ttf dropped from dist). A font that fell back to
        // raw source (bake failed + fallback allowed) keeps no `font` block, so the
        // verifier below checks the shipped source instead.
        const f = convertedFonts.get(entry.path.normalize('NFC'));
        if (f) {
          const block: FontManifestBlock = {
            mode: f.settings.mode,
            fieldType: f.settings.fieldType,
            distanceRange: f.settings.pxRange,
            ...(f.atlasWidth != null ? { atlasWidth: f.atlasWidth } : {}),
            ...(f.atlasHeight != null ? { atlasHeight: f.atlasHeight } : {}),
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
          } else if (entry.font) {
            // Baked font — the source .ttf was dropped; verify both derived files.
            checkFile(entry.path + FONT_ATLAS_SUFFIX, 'font atlas');
            checkFile(entry.path + FONT_METRICS_SUFFIX, 'font metrics');
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
