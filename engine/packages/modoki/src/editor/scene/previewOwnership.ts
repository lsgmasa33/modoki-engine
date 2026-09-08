/** Which panel drives the shared ▶ preview (#810 follow-up).
 *
 *  `isPreviewPlaying` is ONE editor-store flag and BOTH the Timeline and Animation panels key
 *  their preview effects on it, so a single ▶ press starts both. Each then calls
 *  `enterPreviewMode` and takes the single-valued `RunMode` from the other — harmless ownership
 *  churn until #810 gave displacement real teeth, after which the loser's rAF is stopped. The
 *  Timeline ALWAYS lands second (its entry sits behind an awaited `beginTimelinePreviewSession()`),
 *  so it always won and always stopped the Animation panel's loop; with no timeline doc open its
 *  own tick then early-returns every frame, so pressing ▶ in the Animation panel played NOTHING.
 *
 *  The fix is to record WHICH panel's ▶ started the preview (`editorStore.previewOwner`) and let
 *  only that panel drive it. This lives in its own module, not inline in the two `.tsx` panels,
 *  per `docs/editor.md` § Panels: a panel's DECISIONS belong in a plain `.ts` module beside it,
 *  which is where the unit test goes — inline, deleting the gate would fail nothing.
 *
 *  It sits in `scene/` rather than `panels/` because the STORE needs it too: `closeTimelineEditor`
 *  and `closeAnimationEditor` clear the shared flag themselves, so they are ownership decisions
 *  wearing a store action's clothes. That was missed on the first two sweeps — the panels were
 *  guarded and the store actions behind them were not — and the #810 E2E is what caught it. */
export type PreviewOwner = 'timeline' | 'animation';

/** True when `me` should RUN its preview loop for the current store state.
 *
 *  Strict: an unclaimed preview (`owner === null`) drives NOTHING. An earlier cut let either panel
 *  drive when unclaimed, to keep a programmatic `setPreviewPlaying(true)` working — but that is
 *  #810 verbatim on that path (both panels run, the Timeline lands second, wins the mode and stops
 *  the other's loop), and the e2e it was written for asserts `isSkeletalPreviewing() === false`,
 *  which passes either way. So the fallback protected nothing and re-armed the bug; every caller
 *  names its panel instead, and `setPreviewPlaying` warns in DEV if one does not. Nothing playing
 *  is the safe failure here; two panels fighting over a single-valued RunMode is not. */
export function panelDrivesPreview(
  playing: boolean,
  owner: PreviewOwner | null,
  me: PreviewOwner,
): boolean {
  return playing && owner === me;
}

/** True when `me` may STOP the shared preview — a panel unmounting, or clearing a stale flag.
 *
 *  Deliberately the permissive twin of `panelDrivesPreview`: unclaimed state (`owner === null`)
 *  IS this panel's to clean up, or an untagged `setPreviewPlaying(true)` would strand
 *  `isPreviewPlaying` true forever with nothing able to clear it.
 *
 *  ⚠️ The reason this exists at all: `isPreviewPlaying` is shared, so an unguarded
 *  `setPreviewPlaying(false)` in a panel's unmount cleanup stops the OTHER panel's playback.
 *  Closing an idle Timeline tab killed a running Animation preview — the same defect
 *  `panelDrivesPreview` fixes, wearing the opposite face, and one the fix's first cut missed
 *  because it swept only the two preview effects and not the teardown paths that write the flag.
 *  `editor/animation/poseClip.ts` already guards the same globals with `getModeOwner()`. */
export function panelMayStopPreview(owner: PreviewOwner | null, me: PreviewOwner): boolean {
  return owner === null || owner === me;
}
