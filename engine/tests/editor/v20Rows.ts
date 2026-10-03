/** Test helper (#2001 S6): what a scene v20 instance entry states for one member of its prefab, addressed the way the
 *  tests of the pre-model form addressed it: by the member's localId in the prefab document.
 *
 *  A v20 entry keeps its records in `members`, keyed by node identity: the root's on the `"/"` row, a member's on
 *  `/<nodeGuid>` (a pre-v5 document's row has none, and is keyed by `preV5NodeGuid`). This reads the SAVED entry, so an
 *  assertion through it still fails when the save stops writing the record. */
import { preV5NodeGuid } from '../../packages/modoki/src/runtime/loaders/frameChain';

type Bag = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Doc { id?: string; rootLocalId: number; entities: Array<{ localId: number; nodeGuid?: string }> }
interface Entry { prefab?: string; members?: Record<string, { traits?: Bag } & Bag> }

/** The row key of `doc`'s member `localId` in an instance of it (the top frame). */
export function rowKeyOf(doc: Doc, localId: number, source?: string): string {
  if (localId === doc.rootLocalId) return '/';
  const row = doc.entities.find((e) => e.localId === localId);
  return `/${row?.nodeGuid || preV5NodeGuid(doc.id || source || '', localId)}`;
}

/** The whole row the entry states for `doc`'s member `localId`, or undefined. */
export function rowOf(entry: Entry | undefined, doc: Doc, localId: number): ({ traits?: Bag } & Bag) | undefined {
  return entry?.members?.[rowKeyOf(doc, localId, entry.prefab)];
}

/** The trait records the entry states for `doc`'s member `localId` (the old `overrides[localId]`), or undefined. The root's
 *  `EntityAttributes.name` is left out: a v20 `"/"` row states it always, as a default override. */
export function recordsOf(entry: Entry | undefined, doc: Doc, localId: number): Bag | undefined {
  const traits = rowOf(entry, doc, localId)?.traits;
  if (!traits || localId !== doc.rootLocalId) return traits;
  const { EntityAttributes: ea, ...rest } = traits;
  const { name: _name, ...attrs } = (ea ?? {}) as Bag;
  const out = { ...rest, ...(Object.keys(attrs).length ? { EntityAttributes: attrs } : {}) };
  return Object.keys(out).length ? out : undefined;
}
