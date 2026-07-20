/** gpuDetect unit tests — getWebGPUSupported, getWebGPUSupportedSync.
 *  gpuDetect probes `navigator.gpu` natively (requestAdapter + requestDevice), so
 *  these tests stub navigator.gpu rather than mocking pixi.js. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalGpu = (navigator as { gpu?: unknown }).gpu;
function setGpu(value: unknown) {
  Object.defineProperty(navigator, 'gpu', { value, configurable: true, writable: true });
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  setGpu(originalGpu);
});

async function getModule() {
  return import('../../src/runtime/rendering/gpuDetect');
}

/** A navigator.gpu stub whose adapter/device availability is configurable. */
function gpu(opts: { adapter: boolean; device?: boolean; onAdapter?: () => void }) {
  return {
    requestAdapter: () => {
      opts.onAdapter?.();
      if (!opts.adapter) return Promise.resolve(null);
      return Promise.resolve({
        requestDevice: () =>
          opts.device === false ? Promise.reject(new Error('no device')) : Promise.resolve({}),
      });
    },
  };
}

describe('gpuDetect', () => {
  describe('getWebGPUSupported', () => {
    it('returns false when navigator.gpu is absent', async () => {
      setGpu(undefined);
      const { getWebGPUSupported } = await getModule();
      expect(await getWebGPUSupported()).toBe(false);
    });

    it('returns false when no adapter is available', async () => {
      setGpu(gpu({ adapter: false }));
      const { getWebGPUSupported } = await getModule();
      expect(await getWebGPUSupported()).toBe(false);
    });

    it('returns false when an adapter exists but device creation fails', async () => {
      setGpu(gpu({ adapter: true, device: false }));
      const { getWebGPUSupported } = await getModule();
      expect(await getWebGPUSupported()).toBe(false);
    });

    it('returns true when an adapter + device are available', async () => {
      setGpu(gpu({ adapter: true, device: true }));
      const { getWebGPUSupported } = await getModule();
      expect(await getWebGPUSupported()).toBe(true);
    });

    it('caches the result on subsequent calls (probes once)', async () => {
      const onAdapter = vi.fn();
      setGpu(gpu({ adapter: true, device: true, onAdapter }));
      const { getWebGPUSupported } = await getModule();

      const r1 = await getWebGPUSupported();
      const r2 = await getWebGPUSupported();
      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(onAdapter).toHaveBeenCalledTimes(1);
    });

    it('shares the same pending promise for concurrent calls', async () => {
      let resolveAdapter!: (v: null) => void;
      setGpu({ requestAdapter: () => new Promise((r) => { resolveAdapter = r; }) });
      const { getWebGPUSupported } = await getModule();

      const p1 = getWebGPUSupported();
      const p2 = getWebGPUSupported();
      expect(p1).toBe(p2); // same pending promise before resolution

      resolveAdapter(null);
      expect(await p1).toBe(false);
      expect(await p2).toBe(false);
    });
  });

  describe('getWebGPUSupportedSync', () => {
    it('returns null before probing', async () => {
      setGpu(gpu({ adapter: true, device: true }));
      const { getWebGPUSupportedSync } = await getModule();
      expect(getWebGPUSupportedSync()).toBeNull();
    });

    it('returns the cached result after probing', async () => {
      setGpu(gpu({ adapter: false }));
      const { getWebGPUSupported, getWebGPUSupportedSync } = await getModule();
      await getWebGPUSupported();
      expect(getWebGPUSupportedSync()).toBe(false);
    });
  });
});
