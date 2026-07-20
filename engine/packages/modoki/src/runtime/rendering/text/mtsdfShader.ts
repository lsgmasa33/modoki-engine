/** MTSDF text shader — the shared distance-field sampling + effect compositing.
 *
 *  Fill uses the median of the RGB channels (sharp corners); soft effects (outline,
 *  glow) use the **alpha channel** (a true SDF, present only in `mtsdf`) so they
 *  stay smooth where the RGB median would ring at corners. `screenPxRange` converts
 *  the field to screen-pixel space for resolution-independent AA via `fwidth` — fed
 *  a `uTexSize` uniform (not GLSL3 `textureSize`) so the exact same fragment body
 *  works in WebGL1/2 AND can be reused for the Pixi 2D path (Phase 5).
 *
 *  This module owns the Three.js material; the fragment GLSL is exported for the
 *  Pixi shader to reuse. Effects are threshold bands around the 0.5 edge:
 *    weight  — shifts the edge (bolder/thinner)
 *    outline — a second band outside the fill, `uOutlineWidth` wide
 *    glow    — a wide soft band, smoothstepped, composited under the glyph
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { texture as texNode, uniform, uv, vec2, float, max, min, clamp, mix, smoothstep, dot, fwidth, step, attribute } from 'three/tsl';

// The style shape + spread budgets live in a three-FREE module so the Pixi 2D text
// shader can share them without dragging `three/webgpu` into a 2D-only build. Re-export
// here so existing 3D consumers (scene3DSync) keep their single import site.
import { GLOW_MAX_SPREAD, OUTLINE_MAX_SPREAD, type MtsdfStyle } from './mtsdfStyle';
export { GLOW_MAX_SPREAD, OUTLINE_MAX_SPREAD, type MtsdfStyle } from './mtsdfStyle';

/** The MTSDF fragment body (GLSL, WebGL1/2-portable). Reused by the Pixi shader. */
export const MTSDF_FRAGMENT_GLSL = /* glsl */`
float mtsdfMedian(vec3 s){ return max(min(s.r, s.g), min(max(s.r, s.g), s.b)); }

vec4 mtsdfResolve(
  vec4 texel, vec2 uv,
  vec2 texSize, float distanceRange,
  vec4 color, float weight,
  vec4 outlineColor, float outlineWidth,
  vec4 glowColor, float glowSize, float glowStrength
){
  float sd  = mtsdfMedian(texel.rgb); // crisp fill distance
  float asd = texel.a;                // true SDF for soft effects (mtsdf)

  vec2 unitRange = vec2(distanceRange) / texSize;
  vec2 screenTexSize = vec2(1.0) / fwidth(uv);
  float spr = max(0.5 * dot(unitRange, screenTexSize), 1.0);

  float edge = 0.5 - weight;
  float fill = clamp((sd - edge) * spr + 0.5, 0.0, 1.0);

  vec3 rgb = color.rgb;
  float alpha = color.a * fill;

  if (outlineWidth > 0.0) {
    // Straight-alpha 'over' composite: fill OVER outline. (A max()/mix()
    // approximation forces a translucent fill's interior opaque whenever the
    // outline is more opaque — breaks fading text with an outline.)
    float outline = clamp((asd - (edge - outlineWidth)) * spr + 0.5, 0.0, 1.0);
    float fa = color.a * fill;
    float oa = outlineColor.a * outline;
    float outA = fa + oa * (1.0 - fa);
    vec3 pre = color.rgb * fa + outlineColor.rgb * oa * (1.0 - fa);
    rgb = outA > 0.0 ? pre / outA : color.rgb;
    alpha = outA;
  }

  if (glowSize > 0.0) {
    float glow = smoothstep(edge - glowSize, edge, asd) * glowStrength;
    float ga = glowColor.a * glow;
    float outA = alpha + ga * (1.0 - alpha);
    vec3 outRgb = rgb * alpha + glowColor.rgb * ga * (1.0 - alpha);
    rgb = outA > 0.0 ? outRgb / outA : rgb;
    alpha = outA;
  }

  return vec4(rgb, alpha);
}
`;

// TSL node graphs mix float/vec types freely (a float `.div` a vec2, `dot` of two
// vec2s, texture swizzles); the strict TSL TS types fight that in glue code, so the
// uniform handles + graph nodes here are intentionally loose. `.value` is still
// accessed typed in updateMtsdfStyle via a cast.
/* eslint-disable @typescript-eslint/no-explicit-any */
type TUniform = any;

/** TSL uniform handles stashed on the material so {@link updateMtsdfStyle} can
 *  mutate them without rebuilding the node graph. */
interface MtsdfUniforms {
  color: TUniform;
  opacity: TUniform;
  weight: TUniform;
  outlineColor: TUniform;
  outlineOpacity: TUniform;
  outlineWidth: TUniform;
  glowColor: TUniform;
  glowSize: TUniform;
  glowStrength: TUniform;
  shadowColor: TUniform;
  shadowOpacity: TUniform;
  shadowSoftness: TUniform;
  /** Shadow offset in UV space (em × atlasSize/atlasDim). */
  shadowOffset: TUniform;
}
const uni = (v: unknown): TUniform => uniform(v as never);
/** em→UV scale for the shadow offset — the atlas renders `size` px/em, so 1 em is
 *  `size/atlasDim` in UV. Constant across glyphs (all baked at the same size). */
function shadowUvOffset(style: MtsdfStyle, atlasSize: number, atlasW: number, atlasH: number): THREE.Vector2 {
  return new THREE.Vector2(
    (style.shadowOffsetX ?? 0) * atlasSize / atlasW,
    (style.shadowOffsetY ?? 0) * atlasSize / atlasH,
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Create the Three MTSDF material as a TSL NodeMaterial — REQUIRED: the engine
 *  renders with WebGPURenderer (r184, NPR), which rejects a raw GLSL ShaderMaterial
 *  ("Material ShaderMaterial is not compatible"). TSL `Fn` transpiles to both WGSL
 *  and GLSL, so this works on the WebGPU backend AND its WebGL2 fallback. Fill uses
 *  the RGB median; outline/glow use the alpha channel (mtsdf true SDF); effects are
 *  branchless (masked by `step` so width/size 0 contributes nothing). Double-sided
 *  (Y-up geometry flip), alpha-blended, no depth write (text over the scene). */
export function makeMtsdfMaterial(
  tex: THREE.Texture,
  atlasWidth: number,
  atlasHeight: number,
  distanceRange: number,
  atlasSize: number,
  style: MtsdfStyle,
): THREE.Material {
  const u: MtsdfUniforms = {
    color: uni(new THREE.Color(style.color >>> 0)),
    opacity: uni(style.opacity ?? 1),
    weight: uni(Math.max(0, style.weight ?? 0)), // negative (erode-to-thinner) disabled — nicks corners
    outlineColor: uni(new THREE.Color((style.outlineColor ?? 0) >>> 0)),
    outlineOpacity: uni(style.outlineOpacity ?? 1),
    outlineWidth: uni((style.outlineWidth ?? 0) * OUTLINE_MAX_SPREAD),
    glowColor: uni(new THREE.Color((style.glowColor ?? 0) >>> 0)),
    glowSize: uni((style.glowSize ?? 0) * GLOW_MAX_SPREAD),
    glowStrength: uni(style.glowStrength ?? 0),
    shadowColor: uni(new THREE.Color((style.shadowColor ?? 0) >>> 0)),
    shadowOpacity: uni(style.shadowOpacity ?? 0),
    shadowSoftness: uni(style.shadowSoftness ?? 0),
    shadowOffset: uni(shadowUvOffset(style, atlasSize, atlasWidth, atlasHeight)),
  };
  const uTexSize = uni(new THREE.Vector2(atlasWidth, atlasHeight));
  const uDistanceRange = uni(distanceRange);

  const mat = new MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.side = THREE.DoubleSide;

  // Build the node graph directly (no Fn wrapper) and assign color/opacity nodes.
  const vUv = uv();
  const median = (t: TUniform) => max(min(t.r, t.g), min(max(t.r, t.g), t.b));
  const s = texNode(tex, vUv);
  const asd = s.a;        // true SDF (mtsdf) — soft effects
  // mtsdf corner-clash correction (see mtsdfPixiShader for the full rationale): at acute
  // corners the fill/outline MEDIAN nicks BELOW the true-SDF alpha — pull it UP to the
  // alpha, gated on being at/inside the edge so tight counters (alpha speckles high /
  // median correctly low) aren't filled and convex corners (median > alpha) stay sharp.
  const rawSd = median(s);
  const clashUp = max(float(0.0), asd.sub(rawSd));
  const insideGate = smoothstep(float(0.4), float(0.55), rawSd);
  const sd = rawSd.add(clashUp.mul(insideGate));

  // screenPxRange for resolution-independent AA (uTexSize uniform, not GLSL3
  // textureSize, so it's backend-portable).
  const unitRange = uDistanceRange.div(uTexSize);
  const screenTexSize = vec2(1.0, 1.0).div(fwidth(vUv));
  const spr = max(dot(unitRange, screenTexSize).mul(0.5), float(1.0));
  const edge = float(0.5).sub(u.weight);
  const fill = clamp(sd.sub(edge).mul(spr).add(0.5), 0.0, 1.0);
  const fa = u.opacity.mul(fill);

  // ── CONTENT: fill OVER outline. Outline uses the MEDIAN (sd), NOT the alpha SDF —
  // a sharp outline wants the same clash-free field the fill uses (the alpha true-SDF
  // speckles in tight interior corners like the g counter). Masked so width 0 = off.
  const outlineMask = step(float(1e-5), u.outlineWidth);
  // Inner threshold FLOORED at the field budget so a positive weight (lower 'edge')
  // can't push the band past the field's outer saturation and flood the glyph quad.
  const outlineLo = max(edge.sub(u.outlineWidth), float(0.5 - OUTLINE_MAX_SPREAD));
  const outline = clamp(sd.sub(outlineLo).mul(spr).add(0.5), 0.0, 1.0);
  const oa = u.outlineOpacity.mul(outline).mul(outlineMask);
  const contentA = fa.add(oa.mul(float(1.0).sub(fa)));
  const contentRgb = u.color.mul(fa).add(u.outlineColor.mul(oa).mul(float(1.0).sub(fa)))
    .div(max(contentA, float(1e-4)));

  // ── GLOW: soft band (alpha SDF), masked so size 0 = off.
  // Gated by (1 - fill) so glow lives strictly OUTSIDE the clean MEDIAN silhouette:
  // the glow reads the alpha true-SDF, which dips inward at tight concave corners and
  // would speckle through the fill's AA seam. The median fill has no such dip.
  const glowMask = step(float(1e-5), u.glowSize);
  const glowLo = max(edge.sub(u.glowSize), float(0.5 - GLOW_MAX_SPREAD));
  const glowA = smoothstep(glowLo, edge, asd).mul(u.glowStrength).mul(glowMask).mul(float(1.0).sub(fill));

  // ── SHADOW: the glyph silhouette sampled at an OFFSET UV, behind everything. Crisp
  // via the median when softness 0, soft via the alpha SDF otherwise. Masked on opacity.
  const shadowMask = step(float(1e-5), u.shadowOpacity);
  const shUv = vUv.sub(u.shadowOffset);
  const shTex = texNode(tex, shUv);
  const shCrisp = clamp(median(shTex).sub(edge).mul(spr).add(0.5), 0.0, 1.0);
  const shSoft = smoothstep(edge.sub(u.shadowSoftness), edge, shTex.a);
  const shCov = mix(shCrisp, shSoft, step(float(1e-5), u.shadowSoftness));
  const shadowA = u.shadowOpacity.mul(shCov).mul(shadowMask);

  // ── COMPOSITE: content OVER glow OVER shadow (straight-alpha 'over' at each step).
  const midA = glowA.add(shadowA.mul(float(1.0).sub(glowA)));
  const midRgb = u.glowColor.mul(glowA).add(u.shadowColor.mul(shadowA).mul(float(1.0).sub(glowA)))
    .div(max(midA, float(1e-4)));
  const outA = contentA.add(midA.mul(float(1.0).sub(contentA)));
  const outRgb = contentRgb.mul(contentA).add(midRgb.mul(midA).mul(float(1.0).sub(contentA)))
    .div(max(outA, float(1e-4)));

  // Per-glyph colour MULTIPLIER (aTextColor vertex attribute, white by default → no
  // change): rgb tint (rainbow) × alpha fade. Animated by colour effects; static text
  // carries all-white so this is a no-op.
  const vCol: TUniform = attribute('aTextColor', 'vec4');
  mat.colorNode = outRgb.mul(vCol.xyz);
  mat.opacityNode = outA.mul(vCol.w);
  const store = (mat as THREE.Material & { userData: MtsdfUserData }).userData;
  store.mtsdfUniforms = u;
  store.mtsdfShadowScale = new THREE.Vector2(atlasSize / atlasWidth, atlasSize / atlasHeight);
  return mat;
}

interface MtsdfUserData { mtsdfUniforms?: MtsdfUniforms; mtsdfShadowScale?: THREE.Vector2 }

/** Update an existing material's style uniforms in place (renderer calls this when
 *  a Text trait's style fields change — no node-graph rebuild). */
export function updateMtsdfStyle(mat: THREE.Material, style: MtsdfStyle): void {
  const store = (mat as THREE.Material & { userData: MtsdfUserData }).userData;
  const u = store.mtsdfUniforms;
  if (!u) return;
  (u.color.value as THREE.Color).setHex(style.color >>> 0);
  u.opacity.value = style.opacity ?? 1;
  u.weight.value = Math.max(0, style.weight ?? 0);
  (u.outlineColor.value as THREE.Color).setHex((style.outlineColor ?? 0) >>> 0);
  u.outlineOpacity.value = style.outlineOpacity ?? 1;
  u.outlineWidth.value = (style.outlineWidth ?? 0) * OUTLINE_MAX_SPREAD;
  (u.glowColor.value as THREE.Color).setHex((style.glowColor ?? 0) >>> 0);
  u.glowSize.value = (style.glowSize ?? 0) * GLOW_MAX_SPREAD;
  u.glowStrength.value = style.glowStrength ?? 0;
  (u.shadowColor.value as THREE.Color).setHex((style.shadowColor ?? 0) >>> 0);
  u.shadowOpacity.value = style.shadowOpacity ?? 0;
  u.shadowSoftness.value = style.shadowSoftness ?? 0;
  const scale = store.mtsdfShadowScale;
  if (scale) (u.shadowOffset.value as THREE.Vector2).set((style.shadowOffsetX ?? 0) * scale.x, (style.shadowOffsetY ?? 0) * scale.y);
}
