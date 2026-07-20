/** The canonical in-memory glyph-atlas format — the single shape BOTH the baked
 *  provider (msdf-atlas-gen Chlumsky JSON) and the dynamic provider (runtime WASM
 *  MSDF gen) produce, so everything downstream (layout, mesh, shader) is identical
 *  regardless of where a glyph came from.
 *
 *  Coordinate conventions (baked with `-yorigin top`, matched by the dynamic
 *  pages — see font-convert.ts):
 *   - **planeBounds** — em units, baseline-relative, **Y points DOWN** (top of a
 *     glyph is a *negative* Y). So `metrics.ascender` is negative and
 *     `metrics.descender` positive. All layout math stays in this Y-down space; the
 *     per-backend geometry builder flips Y for the Y-up 3D world.
 *   - **atlasBounds** — pixel units in the atlas image, **top-origin** (y=0 at the
 *     top row). UVs are therefore top-origin; Three uploads the atlas with
 *     `flipY=false` (repo KTX2 convention) and Pixi is natively top-origin, so one
 *     UV mapping serves both.
 */

/** One glyph's geometry. `plane`/`atlas` are absent for whitespace (advance only). */
export interface Glyph {
  /** Unicode codepoint. */
  unicode: number;
  /** Horizontal advance in em. */
  advance: number;
  /** Quad geometry in em, baseline-relative, Y-down. Absent ⇒ whitespace. */
  plane?: { left: number; top: number; right: number; bottom: number };
  /** Quad UV source in atlas pixels, top-origin. Absent ⇒ whitespace. */
  atlas?: { left: number; top: number; right: number; bottom: number };
  /** Atlas page index the glyph lives on. Absent/0 ⇒ the first (or only) page — the
   *  baked provider is always single-page; the dynamic provider spills to further
   *  pages once one fills, and the renderer draws one mesh per page (each bound to
   *  that page's texture). `atlas` UVs are relative to the glyph's OWN page. */
  page?: number;
}

/** Font-wide metrics in em (as emitted by msdf-atlas-gen with `-yorigin top`). */
export interface FontMetrics {
  emSize: number;
  lineHeight: number;
  /** Ascent line relative to baseline (NEGATIVE in the Y-down convention). */
  ascender: number;
  /** Descent line relative to baseline (POSITIVE in the Y-down convention). */
  descender: number;
  underlineY?: number;
  underlineThickness?: number;
}

/** Atlas image geometry + field calibration. */
export interface AtlasInfo {
  /** Distance-field type — `mtsdf` for us (`msdf`/`sdf`/... tolerated). */
  type: string;
  /** Distance range in px baked into the field (feeds the shader's screenPxRange). */
  distanceRange: number;
  /** Atlas image dimensions in px. */
  width: number;
  height: number;
  /** Glyph em size in px the field was rendered at. */
  size: number;
  /** Y orientation of `atlasBounds` — always `top` for us. */
  yOrigin: 'top' | 'bottom';
}

export interface GlyphAtlas {
  atlas: AtlasInfo;
  metrics: FontMetrics;
  /** unicode → glyph. Mutable so the dynamic provider can add glyphs in place. */
  glyphs: Map<number, Glyph>;
  /** Packed (a,b) → kerning advance adjustment in em. Key via {@link kerningKey}. */
  kerning: Map<number, number>;
}

/** Pack an ordered codepoint pair into a single safe-integer key. Unicode maxes at
 *  0x10FFFF (< 2^21), so `a<<21 | b` is collision-free and < 2^42 (safe integer). */
export function kerningKey(a: number, b: number): number {
  return a * 0x200000 + b;
}

/** The subset of the Chlumsky JSON layout we consume. */
interface ChlumskyJson {
  atlas?: Partial<AtlasInfo>;
  metrics?: Partial<FontMetrics>;
  glyphs?: Array<{
    unicode?: number;
    index?: number;
    advance?: number;
    planeBounds?: { left: number; top: number; right: number; bottom: number };
    atlasBounds?: { left: number; top: number; right: number; bottom: number };
  }>;
  kerning?: Array<{ unicode1?: number; unicode2?: number; advance?: number }>;
}

/** Parse an msdf-atlas-gen Chlumsky JSON layout into a {@link GlyphAtlas}. Pure +
 *  headless-testable. Tolerates whitespace glyphs (no bounds) and an absent/empty
 *  kerning table. Throws on a structurally invalid document (no atlas/glyphs). */
export function parseChlumskyJson(json: unknown): GlyphAtlas {
  const doc = json as ChlumskyJson;
  if (!doc || typeof doc !== 'object' || !doc.atlas || !Array.isArray(doc.glyphs)) {
    throw new Error('[glyphAtlas] invalid Chlumsky JSON: missing atlas/glyphs');
  }
  const a = doc.atlas;
  const atlas: AtlasInfo = {
    type: a.type ?? 'mtsdf',
    distanceRange: a.distanceRange ?? 4,
    width: a.width ?? 0,
    height: a.height ?? 0,
    size: a.size ?? 0,
    yOrigin: a.yOrigin === 'bottom' ? 'bottom' : 'top',
  };
  const m = doc.metrics ?? {};
  const metrics: FontMetrics = {
    emSize: m.emSize ?? 1,
    lineHeight: m.lineHeight ?? 1.2,
    ascender: m.ascender ?? -0.8,
    descender: m.descender ?? 0.2,
    ...(m.underlineY != null ? { underlineY: m.underlineY } : {}),
    ...(m.underlineThickness != null ? { underlineThickness: m.underlineThickness } : {}),
  };
  const glyphs = new Map<number, Glyph>();
  for (const g of doc.glyphs) {
    const cp = g.unicode ?? g.index;
    if (cp == null) continue;
    glyphs.set(cp, {
      unicode: cp,
      advance: g.advance ?? 0,
      ...(g.planeBounds ? { plane: g.planeBounds } : {}),
      ...(g.atlasBounds ? { atlas: g.atlasBounds } : {}),
    });
  }
  const kerning = new Map<number, number>();
  for (const k of doc.kerning ?? []) {
    if (k.unicode1 == null || k.unicode2 == null || !k.advance) continue;
    kerning.set(kerningKey(k.unicode1, k.unicode2), k.advance);
  }
  return { atlas, metrics, glyphs, kerning };
}
