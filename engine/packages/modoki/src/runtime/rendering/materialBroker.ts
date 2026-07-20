/** Material broker — the render-layer-agnostic bridge from an ECS entity to its
 *  LIVE THREE materials + drawable objects, across every render surface.
 *
 *  WHY THIS EXISTS: a plain ECS system runs with only `world`. It cannot reach an
 *  entity's live material — materials live on `THREE.Object3D`s inside each
 *  renderer's `RenderState.ecsObjects`, and the editor runs TWO surfaces on one
 *  world (Scene3D/GameView + SceneView), each with its own cloned objects. This
 *  registry lets a renderer publish its `RenderState`, and gives systems two
 *  accessors that fan out over every surface for a world:
 *
 *    - getEntityObjects(world, id)   → the drawable meshes (write `.userData` here;
 *                                       custom-shader uniforms read it per-draw via
 *                                       `onObjectUpdate` — no clone, no recompile).
 *    - getEntityMaterials(world, id) → the live materials (mutate a per-entity CLONE
 *                                       here for standard props; never a shared one).
 *
 *  Both are the primitives `MaterialInstance` stands on. See docs/rendering.md
 *  ("MaterialInstance"). */

import type { World } from 'koota';
import type * as THREE from 'three';
import type { RenderState } from './scene3DSync';

/** The 3D renderer's mesh collector, INJECTED by scene3DSync at load
 *  (`setEntityMeshCollector`) so this render-layer-agnostic broker doesn't statically
 *  import the 3D renderer module (scene3DSync pulls three/webgpu — a static import here
 *  would block a 2D game from stripping Three). Null in a render3d-off build, where
 *  there are also no registered surfaces, so it's never reached. */
type MeshCollector = (state: RenderState, id: number) => THREE.Mesh[];
let collectMeshes: MeshCollector | null = null;
export function setEntityMeshCollector(fn: MeshCollector): void {
  collectMeshes = fn;
}

interface Surface {
  /** Resolver, not a snapshot — a surface always draws the CURRENT world, which
   *  changes on the two-world atomic scene swap. Matching against a mount-time
   *  world snapshot would go stale after the first swap. */
  getWorld: () => World;
  state: RenderState;
}

/** Every live render surface. A Set (not keyed by world) because a world can have
 *  multiple surfaces (editor: GameView + SceneView) and we fan out over all of them. */
const surfaces = new Set<Surface>();

/** Publish a render surface (its `RenderState` + a getter for the world it draws).
 *  Pass `getCurrentWorld` — the surface follows scene swaps. Call on renderer mount;
 *  call the returned disposer on unmount. Each registration is a distinct handle, so
 *  two surfaces on one world coexist. */
export function registerRenderSurface(getWorld: () => World, state: RenderState): () => void {
  const surface: Surface = { getWorld, state };
  surfaces.add(surface);
  return () => {
    surfaces.delete(surface);
  };
}

/** All drawable meshes for `id` across every surface of `world`. Empty if the
 *  entity has no 3D presence (yet) on any surface. Order is surface-registration
 *  then mesh order; callers treat it as a set. */
export function getEntityObjects(world: World, id: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const surface of surfaces) {
    if (surface.getWorld() !== world) continue;
    if (collectMeshes) out.push(...collectMeshes(surface.state, id));
  }
  return out;
}

/** All live materials for `id` across every surface of `world` (a mesh with a
 *  material array contributes each element). De-duplicated: the SAME material
 *  instance is often shared across both surfaces (materials come from a shared
 *  cache; only geometry is per-renderer), so returning it once is correct. */
export function getEntityMaterials(world: World, id: number): THREE.Material[] {
  const seen = new Set<THREE.Material>();
  for (const surface of surfaces) {
    if (surface.getWorld() !== world) continue;
    for (const mesh of (collectMeshes?.(surface.state, id) ?? [])) {
      const mat = (mesh as THREE.Mesh).material;
      if (Array.isArray(mat)) {
        for (const m of mat) if (m) seen.add(m);
      } else if (mat) {
        seen.add(mat);
      }
    }
  }
  return [...seen];
}

/** Test/teardown hook — drop every registered surface. NOT part of normal
 *  lifecycle (surfaces unregister via their disposer); used by tests to isolate. */
export function clearRenderSurfaces(): void {
  surfaces.clear();
}
