import { trait } from 'koota';

/** VignettePostFX — screen-edge darkening config (singleton per scene).
 *  When `enabled`, Scene3D adds a vignette stage to the post-FX stack — see
 *  docs/rendering.md "Vignette & Depth of Field". Composes with bloom, DOF, AO,
 *  and NPR. Values are live uniforms — changes update in place without
 *  rebuilding the node graph. */
export const VignettePostFX = trait({
  enabled: false,
  /** Darkening strength at the screen edge. 0 = no vignette, 1 = edges go black. */
  intensity: 0.4,
  /** Falloff softness of the vignette's radial mask. 0..1 — higher spreads the
   *  darkening further toward the center. */
  smoothness: 0.5,
});
