/**
 * `InstanceStore`: the per-world map from a stored instance root's guid to its `InstanceRecord` (#2001 S4, #2014).
 *
 * Rule 2 (docs/prefabs.md § High-level rules): an instance IS its prefab plus its list. This store holds the list.
 * Design: docs/plans/prefab-instance-model.md § 3.2 (the load row) and § 10.1 (S4: store + shadow).
 *
 * ── S4: a SHADOW ──
 * The loader parses every stored owner into the store, beside the old expansion, and the door (`editor/instance/
 * instanceEdits.ts`) writes each gesture's record here before it calls the old writers. NOTHING reads the store to build
 * or save an instance yet: the old path still loads, rebuilds and saves (S5 and S6 flip those). The readers are the
 * door itself (F2 needs "is there a record already"), the I25 shadow in the fuzzer and the save-time drift check.
 *
 * ── Stale records ──
 * The ops S7 and S8 move onto records (Revert, an undo/redo step that does not keep them (`undoManager.ts`
 * `keepsRecords`), Apply and its fan-out, paste/duplicate of an instance, delete-undo, Create Prefab/Replace, Detach,
 * the world swap, Stop, an outside edit) do not all maintain the list yet. Each one that does not MARKS the
 * records it may have changed stale, naming itself (`markStale`). A stale record says nothing: the door re-seeds it from
 * the old capture before writing to it (`editor/instance/instanceSync.ts`), and the shadow and the drift check skip it.
 * The list of ops that mark is closed and explicit, so a writer that is neither the door nor one of them is a BYPASS,
 * which the shadow and the drift check report rather than hide (review R3). S7 deletes each marker as its op moves on.
 *
 * Keyed per world (`WeakMap<World, …>`), like the loader's other per-world state (`identityParents.ts`): a prefab-edit
 * world and the scene world under it are separate stores, and a dropped world takes its store with it.
 */
import type { World } from 'koota';
import { getCurrentWorld } from '../core/ecs/world';
import { getTraitByName } from '../core/ecs/traitRegistry';
import { isStoredRoot } from '../core/assetRefRules';
import { templateKeyOf } from '../core/templateIdentity';
import { unresolvedRefOf } from '../core/unresolvedPrefabRef';
import { onGuidRemap } from '../core/ecs/guidRemap';
import type { InstanceRecord } from './instanceRecord';

/** One stored instance. `stale` names the op that left the record unmaintained, until a re-seed clears it. */
export interface StoredInstance {
  record: InstanceRecord;
  stale?: string;
}

const byWorld = new WeakMap<World, Map<string, StoredInstance>>();
/** Live stored roots an op that marks left WITHOUT a record (it created them without the door: a paste of an instance,
 *  a delete's undo, Create Prefab), by the op's name. The door's re-seed records them when it next writes their tree. */
const unrecordedByWorld = new WeakMap<World, Map<string, string>>();

function storeOf(world: World): Map<string, StoredInstance> {
  let s = byWorld.get(world);
  if (!s) byWorld.set(world, (s = new Map()));
  return s;
}

/** Put `rec` in `world`'s store under its root guid, fresh (not stale). A record with no root guid is not stored. */
export function setInstanceRecord(world: World, rec: InstanceRecord): void {
  if (!rec.rootGuid) return;
  storeOf(world).set(rec.rootGuid, { record: rec });
  unrecordedByWorld.get(world)?.delete(rec.rootGuid);
}

export function storedInstance(world: World, rootGuid: string): StoredInstance | undefined {
  return byWorld.get(world)?.get(rootGuid);
}

/** The record for `rootGuid`, or undefined when there is none OR it is stale: a stale record says nothing. */
export function freshInstanceRecord(world: World, rootGuid: string): InstanceRecord | undefined {
  const s = byWorld.get(world)?.get(rootGuid);
  return s && !s.stale ? s.record : undefined;
}

export function dropInstanceRecord(world: World, rootGuid: string): void {
  byWorld.get(world)?.delete(rootGuid);
}

/** Every stored instance of `world`, fresh and stale. */
export function storedInstances(world: World): ReadonlyMap<string, StoredInstance> {
  return storeOf(world);
}

/** Mark records stale because op `by` may have changed them without the door (see the header). `rootGuids` omitted:
 *  every record of the world. */
export function markStale(world: World, by: string, rootGuids?: Iterable<string>): void {
  const s = storeOf(world);
  if (!rootGuids) for (const v of s.values()) v.stale ??= by;
  else for (const g of rootGuids) { const v = s.get(g); if (v) v.stale ??= by; }
  // Any live stored root with no record now is one `by` created without the door (see `unrecordedByWorld`).
  let u = unrecordedByWorld.get(world);
  for (const g of liveStoredRootGuids(world)) {
    if (s.has(g)) continue;
    if (!u) unrecordedByWorld.set(world, (u = new Map()));
    if (!u.has(g)) u.set(g, by);
  }
}

/** The op that left live stored root `rootGuid` without a record (see `markStale`), or undefined. */
export function unrecordedBy(world: World, rootGuid: string): string | undefined {
  return unrecordedByWorld.get(world)?.get(rootGuid);
}

/** The guids of `world`'s live stored roots, the owners a record is kept for: a root no prefab row expanded (a scene
 *  entry, or a reference node the scene added) and a Missing Prefab placeholder of one. A template-added reference
 *  node's root is not one: its template supplies it, and its members key in the enclosing frame's record. */
function liveStoredRootGuids(world: World): string[] {
  const ea = getTraitByName('EntityAttributes')?.trait, pi = getTraitByName('PrefabInstance')?.trait;
  if (!ea) return [];
  const out: string[] = [];
  for (const e of world.entities) {
    const guid = (e.get(ea) as { guid?: string } | undefined)?.guid;
    if (!guid || templateKeyOf(e)) continue;
    const p = pi && e.has(pi) ? e.get(pi) as Parameters<typeof isStoredRoot>[0] : undefined;
    if (p ? isStoredRoot(p, e.id()) : unresolvedRefOf(e)) out.push(guid);
  }
  return out;
}

/** `fn`, marking every record of the current world stale (`by`) before it starts and once it has finished — returned,
 *  thrown or settled. For the ops S7 moves onto records (see the header): wrapped at their export, so no return path can
 *  skip the mark. Before, because a rebase inside the op reads the store (#2046 S7.3) and must not reproject from a
 *  record the op is leaving behind; after, in the world current at the END, since an op can swap it (an Apply undo, a
 *  reload). */
export function staleAround<A extends unknown[], R>(by: string, fn: (...args: A) => R): (...args: A) => R {
  return staleAroundUnless(by, fn, () => false);
}

/** {@link staleAround}, except that a finished op whose result `kept(out)` says the world it ends in holds the records it
 *  must is not marked after: a reload of a world the editor held, whose load took back the exact lists (#2046 S7.6,
 *  `recordBank.ts`) or parsed fresh ones from the text it loaded. A throw still marks. */
export function staleAroundUnless<A extends unknown[], R>(by: string, fn: (...args: A) => R, kept: (out: Awaited<R>) => boolean): (...args: A) => R {
  return (...args: A): R => {
    let out: R;
    markStale(getCurrentWorld(), by);
    try { out = fn(...args); } catch (err) { markStale(getCurrentWorld(), by); throw err; }
    if (out instanceof Promise) {
      return out.then((v: Awaited<R>) => { if (!kept(v)) markStale(getCurrentWorld(), by); return v; },
        (err: unknown) => { markStale(getCurrentWorld(), by); throw err; }) as R;
    }
    if (!kept(out as Awaited<R>)) markStale(getCurrentWorld(), by);
    return out;
  };
}

// A rename (`applyGuidRemap`) re-points every live ref to a renamed entity, and no record value: a record naming one — a
// field value referring to the node, a pin, a link, its own root guid — no longer states what it did, so it goes stale
// (#2046 S7 close-out review). Create Prefab's renames reach refs in OTHER trees, whose records S7.5 no longer marks.
onGuidRemap('instanceStore', (remap, world) => {
  const named: string[] = [];
  for (const [g, s] of storeOf(world)) {
    if (s.stale) continue;
    const text = JSON.stringify(s.record, (_k, v: unknown) => v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v);
    for (const from of remap.keys()) if (text.includes(from)) { named.push(g); break; }
  }
  if (named.length) markStale(world, 'guidRemap', named);
});
