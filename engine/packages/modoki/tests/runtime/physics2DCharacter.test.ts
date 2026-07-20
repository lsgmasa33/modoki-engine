/** Kinematic character controller (Phase 4.5) — walks on ground, is blocked by walls,
 *  falls under gravity, and auto-steps small ledges. Driven purely by trait fields
 *  (moveX/jump), so the whole thing verifies headlessly + deterministically. */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { CharacterController2D } from '../../src/runtime/traits/CharacterController2D';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import { physics2DSystem, disposePhysics2D } from '../../src/runtime/systems/physics2DSystem';
import { initRapier2D } from '../../src/runtime/systems/rapierLoader';

beforeAll(async () => { await initRapier2D(); });
let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics2D(tw.world); tw.dispose(); tw = undefined; } });

function world() {
  tw = createTestWorld({ systems: [{ name: 'p', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
  tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
  return tw;
}
function floor(x = 0, y = 500, halfW = 400) {
  tw!.spawn(Transform({ x, y }), RigidBody2D({ bodyType: 'static' }),
    Collider2D({ shape: 'box', halfW, halfH: 20, friction: 0.9 }));
}
function character(x = 0, y = 440, extra: Record<string, unknown> = {}) {
  return tw!.spawn(Transform({ x, y }),
    RigidBody2D({ bodyType: 'kinematic' }),
    Collider2D({ shape: 'box', halfW: 20, halfH: 40, friction: 0.9 }),
    CharacterController2D({ speed: 300, ...extra }));
}
const y = (e: unknown) => tw!.trait<{ y: number }>(Transform, e).y;
const x = (e: unknown) => tw!.trait<{ x: number }>(Transform, e).x;
const cc = (e: unknown) => tw!.trait<{ grounded: boolean; velY: number }>(CharacterController2D, e);

describe('physics2D — character controller', () => {
  it('walks along the ground and reports grounded', () => {
    world(); floor();
    const c = character(0, 440, { moveX: 1 });
    tw!.step(60);
    expect(x(c)).toBeGreaterThan(120);        // moved right
    expect(y(c)).toBeLessThan(470);           // stayed on the floor (~440), didn't sink
    expect(cc(c).grounded).toBe(true);
  });

  it('falls under gravity when unsupported and is not grounded', () => {
    world();                                   // no floor
    const c = character(0, 100, { moveX: 0 });
    tw!.step(30);
    expect(y(c)).toBeGreaterThan(160);        // fell (screen-down +Y)
    expect(cc(c).grounded).toBe(false);
  });

  it('is blocked by a wall (collide-and-slide)', () => {
    world(); floor();
    tw!.spawn(Transform({ x: 220, y: 400 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 20, halfH: 120, friction: 0.5 }));
    const c = character(0, 440, { moveX: 1 });
    tw!.step(120);
    expect(x(c)).toBeGreaterThan(80);          // walked toward the wall
    expect(x(c)).toBeLessThan(185);            // stopped at it (wall left face x=200)
  });

  it('honors an external Transform write (respawn / teleport)', () => {
    world(); floor();
    const c = character(0, 440, { moveX: 0 });
    tw!.step(20);                                          // settle on the floor
    expect(Math.abs(x(c))).toBeLessThan(20);
    c.set(Transform, { ...c.get(Transform) as object, x: 300 }); // teleport
    tw!.step(10);
    expect(x(c)).toBeGreaterThan(260);                    // moved to the new spot, not stuck at 0
    expect(x(c)).toBeLessThan(340);
  });

  it('auto-steps a small ledge only when autostep is enabled', () => {
    function run(autostep: number): number {
      world();
      floor(0, 500, 400);                        // full-width floor, top y=480
      // A 20-unit-high ledge sitting on the floor from x=[100,400], top y=460.
      tw!.spawn(Transform({ x: 250, y: 470 }), RigidBody2D({ bodyType: 'static' }),
        Collider2D({ shape: 'box', halfW: 150, halfH: 10, friction: 0.9 }));
      const c = character(0, 440, { moveX: 1, autostepHeight: autostep, autostepMinWidth: 10, snapToGroundDist: 20 });
      tw!.step(150);
      return x(c);
    }
    const climbed = run(30);      // autostep on → steps up the 20-unit lip + keeps going
    const blocked = run(0);       // autostep off → stuck at the ledge face (~x=80)
    expect(climbed).toBeGreaterThan(blocked + 60);
  });
});

describe('physics2D — character jump (T2)', () => {
  it('a grounded jump rises then re-grounds, and jump is a one-shot (auto-reset)', () => {
    world(); floor();
    const c = character(0, 440, { moveX: 0, jumpSpeed: 600 });
    tw!.step(3);                                 // settle onto the floor
    expect(cc(c).grounded).toBe(true);
    const yGround = y(c);
    (c as { set: (t: unknown, v: unknown) => void }).set(CharacterController2D, { jump: true });
    tw!.step(3);
    expect(cc(c).jump).toBe(false);              // consumed this frame (one-shot)
    expect(y(c)).toBeLessThan(yGround - 5);      // rose (screen up = smaller y)
    tw!.step(150);
    expect(y(c)).toBeGreaterThan(yGround - 5);   // came back down
    expect(cc(c).grounded).toBe(true);
  });

  it('a jump pressed while airborne is ignored (no upward launch)', () => {
    world();                                     // no floor → falling
    const c = character(0, 100, { moveX: 0 });
    tw!.step(10);
    expect(cc(c).grounded).toBe(false);
    expect(cc(c).velY).toBeGreaterThan(0);       // falling (down = +Y)
    (c as { set: (t: unknown, v: unknown) => void }).set(CharacterController2D, { jump: true });
    tw!.step(1);
    expect(cc(c).velY).toBeGreaterThan(0);       // still falling — no launch
    expect(cc(c).jump).toBe(false);              // still consumed
  });

  it('holding jump does not fly (only jumps when grounded)', () => {
    world(); floor();
    const c = character(0, 440, { moveX: 0, jumpSpeed: 600 });
    tw!.step(3);
    const yGround = y(c);
    for (let i = 0; i < 200; i++) {              // re-assert jump every frame (held key)
      (c as { set: (t: unknown, v: unknown) => void }).set(CharacterController2D, { jump: true });
      tw!.step(1);
    }
    expect(y(c)).toBeGreaterThan(yGround - 250); // bounded hop height, never accumulates upward
  });
});
