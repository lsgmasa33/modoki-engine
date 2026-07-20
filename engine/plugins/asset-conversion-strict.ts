/** Strict asset-conversion gate for the production build.
 *
 *  During `vite build` the asset-scanner converts every kept texture/model into
 *  its optimized variant (KTX2/WebP, processed/LOD GLB). When an individual
 *  asset's conversion FAILS — a missing encoder CLI (`toktx`, `gltf-transform`,
 *  `gltfpack`), a converter crash — the build historically logged a warning,
 *  shipped the RAW source instead, and still exited 0. That lets a misconfigured
 *  environment (CI box without the encoders) produce a "successful" build that
 *  silently ships unoptimized PNGs/GLBs.
 *
 *  This gate makes such a fallback fail the build by default. The raw source is
 *  still copied into `dist/` (so an explicitly-allowed build still loads the
 *  asset), but unless `MODOKI_ALLOW_ASSET_FALLBACK=1` is set the build aborts
 *  with an aggregated error naming every asset that fell back. */

export interface ConversionFailure {
  /** The asset's URL/virtual path (e.g. `/assets/models/x.glb`). */
  virtualPath: string;
  kind: 'texture' | 'rigged model' | 'model' | 'atlas' | 'audio' | 'font' | 'environment';
  /** The converter's error message. */
  error: string;
}

/** Throw when any asset fell back to raw source during the build, unless the
 *  fallback was explicitly allowed. Aggregates so one build run surfaces every
 *  failure at once. No-op when there are no failures or when allowed. */
export function assertNoConversionFallback(
  failures: ConversionFailure[],
  opts: { allowFallback: boolean },
): void {
  if (failures.length === 0 || opts.allowFallback) return;
  const lines = failures
    .map((f) => `  - ${f.kind}: ${f.virtualPath} — ${f.error}`)
    .join('\n');
  throw new Error(
    `[asset-shaker] ${failures.length} asset(s) could not be processed and fell back to raw source:\n${lines}\n` +
      `Production must not ship unoptimized assets. Install the required encoders ` +
      `(toktx for KTX2; gltf-transform + gltfpack for model LODs) and rebuild, or set ` +
      `MODOKI_ALLOW_ASSET_FALLBACK=1 to ship the raw source intentionally.`,
  );
}
