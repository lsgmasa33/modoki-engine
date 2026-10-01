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
import { getTraitByName } from '../core/ecs/traitRegistry';
import { getCurrentWorld, findEntityById } from '../core/ecs/world';
import { templateKeyOf } from '../core/templateIdentity';
import { isStoredRoot, durableGuid, type MemberPi } from '../core/assetRefRules';
import { PREFAB_EDIT_ROOT_GUID } from '../core/prefabEditRoot';

const marks = new Map<PackedEntity, Set<string>>();
const keyOf = (trait: string, field: string) => `${trait}.${field}`;

/** ROTATION IS ONE VALUE (#1880 F5, owner-approved, the Unity way): a mark on any of `Transform.rx/ry/rz` is a mark on
 *  all three. Unity records a rotation edit as one quaternion (`TransformRotationGUI` writes
 *  `m_Rotation.quaternionValue` whole even when one Euler field changed), so an instance that turned one axis pins its
 *  whole rotation against later template edits. Stated HERE, the one store every mark goes through (an edit, the
 *  reparent's compensation, the load's seeding, a restore), so the top-level and nested captures, which save what is
 *  marked, save the rotation whole without a rule of their own. */
export const ROTATION_MARKS = ['Transform.rx', 'Transform.ry', 'Transform.rz'] as const;
const groupOf = (key: string): readonly string[] => ((ROTATION_MARKS as readonly string[]).includes(key) ? ROTATION_MARKS : [key]);

/** F7 (#1914 R6, owner ruling 2026-10-01, Unity's rootOrder): a SCENE instance's root ALWAYS records its sibling order —
 *  an outermost entry's root, and a reference node the scene added (a stored root with no template key) — as a default
 *  override (#1831: listed, left out of Apply All and Revert All). So its place never follows its template root's
 *  `sortOrder`, and a Missing Prefab placeholder loaded cold (the prefab deleted outside the editor, seed 7078) spawns
 *  where it was, from the override every save now writes. Implicit, read through {@link getOverrideMarkSet}, so every
 *  route that makes such a root (a load, a drop, a rebuild, Create Prefab, a paste) records it with no seeding of its own;
 *  an unmark cannot take it back, as Unity always writes `m_RootOrder`. Not a template's copy of a reference node, whose
 *  order is recorded like any field, and nothing in a prefab-edit world: a template states a row's place in the row. */
const ROOT_ORDER = 'EntityAttributes.sortOrder';
function recordsRootOrder(entity: Entity): boolean {
  const pi = getTraitByName('PrefabInstance');
  const ea = getTraitByName('EntityAttributes');
  if (!pi || !ea || !entity.has(pi.trait) || !isStoredRoot(entity.get(pi.trait) as MemberPi, entity.id()) || templateKeyOf(entity)) return false;
  const attrs = entity.get(ea.trait) as { guid?: string; parentId?: number } | undefined;
  if (!durableGuid(attrs?.guid)) return false;
  const world = getCurrentWorld();
  let inside = false;
  for (let p = attrs?.parentId ?? 0, hops = 0; p && hops < 10000; hops++) {
    const e = findEntityById(p, world);
    const a = e?.has(ea.trait) ? e.get(ea.trait) as { guid?: string; parentId?: number } : undefined;
    if (!a) break;
    if (a.guid === PREFAB_EDIT_ROOT_GUID) return false;
    if (e!.has(pi.trait)) inside = true;
    p = a.parentId ?? 0;
  }
  // Inside an instance it is a node: the scene's own, unless it is a template's copy that lost its key marker (a Play→Stop
  // or an undo respawn), which only the editor's documents can tell (`setTemplateCopyTest`).
  return !inside || !isTemplateCopy(entity);
}

let isTemplateCopy: (entity: Entity) => boolean = () => false;
/** The editor's test for a template's copy of a reference node whose key marker is gone (`recoverTemplateKey`, which reads
 *  the editor's prefab cache). Registered by `prefabCache.ts`; outside the editor no node lost its marker. */
export function setTemplateCopyTest(test: (entity: Entity) => boolean): void {
  isTemplateCopy = test;
}

function setFor(entity: Entity): Set<string> {
  const key = packedOf(entity);
  let s = marks.get(key);
  if (!s) { s = new Set(); marks.set(key, s); }
  return s;
}

/** Record that `field` of `trait` is an explicit override on this instance member. */
export function markOverride(entity: Entity, trait: string, field: string): void {
  const s = setFor(entity);
  for (const k of groupOf(keyOf(trait, field))) s.add(k);
}

/** Take back the mark on `field` of `trait`: an editor write that put the field back at its base, or the undo of
 *  the write that marked it (#1709). */
export function unmarkOverride(entity: Entity, trait: string, field: string): void {
  const s = marks.get(packedOf(entity));
  if (s) for (const k of groupOf(keyOf(trait, field))) s.delete(k);
}

/** Re-apply "Trait.field" keys read off another entity with {@link getCarriedOverrideMarks} — a respawn
 *  of the same logical member (undo, a carried entity) or a copy of it. */
export function restoreOverrideMarks(entity: Entity, keys: Iterable<string>): void {
  const s = setFor(entity);
  for (const k of keys) for (const g of groupOf(k)) s.add(g);
}

/** The set of "Trait.field" keys explicitly overridden on this member (or undefined): a scene instance root's sibling
 *  order always among them (F7, {@link recordsRootOrder}). */
export function getOverrideMarkSet(entity: Entity): ReadonlySet<string> | undefined {
  const s = marks.get(packedOf(entity));
  if (s?.has(ROOT_ORDER) || !recordsRootOrder(entity)) return s;
  return new Set([...(s ?? []), ROOT_ORDER]);
}

/** The marks STORED on this member, exactly: for a write that takes some away and must put back the same ones. */
export function getStoredOverrideMarks(entity: Entity): ReadonlySet<string> | undefined {
  return marks.get(packedOf(entity));
}

/** What a CARRIER captures to put back later with {@link restoreOverrideMarks} (an undo snapshot, a copy, a relink, a
 *  carried entity): the stored marks, less the sibling order this entity's ROLE records (F7, {@link recordsRootOrder}).
 *  That record belongs to the role, which the entity it is put back on is read for again. Carried, it came back stored
 *  and outlived the role: a moved nested root relinked by an undo pinned its order against its template, and a scene
 *  instance pasted into prefab edit stated an order there (#1914 close-out review). A load stores it too, since a save
 *  writes the order every scene root records, so the stored copy is dropped as well as the implied one. A reader that
 *  decides what the save writes or the dialog lists takes {@link getOverrideMarkSet}. */
export function getCarriedOverrideMarks(entity: Entity): ReadonlySet<string> | undefined {
  const s = marks.get(packedOf(entity));
  if (!s?.has(ROOT_ORDER) || !recordsRootOrder(entity)) return s;
  return new Set([...s].filter((k) => k !== ROOT_ORDER));
}

/** Drop all marks for one entity. */
export function clearOverrideMarks(entity: Entity): void {
  marks.delete(packedOf(entity));
}

/** Drop every mark (called when the world/scene is swapped). */
export function clearAllOverrideMarks(): void {
  marks.clear();
}
