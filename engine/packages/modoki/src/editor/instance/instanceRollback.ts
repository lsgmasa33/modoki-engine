/**
 * An op that THROWS part-way rolls back (#2001 S8b, hub decision A, task #11): every instance's records are put back as
 * they stood just before it, and each tree is rebuilt from them, so the scene is left as it was before the gesture
 * instead of half-applied. Before, the throw marked the records stale and the door re-seeded them from the capture at the
 * next write: the half-applied tree became the records' truth, and a save wrote it.
 *
 * The edges (hub, 2026-10-04):
 * 1. **Earlier unsaved edits stay.** The records taken are the ones the earlier edits left, and the scene's dirty state is
 *    not touched.
 * 2. **No undo entry.** The throw still propagates, so the gesture pushes none (and an undo/redo step's entry is dropped,
 *    as every throwing step's is, `undoManager.ts` `runStep`); the next undo lands on the gesture before it.
 * 3. **A file already written stays, and is named.** A prefab file the op wrote before it threw is not put back (its
 *    rollback could lose a race with whatever reads it next); the console error names it (`prefabWriteLog.ts`).
 * 4. **A rollback that cannot finish fails loud.** A tree that cannot be rebuilt, a root the records name that is not
 *    live, the restore itself throwing, or a scene load replacing the world (nothing is rebuilt in a world on its way
 *    out): the console error says so, and the world is marked UNSAVABLE (a posed-world source, `authoredWorld.ts`: every
 *    writer of the live world refuses) until a load replaces it. Nothing is marked stale, so nothing is re-seeded from
 *    what the op left. A world already REPLACED is not the op's any more: reported, and left as its load made it (a
 *    Stop whose own restore failed marks itself, `authoredSnapshot.ts`).
 *
 * Taken for the WHOLE store, not the trees an op names: an op can reach a tree it was not asked about (an Apply's
 * fan-out, a rename's refs). The rollback assumes no other gesture lands inside the op while it awaits, as every async op
 * here holds the world (an Apply, an undo step, an outside edit's reimport).
 */
import type { World } from 'koota';
import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { peekCurrentWorld } from '../../runtime/core/ecs/worldRegistry';
import { liveStoredRootGuids, replaceStoredInstances, storedInstances, storedRecord, type StoredInstance } from '../../runtime/prefab/instanceStore';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { findEntity } from '../../runtime/core/ecs/entityUtils';
import { durableGuid, isOwnedRoot, isStoredRoot } from '../../runtime/core/assetRefRules';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { registerPosedWorldSource } from '../scene/authoredWorld';
import { isSceneLoadSwapping } from '../scene/serialize';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { prefabWritesMark, prefabWritesSince } from '../scene/prefabWriteLog';
import { guidOfEntity, outermostStoredRoot, projectionRootOf, storedRootsAbove, storedRootsUnder } from './instanceKeys';
import { reprojectFromStore, reprojectsExactly } from './instanceReproject';

/** The store as an op found it: which record each root had (`entries`, the objects themselves: a record the op replaced
 *  or dropped goes back), a copy of each record the op may change in place (`copies`, with its stale mark: every one,
 *  or a door verb's trees), which of those had a live root, and the write log's point. */
export interface TakenStore {
  readonly world: World;
  readonly entries: ReadonlyMap<string, StoredInstance>;
  readonly copies: ReadonlyMap<string, StoredInstance>;
  readonly live: ReadonlySet<string>;
  readonly writes: number;
}

/** The current world's store, for {@link rollBack} should the op about to run throw. `trees`: entity ids whose instance
 *  trees are the only ones the op writes in place (a door verb's targets, the hub's "the tree's records"); each is
 *  copied whole, from its outermost stored root, and every other record kept as it is. Copying every record of a
 *  103-instance scene cost 0.42 ms, against a 1.5 ms field write that takes it about three times; one tree's, 0.1 ms. */
export function takeStore(trees?: readonly number[]): TakenStore {
  const world = getCurrentWorld();
  const entries = new Map(storedInstances(world));
  let scope: Iterable<string> = entries.keys();
  // An empty store has nothing to copy: no tree walk (a world with no instance pays nothing for the door's guard).
  if (trees && entries.size > 0) {
    const guids = new Set<string>();
    // From the outermost stored root above each, or the node itself when it is in no instance (the instances under it).
    for (const top of new Set(trees.map((id) => outermostStoredRoot(id) || id))) for (const r of storedRootsUnder(top)) guids.add(guidOfEntity(r));
    scope = guids;
  }
  const copies = new Map<string, StoredInstance>();
  for (const g of scope) { const s = entries.get(g); if (s) copies.set(g, structuredClone(s)); }
  return { world, entries, copies, live: new Set([...copies.keys()].filter((g) => findEntityByGuid(g, world))), writes: prefabWritesMark() };
}

const UNSAVABLE = 'an edit failed part-way and could not be rolled back — reopen the scene before saving';
/** The worlds marked unsavable, by the reason a save is refused with (each reason is one posed-world source). */
const unsavableBy = new Map<string, WeakSet<World>>();

/** Mark `world` unsavable until a load replaces it, the save saying `why`: a rollback that could not finish (edge 4), or
 *  a tree the save found with no record to write (`instanceSave.ts`). */
export function markWorldUnsavable(world: World | null, why: string): void {
  if (!world) return;
  let marked = unsavableBy.get(why);
  if (!marked) {
    const set = (marked = new WeakSet<World>());
    unsavableBy.set(why, set);
    registerPosedWorldSource(why, () => { const w = peekCurrentWorld(); return !!w && set.has(w); });
  }
  marked.add(world);
}
const markUnsavable = (world: World | null): void => markWorldUnsavable(world, UNSAVABLE);

/** A tree with no record (#2001 S8b): the save refuses it (`instanceSave.ts`), and a rebuild leaves it as it was
 *  (`prefabRebuild.ts`) — each marks the world, and this is what `whyWorldNotAuthored` says until a load replaces it. */
export const NO_RECORD_TO_WRITE = 'an instance has no record to write (the console names it) — reopen the scene before saving';

/** The instance in the tree at `rootId` that holds no record — a record-owning stored root in it, the root included —
 *  named for the console: `instance "X" (guid)`, with ` in instance "Y" (guid)` when it is not the root. undefined when every one holds
 *  its record. `orRoot` (the save's refusal): the root is asked whatever it is, and named when none is found — the save
 *  cannot write the tree for another reason then. */
export function recordlessInstanceIn(rootId: number, orRoot = false): string | undefined {
  const world = getCurrentWorld();
  const guid = guidOfEntity(rootId);
  const among = orRoot ? (guid ? [rootId, ...storedRootsUnder(rootId)] : [rootId]) : storedRootsUnder(rootId);
  const missing = among.find((id) => !storedRecord(world, guidOfEntity(id))) ?? (orRoot ? rootId : 0);
  if (!missing) return undefined;
  const nameOf = (id: number) => (findEntity(id)?.get(getTraitByName('EntityAttributes')!.trait) as { name?: string } | undefined)?.name ?? '?';
  const missingGuid = durableGuid(guidOfEntity(missing));
  const where = missing === rootId ? '' : ` in instance "${nameOf(rootId)}" (${durableGuid(guid) || `entity ${rootId}`})`;
  return `instance "${nameOf(missing)}" (${missingGuid || `entity ${missing}, no durable guid`})${where}`;
}

/** Is `world` (default: the current one) marked unsavable by a rollback that could not finish? */
export function isUnsavableAfterRollback(world: World | null = peekCurrentWorld()): boolean {
  return !!world && !!unsavableBy.get(UNSAVABLE)?.has(world);
}

/** The reason any mark above holds `world` (default: the current one) unsavable, or null. Play and a timeline preview
 *  refuse to open on such a world (#2141 review): their exit restores a NEW world, which no mark holds, from a snapshot
 *  that took the marked world as authored — one Play → Stop would clear the mark and let a save write what it guards. */
export function unsavableMarkOf(world: World | null = peekCurrentWorld()): string | null {
  if (!world) return null;
  for (const [why, marked] of unsavableBy) if (marked.has(world)) return why;
  return null;
}

/** Is `why` (a `whyWorldNotAuthored` answer) one of the marks above — a world no save may write until a load replaces it,
 *  which a retry or a Stop does not clear? The save answers it as `'unsavable'`, not as a run mode (#2001 S8b review L2). */
export function isUnsavableMark(why: string | null | undefined): boolean {
  return !!why && unsavableBy.has(why);
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Roll back op `by`, which threw `err`, to `taken` (see the header). Never throws: the caller rethrows `err`.
 */
export function rollBack(taken: TakenStore, by: string, err: unknown): void {
  const written = prefabWritesSince(taken.writes);
  const files = written.length ? ` The file${written.length > 1 ? 's' : ''} it wrote stay${written.length > 1 ? '' : 's'} as written: ${written.join(', ')}.` : '';
  const world = peekCurrentWorld();
  const fail = (why: string) => {
    console.error(`[instanceRollback] ${by} threw part-way (${message(err)}), and ${why}: the world is marked unsavable — reopen the scene.${files}`);
    markUnsavable(world);
  };
  // The world it started in replaced (a scene switch landed while it awaited): that world, and what the op did to it,
  // are gone, and the one on screen took its records from its own load. Reported, and nothing in it touched.
  if (world !== taken.world) {
    console.error(`[instanceRollback] ${by} threw part-way (${message(err)}) after the world it started in was replaced; the one on screen is left as its load made it.${files}`);
    return;
  }
  // A scene load is replacing this world (an Apply's undo that found one in flight left the world to it): its records go
  // back, and no tree is rebuilt in a world on its way out — marked unsavable, should the load not land.
  if (isSceneLoadSwapping() || sceneManager.getNext() !== null) {
    try { replaceStoredInstances(world, restored(taken)); } catch { /* reported below */ }
    return fail('a scene load is replacing the world, so no tree was rebuilt');
  }
  let left: string[];
  try { left = putBack(taken); } catch (e) { return fail(`the rollback threw too (${message(e)})`); }
  if (left.length) return fail(`the rollback could not rebuild ${left.join('; ')}`);
  console.error(`[instanceRollback] ${by} threw part-way (${message(err)}), so it was rolled back: every instance is as it stood before it.${files}`);
}

/** Put `taken`'s records back and rebuild every tree from them. Returns what it could not. */
function putBack(taken: TakenStore): string[] {
  const world = taken.world;
  replaceStoredInstances(world, restored(taken));
  // A stored root the op made, which no record states: a tree it spawned (a paste), or one it made out of the user's
  // entities (Create Prefab's tag of a plain tree). Neither can be put back without the op's own undo, and nothing here
  // deletes an entity on a guess at which it is (a rebuild respawns a tree under new ids, a tag renames its guids): it is
  // left, reported.
  const left: string[] = [];
  // A live stored root with no record: this op's (every op keeps its records, #2001 S8b, so none is left by an earlier one).
  const made = new Set(liveStoredRootGuids(world).filter((g) => !taken.entries.has(g)).map((g) => findEntityByGuid(g, world)!.id()));
  for (const id of made) if (!storedRootsAbove(id).some((a) => a !== id && made.has(a))) left.push(`"${guidOfEntity(id)}" (the op made it an instance; no record states it)`);
  // Every tree the op could change, from its records: it may have changed one without writing them (the throw came first).
  const units = new Set<string>();
  for (const g of taken.copies.keys()) { const e = findEntityByGuid(g, world); const u = e ? projectionRootOf(e.id()) : 0; if (u) units.add(guidOfEntity(u)); }
  for (const g of units) {
    const id = findEntityByGuid(g, world)?.id();
    // No record before the op: reported above (or spawned by it, and gone).
    if (id === undefined || !taken.entries.has(g)) continue;
    if (!reprojectsExactly(id)) { left.push(`"${g}" (a record links a node a rebuild would lose)`); continue; }
    if (!reprojectFromStore(id)) left.push(`"${g}" (its prefab cannot be read)`);
  }
  // A root the records name that the op took away and no rebuild brought back. A placeholder's is live as the
  // placeholder; a record whose root was not live before the op is not the op's. One that is live but no longer a stored
  // root — the op untagged it (Create Prefab's undo, Detach) before it threw — is no instance a rebuild above reached,
  // and its record states a tree that is not there (#2001 S8b review G2). Asked of the entity, stored or owned: a nested
  // record's root is OWNED once its enclosing prefab declares it (an Apply that wrote it, then threw), still an instance.
  const pi = getTraitByName('PrefabInstance')?.trait;
  const isRoot = (e: NonNullable<ReturnType<typeof findEntityByGuid>>) => {
    const p = pi && e.has(pi) ? e.get(pi) as Parameters<typeof isStoredRoot>[0] : undefined;
    return p ? isStoredRoot(p, e.id()) || isOwnedRoot(p, e.id()) : !!unresolvedRefOf(e);
  };
  for (const g of taken.live) {
    const e = findEntityByGuid(g, world);
    if (!e) left.push(`"${g}" (its root is gone)`);
    else if (!isRoot(e)) left.push(`"${g}" (its root is live but no longer an instance)`);
  }
  return left;
}

/** What `taken` puts back: each root's record as the op found it, a copy where the op may have changed it in place. */
function restored(taken: TakenStore): Map<string, StoredInstance> {
  return new Map([...taken.entries].map(([g, s]) => [g, taken.copies.get(g) ?? s]));
}

/** `fn`, rolled back to the store it found ({@link rollBack}) when it throws — returned, or settled when it is async. */
export function rollbackOnThrow<A extends unknown[], R>(by: string, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    const taken = takeStore();
    let out: R;
    try { out = fn(...args); } catch (err) { rollBack(taken, by, err); throw err; }
    if (out instanceof Promise) return out.catch((err: unknown) => { rollBack(taken, by, err); throw err; }) as R;
    return out;
  };
}
