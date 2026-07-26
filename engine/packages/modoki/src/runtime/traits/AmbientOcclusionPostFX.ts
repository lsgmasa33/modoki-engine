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
});
