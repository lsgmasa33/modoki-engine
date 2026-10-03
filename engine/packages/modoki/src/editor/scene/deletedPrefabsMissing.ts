/** A prefab the open scene uses was deleted — the Assets trash, `/api/delete-asset`, or an outside delete the watcher
 *  adopted — and its live instances become Missing Prefab placeholders AT ONCE (#2056, owner ruling 2026-10-03: "Missing
 *  at once, as Unity"). Unity shows "Missing Prefab" the moment the asset goes. Until this, the frames stayed live
 *  (#1738's evicted state, kept across every rebuild by #1862), and only the next load showed the placeholders: a Play →
 *  Stop then changed what was on screen, because Stop's restore IS a load (I13).
 *
 *  The conversion is that load: the live world is captured and put back through the same reload Stop runs
 *  (`reloadCapturedWorld`), so the trash shows exactly what a reload or a Stop shows, by construction rather than by a
 *  second, hand-kept copy of the load's placeholder rules (entry, node and row placeholders, their place, name, order
 *  and marks). The capture is the live world, so unsaved edits, the dirty flag and the undo stack are kept, as Stop keeps
 *  everything before Play.
 *
 *  Not while the live world is not the authored one (`isWorldAuthored`: Play, a preview, a restore still landing): that
 *  envelope's own exit is a load, which makes the placeholders. Not in prefab edit either: the open world is the
 *  template, and leaving it loads the scene. Either way no live frame of a deleted prefab outlives the next load.
 *
 *  A delete is still not undoable (#1868 D2) — nor is it in Unity, whose asset delete says "You cannot undo this action".
 *  The way back is Unity's too: the file put back (the OS Trash, git) is an outside write, and its adopt re-expands the
 *  placeholders in place (`reexpandPlaceholders`, #1873 R1 r3), as Unity relinks a Missing Prefab when its asset returns. */

import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { EntityAttributes } from '../../runtime/core/traits/EntityAttributes';
import { onWorldSwap } from '../../runtime/core/ecs/world';
import { deletedEditorPrefabKeys } from './prefabCache';
import { resolvedRef } from './prefabUse';
import { isWorldAuthored } from './authoredWorld';
import { useEditorStore } from '../store/editorStore';

/** Is a frame of a deleted prefab live in the primary scene — an entity built from it, top-level or nested? A placeholder
 *  carries no `PrefabInstance`, so once converted the world answers no.
 *
 *  A base scene's entities do not count (each is stamped `sourceScene` at spawn): the reload keeps a base's live tree
 *  rather than rebuilding it (`SceneManager`'s kept bases), so it cannot convert them, as Stop does not. Counting them
 *  answered yes after every conversion, and every later delete — of any asset — reloaded the world again for nothing. */
export function liveFramesOfDeletedPrefabs(): boolean {
  const gone = deletedEditorPrefabKeys();
  const pi = getTraitByName('PrefabInstance');
  if (!gone.size || !pi) return false;
  return getCurrentWorld().query(pi.trait).some((e) => {
    if ((e.has(EntityAttributes) ? (e.get(EntityAttributes) as { sourceScene?: string }).sourceScene : '')) return false;
    const source = (e.get(pi.trait) as { source?: string } | undefined)?.source;
    return !!source && (gone.has(source) || gone.has(resolvedRef(source) ?? ''));
  });
}

let pending: Promise<void> = Promise.resolve();

/** Turn every live frame of a deleted prefab into its Missing Prefab placeholder, now. Idempotent and serialised: the
 *  route's renderer repair and the panel's own pass both ask, and the second finds nothing live. */
export function showDeletedPrefabsMissing(): Promise<void> {
  const run = pending.then(convert, convert);
  pending = run.catch((e) => { console.error('[prefab] the deleted prefab\'s instances could not be shown as Missing Prefab', e); });
  return run;
}

/** Settles once every conversion asked for so far has landed — for a caller that reports the world after a delete. */
export function deletedPrefabsShown(): Promise<void> {
  return pending;
}

/** A capture an edit landed in the middle of is not taken (the reload would drop that edit): tried again, this many times. */
const ATTEMPTS = 3;

async function convert(): Promise<void> {
  // Loaded when needed: the snapshot module reaches the scene manager and the serializer, which the Assets panel's
  // path repair (this module's caller) must not pull in for every rename.
  const [{ captureAuthoredSnapshot, reloadCapturedWorld, currentSceneKey }, serialize, { beginWorldReplacement }, { whenUndoIdle, getEditVersion, subscribeUndo, isCapturingActions, isUndoStepInFlight }, { adoptionsSettled }, { sceneManager }] = await Promise.all([
    import('./authoredSnapshot'), import('./serialize'), import('./authoringSettle'), import('../undo/undoManager'), import('./sceneAdoption'), import('../../runtime/scene/SceneManager'),
  ]);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    // An undo or redo already running finishes against the world it started on (the preview restore's rule).
    await whenUndoIdle();
    if (!isWorldAuthored() || useEditorStore.getState().editingPrefab || adoptionsSettled() !== null || !liveFramesOfDeletedPrefabs()) return;
    const world = getCurrentWorld();
    const loads = serialize.sceneLoadGeneration();
    // Sampled BEFORE the capture's awaits, as Play samples it: an edit landing during them may be missing from the
    // capture, and the reload would then drop it.
    const version = getEditVersion();
    const snap = await captureAuthoredSnapshot({ bases: false });
    if (getEditVersion() !== version) continue;
    // A load or swap during the capture replaced the world, and that load made its own placeholders.
    if (getCurrentWorld() !== world || serialize.sceneLoadGeneration() !== loads || snap.key !== currentSceneKey() || !isWorldAuthored() || adoptionsSettled() !== null) return;
    // Nothing refuses an edit while the reload runs (a watcher-driven delete lands whenever its batch does), and the
    // reload builds its world from the capture, so an edit landing before the swap would be dropped with its undo entry
    // left over a world that no longer holds it. Such an edit aborts the load instead: no swap happens, the edit stays
    // where it landed, and the conversion captures again. Heard two ways: an edit pushed (the watch), and, just before
    // the swap, a step still open whose writes are live but not yet pushed — a composite frame (an agent's
    // `modoki.composite` awaiting) or an undo/redo step (#2056 re-review: both were dropped). From the swap on, an edit
    // lands in the new world, so the watch ends there.
    const edited = new AbortController();
    const unwatch = subscribeUndo(() => { if (getEditVersion() !== version) edited.abort(); });
    const unwatchSwap = onWorldSwap(() => unwatch());
    const beforeSwap = async () => { if (isCapturingActions() || isUndoStepInFlight()) edited.abort(); };
    sceneManager.registerBeforeSwap(beforeSwap);
    const release = beginWorldReplacement();
    try {
      await reloadCapturedWorld(snap, edited.signal);
    } catch (e) {
      if (edited.signal.aborted && getCurrentWorld() === world) continue;
      throw e;
    } finally {
      sceneManager.unregisterBeforeSwap(beforeSwap);
      unwatch();
      unwatchSwap();
      release();
    }
    // No dirty-flag repair, unlike Stop's: the reload adopts under the scene's own key and writes no editor scene state
    // (#1698), and no pushed edit sits between the capture and its swap (the version check and the watch above), so the
    // flag is as it was.
    return;
  }
  console.warn('[prefab] edits kept landing while the deleted prefab\'s instances were captured; they stay live until the next load');
}
