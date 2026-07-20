/** Particle GradientEditor color/position math (Missing-Tests #2).
 *  rgbToHex/hexToRgb round-trip; tAt mapping + clamp. (Stop-identity drag behavior is
 *  covered by gradientEditor.test.tsx — F3.) */
import { describe, it, expect } from 'vitest';
import { hexToRgb, rgbToHex, tAt } from '../../src/editor/panels/particle/gradientMath';

describe('gradientMath — rgbToHex / hexToRgb', () => {
  it('round-trips the 8-bit quantized colors', () => {
    for (const hex of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#336699']) {
      expect(rgbToHex(hexToRgb(hex))).toBe(hex);
    }
  });

  it('clamps + rounds out-of-range channel values', () => {
    expect(rgbToHex({ r: -0.5, g: 1.5, b: 0.5 })).toBe('#00ff80');
  });

  it('hexToRgb yields normalized [0,1] channels', () => {
    expect(hexToRgb('#ff8000')).toEqual({ r: 1, g: 128 / 255, b: 0 });
  });
});

describe('gradientMath — tAt strip position', () => {
  const rect = { left: 10, width: 100 };
  it('maps client x → t within [0,1] relative to the strip', () => {
    expect(tAt(10, rect)).toBe(0);
    expect(tAt(60, rect)).toBeCloseTo(0.5, 6);
    expect(tAt(110, rect)).toBe(1);
  });
  it('clamps outside the strip', () => {
    expect(tAt(-100, rect)).toBe(0);
    expect(tAt(9999, rect)).toBe(1);
  });
  it('returns 0 for a zero-width strip (guard)', () => {
    expect(tAt(50, { left: 0, width: 0 })).toBe(0);
  });
});
