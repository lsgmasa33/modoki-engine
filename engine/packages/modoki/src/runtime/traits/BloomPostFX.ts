import { trait } from 'koota';

/** BloomPostFX — HDR bloom post-processing config (singleton per scene).
 *  When `enabled` AND NPR is off, Scene3D routes the plain forward render
 *  through a TSL bloom composer (whole-scene threshold bloom over `pass(scene,
 *  camera)`). All values are live uniforms on the underlying three BloomNode —
 *  changes update in place without rebuilding the node graph.
 *
 *  Mutually exclusive with NPRPostFX for now: if BOTH are enabled the NPR
 *  branch wins and bloom is skipped (composing bloom after the NPR stylize
 *  pass is out of scope). Requires the WebGPU backend — on WebGL2 the plain
 *  render runs without bloom. */
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
