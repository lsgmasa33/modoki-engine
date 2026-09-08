/** Shader parameter schema — the PURE half of `loaders/shaderSchema.ts` (P7 C10). Declares
 *  which params a shader exposes and how the editor should render them; the chosen param
 *  VALUES live in the material's `params` object. Moved to `core/` since `rendering/
 *  pixiShaderBuilder.ts` needs these with no network dependency — `loaders/shaderSchema.ts`
 *  keeps only `fetchShaderManifest` (the actual network fetch) and re-exports everything here. */

export type ShaderParamType = 'float' | 'color' | 'bool' | 'vec2' | 'vec3' | 'vec4' | 'texture';

/** The known param types — used to surface a typo'd `type` at manifest-load time
 *  rather than silently falling through to `coerceParamValue`'s zero default. */
/** Exported so `assetSchemas.ts` can DERIVE the agent-facing note instead of transcribing it —
 *  a hand-copied union went stale on the day it landed (#831 close-out): it said
 *  `"float"|"color"` while a committed shader already used `texture`. */
export const SHADER_PARAM_TYPES: ReadonlySet<string> = new Set<ShaderParamType>([
  'float', 'color', 'bool', 'vec2', 'vec3', 'vec4', 'texture',
]);

export interface ShaderParam {
  type: ShaderParamType;
  /** Default value when a material omits this param. color → hex number; float → number;
   *  bool → boolean; vecN → number[]. */
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  /** Optional human label; falls back to the param key. */
  label?: string;
}

export type ShaderParamSchema = Record<string, ShaderParam>;

/** The shader body extensions — raw WGSL/GLSL source, sibling to a `.shader.json`
 *  descriptor. Deliberately NOT manifest assets (see `assetTypeClassifier.ts`):
 *  no GUID, no manifest entry, no `LiveReloadKind` of their own. */
export const SHADER_BODY_EXTS = ['.glsl', '.wgsl'] as const;

/** A file-based shader manifest (`<name>.shader.json`). Raw WGSL/GLSL bodies live
 *  in sibling `<name>.wgsl` / `<name>.glsl` files. */
export interface ShaderManifest {
  id?: string;
  name?: string;
  params: ShaderParamSchema;
  /** Which render layer this shader targets. `'3d'` (default) = a Three/TSL
   *  NodeMaterial built by `fileShaderBuilder` (the WGSL/GLSL body is a function
   *  returning vec4). `'2d'` = a PixiJS `Shader` built by `pixiShaderBuilder` for
   *  the Canvas2D layer (the WGSL/GLSL body is a fragment MAIN that writes
   *  `outColor` from `vUV` + `uTexture` + the generated uniform block). The two
   *  authoring conventions differ, so `space` selects the loader. */
  space?: '2d' | '3d';
  /** Opt into NPR color preservation (3D only). `'alpha'` = the shader's returned
   *  vec4 alpha is a per-pixel preserve mask (0..1) rather than opacity; the loader
   *  routes it into the NPR lineColor target. Omitted → fully NPR (grayscale). */
  colorPreserve?: 'alpha';
}

/** Derive the sibling body path from a `.shader.json` manifest path. */
export function shaderBodyPath(manifestPath: string, ext: 'glsl' | 'wgsl'): string {
  return manifestPath.replace(/\.shader\.json$/i, `.${ext}`);
}

/** Reverse of {@link shaderBodyPath}: map a shader body path (`<name>.glsl` /
 *  `<name>.wgsl`) back to its sibling `<name>.shader.json` descriptor. Returns
 *  null for any other extension. */
export function shaderManifestPathForBody(bodyPath: string): string | null {
  // Derived from SHADER_BODY_EXTS rather than repeating the extensions, so both DIRECTIONS of the
  // descriptor<->body mapping read from one list.
  // ⚠️ That is the scope of the claim — it is NOT "adding a third body extension is a one-line
  // change", which an earlier version of this comment said and which is false. At least four other
  // places hard-code the pair independently, and the tree-shaker one is load-bearing (it is what
  // keeps a body file in a production build at all):
  //   engine/plugins/asset-tree-shaker.ts (:87 kept-extensions, :117 classifier, :886 sibling walk)
  //   engine/plugins/backend/staticAssets.ts (:44 MIME)
  //   engine/packages/modoki/src/editor/panels/assetUndo.ts (:31 TEXT_ASSET_EXTS)
  // Those cannot import this constant (plugin/runtime split), so a third extension is a sweep.
  const lower = bodyPath.toLowerCase();
  for (const ext of SHADER_BODY_EXTS) {
    if (lower.endsWith(ext)) return bodyPath.slice(0, -ext.length) + '.shader.json';
  }
  return null;
}

/** Surface an authoring typo (e.g. `type: 'flot'`) loudly instead of letting
 *  `coerceParamValue`'s default branch quietly fill zeros for an unknown type. (F10) */
export function warnUnknownParamTypes(manifestPath: string, params: ShaderParamSchema): void {
  for (const [key, param] of Object.entries(params)) {
    const type = param && typeof param === 'object' ? param.type : undefined;
    if (!type || !SHADER_PARAM_TYPES.has(type)) {
      console.warn(`[shaderSchema] ${manifestPath}: param '${key}' has unknown/missing type '${type}' — must be one of ${[...SHADER_PARAM_TYPES].join(', ')}; falls back to a zero default`);
    }
  }
}

/** The shader's target layer, defaulting to 3d when unspecified. */
export function shaderSpace(manifest: Pick<ShaderManifest, 'space'>): '2d' | '3d' {
  return manifest.space === '2d' ? '2d' : '3d';
}

/** Vector param types and their component counts. */
const VEC_COMPONENTS: Record<string, number> = { vec2: 2, vec3: 3, vec4: 4 };

/** Coerce a stored value to the shape implied by a param's type, falling back to
 *  the schema default (and then a type-appropriate zero) when missing/mismatched. */
export function coerceParamValue(param: ShaderParam, value: unknown): unknown {
  const fallback = param.default;
  const v = value ?? fallback;
  switch (param.type) {
    case 'float':
      return typeof v === 'number' ? v : (typeof fallback === 'number' ? fallback : 0);
    case 'color':
      return typeof v === 'number' ? v : (typeof fallback === 'number' ? fallback : 0xffffff);
    case 'bool':
      return typeof v === 'boolean' ? v : !!fallback;
    case 'texture':
      // An asset ref (guid or path) to an image, or '' when unset.
      return typeof v === 'string' ? v : (typeof fallback === 'string' ? fallback : '');
    default: {
      const n = VEC_COMPONENTS[param.type];
      if (Array.isArray(v) && v.length === n) return v;
      if (Array.isArray(fallback) && fallback.length === n) return fallback;
      return new Array(n).fill(0);
    }
  }
}

/** Merge a material's stored param values with a shader schema: keep values for keys
 *  the schema declares (coerced), fill missing keys with schema defaults, and drop
 *  keys the schema no longer declares. Used by the inspector on shader switch and by
 *  the loader when building uniforms. */
export function mergeParamDefaults(
  schema: ShaderParamSchema,
  values: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, param] of Object.entries(schema)) {
    out[key] = coerceParamValue(param, values?.[key]);
  }
  return out;
}
