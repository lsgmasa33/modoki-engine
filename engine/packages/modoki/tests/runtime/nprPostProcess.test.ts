/** NPRPostProcess — structural / decision-logic unit tests (npr-F3).
 *
 *  The NPR subsystem had ZERO automated coverage (review F3 [HIGH]). The GPU
 *  output can't be asserted headlessly, but every pure-JS decision point can:
 *  the `DEFAULTS` merge, fast-path selection (`hasFxaaPath`), the WebGL-backend
 *  FXAA skip, and — the single highest-value invariant — `setConfig`'s
 *  rebuild-detection return value. A regression there (forgetting to return
 *  `true` on an SS-scale change) silently degrades to a stale pipeline.
 *
 *  TSL + WebGPU + the node-graph builders are mocked away (same approach as
 *  `fileShaderBuilderTexture`/`particleRouter`): `uniform()` returns a real
 *  `{value,setName}` so plumbing is observable, `pass()`/`rtt()` return method
 *  stubs, and `RenderPipeline`/`ParticlePassNode`/composite+fxaa builders are
 *  inert. No GPU is ever touched. */

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

// A `uniform()` whose `.value` is observable (so setConfig plumbing can be
// asserted) and whose `.setName()` chains (the source calls `uniform(x).setName(...)`).
function makeUniform(initial: unknown) {
  const u: { value: unknown; setName: () => typeof u } = {
    value: initial,
    setName: () => u,
  };
  return u;
}

// A `pass()` stub: records the layers/MRT/resolution-scale calls and hands back
// chainable texture nodes; also answers to `dispose()` (T3 teardown).
function makeScenePass() {
  return {
    setLayers: vi.fn(),
    setMRT: vi.fn(),
    setResolutionScale: vi.fn(),
    getTextureNode: vi.fn(() => makeNode()),
    dispose: vi.fn(),
  };
}

const outputStructSpy = vi.fn((...args: unknown[]) => ({ __outputStruct: args }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  vi.doMock('three/tsl', () => ({
    pass: vi.fn(() => makeScenePass()),
    mrt: vi.fn((o: unknown) => o),
    rtt: vi.fn(() => ({ setPixelRatio: vi.fn(), dispose: vi.fn(), renderTarget: { dispose: vi.fn() } })),
    output: {},
    normalView: {},
    uniform: vi.fn((v: unknown) => makeUniform(v)),
    materialReference: vi.fn(() => makeNode()),
    outputStruct: outputStructSpy,
    vec4: vi.fn((...a: unknown[]) => ({ __vec4: a })),
  }));

  vi.doMock('three/webgpu', () => ({
    RenderPipeline: class {
      outputNode: unknown = null;
      outputColorTransform = true;
      render = vi.fn();
      dispose = vi.fn();
      constructor(_r?: unknown) {}
    },
  }));

  vi.doMock('../../src/runtime/rendering/npr/compositeNodes', () => ({
    buildCompositeNode: vi.fn(() => makeNode()),
  }));
  vi.doMock('../../src/runtime/rendering/npr/fxaaNode', () => ({
    buildFXAANode: vi.fn(() => makeNode()),
  }));
  vi.doMock('../../src/runtime/rendering/npr/ParticlePassNode', () => ({
    ParticlePassNode: class {
      getTextureNode = vi.fn(() => makeNode());
      dispose = vi.fn();
      constructor(..._a: unknown[]) {}
    },
  }));
});

afterEach(() => { vi.restoreAllMocks(); });

/** Minimal renderer the constructor + render() poke at. `isWebGLBackend`
 *  flips the FXAA-skip path. */
function makeRenderer(isWebGLBackend = false) {
  return {
    backend: { isWebGLBackend },
    getSize: (v: THREE.Vector2) => v.set(800, 600),
    getPixelRatio: () => 1,
    getRenderTarget: () => null,
    setRenderTarget: vi.fn(),
  };
}

async function makeNPR(initial: Record<string, unknown> = {}, isWebGLBackend = false) {
  const { NPRPostProcess } = await import('../../src/runtime/rendering/npr/NPRPostProcess');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  return new NPRPostProcess(makeRenderer(isWebGLBackend), scene, camera, initial);
}

describe('NPRPostProcess — DEFAULTS merge', () => {
  it('initializes the fillMode uniform from the override (flat → 0)', async () => {
    const npr = await makeNPR({ fillMode: 'flat' });
    const u = (npr as any).uniforms;
    expect(u.fillMode.value).toBe(0);
  });

  it('falls back to DEFAULTS for untouched fields', async () => {
    const npr = await makeNPR({ fillMode: 'flat' });
    const u = (npr as any).uniforms;
    expect(u.depthThreshold.value).toBe(0.005);   // DEFAULTS.depthThreshold
    expect(u.normalThreshold.value).toBe(0.4);     // DEFAULTS.normalThreshold
    expect(u.fillMode.value).toBe(0);              // grayscale=1 default overridden to flat=0
  });

  it('grayscale (default) maps the fillMode uniform to 1', async () => {
    const npr = await makeNPR();
    expect((npr as any).uniforms.fillMode.value).toBe(1);
  });
});

describe('NPRPostProcess — fast-path selection (hasFxaaPath)', () => {
  it('is false only at scale 1 with FXAA off (composite → swapchain directly)', async () => {
    const npr = await makeNPR({ superSampleScale: 1, fxaa: false });
    expect((npr as any).hasFxaaPath).toBe(false);
  });

  it('is true at scale 1 with FXAA on (RTT + FXAA stage wired)', async () => {
    const npr = await makeNPR({ superSampleScale: 1, fxaa: true });
    expect((npr as any).hasFxaaPath).toBe(true);
  });

  it('is true whenever supersampling (scale 2), even with FXAA off', async () => {
    const npr = await makeNPR({ superSampleScale: 2, fxaa: false });
    expect((npr as any).hasFxaaPath).toBe(true);
  });

  it('skips FXAA on the WebGL backend — scale 1 + fxaa:true stays fast-path', async () => {
    const npr = await makeNPR({ superSampleScale: 1, fxaa: true }, /* isWebGLBackend */ true);
    expect((npr as any).hasFxaaPath).toBe(false);
    expect((npr as any).isWebGLBackend).toBe(true);
  });
});

describe('NPRPostProcess — FXAA gated off when supersampling (F7)', () => {
  it('wires the FXAA stage at scale 1 with fxaa:true', async () => {
    const { buildFXAANode } = await import('../../src/runtime/rendering/npr/fxaaNode');
    await makeNPR({ superSampleScale: 1, fxaa: true });
    expect(buildFXAANode).toHaveBeenCalledTimes(1);
  });

  it('does NOT wire FXAA at scale 2 even with fxaa:true (would run at SS resolution)', async () => {
    const { buildFXAANode } = await import('../../src/runtime/rendering/npr/fxaaNode');
    const npr = await makeNPR({ superSampleScale: 2, fxaa: true });
    // FXAA gated off, but the composite RTT still exists to downsample SS→display.
    expect(buildFXAANode).not.toHaveBeenCalled();
    expect((npr as any).hasFxaaPath).toBe(true);
    expect((npr as any).compositeRTT).not.toBeNull();
  });
});

describe('NPRPostProcess — setConfig rebuild detection (the load-bearing invariant)', () => {
  it('returns true when superSampleScale changes', async () => {
    const npr = await makeNPR({ superSampleScale: 1 });
    expect(npr.setConfig({ superSampleScale: 2 })).toBe(true);
  });

  it('returns false when superSampleScale is set to its current value', async () => {
    const npr = await makeNPR({ superSampleScale: 2 });
    expect(npr.setConfig({ superSampleScale: 2 })).toBe(false);
  });

  it('returns true turning FXAA on from the no-RTT fast path (WebGPU backend)', async () => {
    const npr = await makeNPR({ superSampleScale: 1, fxaa: false });
    expect((npr as any).hasFxaaPath).toBe(false);
    expect(npr.setConfig({ fxaa: true })).toBe(true);
  });

  it('returns false turning FXAA on in fast path on the WebGL backend (wgslFn cannot compile)', async () => {
    const npr = await makeNPR({ superSampleScale: 1, fxaa: false }, /* isWebGLBackend */ true);
    expect(npr.setConfig({ fxaa: true })).toBe(false);
  });

  it('returns false turning FXAA off (live uniform toggle, no rebuild)', async () => {
    const npr = await makeNPR({ superSampleScale: 1, fxaa: true });
    expect(npr.setConfig({ fxaa: false })).toBe(false);
  });

  it('returns false for a pure threshold uniform update', async () => {
    const npr = await makeNPR();
    expect(npr.setConfig({ depthThreshold: 0.02, lineStrength: 2 })).toBe(false);
  });
});

describe('NPRPostProcess — setConfig uniform plumbing', () => {
  it('pushes each config key into the matching uniform value', async () => {
    const npr = await makeNPR();
    npr.setConfig({
      depthThreshold: 0.02, normalThreshold: 0.5, colorThreshold: 0.3,
      lineThickness: 2, lineStrength: 3, grayscaleGamma: 0.9, grayscaleLift: 0.1,
      fxaaEdgeThreshold: 0.2, fxaaEdgeThresholdMin: 0.05, fxaaBlendStrength: 6,
    });
    const u = (npr as any).uniforms;
    expect(u.depthThreshold.value).toBe(0.02);
    expect(u.normalThreshold.value).toBe(0.5);
    expect(u.colorThreshold.value).toBe(0.3);
    expect(u.lineThickness.value).toBe(2);
    expect(u.lineStrength.value).toBe(3);
    expect(u.grayscaleGamma.value).toBe(0.9);
    expect(u.grayscaleLift.value).toBe(0.1);
    expect(u.fxaaEdgeThreshold.value).toBe(0.2);
    expect(u.fxaaEdgeThresholdMin.value).toBe(0.05);
    expect(u.fxaaBlendStrength.value).toBe(6);
  });

  it('updates the clearColor uniform via Color.setHex', async () => {
    const npr = await makeNPR({ clearColor: 0x000000 });
    npr.setConfig({ clearColor: 0xff8800 });
    const color = (npr as any).uniforms.clearColor.value as THREE.Color;
    expect(color.getHex()).toBe(0xff8800);
  });

  it('fxaa:false zeroes the fxaaEnabled uniform; fxaa:true sets it to 1', async () => {
    const npr = await makeNPR({ fxaa: true });
    npr.setConfig({ fxaa: false });
    expect((npr as any).uniforms.fxaaEnabled.value).toBe(0);
    npr.setConfig({ fxaa: true });
    expect((npr as any).uniforms.fxaaEnabled.value).toBe(1);
  });
});

describe('NPRPostProcess — resize math (F1: supersampled texel size)', () => {
  it('render() primes texelSize from the live drawing buffer (DPR 1, SS 1)', async () => {
    // F2: resize() was deleted — render() is now the sole authority and derives
    // the texel from the renderer drawing buffer every frame. The mock renderer
    // reports 800×600 @ pixelRatio 1, so texel = 1/800, 1/600.
    const npr = await makeNPR();
    npr.render();
    const texel = (npr as any).uniforms.texelSize.value as THREE.Vector2;
    expect(texel.x).toBeCloseTo(1 / 800);
    expect(texel.y).toBeCloseTo(1 / 600);
  });

  it('computeNprTexelSize scales by DPR (the core F1 bug — CSS px gave 2× lines on DPR-2)', async () => {
    const { computeNprTexelSize } = await import('../../src/runtime/rendering/npr/NPRPostProcess');
    // CSS 800×600 at DPR 2 → drawing buffer 1600×1200 → texel half the CSS-pixel value.
    expect(computeNprTexelSize(800, 600, 2, 1)).toEqual({ x: 1 / 1600, y: 1 / 1200 });
  });

  it('computeNprTexelSize compounds DPR × superSampleScale', async () => {
    const { computeNprTexelSize } = await import('../../src/runtime/rendering/npr/NPRPostProcess');
    // DPR 2 × SS 2 → 4× the CSS resolution.
    expect(computeNprTexelSize(800, 600, 2, 2)).toEqual({ x: 1 / 3200, y: 1 / 2400 });
    // DPR 1, SS 1 → CSS pixels (unchanged).
    expect(computeNprTexelSize(1600, 900, 1, 1)).toEqual({ x: 1 / 1600, y: 1 / 900 });
  });

  it('computeNprTexelSize floors fractional pixels and never divides by zero', async () => {
    const { computeNprTexelSize } = await import('../../src/runtime/rendering/npr/NPRPostProcess');
    expect(computeNprTexelSize(800.7, 600.9, 1.5, 1)).toEqual({ x: 1 / 1201, y: 1 / 901 });
    expect(computeNprTexelSize(0, 0, 1, 1)).toEqual({ x: 1, y: 1 }); // clamped to 1px
  });
});

describe('NPRPostProcess — dispose frees node-owned render targets (T3)', () => {
  it('disposes the MRT scene pass and the composite RTT render target on teardown', async () => {
    const npr = await makeNPR({ superSampleScale: 2, fxaa: true }); // has the composite RTT
    const scenePass = (npr as any).scenePass as { dispose: ReturnType<typeof vi.fn> };
    const compositeRTT = (npr as any).compositeRTT as { renderTarget: { dispose: ReturnType<typeof vi.fn> } };
    npr.dispose();
    expect(scenePass.dispose).toHaveBeenCalledTimes(1);
    expect(compositeRTT.renderTarget.dispose).toHaveBeenCalledTimes(1);
  });

  it('has no composite RTT in the fast path (nothing to free there)', async () => {
    const npr = await makeNPR({ superSampleScale: 1, fxaa: false });
    expect((npr as any).compositeRTT).toBeNull();
    expect(() => npr.dispose()).not.toThrow();
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
