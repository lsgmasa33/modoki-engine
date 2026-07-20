/** Generic loader for file-based shaders (`<name>.shader.json` + sibling raw
 *  `<name>.wgsl` / `<name>.glsl` bodies). Picks the body matching the active
 *  renderer backend (WGSL → native WebGPU, GLSL → WebGL2 fallback), wraps it in a
 *  NodeMaterial, and feeds the material's param values in as the shader's named
 *  inputs. Returns null when the needed variant is missing so the caller can fall
 *  back to the standard material.
 *
 *  Shader body convention: one entry function returning vec4 (rgba). Its named
 *  arguments bind by name (three's FunctionCallNode) to either a standard input
 *  or a schema param (by key). A `texture` param binds the sampled color (vec4)
 *  at the mesh UV. A shader declares only the args it needs.
 *
 *  Standard inputs: geometry/time — `uv`, `nView`, `nWorld`, `pView`, `pWorld`,
 *  `time`; and scene lighting from the actual Light traits (see
 *  `sceneLightUniforms.ts`) — `sceneDiffuse` (vec3, a ready-made Lambert term:
 *  `albedo * (ambientColor + sceneDiffuse)`), plus the raw `keyLightDir` (vec3,
 *  toward the key directional light), `keyLightColor` (vec3, rgb×intensity), and
 *  `ambientColor` (vec3) for shaders that want their own lighting math.
 *
 *  Standard-input names are deliberately abbreviated so they don't collide with
 *  TSL's builtin node identifiers (`normalView`, `positionView`, ...). If the
 *  shader function parameter shares a name with a TSL builtin, the WGSL/GLSL
 *  builder ends up registering the same identifier twice in one scope and
 *  emits "Declaration name 'normalView' already in use. Renamed to
 *  'normalView_1'" on every compile. */

import * as THREE from 'three';
import { NodeMaterial } from 'three/webgpu';
import { wgslFn, glslFn, vec2, vec3, vec4, uv, normalView, normalWorld, positionView, positionWorld, time, texture } from 'three/tsl';
import { nprFragmentOutput } from '../rendering/npr/NPRPostProcess';
import { getSceneLightUniforms, buildSceneDiffuseNode } from '../rendering/sceneLightUniforms';
import { getWebGPUSupported } from '../rendering/gpuDetect';
import { assetUrl } from './assetUrl';
import { ASSET_FETCH_INIT } from './assetFetch';
import { sideOf } from './materialUtils';
import { loadTexture3D } from './textureResolver';
import { coerceParamValue, fetchShaderManifest, type ShaderParam } from './shaderSchema';

type CallFn = (args: Record<string, unknown>) => unknown;

/** Derive the sibling body path from a `.shader.json` manifest path. */
function variantPath(manifestPath: string, ext: 'wgsl' | 'glsl'): string {
  return manifestPath.replace(/\.shader\.json$/i, `.${ext}`);
}

/** Strip // line and block comments, then trim. Three's WGSL/GLSL function
 *  parsers expect the source to begin at the function declaration, so leading
 *  doc comments in an authored shader file would otherwise fail to parse. */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .trim();
}

/** Load an image asset ref into a sampled-color TSL node (vec4 at the mesh UV).
 *  Awaits the image so the first render is complete (mirrors meshTemplateCache).
 *  Falls back to white when the ref is empty or the load fails. `acquired` is
 *  populated with every concrete THREE.Texture allocated here so the material's
 *  caller can stash them in `userData.textures` for disposeMaterial.
 *
 *  Routes through `loadTexture3D` (the shared texture resolver) so the ref's
 *  GUID resolves to the correct converted variant (KTX2/WebP) — the production
 *  build drops source PNGs, so a bespoke `TextureLoader.load(source)` would 404.
 *  `loadTexture3D` also applies the texture's import settings (wrap / colorspace /
 *  flipY / mipmaps); we pin `flipY: false` to keep the GLB-origin convention for
 *  the non-KTX source-fallback case. */
async function textureNode(ref: string, acquired: THREE.Texture[]): Promise<unknown> {
  if (!ref) return vec4(1, 1, 1, 1);
  let tex: THREE.Texture | null = null;
  try {
    tex = await loadTexture3D(ref, { flipY: false });
  } catch (e) {
    console.warn(`[FileShader] texture load failed: ${ref}`, e);
    tex = null;
  }
  if (tex) acquired.push(tex);
  return tex ? texture(tex) : vec4(1, 1, 1, 1);
}

/** Convert a schema param + stored value into a TSL node (or raw scalar) suitable
 *  as a shader-function argument. Uses the const-node pattern (same as the
 *  code-registered custom shaders) — values are baked per build; the inspector
 *  rebuilds the material on edit via invalidateMaterial. */
export function paramNode(param: ShaderParam, value: unknown): unknown {
  const v = coerceParamValue(param, value);
  switch (param.type) {
    case 'float':
      return v as number;
    case 'bool':
      return v as boolean;
    case 'color': {
      const c = new THREE.Color(v as number);
      return vec3(c.r, c.g, c.b);
    }
    case 'vec2': {
      const a = v as number[];
      return vec2(a[0], a[1]);
    }
    case 'vec3': {
      const a = v as number[];
      return vec3(a[0], a[1], a[2]);
    }
    case 'vec4': {
      const a = v as number[];
      return vec4(a[0], a[1], a[2], a[3]);
    }
  }
}

/** Build a Three.js material from a file-based shader asset. `data` is the
 *  material JSON (`params`, `side`, `transparent`, `opacity`, ...). Returns null
 *  if the manifest or the backend-matched body is missing — caller falls back. */
export async function buildFileShaderMaterial(
  manifestPath: string,
  data: Record<string, unknown>,
): Promise<THREE.Material | null> {
  const manifest = await fetchShaderManifest(manifestPath);
  if (!manifest) return null;

  const webgpu = await getWebGPUSupported();
  const ext: 'wgsl' | 'glsl' = webgpu ? 'wgsl' : 'glsl';

  const srcRes = await fetch(assetUrl(variantPath(manifestPath, ext)), ASSET_FETCH_INIT);
  if (!srcRes.ok) return null; // variant missing for this backend → fall back to standard
  const source = stripComments(await srcRes.text());

  const fn = (webgpu ? wgslFn(source) : glslFn(source)) as unknown as CallFn;

  // Standard inputs available to every shader, by name. Built here (not at module
  // load) so TSL node construction stays inside the render context. Names are
  // abbreviated to avoid collisions with TSL builtin identifiers — see the
  // module doc comment.
  const lightU = getSceneLightUniforms();
  const inputs: Record<string, unknown> = {
    uv: uv(),
    nView: normalView,
    nWorld: normalWorld,
    pView: positionView,
    pWorld: positionWorld,
    time,
    // Scene lighting (from the actual Light traits, refreshed per frame). A
    // shader binds only the names it declares, so these cost nothing unless used.
    // `sceneDiffuse` is a ready-made Lambert term; the raw key-light uniforms are
    // for shaders that want their own (stylized) lighting math.
    keyLightDir: lightU.keyLightDir,
    keyLightColor: lightU.keyLightColor,
    ambientColor: lightU.ambientColor,
    sceneDiffuse: buildSceneDiffuseNode(normalWorld, positionWorld),
  };

  // Schema params override standard inputs on key collision. Texture params load
  // asynchronously; scalar/color/vec params are built synchronously.
  const values = (data.params as Record<string, unknown>) ?? {};
  const ownedTextures: THREE.Texture[] = [];
  for (const [key, param] of Object.entries(manifest.params)) {
    if (param.type === 'texture') {
      inputs[key] = await textureNode(coerceParamValue(param, values[key]) as string, ownedTextures);
    } else {
      inputs[key] = paramNode(param, values[key]);
    }
  }

  const mat = new NodeMaterial();
  // Stash the concrete textures we allocated so disposeMaterial can free them.
  // Textures bound via TSL `texture(tex)` nodes don't sit on PBR slots
  // (mat.map / .normalMap / …) so the generic disposeMaterial slot-walk misses
  // them; this is the only handle that survives the build.
  if (ownedTextures.length > 0) {
    (mat.userData ??= {}).textures = ownedTextures;
  }
  // Materialize the raw-WGSL/GLSL result into a var before swizzling. Swizzling
  // a deferred FunctionCallNode (`.rgb` / `.a`) is type-resolution-order
  // sensitive and intermittently fails TSL validation ("expected vec3/float")
  // on (re)build; a var node has a concrete type so the swizzle is stable.
  const color = (fn(inputs) as any).toVar();
  if (manifest.colorPreserve === 'alpha') {
    // The shader's returned alpha is a per-pixel NPR color-preserve mask, not
    // opacity. Emit opaque output[0] and route the mask into lineColor.a.
    (mat as unknown as { fragmentNode: unknown }).fragmentNode =
      nprFragmentOutput(vec4(color.rgb, 1.0), color.a);
  } else {
    // No opt-in → preserve falls back to the material's nprColorPreserve (0).
    (mat as unknown as { fragmentNode: unknown }).fragmentNode = nprFragmentOutput(color);
  }

  mat.side = sideOf(data.side);
  mat.transparent = (data.transparent as boolean) ?? false;
  mat.opacity = (data.opacity as number) ?? 1;

  return mat;
}
