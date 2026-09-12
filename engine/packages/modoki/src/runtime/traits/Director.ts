import { trait } from 'koota';

/** Director — plays a `.timeline.json` sequence against this entity and its descendants.
 *
 *  The PlayableDirector analog. `timeline` is a GUID referencing a `.timeline.json` asset
 *  (resolved via the asset manifest); the entity carrying the Director is the binding root,
 *  and every track targets a descendant by relative name-path (same model as `Animator` +
 *  `.anim.json`). Switch/scrub the sequence via `time`; `playing` gates advance; `speed`
 *  scales the playhead; `loop` wraps vs. clamps at `duration`.
 *
 *  The playhead advances on the DETERMINISTIC sim delta (`getSimDelta`), so markers / audio
 *  cues / activation edges land on exact ticks and the whole sequence is reproducible under
 *  `stepSimulation`. `lastTime`/`started` are runtime read-back (never serialized).
 *
 *  ⚠️ **`started` is load-bearing; `lastTime` is not, and this docblock used to claim otherwise.**
 *  `timelineSystem` reads `started` (`justStarted = !dir.started`, plus a skip on a non-advancing
 *  first frame) to fire the once-only sequence-start fan-out. It WRITES `lastTime` every advancing
 *  frame and **reads it nowhere** — verified repo-wide, #1093 — because the edge-detection window
 *  is `(prev, cur]` where `prev` is taken from `time`, not from `lastTime`. The old wording ("the
 *  timeline system uses `lastTime` for edge detection") sent a seek implementation looking for a
 *  replay bug that cannot happen. Keep writing it for inspection; do not build a guard on it. */
export const Director = trait({
  timeline: '' as string,   // GUID of the .timeline.json asset
  time: 0 as number,        // current playhead in seconds
  speed: 1 as number,       // playback rate multiplier
  playing: true as boolean,
  loop: false as boolean,   // repeat vs. clamp at duration
  // Runtime read-back (runtimeOnly, not serialized). `lastTime` = the previous frame's playhead,
  // kept for inspection only — nothing reads it (see the docblock). `started` = whether the
  // sequence-start fan-out has fired for this playthrough, and IS read.
  lastTime: 0 as number,
  started: false as boolean,
});
