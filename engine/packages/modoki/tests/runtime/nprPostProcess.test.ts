/** NPRPostProcess.ts — the NPR shared vocabulary (npr-F3).
 *
 *  ⚠️ This module used to export an `NPRPostProcess` CLASS owning the whole
 *  two-stage pipeline, and most of this suite tested its structural decisions
 *  (fast-path selection, the WebGL FXAA skip, and — the highest-value invariant
 *  — `setConfig`'s rebuild-vs-live return value). The post-FX stack workstream
 *  (see docs/rendering.md "NPR Outline Post-Process") dissolved that class into
 *  stages of `PostFXStack`, so ALL of that coverage MOVED, asserting the same invariants,
 *  to `postfxStack.test.ts` (stage assembly, the I1 single-terminal-transform
 *  contract, dispose) and `postfxStackPlan.test.ts` (rebuild-vs-live, FXAA
 *  legality). Nothing was dropped — it is tested where the code now lives.
 *
 *  What remains here is what this module still owns: the public custom-shader
 *  helpers games depend on (`nprFragmentOutput` / `applyNprFragmentOutput`,
 *  incl. the frozen shared default lineColor and the fog hazard) and the
 *  supersample-aware texel math.
 *
 *  TSL is mocked away (same approach as `fileShaderBuilderTexture`): no GPU is
 *  ever touched. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';

// Chainable no-op TSL node.
function makeNode(): Record<string, unknown> {
  const n: Record<string, unknown> = {};
  n.toVar = () => n;
  n.rgb = n;
  n.a = n;
  return n;
}

const outputStructSpy = vi.fn((...args: unknown[]) => ({ __outputStruct: args }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  vi.doMock('three/tsl', () => ({
    normalView: {},
    materialReference: vi.fn(() => makeNode()),
    outputStruct: outputStructSpy,
    vec4: vi.fn((...a: unknown[]) => ({ __vec4: a })),
  }));
});

afterEach(() => { vi.restoreAllMocks(); });

describe('computeNprTexelSize (F1: supersampled texel size)', () => {
  it('scales by DPR (the core F1 bug — CSS px gave 2× lines on DPR-2)', async () => {
    const { computeNprTexelSize } = await import('../../src/runtime/rendering/npr/NPRPostProcess');
    // CSS 800×600 at DPR 2 → drawing buffer 1600×1200 → texel half the CSS-pixel value.
    expect(computeNprTexelSize(800, 600, 2, 1)).toEqual({ x: 1 / 1600, y: 1 / 1200 });
  });

  it('compounds DPR × superSampleScale', async () => {
    const { computeNprTexelSize } = await import('../../src/runtime/rendering/npr/NPRPostProcess');
    // DPR 2 × SS 2 → 4× the CSS resolution.
    expect(computeNprTexelSize(800, 600, 2, 2)).toEqual({ x: 1 / 3200, y: 1 / 2400 });
    // DPR 1, SS 1 → CSS pixels (unchanged).
    expect(computeNprTexelSize(1600, 900, 1, 1)).toEqual({ x: 1 / 1600, y: 1 / 900 });
  });

  it('floors fractional pixels and never divides by zero', async () => {
    const { computeNprTexelSize } = await import('../../src/runtime/rendering/npr/NPRPostProcess');
    expect(computeNprTexelSize(800.7, 600.9, 1.5, 1)).toEqual({ x: 1 / 1201, y: 1 / 901 });
    expect(computeNprTexelSize(0, 0, 1, 1)).toEqual({ x: 1, y: 1 }); // clamped to 1px
  });
});

describe('nprFragmentOutput', () => {
  it('packs the color into a 3-target outputStruct and patches material.lineColor defaults', async () => {
    const { nprFragmentOutput } = await import('../../src/runtime/rendering/npr/NPRPostProcess');
    const result = nprFragmentOutput({ __color: true });
    expect(result).toBeTruthy();
    expect(outputStructSpy).toHaveBeenCalledTimes(1);
    expect(outputStructSpy.mock.calls[0]).toHaveLength(3); // output / normal / lineColor

    // ensureLineColorOnMaterials ran → every material answers lineColor / nprColorPreserve.
    const mat = new THREE.MeshBasicMaterial();
    expect((mat as any).lineColor).toBeInstanceOf(THREE.Color);
    expect((mat as any).nprColorPreserve).toBe(0);
  });

  // F8: the shared default outline Color is returned by-reference to every
  // material without an explicit lineColor. It MUST be frozen so an in-place
  // mutation through the alias can't shift the default process-wide.
  it('returns a single FROZEN shared default lineColor that resists in-place mutation', async () => {
    const { nprFragmentOutput } = await import('../../src/runtime/rendering/npr/NPRPostProcess');
    nprFragmentOutput({ __color: true }); // ensure the prototype patch ran

    const a = new THREE.MeshBasicMaterial();
    const b = new THREE.MeshStandardMaterial();
    const defA = (a as any).lineColor as THREE.Color;
    const defB = (b as any).lineColor as THREE.Color;

    // Same shared instance (the by-reference aliasing F8 warns about)...
    expect(defA).toBe(defB);
    // ...but frozen, so the alias is read-only.
    expect(Object.isFrozen(defA)).toBe(true);

    // Default is black, and an in-place mutate cannot change it (strict-mode
    // ESM ⇒ assignment to a frozen prop throws; either way the value is intact).
    expect(defA.getHex()).toBe(0x000000);
    expect(() => { defA.setHex(0xff0000); }).toThrow();
    expect(defA.getHex()).toBe(0x000000);
    expect((b as any).lineColor.getHex()).toBe(0x000000); // other materials unaffected

    // Assigning a fresh Color per material (the sanctioned path) still works.
    (a as any).lineColor = new THREE.Color(0x00ff00);
    expect((a as any).lineColor.getHex()).toBe(0x00ff00);
    expect((b as any).lineColor.getHex()).toBe(0x000000); // still the frozen default
  });
});

describe('applyNprFragmentOutput', () => {
  // Fog Phase 2 regression: NodeMaterial.fog defaults to true, and three's
  // setupFog() collapses this helper's 3-target outputStruct down to a single
  // vec4 — which WebGPU then discards (targets[1]/[2] end up with no fragment
  // output). applyNprFragmentOutput must turn fog off on the material so a scene
  // with a Fog entity doesn't silently drop every custom-shader draw.
  it('sets fragmentNode from nprFragmentOutput AND disables material.fog', async () => {
    const { applyNprFragmentOutput } = await import('../../src/runtime/rendering/npr/NPRPostProcess');
    const mat = { fragmentNode: null as unknown, fog: true };
    applyNprFragmentOutput(mat, { __color: true });

    expect(mat.fragmentNode).toBeTruthy();
    expect(outputStructSpy).toHaveBeenCalledTimes(1);
    expect(mat.fog).toBe(false);
  });

  it('forwards a per-pixel preserve node to nprFragmentOutput', async () => {
    const { applyNprFragmentOutput } = await import('../../src/runtime/rendering/npr/NPRPostProcess');
    const mat = { fragmentNode: null as unknown, fog: true };
    const preserve = { __rimMask: true };
    applyNprFragmentOutput(mat, { __color: true }, preserve);

    // outputStruct's 3rd arg is vec4(lineColor, preserveNode) — assert the preserve
    // node we passed reached it, instead of the default materialReference fallback.
    const call = outputStructSpy.mock.calls[0];
    expect(call[2]).toEqual({ __vec4: [expect.anything(), preserve] });
  });
});
