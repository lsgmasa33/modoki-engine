import { trait } from 'koota';

/** DepthOfFieldPostFX — camera-focus blur config (singleton per scene). When
 *  `enabled`, Scene3D adds a DOF stage to the post-FX stack (post-process-
 *  stack-plan.md Phase 2). Composes with bloom/vignette (and, once Phase 3
 *  lands, NPR). Values are live uniforms — changes update in place without
 *  rebuilding the node graph.
 *
 *  ⚠️ On an orthographic camera the stack reconstructs view-space depth with
 *  `orthographicDepthToViewZ` instead of three's default perspective-only
 *  `PassNode.getViewZNode()` — see `postfx/dofViewZ.ts`. */
export const DepthOfFieldPostFX = trait({
  enabled: false,
  /** Distance along the camera's look direction (world units) that stays in focus. */
  focusDistance: 10,
  /** How far (world units) from the focus distance before it's fully out of
   *  focus. Smaller = shallower depth of field. */
  focalLength: 1,
  /** Unitless artistic multiplier on bokeh circle size. */
  bokehScale: 1,
});
