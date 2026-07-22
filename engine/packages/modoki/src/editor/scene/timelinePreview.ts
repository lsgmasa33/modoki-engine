/** Editor preview SESSION controller — the snapshot/restore half of "▶ Preview plays the
 *  cutscene for real" (Phase 6). Mirrors editor Play/Stop (`playMode.ts`): before a preview
 *  begins we snapshot the authored world (the same `serializeScene()` the save path uses); on
 *  stop/scrub/close we revert to it via `SceneManager.loadScene({ preloaded })`, discarding every
 *  preview-mode mutation a signal action / OnSequence made (camera moved, text shown, isActive
 *  toggled). Play stays `'stopped'` throughout — only the two side-effect gates open (see
 *  `runtime/systems/timelinePreview.ts`), so the rest of the sim never runs.
 *
 *  NAMED for the Timeline panel because it shipped there first, but it now backs BOTH preview
 *  owners — the Animation panel's clip scrub/preview opens the same session so its poses are
 *  revertible and its "Exit Preview" can un-wedge saves. Which panel holds it is tracked by
 *  `playMode.getModeOwner()`, not here; the caller supplies its own `rebind` (the reload
 *  rebuilds the world with new entity ids, so each panel must re-resolve its own root).
 *  Phase 3 of `docs/plans/preview-mode-refactor.md` merges this with `playMode.ts`'s Play
 *  snapshot into one owner and drops the "timeline" from these names.
 *
 *  Session vs. active flag are distinct:
 *   - the SESSION (snapshot held) spans the whole preview, surviving Pause — it's what restore
 *     reverts, ended only by stop/scrub/close/global-Play;
 *   - the ACTIVE flag (`setTimelinePreviewActive`) is true only while the forward loop advances,
 *     so Pause silences audio + blocks dispatch without losing the paused frame. */

import type { SceneData } from '../../runtime/loaders/loadSceneFile';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { setTimelinePreviewActive } from '../../runtime/systems/timelinePreview';
import { clearSkeletalSeeks } from '../../runtime/systems/skeletalSeek';
import { clearControlSpawns } from '../../runtime/systems/controlSpawnRegistry';
import { serializeScene, getCurrentScenePath, type SceneFile } from './serialize';

/** Authored-world snapshot captured at the first ▶ of a preview session, plus the scene path it
 *  belongs to (so a scene swap mid-preview can't revert the wrong scene). */
let _snap: SceneFile | null = null;
let _snapPath: string | null = null;
/** In-flight `begin`, so concurrent openers share ONE snapshot — see beginTimelinePreviewSession. */
let _pending: Promise<void> | null = null;

export { setTimelinePreviewActive };

/** Is a preview session currently held (snapshot pending restore)? */
export function hasTimelinePreviewSession(): boolean {
  return _snap !== null;
}

/** Begin a preview session: snapshot the authored world ONCE (idempotent, so Pause→resume keeps
 *  the original authored snapshot to revert to — never re-snapshots the preview-mutated world).
 *
 *  Idempotence has to cover the IN-FLIGHT window too, not just `_snap`: a scrub drag calls this
 *  once per pointermove, and `serializeScene()` is async — so two moves before the first snapshot
 *  resolves both saw `_snap === null` and the second one serialized an ALREADY-POSED world and
 *  overwrote the authored snapshot with it, silently making Exit revert to the pose. Concurrent
 *  callers now await the same promise, and the resolver only seats a snapshot if none landed. */
export async function beginTimelinePreviewSession(): Promise<void> {
  if (_snap) return;
  if (_pending) return _pending;
  _pending = (async () => {
    const snap = await serializeScene();
    const path = getCurrentScenePath();
    if (!_snap) { _snap = snap; _snapPath = path; }
  })().finally(() => { _pending = null; });
  return _pending;
}

/** End the session. Clears the active flag + any skeletal seeks. When `restore`, revert the world
 *  to the authored snapshot (like Stop) and — because the reload rebuilds the world with new
 *  entity ids — run the caller's `rebind` and return the freshly-resolved root id (or null) so the
 *  panel can re-point at its Director/Animator. `rebind` is a callback rather than a timeline path
 *  because BOTH preview panels end sessions here and each resolves its own root. No-op restore
 *  when the scene changed since the snapshot. */
export async function endTimelinePreviewSession(opts: { restore: boolean; rebind?: () => number | null }): Promise<number | null> {
  setTimelinePreviewActive(false);
  clearSkeletalSeeks();
  clearControlSpawns(); // preview-spawned prefabs are discarded by the snapshot reload below
  const snap = _snap;
  const snapPath = _snapPath;
  _snap = null;
  _snapPath = null;
  if (!opts.restore || !snap) return null;
  const path = getCurrentScenePath();
  if (snapPath !== path) return null; // snapshot is for a different scene — don't clobber
  await sceneManager.loadScene(path ?? '', { preloaded: snap as unknown as SceneData });
  return opts.rebind?.() ?? null;
}
