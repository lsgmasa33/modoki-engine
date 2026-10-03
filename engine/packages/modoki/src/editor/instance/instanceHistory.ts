/**
 * Undo and redo of a list edit put back the EXACT records (#2001 S7, #2046; rule 8: "undo restores the exact list and
 * document, in memory"; design § 3.2's undo rows).
 *
 * A step holds the records it touched as they stood before and after, by root guid (`null`: no record, as for an
 * instance the step deleted or created), plus the scene-owned CONTENT the before side links: a node the step removed is
 * not live after it, and the record holds only its link (rule 7). Restoring a side seats those records fresh and
 * reprojects the instance tree from the store (`reprojectFromStore`). Nothing is re-derived from a template, a capture
 * or a mark (D-8a, D-8b).
 */
import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { dropInstanceRecord, freshInstanceRecord, setInstanceRecord } from '../../runtime/prefab/instanceStore';
import type { InstanceRecord, ParsedInstance } from '../../runtime/prefab/instanceRecord';
import { identitiesOf, ownContentOf, projectionRootOf, reprojectFromStore, type Reprojected } from './instanceReproject';
import type { MemberIdentity } from '../../runtime/prefab/serializeInstanceRecord';
import { allStoredRoots, guidOfEntity, storedRootsUnder } from './instanceKeys';
import { editorPrefabReader, recordForWrite, treeForWrite } from './instanceSync';
import { getCachedPrefabSync } from '../scene/prefabCache';
import { foldInstance } from '../../runtime/prefab/foldInstance';

/** The records of one side of a step, by root guid; `null` names a root with no record on that side. */
export interface RecordsSide {
  records: ReadonlyMap<string, InstanceRecord | null>;
  /** The scene-owned content of the instance tree on this side (`ownContentOf`), for a node the other side lacks. */
  content?: ReadonlyMap<string, ParsedInstance>;
  /** The identity the tree's members held on this side (`identitiesOf`), for a member the other side lacks (#2046 S7.4). */
  identity?: ReadonlyMap<string, MemberIdentity>;
}

const clone = (r: InstanceRecord | null | undefined): InstanceRecord | null => (r ? structuredClone(r) : null);

/** The fresh records `rootGuids` as they stand now (a missing or stale one as `null`), with the content of the tree at
 *  `entityId` when one is given. */
export function recordsSide(rootGuids: Iterable<string>, entityId?: number): RecordsSide {
  const world = getCurrentWorld();
  const records = new Map<string, InstanceRecord | null>();
  for (const g of rootGuids) records.set(g, clone(freshInstanceRecord(world, g)));
  const top = entityId !== undefined ? projectionRootOf(entityId) : 0;
  const content = top ? ownContentOf(top) ?? undefined : undefined;
  return { records, ...(content ? { content } : {}), identity: identitiesOf(records.keys()) };
}

/** Seat `side`'s records in the current world's store (a `null` drops that root's record), fresh, and reproject the
 *  instance tree at the outermost live root among them. `at`: the guid of a live root of that tree, when the records
 *  alone may name none that is live. Returns the reprojection, or null when nothing could be rebuilt. */
export function restoreSide(side: RecordsSide, at: string): Reprojected | null {
  const world = getCurrentWorld();
  const id = findEntityByGuid(at)?.id();
  if (!id) return null;
  // The tree's other records must be fresh too: re-seeded FIRST (a re-seed states the whole tree as it stands), so the
  // side's own records are seated over it, never under it.
  const top = projectionRootOf(id);
  if (!top || !recordForWrite(top, guidOfEntity(top), world)) return null;
  for (const [g, r] of side.records) {
    if (r) setInstanceRecord(world, clone(r)!);
    else dropInstanceRecord(world, g);
  }
  return reprojectFromStore(top, side.content, side.identity);
}

/** One tree's records on one side of a step (#2046 S7.3-4): `at` is the guid of its outermost projectable root. */
export interface TreeRecords { side: RecordsSide; at: string }

/** The records of the tree holding `entityId` now — re-seeded from the capture where stale, so fresh — with the scene-owned
 *  content they link; `also` names roots this side must state as absent when it does not hold them. Null when the store
 *  cannot hold the tree (a Missing Prefab above it, no live root). */
export function takeTreeRecords(entityId: number, also: Iterable<string> = []): TreeRecords | null {
  const top = projectionRootOf(entityId);
  const at = top ? guidOfEntity(top) : '';
  if (!top || !at || !treeForWrite(top)) return null;
  const side = recordsSide(new Set([top, ...storedRootsUnder(top)].map(guidOfEntity).filter(Boolean)), top);
  const records = new Map(side.records);
  for (const g of also) if (!records.has(g)) records.set(g, null);
  return { side: { ...side, records }, at };
}

/** {@link takeTreeRecords} for every live tree, by the guid of its outermost projectable root: what a step whose fan-out
 *  can reach any tree holds before it runs (an Apply, #2046 S7.3). A tree the store cannot hold is left out. */
export function takeEveryTree(): Map<string, TreeRecords> {
  const out = new Map<string, TreeRecords>();
  for (const r of allStoredRoots()) {
    if (projectionRootOf(r) !== r) continue;
    const t = takeTreeRecords(r);
    if (t) out.set(t.at, t);
  }
  return out;
}

/** Does the store hold a fresh record for every live tree? A tree under a Missing Prefab placeholder that states no
 *  projectable root is not one. A step restoring records reprojects trees from their own, which a stale one has not. */
export function storeStatesTheWorld(): boolean {
  const world = getCurrentWorld();
  return allStoredRoots().every((r) => !projectionRootOf(r) || !!freshInstanceRecord(world, guidOfEntity(r)));
}

/** Re-seed every live tree holding a stale record (`treeForWrite`) from its capture, so a step can work from records — the capture is what
 *  it read for that tree before. */
export function reseedEveryTree(): void {
  const world = getCurrentWorld();
  for (const r of allStoredRoots()) if (projectionRootOf(r) === r) treeForWrite(r, world);
}

/** Seat `side`'s records (a `null` drops one), fresh, WITHOUT reprojecting: for a step whose live tree is already what
 *  they state (a redo that repeated the forward's live edit). */
export function seatSide(side: RecordsSide): void {
  const world = getCurrentWorld();
  for (const [g, r] of side.records) {
    if (r) setInstanceRecord(world, clone(r)!);
    else dropInstanceRecord(world, g);
  }
}

/** Can `side` be restored exactly onto the current documents? Every record's prefab cached, and none holding a user's
 *  node the fold would not place (an `own` link left unused: {@link reprojectsExactly}'s case, hunt seed 7541). */
export function sideReprojects(side: RecordsSide): boolean {
  for (const r of side.records.values()) {
    if (!r) continue;
    if (!getCachedPrefabSync(r.source)) return false;
    if (foldInstance(editorPrefabReader, r).unused.some((u) => u.part.kind === 'own')) return false;
  }
  return true;
}
