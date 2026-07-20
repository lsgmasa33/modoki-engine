/** pixiShaderBuilder unit + integration tests (2D materials, Phase 1).
 *
 *  Covers: the pure uniform packing/validation (`uniformSpecFor`, `buildUniformValues`,
 *  `validatePixiShaderManifest`) and the async program builder (`buildPixiShaderProgram`)
 *  over a mocked fetch + WebGPU-active backend. The WebGL body/program is intentionally
 *  NOT exercised — `compileHighShaderGlProgram` needs a live GL context (getTestContext),
 *  which jsdom/node lack; the runtime is single-backend and the WGSL path proves the
 *  generation/compilation contract.
 */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  uniformSpecFor, buildUniformValues, validatePixiShaderManifest, generateUniformBlock, generateSamplerBlock,
  type PixiShaderProgram,
} from '../../src/runtime/rendering/pixiShaderBuilder';
import type { ShaderParam, ShaderManifest } from '../../src/runtime/loaders/shaderSchema';

const P = (type: ShaderParam['type'], def: unknown): ShaderParam => ({ type, default: def });

describe('uniformSpecFor', () => {
  it('packs a float and coerces a bool to 0/1 f32', () => {
    expect(uniformSpecFor(P('float', 0.5), 2)).toEqual({ value: 2, type: 'f32' });
    expect(uniformSpecFor(P('float', 0.5), undefined)).toEqual({ value: 0.5, type: 'f32' }); // default
    expect(uniformSpecFor(P('bool', false), true)).toEqual({ value: 1, type: 'f32' });
    expect(uniformSpecFor(P('bool', true), false)).toEqual({ value: 0, type: 'f32' });
  });

  it('unpacks a color hex into a normalized vec3', () => {
    const spec = uniformSpecFor(P('color', 0xffffff), 0xff8000);
    expect(spec.type).toBe('vec3<f32>');
    expect(Array.from(spec.value as Float32Array).map((n) => +n.toFixed(3))).toEqual([1, 0.502, 0]);
  });

  it('packs vecN as a Float32Array of the right length', () => {
    expect(uniformSpecFor(P('vec2', [0, 0]), [1, 2]).type).toBe('vec2<f32>');
    expect(Array.from(uniformSpecFor(P('vec4', [0, 0, 0, 0]), [1, 2, 3, 4]).value as Float32Array)).toEqual([1, 2, 3, 4]);
  });
});

describe('buildUniformValues', () => {
  it('fills declared params from values then schema defaults, in struct order', () => {
    const program = {
      params: [
        ['uSpeed', P('float', 1)],
        ['uTint', P('color', 0x000000)],
      ],
    } as unknown as PixiShaderProgram;
    const out = buildUniformValues(program, { uSpeed: 3 }); // uTint omitted → default
    expect(Object.keys(out)).toEqual(['uSpeed', 'uTint']); // struct order preserved
    expect(out.uSpeed).toEqual({ value: 3, type: 'f32' });
    expect(Array.from(out.uTint.value as Float32Array)).toEqual([0, 0, 0]); // default 0x000000
  });
});

describe('validatePixiShaderManifest', () => {
  const base = (over: Partial<ShaderManifest>): ShaderManifest => ({ params: {}, space: '2d', ...over });

  it('accepts a clean 2D manifest with uniform params', () => {
    expect(validatePixiShaderManifest(base({ params: { uSpeed: P('float', 1), uTint: P('color', 0xffffff) } }))).toEqual([]);
  });

  it('flags a non-2D space', () => {
    expect(validatePixiShaderManifest(base({ space: '3d' }))[0]).toMatch(/space is '3d'/);
  });

  it('accepts a texture param (bound as an extra sampler) but flags an unknown type', () => {
    const issues = validatePixiShaderManifest(base({ params: { uMap: P('texture', ''), uBad: { type: 'flot' as any, default: 0 } } }));
    expect(issues.some((i) => /uMap/.test(i))).toBe(false);      // texture is valid now
    expect(issues.some((i) => /uBad.*unknown/.test(i))).toBe(true);
  });

  it('flags a param name that collides with a PixiJS built-in uniform (WebGL footgun)', () => {
    const issues = validatePixiShaderManifest(base({ params: { uColor: P('color', 0xffffff), uTexture: P('float', 0) } }));
    expect(issues.some((i) => /uColor.*collides/.test(i))).toBe(true);
    expect(issues.some((i) => /uTexture.*collides/.test(i))).toBe(true);
  });
});

describe('generateUniformBlock', () => {
  const params: [string, ShaderParam][] = [['uThreshold', P('float', 0.5)], ['uTint', P('color', 0xffffff)], ['uDir', P('vec2', [0, 0])]];

  it('emits a WGSL struct + @group(3) block with mapped types (color→vec3, bool→f32)', () => {
    const wgsl = generateUniformBlock('wgsl', [...params, ['uOn', P('bool', false)]]);
    expect(wgsl).toContain('struct MatUniforms {');
    expect(wgsl).toContain('uThreshold: f32,');
    expect(wgsl).toContain('uTint: vec3<f32>,');
    expect(wgsl).toContain('uDir: vec2<f32>,');
    expect(wgsl).toContain('uOn: f32,');           // bool → f32 in a uniform block
    expect(wgsl).toContain('@group(3) @binding(0) var<uniform> matUniforms: MatUniforms;');
  });

  it('emits loose GLSL uniforms with mapped types', () => {
    const glsl = generateUniformBlock('glsl', [...params, ['uOn', P('bool', false)]]);
    expect(glsl).toContain('uniform float uThreshold;');
    expect(glsl).toContain('uniform vec3 uTint;');
    expect(glsl).toContain('uniform vec2 uDir;');
    expect(glsl).toContain('uniform float uOn;');  // bool → float
    expect(glsl).not.toContain('struct');          // GLSL path is loose, not a block
  });

  it('emits an empty header when there are no uniform params (WGSL forbids an empty struct)', () => {
    expect(generateUniformBlock('wgsl', [])).toBe('');
    expect(generateUniformBlock('glsl', [])).toBe('');
  });
});

describe('generateSamplerBlock', () => {
  const tex: [string, ShaderParam][] = [['uNoise', P('texture', '')], ['uMask', P('texture', '')]];

  it('emits WGSL texture+sampler pairs in @group(3), binding 0 reserved for matUniforms', () => {
    const wgsl = generateSamplerBlock('wgsl', tex);
    // First texture at binding 1/2, second at 3/4 (binding 0 is the uniform struct's).
    expect(wgsl).toContain('@group(3) @binding(1) var uNoise: texture_2d<f32>;');
    expect(wgsl).toContain('@group(3) @binding(2) var uNoiseSmp: sampler;');
    expect(wgsl).toContain('@group(3) @binding(3) var uMask: texture_2d<f32>;');
    expect(wgsl).toContain('@group(3) @binding(4) var uMaskSmp: sampler;');
    expect(wgsl).not.toContain('@binding(0)'); // binding 0 belongs to matUniforms, not a sampler
  });

  it('emits loose GLSL sampler2D uniforms (no separate sampler object)', () => {
    const glsl = generateSamplerBlock('glsl', tex);
    expect(glsl).toContain('uniform sampler2D uNoise;');
    expect(glsl).toContain('uniform sampler2D uMask;');
    expect(glsl).not.toContain('Smp'); // GLSL has no standalone sampler binding
  });

  it('emits an empty block when there are no texture params', () => {
    expect(generateSamplerBlock('wgsl', [])).toBe('');
    expect(generateSamplerBlock('glsl', [])).toBe('');
  });
});

describe('buildPixiShaderProgram (WebGPU backend, mocked fetch)', () => {
  let buildPixiShaderProgram: typeof import('../../src/runtime/rendering/pixiShaderBuilder').buildPixiShaderProgram;
  const files = new Map<string, string>();

  beforeEach(async () => {
    vi.resetModules();
    files.clear();
    // WebGPU active → only the .wgsl body is fetched + only the gpu program compiles.
    // The builder resolves the backend via canvas2DPool.resolvePixiBackend (mocked
    // here to avoid pulling Pixi's pool init); mock just that export.
    vi.doMock('../../src/runtime/rendering/canvas2DPool', () => ({ resolvePixiBackend: () => Promise.resolve('webgpu') }));
    // assetUrl passthrough + a fetch that serves the in-memory file map.
    vi.doMock('../../src/runtime/loaders/assetUrl', () => ({ assetUrl: (p: string) => p }));
    vi.doMock('../../src/runtime/loaders/assetFetch', () => ({ ASSET_FETCH_INIT: {} }));
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const body = files.get(String(url));
      return Promise.resolve(body != null
        ? { ok: true, json: () => Promise.resolve(JSON.parse(body)), text: () => Promise.resolve(body) }
        : { ok: false, json: () => Promise.reject(new Error('404')), text: () => Promise.resolve('') });
    }) as any);
    ({ buildPixiShaderProgram } = await import('../../src/runtime/rendering/pixiShaderBuilder'));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const manifest = (params: Record<string, ShaderParam>, extra: Partial<ShaderManifest> = {}) =>
    JSON.stringify({ space: '2d', name: 'dissolve', params, ...extra });

  it('compiles a gpu program and carries the declared uniform params in order', async () => {
    files.set('x.shader.json', manifest({ uThreshold: P('float', 0.5), uTint: P('color', 0xffffff) }));
    files.set('x.wgsl', 'let b = textureSample(uTexture, uSampler, vUV); if (b.a < matUniforms.uThreshold) { discard; } outColor = b;');

    const program = await buildPixiShaderProgram('x.shader.json');
    expect(program).not.toBeNull();
    expect(program!.gpuProgram).toBeTruthy();
    expect(program!.glProgram).toBeUndefined();               // only the active backend compiled
    expect(program!.params.map(([k]) => k)).toEqual(['uThreshold', 'uTint']);
  });

  it('assembles the real dissolve.wgsl body (samples uTexture + two float uniforms)', async () => {
    // Locks the shipped 3d-test dissolve material's bit composition (the follow-up #1 demo).
    files.set('d.shader.json', manifest({ uThreshold: P('float', 0), uEdge: P('float', 1.5) }));
    files.set('d.wgsl', [
      'let base = textureSample(uTexture, uSampler, vUV);',
      'let n = fract(sin(dot(vUV, vec2<f32>(12.9898, 78.233))) * 43758.5453);',
      'let keep = step(matUniforms.uThreshold, n);',
      'let edge = (1.0 - smoothstep(matUniforms.uThreshold, matUniforms.uThreshold + 0.07, n)) * keep;',
      'let glow = vec3<f32>(1.0, 0.55, 0.15) * edge * matUniforms.uEdge;',
      'outColor = vec4<f32>(base.rgb * keep + glow, base.a * keep);',
    ].join('\n'));

    const program = await buildPixiShaderProgram('d.shader.json');
    expect(program).not.toBeNull();
    expect(program!.gpuProgram).toBeTruthy();
    expect(program!.params.map(([k]) => k)).toEqual(['uThreshold', 'uEdge']);
  });

  it('builds with zero uniform params (samples uTexture only)', async () => {
    files.set('y.shader.json', manifest({}));
    files.set('y.wgsl', 'outColor = textureSample(uTexture, uSampler, vUV);');
    const program = await buildPixiShaderProgram('y.shader.json');
    expect(program!.gpuProgram).toBeTruthy();
    expect(program!.params).toEqual([]);
  });

  it('splits uniform params from texture params (extra samplers) and builds both', async () => {
    files.set('z.shader.json', manifest({ uMap: P('texture', 'guid-noise'), uSpeed: P('float', 1) }));
    files.set('z.wgsl', 'outColor = textureSample(uMap, uMapSmp, vUV) * matUniforms.uSpeed;');
    const program = await buildPixiShaderProgram('z.shader.json');
    expect(program!.params.map(([k]) => k)).toEqual(['uSpeed']);              // non-texture uniforms
    expect(program!.textureParams.map(([k]) => k)).toEqual(['uMap']);         // extra sampler bound
    expect(program!.gpuProgram).toBeTruthy();
  });

  it('builds a texture-only shader (no uniform struct, just the extra sampler)', async () => {
    files.set('to.shader.json', manifest({ uMask: P('texture', 'guid-mask') }));
    files.set('to.wgsl', 'outColor = textureSample(uTexture, uSampler, vUV) * textureSample(uMask, uMaskSmp, vUV).a;');
    const program = await buildPixiShaderProgram('to.shader.json');
    expect(program!.params).toEqual([]);
    expect(program!.textureParams.map(([k]) => k)).toEqual(['uMask']);
    expect(program!.gpuProgram).toBeTruthy();
  });

  it('rejects (null) a param name colliding with a Pixi built-in uniform', async () => {
    files.set('c.shader.json', manifest({ uColor: P('color', 0xffffff) }));
    files.set('c.wgsl', 'outColor = vec4<f32>(matUniforms.uColor, 1.0);');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await buildPixiShaderProgram('c.shader.json')).toBeNull();
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/collide with PixiJS built-in/));
  });

  it('falls back (null) when the manifest is missing', async () => {
    expect(await buildPixiShaderProgram('nope.shader.json')).toBeNull();
  });

  it('falls back (null) when the active-backend body is missing', async () => {
    files.set('nb.shader.json', manifest({ uSpeed: P('float', 1) }));
    // no .wgsl body seeded
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await buildPixiShaderProgram('nb.shader.json')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/missing WGSL body/));
  });

  it('falls back (null) for a non-2D shader', async () => {
    files.set('td.shader.json', JSON.stringify({ space: '3d', params: {} }));
    files.set('td.wgsl', 'outColor = vec4<f32>(1.0);');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await buildPixiShaderProgram('td.shader.json')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not a 2D shader/));
  });
});

describe('makePixiShaderInstance (mocked pixi.js)', () => {
  // pixi's real Shader/UniformGroup constructors need a live renderer/context, so we mock
  // 'pixi.js' for THIS block only: fake Shader stores the resources config, fake UniformGroup
  // is an identifiable class, fake Matrix stands in for the identity fallback. resetModules +
  // doMock keeps the mock scoped to this block (the buildPixiShaderProgram block above manages
  // its own module graph). shaderSchema (buildUniformValues' deps) stays real.
  let makePixiShaderInstance: typeof import('../../src/runtime/rendering/pixiShaderBuilder').makePixiShaderInstance;
  let FakeMatrix: any;
  let FakeUniformGroup: any;

  beforeEach(async () => {
    vi.resetModules();
    class Matrix { readonly isIdentityFallback = true; }
    class UniformGroup { uniforms: unknown; constructor(u: unknown) { this.uniforms = u; } }
    class Shader { resources: any; glProgram: any; gpuProgram: any; constructor(cfg: any) { this.resources = cfg.resources; this.glProgram = cfg.glProgram; this.gpuProgram = cfg.gpuProgram; } }
    FakeMatrix = Matrix;
    FakeUniformGroup = UniformGroup;
    vi.doMock('pixi.js', () => ({
      Shader, UniformGroup, Matrix,
      // Fallback source for an unbound texture param (extra sampler) — a live WHITE source.
      Texture: { WHITE: { source: { style: { magFilter: 'white' } } } },
      // Named exports pixiShaderBuilder imports at load time — unused by makePixiShaderInstance,
      // provided so the import resolves.
      compileHighShaderGlProgram: () => ({}), compileHighShaderGpuProgram: () => ({}),
      localUniformBit: {}, localUniformBitGl: {}, textureBit: {}, textureBitGl: {},
      roundPixelsBit: {}, roundPixelsBitGl: {},
    }));
    ({ makePixiShaderInstance } = await import('../../src/runtime/rendering/pixiShaderBuilder'));
  });
  afterEach(() => { vi.doUnmock('pixi.js'); vi.resetModules(); });

  const texture = (textureMatrix?: unknown) => ({ source: { style: { magFilter: 'nearest' } }, textureMatrix } as any);
  const program = (params: [string, ShaderParam][], textureParams: [string, ShaderParam][] = []) =>
    ({ params, textureParams, manifest: {}, glProgram: undefined, gpuProgram: {} } as unknown as PixiShaderProgram);

  it('binds uTextureMatrix from the texture atlas sub-rect (mapCoord)', () => {
    const mapCoord = { subRect: true }; // a distinct object standing in for the atlas frame transform
    const tex = texture({ mapCoord });
    const shader = makePixiShaderInstance(program([]), tex, {}) as any;
    expect(shader.resources.textureUniforms.uTextureMatrix.type).toBe('mat3x3<f32>');
    expect(shader.resources.textureUniforms.uTextureMatrix.value).toBe(mapCoord); // exact atlas matrix
    // the sprite's own texture source + sampler are bound too.
    expect(shader.resources.uTexture).toBe(tex.source);
    expect(shader.resources.uSampler).toBe(tex.source.style);
  });

  it('falls back to a fresh identity Matrix when the texture has no textureMatrix', () => {
    const shader = makePixiShaderInstance(program([]), texture(undefined), {}) as any;
    expect(shader.resources.textureUniforms.uTextureMatrix.value).toBeInstanceOf(FakeMatrix);
  });

  it('omits the matUniforms group for a zero-param program', () => {
    const shader = makePixiShaderInstance(program([]), texture({ mapCoord: {} }), {}) as any;
    expect(shader.resources.matUniforms).toBeUndefined();
  });

  it('includes a matUniforms UniformGroup when the program has params', () => {
    const shader = makePixiShaderInstance(
      program([['uSpeed', P('float', 1)]]),
      texture({ mapCoord: {} }),
      { uSpeed: 3 },
    ) as any;
    expect(shader.resources.matUniforms).toBeInstanceOf(FakeUniformGroup);
    expect((shader.resources.matUniforms.uniforms as any).uSpeed).toEqual({ value: 3, type: 'f32' });
  });

  it('binds each texture param (extra sampler) as <key> + <key>Smp, falling back to WHITE when unresolved', () => {
    const bound = { source: { style: { magFilter: 'linear' } } } as any;
    const shader = makePixiShaderInstance(
      program([], [['uReveal', P('texture', 0)], ['uMask', P('texture', 0)]]),
      texture({ mapCoord: {} }),
      {},
      { uReveal: bound }, // uMask left unresolved → WHITE fallback
    ) as any;
    // Bound param → its own source + sampler style.
    expect(shader.resources.uReveal).toBe(bound.source);
    expect(shader.resources.uRevealSmp).toBe(bound.source.style);
    // Unresolved param → the live WHITE source (a complete bind group), never undefined.
    expect(shader.resources.uMask).toEqual({ style: { magFilter: 'white' } });
    expect(shader.resources.uMaskSmp).toEqual({ magFilter: 'white' });
  });
});
