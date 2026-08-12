/** Frame Driver — single requestAnimationFrame loop with priority-ordered callbacks.
 *  Replaces multiple independent rAF loops to guarantee deterministic execution order:
 *  ECS pipeline (0) → Three.js render (10) → PixiJS render (20). */

import { rawNow } from '../core/clock';
import { recordFrame, setProfilerFrameCap } from '../core/frameProfiler';
import { beginProfilerFrame, endProfilerFrame, profileScope } from '../core/profilerMarkers';
import { recordMarkerFrame } from '../core/profilerAggregate';
import { captureFrame } from '../core/profilerCapture';
import { recordCounterFrame } from '../core/profilerCounters';
import { pollGpuTimings } from '../core/gpuTimings';

type FrameCallback = () => void;

export const PRIORITY_ECS = 0;
export const PRIORITY_RENDER_3D = 10;
export const PRIORITY_RENDER_2D = 20;
export const PRIORITY_EDITOR_3D = 30;
export const PRIORITY_EDITOR_2D = 40;

/** Target FPS cap. Set to 0 for uncapped (uses display refresh rate). */
export let targetFPS = 60;
/** ⚠️ The cap is told to the PROFILER here and nowhere else. `runFrame` skips the whole callback
 *  pass before `recordFrame` runs, so a capped loop's measured `frameMs` is this interval rather
 *  than the display's — and a profiler that does not know that reports a device obeying its cap as
 *  a device missing its budget, which disabled tier promotion fleet-wide (see
 *  `frameProfiler.frameCapIntervalMs`). Every source of the cap — project config and a quality
 *  tier — goes through this one setter, so a source added later cannot bypass it. */
export function setTargetFPS(fps: number) { targetFPS = fps; setProfilerFrameCap(fps); }

const callbacks = new Map<string, { cb: FrameCallback; priority: number }>();
let sorted: { key: string; cb: FrameCallback }[] = [];
let dirty = false;
let rafId = 0;
let refCount = 0;
let lastFrameTime = 0;

/** True while a rAF chain is armed. Tracked SEPARATELY from `refCount` because the two
 *  can disagree — that disagreement IS the wedge this module now detects and repairs:
 *  a positive refCount (callers believe frames are pumping) with a dead chain renders
 *  the editor alive-but-frozen, with no exception and no log. */
let loopArmed = false;
/** Generation token for the armed chain. A re-arm bumps it so any older `frame()`
 *  continuation that was actually still pending retires itself instead of running a
 *  second, duplicate loop (which would double-step every system). */
let loopGen = 0;
/** Timestamp of the most recent EXECUTED frame; 0 if none has run since the chain was armed.
 *  Deliberately NOT touched by `armLoop()`: the watchdog re-arms a stalled chain, and if a
 *  re-arm reset this clock the health report would flicker back to "running" every couple of
 *  seconds during a real outage — the recovery would hide the very symptom it is reporting. */
let lastFrameAt = 0;
/** Timestamp of the last arm. Gives a newly-armed chain a grace period before the watchdog
 *  can call it stalled, without contaminating `lastFrameAt`'s meaning. */
let armedAt = 0;

/** ms since the loop last made progress — a real frame, or the arm that is still awaiting
 *  its first one. This is what the watchdog judges; `msSinceLastFrame` (reported) always
 *  measures from the last REAL frame. */
function msSinceProgress(): number {
  return rawNow() - Math.max(lastFrameAt, armedAt);
}

/** ms since the last real frame executed. */
function msSinceRealFrame(): number {
  return rawNow() - (lastFrameAt || armedAt);
}

// Per-callback consecutive-throw counts; after MAX_CONSECUTIVE_ERRORS we drop it
// to stop log floods. Cleared when a callback runs successfully.
const errorCounts = new Map<string, number>();
const MAX_CONSECUTIVE_ERRORS = 10;

// FPS tracking — updated once per second inside the frame loop.
let _currentFPS = 0;
let _fpsFrameCount = 0;
let _fpsLastSample = 0;
/** Current frames-per-second (integer, updated once per second).
 *  The sample is only refreshed from inside `frame()`, so a chain that dies mid-second
 *  would otherwise keep reporting its last healthy number forever. Report 0 once the
 *  loop has visibly stalled, so `fps` never lies about liveness. */
export function getCurrentFPS(): number {
  if (loopArmed && msSinceRealFrame() >= STALL_MS) return 0;
  return _currentFPS;
}

export function registerFrameCallback(key: string, cb: FrameCallback, priority: number) {
  callbacks.set(key, { cb, priority });
  dirty = true;
}

export function unregisterFrameCallback(key: string) {
  callbacks.delete(key);
  dirty = true;
}

function rebuildSorted() {
  sorted = [...callbacks.entries()]
    .map(([key, v]) => ({ key, cb: v.cb, priority: v.priority }))
    .sort((a, b) => a.priority - b.priority)
    .map(r => ({ key: r.key, cb: r.cb }));
  dirty = false;
}

/** Build the rAF callback for generation `gen`. Only the CURRENT generation keeps
 *  rescheduling itself, so re-arming a chain that turns out to still be alive costs one
 *  wasted frame rather than permanently double-stepping every registered system. */
function makeFrame(gen: number) {
  const frame = (now: DOMHighResTimeStamp) => { runFrame(now, gen, frame); };
  return frame;
}

function runFrame(now: DOMHighResTimeStamp, gen: number, self: FrameRequestCallback) {
  if (gen !== loopGen) return; // superseded chain — retire silently
  rafId = requestAnimationFrame(self);
  // Read through `rawNow()` rather than storing the rAF timestamp, so this shares ONE clock
  // with `armedAt` and the watchdog. They agree in the browser anyway, but under an injected
  // manual clock (headless tests) the rAF stamp would drift from `rawNow()` and the watchdog
  // would judge liveness against a clock nothing else uses.
  lastFrameAt = rawNow();
  if (targetFPS > 0) {
    const interval = 1000 / targetFPS;
    if (now - lastFrameTime < interval) return;
    lastFrameTime = now - ((now - lastFrameTime) % interval);
  }
  _fpsFrameCount++;
  if (now - _fpsLastSample >= 1000) {
    _currentFPS = _fpsFrameCount;
    _fpsFrameCount = 0;
    _fpsLastSample = now;
  }
  if (dirty) rebuildSorted();
  // Profiler-plan P2 — attribute the frame to its named units of work. The callbacks are ALREADY
  // named and priority-ordered ('ecs', the Scene3D/Scene2D/SceneView keys, …), so this is what
  // turns "48ms of an 83ms frame was CPU" into "31ms ECS, 12ms 3D, 5ms 2D" for one wrapper call.
  // No-ops to a single branch when markers are disabled.
  beginProfilerFrame();
  for (const entry of sorted) {
    try {
      // profileScope is exception-safe (try/finally), so a callback that throws — which the
      // catch below treats as routine — still closes its span and cannot unbalance the stack.
      profileScope(entry.key, entry.cb);
      if (errorCounts.has(entry.key)) errorCounts.delete(entry.key);
    } catch (err) {
      const n = (errorCounts.get(entry.key) ?? 0) + 1;
      errorCounts.set(entry.key, n);
      console.error(`[frameDriver] callback "${entry.key}" threw (${n}/${MAX_CONSECUTIVE_ERRORS}):`, err);
      if (n >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`[frameDriver] auto-unregistering "${entry.key}" after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`);
        unregisterFrameCallback(entry.key);
      }
    }
  }
  // #121 P2 — frame-time profiling. `lastFrameAt` is this frame's start (read through the same
  // `rawNow()` clock above), so CPU cost is that to HERE: the end of every engine callback, which
  // is exactly the span the low-end investigation measured at ~48 ms of an 83 ms frame. Two
  // clock reads and a ring write, deliberately unconditional — an intermittent boot-time hitch
  // is not reproducible on demand after flipping a flag. A throwing callback is already caught
  // above, so its cost is still counted rather than skipping the frame entirely.
  endProfilerFrame();
  // Fold this frame's tree into the aggregation window (P3). No-ops when markers are off.
  recordMarkerFrame();
  // Counters share the marker frame boundary so a counter and a timing read on the same
  // screen describe the same span (P9). Rate counters reset here; levels persist.
  recordCounterFrame();
  // Frame capture (P6) reuses the timings recordFrame just computed rather than keeping its own
  // `prevFrameStart` — two copies of that state would drift the moment either side changed its
  // discontinuity handling, and a capture would then silently disagree with the live profile.
  const { frameMs, cpuMs } = recordFrame(lastFrameAt, rawNow());
  captureFrame(frameMs, cpuMs); // no-ops unless someone pressed record
  // P7 — kick a GPU timestamp resolve. Placed AFTER the frame's work and deliberately never
  // awaited: the results are asynchronous by nature (a buffer map), and awaiting one on the frame
  // loop would introduce exactly the stall this instrument was built to find. No-ops to one
  // boolean test when GPU timing is off, which is the default.
  pollGpuTimings();
}

/** Arm a fresh rAF chain, superseding any previous one. Idempotent in effect: the old
 *  generation retires itself on its next tick. */
function armLoop() {
  loopGen++;
  loopArmed = true;
  // Grace period for the new chain; `lastFrameAt` is left alone on purpose (see its docs).
  armedAt = rawNow();
  rafId = requestAnimationFrame(makeFrame(loopGen));
  startWatchdog();
}

function disarmLoop() {
  loopGen++; // invalidate the in-flight continuation as well as cancelling the pending id
  loopArmed = false;
  cancelAnimationFrame(rafId);
  stopWatchdog();
}

// ── Stall watchdog ────────────────────────────────────────────────────────────────────
// The frame loop is the editor's heartbeat: when it dies, EVERYTHING downstream fails
// silently — no systems tick, so trusted input no-ops with no error; nothing renders, so
// a screenshot fails deep in Chromium with an opaque compositor error; and the play state
// still reads "playing"/advancing because those are run-MODE flags, not liveness. This
// watchdog is the one place that can tell "frozen" from "fine", so it both repairs the
// common case and records the diagnosis for `modoki_get_editor_state` to surface.

/** A chain that has not ticked for this long, while the document is visible and callers
 *  still hold a start ref, is not slow — it is dead. Three seconds is far beyond any
 *  legitimate frame time (a measured focused editor runs ~14ms frames; a heavy WGSL compile
 *  stalls hundreds of ms, not thousands), and it also clears the ~1fps rate Chromium
 *  throttles an OCCLUDED-but-still-"visible" window to, which `documentHidden()` cannot
 *  detect on macOS. That headroom matters: a false "stalled" report would be exactly the
 *  kind of noise that teaches people to ignore this signal. */
const STALL_MS = 3000;
const WATCHDOG_INTERVAL_MS = 1000;
/** How many failed re-arms we LOG before going quiet. Re-arming itself never stops: it is a
 *  single requestAnimationFrame call, and giving up would mean a chain that stays dead even
 *  after the environment recovers (a GPU process that came back, a window that was restored).
 *  Only the log floods, so only the log is capped. */
const MAX_REPORTED_ATTEMPTS = 3;

let watchdogId: ReturnType<typeof setInterval> | undefined;
let recoveryAttempts = 0;
let recoveredCount = 0;
let stalledSince: number | null = null;

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function checkStall() {
  // A hidden window legitimately gets no rAF callbacks — that is throttling, not a wedge.
  // Treat it as healthy and reset, so un-hiding does not immediately trip the watchdog.
  if (!loopArmed || refCount === 0 || documentHidden()) {
    stalledSince = null;
    recoveryAttempts = 0;
    return;
  }
  const since = msSinceProgress();
  if (since < STALL_MS) {
    stalledSince = null;
    recoveryAttempts = 0;
    return;
  }
  if (stalledSince === null) stalledSince = lastFrameAt;
  recoveryAttempts++;
  if (recoveryAttempts <= MAX_REPORTED_ATTEMPTS) {
    console.error(
      `[frameDriver] FRAME LOOP STALLED — no frame for ${Math.round(since)}ms with ${refCount} ` +
      `active start ref(s) and ${callbacks.size} registered callback(s), document visible. ` +
      `The editor is alive but not pumping frames: no ECS system ticks, nothing renders, and ` +
      `trusted input will silently no-op. Re-arming the requestAnimationFrame chain ` +
      `(attempt ${recoveryAttempts}).` +
      (recoveryAttempts === MAX_REPORTED_ATTEMPTS
        ? ' Further attempts will continue SILENTLY — read frameLoop.status in the editor state.'
        : ''),
    );
  }
  recoveredCount++;
  armLoop();
}

function startWatchdog() {
  if (watchdogId !== undefined) return;
  if (typeof setInterval !== 'function') return;
  watchdogId = setInterval(checkStall, WATCHDOG_INTERVAL_MS);
  // Never hold a Node/test process open on account of the heartbeat monitor.
  (watchdogId as unknown as { unref?: () => void }).unref?.();
}

function stopWatchdog() {
  if (watchdogId === undefined) return;
  clearInterval(watchdogId);
  watchdogId = undefined;
  stalledSince = null;
  recoveryAttempts = 0;
}

/** Health of the frame loop — the signal that distinguishes "running fine" from "playing
 *  but not pumping". Surfaced through `modoki_get_editor_state.frameLoop` so an agent
 *  never has to infer a wedge from `fps: 0` plus a failed screenshot again.
 *
 *  `status`:
 *   - `'running'`  — chain armed and ticking.
 *   - `'hidden'`   — armed, but the document is hidden, so rAF is throttled by the browser.
 *                    Expected, not a fault; screenshots of this window will also fail.
 *   - `'idle'`     — nothing holds a start ref, so no frames are being pumped at all. Legal
 *                    (no viewport is mounted) but indistinguishable from a wedge to a caller
 *                    that expects the scene to be running, so it is reported rather than
 *                    hidden behind `fps: 0`.
 *   - `'stalled'`  — armed with live start refs, document visible, no frame for >2s. The
 *                    wedge. `recoveryAttempts` says whether self-repair has been tried. */
export interface FrameLoopHealth {
  status: 'running' | 'hidden' | 'idle' | 'stalled';
  refCount: number;
  callbacks: number;
  armed: boolean;
  fps: number;
  /** ms since the last executed frame (rounded). */
  msSinceLastFrame: number;
  /** How many times the watchdog has re-armed a stalled chain this session. */
  recovered: number;
  recoveryAttempts: number;
  /** Present only when stalled — a ready-to-read explanation, so the failure describes
   *  itself instead of making the reader reconstruct it from three separate fields. */
  detail?: string;
}

export function getFrameLoopHealth(): FrameLoopHealth {
  const msSinceLastFrame = Math.round(loopArmed ? msSinceRealFrame() : 0);
  // Judged on the REAL frame clock, so a watchdog re-arm cannot flip this back to "running"
  // while the outage is ongoing.
  const stalled = loopArmed && refCount > 0 && !documentHidden() && msSinceLastFrame >= STALL_MS;
  const status: FrameLoopHealth['status'] = stalled ? 'stalled'
    : (!loopArmed || refCount === 0) ? 'idle'
    : (documentHidden() ? 'hidden' : 'running');
  const health: FrameLoopHealth = {
    status,
    refCount,
    callbacks: callbacks.size,
    armed: loopArmed,
    fps: _currentFPS,
    msSinceLastFrame,
    recovered: recoveredCount,
    recoveryAttempts,
  };
  if (status === 'idle') {
    health.detail =
      'No frames are being pumped: nothing currently holds a frame-driver start ref, so the ' +
      'ECS pipeline is not ticking and nothing is rendering. This is normal only if no ' +
      'viewport is mounted; if a Scene or Game panel IS on screen, its render effect failed ' +
      'to start (check the console for a renderer-init error).';
  }
  if (stalled) {
    health.detail =
      `The frame loop has not ticked for ${msSinceLastFrame}ms while ${refCount} caller(s) ` +
      `believe it is running. Nothing is rendering and no ECS system is ticking, so play/pause ` +
      `state, trusted input and screenshots are ALL unreliable right now. The watchdog has ` +
      `re-armed the rAF chain ${recoveryAttempts} time(s) without success so far; it keeps ` +
      `retrying, but if this persists the renderer or GPU process is gone — relaunch the editor.`;
  }
  return health;
}

/** Test-only: reset all module state so a suite can exercise start/stop in isolation. */
export function __resetFrameDriverForTests() {
  disarmLoop();
  callbacks.clear();
  sorted = [];
  dirty = false;
  refCount = 0;
  recoveredCount = 0;
  recoveryAttempts = 0;
  lastFrameAt = 0;
  armedAt = 0;
  _currentFPS = 0;
  _fpsFrameCount = 0;
  _fpsLastSample = 0;
  lastFrameTime = 0;
}

/** Start the driver. Ref-counted — multiple callers can start without conflict.
 *
 *  NOTE the arm condition is `!loopArmed`, NOT `++refCount === 1`. Those are not the same
 *  thing, and assuming they were is what made the frozen-editor bug unrecoverable: once the
 *  chain died with refCount still positive, every subsequent startFrameDriver() took the
 *  "already running" branch and returned without scheduling anything, so no amount of
 *  panel remounting could ever restart frames. Arming on the chain's actual state makes
 *  start() a genuine repair operation. */
export function startFrameDriver() {
  refCount++;
  if (!loopArmed) armLoop();
}

/** Stop the driver. Only actually stops when all callers have stopped. */
export function stopFrameDriver() {
  if (refCount === 0) {
    // Unbalanced stop: a cleanup ran for a start that never happened (a bailed-out async
    // init, a Fast Refresh that skipped an []-deps setup but still ran its teardown). The
    // OLD code let refCount go negative here and cancelled a chain other callers still
    // depended on — a silent freeze. Refuse, and say so.
    console.warn('[frameDriver] stopFrameDriver() with refCount already 0 — ignoring the ' +
      'unbalanced stop (a start/stop pair is mismatched; frames are left running).');
    return;
  }
  if (--refCount === 0) disarmLoop();
}

/** Run all callbacks once synchronously (for editor step button). */
export function stepOneFrame() {
  if (dirty) rebuildSorted();
  for (const entry of sorted) {
    try { entry.cb(); }
    catch (err) { console.error(`[frameDriver] step "${entry.key}" threw:`, err); }
  }
}
