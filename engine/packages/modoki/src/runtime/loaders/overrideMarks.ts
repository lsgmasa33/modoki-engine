/** Two rules of what an instance's record lists, stated once for every reader (#2001 S8b: the override-mark store this
 *  file held is gone; the instance's record is the one statement of what it overrides, read through `overrideKeysOf`,
 *  `editor/instance/instanceOverrideView.ts`). */

import type { Entity } from 'koota';
import { getTraitByName } from '../core/ecs/traitRegistry';
import { getCurrentWorld, findEntityById } from '../core/ecs/world';
import { templateKeyOf } from '../core/templateIdentity';
import { isStoredRoot, durableGuid, type MemberPi } from '../core/assetRefRules';
import { PREFAB_EDIT_ROOT_GUID } from '../core/prefabEditRoot';

/** ROTATION IS ONE VALUE (#1880 F5, owner-approved, the Unity way): a record of any of `Transform.rx/ry/rz` is a record of
 *  all three. Unity records a rotation edit as one quaternion (`TransformRotationGUI` writes
 *  `m_Rotation.quaternionValue` whole even when one Euler field changed), so an instance that turned one axis pins its
 *  whole rotation against later template edits. The record's writer and the view both take the group from here. */
export const ROTATION_MARKS = ['Transform.rx', 'Transform.ry', 'Transform.rz'] as const;

/** F7 (#1914 R6, owner ruling 2026-10-01, Unity's rootOrder): a SCENE instance's root ALWAYS records its sibling order —
 *  an outermost entry's root, and a reference node the scene added (a stored root with no template key) — as a default
 *  override (#1831: listed, left out of Apply All and Revert All). So its place never follows its template root's
 *  `sortOrder`, and a Missing Prefab placeholder loaded cold (the prefab deleted outside the editor, seed 7078) spawns
 *  where it was, from the override every save now writes. Implicit, read through the view (`overrideKeysOf`), so every
 *  route that makes such a root (a load, a drop, a rebuild, Create Prefab, a paste) records it with no seeding of its own;
 *  nothing can take it back, as Unity always writes `m_RootOrder`. Not a template's copy of a reference node, whose
 *  order is recorded like any field, and nothing in a prefab-edit world: a template states a row's place in the row. */
export function recordsRootOrder(entity: Entity): boolean {
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
