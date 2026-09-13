/** The device `sim-step` op never steps a body whose Rapier WASM is not instantiated (#1175) — the
 *  REAL loader, end to end. Physics-free frames reported as `ok:true` were the defect.
 *
 *  The op waits for the load inside its own `timeoutMs` budget (the host transport deadline is
 *  derived from that same number, so the wait cannot outlive it). The budget-exhausted and
 *  permanent-failure branches need a controllable loader: agentOpsPhysicsRaces.test.ts.
 *
 *  Own file: the loader is process-global, and this must start with Rapier NOT instantiated. */

import { describe, it, expect, afterEach } from 'vitest';
import { runAgentOp } from '../../app/debug/agentBridge';
import {
  createTestWorld, type TestWorld, RigidBody2D, isRapierReady, getCurrentWorld,
  setTimeScale, getTimeScale,
} from '@modoki/engine/runtime';

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; });

describe('sim-step — physics readiness (real loader)', () => {
  it('a cold body: the op waits for Rapier2D, then proceeds to the frame loop', async () => {
    game = createTestWorld({});
    game.spawn(RigidBody2D());
    const world = getCurrentWorld();
    setTimeScale(world, 0);
    expect(isRapierReady(), 'premise: Rapier starts cold in this file').toBe(false);

    const r = await runAgentOp('sim-step', { frames: 1, timeoutMs: 5000 }) as
      { ok?: boolean; error?: string; physicsLoading?: string[] };

    expect(isRapierReady()).toBe(true);
    expect(r.physicsLoading).toBeUndefined();
    // Headless: no rAF loop, so a step that PROCEEDED ends on the frame-loop timeout path.
    expect(r.error).toMatch(/frame loop/i);
    expect(getTimeScale(world), 'the world is re-frozen').toBe(0);
  });
});
