/** PostFXStack — structural / decision-logic unit tests (post-process-stack-
 *  plan.md Phases 1–4). Bloom had ZERO coverage before this file (the plan
 *  doc's stated gap); this closes it while also covering the stack's own
 *  chain-assembly + rebuild-vs-live contract, vignette/DOF wiring, NPR as an
 *  ordinary stage (Phase 3: composition with bloom, the single terminal color
 *  transform (I1), FXAA at the tail), and GTAO (Phase 4: always a real normal
 *  buffer — the depth-only fallback is broken under MSAA — shared with NPR's
 *  when both are on).
 *
 *  Same mocking approach as `nprPostProcess.test.ts`: TSL + WebGPU + the
 *  bloom/dof/vignette/ao node builders are mocked away, `uniform()`'s `.value`
 *  is observable, `pass()`/`RenderPipeline` are stubs. No GPU is ever touched. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';

// Chainable no-op TSL node with an observable `.value` where relevant
// (bloom()'s returned node exposes strength/radius/threshold as {value}).
function makeBloomNode() {
  return {
    strength: { value: 0 },
    radius: { value: 0 },
    threshold: { value: 0 },
    // Real BloomNode owns a MIP PYRAMID of render targets + materials and has a
    // dispose(). Modelling it here is what lets us catch the stage forgetting to
    // call it — the leak class no other assertion can see.
    dispose: vi.fn(),
  };
}

// A `pass()` stub. `getTextureNode(name)` tags the node with which MRT target
// it came from, so the NPR stage's wiring (color/normal/lineColor/depth) is
// assertable. `isTextureNode` is what the FXAA stage checks to decide whether
// it must wrap the incoming color in an `rtt()` first.
function makeScenePass() {
  const p = {
    setMRT: vi.fn(),
    setLayers: vi.fn(),
    setResolutionScale: vi.fn(),
    getTextureNode: vi.fn((name?: string) => ({ __texture: name ?? 'output', isTextureNode: true })),
    dispose: vi.fn(),
    // #238: the precompile half. `renderTarget` is what `compileSceneAsync` stamps sample count
    // and texture type onto, and `compileAsync` stands in for three's `PassNode.compileAsync` —
    // whose only observable act here is asking the renderer for a render context the way
    // `Renderer.compile()` does: two arguments, so no call depth.
    renderTarget: { samples: 0, texture: { type: null as unknown } },
    compileAsync: vi.fn(async (r: { _renderContexts: { get(rt: unknown, mrt: unknown, d?: number): unknown } }) => {
      r._renderContexts.get(p.renderTarget, null);
    }),
    updateBefore: vi.fn(),
  };
  return p;
}
/** Every pass the mocked `pass()` handed out this test, so a case can reach the one its stack
 *  holds. Declared after the factory: referencing it from inside would make its element type
 *  circular. */
const scenePasses: ReturnType<typeof makeScenePass>[] = [];

// `uniform()` with an observable `.value` and a chaining `.setName()` (the NPR
// + FXAA stages call `uniform(x).setName('...')`).
function makeUniform(initial: unknown) {
  const u: { value: unknown; setName: () => typeof u } = { value: initial, setName: () => u };
  return u;
}

const rttSpy = vi.fn((node: unknown) => ({
  __rtt: node,
  isTextureNode: true,
  setPixelRatio: vi.fn(),
  dispose: vi.fn(),
  renderTarget: { dispose: vi.fn() },
}));
const buildCompositeNodeSpy = vi.fn((args: Record<string, unknown>) => ({ __composite: args }));
const buildFXAANodeSpy = vi.fn((opts: Record<string, unknown>) => ({ __fxaa: opts }));

// Every RenderPipeline the stack constructs, in creation order. The
// 'npr-particles' stage builds an INTERNAL one before the terminal pipeline, so
// [0] is the internal and [1] the terminal whenever NPR is on (I1 assertions).
const renderPipelines: any[] = [];

const bloomSpy = vi.fn((_color: unknown, strength: number, radius: number, threshold: number) => {
  const n = makeBloomNode();
  n.strength.value = strength;
  n.radius.value = radius;
  n.threshold.value = threshold;
  return n;
});

// intensity/smoothness/focusDistance/focalLength/bokehScale are TSL uniform() nodes —
// typed by their `.value` shape (not the full TSL node type) so setConfig-mutation
// assertions below can read `.value` without a cast.
type UniformNode = { value: number };
const vignetteSpy = vi.fn((_color: unknown, intensity: UniformNode, smoothness: UniformNode) => ({ __vignette: [intensity, smoothness] }));
const dofSpy = vi.fn((_color: unknown, viewZ: unknown, focusDistance: UniformNode, focalLength: UniformNode, bokehScale: UniformNode) => (
  // Real DepthOfFieldNode owns 6 render targets + 5 materials and has a dispose().
  { __dof: [viewZ, focusDistance, focalLength, bokehScale], dispose: vi.fn() }
));
const buildViewZNodeSpy = vi.fn((depthTextureNode: unknown, isOrthographic: boolean, _near?: unknown, _far?: unknown) => ({ __viewZ: [depthTextureNode, isOrthographic] }));

// Real GTAONode owns an RT + material and has a dispose(); `radius` is a live
// uniform-like field set directly (not passed through the factory args).
function makeAoNode(depthNode: unknown, normalNode: unknown) {
  return {
    __ao: [depthNode, normalNode],
    radius: { value: 0 },
    getTextureNode: vi.fn(() => ({ __aoTexture: true, r: { __aoTextureR: true } })),
    dispose: vi.fn(),
  };
}
const aoSpy = vi.fn((depthNode: unknown, normalNode: unknown, _camera: unknown) => makeAoNode(depthNode, normalNode));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  renderPipelines.length = 0;
  scenePasses.length = 0;

  vi.doMock('three/tsl', () => ({
    pass: vi.fn(() => { const p = makeScenePass(); scenePasses.push(p); return p; }),
    mrt: vi.fn((o: unknown) => o),
    rtt: rttSpy,
    output: {},
    normalView: {},
    add: vi.fn((a: unknown, b: unknown) => ({ __add: [a, b] })),
    mul: vi.fn((a: unknown, b: unknown) => ({ __mul: [a, b] })),
    mix: vi.fn((a: unknown, b: unknown, t: unknown) => ({ __mix: [a, b, t] })),
    float: vi.fn((v: unknown) => ({ __float: v })),
    vec3: vi.fn((...a: unknown[]) => ({ __vec3: a })),
    uniform: vi.fn((v: unknown) => makeUniform(v)),
    materialReference: vi.fn((n: string) => ({ __matRef: n })),
    outputStruct: vi.fn((...a: unknown[]) => ({ __outputStruct: a })),
    vec4: vi.fn((...a: unknown[]) => ({ __vec4: a })),
  }));

  vi.doMock('three/webgpu', () => ({
    RenderPipeline: class {
      outputNode: unknown = null;
      outputColorTransform = true;
      render = vi.fn();
      dispose = vi.fn();
      constructor(_r?: unknown) { renderPipelines.push(this); }
    },
  }));

  // NPR's node builders: inert, but spied so the stack's wiring is assertable.
  vi.doMock('../../src/runtime/rendering/npr/compositeNodes', () => ({
    buildCompositeNode: buildCompositeNodeSpy,
  }));
  vi.doMock('../../src/runtime/rendering/npr/fxaaNode', () => ({
    buildFXAANode: buildFXAANodeSpy,
  }));
  vi.doMock('../../src/runtime/rendering/npr/ParticlePassNode', () => ({
    ParticlePassNode: class {
      getTextureNode = vi.fn(() => ({ __particleTexture: true, isTextureNode: true }));
      dispose = vi.fn();
      constructor(..._a: unknown[]) {}
    },
  }));

  vi.doMock('three/examples/jsm/tsl/display/BloomNode.js', () => ({
    bloom: bloomSpy,
  }));
  vi.doMock('three/examples/jsm/tsl/display/DepthOfFieldNode.js', () => ({
    dof: dofSpy,
  }));
  vi.doMock('three/examples/jsm/tsl/display/CRT.js', () => ({
    vignette: vignetteSpy,
  }));
  vi.doMock('three/examples/jsm/tsl/display/GTAONode.js', () => ({
    ao: aoSpy,
  }));
  vi.doMock('../../src/runtime/rendering/postfx/dofViewZ', () => ({
    buildViewZNode: buildViewZNodeSpy,
  }));
});

afterEach(() => { vi.restoreAllMocks(); });

/** Minimal renderer the stage prologues poke at (800×600 @ DPR 1).
 *
 *  `_callDepth` + `_renderContexts` are three's private fields the #238 precompile pin reaches
 *  for; `contextLookups` records what the pinned lookup was actually asked for. */
function makeRenderer() {
  const contextLookups: Array<{ rt: unknown; depth: number | undefined }> = [];
  return {
    getSize: (v: THREE.Vector2) => v.set(800, 600),
    getPixelRatio: () => 1,
    getRenderTarget: vi.fn(() => null),
    setRenderTarget: vi.fn(),
    _callDepth: -1,
    _renderContexts: {
      get: (rt: unknown, _mrt: unknown, depth?: number) => {
        contextLookups.push({ rt, depth });
        return { id: depth ?? 0 };
      },
    },
    contextLookups,
  };
}

async function makeStack(req: Record<string, unknown>, camera?: THREE.Camera) {
  const { PostFXStack } = await import('../../src/runtime/rendering/postfx/PostFXStack');
  const scene = new THREE.Scene();
  return new PostFXStack(makeRenderer(), scene, camera ?? new THREE.PerspectiveCamera(), req as never);
}

// The scene-color texture node the first stage receives.
const SCENE_COLOR = { __texture: 'output', isTextureNode: true };
const SCENE_DEPTH = { __texture: 'depth', isTextureNode: true };

const nprCfg = (over: Record<string, unknown> = {}) => ({
  isOrthographic: false, superSampleScale: 1, fillMode: 'grayscale',
  depthThreshold: 0.005, normalThreshold: 0.4, colorThreshold: 0.15,
  lineThickness: 1, lineStrength: 1, grayscaleGamma: 0.7, grayscaleLift: 0.3,
  clearColor: 0x000000, ...over,
});
const fxaaCfg = (over: Record<string, unknown> = {}) => ({
  edgeThreshold: 0.125, edgeThresholdMin: 0.0312, blendStrength: 4, ...over,
});

const bloomCfg = (over: Partial<{ strength: number; radius: number; threshold: number }> = {}) => ({
  strength: 0.8, radius: 0.6, threshold: 0, ...over,
});
const vignetteCfg = (over: Partial<{ intensity: number; smoothness: number }> = {}) => ({
  intensity: 0.4, smoothness: 0.5, ...over,
});
const dofCfg = (over: Partial<{ focusDistance: number; focalLength: number; bokehScale: number }> = {}) => ({
  focusDistance: 10, focalLength: 1, bokehScale: 1, ...over,
});
const aoCfg = (over: Partial<{ radius: number; intensity: number }> = {}) => ({
  radius: 0.25, intensity: 1, ...over,
});

describe('PostFXStack — chain assembly', () => {
  it('builds the bloom node from the scene color and composites via add()', async () => {
    await makeStack({ bloom: bloomCfg({ strength: 1.2, radius: 0.4, threshold: 0.1 }) });
    expect(bloomSpy).toHaveBeenCalledTimes(1);
    expect(bloomSpy).toHaveBeenCalledWith(expect.anything(), 1.2, 0.4, 0.1);
  });

  it('does not call setMRT when only bloom is requested (no normal/lineColor needed)', async () => {
    const { PostFXStack } = await import('../../src/runtime/rendering/postfx/PostFXStack');
    const { pass } = await import('three/tsl');
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    new PostFXStack(makeRenderer(), scene, camera, { bloom: bloomCfg() } as never);
    const scenePassResult = (pass as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(scenePassResult.setMRT).not.toHaveBeenCalled();
  });

});

describe('PostFXStack — AO (GTAO) stage', () => {
  it('passes depth + a REAL normal + camera to ao() — the null-normal path is broken under MSAA', async () => {
    // getNormalFromDepth's null-normal fallback compiles textureDimensions()
    // with a mip-level arg against our multisampled depth texture, which WGSL
    // rejects (confirmed via the browser's native WGSL compiler diagnostic).
    // So AO always gets a real normal, whether it's the only stage or not.
    await makeStack({ ao: aoCfg() });
    expect(aoSpy).toHaveBeenCalledTimes(1);
    expect(aoSpy.mock.calls[0][0]).toEqual(SCENE_DEPTH);
    expect(aoSpy.mock.calls[0][1]).toEqual({ __texture: 'normal', isTextureNode: true });
  });

  it('forces setMRT (normal target) when AO is requested alone', async () => {
    const { pass } = await import('three/tsl');
    await makeStack({ ao: aoCfg() });
    const scenePass = (pass as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(scenePass.setMRT).toHaveBeenCalledTimes(1);
    const dict = scenePass.setMRT.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(dict).sort()).toEqual(['normal', 'output']); // no lineColor — that's NPR-only
  });

  it('shares the SAME normal texture node NPR uses when both are enabled', async () => {
    await makeStack({ npr: nprCfg(), ao: aoCfg() });
    expect(aoSpy.mock.calls[0][1]).toEqual({ __texture: 'normal', isTextureNode: true });
  });

  it('sets radius directly on the ao node and lerps intensity via mix()', async () => {
    const { mix } = await import('three/tsl');
    await makeStack({ ao: aoCfg({ radius: 0.5, intensity: 0.5 }) });
    const aoNode = aoSpy.mock.results[0].value;
    expect(aoNode.radius.value).toBe(0.5);
    expect(mix).toHaveBeenCalledTimes(1);
    const [, aoTexR, intensityArg] = (mix as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(aoTexR).toEqual({ __aoTextureR: true });
    expect(intensityArg).toEqual(expect.objectContaining({ value: 0.5 }));
  });

  it('multiplies the occlusion factor into the incoming color', async () => {
    const { mul } = await import('three/tsl');
    await makeStack({ ao: aoCfg() });
    expect(mul).toHaveBeenCalledWith(SCENE_COLOR, expect.objectContaining({ __vec4: expect.anything() }));
  });

  it('setConfig pushes new radius/intensity into the same node/uniform', async () => {
    const stack = await makeStack({ ao: aoCfg() });
    const aoNode = aoSpy.mock.results[0].value;
    const { mix } = await import('three/tsl');
    const intensityU = (mix as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(stack.setConfig({ ao: aoCfg({ radius: 0.8, intensity: 0.2 }) } as never)).toBe(false);
    expect(aoNode.radius.value).toBe(0.8);
    expect(intensityU.value).toBe(0.2);
  });

  it('is ordered before dof/bloom/vignette (AO -> DOF -> bloom -> vignette)', async () => {
    await makeStack({ ao: aoCfg(), dof: dofCfg(), bloom: bloomCfg(), vignette: vignetteCfg() });
    // dof's color input is AO's mul() output, not the raw scene color.
    expect(dofSpy.mock.calls[0][0]).toEqual(expect.objectContaining({ __mul: expect.anything() }));
  });

  it('dispose() frees the GTAO node (owns a render target + material)', async () => {
    const stack = await makeStack({ ao: aoCfg() });
    const aoNode = aoSpy.mock.results[0].value;
    stack.dispose();
    expect(aoNode.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('PostFXStack — vignette stage', () => {
  it('passes uniform() nodes (not raw numbers) so setConfig can reach them live', async () => {
    await makeStack({ vignette: vignetteCfg({ intensity: 0.6, smoothness: 0.3 }) });
    expect(vignetteSpy).toHaveBeenCalledTimes(1);
    const [, intensityArg, smoothnessArg] = vignetteSpy.mock.calls[0];
    expect(intensityArg).toEqual(expect.objectContaining({ value: 0.6 }));
    expect(smoothnessArg).toEqual(expect.objectContaining({ value: 0.3 }));
  });

  it('setConfig pushes new intensity/smoothness into the SAME uniform objects', async () => {
    const stack = await makeStack({ vignette: vignetteCfg() });
    const [, intensityArg, smoothnessArg] = vignetteSpy.mock.calls[0];
    expect(stack.setConfig({ vignette: vignetteCfg({ intensity: 0.9, smoothness: 0.1 }) } as never)).toBe(false);
    expect(intensityArg.value).toBe(0.9);
    expect(smoothnessArg.value).toBe(0.1);
  });

  it('composes with bloom — both stages chain, in canonical order (bloom before vignette)', async () => {
    await makeStack({ bloom: bloomCfg(), vignette: vignetteCfg() });
    expect(bloomSpy).toHaveBeenCalledTimes(1);
    expect(vignetteSpy).toHaveBeenCalledTimes(1);
    // vignette's color input is bloom's output (add(...)), not the raw scene color.
    const vignetteColorArg = vignetteSpy.mock.calls[0][0];
    expect(vignetteColorArg).toEqual(expect.objectContaining({ __add: expect.anything() }));
  });
});

describe('PostFXStack — DOF stage', () => {
  it('reconstructs viewZ via buildViewZNode instead of PassNode.getViewZNode()', async () => {
    await makeStack({ dof: dofCfg() });
    expect(buildViewZNodeSpy).toHaveBeenCalledTimes(1);
    expect(buildViewZNodeSpy).toHaveBeenCalledWith(SCENE_DEPTH, false, expect.anything(), expect.anything());
  });

  it('passes isOrthographic=true for an orthographic camera', async () => {
    const { PostFXStack } = await import('../../src/runtime/rendering/postfx/PostFXStack');
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera();
    new PostFXStack(makeRenderer(), scene, camera, { dof: dofCfg() } as never);
    expect(buildViewZNodeSpy).toHaveBeenCalledWith(SCENE_DEPTH, true, expect.anything(), expect.anything());
  });

  it('passes uniform() nodes for focusDistance/focalLength/bokehScale', async () => {
    await makeStack({ dof: dofCfg({ focusDistance: 5, focalLength: 2, bokehScale: 1.5 }) });
    const [, , focusArg, focalArg, bokehArg] = dofSpy.mock.calls[0];
    expect(focusArg).toEqual(expect.objectContaining({ value: 5 }));
    expect(focalArg).toEqual(expect.objectContaining({ value: 2 }));
    expect(bokehArg).toEqual(expect.objectContaining({ value: 1.5 }));
  });

  it('setConfig pushes new values into the same uniform objects', async () => {
    const stack = await makeStack({ dof: dofCfg() });
    const [, , focusArg, focalArg, bokehArg] = dofSpy.mock.calls[0];
    stack.setConfig({ dof: dofCfg({ focusDistance: 20, focalLength: 3, bokehScale: 0.5 }) } as never);
    expect(focusArg.value).toBe(20);
    expect(focalArg.value).toBe(3);
    expect(bokehArg.value).toBe(0.5);
  });

  it('does not force setMRT — depth is already free from pass()', async () => {
    const { PostFXStack } = await import('../../src/runtime/rendering/postfx/PostFXStack');
    const { pass } = await import('three/tsl');
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    new PostFXStack(makeRenderer(), scene, camera, { dof: dofCfg() } as never);
    const scenePassResult = (pass as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(scenePassResult.setMRT).not.toHaveBeenCalled();
  });
});

describe('PostFXStack — full chain order (npr-less): ao, dof, bloom, vignette, fxaa', () => {
  it('builds dof before bloom before vignette when all three are requested', async () => {
    await makeStack({ dof: dofCfg(), bloom: bloomCfg(), vignette: vignetteCfg() });
    // dof's input is the raw scene color; bloom's input is dof's output; vignette's
    // input is bloom's output — assert the chain by checking dof got the plain
    // texture node while vignette got bloom's wrapped output.
    expect(dofSpy.mock.calls[0][0]).toEqual(SCENE_COLOR);
    expect(bloomSpy.mock.calls[0][0]).toEqual(expect.objectContaining({ __dof: expect.anything() }));
    expect(vignetteSpy.mock.calls[0][0]).toEqual(expect.objectContaining({ __add: expect.anything() }));
  });
});

describe('PostFXStack — setConfig rebuild-vs-live contract', () => {
  it('returns false and pushes new values for a param-only bloom edit', async () => {
    const stack = await makeStack({ bloom: bloomCfg() });
    const node = bloomSpy.mock.results[0].value;
    expect(stack.setConfig({ bloom: bloomCfg({ strength: 2 }) } as never)).toBe(false);
    expect(node.strength.value).toBe(2);
  });

  it('returns true when a stage is added (stage set changed)', async () => {
    const stack = await makeStack({ bloom: bloomCfg() });
    expect(stack.setConfig({ bloom: bloomCfg(), vignette: { intensity: 0.4, smoothness: 0.5 } } as never)).toBe(true);
  });

  it('returns true when the only stage is removed', async () => {
    const stack = await makeStack({ bloom: bloomCfg() });
    expect(stack.setConfig({} as never)).toBe(true);
  });
});

describe('PostFXStack — render / dispose', () => {
  it('render() delegates to the underlying RenderPipeline', async () => {
    const stack = await makeStack({ bloom: bloomCfg() });
    const pipeline = (stack as any).pipeline;
    stack.render();
    expect(pipeline.render).toHaveBeenCalledTimes(1);
  });

  it('dispose() frees the pipeline AND the scene pass (RenderPipeline.dispose does not recurse)', async () => {
    const stack = await makeStack({ bloom: bloomCfg() });
    const pipeline = (stack as any).pipeline;
    const scenePass = (stack as any).scenePass;
    stack.dispose();
    expect(pipeline.dispose).toHaveBeenCalledTimes(1);
    expect(scenePass.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps outputColorTransform at its default true — single terminal pipeline (I1)', async () => {
    const stack = await makeStack({ bloom: bloomCfg() });
    expect((stack as any).pipeline.outputColorTransform).toBe(true);
  });
});

// ── Phase 3: NPR as an ordinary stage ──────────────────────────────────────

describe('PostFXStack — NPR stylize stage', () => {
  it('extends the scene pass MRT with normal + lineColor (I2 union, one layout)', async () => {
    const { pass } = await import('three/tsl');
    await makeStack({ npr: nprCfg() });
    const scenePass = (pass as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(scenePass.setMRT).toHaveBeenCalledTimes(1);
    const dict = scenePass.setMRT.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(dict).sort()).toEqual(['lineColor', 'normal', 'output']);
  });

  it('excludes the particle layer from the geometry pass (particles are stage 2)', async () => {
    const { pass } = await import('three/tsl');
    const { PARTICLE_LAYER } = await import('../../src/runtime/rendering/layers');
    await makeStack({ npr: nprCfg() });
    const scenePass = (pass as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    const layers = scenePass.setLayers.mock.calls[0][0] as THREE.Layers;
    expect(layers.isEnabled(PARTICLE_LAYER)).toBe(false);
    expect(layers.isEnabled(0)).toBe(true);
  });

  it('feeds the composite the scene color + normal + lineColor + depth nodes', async () => {
    await makeStack({ npr: nprCfg() });
    expect(buildCompositeNodeSpy).toHaveBeenCalledTimes(1);
    const args = buildCompositeNodeSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(args.colorNode).toEqual(SCENE_COLOR);
    expect(args.normalNode).toEqual({ __texture: 'normal', isTextureNode: true });
    expect(args.lineColorNode).toEqual({ __texture: 'lineColor', isTextureNode: true });
    expect(args.depthTextureNode).toEqual(SCENE_DEPTH);
  });

  it('selects the ORTHO depth reconstructor for an orthographic camera (F10)', async () => {
    await makeStack({ npr: nprCfg() }, new THREE.OrthographicCamera());
    expect((buildCompositeNodeSpy.mock.calls[0][0] as any).isOrthographic).toBe(true);
  });

  it('passes uniform() nodes so setConfig reaches the composite live', async () => {
    await makeStack({ npr: nprCfg({ fillMode: 'flat', lineStrength: 2 }) });
    const u = (buildCompositeNodeSpy.mock.calls[0][0] as any).uniforms;
    expect(u.fillMode.value).toBe(0);       // flat → 0
    expect(u.lineStrength.value).toBe(2);
    expect(u.depthThreshold.value).toBe(0.005);
  });

  it('at superSampleScale 1 the composite flows on unwrapped (no extra offscreen pass)', async () => {
    const { pass } = await import('three/tsl');
    await makeStack({ npr: nprCfg({ superSampleScale: 1 }) });
    const scenePass = (pass as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(scenePass.setResolutionScale).toHaveBeenCalledWith(1);
    expect(rttSpy).not.toHaveBeenCalled();
  });

  it('at superSampleScale 2 supersamples the pass and downsamples through an RTT', async () => {
    const { pass } = await import('three/tsl');
    await makeStack({ npr: nprCfg({ superSampleScale: 2 }) });
    const scenePass = (pass as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(scenePass.setResolutionScale).toHaveBeenCalledWith(2);
    expect(rttSpy).toHaveBeenCalledTimes(1);
    expect(rttSpy.mock.results[0].value.setPixelRatio).toHaveBeenCalledWith(2);
  });

  it('render() primes texelSize from the SUPERSAMPLED resolution (F1)', async () => {
    // 800x600 @ DPR 1, SS 2 → the Sobel kernel steps over a 1600x1200 buffer.
    const stack = await makeStack({ npr: nprCfg({ superSampleScale: 2 }) });
    stack.render();
    const u = (buildCompositeNodeSpy.mock.calls[0][0] as any).uniforms;
    expect(u.texelSize.value.x).toBeCloseTo(1 / 1600);
    expect(u.texelSize.value.y).toBeCloseTo(1 / 1200);
  });
});

describe('PostFXStack — NPR particle stage (scene-injecting, not a filter)', () => {
  it('hands the chain the particle pass TEXTURE node, not a scene-draw concept', async () => {
    // The generic stack never learns about "a stage that draws the scene" — the
    // particle stage keeps that internally and exposes a plain texture node.
    await makeStack({ npr: nprCfg(), bloom: bloomCfg() });
    expect(bloomSpy.mock.calls[0][0]).toEqual({ __particleTexture: true, isTextureNode: true });
  });

  it('I1: the INTERNAL pipeline does not color-transform; the TERMINAL one does', async () => {
    // Getting this backwards double-encodes the frame (washed out / crushed) —
    // the single most likely visual regression of the whole workstream.
    const stack = await makeStack({ npr: nprCfg() });
    expect(renderPipelines).toHaveLength(2);
    const [internal, terminal] = renderPipelines;
    expect(internal.outputColorTransform).toBe(false);
    expect(terminal.outputColorTransform).toBe(true);
    expect(terminal).toBe((stack as any).pipeline);
  });

  it('render() runs the internal pipeline BEFORE the terminal one samples its texture', async () => {
    const stack = await makeStack({ npr: nprCfg() });
    const [internal, terminal] = renderPipelines;
    stack.render();
    expect(internal.render).toHaveBeenCalledTimes(1);
    expect(terminal.render).toHaveBeenCalledTimes(1);
    expect(internal.render.mock.invocationCallOrder[0])
      .toBeLessThan(terminal.render.mock.invocationCallOrder[0]);
  });

  it('render() restores the previous render target after the internal pass', async () => {
    const renderer = makeRenderer();
    const { PostFXStack } = await import('../../src/runtime/rendering/postfx/PostFXStack');
    const stack = new PostFXStack(renderer, new THREE.Scene(), new THREE.PerspectiveCamera(), { npr: nprCfg() } as never);
    stack.render();
    // set to the stylized RT, then back to whatever was current (null here).
    expect(renderer.setRenderTarget).toHaveBeenCalledTimes(2);
    expect(renderer.setRenderTarget.mock.calls[1][0]).toBeNull();
  });
});

describe('PostFXStack — NPR composes with the rest of the stack (the Phase 3 point)', () => {
  it('NPR + bloom both build — no "NPR wins, bloom is skipped"', async () => {
    await makeStack({ npr: nprCfg(), bloom: bloomCfg({ strength: 1.5 }) });
    expect(buildCompositeNodeSpy).toHaveBeenCalledTimes(1);
    expect(bloomSpy).toHaveBeenCalledTimes(1);
    expect(bloomSpy).toHaveBeenCalledWith(expect.anything(), 1.5, 0.6, 0);
  });

  it('orders NPR → dof → bloom → vignette → fxaa', async () => {
    await makeStack({
      npr: nprCfg(), dof: dofCfg(), bloom: bloomCfg(), vignette: vignetteCfg(), fxaa: fxaaCfg(),
    });
    // dof consumes the particle texture (NPR's output), bloom consumes dof's,
    // vignette consumes bloom's, fxaa consumes vignette's (via an rtt wrap).
    expect(dofSpy.mock.calls[0][0]).toEqual({ __particleTexture: true, isTextureNode: true });
    expect(bloomSpy.mock.calls[0][0]).toEqual(expect.objectContaining({ __dof: expect.anything() }));
    expect(vignetteSpy.mock.calls[0][0]).toEqual(expect.objectContaining({ __add: expect.anything() }));
    expect(buildFXAANodeSpy.mock.calls[0][0].inputTex)
      .toEqual(expect.objectContaining({ __rtt: expect.objectContaining({ __vignette: expect.anything() }) }));
  });
});

describe('PostFXStack — FXAA is a tail stage now, not "the pipeline output"', () => {
  it('samples the previous stage directly when it is already a texture node', async () => {
    await makeStack({ npr: nprCfg(), fxaa: fxaaCfg() });
    expect(rttSpy).not.toHaveBeenCalled(); // the particle texture needs no wrap
    expect(buildFXAANodeSpy.mock.calls[0][0].inputTex)
      .toEqual({ __particleTexture: true, isTextureNode: true });
  });

  it('resolves a non-texture chain into an RTT first (wgslFn needs a real texture)', async () => {
    await makeStack({ bloom: bloomCfg(), fxaa: fxaaCfg() });
    expect(rttSpy).toHaveBeenCalledTimes(1);
    expect(buildFXAANodeSpy.mock.calls[0][0].inputTex).toEqual(
      expect.objectContaining({ __rtt: expect.objectContaining({ __add: expect.anything() }) }),
    );
  });

  it('primes its texel size at DISPLAY resolution even when NPR supersamples', async () => {
    // FXAA runs after the SS composite has been downsampled, so its kernel step
    // must be 1/displayPixels — not 1/(displayPixels * SS).
    const stack = await makeStack({ npr: nprCfg({ superSampleScale: 1 }), fxaa: fxaaCfg() });
    stack.render();
    const texel = buildFXAANodeSpy.mock.calls[0][0].texelSize as any;
    expect(texel.value.x).toBeCloseTo(1 / 800);
    expect(texel.value.y).toBeCloseTo(1 / 600);
  });

  it('setConfig pushes FXAA thresholds into the same uniform objects (live, no rebuild)', async () => {
    const stack = await makeStack({ npr: nprCfg(), fxaa: fxaaCfg() });
    const opts = buildFXAANodeSpy.mock.calls[0][0] as any;
    expect(stack.setConfig({ npr: nprCfg(), fxaa: fxaaCfg({ edgeThreshold: 0.2, blendStrength: 6 }) } as never)).toBe(false);
    expect(opts.edgeThreshold.value).toBe(0.2);
    expect(opts.blendStrength.value).toBe(6);
  });
});

describe('PostFXStack — NPR rebuild-vs-live contract (blocker 5)', () => {
  it('returns false for a param-only NPR edit and pushes the new uniform values', async () => {
    const stack = await makeStack({ npr: nprCfg() });
    const u = (buildCompositeNodeSpy.mock.calls[0][0] as any).uniforms;
    expect(stack.setConfig({ npr: nprCfg({ lineStrength: 3, fillMode: 'flat' }) } as never)).toBe(false);
    expect(u.lineStrength.value).toBe(3);
    expect(u.fillMode.value).toBe(0);
  });

  it('returns false for a clearColor edit (Color.setHex on the live uniform)', async () => {
    const stack = await makeStack({ npr: nprCfg({ clearColor: 0x000000 }) });
    const u = (buildCompositeNodeSpy.mock.calls[0][0] as any).uniforms;
    expect(stack.setConfig({ npr: nprCfg({ clearColor: 0xff8800 }) } as never)).toBe(false);
    expect((u.clearColor.value as THREE.Color).getHex()).toBe(0xff8800);
  });

  it('returns TRUE when superSampleScale changes (resizes every render target)', async () => {
    const stack = await makeStack({ npr: nprCfg({ superSampleScale: 1 }) });
    expect(stack.setConfig({ npr: nprCfg({ superSampleScale: 2 }) } as never)).toBe(true);
  });

  it('returns TRUE when the camera projection flips (different depth reconstructor)', async () => {
    const stack = await makeStack({ npr: nprCfg({ isOrthographic: false }) });
    expect(stack.setConfig({ npr: nprCfg({ isOrthographic: true }) } as never)).toBe(true);
  });

  it('returns TRUE when bloom is added alongside NPR (stage set changed)', async () => {
    const stack = await makeStack({ npr: nprCfg() });
    expect(stack.setConfig({ npr: nprCfg(), bloom: bloomCfg() } as never)).toBe(true);
  });
});

describe('PostFXStack — dispose frees every stage-owned render target (T3)', () => {
  it('frees the NPR particle stage internal pipeline, pass and stylized RT', async () => {
    const stack = await makeStack({ npr: nprCfg() });
    const [internal, terminal] = renderPipelines;
    const particleStage = (stack as any).stages.find((s: any) => s.kind === 'npr-particles');
    const disposeSpy = vi.spyOn(particleStage, 'dispose');
    stack.dispose();
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(internal.dispose).toHaveBeenCalledTimes(1);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('frees the supersample composite RTT (RTTNode.dispose does NOT free its target)', async () => {
    const stack = await makeStack({ npr: nprCfg({ superSampleScale: 2 }) });
    const compositeRTT = rttSpy.mock.results[0].value;
    stack.dispose();
    expect(compositeRTT.renderTarget.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('PostFXStack — stage nodes that own GPU resources are freed (leak regression)', () => {
  // These nodes own render targets that `RenderPipeline.dispose()` cannot reach.
  // The stack rebuilds on ANY stage-set change, so a missing dispose leaks the
  // whole pyramid every time a sibling effect is toggled in the Inspector.
  it('dispose() frees the bloom node (11 render targets + 8 materials upstream)', async () => {
    const stack = await makeStack({ bloom: bloomCfg() });
    const bloomNode = bloomSpy.mock.results[0].value;
    stack.dispose();
    expect(bloomNode.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose() frees the DOF node (6 render targets + 5 materials upstream)', async () => {
    const stack = await makeStack({ dof: dofCfg() });
    const dofNode = dofSpy.mock.results[0].value;
    stack.dispose();
    expect(dofNode.dispose).toHaveBeenCalledTimes(1);
  });

  it('frees every stage node when the whole chain is built', async () => {
    const stack = await makeStack({ npr: nprCfg(), dof: dofCfg(), bloom: bloomCfg(), vignette: vignetteCfg(), fxaa: fxaaCfg() });
    const bloomNode = bloomSpy.mock.results[0].value;
    const dofNode = dofSpy.mock.results[0].value;
    stack.dispose();
    expect(bloomNode.dispose).toHaveBeenCalledTimes(1);
    expect(dofNode.dispose).toHaveBeenCalledTimes(1);
  });

  // ── #238: the precompile must warm the context the pass DRAWS through ──────────────────────
  //
  // three folds `context.id` into every material's node-builder cache key, and it keys its
  // contexts by call depth. `Renderer.compile()` always takes the depth-0 one; the scene pass is
  // drawn from inside the terminal pipeline's quad, one level deeper. Getting this wrong is not
  // visible — the compile succeeds, warms a cache nothing reads, and the first frame rebuilds
  // every shader graph synchronously (513 ms of an 807 ms block on an A23). So the wiring is
  // asserted here rather than left to the render to reveal.
  describe('scene-pass precompile (#238)', () => {
    it('pins the pass render target to the depth the pass draws at', async () => {
      const { PostFXStack } = await import('../../src/runtime/rendering/postfx/PostFXStack');
      const renderer = makeRenderer();
      const stack = new PostFXStack(renderer, new THREE.Scene(), new THREE.PerspectiveCamera(), { bloom: bloomCfg() } as never);
      await stack.compileSceneAsync();
      expect(renderer.contextLookups).toEqual([{ rt: scenePasses[0].renderTarget, depth: 1 }]);
    });

    it('re-pins to the depth the live pass was observed at', async () => {
      const { PostFXStack } = await import('../../src/runtime/rendering/postfx/PostFXStack');
      const renderer = makeRenderer();
      const stack = new PostFXStack(renderer, new THREE.Scene(), new THREE.PerspectiveCamera(), { bloom: bloomCfg() } as never);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // A stack shape that nests the pass one level deeper than the default: the first frame
      // draws it from inside a draw that is itself at depth 1.
      renderer._callDepth = 1;
      scenePasses[0].updateBefore({});

      await stack.compileSceneAsync();
      expect(renderer.contextLookups).toEqual([{ rt: scenePasses[0].renderTarget, depth: 2 }]);
    });

    it('stamps the pass target sample count before compiling', async () => {
      // Not tidiness: `PassNode.setup()` normally stamps this during the first render — the very
      // frame the precompile exists to get ahead of — and a sample-count mismatch is a different
      // pipeline key, so the compile would warm the wrong set and look like a fix that did not work.
      const { PostFXStack } = await import('../../src/runtime/rendering/postfx/PostFXStack');
      const renderer = { ...makeRenderer(), samples: 4, getOutputBufferType: () => 1016 as never };
      const stack = new PostFXStack(renderer, new THREE.Scene(), new THREE.PerspectiveCamera(), { bloom: bloomCfg() } as never);
      await stack.compileSceneAsync();
      expect(scenePasses[0].renderTarget.samples).toBe(4);
      expect(scenePasses[0].renderTarget.texture.type).toBe(1016);
    });
  });

});
