/** Pure transforms from `@zappar/msdf-generator` output → our canonical glyph-atlas
 *  format (see glyphAtlas.ts). Headless-testable; no DOM/renderer imports.
 *
 *  The generator's coordinate convention (pinned from real sample output — a live
 *  CDP probe of generateMsdf, Geologica 'A' @ fontSize 48, pad 4):
 *   - metrics ascender/descender/lineHeight are in **PX** (× fontSize), **Y-UP**
 *     (ascender POSITIVE, descender NEGATIVE) — e.g. asc +46.8, desc -13.2, lh 60.
 *   - a glyph's `bounds{left,bottom,right,top}` is its tight shape bbox in **px,
 *     Y-UP baseline-relative** (bottom on baseline = 0).
 *   - `atlasPosition`/`atlasSize` is the **PADDED** cell in the generated image (px,
 *     top-origin): atlasSize = boundsSize + 2·pad. e.g. 43×42 = 35×34 + 2·4.
 *   - `advance`, `xoffset`, `yoffset` are in px.
 *
 *  Our canonical is **em, baseline-relative, Y-DOWN** for planeBounds (top NEGATIVE)
 *  and **atlas px, top-origin** for atlasBounds — so: ÷fontSize, negate Y for plane.
 */

import type { Glyph, FontMetrics } from './glyphAtlas';

/** The subset of the lib's per-glyph info we consume. */
export interface GenGlyphInfo {
  unicode: number;
  atlasPosition: [number, number];
  atlasSize: [number, number];
  bounds: { left: number; bottom: number; right: number; top: number };
  advance: number;
}

/** The lib's font metrics (px + Y-up). */
export interface GenMetrics {
  emSize: number;
  ascender: number;
  descender: number;
  lineHeight: number;
}

/** Generator metrics (px, Y-up) → canonical {@link FontMetrics} (em, Y-down). */
export function metricsFromGen(gm: GenMetrics, fontSize: number): FontMetrics {
  const s = fontSize || 1;
  return {
    emSize: 1,
    // Y-down: above-baseline ascender is NEGATIVE, below-baseline descender POSITIVE.
    ascender: -gm.ascender / s,
    descender: -gm.descender / s,
    lineHeight: gm.lineHeight / s,
  };
}

/** One generator glyph → canonical {@link Glyph}, with its atlas rect placed at
 *  `(dstX,dstY)` in the destination (growing) atlas canvas. `pad` is the generation
 *  padding (px) baked into atlasSize. A zero-area cell (whitespace) yields an
 *  advance-only glyph (no plane/atlas), like the baked path. */
export function glyphFromGen(
  gi: GenGlyphInfo,
  fontSize: number,
  pad: number,
  dstX: number,
  dstY: number,
): Glyph {
  const s = fontSize || 1;
  const advance = gi.advance / s;
  const [w, h] = gi.atlasSize;
  if (w <= 0 || h <= 0) return { unicode: gi.unicode, advance };
  const b = gi.bounds;
  return {
    unicode: gi.unicode,
    advance,
    // Padded quad in em, baseline-relative, Y-down (top = most negative).
    plane: {
      left: (b.left - pad) / s,
      right: (b.right + pad) / s,
      top: -(b.top + pad) / s,
      bottom: -(b.bottom - pad) / s,
    },
    // Padded cell in the destination canvas, top-origin px.
    atlas: { left: dstX, top: dstY, right: dstX + w, bottom: dstY + h },
  };
}

/** Overwrite each texel's alpha with `median(r,g,b)` IN PLACE — synthesizes the
 *  mtsdf-style true-SDF alpha channel from the MSDF's 3 channels (the generator
 *  hard-sets alpha to 255). msdfgen reconstructs distance as median(rgb), so this is
 *  the same field the fill/outline read; the shader masks glow/soft-shadow by the
 *  median fill, so median-alpha behaves ~like real mtsdf for our effects. */
export function applyMedianAlpha(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // median of three
    data[i + 3] = Math.max(Math.min(r, g), Math.min(Math.max(r, g), b));
  }
}
