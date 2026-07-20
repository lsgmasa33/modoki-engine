/** Built-in material type presets — registered with materialTypes at engine
 *  init. Each preset reads the relevant fields from the .mat.json data and
 *  returns a Three.js Material. Texture/opacity/side/lineColor application is
 *  handled by the caller (meshTemplateCache) uniformly across all types. */

import * as THREE from 'three';
import { registerMaterialType, type MaterialBuilder } from './materialTypes';
import { getCustomShader } from './customShaders';
import { resolveRef } from './assetManifest';
import { sideOf } from './materialUtils';

const pbrBuilder: MaterialBuilder = {
  build(data) {
    const mat = new THREE.MeshStandardMaterial({
      color: (data.color as number) ?? 0xffffff,
      roughness: (data.roughness as number) ?? 1,
      metalness: (data.metalness as number) ?? 0,
      transparent: (data.transparent as boolean) ?? false,
      opacity: (data.opacity as number) ?? 1,
      side: sideOf(data.side),
      alphaTest: (data.alphaTest as number) ?? 0,
      envMapIntensity: (data.envMapIntensity as number) ?? 1,
    });
    // Remaining MeshStandardMaterial scalars/flags. Each is only assigned when set,
    // so a sparse .mat.json keeps THREE's defaults. The map *intensity* scalars
    // (ao/light/bump/displacement/normal) are harmless without their map and take
    // effect once meshTemplateCache loads it.
    if (data.emissive !== undefined) mat.emissive = new THREE.Color(data.emissive as number);
    if (data.emissiveIntensity !== undefined) mat.emissiveIntensity = data.emissiveIntensity as number;
    if (data.aoMapIntensity !== undefined) mat.aoMapIntensity = data.aoMapIntensity as number;
    if (data.lightMapIntensity !== undefined) mat.lightMapIntensity = data.lightMapIntensity as number;
    if (data.bumpScale !== undefined) mat.bumpScale = data.bumpScale as number;
    if (data.displacementScale !== undefined) mat.displacementScale = data.displacementScale as number;
    if (data.displacementBias !== undefined) mat.displacementBias = data.displacementBias as number;
    if (data.flatShading !== undefined) mat.flatShading = data.flatShading as boolean;
    if (data.wireframe !== undefined) mat.wireframe = data.wireframe as boolean;
    if (data.vertexColors !== undefined) mat.vertexColors = data.vertexColors as boolean;
    return mat;
  },
};

const unlitBuilder: MaterialBuilder = {
  build(data) {
    return new THREE.MeshBasicMaterial({
      color: (data.color as number) ?? 0xffffff,
      transparent: (data.transparent as boolean) ?? false,
      opacity: (data.opacity as number) ?? 1,
      side: sideOf(data.side),
      alphaTest: (data.alphaTest as number) ?? 0,
    });
  },
};

const customBuilder: MaterialBuilder = {
  async build(data) {
    const name = data.shader as string | undefined;
    if (!name) {
      console.warn('[Material] type=custom requires a `shader` field (a registered shader name or a .shader.json asset ref).');
      return pbrBuilder.build(data);
    }
    // 1. Code-registered shader (by name) — the original path.
    const build = getCustomShader(name);
    if (build) {
      // Forward the material's top-level `texture` ref into params so
      // texture-driven custom shaders (e.g. the planet projection) can bind it
      // via TSL — meshTemplateCache's `.map` application is skipped for
      // NodeMaterials, so a shader can't pick it up otherwise. An explicit
      // `params.texture` still wins.
      const params = { ...((data.params as Record<string, unknown>) ?? {}) };
      if (data.texture != null && params.texture == null) params.texture = data.texture;
      return await build(params);
    }
    // 2. File-based shader: resolve the ref (guid or path) to a .shader.json asset.
    //    Lazy-import keeps the WebGPU node pipeline (three/webgpu) out of the module
    //    graph for the common pbr/unlit path — loaded only when a file shader is built.
    //    The render3d flag lets Rolldown DCE the whole `import('./fileShaderBuilder')`
    //    (and thus three/webgpu) from a 2D-only build: file shaders are WGSL/GLSL
    //    NodeMaterials, a 3D-renderer feature with no meaning when render3d is off.
    const path = resolveRef(name);
    if (path && path.endsWith('.shader.json')) {
      if (!__MODOKI_MODULE_RENDER3D__) {
        console.warn(`[Material] File shader "${name}" needs the 3D renderer, which was excluded from this build. Falling back to standard material.`);
        return pbrBuilder.build(data);
      }
      const { buildFileShaderMaterial } = await import('./fileShaderBuilder');
      const mat = await buildFileShaderMaterial(path, data);
      if (mat) return mat;
      // The backend-matched variant (.wgsl/.glsl) is missing → use the standard material.
      return pbrBuilder.build(data);
    }
    console.warn(`[Material] Shader "${name}" is neither a registered shader nor a .shader.json asset. Falling back to standard material.`);
    return pbrBuilder.build(data);
  },
};

let _registered = false;
export function registerBuiltinMaterialTypes(): void {
  if (_registered) return;
  _registered = true;
  registerMaterialType('pbr', pbrBuilder);
  registerMaterialType('unlit', unlitBuilder);
  registerMaterialType('custom', customBuilder);
}
