/** Gamepad source — Phase 2 of the input-and-ui-focus plan.
 *
 *  UNIT: the pure `sampleGamepadInto` mapper (W3C standard-gamepad snapshot → action
 *  vocabulary), driven with fabricated snapshots — no DOM, fully deterministic.
 *  INTEGRATION: the whole `inputSystem` path (reset → sampleAll every registered
 *  source → clamp → derive edges → write the Input resource), driven through a fake
 *  source registered into the same registry a real gamepad would use — proving edges
 *  fire once per press and cross-source axes clamp. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { sampleGamepadInto, type GamepadSnapshot } from '../../src/runtime/input/gamepadSource';
import { createInputFrame, clampAxes } from '../../src/runtime/input/actions';
import { inputSystem } from '../../src/runtime/systems/inputSystem';
import { Input, getInput } from '../../src/runtime/traits/Input';
import { registerSource, unregisterSource, type InputSource } from '../../src/runtime/input/inputSources';
import { setPlayState } from '../../src/runtime/systems/playState';

/** Build a W3C standard-gamepad snapshot. `axes` defaults to centered sticks;
 *  `down` lists pressed button indices. */
function mkPad({ axes = [0, 0, 0, 0], down = [] }: { axes?: number[]; down?: number[] }): GamepadSnapshot {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false }));
  for (const i of down) buttons[i] = { pressed: true };
  return { axes, buttons };
}

describe('sampleGamepadInto (pure mapper)', () => {
  it('left stick → moveX/moveY, Y negated (up = +1), deadzoned', () => {
    const f = createInputFrame();
    expect(sampleGamepadInto(mkPad({ axes: [1, -1, 0, 0] }), f)).toBe(true);
    expect(f.axes.moveX).toBeCloseTo(1, 5);
    expect(f.axes.moveY).toBeCloseTo(1, 5); // browser +Y down → forward/up = +1
  });

  it('right stick → lookX/lookY, same sign convention', () => {
    const f = createInputFrame();
    sampleGamepadInto(mkPad({ axes: [0, 0, 1, -1] }), f);
    expect(f.axes.lookX).toBeCloseTo(1, 5);
    expect(f.axes.lookY).toBeCloseTo(1, 5);
  });

  it('a stick inside the deadzone contributes nothing (and is not "active")', () => {
    const f = createInputFrame();
    expect(sampleGamepadInto(mkPad({ axes: [0.1, 0.1, 0, 0] }), f)).toBe(false);
    expect(f.axes.moveX).toBe(0);
    expect(f.axes.moveY).toBe(0);
  });

  it('A → confirm + jump; B → cancel; Start → menu + pause', () => {
    const a = createInputFrame();
    sampleGamepadInto(mkPad({ down: [0] }), a);
    expect(a.held.confirm).toBe(true);
    expect(a.held.jump).toBe(true);

    const b = createInputFrame();
    sampleGamepadInto(mkPad({ down: [1] }), b);
    expect(b.held.cancel).toBe(true);

    const start = createInputFrame();
    sampleGamepadInto(mkPad({ down: [9] }), start);
    expect(start.held.menu).toBe(true);
    expect(start.held.pause).toBe(true);
  });

  it('D-pad drives BOTH nav edges and discrete locomotion (keyboard-arrow parity)', () => {
    const f = createInputFrame();
    sampleGamepadInto(mkPad({ down: [12, 15] }), f); // up + right
    expect(f.held.navUp).toBe(true);
    expect(f.held.navRight).toBe(true);
    expect(f.axes.moveY).toBe(1);
    expect(f.axes.moveX).toBe(1);
  });

  it('stick + D-pad can exceed unit range; clampAxes normalizes to ∓1', () => {
    const f = createInputFrame();
    sampleGamepadInto(mkPad({ axes: [1, 0, 0, 0], down: [15] }), f); // stick right + d-pad right
    expect(f.axes.moveX).toBeCloseTo(2, 5);
    clampAxes(f);
    expect(f.axes.moveX).toBe(1);
  });
});

describe('inputSystem integration (registry → Input resource, edges, clamp)', () => {
  const registered: string[] = [];
  afterEach(() => {
    for (const n of registered) unregisterSource(n);
    registered.length = 0;
    setPlayState('stopped'); // reset play state so the edge-suppression flag can't leak
  });

  it('samples registered sources, writes the Input resource, and fires edges once', () => {
    // A fake source standing in for a gamepad (deterministic, no DOM). It reports a
    // held confirm + full-right moveX each frame it is registered.
    const fake: InputSource = {
      name: 'test:pad',
      attach() {}, detach() {},
      sample(out) { out.axes.moveX += 1; out.held.confirm = true; out.lastDevice = 'gamepad'; },
    };
    registerSource(fake); registered.push('test:pad');

    const world = createWorld();
    world.spawn(Input);

    // Frame 1: confirm goes down → held + pressed edge; axis written; device tracked.
    inputSystem(world);
    let inp = getInput(world)!;
    expect(inp.axes.moveX).toBe(1);
    expect(inp.held.confirm).toBe(true);
    expect(inp.pressed.confirm).toBe(true);
    expect(inp.released.confirm).toBe(false);
    expect(inp.lastDevice).toBe('gamepad');

    // Frame 2: still held → no fresh edge (once per press).
    inputSystem(world);
    inp = getInput(world)!;
    expect(inp.held.confirm).toBe(true);
    expect(inp.pressed.confirm).toBe(false);

    // Frame 3: source gone → confirm released this frame, then clears.
    unregisterSource('test:pad'); registered.length = 0;
    inputSystem(world);
    inp = getInput(world)!;
    expect(inp.held.confirm).toBe(false);
    expect(inp.released.confirm).toBe(true);
    expect(inp.axes.moveX).toBe(0);
  });

  it('suppresses a phantom edge for an action already held at play-start', () => {
    // A source reporting a button held every frame (as a real pad polled via
    // getGamepads would, if A were physically down when the user clicked Play).
    const heldPad: InputSource = { name: 'test:held', attach() {}, detach() {}, sample(out) { out.held.confirm = true; } };
    registerSource(heldPad); registered.push('test:held');

    const world = createWorld();
    world.spawn(Input);

    setPlayState('playing'); // arms the first-frame edge suppression
    inputSystem(world);      // frame 1: confirm is held, but NOT a fresh press
    let inp = getInput(world)!;
    expect(inp.held.confirm).toBe(true);
    expect(inp.pressed.confirm).toBe(false); // phantom edge suppressed — no auto-confirm/jump

    inputSystem(world);      // frame 2: still held → still no edge
    inp = getInput(world)!;
    expect(inp.pressed.confirm).toBe(false);
  });

  it('clamps an axis two sources both push (kbd + pad) to ∓1', () => {
    const padA: InputSource = { name: 'test:a', attach() {}, detach() {}, sample(out) { out.axes.moveX += 1; } };
    const padB: InputSource = { name: 'test:b', attach() {}, detach() {}, sample(out) { out.axes.moveX += 1; } };
    registerSource(padA); registered.push('test:a');
    registerSource(padB); registered.push('test:b');

    const world = createWorld();
    world.spawn(Input);
    inputSystem(world);
    expect(getInput(world)!.axes.moveX).toBe(1); // 1 + 1 = 2, clamped
  });
});
