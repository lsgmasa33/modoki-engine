/** ModelPostprocessor registry — games register custom post-load fixups for
 *  different model types. Each postprocessor defines how to massage a GLB
 *  after it's loaded (material patches, mesh filtering, import-time overrides). */

// Type-only — this registry only references THREE types in signatures. A value import
// would pull the `three` base into this widely-reachable loader (a 2D build leak).
import type * as THREE from 'three';

export interface ModelLoadConfig {
  prefix: string;
  rootTransform?: {
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: number;
  };
}

export interface ModelPostprocessor {
  name: string;
  description: string;
  /** Bumped by the postprocessor author whenever `fixupMesh` /
   *  `resolveImportOptions` semantics change in a way the model-convert cache
   *  must invalidate. Mixed into the cache hash so a recipe edit forces
   *  re-encode of every model bound to this postprocessor. Default 0 — but
   *  bump it the moment any fixup body changes, or the cache will silently
   *  serve stale processed GLBs. */
  recipeVersion?: number;
  /** Process a mesh after extraction — apply material fixes, etc. */
  fixupMesh: (mesh: THREE.Mesh) => void;
  /** Optional: filter which meshes to include (return false to skip) */
  filterMesh?: (mesh: THREE.Mesh) => boolean;
  /** Optional: resolve import options from loaded templates.
   *  Called during model import to produce excludeMeshes and materialOverrides.
   *  Templates have fixupMesh already applied. */
  resolveImportOptions?: (
    templates: Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; name: string }>,
    materialDir: string,
  ) => { excludeMeshes?: string[]; materialOverrides?: Record<string, string> };
}

// ── Registry ────────────────────────────────────────────

const postprocessors = new Map<string, ModelPostprocessor>();

/** "None" postprocessor — no material modifications. Used when a model has no
 *  postprocessor selected, and as the fallback for unknown IDs. */
const nonePostprocessor: ModelPostprocessor = {
  name: 'None',
  description: 'No material modifications',
  fixupMesh: () => {},
};

postprocessors.set('none', nonePostprocessor);

export function registerModelPostprocessor(id: string, postprocessor: ModelPostprocessor) {
  postprocessors.set(id, postprocessor);
}

export function getModelPostprocessor(id: string): ModelPostprocessor {
  return postprocessors.get(id) || nonePostprocessor;
}

export function getAllModelPostprocessors(): { id: string; postprocessor: ModelPostprocessor }[] {
  return Array.from(postprocessors.entries()).map(([id, postprocessor]) => ({ id, postprocessor }));
}

export function getModelPostprocessorIds(): string[] {
  return Array.from(postprocessors.keys());
}
