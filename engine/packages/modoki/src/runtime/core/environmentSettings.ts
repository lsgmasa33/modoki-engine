/** Environment (HDR) import settings — the single source of truth shared by the
 *  editor Environment Inspector, the dev-server conversion service, the build
 *  tree-shaker, and the runtime environment resolver. Mirrors `textureSettings.ts`.
 *
 *  Settings live in an HDR's `.meta.json` sidecar (`environment` block) and are
 *  baked into the asset manifest so the runtime picks the converted variant without
 *  an extra per-file fetch. The conversion service downscales the source Radiance
 *  `.hdr` (huge — 2K is ~6 MB) to `maxSize` and re-encodes a smaller `.hdr`,
 *  served/copied at the `~env.hdr` variant URL (mirrors the texture-variant scheme).
 *
 *  Two formats ship: `hdr` (downscaled Radiance, Node-generated) and `ultrahdr`
 *  (UltraHDR gainmap JPEG, browser-encoded in the editor). A compressed KTX2 ASTC-HDR
 *  format is a future `format` value behind the same seams. */

/** Output format.
 *  - `hdr` = downscaled Radiance HDR (universal, Node-generated, decodes via HDRLoader).
 *  - `ultrahdr` = UltraHDR gainmap JPEG (~10× smaller, universal device support —
 *    JPEG-based, HDR gain applied in-shader). Encoded BROWSER-SIDE in the editor
 *    (@monogrid/gainmap-js needs WebGL), so its `~ultrahdr.jpg` variant is COMMITTED
 *    next to the source (the Node build can't regenerate it); decodes via three's
 *    UltraHDRLoader. */
export type EnvFormat = 'hdr' | 'ultrahdr';

/** Longest-edge cap for the equirect HDR; downscaled (never upscaled) to fit. */
export type EnvMaxSize = 256 | 512 | 1024 | 2048 | 4096;

export interface EnvImportSettings {
  format: EnvFormat;
  /** Longest-edge cap in px; the source is downscaled to fit (never upscaled). */
  maxSize: EnvMaxSize;
}

export const DEFAULT_ENV_SETTINGS: EnvImportSettings = {
  format: 'hdr',
  // 1024: a 2K equirect env (~6 MB) → 1K is ~4× smaller and, since the env feeds a
  // blurred PMREM irradiance/prefilter, the detail loss is largely invisible. Drop to
  // 512 for a pure lighting env, or raise to 2048 to keep a sharp visible background.
  maxSize: 1024,
};

export const ENV_MAX_SIZES: EnvMaxSize[] = [256, 512, 1024, 2048, 4096];

/** Variant-URL suffix for the `hdr` (downscaled Radiance) format — the Node-generated,
 *  cache-served variant (mirrors `variantSuffix` for textures), e.g. `studio.hdr` + `~env.hdr`. */
export const ENV_VARIANT_SUFFIX = '~env.hdr';
/** Variant-URL suffix for the `ultrahdr` (gainmap JPEG) format — a COMMITTED file
 *  next to the source (browser-encoded), e.g. `studio.hdr` + `~ultrahdr.jpg`. */
export const ULTRAHDR_VARIANT_SUFFIX = '~ultrahdr.jpg';

/** The variant suffix for a given output format. */
export function envVariantSuffix(format: EnvFormat): string {
  return format === 'ultrahdr' ? ULTRAHDR_VARIANT_SUFFIX : ENV_VARIANT_SUFFIX;
}

/** Approximate environment-intensity compensation applied to an `ultrahdr` env at
 *  render time. UltraHDR is a display-referred gainmap (SDR base + bounded gain), so
 *  its reconstructed radiance under-drives image-based lighting → the scene reads
 *  dimmer than the scene-linear `hdr`. This multiplier claws most of that back; it
 *  won't perfectly match (the format can't), and the user's own `Environment.intensity`
 *  still scales on top. Only applied when the env's manifest format is `ultrahdr`. */
export const ULTRAHDR_INTENSITY_BOOST = 1.5;

export function envVariantUrl(sourcePath: string, format: EnvFormat = 'hdr'): string {
  return sourcePath + envVariantSuffix(format);
}

/** Cache bookkeeping persisted in the HDR's meta sidecar (`environmentCache`).
 *  `hash` keys the content cache (source bytes + settings + encoder version); the
 *  rest are post-conversion stats surfaced in the inspector. */
export interface EnvCacheInfo {
  hash: string;
  /** Post-conversion (downscaled) pixel dimensions. */
  width?: number;
  height?: number;
  /** Original source pixel dimensions (pre-downscale). */
  srcWidth?: number;
  srcHeight?: number;
  /** On-disk byte size of the converted `~env.hdr` variant. */
  bytes?: number;
}

/** The environment block baked onto an asset-manifest entry (`AssetEntry.environment`)
 *  at scan/build time. Carries the settings the resolver needs to pick the variant. */
export interface EnvManifestBlock {
  format?: EnvFormat;
  maxSize?: EnvMaxSize;
}

/** Merge persisted settings over the defaults. Tolerates a missing/partial
 *  `environment` block (an HDR that hasn't been through the importer → defaults). */
export function resolveEnvSettings(
  meta: { environment?: Partial<EnvImportSettings> } | null | undefined,
): EnvImportSettings {
  return { ...DEFAULT_ENV_SETTINGS, ...(meta?.environment ?? {}) };
}
