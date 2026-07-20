/** fileShaderBuilder — file-based shader (.shader.json + .wgsl/.glsl) loading.
 *  (runtime-texture-shader-font F5.) The heaviest/riskiest file in scope and
 *  previously only mocked indirectly. The GPU-touching deps (three/webgpu, three/tsl,
 *  NPRPostProcess, textureResolver, gpuDetect) are stubbed so the test exercises the
 *  builder's pure logic + control flow without a WebGPU/TSL context. `three` (Color)
 *  and `shaderSchema` (coerceParamValue/fetchShaderManifest) stay real. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Tagged TSL stubs — every node-builder returns a recognizable plain object so we
// can assert which conversion ran without a real render context.
vi.mock('three/webgpu', () => ({ NodeMaterial: class { userData: Record<string, unknown> = {}; side = 0; transparent = false; opacity = 1; } }));
vi.mock('three/tsl', () => {
  const fnNode = (kind: string) => () => (args: Record<string, unknown>) => ({
    __call: kind, args,
    toVar: () => ({ rgb: { __t: 'rgb' }, a: { __t: 'a' } }),
  });
  return {
  wgslFn: fnNode('wgsl'),
  glslFn: fnNode('glsl'),
  vec2: (...a: unknown[]) => ({ __t: 'vec2', a }),
  vec3: (...a: unknown[]) => ({ __t: 'vec3', a }),
  vec4: (...a: unknown[]) => ({ __t: 'vec4', a }),
  uv: () => ({ __t: 'uv' }),
  normalView: { __t: 'nView' }, normalWorld: { __t: 'nWorld' },
  positionView: { __t: 'pView' }, positionWorld: { __t: 'pWorld' },
  time: { __t: 'time' },
  texture: (t: unknown) => ({ __t: 'texture', t }),
  };
});
vi.mock('../../src/runtime/rendering/npr/NPRPostProcess', () => ({
  nprFragmentOutput: (...a: unknown[]) => ({ __npr: a }),
}));
// Scene-light inputs aren't under test here; stub so the builder doesn't reach
// the real TSL lighting nodes through the mocked three/tsl.
vi.mock('../../src/runtime/rendering/sceneLightUniforms', () => ({
  getSceneLightUniforms: () => ({
    keyLightDir: { __t: 'keyLightDir' }, keyLightColor: { __t: 'keyLightColor' },
    ambientColor: { __t: 'ambientColor' }, pointPos: [], pointColor: [], pointInvRange: [],
  }),
  buildSceneDiffuseNode: () => ({ __t: 'sceneDiffuse' }),
}));
const { getWebGPUSupported, loadTexture3D } = vi.hoisted(() => ({
  getWebGPUSupported: vi.fn(async () => true),
  loadTexture3D: vi.fn(async () => ({ isTexture: true, name: 'fake' })),
}));
vi.mock('../../src/runtime/rendering/gpuDetect', () => ({ getWebGPUSupported: () => getWebGPUSupported() }));
vi.mock('../../src/runtime/loaders/textureResolver', () => ({ loadTexture3D: (...a: unknown[]) => loadTexture3D(...(a as [])) }));

import { stripComments, paramNode, buildFileShaderMaterial } from '../../src/runtime/loaders/fileShaderBuilder';
import type { ShaderParam, ShaderManifest } from '../../src/runtime/loaders/shaderSchema';

describe('stripComments', () => {
  it('removes leading doc, line, and block comments and trims', () => {
    const src = `/** doc\n * comment */\nfn main() { // trailing\n  let x = 1; /* inline */ return x;\n}`;
    const out = stripComments(src);
    expect(out.startsWith('fn main()')).toBe(true);
    expect(out).not.toContain('doc');
    expect(out).not.toContain('trailing');
    expect(out).not.toContain('inline');
  });
});

describe('paramNode', () => {
  const P = (type: ShaderParam['type'], def: unknown): ShaderParam => ({ type, default: def });

  it('float passes the number through', () => {
    expect(paramNode(P('float', 0), 2.5)).toBe(2.5);
  });
  it('bool passes the boolean through', () => {
    expect(paramNode(P('bool', false), true)).toBe(true);
  });
  it('color -> vec3 of normalized r/g/b', () => {
    const n = paramNode(P('color', 0xffffff), 0xff0000) as { __t: string; a: number[] };
    expect(n.__t).toBe('vec3');
    expect(n.a).toEqual([1, 0, 0]); // pure red
  });
  it('vec2/vec3/vec4 pass components through', () => {
    expect((paramNode(P('vec2', [0, 0]), [1, 2]) as { a: number[] }).a).toEqual([1, 2]);
    expect((paramNode(P('vec3', [0, 0, 0]), [1, 2, 3]) as { a: number[] }).a).toEqual([1, 2, 3]);
    expect((paramNode(P('vec4', [0, 0, 0, 0]), [1, 2, 3, 4]) as { a: number[] }).a).toEqual([1, 2, 3, 4]);
  });
  it('falls back to the schema default when the value is missing', () => {
    expect(paramNode(P('float', 7), undefined)).toBe(7);
  });
});

describe('buildFileShaderMaterial — control flow', () => {
  const realFetch = globalThis.fetch;
  let manifest: ShaderManifest | null;
  let bodyOk: boolean;

  function mockFetch() {
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('.shader.json')) {
        return manifest
          ? ({ ok: true, json: async () => manifest } as Response)
          : ({ ok: false, json: async () => ({}) } as Response);
      }
      if (u.endsWith('.wgsl') || u.endsWith('.glsl')) {
        return ({ ok: bodyOk, text: async () => 'fn main() { return vec4(1.0); }' } as Response);
      }
      return ({ ok: false } as Response);
    }) as typeof fetch;
  }

  beforeEach(() => {
    manifest = { params: {} };
    bodyOk = true;
    getWebGPUSupported.mockResolvedValue(true);
    loadTexture3D.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch();
  });
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it('returns null when the manifest is missing', async () => {
    manifest = null;
    expect(await buildFileShaderMaterial('/a/x.shader.json', {})).toBeNull();
  });

  it('returns null when the backend body variant is missing', async () => {
    bodyOk = false; // .wgsl 404
    expect(await buildFileShaderMaterial('/a/x.shader.json', {})).toBeNull();
  });

  it('routes colorPreserve:"alpha" into the two-arg nprFragmentOutput (color + mask)', async () => {
    manifest = { params: {}, colorPreserve: 'alpha' };
    const mat = await buildFileShaderMaterial('/a/x.shader.json', {}) as unknown as { fragmentNode: { __npr: unknown[] } };
    expect(mat).not.toBeNull();
    expect(mat.fragmentNode.__npr).toHaveLength(2); // vec4(rgb,1) + alpha mask
  });

  it('default (no colorPreserve) uses the single-arg nprFragmentOutput', async () => {
    const mat = await buildFileShaderMaterial('/a/x.shader.json', {}) as unknown as { fragmentNode: { __npr: unknown[] } };
    expect(mat.fragmentNode.__npr).toHaveLength(1);
  });

  it('loads texture params and stashes the texture on userData for disposal', async () => {
    manifest = { params: { tex: { type: 'texture', default: '' } } };
    const mat = await buildFileShaderMaterial('/a/x.shader.json', { params: { tex: 'guid-123' } }) as unknown as { userData: { textures?: unknown[] } };
    expect(loadTexture3D).toHaveBeenCalledTimes(1);
    expect(mat.userData.textures).toHaveLength(1);
  });

  it('picks the GLSL variant when WebGPU is unsupported', async () => {
    getWebGPUSupported.mockResolvedValue(false);
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>;
    await buildFileShaderMaterial('/a/x.shader.json', {});
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith('.glsl'))).toBe(true);
    expect(urls.some((u) => u.endsWith('.wgsl'))).toBe(false);
  });
});
