/** Pure NPRPostFX trait → NPRConfig mapping (extracted from Scene3D.renderFrame for
 *  testability — npr-postfx Missing-Test #1 / F6). The 3D render loop reads the
 *  `NPRPostFX` singleton + the active camera's `clearColor` and turns them into the
 *  config the composer consumes, plus a string signature it edge-triggers on so a
 *  static scene does zero NPR config work per frame. Keeping the mapping + signature
 *  pure means the load-bearing normalization (fillMode, signature stability) is unit-
 *  tested against the SAME code the loop runs, not a copy. */

import type { NPRConfig, NPRFillMode } from './NPRPostProcess';

/** The subset of the `NPRPostFX` trait the composer reads. A plain shape (not the koota
 *  trait) so it's snapshot-copyable and testable without an ECS world. */
export interface NprTraitSnapshot {
  fillMode: string;
  depthThreshold: number;
  normalThreshold: number;
  colorThreshold: number;
  lineThickness: number;
  lineStrength: number;
  grayscaleGamma: number;
  grayscaleLift: number;
  fxaa: boolean;
  fxaaEdgeThreshold: number;
  fxaaEdgeThresholdMin: number;
  fxaaBlendStrength: number;
  superSampleScale: number;
}

/** `'flat'` stays flat; anything else (incl. an unknown string) → `'grayscale'`. The
 *  composer only knows two fill modes, so a stray value must fall back, not crash. */
export function normalizeFillMode(fillMode: string): NPRFillMode {
  return fillMode === 'flat' ? 'flat' : 'grayscale';
}

/** Build the composer config from a trait snapshot + the active camera's clear color. */
export function nprConfigFromTrait(fx: NprTraitSnapshot, clearColor: number): NPRConfig {
  return {
    fillMode: normalizeFillMode(fx.fillMode),
    depthThreshold: fx.depthThreshold,
    normalThreshold: fx.normalThreshold,
    colorThreshold: fx.colorThreshold,
    lineThickness: fx.lineThickness,
    lineStrength: fx.lineStrength,
    grayscaleGamma: fx.grayscaleGamma,
    grayscaleLift: fx.grayscaleLift,
    fxaa: fx.fxaa,
    fxaaEdgeThreshold: fx.fxaaEdgeThreshold,
    fxaaEdgeThresholdMin: fx.fxaaEdgeThresholdMin,
    fxaaBlendStrength: fx.fxaaBlendStrength,
    superSampleScale: fx.superSampleScale,
    clearColor,
  };
}

/** Stable string signature of every config value the NPR pass reads. The render loop
 *  compares this against the last-applied signature and skips the config-object build
 *  + the 13 uniform writes + `Color.setHex` when it's unchanged (F6 edge-trigger). The
 *  field order is fixed so two equal configs always produce an identical signature. */
export function nprConfigSignature(c: NPRConfig): string {
  return [
    c.fillMode, c.depthThreshold, c.normalThreshold, c.colorThreshold,
    c.lineThickness, c.lineStrength, c.grayscaleGamma, c.grayscaleLift,
    c.fxaa, c.fxaaEdgeThreshold, c.fxaaEdgeThresholdMin, c.fxaaBlendStrength,
    c.superSampleScale, c.clearColor,
  ].join('|');
}
