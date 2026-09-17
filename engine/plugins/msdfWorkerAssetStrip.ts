/**
 * Stops `@zappar/msdf-generator` from emitting its RAW worker script (#1356).
 *
 * The lib's constructor falls back to
 *
 *   this.workerUrl = config.workerUrl || new URL("./worker.js", import.meta.url).href;
 *
 * and the bundler turns that `new URL(…, import.meta.url)` into a verbatim copy of `dist/worker.js`
 * — an ASSET, not a bundled worker, so its `import … from "comlink"` survives, and a module Worker
 * cannot resolve a bare specifier. That copy never starts in a browser. The engine now always hands
 * the lib a Vite-bundled `workerUrl` (`workerUrl()` in `runtime/rendering/text/msdfGenerate.ts`), so
 * the raw copy is dead weight at best, and a silently broken fallback at worst.
 *
 * The rewrite replaces the fallback with a THROW: a build that somehow reaches it fails at
 * construction, loudly, instead of starting a worker that errors and waiting out the init timeout.
 * ⚠️ If a later version changes the expression, a silent no-op would bring the raw copy back unseen,
 * so the transform THROWS when the file still mentions `import.meta.url` after the rewrite — the
 * same contract as `ktx2LoaderAssetStrip.ts` (#1340).
 */

import type { Plugin } from 'vite';

/** Also the hook's native `filter` — see ktx2LoaderAssetStrip.ts for why one is needed.
 *  `(?:$|\?)` admits a `?query` suffix. */
const MSDF_ENTRY_ID = /[\\/]@zappar[\\/]msdf-generator[\\/]dist[\\/]index\.js(?:$|\?)/;

const WORKER_URL = /new URL\(\s*(['"])\.\/worker\.js\1\s*,\s*import\.meta\.url\s*\)\.href/g;

const FALLBACK_THROW =
  '(() => { throw new Error("[msdf-generator] no workerUrl was given, and the lib\'s own worker.js is not ' +
  'shipped: it is an unbundled copy that cannot start (#1356). Pass the Vite-bundled URL (msdfGenerate.ts workerUrl()).") })()';

/** Whether `id` (a resolved module id, possibly with a `?query`) is the msdf-generator entry. */
export function isMsdfGeneratorEntryId(id: string): boolean {
  return MSDF_ENTRY_ID.test(id);
}

/** Replace the lib's own worker-URL fallback with a throw. Returns `null` when the source has
 *  nothing to rewrite; throws when `import.meta.url` survives the rewrite (an unrecognised shape). */
export function stripMsdfWorkerAssetUrl(code: string): string | null {
  const out = code.replace(WORKER_URL, FALLBACK_THROW);
  if (out.includes('import.meta.url')) {
    throw new Error(
      '[msdf-worker-asset-strip] @zappar/msdf-generator/dist/index.js still references ' +
      '`import.meta.url` after the rewrite — its worker-URL expression changed shape. Update ' +
      'WORKER_URL in engine/plugins/msdfWorkerAssetStrip.ts, or the build ships an unbundled ' +
      'worker that cannot start (#1356).',
    );
  }
  return out === code ? null : out;
}

export function msdfWorkerAssetStripPlugin(): Plugin {
  return {
    name: 'modoki-msdf-worker-asset-strip',
    apply: 'build',
    enforce: 'pre',
    transform: {
      filter: { id: MSDF_ENTRY_ID },
      // The id check again, because an ignored filter would hand EVERY module to a rewrite that
      // throws on any `import.meta.url` it does not recognise.
      handler(code, id) {
        if (!isMsdfGeneratorEntryId(id)) return null;
        const out = stripMsdfWorkerAssetUrl(code);
        return out === null ? null : { code: out, map: null };
      },
    },
  };
}
