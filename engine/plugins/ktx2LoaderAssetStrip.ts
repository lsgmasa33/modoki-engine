/**
 * Stops three's `KTX2Loader` from emitting a second, hashed copy of the Basis transcoder (#1340).
 *
 * three r185 added module-level defaults to `examples/jsm/loaders/KTX2Loader.js`:
 *
 *   const WASM_BIN_URL = new URL( '../libs/basis/basis_transcoder.wasm', import.meta.url ).toString();
 *   const WASM_JS_URL  = new URL( '../libs/basis/basis_transcoder.js',  import.meta.url ).toString();
 *
 * The bundler turns each `new URL(…, import.meta.url)` into an emitted `assets/basis_transcoder-<hash>.*`
 * file (~585 KB together). The loader reads them only when `transcoderPath === ''`, and the engine's
 * one construction site (`getKTX2Loader` in `runtime/loaders/textureResolver.ts`) always calls
 * `setTranscoderPath(assetUrl('/basis/'))` — the copy `shipTranscoders` (`transcoders.ts`) writes. So the
 * hashed pair is never fetched: dead weight in every web/native build, and in a playable build the
 * stray `.js` trips `inlinePlayable`'s single-chunk guard and fails the export outright.
 *
 * Rewriting the two defaults to `''` removes the emission at its source; the guard stays strict.
 * ⚠️ If a later three changes the expression, a silent no-op would bring the defect back unseen,
 * so the transform THROWS when the file still mentions `import.meta.url` after the rewrite.
 */

import type { Plugin } from 'vite';

/** Also the hook's native `filter`: without one, the bundler calls into JS for EVERY module, which
 *  measured as 29% of a forest-camp build's plugin time. `(?:$|\?)` admits a `?query` suffix. */
const KTX2_LOADER_ID = /[\\/]three[\\/]examples[\\/]jsm[\\/]loaders[\\/]KTX2Loader\.js(?:$|\?)/;

const TRANSCODER_URL = /new URL\(\s*(['"])\.\.\/libs\/basis\/basis_transcoder\.(?:js|wasm)\1\s*,\s*import\.meta\.url\s*\)\.toString\(\)/g;

/** Whether `id` (a resolved module id, possibly with a `?query`) is three's KTX2Loader. */
export function isKtx2LoaderId(id: string): boolean {
  return KTX2_LOADER_ID.test(id);
}

/** Blank the transcoder URL defaults in KTX2Loader's source. Returns `null` when the source has
 *  nothing to rewrite; throws when `import.meta.url` survives the rewrite (an unrecognised shape). */
export function stripKtx2LoaderAssetUrls(code: string): string | null {
  const out = code.replace(TRANSCODER_URL, "''");
  if (out.includes('import.meta.url')) {
    throw new Error(
      '[ktx2-loader-asset-strip] three/examples/jsm/loaders/KTX2Loader.js still references ' +
      '`import.meta.url` after the rewrite — its transcoder-URL expression changed shape. Update ' +
      'TRANSCODER_URL in engine/plugins/ktx2LoaderAssetStrip.ts, or the build ships a dead hashed ' +
      'basis_transcoder pair and every playable export fails (#1340).',
    );
  }
  return out === code ? null : out;
}

export function ktx2LoaderAssetStripPlugin(): Plugin {
  return {
    name: 'modoki-ktx2-loader-asset-strip',
    apply: 'build',
    enforce: 'pre',
    transform: {
      filter: { id: KTX2_LOADER_ID },
      // The id check again, because an ignored filter would hand EVERY module to a rewrite that
      // throws on any `import.meta.url` it does not recognise.
      handler(code, id) {
        if (!isKtx2LoaderId(id)) return null;
        const out = stripKtx2LoaderAssetUrls(code);
        return out === null ? null : { code: out, map: null };
      },
    },
  };
}
