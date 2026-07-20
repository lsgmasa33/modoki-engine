/** inputSystem — the bridge that turns attached input sources into the canonical
 *  `Input` ECS resource (Part A4 of the input-and-ui-focus plan).
 *
 *  Runs in the APP pipeline at `SYSTEM_PRIORITY.INPUT` (just after TIME=0, before
 *  GAME=100) so every gameplay/UI system this frame reads a fresh `Input`. Each
 *  frame it: reset a scratch frame → let every attached source merge its
 *  contribution (`sampleAll`) → derive edges vs the previous frame (`computeEdges`)
 *  → copy the result into the `Input` singleton.
 *
 *  It is registered in the app pipeline ONLY — never in the headless harness — so
 *  the DOM/gamepad reads inside the sources never enter the deterministic sim.
 *  Tests set the `Input` resource directly. No wall-clock, no RNG. Sim-gated by
 *  priority < TRANSFORM, so it only ticks while the sim is playing (matching the
 *  old characterInput bridge). */

import type { World } from 'koota';
import { Input } from '../traits/Input';
import { DIGITAL, createInputFrame, beginSample, clampAxes, computeEdges, computePointerEdge, makeFlags, type InputFrame, type FlagMap, type InputDevice } from '../input/actions';
import { sampleAll } from '../input/inputSources';
import { getPlayState, onPlayStateChange } from './playState';
import { markUIDirty } from '../ui/uiTreeStore';

// Module-level scratch — reused each frame to avoid per-frame allocation. `prevHeld`
// carries the previous frame's held map so edges (pressed/released) can be derived.
const frame: InputFrame = createInputFrame();
const prevHeld: FlagMap = makeFlags();
const prevPointer = { down: false };

// On the first frame after the sim (re)starts, suppress edges: adopt whatever is held
// this frame as the baseline (prevHeld = current held) so an action already down at
// Play — a gamepad face button, or a key keyboardSource happened to be tracking — does
// NOT read as a fresh press (no phantom confirm/jump). Held state is still reported, so
// holding a direction moves immediately. This is source-agnostic; it replaces the old
// keyboard-only prevHeld-clear, which left gamepad buttons firing a phantom edge at Play.
// App-pipeline only (this module isn't registered headless), so no determinism concern.
let suppressEdgesNextFrame = false;
onPlayStateChange(() => { if (getPlayState() === 'playing') suppressEdgesNextFrame = true; });

// Last device we repainted the UI for. When the active input device changes
// (e.g. the player sets down the keyboard and picks up a controller), device-
// appropriate prompts ("Press A" vs "Enter") must re-resolve — but read sources
// are pull-only, so nothing repaints on its own. Mark the UI tree dirty on the
// transition so bound {confirmPrompt}/{inputDevice} text re-resolves. Rare event
// (once per device switch), so the full rebuild cost is negligible.
let repaintedDevice: InputDevice = 'none';

export function inputSystem(world: World): void {
  const e = world.queryFirst(Input);
  if (e === undefined) return; // no Input resource in this world → nothing to write

  beginSample(frame);       // zero axes + held; pressed/released recomputed below
  frame.lastDevice = (e.get(Input) as unknown as InputFrame).lastDevice; // sticky across frames
  sampleAll(frame);         // every attached source ORs/adds its contribution in
  clampAxes(frame);         // multiple sources can push the same axis (kbd + pad) → clamp to ∓1
  if (suppressEdgesNextFrame) {
    // First play frame: seed the baseline from what's held/down now, so computeEdges
    // and computePointerEdge emit no rising edges this frame (already-down ≠ a fresh
    // press — e.g. a pointer left down across a Play toggle).
    for (const d of DIGITAL) prevHeld[d] = frame.held[d];
    prevPointer.down = frame.pointer.down;
    suppressEdgesNextFrame = false;
  }
  computeEdges(frame, prevHeld);
  computePointerEdge(frame, prevPointer);

  world.query(Input).updateEach(([inp]: [InputFrame]) => {
    inp.axes.moveX = frame.axes.moveX;
    inp.axes.moveY = frame.axes.moveY;
    inp.axes.lookX = frame.axes.lookX;
    inp.axes.lookY = frame.axes.lookY;
    Object.assign(inp.held, frame.held);
    Object.assign(inp.pressed, frame.pressed);
    Object.assign(inp.released, frame.released);
    Object.assign(inp.pointer, frame.pointer);
    inp.lastDevice = frame.lastDevice;
  });

  if (frame.lastDevice !== repaintedDevice) {
    repaintedDevice = frame.lastDevice;
    markUIDirty(); // device switched → re-resolve device-appropriate prompts
  }
}
