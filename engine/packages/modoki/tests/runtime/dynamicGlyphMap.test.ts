import { describe, it, expect } from 'vitest';
import {
  metricsFromGen, glyphFromGen, applyMedianAlpha,
} from '../../src/runtime/rendering/text/dynamicGlyphMap';

// Values captured from a live CDP probe of generateMsdf(Geologica-Bold, 'AgMo',
// {fontSize:48, fieldRange:8, padding:4}).
const GEN_METRICS = { emSize: 1, ascender: 46.8, descender: -13.2, lineHeight: 60 };
const GLYPH_A = {
  unicode: 65,
  atlasPosition: [0, 0] as [number, number],
  atlasSize: [43, 42] as [number, number],
  bounds: { left: 0, bottom: 0, right: 35, top: 34 },
  advance: 34.8,
};

describe('metricsFromGen', () => {
  it('converts px + Y-up → em + Y-down', () => {
    const m = metricsFromGen(GEN_METRICS, 48);
    expect(m.emSize).toBe(1);
    expect(m.ascender).toBeCloseTo(-0.975, 5); // above baseline ⇒ negative
    expect(m.descender).toBeCloseTo(0.275, 5); // below baseline ⇒ positive
    expect(m.lineHeight).toBeCloseTo(1.25, 5);
  });
});

describe('glyphFromGen', () => {
  it('maps a padded cell to em plane (Y-down) + destination atlas rect', () => {
    const g = glyphFromGen(GLYPH_A, 48, 4, 10, 20);
    expect(g.unicode).toBe(65);
    expect(g.advance).toBeCloseTo(34.8 / 48, 5);
    // plane: padded bbox ÷ fontSize, Y negated (top most-negative).
    expect(g.plane!.left).toBeCloseTo(-4 / 48, 5);
    expect(g.plane!.right).toBeCloseTo(39 / 48, 5);
    expect(g.plane!.top).toBeCloseTo(-38 / 48, 5);
    expect(g.plane!.bottom).toBeCloseTo(4 / 48, 5);
    // atlas: padded cell placed at (dstX,dstY), top-origin.
    expect(g.atlas).toEqual({ left: 10, top: 20, right: 53, bottom: 62 });
  });

  it('emits advance-only for a zero-area (whitespace) cell', () => {
    const space = { ...GLYPH_A, unicode: 32, atlasSize: [0, 0] as [number, number] };
    const g = glyphFromGen(space, 48, 4, 0, 0);
    expect(g.advance).toBeCloseTo(34.8 / 48, 5);
    expect(g.plane).toBeUndefined();
    expect(g.atlas).toBeUndefined();
  });
});

describe('applyMedianAlpha', () => {
  it('sets alpha = median(r,g,b) in place', () => {
    const d = new Uint8ClampedArray([30, 67, 67, 255, 10, 20, 30, 255, 200, 5, 100, 0]);
    applyMedianAlpha(d);
    expect(d[3]).toBe(67);  // median(30,67,67)
    expect(d[7]).toBe(20);  // median(10,20,30)
    expect(d[11]).toBe(100); // median(200,5,100)
    // RGB untouched
    expect([d[0], d[1], d[2]]).toEqual([30, 67, 67]);
  });
});
