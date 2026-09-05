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
import { resolvePixiBackend } from './canvas2DPool';
import {
  coerceParamValue, mergeParamDefaults, shaderSpace,
  type ShaderParam, type ShaderParamType, type ShaderManifest, type ShaderParamSchema,
} from '../core/shaderSchema';
import { assetPlumbing } from '../core/assetPlumbing';

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

// Program cache (fixes #716; re-keyed on CONTENT in the #716 close-out review) — mirrors
// `mtsdfPixiShader.ts`'s `getMtsdfPrograms` (see its "Program cache (fixes #590)" comment block
// for the full mechanism writeup). The uncached-compile problem this fixes is GL-only:
// `compileHighShaderGlProgram(...)` ends in `new GlProgram(...)` directly — NOT
// `GlProgram.from()`, which is the only constructor PixiJS content-caches — so without this cache
// every call mints a fresh `GlProgram`. Our generated GLSL declares no `#define SHADER_NAME`, so
// Pixi's own `setProgramName` stamps an incrementing one into the source, the program's `_key` is
// computed from that mutated source, `GlShaderSystem`'s internal cache misses every time, and a
// brand-new `WebGLProgram` is compiled and linked — PixiJS has no `gl.deleteProgram` call site
// anywhere, so every one of those is stranded on the GPU permanently. `clearSpriteMaterialCache()`
// (called on every world swap, `Scene2D.stop()`, AND every `.shader.json` inspector edit/undo/
// redo) used to force exactly this: a fresh GL compile on every one of those.
// `compileHighShaderGpuProgram(...)`, by contrast, already returns `GpuProgram.from({...})` —
// Pixi's own content cache — so the GPU path was never at risk of the stranded-program leak (see
// `docs/plans/ios-rendering-update-wedge.md`'s "#716 ... GL-only" note, added in this same body of
// work). This module cache still earns its place on the GPU path too, though: it skips the
// manifest+body FETCH and the string assembly (`customBit`, uniform/sampler block generation) on
// every call, not just the program compile — that work is backend-agnostic and worth memoizing
// either way.
//
// ⚠️ THE TRAP: the fix here must be THIS memo, never "just add a stable `#define SHADER_NAME`"
// like `mtsdfBitGl` does. With a stable key, a SECOND `GlProgram` constructed over identical
// source would hit `GlShaderSystem`'s cache, `generateProgram` would never run for it, and
// `GlGeometrySystem.initGeometryVao` would then throw on `aPosition` (see the mtsdf file's own
// comment above `mtsdfBitGl`). Memoising means a second `GlProgram`/`GpuProgram` is never
// constructed for the same source, which is what makes this safe — a future reader must not
// "simplify" this into a define.
//
// Keyed on backend + manifest PATH + the actual CONTENT that reaches the generated source (the
// fetched body text, plus the manifest's `params` and `name` — see `contentCacheKey`), NOT on
// the path alone. Path-only keying missed every write route except the Inspector's
// `persistAssetEdit` (the only caller of `invalidatePixiShaderProgram`): editing the sibling
// `.glsl`/`.wgsl` BODY directly (the documented way to edit a body — see `ShaderAssetView.tsx`)
// gets no evictor and no HMR event (the vite asset scanner returns `[]` for asset-root files), so
// a body edit + scene reload used to keep running the OLD compiled program. Content-keying makes
// the cache self-heal from EVERY route: a genuinely changed body or manifest field naturally
// computes a different key, so the edit takes effect with no evictor needed, while an unchanged
// refetch (world swap, `Scene2D.stop()`) computes the SAME key and reuses the SAME compiled
// program — #716's original guarantee, preserved. The one accepted cost: a real source change
// orphans the old program (PixiJS never calls `gl.deleteProgram`) — bounded and intentional, the
// same cost #716 already accepted for the invalidate-on-edit path.
// The promise itself is cached (not just the resolved value) so concurrent callers that land on
// the SAME content key share ONE in-flight compile. A fetch-time failure (missing manifest/body,
// wrong space, a reserved name) never even reaches `programCache.set` — see the `if (!source)
// return null;` early-out in `buildPixiShaderProgram` below — and a REJECTED compile (the
// decorator-in-a-comment throw the FIX-1 comment on `.then` below explains) is evicted the moment
// it settles, so neither kind of failure is ever left sitting in the cache: it can be fixed by
// editing the source file, and caching it would make the failure permanent even after the fix.
const programCache = new Map<string, Promise<PixiShaderProgram | null>>();
// Reverse index (path → the content keys it has ever produced) so `invalidatePixiShaderProgram`
// can still evict by path even though the cache is no longer keyed on path alone. Purely an
// optimisation/cleanup now (see that function's comment) — nothing above relies on it for
// correctness, since a real content change already computes a fresh key on its own.
const pathKeys = new Map<string, Set<string>>();

function trackPathKey(manifestPath: string, key: string): void {
  let set = pathKeys.get(manifestPath);
  if (!set) { set = new Set(); pathKeys.set(manifestPath, set); }
  set.add(key);
}

/** Drop exactly one (path, key) entry — used to evict a single failed/rejected build without
 *  touching any OTHER content key concurrently tracked under the same path. */
function untrackPathKey(manifestPath: string, key: string): void {
  programCache.delete(key);
  const set = pathKeys.get(manifestPath);
  if (!set) return;
  set.delete(key);
  if (set.size === 0) pathKeys.delete(manifestPath);
}

/** The result of the cheap I/O half of a build — the manifest + the backend-matched body text,
 *  fetched and validated but not yet compiled. Everything a build derives that could ever change
 *  the generated source lives here, so {@link contentCacheKey} can hash exactly this. */
interface FetchedShaderSource {
  manifest: ShaderManifest;
  body: string;
}

/** Cache key from CONTENT, not path: two fetches (of the same or different paths) that yield the
 *  same backend + body + params + name produce the SAME key, so a world swap's refetch reuses
 *  the existing compiled program and an actually-edited file computes a new one automatically.
 *  `manifest.name` IS included, even though it never affects `customBit`'s generated header/main:
 *  on WebGL it still reaches the emitted source a level up — `compileHighShaderGlProgram({name})`
 *  passes it into `new GlProgram({name})`, whose `setProgramName` prepends `#define SHADER_NAME
 *  <name>-fragment` to the actual compiled text (see the TRAP comment above). Omitting it would
 *  let a `name`-only edit rebuild to the SAME key and keep serving a program stamped with the OLD
 *  name, and leave `program.manifest.name` itself stale — exactly the class of staleness this
 *  content-keying exists to prevent, so it belongs in the key even though nothing reads
 *  `program.manifest.name` today. `space` is NOT part of the key: it never reaches `customBit`/
 *  `compileHighShader*`, and `fetchPixiShaderSource` only returns a source when
 *  `shaderSpace(manifest) === '2d'`, so at this point it is always the constant `'2d'` — including
 *  it would add a component that never varies rather than guard anything. `params` (both uniform
 *  and `texture` kinds — `customBit` reads all of `manifest.params`) does feed the generated bits
 *  and is included. `manifestPath` is included too, but only so two assets with byte-identical
 *  bodies stay distinguishable in logs/debugging — it plays no role in whether reuse is SAFE; the
 *  content does. No cryptographic hash needed — a stable string over content that's already in
 *  memory is enough. */
function contentCacheKey(webgpu: boolean, manifestPath: string, source: FetchedShaderSource): string {
  return `${webgpu ? 'gpu' : 'gl'}|${manifestPath}|${source.manifest.name ?? ''}|${JSON.stringify(source.manifest.params)}|${source.body}`;
}

/** Evict this path's cached program(s) from the module cache. Historically the ONLY thing
 *  standing between a `.shader.json` Inspector edit and a stale compiled program; now that
 *  {@link programCache} is keyed on CONTENT (see the block comment above), a changed file
 *  computes a fresh key on its own the next time it's fetched, so this call is an OPTIMISATION —
 *  it drops the now-orphaned entry for the OLD content immediately (freeing it, and giving the
 *  Inspector's own next rebuild one less stale entry to skip past) rather than leaving it to sit
 *  in the map until process end. With no argument, clears the whole cache (+ the path index).
 *  Do NOT call this for anything that isn't a source edit — a world swap or a viewport teardown
 *  must NOT evict, which is the entire point of this cache existing. */
export function invalidatePixiShaderProgram(manifestPath?: string): void {
  if (manifestPath == null) { programCache.clear(); pathKeys.clear(); return; }
  const keys = pathKeys.get(manifestPath);
  if (!keys) return;
  for (const key of keys) programCache.delete(key);
  pathKeys.delete(manifestPath);
}

/** Fetch + validate a `space:'2d'` shader manifest + its backend-matched body, WITHOUT
 *  compiling. Returns null (already having warned/errored) for every reason a build can fail:
 *  missing manifest, wrong space, a reserved param name, or a missing body for the active
 *  backend. Split out from the compile step so {@link buildPixiShaderProgram} can compute the
 *  content cache key BEFORE deciding whether to compile at all. */
async function fetchPixiShaderSource(manifestPath: string, webgpu: boolean): Promise<FetchedShaderSource | null> {
  const manifest = await assetPlumbing.get()?.fetchShaderManifest(manifestPath) ?? null;
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

  // Remaining well-formedness findings — today that is an unknown/missing param `type`, which the
  // two guards above do NOT cover and which otherwise zero-fills silently. Reported here rather
  // than duplicated inline: `validatePixiShaderManifest` is the one place the manifest rules live
  // (it is also what the unit tests assert against), and before #74 it had no production caller at
  // all, so the check existed and never ran. Placed AFTER the space + reserved-name guards, both of
  // which `return null`, so those two can never be reported twice.
  for (const issue of validatePixiShaderManifest(manifest)) {
    console.warn(`[pixiShader] ${manifestPath}: ${issue}`);
  }

  // Fetch ONLY the active backend's body; a missing variant → fall back to the default sprite
  // shader. `webgpu` was already resolved by the caller before the cache lookup — see
  // `buildPixiShaderProgram`'s comment.
  const ext: 'wgsl' | 'glsl' = webgpu ? 'wgsl' : 'glsl';
  const plumbing = assetPlumbing.get();
  const bodyRes = plumbing ? await fetch(plumbing.assetUrl(variantPath(manifestPath, ext)), plumbing.fetchInit).catch(() => null) : null;
  const body = bodyRes?.ok ? (await bodyRes.text()).trim() : '';
  if (!body) {
    console.warn(`[pixiShader] ${manifestPath}: missing ${ext.toUpperCase()} body for the active backend — falling back to the default sprite shader.`);
    return null;
  }
  return { manifest, body };
}

/** Compile a fetched+validated source into a program for one backend. An `async` function on
 *  purpose even though nothing here awaits: `compileHighShaderGlProgram`/`GpuProgram` run
 *  synchronously and CAN throw (e.g. a decorator-shaped token inside a WGSL body comment reaches
 *  Pixi's `extractStructAndGroups`, where `item.match(bindingPattern)[1]` throws on a null match)
 *  — wrapping the call in an `async` function turns that throw into a REJECTED promise instead of
 *  an uncaught synchronous throw, so it settles {@link buildPixiShaderProgram}'s cached promise
 *  the same way a fetch failure would, and the FIX-1 `.then` there evicts it either way. */
async function compilePixiShaderProgram(source: FetchedShaderSource, webgpu: boolean): Promise<PixiShaderProgram> {
  const { manifest, body } = source;
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

/** Fetch + compile a `space:'2d'` shader program from its manifest path. Returns null
 *  (caller falls back to the default texture shader) when the manifest is missing, is
 *  not a 2D shader, or the backend-matched body is absent. Compiles ONE gl + one gpu
 *  program; call once per asset and reuse across entities. Memoised at module scope by
 *  {@link programCache}, keyed on CONTENT — see the comment there for why. */
export async function buildPixiShaderProgram(manifestPath: string): Promise<PixiShaderProgram | null> {
  // Backend is resolved up front so the fetch below always reaches the body that matches the
  // ACTUAL live renderer — same resolution the Canvas2D pool itself uses.
  const webgpu = (await resolvePixiBackend()) === 'webgpu';
  // Fetch (cheap I/O — browser-cached in prod, no-store in dev) BEFORE the cache lookup, so the
  // key can be computed from CONTENT rather than path. This function is only reached on
  // `spriteMaterialCache`'s own cache miss (roughly once per material per world swap), so the
  // extra fetch here is negligible next to a program compile.
  const source = await fetchPixiShaderSource(manifestPath, webgpu);
  if (!source) return null; // already warned/errored inside fetchPixiShaderSource
  const key = contentCacheKey(webgpu, manifestPath, source);
  const cached = programCache.get(key);
  if (cached) return cached;
  const built: Promise<PixiShaderProgram | null> = compilePixiShaderProgram(source, webgpu);
  programCache.set(key, built);
  trackPathKey(manifestPath, key);
  // FIX 1: evict on a REJECTION too, not just on fulfilment. `.then(onFulfilled)` alone (the
  // pre-fix shape — it existed to evict a null RESULT, back when the fetch+build were one
  // function and could fulfil with null) never runs when the promise REJECTS instead. A
  // `.wgsl`/`.glsl` body whose compile throws (see `compilePixiShaderProgram`'s comment — Pixi's
  // `extractStructAndGroups` throws on a decorator-shaped token inside a body comment) left the
  // poisoned promise cached forever: the author fixes the file, reloads the scene, and gets the
  // SAME rejected promise back for the rest of the session — the throw path is exactly the one
  // "never cache a failure" (the comment on `programCache` above) was written to protect against,
  // and a rejection is a failure too. The `.then` here also OWNED the derived promise it created
  // with no handler on rejection, so the rejection additionally surfaced as an unhandled
  // rejection even though `spriteMaterialCache` attaches its OWN `.catch` to the promise it gets
  // back from us. `onFulfilled` is `undefined` now (fetch-time nulls never reach `programCache` —
  // see the `if (!source) return null;` above, which returns before any set) so only rejection
  // needs handling, but the shape stays a two-arg `.then` so a future null-on-fulfil path (should
  // one ever return) is handled the same way as a matter of course.
  void built.then(undefined, () => { untrackPathKey(manifestPath, key); });
  return built;
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
