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
import type { MtsdfStyle } from './mtsdfStyle';
import { GLOW_MAX_SPREAD, OUTLINE_MAX_SPREAD } from './mtsdfStyle';

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
  const F = (n: number) => (gpu ? `${f}(${n})` : n.toFixed(1)); // float literal
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
    ${d(f)}asd = s.a;
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
    ${d(v2)}screenTexSize = ${v2}(${F(1)}) / fwidth(vUV);
    ${d(f)}spr = max(${F(0.5)} * dot(unitRange, screenTexSize), ${F(1)});
    ${d(f)}edge = ${F(0.5)} - ${M}uWeight;
    ${d(f)}fill = clamp((sd - edge) * spr + ${F(0.5)}, ${F(0)}, ${F(1)});

    ${d(v3, true)}rgb = ${M}uTextColor.rgb;
    ${d(f, true)}alpha = ${M}uTextColor.a * fill;

    // ── OUTLINE (median, masked so width 0 = off): fill OVER outline. The inner
    // threshold is FLOORED at the field budget (0.5 - OUTLINE_MAX_SPREAD) so a
    // positive weight (which lowers 'edge') can't push the band past the field's
    // outer saturation and flood the glyph quad (the black-rect bug).
    ${d(f)}outlineMask = step(${F(0.00001)}, ${M}uOutlineWidth);
    ${d(f)}outlineLo = max(edge - ${M}uOutlineWidth, ${F(0.5 - OUTLINE_MAX_SPREAD)});
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
    ${d(f)}shSoft = smoothstep(edge - ${M}uShadowSoftness, edge, shTex.a);
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
      };
      @group(3) @binding(0) var<uniform> mtsdfUniforms: MtsdfUniforms;
    `,
    main: mtsdfBody('wgsl'),
  },
};

/** The custom bit (GLSL). Uniforms are loose (Pixi's GL UBO handling maps them to
 *  the `mtsdfUniforms` group by name — names are unique across all bits). */
const mtsdfBitGl = {
  name: 'mtsdf-bit',
  vertex: {
    header: /* glsl */`in vec4 aTextColor;`,
    main: /* glsl */`vColor *= vec4(aTextColor.rgb * aTextColor.a, aTextColor.a);`,
  },
  fragment: {
    header: /* glsl */`
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
function mtsdfUniformValues(style: MtsdfStyle, atlasW: number, atlasH: number, distanceRange: number, atlasSize: number) {
  return {
    uTextColor: { value: toColorVec(style.color >>> 0, style.opacity ?? 1), type: 'vec4<f32>' },
    uOutlineColor: { value: toColorVec((style.outlineColor ?? 0) >>> 0, style.outlineOpacity ?? 1), type: 'vec4<f32>' },
    uGlowColor: { value: toColorVec((style.glowColor ?? 0) >>> 0, 1), type: 'vec4<f32>' },
    uShadowColor: { value: toColorVec((style.shadowColor ?? 0) >>> 0, style.shadowOpacity ?? 0), type: 'vec4<f32>' },
    uShadowOffset: { value: new Float32Array([(style.shadowOffsetX ?? 0) * atlasSize / atlasW, (style.shadowOffsetY ?? 0) * atlasSize / atlasH]), type: 'vec2<f32>' },
    uTexSize: { value: new Float32Array([atlasW, atlasH]), type: 'vec2<f32>' },
    uWeight: { value: Math.max(0, style.weight ?? 0), type: 'f32' }, // negative disabled (nicks corners)
    uOutlineWidth: { value: (style.outlineWidth ?? 0) * OUTLINE_MAX_SPREAD, type: 'f32' },
    uGlowSize: { value: (style.glowSize ?? 0) * GLOW_MAX_SPREAD, type: 'f32' },
    uGlowStrength: { value: style.glowStrength ?? 0, type: 'f32' },
    uShadowSoftness: { value: style.shadowSoftness ?? 0, type: 'f32' },
    uDistanceRange: { value: distanceRange, type: 'f32' },
  };
}

/** The atlas geometry a shader is built against — needed to re-derive the shadow
 *  UV offset when the style changes. */
export interface MtsdfPixiAtlas { width: number; height: number; distanceRange: number; size: number }

/** Create the Pixi MTSDF Shader for a font atlas. The atlas texture is bound BOTH
 *  ways because the mesh adaptor differs per backend: WebGL reads
 *  `resources.uTexture`, WebGPU rebinds group 2 from `mesh.texture`. Callers must
 *  therefore ALSO set `mesh.texture = <same atlas>`. */
export function makeMtsdfPixiShader(texture: Texture, atlas: MtsdfPixiAtlas, style: MtsdfStyle): Shader {
  const glProgram = compileHighShaderGlProgram({ name: 'mtsdf-text', bits: [localUniformBitGl, textureBitGl, roundPixelsBitGl, mtsdfBitGl] });
  const gpuProgram = compileHighShaderGpuProgram({ name: 'mtsdf-text', bits: [localUniformBit, textureBit, roundPixelsBit, mtsdfBit] });
  const mtsdfUniforms = new UniformGroup(mtsdfUniformValues(style, atlas.width, atlas.height, atlas.distanceRange, atlas.size) as any);
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
  u.uShadowOffset = new Float32Array([(style.shadowOffsetX ?? 0) * atlas.size / atlas.width, (style.shadowOffsetY ?? 0) * atlas.size / atlas.height]);
  u.uWeight = Math.max(0, style.weight ?? 0);
  u.uOutlineWidth = (style.outlineWidth ?? 0) * OUTLINE_MAX_SPREAD;
  u.uGlowSize = (style.glowSize ?? 0) * GLOW_MAX_SPREAD;
  u.uGlowStrength = style.glowStrength ?? 0;
  u.uShadowSoftness = style.shadowSoftness ?? 0;
}
