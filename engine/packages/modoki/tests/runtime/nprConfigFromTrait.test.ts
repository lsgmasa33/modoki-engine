/** NPR trait→config mapping (npr-postfx Missing-Test #1).
 *  The pure mapping + signature Scene3D.renderFrame uses to turn the NPRPostFX trait +
 *  active-camera clearColor into the composer config (and to edge-trigger setConfig).
 *  Type-only import from NPRPostProcess → no TSL/WebGPU mocking needed. */

import { describe, it, expect } from 'vitest';
import {
  normalizeFillMode, nprConfigFromTrait, nprConfigSignature,
  type NprTraitSnapshot,
} from '../../src/runtime/rendering/npr/nprConfigFromTrait';

const snap = (over: Partial<NprTraitSnapshot> = {}): NprTraitSnapshot => ({
  fillMode: 'grayscale',
  depthThreshold: 0.1, normalThreshold: 0.2, colorThreshold: 0.3,
  lineThickness: 1, lineStrength: 0.5,
  grayscaleGamma: 1.2, grayscaleLift: 0.05,
  fxaa: true, fxaaEdgeThreshold: 0.125, fxaaEdgeThresholdMin: 0.05, fxaaBlendStrength: 4,
  superSampleScale: 1,
  ...over,
});

describe('normalizeFillMode', () => {
  it("'flat' stays flat; everything else → grayscale", () => {
    expect(normalizeFillMode('flat')).toBe('flat');
    expect(normalizeFillMode('grayscale')).toBe('grayscale');
    expect(normalizeFillMode('')).toBe('grayscale');
    expect(normalizeFillMode('bogus')).toBe('grayscale'); // unknown value falls back, never crashes
  });
});

describe('nprConfigFromTrait', () => {
  it('passes every threshold through and folds in fillMode + clearColor', () => {
    const cfg = nprConfigFromTrait(snap({ fillMode: 'flat', depthThreshold: 0.42 }), 0x112233);
    expect(cfg.fillMode).toBe('flat');
    expect(cfg.clearColor).toBe(0x112233);
    expect(cfg.depthThreshold).toBe(0.42);
    expect(cfg.normalThreshold).toBe(0.2);
    expect(cfg.lineThickness).toBe(1);
    expect(cfg.fxaa).toBe(true);
    expect(cfg.superSampleScale).toBe(1);
  });

  it('normalizes an unknown fillMode to grayscale', () => {
    expect(nprConfigFromTrait(snap({ fillMode: 'weird' }), 0).fillMode).toBe('grayscale');
  });
});

describe('nprConfigSignature', () => {
  it('is identical for two equal configs (stable field order)', () => {
    const a = nprConfigFromTrait(snap(), 0x000000);
    const b = nprConfigFromTrait(snap(), 0x000000);
    expect(nprConfigSignature(a)).toBe(nprConfigSignature(b));
  });

  it('differs when ANY tracked value changes — incl. clearColor and superSampleScale', () => {
    const base = nprConfigSignature(nprConfigFromTrait(snap(), 0x000000));
    expect(nprConfigSignature(nprConfigFromTrait(snap({ fillMode: 'flat' }), 0x000000))).not.toBe(base);
    expect(nprConfigSignature(nprConfigFromTrait(snap({ lineThickness: 2 }), 0x000000))).not.toBe(base);
    expect(nprConfigSignature(nprConfigFromTrait(snap({ fxaa: false }), 0x000000))).not.toBe(base);
    expect(nprConfigSignature(nprConfigFromTrait(snap({ superSampleScale: 2 }), 0x000000))).not.toBe(base);
    expect(nprConfigSignature(nprConfigFromTrait(snap(), 0x010000))).not.toBe(base); // clearColor only
  });

  it('does NOT collapse distinct numeric fields that would concatenate ambiguously', () => {
    // 0.1|2 vs 0.12 — the join delimiter must keep these distinct.
    const a = nprConfigSignature(nprConfigFromTrait(snap({ depthThreshold: 0.1, normalThreshold: 2 }), 0));
    const b = nprConfigSignature(nprConfigFromTrait(snap({ depthThreshold: 0.12, normalThreshold: 0.2 }), 0));
    expect(a).not.toBe(b);
  });
});
