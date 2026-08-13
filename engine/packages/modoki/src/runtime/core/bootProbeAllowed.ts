/** bootProbeAllowed — whether this build may spend launch time measuring the device.
 *
 *  Pushed from the app bootstrap, exactly like `setDebugHandlesEnabled` / `setJournalEnabled`.
 *  **The one build that must say no is a PLAYABLE AD** (#221 W2 item 5).
 *
 *  ── WHY A FLAG RATHER THAN THE EXISTING GATES ─────────────────────────────────────────────
 *  The plan recorded this as "'one config ⇒ no probe' covers most of it; make it explicit", and
 *  "most of it" is the problem — both halves of that sentence are load-bearing and neither is
 *  sufficient:
 *
 *    - **The single-config short-circuit is a PROJECT's choice, not the ad format's.** It fires
 *      only when the project authored exactly one tier config. A playable exported from a project
 *      with two (which is the scaffolder's default, and every project in this repo) reaches the
 *      probe like anything else.
 *    - **The measure-and-log path does not consult it at all.** A tier answered cheaply — by GPU
 *      identity or the iOS model table — still runs the whole probe for EVIDENCE when
 *      `areDebugHandlesEnabled()`, and **ten projects ship `build.debugBuild: true`**. So the
 *      worst case is precisely the likely one: a playable built from a debug-flagged project pays
 *      the full probe and then throws the verdict away.
 *
 *  ⚠️ **AND THE COST OF THAT GREW BY 3x ON 2026-08-13**, which is why this stopped being tidiness:
 *  the probe now repeats itself within one launch to settle immediately (#221 W2 item 2), so the
 *  measured bill on real phones went from ~550 ms to **1.6-1.8 s** of blocked launch. In an ad
 *  creative, launch time IS the product — a network measures time-to-interaction and a viewer
 *  measures patience, and neither is spending it on a measurement whose only consumer is a tier
 *  the ad will not live long enough to benefit from.
 *
 *  ── WHAT A PLAYABLE GETS INSTEAD ──────────────────────────────────────────────────────────
 *  Every cheaper layer still runs: a player pin, a project pin, the single-config short-circuit,
 *  the iOS model table, GPU identity. Only the fallback measurement is refused, so a playable on
 *  recognised hardware is completely unaffected — it was never reaching the probe. On unrecognised
 *  hardware it resolves as `calibrating` and the live calibration loop corrects it within seconds,
 *  which is the same degrade path the plan already accepts for the stale-data tail.
 *
 *  ⚠️ **DEFAULTS TO TRUE, deliberately.** A build that never calls the setter behaves exactly as it
 *  did before this flag existed. The failure mode of the opposite default is silent and expensive:
 *  every non-playable build would stop measuring, every unrecognised device would sit on
 *  `calibrating`, and nothing would error. */

let _allowed = true;

/** Set by the app bootstrap — `!__MODOKI_PLAYABLE__`. */
export function setBootProbeAllowed(allowed: boolean): void {
  _allowed = allowed;
}

/** Whether the boot ramp probe may run in this build. */
export function isBootProbeAllowed(): boolean {
  return _allowed;
}
