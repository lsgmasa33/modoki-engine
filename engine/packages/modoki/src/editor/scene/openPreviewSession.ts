/** Open the preview SESSION for a pose the caller is about to make — and pose nothing when none opens.
 *
 *  The caller has already claimed its run mode (`enterScrubMode(owner)`), synchronously, because the
 *  snapshot is async. The session is what makes that claim safe, so when `beginTimelinePreviewSession`
 *  resolves `false` or throws, the pose must NOT run, and the mode goes back:
 *   - **`false`** — a restore is still landing (#1167, refused rather than awaited: the pose would aim
 *     at an entity id resolved before the swap, and the next scrub move poses normally), or an Exit
 *     intervened while the snapshot serialized.
 *   - **a throw** — used to escape as an unhandled rejection with the mode pinned at `scrub`: Cmd+S
 *     blocked and nothing to revert. `poseClipAtTime` guards the same wedge on the Animation side.
 *
 *  A plain module rather than a helper inside `TimelineEditor.tsx`, so the decision carries a unit
 *  test (docs/editor.md § Panels). `exitPreviewMode` is owner-guarded, so handing back a mode another
 *  panel has since taken is a no-op. */

import { beginTimelinePreviewSession, hasTimelinePreviewSession, isPreviewSessionPending } from './timelinePreview';
import { enterScrubMode, enterPreviewMode, exitPreviewMode, getModeOwner } from './playMode';

/** Hand `owner`'s mode claim back after its begin opened nothing — unless a NEWER begin is live.
 *
 *  A begin that opened nothing was usually cancelled: its envelope ended while the snapshot
 *  serialized. A click made after that end claims the mode again and starts its own begin, and this
 *  refusal can land while the new begin is still serializing. Handing the mode back then takes the
 *  newer click's claim, and leaving the envelope cancels that begin too (#1569), so the click would
 *  pose nothing. A live pending begin is always the newer one, because a begin joins a live one
 *  instead of starting its own, and it resolves its own claim when it lands. `exitPreviewMode` is
 *  owner-guarded, so another panel's claim was never at risk here. */
export function handBackPreviewClaim(owner: 'animation' | 'timeline'): void {
  if (!isPreviewSessionPending()) exitPreviewMode(owner);
}

/** Resolves `true` once `pose` has run inside a held session; `false` when nothing was posed. */
export function openPreviewSessionThen(owner: 'animation' | 'timeline', pose: () => void): Promise<boolean> {
  return beginTimelinePreviewSession().then(
    (opened) => {
      if (!opened) { handBackPreviewClaim(owner); return false; }
      pose();
      return true;
    },
    (e: unknown) => {
      handBackPreviewClaim(owner);
      console.error(`[preview:${owner}] could not open the preview session — nothing posed`, e);
      return false;
    },
  );
}

/** Open the session for a ▶ playthrough, claiming the mode FIRST: a frozen `preview`, which the
 *  caller turns into an advancing one once its loop starts.
 *
 *  The Timeline ▶ used to begin with no claim and take the mode only after the snapshot landed. A
 *  teardown in that gap (closing the panel, switching timelines) then found the mode already
 *  `stopped` and no session held, so it cancelled nothing, and the begin seated a session nobody
 *  owned, with no ⏹ to end it (#1569). With the claim made first, that teardown's
 *  `exitPreviewMode` leaves the envelope, and leaving it cancels the begin. A Pause in the gap
 *  keeps the frozen claim, so the session seats as a paused preview, which is what a Pause means.
 *
 *  Resolves `true` only when a session is held. A refusal or a thrown snapshot hands the claim back
 *  (unless a newer begin owns it, see `handBackPreviewClaim`), so ▶ never leaves the mode pinned.
 *  The Animation ▶ claims its own mode before its begin, so it does not need this. */
export async function openPlaybackSession(owner: 'animation' | 'timeline'): Promise<boolean> {
  enterPreviewMode(false, owner);
  let opened = false;
  try {
    opened = await beginTimelinePreviewSession();
  } catch (e) {
    console.error(`[preview:${owner}] could not open the preview session — ▶ not started`, e);
  }
  if (!opened) handBackPreviewClaim(owner);
  return opened;
}

/** Reopen the envelope after a gesture's OWN restore — the Timeline's "grab the playhead while ▶ is
 *  playing" chain, which reverts the forward run and then scrubs from the authored world.
 *
 *  Two things this chain got wrong, both found by #1167's close-out review:
 *   - **It re-claims scrub itself** rather than trusting the claim made before the restore. A drag
 *     move landing DURING that restore is refused and hands the mode back to `stopped`; the reopen
 *     then posed under `stopped` — a session held, Cmd+S baking the pose, the ⏹ button hidden.
 *   - **It reopens only while the gesture is still live** (`isLive` — `capturePreviewGesture()`, cancelled
 *     by Exit, an asset switch, the panel's unmount and toolbar Stop). An Exit pressed during the restore finds no snapshot and
 *     restores nothing, and the chain used to reopen anyway, silently undoing that Exit.
 *  A restore that throws hands the mode back instead of escaping as an unhandled rejection. `pose`
 *  should read the LATEST playhead: moves refused during the restore still moved it. */
export async function reopenPreviewAfterRestore(
  owner: 'animation' | 'timeline', restore: Promise<unknown>, isLive: () => boolean, pose: () => void,
): Promise<boolean> {
  try {
    await restore;
  } catch (e) {
    exitPreviewMode(owner);
    console.error(`[preview:${owner}] the restore before reopening the preview failed — nothing posed`, e);
    return false;
  }
  if (!isLive()) return false;
  enterScrubMode(owner);
  return openPreviewSessionThen(owner, pose);
}

// ── Which panel may act on the SHARED envelope (#1549) ──────────────────────────────────────────
//
// The session and the run mode are single globals both panels read. Each panel used to decide "is
// this mine?" from a different piece of state — the Timeline from the run mode alone (so it
// registered its Cmd+S handler and showed ⏹ for an ANIMATION envelope, and its handler then won the
// save), the Animation panel from a hand-kept `useState` that some exits never reset. Every such
// decision now reads the one owner field, through these, so the two panels cannot answer differently.

/** Does `me` hold the envelope — show ⏹, register a Cmd+S handler, drive the status text? */
export function panelOwnsEnvelope(me: 'animation' | 'timeline'): boolean {
  return getModeOwner() === me;
}

/** May `me` END the shared session (opening/switching its own asset)? Its own, or an orphan nobody
 *  owns — never the other panel's, whose world a restore would swap out from under it. */
export function mayEndSharedSession(me: 'animation' | 'timeline'): boolean {
  const owner = getModeOwner();
  return owner === me || owner === null;
}

/** Should an undo/redo of `me`'s ASSET edit re-pose the world? Only into `me`'s own held session.
 *
 *  The closures used to pose unconditionally, and a pose OPENS the envelope — so Cmd+Z of a clip edit
 *  after ⏹ Exit (or with the panel closed) silently re-entered scrub: Cmd+S refused "exit the
 *  preview" with no ⏹ anywhere to press (#1550). An asset undo changes the asset; the world only needs
 *  re-posing when it is already showing a preview of it. */
export function undoMayRepose(me: 'animation' | 'timeline'): boolean {
  return ownsHeldSession(me);
}

/** Does `me` own the mode AND is a session actually held — i.e. is the live world `me`'s preview?
 *  The Animation record hook asks this before keying (#1550 close-out review): a recorded edit is
 *  preview-only ONLY if the envelope was open before the edit was written. */
export function ownsHeldSession(me: 'animation' | 'timeline'): boolean {
  return getModeOwner() === me && hasTimelinePreviewSession();
}
