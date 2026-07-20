/** Runtime MSDF glyph generation — the Phase 7 (dynamic path B) counterpart to the
 *  build-time msdf-atlas-gen bake (path A). Thin wrapper over
 *  `@zappar/msdf-generator` (msdfgen compiled to WASM, run in its own module Worker
 *  via comlink), which produces a WHOLE atlas for a given charset in one call.
 *
 *  IMPORTANT — MSDF, not MTSDF: the WASM emits 3-channel MSDF only (no alpha true-SDF
 *  binding). The dynamic provider synthesizes `alpha = median(RGB)` when compositing
 *  glyphs into its atlas (see dynamicFontProvider). msdfgen's own renderer reconstructs
 *  distance as median(rgb), and our shader masks glow/soft-shadow by the median fill
 *  (mtsdfShader/mtsdfPixiShader), so median-alpha is ~equivalent to true mtsdf for our
 *  effects. Baked (path A) glyphs keep real mtsdf.
 *
 *  The lib self-resolves its worker + wasm via `new URL(..., import.meta.url)`; the
 *  engine's vite.config marks `@zappar/msdf-generator` `optimizeDeps.exclude` so those
 *  relative URLs survive (esbuild bundling would break them).
 */

import { MSDF, type MSDFAtlas } from '@zappar/msdf-generator';

export type { MSDFAtlas };

/** Options for a generation batch. `fieldRange` MUST match the baked atlas's
 *  distanceRange so dynamic + baked glyphs share one shader calibration. */
export interface MsdfGenOptions {
  fontSize?: number;         // px/em the field is rendered at (match baked `size`)
  fieldRange?: number;       // distance range in px (match baked `distanceRange`)
  padding?: number;          // px gutter around each glyph in the scratch atlas
  textureSize?: [number, number];
}

let instance: MSDF | null = null;
let initPromise: Promise<MSDF> | null = null;

/** Lazily create + initialize the shared generator (one Worker + WASM for the whole
 *  app). Safe to call concurrently — the init promise is memoized. */
async function getGenerator(): Promise<MSDF> {
  if (instance) return instance;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const msdf = new MSDF();
    await msdf.initialize();
    instance = msdf;
    return msdf;
  })();
  return initPromise;
}

/** Generate an MSDF atlas for `charset` from raw font bytes. Returns the lib's
 *  `MSDFAtlas` (ImageData + per-glyph layout + metrics), which the dynamic provider
 *  then blits (with median-alpha) into its growing canvas. Runs off the main thread. */
export async function generateMsdf(
  font: Uint8Array,
  charset: string,
  opts: MsdfGenOptions = {},
): Promise<MSDFAtlas> {
  const gen = await getGenerator();
  return gen.generateAtlas({
    font,
    charset,
    ...(opts.fontSize != null ? { fontSize: opts.fontSize } : {}),
    ...(opts.fieldRange != null ? { fieldRange: opts.fieldRange } : {}),
    ...(opts.padding != null ? { padding: opts.padding } : {}),
    ...(opts.textureSize ? { textureSize: opts.textureSize } : {}),
  });
}

/** Tear down the shared generator + its Worker. */
export async function disposeMsdfGenerator(): Promise<void> {
  const g = instance;
  instance = null;
  initPromise = null;
  if (g) await g.dispose();
}
