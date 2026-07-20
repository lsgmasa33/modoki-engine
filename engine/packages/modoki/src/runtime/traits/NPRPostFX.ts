import { trait } from 'koota';

/** NPRPostFX — non-photoreal post-processing config (singleton per scene).
 *  When `enabled`, Scene3D routes rendering through a TSL edge-detection
 *  composer. Two fill modes: 'flat' (white sheet) and 'grayscale' (lit
 *  luminance, remapped toward highlights). All thresholds are uniform
 *  inputs — changes update in place without rebuilding the node graph. */
export const NPRPostFX = trait({
  enabled: false,
  /** 'flat' = white sheet, 'grayscale' = lit luminance remap. */
  fillMode: 'grayscale',
  /** View-space depth Sobel threshold for silhouettes. Larger = fewer lines. */
  depthThreshold: 0.005,
  /** Normal Sobel threshold for crease edges. 0..1. */
  normalThreshold: 0.4,
  /** Luminance Sobel threshold for texture/color edges. 0..1. */
  colorThreshold: 0.15,
  /** Sobel sample radius in pixels. 1 or 2. */
  lineThickness: 1,
  /** Multiplier on the line mask before darkening the fill. 0..1. */
  lineStrength: 1,
  /** Luminance remap exponent in grayscale mode. <1 lifts midtones. */
  grayscaleGamma: 0.7,
  /** Black lift in grayscale mode. 0..1. */
  grayscaleLift: 0.3,
  /** FXAA post-AA on the composite output. */
  fxaa: true,
  /** FXAA relative-contrast threshold (typical 0.05–0.25). */
  fxaaEdgeThreshold: 0.125,
  /** FXAA absolute luma floor — pixels below are treated as flat. */
  fxaaEdgeThresholdMin: 0.0312,
  /** FXAA blur strength multiplier on detected edges (typical 2–8). */
  fxaaBlendStrength: 4.0,
  /** Supersample factor on MRT + composite (1 = native, 2 = 4× pixels).
   *  Changing this rebuilds the pipeline. */
  superSampleScale: 1,
});
