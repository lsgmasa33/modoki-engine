// HMR: see NPRPostProcess.ts — wgslFn instances baked into compiled pipelines
// can't safely hot-reload.
if (import.meta.hot) import.meta.hot.invalidate();

/** FXAA — Fast Approximate Anti-Aliasing in raw WGSL.
 *
 *  Why wgslFn instead of three.js's built-in FXAANode? The built-in trips on a
 *  setLayout/Fn build bug in our pipeline (logged "Cannot read properties of
 *  null (reading 'If')") on r183/r184. This is a self-contained alternative
 *  that runs entirely in vanilla WGSL with no setLayout dependency.
 *
 *  Algorithm: simplified FXAA 3.11 — luma-based edge detect, directional blur
 *  perpendicular to the gradient. Faster + lighter than the full reference
 *  implementation; the visual difference is negligible at normal viewing
 *  distance, and the goal here is cheap silhouette anti-aliasing at display
 *  resolution. NPRPostProcess only wires this pass when superSampleScale===1
 *  (F7) — at SS>1 the SSAA already handles aliasing and FXAA would otherwise run
 *  at the supersampled resolution, so it's gated off and the composite RTT is
 *  downsampled directly. */

import { wgslFn, screenUV, sampler } from 'three/tsl';

const fxaaFn = wgslFn(`
  fn fxaa(
    uv: vec2<f32>,
    tex: texture_2d<f32>,
    samp: sampler,
    texelSize: vec2<f32>,
    enabled: f32,
    edgeThreshold: f32,
    edgeThresholdMin: f32,
    blendStrength: f32
  ) -> vec4<f32> {
    let rgbM = textureSample(tex, samp, uv).rgb;

    // Live toggle — skip all AA work when disabled.
    if (enabled < 0.5) {
      return vec4<f32>(rgbM, 1.0);
    }

    let lumaCoef = vec3<f32>(0.299, 0.587, 0.114);

    let rgbN = textureSample(tex, samp, uv + vec2<f32>(0.0, -texelSize.y)).rgb;
    let rgbS = textureSample(tex, samp, uv + vec2<f32>(0.0,  texelSize.y)).rgb;
    let rgbE = textureSample(tex, samp, uv + vec2<f32>( texelSize.x, 0.0)).rgb;
    let rgbW = textureSample(tex, samp, uv + vec2<f32>(-texelSize.x, 0.0)).rgb;

    let lumaM = dot(rgbM, lumaCoef);
    let lumaN = dot(rgbN, lumaCoef);
    let lumaS = dot(rgbS, lumaCoef);
    let lumaE = dot(rgbE, lumaCoef);
    let lumaW = dot(rgbW, lumaCoef);

    let lumaMin = min(lumaM, min(min(lumaN, lumaS), min(lumaE, lumaW)));
    let lumaMax = max(lumaM, max(max(lumaN, lumaS), max(lumaE, lumaW)));
    let lumaRange = lumaMax - lumaMin;

    // Early-out for flat regions (no edge detected).
    if (lumaRange < max(edgeThresholdMin, lumaMax * edgeThreshold)) {
      return vec4<f32>(rgbM, 1.0);
    }

    // Gradient direction in luma space. Edges run perpendicular to this.
    let gradient = vec2<f32>(lumaE - lumaW, lumaS - lumaN);
    let gradLen = length(gradient) + 0.00001;
    let dir = gradient / gradLen;

    // Sample two points along the edge (perpendicular to gradient).
    let perp = vec2<f32>(-dir.y, dir.x);
    let offset = perp * texelSize;
    let rgbA = textureSample(tex, samp, uv + offset).rgb;
    let rgbB = textureSample(tex, samp, uv - offset).rgb;
    let blurred = (rgbA + rgbB) * 0.5;

    // Mix center toward blurred proportional to contrast (stronger edges get
    // more blur; subtle ones get less). blendStrength scales the curve.
    let blendFactor = clamp(lumaRange * blendStrength, 0.0, 1.0);
    let result = mix(rgbM, blurred, blendFactor);
    return vec4<f32>(result, 1.0);
  }
`);

/** Build an FXAA output node that samples `inputTex` (an RTT/TextureNode) and
 *  returns the antialiased screen color. Pass it to `pipeline.outputNode`.
 *
 *  All threshold uniforms come from the caller so they can be live-tunable —
 *  reuse the NPRUniforms that the post-process owner already created. */
export function buildFXAANode(opts: {
  inputTex: unknown;
  texelSize: unknown;
  enabled: unknown;
  edgeThreshold: unknown;
  edgeThresholdMin: unknown;
  blendStrength: unknown;
}): unknown {
  return (fxaaFn as unknown as (args: Record<string, unknown>) => unknown)({
    uv: screenUV,
    tex: opts.inputTex,
    samp: (sampler as unknown as (t: unknown) => unknown)(opts.inputTex),
    texelSize: opts.texelSize,
    enabled: opts.enabled,
    edgeThreshold: opts.edgeThreshold,
    edgeThresholdMin: opts.edgeThresholdMin,
    blendStrength: opts.blendStrength,
  });
}
