/** Explicit prefab-instance override marks.
 *
 *  An override is a DELIBERATE per-instance field change. The engine used to
 *  infer override-ness purely from `live value != prefab base` — which silently
 *  LOSES an override when a child prefab's base is edited to a value the instance
 *  overrides: the next serialize re-diffs against the new base, the difference
 *  collapses to zero, and the override vanishes from the file. (Reported as
 *  "edited the Engine Flame prefab position and lost the position override on the
 *  flames in the Spaceship prefab".)
 *
 *  A mark records that a field is overridden REGARDLESS of whether its value
 *  currently equals the base, so serialize writes it either way.
 *
 *  Marks are RUNTIME-ONLY state — NOT persisted, no file-format change. The
 *  existing override map in a scene/prefab file already IS the explicit record;
 *  marks are seeded from it at apply time (`applyOverrides*`) and from user edits,
 *  then read by the editor at serialize time (`captureInstanceOverrides`).
 *
 *  KEYED BY THE PACKED ENTITY (#868), generation included — not `entity.id()`. koota hands a
 *  destroyed index to the next spawn, and the id key was cleared only on the instantiate paths, so
 *  an editor duplicate/paste/undo that respawned onto a dead member's index inherited its marks (a
 *  spurious override frozen into the file at save). A dead entity's marks are no longer matched by
 *  the next entity on its index.
 *
 *  ⚠️ NOT SWEPT, SO EVERY SPAWN OF A MEMBER STILL CLEARS (`clearOverrideMarks`). Nothing removes a
 *  dead entity's entry before the scene swap, and koota's generation is 8 bits: after 256 reuses of
 *  an index the packed value repeats EXACTLY, and a prefab rebuild loop (save → refresh, Apply,
 *  Revert, their undo/redo) respawns members on the same few indices — measured, 300 rebuilds leave a
 *  dead mark on every generation. So the instantiate paths and `respawnFromSnapshot` clear before
 *  they seed, exactly as the id-keyed map did; the packed key closes the window BETWEEN a destroy and
 *  the next spawn, the clear closes the wrap.
 *
 *  What must SURVIVE a respawn is carried explicitly: an `EntitySnapshot`
 *  records its entity's marks and `respawnFromSnapshot` restores them (delete-undo, redo, duplicate,
 *  paste), and a scene swap's carry re-seeds them per entity (`SceneManager`). A scene swap clears
 *  everything (`clearAllOverrideMarks`). The map is populated in both the editor and runtime apply
 *  paths but only ever READ by the editor — in a production build it costs a few Map inserts per
 *  instance and is never queried. */

import type { Entity } from 'koota';
import { packedOf, type PackedEntity } from '../core/ecs/entityTable';

const marks = new Map<PackedEntity, Set<string>>();
const keyOf = (trait: string, field: string) => `${trait}.${field}`;

function setFor(entity: Entity): Set<string> {
  const key = packedOf(entity);
  let s = marks.get(key);
  if (!s) { s = new Set(); marks.set(key, s); }
  return s;
}

/** Record that `field` of `trait` is an explicit override on this instance member. */
export function markOverride(entity: Entity, trait: string, field: string): void {
  setFor(entity).add(keyOf(trait, field));
}

/** Re-apply "Trait.field" keys read off another entity with {@link getOverrideMarkSet} — a respawn
 *  of the same logical member (undo, a carried entity) or a copy of it. */
export function restoreOverrideMarks(entity: Entity, keys: Iterable<string>): void {
  const s = setFor(entity);
  for (const k of keys) s.add(k);
}

/** The set of "Trait.field" keys explicitly overridden on this member (or undefined). */
export function getOverrideMarkSet(entity: Entity): ReadonlySet<string> | undefined {
  return marks.get(packedOf(entity));
}

/** Drop all marks for one entity. */
export function clearOverrideMarks(entity: Entity): void {
  marks.delete(packedOf(entity));
}

/** Drop every mark (called when the world/scene is swapped). */
export function clearAllOverrideMarks(): void {
  marks.clear();
}
