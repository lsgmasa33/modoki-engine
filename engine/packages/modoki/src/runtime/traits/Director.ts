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
 *  `stepSimulation`. `lastTime`/`started` are runtime read-back (never serialized): the
 *  timeline system uses `lastTime` for edge detection and `started` to fire the once-only
 *  sequence-start fan-out. */
export const Director = trait({
  timeline: '' as string,   // GUID of the .timeline.json asset
  time: 0 as number,        // current playhead in seconds
  speed: 1 as number,       // playback rate multiplier
  playing: true as boolean,
  loop: false as boolean,   // repeat vs. clamp at duration
  // Runtime read-back (runtimeOnly, not serialized). `lastTime` = the previous frame's
  // playhead, used to edge-detect markers/cues/spans over (lastTime, time]. `started` =
  // whether the sequence-start fan-out has fired for this playthrough.
  lastTime: 0 as number,
  started: false as boolean,
});
