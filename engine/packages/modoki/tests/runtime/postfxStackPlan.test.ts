/** Pure post-FX stack planning — see docs/rendering.md "Post-Process Stack"
 *  ("Planning is pure") for the full design.
 *  No `three`/TSL involved — these are the decisions `PostFXStack` must not
 *  re-derive itself: stage order, MRT union, FXAA legality, and the
 *  rebuild-vs-live-update contract that keeps a param-only edit from forcing a
 *  shader recompile. */

import { describe, it, expect } from 'vitest';
import {
  planStages, requiredMrtTargets, stackSignature, needsRebuild, planFxaaEnabled,
  type PostFXRequest,
} from '../../src/runtime/rendering/postfx/stackPlan';

const bloom = () => ({ strength: 0.8, radius: 0.6, threshold: 0 });
const vignette = () => ({ intensity: 0.4, smoothness: 0.5 });
const dof = () => ({ focusDistance: 10, focalLength: 1, bokehScale: 1 });
const ao = () => ({ radius: 0.25, intensity: 1 });
const fxaa = () => ({ edgeThreshold: 0.125, edgeThresholdMin: 0.0312, blendStrength: 4 });
const npr = (over: Record<string, unknown> = {}) => ({
  isOrthographic: false, superSampleScale: 1, fillMode: 'grayscale' as const,
  depthThreshold: 0.005, normalThreshold: 0.4, colorThreshold: 0.15,
  lineThickness: 1, lineStrength: 1, grayscaleGamma: 0.7, grayscaleLift: 0.3,
  clearColor: 0x000000, ...over,
});

describe('planStages', () => {
  it('returns nothing enabled → empty stack', () => {
    expect(planStages({})).toEqual([]);
  });

  it('orders stages canonically: npr(+particles), ao, dof, bloom, vignette, fxaa', () => {
    const req: PostFXRequest = { fxaa: fxaa(), vignette: vignette(), bloom: bloom(), dof: dof(), ao: ao(), npr: npr() };
    expect(planStages(req)).toEqual(['npr', 'npr-particles', 'ao', 'dof', 'bloom', 'vignette', 'fxaa']);
  });

  it('is independent of the request object key order', () => {
    const a: PostFXRequest = { bloom: bloom(), vignette: vignette(), fxaa: fxaa() };
    const b: PostFXRequest = { fxaa: fxaa(), vignette: vignette(), bloom: bloom() };
    expect(planStages(a)).toEqual(planStages(b));
  });

  it('NPR pulls in its particle stage as a pair, never alone', () => {
    expect(planStages({ npr: npr() })).toEqual(['npr', 'npr-particles']);
  });

  it('omits a stage entirely when its config is absent', () => {
    expect(planStages({ bloom: bloom() })).toEqual(['bloom']);
    expect(planStages({ ao: ao() })).toEqual(['ao']);
  });
});

describe('requiredMrtTargets', () => {
  it('is just output when nothing needs normal/lineColor', () => {
    expect(requiredMrtTargets({ bloom: bloom(), dof: dof(), fxaa: fxaa() })).toEqual(['output']);
  });

  it('NPR adds normal + lineColor', () => {
    expect(requiredMrtTargets({ npr: npr() })).toEqual(['output', 'normal', 'lineColor']);
  });

  it('AO adds normal but NOT lineColor (that stays NPR-only)', () => {
    // The "nullable normalNode, no MRT" GTAO path was tried and is broken
    // under this renderer's multisampled depth buffer (WGSL codegen gap) —
    // see requiredMrtTargets's doc comment. AO always forces a real normal.
    expect(requiredMrtTargets({ ao: ao() })).toEqual(['output', 'normal']);
  });

  it('NPR + AO share the same single normal target — no duplication', () => {
    expect(requiredMrtTargets({ npr: npr(), ao: ao() })).toEqual(['output', 'normal', 'lineColor']);
  });

  it('is minimal — never adds a target no enabled stage needs', () => {
    const targets = requiredMrtTargets({ bloom: bloom(), vignette: vignette() });
    expect(targets).toEqual(['output']);
  });
});

describe('stackSignature', () => {
  it('is identical for two equal requests regardless of key order', () => {
    const a: PostFXRequest = { bloom: bloom(), vignette: vignette() };
    const b: PostFXRequest = { vignette: vignette(), bloom: bloom() };
    expect(stackSignature(a)).toBe(stackSignature(b));
  });

  it('changes when a stage is added', () => {
    const base = stackSignature({ bloom: bloom() });
    expect(stackSignature({ bloom: bloom(), vignette: vignette() })).not.toBe(base);
  });

  it('changes when a param inside an enabled stage changes', () => {
    const base = stackSignature({ bloom: bloom() });
    expect(stackSignature({ bloom: { strength: 1.5, radius: 0.6, threshold: 0 } })).not.toBe(base);
  });

  it('changes when a stage is removed entirely', () => {
    const base = stackSignature({ bloom: bloom(), dof: dof() });
    expect(stackSignature({ bloom: bloom() })).not.toBe(base);
  });

  it('changes when the AO intensity changes (a param-only edit, not just radius)', () => {
    const base = stackSignature({ ao: ao() });
    expect(stackSignature({ ao: { radius: 0.25, intensity: 0.5 } })).not.toBe(base);
  });
});

describe('needsRebuild', () => {
  it('is false for identical requests', () => {
    expect(needsRebuild({ bloom: bloom() }, { bloom: bloom() })).toBe(false);
  });

  it('is false for a param-only edit — must apply as a live uniform update', () => {
    const prev: PostFXRequest = { bloom: bloom() };
    const next: PostFXRequest = { bloom: { strength: 1.5, radius: 0.6, threshold: 0 } };
    expect(needsRebuild(prev, next)).toBe(false);
  });

  it('is true when a stage is added', () => {
    const prev: PostFXRequest = { bloom: bloom() };
    const next: PostFXRequest = { bloom: bloom(), vignette: vignette() };
    expect(needsRebuild(prev, next)).toBe(true);
  });

  it('is true when a stage is removed', () => {
    const prev: PostFXRequest = { bloom: bloom(), vignette: vignette() };
    const next: PostFXRequest = { bloom: bloom() };
    expect(needsRebuild(prev, next)).toBe(true);
  });

  it('is true when the MRT layout changes (NPR toggled, even with an unrelated param edit)', () => {
    const prev: PostFXRequest = { bloom: bloom() };
    const next: PostFXRequest = { bloom: bloom(), npr: npr() };
    expect(needsRebuild(prev, next)).toBe(true);
  });

  it('is true when a stage is swapped for a different one with the same MRT needs', () => {
    // bloom -> vignette: neither needs normal/lineColor, but the stage SET changed,
    // so this must still signal a rebuild (chain topology changed even if MRT didn't).
    const prev: PostFXRequest = { bloom: bloom() };
    const next: PostFXRequest = { vignette: vignette() };
    expect(needsRebuild(prev, next)).toBe(true);
  });

  it('is false for an AO intensity edit — GTAONode has no MRT/dispose cost from a param change', () => {
    const prev: PostFXRequest = { ao: ao() };
    const next: PostFXRequest = { ao: { radius: 0.25, intensity: 0.5 } };
    expect(needsRebuild(prev, next)).toBe(false);
  });
});

describe('planFxaaEnabled (Phase 3 — FXAA moved out of NPR into the stack tail)', () => {
  const base = { requested: true, isWebGLBackend: false, superSampleScale: 1 };

  it('is on when requested, on WebGPU, at native resolution', () => {
    expect(planFxaaEnabled(base)).toBe(true);
  });

  it('is off when not requested', () => {
    expect(planFxaaEnabled({ ...base, requested: false })).toBe(false);
  });

  it('is off on the WebGL2 backend — the raw-WGSL wgslFn cannot compile there', () => {
    expect(planFxaaEnabled({ ...base, isWebGLBackend: true })).toBe(false);
  });

  it('is off while supersampling (F7) — SSAA already covers it, at scale² cost', () => {
    expect(planFxaaEnabled({ ...base, superSampleScale: 2 })).toBe(false);
    expect(planFxaaEnabled({ ...base, superSampleScale: 4 })).toBe(false);
  });
});

describe('needsRebuild — NPR structural fields (Phase 3 blocker 5)', () => {
  it('is FALSE for an NPR param-only edit (threshold/fill/clearColor sliders)', () => {
    const prev: PostFXRequest = { npr: npr() };
    const next: PostFXRequest = { npr: npr({ lineStrength: 3, fillMode: 'flat', clearColor: 0xff8800 }) };
    expect(needsRebuild(prev, next)).toBe(false);
  });

  it('is TRUE when superSampleScale changes (every render target resizes)', () => {
    expect(needsRebuild({ npr: npr() }, { npr: npr({ superSampleScale: 2 }) })).toBe(true);
  });

  it('is TRUE when the camera projection flips (depth reconstructor is baked in)', () => {
    expect(needsRebuild({ npr: npr() }, { npr: npr({ isOrthographic: true }) })).toBe(true);
  });

  it('is FALSE for an FXAA threshold edit — those are live uniforms', () => {
    const prev: PostFXRequest = { npr: npr(), fxaa: fxaa() };
    const next: PostFXRequest = { npr: npr(), fxaa: { edgeThreshold: 0.2, edgeThresholdMin: 0.05, blendStrength: 6 } };
    expect(needsRebuild(prev, next)).toBe(false);
  });

  it('is TRUE when FXAA is toggled off (the stage leaves the chain)', () => {
    expect(needsRebuild({ npr: npr(), fxaa: fxaa() }, { npr: npr() })).toBe(true);
  });

  it('NPR + bloom coexist — adding bloom to NPR is a rebuild, not a rejection', () => {
    expect(needsRebuild({ npr: npr() }, { npr: npr(), bloom: bloom() })).toBe(true);
  });
});

describe('stackSignature — NPR + FXAA params', () => {
  it('changes when an NPR threshold changes', () => {
    expect(stackSignature({ npr: npr({ depthThreshold: 0.02 }) })).not.toBe(stackSignature({ npr: npr() }));
  });

  it('changes when the NPR clearColor changes', () => {
    expect(stackSignature({ npr: npr({ clearColor: 0xff0000 }) })).not.toBe(stackSignature({ npr: npr() }));
  });

  it('changes when an FXAA threshold changes', () => {
    const base = stackSignature({ fxaa: fxaa() });
    expect(stackSignature({ fxaa: { edgeThreshold: 0.2, edgeThresholdMin: 0.0312, blendStrength: 4 } })).not.toBe(base);
  });
});
