/** Pointer input source — the mouse/touch modality of the source-agnostic input
 *  seam. The single active pointer (mouse, or the primary touch of a multi-touch
 *  gesture) is tracked from Pointer Events on `window` and merged into the shared
 *  `InputFrame` as a `PointerFrame` (position + down + drag delta). Game/UI logic
 *  reads it via the `Input` resource accessors (`pointerPressed`/`pointerDrag`/…),
 *  never from `window` — the input-source guard enforces that games route through
 *  here instead of adding their own `window.addEventListener('pointer…')`.
 *
 *  Only tracks LEVEL state (down + position); the down-EDGE (`pressed`/`released`)
 *  is derived centrally by `inputSystem` (`computePointerEdge`), same discipline as
 *  the keyboard/gamepad sources — this source stays a pure reporter.
 *
 *  Android/touch robustness (the reason this exists): a raw `pointercancel` from the
 *  browser reclaiming a touch for a scroll/zoom gesture must NOT read as a normal
 *  release — otherwise a drag-to-aim gets cancelled mid-gesture. So:
 *    - we `setPointerCapture` on press, so moves keep flowing to us even outside the
 *      original element, and
 *    - `pointercancel` ends the gesture as a plain up (down=false) — the same as
 *      release; combined with the app's `touch-action: none` on the game canvas
 *      (which stops the browser stealing the gesture in the first place) the cancel
 *      path is rarely hit at all.
 *
 *  Guards `typeof window` so importing it headless is inert; no wall-clock / no RNG.
 *  The primary-touch rule: the FIRST pointer down owns the gesture (its pointerId is
 *  latched); later pointers are ignored until it lifts — so a second finger can't
 *  hijack an in-progress drag.
 *
 *  EDGE LATCHING. Level state alone can silently drop a whole press+release: if both
 *  happen between two `inputSystem` samples, the down/up cancel out and NEITHER a
 *  pressed nor released edge is ever seen — worse, if a press is followed by several
 *  moves before the next sample, level state reports the LATEST move position as if
 *  it were where the press happened, corrupting anything that reads the down point
 *  (a drag's start, a tap's aim). So `down`/`up` also push onto a small FIFO of
 *  transitions (`pending`, capped) carrying their own exact `{x,y,startX,startY}`;
 *  `sample()` drains at most one transition per frame BEFORE falling back to level
 *  state, so a press and its matching release are always reported as two distinct
 *  samples, each with its own true coordinates — a press+release inside one frame
 *  now yields pressed on frame N and released on frame N+1, rather than vanishing.
 *  A drained RELEASE transition reports the TRUE final `dragX/dragY` (not zeroed) —
 *  matching `PointerFrame`'s documented contract ("a tap is a pressed with a small
 *  dragX/dragY AT released") — so a consumer that computes a fling/throw/launch from
 *  `pointerReleased() + pointerDrag()` together still sees the real magnitude.
 *
 *  POINTER-BLOCK ROOTS (`core/pointerBlockers.ts`). A DOM overlay sibling of the
 *  game canvas (the engine `UIRenderer`, the debug menu panel, a game's own hand-
 *  built chrome like Court's rules dialog) can register itself so a pointerdown/
 *  wheel that starts on it never reaches the game. The filter is applied HERE, at
 *  ingestion — in `onPointerDown`/`onWheel`, before `activeId` latches or
 *  `setPointerCapture` is called — never inside `sample()`. Filtering at read-time
 *  instead would be wrong: a blocked press has already been pushed onto `pending`
 *  (the FIFO above), and masking it out there breaks the down/up alternation
 *  `pushTransition`'s comment describes, so `computePointerEdge` would swallow the
 *  gesture silently. Filtering at ingestion means a blocked pointer never latches
 *  `activeId` at all, so subsequent moves/up for it already no-op via the existing
 *  `pointerId !== activeId` checks below — for free, with no additional state, and
 *  a SECOND pointer landing on the canvas becomes the active gesture (the only real
 *  multitouch benefit available here — `pointerSource` tracks a single pointer, so
 *  there is nothing to key a claim by `pointerId`; see the module's git history and
 *  docs/input.md for the earlier per-pointerId design this replaced). Because the
 *  decision is recomputed from the live DOM at every event rather than latched into
 *  a claim, a registration can never "leak" — there is no claim state to strand. */

import type { InputSource } from './inputSources';
import { noteUserInput } from '../core/userActivity';
import { rawNow } from '../core/clock';
import type { InputFrame } from '../core/inputActions';
import { getPlayState, onPlayStateChange } from '../core/playState';
import { isPointerBlocked } from '../core/pointerBlockers';
import { peekCurrentWorld } from '../core/ecs/worldRegistry';
import { emit } from '../core/journal';
import { createOneEuroFilter, POINTER_FILTER_DEFAULTS, type OneEuroParams } from './oneEuroFilter';

/** One press or release event, captured with the exact coordinates it occurred at
 *  (not the coordinates by the time it's sampled). `startX/startY` snapshot the
 *  gesture's down point so a drained `up` still reports the correct drag origin
 *  even if a later gesture has since latched a new module-level `startX/startY`. */
interface PointerTransition { down: boolean; x: number; y: number; startX: number; startY: number }

// Cap on queued transitions awaiting drain — real gestures produce at most one down
// and one up per frame-gap; this only guards against a pathological event storm.
const MAX_PENDING = 16;

// Tracked level state of the owning pointer. `activeId` is the pointerId that owns
// the current gesture (null = no pointer down). start* latch on press for the drag delta.
let down = false;
let x = 0;
let y = 0;
let startX = 0;
let startY = 0;
let activeId: number | null = null;
/** Whether the gesture owning `activeId` came from a REAL pointer (`isTrusted`). A synthetic press
 *  — the device debug bridge's `device_pointer`/`device_tap` — sets this false, which is what lets
 *  a real finger reclaim a stranded one; see `onPointerDown` (#299). */
let activeTrusted = false;
let active = false;         // saw activity since last sample → sets lastDevice='pointer'
// Smoothed pointer position + velocity, published for latency extrapolation
// (`pointerPredictedPos`). Both come from a 1€ filter per axis rather than a fixed EMA: a fixed
// smoothing constant has to choose between killing jitter (heavy) and tracking a fast movement
// (light), and every constant is wrong somewhere. Measured on an A23 — an 83 ms lead felt right
// with one constant and 33 ms trembled with the same constant once extrapolation resampled to
// absolute time, because a velocity error becomes a per-sample SAWTOOTH once the position is
// advanced between samples. See `oneEuroFilter.ts`.
//
// ⚠️ Only the VELOCITY is filtered. The smoothed POSITION the filter also produces is
// deliberately discarded: extrapolating from it subtracts the filter's lag from the lead and,
// at conservative settings, exceeds it — prediction then draws BEHIND the finger. See
// `pointerPredictedPos`.
let vx = 0;
let vy = 0;
let lastMoveT = 0;
/** Live tunables, shared by both axes. Mutated IN PLACE by `setPointerFilterParams`, and the
 *  filters below close over this very object — so the debug tuner's edits take effect on the next
 *  SAMPLE rather than the next gesture, and without rebuilding the filters and losing history. */
const filterParams: OneEuroParams = { ...POINTER_FILTER_DEFAULTS };
const filterX = createOneEuroFilter(filterParams);
const filterY = createOneEuroFilter(filterParams);
/** Ignore a dt outside this band: below it the derivative explodes on near-duplicate
 *  timestamps, above it the samples straddle a stall and the "velocity" is fiction. */
const VEL_MIN_DT_MS = 1;
const VEL_MAX_DT_MS = 64;

/** Retune the 1€ filter live (debug menu → Input). `minCutoff` first — lower it until a
 *  stationary pointer stops trembling — then `beta`, raised until a fast drag stops lagging. */
export function setPointerFilterParams(next: Partial<OneEuroParams>): void {
  if (Number.isFinite(next.minCutoff)) filterParams.minCutoff = Math.max(1e-3, next.minCutoff!);
  if (Number.isFinite(next.beta)) filterParams.beta = Math.max(0, next.beta!);
  if (Number.isFinite(next.dCutoff)) filterParams.dCutoff = Math.max(1e-3, next.dCutoff!);
}

/** The live 1€ parameters (a copy — the caller must not mutate the filters' own state). */
export function getPointerFilterParams(): OneEuroParams { return { ...filterParams }; }
let attached = false;
let offPlayState: (() => void) | null = null;
// Accumulated scroll-notch delta since the last sample (+down / −up), one unit per
// wheel event; drained to `pointer.wheel` each frame and re-zeroed. Transient, not
// latched level state — so it's cleared on reset() too.
let wheelAccum = 0;
// Queued down/up transitions awaiting drain by `sample()`, oldest first.
const pending: PointerTransition[] = [];

function reset(): void {
  down = false; activeId = null; activeTrusted = false; wheelAccum = 0; pending.length = 0;
  vx = 0; vy = 0; lastMoveT = 0;
  filterX.reset(); filterY.reset();
}

function pushTransition(t: PointerTransition): void {
  // Drop the NEWEST on overflow, not the oldest: dropping the oldest can leave an
  // `up` at the head with no matching `down` ahead of it in the queue, which breaks
  // down/up alternation — `computePointerEdge` then sees `now=false, prev.down=false`
  // and emits NEITHER a pressed nor released edge, silently swallowing a whole
  // gesture (the exact failure class this FIFO exists to kill). Refusing the newest
  // push instead preserves the drained prefix's alternation; only reachable under a
  // pathological event storm (MAX_PENDING), never in a real single/double gesture.
  if (pending.length >= MAX_PENDING) return;
  pending.push(t);
}

function onPointerDown(e: PointerEvent): void {
  noteUserInput(rawNow()); // see core/userActivity.ts — tier calibration must not judge an idle device
  if (activeId !== null) {
    // A gesture already owns the pointer — EXCEPT when it is a stranded SYNTHETIC one. A synthetic
    // press (the device debug bridge) can be left un-released with nothing able to clear it: no
    // matching `up` ever arrives, and `blur`/`visibilitychange`/play-start resets do not fire in a
    // running shipped game. From then on this early return swallows EVERY real finger — measured on
    // an A23, where camera orbit stayed dead until a force-stop (#299).
    //
    // A real pointer reclaims it, because the two cannot physically coexist: an `isTrusted` press
    // is a finger on the glass, and a finger cannot arrive while a *synthetic* gesture is genuinely
    // in progress. That makes the takeover exact — unlike a staleness TIMEOUT, which would also
    // steal a legitimate long hold from a second finger, breaking the primary-touch rule below for
    // real multitouch. The reverse case (a synthetic press during a real gesture) is NOT adopted:
    // there the finger is real and owns the gesture.
    if (!e.isTrusted || activeTrusted) return;
    // Close the stale gesture with a release before latching the new one, so `pending` keeps its
    // down/up alternation — see `pushTransition`: a down following a down makes `computePointerEdge`
    // emit neither edge, silently swallowing the finger we are trying to hand control to.
    down = false;
    pushTransition({ down: false, x, y, startX, startY });
    activeId = null;
    activeTrusted = false;
  }
  if (isPointerBlocked(e.target)) {
    // Never latch `activeId` for a blocked press — the whole gesture (its later
    // move/up) already falls through the `pointerId !== activeId` checks below
    // for free, with no claim state to strand. A second, unblocked pointer can
    // still land on the canvas and become the active gesture.
    if (import.meta.env.DEV) {
      const world = peekCurrentWorld();
      if (world) emit('input.pointer.blocked', { x: e.clientX, y: e.clientY }, world);
    }
    return;
  }
  activeId = e.pointerId;
  activeTrusted = e.isTrusted;
  down = true;
  x = e.clientX; y = e.clientY;
  startX = x; startY = y;
  active = true;
  // A new gesture inherits NO velocity or smoothing history from the last one — carrying either
  // over would fling the extrapolated point away from a finger that has only just landed, or
  // sweep it across the screen from wherever the previous gesture ended.
  vx = 0; vy = 0; lastMoveT = e.timeStamp;
  filterX.reset(); filterY.reset();
  // SEED at the press point, don't just reset: an unseeded filter spends the gesture's first
  // move establishing itself and reports no heading, so prediction would engage one sample late
  // — exactly at the moment the finger starts to travel and the lag is most visible.
  filterX.seed(x); filterY.seed(y);
  pushTransition({ down: true, x, y, startX, startY });
  // Keep receiving moves even if the finger/cursor leaves the original element.
  const el = e.target as Element | null;
  try { el?.setPointerCapture?.(e.pointerId); } catch { /* capture is best-effort */ }
}

function onPointerMove(e: PointerEvent): void {
  noteUserInput(rawNow()); // see core/userActivity.ts — tier calibration must not judge an idle device
  if (e.pointerId !== activeId) return;
  const dt = e.timeStamp - lastMoveT;
  if (dt > VEL_MIN_DT_MS && dt < VEL_MAX_DT_MS) {
    const dtSec = dt / 1000;
    // The filter's smoothed VALUE is discarded on purpose (see the declaration above); only its
    // low-passed derivative is kept. The 1€ derivative is per SECOND; the pointer frame
    // publishes px/ms to match `lastMoveT`.
    const sx = filterX.filter(e.clientX, dtSec);
    const sy = filterY.filter(e.clientY, dtSec);
    vx = sx.derivative / 1000; vy = sy.derivative / 1000;
  }
  // Outside the usable dt band the derivative is fiction — hold the last heading rather than
  // invent one.
  lastMoveT = e.timeStamp;
  x = e.clientX; y = e.clientY;
  active = true;
}

/** Up OR cancel: end the gesture. `pointercancel` is treated identically to `up`
 *  (a plain release) rather than as an abort, so a browser-reclaimed touch doesn't
 *  strand `down=true` forever — the consumer sees a clean released edge. */
function onPointerUp(e: PointerEvent): void {
  if (e.pointerId !== activeId) return;
  x = e.clientX; y = e.clientY;
  down = false;
  activeId = null;
  activeTrusted = false;
  active = true;
  // Kill the velocity on release so the extrapolated point collapses onto the true one. A
  // flick-and-lift would otherwise leave the picture coasting past the finger on the very
  // frame the gesture is being resolved.
  vx = 0; vy = 0;
  filterX.reset(); filterY.reset();
  pushTransition({ down: false, x, y, startX, startY });
}

/** Wheel/scroll — accumulate one signed notch per event (magnitude-agnostic, so a
 *  free-spinning vs clicky wheel behave the same). Passive listener, no
 *  `preventDefault`, so it never fights editor-panel scrolling. */
function onWheel(e: WheelEvent): void {
  noteUserInput(rawNow()); // see core/userActivity.ts — tier calibration must not judge an idle device
  if (e.deltaY === 0) return;
  // Unlike pointerdown, this check is correct PER EVENT: a wheel notch is not a
  // gesture, so there is no "hold for the whole gesture" argument here — a
  // registered root (e.g. a scrollable DOM list) should block only the notches
  // that land on it, not every notch for the rest of time.
  if (isPointerBlocked(e.target)) return;
  wheelAccum += Math.sign(e.deltaY);
  active = true;
}

export const pointerSource: InputSource = {
  name: 'pointer',

  attach(): void {
    if (attached || typeof window === 'undefined') return;
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('wheel', onWheel, { passive: true });
    // Drop a stale press each time the sim (re)starts, so a pointer left down across
    // a Play toggle can't leak a held drag into the first play frame.
    offPlayState = onPlayStateChange(() => { if (getPlayState() === 'playing') reset(); });
    attached = true;
  },

  detach(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('wheel', onWheel);
    }
    offPlayState?.(); offPlayState = null;
    reset(); active = false; attached = false;
  },

  /** Drop latched pointer state without detaching — host input gate closing edge. */
  reset(): void { reset(); },

  sample(out: InputFrame): void {
    // Authoritative: overwrite the pointer level state wholesale (no OR-merge —
    // there is one pointer). Edge (pressed/released) is derived by inputSystem.
    const p = out.pointer;
    const t = pending.shift(); // drain at most one queued transition this frame
    if (t) {
      p.down = t.down; p.x = t.x; p.y = t.y;
      p.startX = t.startX; p.startY = t.startY;
      // Report the true delta even on a drained RELEASE transition (down:false) —
      // forcing it to 0 here would discard the gesture's final magnitude on the one
      // frame a consumer reading pointerReleased()+pointerDrag() together expects it
      // (a fling/throw/launch computed at release, not during the hold).
      p.dragX = t.x - t.startX;
      p.dragY = t.y - t.startY;
    } else {
      p.x = x; p.y = y; p.down = down;
      p.startX = startX; p.startY = startY;
      p.dragX = down ? x - startX : 0;
      p.dragY = down ? y - startY : 0;
    }
    // Velocity is level state like x/y, not an edge: published every frame, and already
    // zeroed by press/release/reset so it can only be non-zero mid-gesture. `t` travels with
    // them so a consumer can tell how STALE this position already is — see `pointerPredictedPos`.
    p.vx = vx; p.vy = vy; p.t = lastMoveT;
    p.wheel = wheelAccum; wheelAccum = 0; // transient per-frame delta, consumed here
    if (active) { out.lastDevice = 'pointer'; active = false; }
  },
};
