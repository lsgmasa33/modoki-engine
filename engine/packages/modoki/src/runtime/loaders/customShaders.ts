/** Custom shader registry — the `type: 'custom'` material builder dispatches
 *  here by name. Each game registers its shaders at startup (typically from
 *  the game's `registerSystems`), giving them stable names that .mat.json
 *  files can reference (e.g. `"shader": "space-console/stripes"`).
 *
 *  Naming convention: `<game-id>/<shader-id>` to avoid cross-game collisions.
 *  The engine itself can register shaders too if it ships any (none today).
 *
 *  Shaders may optionally register a param schema so the editor can expose typed
 *  widgets for their params (the same schema shape file shaders declare in their
 *  `.shader.json`). File-based shaders are NOT registered here — the material
 *  loader builds them on demand from their asset path. */

import type * as THREE from 'three';
import type { ShaderParamSchema } from './shaderSchema';

export type CustomShaderBuild = (params: Record<string, unknown>) => THREE.Material | Promise<THREE.Material>;

const shaders = new Map<string, CustomShaderBuild>();
const schemas = new Map<string, ShaderParamSchema>();

export function registerCustomShader(name: string, build: CustomShaderBuild, schema?: ShaderParamSchema): void {
  shaders.set(name, build);
  if (schema) schemas.set(name, schema);
}

export function unregisterCustomShader(name: string): void {
  shaders.delete(name);
  schemas.delete(name);
}

export function getCustomShader(name: string): CustomShaderBuild | undefined {
  return shaders.get(name);
}

/** Param schema for a registered code shader, if it declared one. */
export function getCustomShaderSchema(name: string): ShaderParamSchema | undefined {
  return schemas.get(name);
}

export function getRegisteredShaderNames(): string[] {
  return Array.from(shaders.keys());
}
