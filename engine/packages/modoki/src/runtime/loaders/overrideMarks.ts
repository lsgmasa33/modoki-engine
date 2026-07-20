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
 *  Keyed by ecs id. A member's marks die with the entity; a fresh spawn clears
 *  any stale marks left on a reused id (`clearOverrideMarks`), and a scene swap
 *  clears everything (`clearAllOverrideMarks`). The map is populated in both the
 *  editor and runtime apply paths but only ever READ by the editor — in a
 *  production build it costs a few Map inserts per instance and is never queried. */

const marks = new Map<number, Set<string>>();
const keyOf = (trait: string, field: string) => `${trait}.${field}`;

/** Record that `field` of `trait` is an explicit override on this instance member. */
export function markOverride(ecsId: number, trait: string, field: string): void {
  let s = marks.get(ecsId);
  if (!s) { s = new Set(); marks.set(ecsId, s); }
  s.add(keyOf(trait, field));
}

/** The set of "Trait.field" keys explicitly overridden on this member (or undefined). */
export function getOverrideMarkSet(ecsId: number): ReadonlySet<string> | undefined {
  return marks.get(ecsId);
}

/** Drop all marks for one entity (called on fresh spawn to defend against ecs-id reuse). */
export function clearOverrideMarks(ecsId: number): void {
  marks.delete(ecsId);
}

/** Drop every mark (called when the world/scene is swapped). */
export function clearAllOverrideMarks(): void {
  marks.clear();
}
