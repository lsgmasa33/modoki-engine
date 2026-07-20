/** timelinePreview — editor-only "the Timeline panel is previewing forward" signal.
 *
 *  The engine gates all game side effects on `getPlayState() === 'playing'`: `dispatchGameAction`
 *  refuses to fire (so signal markers / `OnSequence` actions don't run) and `audioSystem` silences
 *  + discards every queued cue. That's correct for authoring — a stopped editor makes no sound and
 *  runs no game logic. But the Timeline panel's ▶ Preview is a genuine FORWARD playthrough of a
 *  cutscene: the user wants to see AND hear it (audio cues, camera/text signals, `OnSequence`)
 *  without entering full Play (which would also run physics/input/all gameplay).
 *
 *  This flag threads that needle. While the panel's preview loop advances, it sets the flag; the two
 *  gates (`dispatchGameAction`, `audioSystem`) treat "previewing" like "playing" so those specific
 *  effects run — but `getPlayState()` stays `'stopped'`, so `runPipeline` still skips the whole
 *  simulation tier (< TRANSFORM) and the rest of the sim stays inert. The panel snapshots the
 *  authored world before preview and reverts it on stop/scrub (mirroring editor Play/Stop), so the
 *  unbounded mutations a signal action can make never reach disk. Cleared on pause / end / scrub /
 *  panel unmount. A shipped game never sets it, so behaviour is unchanged there.
 *
 *  It is ALSO force-cleared on any world swap (below): if the user loads a different scene while a
 *  preview loop is mid-flight, the editor effect (keyed on store fields, not the world) wouldn't
 *  tear down — leaving this flag stuck on so `audioSystem` autoplays and `dispatchGameAction` fires
 *  in the freshly-loaded, still-STOPPED scene. Resetting on swap closes those gates immediately. */

import { onWorldSwap } from '../ecs/world';

let _active = false;

/** Set by the Timeline panel each preview frame while the forward loop is advancing (false on
 *  pause / end / scrub / unmount). */
export function setTimelinePreviewActive(active: boolean): void {
  _active = active;
}

/** True while the Timeline panel is actively previewing forward — opens the `dispatchGameAction`
 *  and `audioSystem` gates so signal/audio/OnSequence effects fire with the sim otherwise stopped. */
export function isTimelinePreviewActive(): boolean {
  return _active;
}

// A mid-preview scene load must not leave the gates open on the newly-loaded, stopped scene.
onWorldSwap(() => { _active = false; });
