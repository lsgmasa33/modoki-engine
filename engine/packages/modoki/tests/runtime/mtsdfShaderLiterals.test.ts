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
import { stripComments as sharedStripComments, assertScanIsSane } from '../helpers/sourceScanner';

/** Comment stripping is the shared scanner (`../helpers/sourceScanner`, #419), with
 *  `regexLiterals: false` — this source is WGSL/GLSL, where a `/` is always division and the
 *  JS regex-literal heuristic could only misfire.
 *
 *  Stripping is required for CORRECTNESS, not tidiness: the two extractors below have DIFFERENT
 *  blind spots. WGSL's only matches `f32(...)` calls, so prose is invisible to it, while GLSL's
 *  matches any bare decimal — so a comment mentioning a threshold ("the shipped floor of 0.1")
 *  registered as a GLSL-only constant and failed a parity check on two identical programs. This
 *  test is about the CODE the backends emit; the shared template's prose is not part of it. */
function stripComments(src: string): string {
  return sharedStripComments(src, { regexLiterals: false });
}

/** Every `f32(<n>)` literal the WGSL program emits. */
function wgslNumbers(src: string): number[] {
  return [...stripComments(src).matchAll(/\bf32\(([-0-9.eE]+)\)/g)].map(m => Number(m[1]));
}

/** Every bare float literal the GLSL program emits (`1.0`, `0.0001`, `0.55`, …). Excludes
 *  vector/array indices and swizzles by requiring a decimal point. */
function glslNumbers(src: string): number[] {
  return [...stripComments(src).matchAll(/(?<![\w.])(\d+\.\d+(?:[eE][-+]?\d+)?)/g)].map(m => Number(m[1]));
}

describe('MTSDF shader float literals', () => {
  const { wgsl, glsl } = mtsdfShaderBitsForTest();
  const wgslSrc = wgsl.fragment.main;
  const glslSrc = glsl.fragment.main;

  // Length/line parity is true by construction for the scanner (sourceScanner.ts) — this pins
  // against a regression to a regex stripper. The forward oracle lives in sourceScanner.test.ts.
  it('the comment strip is length- and line-exact (a regex stripper would not be)', () => {
    assertScanIsSane(wgslSrc, stripComments(wgslSrc), 'mtsdf wgsl fragment.main');
    assertScanIsSane(glslSrc, stripComments(glslSrc), 'mtsdf glsl fragment.main');
  });

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

/** The soft-effect distance must never read the atlas alpha UNGATED.
 *
 *  Glow and the soft drop shadow are `smoothstep(.., asd)` over a "true SDF". Only an
 *  MTSDF atlas has one: a 3-channel MSDF bake samples a == 1.0 everywhere, so an ungated
 *  read saturates both effects over the entire glyph quad (solid rectangles) and makes
 *  `clashUp = max(0, 1 - rawSd)` dilate the fill at every edge. `fieldType: 'msdf'` is a
 *  Font Inspector option, so this was reachable by authoring alone.
 *
 *  The gate is the `uHasTrueSdf` uniform (0/1), since both backends share ONE program.
 *  Asserting on the emitted SOURCE is the only check available — a unit test cannot run a
 *  shader, and the Three/TSL twin takes the same decision as a build-time branch. */
describe('mtsdf soft effects are gated on the atlas actually having a true SDF', () => {
  const { wgsl, glsl } = mtsdfShaderBitsForTest();
  for (const [lang, bit] of [['wgsl', wgsl], ['glsl', glsl]] as const) {
    const src = stripComments(bit.fragment.main);
    it(`${lang}: derives asd through uHasTrueSdf, not a bare .a`, () => {
      expect(src).toMatch(/asd\s*=\s*mix\(\s*rawSd\s*,\s*s\.a\s*,\s*[\w.]*uHasTrueSdf\s*\)/);
    });
    it(`${lang}: gates the soft shadow the same way`, () => {
      expect(src).toMatch(/shSoft[\s\S]{0,260}uHasTrueSdf/);
      expect(src).not.toMatch(/smoothstep\([^)]*edge\s*,\s*shTex\.a\s*\)/);
    });
    it(`${lang}: declares the uniform`, () => {
      expect(bit.fragment.header).toContain('uHasTrueSdf');
    });
  }
});
