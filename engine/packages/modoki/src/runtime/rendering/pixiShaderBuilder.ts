/** pixiShaderBuilder — build a PixiJS `Shader` for the Canvas2D layer from a
 *  `space:'2d'` `.shader.json` manifest + its sibling `<name>.wgsl` / `<name>.glsl`
 *  fragment bodies. The 2D twin of {@link buildFileShaderMaterial} (the 3D/TSL path)
 *  and a generalization of {@link makeMtsdfPixiShader} (the fixed MTSDF text shader).
 *
 *  Authoring convention (differs from the 3D `shader:'file'` path — see
 *  ShaderManifest.space): the `.wgsl` / `.glsl` body is a fragment MAIN snippet that
 *  writes `outColor` (a PREMULTIPLIED vec4; the base high-shader multiplies it by
 *  `vColor`, the mesh tint/alpha). Available in the body:
 *    - `vUV`                       — sprite UV (from Pixi's textureBit)
 *    - `uTexture` / `uSampler`     — the sprite's own texture + sampler
 *    - the shader's params, as a uniform block:
 *        WGSL → `matUniforms.<param>`   GLSL → `<param>` (loose)
 *  A dissolve body, for example:
 *    WGSL: `let b = textureSample(uTexture, uSampler, vUV);
 *           let n = fract(sin(dot(vUV, vec2<f32>(12.9,78.2)))*43758.5);
 *           if (n < matUniforms.uThreshold) { discard; } outColor = b;`
 *
 *  AUTHORING FOOTGUN: do NOT write `@group(N)` or `@binding(N)` inside a WGSL body
 *  COMMENT. Pixi's `extractStructAndGroups` scans the assembled fragment source with a
 *  regex that only skips a binding when the char immediately before `@` is `/` — so
 *  `//@group` is skipped but `// @group(3) … ;` (a space after `//`) is parsed as a real
 *  binding and throws (`Cannot read properties of null`), silently failing the whole
 *  material. Keep decorator-shaped tokens out of comment prose.
 *
 *  How this reuses Pixi's pipeline: we compose Pixi's own high-shader bits
 *  (`localUniformBit` transform, `textureBit` sampler, `roundPixelsBit`) + ONE
 *  generated custom bit that declares the uniform block and splices the authored
 *  body — so we own only the fragment maths, exactly like mtsdfPixiShader. The
 *  program is compiled ONCE per asset; each entity mints its own `Shader` (its own
 *  UniformGroup) via {@link makePixiShaderInstance} so `MaterialInstance` can drive
 *  that entity's uniforms independently (Phase 3).
 *
 *  Scope: uniform params (float/bool/color/vecN), the sprite's own texture (`uTexture`),
 *  AND extra `texture` params (additional samplers). A `texture` param `uFoo` binds the
 *  image its manifest `default` GUID resolves to as an extra sampler; the body samples it
 *  as `textureSample(uFoo, uFooSmp, vUV)` (WGSL — the sampler is `<key>Smp`) or
 *  `texture(uFoo, vUV)` (GLSL). `vUV` is the sprite's texture-space UV (0..1 for a whole
 *  sprite), so an extra texture is sampled in the sprite's UV frame. Extra textures are
 *  bound WHOLE-image (no atlas sub-rect) and are resolved/refcounted by the renderer
 *  (Scene2D), which passes them to {@link makePixiShaderInstance}. Per-entity texture
 *  overrides are not yet supported (a texture param's value is the manifest default —
 *  `MaterialInstance` drives only scalar uniforms). */

import {
  Shader, UniformGroup, Matrix, Texture,
  compileHighShaderGlProgram, compileHighShaderGpuProgram,
  localUniformBit, localUniformBitGl,
  textureBit, textureBitGl,
  roundPixelsBit, roundPixelsBitGl,
  // Program types are structural; import lazily via the compile fns' return type.
} from 'pixi.js';
import { assetUrl } from '../loaders/assetUrl';
import { ASSET_FETCH_INIT } from '../loaders/assetFetch';
import { resolvePixiBackend } from './canvas2DPool';
import {
  coerceParamValue, fetchShaderManifest, mergeParamDefaults, shaderSpace,
  type ShaderParam, type ShaderParamType, type ShaderManifest, type ShaderParamSchema,
} from '../loaders/shaderSchema';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The uniform-bearing (non-texture) param types, in the order the WGSL struct and
 *  the UniformGroup are both generated. `texture` params are excluded (v1 scope). */
const UNIFORM_PARAM_TYPES: ReadonlySet<ShaderParamType> = new Set<ShaderParamType>([
  'float', 'bool', 'color', 'vec2', 'vec3', 'vec4',
]);

/** Uniform names PixiJS's own composed high-shader bits already declare in the flat
 *  GLSL namespace (localUniformBit → uColor/uTransformMatrix/uRound; global →
 *  uResolution; textureBit → uTexture/uSampler/uTextureMatrix/uTextureId). A 2D
 *  material param keyed with one of these compiles fine on WGSL (namespaced under
 *  `matUniforms`) but REDECLARES the built-in on the WebGL fallback and fails to
 *  compile — so we reject them at build + validation time. */
const RESERVED_UNIFORM_NAMES: ReadonlySet<string> = new Set([
  'uColor', 'uTransformMatrix', 'uRound', 'uResolution',
  'uTexture', 'uSampler', 'uTextureMatrix', 'uTextureId',
]);

/** WGSL type token for a uniform param (bool is represented as f32 — WGSL uniform
 *  blocks can't hold bool; author with `matUniforms.uFlag > 0.5`). */
function wgslType(t: ShaderParamType): string {
  switch (t) {
    case 'float': case 'bool': return 'f32';
    case 'color': case 'vec3': return 'vec3<f32>';
    case 'vec2': return 'vec2<f32>';
    case 'vec4': return 'vec4<f32>';
    default: return 'f32';
  }
}
/** GLSL type token (the loose-uniform declaration). */
function glslType(t: ShaderParamType): string {
  switch (t) {
    case 'float': case 'bool': return 'float';
    case 'color': case 'vec3': return 'vec3';
    case 'vec2': return 'vec2';
    case 'vec4': return 'vec4';
    default: return 'float';
  }
}

/** Pack a coerced param value into the `{ value, type }` shape a Pixi UniformGroup
 *  wants. `type` matches {@link wgslType} so the std140 buffer layout lines up with
 *  the generated WGSL struct. */
export function uniformSpecFor(param: ShaderParam, value: unknown): { value: number | Float32Array; type: string } {
  const v = coerceParamValue(param, value);
  switch (param.type) {
    case 'float': return { value: v as number, type: 'f32' };
    case 'bool': return { value: (v as boolean) ? 1 : 0, type: 'f32' };
    case 'color': {
      const hex = (v as number) >>> 0;
      return { value: new Float32Array([((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]), type: 'vec3<f32>' };
    }
    case 'vec2': return { value: new Float32Array(v as number[]), type: 'vec2<f32>' };
    case 'vec3': return { value: new Float32Array(v as number[]), type: 'vec3<f32>' };
    case 'vec4': return { value: new Float32Array(v as number[]), type: 'vec4<f32>' };
    default: return { value: 0, type: 'f32' };
  }
}

/** The uniform (non-texture) params of a schema, in a stable order. `texture` params
 *  are handled separately (bound as extra samplers — see {@link textureParams}). */
function uniformParams(schema: ShaderParamSchema): [string, ShaderParam][] {
  const out: [string, ShaderParam][] = [];
  for (const [key, param] of Object.entries(schema)) {
    if (UNIFORM_PARAM_TYPES.has(param.type)) out.push([key, param]);
  }
  return out;
}

/** The `texture` params of a schema, in a stable order — each becomes an extra sampler
 *  (`<key>` texture + `<key>Smp` sampler on WGSL; `sampler2D <key>` on GLSL). */
function textureParams(schema: ShaderParamSchema): [string, ShaderParam][] {
  return Object.entries(schema).filter(([, p]) => p.type === 'texture');
}

/** Pure well-formedness check for a 2D shader manifest — surfaces authoring issues
 *  without touching the network (used by tests and, later, scene/asset validation).
 *  Returns a list of human-readable problems (empty = clean). `space` mismatch and
 *  unknown/`texture` param types are reported; they do not by themselves make the
 *  shader unbuildable (texture params are skipped, unknown types zero-fill). */
export function validatePixiShaderManifest(manifest: ShaderManifest): string[] {
  const issues: string[] = [];
  if (shaderSpace(manifest) !== '2d') issues.push(`space is '${manifest.space ?? '3d'}', expected '2d'`);
  for (const [key, param] of Object.entries(manifest.params ?? {})) {
    const t = param?.type;
    if (RESERVED_UNIFORM_NAMES.has(key)) issues.push(`param '${key}': name collides with a PixiJS built-in uniform — rename it`);
    else if (t !== 'texture' && (!t || !(UNIFORM_PARAM_TYPES.has(t)))) issues.push(`param '${key}': unknown/missing type '${t}'`);
  }
  return issues;
}

/** Generate the fragment-header uniform-block declaration for one backend from the
 *  params (empty string when there are none — WGSL forbids an empty uniform struct,
 *  and a shader that only samples `uTexture` needs no block). WGSL wraps the params
 *  in a `struct MatUniforms { … }` at `@group(3) @binding(0)`; GLSL emits loose
 *  uniforms (unique names — reserved collisions are rejected upstream). Exported for
 *  unit tests (the WebGL program can't be compiled headlessly, so we assert on this
 *  generated text directly). */
export function generateUniformBlock(lang: 'wgsl' | 'glsl', params: [string, ShaderParam][]): string {
  if (params.length === 0) return '';
  if (lang === 'wgsl') {
    const fields = params.map(([k, p]) => `        ${k}: ${wgslType(p.type)},`).join('\n');
    return `
      struct MatUniforms {
${fields}
      };
      @group(3) @binding(0) var<uniform> matUniforms: MatUniforms;`;
  }
  return params.map(([k, p]) => `      uniform ${glslType(p.type)} ${k};`).join('\n');
}

/** Generate the extra-sampler declarations for the `texture` params (empty when none).
 *  On WGSL each texture takes a texture+sampler binding pair in `@group(3)` — binding 0
 *  is RESERVED for `matUniforms` (declared or not), so the i-th texture is at binding
 *  `1+2i` and its sampler `<key>Smp` at `2+2i` (non-contiguous bindings when there are no
 *  uniform params are valid WebGPU). On GLSL they're loose `sampler2D` uniforms (reserved
 *  collisions are rejected upstream). Exported for unit tests. */
export function generateSamplerBlock(lang: 'wgsl' | 'glsl', textures: [string, ShaderParam][]): string {
  if (textures.length === 0) return '';
  if (lang === 'wgsl') {
    return textures.map(([k], i) =>
      `      @group(3) @binding(${1 + 2 * i}) var ${k}: texture_2d<f32>;\n` +
      `      @group(3) @binding(${2 + 2 * i}) var ${k}Smp: sampler;`).join('\n');
  }
  return textures.map(([k]) => `      uniform sampler2D ${k};`).join('\n');
}

/** Build the custom high-shader bit for one backend: declares the uniform block + the
 *  extra-sampler declarations from the params and splices the authored body. */
function customBit(lang: 'wgsl' | 'glsl', body: string, params: [string, ShaderParam][], textures: [string, ShaderParam][]) {
  const header = `${generateUniformBlock(lang, params)}\n${generateSamplerBlock(lang, textures)}`;
  return { name: 'pixi-material-bit', fragment: { header, main: body } };
}

/** A compiled 2D shader program + the schema it was built from. Only the ACTIVE
 *  backend's program is compiled (a session is single-backend; compiling the other
 *  wastes work and — for WebGL — needs a live GL context). Shareable across entities;
 *  each entity mints its own Shader via {@link makePixiShaderInstance}. */
export interface PixiShaderProgram {
  manifest: ShaderManifest;
  /** Exactly one of these is set, matching the active renderer backend. */
  glProgram?: ReturnType<typeof compileHighShaderGlProgram>;
  gpuProgram?: ReturnType<typeof compileHighShaderGpuProgram>;
  /** Uniform (non-texture) params in struct order. */
  params: [string, ShaderParam][];
  /** `texture` params (extra samplers) in binding order — each needs a bound Texture
   *  in {@link makePixiShaderInstance}. */
  textureParams: [string, ShaderParam][];
}

/** Derive the sibling body path from a `.shader.json` manifest path. */
function variantPath(manifestPath: string, ext: 'wgsl' | 'glsl'): string {
  return manifestPath.replace(/\.shader\.json$/i, `.${ext}`);
}

/** Fetch + compile a `space:'2d'` shader program from its manifest path. Returns null
 *  (caller falls back to the default texture shader) when the manifest is missing, is
 *  not a 2D shader, or the backend-matched body is absent. Compiles ONE gl + one gpu
 *  program; call once per asset and reuse across entities. */
export async function buildPixiShaderProgram(manifestPath: string): Promise<PixiShaderProgram | null> {
  const manifest = await fetchShaderManifest(manifestPath);
  if (!manifest) return null;
  if (shaderSpace(manifest) !== '2d') {
    console.warn(`[pixiShader] ${manifestPath}: not a 2D shader (space='${manifest.space ?? '3d'}') — skipped.`);
    return null;
  }

  // Reserved-name guard: reject params whose key collides with a uniform Pixi's
  // own composed bits already declare (see RESERVED_UNIFORM_NAMES). On WGSL the
  // params are namespaced inside `matUniforms`, so a collision is harmless there —
  // but on the WebGL fallback they're LOOSE globals in the same namespace as Pixi's
  // built-ins, so `uColor`/`uTexture` would redeclare a built-in and fail to compile.
  // Fail LOUDLY + consistently on both backends rather than WebGPU-works/WebGL-breaks.
  const reserved = Object.keys(manifest.params).filter((k) => RESERVED_UNIFORM_NAMES.has(k));
  if (reserved.length > 0) {
    console.error(`[pixiShader] ${manifestPath}: param name(s) ${reserved.join(', ')} collide with PixiJS built-in uniforms (${[...RESERVED_UNIFORM_NAMES].join(', ')}) — rename them; skipped.`);
    return null;
  }

  // Compile ONLY the active backend's program. Fetch just that backend's body; a
  // missing variant → fall back to the default sprite shader. Backend is resolved
  // the SAME way the Canvas2D pool picks its renderer (honors the pixi.backend
  // override), so the compiled program always matches the live renderer.
  const ext: 'wgsl' | 'glsl' = (await resolvePixiBackend()) === 'webgpu' ? 'wgsl' : 'glsl';
  const webgpu = ext === 'wgsl';
  const bodyRes = await fetch(assetUrl(variantPath(manifestPath, ext)), ASSET_FETCH_INIT).catch(() => null);
  const body = bodyRes?.ok ? (await bodyRes.text()).trim() : '';
  if (!body) {
    console.warn(`[pixiShader] ${manifestPath}: missing ${ext.toUpperCase()} body for the active backend — falling back to the default sprite shader.`);
    return null;
  }

  const params = uniformParams(manifest.params);
  const texParams = textureParams(manifest.params);
  const name = manifest.name || 'pixi-material';
  if (webgpu) {
    const gpuProgram = compileHighShaderGpuProgram({ name, bits: [localUniformBit, textureBit, roundPixelsBit, customBit('wgsl', body, params, texParams)] });
    return { manifest, gpuProgram, params, textureParams: texParams };
  }
  const glProgram = compileHighShaderGlProgram({ name, bits: [localUniformBitGl, textureBitGl, roundPixelsBitGl, customBit('glsl', body, params, texParams)] });
  return { manifest, glProgram, params, textureParams: texParams };
}

/** Build the per-entity UniformGroup values from a program's params + a material's
 *  stored param values (missing keys fall back to schema defaults). Insertion order
 *  matches the WGSL struct field order. */
export function buildUniformValues(program: PixiShaderProgram, values: Record<string, unknown> | undefined): Record<string, { value: number | Float32Array; type: string }> {
  const merged = mergeParamDefaults(Object.fromEntries(program.params), values);
  const out: Record<string, { value: number | Float32Array; type: string }> = {};
  for (const [key, param] of program.params) out[key] = uniformSpecFor(param, merged[key]);
  return out;
}

/** Mint a per-entity PixiJS `Shader` from a compiled program, a texture (the sprite's
 *  own texture), and this entity's param values. Each call yields an independent
 *  UniformGroup so `MaterialInstance` can drive uniforms per entity. The texture is
 *  bound BOTH ways (WebGL reads `resources.uTexture`; WebGPU rebinds group 2 from
 *  `mesh.texture`) — callers must ALSO set `mesh.texture = <same texture>`.
 *
 *  `uTextureMatrix` is the texture's own uv matrix — IDENTITY for a whole image, the frame
 *  transform for an atlas slice — so the shader samples the correct sub-rect (the Texture
 *  getter constructs + updates its TextureMatrix, so `mapCoord` is current). `vUV` in the
 *  body is therefore the TEXTURE-space UV (0..1 for a whole sprite; the sub-rect for a slice).
 *
 *  `extraTextures` binds the shader's `texture` params (extra samplers) by param name — each
 *  declared texture param MUST be bound (WebGPU bind group group(3) must be complete), so a
 *  param the caller hasn't resolved yet falls back to `Texture.WHITE` (a live source) and the
 *  caller rebuilds when it lands. The sampler resource is keyed `<param>Smp` to match the
 *  generated WGSL; on GLSL that extra key is an unknown uniform and is simply ignored. */
export function makePixiShaderInstance(program: PixiShaderProgram, texture: Texture, values: Record<string, unknown> | undefined, extraTextures?: Record<string, Texture>): Shader {
  const resources: Record<string, unknown> = {
    uTexture: texture.source,
    uSampler: texture.source.style,
    textureUniforms: { uTextureMatrix: { type: 'mat3x3<f32>', value: texture.textureMatrix?.mapCoord ?? new Matrix() } },
  };
  if (program.params.length > 0) {
    resources.matUniforms = new UniformGroup(buildUniformValues(program, values) as any);
  }
  for (const [key] of program.textureParams) {
    const t = extraTextures?.[key] ?? Texture.WHITE;
    resources[key] = t.source;
    resources[`${key}Smp`] = t.source.style;
  }
  return new Shader({ glProgram: program.glProgram, gpuProgram: program.gpuProgram, resources: resources as any } as any);
}
