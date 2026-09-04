/** MTSDF text shader for the PixiJS 2D layer — the 2D twin of {@link mtsdfShader}
 *  (the Three/TSL 3D material). Pixi v8 is WebGPU-preferred (see canvas2DPool), so
 *  this must ship BOTH a WGSL and a GLSL program. Rather than hand-write the vertex
 *  transform for both backends (and risk drifting from Pixi's mesh pipeline), we
 *  compose Pixi's own high-shader BITS — `localUniformBit` (model/projection
 *  transform), `textureBit` (atlas sampler), `roundPixelsBit` — and add ONE custom
 *  `mtsdfBit` that overrides the fragment colour with the distance-field effect
 *  compositing. That reuses Pixi's exact per-backend transform boilerplate; we only
 *  own the fragment maths, which mirrors the TSL graph 1:1 (median fill + alpha-SDF
 *  glow/shadow, outline via the median, `screenPxRange` AA via `fwidth`).
 *
 *  The effect maths MUST match mtsdfShader.ts so 2D and 3D text look identical.
 */

import {
  Shader, UniformGroup, Matrix, Texture,
  compileHighShaderGlProgram, compileHighShaderGpuProgram,
  localUniformBit, localUniformBitGl,
  textureBit, textureBitGl,
  roundPixelsBit, roundPixelsBitGl,
} from 'pixi.js';
import type { GlProgram, GpuProgram } from 'pixi.js';
import type { MtsdfStyle } from './mtsdfStyle';
import { GLOW_MAX_SPREAD, OUTLINE_MAX_SPREAD, clampShadowOffset } from './mtsdfStyle';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Shared MTSDF fragment body — samples the atlas at `vUV`, composites content
 *  (fill OVER outline, both MEDIAN) OVER glow (alpha SDF) OVER shadow (offset
 *  sample). Identical maths to the TSL 3D path; only the language differs. `M` is a
 *  namespace token (`mtsdfUniforms.` on WGSL, empty on GLSL where uniforms are
 *  loose) so one string template serves both. Output is PREMULTIPLIED (Pixi does
 *  `finalColor = outColor * vColor`). */
function mtsdfBody(lang: 'wgsl' | 'glsl'): string {
  const gpu = lang === 'wgsl';
  const M = gpu ? 'mtsdfUniforms.' : '';
  const f = gpu ? 'f32' : 'float';
  const v2 = gpu ? 'vec2<f32>' : 'vec2';
  const v3 = gpu ? 'vec3<f32>' : 'vec3';
  const v4 = gpu ? 'vec4<f32>' : 'vec4';
  // Local declaration prefix. WGSL: `let name`/`var name` with the TYPE INFERRED
  // from the initializer — the type may NOT precede the name (`let vec4<f32> s` is a
  // parse error; the typed form is `let s: vec4<f32>`). GLSL: C-style `type name`.
  // So the type token is emitted for GLSL only; WGSL relies on inference (every decl
  // below has an unambiguous initializer). `d(type)` = immutable `let`, `d(type,true)`
  // = mutable `var`. (Constructor calls like `vec4<f32>(...)` still use v2/v3/v4.)
  const d = (type: string, mutable = false) => (gpu ? (mutable ? 'var ' : 'let ') : `${type} `);
  /** Float literal.
   *
   *  ⚠️ GLSL needs a DECIMAL POINT (`1` is an int, `1.0` is a float), but it must not be
   *  produced with `toFixed(1)` — that ROUNDS TO ONE DECIMAL PLACE and silently destroys
   *  every constant finer than 0.1. It emitted `max(cA, 0.0001)` as `max(cA, 0.0)`, turning
   *  all three composite divide-by-zero guards below into divide-by-zero: a fully
   *  transparent pixel (cA == 0) then divides 0/0 → NaN → the glyph colour is destroyed.
   *  Measured on an iPhone 7: the board labels drew at #141321 against a #100e23
   *  background — present, laid out, and ~4/255 from invisible. It also rounded the
   *  `insideGate` threshold 0.55 → 0.6, shifting the corner-clash AA gate.
   *
   *  WGSL was never affected (`f32(0.0001)` keeps the value), which is exactly why this
   *  survived: every WebGPU device renders it correctly, and only the WebGL fallback —
   *  i.e. older hardware — gets the broken program. */
  const F = (n: number) => (gpu ? `${f}(${n})` : (Number.isInteger(n) ? n.toFixed(1) : String(n)));
  const sample = gpu
    ? 'textureSample(uTexture, uSampler, vUV)'
    : 'texture(uTexture, vUV)';
  // median(vec3): the mtsdf sharp-fill distance.
  const median = (s: string) => `max(min(${s}.r, ${s}.g), min(max(${s}.r, ${s}.g), ${s}.b))`;
  const shUv = gpu ? 'vUV - ' + M + 'uShadowOffset' : 'vUV - uShadowOffset';
  const shSample = gpu
    ? `textureSample(uTexture, uSampler, ${shUv})`
    : `texture(uTexture, ${shUv})`;
  const mix = gpu ? 'mix' : 'mix';
  return `
    ${d(v4)}s = ${sample};
    ${d(f)}rawSd = ${median('s')};
    // The "soft-effect" distance. On an MTSDF atlas that is the alpha channel's true SDF.
    // On a 3-CHANNEL MSDF atlas there is no alpha SDF — the texture samples a==1 EVERYWHERE
    // — so reading it made smoothstep(.., asd) saturate over the whole quad: glow and soft
    // shadow became solid rectangles, and clashUp = max(0, 1 - rawSd) dilated the fill at
    // every edge. fieldType 'msdf' was offered in the Font Inspector the whole time.
    // Falling back to the median is exactly what the DYNAMIC path already does (it
    // synthesizes alpha = median(RGB)), so all three paths now share one behaviour.
    ${d(f)}asd = ${mix}(rawSd, s.a, ${M}uHasTrueSdf);
    // mtsdf corner-clash correction. At acute corners the fill/outline MEDIAN nicks
    // BELOW the true-SDF alpha (median < alpha) — pull it UP to the alpha there. Gate
    // on the median being at/inside the edge (insideGate) so tight COUNTERS — where
    // the alpha spuriously speckles HIGH while the median is correctly low/outside —
    // are NOT filled in. clashUp is 0 at convex corners (median > alpha) so those stay
    // razor-sharp. (Dynamic median-alpha ⇒ asd==rawSd ⇒ clashUp 0 ⇒ no-op.)
    ${d(f)}clashUp = max(${F(0)}, asd - rawSd);
    ${d(f)}insideGate = smoothstep(${F(0.4)}, ${F(0.55)}, rawSd);
    ${d(f)}sd = rawSd + clashUp * insideGate;
    ${d(v2)}unitRange = ${v2}(${M}uDistanceRange) / ${M}uTexSize;
${gpu ? `    ${d(v2)}screenTexSize = ${v2}(${F(1)}) / fwidth(vUV);
    ${d(f)}spr = max(${F(0.5)} * dot(unitRange, screenTexSize), ${F(1)});`
      : `    // ⚠️ fwidth() is NOT universally available. In GLSL ES 1.00 it needs
    // OES_standard_derivatives, and some WebGL1 devices simply DO NOT HAVE that extension —
    // iPhone 8 / iOS reports 'extension is not supported' and then
    // 'fwidth: no matching overloaded function found', so the program fails to COMPILE and
    // every glyph in the game disappears. Declaring the pragma with \`enable\` (see
    // withDerivativesExtension) fixes the spec-strictness case but NOT this one: it downgrades
    // the directive to a warning while fwidth stays undefined, so the failure just moves from
    // the pragma line to the call site.
    //
    // So the derivative path is now compile-time OPTIONAL. \`GL_OES_standard_derivatives\` is
    // defined only when the extension is both requested AND supported; __VERSION__ >= 300 covers
    // WebGL2, where fwidth is core and the macro is absent. Everything else takes the CPU-supplied
    // range — the standard msdfgen fallback, screenPxRange = fontSize / atlasSize * distanceRange.
    #if defined(GL_OES_standard_derivatives) || __VERSION__ >= 300
    vec2 screenTexSize = vec2(1.0) / fwidth(vUV);
    float spr = max(0.5 * dot(unitRange, screenTexSize), 1.0);
    #else
    float spr = max(uScreenPxRange, 1.0);
    #endif`}
    ${d(f)}edge = ${F(0.5)} - ${M}uWeight;
    ${d(f)}fill = clamp((sd - edge) * spr + ${F(0.5)}, ${F(0)}, ${F(1)});

    ${d(v3, true)}rgb = ${M}uTextColor.rgb;
    ${d(f, true)}alpha = ${M}uTextColor.a * fill;

    // ── OUTLINE (median, masked so width 0 = off): fill OVER outline.
    //
    // The inner threshold is floored TWICE, and the second floor is the load-bearing one:
    //   · the static field budget (0.5 - OUTLINE_MAX_SPREAD), so a positive weight (which
    //     lowers 'edge') can't push the band past the field's outer saturation; and
    //   · 0.5/spr, which is what actually stops the black-rect bug.
    //
    // Why the constant alone was not enough: a far-OUTSIDE texel has sd ~ 0, so its
    // outline coverage is clamp((0 - outlineLo)*spr + 0.5) = 0.5 - outlineLo*spr. That is
    // zero only when outlineLo >= 0.5/spr. At the shipped floor of 0.1 it needs spr >= 5 —
    // true when text is large on screen, FALSE as soon as it is scaled down, where every
    // texel of the quad picks up constant coverage and the glyph gets a filled rectangle
    // behind it. It reproduced as "fine in the Scene panel, box in the Game panel": same
    // data, same shader, different on-screen size (measured — see #189).
    //
    // 0.5/spr equals 0.1 exactly at spr 5, so this generalizes the old constant rather
    // than replacing it: unchanged where it was already correct, and it shrinks the band
    // toward nothing at small sizes instead of flooding the quad. An outline the raster
    // cannot resolve should vanish, not become a rectangle.
    ${d(f)}outlineMask = step(${F(0.00001)}, ${M}uOutlineWidth);
    ${d(f)}outlineLo = max(edge - ${M}uOutlineWidth, max(${F(0.5 - OUTLINE_MAX_SPREAD)}, ${F(0.5)} / spr));
    ${d(f)}outline = clamp((sd - outlineLo) * spr + ${F(0.5)}, ${F(0)}, ${F(1)});
    ${d(f)}oa = ${M}uOutlineColor.a * outline * outlineMask;
    ${d(f)}cA = alpha + oa * (${F(1)} - alpha);
    rgb = (rgb * alpha + ${M}uOutlineColor.rgb * oa * (${F(1)} - alpha)) / max(cA, ${F(0.0001)});
    ${d(f, true)}contentA = cA;
    ${d(v3, true)}contentRgb = rgb;

    // ── GLOW (alpha SDF, masked): glowSize is normalized 0..1 → scaled budget.
    // Outer threshold FLOORED at the field budget (as with outline) so weight can't
    // push the glow ramp past saturation into a full-quad plateau.
    // Gated by (1 - fill): glow lives strictly OUTSIDE the clean MEDIAN silhouette.
    // The glow samples the alpha true-SDF, which dips inward at tight concave corners
    // (M vertices, counters) and would speckle through the fill's AA seam; the median
    // fill has no such dip, so masking by it removes the corner intrusion.
    ${d(f)}glowMask = step(${F(0.00001)}, ${M}uGlowSize);
    ${d(f)}glowEdgeLo = max(edge - ${M}uGlowSize, ${F(0.5 - GLOW_MAX_SPREAD)});
    ${d(f)}glowA = smoothstep(glowEdgeLo, edge, asd) * ${M}uGlowStrength * glowMask * (${F(1)} - fill);

    // ── SHADOW (offset sample; crisp median or soft alpha), masked on opacity.
    ${d(f)}shadowMask = step(${F(0.00001)}, ${M}uShadowColor.a);
    ${d(v4)}shTex = ${shSample};
    ${d(f)}shCrisp = clamp(${median('shTex')} * spr - (edge * spr) + ${F(0.5)}, ${F(0)}, ${F(1)});
    ${d(f)}shSoft = smoothstep(edge - ${M}uShadowSoftness, edge, ${mix}(${median('shTex')}, shTex.a, ${M}uHasTrueSdf));
    ${d(f)}shCov = ${mix}(shCrisp, shSoft, step(${F(0.00001)}, ${M}uShadowSoftness));
    ${d(f)}shadowA = ${M}uShadowColor.a * shCov * shadowMask;

    // ── COMPOSITE: content OVER glow OVER shadow (straight-alpha 'over').
    ${d(f)}midA = glowA + shadowA * (${F(1)} - glowA);
    ${d(v3)}midRgb = (${M}uGlowColor.rgb * glowA + ${M}uShadowColor.rgb * shadowA * (${F(1)} - glowA)) / max(midA, ${F(0.0001)});
    ${d(f)}outA = contentA + midA * (${F(1)} - contentA);
    ${d(v3)}outRgb = (contentRgb * contentA + midRgb * midA * (${F(1)} - contentA)) / max(outA, ${F(0.0001)});

    outColor = ${v4}(outRgb * outA, outA);
  `;
}

/** The custom high-shader bit (WGSL). Declares the mtsdf uniform block at the first
 *  free group (3 — global=0, local=1, texture=2) and overrides `outColor`. */
/** Exported for tests only — `mtsdfShaderBitsForTest` lets a test assert on the REAL
 *  generated shader source (both backends) rather than re-deriving it. The GLSL float
 *  formatter silently rounded every epsilon to 0.0 for months precisely because nothing
 *  ever looked at the emitted program. */
const mtsdfBit = {
  name: 'mtsdf-bit',
  // Per-glyph colour: an extra vertex attribute (aTextColor, STRAIGHT rgba — shared
  // with the 3D path) premultiplied into Pixi's built-in `vColor`, which the template
  // multiplies onto our premultiplied `outColor` (finalColor = outColor * vColor).
  // White (1,1,1,1) ⇒ no change. Animated by the colour effects (rainbow/fade).
  vertex: {
    header: /* wgsl */`@in aTextColor: vec4<f32>;`,
    main: /* wgsl */`vColor *= vec4<f32>(aTextColor.rgb * aTextColor.a, aTextColor.a);`,
  },
  fragment: {
    header: /* wgsl */`
      struct MtsdfUniforms {
        uTextColor: vec4<f32>,
        uOutlineColor: vec4<f32>,
        uGlowColor: vec4<f32>,
        uShadowColor: vec4<f32>,
        uShadowOffset: vec2<f32>,
        uTexSize: vec2<f32>,
        uWeight: f32,
        uOutlineWidth: f32,
        uGlowSize: f32,
        uGlowStrength: f32,
        uShadowSoftness: f32,
        uDistanceRange: f32,
        uScreenPxRange: f32,
        uHasTrueSdf: f32,
      };
      @group(3) @binding(0) var<uniform> mtsdfUniforms: MtsdfUniforms;
    `,
    main: mtsdfBody('wgsl'),
  },
};

/** Single source for the shader's name — feeds both `compileHighShaderGlProgram`'s /
 *  `compileHighShaderGpuProgram`'s `name:` argument (`getMtsdfPrograms`, below) AND the
 *  `#define SHADER_NAME` stamped into `mtsdfBitGl`'s own vertex/fragment headers, so a rename of
 *  one can't drift from the other.
 *
 *  ⚠️ For the GL program specifically, `name:` no longer reaches the compiled source at all:
 *  `GlProgram`'s constructor (`setProgramName`) only stamps `#define SHADER_NAME <name>-N` when
 *  the source doesn't already declare one, and `mtsdfBitGl`'s headers below always do — so
 *  `setProgramName` early-returns before it ever reads `name`. The `name:` argument passed to
 *  `compileHighShaderGlProgram` is DEAD for that reason; it is kept in sync here anyway because a
 *  program whose reported name doesn't match its own `#define` would be a confusing thing to debug,
 *  and because `compileHighShaderGpuProgram` (WGSL) still uses it directly. */
const MTSDF_SHADER_NAME = 'mtsdf-text';

/** The custom bit (GLSL). Uniforms are loose (Pixi's GL UBO handling maps them to
 *  the `mtsdfUniforms` group by name — names are unique across all bits). */
const mtsdfBitGl = {
  name: 'mtsdf-bit',
  vertex: {
    // ⚠️ Pixi 8.19.0's GLSL preprocessor (`GlProgram`'s `setProgramName`) stamps an
    // incrementing `#define SHADER_NAME <name>-N` into any source that doesn't already
    // carry one — see the note above `makeMtsdfPixiShader` for why that matters. The
    // fixed, stable defines here stop the LEAK (identical source now hashes to a stable
    // `_key` instead of an ever-incrementing one — see the `getMtsdfPrograms` comment
    // below). They do NOT make per-call program construction safe on their own: a SECOND
    // `GlProgram` built from this same source would still hit `GlShaderSystem`'s cache on
    // that stable key, `generateProgram` would never run for it, and its `_attributeData`
    // would stay unpopulated — `GlGeometrySystem.initGeometryVao` → `getSignature` then
    // hard-throws `Cannot read properties of undefined (reading 'aPosition')` inside the
    // 2D frame callback. The module-level cache in `getMtsdfPrograms` is what actually
    // keeps this to one program — it is LOAD-BEARING, not belt-and-suspenders, and it is
    // reachable via HMR / module re-evaluation while a renderer has already compiled the
    // program (a possibility, not confirmed against a live repro).
    header: /* glsl */`
      #define SHADER_NAME ${MTSDF_SHADER_NAME}-vertex
      in vec4 aTextColor;
    `,
    main: /* glsl */`vColor *= vec4(aTextColor.rgb * aTextColor.a, aTextColor.a);`,
  },
  fragment: {
    header: /* glsl */`
      #define SHADER_NAME ${MTSDF_SHADER_NAME}-fragment
      uniform vec4 uTextColor;
      uniform vec4 uOutlineColor;
      uniform vec4 uGlowColor;
      uniform vec4 uShadowColor;
      uniform vec2 uShadowOffset;
      uniform vec2 uTexSize;
      uniform float uWeight;
      uniform float uOutlineWidth;
      uniform float uGlowSize;
      uniform float uGlowStrength;
      uniform float uShadowSoftness;
      uniform float uDistanceRange;
      // Only READ on the no-derivatives path; declared always so the std140 layout mirrors WGSL.
      uniform float uScreenPxRange;
      // 1 on an mtsdf atlas (alpha carries a true SDF), 0 on a 3-channel msdf one.
      uniform float uHasTrueSdf;
    `,
    main: mtsdfBody('glsl'),
  },
};

/** Build the mtsdf UniformGroup from a style. Field ORDER/type must mirror the WGSL
 *  struct so the std140 layout matches. Colours are packed rgb + effect-opacity in
 *  the alpha channel. glowSize is scaled by {@link GLOW_MAX_SPREAD} here (same as
 *  the 3D path) so the trait's 0..1 stays seam-free. */
function toColorVec(hex: number, a: number): Float32Array {
  return new Float32Array([((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, a]);
}
function mtsdfUniformValues(style: MtsdfStyle, atlasW: number, atlasH: number, distanceRange: number, atlasSize: number, fontSize: number, hasTrueSdf: boolean) {
  return {
    uTextColor: { value: toColorVec(style.color >>> 0, style.opacity ?? 1), type: 'vec4<f32>' },
    uOutlineColor: { value: toColorVec((style.outlineColor ?? 0) >>> 0, style.outlineOpacity ?? 1), type: 'vec4<f32>' },
    uGlowColor: { value: toColorVec((style.glowColor ?? 0) >>> 0, 1), type: 'vec4<f32>' },
    uShadowColor: { value: toColorVec((style.shadowColor ?? 0) >>> 0, style.shadowOpacity ?? 0), type: 'vec4<f32>' },
    // Clamped to the atlas padding — past it the offset sample reads the NEIGHBOURING
    // glyph (or, off the atlas edge, a clamp-to-edge band): garbage, silently. See
    // maxShadowOffsetEm.
    uShadowOffset: { value: new Float32Array([
      clampShadowOffset(style.shadowOffsetX ?? 0, distanceRange, atlasSize) * atlasSize / atlasW,
      clampShadowOffset(style.shadowOffsetY ?? 0, distanceRange, atlasSize) * atlasSize / atlasH,
    ]), type: 'vec2<f32>' },
    uTexSize: { value: new Float32Array([atlasW, atlasH]), type: 'vec2<f32>' },
    uWeight: { value: Math.max(0, style.weight ?? 0), type: 'f32' }, // negative disabled (nicks corners)
    uOutlineWidth: { value: (style.outlineWidth ?? 0) * OUTLINE_MAX_SPREAD, type: 'f32' },
    uGlowSize: { value: (style.glowSize ?? 0) * GLOW_MAX_SPREAD, type: 'f32' },
    uGlowStrength: { value: style.glowStrength ?? 0, type: 'f32' },
    uShadowSoftness: { value: style.shadowSoftness ?? 0, type: 'f32' },
    uDistanceRange: { value: distanceRange, type: 'f32' },
    // Used ONLY where fwidth is unavailable (see the shader body). Design-space, because the
    // canvas scale is not known here — so on a downscaled canvas this over-estimates the range,
    // which errs toward a crisper edge rather than a blurry one. Anything is an improvement on
    // the alternative, which is a shader that does not compile and text that does not exist.
    uScreenPxRange: { value: Math.max(1, (fontSize / Math.max(1, atlasSize)) * distanceRange), type: 'f32' },
    // Atlas-derived, not style-derived — so updateMtsdfPixiStyle leaves it alone.
    uHasTrueSdf: { value: hasTrueSdf ? 1 : 0, type: 'f32' },
  };
}

/** GLSL ES 1.00 needs `OES_standard_derivatives` declared before `fwidth` is legal, and Pixi's
 *  high-shader assembly emits version-less (ES 1.00) GLSL — it only takes the ES 3.00 path when
 *  the source literally contains `#version 300 es` (`GlProgram`: `indexOf('#version 300 es')`).
 *  So the MTSDF `screenPxRange` line failed to compile with
 *
 *      ERROR: 0:67: 'GL_OES_standard_derivatives' : extension is disabled
 *
 *  and every glyph silently vanished (iPhone 7 / iOS 15.8.2 — the board's row/column letters).
 *  Desktop and Android never saw it: their WebGL2 drivers accept `fwidth` in ES 1.00 source
 *  without the pragma, so this is a spec-strictness difference, not a capability one.
 *
 *  ⚠️ The pragma MUST land before `precision` — measured on the device, all four variants:
 *    no pragma                 → 'extension is disabled'          (the shipped bug)
 *    pragma AFTER precision    → 'must occur before any non-preprocessor tokens'
 *    pragma at the TOP         → compiles
 *    `#version 300 es`         → compiles (fwidth is core there)
 *  Adding it to this file's `fragment.header` bit — the obvious fix — is the SECOND row: Pixi
 *  injects that bit after the precision line, so it fails just as loudly. Hence rewriting the
 *  assembled source here instead. `enable` (not `require`) so a device without the extension
 *  gets a warning and a working program rather than a hard failure.
 *
 *  Not done as `#version 300 es`: that would hard-fail on a genuinely WebGL1-only device, and
 *  the pragma keeps one program source valid on both. */
function withDerivativesExtension<T extends { fragment?: string; vertex?: string }>(program: T): T {
  const src = program.fragment;
  if (!src || src.includes('GL_OES_standard_derivatives') || src.includes('#version 300 es')) return program;
  // After any leading #define lines (preprocessor tokens are fine before it), before everything
  // else — `precision` is what must come after.
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length && /^\s*(#define|#extension|\/\/|\s*$)/.test(lines[i])) i++;
  lines.splice(i, 0, '#extension GL_OES_standard_derivatives : enable');
  // `fragment` is declared readonly on GlProgram; this is a deliberate post-assembly rewrite of
  // a string Pixi has no API to influence.
  (program as { fragment: string }).fragment = lines.join('\n');
  return program;
}

/** The atlas geometry a shader is built against — needed to re-derive the shadow
 *  UV offset when the style changes. */
export interface MtsdfPixiAtlas {
  width: number; height: number; distanceRange: number; size: number;
  /** Distance-field kind (`AtlasInfo.type`). Only a 3-channel `'msdf'` bake lacks the true
   *  SDF in alpha, and the shader must read the median instead — see `uHasTrueSdf`.
   *
   *  ⚠️ REQUIRED on purpose. It was optional for one commit, and Scene2D built this object
   *  from a hand-written four-field literal that predated it — so `type` was silently
   *  dropped, `hasTrueSdf` stayed true, and an msdf font's glow still rendered as a solid
   *  rectangle. Required makes that a compile error. Pass `{ ...provider.atlas }`. */
  type: string;
}

// ── Program cache (fixes #590) ──────────────────────────────────────────────
// `makeMtsdfPixiShader` used to call `compileHighShaderGlProgram`/
// `compileHighShaderGpuProgram` fresh on every invocation. `compileHighShaderGpuProgram`
// ends in `GpuProgram.from(...)`, which is content-cached — harmless. But
// `compileHighShaderGlProgram` ends in `new GlProgram(...)`, NOT `GlProgram.from(...)`,
// so it built a brand-new program every call, and that is the actual leak:
//
// 1. `GlProgram`'s constructor runs `setProgramName` as a preprocessor. On Pixi 8.19.0
//    that helper keeps a module-global name cache and, for any source that does not
//    already contain `#define SHADER_NAME`, appends an INCREMENTING suffix and injects
//    the define into the source text. Our source had none, so the injection fired
//    every time (fixed by the `#define SHADER_NAME` lines on `mtsdfBitGl` above — belt
//    and suspenders alongside the cache here).
// 2. `GlProgram` computes `_key = createIdFromString(vertex + ':' + fragment)` AFTER
//    that preprocessing, so the injected, ever-incrementing name made byte-identical
//    input hash to a DIFFERENT key on every call.
// 3. `GlShaderSystem`'s `_getProgramData` keys its `_programDataHash` cache by that
//    `_key`, so a fresh key is always a cache miss: a brand-new `WebGLProgram` gets
//    compiled and stored, and it stays there — the library has no `gl.deleteProgram`
//    call site anywhere, so nothing ever frees the old one.
//
// The `#define` above closes the name-injection hole, but the root fix is here: build
// the GL/GPU programs ONCE and reuse them. `bits`/`name` passed to the two `compile*`
// calls below are fixed module-level constants (`mtsdfBit`/`mtsdfBitGl` and their
// sibling bits) — none of `makeMtsdfPixiShader`'s arguments (`texture`, `atlas`,
// `style`, `fontSize`) reach the shader SOURCE at all; they only feed `mtsdfUniforms`
// (a `UniformGroup`, rebuilt per call below, as it must be — see the doc comment on
// `MtsdfPixiAtlas.type` and `mtsdfUniformValues`). So there is exactly one distinct
// program pair for the whole file, not a family keyed by some input — a `Map` would
// only ever hold one entry.
let cachedGlProgram: GlProgram | undefined;
let cachedGpuProgram: GpuProgram | undefined;

function getMtsdfPrograms(): { glProgram: GlProgram; gpuProgram: GpuProgram } {
  cachedGlProgram ??= withDerivativesExtension(
    compileHighShaderGlProgram({ name: MTSDF_SHADER_NAME, bits: [localUniformBitGl, textureBitGl, roundPixelsBitGl, mtsdfBitGl] }),
  );
  cachedGpuProgram ??= compileHighShaderGpuProgram({ name: MTSDF_SHADER_NAME, bits: [localUniformBit, textureBit, roundPixelsBit, mtsdfBit] });
  return { glProgram: cachedGlProgram, gpuProgram: cachedGpuProgram };
}

/** Create the Pixi MTSDF Shader for a font atlas. The atlas texture is bound BOTH
 *  ways because the mesh adaptor differs per backend: WebGL reads
 *  `resources.uTexture`, WebGPU rebinds group 2 from `mesh.texture`. Callers must
 *  therefore ALSO set `mesh.texture = <same atlas>`.
 *
 *  The `glProgram`/`gpuProgram` are shared across every call (see `getMtsdfPrograms`
 *  above) — only the `Shader` instance and its uniforms are per-call. */
export function makeMtsdfPixiShader(texture: Texture, atlas: MtsdfPixiAtlas, style: MtsdfStyle, fontSize: number): Shader {
  const { glProgram, gpuProgram } = getMtsdfPrograms();
  const mtsdfUniforms = new UniformGroup(mtsdfUniformValues(style, atlas.width, atlas.height, atlas.distanceRange, atlas.size, fontSize, atlas.type !== 'msdf') as any);
  const shader = new Shader({
    glProgram, gpuProgram,
    resources: {
      uTexture: texture.source,
      uSampler: texture.source.style,
      textureUniforms: { uTextureMatrix: { type: 'mat3x3<f32>', value: new Matrix() } },
      mtsdfUniforms,
    },
  });
  (shader as any)._mtsdfAtlas = atlas;
  return shader;
}

/** Update an existing mtsdf shader's style uniforms in place (no rebuild). */
export function updateMtsdfPixiStyle(shader: Shader, style: MtsdfStyle): void {
  const atlas = (shader as any)._mtsdfAtlas as MtsdfPixiAtlas | undefined;
  if (!atlas) return;
  const u = (shader.resources.mtsdfUniforms as UniformGroup).uniforms as any;
  u.uTextColor = toColorVec(style.color >>> 0, style.opacity ?? 1);
  u.uOutlineColor = toColorVec((style.outlineColor ?? 0) >>> 0, style.outlineOpacity ?? 1);
  u.uGlowColor = toColorVec((style.glowColor ?? 0) >>> 0, 1);
  u.uShadowColor = toColorVec((style.shadowColor ?? 0) >>> 0, style.shadowOpacity ?? 0);
  u.uShadowOffset = new Float32Array([
    clampShadowOffset(style.shadowOffsetX ?? 0, atlas.distanceRange, atlas.size) * atlas.size / atlas.width,
    clampShadowOffset(style.shadowOffsetY ?? 0, atlas.distanceRange, atlas.size) * atlas.size / atlas.height,
  ]);
  u.uWeight = Math.max(0, style.weight ?? 0);
  u.uOutlineWidth = (style.outlineWidth ?? 0) * OUTLINE_MAX_SPREAD;
  u.uGlowSize = (style.glowSize ?? 0) * GLOW_MAX_SPREAD;
  u.uGlowStrength = style.glowStrength ?? 0;
  u.uShadowSoftness = style.shadowSoftness ?? 0;
}

/** Test-only accessor for the two generated shader bits (see the note above `mtsdfBit`). */
export const mtsdfShaderBitsForTest = () => ({ wgsl: mtsdfBit, glsl: mtsdfBitGl });

/** Test-only accessor for the module-level program cache (see `getMtsdfPrograms` above / the
 *  "Program cache (fixes #590)" note) — lets a test assert the GL/GPU programs are actually
 *  SHARED across calls, not just that the cache field exists. */
export const mtsdfProgramsForTest = () => getMtsdfPrograms();
