// HMR: see NPRPostProcess.ts — TSL nodes baked into compiled pipelines can't
// safely hot-reload.
if (import.meta.hot) import.meta.hot.invalidate();

/** NPR composite — combines edges + fill into the final pixel.
 *
 *  Inputs:
 *    colorNode  — RGBA from the scene's MRT 'output' attachment (lit, linear)
 *    normalNode — RGBA from the scene's MRT 'normal' attachment (packed view normal)
 *    viewZNode  — float, linearized view-space Z for the current screen pixel
 *
 *  Output:
 *    vec4(fill * (1 - edge*lineStrength), 1)
 *
 *  Fill mode is switched by an int-valued uniform (0=flat, 1=grayscale). */

import { vec3, vec4, mix, saturate, smoothstep, max, luminance, pow, step, length } from 'three/tsl';
import { sobelDepth, sobelNormal, sobelLuminance } from './edgeNodes';

// Uniform nodes carry runtime `.value` setters that the TSL static types
// don't expose. Use `any` at the boundary to avoid noise.
type UniformNode = any;

export interface NPRUniforms {
  /** 0 = flat-white, 1 = lit-grayscale. */
  fillMode: UniformNode;
  depthThreshold: UniformNode;
  normalThreshold: UniformNode;
  colorThreshold: UniformNode;
  lineThickness: UniformNode;
  lineStrength: UniformNode;
  grayscaleGamma: UniformNode;
  grayscaleLift: UniformNode;
  /** vec2(1/width, 1/height) — owner updates on resize. */
  texelSize: UniformNode;
  /** Live FXAA toggle — 0 disables AA, 1 enables. Drives a branch inside the shader. */
  fxaaEnabled: UniformNode;
  /** Relative-contrast threshold for FXAA edge detection (0..1). */
  fxaaEdgeThreshold: UniformNode;
  /** Absolute floor for FXAA edge detection — prevents AA on near-flat regions. */
  fxaaEdgeThresholdMin: UniformNode;
  /** Multiplier on the blend curve (higher = more blur on detected edges). */
  fxaaBlendStrength: UniformNode;
  /** Camera clear color (RGB) — shows through where the MRT pass drew no
   *  geometry. The composite covers every pixel, so without this uniform
   *  the camera's clearColor would never reach the swapchain when NPR is on. */
  clearColor: UniformNode;
}

export interface BuildCompositeArgs {
  colorNode: any;
  normalNode: any;
  /** Per-material outline color sampled from the MRT 'lineColor' attachment.
   *  Comes from `materialReference('lineColor', 'color')` so every fragment
   *  knows what color *its surface* wants its outline to be. */
  lineColorNode: any;
  /** The pass's raw depth texture node (samplable at offsets). Sobel
   *  reconstructs viewZ per sample to keep the threshold scale-invariant. */
  depthTextureNode: any;
  /** True when the build-time camera is orthographic — selects the matching
   *  linear depth→viewZ reconstructor in `sobelDepth` (F10). Defaults to
   *  perspective (the shipping island/game cameras). */
  isOrthographic?: boolean;
  uniforms: NPRUniforms;
}

export function buildCompositeNode(args: BuildCompositeArgs): any {
  const { colorNode, normalNode, lineColorNode, depthTextureNode, isOrthographic, uniforms } = args;
  // Scale stencil by lineThickness (1 or 2) so the kernel widens for thicker lines.
  const scaledTexel = uniforms.texelSize.mul(uniforms.lineThickness);

  const dRaw = sobelDepth(depthTextureNode, scaledTexel, isOrthographic === true);
  const nRaw = sobelNormal(normalNode, scaledTexel);
  const cRaw = sobelLuminance(colorNode, scaledTexel);

  // Fixed-width smoothstep per source: transition over [threshold, threshold*2].
  // Combine via max so any single signal lights up the line. Simple and
  // predictable — the fwidth-based variant didn't visibly outperform this.
  const dW = smoothstep(uniforms.depthThreshold,  uniforms.depthThreshold.mul(2),  dRaw);
  const nW = smoothstep(uniforms.normalThreshold, uniforms.normalThreshold.mul(2), nRaw);
  const cW = smoothstep(uniforms.colorThreshold,  uniforms.colorThreshold.mul(2),  cRaw);
  const edge = saturate(max(max(dW, nW), cW));

  // Return a raw node expression (no outer Fn wrapper). Wrapping in `Fn(()=>...)()`
  // produces a ShaderCallNodeInternal that confuses FXAA's setLayout build when it
  // tries to wrap our output as a texture input. Plain expression composition lets
  // each node defer naturally.
  const sceneColor = (colorNode as any).rgb;
  const lum = luminance(sceneColor);
  const remapped = pow(saturate(lum), uniforms.grayscaleGamma);
  const lifted   = (remapped as any).add((uniforms.grayscaleLift as any).mul((remapped as any).oneMinus()));
  const grayscaleFill = vec3(lifted);
  const flatFill      = vec3(1.0);
  const fill = mix(flatFill, grayscaleFill, uniforms.fillMode);
  // Color preserve: lineColor's alpha carries `nprColorPreserve` (0..1). Lerp
  // the grayscale fill back toward this fragment's true lit color by that
  // amount, so shaders/materials can keep their hue through NPR. 0 = full
  // grayscale (default), 1 = full color. Lines are still drawn on top, so the
  // outline survives at every preserve level.
  const preserve = (lineColorNode as any).a;
  const fillKept = mix(fill, sceneColor, preserve);
  // Per-material outline color: lerp from the (possibly color-kept) fill toward
  // the material's lineColor by `edge * lineStrength`. lineColor=black gives the
  // previous behavior; non-black tints lines per-material.
  const lineColor = (lineColorNode as any).rgb;
  const fgComposite = mix(fillKept, lineColor, (edge as any).mul(uniforms.lineStrength));
  // Background mask: the MRT normal target clears to (0,0,0,0); geometry writes
  // a unit-length view normal. step(0.5, |n|) cleanly separates the two without
  // a branch — 0 for empty pixels, 1 for geometry — and gives us a hard edge so
  // the camera's clearColor reaches the swapchain unmodified outside the model
  // silhouette (no NPR-fill, no line drawn).
  const isForeground = step(0.5, length((normalNode as any).xyz));
  const finalRgb = mix(uniforms.clearColor, fgComposite, isForeground);
  // Opaque output (alpha 1) so the camera clearColor paints the background on
  // every backend. We can't rely on alpha here for transparent-canvas layering:
  // the WebGPU swapchain is opaque (alpha ignored), while the WebGL2 backend's
  // context is always created premultiplied alpha:true (the renderer's
  // alpha:false is ignored) — so an alpha-0 background would multiply clearColor
  // to zero and let the page show through, diverging from WebGPU. Forcing alpha
  // 1 keeps both backends identical. (If transparent 3D-over-DOM is ever needed,
  // gate this on a config flag rather than the backend.)
  return vec4(finalRgb, 1.0);
}
