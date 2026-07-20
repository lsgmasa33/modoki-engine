/** gpuDetect unit tests — WebGPU detection, caching. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function getGpuDetect() {
  return import('../../packages/modoki/src/runtime/rendering/gpuDetect');
}

describe('gpuDetect', () => {
  describe('getWebGPUSupported', () => {
    it('returns a boolean result', async () => {
      const { getWebGPUSupported } = await getGpuDetect();

      const result = await getWebGPUSupported();

      expect(typeof result).toBe('boolean');
    });

    it('caches the result', async () => {
      const { getWebGPUSupported } = await getGpuDetect();

      const r1 = await getWebGPUSupported();
      const r2 = await getWebGPUSupported();

      // Both should be the same cached value
      expect(r1).toBe(r2);
    });

    it('returns a resolved promise on second call', async () => {
      const { getWebGPUSupported } = await getGpuDetect();

      await getWebGPUSupported();

      // Second call should be immediately resolved (same promise)
      const p2 = getWebGPUSupported();
      expect(p2).toBeInstanceOf(Promise);
    });
  });

  describe('getWebGPUSupportedSync', () => {
    it('returns null before probe', async () => {
      // Fresh module = not probed yet
      vi.resetModules();
      const { getWebGPUSupportedSync } = await getGpuDetect();

      expect(getWebGPUSupportedSync()).toBeNull();
    });

    it('returns the cached result after probe', async () => {
      const { getWebGPUSupported, getWebGPUSupportedSync } = await getGpuDetect();

      const asyncResult = await getWebGPUSupported();
      const syncResult = getWebGPUSupportedSync();

      expect(syncResult).toBe(asyncResult);
    });
  });
});
