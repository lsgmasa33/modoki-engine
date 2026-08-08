/**
 * One build-pipeline job at a time, per backend process (#173).
 *
 * `/api/build` runs a multi-step pipeline against the open project: a vite compile into
 * `<project>/dist`, then `cap sync` copying that dist into the native project's bundled assets, then
 * xcodebuild/gradle. Nothing serialized it. Two pipelines interleaving is mostly LOUD — two
 * xcodebuilds fight over DerivedData, the SSE logs interleave into nonsense — but there is one quiet
 * failure worth preventing: build B rewriting `dist` while build A's `cap sync` reads it copies a
 * TORN bundle into `ios/`, and A then succeeds. A signed app containing half a JS bundle is a bug
 * that surfaces on the device, hours after the build that caused it.
 *
 * ── Why in-process, when the issue names cross-process cases too ──
 * #170 already fixed the gesture that made this one click away (the Build menu refuses while a build
 * is active). What remains reachable is an AGENT firing `modoki_build` while the human's build runs —
 * and both arrive at the same backend process, so a module-level flag closes it. The other case in
 * the issue — two editor PROCESSES on one project (a packaged editor beside a dev one) — needs a
 * cross-process claim on the filesystem, the shape `deviceClaims.ts` already implements. That is
 * deliberately NOT done here: it is the rarer half, it costs a refactor of a module that arbitrates
 * access to physical hardware, and no incident has ever been observed for either. The gap is recorded
 * on #173 rather than closed.
 *
 * ── Refuse, don't queue ──
 * A build runs for minutes and nothing can cancel one. A queued SSE stream would sit silent for that
 * whole time with no way out, which reads as a wedged editor. Refusing immediately, naming what is
 * already running and since when, is the answer the caller can act on.
 *
 * Pure and process-local on purpose: the route holds no state of its own, so this module IS the
 * state, and it stays unit-testable without an HTTP server.
 */

/** What is running right now, for the refusal message. */
export interface ActiveBuild {
  /** What is running, as a noun phrase for the refusal message — 'ios build', 'OTA publish',
   *  'android native scaffold'. A plain string, not the route's platform union: the slot is shared
   *  by three routes that are not all builds, and the union would only fit one of them. */
  label: string;
  /** Epoch ms. Formatted only where a human reads it. */
  startedAt: number;
}

let active: ActiveBuild | null = null;

/** The in-flight build, or null. Read-only view — acquiring is the only way to set it. */
export function activeBuild(): ActiveBuild | null {
  return active;
}

export type AcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; held: ActiveBuild; message: string };

/** Take the build slot, or refuse naming the build that has it.
 *
 *  The returned `release` is IDEMPOTENT and only ever clears the acquisition it belongs to. Both
 *  matter: the route releases from `res.on('close')`, which fires on a normal end AND on a client
 *  disconnect, and a stale closure from a finished build must never be able to free a LATER build's
 *  slot — that would silently re-open the collision this module exists to prevent. */
export function acquireBuild(label: string, now: number = Date.now()): AcquireResult {
  if (active) return { ok: false, held: active, message: describeBuildConflict(active, now) };
  const mine: ActiveBuild = { label, startedAt: now };
  active = mine;
  return {
    ok: true,
    release: () => { if (active === mine) active = null; },
  };
}

/** The refusal text. Names the platform and how long it has been going — enough to decide between
 *  waiting and going to look at the other editor window. Mentions that nothing cancels a build,
 *  because the natural next question is "can I stop it?" and the answer is no. */
export function describeBuildConflict(held: ActiveBuild, now: number = Date.now()): string {
  const mins = Math.max(0, Math.round((now - held.startedAt) / 60000));
  const when = new Date(held.startedAt).toLocaleTimeString();
  return `Another job is already running in this editor: ${held.label}, started ${when} (${mins} min `
    + 'ago). Builds, OTA publishes and native scaffolds all compile into the SAME <project>/dist, so '
    + 'running two at once lets one rewrite that dist while the other is copying it — producing an '
    + 'app, or an OTA bundle, with a torn JS bundle inside. So this is refused rather than shared. '
    + 'Wait for it to finish (nothing can cancel one) and try again.';
}

/** When the slot goes back, for a handler whose two halves stop at different times.
 *
 *  `/api/build` returns SYNCHRONOUSLY from six preflight gates (bad config, no iOS device, no team,
 *  no bucket, missing toolchain) that spawn nothing, and only then starts an async pipeline that
 *  does. Those two need DIFFERENT release signals, and conflating them is a real bug, not a
 *  tidiness point:
 *
 *   - Release the preflight paths on the response closing — they own no child process, so the
 *     response ending IS the end of the work, and one `close` handler covers all six plus a throw.
 *   - Release the pipeline when the PIPELINE stops. Using `close` there frees the slot the instant
 *     the client disconnects, while the step loop is still awaiting a spawned child — so a retry
 *     starting right then runs `npm run build` into `<project>/dist` alongside the dying build's own
 *     flush. Reachable through the editor's own force-reload: editing a game `.ts` reloads the page,
 *     which tears down the EventSource mid-build.
 *
 *  Both signals still fire in every run (a finished pipeline also closes its response), so the
 *  policy must be idempotent and order-independent — which is exactly what makes it worth a state
 *  machine with tests rather than a boolean in the route.
 *
 *  ⚠️ The guarantee is bounded by what "the pipeline stopped" can observe: the step's `bash` exiting.
 *  A compound step (`APP_PATH=$(…) && { … }`) forks rather than exec-replacing, so its grandchild
 *  outlives the SIGTERM and the slot is given back while that orphan still runs. Closing THAT means
 *  killing the process group — a change to every build step, not to this module (#176). See
 *  docs/build.md § "One build at a time". */
export interface ReleasePolicy {
  /** The HTTP response closed — a normal end, or the client disconnecting. */
  onResponseClose(): void;
  /** The async pipeline is about to spawn its first child. Must be called SYNCHRONOUSLY, before the
   *  first `await`, or a disconnect in that window sees an un-started pipeline and releases. */
  onPipelineStart(): void;
  /** The pipeline stopped — every step settled, or it returned/threw early. */
  onPipelineEnd(): void;
}

export function releasePolicy(release: () => void): ReleasePolicy {
  let started = false;
  let done = false;
  const fire = () => { if (!done) { done = true; release(); } };
  return {
    onResponseClose: () => { if (!started) fire(); },
    onPipelineStart: () => { started = true; },
    onPipelineEnd: fire,
  };
}

/** Test-only: drop any in-flight build so one test cannot leak state into the next. Never called by
 *  the route — a build that is genuinely running must not be forgettable. */
export function resetBuildLockForTests(): void {
  active = null;
}
