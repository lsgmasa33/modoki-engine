/** Capture mode — the gameplay recorder (#1479) is running on this page.
 *
 *  A take is source footage for an ad, so anything that is chrome rather than gameplay — a banner-ad
 *  placeholder, a debug affordance — should not be in it. The ENGINE cannot know what a game draws
 *  as chrome, so it only says that a capture is running; each game's own seam decides what to hide
 *  (Court's and Weaveling's `adBannerShown`).
 *
 *  Two phases, and the difference matters to exactly one kind of reader:
 *  - `'recording'` — the owner is PLAYING the take in the editor. Games hide their capture chrome
 *    here too, because hiding it can move the layout and the recorded positions must match what
 *    will be rendered. But the owner is watching: engine debug surfaces (error toasts) stay up.
 *  - `'rendering'` — the headless replay is drawing the video. Nothing but gameplay belongs in the
 *    frame; the renderer collects page errors into its report instead. */

export type CaptureMode = 'off' | 'recording' | 'rendering';

let mode: CaptureMode = 'off';

/** True while a take is being recorded OR rendered — the question a game's chrome asks. */
export function isCaptureMode(): boolean {
  return mode !== 'off';
}

/** Which phase of a capture is running, for a reader that must tell them apart. */
export function getCaptureMode(): CaptureMode {
  return mode;
}

/** Enter a capture phase, or leave it with `'off'`. Only the recorder and its replay driver call this. */
export function setCaptureMode(next: CaptureMode): void {
  mode = next;
}
