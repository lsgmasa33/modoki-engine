/** Pure layout engine tests — advance, kerning, whitespace, alignment, wrapping,
 *  multi-line baselines, and UV mapping. Uses a synthetic font with round numbers
 *  (1 em = fontSize px) so every position is exactly predictable. */

import { describe, it, expect } from 'vitest';
import { layoutText, type LayoutFont } from '../../src/runtime/rendering/text/layoutText';
import type { Glyph } from '../../src/runtime/rendering/text/glyphAtlas';

// Square-ish glyph: 0.5em advance, full-ascender box, atlas 100×100.
const boxGlyph = (cp: number): Glyph => ({
  unicode: cp, advance: 0.5,
  plane: { left: 0, top: -0.8, right: 0.5, bottom: 0 },
  atlas: { left: 0, top: 0, right: 50, bottom: 80 },
});

function makeFont(kern: Record<string, number> = {}): LayoutFont {
  const glyphs = new Map<number, Glyph>([
    [65, boxGlyph(65)], [66, boxGlyph(66)],
    [32, { unicode: 32, advance: 0.5 }], // space, no bounds
  ]);
  return {
    metrics: { emSize: 1, lineHeight: 1.0, ascender: -0.8, descender: 0.2 },
    atlas: { type: 'mtsdf', distanceRange: 4, width: 100, height: 100, size: 48, yOrigin: 'top' },
    getGlyph: (cp) => glyphs.get(cp),
    kerning: (a, b) => kern[`${a},${b}`] ?? 0,
  };
}

const FS = 100;

describe('layoutText', () => {
  it('places a single glyph with baseline + UVs correct', () => {
    const l = layoutText(makeFont(), 'A', { fontSize: FS });
    expect(l.quads).toHaveLength(1);
    const q = l.quads[0];
    expect(q).toMatchObject({ x0: 0, x1: 50, y0: 0, y1: 80 }); // baseline at 80 (ascent), box up to 0
    expect(q).toMatchObject({ u0: 0, u1: 0.5, v0: 0, v1: 0.8 }); // top-origin UVs
    expect(l.width).toBe(50);
    expect(l.height).toBe(100); // 1 line × lineHeight(1) × fs(100)
    expect(l.lines).toBe(1);
  });

  it('applies kerning between an ordered pair', () => {
    const l = layoutText(makeFont({ '65,65': -0.1 }), 'AA', { fontSize: FS });
    expect(l.quads[0].x0).toBe(0);
    expect(l.quads[1].x0).toBe(40); // 50 advance − 10 kern
    expect(l.width).toBe(90);
  });

  it('advances whitespace but emits no quad for it', () => {
    const l = layoutText(makeFont(), 'A A', { fontSize: FS });
    expect(l.quads).toHaveLength(2);
    expect(l.quads[1].x0).toBe(100); // A(50) + space(50)
  });

  it('center-aligns within maxWidth', () => {
    const l = layoutText(makeFont(), 'A', { fontSize: FS, maxWidth: 100, align: 'center' });
    expect(l.quads[0].x0).toBe(25); // (100 − 50) / 2
    expect(l.width).toBe(100);
  });

  it('right-aligns within maxWidth', () => {
    const l = layoutText(makeFont(), 'A', { fontSize: FS, maxWidth: 100, align: 'right' });
    expect(l.quads[0].x0).toBe(50); // 100 − 50
  });

  it('word-wraps at maxWidth', () => {
    // "A A A": each word 50px, space 50px. maxWidth 160 fits "A A" (150), wraps the 3rd.
    const l = layoutText(makeFont(), 'A A A', { fontSize: FS, maxWidth: 160 });
    expect(l.lines).toBe(2);
    expect(l.height).toBe(200);
  });

  it('honors hard newlines with stacked baselines', () => {
    const l = layoutText(makeFont(), 'A\nA', { fontSize: FS });
    expect(l.lines).toBe(2);
    expect(l.quads[0].y1).toBe(80);  // line 0 baseline
    expect(l.quads[1].y1).toBe(180); // line 1 baseline = 80 + lineStep(100)
  });

  it('applies letterSpacing to advance', () => {
    const l = layoutText(makeFont(), 'AA', { fontSize: FS, letterSpacing: 10 });
    expect(l.quads[1].x0).toBe(60); // 50 advance + 10 letterSpacing
  });

  it('falls back (advances, no quad) for a glyph not in the atlas', () => {
    const l = layoutText(makeFont(), 'AxA', { fontSize: FS }); // x (120) not in font
    expect(l.quads).toHaveLength(2); // only the two A's
    // second A pushed past the fallback advance (0.5em = 50px): A(50)+x(50)=100
    expect(l.quads[1].x0).toBe(100);
  });
});
