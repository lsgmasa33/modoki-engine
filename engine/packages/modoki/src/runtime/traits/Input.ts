import { trait } from 'koota';
import {
  makeAxes, makeFlags, makePointer, makeGesture,
  type Axis, type DigitalAction, type GestureFrame, type InputDevice, type InputFrame, type PointerFrame,
} from '../core/inputActions';
import type { World } from 'koota';
// The sanctioned wall-clock wrapper (see the determinism guard): prediction is a PRESENTATION
// concern measured against real elapsed time, never game state, so it may read it.
import { rawNow } from '../core/clock';

/** Input resource — the canonical, source-agnostic input snapshot for this frame
 *  (Part A2 of the input-and-ui-focus plan). A world-scoped singleton (like `Time`):
 *  the app-pipeline `inputSystem` merges every attached source into it BEFORE
 *  GAME-priority systems run, and game/UI logic reads it via the accessors below —
 *  never from `window`/`navigator` directly.
 *
 *  It is PLAIN DATA (determinism-guard-safe, trivially serializable), so the headless
 *  harness sets it by hand instead of faking a device:
 *    world.spawn(Input);
 *    setAxis(world, 'moveX', 1); setPressed(world, 'confirm', true);
 *    step(1);  // characterInputSystem / uiFocusSystem read it deterministically
 *
 *  koota note: AoS (callback) form because the fields are nested objects — the
 *  callback runs per entity so the singleton gets its OWN fresh maps (no shared
 *  default). `inputSystem` mutates these in place each frame. This resource is
 *  runtime-only (spawned like `Time`, never hand-authored into a scene) so it is
 *  intentionally not registered as an editor-inspectable trait. */
export const Input = trait(() => ({
  axes: makeAxes(),
  held: makeFlags(),
  pressed: makeFlags(),
  released: makeFlags(),
  pointer: makePointer(),
  gesture: makeGesture(),
  lastDevice: 'none' as InputDevice,
}));

/** The singleton Input resource instance, or null if not spawned. */
export function getInput(world: World): InputFrame | null {
  const e = world.queryFirst(Input);
  return e ? (e.get(Input) as unknown as InputFrame) : null;
}

/** Current value of an analog axis (−1…+1), 0 if no Input resource. */
export function axis(world: World, a: Axis): number { return getInput(world)?.axes[a] ?? 0; }
/** Whether a digital action is currently held. */
export function held(world: World, a: DigitalAction): boolean { return getInput(world)?.held[a] ?? false; }
/** Rising-edge: true only on the frame the action went down (once per press). */
export function pressed(world: World, a: DigitalAction): boolean { return getInput(world)?.pressed[a] ?? false; }
/** Falling-edge: true only on the frame the action went up. */
export function released(world: World, a: DigitalAction): boolean { return getInput(world)?.released[a] ?? false; }
/** Which device last produced input — for prompt swapping ("Press A" vs "Click"). */
export function lastInputDevice(world: World): InputDevice { return getInput(world)?.lastDevice ?? 'none'; }

// ── Pointer / tap / drag accessors ─────────────────────────────────────────────
// The single active pointer (mouse or primary touch), in CSS/client px. See
// `PointerFrame`. A zeroed default (down:false) is returned when no Input resource.

const ZERO_POINTER: PointerFrame = makePointer();

/** The full pointer snapshot (position, down/pressed/released, drag delta). */
export function pointer(world: World): PointerFrame { return getInput(world)?.pointer ?? ZERO_POINTER; }
/** Whether the pointer is currently down (held). */
export function pointerDown(world: World): boolean { return getInput(world)?.pointer.down ?? false; }
/** Rising-edge: true only on the frame the pointer went down (press/tap start). */
export function pointerPressed(world: World): boolean { return getInput(world)?.pointer.pressed ?? false; }
/** Falling-edge: true only on the frame the pointer went up (release/tap end). */
export function pointerReleased(world: World): boolean { return getInput(world)?.pointer.released ?? false; }
/** Current pointer position in viewport CSS px. Raw `clientX/clientY` — ratio-matched to
 *  `getBoundingClientRect`, so raycast/hit-testing off this is already zoom-invariant. */
export function pointerPos(world: World): { x: number; y: number } {
  const p = getInput(world)?.pointer ?? ZERO_POINTER;
  return { x: p.x, y: p.y };
}
/** Drag delta (current − press start), PRESENTATION-INVARIANT: `inputSystem` scales it to
 *  zoom-0-equivalent px once, at the point it merges the pointer frame into this resource (see
 *  presentationScale.ts), so a gesture yields the same magnitude at any editor/browser/OS zoom.
 *  {0,0} while the pointer is up. Positions (`pointerPos`) stay raw — only this magnitude is
 *  scaled, which is why a game's `dragPx × k` feel constant no longer drifts under zoom. A plain
 *  read: `Input.pointer.dragX/dragY` IS the presentation-invariant value, not a second raw copy —
 *  reading the field directly gives the same answer as this accessor. */
export function pointerDrag(world: World): { x: number; y: number } {
  const p = getInput(world)?.pointer ?? ZERO_POINTER;
  return { x: p.dragX, y: p.dragY };
}

// ── Gesture accessors (pan / pinch / tap) ─────────────────────────────────────
// Multi-touch, from `gestureSource`. Distinct from the pointer accessors above: those report the
// ONE primary pointer, these report the shape of every live finger. See `GestureFrame`.

const ZERO_GESTURE: GestureFrame = makeGesture();

/** The full gesture snapshot. */
export function gesture(world: World): GestureFrame { return getInput(world)?.gesture ?? ZERO_GESTURE; }
/** Whether a two-finger pinch is live. */
export function pinching(world: World): boolean { return getInput(world)?.gesture.pinching ?? false; }
/** Pinch spread RATIO against the distance the gesture started at (1 = unchanged). */
export function pinchScale(world: World): number { return getInput(world)?.gesture.pinchScale ?? 1; }
/** Pinch spread ratio against the PREVIOUS frame — multiply into a zoom you already hold. */
export function pinchScaleDelta(world: World): number { return getInput(world)?.gesture.pinchScaleDelta ?? 1; }
/** Pan movement this frame, presentation-scaled like `pointerDrag`. {0,0} unless panning/pinching. */
export function panDelta(world: World): { x: number; y: number } {
  const g = getInput(world)?.gesture ?? ZERO_GESTURE;
  return { x: g.panX, y: g.panY };
}
/** Edge: a tap completed this frame (short press that never left the slop radius). */
export function gestureTapped(world: World): boolean { return getInput(world)?.gesture.tapped ?? false; }
/** Where the tap went down. Only meaningful on the frame `gestureTapped` is true. */
export function gestureTapPos(world: World): { x: number; y: number } {
  const g = getInput(world)?.gesture ?? ZERO_GESTURE;
  return { x: g.tapX, y: g.tapY };
}

// ── Latency compensation ──────────────────────────────────────────────────────
/**
 * How far ahead `pointerPredictedPos` extrapolates, in milliseconds.
 *
 * ## Why this exists
 *
 * A touch takes a long time to become a lit pixel: the OS samples the digitizer, the
 * WebView dispatches an event, the app renders a frame, and the compositor presents it.
 * Measured on an A23 (2026-08-06) that total is around **83 ms — five frames at 60 Hz** —
 * and it is perceived as the dragged object trailing the finger.
 *
 * ⚠️ **It is NOT the engine's frame budget, and it is not fixable by making Court faster.**
 * That was checked before this knob was written: during a real drag the frame time was a
 * median of 16.7 ms with exactly one frame over 25 ms out of 226, the ECS pipeline already
 * runs INPUT (50) before GAME (100) before the 2D render, and `onPointerMove` queues nothing
 * that could accumulate. The decisive measurement was a control: a bare DOM `<div>` moved
 * directly in the pointer handler — no ECS, no canvas, the shortest path a browser offers —
 * lags by the *same* amount. There is no frame left in our code to reclaim, so the only
 * remaining lever is to draw where the finger is ABOUT to be.
 *
 * Chrome's own `getPredictedEvents()` reaches exactly one frame ahead (16.6 ms measured), so
 * it cannot close this on its own.
 *
 * ## ⚠️ The default is OFF, and that is a measurement, not caution
 *
 * A lead is not merely device-specific in MAGNITUDE — on a fast, high-refresh device it is
 * actively harmful. Both measured live, same build, same estimator:
 *
 * | Device | Verdict |
 * |---|---|
 * | Galaxy A23, 60 Hz | ~83 ms — the drag only stops trailing the finger with it |
 * | iPhone Air, 120 Hz | **0 — any lead visibly JITTERS** |
 *
 * The reason is arithmetic. A two-point velocity divides by the sample gap, so at 120 Hz
 * (~8.3 ms) one pixel of pointer noise becomes ~0.12 px/ms of velocity error, which an 83 ms
 * lead multiplies into ~10 px of jitter. At 60 Hz the gap is double, the noise term halves,
 * and the device actually has the latency worth cancelling. Same code, opposite outcome —
 * so there is no honest engine-wide number, and a default of 83 would have shipped jitter
 * to every fast device to fix a slow one.
 *
 * Hence 0: prediction is inert until something measures a device and asks for it. Measure with
 * debug menu → **Input** (two rings, raw vs extrapolated, plus a lead slider) — never by
 * reasoning about the hardware, which is how both of the numbers above were nearly guessed wrong.
 *
 * ## ⚠️ Extrapolate to a TIME, not by an OFFSET
 *
 * The obvious implementation — `lastEventPos + velocity × lead` — is what produced the iPhone
 * jitter, and it is a known-wrong shape rather than a tuning problem. Input and display are
 * ASYNCHRONOUS, so the newest event's age at render time varies by up to a full input interval
 * every frame; adding a fixed offset to a position of varying staleness writes that phase noise
 * straight into the pixels. Casiez et al., *Modeling and Reducing Spatial Jitter caused by
 * Asynchronous Input and Output Rates*, describe it and prescribe the fix: resample to a fixed
 * point in ABSOLUTE time rather than relative to the last event. Chrome on Android has shipped
 * that by default since 2023.
 *
 * So the position is advanced by `(now − sampleTime) + lead`. The age term cancels the phase
 * noise; the lead term is the actual latency compensation. At 60 Hz the age varies by ~16 ms and
 * the error was tolerable; at 120 Hz it varies by ~8 ms against a much shorter true latency,
 * which is why the fast device was the one that trembled.
 *
 * ## Smooth the VELOCITY, extrapolate from the RAW position
 *
 * Smoothing the base position and then extrapolating from it subtracts the filter's lag from
 * the lead — at conservative settings by MORE than the lead, so switching prediction on moved
 * the picture backwards. Position noise is ~1 px; velocity noise times an 80 ms lead was the
 * ~10 px tremor. Only the second one is worth filtering.
 *
 * ## The velocity is 1€-filtered, not EMA-smoothed
 *
 * A fixed smoothing constant must choose between killing jitter and tracking a fast movement, and
 * every constant is wrong somewhere — this one was wrong twice on the SAME device (83 ms felt
 * right, then 33 ms trembled). Once the position is advanced between samples, a velocity ERROR
 * becomes a per-sample sawtooth, which is what "jitter" turned out to mean here. So both the
 * position and the velocity come from a **1€ filter** whose cutoff rises with speed — see
 * `input/oneEuroFilter.ts`, and `setPointerFilterParams` to tune it live.
 *
 * ## What it must never touch
 *
 * An extrapolated point is a GUESS about the future, so it belongs to RENDERING only. Feeding
 * it to a hit-test would resolve a tap, a drop cell or a drag threshold at a position the
 * finger never occupied — visible only on fast strokes, which is the worst way to find a bug.
 * `pointerPos` therefore stays the truth and is what every hit-test must keep reading.
 */
export const POINTER_LEAD_MS_DEFAULT = 0;

/** The lead measured on a 60 Hz Android device (Galaxy A23, 2026-08-06). Exported so a game
 *  applying it per platform cites the measurement instead of re-typing a magic 83 — and so the
 *  next device that disagrees has one place to argue with. */
export const POINTER_LEAD_MS_ANDROID_60HZ = 83;

let pointerLeadMs = POINTER_LEAD_MS_DEFAULT;

/**
 * Speed gate for the lead, in CSS px/ms — below `min` no prediction at all, above `full` the
 * whole lead, smoothly ramped between.
 *
 * ## Why gate at all (owner, 2026-08-06)
 *
 * The two failure modes live at opposite ends of the speed range. Near-stationary, the latency
 * is imperceptible and any extrapolation error is a visible tremor on a hard-edged object.
 * Moving fast, the extrapolation error is swamped by the movement itself and the latency is the
 * only thing you notice. A single fixed lead has to serve both and serves neither — which is the
 * same shape of problem the 1€ filter solves for smoothing, one level up.
 *
 * ## Why a RAMP and not a threshold
 *
 * A hard on/off pops: at the crossing speed the drawn position jumps by `speed × lead` — about
 * 7px at 0.2 px/ms and a 33ms lead — trading a tremor for a snap, which is worse because it is
 * correlated with the gesture rather than with noise. `smoothstep` between the two speeds has a
 * zero derivative at both ends, so the lead fades in with no discontinuity in position OR in
 * velocity.
 *
 * ## The defaults are a starting point, not a measurement
 *
 * ⚠️ `minSpeed` MUST sit clear of the velocity estimator's noise floor, and the first guess did
 * not. Measured on an A23 while the owner deliberately held a piece still: the estimated speed
 * had a MEDIAN of 0.065 px/ms against a floor of 0.05, so the gate factor swung between 0 and
 * 0.6 frame to frame (zero only 25% of the time). A gate that flickers multiplies the lead by a
 * rapidly varying number, which is worse than having no gate at all — it converts a steady
 * offset into tremor. The floor is now 0.2: comfortably above a measured still hand, still well
 * below a deliberate drag.
 *
 * For scale: a stationary finger reads ~0.065 px/ms of pure estimator noise, a deliberate slow
 * drag 0.2–0.5, a flick upwards of 2. Tune live (debug menu → Input) — and re-check the floor on
 * any device whose noise floor might differ, because that is the parameter that bites.
 */
export const POINTER_LEAD_GATE_DEFAULTS = { minSpeed: 0.2, fullSpeed: 0.6 };
const leadGate = { ...POINTER_LEAD_GATE_DEFAULTS };

/** Retune the speed gate live. `minSpeed` is the owner's "disable under a threshold"; `fullSpeed`
 *  is where the lead reaches its authored value. `full` is held at or above `min` so the ramp can
 *  never invert into a divide-by-zero or a backwards gate. */
export function setPointerLeadGate(next: { minSpeed?: number; fullSpeed?: number }): void {
  if (Number.isFinite(next.minSpeed)) leadGate.minSpeed = Math.max(0, next.minSpeed!);
  if (Number.isFinite(next.fullSpeed)) leadGate.fullSpeed = Math.max(0, next.fullSpeed!);
  if (leadGate.fullSpeed < leadGate.minSpeed) leadGate.fullSpeed = leadGate.minSpeed;
}

/** The live speed gate (a copy). */
export function getPointerLeadGate(): { minSpeed: number; fullSpeed: number } { return { ...leadGate }; }

/** 0 below `min`, 1 above `full`, smoothstep between — zero derivative at both ends, so the lead
 *  fades in without a discontinuity in position or velocity. Exported for the debug tuner, which
 *  must model the runtime exactly rather than approximate it. */
export function pointerLeadGateFactor(speed: number, min = leadGate.minSpeed, full = leadGate.fullSpeed): number {
  if (!(speed > min)) return 0;
  if (!(full > min) || speed >= full) return 1;
  const t = (speed - min) / (full - min);
  return t * t * (3 - 2 * t);
}

/** Set the global extrapolation lead (ms). 0 disables prediction entirely — `pointerPredictedPos`
 *  then returns exactly `pointerPos`. Clamped at 0; a negative lead would draw the pointer in its
 *  own past, which is the bug this compensates for, doubled. */
export function setPointerLeadMs(ms: number): void {
  pointerLeadMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

/** The current global extrapolation lead (ms). */
export function getPointerLeadMs(): number { return pointerLeadMs; }

/**
 * The pointer position extrapolated forward by `leadMs`, to cancel touch-to-photon latency.
 *
 * ⚠️ **RENDERING ONLY.** See `POINTER_LEAD_MS_DEFAULT` — hit-tests, drop targets and drag
 * thresholds must read `pointerPos`, which is where the finger actually was.
 *
 * Degrades to the true position on its own: velocity is 0 while the pointer is up, on the
 * frame it goes down, and on the frame it is released — so a stationary or just-landed finger
 * gets no offset at all, and nothing is "predicted" out of a gesture that has not moved.
 */
export function pointerPredictedPos(world: World, leadMs: number = pointerLeadMs): { x: number; y: number } {
  const p = getInput(world)?.pointer ?? ZERO_POINTER;
  if (!(leadMs > 0)) return { x: p.x, y: p.y };
  // Extrapolate to NOW + lead, not by lead from the event. `age` is what removes the jitter:
  // see the header. Clamped so a stale or clock-skewed sample cannot fling the point — the
  // upper bound matches the velocity estimator's own window, past which "velocity" is fiction.
  const age = p.t > 0 ? Math.max(0, Math.min(64, rawNow() - p.t)) : 0;
  // SPEED-GATED, and the gate covers the AGE term too.
  //
  // ⚠️ The age term was originally left ungated on the argument that it corrects a KNOWN
  // staleness rather than guessing, and is "self-limiting anyway" because it multiplies a
  // near-zero velocity. That was wrong, and measured wrong on an A23: below the gate floor,
  // where the offset should be exactly zero, `age × v` alone produced up to 2.5 px — and since
  // `age` varies frame to frame with input/display phase, that offset VARIES. Jitter that
  // survives the gate is precisely what the gate exists to stop, so gate 0 now means the raw
  // position, full stop.
  const speed = Math.hypot(p.vx, p.vy);
  const gate = pointerLeadGateFactor(speed);
  if (gate <= 0) return { x: p.x, y: p.y };
  const ahead2 = (age + leadMs) * gate;
  // ⚠️ From the RAW position, NOT a smoothed one. Extrapolating a SMOOTHED base was the
  // obvious-looking choice and it is wrong: the smoothing lag subtracts from the lead, and at
  // conservative filter settings it exceeds it — measured, a 12-sample drag put the "predicted"
  // point at x=372 against a true x=440, i.e. BEHIND the finger. A feature whose ON state is
  // worse than its OFF state is not a tuning problem, it is a defect.
  //
  // Smoothing belongs on the VELOCITY, which is where the noise actually hurts: position noise
  // is ~1px, while velocity noise multiplied by an 80ms lead was the ~10px jitter this whole
  // mechanism tripped over. `vx/vy` are 1€-filtered; the base is the truth.
  return { x: p.x + p.vx * ahead2, y: p.y + p.vy * ahead2 };
}

/** Pointer velocity in CSS px/ms (EMA-smoothed), {0,0} while the pointer is up. */
export function pointerVelocity(world: World): { x: number; y: number } {
  const p = getInput(world)?.pointer ?? ZERO_POINTER;
  return { x: p.vx, y: p.vy };
}

/** Scroll-wheel notch delta THIS frame (+down / −up, one unit per wheel event);
 *  0 when the wheel didn't move. Consumed/re-zeroed each frame — read it once. */
export function getWheelDelta(world: World): number {
  return getInput(world)?.pointer.wheel ?? 0;
}

// ── Harness helpers — set the resource directly in headless tests ──────────────

/** Set an analog axis on the Input singleton (test/tooling convenience). */
export function setAxis(world: World, a: Axis, v: number): void {
  world.query(Input).updateEach(([inp]: [InputFrame]) => { inp.axes[a] = v; });
}
/** Set a digital action's held level (and optionally its pressed edge) on the
 *  Input singleton. `pressed` defaults to mirror `value` so a test can express a
 *  one-frame press with `setDigital(world, 'confirm', true)`. */
export function setDigital(world: World, a: DigitalAction, value: boolean, pressed = value): void {
  world.query(Input).updateEach(([inp]: [InputFrame]) => {
    const wasHeld = inp.held[a];
    inp.held[a] = value;
    inp.pressed[a] = pressed;
    inp.released[a] = !value && wasHeld;
  });
}

/** Set the pointer on the Input singleton directly (test/tooling convenience).
 *  Derives `pressed`/`released`/`dragX`/`dragY` from the prior state like the live
 *  pipeline: on a fresh press it latches `startX/startY` to `x,y`; while down it
 *  keeps the existing start and updates the drag delta. Pass just `{x,y,down}` to
 *  script a gesture frame-by-frame:
 *    setPointer(world, {x:100, y:200, down:true});   // press  → pressed, drag 0
 *    setPointer(world, {x:100, y:260, down:true});   // drag   → down, dragY 60
 *    setPointer(world, {x:100, y:260, down:false});  // release→ released */
export function setPointer(world: World, next: { x: number; y: number; down: boolean }): void {
  world.query(Input).updateEach(([inp]: [InputFrame]) => {
    const p = inp.pointer;
    const wasDown = p.down;
    p.pressed = next.down && !wasDown;
    p.released = !next.down && wasDown;
    if (p.pressed) { p.startX = next.x; p.startY = next.y; }
    p.x = next.x; p.y = next.y; p.down = next.down;
    p.dragX = next.down ? next.x - p.startX : 0;
    p.dragY = next.down ? next.y - p.startY : 0;
  });
}
