/** Font import settings — the single source of truth shared by the editor Font
 *  Inspector, the dev-server msdf-atlas-gen conversion service, the build, and the
 *  runtime font loader.
 *
 *  Settings live in a font's `.meta.json` sidecar (`font` block) and are baked
 *  into the asset manifest (`FontManifestBlock`) so the runtime can pick the
 *  provider without an extra per-font fetch. The conversion service turns one
 *  source `.ttf`/`.otf` into two derived files — an mtsdf atlas PNG + a Chlumsky
 *  JSON metrics layout — served/copied at the `~atlas.png` / `~metrics.json`
 *  variant URLs alongside the source (mirrors the texture-variant convention).
 */

export type FontFieldType = 'msdf' | 'mtsdf';
/** `baked` = the fixed atlas is the whole font (miss ⇒ tofu box). `dynamic` = the
 *  baked atlas SEEDS a runtime MSDF generator that fills in unseen glyphs on
 *  demand (arbitrary Unicode / CJK). Same atlas format either way. */
export type FontMode = 'baked' | 'dynamic';

/** Built-in charset presets (plus `custom`, which uses `customChars`). */
export type FontCharsetPreset = 'ascii' | 'latin1' | 'custom';

export interface FontImportSettings {
  /** Distance-field type. `mtsdf` (4-channel: RGB median fill + alpha true-SDF)
   *  gives clean soft glow/outline; the default everywhere. */
  fieldType: FontFieldType;
  /** Glyph em size in px — the atlas resolution per em. Higher = crisper at large
   *  scale, bigger atlas. 48 is a good default for UI/label text. */
  size: number;
  /** Distance range in px baked into the field — feeds the shader's `screenPxRange`.
   *  Larger = wider AA band + room for thicker outlines/softer glow. 4 is safe. */
  pxRange: number;
  /** Which characters to bake. Presets expand to Unicode ranges; `custom` uses
   *  `customChars`. Dynamic fonts still bake this set as the synchronous fast path. */
  charset: FontCharsetPreset;
  /** Literal characters to bake when `charset === 'custom'`. */
  customChars?: string;
  /** Max atlas page dimension in px. Baked atlases auto-size below this; dynamic
   *  runtime pages allocate at this size. */
  atlasMax: number;
  /** How glyphs are sourced at runtime (baked-only vs baked-seeded dynamic gen). */
  mode: FontMode;
}

export const DEFAULT_FONT_SETTINGS: FontImportSettings = {
  fieldType: 'mtsdf',
  // 128, not 64/48: at pxRange 8 a lower-res field under-resolves SHARP concave
  // corners (the M/W/A/V inner vertices) — the median-clash leaves dark nicks that
  // bite into the fill, amplified by an outline. size/pxRange ratio is the lever:
  // 8/128 ≈ 0.06 resolves those corners cleanly (8/64 ≈ 0.125 did not). SDF text is
  // meant to be shown LARGE (scalable labels) where the nicks are most visible, so
  // pay the atlas cost by default (ASCII @128 = 1024², ~340KB). Drop to 64 per-font
  // in the Font Inspector for small/body UI where the extra resolution is wasted.
  size: 128,
  // 8, not the usual 4: mtsdf means we WANT room for outline/glow, and the SDF's
  // representable distance (± pxRange/2 at atlas scale) caps how thick an outline
  // or how wide a glow can be. 4 is fine for plain fill but starves the effects.
  pxRange: 8,
  charset: 'ascii',
  // 2048 headroom so a bigger charset at size 128 isn't force-downscaled (ASCII
  // still packs into 1024²; the packer uses only what it needs).
  atlasMax: 2048,
  mode: 'baked',
};

/** Cache bookkeeping persisted in the font's meta sidecar (`fontCache` block).
 *  `hash` keys the content cache (source bytes + settings + encoder version). The
 *  rest are post-conversion stats surfaced in the inspector + baked into the
 *  manifest so the loader/shader know the atlas geometry without a fetch. */
export interface FontCacheInfo {
  hash: string;
  atlasWidth?: number;
  atlasHeight?: number;
  /** Number of glyphs baked into the atlas. */
  glyphCount?: number;
  /** On-disk byte size of the atlas PNG. */
  bytes?: number;
}

/** Merge persisted settings over the defaults. Tolerates a missing/partial
 *  `font` block (a font that hasn't been through the importer → all defaults). */
export function resolveFontSettings(
  meta: { font?: Partial<FontImportSettings> } | null | undefined,
): FontImportSettings {
  return { ...DEFAULT_FONT_SETTINGS, ...(meta?.font ?? {}) };
}

/** Expand a charset selection to the literal string of characters to bake. Pure +
 *  testable; the conversion service formats this into an msdf-atlas-gen charset
 *  file. `ascii` = printable ASCII (0x20–0x7E); `latin1` adds the Latin-1
 *  supplement (0xA0–0xFF); `custom` returns the authored `customChars` verbatim. */
export function expandCharset(settings: Pick<FontImportSettings, 'charset' | 'customChars'>): string {
  if (settings.charset === 'custom') return settings.customChars ?? '';
  let out = '';
  for (let c = 0x20; c <= 0x7e; c++) out += String.fromCharCode(c);
  if (settings.charset === 'latin1') {
    for (let c = 0xa0; c <= 0xff; c++) out += String.fromCharCode(c);
  }
  return out;
}

/** Variant-URL suffixes appended to the source font path to form the deterministic
 *  served/dist URLs (mirrors `variantSuffix` for textures). The dev server serves
 *  these from the content cache; the build copies them into `dist/`. */
export const FONT_ATLAS_SUFFIX = '~atlas.png';
export const FONT_METRICS_SUFFIX = '~metrics.json';

export function fontAtlasUrl(sourcePath: string): string {
  return sourcePath + FONT_ATLAS_SUFFIX;
}
export function fontMetricsUrl(sourcePath: string): string {
  return sourcePath + FONT_METRICS_SUFFIX;
}

/** The font block baked onto an asset-manifest entry (`AssetEntry.font`) at scan/
 *  build time. The full per-glyph metrics live in the sibling `~metrics.json`
 *  variant (fetched by the font loader at acquire time — fonts are async scene
 *  resources), so this carries only what the loader/resolver needs up front: which
 *  provider to build and the atlas geometry the shader is calibrated to.
 *
 *  Defined HERE (a pure, Node-safe module) rather than in the browser-coupled
 *  `assetManifest.ts` so the build plugins can import it without dragging DOM
 *  globals into their Node typecheck. Re-exported from `assetManifest` for runtime
 *  consumers. */
export interface FontManifestBlock {
  /** How glyphs are sourced at runtime. `baked` = fixed atlas only; `dynamic` =
   *  the baked atlas seeds a runtime MSDF generator for arbitrary/unseen glyphs. */
  mode?: FontMode;
  /** Distance-field type baked into the atlas (always `mtsdf` for now). */
  fieldType?: FontFieldType;
  /** Distance range in px baked into the atlas — feeds the shader's `screenPxRange`.
   *  MUST match between the baked atlas and any dynamic-page atlas or AA/outlines
   *  drift between glyphs. */
  distanceRange?: number;
  /** Baked atlas page dimensions in px. */
  atlasWidth?: number;
  atlasHeight?: number;
}
