/** Integration: the real layoutText output flowing through applyTextAnimation. Proves
 *  the two pure modules compose — animation preserves each glyph's UVs/page while moving
 *  or hiding its quad, and stays aligned to layout's quad list (whitespace excluded). */

import { describe, it, expect } from 'vitest';
import { layoutText, type LayoutFont } from '../../src/runtime/rendering/text/layoutText';
import { applyTextAnimation, type TextAnimParams } from '../../src/runtime/rendering/text/textAnimate';
import type { Glyph } from '../../src/runtime/rendering/text/glyphAtlas';

const boxGlyph = (cp: number): Glyph => ({
  unicode: cp, advance: 0.5,
  plane: { left: 0, top: -0.8, right: 0.5, bottom: 0 },
  atlas: { left: 0, top: 0, right: 50, bottom: 80 },
});
const font: LayoutFont = {
  metrics: { emSize: 1, lineHeight: 1, ascender: -0.8, descender: 0.2 },
  atlas: { type: 'mtsdf', distanceRange: 4, width: 100, height: 100, size: 48, yOrigin: 'top' },
  getGlyph: (cp) => new Map([[65, boxGlyph(65)], [66, boxGlyph(66)], [32, { unicode: 32, advance: 0.5 }]]).get(cp),
  kerning: () => 0,
};
const FS = 100;
const params = (p: Partial<TextAnimParams>): TextAnimParams =>
  ({ effect: 'none', speed: 1, amplitude: 0.1, frequency: 1, loop: false, ...p });
const isZeroArea = (q: { x0: number; y0: number; x1: number; y1: number }) => q.x0 === q.x1 && q.y0 === q.y1;

describe('textAnimate ∘ layoutText', () => {
  it('typewriter hides trailing glyphs but preserves the visible ones exactly', () => {
    const layout = layoutText(font, 'ABAB', { fontSize: FS }); // 4 quads at x 0,50,100,150
    expect(layout.quads).toHaveLength(4);
    const out = applyTextAnimation(layout.quads, params({ effect: 'typewriter', speed: 2 }), 1.0, FS);
    expect(out).toHaveLength(4);
    // 2 revealed → indices 0,1 identical to layout; 2,3 collapsed.
    for (const i of [0, 1]) {
      expect(out[i]).toEqual(layout.quads[i]);        // UVs + page + rect untouched
    }
    expect(isZeroArea(out[2])).toBe(true);
    expect(isZeroArea(out[3])).toBe(true);
    // A hidden glyph keeps its UVs/page (only the rect collapses) — so a renderer's
    // per-page vertex layout is unchanged.
    expect(out[2].u0).toBe(layout.quads[2].u0);
    expect(out[2].page).toBe(layout.quads[2].page);
  });

  it('wave moves each glyph vertically but leaves x, UVs, and page intact', () => {
    const layout = layoutText(font, 'AB', { fontSize: FS });
    const out = applyTextAnimation(layout.quads, params({ effect: 'wave', amplitude: 0.2, speed: 1, frequency: 0.5 }), 0.25, FS);
    out.forEach((q, i) => {
      const src = layout.quads[i];
      const dy = 0.2 * FS * Math.sin(0.25 * 1 * Math.PI * 2 + i * 0.5);
      expect(q.x0).toBe(src.x0);
      expect(q.u0).toBe(src.u0); expect(q.u1).toBe(src.u1);
      expect(q.page).toBe(src.page);
      expect(q.y0).toBeCloseTo(src.y0 + dy, 4);
      expect(q.y1).toBeCloseTo(src.y1 + dy, 4);
    });
  });

  it('stays aligned to the quad list when the string has whitespace (no space quad)', () => {
    const layout = layoutText(font, 'A A', { fontSize: FS }); // 2 quads (space emits none)
    expect(layout.quads).toHaveLength(2);
    const out = applyTextAnimation(layout.quads, params({ effect: 'wave' }), 0.1, FS);
    expect(out).toHaveLength(2);
    expect(out[1].x0).toBe(layout.quads[1].x0); // second 'A' still at its advanced x
  });
});
