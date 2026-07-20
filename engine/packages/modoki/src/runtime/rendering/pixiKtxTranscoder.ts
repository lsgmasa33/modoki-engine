/** Register PixiJS's KTX2 load parser and point its transcoder at a LOCALLY-served
 *  libktx instead of the default jsdelivr CDN. This is what lets 2D `.ktx2`
 *  sprites/atlas-pages decode offline (and in the packaged Electron editor, which
 *  has no network guarantee).
 *
 *  NOTE: `pixi.js` v8 does NOT auto-register `loadKTX2` — importing the umbrella
 *  leaves the loader parsers at [loadTextures, …] with no `.ktx2` support, so
 *  `Assets.load('…~uastc.ktx2')` fails with "we don't know how to parse it". We add
 *  it explicitly here (idempotent; `extensions.add` de-dupes).
 *
 *  The `/pixi-ktx/{libktx.js,libktx.wasm}` URL is served in dev by the backend
 *  static-asset handler (`staticAssets.ts`) and copied into `dist/` at build time
 *  (`shipPixiKtxTranscoder` in `vite-asset-scanner.ts`) — mirroring how the
 *  three.js Basis transcoder is provided at `/basis/` for the 3D KTX2 path.
 *
 *  `setKTXTranscoderPath` is a plain `Object.assign` into a module singleton, so
 *  calling it more than once is harmless; the guard just avoids redundant work. */

import { setKTXTranscoderPath, loadKTX2, extensions } from 'pixi.js';
import { assetUrl } from '../loaders/assetUrl';

let configured = false;

/** Idempotently register the KTX2 load parser and redirect PixiJS's KTX2 transcoder
 *  to the locally-served libktx. Call once during 2D startup, before the first KTX2
 *  sprite loads. */
export function ensurePixiKtxTranscoder(): void {
  if (configured) return;
  configured = true;
  extensions.add(loadKTX2); // v8 does NOT auto-register this — without it .ktx2 sprites can't parse
  setKTXTranscoderPath({
    jsUrl: assetUrl('/pixi-ktx/libktx.js'),
    wasmUrl: assetUrl('/pixi-ktx/libktx.wasm'),
  });
}
