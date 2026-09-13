/** ensurePhysicsReady's failure half (#1175). The REAL loader cannot be made to fail on demand,
 *  so the loader is replaced by one with the SAME memoisation contract (#541): `init()` returns the
 *  in-flight promise until a rejection clears it, and a permanent failure leaves the rejected
 *  promise memoised. What is under test is ensurePhysicsReady's reading of that contract — a fresh
 *  promise means "retry granted", the same one back means "gave up" — not Rapier. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const loader = vi.hoisted(() => ({
  ready: false,
  plan: [] as Array<'fail' | 'ok'>,   // outcome of each successive attempt
  attempts: 0,
  current: null as Promise<void> | null,
}));

vi.mock('../../src/runtime/physics/rapierLoader', () => ({
  isRapierReady: () => loader.ready,
  initRapier2D: () => {
    if (loader.current) return loader.current;
    const outcome = loader.plan[loader.attempts++] ?? 'fail';
    const p = outcome === 'ok'
      ? Promise.resolve().then(() => { loader.ready = true; })
      : Promise.reject(new Error(`wasm instantiate failed #${loader.attempts}`));
    loader.current = p;
    // Mirrors rapierLoader's `.catch`: clear on failure while budget remains (here: all but the
    // last planned attempt), else leave the rejection memoised.
    p.catch(() => { if (loader.attempts < loader.plan.length && loader.current === p) loader.current = null; });
    return p;
  },
}));

import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { ensurePhysicsReady } from '../../src/runtime/physics/physicsReady';

let tw: TestWorld | undefined;
beforeEach(() => { loader.ready = false; loader.plan = []; loader.attempts = 0; loader.current = null; });
afterEach(() => { tw?.dispose(); tw = undefined; });

describe('ensurePhysicsReady — a failing loader', () => {
  it('rides the loader\'s retry budget: two transient failures then a success resolves ok', async () => {
    loader.plan = ['fail', 'fail', 'ok'];
    tw = createTestWorld({});
    tw.spawn(RigidBody2D());
    expect(await ensurePhysicsReady(tw.world)).toEqual({ ok: true });
    expect(loader.attempts).toBe(3);
    expect(loader.ready).toBe(true);
  });

  it('a PERMANENT failure comes back as ok:false naming the module — it neither hangs nor rejects', async () => {
    loader.plan = ['fail', 'fail', 'fail'];
    tw = createTestWorld({});
    tw.spawn(RigidBody2D());
    const r = await ensurePhysicsReady(tw.world);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/^\[physics2D\] wasm instantiate failed #3$/);
    expect(loader.attempts).toBe(3);
  });
});
