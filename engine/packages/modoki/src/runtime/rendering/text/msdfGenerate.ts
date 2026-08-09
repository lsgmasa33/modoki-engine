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
 *  relative URLs survive (esbuild bundling would break them). The WASM half of that
 *  self-resolution does NOT survive a game build — see {@link wasmUrl} — so we hand the
 *  worker an explicit URL instead of trusting it.
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

/** Serializes every generation against the shared worker. **Load-bearing — this is a
 *  correctness lock, not a throttle.**
 *
 *  The worker holds exactly ONE loaded font (`MSDFGeneratorWorker.generator.font`), and the
 *  library's `generateAtlas` is TWO separate awaited round-trips over comlink:
 *
 *      await client.loadFont(options.font);      // sets the worker's single this.font
 *      return await client.generateAtlas(...);   // rasterizes whatever this.font now is
 *
 *  Two fonts generating concurrently interleave as loadFont(A) · loadFont(B) ·
 *  generateAtlas(A) · generateAtlas(B) — and A's atlas comes back drawn from B's OUTLINES.
 *  Nothing errors: the glyphs are real, the advances are real, they are just the wrong
 *  typeface, so the text renders in the other font's weight.
 *
 *  A scene with two `mode:'dynamic'` fonts hits this at LOAD, because `acquireFont` seeds
 *  them in parallel — which is why it presented as an intermittent cold-start bug that
 *  "healed" after a re-import (a lone re-acquire cannot race). Measured live in text_demo:
 *  the Geologica-Bold-700 provider came back with H advance 0.698 and ascender 1.16 —
 *  NotoSansJP's metrics, not Geologica's 0.773 / 0.975. It cost an entire session chasing
 *  a weight bug, because every check of the SERVED bytes was correct; the swap is inside
 *  the generator, past everything a fetch can see.
 *
 *  `DynamicFontProvider.flush()`'s `generating` flag does NOT cover this — it is per
 *  provider, and the race is BETWEEN providers. */
let genQueue: Promise<unknown> = Promise.resolve();

/** How long the worker gets to come up, and to answer one generation.
 *
 *  ⚠️ These are not politeness — they are what stops a missing asset from bricking the
 *  app. `initialize()` is a comlink round-trip to a module Worker: if the worker cannot
 *  load (its script or its wasm 404s), the reply never arrives and the promise NEVER
 *  SETTLES — it does not reject. Fonts are awaited SCENE RESOURCES, so that hang
 *  propagated all the way up and the game sat on its splash screen forever, with no
 *  error anywhere. A font that cannot load must degrade to no text, never to no boot. */
const INIT_TIMEOUT_MS = 10_000;
const GENERATE_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`[msdfGenerate] ${what} timed out after ${ms}ms — the MSDF worker is unreachable (missing worker script or wasm?)`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** The wasm binary's URL, resolved through the BUNDLER rather than by the worker.
 *
 *  ⚠️ The worker's own fallback is `new URL("msdfgen_wasm.wasm", import.meta.url)` buried
 *  inside a ternary in the emscripten glue, which Vite's static analysis does not match —
 *  so the worker chunk shipped and the wasm beside it did NOT. Measured on a Court iOS
 *  build: `assets/worker-*.js` present, no `msdfgen_wasm.wasm` anywhere in the bundle.
 *  Dev never showed it (the dev server serves the file straight out of node_modules).
 *
 *  A `?url` import is the specifier Vite DOES see, so the asset is emitted and hashed like
 *  any other; `initialize(url)` feeds it to the module's `locateFile`. Resolved lazily and
 *  defensively: the PLAYABLE build aliases this package to a stub (playables use pre-baked
 *  atlases and cannot afford a 1.5 MB wasm against the 5 MB cap), so the import may resolve
 *  to something that is not a URL — in which case we pass nothing and leave the worker's
 *  own resolution in charge, exactly as before. */
async function wasmUrl(): Promise<string | undefined> {
  let m: { default?: unknown } | null = null;
  try {
    // The package's EXPORTED subpath name. Not `dist/…`: only this config's alias knows the
    // dist layout, and the engine package's own vitest project has no aliases — `dist/` is
    // blocked there by the package `exports` map and failed to collect 114 test files.
    m = await import('@zappar/msdf-generator/msdfgen_wasm.wasm?url');
  } catch { /* reported below */ }
  if (typeof m?.default === 'string') return m.default;
  // ⚠️ LOUD, never silent. The first attempt at this fix resolved to the wrong path (the
  // package-dir alias rewrote the subpath to <pkg>/msdfgen_wasm.wasm, while the file is at
  // <pkg>/dist/), and a bare `catch { return undefined }` hid it completely: the build
  // emitted no wasm, the fix looked applied, and the bug was untouched. If this ever falls
  // back again, the log says so before the worker fails.
  console.warn('[msdfGenerate] could not resolve the msdfgen wasm URL through the bundler — falling back to the worker\'s own resolution, which does NOT survive a production build. Dynamic fonts may fail to load.');
  return undefined;
}

/** Lazily create + initialize the shared generator (one Worker + WASM for the whole
 *  app). Safe to call concurrently — the init promise is memoized, INCLUDING a rejection:
 *  once the worker has failed to come up, every later call fails fast instead of paying
 *  the timeout again (N fonts × 10s of blank text is not a better failure). */
async function getGenerator(): Promise<MSDF> {
  if (instance) return instance;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const url = await wasmUrl();
    const msdf = new MSDF(url ? { wasmUrl: url } : {});
    await withTimeout(msdf.initialize(), INIT_TIMEOUT_MS, 'worker init');
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
  // Queued, never concurrent — see genQueue. The whole call must be inside the lock:
  // the font-swap window is between the library's own loadFont and generateAtlas, so
  // locking either one alone would still let another font in.
  const run = genQueue.then(async () => {
    const gen = await getGenerator();
    // Bounded too, not just init: a worker that dies MID-call leaves the comlink reply
    // outstanding forever, and because every generation is queued behind this one, a
    // single hang would wedge the queue for every font in the app.
    return withTimeout(gen.generateAtlas({
      font,
      charset,
      ...(opts.fontSize != null ? { fontSize: opts.fontSize } : {}),
      ...(opts.fieldRange != null ? { fieldRange: opts.fieldRange } : {}),
      ...(opts.padding != null ? { padding: opts.padding } : {}),
      ...(opts.textureSize ? { textureSize: opts.textureSize } : {}),
    }), GENERATE_TIMEOUT_MS, `generation of ${charset.length} glyph(s)`);
  });
  // Swallow on the CHAIN only (never on the returned promise): one failed generation
  // must not reject every generation queued behind it, nor leave the chain rejected.
  genQueue = run.catch(() => {});
  return run;
}

/** Tear down the shared generator + its Worker. Queued behind any in-flight generation:
 *  terminating the worker mid-call would reject a batch that was about to succeed. */
export async function disposeMsdfGenerator(): Promise<void> {
  const done = genQueue.then(async () => {
    const g = instance;
    instance = null;
    initPromise = null;
    if (g) await g.dispose();
  });
  genQueue = done.catch(() => {});
  return done;
}
