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
import { dropInstanceRecord, storedRecord, replaceStoredInstances, setInstanceRecord, storedInstances } from '../../runtime/prefab/instanceStore';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { findEntity } from '../../runtime/core/ecs/entityUtils';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import type { InstanceRecord, ParsedInstance } from '../../runtime/prefab/instanceRecord';
import { identitiesOf, linksUnplacedNode, ownContentOf, projectionRootOf, reprojectFromStore, type Reprojected } from './instanceReproject';
import type { MemberIdentity } from '../../runtime/prefab/serializeInstanceRecord';
import { allStoredRoots, guidOfEntity, storedRootsAbove, storedRootsUnder } from './instanceKeys';
import { recordForWrite, treeForWrite } from './instanceSync';
import { getCachedPrefabSync } from '../scene/prefabCache';

/** The records of one side of a step, by root guid; `null` names a root with no record on that side. */
export interface RecordsSide {
  records: ReadonlyMap<string, InstanceRecord | null>;
  /** The scene-owned content of the instance tree on this side (`ownContentOf`), for a node the other side lacks. */
  content?: ReadonlyMap<string, ParsedInstance>;
  /** The identity the tree's members held on this side (`identitiesOf`), for a member the other side lacks (#2046 S7.4). */
  identity?: ReadonlyMap<string, MemberIdentity>;
}

const clone = (r: InstanceRecord | null | undefined): InstanceRecord | null => (r ? structuredClone(r) : null);

/** The records `rootGuids` as they stand now (a missing one as `null`), with the content of the tree at
 *  `entityId` when one is given. */
export function recordsSide(rootGuids: Iterable<string>, entityId?: number): RecordsSide {
  const world = getCurrentWorld();
  const records = new Map<string, InstanceRecord | null>();
  for (const g of rootGuids) records.set(g, clone(storedRecord(world, g)));
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
  // The tree's other records must be fresh too, so the side's own records are seated over records that state the tree:
  // the side or the store states every root of it (a Delete's undo respawns the deleted tree, whose roots then have no
  // record until the side seats them), or the top's record is fresh. Otherwise nothing is seated.
  const top = projectionRootOf(id);
  if (!top) return null;
  const stated = (g: string) => !!g && (!!side.records.get(g) || (!side.records.has(g) && !!storedRecord(world, g)));
  if (![top, ...storedRootsUnder(top)].every((r) => stated(guidOfEntity(r))) && !recordForWrite(top, guidOfEntity(top), world)) return null;
  for (const [g, r] of side.records) {
    if (r) setInstanceRecord(world, clone(r)!);
    else dropInstanceRecord(world, g);
  }
  return reprojectFromStore(top, side.content, side.identity);
}

/** One tree's records on one side of a step (#2046 S7.3-4): `at` is the guid of its outermost projectable root. */
export interface TreeRecords { side: RecordsSide; at: string }

/** The records of the tree holding `entityId` now — fresh, or null when one is missing or stale — with the scene-owned
 *  content they link; `also` names roots this side must state as absent when it does not hold them. Null when the store
 *  cannot hold the tree (a Missing Prefab above it, no live root). */
export function takeTreeRecords(entityId: number, also: Iterable<string> = []): TreeRecords | null {
  const top = projectionRootOf(entityId);
  const at = top ? guidOfEntity(top) : '';
  if (!top || !at || !treeForWrite(top)) return null;
  const side = recordsSide(linkedRecords(new Set([top, ...storedRootsUnder(top)].map(guidOfEntity).filter(Boolean))), top);
  const records = new Map(side.records);
  for (const g of also) if (!records.has(g)) records.set(g, null);
  return { side: { ...side, records }, at };
}

/** `rootGuids` and every root a record among them links by an `own` link that the store holds, transitively: a tree's
 *  records include those of the instances it links under an anchor the fold does not place (a HELD own link, #2021),
 *  which are not live and so read as no stored root, yet stay in the store for the anchor's return. */
function linkedRecords(rootGuids: ReadonlySet<string>): Set<string> {
  const world = getCurrentWorld();
  const out = new Set(rootGuids);
  const todo = [...rootGuids];
  for (let g = todo.pop(); g !== undefined; g = todo.pop()) {
    const rec = storedRecord(world, g);
    if (!rec) continue;
    for (const row of rec.list.rows.values()) {
      for (const o of row.own ?? []) {
        if (!o.guid || out.has(o.guid) || !storedInstances(world).has(o.guid)) continue;
        out.add(o.guid);
        todo.push(o.guid);
      }
    }
  }
  return out;
}

/** The records of every tree the subtree at `entityId` touches, as one side: the tree that holds it, or, when it lies in
 *  none, each tree under it (#2001 S8b: a Create Prefab of a plain tree swallows the instances in it). The subtree's own
 *  root is stated absent when it holds no record (a create's undo drops the one it made). Null when one of those trees
 *  cannot be had (a root that does not project and is no Missing Prefab placeholder), or in a world with no instance type. */
export function takeRecordsAround(entityId: number): RecordsSide | null {
  if (!getTraitByName('EntityAttributes') || !getTraitByName('PrefabInstance')) return null;
  const also = [guidOfEntity(entityId)];
  const under = storedRootsUnder(entityId);
  // A Missing Prefab placeholder in the subtree (the subtree's own root, or one under it: hunt seeds 9401, 8039) is a root
  // no tree projects: its record is taken as it stands, for the prefab's return. (The records it links by a held `own`
  // link are not: no op here changes them.) Any other root that does not project leaves the op without records.
  const held = under.filter((r) => !projectionRootOf(r));
  if (held.some((r) => !unresolvedRefOf(findEntity(r) as Parameters<typeof unresolvedRefOf>[0]))) return null;
  const tops = projectionRootOf(entityId) ? [entityId] : under.filter((r) => projectionRootOf(r) === r);
  const records = new Map<string, InstanceRecord | null>();
  const world = getCurrentWorld();
  for (const g of held.map(guidOfEntity)) {
    const fresh = storedRecord(world, g);
    if (!fresh) return null;
    records.set(g, clone(fresh));
  }
  for (const t of tops) {
    const got = takeTreeRecords(t);
    if (!got) return null;
    for (const [g, r] of got.side.records) records.set(g, r);
  }
  // A node in the subtree that holds a record but reads as no stored root (Create Prefab's serialize keys the scene-added
  // reference nodes it writes before the tag): its record too, exactly, or nothing can be put back.
  for (const g of liveGuidsIn(entityId)) {
    if (records.has(g) || !storedInstances(world).has(g)) continue;
    const fresh = storedRecord(world, g);
    if (!fresh) return null;
    records.set(g, clone(fresh));
  }
  // A stored root above it that no tree above reaches (a Missing Prefab placeholder, which `projectionRootOf` stops
  // under): the op changes it with the tree, so its record too (hunt seed 9344).
  for (const r of storedRootsAbove(entityId)) {
    const g = guidOfEntity(r);
    const fresh = g && !records.has(g) ? storedRecord(world, g) : undefined;
    if (fresh) records.set(g, clone(fresh));
  }
  for (const g of also) if (g && !records.has(g)) records.set(g, null);
  return { records };
}

/** The guid of every live entity in the subtree at `entityId`, itself included. */
function liveGuidsIn(entityId: number): string[] {
  const out: string[] = [];
  const ea = getTraitByName('EntityAttributes');
  if (!ea) return out;
  const parentOf = new Map<number, number>();
  const guidOf = new Map<number, string>();
  for (const e of getCurrentWorld().query(ea.trait)) {
    const a = e.get(ea.trait) as { parentId?: number; guid?: string };
    parentOf.set(e.id(), a.parentId ?? 0);
    if (a.guid) guidOf.set(e.id(), a.guid);
  }
  for (const [id, g] of guidOf) {
    for (let a = id, n = 0; a && n < 1024; a = parentOf.get(a) ?? 0, n++) if (a === entityId) { out.push(g); break; }
  }
  return out;
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

/** Does the store hold a record for every live tree? A tree under a Missing Prefab placeholder that states no
 *  projectable root is not one. A step restoring records reprojects trees from their own, which a missing one cannot. */
export function storeStatesTheWorld(): boolean {
  const world = getCurrentWorld();
  return allStoredRoots().every((r) => !projectionRootOf(r) || !!storedRecord(world, guidOfEntity(r)));
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

/** Every record of the current world as it stands, copied: the `before` of a step whose changes {@link changedSince}
 *  reads once it has run. */
export interface RecordsCopy { readonly records: ReadonlyMap<string, InstanceRecord> }

export function copyRecords(): RecordsCopy {
  const records = new Map<string, InstanceRecord>();
  for (const [g, s] of storedInstances(getCurrentWorld())) records.set(g, structuredClone(s.record));
  return { records };
}

/** A record's content, for telling a changed one from one left alone (a Map or Set as its entries, in order). */
const contentOf = (r: InstanceRecord): string =>
  JSON.stringify(r, (_k, v: unknown) => (v instanceof Map ? { m: [...v] } : v instanceof Set ? { s: [...v] } : v));

/** The records a step changed ({@link changedSince}): `before` and `after` by root guid (`null`: no record on that side). */
export interface ChangedRecords { before: RecordsSide; after: RecordsSide }

/**
 * What a step changed in the records since `before` ({@link copyRecords}, taken before its forward ran): both sides of
 * every root whose record it created, dropped or changed. For a step whose forward wrote its records through the door
 * but whose own undo and redo put the LIVE world back by other means (a snapshot respawn, a raw re-tag): each seats its
 * side around that live work ({@link seatBefore}, {@link seatAfter}), and every record the step did not change is left as
 * it stands.
 */
export function changedSince(before: RecordsCopy): ChangedRecords {
  const now = storedInstances(getCurrentWorld());
  const was = new Map<string, InstanceRecord | null>();
  const is = new Map<string, InstanceRecord | null>();
  for (const g of new Set([...before.records.keys(), ...now.keys()])) {
    const ra = before.records.get(g) ?? null;
    const rb = now.get(g)?.record ?? null;
    if (ra && rb && contentOf(ra) === contentOf(rb)) continue;
    was.set(g, clone(ra));
    is.set(g, clone(rb));
  }
  return { before: { records: was }, after: { records: is } };
}

/** Run a step's LIVE undo (`side` 'before') or redo ('after') with `changed`'s side seated around it: before it, since the
 *  live work reads the store (a frame rebase reprojects from it), and again after it, over whatever that work wrote. One
 *  that throws puts the records it seated back as they stood, so a refusal applies nothing (I19). */
export function seatAround(changed: ChangedRecords, side: 'before' | 'after', live: () => void): void {
  const world = getCurrentWorld();
  const keys = side === 'before' ? changed.before.records.keys() : changed.after.records.keys();
  const held = new Map([...keys].map((g) => { const v = storedInstances(world).get(g); return [g, v && { ...v, record: structuredClone(v.record) }] as const; }));
  const seat = () => (side === 'before' ? seatBefore(changed) : seatAfter(changed));
  seat();
  try { live(); } catch (err) {
    const all = new Map(storedInstances(world));
    for (const [g, v] of held) { if (v) all.set(g, v); else all.delete(g); }
    replaceStoredInstances(world, all);
    throw err;
  }
  seat();
}

/** Seat the records `changed` found (an undo's side). */
export function seatBefore(changed: ChangedRecords): void {
  seatSide(changed.before);
}

/** Seat the records `changed` left (a redo's side). */
export function seatAfter(changed: ChangedRecords): void {
  seatSide(changed.after);
}

/** Can `side` be restored exactly onto the current documents? Every record's prefab cached, and none linking a user's
 *  node a rebuild would lose ({@link linksUnplacedNode}, hunt seed 7541). */
export function sideReprojects(side: RecordsSide): boolean {
  for (const r of side.records.values()) {
    if (!r) continue;
    if (!getCachedPrefabSync(r.source) || linksUnplacedNode(r)) return false;
  }
  return true;
}
