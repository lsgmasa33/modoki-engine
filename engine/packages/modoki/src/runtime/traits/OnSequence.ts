import { trait } from 'koota';

/** Declarative `Director` sequence reaction — the no-code path on top of the `TimelineEvents`
 *  manager. Put this on the SAME entity as a `Director`: when its timeline sequence STARTS or
 *  ENDS, the timeline system dispatches the named UIAction, passing the Director entity as
 *  `ctx.target` and `{ self }` in `ctx.params`.
 *
 *  The dispatch is pipeline-safe (`dispatchGameAction` — never throws on a missing handler,
 *  inert unless the sim is running), so an unwired action name is a warning, not a frame-
 *  aborting crash. Leave a field empty to react to only the other phase.
 *
 *  Per-marker reactions are authored on the timeline's SIGNAL tracks (each marker names its own
 *  action); `OnSequence` covers only the whole-sequence start/end. For richer reactions subscribe
 *  to the `timelineEvents` manager directly in code. */
export const OnSequence = trait({
  /** UIAction dispatched when the Director's sequence STARTS. */
  onStart: '' as string,
  /** UIAction dispatched when the Director's sequence reaches its END (non-looping). */
  onEnd: '' as string,
});
