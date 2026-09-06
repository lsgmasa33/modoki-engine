/** #682 — frame-fed reads (`scene-state` world/bounds, `layout-bounds`, `hit-regions`,
 *  `scene-query`, `profiler`, `watch-read`) carry a staleness note on the EXISTING `warnings`
 *  array whenever the frame loop is not plainly healthy, via the shared `frameStalenessWarning`
 *  helper in `agentBridge.ts`.
 *
 *  Most cases here run in the SUITE'S DEFAULT headless state: `createTestWorld` never touches the
 *  frame driver at all (no renderer, no rAF), so `getFrameLoopHealth().status` is `'idle'` unless a
 *  test arms it — exactly the "a loop that never ran" half of the bug this issue calls out
 *  (`worldTransforms`/bounds/etc. dropped a key or reported nothing with no explanation). The
 *  ACCEPT side (a healthy, RUNNING loop stays silent) is proven separately for `scene-state`,
 *  using the same dead/live-loop simulator as the other #682 test files. */

import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import {
  createTestWorld, type TestWorld,
  Transform, EntityAttributes, RigidBody3D, Collider3D, Physics3D,
  physics3DSystem, disposePhysics3D, initRapier3D,
  SYSTEM_PRIORITY, startFrameDriver, stopFrameDriver,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();

let tw: TestWorld | undefined;
afterEach(() => {
  if (tw) { disposePhysics3D(tw.world); tw.dispose(); }
  tw = undefined;
});

type Warned = { warnings?: string[] };

describe('frame-fed reads warn when the loop has never pumped a frame (#682, default headless state)', () => {
  it('scene-state: world enricher carries a staleness warning', async () => {
    tw = createTestWorld({});
    tw.spawn(Transform({}), EntityAttributes({ name: 'Thing' }));
    const r = await runAgentOp('scene-state', { world: true }) as Warned;
    expect(r.warnings?.some((w) => w.includes('world/bounds'))).toBe(true);
    // The 'idle' half of the bug: a loop that NEVER ran must say so, not just look empty.
    expect(r.warnings?.some((w) => w.includes('No frames are being pumped'))).toBe(true);
  });

  it('scene-state: bounds enricher carries a staleness warning too', async () => {
    tw = createTestWorld({});
    tw.spawn(Transform({}), EntityAttributes({ name: 'Thing' }));
    const r = await runAgentOp('scene-state', { bounds: true }) as Warned;
    expect(r.warnings?.some((w) => w.includes('world/bounds'))).toBe(true);
  });

  it('scene-state: an UNENRICHED (index-mode) call carries no staleness note — nothing frame-fed was asked for', async () => {
    tw = createTestWorld({});
    tw.spawn(Transform({}), EntityAttributes({ name: 'Thing' }));
    const r = await runAgentOp('scene-state', {}) as Warned;
    // `toContain` is STRICT equality and does not apply asymmetric matchers — `not.toContain(
    // stringContaining(...))` would pass vacuously even with the warning present, since the array
    // never literally contains an `expect.stringContaining` object. `toContainEqual` is the one
    // that actually applies it.
    expect(r.warnings ?? []).not.toContainEqual(expect.stringContaining('world/bounds'));
  });

  it('layout-bounds carries a staleness warning', async () => {
    tw = createTestWorld({});
    const r = await runAgentOp('layout-bounds', {}) as Warned;
    expect(r.warnings?.some((w) => w.includes('layout bounds'))).toBe(true);
  });

  it('hit-regions (read) carries a staleness warning', async () => {
    tw = createTestWorld({});
    const r = await runAgentOp('hit-regions', {}) as Warned;
    expect(r.warnings?.some((w) => w.includes('hit regions'))).toBe(true);
  });

  it('hit-regions show/hide (a CONTROL action, not a read) carries no staleness note', async () => {
    tw = createTestWorld({});
    const r = await runAgentOp('hit-regions', { action: 'show' }) as Warned;
    expect(r.warnings).toBeUndefined();
  });

  it('profiler read carries a staleness warning', async () => {
    tw = createTestWorld({});
    const r = await runAgentOp('profiler', { action: 'read' }) as Warned;
    expect(r.warnings?.some((w) => w.includes('profiler'))).toBe(true);
  });

  it('profiler capture-read carries a staleness warning WHILE still capturing', async () => {
    tw = createTestWorld({});
    await runAgentOp('profiler', { action: 'capture-start' });
    const r = await runAgentOp('profiler', { action: 'capture-read' }) as Warned & { capturing: boolean };
    expect(r.capturing).toBe(true);
    expect(r.warnings?.some((w) => w.includes('profiler capture'))).toBe(true);
    await runAgentOp('profiler', { action: 'capture-stop' });
  });

  it('profiler capture-read carries NO staleness note once the capture has been STOPPED — frozen is expected, not stale', async () => {
    tw = createTestWorld({});
    await runAgentOp('profiler', { action: 'capture-start' });
    await runAgentOp('profiler', { action: 'capture-stop' });
    const r = await runAgentOp('profiler', { action: 'capture-read' }) as Warned & { capturing: boolean };
    expect(r.capturing).toBe(false);
    expect(r.warnings).toBeUndefined();
  });

  it('watch-read carries a staleness warning', async () => {
    tw = createTestWorld({});
    tw.spawn(Transform({}), EntityAttributes({ name: 'Thing' }));
    const started = await runAgentOp('watch-start', { component: 'Transform' }) as { ok: boolean; id: string };
    expect(started.ok).toBe(true);
    const r = await runAgentOp('watch-read', { id: started.id }) as Warned;
    expect(r.warnings?.some((w) => w.includes('watch'))).toBe(true);
    await runAgentOp('watch-clear', { id: started.id });
  });
});

describe('scene-query warns too — a physics query reads the CURRENT Rapier world (#682)', () => {
  beforeAll(async () => { await initRapier3D(); });

  it('a successful raycast still carries a staleness warning in the default idle state', async () => {
    tw = createTestWorld({ systems: [{ name: 'phys3', priority: SYSTEM_PRIORITY.PHYSICS, fn: physics3DSystem }] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0 }));
    tw.spawn(
      EntityAttributes({ name: 'Floor', guid: 'floor-guid-0001' }),
      Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 100, halfH: 1, halfD: 100 }),
    );
    tw.step(1);

    const r = await runAgentOp('scene-query', {
      kind: 'raycast', dim: '3d', origin: [0, 10, 0], direction: [0, -1, 0],
    }) as Warned & { ok?: boolean; hit?: unknown };
    expect(r.ok).toBe(true);
    expect(r.hit).not.toBeNull();
    expect(r.warnings?.some((w) => w.includes('scene query'))).toBe(true);
  });
});

describe('scene-state stays silent while the loop is healthy — the accept side (#682)', () => {
  function mockRaf(deliver: ((cb: (t: number) => void) => void) | null) {
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as unknown as typeof requestAnimationFrame;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      if (deliver) deliver(cb as unknown as (t: number) => void);
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  }

  it('world enricher carries NO warnings once the loop is actively running', async () => {
    tw = createTestWorld({});
    tw.spawn(Transform({}), EntityAttributes({ name: 'Thing' }));

    let pending: ((t: number) => void) | null = null;
    mockRaf((cb) => { pending = cb; });
    startFrameDriver();
    pending!(16); // one real frame -> status 'running'

    const r = await runAgentOp('scene-state', { world: true }) as Warned;
    expect(r.warnings).toBeUndefined();

    stopFrameDriver();
    vi.restoreAllMocks();
  });
});
