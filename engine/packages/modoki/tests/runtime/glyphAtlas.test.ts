/** Chlumsky JSON parse + BakedFontProvider unit tests. Uses a hand-built fixture
 *  matching the real msdf-atlas-gen `-yorigin top` output (verified against a live
 *  bake): ascender negative, atlasBounds top-origin, whitespace glyphs bounds-less. */

import { describe, it, expect } from 'vitest';
import { parseChlumskyJson, kerningKey } from '../../src/runtime/rendering/text/glyphAtlas';
import { BakedFontProvider } from '../../src/runtime/rendering/text/fontProvider';

const FIXTURE = {
  atlas: { type: 'mtsdf', distanceRange: 4, size: 48, width: 128, height: 64, yOrigin: 'top' },
  metrics: { emSize: 1, lineHeight: 1.25, ascender: -0.975, descender: 0.275 },
  glyphs: [
    { unicode: 32, advance: 0.25 }, // space — no bounds
    { unicode: 65, advance: 0.68, // A
      planeBounds: { left: -0.03, top: -0.76, right: 0.71, bottom: 0.05 },
      atlasBounds: { left: 60.5, top: 0.5, right: 96.5, bottom: 39.5 } },
  ],
  kerning: [{ unicode1: 65, unicode2: 86, advance: -0.05 }],
};

describe('parseChlumskyJson', () => {
  it('parses atlas + metrics + glyphs + kerning', () => {
    const a = parseChlumskyJson(FIXTURE);
    expect(a.atlas.type).toBe('mtsdf');
    expect(a.atlas.yOrigin).toBe('top');
    expect(a.atlas.width).toBe(128);
    expect(a.metrics.ascender).toBeLessThan(0); // Y-down convention
    expect(a.glyphs.size).toBe(2);
    expect(a.glyphs.get(65)?.plane?.right).toBe(0.71);
    expect(a.kerning.get(kerningKey(65, 86))).toBe(-0.05);
  });

  it('keeps whitespace glyphs bounds-less (advance only)', () => {
    const a = parseChlumskyJson(FIXTURE);
    const space = a.glyphs.get(32)!;
    expect(space.advance).toBe(0.25);
    expect(space.plane).toBeUndefined();
    expect(space.atlas).toBeUndefined();
  });

  it('tolerates missing kerning table', () => {
    const a = parseChlumskyJson({ ...FIXTURE, kerning: undefined });
    expect(a.kerning.size).toBe(0);
  });

  it('throws on a structurally invalid doc', () => {
    expect(() => parseChlumskyJson({})).toThrow(/invalid Chlumsky/);
    expect(() => parseChlumskyJson(null)).toThrow(/invalid Chlumsky/);
  });
});

describe('BakedFontProvider', () => {
  it('exposes glyphs, kerning, metrics + a constant atlasVersion', () => {
    const p = new BakedFontProvider('font-guid', parseChlumskyJson(FIXTURE), '/f.ttf~atlas.png');
    expect(p.id).toBe('font-guid');
    expect(p.atlasVersion).toBe(0);
    expect(p.atlasImageUrl).toBe('/f.ttf~atlas.png');
    expect(p.getGlyph(65)?.advance).toBe(0.68);
    expect(p.getGlyph(999)).toBeUndefined();
    expect(p.kerning(65, 86)).toBe(-0.05);
    expect(p.kerning(65, 67)).toBe(0); // no pair → 0
    expect(p.metrics.lineHeight).toBe(1.25);
  });
});

describe('kerningKey', () => {
  it('is collision-free for distinct ordered pairs', () => {
    expect(kerningKey(65, 86)).not.toBe(kerningKey(86, 65));
    expect(kerningKey(1, 2)).not.toBe(kerningKey(2, 1));
    // high codepoints (emoji range) stay within safe-integer range
    expect(Number.isSafeInteger(kerningKey(0x10ffff, 0x10ffff))).toBe(true);
  });
});
