/**
 * The per-frame ENTITY INDEX and its queries — engine core.
 *
 * One `EntityAttributes` query, built ONCE per frame and passed to every consumer, so N
 * consumers cost O(N + entities) instead of O(N × entities). Three queries over it:
 * lookup by id (`byId`), Unity-style relative name-path resolution (`resolveTrackTarget`),
 * and the active-in-hierarchy predicate (`isEntityActiveInHierarchy`).
 *
 * WHY IT LIVES IN `ecs/` AND NOT `animation/`. It was born in `animation/sampleClip.ts` for
 * clip binding, but it is used by the RENDERER (`scene3DSync`), the sequencer
 * (`timelineSystem`), 2D deformation (`deform2DSystem`) and animation alike — it is core
 * infrastructure, not an animation detail. Leaving it there forced the dependency arrow the
 * wrong way: a physics or zone system wanting the activity predicate would have had to import
 * it from an animation module. `sampleClip.ts` now imports from here, like everyone else.
 */

import type { World } from 'koota';
import { EntityAttributes } from '../traits/EntityAttributes';

/** koota entity handle (minimal surface we use). */
export type Ent = {
  id(): number;
  has(trait: unknown): boolean;
  get(trait: unknown): Record<string, unknown> | undefined;
  set(trait: unknown, value: Record<string, unknown>): void;
};

export interface EntityIndex {
  byId: Map<number, Ent>;
  /** parentId → (childName → child entity id). Last writer wins on duplicate names. */
  childrenByParent: Map<number, Map<string, number>>;
}

/** Build a one-shot index of the world's entities by id + name-keyed children.
 *  A single EntityAttributes query; build ONCE per frame and pass it to every
 *  `applyClipAtTime` call so N animators cost O(N + entities), not O(N × entities). */
export function buildEntityIndex(world: World): EntityIndex {
  const byId = new Map<number, Ent>();
  const childrenByParent = new Map<number, Map<string, number>>();
  world.query(EntityAttributes).updateEach(([attr]: [Record<string, unknown>], entity: Ent) => {
    const id = entity.id();
    byId.set(id, entity);
    const parentId = (attr.parentId as number) ?? 0;
    const name = (attr.name as string) ?? '';
    let bucket = childrenByParent.get(parentId);
    if (!bucket) { bucket = new Map(); childrenByParent.set(parentId, bucket); }
    bucket.set(name, id);
  });
  return { byId, childrenByParent };
}

/** Resolve a relative name-path from `rootId` to a descendant entity id, or null.
 *  "" resolves to the root itself. */
export function resolveTrackTarget(index: EntityIndex, rootId: number, path: string): number | null {
  if (!path) return index.byId.has(rootId) ? rootId : null;
  let current = rootId;
  for (const seg of path.split('/')) {
    if (!seg) continue;
    const child = index.childrenByParent.get(current)?.get(seg);
    if (child === undefined) return null;
    current = child;
  }
  return current;
}

/** Is `id` active — itself AND every ancestor (`EntityAttributes.isActive`)?
 *
 *  The `deactivatedEntities` twin of this lives in `core/ecs/transformPropagationSystem`
 *  (a sibling since P5; it was under `src/three/` before) and is what every RENDERER checks.
 *  SIM systems still can't use it for three reasons: it is built by a module whose matrix math
 *  is THREE (importing it drags three into a 2D-only/playable bundle), it is produced
 *  at TRANSFORM priority (200) so a system running earlier — timelineSystem is at 149 — reads a
 *  one-frame-stale set, and the headless harness registers no propagation system at all, so it
 *  is permanently empty there and a unit test could not pin any guard built on it.
 *
 *  So: walk the `parentId` chain over the index the caller already built — no THREE, no frame
 *  lag, works headless. `visiting` guards a parentId CYCLE (A→B→A), mirroring the `_deactVisiting`
 *  guard in the propagation pass; a cycle breaks to "active" rather than recursing forever.
 *  An entity missing from the index (destroyed, or no EntityAttributes) counts as active — the
 *  same permissive default the renderers take.
 *
 *  Consumers so far: `timelineSystem` (a deactivated entity FREEZES its Director) and the 2D/3D
 *  zone triggers (a deactivated zone/occupant fires `exit`, as if despawned). What "off" means is
 *  per-subsystem on purpose — see docs/architecture.md "`isActive` — who honours it". PHYSICS is
 *  the remaining gap and this is the seam to close it with, once it is decided whether a
 *  deactivated body leaves the Rapier world or stays as an inert ghost. */
export function isEntityActiveInHierarchy(index: EntityIndex, id: number, visiting?: Set<number>): boolean {
  const ent = index.byId.get(id);
  if (!ent) return true;
  const attr = ent.get(EntityAttributes);
  if (attr && attr.isActive === false) return false;
  const parentId = (attr?.parentId as number) ?? 0;
  if (!parentId || parentId <= 0) return true;
  const seen = visiting ?? new Set<number>();
  if (seen.has(id)) return true; // cycle — this edge can't deactivate
  seen.add(id);
  return isEntityActiveInHierarchy(index, parentId, seen);
}
