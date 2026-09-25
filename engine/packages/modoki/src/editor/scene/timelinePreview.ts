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

import { setTimelinePreviewActive } from '../../runtime/core/timelinePreview';
import { getRunMode } from '../../runtime/core/playState';
import { onWorldSwap } from '../../runtime/core/ecs/world';
import { registerPosedWorldSource } from './authoredWorld';
import { clearSkeletalSeeks } from '../../runtime/core/skeletalSeek';
import { clearControlSpawns } from '../../runtime/timeline/controlSpawnRegistry';
import { captureAuthoredSnapshot, restoreAuthoredSnapshot, currentSceneKey, lastRestoreFailed, type AuthoredSnapshot } from './authoredSnapshot';
import { capturePreviewSideState, restorePreviewSideState, type PreviewSideState } from './previewSideState';
import { beginWorldReplacement } from './authoringSettle';
import { getEditVersion, setPreviewUndoSession, clearPreviewUndoSession, whenUndoIdle, beginPreviewRestore, finishPreviewRestore } from '../undo/undoManager';
import { createTeardownToken } from '../../runtime/core/liveness';
import { notifyListeners } from '../../runtime/core/notifyListeners';

/** Authored-world snapshot captured at the first pose of a session — primary, bases, and the scene
 *  key it belongs to (so a scene swap mid-preview can't revert the wrong scene). Captured and
 *  restored by `authoredSnapshot.ts`, the same code Play/Stop uses (#1547). */
let _snap: AuthoredSnapshot | null = null;
/** The non-world stores ▶ actions can change (#1551), seated and released WITH `_snap` — see
 *  `previewSideState.ts`. Restored on every end, including the ones that leave the world alone. */
let _side: PreviewSideState | null = null;
/** The scene edit-version when the snapshot was taken, so `previewHasAuthoredEdits` can tell an
 *  authored change made INSIDE the envelope from one that predates it. */
let _snapEditVersion = 0;
/** The last preview session id handed to the undo stack (`setPreviewUndoSession`): the scene edits
 *  pushed while a session was held are the ones its restore makes obsolete (#1148). A plain id
 *  sequence — `clearPreviewUndoSession(id)` does the "is it still this one" check on the undo side. */
let _undoSessionSeq = 0;
/** In-flight `begin`, so concurrent openers share ONE snapshot — see beginTimelinePreviewSession. */
let _pending: Promise<void> | null = null;
/** Whether `_pending` can still seat its snapshot. An Exit invalidates a begin that is still
 *  serializing, and that dead begin keeps `_pending` set until its serialize settles — a begin made
 *  AFTER the Exit must not join it, or it resolves `false` for an envelope nobody closed. */
let _pendingLive: () => boolean = () => false;
/** Session restores whose world swap has not finished. A count, not a flag: a second end during the
 *  first one's restore takes the early return and never restores, but nothing here should rely on
 *  that to keep the refusal honest. While non-zero, `beginTimelinePreviewSession` refuses (#1167). */
let _restoresInFlight = 0;
/** Resolvers for `whenPreviewRestoresLanded`, flushed when `_restoresInFlight` returns to zero. */
let _restoreWaiters: (() => void)[] = [];
/** Liveness of preview GESTURES that reopen a session after their own restore — the Timeline's
 *  grab-while-playing chain (`reopenPreviewAfterRestore`). Module-level rather than panel-owned so
 *  toolbar Stop (`playMode.stopPlay`), which cannot reach the panel, can cancel one too. */
const gestureLiveness = createTeardownToken();
/** Invalidated by every session END, so a `begin` that was already awaiting cannot seat its
 *  snapshot after the envelope it belonged to was exited. */
const beginLiveness = createTeardownToken();
/** Open holds from {@link holdPreviewSessionsClosed} — Play starting up. While non-zero every begin
 *  is refused (#1546). A count, for the same reason as `_restoresInFlight`. */
let _closedHolds = 0;

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

/** Every handler currently registered, oldest first; `_saveHandler`'s answer is always the LAST
 *  entry — same shape as `registrants` in `runtime/core/activeRenderer.ts` (#810).
 *
 *  ⚠️ A single slot overwritten unconditionally is how one panel's registration silently deletes
 *  the other's: both panels register in an effect and re-run it on unrelated deps (a world swap
 *  re-resolves the Timeline panel's Director root, for instance), so TimelineEditor registering
 *  after AnimationEditor used to drop the Timeline's handler with nothing telling it — and the
 *  Animation panel's later, correctly-guarded clear then nulled the slot out from under a still-
 *  mounted Timeline panel (bug class: #810). A disposer now removes only ITS OWN entry and hands
 *  the slot back to the most recent survivor, reaching null only when the last registrant goes.
 *  Membership is by identity, so a repeat registration of the same handler object re-seats rather
 *  than duplicating. */
const _registrants: PreviewSaveHandler[] = [];

/** Register the owner panel's save hooks. Re-seats rather than duplicates: a repeat registration
 *  of the same handler object must leave ONE entry, or its clear would remove only one of them and
 *  the stale entry would linger reachable underneath. */
export function setPreviewSaveHandler(h: PreviewSaveHandler): void {
  const existing = _registrants.indexOf(h);
  if (existing >= 0) _registrants.splice(existing, 1);
  _registrants.push(h);
}

/** Clear `mine` — but ONLY by removing IT, wherever it sits in the stack, and hand the slot back to
 *  the most recent survivor. Null only when the last registrant goes.
 *
 *  ⚠️ Unconditional clearing is how one panel deletes another's registration. Both panels register
 *  in an effect and both clean up in its teardown, and their effects re-run on unrelated deps (a
 *  world swap re-resolves the Timeline panel's Director root, for instance) — so an unguarded
 *  `setPreviewSaveHandler(null)` from the panel that does NOT own the envelope silently disables
 *  the feature for the one that does. Same lesson as `_modeOwner` in playMode.ts. Removing `mine`
 *  specifically (rather than only-if-current) is what makes this safe even when `mine` was already
 *  displaced from the top of the stack by a later registration — the OLD guard's `if (_saveHandler
 *  === mine)` would silently no-op that clear and leak `mine` in the stack forever. */
export function clearPreviewSaveHandler(mine: PreviewSaveHandler): void {
  const at = _registrants.indexOf(mine);
  if (at >= 0) _registrants.splice(at, 1);
}

/** The owner panel's save hooks, or null when nothing owns an envelope — the most recently
 *  registered survivor. */
export function getPreviewSaveHandler(): PreviewSaveHandler | null {
  return _registrants[_registrants.length - 1] ?? null;
}

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
  const current = getPreviewSaveHandler();
  return current?.owner === owner ? current : null;
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

/** Is a session restore still landing? True from the moment an end commits to restoring (before it
 *  awaits `whenUndoIdle`, so before `sceneManager` shows a pending load) until its swap is done. Any
 *  other snapshot taker must treat this as a world swap in progress (#1167) — see
 *  `playMode.aSceneSwapIsHappening`. */
export function isPreviewRestoreInFlight(): boolean {
  return _restoresInFlight > 0;
}

/** Resolves once no session restore is landing (immediately when none is). For an AUTHORED writer
 *  that must not run in that window: Exit has already cleared the session and set 'stopped', so a
 *  Cmd+S there passed every envelope check and serialized the still-POSED world (#1167 review). */
export function whenPreviewRestoresLanded(): Promise<void> {
  if (_restoresInFlight === 0) return Promise.resolve();
  return new Promise<void>((resolve) => { _restoreWaiters.push(resolve); });
}

/** Capture a gesture's liveness; the returned check turns false at the next `cancelPreviewGestures`. */
export function capturePreviewGesture(): () => boolean {
  return gestureLiveness.capture();
}

/** Cancel every in-flight preview gesture — called by ⏹ Exit, an asset switch, the Timeline panel's
 *  unmount, and toolbar Stop, so a chain still waiting on its restore does not reopen over them. */
export function cancelPreviewGestures(): void {
  gestureLiveness.invalidateAll();
}

/** Is a preview session currently held (snapshot pending restore)? */
export function hasTimelinePreviewSession(): boolean {
  return _snap !== null;
}

/** Is a live `begin` still serializing its snapshot? Distinct from a held session: nothing has
 *  been posed yet, but a pose is chained onto it. */
export function isPreviewSessionPending(): boolean {
  return _pending !== null && _pendingLive();
}

/** Is the live world inside SOME envelope a pose may be written into — a held preview session, or
 *  full Play (#1546)?
 *
 *  A pose writes authored trait values, so it needs something that will put them back. In Play that
 *  is Play's own snapshot: Stop reverts every write made while playing, a pose included, and saving
 *  is refused for the whole of Play. So a pose during Play goes STRAIGHT into the Play world and
 *  opens no preview session. It used to open one — `enterScrubMode` no-ops in Play but the begin did
 *  not — and that session snapshotted the RUNNING world, outlived Stop (which ends only Play's
 *  envelope), and later restored the Play world as if it were authored: on ⏹ Exit, on the Cmd+S
 *  cycle, or on the next Play press. Every pose-guard asks this, so the two envelopes can never nest.
 *
 *  A PAUSED Play counts (run mode `'playing'`, not advancing): Play's snapshot is still held. Play STARTING UP does not — it reads `'stopped'`
 *  until the snapshot is taken, and `holdPreviewSessionsClosed` refuses a begin for that window. */
export function poseEnvelopeHeld(): boolean {
  return _snap !== null || getRunMode() === 'playing';
}

/** Refuse every begin until the returned release is called. `enterPlay` holds this across its
 *  startup: a session opened after its hand-off restore and before `'playing'` would snapshot a
 *  world Play is about to own, and nothing would ever end it (#1546). It refuses NEW begins only —
 *  one already serializing is cancelled by the takedown that follows (`cancelPendingPreviewBegins`). */
export function holdPreviewSessionsClosed(): () => void {
  _closedHolds++;
  let released = false;
  return () => { if (!released) { released = true; _closedHolds--; } };
}

/** Cancel a `begin` still serializing, so it seats nothing and the pose chained onto it never runs.
 *  For a teardown that finds NO held session to end — an end already does this itself. */
export function cancelPendingPreviewBegins(): void {
  beginLiveness.invalidateAll();
}

/** Begin a preview session: snapshot the authored world ONCE (idempotent, so Pause→resume keeps
 *  the original authored snapshot to revert to — never re-snapshots the preview-mutated world).
 *
 *  Idempotence has to cover the IN-FLIGHT window too, not just `_snap`: a scrub drag calls this
 *  once per pointermove, and `serializeScene()` is async — so two moves before the first snapshot
 *  resolves both saw `_snap === null` and the second one serialized an ALREADY-POSED world and
 *  overwrote the authored snapshot with it, silently making Exit revert to the pose. Concurrent
 *  callers now await the same promise, and the resolver only seats a snapshot if none landed.
 *
 *  **Resolves `true` only when a session is held**, and every caller must honour `false` by posing
 *  nothing and handing back the run mode it claimed. `false` means one of:
 *   - **a restore is in progress** (#1167, owner-settled: refuse, not wait). The ending session has
 *     already cleared `_snap`, so a begin here would serialize the still-POSED world as the new
 *     "authored" snapshot, and the next Exit would restore a pose. Waiting instead was declined: the
 *     pose that follows would aim at entity ids resolved before the swap. The same window already
 *     refuses every undo/redo (`beginPreviewRestore`, #1148); a drag simply poses again on its next
 *     move once the restore has landed.
 *   - **an end intervened** while the snapshot was serializing (see `endTimelinePreviewSession`).
 *   - **Play is running or starting** (#1546) — see `poseEnvelopeHeld` for where that pose goes.
 *  A pose after `false` is unrevertible and unguarded, since the run mode is (or is about to be)
 *  back at 'stopped'. A thrown `serializeScene` still rejects. */
export async function beginTimelinePreviewSession(): Promise<boolean> {
  // FIRST, ahead of the held-session answer: a preview session and Play never coexist (#1546). In
  // Play the pose goes into Play's own envelope — see `poseEnvelopeHeld`.
  if (getRunMode() === 'playing' || _closedHolds > 0) return false;
  // A failed restore left the world possibly posed: snapshotting it would launder the pose (#1548).
  if (lastRestoreFailed()) return false;
  if (_snap) return true;
  if (_pending && _pendingLive()) { await _pending; return _snap !== null; }
  if (_restoresInFlight > 0) return false;
  const stillLive = beginLiveness.capture();
  // ⚠️ Sample the edit-version BEFORE the await, not after. `serializeScene()` is async, and an
  // authored edit landing during it may or may not be in `snap` — but folding its bump into the
  // baseline unconditionally makes `previewHasAuthoredEdits()` answer FALSE, which is the unsafe
  // direction: the save then cycles the envelope, restores a snapshot that predates the edit, and
  // writes the pre-edit world reporting success. Sampling first can only over-report (refuse a save
  // that would have been fine), which costs a keystroke instead of the edit.
  const version = getEditVersion();
  // Marked from HERE, before the await, for the same reason `version` is sampled here: an edit
  // landing during `serializeScene()` may or may not be in the snapshot, and dropping its entry on
  // restore can only cost an undo, where keeping a stale one writes a posed value on undo.
  const session = ++_undoSessionSeq;
  setPreviewUndoSession(session);
  const mine: Promise<void> = (async () => {
    const snap = await captureAuthoredSnapshot();
    // Only seat it if no session end intervened (see endTimelinePreviewSession).
    if (!_snap && stillLive()) { _snap = snap; _side = capturePreviewSideState(); _snapEditVersion = version; }
  })().finally(() => {
    // Only its OWN slot: a begin made after an Exit cancelled this one may already hold `_pending`.
    if (_pending === mine) _pending = null;
    // No snapshot seated (serialize threw, or an end intervened): there is no session for the mark to
    // belong to, and nothing will ever restore — so edits from here on are authored.
    if (!_snap) clearPreviewUndoSession(session);
  });
  _pending = mine;
  _pendingLive = stillLive;
  await mine;
  return _snap !== null;
}

/** End the session. Clears the active flag + any skeletal seeks. When `restore`, revert the world
 *  to the authored snapshot (like Stop) and — because the reload rebuilds the world with new
 *  entity ids — run the caller's `rebind` and return the freshly-resolved root id (or null) so the
 *  panel can re-point at its Director/Animator. `rebind` is a callback rather than a timeline path
 *  because BOTH preview panels end sessions here and each resolves its own root. No-op restore
 *  when the scene changed since the snapshot. */
export async function endTimelinePreviewSession(opts: { restore: boolean; rebind?: () => number | null }): Promise<number | null> {
  // #1164: taken synchronously, before anything else. Panels call this WITHOUT awaiting and flip the
  // run mode to 'stopped' on the next line, so without the token that flip would count as settled
  // and a deferred hot reload would start a load under the restore below — see `authoringSettle.ts`.
  const releaseReplacement = beginWorldReplacement();
  try {
    return await endSessionHoldingReplacement(opts);
  } finally {
    releaseReplacement();
  }
}

async function endSessionHoldingReplacement(opts: { restore: boolean; rebind?: () => number | null }): Promise<number | null> {
  // ⚠️ Invalidate any in-flight `begin` FIRST. `beginTimelinePreviewSession` seats its snapshot on
  // `if (!_snap)` alone, so a begin still awaiting `serializeScene()` when the envelope is exited
  // used to seat a session AFTERWARDS — and the pose chained onto it then ran with run-mode back at
  // 'stopped', where the next save serializes the posed world into the scene file and says "Scene
  // saved". Exiting during that window is not exotic: it is pressing ⏹ or switching clips within
  // the tens of ms a real scene takes to serialize.
  beginLiveness.invalidateAll();
  setTimelinePreviewActive(false);
  clearSkeletalSeeks();
  clearControlSpawns(); // preview-spawned prefabs are discarded by the snapshot reload below
  const snap = _snap;
  const session = _undoSessionSeq;
  _snap = null;
  // Before the world branch below, and whichever way it goes (#1551): a restore:false end, or one
  // for a scene that has since changed, still ends the session whose actions changed these stores.
  releaseSideState();
  // `currentSceneKey`, NOT the editor's file path: prefab-edit nulls that path on purpose, and the
  // restore used to reload under `''` — dropping the editor out of prefab-edit (#1547).
  if (!opts.restore || !snap || snap.key !== currentSceneKey()) {
    // No restore (or a snapshot for a different scene — don't clobber): the world keeps the session's
    // edits, so their entries stay valid, and pushes from here on are authored.
    clearPreviewUndoSession(session);
    return null;
  }
  // From here until the drop, every undo/redo is refused and the session's mark stays on (#1148
  // review): an edit pushed while the restore is awaiting lands in the posed world the swap throws
  // away, so it must be marked and dropped like the rest, and no undo step may start against a world
  // that is about to be replaced — see `beginPreviewRestore`.
  beginPreviewRestore(session);
  // Taken in the same synchronous run as `_snap = null` above, so no begin can observe the gap (#1167).
  _restoresInFlight++;
  let reverted = false;
  try {
    // Let an undo/redo that was ALREADY running finish against the posed world — see `whenUndoIdle`.
    await whenUndoIdle();
    // ⚠️ Re-check the path AFTER that wait: a scene opened meanwhile must not have this snapshot
    // loaded over it (the check above ran before the yield).
    if (currentSceneKey() !== snap.key) return null;
    await restoreAuthoredSnapshot(snap);
    reverted = true;
  } finally {
    // Released first: a throw from the drop must not leave every later begin refused for good.
    _restoresInFlight--;
    if (_restoresInFlight === 0 && _restoreWaiters.length) {
      const waiters = _restoreWaiters;
      _restoreWaiters = [];
      notifyListeners(waiters, 'timelinePreview:restoresLanded', []);
    }
    // The restore discarded every scene edit made during this session; their undo entries go with
    // them, or an undo after Exit writes a posed value into the authored scene (#1148).
    finishPreviewRestore(session, { drop: reverted });
  }
  return opts.rebind?.() ?? null;
}

function releaseSideState(): void {
  const side = _side;
  _side = null;
  if (side) restorePreviewSideState(side);
}

/** A world swap this module did not make ends the session WITHOUT a restore (#1546).
 *
 *  The snapshot belongs to the world that just went away: its restore would either no-op (a
 *  different scene — the path guard) or put the OLD scene back over the new one (a same-path reload).
 *  Leaving it held was worse than useless — every pose-guard read "session held", so both panels'
 *  fast paths went on posing the NEW world with the run mode already back at 'stopped' (a scene load
 *  sets it), where a save bakes the pose. The Timeline panel dropped it from its own swap handler,
 *  but only while mounted and only for its own previews; this is the one place that sees every swap.
 *
 *  Our OWN restore swaps the world too, and needs no exclusion: by then `_snap` is already null and
 *  the end invalidated every pending begin, so the early return below takes it. */
onWorldSwap(() => {
  if (!_snap && !isPreviewSessionPending()) return;
  beginLiveness.invalidateAll();
  _snap = null;
  // The world is not put back, but the audio/prefs/tier the session's actions changed are (#1551):
  // an `engine.loadScene` fired by ▶ is exactly the swap that lands here.
  releaseSideState();
  // Nothing will restore: the scene edits made during the session live on in no world at all, and
  // edits from here on are authored.
  clearPreviewUndoSession(_undoSessionSeq);
});

// A held session means the live world may carry a pose; a restore in flight means it still does until
// the swap lands — including the gap BEFORE the load starts, where the mode already reads 'stopped'
// (a panel's ⏹ Exit flips it without awaiting the restore). Every disk writer asks (#1548).
registerPosedWorldSource('a preview session is open', () => _snap !== null);
registerPosedWorldSource('a preview restore is still landing', () => _restoresInFlight > 0);
