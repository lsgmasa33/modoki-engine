/** SDF font-atlas loader — resolves a font GUID to a {@link FontProvider}, fetching
 *  the baked mtsdf atlas (`~atlas.png`) + Chlumsky metrics (`~metrics.json`) variants.
 *  This is the SDF/text-rendering loader; the CSS-`fontFamily` loader (browser
 *  FontFace, for `UIElement.fontFamily`) is the separate `loaders/fontLoader.ts`.
 *
 *  Scene-scoped refcounting mirrors the mesh/audio caches: fonts are scene
 *  resources, acquired on first use and released wholesale at scene swap via
 *  {@link releaseFontsForScene} (wired into meshTemplateCache's releaseAllForScene,
 *  same as audio). A font shared by two consecutive scenes survives the swap.
 *
 *  The provider is renderer-agnostic (it carries the atlas image URL + parsed glyph
 *  data); Scene3D/Scene2D each build their own GPU texture from it.
 */

import { resolveRef, getAssetEntry, isGuid, onFontInvalidated } from '../../loaders/assetManifest';
import { assetUrl, withCacheBust } from '../../loaders/assetUrl';
import { FONT_ATLAS_SUFFIX, FONT_METRICS_SUFFIX } from '../../loaders/fontSettings';
import { parseChlumskyJson } from './glyphAtlas';
import { BakedFontProvider, type FontProvider } from './fontProvider';
import { DynamicFontProvider } from './dynamicFontProvider';
import { disposeMsdfGenerator } from './msdfGenerate';
import { markTextDirty } from './textDirty';

type SceneId = number;

const providers = new Map<string, FontProvider>();                   // guid → provider (once loaded)
const loadPromises = new Map<string, Promise<FontProvider | null>>(); // guid → in-flight load
const owners = new Map<string, Set<SceneId>>();                      // guid → owning scenes
const unknownSeen = new Set<string>();                               // warn-once for bad guids
// Bumped whenever a font is released/disposed. An in-flight acquire captures the
// value and refuses to cache its result if it changed (or the owner vanished) —
// otherwise a fetch that resolves AFTER its scene was released re-inserts an
// owner-less provider that releaseFontsForScene can never reclaim (leak). Mirrors
// audioBufferCache's generation guard.
let generation = 0;

function addOwner(guid: string, sceneId: SceneId): void {
  let set = owners.get(guid);
  if (!set) { set = new Set(); owners.set(guid, set); }
  set.add(sceneId);
}

/** Build the served URLs for a font GUID's baked variants (with `?v=<hash>`
 *  cache-bust). Returns null when the guid doesn't resolve. */
function fontUrls(guid: string): { atlasUrl: string; metricsUrl: string; fontUrl: string } | null {
  const sourcePath = resolveRef(guid);
  if (!sourcePath) return null;
  const hash = getAssetEntry(guid)?.hash;
  return {
    atlasUrl: withCacheBust(assetUrl(sourcePath + FONT_ATLAS_SUFFIX), hash),
    metricsUrl: withCacheBust(assetUrl(sourcePath + FONT_METRICS_SUFFIX), hash),
    // Source .ttf/.otf — the dynamic provider generates glyphs from these raw bytes.
    fontUrl: withCacheBust(assetUrl(sourcePath), hash),
  };
}

/** Load (or return the cached) FontProvider for a font GUID under a scene's
 *  ownership. Memoized per guid — concurrent callers share one fetch. Returns null
 *  if the guid doesn't resolve or the fetch/parse fails (logged once). */
export async function acquireFont(sceneId: SceneId, guid: string): Promise<FontProvider | null> {
  if (!guid || !isGuid(guid)) return null;
  addOwner(guid, sceneId);
  const existing = providers.get(guid);
  if (existing) return existing;
  const inFlight = loadPromises.get(guid);
  if (inFlight) return inFlight;

  const gen = generation;
  const promise = (async (): Promise<FontProvider | null> => {
    const urls = fontUrls(guid);
    if (!urls) {
      if (!unknownSeen.has(guid)) { unknownSeen.add(guid); console.warn(`[fontAtlasLoader] cannot resolve font guid ${guid}`); }
      return null;
    }
    try {
      // Dynamic (path B): generate glyphs at runtime from the raw font. Needs the
      // SOURCE .ttf bytes (not the baked atlas); everything else (metrics, glyphs) is
      // produced by the generator. Baked (path A): load the pre-baked mtsdf atlas.
      const mode = getAssetEntry(guid)?.font?.mode;
      let provider: FontProvider | null;
      if (mode === 'dynamic') {
        const fontRes = await fetch(urls.fontUrl);
        if (!fontRes.ok) throw new Error(`font fetch ${fontRes.status}`);
        const bytes = new Uint8Array(await fontRes.arrayBuffer());
        if (gen !== generation || !owners.has(guid)) return null;
        provider = await DynamicFontProvider.create(guid, bytes);
      } else {
        const res = await fetch(urls.metricsUrl);
        if (!res.ok) throw new Error(`metrics fetch ${res.status}`);
        const atlas = parseChlumskyJson(await res.json());
        provider = new BakedFontProvider(guid, atlas, urls.atlasUrl);
      }
      // The scene that requested this may have been released while the fetch/gen was
      // in flight — don't re-insert an owner-less provider (unreclaimable leak).
      if (!provider) return null;
      if (gen !== generation || !owners.has(guid)) { provider.dispose(); return null; }
      providers.set(guid, provider);
      // Text that was waiting on this font can now lay out — nudge dirty-gated
      // renderers (Scene2D) to repaint. (Scene3D re-queries every frame anyway.)
      markTextDirty();
      return provider;
    } catch (e) {
      console.warn(`[fontAtlasLoader] failed to load font ${guid}:`, e);
      return null;
    } finally {
      loadPromises.delete(guid);
    }
  })();
  loadPromises.set(guid, promise);
  return promise;
}

/** Fire-and-forget acquire — the renderer calls this when it first sees a font
 *  GUID on an entity; the atlas loads in the background and the next relayout (once
 *  {@link getLoadedFont} returns non-undefined) renders the text. */
export function ensureFontLoaded(sceneId: SceneId, guid: string): void {
  if (providers.has(guid)) { addOwner(guid, sceneId); return; }
  if (!guid || !isGuid(guid)) return;
  void acquireFont(sceneId, guid);
}

/** Synchronous accessor for an already-loaded font — used by the per-frame
 *  renderers. Undefined until the async load completes. */
export function getLoadedFont(guid: string): FontProvider | undefined {
  return providers.get(guid);
}

/** Evict the live provider for a font whose settings changed (mode flip / re-bake),
 *  KEEPING its scene ownership so the next `ensureFontLoaded`/render re-acquires it
 *  with the new manifest block. Bumps `generation` (kills any in-flight load) + marks
 *  text dirty so dirty-gated renderers repaint. Wired to manifest font-changes below. */
export function invalidateFont(guid: string): void {
  const p = providers.get(guid);
  if (p) p.dispose();
  providers.delete(guid);
  loadPromises.delete(guid);
  generation++;
  markTextDirty();
}
// Re-acquire on any Font-Inspector mode flip or re-bake (no editor restart needed).
onFontInvalidated(invalidateFont);

/** Drop this scene's hold on every font; dispose any left with no owners. Called
 *  from releaseAllForScene at scene swap (parallel cache, like audio). */
export function releaseFontsForScene(sceneId: SceneId): void {
  for (const guid of [...owners.keys()]) {
    const set = owners.get(guid);
    if (!set || !set.has(sceneId)) continue;
    set.delete(sceneId);
    if (set.size === 0) {
      owners.delete(guid);
      providers.get(guid)?.dispose();
      providers.delete(guid);
      loadPromises.delete(guid);
      generation++; // invalidate any in-flight acquire for this guid
    }
  }
}

/** Full teardown — dispose all fonts (called from disposeAllCachedResources). Also
 *  tears down the shared runtime MSDF generator (its Worker + WASM); it's a lazy
 *  app-level singleton, only spun up if a dynamic font was ever loaded. */
export function disposeAllFonts(): void {
  for (const p of providers.values()) p.dispose();
  providers.clear();
  loadPromises.clear();
  owners.clear();
  unknownSeen.clear();
  generation++; // invalidate every in-flight acquire
  void disposeMsdfGenerator();
}

/** Test/debug: owner counts per font guid. */
export function getFontOwnerCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of owners) out[k] = v.size;
  return out;
}
