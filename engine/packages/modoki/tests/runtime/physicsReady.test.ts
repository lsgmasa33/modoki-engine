/** ensurePhysicsReady / pendingPhysics (#1175) against the REAL Rapier loaders.
 *
 *  ⚠️ ORDER-DEPENDENT on purpose: the loaders are process-global, and vitest gives this file a
 *  fresh module registry, so Rapier starts NOT instantiated. The "no bodies" cases must run before
 *  the cases that load a module — once loaded it stays loaded for the rest of the file. */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { isRapierReady } from '../../src/runtime/physics/rapierLoader';
import { isRapier3DReady } from '../../src/runtime/physics/rapier3DLoader';
import { ensurePhysicsReady, pendingPhysics } from '../../src/runtime/physics/physicsReady';

let tw: TestWorld | undefined;
afterEach(() => { tw?.dispose(); tw = undefined; });

describe('ensurePhysicsReady', () => {
  it('a world with no bodies loads NO Rapier — a game without physics never downloads it', async () => {
    tw = createTestWorld({});
    expect(pendingPhysics(tw.world)).toEqual([]);
    expect(await ensurePhysicsReady(tw.world)).toEqual({ ok: true });
    expect(isRapierReady()).toBe(false);
    expect(isRapier3DReady()).toBe(false);
  });

  it('a world with a RigidBody2D resolves only once Rapier2D is instantiated — and leaves 3D alone', async () => {
    tw = createTestWorld({});
    tw.spawn(RigidBody2D());
    expect(pendingPhysics(tw.world).map((m) => m.name)).toEqual(['physics2D']);
    expect(await ensurePhysicsReady(tw.world)).toEqual({ ok: true });
    expect(isRapierReady()).toBe(true);
    expect(isRapier3DReady()).toBe(false);
    expect(pendingPhysics(tw.world)).toEqual([]);
  });

  it('a world with a RigidBody3D resolves only once Rapier3D is instantiated', async () => {
    tw = createTestWorld({});
    tw.spawn(RigidBody3D());
    expect(pendingPhysics(tw.world).map((m) => m.name)).toEqual(['physics3D']);
    expect(await ensurePhysicsReady(tw.world)).toEqual({ ok: true });
    expect(isRapier3DReady()).toBe(true);
  });
});
