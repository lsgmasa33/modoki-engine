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

/** Text style → shader uniforms. Colors are 0xRRGGBB; opacities 0..1. */
export interface MtsdfStyle {
  color: number;
  opacity?: number;
  /** Edge shift: >0 bolder, <0 thinner. Range ~[-0.3, 0.3]. */
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
