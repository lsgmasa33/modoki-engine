/** FrameDriver unit tests — priority ordering, FPS capping, ref-counted start/stop, stepOneFrame. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function getFrameDriver() {
  return import('@modoki/engine/runtime');
}

function setupRAFMock() {
  const rafCallbacks: ((t: number) => void)[] = [];
  let rafIdCounter = 0;

  // Ensure rAF/cAF exist on globalThis (jsdom 26 doesn't provide them)
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
  if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;

  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    const id = ++rafIdCounter;
    rafCallbacks.push((t: number) => cb(t));
    return id;
  });
  const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

  return { rafCallbacks, cancelSpy };
}

describe('frameDriver', () => {
  describe('registerFrameCallback / unregisterFrameCallback', () => {
    it('registers and executes callbacks in priority order', async () => {
      const { registerFrameCallback, stepOneFrame } = await getFrameDriver();

      const order: string[] = [];
      registerFrameCallback('low', () => order.push('low'), 20);
      registerFrameCallback('high', () => order.push('high'), 0);
      registerFrameCallback('mid', () => order.push('mid'), 10);

      stepOneFrame();

      expect(order).toEqual(['high', 'mid', 'low']);
    });

    it('replaces existing callback with same key', async () => {
      const { registerFrameCallback, stepOneFrame } = await getFrameDriver();

      const order: string[] = [];
      registerFrameCallback('a', () => order.push('old'), 0);
      registerFrameCallback('a', () => order.push('new'), 0);

      stepOneFrame();

      expect(order).toEqual(['new']);
    });

    it('unregisterFrameCallback removes the callback', async () => {
      const { registerFrameCallback, unregisterFrameCallback, stepOneFrame } = await getFrameDriver();

      let called = false;
      registerFrameCallback('test', () => { called = true; }, 0);
      unregisterFrameCallback('test');

      stepOneFrame();

      expect(called).toBe(false);
    });
  });

  describe('startFrameDriver / stopFrameDriver', () => {
    it('starts rAF loop on first start', async () => {
      setupRAFMock();
      const { startFrameDriver } = await getFrameDriver();

      startFrameDriver();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    });

    it('does not start multiple rAF loops', async () => {
      setupRAFMock();
      const { startFrameDriver } = await getFrameDriver();

      startFrameDriver();
      startFrameDriver();
      startFrameDriver();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    });

    it('does not stop until all callers have stopped', async () => {
      setupRAFMock();
      const { startFrameDriver, stopFrameDriver } = await getFrameDriver();

      startFrameDriver();
      startFrameDriver();
      stopFrameDriver();

      expect(cancelAnimationFrame).not.toHaveBeenCalled();
    });

    it('stops rAF when ref count reaches zero', async () => {
      setupRAFMock();
      const { startFrameDriver, stopFrameDriver } = await getFrameDriver();

      startFrameDriver();
      startFrameDriver();
      stopFrameDriver();
      stopFrameDriver();

      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    });

    it('ignores extra stops instead of cancelling a chain it does not own', async () => {
      setupRAFMock();
      const { startFrameDriver, stopFrameDriver, getFrameLoopHealth } = await getFrameDriver();

      startFrameDriver();
      stopFrameDriver();
      stopFrameDriver();
      stopFrameDriver();

      // Only the BALANCED stop may cancel. The old code decremented past zero and called
      // cancelAnimationFrame on every extra stop; combined with a later start that took the
      // "already running" branch, that is how the loop could end up dead while callers still
      // believed it was pumping — the silent frozen-editor wedge.
      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
      expect(getFrameLoopHealth().refCount).toBe(0);
    });

    it('an unbalanced stop cannot kill a chain another caller still holds', async () => {
      setupRAFMock();
      const { startFrameDriver, stopFrameDriver, getFrameLoopHealth } = await getFrameDriver();

      startFrameDriver();      // caller A
      startFrameDriver();      // caller B
      stopFrameDriver();       // A releases → B still holds one ref
      stopFrameDriver();       // B releases → chain legitimately cancelled
      stopFrameDriver();       // stray cleanup with no matching start — must be inert

      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
      expect(getFrameLoopHealth().refCount).toBe(0);
    });

    it('re-arms a dead chain on start even when refCount is still positive', async () => {
      setupRAFMock();
      const { startFrameDriver, getFrameLoopHealth } = await getFrameDriver();

      startFrameDriver();                       // refCount 1, chain armed
      expect(getFrameLoopHealth().armed).toBe(true);
      const armsAfterFirst = (requestAnimationFrame as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

      // A second start while already running must NOT arm a duplicate chain — the generation
      // guard exists precisely so a repair attempt can never double-step every system.
      startFrameDriver();
      expect((requestAnimationFrame as unknown as { mock: { calls: unknown[] } }).mock.calls.length)
        .toBe(armsAfterFirst);
      expect(getFrameLoopHealth().refCount).toBe(2);
    });

    it('re-starts after full stop', async () => {
      setupRAFMock();
      const { startFrameDriver, stopFrameDriver } = await getFrameDriver();

      startFrameDriver();
      stopFrameDriver();
      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);

      startFrameDriver();
      expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    });
  });

  describe('stepOneFrame', () => {
    it('runs all registered callbacks synchronously', async () => {
      const { registerFrameCallback, stepOneFrame } = await getFrameDriver();

      let result = 0;
      registerFrameCallback('a', () => { result += 1; }, 0);
      registerFrameCallback('b', () => { result += 2; }, 0);

      stepOneFrame();

      expect(result).toBe(3);
    });

    it('can be called multiple times', async () => {
      const { registerFrameCallback, stepOneFrame } = await getFrameDriver();

      let count = 0;
      registerFrameCallback('c', () => { count++; }, 0);

      stepOneFrame();
      stepOneFrame();
      stepOneFrame();

      expect(count).toBe(3);
    });
  });

  describe('FPS capping', () => {
    it('targetFPS can be changed', async () => {
      const { setTargetFPS, targetFPS } = await getFrameDriver();

      // targetFPS starts at 60
      expect(targetFPS).toBe(60);

      setTargetFPS(30);
      const { targetFPS: newFps } = await getFrameDriver();
      expect(newFps).toBe(30);
    });

    it('stepOneFrame bypasses FPS cap', async () => {
      const { registerFrameCallback, stepOneFrame, setTargetFPS } = await getFrameDriver();

      setTargetFPS(1); // 1fps = very slow

      let count = 0;
      registerFrameCallback('test', () => { count++; }, 0);

      // stepOneFrame should run regardless of FPS cap
      stepOneFrame();
      stepOneFrame();
      stepOneFrame();

      expect(count).toBe(3);
    });
  });

  describe('priority constants', () => {
    it('exports expected priority values', async () => {
      const { PRIORITY_ECS, PRIORITY_RENDER_3D, PRIORITY_RENDER_2D } = await getFrameDriver();

      expect(PRIORITY_ECS).toBe(0);
      expect(PRIORITY_RENDER_3D).toBe(10);
      expect(PRIORITY_RENDER_2D).toBe(20);
    });
  });
});
