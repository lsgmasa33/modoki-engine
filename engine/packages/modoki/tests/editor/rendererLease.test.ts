/** The renderer lease exists to stop React StrictMode's dev double-invoke (mount → unmount →
 *  remount) from creating, destroying, and immediately re-requesting a GPU device — a race
 *  against the browser's asynchronous device teardown, and the likeliest source of the
 *  intermittent `makeWebGPURenderer` failures SceneView's retry was added to absorb.
 *
 *  These assert the property that matters: a remount reuses the SAME renderer, and the device
 *  is torn down exactly once, only when nothing has re-claimed it. */

import { describe, expect, it, vi } from 'vitest';
import { acquireRenderer, releaseRenderer, __hasLease } from '../../src/editor/panels/rendererLease';

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
});
