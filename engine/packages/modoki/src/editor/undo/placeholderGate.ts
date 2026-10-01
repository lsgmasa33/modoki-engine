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
import { PLACEHOLDER_PLACEMENT_FIELDS } from '../../runtime/loaders/unresolvedPrefabRefs';
import { isSuppliedByPrefab, repeatedTemplateKeyRefusal } from '../scene/restructureRefusal';

/** True when the live entity `id` is a Missing Prefab placeholder: it carries a kept record (`UnresolvedPrefabRef`). */
export function isMissingPrefabPlaceholder(id: number): boolean {
  return !!unresolvedRefOf(findEntity(id) as Parameters<typeof unresolvedRefOf>[0]);
}

/** The `EntityAttributes` fields a SCENE placeholder's writers save from the live entity: the name, plus the placement
 *  both scene shapes carry (`PLACEHOLDER_PLACEMENT_FIELDS`, the one list; an entry, or since #1901 an added node inside
 *  an instance). The Hierarchy's rename, reparent, folder moves, reorder and Activate write exactly these. Derived, not
 *  restated, so a field the gate lets through is one the save keeps. */
export const PLACEHOLDER_WRITABLE_FIELDS: ReadonlySet<string> = new Set(['name', ...PLACEHOLDER_PLACEMENT_FIELDS]);

const NONE: ReadonlySet<string> = new Set();

/** The `EntityAttributes` fields the writer that saves placeholder `id` takes from its live entity — the gate's one
 *  question, asked of the writer rather than the entity's shape (#1901 close-out review):
 *  - a node the TEMPLATE declares (a keyed node, supplied by the prefab): none. It is the template's, and its frame's
 *    save states nothing of it, so a rename or a toggle there was dropped;
 *  - any other placeholder, an entry or a node the scene added: {@link PLACEHOLDER_WRITABLE_FIELDS}.
 *  ⚠️ A prefab-edit ROW placeholder is not asked yet: its writer keeps the name, and the parent only within the edited
 *  document, so an order, a flag or a move under a nested member there is still dropped (#1918). */
export function placeholderSavedFields(id: number): ReadonlySet<string> {
  if (isSuppliedByPrefab(id)) return NONE;
  return PLACEHOLDER_WRITABLE_FIELDS;
}

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

/** Why writing `traitName` (`field`, or the whole trait when omitted: an add or a remove) on entity `id` is refused,
 *  or null when it may go ahead. Refuses on a placeholder unless the writer that saves it keeps the field
 *  ({@link placeholderSavedFields}). */
export function placeholderWriteRefusal(id: number, traitName: string, field?: string): string | null {
  // A template node whose key its frame repeats (#1937 C-A step 4): no row can record the edit, so none is taken.
  if (!isMissingPrefabPlaceholder(id)) return repeatedTemplateKeyRefusal(id);
  if (traitName === 'EntityAttributes' && field !== undefined && placeholderSavedFields(id).has(field)) return null;
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
