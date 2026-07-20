/** Input resource + bridge systems — Phase 1 of the input-and-ui-focus plan.
 *
 *  Proves the generalized input seam headlessly and deterministically: set the
 *  canonical `Input` ECS resource by hand (no DOM, no gamepad), step the bridge
 *  systems, and assert the same `CharacterController2D/3D` fields the old
 *  keyboard-only path produced. Because the bridge now reads plain trait data, it
 *  runs INSIDE the harness — the exact discipline the plan generalizes.
 *
 *  Also unit-tests the pure action bookkeeping (edges + deadzone) in actions.ts. */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import {
  Input, setAxis, setDigital, setPointer,
  pointer, pointerDown, pointerPressed, pointerReleased, pointerPos, pointerDrag,
} from '../../src/runtime/traits/Input';
import { computePointerEdge } from '../../src/runtime/input/actions';
import { CharacterController2D } from '../../src/runtime/traits/CharacterController2D';
import { CharacterController3D } from '../../src/runtime/traits/CharacterController3D';
import { characterInputSystem } from '../../src/runtime/systems/characterInputSystem';
import { characterInput3DSystem } from '../../src/runtime/systems/characterInput3DSystem';
import { createInputFrame, beginSample, computeEdges, applyDeadzone, makeFlags } from '../../src/runtime/input/actions';

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; });

describe('Input resource → CharacterController2D (2D bridge)', () => {
  it('maps moveX axis and jump edge onto the controller', () => {
    game = createTestWorld({
      systems: [{ name: 'characterInput', fn: characterInputSystem, priority: SYSTEM_PRIORITY.GAME }],
    });
    game.spawn(Input);
    const player = game.spawn(CharacterController2D);

    // Idle: nothing set → no movement, no jump.
    game.step(1);
    expect(game.trait<{ moveX: number; jump: boolean }>(CharacterController2D, player).moveX).toBe(0);
    expect(game.trait<{ moveX: number; jump: boolean }>(CharacterController2D, player).jump).toBe(false);

    // Move right + jump via the resource (as a source would, but hand-set).
    setAxis(game.world, 'moveX', 1);
    setDigital(game.world, 'jump', true);
    game.step(1);
    expect(game.trait<{ moveX: number; jump: boolean }>(CharacterController2D, player).moveX).toBe(1);
    expect(game.trait<{ moveX: number; jump: boolean }>(CharacterController2D, player).jump).toBe(true);
  });

  it('treats navUp (W/↑) as a 2D jump too — the historical binding', () => {
    game = createTestWorld({
      systems: [{ name: 'characterInput', fn: characterInputSystem, priority: SYSTEM_PRIORITY.GAME }],
    });
    game.spawn(Input);
    const player = game.spawn(CharacterController2D);

    setDigital(game.world, 'navUp', true); // W/↑ pressed — no `jump` action
    game.step(1);
    expect(game.trait<{ jump: boolean }>(CharacterController2D, player).jump).toBe(true);
  });
});

describe('Input resource → CharacterController3D (3D bridge)', () => {
  it('maps moveX→moveX and forward (moveY=+1)→moveZ=-1, jump on Space only', () => {
    game = createTestWorld({
      systems: [{ name: 'characterInput3D', fn: characterInput3DSystem, priority: SYSTEM_PRIORITY.GAME }],
    });
    game.spawn(Input);
    const player = game.spawn(CharacterController3D);

    setAxis(game.world, 'moveX', -1);   // strafe left
    setAxis(game.world, 'moveY', 1);    // forward → into scene (-Z)
    setDigital(game.world, 'jump', true);
    game.step(1);
    const cc = game.trait<{ moveX: number; moveZ: number; jump: boolean }>(CharacterController3D, player);
    expect(cc.moveX).toBe(-1);
    expect(cc.moveZ).toBe(-1);          // forward is -Z (moveY negated)
    expect(cc.jump).toBe(true);
  });

  it('does NOT jump on navUp in 3D (W is forward there, not jump)', () => {
    game = createTestWorld({
      systems: [{ name: 'characterInput3D', fn: characterInput3DSystem, priority: SYSTEM_PRIORITY.GAME }],
    });
    game.spawn(Input);
    const player = game.spawn(CharacterController3D);

    setDigital(game.world, 'navUp', true); // forward, but not a jump
    game.step(1);
    expect(game.trait<{ jump: boolean }>(CharacterController3D, player).jump).toBe(false);
  });
});

describe('action bookkeeping (pure, source-agnostic)', () => {
  it('computeEdges derives pressed/released once per transition', () => {
    const frame = createInputFrame();
    const prev = makeFlags();

    // Frame 1: confirm goes down → pressed edge.
    beginSample(frame);
    frame.held.confirm = true;
    computeEdges(frame, prev);
    expect(frame.pressed.confirm).toBe(true);
    expect(frame.released.confirm).toBe(false);

    // Frame 2: still held → no edge (once per press).
    beginSample(frame);
    frame.held.confirm = true;
    computeEdges(frame, prev);
    expect(frame.pressed.confirm).toBe(false);
    expect(frame.released.confirm).toBe(false);

    // Frame 3: released → released edge.
    beginSample(frame);
    computeEdges(frame, prev);
    expect(frame.pressed.confirm).toBe(false);
    expect(frame.released.confirm).toBe(true);
  });

  it('applyDeadzone zeroes below threshold and rescales above it', () => {
    expect(applyDeadzone(0.1, 0.2)).toBe(0);
    expect(applyDeadzone(0.2, 0.2)).toBe(0);
    expect(applyDeadzone(1, 0.2)).toBe(1);
    expect(applyDeadzone(-1, 0.2)).toBe(-1);
    expect(applyDeadzone(0.6, 0.2)).toBeCloseTo(0.5, 5); // (0.6-0.2)/(1-0.2)
  });

  it('computePointerEdge derives the down-edge once per transition', () => {
    const frame = createInputFrame();
    const prev = { down: false };

    frame.pointer.down = true; computePointerEdge(frame, prev);
    expect(frame.pointer.pressed).toBe(true);
    expect(frame.pointer.released).toBe(false);

    frame.pointer.down = true; computePointerEdge(frame, prev);
    expect(frame.pointer.pressed).toBe(false);

    frame.pointer.down = false; computePointerEdge(frame, prev);
    expect(frame.pointer.released).toBe(true);
  });
});

describe('Input resource — pointer/tap/drag accessors', () => {
  it('setPointer scripts a press→drag→release with derived edges + drag delta', () => {
    game = createTestWorld({});
    game.spawn(Input);
    const w = game.world;

    // Idle default: up, no edges, zero position.
    expect(pointerDown(w)).toBe(false);
    expect(pointerPressed(w)).toBe(false);
    expect(pointerPos(w)).toEqual({ x: 0, y: 0 });

    // Press at (100,200): down + pressed edge, drag 0, start latched.
    setPointer(w, { x: 100, y: 200, down: true });
    expect(pointerDown(w)).toBe(true);
    expect(pointerPressed(w)).toBe(true);
    expect(pointerReleased(w)).toBe(false);
    expect(pointerPos(w)).toEqual({ x: 100, y: 200 });
    expect(pointerDrag(w)).toEqual({ x: 0, y: 0 });

    // Drag to (140,260): held (no new press edge), drag delta from the start point.
    setPointer(w, { x: 140, y: 260, down: true });
    expect(pointerPressed(w)).toBe(false);
    expect(pointerDown(w)).toBe(true);
    expect(pointerDrag(w)).toEqual({ x: 40, y: 60 });

    // Release: up + released edge, drag zeroed while up.
    setPointer(w, { x: 140, y: 260, down: false });
    expect(pointerDown(w)).toBe(false);
    expect(pointerReleased(w)).toBe(true);
    expect(pointerDrag(w)).toEqual({ x: 0, y: 0 });

    // A fresh press re-latches the start (new drag baseline).
    setPointer(w, { x: 300, y: 300, down: true });
    setPointer(w, { x: 310, y: 300, down: true });
    expect(pointerDrag(w)).toEqual({ x: 10, y: 0 });
    expect(pointer(w).startX).toBe(300);
  });

  it('accessors degrade safely with no Input resource', () => {
    game = createTestWorld({});
    expect(pointerDown(game.world)).toBe(false);
    expect(pointerPos(game.world)).toEqual({ x: 0, y: 0 });
    expect(pointerDrag(game.world)).toEqual({ x: 0, y: 0 });
  });
});
