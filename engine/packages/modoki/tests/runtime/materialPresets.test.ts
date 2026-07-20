/** materialPresets — runtime `type: 'custom'` shader resolution.
 *
 *  customBuilder dispatches in three ways and must fall back to a standard PBR
 *  material whenever resolution fails (rather than rendering nothing):
 *    1. a code-registered shader name → getCustomShader(name)
 *    2. a `.shader.json` asset ref     → buildFileShaderMaterial(path, data)
 *    3. neither / missing variant / no `shader` field → pbr fallback
 *
 *  customShaders, assetManifest and fileShaderBuilder are mocked so the test
 *  stays free of the WebGPU/TSL node pipeline; the pbr fallback uses a real
 *  THREE.MeshStandardMaterial (constructs fine without a GPU context). */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

interface Opts {
  customShaders?: Record<string, (params: Record<string, unknown>) => unknown>;
  refs?: Record<string, string>;
  buildFileShaderMaterial?: (path: string, data: Record<string, unknown>) => Promise<unknown>;
}

async function customBuilder(opts: Opts = {}) {
  const getCustomShader = vi.fn((name: string) => opts.customShaders?.[name]);
  const resolveRef = vi.fn((ref: string) => opts.refs?.[ref]);
  const buildFileShaderMaterial = vi.fn(opts.buildFileShaderMaterial ?? (async () => null));

  vi.doMock('../../src/runtime/loaders/customShaders', () => ({ getCustomShader }));
  vi.doMock('../../src/runtime/loaders/assetManifest', () => ({ resolveRef }));
  vi.doMock('../../src/runtime/loaders/fileShaderBuilder', () => ({ buildFileShaderMaterial }));

  const { registerBuiltinMaterialTypes } = await import('../../src/runtime/loaders/materialPresets');
  const { getMaterialBuilder } = await import('../../src/runtime/loaders/materialTypes');
  registerBuiltinMaterialTypes();
  const builder = getMaterialBuilder('custom')!;
  return { builder, getCustomShader, resolveRef, buildFileShaderMaterial };
}

const isPbr = (m: unknown) => (m as { type?: string })?.type === 'MeshStandardMaterial';

describe('materialPresets — customBuilder dispatch', () => {
  it('falls back to a PBR material when no shader field is set', async () => {
    const { builder } = await customBuilder();
    const mat = await builder.build({ color: 0x123456 });
    expect(isPbr(mat)).toBe(true);
    expect((mat as { color: { getHex(): number } }).color.getHex()).toBe(0x123456);
    expect(console.warn).toHaveBeenCalled();
  });

  it('dispatches a code-registered shader name to its build fn with params', async () => {
    const codeMat = { tag: 'code' };
    const build = vi.fn(async () => codeMat);
    const { builder } = await customBuilder({ customShaders: { 'game/holo': build } });

    const mat = await builder.build({ shader: 'game/holo', params: { power: 3 } });
    expect(mat).toBe(codeMat);
    expect(build).toHaveBeenCalledWith({ power: 3 });
  });

  it('passes an empty params object to a code shader when params is absent', async () => {
    const build = vi.fn(async () => ({ tag: 'code' }));
    const { builder } = await customBuilder({ customShaders: { 'game/x': build } });
    await builder.build({ shader: 'game/x' });
    expect(build).toHaveBeenCalledWith({});
  });

  it('forwards the material top-level texture ref into the shader params', async () => {
    // Texture-driven shaders (e.g. the planet projection) bind their own map via
    // TSL; meshTemplateCache's `.map` path is skipped for NodeMaterials, so the
    // builder hands the ref down through params.
    const build = vi.fn(async () => ({ tag: 'code' }));
    const { builder } = await customBuilder({ customShaders: { 'game/planet': build } });
    await builder.build({ shader: 'game/planet', texture: 'tex-guid', params: { ambient: 0.3 } });
    expect(build).toHaveBeenCalledWith({ ambient: 0.3, texture: 'tex-guid' });
  });

  it('does not override an explicit params.texture with the top-level one', async () => {
    const build = vi.fn(async () => ({ tag: 'code' }));
    const { builder } = await customBuilder({ customShaders: { 'game/planet': build } });
    await builder.build({ shader: 'game/planet', texture: 'top', params: { texture: 'explicit' } });
    expect(build).toHaveBeenCalledWith({ texture: 'explicit' });
  });

  it('resolves a .shader.json asset ref to buildFileShaderMaterial', async () => {
    const fileMat = { tag: 'file' };
    const { builder, buildFileShaderMaterial } = await customBuilder({
      refs: { 'guid-1': '/games/x/assets/shaders/holo.shader.json' },
      buildFileShaderMaterial: async () => fileMat,
    });

    const data = { shader: 'guid-1', params: { rimColor: 1 } };
    const mat = await builder.build(data);
    expect(mat).toBe(fileMat);
    expect(buildFileShaderMaterial).toHaveBeenCalledWith('/games/x/assets/shaders/holo.shader.json', data);
  });

  it('falls back to PBR when the file shader has no backend-matched variant', async () => {
    const { builder } = await customBuilder({
      refs: { 'guid-2': '/x/holo.shader.json' },
      buildFileShaderMaterial: async () => null, // variant missing → null
    });
    const mat = await builder.build({ shader: 'guid-2', color: 0xabcdef });
    expect(isPbr(mat)).toBe(true);
    expect((mat as { color: { getHex(): number } }).color.getHex()).toBe(0xabcdef);
  });

  it('falls back to PBR for a shader that is neither registered nor a .shader.json', async () => {
    const { builder, buildFileShaderMaterial } = await customBuilder({
      refs: { 'guid-3': '/x/mesh.mesh.json' }, // resolves, but not a shader asset
    });
    const mat = await builder.build({ shader: 'guid-3' });
    expect(isPbr(mat)).toBe(true);
    expect(buildFileShaderMaterial).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('materialPresets — pbrBuilder full MeshStandardMaterial surface', () => {
  async function pbr() {
    const { registerBuiltinMaterialTypes } = await import('../../src/runtime/loaders/materialPresets');
    const { getMaterialBuilder } = await import('../../src/runtime/loaders/materialTypes');
    registerBuiltinMaterialTypes();
    return getMaterialBuilder('pbr')!;
  }

  it('applies emissive color + intensity, flags, and the map-intensity scalars', async () => {
    const builder = await pbr();
    const m = (await builder.build({
      emissive: 0x112233, emissiveIntensity: 2.5,
      aoMapIntensity: 0.4, lightMapIntensity: 0.7, bumpScale: 3,
      displacementScale: 1.5, displacementBias: 0.2,
      flatShading: true, wireframe: true, vertexColors: true,
    })) as unknown as {
      emissive: { getHex(): number }; emissiveIntensity: number; aoMapIntensity: number;
      lightMapIntensity: number; bumpScale: number; displacementScale: number;
      displacementBias: number; flatShading: boolean; wireframe: boolean; vertexColors: boolean;
    };
    expect(m.emissive.getHex()).toBe(0x112233);
    expect(m.emissiveIntensity).toBe(2.5);
    expect(m.aoMapIntensity).toBe(0.4);
    expect(m.lightMapIntensity).toBe(0.7);
    expect(m.bumpScale).toBe(3);
    expect(m.displacementScale).toBe(1.5);
    expect(m.displacementBias).toBe(0.2);
    expect(m.flatShading).toBe(true);
    expect(m.wireframe).toBe(true);
    expect(m.vertexColors).toBe(true);
  });

  it('leaves THREE defaults for params not present in the .mat.json', async () => {
    const builder = await pbr();
    const m = (await builder.build({ color: 0x808080 })) as unknown as {
      emissive: { getHex(): number }; flatShading: boolean; wireframe: boolean;
    };
    expect(m.emissive.getHex()).toBe(0x000000); // THREE default = black (no emission)
    expect(m.flatShading).toBe(false);
    expect(m.wireframe).toBe(false);
  });

  it("maps side 'back' to THREE.BackSide", async () => {
    const THREE = await import('three');
    const builder = await pbr();
    const m = (await builder.build({ side: 'back' })) as unknown as { side: number };
    expect(m.side).toBe(THREE.BackSide);
  });
});
