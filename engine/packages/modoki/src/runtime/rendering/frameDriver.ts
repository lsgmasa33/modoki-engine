/** Frame Driver — single requestAnimationFrame loop with priority-ordered callbacks.
 *  Replaces multiple independent rAF loops to guarantee deterministic execution order:
 *  ECS pipeline (0) → Three.js render (10) → PixiJS render (20). */

import { createSupersessionToken, type LivenessCheck } from '../core/liveness';
import { rawNow } from '../core/clock';
import { recordFrame, setProfilerFrameCap } from '../core/frameProfiler';
import { beginProfilerFrame, endProfilerFrame, profileScope } from '../core/profilerMarkers';
import { beginBootSpan, endBootSpan, recordBootSpan } from '../core/bootTimeline';
import { recordMarkerFrame } from '../core/profilerAggregate';
import { captureFrame } from '../core/profilerCapture';
import { recordCounterFrame } from '../core/profilerCounters';
import { pollGpuTimings } from '../core/gpuTimings';
// Names the CAUSE (a lost GPU device) alongside the SYMPTOM this module reports (frames stopped
// pumping) — see `activeRenderer.ts:76`, which documents that link and the log-correlation gap
// it used to leave. `activeRenderer` imports only `three` types + `./clock`, so this is L2→L0
// (rendering → core) and adds no cycle.
import { getGpuFaultState, onRendererLost, type GpuFaultState } from '../core/activeRenderer';

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
/** Frames still to be recorded into the boot timeline (#238). A FIXED prefix — enough to show
 *  when rendering started relative to the load phases — deliberately short, because the prefix
 *  is the part that runs out at the wrong moment: measured on a Galaxy A23 cold boot of
 *  `games/3d-test`, 180 frames were consumed BEFORE the scene finished loading, so the 1,806 ms
 *  stall that followed had no frame span anywhere near it. The long-frame budget below is what
 *  actually covers the stall; this prefix is only context. */
let bootFramesLeft = 60;
let frameCounter = 0;
/** A frame this slow is recorded into the boot timeline whatever its index — the stall being
 *  hunted is 1.2-1.8 s, and the profiler's own discontinuity threshold is 1000 ms, so this sits
 *  well below both and still cannot fire on an ordinary frame (a 30 fps budget is 33 ms). */
const LONG_FRAME_MS = 120;
/** Long frames still recordable. Bounded so a permanently slow device cannot fill the timeline
 *  with them and push the phase spans off the cap; a boot has a handful, not hundreds. */
let longFramesLeft = 48;
let refCount = 0;
let lastFrameTime = 0;

/** True while a rAF chain is armed. Tracked SEPARATELY from `refCount` because the two
 *  can disagree — that disagreement IS the wedge this module now detects and repairs:
 *  a positive refCount (callers believe frames are pumping) with a dead chain renders
 *  the editor alive-but-frozen, with no exception and no log. */
let loopArmed = false;
/** Liveness token for the armed chain. A re-arm supersedes it, so any older `frame()`
 *  continuation that was actually still pending retires itself instead of running a second,
 *  duplicate loop (which would double-step every system). `disarmLoop` supersedes it too — with
 *  nothing — which retires the in-flight continuation as well as cancelling the pending id.
 *
 *  ⚠️ The check is THREADED as a value through `makeFrame`/`runFrame` rather than re-read from
 *  module scope, per docs/async-lifetime.md: carrying a raw number across a call boundary and
 *  re-comparing it in the callee is the one liveness shape no per-file scan can see, which is
 *  exactly what this was before #573 and why the architecture guard could not see it. */
const loopLiveness = createSupersessionToken();
/** Timestamp of the most recent EXECUTED frame; 0 if none has run since the chain was armed.
 *  Deliberately NOT touched by `armLoop()`: the watchdog re-arms a stalled chain, and if a
 *  re-arm reset this clock the health report would flicker back to "running" every couple of
 *  seconds during a real outage — the recovery would hide the very symptom it is reporting. */
let lastFrameAt = 0;
/** Timestamp of the last arm. Gives a newly-armed chain a grace period before the watchdog
 *  can call it stalled, without contaminating `lastFrameAt`'s meaning. */
let armedAt = 0;
/** True once the CURRENT arm's rAF callback has actually executed at least once. Set `false` by
 *  `armLoop()`, `true` by `runFrame()` right after the supersession check passes. This is the
 *  fact `checkStall()` needs to tell "the chain ran and then died" (a re-arm is legitimate) from
 *  "the outstanding rAF has never been delivered" (a re-arm would supersede the still-pending
 *  callback via `loopLiveness.begin()` — destructive, not just useless, if rAF is merely SLOW
 *  rather than dead: the supersession is what starves it permanently). */
let frameSinceArm = false;

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

/** Build the rAF callback bound to ONE chain, identified by the `stillCurrent` check it closes
 *  over. Only the current chain keeps rescheduling itself, so re-arming one that turns out to
 *  still be alive costs one wasted frame rather than permanently double-stepping every registered
 *  system. The check travels as a value rather than being re-read from module scope — see
 *  `loopLiveness` and docs/async-lifetime.md. */
function makeFrame(stillCurrent: LivenessCheck) {
  const frame = (now: DOMHighResTimeStamp) => { runFrame(now, stillCurrent, frame); };
  return frame;
}

function runFrame(now: DOMHighResTimeStamp, stillCurrent: LivenessCheck, self: FrameRequestCallback) {
  if (!stillCurrent()) return; // superseded chain — retire silently
  frameSinceArm = true; // this chain's rAF has now actually fired at least once since its arm
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
  // Boot timeline (#238): a short PREFIX of frames, for context the phase spans cannot give —
  // when rendering actually started relative to scene load, and how fast frames were before the
  // interesting moment. The stall itself is caught by the retroactive long-frame spans below,
  // not here; a prefix long enough to reach a stall is a prefix that crowds out the phase rows.
  const frameSpan = bootFramesLeft > 0 ? (bootFramesLeft--, beginBootSpan('frame', String(frameCounter))) : -1;
  frameCounter++;
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
  endBootSpan(frameSpan);
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
  // #238 — record a LONG frame into the boot timeline retroactively. Two DISTINCT spans, and the
  // distinction is the whole point: `frame-slow` is time inside our own callbacks, while
  // `frame-interval` is rAF-start to rAF-start and therefore ALSO covers time our callbacks were
  // not running — browser, GPU, compositor, or a promise continuation nothing here owns. Measured
  // on a Galaxy A23 cold boot of `games/3d-test`: the 1,755 ms stall is a `frame-interval` with
  // NO `frame-slow` inside it, which is what establishes it is not engine code — and the same
  // boot recorded one `frame-slow` (frame 234, 805 ms), so that absence is evidence, not silence.
  // One span could not have told those apart. `frameMs` is 0 on the first frame (no previous), and
  // recordFrame has already applied the discontinuity rules to the number.
  if (longFramesLeft > 0 && (cpuMs >= LONG_FRAME_MS || frameMs >= LONG_FRAME_MS)) {
    longFramesLeft--;
    // `frame-interval` is rAF-start to rAF-start — the SAME quantity `worstStallMs` reports, so
    // the stall itself becomes a row on the timeline instead of a number beside it. It contains
    // the PREVIOUS frame's callbacks, which is exactly why the second span is separate.
    if (frameMs >= LONG_FRAME_MS) recordBootSpan('frame-interval', lastFrameAt - frameMs, lastFrameAt, `before frame ${frameCounter - 1}`);
    // `frame-slow` is THIS frame's own callbacks. Read together: an interval of 1.8 s with no
    // `frame-slow` inside it means the time was not spent in engine code at all.
    if (cpuMs >= LONG_FRAME_MS) recordBootSpan('frame-slow', lastFrameAt, lastFrameAt + cpuMs, `frame ${frameCounter - 1}`);
  }
  // P7 — kick a GPU timestamp resolve. Placed AFTER the frame's work and deliberately never
  // awaited: the results are asynchronous by nature (a buffer map), and awaiting one on the frame
  // loop would introduce exactly the stall this instrument was built to find. No-ops to one
  // boolean test when GPU timing is off, which is the default.
  pollGpuTimings();
}

/** Arm a fresh rAF chain, superseding any previous one. Idempotent in effect: the old
 *  generation retires itself on its next tick. */
function armLoop() {
  const stillCurrent = loopLiveness.begin();
  loopArmed = true;
  frameSinceArm = false; // this arm's rAF has not fired yet
  // Grace period for the new chain; `lastFrameAt` is left alone on purpose (see its docs).
  armedAt = rawNow();
  rafId = requestAnimationFrame(makeFrame(stillCurrent));
  startWatchdog();
}

function disarmLoop() {
  loopLiveness.begin(); // supersede the in-flight continuation as well as cancelling the pending id
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
/** How many consecutive failed stall checks before the watchdog gives up entirely and declares
 *  the chain unrecoverable — ~12s of a rAF chain that never delivers again. That is far beyond
 *  any legitimate delivery gap (the slow-but-alive-rAF test below proves a genuinely slow chain
 *  recovers well before this fires) and matches the measured iOS WKWebView failure: after a
 *  WebGL context loss, JS/timers/the native bridge stay alive but `requestAnimationFrame` never
 *  delivers again (docs/plans/ios-rendering-update-wedge.md). Past this point re-arming has had
 *  its fair chances (see `checkStall()`'s escalation branch) and further silent retries would
 *  just be theatre. */
const UNRECOVERABLE_AFTER_ATTEMPTS = 4;

let watchdogId: ReturnType<typeof setInterval> | undefined;
let recoveryAttempts = 0;
let recoveredCount = 0;
let stalledSince: number | null = null;
/** Wall-clock time the CURRENT outage was first detected — `null` when healthy. This is the
 *  baseline `checkStall()`'s escalation cadence is measured from, and it is a SEPARATE clock
 *  from `stalledSince` deliberately: `stalledSince` holds `lastFrameAt` (a "which frame died"
 *  marker with no other reader), while this is a "when did WE notice" marker the escalation math
 *  needs. Re-baselining here — rather than measuring off the (possibly ancient) `lastFrameAt` —
 *  is what makes escalation take the same ~9s after detection whether the gap that preceded
 *  detection was 3s or 3 minutes. See the escalation comment in `checkStall()` for the bug this
 *  fixes (a discontinuity in `lastFrameAt` — backgrounding, device sleep, a long main-thread
 *  block — used to make `Math.floor(since / STALL_MS)` already be several STALL_MS units ahead
 *  of `recoveryAttempts` on the FIRST post-gap tick, and every tick after kept re-satisfying that
 *  same gap, so escalation fired every `WATCHDOG_INTERVAL_MS` instead of every `STALL_MS`). */
let outageDetectedAt: number | null = null;
/** How many times the watchdog has re-armed a stalled chain during the CURRENT outage —
 *  `recoveredCount`'s per-outage twin. `recoveredCount` is intentionally session-cumulative (see
 *  its own field on `FrameLoopHealth`), which is exactly wrong for `getFrameLoopHealth()`'s
 *  `detail` text: a brand-new outage's FIRST stall message would otherwise report however many
 *  times earlier, unrelated outages this session had already re-armed. Reset alongside
 *  `recoveryAttempts`. */
let outageRearms = 0;
/** True once `declareUnrecoverable()` has fired for the CURRENT outage. Cleared the moment a REAL
 *  frame proves the outage is over (`checkStall()`'s healthy branch) or the driver does a full
 *  stop/start cycle (`stopWatchdog()`) — NOT by merely going hidden or idle, which is throttling,
 *  not evidence of recovery. `activeRenderer`'s `isRecoveryAbandoned()` is the precedent this
 *  comment used to cite for "only `resetRecoveryState()` clears it" — that turned out to be the
 *  wrong model here: that flag tracks a WHOLE SESSION'S rebuild budget, deliberately sticky, while
 *  this one describes ONE outage and must end when the outage does, or a single false escalation
 *  (or a genuine transient one) silently disables the watchdog for the rest of the session — see
 *  `getFrameLoopHealth().status === 'running'` with `unrecoverable` still `true` before this fix,
 *  invisible to `agentEditorOps.ts`'s `frameLoopFields()` (omitted whenever status is `'running'`
 *  and `recovered === 0`) into the bargain. */
let unrecoverable = false;
/** Latched copy of `activeRenderer.getGpuFaultState()` at the moment `onRendererLost` fired,
 *  kept because reading `getGpuFaultState()` LIVE at report time is provably too late: the
 *  production sequence is `reportRendererLoss` -> `onRendererLost` -> `rendererRecovery` (a
 *  ~250ms delay) -> the viewport's `bringUp()` -> its own `attachUncapturedErrorListener`, which
 *  unconditionally does `gpuFaultState = null` for the NEW renderer (that reset moved off
 *  `setActiveRendererHandle` in #802, but it still happens on every viewport bring-up). Against the plan doc's own iPhone-8 trace the loss is at +1,136,882 and the stall
 *  fires at +1,139,989 — over a full STALL_MS later, long after that 250ms-delayed rebuild has
 *  already wiped the state this module used to read. Latching at the loss event, not at report
 *  time, is the only way the stall/unrecoverable report can still name the cause. Cleared when the
 *  outage it may be explaining ends (see `unrecoverable`'s comment) — it is not a running fault
 *  log, only a "what was implicated in THIS outage" pointer. */
let latchedGpuFault: GpuFaultState | null = null;
/** `lastFrameAt` at the moment `latchedGpuFault` was taken (`0` while no latch is held) — the
 *  "has a real frame executed since" discriminator `checkStall()`'s healthy branch uses to drop
 *  a latch left behind by a loss that RECOVERED IN PLACE (see there for why "time passed" or "a
 *  renderer rebuilt" are not safe substitutes). */
let latchedGpuFaultFrameAt = 0;
onRendererLost(() => { latchedGpuFault = getGpuFaultState(); latchedGpuFaultFrameAt = lastFrameAt; });

/** Info handed to an `onFrameLoopUnrecoverable` listener at the moment recovery is abandoned. */
export interface FrameLoopUnrecoverableInfo {
  /** How many consecutive stall checks it took to give up. */
  recoveryAttempts: number;
  /** ms since the last real frame executed, at the moment of declaration. */
  msSinceLastFrame: number;
  /** The GPU fault channel's state at declaration time, if any — names the cause alongside the
   *  symptom (`activeRenderer.ts:76`). */
  gpuFault: GpuFaultState | null;
}
const unrecoverableListeners = new Set<(info: FrameLoopUnrecoverableInfo) => void>();

/** Declare the frame loop permanently dead: the outstanding rAF has not been delivered across
 *  `UNRECOVERABLE_AFTER_ATTEMPTS` watchdog checks, and re-arming provably cannot repair it (see
 *  `checkStall()`'s escalation branch). Idempotent — logs and notifies listeners exactly ONCE per
 *  outage. A throwing listener must not stop the others from being notified, matching
 *  `onRendererLost`'s contract in `activeRenderer.ts`. Phase 2 (out of scope here) wires a native
 *  alert to this transition — see docs/plans/ios-rendering-update-wedge.md. */
function declareUnrecoverable() {
  if (unrecoverable) return;
  unrecoverable = true;
  // Prefer the LATCH — see its declaration for why the live read is too late in the real
  // sequence (a renderer rebuild wipes it well before this fires).
  const gpuFault = latchedGpuFault ?? getGpuFaultState();
  const info: FrameLoopUnrecoverableInfo = {
    recoveryAttempts,
    msSinceLastFrame: Math.round(msSinceRealFrame()),
    gpuFault,
  };
  // Constant text, same reasoning as the stall message below — see its comment.
  console.error(
    `[frameDriver] FRAME LOOP UNRECOVERABLE — the requestAnimationFrame chain has not delivered ` +
    `a frame across ${UNRECOVERABLE_AFTER_ATTEMPTS} stall checks. The app is alive (JS, timers ` +
    `and the native bridge all still run) but the browser has stopped delivering paint callbacks; ` +
    `no further automatic repair will be attempted.` +
    (gpuFault?.deviceLost ? ` GPU fault: ${gpuFault.reason ?? 'unknown reason'}.` : ''),
  );
  for (const fn of unrecoverableListeners) {
    try { fn(info); }
    catch (e) { console.error('[frameDriver] an unrecoverable listener threw', e); }
  }
}

/** Subscribe to "the frame loop is permanently dead — no further automatic repair will run".
 *  Fires at most once per outage. Returns an unsubscribe function, matching `onRendererLost`'s
 *  shape in `activeRenderer.ts`. */
export function onFrameLoopUnrecoverable(fn: (info: FrameLoopUnrecoverableInfo) => void): () => void {
  unrecoverableListeners.add(fn);
  return () => { unrecoverableListeners.delete(fn); };
}

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function checkStall() {
  // A hidden window legitimately gets no rAF callbacks — that is throttling, not a wedge.
  // Treat it as healthy and reset, so un-hiding does not immediately trip the watchdog.
  // `unrecoverable` is deliberately NOT touched here — going hidden mid-outage is not evidence of
  // recovery, only a real frame (below) is.
  if (!loopArmed || refCount === 0 || documentHidden()) {
    stalledSince = null;
    recoveryAttempts = 0;
    outageDetectedAt = null;
    outageRearms = 0;
    return;
  }

  // Once an outage has begun (`stalledSince !== null`), judge it on the REAL frame clock
  // (`msSinceRealFrame`), not the arm-grace clock (`msSinceProgress`). `armLoop()` resets
  // `armedAt` on every re-arm, and `msSinceProgress()` reads `max(lastFrameAt, armedAt)` — so
  // judging an ONGOING outage against it made every re-arm look like fresh progress for the next
  // two watchdog ticks, `recoveryAttempts` reset to 0 right on schedule, `MAX_REPORTED_ATTEMPTS`
  // never engaged, and every observed message said "attempt 1" forever. The grace period is still
  // honoured for the FIRST detection, so a freshly armed chain gets its due grace before being
  // judged at all.
  const since = stalledSince === null ? msSinceProgress() : msSinceRealFrame();
  if (since < STALL_MS) {
    // A real frame (or a still-in-grace arm) has put us back under the threshold — the outage,
    // if there was one, is OVER. This is the ONLY place `unrecoverable`/the latched GPU fault
    // clear outside a full stop/start cycle (`stopWatchdog()`): only a REAL recovered frame, not
    // merely time passing or the tab going hidden, proves an outage has ended. Gated on
    // `stalledSince !== null || unrecoverable` — NOT `stalledSince` alone — because once declared,
    // `checkStall()` returns before re-populating `stalledSince` on a hidden/idle tick (see
    // below), so an outage that was hidden away and is only NOW recovering can reach this branch
    // with `stalledSince` already back to `null`. Either flag being set means SOME outage was
    // detected; a routine healthy tick where NEITHER was ever set must not run this (it would
    // wipe a freshly latched GPU fault before the still-to-come stall detection reads it).
    if (stalledSince !== null || unrecoverable) {
      unrecoverable = false;
      latchedGpuFault = null;
    }
    // A GPU loss that RECOVERS IN PLACE (`rendererRecovery` rebuilds within ~250ms, well under
    // `STALL_MS`) never sets `stalledSince`/`unrecoverable` above — frames never stop for a full
    // `STALL_MS`, so the gated clear just above never runs, and the latch would otherwise survive
    // forever, shadowing `getFrameLoopHealth().gpuFault`/every stall report with a fault that
    // recovered minutes earlier. The discriminator is "a real frame executed AFTER the latch was
    // taken" — NOT "time passed" (a hidden/idle tick proves nothing) and NOT "a renderer
    // rebuilt" (a rebuild alone proves nothing either: the pinned "SURVIVING the real production
    // sequence" test below rebuilds the renderer BETWEEN the loss and a stall that never ends,
    // and the latch MUST survive that). `latchedGpuFaultFrameAt` snapshots `lastFrameAt` at the
    // moment of the latch; `lastFrameAt` only advances inside `runFrame()`, so strictly-greater
    // here means at least one real frame ran since — safe to drop the shadow.
    if (latchedGpuFault !== null && lastFrameAt > latchedGpuFaultFrameAt) {
      latchedGpuFault = null;
    }
    stalledSince = null;
    recoveryAttempts = 0;
    outageDetectedAt = null;
    outageRearms = 0;
    return;
  }
  if (unrecoverable) return; // already declared for this outage — nothing left to try automatically

  if (stalledSince === null) { stalledSince = lastFrameAt; outageDetectedAt = rawNow(); }

  // ⚠️ Escalation is measured from `outageDetectedAt` (when WE first noticed), never from the
  // absolute `since` above. A previous version derived attempts straight from `since`
  // (`Math.floor(since / STALL_MS)`), which is correct for a CLEAN outage (last frame t=0,
  // detected t=3000 -> attempt 1, t=6000 -> 2, ... t=12000 -> unrecoverable) but breaks after any
  // discontinuity in `lastFrameAt` — backgrounding, device sleep, a long main-thread block, a
  // manual-clock jump in tests. `documentHidden()`/`refCount===0` resets `recoveryAttempts` to 0
  // above but never touches `lastFrameAt`, so the FIRST post-gap detection sees a `since` already
  // many `STALL_MS` units large; `Math.floor(since / STALL_MS) > recoveryAttempts` then stays true
  // on EVERY subsequent 1s watchdog tick too (an attempted "at most 1 per detection" clamp here
  // is a no-op: the guard above already establishes `attempt > recoveryAttempts`, i.e.
  // `attempt >= recoveryAttempts + 1`, so `Math.min(attempt, recoveryAttempts + 1)` always equals
  // `recoveryAttempts + 1` — a plain per-TICK increment wearing a clamp's clothes). Measured: a
  // resume after an 8s/20s/60s hidden gap declared unrecoverable 4 real seconds later, inside the
  // slow-but-alive window `DELIVER_MS = 4900` in the defect-5 test below is supposed to survive.
  // Re-baselining on `outageDetectedAt` fixes this: the FIRST post-gap detection sets it to `now`
  // (not to the stale `lastFrameAt`), so escalation is always exactly `UNRECOVERABLE_AFTER_ATTEMPTS
  // * STALL_MS` (~12s) after DETECTION — regardless of how long the gap that preceded it was.
  const attempts = 1 + Math.floor((rawNow() - outageDetectedAt!) / STALL_MS);
  if (attempts <= recoveryAttempts) return; // not yet another full STALL_MS since detection
  recoveryAttempts = attempts;

  if (recoveryAttempts <= MAX_REPORTED_ATTEMPTS) {
    // Prefer the LATCH — see its declaration for why the live `getGpuFaultState()` read is
    // provably too late in the real sequence (a renderer rebuild wipes it first).
    const gpuFault = latchedGpuFault ?? getGpuFaultState();
    // ⚠️ CONSTANT text — no `since`/`recoveryAttempts` interpolated. `globalErrors.ts:75` warns
    // about exactly this shape: "the flood that DEFEATS dedupe by varying its text" (there: an
    // entity id; here it was `${Math.round(since)}ms`, distinct on every emission) burns
    // `MAX_ERRORS_PER_SESSION` in minutes and then silently drops every genuine crash for the
    // rest of the session. The precise numbers still live in `getFrameLoopHealth()`
    // (`msSinceLastFrame`, `recoveryAttempts`) — structured fields, not deduped text.
    console.error(
      `[frameDriver] FRAME LOOP STALLED — no frame for over ${STALL_MS}ms with ${refCount} ` +
      `active start ref(s) and ${callbacks.size} registered callback(s), document visible. The ` +
      `app is alive but not pumping frames: no ECS system ticks, nothing renders, and trusted ` +
      `input will silently no-op.` +
      (gpuFault?.deviceLost ? ` GPU fault: ${gpuFault.reason ?? 'unknown reason'}.` : '') +
      (frameSinceArm
        ? ' Re-arming the requestAnimationFrame chain.'
        : ' The outstanding requestAnimationFrame callback has never fired — re-arming would ' +
          'only supersede it, and if rAF is merely slow rather than dead that supersession is ' +
          'what would starve it permanently, so this attempt is NOT re-armed.') +
      (recoveryAttempts >= MAX_REPORTED_ATTEMPTS
        ? ' Further attempts will continue SILENTLY — read getFrameLoopHealth().'
        : ''),
    );
  }

  // Gated on `!frameSinceArm`, deliberately: "unrecoverable" must mean "we armed a chain and the
  // browser never delivered ITS callback" — not merely "a lot of time has passed since a frame".
  // If `frameSinceArm` is true, a frame ran at some point since the CURRENT arm, so the honest
  // read is "still plausibly alive" and the right response is a re-arm, not surrender. This is
  // exactly the resume-from-background/long-main-thread-block case: `frameSinceArm` was left
  // `true` by the last frame that ran BEFORE the gap, `documentHidden()`/blocked-thread ticks
  // never reset it, and the first post-gap detection would otherwise declare a healthy, resuming
  // app unrecoverable with zero re-arms attempted. Re-arming here sets `frameSinceArm = false`
  // for the NEW chain — if rAF is genuinely dead, the next detections correctly fall to the
  // `!frameSinceArm` branch below and escalate for real. ⚠️ Do not "simplify" this gate away —
  // see the resume-after-hidden test, which is what it exists for.
  if (!frameSinceArm && recoveryAttempts >= UNRECOVERABLE_AFTER_ATTEMPTS) {
    declareUnrecoverable();
    return;
  }

  if (frameSinceArm) {
    // The chain ran at least once since it was armed and then died — a fresh arm is legitimate.
    recoveredCount++;
    outageRearms++;
    armLoop();
  }
  // else: the outstanding rAF has never been delivered. Re-arming would call
  // `loopLiveness.begin()` and supersede that still-pending callback — if rAF is merely SLOW
  // rather than dead (delivery interval > STALL_MS), the supersession is what kills it, i.e. the
  // "rescue" would cause the very outage it exists to fix (defect 5). Do nothing but count and
  // let the next tick judge again — the pending callback, if it is ever going to fire, still can.
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
  outageDetectedAt = null;
  outageRearms = 0;
  // A full stop is a deliberate clean slate — the other place `unrecoverable` clears (a real
  // frame, in `checkStall()`) can't apply here since nothing is armed to deliver one. Without
  // this, a stop/start cycle after a declared outage left `getFrameLoopHealth().unrecoverable`
  // stuck `true` forever even though the driver had fully restarted.
  unrecoverable = false;
  latchedGpuFault = null;
  latchedGpuFaultFrameAt = 0;
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
  /** True once the watchdog has given up automatically repairing this outage — see
   *  `onFrameLoopUnrecoverable`. Deliberately NOT folded into `status` (still reads `'stalled'`
   *  when true): a new status literal would break every exhaustive switch already written
   *  against this union. */
  unrecoverable: boolean;
  /** The GPU fault channel's state (`activeRenderer.getGpuFaultState()`), when present — so a
   *  reader sees "frames stopped AND the GPU device was lost" in one place instead of
   *  correlating this report with a separate `[activeRenderer]` log by hand (`activeRenderer.
   *  ts:76`). Omitted while nothing has faulted, matching that module's own convention. */
  gpuFault?: GpuFaultState | null;
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
  const liveGpuFault = getGpuFaultState();
  const health: FrameLoopHealth = {
    status,
    refCount,
    callbacks: callbacks.size,
    armed: loopArmed,
    fps: _currentFPS,
    msSinceLastFrame,
    recovered: recoveredCount,
    recoveryAttempts,
    unrecoverable,
  };
  if (liveGpuFault) health.gpuFault = liveGpuFault;
  if (status === 'idle') {
    health.detail =
      'No frames are being pumped: nothing currently holds a frame-driver start ref, so the ' +
      'ECS pipeline is not ticking and nothing is rendering. This is normal only if no ' +
      'viewport is mounted; if a Scene or Game panel IS on screen, its render effect failed ' +
      'to start (check the console for a renderer-init error).';
  }
  if (stalled) {
    // Prefer the LATCH over the live read while stalled — see its declaration for why: by the
    // time a stall is 3s+ old, a renderer rebuild has typically already wiped the live state.
    const gpuFault = latchedGpuFault ?? liveGpuFault;
    if (gpuFault) health.gpuFault = gpuFault; // overrides the live-only assignment above, if any
    health.detail =
      `The frame loop has not ticked for ${msSinceLastFrame}ms while ${refCount} caller(s) ` +
      `believe it is running. Nothing is rendering and no ECS system is ticking, so play/pause ` +
      `state, trusted input and screenshots are ALL unreliable right now.` +
      (unrecoverable
        ? ` The watchdog gave up after ${UNRECOVERABLE_AFTER_ATTEMPTS} failed checks — the ` +
          `outstanding requestAnimationFrame callback is never being delivered, so nothing ` +
          `further will be tried automatically; restart the app.`
        // Per-OUTAGE count (`outageRearms`), not the session-cumulative `recoveredCount` — a
        // brand-new outage's first message must not report however many times EARLIER, unrelated
        // outages this session had already re-armed.
        : ` The watchdog has re-armed the rAF chain ${outageRearms} time(s) so far this outage ` +
          `and keeps retrying, but if this persists the app is alive while paint is dead — a ` +
          `known iOS WKWebView failure mode after a WebGL context loss.`) +
      (gpuFault?.deviceLost ? ` GPU fault: ${gpuFault.reason ?? 'unknown reason'}.` : '');
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
  stalledSince = null;
  outageDetectedAt = null;
  outageRearms = 0;
  lastFrameAt = 0;
  armedAt = 0;
  _currentFPS = 0;
  _fpsFrameCount = 0;
  _fpsLastSample = 0;
  lastFrameTime = 0;
  frameSinceArm = false;
  unrecoverable = false;
  latchedGpuFault = null;
  latchedGpuFaultFrameAt = 0;
  unrecoverableListeners.clear();
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
