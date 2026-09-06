/**
 * One build-pipeline job at a time, per project (#173, cross-process closed by #650).
 *
 * `/api/build` runs a multi-step pipeline against the open project: a vite compile into
 * `<project>/dist`, then `cap sync` copying that dist into the native project's bundled assets, then
 * xcodebuild/gradle. Nothing serialized it. Two pipelines interleaving is mostly LOUD — two
 * xcodebuilds fight over DerivedData, the SSE logs interleave into nonsense — but there is one quiet
 * failure worth preventing: build B rewriting `dist` while build A's `cap sync` reads it copies a
 * TORN bundle into `ios/`, and A then succeeds. A signed app containing half a JS bundle is a bug
 * that surfaces on the device, hours after the build that caused it.
 *
 * ── Two layers: in-process AND cross-process ──
 * #170 already fixed the gesture that made this one click away (the Build menu refuses while a build
 * is active). What the in-process flag (`acquireBuild`, below) alone still catches: an AGENT firing
 * `modoki_build` while the human's build runs — both arrive at the SAME backend process, so a
 * module-level flag closes it, fast, with no filesystem I/O.
 *
 * It cannot see across a process boundary, and there are two of those. A second editor PROCESS on
 * the same project (a packaged editor beside a dev one) is the case this docblock used to point at
 * `deviceClaims.ts`/#173 and defer as "the rarer half". The other — closed by #650 — is a CLI
 * script: `build-web.mjs`, `add-native-targets.mjs`, `ota-publish.mjs` are not an exotic case but a
 * DOCUMENTED, recommended entry point (`docs/build.md`) that compiles the byte-identical
 * `<project>/dist`, and a hand-run one racing the editor's own OTA publish ships a torn bundle to
 * every installed device with no review step in between.
 *
 * Both are closed by `acquireBuildSlot` (below), which takes a CROSS-PROCESS claim
 * (`../../scripts/buildClaimsStore.mjs`) ALONGSIDE the in-process flag. An editor route holds
 * BOTH — see `acquireBuildSlot`'s own comment for why they are two separate layers rather than one
 * merged check. A CLI script holds only the cross-process claim (it has no in-process flag to share
 * with anything, being its own process). See `buildClaimsStore.mjs`'s header for the claim file's
 * mechanics and why a build claim's lock/TTL windows differ from a device claim's.
 *
 * ── Refuse, don't queue ──
 * A build runs for minutes and nothing can cancel one. A queued SSE stream would sit silent for that
 * whole time with no way out, which reads as a wedged editor. Refusing immediately, naming what is
 * already running and since when, is the answer the caller can act on. The three CLI scripts follow
 * the same rule for the same reason — a scripted build must not hang on an interactive editor.
 *
 * Pure and process-local on purpose: the route holds no state of its own, so this module IS the
 * state, and it stays unit-testable without an HTTP server.
 */

import { acquireBuildClaim } from '../../scripts/buildClaimsStore.mjs';

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
  | { ok: false; held: ActiveBuild; message: string }
  /** A cross-process UNKNOWN passed through from `acquireBuildClaim` (its claims file exists but
   *  couldn't be read/parsed) — there is no holder to name, only a message. See
   *  `acquireBuildSlot`'s own handling below. `held?: undefined` (rather than omitting the key) so
   *  callers can narrow on `held`'s truthiness the same way they already narrow on `ok`. */
  | { ok: false; held?: undefined; message: string };

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

/** Take BOTH the in-process slot and the cross-process claim (#650) — the pair an editor route
 *  should hold, so a CLI script (a separate process, invisible to `acquireBuild` above) is refused
 *  too, and a CLI is refused right back by this same claim when an editor build is running.
 *
 *  A SEPARATE function from `acquireBuild` rather than a change to it: `acquireBuild` stays the
 *  pure, fast, in-process-only primitive, unit-tested on its own (`buildLock.test.ts`) with no
 *  filesystem I/O — this composes it WITH the cross-process claim, rather than replacing it, so a
 *  same-process conflict (an agent's `modoki_build` racing a human's build) still resolves without
 *  ever touching disk.
 *
 *  Order matters. The in-process check runs FIRST because it is free, and because its own refusal
 *  wording ("in this editor") stays correct precisely because `acquireBuild` can only ever observe a
 *  build THIS backend process started (see `describeBuildConflict`'s comment). Only once that passes
 *  do we touch the filesystem for the cross-process claim; a refusal there is worded by
 *  `buildClaimsStore.mjs`'s own `describeBuildClaimConflict`, which — unlike this module's — knows
 *  how to say "another editor process" or "a command-line build" and names the pid.
 *
 *  On a cross-process refusal, the in-process slot just taken is released again immediately:
 *  otherwise this backend would believe IT has a build running even though the OVERALL acquisition
 *  failed, and would wrongly refuse its own very next attempt with "in this editor" — a confusing
 *  self-refusal for something that never actually started. */
export function acquireBuildSlot(label: string, projectRoot: string, now: number = Date.now()): AcquireResult {
  const local = acquireBuild(label, now);
  if (!local.ok) return local;
  // `acquireBuildClaim` can THROW rather than return a refusal (e.g. `~/.modoki` is uncreatable, or
  // its lock is genuinely wedged — buildClaimsStore.mjs's `withLock`) — a real failure taking the
  // cross-process claim, not a conflict with another build. Without this try/catch that throw would
  // propagate past the point below that releases `local`, leaving the in-process slot held for the
  // life of this backend process: `active` is a module-level variable, so every LATER build would
  // then wrongly refuse "in this editor" until a restart, over a build that never actually started.
  let cross: ReturnType<typeof acquireBuildClaim>;
  try {
    cross = acquireBuildClaim(projectRoot, label, { kind: 'editor', now });
  } catch (e) {
    local.release();
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  if (!cross.ok) {
    local.release();
    // UNKNOWN (no `held` — the cross-process claims file couldn't be read) passes through as-is:
    // there is no holder to name, only the refusal message. See `AcquireResult`'s own comment.
    if (!cross.held) return { ok: false, message: cross.message };
    return { ok: false, held: { label: cross.held.label, startedAt: cross.held.at }, message: cross.message };
  }
  return {
    ok: true,
    // Both layers were acquired together, so they are released together, through the ONE function
    // `releasePolicy` wraps — that is what makes "released on exactly the same signals, exactly
    // once" true for the cross-process claim too, with no separate wiring in the routes.
    //
    // `try { cross.release() } finally { local.release() }`, not two bare statements: `cross` is
    // `buildClaimsStore.mjs`'s own release, which is documented to warn-and-swallow rather than
    // throw (a failed cross-process release must never crash the caller) — but this composed
    // release must not depend on that staying true forever. If `cross.release()` ever DID throw,
    // a bare `cross.release(); local.release();` would skip `local.release()` entirely, leaving
    // `active` set for the life of this backend process: every later build would then wrongly
    // refuse "in this editor" until a restart, over a build that actually finished. The `finally`
    // guarantees the in-process slot is always freed, independent of how the cross-process side
    // behaves.
    release: () => { try { cross.release(); } finally { local.release(); } },
  };
}

/** The refusal text for an IN-PROCESS conflict. Names the platform and how long it has been going —
 *  enough to decide between waiting and going to look at the other editor window. Mentions that
 *  nothing cancels a build, because the natural next question is "can I stop it?" and the answer is
 *  no.
 *
 *  Scoped to "in this editor" ON PURPOSE, and that stays TRUE even after #650: `active` is a
 *  module-level variable, so the only conflict `acquireBuild` can ever observe is one this SAME
 *  backend process started. A cross-process conflict (another editor process, or a CLI script) is a
 *  different kind of holder this function never sees — that refusal is worded by
 *  `buildClaimsStore.mjs`'s own `describeBuildClaimConflict` and surfaces through
 *  `acquireBuildSlot` below, not through this function. */
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
