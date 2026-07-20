/** Material type registry — pluggable .mat.json material builders.
 *
 *  Built-in types ('pbr', 'unlit', 'custom') are registered by the engine.
 *  Games can register additional types (e.g., a 'toon' preset) at startup.
 *
 *  Each builder receives the raw .mat.json data (minus `version`) and returns
 *  the constructed THREE.Material. Texture/opacity/side application and the
 *  `lineColor` default are applied uniformly by the caller after build. */

import type * as THREE from 'three';

export interface MaterialBuilder {
  build(data: Record<string, unknown>): THREE.Material | Promise<THREE.Material>;
}

const registry = new Map<string, MaterialBuilder>();

export function registerMaterialType(name: string, builder: MaterialBuilder): void {
  registry.set(name, builder);
}

export function getMaterialBuilder(name: string): MaterialBuilder | undefined {
  return registry.get(name);
}

export function getRegisteredMaterialTypes(): string[] {
  return Array.from(registry.keys());
}
