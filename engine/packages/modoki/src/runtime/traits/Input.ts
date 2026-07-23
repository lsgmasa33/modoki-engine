import { trait } from 'koota';
import {
  makeAxes, makeFlags, makePointer,
  type Axis, type DigitalAction, type InputDevice, type InputFrame, type PointerFrame,
} from '../input/actions';
import { getPresentationScale } from '../input/presentationScale';
import type { World } from 'koota';

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
/** Drag delta (current − press start), PRESENTATION-INVARIANT: normalized to zoom-0 px so a
 *  gesture yields the same magnitude at any editor/browser/OS zoom (see presentationScale.ts).
 *  {0,0} while the pointer is up. Positions (`pointerPos`) stay raw — only this magnitude is
 *  scaled, which is why a game's `dragPx × k` feel constant no longer drifts under zoom. */
export function pointerDrag(world: World): { x: number; y: number } {
  const p = getInput(world)?.pointer ?? ZERO_POINTER;
  const s = getPresentationScale();
  return { x: p.dragX * s, y: p.dragY * s };
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
