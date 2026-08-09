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
  /** Variable-font axis instance — axis tag → pinned value, e.g. `{ wght: 700 }` or
   *  `{ wght: 600, SHRP: 40 }`. Tags are raw OpenType tags from the source's `fvar`
   *  table (the Font Inspector reads them, with each axis's real min/default/max).
   *
   *  Absent or empty ⇒ the font's DEFAULT instance. That default is often not Regular:
   *  Geologica defaults to wght 100 (Thin) and Nunito to 200 (ExtraLight), so leaving
   *  this unset is what made those families render at their lightest weight and nothing
   *  else. See docs/plans/font-variation-axes-plan.md.
   *
   *  ONE FONT ASSET = ONE INSTANCE (as in Unity): two weights of a family means two font
   *  assets, since each bakes its own atlas. Distinct from `Text2D.weight`, which is a
   *  per-entity SDF edge shift (fake bolding of whatever instance was rasterized). */
  variationAxes?: Record<string, number>;
  /** Whether the build ships the source `.ttf`/`.otf` alongside the baked atlas.
   *  `auto` (default) ships it only when the static asset-shaker finds a DOM
   *  consumer — a `UIElement.fontFamily` (or `resources[]` `type:'font'`) naming
   *  this font's CSS family — since DOM/PixiJS text goes through the browser's
   *  FontFace API and needs the real outlines; CANVAS text (`Text2D.font`, a GUID)
   *  renders from the atlas alone. `always` forces shipping even with no detected
   *  DOM usage — the escape hatch for a family named from CODE (a runtime string,
   *  not a scene field) or from a stylesheet the static scan can't see. `never`
   *  forces dropping it even if DOM usage IS detected (accepting a fallback face)
   *  when the payload isn't worth it. */
  shipSource?: 'auto' | 'always' | 'never';
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
  shipSource: 'auto',
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
/** The axis-pinned static instance of the source font, emitted only when
 *  `variationAxes` is set. Consumed by the DYNAMIC runtime generator, which rasterizes
 *  raw outlines and so cannot apply axes itself. Baked fonts never need it at runtime —
 *  their atlas was already baked from it. */
export const FONT_INSTANCE_SUFFIX = '~instance.ttf';

export function fontAtlasUrl(sourcePath: string): string {
  return sourcePath + FONT_ATLAS_SUFFIX;
}
export function fontMetricsUrl(sourcePath: string): string {
  return sourcePath + FONT_METRICS_SUFFIX;
}
export function fontInstanceUrl(sourcePath: string): string {
  return sourcePath + FONT_INSTANCE_SUFFIX;
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
  /** ── DYNAMIC-only generation settings. Emitted just for `mode:'dynamic'` fonts, whose
   *  provider generates its own atlas at runtime and so needs the authored knobs the
   *  baked path gets from the sidecar at build time. (A baked font's atlas is already on
   *  disk, so carrying these for it would be dead weight in every manifest.)
   *
   *  They exist because the dynamic provider used to take NO settings and hardcode
   *  everything: a font could author `size: 128` and silently get 64. */
  size?: number;
  atlasMax?: number;
  charset?: FontCharsetPreset;
  customChars?: string;
  /** True when an axis-pinned `~instance.ttf` variant was emitted and the DYNAMIC
   *  runtime generator must fetch THAT instead of the source path. Absent/false ⇒ the
   *  font authors no `variationAxes`, so the source itself is the right outlines.
   *
   *  Note a DOM consumer still wants the RAW source, not this: CSS `font-weight`
   *  instances a variable font natively, so `sourceShipped` and `instanced` are
   *  independent and a font can legitimately ship both. */
  instanced?: boolean;
  /** Whether the build shipped the source `.ttf`/`.otf` next to the atlas.
   *  `false` means the shaker dropped it (`shipSource:'auto'` + no DOM usage
   *  found, or an explicit `'never'`) — `loadAllFonts` must NOT FontFace-load
   *  this entry's path, or it 404s and pads the "N/N fonts failed" warning with
   *  a failure that isn't one. Absent/`true` means the source is available
   *  (always the case in dev, which serves everything off disk). */
  sourceShipped?: boolean;
}
