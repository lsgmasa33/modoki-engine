// HMR: see NPRPostProcess.ts — TSL nodes baked into compiled pipelines can't
// safely hot-reload.
if (import.meta.hot) import.meta.hot.invalidate();

/** Sobel edge-detection helpers as TSL nodes.
 *
 *  Three flavors:
 *    - sobelDepth(depthTextureNode, texelSize)      → float, on linearized view-space Z
 *    - sobelNormal(normalTextureNode, texelSize)    → float, on packed view-space normal
 *    - sobelLuminance(colorTextureNode, texelSize)  → float, on Rec.709 luminance
 *
 *  Each returns a 0..∞ magnitude. Callers threshold via `smoothstep` to clean
 *  the line mask. The same 3x3 stencil is used for all three so feature
 *  alignment is consistent. */

import {
  vec2, abs, max, sqrt, luminance, screenUV,
  cameraNear, cameraFar, perspectiveDepthToViewZ, orthographicDepthToViewZ,
} from 'three/tsl';

// TSL node types are statically narrow but the graph is dynamic — relax at
// boundaries to avoid fighting the type system on every line.
type AnyNode = any;

/** Resolve a TextureNode's base UV — defaults to `screenUV` when the node
 *  was created without one (true for raw `getTextureNode('depth')`). */
function baseUVOf(textureNode: AnyNode): AnyNode {
  return textureNode.uvNode ?? screenUV;
}

/** Sample a TextureNode at a UV-space offset. */
function sampleAt(textureNode: AnyNode, baseUV: AnyNode, offset: AnyNode): AnyNode {
  return textureNode.sample(baseUV.add(offset));
}

/** Run the standard 3x3 Sobel kernel on a per-sample scalar function `s(u, v)`.
 *  Returns sqrt(Gx^2 + Gy^2). */
function sobelScalar(s: (du: number, dv: number) => AnyNode): AnyNode {
  const tx0y0 = s(-1, -1), tx1y0 = s(0, -1), tx2y0 = s(1, -1);
  const tx0y1 = s(-1,  0),                  tx2y1 = s(1,  0);
  const tx0y2 = s(-1,  1), tx1y2 = s(0,  1), tx2y2 = s(1,  1);

  // Gx = [-1 0 1; -2 0 2; -1 0 1]
  const gx = tx2y0.add(tx2y1.mul(2)).add(tx2y2)
       .sub(tx0y0).sub(tx0y1.mul(2)).sub(tx0y2);
  // Gy = [-1 -2 -1; 0 0 0; 1 2 1]
  const gy = tx0y2.add(tx1y2.mul(2)).add(tx2y2)
       .sub(tx0y0).sub(tx1y0.mul(2)).sub(tx2y0);

  return sqrt(gx.mul(gx).add(gy.mul(gy)));
}

/** Luminance Sobel (texture/color seams). */
export const sobelLuminance = (colorTextureNode: any, texelSize: any): any => {
  const baseUV = baseUVOf(colorTextureNode);
  const lum = (du: number, dv: number) =>
    luminance(sampleAt(colorTextureNode, baseUV, texelSize.mul(vec2(du, dv))).xyz);
  return sobelScalar(lum);
};

/** Normal Sobel (creases). Operates on the packed view-space normal — for
 *  edge magnitude the pack offset/scale cancels out, so unpacking is
 *  unnecessary. Takes the max magnitude over X/Y/Z channels so an angle
 *  change in any axis registers. */
export const sobelNormal = (normalTextureNode: any, texelSize: any): any => {
  const baseUV = baseUVOf(normalTextureNode);
  const sample = (du: number, dv: number): AnyNode =>
    sampleAt(normalTextureNode, baseUV, texelSize.mul(vec2(du, dv)));

  const tx0y0 = sample(-1, -1), tx1y0 = sample(0, -1), tx2y0 = sample(1, -1);
  const tx0y1 = sample(-1,  0),                       tx2y1 = sample(1,  0);
  const tx0y2 = sample(-1,  1), tx1y2 = sample(0,  1), tx2y2 = sample(1,  1);

  const gx = tx2y0.add(tx2y1.mul(2)).add(tx2y2)
       .sub(tx0y0).sub(tx0y1.mul(2)).sub(tx0y2);
  const gy = tx0y2.add(tx1y2.mul(2)).add(tx2y2)
       .sub(tx0y0).sub(tx1y0.mul(2)).sub(tx2y0);

  const magX = sqrt(gx.x.mul(gx.x).add(gy.x.mul(gy.x)));
  const magY = sqrt(gx.y.mul(gx.y).add(gy.y.mul(gy.y)));
  const magZ = sqrt(gx.z.mul(gx.z).add(gy.z.mul(gy.z)));
  return max(max(magX, magY), magZ);
};

/** Depth Sobel (silhouettes / object boundaries).
 *
 *  Samples raw depth at 9 offsets, linearizes each to view-space Z, then Sobels.
 *  Linearizing first means a fixed depthThreshold value behaves consistently
 *  across the depth range.
 *
 *  Linearization is projection-dependent: a perspective camera's depth buffer is
 *  non-linear (1/z hyperbolic), an orthographic camera's is already linear in z.
 *  Using `perspectiveDepthToViewZ` under an ortho camera (editor SceneView can use
 *  one) would warp the view-Z and so misfire the silhouette threshold (F10). We
 *  pick the matching `*DepthToViewZ` reconstructor up-front from the build-time
 *  camera type — `isOrthographic` is a plain JS boolean known when the node graph
 *  is built, so this is a static branch, not a per-pixel one. */
export const sobelDepth = (depthTextureNode: any, texelSize: any, isOrthographic = false): any => {
  const baseUV = baseUVOf(depthTextureNode);
  const depthToViewZ = isOrthographic ? orthographicDepthToViewZ : perspectiveDepthToViewZ;
  // Magnitude of view-space Z, not raw Z — abs() so threshold is direction-agnostic.
  const vz = (du: number, dv: number): AnyNode => {
    const sampled = sampleAt(depthTextureNode, baseUV, texelSize.mul(vec2(du, dv))).x;
    return abs(depthToViewZ(sampled, cameraNear, cameraFar));
  };
  return sobelScalar(vz);
};
