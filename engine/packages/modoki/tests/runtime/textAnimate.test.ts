/** textAnimate — pure per-glyph animation. Length-invariance (so renderers can update
 *  positions in place), typewriter reveal, wave/bounce offsets, and deterministic
 *  jitter. No DOM/renderer needed. */

import { describe, it, expect } from 'vitest';
import { applyTextAnimation, isTextAnimating, isColorEffect, type TextAnimParams } from '../../src/runtime/rendering/text/textAnimate';
import type { TextQuad } from '../../src/runtime/rendering/text/layoutText';

// Four unit-square glyph quads at x = 0,10,20,30 (px), page 0.
const quads = (): TextQuad[] =>
  [0, 10, 20, 30].map((x, i) => ({
    unicode: 65 + i, x0: x, y0: 0, x1: x + 8, y1: 10,
    u0: 0, v0: 0, u1: 1, v1: 1, page: 0,
  }));

const params = (p: Partial<TextAnimParams>): TextAnimParams =>
  ({ effect: 'none', speed: 1, amplitude: 0.1, frequency: 1, loop: false, ...p });

const isZeroArea = (q: TextQuad) => q.x0 === q.x1 && q.y0 === q.y1;

describe('textAnimate', () => {
  it('isTextAnimating gates on effect', () => {
    expect(isTextAnimating(null)).toBe(false);
    expect(isTextAnimating(params({ effect: 'none' }))).toBe(false);
    expect(isTextAnimating(params({ effect: 'wave' }))).toBe(true);
  });

  it('effect:none returns an unchanged copy (new objects, same values)', () => {
    const src = quads();
    const out = applyTextAnimation(src, params({ effect: 'none' }), 1.23, 32);
    expect(out).toHaveLength(src.length);
    expect(out).toEqual(src);
    expect(out[0]).not.toBe(src[0]); // copied, not aliased
  });

  it('is length-invariant for every effect (hidden glyphs collapse, not drop)', () => {
    for (const effect of ['typewriter', 'wave', 'bounce', 'jitter'] as const) {
      const out = applyTextAnimation(quads(), params({ effect }), 0.35, 32);
      expect(out).toHaveLength(4);
    }
  });

  it('typewriter reveals speed·t glyphs; the rest collapse to zero area', () => {
    // speed 2 glyphs/sec, t=1.5s → 3 revealed (indices 0,1,2), index 3 hidden.
    const out = applyTextAnimation(quads(), params({ effect: 'typewriter', speed: 2 }), 1.5, 32);
    expect(isZeroArea(out[0])).toBe(false);
    expect(isZeroArea(out[2])).toBe(false);
    expect(isZeroArea(out[3])).toBe(true);
    // t=0 → nothing revealed yet.
    const t0 = applyTextAnimation(quads(), params({ effect: 'typewriter', speed: 2 }), 0, 32);
    expect(t0.every(isZeroArea)).toBe(true);
  });

  it('typewriter with speed<=0 shows the full string (never all-hidden)', () => {
    for (const speed of [0, -1]) {
      const out = applyTextAnimation(quads(), params({ effect: 'typewriter', speed }), 3, 32);
      expect(out.some(isZeroArea)).toBe(false); // every glyph visible
    }
  });

  it('wave offsets each glyph vertically by amplitude·fontSize·sin(...)', () => {
    const fs = 32, amp = 0.25, speed = 1, freq = 0.5, t = 0.3;
    const out = applyTextAnimation(quads(), params({ effect: 'wave', amplitude: amp, speed, frequency: freq }), t, fs);
    out.forEach((q, i) => {
      const dy = amp * fs * Math.sin(t * speed * Math.PI * 2 + i * freq);
      expect(q.y0).toBeCloseTo(0 + dy, 5);
      expect(q.y1).toBeCloseTo(10 + dy, 5);
      expect(q.x0).toBe(i * 10); // no horizontal move
    });
  });

  it('isColorEffect flags the tint/fade effects', () => {
    expect(isColorEffect('fade')).toBe(true);
    expect(isColorEffect('rainbow')).toBe(true);
    expect(isColorEffect('wave')).toBe(false);
    expect(isColorEffect('typewriter')).toBe(false);
  });

  it('fade sets a per-glyph alpha ramp (white rgb) and leaves positions untouched', () => {
    // speed 1, freq(stagger) 0.5, t=1.0 → glyph i alpha = clamp(1 - 0.5·i, 0, 1)
    const src = quads();
    const out = applyTextAnimation(src, params({ effect: 'fade', speed: 1, frequency: 0.5 }), 1.0, 32);
    const expectAlpha = [1, 0.5, 0, 0];
    out.forEach((q, i) => {
      expect(q.color).toBeDefined();
      expect(q.color![0]).toBe(1); expect(q.color![1]).toBe(1); expect(q.color![2]).toBe(1); // white rgb
      expect(q.color![3]).toBeCloseTo(expectAlpha[i], 5);
      expect(q.x0).toBe(src[i].x0); expect(q.y0).toBe(src[i].y0); // no motion
    });
  });

  it('rainbow sets a per-glyph opaque hue that varies across glyphs; deterministic', () => {
    const p = params({ effect: 'rainbow', speed: 0.1, frequency: 0.25 });
    const a = applyTextAnimation(quads(), p, 2, 32);
    const b = applyTextAnimation(quads(), p, 2, 32);
    expect(a).toEqual(b); // deterministic
    a.forEach((q) => { expect(q.color).toBeDefined(); expect(q.color![3]).toBe(1); }); // opaque
    // hue offset by freq → adjacent glyphs differ in colour
    expect(a[0].color).not.toEqual(a[1].color);
  });

  it('jitter is deterministic and bounded by amplitude·fontSize', () => {
    const fs = 40, amp = 0.2, p = params({ effect: 'jitter', amplitude: amp, speed: 1 });
    const a = applyTextAnimation(quads(), p, 0.7, fs);
    const b = applyTextAnimation(quads(), p, 0.7, fs); // same inputs → identical
    expect(a).toEqual(b);
    const bound = amp * fs;
    a.forEach((q, i) => {
      expect(Math.abs(q.x0 - i * 10)).toBeLessThanOrEqual(bound + 1e-6);
      expect(Math.abs(q.y0 - 0)).toBeLessThanOrEqual(bound + 1e-6);
    });
  });
});
