/** Asset manifest — maps stable UUIDs to current file paths.
 *
 *  Assets are referenced on disk by GUID, not path: `"mesh": "a1b2c3d4-..."`.
 *  At load time, loaders detect a GUID-shaped string and resolve it through
 *  this manifest to the current path before fetching. Moving or renaming a
 *  file only requires the manifest entry to be updated — all references
 *  continue to resolve.
 *
 *  The manifest is populated by:
 *    - Editor: scans the project at startup (or via dev-server endpoint),
 *      reads every asset's `id` field / `.meta.json` sidecar, indexes them.
 *    - Production builds: a baked `assets.manifest.json` is fetched once at
 *      app boot and merged into the manifest.
 *
 *  References are GUID-only. An internal asset *path* (e.g.
 *  `/games/x/assets/foo.mesh.json`) is no longer accepted — `resolveRef`
 *  rejects it with a loud error so stale/wrong refs fail visibly instead of
 *  silently resolving. The one exception is genuinely external resources
 *  (`http(s)://`, `data:`, `blob:` URLs), which are not manifest assets and
 *  pass through unchanged.
 */

import { assetUrl } from './assetUrl';
import { ASSET_FETCH_INIT } from './assetFetch';
import type { TextureImportSettings, TextureType } from './textureSettings';
import type { AudioImportSettings, AudioCacheInfo } from './audioSettings';
import type { EnvManifestBlock } from './environmentSettings';
export type { AudioImportSettings } from './audioSettings';
import type { ModelImportSettings, ModelCacheInfo } from './modelSettings';
import { lodUrlSuffix } from './modelSettings';
import type { SpriteSlice, SpriteSheetInfo, SpriteAssetRef, SpriteRect } from './spriteSheet';
import type { AtlasCacheBlock } from './spriteAtlas';
export type { SpriteAssetRef } from './spriteSheet';
// Atlas block/frame types live in the PURE spriteAtlas module so the Node build
// pipeline can import them without dragging this DOM-touching module in. Re-exported
// here so runtime consumers keep importing them from the manifest.
export type { AtlasPackedFrame, AtlasCacheBlock } from './spriteAtlas';

export type AssetType = 'mesh' | 'material' | 'prefab' | 'scene' | 'model' | 'environment' | 'texture' | 'sprite' | 'atlas' | 'font' | 'shader' | 'particle' | 'animation' | 'animset' | 'spriteanim' | 'rig2d' | 'audio' | 'timeline';

export interface AssetEntry {
  guid: string;
  path: string;
  type: AssetType;
  /** Baked texture import settings (texture assets only) — lets the runtime
   *  resolver pick a variant + configure the texture without a per-file fetch. */
  texture?: TextureImportSettings;
  /** Authored texture usage type (texture assets only) — `3d`/`2d`/`ui`. Drives
   *  reference type-checking (a 2D field rejects a `3d` texture). */
  textureType?: TextureType;
  /** Baked model import settings (model assets only) — lets the runtime
   *  mesh-template cache decide whether the model has LODs without re-reading
   *  the meta sidecar. */
  model?: ModelImportSettings;
  /** Baked model cache info (model assets only) — `lodPaths`, `lodDistances`
   *  etc. The runtime LOD resolver reads this; absence means the model is
   *  unconverted (single mesh, no LOD wrapping). */
  modelCache?: ModelCacheInfo;
  /** Model postprocessor id (model assets only), copied from the `.meta.json`
   *  `postprocessor` field at scan time. Static models read their postprocessor
   *  from the `ModelSource` trait, but a rigged/skinned model has no such trait,
   *  so the rigged loader reads it here to apply `filterMesh` (e.g. drop a baked
   *  ground "Plane"). Absent ⇒ 'none'. */
  postprocessor?: string;
  /** Content hash of the converted asset (source bytes + import settings +
   *  encoder version), copied from the `.meta.json` cache block at scan time.
   *  Appended to served variant URLs as `?v=<hash>` so a re-import (new hash →
   *  new URL) busts immutable browser/CDN caches. Absent for unconverted assets. */
  hash?: string;
  /** Sliced-sprite block (`'sprite'` assets only) — the parent texture + rect/pivot.
   *  Resolved to a URL+frame by `resolveSprite`. */
  sprite?: SpriteAssetRef;
  /** Built-atlas block (`'atlas'` assets only) — page dims + frame map. Populated into
   *  the global `atlasFrameIndex` on register so `resolveSprite` redirects members to
   *  their page. Absent ⇒ the atlas hasn't been packed yet (members resolve to source). */
  atlas?: AtlasCacheBlock;
  /** Baked audio block (`'audio'` assets only), copied from the `.meta.json`
   *  `audio`/`audioCache` blocks at scan time. Drives buffer-vs-stream at load +
   *  the converted-variant URL at play time. Absent ⇒ unconverted; the runtime
   *  defaults to `loadType: 'buffer'` and serves the source file. */
  audio?: AudioManifestBlock;
  /** Baked font block (`'font'` assets only), copied from the `.meta.json`
   *  `font` block at scan time. Present only once the font has been through the
   *  MSDF atlas converter (baked `~atlas.png` + `~metrics.json` variants exist).
   *  Absent ⇒ the font is a plain CSS-family-name font (resolved by `fontFamily`,
   *  never a GUID ref) and has no SDF atlas. */
  font?: FontManifestBlock;
  /** Baked environment block (`'environment'` HDR assets only) — present once the
   *  HDR has been downscaled (a `~env.hdr` variant exists). Absent ⇒ the HDR loads
   *  from its raw source. */
  environment?: EnvManifestBlock;
}

/** The audio block baked onto a manifest entry / stored in the `.meta.json`
 *  `audio` block. A partial of the full converter settings — `loadType` may be
 *  the only field when the clip is unconverted (loadType set via the inspector,
 *  no ffmpeg pass) — plus `ext`, the converted variant's file extension, present
 *  only once the clip has been through the converter (so the runtime resolver can
 *  build the `~audio.<ext>` variant URL without reading the sidecar). */
export interface AudioManifestBlock extends Partial<AudioImportSettings> {
  ext?: string;
}

/** Persisted manifest format. Array-of-entries (not keyed-by-guid) for
 *  compatibility with the existing vite-asset-scanner output, which uses the
 *  same file for font discovery and the asset panel. Entries without a guid
 *  are tolerated (legacy entries; just skipped by the guid resolver). */
export interface AssetManifestEntry {
  guid?: string;
  path: string;
  type: AssetType | string;
  name?: string;
  texture?: TextureImportSettings;
  textureType?: TextureType;
  model?: ModelImportSettings;
  modelCache?: ModelCacheInfo;
  postprocessor?: string;
  hash?: string;
  sprite?: SpriteAssetRef;
  atlas?: AtlasCacheBlock;
  audio?: AudioManifestBlock;
  font?: FontManifestBlock;
  environment?: EnvManifestBlock;
}

export interface AssetManifestFile {
  version: number;
  assets: AssetManifestEntry[];
}

/** Sidecar `.meta.json` written next to binary assets (.glb, .hdr, .png/.jpg).
 *  Carries the stable UUID plus importer state (e.g., the list of derived
 *  files produced from a GLB so they can be cleaned up on delete). */
export interface BinaryAssetMeta {
  id: string;
  version: 2;
  /** Importer/loader ID (e.g., 'island', 'default'). Optional — only models have one. */
  loader?: string;
  /** Files produced from this binary by the importer — used for cleanup. */
  generated?: {
    meshes?: string[];
    materials?: string[];
    textures?: string[];
  };
  /** Texture import settings (texture assets only). Edited via the Texture
   *  Inspector; consumed by the conversion service + runtime resolver. */
  texture?: TextureImportSettings;
  /** Content-cache bookkeeping written by the conversion service. */
  textureCache?: import('./textureSettings').TextureCacheInfo;
  /** Model import settings (GLB assets only). Edited via the Model Inspector;
   *  consumed by the conversion service + runtime mesh-template cache. */
  model?: ModelImportSettings;
  /** Content-cache bookkeeping written by the model conversion service —
   *  LOD GLB paths, switch distances, tri counts, byte sizes. */
  modelCache?: ModelCacheInfo;
  /** Audio import settings (audio assets only). Edited via the Audio Inspector;
   *  consumed by the ffmpeg conversion service + runtime resolver. */
  audio?: Partial<AudioImportSettings>;
  /** Content-cache bookkeeping written by the audio conversion service. */
  audioCache?: AudioCacheInfo;
  /** Font import settings (font assets only). Edited via the Font Inspector;
   *  consumed by the msdf-atlas-gen conversion service + runtime font loader. */
  font?: import('./fontSettings').FontImportSettings;
  /** Content-cache bookkeeping written by the font conversion service. */
  fontCache?: import('./fontSettings').FontCacheInfo;
  /** Sliced sprites carved from this texture (texture assets in "multiple" mode).
   *  Edited via the Sprite Editor; each slice gets a stable GUID + registers as a
   *  `'sprite'` manifest entry. Absent ⇒ the texture is a single whole-image sprite. */
  sprites?: SpriteSlice[];
  /** Source-image dimensions the `sprites[]` rects were authored against (for
   *  variant-downscale frame scaling). Written by the Sprite Editor. */
  spriteSheet?: SpriteSheetInfo;
}

const guidToEntry = new Map<string, AssetEntry>();
const pathToGuid = new Map<string, string>();

// Pure ref predicates live in assetRefRules.ts (zero imports, Node-safe) so they
// can be shared with the dev-server plugin + scene validator/mutator. Imported
// for internal use AND re-exported to keep assetManifest's public API stable.
import { isGuid, isExternalUrl, isInternalAssetPath, newGuid, deriveGuid } from './assetRefRules';
export { isGuid, isExternalUrl, isInternalAssetPath, newGuid, deriveGuid };
// FontManifestBlock is defined in the pure fontSettings module (Node-safe, so the
// build plugins can import it without pulling this browser-coupled module into
// their Node typecheck); re-exported here for runtime consumers.
import type { FontManifestBlock } from './fontSettings';
export type { FontManifestBlock } from './fontSettings';

/** Re-derive a model's variant GLB URLs (`<src>.processed.glb`, `<src>.lod<N>.glb`)
 *  from the asset's CURRENT resolved `path` — never trust the ones baked into the
 *  stored `modelCache`. Those absolute paths are written at import time; moving or
 *  renaming the source updates the guid→path map but NOT the baked strings inside
 *  the `.meta.json`, so a stored `processedPath` goes stale and 404s (loader asks
 *  for the old location). Deriving here — the single point every entry flows
 *  through — keeps them correct across moves with zero re-import, and matches how
 *  rigged models already resolve their URL (`riggedModelCache.ts`) and where the
 *  build emits variants (`<assetPath>.processed.glb`). Location-independent fields
 *  (hash, lodDistances, triCounts, lodBytes) are preserved as-is. */
function deriveModelCacheVariantPaths(path: string, mc: ModelCacheInfo | undefined): ModelCacheInfo | undefined {
  if (!mc) return mc;
  if (mc.lodPaths && mc.lodPaths.length > 0) {
    const lodPaths = mc.lodPaths.map((_, i) => path + lodUrlSuffix(i));
    return { ...mc, processedPath: lodPaths[0], lodPaths };
  }
  // Single-variant (e.g. rigged) caches carry only processedPath — fix it too.
  if (mc.processedPath) return { ...mc, processedPath: path + lodUrlSuffix(0) };
  return mc;
}

/** Register an asset's guid → path mapping. Overwrites any prior entry for
 *  the guid. Also indexes the path for reverse lookup. */
export function registerAsset(
  guid: string,
  path: string,
  type: AssetType,
  texture?: TextureImportSettings,
  modelBlocks?: { model?: ModelImportSettings; modelCache?: ModelCacheInfo; postprocessor?: string; sprite?: SpriteAssetRef; atlas?: AtlasCacheBlock; audio?: AudioManifestBlock; font?: FontManifestBlock; environment?: EnvManifestBlock },
  hash?: string,
): void {
  if (!isGuid(guid)) {
    console.warn(`[assetManifest] registerAsset: invalid guid "${guid}" for ${path}`);
    return;
  }
  const prior = guidToEntry.get(guid);
  if (prior && prior.path !== path) {
    pathToGuid.delete(prior.path);
  }
  // A font whose mode (baked↔dynamic) or content hash (re-bake) changed must evict
  // its live provider so the next render re-acquires with the new settings — else a
  // Font-Inspector mode flip or re-bake has no effect until a full editor restart.
  const newFont = modelBlocks?.font ?? (prior && prior.type === type ? prior.font : undefined);
  const newHash = hash ?? (prior && prior.type === type ? prior.hash : undefined);
  const fontChanged = type === 'font' && !!prior &&
    (prior.font?.mode !== newFont?.mode || prior.hash !== newHash);
  // An atlas re-register replaces its frame index wholesale — drop the prior atlas's
  // frames first so a removed member stops resolving to a stale page.
  if (prior?.type === 'atlas') removeAtlasFromIndex(prior.guid);
  // If the type changes for the same guid, drop cached settings tied to the
  // previous type so we don't carry a `model:` block on what's now a 'texture'.
  const typeChanged = prior && prior.type !== type;
  // Preserve previously-registered settings when a later call (e.g. a loader
  // self-registering on fetch) omits them — but only when the type hasn't
  // changed; mismatched-type blocks would silently desync consumers.
  guidToEntry.set(guid, {
    guid, path, type,
    texture: texture ?? (typeChanged ? undefined : prior?.texture),
    model: modelBlocks?.model ?? (typeChanged ? undefined : prior?.model),
    // Derive variant URLs from the CURRENT path so a moved/renamed source resolves
    // without a re-import (the stored processedPath/lodPaths may be stale — see the
    // helper). lodCount/distances/hash are location-independent and kept as-is.
    modelCache: deriveModelCacheVariantPaths(path, modelBlocks?.modelCache ?? (typeChanged ? undefined : prior?.modelCache)),
    postprocessor: modelBlocks?.postprocessor ?? (typeChanged ? undefined : prior?.postprocessor),
    hash: hash ?? (typeChanged ? undefined : prior?.hash),
    sprite: modelBlocks?.sprite ?? (typeChanged ? undefined : prior?.sprite),
    atlas: modelBlocks?.atlas ?? (typeChanged ? undefined : prior?.atlas),
    audio: modelBlocks?.audio ?? (typeChanged ? undefined : prior?.audio),
    font: modelBlocks?.font ?? (typeChanged ? undefined : prior?.font),
    environment: modelBlocks?.environment ?? (typeChanged ? undefined : prior?.environment),
  });
  // Index a built atlas's frames so resolveSprite can redirect members to their page.
  const atlasBlock = modelBlocks?.atlas ?? (typeChanged ? undefined : prior?.atlas);
  if (type === 'atlas' && atlasBlock) addAtlasToIndex(guid, atlasBlock);
  // If a different guid currently owns this path, drop its guidToEntry too —
  // otherwise the abandoned guid still resolves to a path now claimed by a
  // different asset (and possibly different type), and `getAssetType(oldGuid)`
  // returns a stale answer.
  const priorGuidForPath = pathToGuid.get(path);
  if (priorGuidForPath && priorGuidForPath !== guid) {
    guidToEntry.delete(priorGuidForPath);
  }
  pathToGuid.set(path, guid);
  // Fire AFTER the entry is committed so a listener re-acquiring reads the new block.
  if (fontChanged) for (const fn of fontInvalidationListeners) { try { fn(guid); } catch { /* ignore */ } }
}

type FontInvalidationListener = (guid: string) => void;
const fontInvalidationListeners = new Set<FontInvalidationListener>();
/** Subscribe to font-entry changes (mode flip / re-bake). The font atlas loader uses
 *  this to evict + re-acquire the live provider so edits take effect without a restart. */
export function onFontInvalidated(fn: FontInvalidationListener): () => void {
  fontInvalidationListeners.add(fn);
  return () => { fontInvalidationListeners.delete(fn); };
}

/** The synthetic, collision-free path a sliced sprite registers under. Sprites carve
 *  from a texture and have no file of their own, so they'd otherwise fight the parent
 *  texture (and each other) for `pathToGuid[texturePath]`. The `#<guid>` suffix keeps
 *  each slice's path unique while still pointing at the owning texture for debugging.
 *  Never parsed as a ref — `resolveRef(spriteGuid)` returns it but resolution flows
 *  through `sprite.texture`, not this path. */
export function spriteSyntheticPath(texturePath: string, sliceGuid: string): string {
  return `${texturePath}#${sliceGuid}`;
}

// Per-texture epoch, bumped whenever that texture's slice data changes (re-slice in
// the Sprite Editor). The 2D renderer keys cached sprite slots on this so an edited
// frame rebuilds even though the ref GUID is unchanged (otherwise a re-slice wouldn't
// refresh on screen). Scoped per parent texture — NOT global — so re-slicing one
// sheet doesn't needlessly rebuild every on-screen 2D sprite of unrelated textures.
const _spriteEpochByTexture = new Map<string, number>();

/** The slice-epoch for the texture backing `ref`: for a `'sprite'` GUID, its parent
 *  texture's epoch; for a plain texture GUID (a whole-image sprite), that texture's
 *  epoch; 0 for anything else (never-sliced texture, primitive keyword, URL/path).
 *  For a sprite that's a member of a built atlas, the atlas's epoch is folded in too —
 *  a re-pack changes the resolved page URL but NOT the texture epoch, so without this
 *  the 2D renderer's slot cache (keyed on this) wouldn't rebuild the framed page. */
export function getSpriteEpoch(ref: string): number {
  if (!ref || !isGuid(ref)) return 0;
  const entry = guidToEntry.get(ref);
  const texGuid = entry?.type === 'sprite' ? entry.sprite?.texture : ref;
  const texEpoch = texGuid ? (_spriteEpochByTexture.get(texGuid) ?? 0) : 0;
  const frame = atlasFrameIndex.get(ref);
  const atlasEpoch = frame ? (_atlasEpochByAtlas.get(frame.atlasGuid) ?? 0) : 0;
  return texEpoch + atlasEpoch;
}

// ── Atlas frame index ───────────────────────────────────────────────────────
// Global sprite-GUID → built-atlas-page placement. Rebuilt wholesale whenever an
// `'atlas'` entry (re)registers (registerAsset above), so a re-pack repoints members
// without re-registering every `'sprite'` entry. resolveSprite consults this FIRST and
// falls back to the parent-texture path when a sprite isn't in any built atlas.
export interface AtlasFrameRef {
  atlasGuid: string;
  page: number;
  rect: SpriteRect;
  pivot: { x: number; y: number };
  /** The member's page dimensions (px). The frame `rect` is in this space, so a consumer
   *  that needs 0..1 UVs (the 2D skin builder) normalizes `rect / page{W,H}`. */
  pageW: number;
  pageH: number;
  /** Page-encoding settings + content hash (for variant selection + cache-bust). */
  texture: TextureImportSettings;
  hash: string;
}
const atlasFrameIndex = new Map<string, AtlasFrameRef>();
// Track which sprite GUIDs each atlas contributed, so a re-register/unregister can
// remove exactly that atlas's frames (a sprite belongs to at most one built atlas).
const atlasMembers = new Map<string, Set<string>>();
// Monotonic per-atlas epoch, bumped on every (re)register — folded into getSpriteEpoch
// so the 2D renderer rebuilds a member's framed page after a re-pack (the member's GUID
// is unchanged, only the page bytes/URL change). Never decremented (kept monotonic so a
// remove→re-add can't collide with a prior value); cleared only on full teardown.
const _atlasEpochByAtlas = new Map<string, number>();

function addAtlasToIndex(atlasGuid: string, block: AtlasCacheBlock): void {
  removeAtlasFromIndex(atlasGuid);
  _atlasEpochByAtlas.set(atlasGuid, (_atlasEpochByAtlas.get(atlasGuid) ?? 0) + 1);
  const members = new Set<string>();
  for (const [spriteGuid, frame] of Object.entries(block.frames)) {
    // Skip a frame whose page is missing from the cache block (defensive — a partially
    // written block) so the member falls back to its source sprite instead of a bad URL.
    const pageInfo = block.pages[frame.page];
    if (pageInfo?.hash == null) continue;
    atlasFrameIndex.set(spriteGuid, {
      atlasGuid, page: frame.page, rect: frame.rect, pivot: frame.pivot,
      pageW: pageInfo.w, pageH: pageInfo.h,
      texture: block.texture, hash: pageInfo.hash,
    });
    members.add(spriteGuid);
  }
  atlasMembers.set(atlasGuid, members);
}

function removeAtlasFromIndex(atlasGuid: string): void {
  const members = atlasMembers.get(atlasGuid);
  if (!members) return;
  for (const spriteGuid of members) {
    if (atlasFrameIndex.get(spriteGuid)?.atlasGuid === atlasGuid) atlasFrameIndex.delete(spriteGuid);
  }
  atlasMembers.delete(atlasGuid);
}

/** The built-atlas placement for a sprite GUID, or undefined if it isn't packed into
 *  any built atlas. Consulted first by `resolveSprite`. */
export function getAtlasFrame(spriteGuid: string): AtlasFrameRef | undefined {
  return atlasFrameIndex.get(spriteGuid);
}

/** Index a built atlas's frames (used by tests + the manifest loader; production goes
 *  through `registerAsset`). */
export function registerAtlasFrames(atlasGuid: string, block: AtlasCacheBlock): void {
  addAtlasToIndex(atlasGuid, block);
}

/** Drop all atlas frame mappings. Called by `clearManifest`. */
export function clearAtlasFrames(): void {
  atlasFrameIndex.clear();
  atlasMembers.clear();
  _atlasEpochByAtlas.clear();
}

/** Register one sliced sprite as a `'sprite'` manifest entry pointing at its parent
 *  texture. `pivot`/`rect` come straight from the slice; the URL is later resolved
 *  through the parent texture (or, post-packing, an atlas page). */
export function registerSprite(
  sliceGuid: string,
  parentTextureGuid: string,
  parentTexturePath: string,
  sprite: SpriteAssetRef,
): void {
  registerAsset(sliceGuid, spriteSyntheticPath(parentTexturePath, sliceGuid), 'sprite', undefined, { sprite });
  _spriteEpochByTexture.set(parentTextureGuid, (_spriteEpochByTexture.get(parentTextureGuid) ?? 0) + 1);
}

/** Drop an entry. */
export function unregisterAsset(guid: string): void {
  const entry = guidToEntry.get(guid);
  if (!entry) return;
  if (entry.type === 'atlas') removeAtlasFromIndex(guid);
  guidToEntry.delete(guid);
  if (pathToGuid.get(entry.path) === guid) pathToGuid.delete(entry.path);
}

/** Resolve a guid to its current path, or return undefined if unknown. */
export function resolveGuidToPath(guid: string): string | undefined {
  return guidToEntry.get(guid)?.path;
}

/** Look up the guid registered for a path, or undefined. */
export function getGuidForPath(path: string): string | undefined {
  return pathToGuid.get(path);
}

/** Return the asset's type, or undefined if unknown. */
export function getAssetType(guid: string): AssetType | undefined {
  return guidToEntry.get(guid)?.type;
}

/** Look up the full entry for a guid OR a resolved path. A lower-level lookup
 *  utility (baked texture/model settings) — callers pass either a GUID *ref* or
 *  an already-resolved path (e.g. the mesh cache reverse-looking-up LOD info for
 *  a model path). This is NOT a reference resolver: stored references are
 *  GUID-only and validated by `resolveRef`; this just indexes both keys. */
export function getAssetEntry(ref: string): AssetEntry | undefined {
  if (isGuid(ref)) return guidToEntry.get(ref);
  const guid = pathToGuid.get(ref);
  return guid ? guidToEntry.get(guid) : undefined;
}

/** Buffer-vs-stream decision for an audio clip. Reads the baked `.meta.json`
 *  `audio.loadType`; defaults to `'buffer'` for unconverted clips (short SFX are
 *  the common case). Accepts guid or path. */
export function getAudioLoadType(ref: string): 'buffer' | 'stream' {
  return getAssetEntry(ref)?.audio?.loadType ?? 'buffer';
}

const pathRefSeen = new Set<string>();

/** Resolve a reference to a path. GUIDs resolve through the manifest; external
 *  URLs (http/data/blob) pass through unchanged. An internal asset *path* is no
 *  longer a valid reference — it's rejected with a one-time loud error and
 *  resolves to undefined so the asset fails visibly instead of silently loading.
 *  Anything else (sprite keyword, font-family name) passes through unchanged. */
export function resolveRef(ref: string): string | undefined {
  if (!ref) return undefined;
  if (isGuid(ref)) return guidToEntry.get(ref)?.path;
  if (isInternalAssetPath(ref)) {
    if (!pathRefSeen.has(ref)) {
      pathRefSeen.add(ref);
      console.error(
        `[assetManifest] path reference no longer supported — use a GUID: ${ref}\n` +
        `  (Re-save the owning scene/asset in the editor, or re-run scripts/migrate-to-guids.mjs.)`,
      );
    }
    return undefined;
  }
  return ref;
}

/** Bulk-load a manifest JSON (production build path). Entries without a guid
 *  are ignored — they live in the same file for legacy font/panel discovery. */
export function loadManifestJson(json: AssetManifestFile): void {
  if (!Array.isArray(json.assets)) return;
  for (const entry of json.assets) {
    if (!entry.guid || !isGuid(entry.guid)) continue;
    registerAsset(entry.guid, entry.path, entry.type as AssetType, entry.texture, {
      model: entry.model,
      modelCache: entry.modelCache,
      postprocessor: entry.postprocessor,
      sprite: entry.sprite,
      atlas: entry.atlas,
      audio: entry.audio,
      font: entry.font,
      environment: entry.environment,
    }, entry.hash);
  }
}

let manifestLoadPromise: Promise<AssetManifestFile | null> | null = null;

/** Fetch a manifest from `url` and merge it into the guid→path map. Memoized:
 *  repeated calls return the same in-flight/settled promise, so every boot
 *  path (game shell + editor + font loader) can `await` it without re-fetching.
 *
 *  This MUST be awaited before the first scene/asset load — otherwise GUID
 *  references resolve against an empty map and every mesh/material comes back
 *  undefined (missing meshes, black primitives). Returns the parsed manifest so
 *  callers can reuse it (e.g. font discovery) without a second fetch. */
export function ensureManifestLoaded(url: string): Promise<AssetManifestFile | null> {
  if (manifestLoadPromise) return manifestLoadPromise;
  const promise: Promise<AssetManifestFile | null> = (async () => {
    try {
      const res = await fetch(assetUrl(url), ASSET_FETCH_INIT);
      if (!res.ok) {
        console.warn(`[assetManifest] manifest fetch failed: ${url} (${res.status})`);
        return null;
      }
      const data = (await res.json()) as AssetManifestFile;
      loadManifestJson(data);
      return data;
    } catch (e) {
      console.warn(`[assetManifest] failed to load manifest ${url}:`, e);
      return null;
    }
  })();
  manifestLoadPromise = promise;
  // Clear the memo if the load FAILED (resolved null), so the next call retries
  // instead of being stuck with a poisoned singleton — a transient fetch failure
  // (or a manifest fetched mid dev-server restart) would otherwise leave every
  // GUID unresolved until a full page reload. A successful load (even an empty
  // manifest) keeps the memo (load-once). Registered after assignment so the
  // `=== promise` guard never clears a newer in-flight load.
  void promise.then((data) => {
    if (data === null && manifestLoadPromise === promise) manifestLoadPromise = null;
  });
  return promise;
}

/** Serialize the current manifest for writing to disk. */
export function serializeManifest(): AssetManifestFile {
  const assets: AssetManifestEntry[] = [];
  for (const [, entry] of guidToEntry) {
    assets.push({
      guid: entry.guid, path: entry.path, type: entry.type,
      texture: entry.texture,
      model: entry.model,
      modelCache: entry.modelCache,
      postprocessor: entry.postprocessor,
      hash: entry.hash,
      sprite: entry.sprite,
      atlas: entry.atlas,
      audio: entry.audio,
      font: entry.font,
      environment: entry.environment,
    });
  }
  return { version: 2, assets };
}

/** Clear the manifest. Used in tests + when reloading. */
export function clearManifest(): void {
  guidToEntry.clear();
  pathToGuid.clear();
  _spriteEpochByTexture.clear();
  clearAtlasFrames();
  manifestLoadPromise = null;
}

/** Snapshot of all entries, for debug/diagnostics. */
export function getAllAssets(): AssetEntry[] {
  return Array.from(guidToEntry.values());
}

/** Normalize a scene name for tolerant matching: lowercase, drop a trailing
 *  `.json`, collapse spaces/dashes/underscores. So `"2D Animation"`, `"2d-animation"`,
 *  and `"2D Animation.json"` all match the shipped `…/scenes/2D Animation.json`. */
function normalizeSceneName(s: string): string {
  return s.toLowerCase().replace(/\.json$/, '').replace(/[\s_-]+/g, '');
}

/** Resolve a scene reference to its current path by GUID or by name. Used by the
 *  public web shell to honor a `?scene=` query param (e.g. `?scene=Warp`,
 *  `?scene=2D%20Animation`, or a raw GUID). Returns the path of a registered
 *  `'scene'` asset whose filename matches `nameOrGuid`, or undefined if none.
 *  The manifest must be loaded first (`ensureManifestLoaded`). */
export function resolveSceneByName(nameOrGuid: string): string | undefined {
  if (!nameOrGuid) return undefined;
  if (isGuid(nameOrGuid)) {
    const entry = guidToEntry.get(nameOrGuid);
    return entry?.type === 'scene' ? entry.path : undefined;
  }
  const target = normalizeSceneName(nameOrGuid);
  for (const entry of guidToEntry.values()) {
    if (entry.type !== 'scene') continue;
    const base = entry.path.split('/').pop() ?? entry.path;
    if (normalizeSceneName(base) === target) return entry.path;
  }
  return undefined;
}

// Expose for debug console
if (typeof window !== 'undefined') {
  (window as Window & { __assetManifest?: object }).__assetManifest = {
    resolve: resolveRef,
    getAll: getAllAssets,
    serialize: serializeManifest,
  };
}
