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
 *  edge (`pressed`/`released`, once per transition) and a level (`held`). */
export const DIGITAL = [
  'confirm', 'cancel', 'menu', 'pause', 'jump',
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
 *  / its own projection); deltas are already screen-space and need no mapping. */
export interface PointerFrame {
  x: number; y: number;
  down: boolean;
  pressed: boolean;
  released: boolean;
  startX: number; startY: number;
  dragX: number; dragY: number;
}

/** The merged per-frame snapshot a set of sources produces. `held` is the level
 *  state each source ORs into; `pressed`/`released` are the edges the inputSystem
 *  derives by diffing `held` against the previous frame (see `computeEdges`).
 *  `pointer` is authoritative (see `PointerFrame`), not OR-merged. */
export interface InputFrame {
  axes: AxisMap;
  held: FlagMap;
  pressed: FlagMap;
  released: FlagMap;
  pointer: PointerFrame;
  lastDevice: InputDevice;
}

export function makeAxes(): AxisMap {
  return { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };
}

export function makePointer(): PointerFrame {
  return { x: 0, y: 0, down: false, pressed: false, released: false, startX: 0, startY: 0, dragX: 0, dragY: 0 };
}

export function makeFlags(): FlagMap {
  return {
    confirm: false, cancel: false, menu: false, pause: false, jump: false,
    navUp: false, navDown: false, navLeft: false, navRight: false,
  };
}

export function createInputFrame(): InputFrame {
  return { axes: makeAxes(), held: makeFlags(), pressed: makeFlags(), released: makeFlags(), pointer: makePointer(), lastDevice: 'none' };
}

/** Zero the per-sample state (axes + held) before re-sampling all sources into the
 *  frame. `pressed`/`released` are left for `computeEdges` to recompute; `lastDevice`
 *  is sticky (only a source with activity overwrites it). `pointer` is left as-is —
 *  the single pointer source is authoritative and overwrites it in `sample`, and its
 *  `pressed`/`released` down-edge is derived in `inputSystem` (see `computePointerEdge`). */
export function beginSample(frame: InputFrame): void {
  for (const a of AXES) frame.axes[a] = 0;
  for (const d of DIGITAL) frame.held[d] = false;
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
