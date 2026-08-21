/** Pose a bound rig at a time in a clip — the write that `AnimationEditor`'s scrub gesture makes,
 *  extracted so it is not trapped inside a React component.
 *
 *  WHY IT LIVES HERE. `modoki_set_playhead` writes the editor's playhead NUMBER and nothing else;
 *  its own description says so, and a render taken after it shows the UNCHANGED pose. The path
 *  that actually poses was `AnimationEditor.scrub` → `pose` → `applyPose`, three `useCallback`s
 *  inside a panel — so an agent could move the playhead and could not pose the rig (#288 gap 2).
 *  QA-ANIM-0002 worked around it by writing `Animator.time` directly, which happens to work only
 *  because `animationSystem` samples every frame regardless of `playing`.
 *
 *  EXTRACTED, not re-derived. Every dependency below was already module-level or store state —
 *  the only component-local piece was `setInPreview`, a `useState` driving the ⏹ Exit button, and
 *  that stays at the call site. Re-implementing the pose instead would have recreated the bug in
 *  the envelope note below; sharing the code cannot. It also means the pose works with NO Animation
 *  panel mounted, which is what removes the whole "the agent can pose only if the human happens to
 *  have the panel open" cliff.
 *
 *  ⚠️ THE PREVIEW ENVELOPE IS THE LOAD-BEARING PART. A pose writes AUTHORED trait values into the
 *  live world. The session snapshot is what ⏹ Exit reverts to, and the `scrub` run-mode is what
 *  stops `saveScene` writing the pose into the scene FILE. A pose outside it is both unrevertible
 *  and unguarded — measured, not theoretical (owner, 2026-08-19, `games/3d-test`): one Cmd+S after
 *  a keyframe edit silently rewrote `2D Animation.scene.json`'s Circle 2D x/y and Square 2D color
 *  to the clip's t=0 values. So `applyPoseAtTime` REFUSES when no session is held, and
 *  `poseClipAtTime` opens one first. Keeping both here means a future path that poses cannot
 *  forget, which is the same reason the envelope-opening moved into `pose` in the first place.
 */

import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { fireDirtyListeners } from '../../runtime/core/ecs/entityUtils';
import { applyClipAtTime } from '../../runtime/animation/sampleClip';
import { applyClipDeform } from '../../runtime/animation/deform2DSystem';
import { beginDeform2DFrame } from '../../runtime/animation/deform2DBuffers';
import type { AnimationClipDef } from '../../runtime/animation/types';
import { useEditorStore } from '../store/editorStore';
import { enterScrubMode, exitPreviewMode, getModeOwner } from '../scene/playMode';
import { beginTimelinePreviewSession, endTimelinePreviewSession, hasTimelinePreviewSession } from '../scene/timelinePreview';
import { resolveAnimatorRootForClip } from '../panels/openAssetInEditor';

/** Write the clip's sampled values into the bound entities. Returns how many channels applied.
 *
 *  **Never call this directly** — go through `poseClipAtTime`, which guarantees the preview
 *  envelope is open first. Exported only so the panel's own `applyPose` can share it.
 *
 *  Refuses (returns 0) with no session held, rather than warning and posing anyway: a rig that
 *  visibly fails to pose is a bug report, while a scene silently rewritten to a preview frame is
 *  what actually cost the owner data. */
export function applyPoseAtTime(clip: AnimationClipDef | null, rootId: number | null, t: number): number {
  if (!clip || rootId == null) return 0;
  if (!hasTimelinePreviewSession()) {
    console.error(
      '[poseClip] refused to pose with no preview session held — the pose would be unrevertible ' +
      'and a scene save would bake it. Every pose must go through poseClipAtTime.',
    );
    return 0;
  }
  try {
    // applyClipAtTime writes trait values via bulk entity.set (bypassing writeTraitField), so
    // nothing marks the viewport/Inspector dirty. Signal it ourselves — same as a gizmo drag — or
    // the SceneView won't redraw and preview playback looks frozen.
    const w = getCurrentWorld();
    // New deform epoch, then scalar tracks + deform channels, so a scrubbed clip previews
    // cloth/cape deformation exactly as it plays at runtime. (No-op fast path for scalar clips.)
    beginDeform2DFrame();
    const applied = applyClipAtTime(w, rootId, clip, t) + applyClipDeform(w, rootId, clip, t);
    if (applied > 0) fireDirtyListeners();
    return applied;
  } catch (e) {
    // Most failures here are transient: a scene swap can leave `rootId` pointing at a
    // not-yet-resolvable entity for a frame. Don't crash the preview rAF — but don't
    // blanket-swallow either, or a genuine sampler regression manifests as a silently frozen
    // preview with no diagnostic. Log at debug so it's visible when looked for.
    console.debug('[poseClip] pose failed (world not ready or sampler error)', e);
    return 0;
  }
}

/** Pose INSIDE the preview envelope, opening it first if it is not already held.
 *
 *  `owner` names the panel that claims the scrub run-mode when this call OPENS the envelope, so
 *  the editor's "exit preview to save" message names something meaningful.
 *
 *  ⚠️ **The run-mode is claimed ONLY on the opening branch, and that asymmetry is deliberate.** An
 *  earlier cut called `enterScrubMode` on both, reasoning that the owner should be re-claimed even
 *  when someone else opened the envelope — which is exactly what `AnimationEditor.scrub` wants, and
 *  it already does it itself before calling here. But this is also the function the panel's ▶
 *  PREVIEW rAF loop drives, once per frame, after `enterPreviewMode`. Claiming scrub on the fast
 *  path would have downgraded preview → scrub sixty times a second for the whole of playback.
 *  A caller that wants the re-claim asks for it; this one only establishes the mode it opens.
 *
 *  The session begin is async — it serializes the authored world — so a first pose lands a tick
 *  later. That is deliberate and is what keeps the snapshot free of the very pose it is meant to
 *  revert. Callers that need to observe the result must await this. */
export async function poseClipAtTime(
  clip: AnimationClipDef | null, rootId: number | null, t: number, owner: 'animation' | 'timeline' = 'animation',
): Promise<{ applied: number; openedSession: boolean }> {
  if (!clip || rootId == null) return { applied: 0, openedSession: false };
  if (hasTimelinePreviewSession()) {
    return { applied: applyPoseAtTime(clip, rootId, t), openedSession: false };
  }
  enterScrubMode(owner);
  try {
    await beginTimelinePreviewSession();
  } catch (e) {
    // ⚠️ The run-mode is claimed SYNCHRONOUSLY on the line above, and the snapshot is what makes
    // it safe. If the snapshot fails (`serializeScene` throwing on a bad trait, a mid-flight I/O
    // error) an unguarded throw leaves the editor pinned at `scrub` with NO session — Cmd+S
    // blocked, and nothing to revert, which is the wedge this whole module exists to avoid. Hand
    // the mode back before rethrowing so the failure costs the caller a retry, not their editor.
    exitPreviewMode(owner);
    throw e;
  }
  return { applied: applyPoseAtTime(clip, rootId, t), openedSession: true };
}


// ── Leaving the envelope ────────────────────────────────────────────────────
//
// An agent that can OPEN the preview envelope and cannot close it wedges the editor: the envelope
// holds the run-mode at `scrub`, which is exactly what blocks the human's Cmd+S. So the exit is
// part of the capability, not a follow-up.

/** Notified whenever the envelope is closed through `exitPoseEnvelope`.
 *
 *  This exists for one concrete failure. `AnimationEditor` keeps an `inPreview` `useState` that
 *  gates its ⏹ button AND the registration of its Cmd+S save handler, whose `resume()` RE-POSES at
 *  the current playhead. Without this notification an agent-driven exit would leave that handler
 *  registered against a closed envelope — so the human's next save would suspend (a no-op),
 *  serialize, and then resume by re-posing a world the agent had just reverted. A surprise pose
 *  after a save is the same class of bug the envelope itself exists to prevent. */
const exitListeners = new Set<() => void>();

/** Subscribe to envelope exits. Returns the unsubscribe closure. */
export function onPoseEnvelopeExited(cb: () => void): () => void {
  exitListeners.add(cb);
  return () => { exitListeners.delete(cb); };
}

/** Close the animation preview envelope: revert the posed world to the authored snapshot (unless
 *  `restore` is false) and return the global run-mode to `stopped` so Cmd+S works again.
 *
 *  OWNERSHIP-GUARDED: a no-op unless the ANIMATION side holds the mode. Both the session and the
 *  run-mode are globals shared with the Timeline panel, and this runs from unmount / clip-switch
 *  effects that also fire while the Timeline owns a live preview — ending its session there would
 *  revert its world mid-run. (`exitPreviewMode` self-guards on owner; the session end does not,
 *  hence the explicit check.)
 *
 *  Resolves once the world has ACTUALLY been restored. Cmd+S awaits it and serializes immediately
 *  afterwards, so a fire-and-forget restore would let the save write the POSED world — the whole
 *  thing the envelope exists to prevent. */
export async function exitPoseEnvelope(restore: boolean): Promise<{ exited: boolean; rebound: number | null }> {
  if (getModeOwner() !== 'animation') return { exited: false, rebound: null };
  const store = useEditorStore.getState();
  store.setPreviewPlaying(false);
  let rebound: number | null = null;
  try {
    if (hasTimelinePreviewSession()) {
      const path = store.editingAnimationAsset?.path;
      // The restore rebuilds entities, so the bound root id can change underneath us — rebind by
      // resolving the clip again rather than trusting the id we came in with.
      rebound = await endTimelinePreviewSession({
        restore,
        rebind: () => (path ? resolveAnimatorRootForClip(path, { fallbackToSelection: false }) : null),
      });
      if (rebound != null) useEditorStore.getState().setAnimatorRoot(rebound);
    }
  } finally {
    // ⚠️ `finally`, not a straight line. `endTimelinePreviewSession` clears its snapshot BEFORE
    // awaiting the restore's `loadScene`, so a throw in there leaves no session — and an
    // unguarded rethrow would then skip both of these, pinning the run-mode at `scrub` (Cmd+S
    // blocked) while the panel's ⏹ button still believes it is previewing. Handing the mode back
    // and notifying is exactly what must survive a failed restore, because the failure is when
    // the editor most needs to be usable again.
    exitPreviewMode('animation');
    for (const cb of exitListeners) { try { cb(); } catch { /* a bad listener must not block the exit */ } }
  }
  return { exited: true, rebound };
}
