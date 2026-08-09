/** MTSDF text style + shared spread budgets — the three-FREE common ground of the
 *  MTSDF text stack. Both the Three.js path ({@link mtsdfShader}, which imports
 *  `three/webgpu`) and the PixiJS 2D path ({@link mtsdfPixiShader}) need the style
 *  shape and the two spread constants; keeping them here (no `three` import) lets a
 *  2D-only build pull the Pixi text shader WITHOUT dragging `three/webgpu` in. */

/** The internal SDF-unit budget a normalized `glowSize` of 1.0 maps to. 0.5 is the
 *  outer half of the field (edge=0.5 → saturated-0); AT exactly 0.5 the glow ramp
 *  reaches the field's outer edge and faint quad-rectangle haloing just begins, so
 *  we sit a hair under it. The UI exposes glowSize as 0..1 (natural) and the shader
 *  scales by this, keeping the WHOLE slider range comfortably seam-free. */
export const GLOW_MAX_SPREAD = 0.45;

/** The internal SDF-unit budget a normalized `outlineWidth` of 1.0 maps to. The
 *  outline is a HARD band `edge-width..edge` in the median field; at width 0.5 its
 *  inner threshold hits SDF value 0 (the field's outer-saturation point), so every
 *  outside texel — the whole glyph quad — reads constant ~50% coverage: the black
 *  quad-rectangles. We cap a hair lower than glow (0.4 vs 0.45) because the hard
 *  edge makes any plateau far more visible than glow's soft ramp. The UI exposes
 *  outlineWidth as 0..1; the shader scales by this. */
export const OUTLINE_MAX_SPREAD = 0.4;

/** The largest drop-shadow offset (in em, per axis) an atlas can actually represent.
 *
 *  The shadow is an OFFSET SAMPLE of the same atlas — there is no second draw — so it can
 *  only reach as far as the transparent padding baked around each glyph. Past that it
 *  samples the NEIGHBOURING glyph and paints fragments of unrelated letterforms; where the
 *  offset drives UV negative, clamp-to-edge smears a constant band instead (the reported
 *  "shadow renders a box"). Both are silent — nothing errors.
 *
 *  The padding is `pxpadding`, which the bake sets equal to `pxRange` (`distanceRange`),
 *  so the budget is `distanceRange / atlasSize` em. Measured on Geologica-Bold
 *  (24/128 = 0.1875 em): 0.05 clean, 0.15 fine, 0.30 garbled, 0.50 disconnected fragments
 *  of other glyphs — the predicted breakpoint. See #189.
 *
 *  A larger shadow therefore needs a larger `pxRange` on the FONT, which the Font
 *  Inspector now states outright rather than leaving to be discovered. */
export function maxShadowOffsetEm(distanceRange: number, atlasSize: number): number {
  if (!(atlasSize > 0)) return 0;
  return Math.max(0, distanceRange) / atlasSize;
}

/** Clamp one shadow-offset axis into {@link maxShadowOffsetEm}, preserving direction. */
export function clampShadowOffset(v: number, distanceRange: number, atlasSize: number): number {
  const lim = maxShadowOffsetEm(distanceRange, atlasSize);
  return Math.max(-lim, Math.min(lim, v || 0));
}

/** Text style → shader uniforms. Colors are 0xRRGGBB; opacities 0..1. */
export interface MtsdfStyle {
  color: number;
  opacity?: number;
  /** Faux-bold: shifts the fill threshold OUTWARD, in distance-field units. 0 = the
   *  glyph as drawn; useful range ~[0, 0.25].
   *
   *  ⚠️ **NOT resolution-independent, and this is the single most confusing thing about
   *  the text knobs.** One field unit is `distanceRange / size` em, so the SAME value
   *  bolds by `weight × pxRange / size` em — three times as much on a pxRange-24 font as
   *  on a pxRange-8 one at the same glyph size. `outlineWidth`, `glowSize` and the shadow
   *  offset are budgeted from the same ratio (see {@link maxShadowOffsetEm}); the Font
   *  Inspector's Effect budget panel is where it is stated to the author.
   *
   *  ⚠️ **Negative is CLAMPED TO 0 by both shaders** — eroding a rasterized glyph nicks
   *  sharp corners, so thinning is a font-import choice (a lighter `variationAxes.wght`,
   *  or the family's Light weight), not a per-entity one. The Inspector's minimum is 0;
   *  a scene, prefab or code path can still author a negative and it does nothing. */
  weight?: number;
  outlineColor?: number;
  /** Outline band width, NORMALIZED 0..1 (0 = off, 1 = the max seam-free width).
   *  Scaled to the shader's internal SDF budget {@link OUTLINE_MAX_SPREAD} — mirrors
   *  {@link glowSize} so neither effect can flood the glyph quad (the black-rect bug). */
  outlineWidth?: number;
  outlineOpacity?: number;
  glowColor?: number;
  /** Glow spread, NORMALIZED 0..1 (0 = off, 1 = the max seam-free spread). Scaled
   *  to the shader's internal SDF budget {@link GLOW_MAX_SPREAD} — 1.0 reaches the
   *  outer-saturation point of the field (SDF value 0), which is exactly where a
   *  per-quad glow would start bleeding to the glyph-quad rectangle. */
  glowSize?: number;
  glowStrength?: number;
  shadowColor?: number;
  /** Drop-shadow opacity. 0 = off. */
  shadowOpacity?: number;
  /** Shadow offset in em (+x right, +y down). */
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  /** Shadow edge softness (~0..0.4). 0 = crisp offset silhouette. */
  shadowSoftness?: number;
}
