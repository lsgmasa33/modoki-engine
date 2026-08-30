/** Input action vocabulary — the source-agnostic language every input source
 *  speaks and every consumer reads (console/controller readiness, Part A of the
 *  input-and-ui-focus plan).
 *
 *  A source (keyboard, pointer, gamepad, later a native console) never touches
 *  gameplay traits directly — it merges its contribution into an `InputFrame`,
 *  and the app-pipeline `inputSystem` writes that frame into the canonical `Input`
 *  ECS resource once per frame, BEFORE GAME-priority systems run. Game/UI logic
 *  reads the resource, never `window`/`navigator` — that decoupling is what lets a
 *  future Switch port add exactly one new source and change nothing downstream.
 *
 *  This module is pure data + pure functions (no DOM, no wall-clock, no RNG) so it
 *  is determinism-guard-safe and the headless harness can build/set frames by hand. */

/** Analog axes, each −1…+1. `move*` = locomotion, `look*` = camera/aim. */
export const AXES = ['moveX', 'moveY', 'lookX', 'lookY'] as const;
export type Axis = (typeof AXES)[number];

/** Digital actions. `nav*` double as UI focus movement (Part B). Each exposes an
 *  edge (`pressed`/`released`, once per transition) and a level (`held`).
 *  `aim` is a generic aim/ADS toggle (e.g. hold-to-aim, or a mode toggle a game
 *  wires up itself) — keyboard maps it to F, gamepad to the left trigger. */
export const DIGITAL = [
  'confirm', 'cancel', 'menu', 'pause', 'jump', 'aim',
  'navUp', 'navDown', 'navLeft', 'navRight',
] as const;
export type DigitalAction = (typeof DIGITAL)[number];

/** Which physical device last produced activity — for "Press A" vs "Click" prompt
 *  swapping (Part B4). `'none'` until any source reports input. */
export type InputDevice = 'keyboard' | 'pointer' | 'gamepad' | 'native' | 'none';

export type AxisMap = Record<Axis, number>;
export type FlagMap = Record<DigitalAction, boolean>;

/** The pointer/tap/drag snapshot — the single active pointer (mouse or primary
 *  touch), in CSS/client pixels. Unlike axes/held it is NOT an OR-merged level:
 *  there is one pointer source and it is authoritative, so `beginSample` leaves it
 *  untouched (the source overwrites it wholesale each frame) and only the down-edge
 *  (`pressed`/`released`) is derived centrally by `inputSystem`.
 *
 *  `x`/`y` are the current position; `startX`/`startY` are where the current press
 *  began (updated on each `pressed`); `dragX`/`dragY` are the delta from that start
 *  (0 while up). A tap is a `pressed` with a small `dragX/dragY` at `released`; a
 *  drag is a `pressed`→hold-with-growing-drag→`released`. Coordinates are viewport
 *  CSS px (raw `clientX/clientY`) — a game maps them to world space itself (raycast
 *  / its own projection); deltas are already screen-space and need no mapping.
 *  `wheel` is the accumulated scroll-notch delta THIS frame (+down / −up, one unit
 *  per wheel event), consumed and re-zeroed every frame — for camera zoom etc. */
export interface PointerFrame {
  x: number; y: number;
  down: boolean;
  pressed: boolean;
  released: boolean;
  startX: number; startY: number;
  dragX: number; dragY: number;
  wheel: number;
  /** Pointer VELOCITY in CSS px per millisecond, EMA-smoothed, 0 while the pointer is up.
   *  Published so a consumer can EXTRAPOLATE the pointer forward and cancel the platform's
   *  touch-to-photon latency — see `pointerPredictedPos`. Raw (not presentation-scaled), to
   *  match `x`/`y`; `dragX`/`dragY` are the scaled pair. */
  vx: number; vy: number;
  /** `timeStamp` of the sample `x`/`y` came from, on the `performance.now()` clock (0 if none).
   *  Load-bearing for prediction: input and display are ASYNCHRONOUS, so the newest event's age
   *  at render time varies by up to a full input interval every frame. Extrapolating a fixed
   *  lead from the event — instead of to a fixed point in absolute time — bakes that phase noise
   *  straight into the drawn position, which is spatial JITTER rather than latency. See
   *  `pointerPredictedPos`. */
  t: number;
}

/** The merged per-frame snapshot a set of sources produces. `held` is the level
 *  state each source ORs into; `pressed`/`released` are the edges the inputSystem
 *  derives by diffing `held` against the previous frame (see `computeEdges`).
 *  `pointer` is authoritative (see `PointerFrame`), not OR-merged. */

/** A multi-touch GESTURE snapshot — pan, pinch and tap, derived from ALL live pointers.
 *
 *  Separate from `PointerFrame` on purpose. `pointerSource` latches the FIRST pointerId and
 *  ignores every later one (its primary-touch rule), which is what makes "walk while you orbit"
 *  work and was removed once already; a pinch needs the fingers that rule discards. So
 *  `gestureSource` observes the same `window` events independently and reports here, and the two
 *  never contend: one owns the primary gesture, the other owns the shape of the whole hand.
 *
 *  EDGES (`tapped`, `pinchStarted`, `pinchEnded`) and DELTAS (`panX/panY`, `pinchScaleDelta`) are
 *  per-frame and cleared by `beginSample`, so a frame on which the source does not run — input
 *  suppressed by the host gate, or no source registered at all — reports no gesture rather than
 *  repeating the last one.
 *
 *  Coordinates are viewport CSS px, matching `PointerFrame`. `panX/panY` are a MAGNITUDE and are
 *  presentation-scaled once in `inputSystem`, exactly like `dragX/dragY`; `pinchScale` is a RATIO
 *  and is therefore already zoom-invariant with nothing to scale. */
export interface GestureFrame {
  /** How many pointers are down right now (blocked ones excluded). */
  pointerCount: number;
  /** A one-finger pan is in progress — the gesture cleared the tap window or the slop radius. */
  panning: boolean;
  /** Pan movement THIS FRAME, presentation-scaled. Zero unless panning or pinching.
   *  While pinching this is the CENTROID's movement, so two fingers pan and zoom at once. */
  panX: number;
  panY: number;
  /** Two or more pointers are down and the pinch is live. */
  pinching: boolean;
  /** Edge: the frame the pinch began / ended. */
  pinchStarted: boolean;
  pinchEnded: boolean;
  /** Spread RATIO against the distance the pinch STARTED at (1 = unchanged). Absolute, so a
   *  consumer can drive zoom from the gesture's origin without accumulating drift. */
  pinchScale: number;
  /** Spread ratio against the PREVIOUS frame (1 = unchanged) — the incremental form, for a
   *  consumer that multiplies into a zoom it already holds. 1 while not pinching. */
  pinchScaleDelta: number;
  /** Centroid of the live pointers, viewport CSS px. Meaningless while `pointerCount` is 0. */
  centerX: number;
  centerY: number;
  /** Edge: a tap COMPLETED this frame — one finger, released inside the tap window, never having
   *  travelled past the slop radius. See `gestureSource` for the two thresholds. */
  tapped: boolean;
  /** Where the tap went down (not where it came up; they differ by at most the slop radius). */
  tapX: number;
  tapY: number;
}

export function makeGesture(): GestureFrame {
  return {
    pointerCount: 0, panning: false, panX: 0, panY: 0,
    pinching: false, pinchStarted: false, pinchEnded: false,
    pinchScale: 1, pinchScaleDelta: 1, centerX: 0, centerY: 0,
    tapped: false, tapX: 0, tapY: 0,
  };
}

export interface InputFrame {
  axes: AxisMap;
  held: FlagMap;
  pressed: FlagMap;
  released: FlagMap;
  pointer: PointerFrame;
  gesture: GestureFrame;
  lastDevice: InputDevice;
}

export function makeAxes(): AxisMap {
  return { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };
}

export function makePointer(): PointerFrame {
  return { x: 0, y: 0, down: false, pressed: false, released: false, startX: 0, startY: 0, dragX: 0, dragY: 0, wheel: 0, vx: 0, vy: 0, t: 0 };
}

export function makeFlags(): FlagMap {
  return {
    confirm: false, cancel: false, menu: false, pause: false, jump: false, aim: false,
    navUp: false, navDown: false, navLeft: false, navRight: false,
  };
}

export function createInputFrame(): InputFrame {
  return { axes: makeAxes(), held: makeFlags(), pressed: makeFlags(), released: makeFlags(), pointer: makePointer(), gesture: makeGesture(), lastDevice: 'none' };
}

/** Zero the per-sample state (axes + held) before re-sampling all sources into the
 *  frame. `pressed`/`released` are left for `computeEdges` to recompute; `lastDevice`
 *  is sticky (only a source with activity overwrites it). `pointer` is left as-is —
 *  the single pointer source is authoritative and overwrites it in `sample`, and its
 *  `pressed`/`released` down-edge is derived in `inputSystem` (see `computePointerEdge`). */
export function beginSample(frame: InputFrame): void {
  for (const a of AXES) frame.axes[a] = 0;
  for (const d of DIGITAL) frame.held[d] = false;
  // The WHOLE gesture frame is cleared, edges and levels alike, because a frame on which
  // `gestureSource` does not run must report NO gesture rather than repeating the last one.
  //
  // ⚠️ This deliberately differs from `pointer`, which is left latched. The difference is that a
  // suppressed frame still drains each source (`inputSources.drain` calls `reset()`), so the
  // gesture source's own finger list is already gone — leaving `pinching: true` published from it
  // would advertise a pinch that nothing is tracking. Consumers gate real behaviour on `pinching`
  // (wordweave suppresses its whole spelling drag on it), so a latched one is a stuck game, not a
  // cosmetic stale read: hold an editor panel's focus and the board stops accepting input.
  const g = frame.gesture;
  g.pointerCount = 0;
  g.panning = false; g.panX = 0; g.panY = 0;
  g.pinching = false; g.pinchStarted = false; g.pinchEnded = false;
  g.pinchScale = 1; g.pinchScaleDelta = 1;
  g.centerX = 0; g.centerY = 0;
  g.tapped = false;
}

/** Derive the pointer down-edge into `frame.pointer.pressed`/`.released` from the
 *  freshly-sampled `.down` vs the previous frame's down state. `prev` is updated to
 *  the current down for next frame. Mirrors `computeEdges` for digital flags, kept
 *  separate because pointer carries coordinates the OR-merge model doesn't. */
export function computePointerEdge(frame: InputFrame, prev: { down: boolean }): void {
  const now = frame.pointer.down;
  frame.pointer.pressed = now && !prev.down;
  frame.pointer.released = !now && prev.down;
  prev.down = now;
}

/** Derive edges into `frame.pressed`/`frame.released` from the freshly-sampled
 *  `frame.held` vs the previous frame's held map. `prev` is mutated to become the
 *  current held snapshot for next frame. Source-agnostic — a gamepad button and a
 *  keyboard key produce identical edges. */
export function computeEdges(frame: InputFrame, prev: FlagMap): void {
  for (const d of DIGITAL) {
    const now = frame.held[d];
    const was = prev[d];
    frame.pressed[d] = now && !was;
    frame.released[d] = !now && was;
    prev[d] = now;
  }
}

/** Clamp every analog axis into [−1, +1]. Sources ADD their contribution (e.g. a
 *  keyboard and a gamepad both pushing right), so the merged frame can briefly
 *  exceed unit range; this normalizes it before consumers read it. */
export function clampAxes(frame: InputFrame): void {
  for (const a of AXES) frame.axes[a] = Math.max(-1, Math.min(1, frame.axes[a]));
}

/** Radial-ish deadzone for a single analog axis: values under `dz` collapse to 0,
 *  the remainder is rescaled to keep full 0…1 range past the threshold. Keyboard
 *  produces exact ∓1 so this is a no-op there; it matters for sticks (Phase 2). */
export function applyDeadzone(v: number, dz = 0.2): number {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  const scaled = (a - dz) / (1 - dz);
  return Math.sign(v) * Math.min(1, scaled);
}
