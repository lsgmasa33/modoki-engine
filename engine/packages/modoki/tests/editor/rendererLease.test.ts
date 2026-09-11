/** The renderer lease exists to stop React StrictMode's dev double-invoke (mount → unmount →
 *  remount) from creating, destroying, and immediately re-requesting a GPU device — a race
 *  against the browser's asynchronous device teardown, and the likeliest source of the
 *  intermittent `makeWebGPURenderer` failures SceneView's retry was added to absorb.
 *
 *  These assert the property that matters: a remount reuses the SAME renderer, and the device
 *  is torn down exactly once, only when nothing has re-claimed it. */

import { describe, expect, it, vi } from 'vitest';
import { acquireRenderer, releaseRenderer, discardRenderer, __hasLease } from '../../src/editor/panels/rendererLease';

function fakeRenderer() {
  return { dispose: vi.fn(), domElement: { remove: vi.fn() } };
}
/** Let the deferred-release macrotask (setTimeout 0) fire. */
const flushRelease = () => new Promise((r) => setTimeout(r, 1));

describe('rendererLease', () => {
  it('creates once and reuses it for a StrictMode remount on the same container', async () => {
    const container = {};
    const renderer = fakeRenderer();
    const create = vi.fn(async () => renderer);

    // Mount 1.
    const first = await acquireRenderer(container, create);
    // StrictMode unmount → remount, synchronously, before any macrotask runs.
    releaseRenderer(container);
    const second = await acquireRenderer(container, create);

    expect(create).toHaveBeenCalledTimes(1);   // the whole point: ONE GPU device
    expect(second).toBe(first);
    expect(renderer.dispose).not.toHaveBeenCalled();

    // And the cancelled teardown must not fire late and kill the live renderer.
    await flushRelease();
    expect(renderer.dispose).not.toHaveBeenCalled();
    expect(__hasLease(container)).toBe(true);
  });

  it('disposes exactly once when the last holder releases and nothing re-acquires', async () => {
    const container = {};
    const renderer = fakeRenderer();
    await acquireRenderer(container, async () => renderer);

    releaseRenderer(container);
    expect(renderer.dispose).not.toHaveBeenCalled(); // deferred, not immediate

    await flushRelease();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.domElement.remove).toHaveBeenCalledTimes(1);
    expect(__hasLease(container)).toBe(false);
  });

  it('does not cache a failed create — the next mount gets a clean attempt', async () => {
    const container = {};
    const renderer = fakeRenderer();
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('device teardown race'))
      .mockResolvedValueOnce(renderer);

    await expect(acquireRenderer(container, create as never)).rejects.toThrow('device teardown race');
    expect(__hasLease(container)).toBe(false);

    // A rejected promise must not be handed to the next mount forever.
    await expect(acquireRenderer(container, create as never)).resolves.toBe(renderer);
    expect(create).toHaveBeenCalledTimes(2);
  });

  // #1052 close-out review, finding 1. A context-loss rebuild discards a still-PENDING lease and
  // leases a fresh one for the same container, and the abandoned create can reject afterwards. Its
  // failure handler used to delete whatever lease the container held BY THEN — the successor's.
  it("a discarded lease's LATE rejection does not delete the successor's lease", async () => {
    const container = {};
    let rejectFirst!: (e: unknown) => void;
    const first = acquireRenderer(container, () => new Promise<ReturnType<typeof fakeRenderer>>((_resolve, reject) => { rejectFirst = reject; }));
    discardRenderer(container);                                  // the rebuild drops the pending lease…
    const successor = fakeRenderer();
    await acquireRenderer(container, async () => successor);     // …and leases a fresh one

    rejectFirst(new Error('the abandoned create fails late'));
    await expect(first).rejects.toThrow('the abandoned create fails late');

    expect(__hasLease(container), "the stale rejection must leave the successor's lease in place").toBe(true);
    discardRenderer(container);
    expect(successor.dispose, 'so the next rebuild can still dispose it').toHaveBeenCalledTimes(1);
  });

  // The same mechanism in the RELEASE path (#1052 close-out §2d review; latent — SceneView only releases
  // a lease whose create has resolved). A release arms the deferred teardown while the create is still
  // pending, the create then rejects, a fresh lease is acquired for the container, and the stale timer
  // used to delete whatever lease the container held when it fired.
  it("a released lease's deferred teardown does not delete a lease acquired after its create rejected", async () => {
    const container = {};
    let rejectFirst!: (e: unknown) => void;
    const first = acquireRenderer(container, () => new Promise<ReturnType<typeof fakeRenderer>>((_resolve, reject) => { rejectFirst = reject; }));
    releaseRenderer(container);                                  // refs 0: the deferred teardown is armed
    rejectFirst(new Error('the create fails'));
    await expect(first).rejects.toThrow('the create fails');
    const successor = fakeRenderer();
    await acquireRenderer(container, async () => successor);     // a fresh lease on the same container

    await flushRelease();                                        // the stale teardown fires

    expect(__hasLease(container), "the stale teardown must not delete the successor's lease").toBe(true);
    expect(successor.dispose).not.toHaveBeenCalled();
  });

  it('keeps separate containers on separate renderers', async () => {
    const a = {}, b = {};
    const ra = fakeRenderer(), rb = fakeRenderer();
    expect(await acquireRenderer(a, async () => ra)).toBe(ra);
    expect(await acquireRenderer(b, async () => rb)).toBe(rb);

    releaseRenderer(a);
    await flushRelease();
    expect(ra.dispose).toHaveBeenCalledTimes(1);
    expect(rb.dispose).not.toHaveBeenCalled(); // b is untouched
  });

  it('survives two holders releasing out of order without an early teardown', async () => {
    const container = {};
    const renderer = fakeRenderer();
    await acquireRenderer(container, async () => renderer);
    await acquireRenderer(container, async () => renderer); // refs = 2

    releaseRenderer(container);
    await flushRelease();
    expect(renderer.dispose).not.toHaveBeenCalled(); // one holder remains

    releaseRenderer(container);
    await flushRelease();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  // ── discardRenderer (#121 P1) ───────────────────────────────────────────────────────────
  // The reuse property asserted above is what makes the lease correct for StrictMode and FATAL
  // for context-loss recovery: a rebuild is `cleanup(); setup();` in ONE task, so its
  // re-acquire lands before the deferred teardown fires and would be handed the dead renderer
  // back — recovery silently doing nothing, with no error anywhere. These pin the escape hatch.

  it('discard makes the renderer unreusable by a same-task re-acquire — the recovery case', async () => {
    const container = {};
    const dead = fakeRenderer();
    await acquireRenderer(container, async () => dead);

    // Exactly what recovery does: drop the dead renderer, then immediately bring one up.
    discardRenderer(container);
    const fresh = fakeRenderer();
    const create = vi.fn(async () => fresh);
    const got = await acquireRenderer(container, create);

    expect(create).toHaveBeenCalledTimes(1); // a NEW device, not the corpse
    expect(got).toBe(fresh);
    expect(got).not.toBe(dead);
    expect(dead.dispose).toHaveBeenCalledTimes(1);
    expect(dead.domElement.remove).toHaveBeenCalledTimes(1);
  });

  it('discard cancels a pending deferred release so it cannot fire onto the new lease', async () => {
    const container = {};
    const dead = fakeRenderer();
    await acquireRenderer(container, async () => dead);

    releaseRenderer(container);  // schedules teardown on a macrotask
    discardRenderer(container);  // ...and recovery discards before it fires
    const fresh = fakeRenderer();
    await acquireRenderer(container, async () => fresh);

    await flushRelease();
    expect(dead.dispose).toHaveBeenCalledTimes(1); // discarded once, not again by the timer
    expect(fresh.dispose).not.toHaveBeenCalled();  // and the live one is untouched
    expect(__hasLease(container)).toBe(true);
  });

  it('discard ignores a throwing dispose — a dead renderer must not abort the rebuild', async () => {
    const container = {};
    const dead = {
      dispose: vi.fn(() => { throw new Error('context already lost'); }),
      domElement: { remove: vi.fn() },
    };
    await acquireRenderer(container, async () => dead);

    expect(() => discardRenderer(container)).not.toThrow();
    expect(__hasLease(container)).toBe(false);
    expect(dead.domElement.remove).toHaveBeenCalledTimes(1); // still detached despite the throw
  });

  it('discard on a container with no lease is a no-op', () => {
    expect(() => discardRenderer({})).not.toThrow();
  });
});
