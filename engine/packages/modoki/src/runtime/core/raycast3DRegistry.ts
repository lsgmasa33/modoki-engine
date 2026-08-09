/** Registration-inversion seam (docs/architecture-layers.md "The registration-inversion
 *  pattern") so an L2 subsystem can call physics's ground raycast without importing
 *  `physics/` directly — L2 → L2 is disallowed except the declared producer/conductor/
 *  presentation exceptions, and `rendering → physics` isn't one of them. `physics3DSystem`
 *  self-registers its real `raycast3D` here at module-evaluation time; a consumer (today:
 *  `rendering/blobShadowSync`) calls `getRaycast3D()` instead of importing physics.
 *
 *  The hit shape below is a PLAIN LOCAL TYPE (not an import of physics's own return type), so
 *  this stays the neutral meeting point the pattern calls for rather than re-creating the edge
 *  through a shared type. `physics3DSystem.raycast3D`'s actual return shape is a structural
 *  superset (it also carries `entityId`), so it satisfies `Raycast3DFn` unchanged. */

import type { World } from 'koota';

export interface Raycast3DHit {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  distance: number;
}

export type Raycast3DFn = (
  world: World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  opts?: { maxDistance?: number; solid?: boolean; exclude?: number },
) => Raycast3DHit | null;

let impl: Raycast3DFn | null = null;

/** Physics calls this once, at module-evaluation time, to install its real raycast3D. */
export function registerRaycast3D(fn: Raycast3DFn): void {
  impl = fn;
}

/** Consumers read the current implementation — null if physics hasn't registered yet (e.g. a
 *  headless test that deep-imports rendering without going through `runtime/index.ts`). Callers
 *  treat null the same as "no ground found" (hide, don't throw). */
export function getRaycast3D(): Raycast3DFn | null {
  return impl;
}
