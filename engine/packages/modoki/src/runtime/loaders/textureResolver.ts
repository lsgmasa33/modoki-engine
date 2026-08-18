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
import { envVariantSuffix, type EnvFormat } from '../core/environmentSettings';
import {
  setActiveRendererHandle, ktx2CapsReady, areKtx2CapsReady, markKtx2CapsReady,
} from '../core/activeRenderer';
import { warnVocabOnce } from '../core/warnVocab';
import { getActiveTextureSizeCap } from '../core/textureSizeCap';
export { getActiveRenderer, onRendererReady, rendererReady, getRendererGateHealth } from '../core/activeRenderer';
export type { RendererGateHealth } from '../core/activeRenderer';
export type { ResolvedSprite } from '../core/textureProvider';
import type { ResolvedSprite } from '../core/textureProvider';

const WRAP: Record<TextureWrap, THREE.Wrapping> = {
  repeat: THREE.RepeatWrapping,
  clamp: THREE.ClampToEdgeWrapping,
  mirror: THREE.MirroredRepeatWrapping,
};

let ktx2Loader: KTX2Loader | null = null;
let texLoader: THREE.TextureLoader | null = null;
let detectedCaps = { astc: false };

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
  try {
    const loader = getKTX2Loader();
    loader.detectSupport(renderer as never);
    const cfg = (loader as unknown as { workerConfig?: { astcSupported?: boolean } }).workerConfig;
    detectedCaps = { astc: !!cfg?.astcSupported };
  } catch (e) {
    console.warn('[textureResolver] detectSupport failed:', e);
  }
  setActiveRendererHandle(renderer);
}

/** Default delay before `ensureKtx2Caps` gives up waiting for a real viewport and stands up a
 *  throwaway probe renderer instead. Anchored on the ~1.0s a viewport normally takes to mount
 *  (see `NO_VIEWPORT_TIMEOUT_MS` in `editor/createEditor.tsx`) — ~2x headroom before a probe ever
 *  races a real one, and well under the old 12s editor fast-fail. Decided value, not a knob to
 *  re-tune without a fresh measurement. */
export const KTX2_PROBE_DELAY_MS = 2000;

// Single-flight — concurrent `ensureKtx2Caps` callers must trigger exactly ONE probe.
let probePromise: Promise<void> | null = null;

async function runCapsProbe(
  probeFactory: () => Promise<WebGPURenderer | THREE.WebGLRenderer>,
): Promise<void> {
  if (areKtx2CapsReady()) return; // a viewport won the race between the timer firing and here
  if (!probePromise) {
    probePromise = (async () => {
      let probe: WebGPURenderer | THREE.WebGLRenderer | undefined;
      try {
        probe = await probeFactory();
        getKTX2Loader().detectSupport(probe as never);
      } catch (e) {
        // Resolve anyway: a per-texture rejection with a clear cause beats an eternal hang for
        // every future KTX2 load. `detectSupport` copies capability booleans synchronously and
        // keeps no renderer reference (verified against KTX2Loader.js), so disposing right after
        // — or never having created one — is always safe.
        console.error('[textureResolver] KTX2 caps probe failed — KTX2 texture loads may reject:', e);
      } finally {
        probe?.dispose();
      }
      markKtx2CapsReady('probe');
    })();
  }
  return probePromise;
}

/** The ONE place anything waits for KTX2 transcoder caps. Resolves immediately if a real
 *  viewport (or an earlier probe) already registered them; otherwise waits briefly for a
 *  viewport to show up on its own, and if none does, stands up a throwaway probe renderer
 *  (`capsProbeRenderer.ts`, dynamically imported so `runtime/loaders` never statically depends
 *  on `runtime/rendering` — see `docs/architecture-layers.md`'s cycle guard) purely to run
 *  `detectSupport`. Never rejects — a probe failure still resolves the gate (see `runCapsProbe`)
 *  so a dead GPU degrades to per-texture errors instead of hanging every future KTX2 load. */
export async function ensureKtx2Caps(opts?: {
  delayMs?: number;
  probeFactory?: () => Promise<WebGPURenderer | THREE.WebGLRenderer>;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}): Promise<void> {
  if (areKtx2CapsReady()) return;
  const delayMs = opts?.delayMs ?? KTX2_PROBE_DELAY_MS;
  const timers = opts?.timers ?? {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  const probeFactory = opts?.probeFactory ?? (async () => {
    const { createCapsProbeRenderer } = await import('../rendering/capsProbeRenderer');
    return createCapsProbeRenderer();
  });

  let timerId: ReturnType<typeof setTimeout> | undefined;
  const delayThenProbe = new Promise<void>((resolve) => {
    timerId = timers.setTimeout(() => { void runCapsProbe(probeFactory).then(resolve, resolve); }, delayMs);
  });
  await Promise.race([ktx2CapsReady, delayThenProbe]);
  if (timerId !== undefined) timers.clearTimeout(timerId);
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
  // Texture LOD by quality tier (#212). The active tier's cap is used ONLY when the manifest
  // says a variant was actually EMITTED at that size — never guessed. A cap the build didn't
  // produce (project authors no tiers; this size wasn't below this texture's own maxSize/source
  // dims; an older manifest predating this feature) falls straight through to today's URL,
  // unchanged — the resolver must not request a file that may not exist (a missing asset hangs
  // rather than fails, per this repo's own history).
  const cap = getActiveTextureSizeCap();
  const sizeCap = cap > 0 && settings.sizes?.includes(cap) ? cap : undefined;
  // Cache-bust immutable production assets with the content hash (shared helper —
  // matches modelGlbUrl + the invalidateTexture eviction key below).
  return withCacheBust(assetUrl(sourcePath + variantSuffix(variant, sizeCap)), entry?.hash);
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

/** One-time warn for a 2D sprite ref that will never resolve.
 *
 *  WHY (QA-ASSET-0011). The 3D path warns once per unresolvable guid via
 *  `resolveRefWarnOnce` (`[MeshCache] Unknown asset guid: …`); the 2D path returned
 *  `undefined` and both Scene2D call sites bailed silently ("wait for next frame" — which
 *  never ends for a ref that will never resolve). Delete a texture a 2D sprite references
 *  and you got a blank screen with a clean console. The asymmetry WAS the defect. Warned
 *  here rather than at the two call sites so every `resolveSprite` consumer inherits it.
 *
 *  Deduped per ref, so the transient window before the manifest loads costs at most one line —
 *  the same trade `resolveRefWarnOnce` already makes on the 3D side. But a ref that LATER
 *  resolves is FORGOTTEN (`forgetUnresolvedSprite`), so that transient miss cannot permanently
 *  silence the guid: without that, a ref that failed once before the manifest arrived, then
 *  worked, then genuinely broke mid-session would fail in exactly the "blank screen, clean
 *  console" way this warning exists to prevent. (The 3D `unknownGuidSeen` sets had the same gap
 *  until QA-ASSET-0005 measured its cost; `resolveRefWarnOnce` forgets a resolving ref too now.) */
const _unresolvedSpriteWarned = new Set<string>();
function warnUnresolvedSprite(ref: string, why: string): undefined {
  if (!isGuid(ref) || _unresolvedSpriteWarned.has(ref)) return undefined;
  _unresolvedSpriteWarned.add(ref);
  console.warn(`[Sprite2D] Unknown asset guid: ${ref}\n  (${why} — deleted, dropped from the build, renamed, or never assigned an id?)`);
  return undefined;
}

/** A ref that resolves is no longer "unresolved" — drop it so a future genuine failure warns. */
function forgetUnresolvedSprite(ref: string): void {
  if (_unresolvedSpriteWarned.size) _unresolvedSpriteWarned.delete(ref);
}

/** Forget every warned ref. Called by the harness teardown (`createTestWorld().dispose()`)
 *  alongside the other warn-once registries, so a warning assertion cannot be swallowed by a
 *  sibling test that already tripped it. */
export function resetUnresolvedSpriteWarnings(): void {
  _unresolvedSpriteWarned.clear();
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
      forgetUnresolvedSprite(ref);
      return { url, frame: { ...af.rect }, pivot: { ...af.pivot }, sheetW: af.pageW, sheetH: af.pageH };
    }
    // No 2D page variant (mis-set atlas format) — fall through to the source sprite.
  }
  const entry = getAssetEntry(ref);
  if (entry?.type === 'sprite' && entry.sprite) {
    // Resolve the URL through the parent texture's 2D variant (the slice has no file
    // of its own). Phase-2 packing will redirect this to the atlas page + page rect.
    const url = resolveTextureVariantUrl(entry.sprite.texture, '2d');
    if (!url) return warnUnresolvedSprite(ref, `its parent texture ${entry.sprite.texture} has no 2D variant`);
    forgetUnresolvedSprite(ref);
    return {
      url, frame: { ...entry.sprite.rect }, pivot: { ...entry.sprite.pivot },
      sheetW: entry.sprite.sheetW ?? null, sheetH: entry.sprite.sheetH ?? null,
      ...(entry.sprite.border ? { border: { ...entry.sprite.border } } : {}),
    };
  }
  const url = resolveTextureVariantUrl(ref, '2d');
  if (!url) return warnUnresolvedSprite(ref, 'not in the manifest');
  forgetUnresolvedSprite(ref);
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
      // It has a sibling now → forget any earlier complaint about this ref, so a retype BACK to
      // `3d` (or a re-import that drops the sibling) warns again instead of riding on the
      // silence the first warning bought. Retype+reimport is the DOCUMENTED repair for this
      // exact warning and it only started taking effect live once `textureType` reached the
      // runtime manifest (QA-ASSET-0007) — so this condition genuinely flips mid-session now.
      if (_domKtxWarned.size) _domKtxWarned.delete(ref);
      return withCacheBust(assetUrl(sourcePath + variantSuffix(variant)), texEntry?.hash);
    }
    // 3d-typed KTX2 texture in the DOM → no browser variant on disk.
    if (warnKtx) warnKtxTextureInDom(ref);
  }
  return assetUrl(sourcePath);
}

function applyTextureSettings(tex: THREE.Texture, s: TextureImportSettings, isKtx: boolean, flipY?: boolean): void {
  // Unrecognised wrapS/wrapT falls through to `undefined` (not three's own ClampToEdgeWrapping
  // default — verified they differ, see #73) — preserved as-is, just warned once.
  if (!(s.wrapS in WRAP)) warnVocabOnce('texture', 'wrapS', s.wrapS, 'wrapS left unset (undefined)');
  if (!(s.wrapT in WRAP)) warnVocabOnce('texture', 'wrapT', s.wrapT, 'wrapT left unset (undefined)');
  tex.wrapS = WRAP[s.wrapS];
  tex.wrapT = WRAP[s.wrapT];
  // Only 'linear' and 'srgb' are valid TextureColorspace values — anything else silently keeps
  // today's fallback (SRGBColorSpace), same as a legitimate 'srgb'.
  if (s.colorspace !== 'linear' && s.colorspace !== 'srgb') {
    warnVocabOnce('texture', 'colorspace', s.colorspace, "treated as 'srgb' (SRGBColorSpace)");
  }
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
  // Gate KTX2 loads on transcoder caps: KTX2Loader.loadAsync throws "Missing
  // initialization with `.detectSupport( renderer )`" if it runs before caps are known.
  // The game runtime creates the renderer (async WebGPU `init()`) and loads the scene
  // concurrently, so on slower GPUs (e.g. Android/Adreno WebGPU) the island's first
  // material textures can race ahead of `detectSupport` and fail permanently. This is
  // the single 3D texture chokepoint, so gating here covers every caller with no
  // deadlock risk — `ensureKtx2Caps` resolves via a real viewport when one exists, or a
  // throwaway probe when none ever does (a 2D-only game never reaches loadTexture3D, so
  // it never triggers a probe either). The synchronous cache check above is preserved,
  // so concurrent acquires of the same texture still dedup to one load. Non-KTX sources
  // (TextureLoader) need no caps and aren't gated.
  const gate = isKtx && !areKtx2CapsReady() ? ensureKtx2Caps() : Promise.resolve();
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
  // ⚠️ **EVERY EMITTED SIZE, NOT JUST THE UNCAPPED ONE (#212).** This set is matched against
  // `TexCacheEntry.url`, so a variant missing from it can never be evicted — and a per-tier capped
  // texture (`~uastc@512.ktx2`) was missing from it for exactly as long as the feature existed.
  // Measured: `invalidateAssets` reported `textures: 0` on a scene holding 21 of them. It fails
  // SILENTLY in the worst direction for an editor re-import — the stale texture simply stays on
  // screen and the author concludes their re-import did not take.
  const sizes: (number | undefined)[] = [undefined, ...(getAssetEntry(ref)?.texture?.sizes ?? [])];
  for (const v of ['uastc', 'etc1s', 'astc', 'webp', 'png'] as const) {
    for (const size of sizes) {
      urls.add(withCacheBust(assetUrl(sourcePath + variantSuffix(v, size)), hash));
    }
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
