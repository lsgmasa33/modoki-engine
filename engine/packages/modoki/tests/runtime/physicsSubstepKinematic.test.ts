/** A KINEMATIC body must push a dynamic one the same way at 30 fps as at 60 — the property the
 *  substep fix (#205 R2) exists for, applied to the one case it originally broke.
 *
 *  ⚠️ **THE DEFECT THIS FILE PINS.** Splitting a frame into two solver steps while issuing the
 *  kinematic target ONCE per frame makes Rapier derive the body's implicit velocity as
 *  `(target - current) / h` — twice the real speed in substep 1, then zero in substep 2, because
 *  the target has already been reached. Measured against raw Rapier over 1 s (platform travelling
 *  exactly 2.000000 m in every case): a carried box kept **4%** of its 60 fps velocity and slid
 *  1.5 m off the back, and a box in the platform's path was shoved **~2x** as fast. So the fix
 *  meant to stop a frame cap changing behaviour introduced a far larger change of its own, on
 *  exactly the `low` tier it ships to. `retargetKinematics` re-issues the target per substep;
 *  see `substepFraction` (physicsSubstep.ts).
 *
 *  ⚠️ **THE ASSERTIONS ARE CROSS-RATE COMPARISONS, NOT ABSOLUTE NUMBERS.** A fixture pinning "the
 *  box ends at x = 1.56" would pass a build where BOTH rates are equally wrong, which is the whole
 *  class of bug here. Each test runs the same simulated second twice — once at dt 1/60 (one step
 *  per tick) and once at dt 1/30 (two) — and asserts the outcomes agree. Revert either dimension's
 *  `retargetKinematics` and the 30 fps leg diverges by 90%+.
 *
 *  Both dimensions are asserted in one file deliberately: the mechanism is duplicated per
 *  dimension (a quaternion vs an angle is the only real difference), and a copy that silently
 *  loses the fix is exactly what a shared test catches. */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { Transform } from '../../src/runtime/core/traits/Transform';
import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { Collider3D } from '../../src/runtime/traits/Collider3D';
import { Physics3D } from '../../src/runtime/traits/Physics3D';
import { physics3DSystem, disposePhysics3D } from '../../src/runtime/physics/physics3DSystem';
import { initRapier3D } from '../../src/runtime/physics/rapier3DLoader';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import { physics2DSystem, disposePhysics2D } from '../../src/runtime/physics/physics2DSystem';
import { initRapier2D } from '../../src/runtime/physics/rapierLoader';
import { physicsSubsteps, substepFraction, substepLerp } from '../../src/runtime/physics/physicsSubstep';

beforeAll(async () => { await initRapier3D(); await initRapier2D(); });

let tw: TestWorld | undefined;
afterEach(() => {
  if (tw) { disposePhysics3D(tw.world); disposePhysics2D(tw.world); tw.dispose(); tw = undefined; }
});

const PHYS3 = { name: 'physics3D', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS };
const PHYS2 = { name: 'physics2D', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS };

const PLATFORM_SPEED = 2;   // world units per second

type Tf = { x: number; y: number; z: number };

/** One second of simulation at `fps`, advancing the kinematic platform's authored Transform by
 *  the frame's own delta each tick — so the platform covers the SAME total distance whatever the
 *  rate. Without that control the comparison would be meaningless, so the platform's final x is
 *  returned and asserted alongside the box's. */
function run3D(fps: number): { box: Tf; platformX: number } {
  const dt = 1 / fps;
  tw = createTestWorld({ systems: [PHYS3] });
  tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0, unitsPerMeter: 1 }));
  const platform = tw.spawn(
    Transform({ x: 0, y: 0, z: 0 }),
    RigidBody3D({ bodyType: 'kinematic' }),
    Collider3D({ shape: 'box', halfW: 2, halfH: 0.5, halfD: 2, friction: 1 }),
  );
  const box = tw.spawn(
    Transform({ x: 0, y: 1.05, z: 0 }),
    RigidBody3D({ bodyType: 'dynamic' }),
    Collider3D({ shape: 'box', halfW: 0.25, halfH: 0.25, halfD: 0.25, friction: 1, restitution: 0 }),
  );
  for (let i = 0; i < fps; i++) {
    const t = tw.trait<Tf>(Transform, platform);
    platform.set(Transform, { ...t, x: t.x + PLATFORM_SPEED * dt });
    tw.step(1, dt);
  }
  return { box: { ...tw.trait<Tf>(Transform, box) }, platformX: tw.trait<Tf>(Transform, platform).x };
}

/** The 2D twin: gravity pulls +Y (screen down), so the box rides on TOP at a smaller y. */
function run2D(fps: number): { box: Tf; platformX: number } {
  const dt = 1 / fps;
  tw = createTestWorld({ systems: [PHYS2] });
  tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 1 }));
  const platform = tw.spawn(
    Transform({ x: 0, y: 0, z: 0 }),
    RigidBody2D({ bodyType: 'kinematic' }),
    Collider2D({ shape: 'box', halfW: 2, halfH: 0.5, friction: 1 }),
  );
  const box = tw.spawn(
    Transform({ x: 0, y: -1.05, z: 0 }),
    RigidBody2D({ bodyType: 'dynamic' }),
    Collider2D({ shape: 'box', halfW: 0.25, halfH: 0.25, friction: 1, restitution: 0 }),
  );
  for (let i = 0; i < fps; i++) {
    const t = tw.trait<Tf>(Transform, platform);
    platform.set(Transform, { ...t, x: t.x + PLATFORM_SPEED * dt });
    tw.step(1, dt);
  }
  return { box: { ...tw.trait<Tf>(Transform, box) }, platformX: tw.trait<Tf>(Transform, platform).x };
}

describe('a carried box travels with its platform at the same speed whatever the frame rate', () => {
  it('3D: the 30 fps leg (two substeps) matches the 60 fps leg', () => {
    const fast = run3D(60);
    tw!.dispose(); tw = undefined;
    const slow = run3D(30);

    // The control: the platform covered the same ground either way, so any difference in the box
    // is about HOW it was carried, not about how far the platform went.
    expect(slow.platformX).toBeCloseTo(fast.platformX, 6);
    expect(fast.platformX).toBeCloseTo(PLATFORM_SPEED, 6);

    // The box rode along in both. Pre-fix the 30 fps leg kept ~4% of the distance, so 0.2 world
    // units of tolerance is far tighter than the defect and far looser than solver noise.
    expect(slow.box.x).toBeCloseTo(fast.box.x, 1);
    expect(slow.box.x).toBeGreaterThan(1);   // it was actually carried, not left behind
    expect(slow.box.y).toBeCloseTo(fast.box.y, 1);
  });

  it('2D: the 30 fps leg (two substeps) matches the 60 fps leg', () => {
    const fast = run2D(60);
    tw!.dispose(); tw = undefined;
    const slow = run2D(30);

    expect(slow.platformX).toBeCloseTo(fast.platformX, 6);
    expect(slow.box.x).toBeCloseTo(fast.box.x, 1);
    expect(slow.box.x).toBeGreaterThan(1);
    expect(slow.box.y).toBeCloseTo(fast.box.y, 1);
  });
});

describe('substepFraction / substepLerp — the split itself', () => {
  it('an unsplit frame interpolates to exactly the target (bit-for-bit, not merely close)', () => {
    // The `count === 1` path must be byte-identical to the pre-substep engine, so `frac` is 1 and
    // the lerp returns `b` itself — `a + (b-a)*1` is NOT guaranteed to, for large or tiny values.
    expect(substepFraction(0, 1)).toBe(1);
    expect(substepLerp(0.1, 0.3, 1)).toBe(0.3);
    expect(substepLerp(1e300, 1e-300, 1)).toBe(1e-300);
  });

  it('a split frame lands each substep at its own end, finishing exactly on the target', () => {
    expect(substepFraction(0, 2)).toBe(0.5);
    expect(substepFraction(1, 2)).toBe(1);
    expect(substepLerp(0, 10, substepFraction(0, 2))).toBe(5);
    expect(substepLerp(0, 10, substepFraction(1, 2))).toBe(10);
  });

  it('the 30 fps frame this is all about really does split in two', () => {
    // Anchors the tests above to the real trigger: if `SPLIT_TOLERANCE` ever grew enough to stop
    // splitting 1/30, every cross-rate assertion in this file would pass vacuously.
    expect(physicsSubsteps(1 / 30).count).toBe(2);
    expect(physicsSubsteps(1 / 60).count).toBe(1);
  });
});
