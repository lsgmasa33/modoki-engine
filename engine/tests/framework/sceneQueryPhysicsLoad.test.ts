/** `scene-query`'s wait on an unloaded Rapier module (#1260 close-out review).
 *
 *  `sceneQueryOp.test.ts` loads real Rapier, so it never reaches this branch; `sceneQueryAbsence.test.ts`
 *  pins the pure classifier. What is pinned HERE is the op's own wait, with loaders that have the
 *  real contract (#541: one memoised in-flight promise; a permanent failure stays memoised):
 *  - it waits on THIS dimension's module only — a hanging 2D load must not turn a failed 3D load
 *    into "still loading, retry" (observed by the review before the fix);
 *  - a load still running after the bound is `physics-loading`;
 *  - a stopped sim does not wait, or start a download, to answer "start the sim".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Mode = 'hang' | 'fail' | 'ok';
const loaders = vi.hoisted(() => {
  const make = () => ({ ready: false, mode: 'hang' as Mode, current: null as Promise<void> | null, calls: 0 });
  const init = (l: ReturnType<typeof make>) => {
    l.calls++;
    if (!l.current) {
      l.current = l.mode === 'fail' ? Promise.reject(new Error('wasm instantiate failed'))
        : l.mode === 'ok' ? Promise.resolve().then(() => { l.ready = true; })
          : new Promise<void>(() => { /* never settles */ });
      l.current.catch(() => { /* memoised: permanent */ });
    }
    return l.current;
  };
  return { r2: make(), r3: make(), make, init };
});
vi.mock('../../packages/modoki/src/runtime/physics/rapierLoader', () => ({
  isRapierReady: () => loaders.r2.ready,
  getRapier: () => { throw new Error('test loader: no Rapier module'); },
  initRapier2D: () => loaders.init(loaders.r2),
}));
vi.mock('../../packages/modoki/src/runtime/physics/rapier3DLoader', () => ({
  isRapier3DReady: () => loaders.r3.ready,
  getRapier3D: () => { throw new Error('test loader: no Rapier3D module'); },
  initRapier3D: () => loaders.init(loaders.r3),
}));

import { runAgentOp } from '../../app/debug/agentBridge';
import { createTestWorld, type TestWorld, RigidBody2D, RigidBody3D, setPlayState } from '@modoki/engine/runtime';

let tw: TestWorld | undefined;
beforeEach(() => {
  Object.assign(loaders.r2, loaders.make());
  Object.assign(loaders.r3, loaders.make());
  tw = createTestWorld({});
  setPlayState('playing');
});
afterEach(() => { vi.useRealTimers(); setPlayState('stopped'); tw?.dispose(); tw = undefined; });

type Reply = { ok?: boolean; code?: string; reason?: string; hint?: string };
const cast3d = () => runAgentOp('scene-query', { kind: 'raycast', dim: '3d', origin: [0, 10, 0], direction: [0, -1, 0] }) as Promise<Reply>;

describe('scene-query — waiting on an unloaded Rapier module', () => {
  it('a failed 3D load is physics-failed even while the 2D load hangs', async () => {
    tw!.spawn(RigidBody2D());
    tw!.spawn(RigidBody3D());
    loaders.r3.mode = 'fail';           // r2 stays 'hang'
    const r = await cast3d();
    expect(r.code).toBe('NOT_AVAILABLE_HERE');
    expect(r.reason).toBe('physics-failed');
    expect(r.hint).toContain('wasm instantiate failed');
  });

  it('a 3D load that loaded, beside a failed 2D one, is not-built-yet', async () => {
    tw!.spawn(RigidBody2D());
    tw!.spawn(RigidBody3D());
    loaders.r2.mode = 'fail';
    loaders.r3.mode = 'ok';
    expect((await cast3d()).reason).toBe('not-built-yet');
  });

  it('a 3D load still running after the bound is physics-loading', async () => {
    vi.useFakeTimers();
    tw!.spawn(RigidBody3D());           // r3 hangs
    const p = cast3d();
    await vi.advanceTimersByTimeAsync(1600);
    expect((await p).reason).toBe('physics-loading');
  });

  it('a stopped sim answers stopped without waiting or starting a download', async () => {
    tw!.spawn(RigidBody3D());
    setPlayState('stopped');
    const r = await cast3d();
    expect(r.reason).toBe('stopped');
    expect(loaders.r3.calls).toBe(0);
  });
});
