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
 *     guid, because the reload keeps them rather than re-reading them (A5);
 *   - `Persistent` roots of the primary and their subtrees — the same replay, for the same reason:
 *     the reload carries the LIVE root and `filterPersistentDuplicates` drops the snapshot's own
 *     authored copy of it, so without the replay a posed/played Persistent entity kept its value.
 *  Every trait field the snapshot holds is authored-only already (`serializeScene` skips
 *  `runtimeOnly`), so a replay can never regress runtime state such as `Time.elapsed`. */

import type { SceneData } from '../../runtime/loaders/loadSceneFile';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { PREFAB_EDIT_SCENE_PREFIX } from './prefabEditWorld';
import { serializeScene, getCurrentScenePath, type SceneFile, type SerializedEntity } from './serialize';
import { findEntityByGuid, onWorldSwap } from '../../runtime/core/ecs/world';
import { writeTraitField } from '../../runtime/core/ecs/entityUtils';
import { getAllTraits } from '../../runtime/core/ecs/traitRegistry';
import { soaSchema, isRuntimeOnlyField } from '../../runtime/core/ecs/traitSchema';
import { registerPosedWorldSource } from './authoredWorld';
import { registerUndoRestoreBarrier } from '../undo/undoManager';

export interface AuthoredSnapshot {
  /** The primary scene's serialization — what the restore reloads. */
  primary: SceneFile;
  /** `currentSceneKey()` at capture: the path the restore reloads under, and what it is compared to. */
  key: string | null;
  /** Each base in the chain, by scene guid (A5). A base that failed to serialize is simply absent. */
  bases: Map<string, SceneFile>;
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
 *  Persistent HUD or a base entity hidden after ⏹ Exit / Stop — carried live into the next save.
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

export function restoreAuthoredEntities(entries: SerializedEntity[]): void {
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
    if (entry.prefab && entry.overrides && piMeta && liveEntity.has(piMeta.trait)) {
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
export async function captureAuthoredSnapshot(): Promise<AuthoredSnapshot> {
  const primary = await serializeScene();
  const key = currentSceneKey();
  const bases = new Map<string, SceneFile>();
  for (const entry of sceneManager.getLoadedScenes().values()) {
    if (entry.role !== 'base') continue;
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
  return { primary, key, bases };
}

/** The primary's `Persistent` roots and everything under them, as snapshot entries — the part of the
 *  primary the reload CARRIES instead of respawning. Parent links in a snapshot are guids. */
export function persistentSubtreeEntries(entries: SerializedEntity[]): SerializedEntity[] {
  const attrs = (e: SerializedEntity) => (e.traits.EntityAttributes && e.traits.EntityAttributes !== true
    ? e.traits.EntityAttributes as Record<string, unknown> : undefined);
  const guidOf = (e: SerializedEntity) => e.guid || (attrs(e)?.guid as string | undefined) || '';
  const inSubtree = new Set<string>();
  for (const e of entries) if ('Persistent' in e.traits && guidOf(e)) inSubtree.add(guidOf(e));
  if (inSubtree.size === 0) return [];
  // Fixed point rather than one pass: nothing promises parents precede children in the list.
  for (let grew = true; grew;) {
    grew = false;
    for (const e of entries) {
      const g = guidOf(e);
      const parent = attrs(e)?.parentId;
      if (g && !inSubtree.has(g) && typeof parent === 'string' && inSubtree.has(parent)) { inSubtree.add(g); grew = true; }
    }
  }
  return entries.filter((e) => inSubtree.has(guidOf(e)));
}

/** Put the authored world back: reload the primary under the snapshot's key, then replay the parts
 *  the reload carries rather than rebuilds — every base, and the primary's `Persistent` subtrees.
 *  The caller has already checked that the key still names the live scene. */
export async function restoreAuthoredSnapshot(snap: AuthoredSnapshot): Promise<void> {
  // Counted from the FIRST synchronous line: Stop sets 'stopped' and calls this with no await between,
  // so the Play world is still live for the whole reload with the mode already reading 'stopped'.
  _restoring++;
  try {
    await sceneManager.loadScene(snap.key ?? '', { preloaded: snap.primary as unknown as SceneData });
    for (const base of snap.bases.values()) restoreAuthoredEntities(base.entities);
    restoreAuthoredEntities(persistentSubtreeEntries(snap.primary.entities));
    _restoreFailed = false;
  } catch (e) {
    _restoreFailed = true;
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
