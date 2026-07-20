/** frameDriver unit tests (modoki package) — FPS capping via rAF simulation, uncapped mode. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  // Ensure rAF/cAF exist (jsdom may not provide them)
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
  if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function getDriver() {
  return import('../../../src/runtime/rendering/frameDriver');
}

describe('frameDriver FPS capping', () => {
  it('skips callbacks when timestamp is within the frame interval', async () => {
    // Capture the rAF callback so we can simulate it
    let frameCallback: ((t: number) => void) | null = null;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frameCallback = cb as (t: number) => void;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { registerFrameCallback, startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
    setTargetFPS(60); // ~16.67ms interval

    let callCount = 0;
    registerFrameCallback('test', () => callCount++, 0);
    startFrameDriver();

    // Simulate: first frame at t=0 — should fire (initializes lastFrameTime)
    frameCallback!(0);
    const firstCount = callCount;

    // Simulate: frame at t=5 — within interval, should skip
    frameCallback!(5);
    expect(callCount).toBe(firstCount);

    // Simulate: frame at t=20 — past interval, should fire
    frameCallback!(20);
    expect(callCount).toBe(firstCount + 1);

    stopFrameDriver();
  });

  it('runs every callback when targetFPS is 0 (uncapped)', async () => {
    let frameCallback: ((t: number) => void) | null = null;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frameCallback = cb as (t: number) => void;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { registerFrameCallback, startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
    setTargetFPS(0);

    let callCount = 0;
    registerFrameCallback('test', () => callCount++, 0);
    startFrameDriver();

    // Every frame should fire regardless of timing
    frameCallback!(0);
    frameCallback!(1);
    frameCallback!(2);
    expect(callCount).toBe(3);

    stopFrameDriver();
  });

  it('maintains priority order during rAF execution', async () => {
    let frameCallback: ((t: number) => void) | null = null;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frameCallback = cb as (t: number) => void;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { registerFrameCallback, startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
    setTargetFPS(0);

    const order: string[] = [];
    registerFrameCallback('render', () => order.push('render'), 20);
    registerFrameCallback('ecs', () => order.push('ecs'), 0);
    registerFrameCallback('3d', () => order.push('3d'), 10);

    startFrameDriver();
    frameCallback!(0);

    expect(order).toEqual(['ecs', '3d', 'render']);

    stopFrameDriver();
  });

  describe('error isolation (regression for H5)', () => {
    it('a throwing callback does not stop sibling callbacks in the same frame', async () => {
      let frameCallback: ((t: number) => void) | null = null;
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
        frameCallback = cb as (t: number) => void;
        return 1;
      });
      vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
      // silence the expected error log
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { registerFrameCallback, startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
      setTargetFPS(0);

      const order: string[] = [];
      registerFrameCallback('boom', () => { order.push('boom'); throw new Error('intentional'); }, 0);
      registerFrameCallback('after', () => order.push('after'), 10);

      startFrameDriver();
      frameCallback!(0);

      expect(order).toEqual(['boom', 'after']);
      expect(errSpy).toHaveBeenCalled();

      stopFrameDriver();
    });

    it('auto-unregisters a callback after 10 consecutive throws', async () => {
      let frameCallback: ((t: number) => void) | null = null;
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
        frameCallback = cb as (t: number) => void;
        return 1;
      });
      vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { registerFrameCallback, startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
      setTargetFPS(0);

      let invocations = 0;
      registerFrameCallback('boom', () => { invocations++; throw new Error('always fails'); }, 0);

      startFrameDriver();
      // Run 12 frames — after 10 throws the callback should be unregistered,
      // so frames 11 and 12 don't invoke it again.
      for (let i = 0; i < 12; i++) frameCallback!(i);

      expect(invocations).toBe(10);

      stopFrameDriver();
    });

    it('error count resets after a successful call', async () => {
      let frameCallback: ((t: number) => void) | null = null;
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
        frameCallback = cb as (t: number) => void;
        return 1;
      });
      vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { registerFrameCallback, startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
      setTargetFPS(0);

      let shouldThrow = true;
      let invocations = 0;
      registerFrameCallback('flaky', () => {
        invocations++;
        if (shouldThrow) throw new Error('first 9 frames fail');
      }, 0);

      startFrameDriver();
      // 9 throws — under the auto-unregister threshold
      for (let i = 0; i < 9; i++) frameCallback!(i);
      // recover for one frame — resets the error counter
      shouldThrow = false;
      frameCallback!(9);
      // throw again for 10 more frames — should NOT be unregistered yet
      shouldThrow = true;
      for (let i = 10; i < 19; i++) frameCallback!(i);

      // 9 (throws) + 1 (success) + 9 (throws) = 19 invocations, all completed
      expect(invocations).toBe(19);

      stopFrameDriver();
    });
  });

  it('frame() calls requestAnimationFrame for the next frame', async () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
    setTargetFPS(0);

    startFrameDriver();
    // First call is from startFrameDriver
    expect(rafSpy).toHaveBeenCalledTimes(1);

    // Simulate the frame callback — it should schedule the next frame
    const frameCallback = rafSpy.mock.calls[0][0] as (t: number) => void;
    frameCallback(0);
    expect(rafSpy).toHaveBeenCalledTimes(2);

    stopFrameDriver();
  });
});
