/** The Inspector's "Missing component" rows (#1944, #1938 F-CB3's UI half) — what to show and whether Remove may run.
 *
 *  A component whose trait this build does not register is kept for its entity, verbatim, and written back on every save
 *  (`runtime/core/ecs/missingComponents.ts`). Without a row it was invisible: the entity carried data nobody could see.
 *  Unity shows such a component as "Missing (Mono Script)" and lets the user remove it, the one deliberate act that drops
 *  the data; this is that row.
 *
 *  Decisions only, kept out of `Inspector.tsx` so they carry a unit test without mounting a panel (docs/editor.md
 *  § Panels). The source is injected so the test can state an entity's bag and instance membership directly. */

import { findEntityById } from '../../runtime/core/ecs/world';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { missingComponentsFor } from '../../runtime/core/ecs/missingComponents';
import { instanceTargetOf } from '../instance/instanceKeys';

export interface MissingComponentRow {
  /** The trait name the file uses, which this build registers nothing for. */
  name: string;
  /** Why Remove would be refused on this selection, or null when it may run. */
  removeRefusal: string | null;
}

/** What the decisions read about a live entity. */
export interface MissingComponentSource {
  /** The missing components the next save writes back for entity `id` (`missingComponentsFor`), or undefined. */
  bagOf(id: number): Readonly<Record<string, unknown>> | undefined;
  /** Is `id` a TEMPLATE member of a prefab instance — a keyed node whose data the prefab file holds? */
  isTemplateMember(id: number): boolean;
}

/** Shown on every row: a reader who sees it for the first time needs to know nothing is lost by leaving it. */
export const MISSING_COMPONENT_HELP =
  'This build registers no trait with this name — renamed or deleted, or its game code did not load. Its data is kept '
  + 'as the file has it and written back on every save. Remove drops it from the entity (undoable).';

/** Remove on a template member is refused: the component is in the PREFAB file, which a scene save does not write, so
 *  the row would come back on the next load. Prefab Mode edits that file. A scene-added node, an instance root and an
 *  ordinary entity are the scene's own, and their removal reaches the file the save writes. */
export const MISSING_REMOVE_ON_TEMPLATE_MEMBER =
  'part of a prefab instance — this component comes from the prefab, so remove it in Prefab Mode';

/** The rows for a selection: each missing component EVERY selected entity carries, by name. A name only some carry is
 *  left out, as the Inspector leaves out a trait only some carry. Empty for an empty selection. */
export function missingComponentRows(ids: readonly number[], src: MissingComponentSource): MissingComponentRow[] {
  if (!ids.length) return [];
  const bags = ids.map((id) => src.bagOf(id));
  if (bags.some((b) => !b)) return [];
  const shared = Object.keys(bags[0]!).filter((name) => bags.every((b) => Object.hasOwn(b!, name))).sort();
  const refusal = missingRemoveRefusal(ids, src);
  return shared.map((name) => ({ name, removeRefusal: refusal }));
}

/** Why removing a missing component from `ids` would not stick, or null. */
export function missingRemoveRefusal(ids: readonly number[], src: Pick<MissingComponentSource, 'isTemplateMember'>): string | null {
  return ids.some((id) => src.isTemplateMember(id)) ? MISSING_REMOVE_ON_TEMPLATE_MEMBER : null;
}

/** A stable key for a row list, so the Inspector's per-frame read re-renders only when the rows changed. */
export function missingRowsKey(rows: readonly MissingComponentRow[]): string {
  return rows.map((r) => `${r.name}:${r.removeRefusal ?? ''}`).join('|');
}

/** The live entity `id`'s guid, or ''. */
function guidOf(id: number): string {
  const ea = getTraitByName('EntityAttributes');
  const e = findEntityById(id);
  return ea && e?.has(ea.trait) ? String((e.get(ea.trait) as { guid?: unknown }).guid ?? '') : '';
}

/** The live editor world as a {@link MissingComponentSource}. */
export const liveMissingSource: MissingComponentSource = {
  bagOf: (id) => missingComponentsFor(guidOf(id), id),
  // An instance ROOT is keyed too, but its extra components are the scene entry's own `traits` (serialize.ts writes them
  // back there, #1933 close-out review #10), so the scene save is the writer that drops them: not a template member here.
  isTemplateMember: (id) => { const t = instanceTargetOf(id); return t?.kind === 'member' && t.rootId !== id; },
};
