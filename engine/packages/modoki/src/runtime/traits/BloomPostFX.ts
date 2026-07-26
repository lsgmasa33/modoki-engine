import { trait } from 'koota';

/** BloomPostFX — HDR bloom post-processing config (singleton per scene).
 *  When `enabled`, Scene3D routes the render through the post-FX stack's
 *  bloom stage (`postfx/PostFXStack.ts`) — whole-scene threshold bloom over
 *  the incoming color, including NPR's stylized output when NPR is also
 *  enabled (they compose; see docs/rendering.md "Post-Process Stack"). All
 *  values are live uniforms — changes update in place without rebuilding the
 *  node graph. Requires the WebGPU backend — on WebGL2 the plain render runs
 *  without bloom. */
export const BloomPostFX = trait({
  enabled: false,
  /** Bloom intensity / glow brightness. Higher = brighter bleed. Typical 0.3–1.5. */
  strength: 0.8,
  /** Blur spread of the glow. 0..1. Higher = softer/wider halo. */
  radius: 0.6,
  /** Luminance threshold — only pixels brighter than this contribute to the
   *  bloom. 0 = whole scene blooms (ideal on a near-black void); ~0.8 = only
   *  bright highlights. */
  threshold: 0.0,
});
