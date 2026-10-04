/** The AUTHORED-world snapshot both editor envelopes revert to — full Play (`playMode.ts`) and the
 *  preview session (`timelinePreview.ts`) — and the ONE restore that puts it back (#1547).
 *
 *  They used to be two implementations of the same idea, and they drifted: Play/Stop gained the A5
 *  base-scene replay and the prefab-edit `currentSceneKey`, and the preview restore got neither. So
 *  a preview that posed a base-scene camera kept the pose after ⏹ Exit (SceneManager CARRIES a kept
 *  base across the reload instead of re-reading it), and ⏹ Exit inside prefab-edit reloaded under an
 *  empty path — dropping the editor out of prefab-edit so Cmd+S opened Save As. Both were fixed once,
 *  on the Play side, and re-broken on the other. One capture and one restore cannot drift.
 *
 *  What a snapshot covers, and how each part comes back:
 *   - the PRIMARY scene — reloaded wholesale from its serialization (`preloaded`, no disk read);
 *   - every BASE scene in the chain — replayed field-by-field onto the carried live entities by
 *     guid, because the reload keeps them rather than re-reading them (A5).
 *  A `Persistent` root is NOT carried: the restore runs outside Play (Stop sets `stopped` first; a
 *  preview is never `playing`), and SceneManager carries Persistent roots only in Play (#1863) — as
 *  Unity destroys DontDestroyOnLoad objects on leaving Play mode. So the snapshot's own copy comes
 *  back like any other entity. It used to be carried AND respawned: nothing dropped the snapshot's
 *  copy, and every Stop added one more (a filter meant to never matched a current-format root).
 *  Every trait field the snapshot holds is authored-only already (`serializeScene` skips
 *  `runtimeOnly`), so a replay can never regress runtime state such as `Time.elapsed`. */

import type { SceneData, SceneCopyCarry } from '../../runtime/loaders/loadSceneFile';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { PREFAB_EDIT_SCENE_PREFIX } from './prefabEditWorld';
import { serializeScene, getCurrentScenePath, type SceneFile, type SerializedEntity } from './serialize';
import { findEntityByGuid, onWorldSwap } from '../../runtime/core/ecs/world';
import { writeTraitField } from '../../runtime/core/ecs/entityUtils';
import { getAllTraits } from '../../runtime/core/ecs/traitRegistry';
import { soaSchema, isRuntimeOnlyField } from '../../runtime/core/ecs/traitSchema';
import { registerPosedWorldSource } from './authoredWorld';
import { registerUndoRestoreBarrier } from '../undo/undoManager';
import { withRestore } from './sceneAdoption';
import { replaceStoredInstances, setInstanceRecord, storedInstance, storedInstances, type StoredInstance } from '../../runtime/prefab/instanceStore';
import { markWorldUnsavable, rollBack, rollbackOnThrow, takeStore } from '../instance/instanceRollback';
import { bankInstanceRecords, dropRecordBank, cloneInstanceStore, steadyRecords, storedText } from '../../runtime/prefab/recordBank';
import { guidOfEntity, projectionRootOf } from '../instance/instanceKeys';
import { reprojectFromStore, reprojectsExactly } from '../instance/instanceReproject';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import type { SceneEntityEntry } from '../../runtime/loaders/loadSceneFile';

export interface AuthoredSnapshot {
  /** The primary scene's serialization — what the restore reloads. */
  primary: SceneFile;
  /** `currentSceneKey()` at capture: the path the restore reloads under, and what it is compared to. */
  key: string | null;
  /** Each base in the chain, by scene guid (A5). A base that failed to serialize is simply absent. */
  bases: Map<string, SceneFile>;
  /** The copies of missing prefabs the edit world held, and its live frames' documents (#1939 item 2): what the restore's
   *  swap carries, instead of the Play or preview world's, so nothing done inside the envelope changes what the edit world
   *  expands (Unity discards Play state). Absent: the restore carries none. */
  copies?: SceneCopyCarry;
  /** The authored world's instance records, cloned at capture (#2046 S7.6): banked for the restore's reload of `primary`,
   *  which takes back each exact list whose entry it reloads unchanged (`recordBank.ts`). */
  records?: Map<string, StoredInstance>;
}

/**
 * Which SCENE an authored snapshot belongs to, and the path its restore reloads it under.
 *
 * ⚠️ **Not `getCurrentScenePath()`, and the difference is the whole bug.** That is the editor's
 * *file* path, and prefab-edit deliberately sets it to **null** so a normal save cannot target a
 * real file. The Stop-revert therefore reloaded the world under `path ?? ''` — an empty path — so
 * after Play→Stop the live scene silently stopped being the prefab-edit world. Reported as: *"when
 * I press play, and stop, the prefab edit mode loses the prefab name, and cmd+s ends up the new
 * file dialog."* Both symptoms are that one empty string:
 *
 *  - the SceneView breadcrumb ground-truths on `sceneManager.getCurrent()?.path` starting with the
 *    prefab-edit prefix, so it stops showing the prefab;
 *  - `isEditingPrefab()` fails the same check and runs its self-heal, CLEARING `editingPrefab` —
 *    after which Cmd+S no longer routes to `savePrefabEdit()` and falls through to a scene save with
 *    a null path, i.e. the native "Save Scene As" panel.
 *
 * So the SYNTHETIC path has to round-trip, and only the live identity carries it. See the body for
 * why that preference is narrowed to the synthetic case rather than applied blanket. Both the
 * capture and the compare go through here, so they cannot disagree.
 */
export function currentSceneKey(): string | null {
  // ⚠️ Prefer the live path ONLY when it is the synthetic one. A blanket
  // `sceneManager.getCurrent()?.path ?? getCurrentScenePath()` looks equivalent and is not.
  // The original scar: `newScene()` used to wipe the ECS world and set `_currentScenePath`
  // WITHOUT touching sceneManager, so after an untitled new scene the live path was still the
  // PREVIOUS scene's — and preferring it made Stop reload the blank world under the old scene's
  // identity, impersonating a real file. Since #853 `newScene()` goes through
  // `sceneManager.replaceWorldContent()`, which clears `loadedScenes`, so `getCurrent()` is null
  // there and the fallback is reached honestly rather than by narrowing. The narrowing STAYS:
  // it is what fixes the prefab-edit case (the bug this exists for), and it is what keeps every
  // other divergence between the two — a Save As, the boot restore, the dev bridge — reading the
  // editor's own path rather than a stale live one.
  const live = sceneManager.getCurrent()?.path ?? null;
  return live?.startsWith(PREFAB_EDIT_SCENE_PREFIX) ? live : getCurrentScenePath();
}


/** Write each snapshot entry's AUTHORED fields back onto the matching LIVE entity
 *  (resolved by guid), skipping entities no longer present (a base's file/subtree
 *  changed shape between Play and Stop — rare, and a missing entity is simply not
 *  restored rather than an error). `entry.traits` already excludes `runtimeOnly`
 *  fields (serializeScene's own filter). PrefabInstance is skipped, and so are the
 *  STRUCTURAL fields of EntityAttributes (`ENTITY_STRUCTURE_FIELDS`) — identity/hierarchy
 *  fields don't drift at runtime the way gameplay-mutated fields do, and blindly
 *  replaying a snapshot's `parentId`/`sortOrder` could undo a LEGITIMATE structural
 *  edit made to the base while Play was running via the editor's own tools (not the
 *  game) — out of scope for what A5 exists to fix.
 *
 *  ⚠️ But NOT EntityAttributes wholesale (#1547 close-out review): `isActive` is the field a
 *  cutscene's activation track and a game both toggle most, and skipping the trait left a
 *  base entity (once, a carried Persistent HUD) hidden after ⏹ Exit / Stop — carried live into the next save.
 *
 *  A prefab-instance ROOT writes only `PrefabInstance` in `entry.traits` (Phase 6's
 *  serialize convention) — its actual authored field values (Transform, a custom
 *  trait like `Fish`) live in `entry.overrides[localId]`, keyed by the root's OWN
 *  localId. Resolved from the LIVE entity's current PrefabInstance.localId (stable
 *  across Play — reparenting/duplication during Play would be reverted structurally
 *  by the primary's own snapshot revert, not by this pass).
 *
 *  ⚠️ **A snapshot is SPARSE, so the replay fills the schema default back in** (#1547). The
 *  serializer omits every field still holding its trait default (`isFieldWritten` — it keeps
 *  defaults live on disk), so an authored `x: 0` is simply absent from `traits.Transform`. Replaying
 *  only the keys present therefore restored every posed field EXCEPT those whose authored value was
 *  the default: a base camera authored at x=0 and moved by a game kept its play-mode x after Stop,
 *  with the A5 replay "running" and doing nothing for it. So for a SoA trait the authored value is
 *  schema default ⊕ snapshot, key by key.
 *  - **`runtimeOnly` fields are skipped** — never authored, never in the snapshot, and filling their
 *    default would reset live runtime state (Time.elapsed) the replay must not touch.
 *  - **`entityId` fields are skipped** — the snapshot holds them as GUID STRINGS (the serializer
 *    guid-ifies them), and writing one back put a string into a numeric id field. Like `parentId`,
 *    a reference is structure, which this pass does not own.
 *  - **Prefab-root overrides stay a partial replay.** An override bag lists only the fields that
 *    differ from the PREFAB, not from the trait default, so filling defaults there would overwrite
 *    template values with the wrong baseline. A posed field that is NOT overridden is not restored
 *    by this pass — a known limit, as is a posed prefab CHILD (its overrides key by its own localId). */
/** EntityAttributes fields that are identity or hierarchy, not state — never replayed (see below). */
const ENTITY_STRUCTURE_FIELDS = new Set(['parentId', 'sortOrder', 'guid', 'sourceScene', 'editorFolder']);

function restoreAuthoredEntitiesUnmarked(entries: SerializedEntity[]): void {
  const allTraits = getAllTraits();
  const piMeta = allTraits.find((m) => m.name === 'PrefabInstance');
  for (const entry of entries) {
    const guid = entry.guid || (entry.traits.EntityAttributes && entry.traits.EntityAttributes !== true
      ? (entry.traits.EntityAttributes as Record<string, unknown>).guid as string | undefined
      : undefined);
    if (!guid) continue;
    const liveEntity = findEntityByGuid(guid);
    if (!liveEntity) continue;
    const liveId = liveEntity.id();

    let fieldsByTrait: Record<string, Record<string, unknown> | boolean> = entry.traits;
    // A plain entity's traits omit SCHEMA defaults, so a missing key means "the default". A prefab
    // entry's do not: what it omits comes from the TEMPLATE, which this pass cannot see — so it is
    // replayed only as far as it states. ⚠️ Keyed on `entry.prefab`, not on having overrides
    // (#1547 re-review): a prefab root with no root-level overrides still writes a bare
    // `EntityAttributes: { parentId }` (or `{ editorFolder }`), and schema-filling that blanked the
    // instance's name to '' and forced isActive on, on every Stop and every ⏹ Exit.
    const sparseAgainstSchema = !entry.prefab;
    const rootRow = entry.prefab ? (entry.members as Record<string, { traits?: Record<string, Record<string, unknown> | boolean> }> | undefined)?.['/']?.traits : undefined;
    if (rootRow) {
      // Scene v20 (#2001 S6): the root's records are its `"/"` row's, its placement the entry's own `EntityAttributes`.
      const placed = entry.traits.EntityAttributes, stated = rootRow.EntityAttributes;
      const ea = { ...(typeof placed === 'object' ? placed : {}), ...(typeof stated === 'object' ? stated : {}) };
      fieldsByTrait = { ...rootRow, ...(Object.keys(ea).length ? { EntityAttributes: ea } : {}) };
    } else if (entry.prefab && entry.overrides && piMeta && liveEntity.has(piMeta.trait)) {
      const localId = (liveEntity.get(piMeta.trait) as { localId?: number }).localId;
      fieldsByTrait = (localId != null ? entry.overrides[localId] : undefined) ?? {};
    }

    for (const [traitName, fields] of Object.entries(fieldsByTrait)) {
      if (traitName === 'PrefabInstance') continue;
      if (typeof fields !== 'object') continue; // a tag trait's presence doesn't drift at runtime
      const meta = allTraits.find((m) => m.name === traitName);
      if (!meta) continue;
      const schema = sparseAgainstSchema ? soaSchema(meta) : null;
      const keys = schema ? Object.keys(schema) : Object.keys(fields);
      for (const field of keys) {
        if (isRuntimeOnlyField(meta, field) || meta.fields[field]?.entityId) continue;
        if (traitName === 'EntityAttributes' && ENTITY_STRUCTURE_FIELDS.has(field)) continue;
        const value = Object.prototype.hasOwnProperty.call(fields, field) ? fields[field] : schema?.[field];
        writeTraitField(liveId, meta, field, value);
      }
    }
  }
}

/** Capture the authored world: the primary, then every base in the chain.
 *
 *  Snapshot only — NO `assignGuids`. Neither envelope may write authored data (the whole contract is
 *  that its exit discards every mutation made inside it); minted guids land in the snapshot JSON, not
 *  the live world. */
export async function captureAuthoredSnapshot(opts: { bases?: boolean } = {}): Promise<AuthoredSnapshot> {
  // Before the first await: a record an edit changes while the serializes below await is left out (`steadyRecords`).
  const recordsAt = cloneInstanceStore(getCurrentWorld());
  const primary = await serializeScene();
  const key = currentSceneKey();
  const bases = new Map<string, SceneFile>();
  for (const entry of sceneManager.getLoadedScenes().values()) {
    if (entry.role !== 'base' || opts.bases === false) continue;
    // Defensive per-base catch: if a base fails to serialize, skip ITS replay rather than refuse the
    // whole envelope (its authored state then just isn't restored). This used to fire routinely for a
    // base containing a prefab instance — Phase 12's A8/A9 safety guard — which is now gone, both
    // bugs being fixed; sling's Base.json snapshots normally. Kept for resilience, not for that guard.
    try {
      bases.set(entry.guid, await serializeScene({ scene: { path: entry.path, guid: entry.guid } }));
    } catch (e) {
      console.warn(`[Editor] A5 base snapshot skipped for "${entry.path}": ${(e as Error).message}`);
    }
  }
  return { primary, key, bases, copies: sceneManager.captureSceneCopies(undefined, primary.id), records: steadyRecords(recordsAt, getCurrentWorld()) };
}

/** Put the authored world back: reload the primary under the snapshot's key, then replay the part
 *  the reload carries rather than rebuilds — every base.
 *  The caller has already checked that the key still names the live scene. */
async function restoreAuthoredSnapshotUnmarked(snap: AuthoredSnapshot, signal?: AbortSignal): Promise<void> {
  // Counted from the FIRST synchronous line: Stop sets 'stopped' and calls this with no await between,
  // so the Play world is still live for the whole reload with the mode already reading 'stopped'.
  _restoring++;
  try {
    // The restore is the ADOPTER (#1698, hub): it reloads under the SAME key, so it writes no editor scene state, and an
    // older route whose world it replaced — a load still in its tail — adopts nothing.
    await withRestore(async (adoption) => {
      const bank = snap.records ? bankInstanceRecords(snap.key ?? '', snap.records, snap.primary.entities as unknown as SceneEntityEntry[]) : undefined;
      try {
        const { world } = await sceneManager.loadScene(snap.key ?? '', { preloaded: snap.primary as unknown as SceneData, sceneCopies: snap.copies ?? new Map(), signal });
        adoption.restored(world);
      } finally {
        // Taken by the load once it made its world; one that threw before that leaves it for no later load to take.
        if (bank) dropRecordBank(snap.key ?? '', bank);
      }
    });
    for (const base of snap.bases.values()) restoreAuthoredEntities(base.entities);
    seatBaseRecords(snap.records);
    _restoreFailed = false;
  } catch (e) {
    // A caller's abort lands before the swap (the trash's reload: an edit landed), so the world it leaves is the authored
    // one it started from — not a world that may still hold a pose.
    if (!signal?.aborted) _restoreFailed = true;
    throw e;
  } finally {
    _restoring--;
  }
}

/** Restores that have not finished — the old world (posed, or the Play world) is still live. */
let _restoring = 0;
/** Is ANY authored restore still landing — Stop's as well as a preview Exit's? Until it has, the live
 *  world is not the authored one, so nothing may snapshot it as authored (#1572). */
export function authoredRestoreInFlight(): boolean {
  return _restoring > 0;
}
/** The last restore THREW: the reload or a replay failed, so the live world may still hold the pose
 *  or the Play world while every other source reads clear — the envelope already ended, the counters
 *  already dropped (#1548 close-out review). Cleared by the next world swap (a load from disk, or a
 *  restore that gets as far as its swap) and by a restore that completes. */
let _restoreFailed = false;
/** Did the last restore FAIL, leaving a possibly-posed world live? An envelope must not OPEN on such a
 *  world (#1548 re-review): its snapshot would take the pose as "authored", and that envelope's own
 *  successful restore — a world swap — would then clear this flag and wave the pose through a save.
 *  `beginTimelinePreviewSession` and `enterPlay` refuse while it holds. */
export function lastRestoreFailed(): boolean {
  return _restoreFailed;
}
registerPosedWorldSource('a Play/preview restore is still landing', () => _restoring > 0);
registerUndoRestoreBarrier(() => _restoring > 0);
registerPosedWorldSource('the last Play/preview restore FAILED — reload the scene before saving', () => _restoreFailed);
onWorldSwap(() => { _restoreFailed = false; });

// #2046 S7.6 / #2001 S8b: the restore's reload takes back the authored world's exact records (banked above) or parses
// fresh ones from the snapshot, and the bases' carried records are seated back where the session changed them
// (`seatBaseRecords`), so a restore marks nothing. Before, it marked every record of the world it left stale first: a world
// on its way out, but the mark rode the carry onto every base record. One that throws rolls back (`instanceRollback.ts`).
export const restoreAuthoredSnapshot = rollbackOnThrow('stop', (snap: AuthoredSnapshot) => restoreAuthoredSnapshotUnmarked(snap));
/** The same reload, for a trashed prefab's live frames (#2056, `deletedPrefabsMissing.ts`): the world just captured is put
 *  back through the load, which makes every instance of a prefab that no longer resolves a Missing Prefab placeholder.
 *
 *  Not wrapped in `rollbackOnThrow` as Stop's is: a reload its caller ABORTS (an edit landed) keeps that world as the edit
 *  left it, which a rollback would take back (#2056 re-review). Any other throw rolls back (#2001 S8b: before, it marked
 *  every record stale). */
export async function reloadCapturedWorld(snap: AuthoredSnapshot, signal?: AbortSignal): Promise<void> {
  const taken = takeStore();
  try {
    await restoreAuthoredSnapshotUnmarked(snap, signal);
  } catch (e) {
    if (!signal?.aborted) rollBack(taken, 'trash', e);
    throw e;
  }
}

/** The base replay writes authored values onto a kept base's carried entities without the door. The records of the trees
 *  it writes are not marked (#2001 S8b): they state the authored world, which the session's posing never wrote, and one
 *  an edit changed during the session is seated back by {@link seatBaseRecords}. */
export function restoreAuthoredEntities(entries: SerializedEntity[]): void {
  restoreAuthoredEntitiesUnmarked(entries);
}

/** Seat back the record of every instance a kept base scene owns that differs from the snapshot's `records`, and rebuild
 *  its tree from it (#2001 S8b). The reload carries a base's entities and records across as they stood, and the replay
 *  puts back only the fields its entries state: a preview takes scene edits and drops them at its Exit, so a door write
 *  to a base instance during it left a record stating the dropped edit. Before, the replay marked every base record stale
 *  instead, and the next write re-seeded it from the live tree: the dropped edit's structure, and every field Play or the
 *  pose moved that the entries do not state, went into the record (and the next save). A root the snapshot has no record
 *  for (made during the session, or edited while the snapshot serialized: `steadyRecords`) keeps the one it has. A tree
 *  its seated records cannot rebuild exactly — one links a user's node that is neither placed, held nor live, or its
 *  prefab cannot be read — is REFUSED (#2141): its records go back to the ones it had, the tree is left as it was, the
 *  console names it, and the world is marked unsavable until a load replaces it (S8b's rule). Before, the records stayed
 *  seated with a warning, and the save wrote them: a node the session's rebuild held (its anchor member gone from the
 *  prefab) was linked by the seated record and held by none, so the save dropped it. A rebuild that THROWS puts the
 *  store back as it stood before that tree's seat, marks the world and rethrows. A Missing Prefab placeholder has no tree to rebuild: its record is
 *  seated back as it stood. No `records` (a snapshot built by
 *  hand): nothing to compare. An Apply's undo and redo that reload the scene seat a base's records the same way, from the
 *  store as it stood on that side (`applyPrefabUndo.ts`). True when it rebuilt any tree (by new ids). */
export function seatBaseRecords(records: ReadonlyMap<string, StoredInstance> | undefined): boolean {
  if (!records) return false;
  const world = getCurrentWorld();
  // Each tree's differing roots, by its outermost root's guid (a rebuild respawns its tree under new ids).
  const trees = new Map<string, string[]>();
  for (const g of baseStoredRoots()) {
    const was = records.get(g);
    if (!was || storedText(was) === storedText(storedInstance(world, g))) continue;
    const top = projectionRootOf(findEntityByGuid(g, world)!.id());
    // A Missing Prefab placeholder nested in a tree (no projection unit of its own; a root UNDER a placeholder is one, #2018,
    // and takes the tree path) has nothing to project: its record is all it states, so it is seated back as it stood, with
    // no rebuild to ask about (#2141 review: skipped, it kept the session's edit).
    if (!top) { setInstanceRecord(world, structuredClone(was.record)); continue; }
    const tg = guidOfEntity(top);
    trees.set(tg, [...(trees.get(tg) ?? []), g]);
  }
  let rebuilt = false;
  for (const [tg, roots] of trees) {
    const had = new Map(roots.map((g) => [g, storedInstance(world, g)!]));
    // The whole store as it stood before this tree's seat: a rebuild that throws part-way may have changed records beyond
    // the differing roots (a held node it seated, a record it dropped), so the throw puts all of it back (re-review H1).
    const storeBefore = new Map(storedInstances(world));
    const putBack = () => { for (const s of had.values()) setInstanceRecord(world, s.record); };
    for (const g of roots) setInstanceRecord(world, structuredClone(records.get(g)!.record));
    const top = findEntityByGuid(tg, world)?.id();
    const refused: { why?: string } = {};
    try {
      if (top !== undefined && !reprojectsExactly(top)) refused.why = 'a record links a node it does not hold, which a rebuild would lose';
      else if (top !== undefined && reprojectFromStore(top, undefined, undefined, { refused })) { rebuilt = true; continue; }
    } catch (e) {
      // A rebuild that threw part-way: the tree may be half-built, so no record states it — not the seated ones, not the
      // ones before. The store goes back, the throw is said, and the world is unsavable (a rollback that cannot finish,
      // `instanceRollback.ts` edge 4).
      replaceStoredInstances(world, storeBefore);
      markWorldUnsavable(world, NOT_RESTORED);
      console.error(`[Prefab] restore of instance ${tg} threw while rebuilding (${(e as Error)?.message ?? e}) — the scene cannot be saved until it is reopened`);
      throw e;
    }
    // `reprojectFromStore` refuses before it rebuilds anything, so the tree is still the one `had` states.
    putBack();
    console.error(`[Prefab] restore of instance ${tg} refused: ${refused.why ?? 'its root is gone'} — left as it was, and the scene cannot be saved until it is reopened`);
    markWorldUnsavable(world, NOT_RESTORED);
  }
  return rebuilt;
}

/** The world a restore could not put an instance back in ({@link seatBaseRecords}, #2141): no save may write it. */
export const NOT_RESTORED = 'an instance could not be restored from its records (the console names it) — reopen the scene before saving';

function baseStoredRoots(): string[] {
  return [...storedInstances(getCurrentWorld()).keys()].filter((g) => {
    const e = findEntityByGuid(g) as { get?: (t: unknown) => unknown } | undefined;
    const ea = getAllTraits().find((m) => m.name === 'EntityAttributes');
    return !!e && !!ea && !!(e.get?.(ea.trait) as { sourceScene?: string } | undefined)?.sourceScene;
  });
}
