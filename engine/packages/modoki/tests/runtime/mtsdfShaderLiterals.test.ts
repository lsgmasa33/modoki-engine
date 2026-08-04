/** The GLSL and WGSL MTSDF programs must agree on every NUMERIC CONSTANT.
 *
 *  They are generated from one template by `mtsdfBody(lang)`, so the maths is shared by
 *  construction — but the float LITERALS go through a per-language formatter, and that
 *  formatter was `n.toFixed(1)` for GLSL. It rounded to one decimal place, silently
 *  destroying four distinct constants:
 *
 *    0.0001  -> 0.0   three composite divide-by-zero guards became divide-by-zero:
 *                     a fully transparent pixel gives cA == 0, so 0/0 -> NaN and the
 *                     glyph colour is destroyed
 *    0.00001 -> 0.0   four `step()` masks; `step(0.0, 0.0)` is 1.0, so "width 0 = off"
 *                     became "always on"
 *    0.55    -> 0.6   the corner-clash AA gate
 *    0.05    -> 0.0   the glow ramp floor (0.5 - GLOW_MAX_SPREAD)
 *
 *  WGSL was never affected (`f32(0.0001)` keeps the value), so EVERY WebGPU device
 *  rendered correctly and only the WebGL fallback — older hardware — got the broken
 *  program. It surfaced as invisible text on an iPhone 7 (labels drew at #141321 on a
 *  #100e23 background) and had been shipping unnoticed.
 *
 *  Asserting parity BETWEEN the two backends is what makes this general: it catches any
 *  future formatter regression without this test having to know which constants exist. */
import { describe, it, expect } from 'vitest';
import { mtsdfShaderBitsForTest } from '../../src/runtime/rendering/text/mtsdfPixiShader';

/** Every `f32(<n>)` literal the WGSL program emits. */
function wgslNumbers(src: string): number[] {
  return [...src.matchAll(/\bf32\(([-0-9.eE]+)\)/g)].map(m => Number(m[1]));
}

/** Every bare float literal the GLSL program emits (`1.0`, `0.0001`, `0.55`, …). Excludes
 *  vector/array indices and swizzles by requiring a decimal point. */
function glslNumbers(src: string): number[] {
  return [...src.matchAll(/(?<![\w.])(\d+\.\d+(?:[eE][-+]?\d+)?)/g)].map(m => Number(m[1]));
}

describe('MTSDF shader float literals', () => {
  const { wgsl, glsl } = mtsdfShaderBitsForTest();
  const wgslSrc = wgsl.fragment.main;
  const glslSrc = glsl.fragment.main;

  it('emits the same SET of constants on both backends', () => {
    const w = [...new Set(wgslNumbers(wgslSrc))].sort((a, b) => a - b);
    const g = [...new Set(glslNumbers(glslSrc))].sort((a, b) => a - b);
    expect(g).toEqual(w);
  });

  // The specific values that were destroyed — named so a failure says WHICH guard broke
  // rather than just "a number changed".
  it('keeps the composite divide-by-zero guards non-zero', () => {
    // `max(cA, 0.0)` divides 0/0 on a transparent pixel -> NaN -> no visible glyph.
    expect(glslSrc).not.toMatch(/max\((?:cA|midA|outA), 0\.0\)/);
    expect(glslSrc).toMatch(/max\(cA, 0\.0001\)/);
  });

  it('keeps the effect masks strictly above zero — step(0.0, 0.0) is 1.0, i.e. never off', () => {
    expect(glslSrc).not.toMatch(/step\(0\.0,/);
    expect(glslSrc).toMatch(/step\(0\.00001,/);
  });

  it('does not round a sub-0.1 constant away', () => {
    expect(glslSrc).toContain('0.55'); // corner-clash gate; 1dp would give 0.6
    // The glow floor is COMPUTED (`0.5 - GLOW_MAX_SPREAD`), so it carries float error and
    // is emitted as 0.04999999999999999 — assert the VALUE, not the text. At 1dp it became
    // 0.0, which drops the ramp floor entirely.
    const m = glslSrc.match(/max\(edge - uGlowSize, ([0-9.eE+-]+)\)/);
    expect(m, 'the glow floor expression should exist').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0.01);
  });

  // GLSL needs the decimal point: `1` is an int and `float x = 1;` is a type error.
  it('still emits whole numbers as float literals', () => {
    expect(glslSrc).toMatch(/\b1\.0\b/);
    expect(glslSrc).toMatch(/\b0\.0\b/);
  });
});
