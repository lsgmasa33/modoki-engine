import { trait } from 'koota';

/** AmbientOcclusionPostFX — screen-space ambient occlusion config (singleton
 *  per scene). When `enabled`, Scene3D adds a GTAO stage to the post-FX
 *  stack — see docs/rendering.md "Ambient Occlusion (GTAO)". Composes with
 *  every other stage. Values are live uniforms — changes update in place
 *  without rebuilding the node graph.
 *
 *  Always forces the scene pass's 'normal' MRT target (same one NPR already
 *  forces) — GTAO's alternative depth-only normal reconstruction is broken
 *  under this renderer's multisampled depth buffer (a WGSL codegen gap, not
 *  a wiring choice; see `stackPlan.ts`'s `requiredMrtTargets`). A custom-
 *  shader `NodeMaterial` combined with AO on the (previously MRT-free) plain
 *  path must emit both MRT targets or its draw is silently dropped. */
export const AmbientOcclusionPostFX = trait({
  enabled: false,
  /** World-space sample radius for the occlusion horizon search. */
  radius: 0.25,
  /** 0 = no darkening, 1 = full raw occlusion. */
  intensity: 1,
  /** Fraction of the drawing buffer the GTAO pass renders at — its dominant cost on a mobile GPU
   *  (#962: full-resolution GTAO made postfx-demo slow on an Adreno 730). 1 = full resolution,
   *  three's own default and today's behaviour; 0.5 renders a quarter of the pixels, which three
   *  documents as sufficient for most scenes. Live — no stack rebuild. */
  resolutionScale: 1,
  /** Horizon samples per pixel (three's default 16). Fewer is cheaper and noisier; below 30 three
   *  searches 3 directions, from 30 it searches 5. Live — it is a uniform. */
  samples: 16,
});
