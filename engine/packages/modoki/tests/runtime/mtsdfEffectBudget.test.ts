/** Text effect budgets + the two silent-failure modes they caused (#189).
 *
 *  Every effect is a threshold band inside the baked distance field, so the field's em
 *  width (`pxRange / size`) is a hard ceiling — and nothing used to say so. Two distinct
 *  defects came out of that, in opposite directions: the band was too NARROW to be useful
 *  at the shipped defaults, and simultaneously wide enough to flood the whole glyph quad
 *  once text was scaled down.
 */

import { describe, it, expect } from 'vitest';
import {
  maxShadowOffsetEm, clampShadowOffset, OUTLINE_MAX_SPREAD,
} from '../../src/runtime/rendering/text/mtsdfStyle';
import { mtsdfShaderBitsForTest } from '../../src/runtime/rendering/text/mtsdfPixiShader';
import { Text2D } from '../../src/runtime/traits/Text2D';
import { Text3D } from '../../src/runtime/traits/Text3D';

describe('glow defaults', () => {
  /** `glowStrength` multiplied the glow, and defaulted to 0 — so authoring `glowSize`
   *  alone rendered nothing however far the slider went ("glow does not work"). The first
   *  fix anyone tried, setting strength, then produced a BLACK glow, because glowColor
   *  defaulted to black too. Both had to move. */
  it('a glow needs only glowSize to be visible', () => {
    for (const [name, t] of [['Text2D', Text2D], ['Text3D', Text3D]] as const) {
      const d = (t as unknown as { schema: Record<string, unknown> }).schema ?? t;
      const s = d as unknown as { glowStrength: number; glowColor: number };
      expect(s.glowStrength, `${name}.glowStrength must not default to 0 — it gates the whole effect`).toBeGreaterThan(0);
      expect(s.glowColor, `${name}.glowColor must not default to black — invisible on a dark background`).not.toBe(0x000000);
    }
  });

  it('glow is still OFF by default (glowSize gates it, not strength)', () => {
    for (const t of [Text2D, Text3D]) {
      const s = ((t as unknown as { schema: Record<string, unknown> }).schema ?? t) as unknown as { glowSize: number };
      expect(s.glowSize).toBe(0);
    }
  });
});

describe('maxShadowOffsetEm', () => {
  /** The shadow is an OFFSET SAMPLE of the same atlas — no second draw — so it reaches
   *  only as far as the padding baked around each glyph, which is `pxRange` px. Past that
   *  it samples the NEIGHBOURING glyph and paints fragments of unrelated letterforms.
   *  Measured on Geologica-Bold (24/128 = 0.1875 em): 0.05 clean, 0.15 fine, 0.30 garbled,
   *  0.50 disconnected fragments — the predicted breakpoint. */
  it('is the field width in em', () => {
    expect(maxShadowOffsetEm(24, 128)).toBeCloseTo(0.1875, 6);
    expect(maxShadowOffsetEm(8, 128)).toBeCloseTo(0.0625, 6);
    expect(maxShadowOffsetEm(8, 64)).toBeCloseTo(0.125, 6);
  });

  it('degrades to 0 rather than dividing by zero', () => {
    expect(maxShadowOffsetEm(8, 0)).toBe(0);
    expect(maxShadowOffsetEm(-4, 128)).toBe(0);
  });

  it('clamps an over-large offset while preserving direction', () => {
    expect(clampShadowOffset(0.5, 24, 128)).toBeCloseTo(0.1875, 6);
    expect(clampShadowOffset(-0.5, 24, 128)).toBeCloseTo(-0.1875, 6);
  });

  it('leaves an in-budget offset untouched — including the trait default', () => {
    expect(clampShadowOffset(0.05, 24, 128)).toBeCloseTo(0.05, 6);
    expect(clampShadowOffset(0.05, 8, 128)).toBeCloseTo(0.05, 6); // budget 0.0625
    expect(clampShadowOffset(0, 24, 128)).toBe(0);
  });

  it('the shipped trait default fits the engine default font', () => {
    const dflt = ((Text2D as unknown as { schema: Record<string, unknown> }).schema ?? Text2D) as unknown as { shadowOffsetX: number };
    expect(dflt.shadowOffsetX).toBeLessThanOrEqual(maxShadowOffsetEm(8, 128));
  });
});

describe('outline band cannot flood the glyph quad', () => {
  /** THE black-rect bug, as arithmetic. A far-outside texel has sd ~ 0, so its outline
   *  coverage is `clamp((0 - lo)*spr + 0.5)` = `0.5 - lo*spr`, which is 0 only when
   *  `lo >= 0.5/spr`. The shipped floor was the constant 0.5 - OUTLINE_MAX_SPREAD = 0.1,
   *  satisfying that at spr >= 5 (large text) and failing below it — which is exactly what
   *  a scaled-down Game panel produces. Same data, same shader, different on-screen size:
   *  "fine in Scene view, box in Game view". */
  const outsideCoverage = (lo: number, spr: number) => Math.min(1, Math.max(0, (0 - lo) * spr + 0.5));
  const loFor = (width: number, spr: number) =>
    Math.max(0.5 - width, Math.max(0.5 - OUTLINE_MAX_SPREAD, 0.5 / spr));

  it('the OLD constant-only floor floods the quad below spr 5', () => {
    const oldLo = 0.5 - OUTLINE_MAX_SPREAD; // 0.1
    expect(outsideCoverage(oldLo, 5)).toBeCloseTo(0, 6);   // fine when text is large
    expect(outsideCoverage(oldLo, 2)).toBeCloseTo(0.3, 6); // 30% rectangle
    expect(outsideCoverage(oldLo, 1)).toBeCloseTo(0.4, 6); // 40% rectangle
  });

  it('the spr-dependent floor keeps outside coverage at zero, at every scale', () => {
    for (const spr of [1, 1.5, 2, 3, 5, 10, 40]) {
      expect(outsideCoverage(loFor(OUTLINE_MAX_SPREAD, spr), spr), `spr=${spr}`).toBeCloseTo(0, 6);
    }
  });

  it('does not change what already worked — it equals the old floor at spr 5', () => {
    expect(loFor(OUTLINE_MAX_SPREAD, 5)).toBeCloseTo(0.5 - OUTLINE_MAX_SPREAD, 6);
    // …and stays clamped by the static budget above that, so a huge spr cannot widen the
    // band past the field's outer saturation.
    expect(loFor(OUTLINE_MAX_SPREAD, 100)).toBeCloseTo(0.5 - OUTLINE_MAX_SPREAD, 6);
  });

  it('shrinks the band toward nothing at small sizes instead of drawing a rectangle', () => {
    // At spr 1 the raster cannot resolve any band at all, so the outline must vanish.
    expect(0.5 - loFor(OUTLINE_MAX_SPREAD, 1)).toBeCloseTo(0, 6);
    // …and recover monotonically as the text gets bigger.
    const widths = [1, 2, 3, 5].map((spr) => 0.5 - loFor(OUTLINE_MAX_SPREAD, spr));
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
  });

  /** Both backends are generated from one template, but the 3D path is a SEPARATE TSL
   *  graph — the two have drifted before, and a 2D-only fix would leave 3D text boxed. */
  it('both generated Pixi programs carry the spr-dependent floor', () => {
    const { wgsl, glsl } = mtsdfShaderBitsForTest();
    for (const [lang, bit] of [['wgsl', wgsl], ['glsl', glsl]] as const) {
      expect(bit.fragment.main, lang).toMatch(/outlineLo\s*=\s*max\(/);
      expect(bit.fragment.main, `${lang} must divide 0.5 by spr`).toMatch(/0\.5\s*\)?\s*\/\s*spr|\/\s*spr/);
    }
  });
});
