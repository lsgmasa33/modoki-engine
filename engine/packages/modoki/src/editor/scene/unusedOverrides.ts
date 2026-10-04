/** How many UNUSED overrides an instance keeps (#1914 R5, owner ruling F6): the records the load could not apply and every
 *  save writes back (docs/prefabs.md § I18), which the Apply/Revert dialog states as a count. Unity lists them in the
 *  Overrides drop-down with a Remove; Modoki's is the dialog's Remove Unused (#2001 S9, `instanceEdits.removeUnused`), which
 *  takes exactly the {@link removableUnused} part of what is counted here.
 *
 *  One record is one statement a writer made: a field, a component added with no fields, a component removal (or
 *  restore), a member removal, an added node, a re-parent, a legacy move. A row's `guid` and `name` are identity, not
 *  overrides (Unity's file has no such entry), so a row holding only them counts nothing.
 *
 *  What is counted is read off the instance's record (#2001 S8b): each record its fold reports unused (a target gone, a
 *  field nothing persists, a component nothing registers; not one waiting on a missing prefab, which applies once it
 *  returns, and not a held user node, which is scene content), less what a member the instance removed states besides
 *  its removal; and each value no reader takes that the record holds (`held.unparsed`, a keyed node's too).
 */

import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { readTraitData } from '../../runtime/core/ecs/entityUtils';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { durableGuid } from '../../runtime/core/assetRefRules';
import { storedRecord } from '../../runtime/prefab/instanceStore';
import { foldInstance } from '../../runtime/prefab/foldInstance';
import { HELD_REMAINDER, type InstanceRecord, type UnusedCause, type UnusedRecord } from '../../runtime/prefab/instanceRecord';
import { editorPrefabReader } from '../instance/instanceSync';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The causes a count states: a record whose target is gone, a field nothing persists, a component nothing registers.
 *  Not one waiting on a missing prefab (it applies once that returns), and not a held user node (scene content). */
const COUNTED: ReadonlySet<UnusedCause> = new Set(['gone', 'unknownField', 'unregistered']);

/** Values no reader takes in a held `unparsed` tree: each leaf one. */
function heldValues(held: unknown): number {
  if (!isRecord(held)) return held === undefined ? 0 : 1;
  let n = 0;
  for (const v of Object.values(held)) n += heldValues(v);
  return n;
}

/** The causes Remove Unused takes (plan § 10.4, hub 2026-10-02, #2007): a record whose target is gone, a field nothing
 *  persists — Unity's Remove Unused Overrides takes a modification whose target object or property path is gone. Not a
 *  component nothing registers: that is Remove Missing's (#1944), and the record applies once the component returns. */
const REMOVABLE: ReadonlySet<UnusedCause> = new Set(['gone', 'unknownField']);

/** The fold's unused records `rec` COUNTS (the module doc says which). A member the instance removed takes its records with
 *  it: what its row (or a nested frame under it) states besides the removal is not counted. A removal that is ITSELF unused
 *  (its member gone from the template) takes nothing: it and every record under it are counted, one each, as Unity counts
 *  a removed object's override and its modifications once the target is gone (#2001 S9 close-out review 2; before, the
 *  removal hid itself too, so the file kept it forever, uncounted and unremovable). */
function countedRecords(rec: InstanceRecord): UnusedRecord[] {
  const unused = foldInstance(editorPrefabReader, rec).unused;
  const unusedRemoval = new Set(unused.filter((u) => u.part.kind === 'removed').map((u) => u.key));
  const removed = [...rec.list.rows].filter(([k, row]) => row.removed === true && !unusedRemoval.has(k)).map(([k]) => k as string);
  const underRemoved = (key: string) => removed.some((r) => key === r || key.startsWith(`${r}/`));
  return unused.filter((u) => COUNTED.has(u.cause) && !underRemoved(u.key));
}

/** The unused overrides record `rec` keeps (the module doc says what one is). */
export function recordUnusedOverrides(rec: InstanceRecord): number {
  let n = countedRecords(rec).length;
  n += heldValues(rec.held.unparsed);
  for (const h of rec.held.keyedNodeHeld?.values() ?? []) n += heldValues(h.unparsed);
  return n;
}

/** The value at `path` in a held tree, or undefined. */
function heldAt(root: unknown, path: readonly string[]): unknown {
  let v = root;
  for (const step of path) v = isRecord(v) || Array.isArray(v) ? (v as Record<string, unknown>)[step] : undefined;
  return v;
}

/** What Remove Unused takes off `rec` (#2001 S9): each counted record whose cause is {@link REMOVABLE}. The rest of the
 *  count stays: a component nothing registers, and a value no reader takes (`held.unparsed`, kept as the file wrote it).
 *
 *  A held WHOLE list (an `added` with no `heldRemainder` marker) is one statement: it says which nodes the row's list is,
 *  so taking one element out would make the rest say something the user never did (a template node read as removed once
 *  the member returns). Its elements go all together or not at all (#2001 S9 close-out review H1). A remainder converts
 *  element by element, so its elements go one by one. */
export function removableUnused(rec: InstanceRecord): UnusedRecord[] {
  const taken = countedRecords(rec).filter((u) => REMOVABLE.has(u.cause));
  const pending = rec.held.pendingLegacy;
  const byList = new Map<string, number>();
  const listOf = (u: UnusedRecord): string[] | null => {
    if (u.part.kind !== 'legacy') return null;
    const p = u.part.path;
    return p.length >= 2 && p[p.length - 2] === 'added' && /^\d+$/.test(p[p.length - 1]!) ? p.slice(0, -1) : null;
  };
  for (const u of taken) { const l = listOf(u); if (l) byList.set(l.join('\u0000'), (byList.get(l.join('\u0000')) ?? 0) + 1); }
  return taken.filter((u) => {
    const l = listOf(u);
    if (!l) return true;
    const container = heldAt(pending, l.slice(0, -1));
    const list = heldAt(pending, l);
    if (isRecord(container) && container[HELD_REMAINDER]) return true;
    return Array.isArray(list) && byList.get(l.join('\u0000')) === list.length;
  });
}

/** The stored record of instance root `rootId`, by its durable guid; undefined for a root with none. */
function rootRecord(rootId: number): InstanceRecord | undefined {
  const ea = getTraitByName('EntityAttributes');
  const rootGuid = ea ? durableGuid((readTraitData(rootId, ea) as { guid?: string } | null)?.guid) : '';
  return rootGuid ? storedRecord(getCurrentWorld(), rootGuid) : undefined;
}

/** The unused overrides instance root `rootId` keeps: its record's. 0 for a root with no record. */
export function instanceUnusedOverrides(rootId: number): number {
  const rec = rootRecord(rootId);
  return rec ? recordUnusedOverrides(rec) : 0;
}

/** How many of them Remove Unused would take ({@link removableUnused}). 0 for a root with no record. */
export function instanceRemovableUnused(rootId: number): number {
  const rec = rootRecord(rootId);
  return rec ? removableUnused(rec).length : 0;
}
