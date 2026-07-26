// HMR: this module's TSL nodes bake into compiled WGSL pipelines, so an edit here needs a full
// RELOAD, not a hot patch. The dev server forces one by path (isShaderGraphFile in
// plugins/vite-asset-scanner.ts). Do NOT re-add `import.meta.hot.invalidate()` — it only
// propagates to importers and was silently swallowed by Scene3D.tsx's Fast Refresh boundary,
// which is exactly how a correct shader fix ended up looking broken.

/** View-space depth reconstruction for the DOF stage (post-process-stack-
 *  plan.md Phase 2).
 *
 *  ⚠️ `PassNode.getViewZNode()` hardcodes `perspectiveDepthToViewZ` — there
 *  is no orthographic branch (verified against the installed three source).
 *  Using it under an orthographic camera (the editor SceneView can use one)
 *  would warp view-Z and blur the wrong things — exactly the F10 hazard
 *  `npr/edgeNodes.ts`'s `sobelDepth` already solves for the NPR Sobel pass.
 *  This mirrors that fix for DOF: pick the matching `*DepthToViewZ`
 *  reconstructor from the build-time camera type (a plain JS boolean known
 *  when the node graph is built, so this is a static branch, not per-pixel). */

import { perspectiveDepthToViewZ, orthographicDepthToViewZ } from 'three/tsl';

// TSL node types are statically narrow but the graph is dynamic — relax at
// the boundary rather than fight the type system (same convention as edgeNodes.ts).
type AnyNode = any;

/** `depthTextureNode` is a TextureNode sampled at its default UV (mirrors
 *  `PassNode.getViewZNode()`'s own `perspectiveDepthToViewZ(this.getTextureNode(name), ...)`
 *  call — no explicit `.sample()` needed).
 *
 *  ⚠️ **`nearNode`/`farNode` MUST be the SCENE camera's near/far, passed in as uniforms the
 *  caller owns and updates — never TSL's global `cameraNear`/`cameraFar`.** Those globals
 *  resolve from whatever camera is rendering the CURRENT pass, and DOF's circle-of-confusion
 *  pass is a full-screen QUAD with its own camera — so they resolve to the quad's near/far,
 *  not the scene camera's. The reconstructed viewZ is then meaningless and effectively
 *  constant across the frame, which reads as "every object blurs by the same amount, near
 *  and far alike, and moving focusDistance changes them all together" — i.e. depth-of-field
 *  with no depth. It also makes the effect completely ignore the scene camera's `near`
 *  (changing it 0.1 → 0.5 does nothing), which is the giveaway when diagnosing.
 *  three's own `PassNode.getViewZNode()` avoids this by using the pass's private
 *  `_cameraNear`/`_cameraFar` uniforms; we can't reach those, hence the explicit params. */
export function buildViewZNode(
  depthTextureNode: AnyNode,
  isOrthographic: boolean,
  nearNode: AnyNode,
  farNode: AnyNode,
): AnyNode {
  const depthToViewZ = isOrthographic ? orthographicDepthToViewZ : perspectiveDepthToViewZ;
  return depthToViewZ(depthTextureNode, nearNode, farNode);
}
