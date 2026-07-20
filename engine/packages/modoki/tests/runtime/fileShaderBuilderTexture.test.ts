/** fileShaderBuilder — texture params route through the shared texture resolver.
 *
 *  Regression guard for F2 [HIGH]: a `texture`-typed file-shader param must be
 *  loaded via `loadTexture3D` (the same resolver UINode/3D materials use) so its
 *  GUID resolves to the converted KTX2/WebP variant. The previous code used a
 *  bespoke `new THREE.TextureLoader().load(assetUrl(resolveRef(ref)))`, which
 *  fetched the SOURCE PNG — dropped from production builds → 404 → white fallback.
 *
 *  The WGSL/TSL node pipeline is mocked away so the test never touches a GPU:
 *  `three/tsl`'s `texture()` is stubbed to a tagged node, `nprFragmentOutput`
 *  is a passthrough, `fetch` serves the manifest + variant body, and
 *  `textureResolver.loadTexture3D` is the unit under assertion. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A sentinel for the resolved variant texture (what loadTexture3D returns).
const RESOLVED_TEXTURE = { __resolved: true, isTexture: true };

// Stub TSL so `texture(tex)` is observable and no WebGPU node graph is built.
const textureNodeFactory = vi.fn((tex: unknown) => ({ __texNode: true, tex }));
const vec4Factory = vi.fn((...a: number[]) => ({ __vec4: a }));

const loadTexture3D = vi.fn(async (_ref: string, _opts?: { flipY?: boolean }) => RESOLVED_TEXTURE);

function makeNodeStub() {
  const node: Record<string, unknown> = {};
  node.toVar = () => node;
  node.rgb = node;
  node.a = node;
  return node;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  loadTexture3D.mockImplementation(async () => RESOLVED_TEXTURE);

  const tslStub = () => ({
    wgslFn: () => (_inputs: Record<string, unknown>) => makeNodeStub(),
    glslFn: () => (_inputs: Record<string, unknown>) => makeNodeStub(),
    vec2: vi.fn((...a: number[]) => ({ __vec2: a })),
    vec3: vi.fn((...a: number[]) => ({ __vec3: a })),
    vec4: vec4Factory,
    uv: () => ({ __uv: true }),
    normalView: {}, normalWorld: {}, positionView: {}, positionWorld: {}, time: {},
    texture: textureNodeFactory,
  });
  // `three/tsl` is aliased to a stub in vitest.config (the bare `three` alias
  // shadows three's exports map); this doMock overrides that stub so we can
  // observe the `texture()`/`vec4()` calls the builder makes.
  vi.doMock('three/tsl', tslStub);
  vi.doMock('three/webgpu', () => ({
    NodeMaterial: class { userData: Record<string, unknown> = {}; side = 0; transparent = false; opacity = 1; },
  }));
  vi.doMock('../../src/runtime/rendering/npr/NPRPostProcess', () => ({
    nprFragmentOutput: vi.fn((c: unknown) => c),
  }));
  // Scene-light inputs are irrelevant to texture-param routing; stub them so the
  // builder doesn't pull the real TSL lighting nodes through the mocked three/tsl.
  vi.doMock('../../src/runtime/rendering/sceneLightUniforms', () => ({
    getSceneLightUniforms: () => ({
      keyLightDir: {}, keyLightColor: {}, ambientColor: {},
      pointPos: [], pointColor: [], pointInvRange: [],
    }),
    buildSceneDiffuseNode: () => ({}),
  }));
  vi.doMock('../../src/runtime/rendering/gpuDetect', () => ({
    getWebGPUSupported: async () => true, // → wgsl branch
  }));
  vi.doMock('../../src/runtime/loaders/textureResolver', () => ({ loadTexture3D }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const MANIFEST = {
  params: { albedo: { type: 'texture', default: '' } },
};

/** Serve the `.shader.json` manifest and the `.wgsl` body for any fetch. */
function stubFetch(manifest: unknown = MANIFEST) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('.wgsl') || String(url).endsWith('.glsl')) {
      return { ok: true, text: async () => 'fn main() -> vec4 { return vec4(1.0); }' };
    }
    return { ok: true, json: async () => manifest };
  }));
}

describe('fileShaderBuilder — texture params go through the variant resolver (F2)', () => {
  it('calls loadTexture3D with the texture ref (GUID), not a raw TextureLoader', async () => {
    stubFetch();
    const { buildFileShaderMaterial } = await import('../../src/runtime/loaders/fileShaderBuilder');

    const mat = await buildFileShaderMaterial('/games/x/assets/shaders/holo.shader.json', {
      params: { albedo: 'tex-guid-123' },
    });

    expect(mat).not.toBeNull();
    // Routed through the shared resolver with the ref + flipY:false convention.
    expect(loadTexture3D).toHaveBeenCalledTimes(1);
    expect(loadTexture3D).toHaveBeenCalledWith('tex-guid-123', { flipY: false });
  });

  it('wraps the RESOLVED variant texture in the TSL texture() node (not the raw ref/source)', async () => {
    stubFetch();
    const { buildFileShaderMaterial } = await import('../../src/runtime/loaders/fileShaderBuilder');

    const mat = await buildFileShaderMaterial('/x/holo.shader.json', { params: { albedo: 'tex-guid-123' } });

    // texture() was fed the object loadTexture3D resolved — the converted variant,
    // never the raw GUID string or a source path.
    expect(textureNodeFactory).toHaveBeenCalledTimes(1);
    expect(textureNodeFactory).toHaveBeenCalledWith(RESOLVED_TEXTURE);
    // And that concrete texture is stashed for disposal.
    expect((mat!.userData as { textures?: unknown[] }).textures).toEqual([RESOLVED_TEXTURE]);
  });

  it('falls back to white (vec4) without crashing when the resolver throws', async () => {
    stubFetch();
    loadTexture3D.mockRejectedValueOnce(new Error('404 source dropped in prod'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { buildFileShaderMaterial } = await import('../../src/runtime/loaders/fileShaderBuilder');

    const mat = await buildFileShaderMaterial('/x/holo.shader.json', { params: { albedo: 'tex-guid-123' } });

    expect(mat).not.toBeNull();
    expect(textureNodeFactory).not.toHaveBeenCalled(); // no texture node on failure
    expect(vec4Factory).toHaveBeenCalledWith(1, 1, 1, 1); // white fallback
    expect((mat!.userData as { textures?: unknown[] }).textures).toBeUndefined();
  });

  it('uses the white fallback for an empty texture ref without calling the resolver', async () => {
    stubFetch();
    const { buildFileShaderMaterial } = await import('../../src/runtime/loaders/fileShaderBuilder');

    await buildFileShaderMaterial('/x/holo.shader.json', { params: { albedo: '' } });

    expect(loadTexture3D).not.toHaveBeenCalled();
    expect(vec4Factory).toHaveBeenCalledWith(1, 1, 1, 1);
  });
});
