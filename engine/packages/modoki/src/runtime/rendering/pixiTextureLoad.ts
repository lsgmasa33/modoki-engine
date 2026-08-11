/** PixiJS texture-load shim — the single entry every Scene2D/font Pixi texture
 *  load goes through, so the playable-blob fix lives in ONE place. */

import { Assets, type Texture } from 'pixi.js';

/** Load a texture through PixiJS Assets, forcing the image parser for `blob:` URLs.
 *
 *  A playable single-file build (VITE_PLAYABLE) serves every asset as a `blob:` URL
 *  with NO extension (assetUrl → __PLAYABLE_ASSETS__). PixiJS v8 selects a texture
 *  loadParser by EXTENSION (loadTextures.test → checkExtension → path.extname, which
 *  strips BOTH the `?query` and the `#hash` — so a URL hint can't smuggle the
 *  extension in either). A bare `blob:` therefore hits "we don't know how to parse
 *  it", the texture never loads, and the 2D render callback then reads a null texture
 *  and frameDriver auto-unregisters `render2d` → a blank game (the ONE 2D-render bug a
 *  playable hits; Three uses explicit loaders, so 3D is unaffected). Playable textures
 *  are ALWAYS browser-decodable — the asset profile forces WebP/PNG, never KTX2 — so
 *  forcing the `'texture'` parser (loadTextures' id) is correct there. Non-blob URLs
 *  (dev / web / native — real extensions, incl. KTX2) auto-detect as before. */
export function loadPixiTexture(url: string): Promise<Texture> {
  evictSourcelessEntry(url);
  if (url.startsWith('blob:')) {
    disablePixiTextureWorker();
    return Assets.load<Texture>({ src: url, parser: 'texture' });
  }
  return Assets.load<Texture>(url);
}

/**
 * Is there a cache entry for `url` that is actually USABLE — present AND still holding a source?
 *
 * ⚠️ **Exported because `Assets.cache.has(url)` is the wrong question and a call site asking it
 * cannot be rescued by the shim.** `12fea928` moved the sourceless-entry guard into
 * `loadPixiTexture` on the reasoning that every consumer shares that choke point, and listed the
 * skinned-mesh part path as covered. It is not: that site reads `if (!Assets.cache.has(part.url))`
 * and only calls the shim when the entry is ABSENT, so a present-but-sourceless entry skips the
 * load entirely and gets bound straight into a `new Mesh`. A choke-point fix only reaches callers
 * that actually call it — a `has()` short-circuit in front of it is a hole by construction.
 *
 * So: **decide "do I need to load?" with this, never with `Assets.cache.has`.**
 */
export function isPixiTextureLive(url: string): boolean {
  if (!Assets.cache.has(url)) return false;
  const cached = Assets.cache.get(url) as Texture | undefined;
  return !!cached?.source;
}

/**
 * Drop a cache entry whose `source` is gone, so the load below genuinely REFETCHES.
 *
 * `Assets.unload` destroys the texture's source EAGERLY but removes the cache entry
 * asynchronously, leaving a window where the entry is present and unusable. `Assets.load`
 * hands that corpse straight back, and every consumer then reads it as a live texture:
 * a Sprite binds it and draws nothing forever, a Mesh binds it, and the font path does
 * `tex.source.scaleMode = 'linear'` and THROWS on a null source.
 *
 * This lives in the shim rather than at the call sites because the window belongs to
 * `Assets`, not to any one consumer — the same reason the blob-parser fix is here. Measured
 * on a live renderer 2026-08-10: `{inCache: true, hasSource: false}` for a texture whose
 * sprite had rendered nothing since the previous frame's despawn.
 *
 * A mid-decode entry is NOT at risk here: Pixi publishes to the cache on resolve, so a
 * present entry has already finished loading — a null source means it was torn down.
 */
function evictSourcelessEntry(url: string): void {
  if (Assets.cache.has(url) && !isPixiTextureLive(url)) Assets.cache.remove(url);
}

// Pixi decodes textures in a Web Worker by default (loadTextures.config.preferWorkers).
// A playable opened from `file://` (Finder double-click on the built ads/index.html —
// exactly what the Build menu's "reveal ads/" step invites) mints `blob:null/…` URLs
// (file:// is a null origin), and the WORKER cannot fetch a null-origin blob →
// "TypeError: Failed to fetch" → the texture never loads (blank game), even though the
// SAME blob fetches fine on the main thread. Over http(s) (an ad container / preview
// tool) workers are fine, so this only matters for the local file:// preview — but
// forcing main-thread decode is harmless (a playable has a handful of textures) and
// makes the double-click "just work". One-shot, set before the first blob texture load.
let workerDisabled = false;
function disablePixiTextureWorker(): void {
  if (workerDisabled) return;
  workerDisabled = true;
  Assets.setPreferences({ preferWorkers: false });
}
