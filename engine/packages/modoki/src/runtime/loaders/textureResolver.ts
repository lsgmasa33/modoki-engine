/** Runtime texture resolution.
 *
 *  Given an asset ref (guid or path), picks the right converted variant for the
 *  call site + GPU and loads it with the appropriate Three.js loader, applying
 *  the texture's import settings (wrap / colorspace / mipmaps). KTX2 variants are
 *  transcoded by a singleton KTX2Loader whose target format is chosen from the
 *  active renderer's capabilities. Textures that haven't been converted yet fall
 *  back to the raw source (dev convenience).
 */

import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import type { WebGPURenderer } from 'three/webgpu';
import { assetUrl, withCacheBust } from './assetUrl';
import { resolveRef, getAssetEntry, isGuid, getAtlasFrame, type AtlasFrameRef } from './assetManifest';
import {
  resolveTextureSettings, selectVariant, browserVariant, variantSuffix,
  type TextureImportSettings, type TextureWrap,
} from './textureSettings';
import { envVariantSuffix, type EnvFormat } from './environmentSettings';

const WRAP: Record<TextureWrap, THREE.Wrapping> = {
  repeat: THREE.RepeatWrapping,
  clamp: THREE.ClampToEdgeWrapping,
  mirror: THREE.MirroredRepeatWrapping,
};

let ktx2Loader: KTX2Loader | null = null;
let texLoader: THREE.TextureLoader | null = null;
let detectedCaps = { astc: false };

/** Resolves on the FIRST `setActiveRenderer` call. Editor bootstrap awaits
 *  this before calling `sceneManager.loadScene()` so the KTX2 transcoder has
 *  the GPU caps it needs before any texture load fires — without that
 *  ordering, scene preload races renderer init and KTX2Loader.loadAsync
 *  throws "Missing initialization with .detectSupport()" on the first
 *  ASTC-variant material. Public so callers can await it directly. */
let _rendererReadyResolve: () => void;
export const rendererReady: Promise<void> = new Promise((r) => { _rendererReadyResolve = r; });
let rendererReadyFired = false;
let activeRenderer: WebGPURenderer | THREE.WebGLRenderer | null = null;

/** The most recently activated renderer, or null before init. Used by the GPU
 *  particle backend to dispatch compute passes (the CPU backend needs no renderer
 *  ref — it uploads via instanced attributes at render time). */
export function getActiveRenderer(): WebGPURenderer | THREE.WebGLRenderer | null {
  return activeRenderer;
}

export function getKTX2Loader(): KTX2Loader {
  if (!ktx2Loader) {
    ktx2Loader = new KTX2Loader();
    ktx2Loader.setTranscoderPath(assetUrl('/basis/'));
  }
  return ktx2Loader;
}

function getTextureLoader(): THREE.TextureLoader {
  return texLoader ?? (texLoader = new THREE.TextureLoader());
}

/** Register the active renderer so the KTX2Loader can detect which compressed
 *  formats the GPU supports. Must run after `renderer.init()` for WebGPU.
 *  Idempotent + cheap — safe to call from every renderer creation site. */
export function setActiveRenderer(renderer: WebGPURenderer | THREE.WebGLRenderer): void {
  activeRenderer = renderer;
  try {
    const loader = getKTX2Loader();
    loader.detectSupport(renderer as never);
    const cfg = (loader as unknown as { workerConfig?: { astcSupported?: boolean } }).workerConfig;
    detectedCaps = { astc: !!cfg?.astcSupported };
  } catch (e) {
    console.warn('[textureResolver] detectSupport failed:', e);
  }
  if (!rendererReadyFired) { rendererReadyFired = true; _rendererReadyResolve(); }
}

/** The texture's baked import settings, or defaults when unconverted. */
export function getTextureSettings(ref: string): TextureImportSettings {
  return resolveTextureSettings({ texture: getAssetEntry(ref)?.texture });
}

/** Resolve a texture ref to the served URL of the best variant for `usage`.
 *  Returns the raw source URL when the texture hasn't been converted yet. */
export function resolveTextureVariantUrl(ref: string, usage: '2d' | '3d'): string | undefined {
  const sourcePath = resolveRef(ref);
  if (!sourcePath) return undefined;
  const entry = getAssetEntry(ref);
  const settings = entry?.texture;
  if (!settings) return assetUrl(sourcePath); // unconverted → source fallback
  const variant = selectVariant(settings, usage, detectedCaps);
  // Cache-bust immutable production assets with the content hash (shared helper —
  // matches modelGlbUrl + the invalidateTexture eviction key below).
  return withCacheBust(assetUrl(sourcePath + variantSuffix(variant)), entry?.hash);
}

/** Resolve an environment (HDR) ref to the served URL of its converted variant
 *  (`~env.hdr` downscaled Radiance, or `~ultrahdr.jpg` gainmap), or the raw source
 *  URL when it hasn't been converted. Accepts a guid or a path (the runtime env
 *  loader has the source path). */
export function resolveEnvVariantUrl(ref: string): string | undefined {
  const entry = getAssetEntry(ref);
  const sourcePath = entry?.path ?? (isGuid(ref) ? undefined : ref);
  if (!sourcePath) return undefined;
  if (!entry?.environment) return assetUrl(sourcePath); // unconverted → source fallback
  return withCacheBust(assetUrl(sourcePath + envVariantSuffix(entry.environment.format ?? 'hdr')), entry.hash);
}

/** The output format of a converted environment ref (`hdr`/`ultrahdr`), or undefined
 *  when unconverted — drives which three loader the runtime env loader picks. */
export function getEnvFormat(ref: string): EnvFormat | undefined {
  return getAssetEntry(ref)?.environment?.format;
}

/** A resolved sprite: the served URL of the texture (or, post-packing, atlas page)
 *  that backs it, the source-pixel frame rect, and the slice's pivot. A whole-texture
 *  ref resolves with `frame: null` (use the entire image). */
export interface ResolvedSprite {
  url: string;
  /** Source-pixel rect within the authored sheet, or null for the whole image.
   *  The render path scales this to the actually-loaded variant via {@link sheetW}. */
  frame: { x: number; y: number; w: number; h: number } | null;
  pivot: { x: number; y: number } | null;
  /** Source-sheet dims the frame was authored against. When the loaded variant is
   *  downscaled, multiply frame coords by `loadedTexW / sheetW`. Null ⇒ no scaling. */
  sheetW: number | null;
  sheetH: number | null;
  /** 9-slice border insets (source px), for UI `border-image`. Absent ⇒ plain image.
   *  `scale` = CSS px drawn per source px of border (Unity PPU-style); absent ⇒ 1. */
  border?: { l: number; r: number; t: number; b: number; scale?: number };
}

/** Resolve a built-atlas page's served URL for a member frame, mirroring
 *  `resolveTextureVariantUrl`: picks the variant for `usage` from the page's encoding
 *  settings, forms the deterministic `<atlasUrl>~page<N>~<variant>.<ext>` URL, and
 *  cache-busts with the atlas content hash. Returns undefined only when the atlas
 *  GUID doesn't resolve to a path (both 2D and 3D now have a KTX2/WebP variant). */
export function resolveAtlasPageUrl(frame: AtlasFrameRef, usage: '2d' | '3d'): string | undefined {
  const atlasPath = getAssetEntry(frame.atlasGuid)?.path;
  if (!atlasPath) return undefined;
  const variant = selectVariant(frame.texture, usage, detectedCaps);
  return withCacheBust(assetUrl(`${atlasPath}~page${frame.page}${variantSuffix(variant)}`), frame.hash);
}

/** BROWSER-decodable (WebP/PNG) URL of an atlas page for a member frame — the DOM/Canvas2D
 *  counterpart to {@link resolveAtlasPageUrl}. An atlas page is inherently 2d, so it always
 *  exposes a browser variant (WebP; the atlas emitter emits it as a sibling for a ktx2 page).
 *  Returns undefined only when the atlas GUID doesn't resolve to a path. */
function resolveAtlasPageBrowserUrl(frame: AtlasFrameRef): string | undefined {
  const atlasPath = getAssetEntry(frame.atlasGuid)?.path;
  if (!atlasPath) return undefined;
  const variant = browserVariant(frame.texture.format, '2d');
  if (!variant) return undefined; // unreachable for a 2d page, but keep the type honest
  return withCacheBust(assetUrl(`${atlasPath}~page${frame.page}${variantSuffix(variant)}`), frame.hash);
}

/** Resolve a 2D image-or-sprite ref to `{ url, frame, pivot }`.
 *  - A sprite GUID that's a member of a BUILT atlas resolves to the atlas page URL +
 *    its rect ON THE PAGE. `sheetW/sheetH` carry the page dims so a consumer can
 *    normalize the page-px rect to 0..1 (the page is authored 1:1, so the render-path
 *    downscale scaling in `frameTexture` is a no-op: base.width/sheetW == 1).
 *  - A `'sprite'` GUID otherwise resolves through its parent texture, carrying the
 *    slice's frame rect + pivot.
 *  - Any other texture ref / path / URL resolves to the whole image (`frame: null`).
 *  Returns undefined when the ref can't be resolved (unknown GUID, no 2D variant). */
export function resolveSprite(ref: string): ResolvedSprite | undefined {
  // Built-atlas redirect first: a packed member draws from its page, not the source.
  const af = getAtlasFrame(ref);
  if (af) {
    const url = resolveAtlasPageUrl(af, '2d');
    if (url) {
      return { url, frame: { ...af.rect }, pivot: { ...af.pivot }, sheetW: af.pageW, sheetH: af.pageH };
    }
    // No 2D page variant (mis-set atlas format) — fall through to the source sprite.
  }
  const entry = getAssetEntry(ref);
  if (entry?.type === 'sprite' && entry.sprite) {
    // Resolve the URL through the parent texture's 2D variant (the slice has no file
    // of its own). Phase-2 packing will redirect this to the atlas page + page rect.
    const url = resolveTextureVariantUrl(entry.sprite.texture, '2d');
    if (!url) return undefined;
    return {
      url, frame: { ...entry.sprite.rect }, pivot: { ...entry.sprite.pivot },
      sheetW: entry.sprite.sheetW ?? null, sheetH: entry.sprite.sheetH ?? null,
      ...(entry.sprite.border ? { border: { ...entry.sprite.border } } : {}),
    };
  }
  const url = resolveTextureVariantUrl(ref, '2d');
  if (!url) return undefined;
  return { url, frame: null, pivot: null, sheetW: null, sheetH: null };
}

const _domKtxWarned = new Set<string>();
function warnKtxTextureInDom(ref: string): void {
  if (_domKtxWarned.has(ref)) return;
  _domKtxWarned.add(ref);
  console.warn(
    `[textureResolver] "${ref}" is a 3D-typed KTX2 texture drawn in the DOM, which cannot ` +
    `decode KTX2 (no WebP sibling is emitted for 3D textures). Falling back to the unconverted ` +
    `source (STRIPPED from production builds). Set the texture type to 'ui'/'2d' so a WebP is emitted.`,
  );
}

/** A BROWSER-decodable image URL for a sprite/texture ref — for consumers that CANNOT
 *  decode the KTX2 GPU variant (DOM `<img>`/CSS `background-image`, editor SceneView
 *  Canvas2D `drawImage`). This is the DOM counterpart to the `'2d'` (PixiJS/GPU) path:
 *   - a `2d`/`ui` texture exposes a browser variant (WebP for a ktx2 format, else its
 *     own webp/png) → returned here; the KTX2 GPU variant stays on the PixiJS/Three path;
 *   - a `3d`-typed KTX2 texture emits NO WebP sibling (Three's KTX2Loader decodes it
 *     everywhere), so drawing one in the DOM is misuse → source fallback + (opt-in) warn.
 *  A sprite resolves through its parent texture (the slice has no file of its own); pair
 *  with the sprite's normalized frame rect to draw the slice. Returns undefined when the
 *  ref doesn't resolve to a path.
 *
 *  `warnKtx` (opt-in): only the production-DOM path (UI `<img>`) should set it — a UI image
 *  with no browser variant is genuinely broken in prod. The editor SceneView preview must
 *  NOT warn (a 2d/skin texture is correctly ktx2 for the game and now has a WebP sibling). */
export function resolveBrowserImageUrl(ref: string, warnKtx = false): string | undefined {
  // Built-atlas member: draw from the atlas PAGE (the buffer's uvRect maps into the page),
  // NOT the original source texture — mirror resolveSprite's atlas redirect. The page is a
  // 2d texture, so it has a browser variant.
  const af = getAtlasFrame(ref);
  if (af) {
    const url = resolveAtlasPageBrowserUrl(af);
    if (url) return url;
    // No page variant (mis-set atlas) — fall through to the source sprite below.
  }
  const entry = getAssetEntry(ref);
  const texRef = entry?.type === 'sprite' && entry.sprite ? entry.sprite.texture : ref;
  const texEntry = getAssetEntry(texRef);
  const sourcePath = resolveRef(texRef);
  if (!sourcePath) return undefined;
  const settings = texEntry?.texture;
  if (settings) {
    // The WebP/PNG sibling a 2d/ui texture exposes (mirrors what the build emits).
    const variant = browserVariant(settings.format, texEntry?.textureType);
    if (variant) {
      return withCacheBust(assetUrl(sourcePath + variantSuffix(variant)), texEntry?.hash);
    }
    // 3d-typed KTX2 texture in the DOM → no browser variant on disk.
    if (warnKtx) warnKtxTextureInDom(ref);
  }
  return assetUrl(sourcePath);
}

function applyTextureSettings(tex: THREE.Texture, s: TextureImportSettings, isKtx: boolean, flipY?: boolean): void {
  tex.wrapS = WRAP[s.wrapS];
  tex.wrapT = WRAP[s.wrapT];
  tex.colorSpace = s.colorspace === 'linear' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (isKtx) {
    // KTX2/Basis is bottom-origin and carries baked mip levels.
    tex.flipY = false;
    tex.generateMipmaps = false;
  } else {
    if (flipY !== undefined) tex.flipY = flipY;
    tex.generateMipmaps = s.mipmaps;
  }
  tex.minFilter = s.mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.needsUpdate = true;
}

// ── Shared, refcounted texture cache (F3) ──────────────────────────────────
// `loadTexture3D` used to mint a FRESH THREE.Texture per call, so the same texture
// referenced by N materials / particle emitters cost N fetches + N KTX2 transcodes
// (the expensive WASM/worker step) + N GPU uploads — undoing the content-hash
// immutability the pipeline is built on. We now memoize by resolved-variant URL and
// refcount: every `loadTexture3D` is +1, every `releaseTexture3D` is −1, the texture
// is disposed at 0. Consumers MUST call `releaseTexture3D(tex)` instead of
// `tex.dispose()`. The cache key is stashed on `tex.userData[KEY]` so a consumer
// holding only the instance can release it (robust to a manifest change between
// acquire and release). Material *clones* that merely copy `.map` (e.g. Tint clones)
// must keep using plain `material.dispose()` — they borrow the shared texture and do
// NOT hold a refcount, so they must NOT release it.
const KEY = '__sharedTexKey';
interface TexCacheEntry {
  promise: Promise<THREE.Texture>;
  texture: THREE.Texture | null; // resolved instance, for synchronous disposal at refCount 0
  refCount: number;
  url: string; // resolved variant URL — the match key for invalidateTexture
}
const texCache = new Map<string, TexCacheEntry>();

function texCacheKey(url: string, isKtx: boolean, flipY?: boolean): string {
  // KTX2 is always bottom-origin (applyTextureSettings forces flipY=false), so flipY
  // doesn't differentiate the resulting texture there — keep those calls on ONE entry.
  // For non-KTX sources flipY mutates the texture, so it must be part of the key.
  return isKtx ? url : `${url}|${flipY ?? 'd'}`;
}

/** Load a texture for 3D use (material map / inline primitive). Picks a KTX2
 *  variant (transcoded to the GPU's format) or falls back to the raw source.
 *  `flipY` overrides orientation for non-KTX sources (KTX2 is always bottom-origin
 *  = `false`); used by material textures that follow the GLB `flipY=false` convention.
 *  Refcounted + shared (see the cache note above): release with `releaseTexture3D`. */
export async function loadTexture3D(ref: string, opts?: { flipY?: boolean }): Promise<THREE.Texture> {
  const url = resolveTextureVariantUrl(ref, '3d');
  if (!url) throw new Error(`[textureResolver] unresolved texture ref: ${ref}`);
  const isKtx = /\.ktx2(\?|$)/.test(url); // url may carry a ?v=<hash> cache-bust suffix
  const key = texCacheKey(url, isKtx, opts?.flipY);
  const hit = texCache.get(key);
  if (hit) { hit.refCount++; return hit.promise; }

  const settings = getTextureSettings(ref);
  const loader = isKtx ? getKTX2Loader() : getTextureLoader();
  const entry: TexCacheEntry = { promise: undefined as never, texture: null, refCount: 1, url };
  // Gate KTX2 loads on renderer readiness: KTX2Loader.loadAsync throws
  // "Missing initialization with `.detectSupport( renderer )`" if it runs before
  // `setActiveRenderer` wires the loader's GPU-format caps. In the EDITOR, scene
  // load is gated on `rendererReady` up front — but the game runtime creates the
  // renderer (async WebGPU `init()`) and loads the scene concurrently, so on
  // slower GPUs (e.g. Android/Adreno WebGPU) the island's first material textures
  // race ahead of `detectSupport` and fail permanently. This is the single 3D
  // texture chokepoint, so gating here covers every caller with no deadlock risk
  // (a 2D-only game never reaches loadTexture3D, so it never awaits a renderer).
  // The synchronous cache check above is preserved, so concurrent acquires of the
  // same texture still dedup to one load. Non-KTX sources (TextureLoader) need no
  // renderer and aren't gated.
  const gate = isKtx && !rendererReadyFired ? rendererReady : Promise.resolve();
  // Cast unifies the KTX2Loader/TextureLoader loadAsync union (CompressedTexture
  // extends Texture) so the extra `.then` gate doesn't break inference.
  entry.promise = gate.then(() => loader.loadAsync(url) as Promise<THREE.Texture>).then((loaded) => {
    const tex = loaded as THREE.Texture;
    applyTextureSettings(tex, settings, isKtx, opts?.flipY);
    (tex.userData as Record<string, unknown>)[KEY] = key;
    entry.texture = tex;
    return tex;
  }).catch((e) => {
    // Don't cache a rejected load forever — a later call should be free to retry
    // (e.g. once the renderer/transcoder becomes ready). Acquirers see the reject.
    if (texCache.get(key) === entry) texCache.delete(key);
    throw e;
  });
  texCache.set(key, entry);
  return entry.promise;
}

/** Release one reference taken by `loadTexture3D`. Disposes the underlying
 *  THREE.Texture when the last reference drops. Pass the resolved texture instance
 *  (consumers hold it); a texture not from the shared cache is disposed directly, and
 *  releasing an already-evicted texture (force-dropped by `invalidateTexture`) is a
 *  safe no-op. Call this — never `tex.dispose()` — for anything from `loadTexture3D`. */
export function releaseTexture3D(tex: THREE.Texture | null | undefined): void {
  if (!tex) return;
  const key = (tex.userData as Record<string, unknown> | undefined)?.[KEY] as string | undefined;
  if (!key) { tex.dispose(); return; } // not shared-cache owned → dispose directly
  const entry = texCache.get(key);
  if (!entry) return; // already force-evicted by invalidateTexture (texture disposed there)
  if (--entry.refCount > 0) return;
  entry.texture?.dispose();
  texCache.delete(key);
}

/** Whether `tex` came from the shared cache (and so must be freed via
 *  `releaseTexture3D`, never `tex.dispose()`). Lets a generic disposal path (e.g.
 *  meshTemplateCache.disposeMaterial) tell shared textures apart from directly-owned
 *  ones (env maps, rigged-GLB embedded textures) so it releases the former and
 *  dedup-disposes the latter. */
export function isSharedTexture(tex: THREE.Texture | null | undefined): boolean {
  return !!tex && typeof (tex.userData as Record<string, unknown> | undefined)?.[KEY] === 'string';
}

/** Diagnostics: number of distinct cached textures + total outstanding refs. */
export function getSharedTextureStats(): { count: number; refs: number } {
  let refs = 0;
  for (const e of texCache.values()) refs += e.refCount;
  return { count: texCache.size, refs };
}

/** Hard reset — dispose every shared texture regardless of refcount and clear the
 *  cache. For genuine FULL teardown / tests only, NOT mid-session scene swaps:
 *  a swap relies on refcounting (a texture shared by the outgoing and incoming
 *  scene must survive), so force-flushing there would dispose a live texture. */
export function disposeAllSharedTextures(): void {
  for (const e of texCache.values()) e.texture?.dispose();
  texCache.clear();
}

/** Subscribe to the FIRST `setActiveRenderer` call. Used by callers that
 *  failed a KTX2 transcode before the renderer was ready, to retry after
 *  the loader's worker has its GPU caps. */
export function onRendererReady(fn: () => void): void {
  if (rendererReadyFired) { fn(); return; }
  rendererReady.then(fn);
}

/** Drop the shared cache's textures for a ref's variants so a subsequent load
 *  re-fetches + re-transcodes the freshly-converted files. Called by the editor's
 *  texture re-import + model re-import, both of which then reload the active scene —
 *  materials rebuild and re-acquire fresh bytes. The old THREE.Texture instances are
 *  force-disposed here regardless of refcount; any outstanding `releaseTexture3D` on
 *  them becomes a safe no-op (the entry is already gone), so there's no double dispose. */
export function invalidateTexture(ref: string): void {
  // `ref` is normally a GUID, but the editor's texture re-import + model import
  // call this with the asset PATH directly. resolveRef rejects internal paths
  // loudly, so only route GUIDs through it and accept a path (or external URL)
  // as-is — this is just a cache key, so the literal source is what we want.
  const sourcePath = isGuid(ref) ? resolveRef(ref) : ref;
  if (!sourcePath) return;
  // The set of variant URLs this ref could have been loaded under — built with the
  // SAME key construction loadTexture3D uses, including the ?v=<hash> suffix in prod.
  const hash = getAssetEntry(ref)?.hash;
  const urls = new Set<string>();
  for (const v of ['uastc', 'etc1s', 'astc', 'webp', 'png'] as const) {
    urls.add(withCacheBust(assetUrl(sourcePath + variantSuffix(v)), hash));
  }
  urls.add(withCacheBust(assetUrl(sourcePath), hash));
  // Force-evict + dispose any shared textures bound to those URLs.
  for (const [key, entry] of texCache) {
    if (urls.has(entry.url)) { entry.texture?.dispose(); texCache.delete(key); }
  }
  // THREE.Cache holds decoded image bytes only when Cache.enabled (it isn't, today);
  // evict for parity in case it's ever turned on.
  for (const u of urls) THREE.Cache.remove(u);
}
