/** How many UNUSED overrides an instance keeps (#1914 R5, owner ruling F6): the records the load could not apply and every
 *  save writes back (docs/prefabs.md § I18), which the Apply/Revert dialog states as a read-only count. Unity lists them
 *  in the Overrides drop-down with a Remove; Modoki's Remove is later work, so nothing here acts on them.
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
import type { InstanceRecord, UnusedCause } from '../../runtime/prefab/instanceRecord';
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

/** The unused overrides record `rec` keeps (the module doc says what one is). A member the instance removed takes its
 *  records with it: what its row (or a nested frame under it) states besides the removal is not counted. */
export function recordUnusedOverrides(rec: InstanceRecord): number {
  const removed = [...rec.list.rows].filter(([, row]) => row.removed === true).map(([k]) => k as string);
  const underRemoved = (key: string) => removed.some((r) => key === r || key.startsWith(`${r}/`));
  let n = foldInstance(editorPrefabReader, rec).unused.filter((u) => COUNTED.has(u.cause) && !underRemoved(u.key)).length;
  n += heldValues(rec.held.unparsed);
  for (const h of rec.held.keyedNodeHeld?.values() ?? []) n += heldValues(h.unparsed);
  return n;
}

/** The unused overrides instance root `rootId` keeps: its record's. 0 for a root with no record. */
export function instanceUnusedOverrides(rootId: number): number {
  const ea = getTraitByName('EntityAttributes');
  const rootGuid = ea ? durableGuid((readTraitData(rootId, ea) as { guid?: string } | null)?.guid) : '';
  const rec = rootGuid ? storedRecord(getCurrentWorld(), rootGuid) : undefined;
  return rec ? recordUnusedOverrides(rec) : 0;
}
