/** The post-swap live-compile hold (#238) — four ways it can go wrong, all of them silent.
 *
 *  A gate that holds too long is a viewport that never draws; a gate that releases too early puts
 *  the stall back; a gate that trusts a stale promise draws the NEW scene when the OLD scene's
 *  compile lands. None of those show up in a screenshot, which is why they are pinned here. */

import { describe, it, expect, vi } from 'vitest';
import { createLiveCompileGate } from '../../src/runtime/rendering/liveCompileGate';

/** A hand-driven clock — the gate takes `now` injected precisely so a deadline test does not
 *  have to sleep, and so the determinism guard stays satisfied in production. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** A promise whose settlement the test controls. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('liveCompileGate', () => {
  it('does not hold until a swap arms it', () => {
    const c = clock();
    const gate = createLiveCompileGate({ maxHoldMs: 5000, now: c.now });
    const kick = vi.fn(async () => {});

    expect(gate.tick(kick)).toBe(false);
    expect(kick).not.toHaveBeenCalled();
  });

  it('kicks ONCE on the first tick after a swap and holds until it settles', async () => {
    const c = clock();
    const gate = createLiveCompileGate({ maxHoldMs: 5000, now: c.now });
    const d = deferred();
    const kick = vi.fn(() => d.promise);

    gate.arm();
    expect(gate.tick(kick)).toBe(true);
    expect(gate.tick(kick)).toBe(true);   // still holding
    expect(kick).toHaveBeenCalledTimes(1); // and NOT re-kicked every frame

    d.resolve();
    await d.promise;
    expect(gate.tick(kick)).toBe(false);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it('wakes an idle surface when its own compile settles', async () => {
    const c = clock();
    const onSettled = vi.fn();
    const gate = createLiveCompileGate({ maxHoldMs: 5000, now: c.now, onSettled });
    const d = deferred();

    gate.arm();
    gate.tick(() => d.promise);
    expect(onSettled).not.toHaveBeenCalled();

    d.resolve();
    await d.promise;
    // Releasing the hold is not enough on its own: a Stopped surface with nothing dirty would
    // never draw the scene the compile was for.
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('releases the frame when the compile REJECTS, and reports it', async () => {
    const c = clock();
    const onError = vi.fn();
    const gate = createLiveCompileGate({ maxHoldMs: 5000, now: c.now, onError });
    const d = deferred();

    gate.arm();
    expect(gate.tick(() => d.promise)).toBe(true);

    d.reject(new Error('device lost'));
    await d.promise.catch(() => {});
    await Promise.resolve();

    // A shader that fails to build must degrade to the OLD behaviour (a stalling first frame),
    // never to a viewport that stops drawing.
    expect(gate.tick(async () => {})).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('treats a SYNCHRONOUS throw from the kick as a rejection', async () => {
    const c = clock();
    const onError = vi.fn();
    const gate = createLiveCompileGate({ maxHoldMs: 5000, now: c.now, onError });

    gate.arm();
    // Thrown, not rejected — a missing three API or a null stack would do this. Left to propagate
    // it would escape `tick` into the frame callback with `pending` set and nothing in flight to
    // clear it, so every swap would hold for the full deadline.
    expect(() => gate.tick(() => { throw new Error('no scene pass'); })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(gate.tick(async () => {})).toBe(false);
  });

  it('releases the frame at the deadline even while the compile is still pending', () => {
    const c = clock();
    const gate = createLiveCompileGate({ maxHoldMs: 5000, now: c.now });
    const d = deferred();

    gate.arm();
    expect(gate.tick(() => d.promise)).toBe(true);
    c.advance(4999);
    expect(gate.tick(() => d.promise)).toBe(true);
    c.advance(1);
    // The deadline releases the FRAME, not the compile — the work is still in flight and still
    // useful when it lands.
    expect(gate.tick(() => d.promise)).toBe(false);
    expect(gate.isPending()).toBe(true);
  });

  it('a STALE compile settling does not release the hold a newer swap owns', async () => {
    const c = clock();
    const onSettled = vi.fn();
    const gate = createLiveCompileGate({ maxHoldMs: 5000, now: c.now, onSettled });
    const first = deferred();
    const second = deferred();

    gate.arm();
    gate.tick(() => first.promise);   // scene A compiling
    gate.arm();                        // …and a second swap lands before it finishes
    expect(gate.tick(() => second.promise)).toBe(true);

    first.resolve();                   // scene A's compile finally lands
    await first.promise;
    await Promise.resolve();

    // Its promise closure holds the OLD scene. Releasing on it would draw scene B with scene B's
    // pipelines still uncompiled — the stall this gate exists to prevent, one swap later.
    expect(gate.tick(() => second.promise)).toBe(true);
    expect(onSettled).not.toHaveBeenCalled();

    second.resolve();
    await second.promise;
    expect(gate.tick(() => second.promise)).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('re-arms cleanly for the next swap once a hold has ended', async () => {
    const c = clock();
    const gate = createLiveCompileGate({ maxHoldMs: 5000, now: c.now });
    const a = deferred();
    gate.arm();
    gate.tick(() => a.promise);
    a.resolve();
    await a.promise;
    expect(gate.tick(async () => {})).toBe(false);

    const b = deferred();
    const kick = vi.fn(() => b.promise);
    gate.arm();
    expect(gate.tick(kick)).toBe(true);
    expect(kick).toHaveBeenCalledTimes(1);
  });
});
