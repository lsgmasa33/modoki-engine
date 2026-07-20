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
  if (url.startsWith('blob:')) {
    disablePixiTextureWorker();
    return Assets.load<Texture>({ src: url, parser: 'texture' });
  }
  return Assets.load<Texture>(url);
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
