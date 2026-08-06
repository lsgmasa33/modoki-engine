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
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import {
  Input, setAxis, setDigital, setPointer,
  pointer, pointerDown, pointerPressed, pointerReleased, pointerPos, pointerDrag,
  pointerPredictedPos, pointerVelocity, setPointerLeadMs, getPointerLeadMs,
  POINTER_LEAD_MS_DEFAULT, POINTER_LEAD_MS_ANDROID_60HZ,
  setPointerLeadGate, getPointerLeadGate, pointerLeadGateFactor, POINTER_LEAD_GATE_DEFAULTS,
} from '../../src/runtime/traits/Input';
import { computePointerEdge } from '../../src/runtime/core/inputActions';
import { setManualNow, restoreRealClock } from '../../src/runtime/core/clock';
import { CharacterController2D } from '../../src/runtime/traits/CharacterController2D';
import { CharacterController3D } from '../../src/runtime/traits/CharacterController3D';
import { characterInputSystem } from '../../src/runtime/input/characterInputSystem';
import { characterInput3DSystem } from '../../src/runtime/input/characterInput3DSystem';
import { createInputFrame, beginSample, computeEdges, applyDeadzone, makeFlags } from '../../src/runtime/core/inputActions';

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

  it('predicted-position accessors degrade safely with no Input resource', () => {
    game = createTestWorld({});
    expect(pointerVelocity(game.world)).toEqual({ x: 0, y: 0 });
    expect(pointerPredictedPos(game.world)).toEqual({ x: 0, y: 0 });
  });
});

/** Touch-to-photon latency compensation. The lead is engine-wide state, so these restore it. */
describe('pointerPredictedPos (latency compensation)', () => {
  const original = getPointerLeadMs();
  afterEach(() => setPointerLeadMs(original));

  /** Put a known velocity on the resource. `setPointer` does not touch vx/vy — it models a
   *  teleporting test pointer, not a swipe — so the fields are written directly, which is also
   *  how the headless harness is meant to drive input. */
  function withVelocity(g: TestWorld, x: number, y: number, vx: number, vy: number, t = 0): void {
    setPointer(g.world, { x, y, down: true });
    g.world.query(Input).updateEach(([inp]) => { inp.pointer.vx = vx; inp.pointer.vy = vy; inp.pointer.t = t; });
  }

  it('returns the TRUE position when the lead is 0 — prediction fully off', () => {
    game = createTestWorld({});
    game.world.spawn(Input);
    withVelocity(game, 100, 200, 2, -1);
    setPointerLeadMs(0);
    expect(pointerPredictedPos(game.world)).toEqual({ x: 100, y: 200 });
  });

  it('extrapolates by velocity x lead', () => {
    game = createTestWorld({});
    game.world.spawn(Input);
    withVelocity(game, 100, 200, 2, -1);       // px/ms
    setPointerLeadMs(50);
    expect(pointerPredictedPos(game.world)).toEqual({ x: 200, y: 150 });
    // An explicit lead overrides the global one, which is what the debug tuner drives.
    expect(pointerPredictedPos(game.world, 10)).toEqual({ x: 120, y: 190 });
  });

  it('equals the true position whenever the pointer is not moving', () => {
    game = createTestWorld({});
    game.world.spawn(Input);
    withVelocity(game, 42, 43, 0, 0);
    setPointerLeadMs(POINTER_LEAD_MS_ANDROID_60HZ);
    expect(pointerPredictedPos(game.world)).toEqual({ x: 42, y: 43 });
  });

  it('is OFF by default — a lead is opt-in, because on a 120Hz device any lead JITTERS', () => {
    // Measured: iPhone Air (120Hz) is best at 0 while the A23 (60Hz) needs ~83. A two-point
    // velocity over an 8.3ms gap turns a pixel of pointer noise into ~10px of extrapolation
    // error, so an engine-wide default would ship jitter to fast devices to fix slow ones.
    expect(POINTER_LEAD_MS_DEFAULT).toBe(0);
    game = createTestWorld({});
    game.world.spawn(Input);
    withVelocity(game, 100, 200, 5, 5);
    setPointerLeadMs(POINTER_LEAD_MS_DEFAULT);
    expect(pointerPredictedPos(game.world)).toEqual({ x: 100, y: 200 });
  });

  /** The fix for the iPhone Air jitter: advance to NOW + lead, not BY lead from the event.
   *  Input and display are asynchronous, so the newest sample's age varies every frame; adding a
   *  fixed offset to a position of varying staleness writes that phase noise into the pixels
   *  (Casiez et al., "Modeling and Reducing Spatial Jitter caused by Asynchronous Input and
   *  Output Rates" — the technique Chrome on Android has shipped by default since 2023). */
  describe('resamples to absolute time', () => {
    afterEach(() => restoreRealClock());

    it('adds the sample AGE to the lead, so a staler sample is advanced further', () => {
      game = createTestWorld({});
      game.world.spawn(Input);
      setManualNow(1000);
      withVelocity(game, 100, 200, 2, 0, 1000);      // sampled exactly now → age 0
      expect(pointerPredictedPos(game.world, 10)).toEqual({ x: 120, y: 200 });
      // Same sample, read 8ms later: it is 8ms staler, so it must be advanced 8ms further —
      // otherwise the drawn position walks backwards relative to the finger as the frame slips.
      setManualNow(1008);
      expect(pointerPredictedPos(game.world, 10)).toEqual({ x: 136, y: 200 });
    });

    it('clamps the age so a stale sample cannot fling the point', () => {
      game = createTestWorld({});
      game.world.spawn(Input);
      setManualNow(1000);
      withVelocity(game, 100, 200, 2, 0, 1000);
      setManualNow(6000);                             // 5 seconds stale — a backgrounded tab
      // Age clamps to 64ms (the velocity estimator's own window), not 5000.
      expect(pointerPredictedPos(game.world, 10)).toEqual({ x: 100 + 2 * (64 + 10), y: 200 });
    });

    it('a lead of 0 is FULLY off — not even the age term applies', () => {
      // Disabling a feature has to return exactly the previous behaviour, or "off" is a third
      // mode nobody asked for. This is the setting the iPhone Air measured best at.
      game = createTestWorld({});
      game.world.spawn(Input);
      setManualNow(1000);
      withVelocity(game, 100, 200, 2, 0, 900);        // 100ms stale AND moving
      expect(pointerPredictedPos(game.world, 0)).toEqual({ x: 100, y: 200 });
    });

    it('ignores the age when no sample time is known', () => {
      game = createTestWorld({});
      game.world.spawn(Input);
      setManualNow(9999);
      withVelocity(game, 100, 200, 2, 0, 0);          // t = 0 → the harness set it by hand
      expect(pointerPredictedPos(game.world, 10)).toEqual({ x: 120, y: 200 });
    });
  });

  /** The speed gate (owner, 2026-08-06: "if we can disable the prediction when the velocity is
   *  under threshold, this might be useable"). The two failure modes live at opposite ends of the
   *  speed range — tremor when nearly still, latency when moving — so one fixed lead serves
   *  neither. Ramped rather than switched: a hard threshold jumps the drawn position by
   *  `speed x lead` at the crossing, trading a tremor for a snap that is correlated with the
   *  gesture instead of with noise. */
  describe('speed gate', () => {
    const originalGate = getPointerLeadGate();
    afterEach(() => setPointerLeadGate(originalGate));

    it('is 0 at rest, 1 at full speed, and monotone between', () => {
      const g = (s: number) => pointerLeadGateFactor(s, 0.05, 0.5);
      expect(g(0)).toBe(0);
      expect(g(0.05)).toBe(0);          // AT the floor is still off — the floor is the noise line
      expect(g(0.5)).toBe(1);
      expect(g(5)).toBe(1);
      let prev = -1;
      for (let s = 0; s <= 0.6; s += 0.02) { const v = g(s); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
    });

    it('has a zero derivative at both ends — the property a hard threshold lacks', () => {
      // This is the whole reason it is a smoothstep: the lead must fade in without a
      // discontinuity in position OR velocity, or the fade itself becomes the artefact.
      const g = (s: number) => pointerLeadGateFactor(s, 0, 1);
      expect(g(0.01)).toBeLessThan(0.001);        // creeps away from 0, does not jump
      expect(1 - g(0.99)).toBeLessThan(0.001);    // and eases into 1
      expect(g(0.5)).toBeCloseTo(0.5, 9);         // symmetric about the midpoint
    });

    it('suppresses the lead entirely for a slow drag, and applies it fully for a fast one', () => {
      game = createTestWorld({});
      game.world.spawn(Input);
      setPointerLeadMs(80);
      setPointerLeadGate({ minSpeed: 0.05, fullSpeed: 0.5 });

      withVelocity(game, 100, 200, 0.02, 0);      // below the noise floor
      expect(pointerPredictedPos(game.world)).toEqual({ x: 100, y: 200 });

      withVelocity(game, 100, 200, 2, 0);         // a flick: full lead
      expect(pointerPredictedPos(game.world).x).toBeCloseTo(100 + 2 * 80, 6);
    });

    it('⚠️ below the floor the offset is EXACTLY zero — the age term is gated too', () => {
      // Measured regression (A23, owner holding a piece still): the age term was left ungated on
      // the argument that it was "self-limiting" against a near-zero velocity. It was not — below
      // the floor it still produced up to 2.5px, and because `age` varies with input/display
      // phase, that offset varied frame to frame. Jitter surviving the gate is exactly what the
      // gate exists to stop.
      game = createTestWorld({});
      game.world.spawn(Input);
      setPointerLeadMs(80);
      setPointerLeadGate({ minSpeed: 0.2, fullSpeed: 0.6 });
      setManualNow(1064);
      withVelocity(game, 100, 200, 0.15, 0.05, 1000);   // under the floor, and 64ms STALE
      expect(pointerPredictedPos(game.world)).toEqual({ x: 100, y: 200 });
      restoreRealClock();
    });

    it('ships a floor clear of the measured estimator noise', () => {
      // A still hand measured a MEDIAN estimated speed of 0.065 px/ms. A floor at or below that
      // makes the gate flicker, which converts a steady offset into tremor — worse than no gate.
      expect(POINTER_LEAD_GATE_DEFAULTS.minSpeed).toBeGreaterThan(0.065 * 2);
    });

    it('a degenerate gate (full <= min) is a plain threshold, not a divide-by-zero', () => {
      setPointerLeadGate({ minSpeed: 0.5, fullSpeed: 0.1 });   // inverted by the caller
      const g = getPointerLeadGate();
      expect(g.fullSpeed).toBeGreaterThanOrEqual(g.minSpeed);  // clamped, not inverted
      expect(Number.isFinite(pointerLeadGateFactor(0.6, 0.5, 0.5))).toBe(true);
      expect(pointerLeadGateFactor(0.6, 0.5, 0.5)).toBe(1);
      expect(pointerLeadGateFactor(0.4, 0.5, 0.5)).toBe(0);
    });

    it('ships defaults that are a starting point, and the gate is live-tunable', () => {
      expect(POINTER_LEAD_GATE_DEFAULTS.minSpeed).toBeGreaterThan(0);
      expect(POINTER_LEAD_GATE_DEFAULTS.fullSpeed).toBeGreaterThan(POINTER_LEAD_GATE_DEFAULTS.minSpeed);
      setPointerLeadGate({ minSpeed: 0.2 });
      expect(getPointerLeadGate().minSpeed).toBeCloseTo(0.2, 9);
    });
  });

  it('clamps a negative or non-finite lead to 0 rather than predicting into the past', () => {
    setPointerLeadMs(-100);
    expect(getPointerLeadMs()).toBe(0);
    setPointerLeadMs(NaN);
    expect(getPointerLeadMs()).toBe(0);
  });

  it('never moves pointerPos — the truth a hit-test reads is untouched by the lead', () => {
    game = createTestWorld({});
    game.world.spawn(Input);
    withVelocity(game, 100, 200, 5, 5);
    setPointerLeadMs(POINTER_LEAD_MS_ANDROID_60HZ);
    expect(pointerPos(game.world)).toEqual({ x: 100, y: 200 });
    expect(pointerPredictedPos(game.world)).not.toEqual({ x: 100, y: 200 });
  });
});
