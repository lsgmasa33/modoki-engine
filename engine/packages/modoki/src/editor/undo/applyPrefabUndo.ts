/** Undo/redo for "Apply to Prefab".
 *
 *  Apply mutates TWO things, not one:
 *   1. the prefab FILE — the shared base every instance inherits from; and
 *   2. the live SCENE — every instance is re-instantiated (its override relationship
 *      to the base changes), and a promoted "added" child is deleted from the scene.
 *
 *  So a value-only "swap the prefab base back" undo is WRONG: after applying field V,
 *  the instance you edited now MATCHES the new base, while other instances that merely
 *  inherited it also show V. Reverting the base alone can't tell them apart — the
 *  edited instance must return to an *override* V while the inheritors return to the
 *  old base. The only record that distinguishes them is the pre-apply scene state.
 *
 *  Therefore undo is "record before/after of BOTH, reverse it": snapshot the prefab
 *  document and the serialized scene before and after, and restore by putting the prefab
 *  document back IN MEMORY and rebuilding the scene from its snapshot (which re-instantiates
 *  every instance exactly, preserving each one's overrides). The forward Apply writes the file,
 *  as Unity's does; its undo and redo write nothing (#1868, D1 = Park): the restored document is
 *  parked, and Save writes it. Neither ever saves the scene.
 *
 *  The snapshot is reloaded under the key of the world the undo belongs to when it RUNS: the scene's
 *  path; the prefab editor's synthetic path, since that world has no scene file (#1573); or '' for an
 *  untitled scene, as Stop reloads one (#1575). Same reason, same rule in each: a rebase alone is not a
 *  substitute, and neither is a rebuild from the prefab's document. */

import { pushAction, beginWorldBoundOperation, isWorldSwitchInProgress, type UndoAction } from './undoManager';
import { reportUndoFailure } from './undoFailure';
import { restorePrefabsInMemory } from '../scene/prefabMemoryRestore';
import { sceneManager } from '../../runtime/scene/SceneManager';
import type { SceneData } from '../../runtime/loaders/loadSceneFile';
import { serializeScene, isSceneLoadSwapping } from '../scene/serialize';
import { withAdoption, adoptionsSettled, captureAdoption } from '../scene/sceneAdoption';
import { guidForEntityId, entityIdForGuid, resolveInstanceContext, type PrefabFile } from '../scene/prefab';
import { getPrefabSource, preloadNestedPrefabsForSubtree } from '../scene/prefabCache';
import { captureInstanceOverrides } from '../scene/prefabInstanceOverrides';
import { captureInstanceStructure } from '../scene/prefabCapture';
import {
  rebuildInstanceFromCapture, refreshBaseInstances, rebaseStaleInstances, captureNestedFrames,
  type NestedInstanceCapture,
} from '../scene/prefabRebuild';
import { applyToPrefabSelective, type ApplyResult } from '../scene/prefabApply';
import type { ApplyTargets } from '../scene/prefabApplyTargets';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { useEditorStore } from '../store/editorStore';
import { resolveAffectedScenes } from '../scene/sceneDirty';
import { ensureGuid } from './entityRef';
import { captureEntityIdentity } from '../../runtime/core/ecs/entityUtils';
import { PREFAB_EDIT_SCENE_PREFIX } from '../scene/prefabEditWorld';
import { currentSceneKey } from '../scene/authoredSnapshot';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Restore one side of an Apply (#1868, owner ruling D1 = Park): every prefab it wrote goes back IN MEMORY — both caches,
 *  and parked for Save, which writes it (`restorePrefabsInMemory`) — and the live world is rebuilt from the scene
 *  snapshot of that side (runtime loadScene — no history clear). Nothing is written and no scene is saved: Unity's Apply
 *  never saves the scene either, and the undo dirties it as every undo does. Re-selects the previously-inspected entity
 *  by guid (ids change on rebuild). Resolves `false` when the world it belongs to is no longer live, having restored the
 *  prefab documents only. Throws the refusal, before anything changed, when the editor holds another document for one of
 *  them than the other side of the Apply (a prefab-edit save since, an outside change).
 *
 *  The snapshot goes back to the world this undo stack belongs to NOW — `currentSceneKey()`, the key Stop restores
 *  under — not to a path captured at the Apply (#1575). An untitled world has no path at all, and one saved with
 *  Save As since keeps its history under a path the Apply never saw. */
async function restoreSnapshot(
  source: string,
  prefab: PrefabFile,
  /** The other side of the Apply — the document the editor must hold for `source` now. */
  expected: PrefabFile,
  scene: SceneData,
  selGuid: string,
  /** The OTHER prefabs the Apply wrote (#1693: an enclosing prefab's row — an override applied there, or U13's revert of
   *  one), each restored with this one as ONE step. */
  others: readonly { source: string; doc: PrefabFile; expected: PrefabFile }[] = [],
): Promise<boolean> {
  // Read before the first await: the restore's nested preload and the reload below are a window a scene load, an Exit or
  // a Create Scene can land in, and the snapshot must not be loaded over whatever world that put in.
  const key = currentSceneKey();
  const world = getCurrentWorld();
  let restored = false;
  await restorePrefabsInMemory([
    { source, doc: prefab, from: expected },
    ...others.map((o) => ({ source: o.source, doc: o.doc, from: o.expected })),
  ], {
    // The reload below rebases what it carries itself.
    rebase: false,
    rebuild: async () => {
      // Still THAT world? An Exit swaps a real scene in under the edit world's undo (#1573 close-out re-review), where
      // loading the synthetic world would leave it under a real path for `saveScene` to write into that file. Every
      // untitled world shares the key `null`, so a Create Scene there is told apart by the world itself (#1575). The
      // world is compared for EVERY key: a scene load swaps the world first and sets its path only in its tail, after
      // awaiting the scene managers, so for that window the key still reads as this scene's (#1575 close-out
      // re-review). And a load still in flight is not raced: loading this snapshot over it would leave its tail setting
      // the other scene's path and history over this world.
      // Since #1579 every user world switch waits for this step before it swaps, so these are defence in depth, for a
      // route that swaps through `sceneManager` directly. `isSceneLoadSwapping`, not `isSceneLoadInFlight`: the latter
      // also counts a load still WAITING for this very step, and skipping on it recreated the window #1579 closed.
      if (currentSceneKey() !== key || getCurrentWorld() !== world || isSceneLoadSwapping() || sceneManager.getNext() !== null) {
        console.warn(`[ApplyPrefab] ${key ?? 'the untitled scene'} is no longer the live world; restored the prefab only`);
        return;
      }
      // The world call is one pending adoption (#1698). Its world is adopted only while it is still the one on screen;
      // otherwise the switch that replaced it adopts its own, and this step restored the prefab only.
      const adopted = await withAdoption('prefab-undo-restore', async (adoption) => {
        if (key === null) {
          // An untitled world: reloaded under '' as Stop reloads it (`restoreAuthoredSnapshot`) — no file is read and none
          // is marked loaded, and the editor's scene path stays null, so Save still asks where. Not rebuilt through
          // `replaceWorldContent`, whose populate is synchronous and cannot instantiate a prefab (#1575). A restore under
          // the same key: it writes nothing.
          const { world: w } = await sceneManager.loadScene('', { preloaded: clone(scene) });
          return adoption.restored(w);
        }
        if (key.startsWith(PREFAB_EDIT_SCENE_PREFIX)) {
          // The prefab-edit world has no scene file, so before #1573 the world stayed built from the applied document. It
          // is a scene loaded at a synthetic path, so the same snapshot restores it — with the live guids every other undo
          // entry addresses its entities by, which a rebuild from the edited prefab's document would re-mint (review of
          // the first #1573 fix). No scene path set: that world reaches its file through Save alone. A restore under the
          // same key: it writes nothing, the edit session included.
          const { world: w } = await sceneManager.loadScene(key, { preloaded: clone(scene) });
          return adoption.restored(w);
        }
        // A3: sceneManager.loadScene({preloaded}) records the base ref internally, but the editor's own baseScene tracking
        // (re-emitted by serializeScene) is separate module state — re-synced with the path. No history write: this runs
        // INSIDE the undo history.
        const { world: w } = await sceneManager.loadScene(key, { preloaded: clone(scene) });
        return adoption.offer({ world: w, path: key, baseScene: 'loaded' });
      });
      if (!adopted) {
        console.warn(`[ApplyPrefab] ${key ?? 'the untitled scene'} was replaced while it was restored; restored the prefab only`);
        return;
      }
      restored = true;
      // The load CARRIES kept base roots flat (a `Persistent` one only in Play, #1863), still built from the document being
      // undone; rebuild them against the one just restored before anything captures them (#1483 review 3).
      await rebaseStaleInstances();
    },
  });
  if (!restored) return false;
  const id = selGuid ? entityIdForGuid(selGuid) : 0;
  useEditorStore.getState().selectEntity(id || null);
  return true;
}

/** A BASE scene's instance, as it stood on one side of the apply (#1431). `restoreSnapshot` rebuilds
 *  only the PRIMARY: a base loaded with it is CARRIED live across `loadScene`, so its instance
 *  would keep its post-apply state against the restored prefab — and since the base is dirty, Save
 *  All would then write that into the base file (a promoted added node was lost exactly so). The
 *  instance is rebuilt from this capture instead, the same way Revert's own undo rebuilds it. */
export interface BaseInstanceSide {
  rootGuid: string;
  /** The frame's OWN prefab — not necessarily one the Apply wrote (#1724: "override in Prefab 'O'" writes only the
   *  enclosing one). */
  source: string;
  prefab: PrefabFile;
  overrides: ReturnType<typeof captureInstanceOverrides>;
  structure: ReturnType<typeof captureInstanceStructure>;
  /** Every frame NESTED in it, as it stood on this side (#1741). Captured here, not at the rebuild: the rebuild's own
   *  capture reads the live frames, which by then show the other side — a U14 Apply from the outer root moved the frame's
   *  own edit into a prefab (`took`), so its undo read nothing of it and re-derived the frame from the restored row. */
  nested: NestedInstanceCapture[];
}

export function captureSide(rootInstanceId: number, rootGuid: string, source: string, prefab: PrefabFile): BaseInstanceSide {
  return {
    rootGuid, source, prefab,
    overrides: captureInstanceOverrides(rootInstanceId, prefab),
    structure: captureInstanceStructure(rootInstanceId, prefab),
    nested: captureNestedFrames(rootInstanceId, source, prefab),
  };
}

/** After `restoreSnapshot`: rebuild the carried base instance to `side`. Its root guid survives
 *  every rebuild, so it is found by guid; one that is gone (the base was unloaded) is left alone. */
async function restoreBaseInstance(side: BaseInstanceSide | null, direction: 'Undo' | 'Redo'): Promise<void> {
  if (!side) return;
  const id = side.rootGuid ? entityIdForGuid(side.rootGuid) : 0;
  if (!id) return;
  await preloadNestedPrefabsForSubtree(id);
  // Onto the CURRENT copy of its prefab, not the one captured (close-out review of #1724): when the Apply wrote only an
  // enclosing prefab, nothing restored the frame's own, and it may have changed since (a prefab-edit save, another
  // scene's Apply, a pull). Rebuilt from the captured copy, a member it gained since vanished from this instance, and
  // the frame read as stale, so Apply and Revert refused it. `null`: a frame nested in it is stale — the refresh's refusal.
  if (rebuildInstanceFromCapture(id, side.source, side.prefab, side.overrides, side.structure, side.nested) === null) {
    // Reported, not thrown: the files and the world have already followed the step (#308). Reachable only with a frame
    // the restore's rebase left stale, i.e. a damaged tree — but then the instance keeps the other side's edits, and a
    // dirty base would save them.
    reportUndoFailure({
      direction, label: 'Apply to Prefab',
      detail: `the applied instance ${side.rootGuid} holds a nested frame built from other rows, so it was not rebuilt to this side of the Apply. Its own edits may be missing; check it before saving its scene.`,
    });
  }
}

/** After each prefab of `files` is swapped from `from` to `to` (innermost first, as the Apply wrote them): rebuild the
 *  applied base instance from its capture, THEN re-derive every other base instance of each file (#1431).
 *
 *  In that order (#1483 review 3): the applied frame can sit inside another base instance whose refresh captures it
 *  through `captureNestedRef` against the cache — so it must already be built from the restored prefab, or the
 *  enclosing refresh reads it as a stale nested frame and is skipped, keeping the side being undone. The rebuild also
 *  re-seeds the frame's own overrides as MARKED, which is what carries them through an enclosing refresh when the Apply
 *  wrote only the enclosing prefab (#1724): that row held the instance's own value after the Apply (U15), so a capture
 *  measuring by value alone saw no override there, and the instance came back with the row's old value. The enclosing
 *  rebuild re-creates the frame with fresh ids, so it is re-selected by guid last. */
export async function rederiveBaseInstances(
  files: readonly { source: string; from: PrefabFile; to: PrefabFile }[],
  side: BaseInstanceSide | null,
  direction: 'Undo' | 'Redo' = 'Undo',
): Promise<void> {
  await restoreBaseInstance(side, direction);
  for (const f of files) refreshBaseInstances(f.source, f.from, f.to, side?.rootGuid);
  const id = side?.rootGuid ? entityIdForGuid(side.rootGuid) : 0;
  if (id) useEditorStore.getState().selectEntity(id);
}

const worldLeft = () => new Error('the scene changed while it ran, so only the prefab was restored — the instances were not');

function makeApplyPrefabAction(opts: {
  source: string;
  prefabBefore: PrefabFile;
  prefabAfter: PrefabFile;
  sceneBefore: SceneData;
  sceneAfter: SceneData;
  selGuid: string;
  affectedScenes: string[];
  baseBefore: BaseInstanceSide | null;
  baseAfter: BaseInstanceSide | null;
  /** Every OTHER prefab file the Apply wrote, with its two sides (#1693). */
  others: readonly { source: string; before: PrefabFile; after: PrefabFile }[];
  /** Every prefab file the Apply wrote, innermost first (`ApplyResult.writes`) — the order the base re-derive runs in. */
  writes: readonly { source: string; before: PrefabFile; after: PrefabFile }[];
}): UndoAction {
  const label = 'Apply to Prefab';
  return {
    label,
    affectedScenes: opts.affectedScenes,
    // The world restore reaches only the primary; every carried base instance of the prefab is
    // re-derived against the prefab being restored, and the applied one rebuilt from its capture.
    // Not when the restore found its world gone: the rederive rebuilds every base instance of the prefab in whatever
    // world is live, which is then a scene this Apply never touched (#1575 close-out re-review). And the step THROWS
    // then, because it applied only half — the file, not the world. `runStep` drops a throwing step with a loud report
    // (#310), rather than pushing it to the other stack as if the world had followed.
    undo: async () => {
      const others = opts.others.map((o) => ({ source: o.source, doc: o.before, expected: o.after }));
      if (!await restoreSnapshot(opts.source, opts.prefabBefore, opts.prefabAfter, opts.sceneBefore, opts.selGuid, others)) throw worldLeft();
      await rederiveBaseInstances(opts.writes.map((w) => ({ source: w.source, from: w.after, to: w.before })), opts.baseBefore, 'Undo');
    },
    redo: async () => {
      const others = opts.others.map((o) => ({ source: o.source, doc: o.after, expected: o.before }));
      if (!await restoreSnapshot(opts.source, opts.prefabAfter, opts.prefabBefore, opts.sceneAfter, opts.selGuid, others)) throw worldLeft();
      await rederiveBaseInstances(opts.writes.map((w) => ({ source: w.source, from: w.before, to: w.after })), opts.baseAfter, 'Redo');
    },
  };
}

const NOT_APPLIED = { promotedAdditions: 0, applied: false } as const;

/** Apply the selected overrides to the prefab AND record one undo entry.
 *  Captures the scene snapshot before the mutation, applies, captures the after snapshot, and pushes the action. */
export async function applyToPrefabWithUndo(
  rootInstanceId: number,
  selectedKeys: Set<string>,
  /** Where each key is written (#1693) — see `applyToPrefabSelective`. */
  targets?: ApplyTargets,
  /** `expect`: the fingerprint of the preview the caller showed (#1736) — see `applyToPrefabSelective`. */
  opts: { expect?: string } = {},
): Promise<ApplyResult> {
  // ⚠️ Lands WHOLE, in the world it began in (I11, #1667). Its write, its refresh, its scene save and its undo entry
  // are separated by awaits, and a Play, a scene open or entering prefab edit in one of them ran the rest in the
  // incoming world: Play snapshotted the pre-refresh world and Stop restored it over the applied prefab, and a scene
  // open took the undo entry onto ITS stack. So every world switch waits for this, as for an undo step (#1579), and
  // an Apply does not start while one is under way. Taken synchronously, before the first await.
  if (isWorldSwitchInProgress()) {
    return { ...NOT_APPLIED, refused: 'a scene switch is in progress — apply again once it has landed.' };
  }
  const release = beginWorldBoundOperation();
  try {
    return await applyHeld(rootInstanceId, selectedKeys, targets, opts);
  } finally {
    release();
  }
}

async function applyHeld(rootInstanceId: number, selectedKeys: Set<string>, targets?: ApplyTargets, opts: { expect?: string } = {}): Promise<ApplyResult> {
  // …and not over a world an editor route is still adopting (#1698): its snapshot, its scene save and its undo entry
  // would describe a world whose history and path are about to change under them.
  // ⚠️ `rootInstanceId` is a bare entity index, and a reloaded world numbers its entities from zero in FILE order, so
  // after a switch it names whatever entity holds that index — often ANOTHER instance of the same prefab (#1750 H1:
  // measured, IB's value written as IA's with `applied: true`). So the Apply captures the adopted world first and, after
  // its last await before it plans (below — it covers this wait too), refuses if that world is gone. Never re-found by
  // guid: the write would no longer be the preview the user confirmed (owner, 2026-09-28).
  const adopted = captureAdoption();
  if (!adopted) return { ...NOT_APPLIED, refused: 'a scene is still loading — apply again once it is open.' };
  // …and the instance itself: a frame rebuilt in place (a leave repair this waits for below, another Apply's fan-out)
  // re-mints its entities in the SAME world, so the world check cannot see it (close-out reviews).
  const sameInstance = captureEntityIdentity(rootInstanceId);
  const settling = adoptionsSettled();
  if (settling) await settling;
  // assignGuids so every entity (incl. the selection) has a stable guid the snapshot
  // and selection-restore can key on.
  const sceneBefore = (await serializeScene({ assignGuids: true })) as unknown as SceneData;
  // Anchor selection-restore to the INSTANCE being applied (its root guid), not the
  // editor's transient selection — the scene rebuild on undo/redo mints new ECS ids,
  // and the instance root is the entity the user was working on. Falls back to the
  // current selection if the root has no guid yet.
  const selGuid = guidForEntityId(rootInstanceId) || (() => {
    const selId = useEditorStore.getState().selectedEntityId;
    return selId != null ? guidForEntityId(selId) : '';
  })();

  // A BASE scene's instance (#1431): the apply rebuilds it and consumes its overrides/additions into
  // the prefab, so the base's file is stale too.
  // Carried as the action's `affectedScenes`, so push, undo and redo each dirty the base for Save All.
  // Read BEFORE the apply: it tears the instance down.
  const affectedScenes = resolveAffectedScenes([rootInstanceId]);
  // …and the undo needs the base instance itself, which `sceneBefore` (primary-only) does not hold.
  // Found again by a DURABLE guid: a runtime one is not carried by the rebuild nor across the carry,
  // and a miss would silently drop back to saving the post-apply instance. Warmed first, as Revert
  // does: a cold cache drops a user-added nested instance from the capture (#1284).
  const ctx = affectedScenes.length ? resolveInstanceContext(rootInstanceId) : null;
  const rootGuid = ctx ? ensureGuid(rootInstanceId) : '';
  if (ctx) await preloadNestedPrefabsForSubtree(rootInstanceId);
  const prefabNow = ctx ? await getPrefabSource(ctx.source) : null;
  const baseBefore = ctx && prefabNow && rootGuid ? captureSide(rootInstanceId, rootGuid, ctx.source, prefabNow) : null;
  // The last await before the plan reads the instance by that id: a reload the wait above let land, or one landing in
  // `sceneBefore`'s serialize (it fetches a cold prefab) or the preloads, renumbered the world (#1750 H1, both windows).
  if (!adopted()) return { ...NOT_APPLIED, refused: 'the scene reloaded — open Apply again.' };
  if (!sameInstance()) return { ...NOT_APPLIED, refused: 'the instance was rebuilt meanwhile — open Apply again.' };
  const result = await applyToPrefabSelective(rootInstanceId, selectedKeys, targets, opts);
  if (!result.applied || !result.source || !result.prefabBefore || !result.prefabAfter) {
    return result; // no-op apply — nothing to undo
  }

  // No scene save, a promotion's included (#1868): Unity's Apply never saves the scene, and the entry below dirties it.
  const sceneAfter = (await serializeScene({ assignGuids: true })) as unknown as SceneData;
  // Every file the Apply wrote, innermost first; the primary's only when the plural list is absent.
  const writes = result.writes ?? [{ source: result.source, before: result.prefabBefore, after: result.prefabAfter }];
  // The base instance's sides are measured against the frame's OWN prefab — the one it is rebuilt as — on each side of
  // the Apply: that file's two sides when the Apply wrote it, else the unchanged document on both. An Apply that wrote
  // only ENCLOSING prefabs (#1693: "override in Prefab 'O'") still needs them (#1724): it moved the instance's own value
  // into the enclosing row, and a re-derive from the row it restores cannot bring that value back.
  const own = ctx ? writes.find((w) => w.source === ctx.source) : undefined;
  const liveAfter = baseBefore && rootGuid ? entityIdForGuid(rootGuid) : 0;
  const baseAfter = liveAfter && ctx && prefabNow ? captureSide(liveAfter, rootGuid, ctx.source, own?.after ?? prefabNow) : null;
  pushAction(makeApplyPrefabAction({
    source: result.source,
    prefabBefore: result.prefabBefore,
    prefabAfter: result.prefabAfter,
    sceneBefore,
    sceneAfter,
    selGuid,
    affectedScenes,
    baseBefore: baseBefore && liveAfter ? { ...baseBefore, prefab: own?.before ?? baseBefore.prefab } : null,
    baseAfter,
    // Every file but the one `result.source` names (writes are innermost first, and a U14 Apply's frame file is not).
    others: writes.filter((w) => w.source !== result.source),
    writes,
  }));
  return result;
}
