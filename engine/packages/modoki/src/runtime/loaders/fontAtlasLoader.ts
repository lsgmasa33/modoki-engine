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

import { resolveRef, getAssetEntry, isGuid, onFontInvalidated } from './assetManifest';
import { assetUrl, withCacheBust } from './assetUrl';
import { assetIsAbsent, checkAssetResponse, parseAssetJson, readAssetBytes } from './assetFetch';
import { createLoadFailureMemo, rethrowAsNetworkError } from '../core/loadFailureMemo';
import { FONT_ATLAS_SUFFIX, FONT_METRICS_SUFFIX, FONT_INSTANCE_SUFFIX } from '../core/fontSettings';
import { parseChlumskyJson } from '../rendering/text/glyphAtlas';
import { BakedFontProvider, type FontProvider } from '../rendering/text/fontProvider';
import { DynamicFontProvider, dynamicConfigFromSettings } from '../rendering/text/dynamicFontProvider';
import { disposeMsdfGenerator } from '../rendering/text/msdfGenerate';
import { markTextDirty } from '../rendering/text/textDirty';
import { createTeardownToken } from '../core/liveness';

type SceneId = number;

const providers = new Map<string, FontProvider>();                   // guid → provider (once loaded)
const loadPromises = new Map<string, Promise<FontProvider | null>>(); // guid → in-flight load
const owners = new Map<string, Set<SceneId>>();                      // guid → owning scenes
const unknownSeen = new Set<string>();                               // warn-once for bad guids
// Teardown liveness — PER-KEY (#856): invalidateFont and releaseFontsForScene's per-guid drop each
// invalidate only THAT guid's key, so an unrelated font's in-flight acquire started around the same
// time is not superseded. This matters because `ensureFontLoaded` is called per frame from
// `Scene2D.tsx` and `scene3DSync.ts`, so a live unrelated acquire genuinely can be in flight at a
// scene swap. An in-flight acquire captures its own guid's key and refuses to cache its result if
// it changed (or the owner vanished) — otherwise a fetch that resolves AFTER its scene was released
// re-inserts an owner-less provider that releaseFontsForScene can never reclaim (leak). Full
// teardown (`disposeAllFonts`) still invalidates wholesale. Mirrors audioBufferCache's liveness guard.
const liveness = createTeardownToken();
/** What a FAILED load left behind (#1397). Before it, nothing: `ensureFontLoaded` runs every frame
 *  from both renderers, so a font whose metrics 404'd was fetched again every frame. A 404 or a
 *  corrupt file is now remembered until the font is invalidated or its last scene lets go; a
 *  dropped connection or a 5xx backs off. `unknownIs: 'permanent'` — every fetch below is typed at
 *  the source, so an unknown is a parse throw or a generator failure, which the same bytes
 *  reproduce. `onRetryDue` repaints dirty-gated Scene2D text when a retry is due. */
const failures = createLoadFailureMemo({ label: 'fontAtlasLoader', unknownIs: 'permanent', onRetryDue: (guid) => markTextDirty(guid) });

/** Fetch a binary font asset with every outcome typed for {@link failures}. */
async function fetchFontBytes(url: string): Promise<Uint8Array> {
  const res = checkAssetResponse(await fetch(url).catch(rethrowAsNetworkError), url);
  return new Uint8Array(await readAssetBytes(res));
}

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
  const entry = getAssetEntry(guid);
  const hash = entry?.hash;
  return {
    atlasUrl: withCacheBust(assetUrl(sourcePath + FONT_ATLAS_SUFFIX), hash),
    metricsUrl: withCacheBust(assetUrl(sourcePath + FONT_METRICS_SUFFIX), hash),
    // Raw outlines for the dynamic provider to rasterize. When the font authors
    // `variationAxes` the build emits an axis-pinned `~instance.ttf` and THAT is the
    // right file — the generator cannot apply axes itself, so fetching the source here
    // would silently rasterize the font's default instance (Thin, for Geologica/Nunito/
    // NotoSansJP) no matter what the sidecar says.
    fontUrl: withCacheBust(assetUrl(entry?.font?.instanced ? sourcePath + FONT_INSTANCE_SUFFIX : sourcePath), hash),
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
  if (failures.blocked(guid)) return null;

  // Resolve BEFORE the memo, because an unresolvable guid must NOT be memoized. `fontUrls` is
  // sync, so the old shape returned null from inside the promise body and then stored that
  // settled null in `loadPromises` — where nothing ever removed it (the `finally` that clears the
  // memo belongs to the try BELOW this early return). A font ref bound in the window before the
  // manifest reaches the client was therefore dead for the whole session: the manifest arrived,
  // the guid resolved, and every later acquire still handed back the cached null, so the font
  // never rendered. Found writing the warn-forget test for it.
  const urls = fontUrls(guid);
  if (!urls) {
    if (!unknownSeen.has(guid)) { unknownSeen.add(guid); console.warn(`[fontAtlasLoader] cannot resolve font guid ${guid}`); }
    return null;
  }
  // It resolves now → forget it, so a genuine LATER break warns again. Same gap
  // `resolveRefWarnOnce` had (QA-ASSET-0005): one miss in the window before the manifest
  // arrives otherwise silences this guid for the rest of the session, and the deletion that
  // actually breaks the font then produces no console line at all.
  unknownSeen.delete(guid);

  const stillLive = liveness.capture(guid);
  const promise = (async (): Promise<FontProvider | null> => {
    try {
      // Dynamic (path B): generate glyphs at runtime from real outlines — the pinned
      // `~instance.ttf` when axes are authored, else the source .ttf (never the baked
      // atlas); metrics and glyphs all come from the generator. Baked (path A): load
      // the pre-baked mtsdf atlas.
      const fontBlock = getAssetEntry(guid)?.font;
      let provider: FontProvider | null;
      if (fontBlock?.mode === 'dynamic') {
        // The BAKED atlas is the seed — which is what `dynamic` has always meant in the
        // docs, and what the code did not do. It used to skip the bake entirely and
        // regenerate the seed charset through the WASM worker at every boot: a 1.5 MB wasm
        // fetch plus ~640 ms of rasterization (desktop; more on a phone) to reproduce
        // glyphs the shipped `~atlas.png` already contained, all of it blocking the scene
        // load because fonts are awaited scene resources. Seeded from the bake this path is
        // as fast as a baked font, and the generator is touched only if something actually
        // asks for a glyph outside the baked charset.
        // Only a bake that is NOT THERE (404/410, or the dev server's SPA fallback) falls through
        // to the WASM seed below. A 5xx or a dropped connection is the server failing to serve a
        // bake that may exist: it throws to the catch as transient, rather than paying the slow
        // seed path for a blip (#1397).
        let bakedJson: unknown;
        try {
          bakedJson = await parseAssetJson(await fetch(urls.metricsUrl).catch(rethrowAsNetworkError), urls.metricsUrl);
        } catch (e) {
          if (!assetIsAbsent(e)) throw e;
        }
        if (bakedJson !== undefined) {
          const atlas = parseChlumskyJson(bakedJson);
          if (!stillLive() || !owners.has(guid)) return null;
          provider = DynamicFontProvider.fromBaked(
            guid, atlas, urls.atlasUrl,
            // Deferred: not fetched at all unless a miss happens.
            () => fetchFontBytes(urls.fontUrl),
            dynamicConfigFromSettings(fontBlock),
          );
        } else {
          // No usable bake (conversion failed) — fall back to generating the seed, which is
          // the only way this font renders at all. Slow, and now the exception.
          const bytes = await fetchFontBytes(urls.fontUrl);
          if (!stillLive() || !owners.has(guid)) return null;
          provider = await DynamicFontProvider.create(guid, bytes, dynamicConfigFromSettings(fontBlock));
        }
      } else {
        const res = await fetch(urls.metricsUrl).catch(rethrowAsNetworkError);
        // parseAssetJson types a non-ok status, and the SPA fallback (a missing asset arriving as
        // 200 OK index.html), so the failure memo can tell absent from unreachable.
        const atlas = parseChlumskyJson(await parseAssetJson(res, urls.metricsUrl));
        provider = new BakedFontProvider(guid, atlas, urls.atlasUrl);
      }
      // The scene that requested this may have been released while the fetch/gen was
      // in flight — don't re-insert an owner-less provider (unreclaimable leak).
      if (!provider) return null;
      if (!stillLive() || !owners.has(guid)) { provider.dispose(); return null; }
      providers.set(guid, provider);
      failures.forget(guid);
      // Text that was waiting on this font can now lay out — nudge dirty-gated
      // renderers (Scene2D) to repaint. (Scene3D re-queries every frame anyway.)
      markTextDirty(guid);
      return provider;
    } catch (e) {
      failures.record(guid, e, stillLive() && owners.has(guid));
      return null;
    }
  })().finally(() => {
    // IDENTITY-CHECKED, as `riggedModelCache` spells out at its twin: an `invalidateFont` or a
    // last release mid-flight deletes this entry and the next frame starts a REPLACEMENT load,
    // which an unconditional delete here would evict when this stale load settles — so the
    // frame after that starts a third, and a failure the replacement is about to record is
    // re-requested before it lands (#1397).
    if (loadPromises.get(guid) === promise) loadPromises.delete(guid);
  });
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
 *  with the new manifest block. Invalidates liveness (kills any in-flight load) + marks
 *  text dirty so dirty-gated renderers repaint. Wired to manifest font-changes below. */
export function invalidateFont(guid: string): void {
  const p = providers.get(guid);
  if (p) p.dispose();
  providers.delete(guid);
  loadPromises.delete(guid);
  failures.forget(guid); // a re-bake may have fixed the file
  liveness.invalidateKey(guid);
  markTextDirty(guid);
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
      failures.forget(guid); // failure memory is scene-scoped, like the mesh cache's (#1371)
      liveness.invalidateKey(guid); // invalidate any in-flight acquire for this guid
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
  failures.clear();
  liveness.invalidateAll(); // invalidate every in-flight acquire
  void disposeMsdfGenerator();
}

/** Test/debug: owner counts per font guid. */
export function getFontOwnerCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of owners) out[k] = v.size;
  return out;
}
