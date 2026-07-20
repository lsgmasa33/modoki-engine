/** Texture import settings — the single source of truth shared by the editor
 *  Texture Inspector, the dev-server conversion service, the build tree-shaker,
 *  and the runtime texture resolver.
 *
 *  Settings live in a texture's `.meta.json` sidecar (`texture` block) and are
 *  baked into the asset manifest so the runtime can read them without an extra
 *  per-texture fetch. The conversion service turns one source PNG into a small
 *  set of derived `variants` (see {@link variantsForFormat}); the runtime picks
 *  one per call site via {@link selectVariant}.
 */

export type TextureFormat = 'ktx2-uastc' | 'ktx2-etc1s' | 'ktx2-astc' | 'webp' | 'png';
export type TextureWrap = 'repeat' | 'clamp' | 'mirror';
export type TextureColorspace = 'srgb' | 'linear';
export type TextureMaxSize = 256 | 512 | 1024 | 2048 | 4096;

/** The authored *purpose* of a texture — the altitude an artist actually thinks
 *  at. Drives the codec/mipmap/wrap defaults (see {@link deriveSettingsForType}),
 *  whether a whole-image sprite is auto-created (2d/ui only), and reference
 *  type-checking (a 2D field rejects a `3d` texture). One type per texture. */
export type TextureType = '3d' | '2d' | 'ui';

export interface TextureImportSettings {
  /** Output format. Default `ktx2-uastc` (UASTC+RDO+Zstd) — high quality, cheap
   *  transcode to ASTC/BC7. `ktx2-astc` is the native, zero-transcode override. */
  format: TextureFormat;
  /** Longest-edge cap; the source is downscaled (never upscaled) to fit. */
  maxSize: TextureMaxSize;
  mipmaps: boolean;
  wrapS: TextureWrap;
  wrapT: TextureWrap;
  /** `srgb` = color map; `linear` = data/normal map (no gamma). */
  colorspace: TextureColorspace;
  /** Bake a vertical flip into every derived variant at convert time. Needed
   *  because `Texture.flipY` is IGNORED for block-compressed KTX2 (can't flip
   *  compressed data on the CPU) — so orientation must be baked here, not set at
   *  runtime. Applies to KTX2/WebP/PNG alike. Default false. */
  flipY?: boolean;
  /** Invert the green channel (tangent-space Y). Pair with {@link flipY} on a
   *  NORMAL map — flipping the image spatially also flips its encoded Y — or use
   *  alone to switch a normal map between OpenGL (+Y up) and DirectX (−Y) convention.
   *  No-op / harmless on color maps. Default false. */
  flipGreen?: boolean;
  /** WebP encode quality (1–100) for the WebP variant/sibling. Higher = larger,
   *  crisper. Only affects a texture that emits a WebP file (a `webp` format, or a
   *  2d/ui KTX2 texture's browser sibling). Default 80. */
  webpQuality?: number;
  /** UASTC encode quality level (0–4) for the `uastc` variant (`ktx2-uastc`, and
   *  the universal sibling of `ktx2-astc`). Higher = better quality, slower encode.
   *  Default 2. */
  uastcLevel?: number;
  /** UASTC RDO lambda for the `uastc` variant — rate-distortion tradeoff feeding
   *  `--uastc_rdo_l`. Higher = smaller (Zstd compresses better) at some quality cost;
   *  0 disables RDO. Default 1.0. */
  uastcRdoLambda?: number;
}

export const DEFAULT_TEXTURE_SETTINGS: TextureImportSettings = {
  format: 'ktx2-uastc',
  maxSize: 2048,
  mipmaps: true,
  wrapS: 'repeat',
  wrapT: 'repeat',
  colorspace: 'srgb',
};

export const TEXTURE_MAX_SIZES: TextureMaxSize[] = [256, 512, 1024, 2048, 4096];

/** Default WebP encode quality when {@link TextureImportSettings.webpQuality} is unset. */
export const DEFAULT_WEBP_QUALITY = 80;

/** Clamp a WebP quality to the valid 1–100 range (falls back to the default when
 *  undefined/NaN). Shared by the converter and the inspector control. */
export function resolveWebpQuality(q: number | undefined): number {
  if (q === undefined || Number.isNaN(q)) return DEFAULT_WEBP_QUALITY;
  return Math.max(1, Math.min(100, Math.round(q)));
}

/** UASTC encoder defaults (toktx `--uastc <level>` + `--uastc_rdo_l <lambda>`). */
export const DEFAULT_UASTC_LEVEL = 2;
export const DEFAULT_UASTC_RDO_LAMBDA = 1.0;
export const UASTC_LEVELS = [0, 1, 2, 3, 4];

/** Clamp a UASTC level to 0–4 (default when undefined/NaN). */
export function resolveUastcLevel(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return DEFAULT_UASTC_LEVEL;
  return Math.max(0, Math.min(4, Math.round(v)));
}

/** Clamp a UASTC RDO lambda to a sane 0–4 range (default when undefined/NaN; 0 = off). */
export function resolveUastcRdoLambda(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return DEFAULT_UASTC_RDO_LAMBDA;
  return Math.max(0, Math.min(4, v));
}

/** Codec/mipmap/wrap defaults derived from a texture's authored {@link TextureType}.
 *  `type` is the source of truth an artist edits; the returned `TextureImportSettings`
 *  is what the conversion + cache layers consume (so those stay type-agnostic).
 *  Explicit per-field `overrides` win — that's how the inspector's Advanced section
 *  and the 2D WebP-vs-KTX2 toggle are expressed.
 *   - `3d`  KTX2-UASTC, mipmapped, repeat wrap (tiled 3D surfaces, trilinear filter).
 *   - `2d`  KTX2-UASTC (WebP override for crisp/alpha art), no mips, clamp (sprites
 *           drawn ~1:1; mips cross-bleed in atlas pages).
 *   - `ui`  WebP, no mips, clamp — CSS/DOM can't decode KTX2, so UI stays WebP. */
export function deriveSettingsForType(
  type: TextureType,
  overrides?: Partial<TextureImportSettings>,
): TextureImportSettings {
  const base: TextureImportSettings =
    type === '3d'
      ? { format: 'ktx2-uastc', maxSize: 2048, mipmaps: true, wrapS: 'repeat', wrapT: 'repeat', colorspace: 'srgb' }
      : type === '2d'
        ? { format: 'ktx2-uastc', maxSize: 2048, mipmaps: false, wrapS: 'clamp', wrapT: 'clamp', colorspace: 'srgb' }
        : { format: 'webp', maxSize: 2048, mipmaps: false, wrapS: 'clamp', wrapT: 'clamp', colorspace: 'srgb' };
  return { ...base, ...(overrides ?? {}) };
}

/** The authored type of a texture: explicit `meta.type` when present, else inferred
 *  from the codec for LEGACY textures (pre-type-system) so the scanner/validation
 *  have a usable answer before the one-shot migration stamps explicit types — a
 *  `ktx2-*` format is a 3D texture, `webp`/`png` a 2D one. `ui` is never inferred
 *  (indistinguishable from `2d` by codec); UI textures are always explicitly typed. */
export function resolveTextureType(
  meta: { type?: TextureType; texture?: Partial<TextureImportSettings> } | null | undefined,
): TextureType {
  if (meta?.type) return meta.type;
  const fmt = meta?.texture?.format;
  return fmt === 'webp' || fmt === 'png' ? '2d' : '3d';
}

/** A derived output file produced by the converter. */
export type TextureVariant = 'uastc' | 'etc1s' | 'astc' | 'webp' | 'png';

/** Cache bookkeeping persisted in the texture's meta sidecar. `hash` keys the
 *  content cache (source bytes + settings + encoder version); `variants` lists
 *  which derived files were produced (used for dev-serving, build copy, cleanup).
 *  The remaining fields are post-conversion stats surfaced in the inspector. */
export interface TextureCacheInfo {
  hash: string;
  variants: TextureVariant[];
  /** Post-conversion pixel dimensions (the resized, multiple-of-4 size shared by
   *  all variants — read from the produced KTX2 header when present). */
  width?: number;
  height?: number;
  /** Original source pixel dims (pre-resize/snap). The auto whole-image sprite's
   *  rect uses these (it carves from the SOURCE file, not the converted variant). */
  srcWidth?: number;
  srcHeight?: number;
  /** Mip levels baked into the KTX2 variant (1 when mipmaps are off or the format
   *  produces no KTX2). */
  mipLevels?: number;
  /** On-disk byte size of each produced variant file. */
  variantBytes?: Partial<Record<TextureVariant, number>>;
}

/** Merge persisted settings over the defaults. Tolerates a missing/partial
 *  `texture` block (legacy textures with no import settings → all defaults). */
export function resolveTextureSettings(
  meta: { type?: TextureType; texture?: Partial<TextureImportSettings> } | null | undefined,
): TextureImportSettings {
  // A typed texture derives its codec from the type, with the persisted `texture`
  // block as explicit overrides (a fully-populated block simply wins — that's how
  // the inspector persists derived-or-overridden settings). Legacy textures with
  // no `type` fall back to defaults-merged-over-persisted, unchanged.
  if (meta?.type) return deriveSettingsForType(meta.type, meta.texture);
  return { ...DEFAULT_TEXTURE_SETTINGS, ...(meta?.texture ?? {}) };
}

/** Which derived files a given format produces. The format declares the target:
 *  `ktx2-*` are 3D (GPU-compressed) formats and emit only KTX2 — native ASTC also
 *  emits a universal UASTC sibling for GPUs without ASTC support. `webp`/`png` are
 *  the 2D/UI formats (browser-decodable for DOM/Canvas/PixiJS). A texture used in
 *  both 2D and 3D should be imported in each form (or use a 2D format, which 3D
 *  can still load uncompressed). */
export function variantsForFormat(format: TextureFormat): TextureVariant[] {
  switch (format) {
    case 'ktx2-uastc': return ['uastc'];
    case 'ktx2-etc1s': return ['etc1s'];
    case 'ktx2-astc': return ['astc', 'uastc'];
    case 'webp': return ['webp'];
    case 'png': return ['png'];
  }
}

export function variantExtension(v: TextureVariant): 'ktx2' | 'webp' | 'png' {
  return v === 'webp' ? 'webp' : v === 'png' ? 'png' : 'ktx2';
}

/** The FULL set of derived files to emit for a texture, given its authored TYPE — its
 *  GPU variant(s) from {@link variantsForFormat}, PLUS a WebP **browser sibling** for a
 *  `2d`/`ui` texture whose GPU format is KTX2 (which otherwise emits no browser-decodable
 *  file). The runtime (PixiJS 2D / Three.js 3D) loads the KTX2; the editor's Canvas2D 2D
 *  preview + DOM UI images load the WebP. A `3d` texture never needs the sibling — Three's
 *  KTX2Loader decodes KTX2 in the editor too, so it's the same path as the runtime. */
export function variantsToEmit(format: TextureFormat, type: TextureType): TextureVariant[] {
  const base = variantsForFormat(format);
  const hasBrowserVariant = base.some((v) => v === 'webp' || v === 'png');
  if (!hasBrowserVariant && (type === '2d' || type === 'ui')) return [...base, 'webp'];
  return base;
}

/** The browser-decodable variant (WebP/PNG) a texture exposes for DOM/Canvas2D, or null
 *  when none is emitted (a `3d`-typed texture — Three.js decodes its KTX2 directly).
 *  Mirrors {@link variantsToEmit} exactly, so the runtime resolver and the build emitter
 *  never disagree about whether a WebP sibling exists. `type` is inferred from the format
 *  when omitted (legacy textures: `ktx2-*` ⇒ 3d ⇒ null). */
export function browserVariant(format: TextureFormat, type?: TextureType): TextureVariant | null {
  const t = type ?? resolveTextureType({ texture: { format } });
  const emitted = variantsToEmit(format, t);
  return emitted.includes('webp') ? 'webp' : emitted.includes('png') ? 'png' : null;
}

/** Suffix appended to the source path to form the deterministic served URL,
 *  e.g. `rock.png` + `~uastc.ktx2`. Dev server and production build both serve
 *  the variant at this URL, so the runtime computes it without reading the hash. */
export function variantSuffix(v: TextureVariant): string {
  return `~${v}.${variantExtension(v)}`;
}

/** Pick the best variant for a call site given GPU capabilities. Pure +
 *  testable — the runtime resolver supplies live caps from the KTX2Loader.
 *
 *  Both usages can now serve KTX2: the 3D (Three.js) and 2D (PixiJS) paths each
 *  register a KTX2/Basis loader that transcodes the UNIVERSAL variants
 *  (`uastc`/`etc1s`) to the GPU's format. 2D deliberately prefers the universal
 *  sibling over native `astc` — PixiJS's own GPU-format detection drives the
 *  transcode, so we hand it the transcodable variant rather than depend on the
 *  Three-side `caps.astc`. `webp`/`png` stay browser-decodable for 2D/UI/DOM.
 *  Never returns null (every format now produces a variant for both usages). */
export function selectVariant(
  settings: TextureImportSettings,
  usage: '2d' | '3d',
  caps: { astc: boolean },
): TextureVariant {
  if (usage === '2d') {
    switch (settings.format) {
      case 'png': return 'png';
      case 'webp': return 'webp';
      case 'ktx2-etc1s': return 'etc1s';
      case 'ktx2-uastc': return 'uastc';
      case 'ktx2-astc': return 'uastc'; // universal sibling — PixiJS transcodes
    }
  }
  switch (settings.format) {
    case 'ktx2-astc': return caps.astc ? 'astc' : 'uastc';
    case 'ktx2-uastc': return 'uastc';
    case 'ktx2-etc1s': return 'etc1s';
    case 'webp': return 'webp';
    case 'png': return 'png';
  }
}
