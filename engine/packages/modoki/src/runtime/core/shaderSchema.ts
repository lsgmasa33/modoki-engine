/** Shader parameter schema — the PURE half of `loaders/shaderSchema.ts` (P7 C10). Declares
 *  which params a shader exposes and how the editor should render them; the chosen param
 *  VALUES live in the material's `params` object. Moved to `core/` since `rendering/
 *  pixiShaderBuilder.ts` needs these with no network dependency — `loaders/shaderSchema.ts`
 *  keeps only `fetchShaderManifest` (the actual network fetch) and re-exports everything here. */

export type ShaderParamType = 'float' | 'color' | 'bool' | 'vec2' | 'vec3' | 'vec4' | 'texture';

/** The known param types — used to surface a typo'd `type` at manifest-load time
 *  rather than silently falling through to `coerceParamValue`'s zero default. */
const SHADER_PARAM_TYPES: ReadonlySet<string> = new Set<ShaderParamType>([
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
