/** The Missing Prefab placeholder, as the editor's writers and undo steps see it (#1818, #1819; I20, I21 in
 *  docs/prefabs.md).
 *
 *  A placeholder stands in for a prefab reference the load could not expand (#1699, I18). Its save writes the KEPT
 *  RECORD plus only the live placement: name, guid, parent, folder, sort order and active flag (`asSceneEntry`,
 *  `asAddedNode`). Every other edit that lands on it shows live and is dropped by the next save. So:
 *
 *  - **The write gate** (`placeholderWriteRefusal`, I21): every writer in the field-write family and the trait
 *    add/remove writers ask it, on the human and the agent surfaces. It lets through exactly the `EntityAttributes`
 *    fields the writers carry, and refuses the rest with a reason.
 *  - **The kind** (`isMissingPrefabPlaceholder`, I20): `entityRef` records whether its entity was a placeholder, and
 *    `require` refuses an undo whose target has changed kind since (an instance that a world swap turned into a
 *    placeholder, or the other way round). */

import { findEntity, readTraitData } from '../../runtime/core/ecs/entityUtils';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { PLACEHOLDER_PLACEMENT_FIELDS, PLACEHOLDER_ENTRY_ONLY_FIELDS } from '../../runtime/loaders/unresolvedPrefabRefs';

/** True when the live entity `id` is a Missing Prefab placeholder: it carries a kept record (`UnresolvedPrefabRef`). */
export function isMissingPrefabPlaceholder(id: number): boolean {
  return !!unresolvedRefOf(findEntity(id) as Parameters<typeof unresolvedRefOf>[0]);
}

/** The `EntityAttributes` fields a placeholder's writers save from the live entity: the name, plus the placement both
 *  writers carry (`PLACEHOLDER_PLACEMENT_FIELDS`, the one list). The Hierarchy's rename, reparent, folder moves,
 *  reorder and Activate write exactly these. Derived, not restated, so a field the gate lets through is one the save
 *  keeps. */
export const PLACEHOLDER_WRITABLE_FIELDS: ReadonlySet<string> = new Set(['name', ...PLACEHOLDER_PLACEMENT_FIELDS]);

/** The live name of entity `id` ('' when it has none). */
export function entityNameOf(id: number): string {
  const ea = getTraitByName('EntityAttributes');
  const data = ea ? readTraitData(id, ea) : null;
  return data ? String(data.name ?? '') : '';
}

/** The words for an edit refused on a placeholder, naming it. */
export function placeholderRefusalWords(name: string): string {
  return `"${name || 'Missing Prefab'}" is a Missing Prefab now (its prefab was deleted or cannot be read), and its save keeps only what the file holds for it — restore the prefab and reload the scene to edit it`;
}

/** The fields only the ENTRY shape carries (`asSceneEntry`'s `order`): a placeholder saved as an added node inside an
 *  instance keeps neither. The writers' own list. */
const ENTRY_ONLY_FIELDS: ReadonlySet<string> = new Set(PLACEHOLDER_ENTRY_ONLY_FIELDS);

/** True when the save writes placeholder `id` as an ADDED NODE (`asAddedNode`): it sits inside a prefab instance, so the
 *  instance's capture takes it (`captureChild`). Anywhere else it is written as a scene entry. */
export function placeholderWrittenAsNode(id: number): boolean {
  const ea = getTraitByName('EntityAttributes');
  return !!ea && isUnderPrefabInstance(Number((readTraitData(id, ea) as { parentId?: number } | null)?.parentId ?? 0), id);
}

/** True when `parentId` or one of its ancestors is a prefab instance entity: a placeholder under it is saved as an
 *  added node. `self` is excluded from the walk (a cycle guard). */
export function isUnderPrefabInstance(parentId: number, self = 0): boolean {
  const pi = getTraitByName('PrefabInstance');
  const ea = getTraitByName('EntityAttributes');
  if (!pi || !ea) return false;
  const seen = new Set<number>([self]);
  let parent = parentId;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    if (findEntity(parent)?.has(pi.trait)) return true;
    parent = Number((readTraitData(parent, ea) as { parentId?: number } | null)?.parentId ?? 0);
  }
  return false;
}

/** Why writing `traitName` (`field`, or the whole trait when omitted: an add or a remove) on entity `id` is refused,
 *  or null when it may go ahead. Refuses on a placeholder unless it is one of `PLACEHOLDER_WRITABLE_FIELDS` that the
 *  shape it is saved in carries. */
export function placeholderWriteRefusal(id: number, traitName: string, field?: string): string | null {
  if (!isMissingPrefabPlaceholder(id)) return null;
  if (traitName === 'EntityAttributes' && field !== undefined && PLACEHOLDER_WRITABLE_FIELDS.has(field)) {
    if (!ENTRY_ONLY_FIELDS.has(field) || !placeholderWrittenAsNode(id)) return null;
  }
  return placeholderRefusalWords(entityNameOf(id));
}

/** The first refusal among `ids` for the same write, or null. A multi-entity writer refuses as a whole: writing the
 *  rest and skipping the placeholder would split one undo entry across a partial selection. */
export function placeholderWriteRefusalAny(ids: readonly number[], traitName: string, field?: string): string | null {
  for (const id of ids) {
    const r = placeholderWriteRefusal(id, traitName, field);
    if (r) return r;
  }
  return null;
}
