/** Editor preview SESSION controller — the snapshot/restore half of "▶ Preview plays the
 *  cutscene for real" (Phase 6). Mirrors editor Play/Stop (`playMode.ts`): before a preview
 *  begins we snapshot the authored world (the same `serializeScene()` the save path uses); on
 *  stop/scrub/close we revert to it via `SceneManager.loadScene({ preloaded })`, discarding every
 *  preview-mode mutation a signal action / OnSequence made (camera moved, text shown, isActive
 *  toggled). Play stays `'stopped'` throughout — only the two side-effect gates open (see
 *  `runtime/core/timelinePreview.ts`), so the rest of the sim never runs.
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
import { setTimelinePreviewActive } from '../../runtime/core/timelinePreview';
import { clearSkeletalSeeks } from '../../runtime/core/skeletalSeek';
import { clearControlSpawns } from '../../runtime/timeline/controlSpawnRegistry';
import { serializeScene, getCurrentScenePath, type SceneFile } from './serialize';
import { getEditVersion } from '../undo/undoManager';

/** Authored-world snapshot captured at the first ▶ of a preview session, plus the scene path it
 *  belongs to (so a scene swap mid-preview can't revert the wrong scene). */
let _snap: SceneFile | null = null;
let _snapPath: string | null = null;
/** The scene edit-version when the snapshot was taken, so `previewHasAuthoredEdits` can tell an
 *  authored change made INSIDE the envelope from one that predates it. */
let _snapEditVersion = 0;
/** In-flight `begin`, so concurrent openers share ONE snapshot — see beginTimelinePreviewSession. */
let _pending: Promise<void> | null = null;
/** Bumped by every session END, so a `begin` that was already awaiting cannot seat its snapshot
 *  after the envelope it belonged to was exited. */
let _beginEpoch = 0;

export { setTimelinePreviewActive };

/** How Cmd+S puts a preview envelope down and picks it back up (#259 follow-up).
 *
 *  A SCENE save has to write authored data, and inside the envelope the live world holds a pose —
 *  so the save used to be refused with "exit preview first". Owner's call (2026-08-19): don't
 *  refuse, and don't just exit either; **exit, save, then put the preview back where it was**, so
 *  Cmd+S always works and an animator keeps their frame. The cost is a world reload behind the
 *  scenes, which is why the scene half is skipped entirely when the scene has nothing to write —
 *  otherwise every save while animating would churn the scene file and flicker the viewport for no
 *  reason.
 *
 *  The panel that owns the envelope registers this, because only it knows what to rebind to and
 *  where its playhead is. `suspend` MUST resolve after the world has actually been restored — the
 *  save serializes immediately afterwards, and a fire-and-forget restore would let it serialize the
 *  posed world, which is the exact bug this exists to prevent. */
export interface PreviewSaveHandler {
  /** WHICH panel this belongs to — the identity that survives a re-registration. */
  owner: 'animation' | 'timeline';
  /** End the envelope, restoring the authored world (and rebinding this panel's root). */
  suspend(): Promise<void>;
  /** Re-open the envelope and re-pose at the panel's current playhead. */
  resume(): void;
  /** Is the owner panel STILL MOUNTED?
   *
   *  This exists to separate two states that both leave nothing registered when a save finishes,
   *  and that need opposite answers. A panel that UNMOUNTED must not be resumed — re-entering
   *  scrub mode with nobody to drive it wedges the run-mode. A panel that merely DEREGISTERED,
   *  because the suspend flipped the run-mode its registration effect is guarded on, is still
   *  there and still owes the human their frame. See {@link resumeHandlerFor}.
   *
   *  Optional: a handler that does not answer is assumed live, which is the pre-existing
   *  behaviour for the replaced-handler path. */
  isLive?(): boolean;
}

let _saveHandler: PreviewSaveHandler | null = null;

/** Register the owner panel's save hooks. */
export function setPreviewSaveHandler(h: PreviewSaveHandler): void { _saveHandler = h; }

/** Clear them — but ONLY if `mine` is still the registered handler.
 *
 *  ⚠️ Unconditional clearing is how one panel deletes another's registration. Both panels register
 *  in an effect and both clean up in its teardown, and their effects re-run on unrelated deps (a
 *  world swap re-resolves the Timeline panel's Director root, for instance) — so an unguarded
 *  `setPreviewSaveHandler(null)` from the panel that does NOT own the envelope silently disables
 *  the feature for the one that does. Same lesson as `_modeOwner` in playMode.ts. */
export function clearPreviewSaveHandler(mine: PreviewSaveHandler): void {
  if (_saveHandler === mine) _saveHandler = null;
}

/** The owner panel's save hooks, or null when nothing owns an envelope. */
export function getPreviewSaveHandler(): PreviewSaveHandler | null { return _saveHandler; }

/** The CURRENT handler for `owner`, or null if that panel no longer owns the envelope.
 *
 *  ⚠️ This is why the handler carries an owner tag instead of being compared by object identity.
 *  `suspend()` restores the world, which reassigns entity ids, which makes the panel re-resolve its
 *  root — so its callbacks, and therefore its handler object, are REPLACED during the very save
 *  that is about to resume it. An identity check (the first version of this) therefore failed on
 *  every normal cycle and silently skipped the resume: the animator's frame vanished and the toast
 *  said "Scene saved". Resuming through the CURRENT handler is also what makes the resume use the
 *  freshly-rebound root rather than the dead one. */
export function currentPreviewSaveHandlerFor(owner: PreviewSaveHandler['owner']): PreviewSaveHandler | null {
  return _saveHandler?.owner === owner ? _saveHandler : null;
}

/** Which handler a finished save cycle should RESUME through — or null when it must not resume.
 *
 *  THREE things can happen to a registration across `suspend()` → save → `resume()`, and only two
 *  of them were handled:
 *
 *  - **Replaced.** The restore reassigns entity ids, the owner panel re-resolves its root, and its
 *    effect re-registers a handler bound to the NEW root. The current registration wins — resuming
 *    through the captured object would pose a dead root. That is what
 *    {@link currentPreviewSaveHandlerFor} is for.
 *  - **Gone, because the panel CLOSED.** Nothing should be resumed: re-entering scrub mode with no
 *    panel to drive it wedges the run-mode at 'scrub' with the world posed. Null is right here.
 *  - **Gone, because the panel DEREGISTERED ITSELF.** The registration effect is guarded on being
 *    inside the envelope, and `suspend()` is precisely what leaves it — so the suspend deletes the
 *    registration it is about to need, while the panel is still perfectly alive. This case was
 *    read as the previous one, and it is the Timeline panel's NORMAL path: `previewResumed` came
 *    back false on every cycle, the human's scrub session ended on every Cmd+S, and the panel went
 *    on showing a playhead for an envelope that no longer existed (bug `tSv0EWjWICpEl9HSjRe9`,
 *    QA-TIMELINE-0007). The save itself was correct throughout, which is why nothing else caught
 *    it.
 *
 *  `isLive()` is what tells the last two apart. Without it there is no observable difference: both
 *  present as "the owner has no registration".
 *
 *  ⚠️ Falling back to the CAPTURED handler is only sound because both panels' handlers dispatch
 *  through a ref, so it still calls the freshly-rebound closures. Do not reintroduce a handler
 *  that closes over a root directly. */
export function resumeHandlerFor(
  owner: PreviewSaveHandler['owner'],
  started: PreviewSaveHandler,
): PreviewSaveHandler | null {
  const current = currentPreviewSaveHandlerFor(owner);
  if (current) return current;
  // FAIL OPEN. `isLive` is an optional method on a public interface, so a future implementation
  // could be more than a ref read — and this runs AFTER the scene has already been written. A
  // throw here would escape `runSaveAllOnce`'s try, hit its catch, be re-thrown by the SECOND
  // call there, and surface as a failed save that actually succeeded, with the envelope left
  // suspended forever: exactly the bug this function exists to fix, reopened through its own
  // guard. Unreachable with today's two implementations; the contract is what invites it.
  let live = true;
  try { live = started.isLive?.() !== false; } catch { /* an unanswerable panel is treated as live */ }
  return live ? started : null;
}

/** Has the authored world been EDITED since this envelope opened?
 *
 *  Restoring the snapshot reverts the world to how it looked when the preview began — which
 *  silently throws away anything authored since. That has always been true of ⏹ Exit; what makes it
 *  worth detecting is that Cmd+S now ends the envelope by itself (see `PreviewSaveHandler`), and a
 *  SAVE that destroys work is a different order of wrong from a button that says "poses revert on
 *  exit". So when this is true the save does NOT cycle the preview — it refuses and says why,
 *  leaving the human to decide. False (the common case: only the clip was touched) means the
 *  snapshot still equals the authored world and cycling loses nothing.
 *
 *  Fixing the underlying hole — an authored edit made inside the envelope being revertible at all —
 *  belongs to `docs/plans/preview-mode-refactor.md`, not here. */
export function previewHasAuthoredEdits(): boolean {
  return _snap !== null && getEditVersion() !== _snapEditVersion;
}

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
  const epoch = _beginEpoch;
  // ⚠️ Sample the edit-version BEFORE the await, not after. `serializeScene()` is async, and an
  // authored edit landing during it may or may not be in `snap` — but folding its bump into the
  // baseline unconditionally makes `previewHasAuthoredEdits()` answer FALSE, which is the unsafe
  // direction: the save then cycles the envelope, restores a snapshot that predates the edit, and
  // writes the pre-edit world reporting success. Sampling first can only over-report (refuse a save
  // that would have been fine), which costs a keystroke instead of the edit.
  const version = getEditVersion();
  _pending = (async () => {
    const snap = await serializeScene();
    const path = getCurrentScenePath();
    // Only seat it if no session end intervened (see endTimelinePreviewSession).
    if (!_snap && epoch === _beginEpoch) { _snap = snap; _snapPath = path; _snapEditVersion = version; }
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
  // ⚠️ Invalidate any in-flight `begin` FIRST. `beginTimelinePreviewSession` seats its snapshot on
  // `if (!_snap)` alone, so a begin still awaiting `serializeScene()` when the envelope is exited
  // used to seat a session AFTERWARDS — and the pose chained onto it then ran with run-mode back at
  // 'stopped', where the next save serializes the posed world into the scene file and says "Scene
  // saved". Exiting during that window is not exotic: it is pressing ⏹ or switching clips within
  // the tens of ms a real scene takes to serialize.
  _beginEpoch += 1;
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
