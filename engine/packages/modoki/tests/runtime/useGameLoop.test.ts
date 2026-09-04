// @vitest-environment jsdom
/** useGameLoop — Phase 3 of #590 (docs/plans/ios-rendering-update-wedge.md) added the GPU-memory
 *  sampler's start/stop alongside the frame driver's. This drives the REAL hook through
 *  `renderHook`, mocking `frameDriver` (a heavy module) and reading the sampler through the SAME
 *  provider slot the hook itself goes through — `rendering/useGameLoop.ts` is L2 and cannot import
 *  `loaders/gpuMemoryReport.ts` (L3) directly.
 *  ⚠️ The lifecycle tests below each hand-provide their OWN `vi.fn()` sampler — that proves the
 *  HOOK reads the slot correctly, but nothing here (until the "PRODUCTION wiring" describe block
 *  further down) touches whether `loaders/gpuMemoryReport.ts` actually REGISTERS a real sampler
 *  into the slot in production. Commenting out that file's `gpuMemorySamplerProvider.provide(...)`
 *  call leaves every test above green — see the wiring test below for the one that catches it. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('../../src/runtime/rendering/frameDriver', () => ({
  registerFrameCallback: vi.fn(),
  unregisterFrameCallback: vi.fn(),
  startFrameDriver: vi.fn(),
  stopFrameDriver: vi.fn(),
  PRIORITY_ECS: 0,
}));

const { useGameLoop } = await import('../../src/runtime/rendering/useGameLoop');
const frameDriver = await import('../../src/runtime/rendering/frameDriver');
const { gpuMemorySamplerProvider } = await import('../../src/runtime/core/gpuMemorySamplerProvider');

beforeEach(() => {
  vi.clearAllMocks();
  gpuMemorySamplerProvider.reset();
});

afterEach(() => {
  gpuMemorySamplerProvider.reset();
});

describe('useGameLoop — GPU-memory sampler lifecycle (Phase 3 of #590)', () => {
  it('starts the sampler (through the provider slot) alongside the frame driver, on mount', () => {
    const sampler = { start: vi.fn(), stop: vi.fn() };
    gpuMemorySamplerProvider.provide(sampler);

    renderHook(() => useGameLoop());

    expect(frameDriver.startFrameDriver).toHaveBeenCalledTimes(1);
    expect(sampler.start).toHaveBeenCalledTimes(1);
    expect(sampler.stop).not.toHaveBeenCalled();
  });

  it('stops the sampler alongside the frame driver, on unmount', () => {
    const sampler = { start: vi.fn(), stop: vi.fn() };
    gpuMemorySamplerProvider.provide(sampler);

    const { unmount } = renderHook(() => useGameLoop());
    unmount();

    expect(frameDriver.stopFrameDriver).toHaveBeenCalledTimes(1);
    expect(sampler.stop).toHaveBeenCalledTimes(1);
  });

  it('does not throw when nothing has provided the sampler yet (D5: get() returns null, warns once)', () => {
    // No `gpuMemorySamplerProvider.provide(...)` call — mirrors a headless test that deep-imports
    // useGameLoop without going through runtime/index.ts (so loaders/gpuMemoryReport.ts, which
    // self-registers, was never imported).
    expect(() => {
      const { unmount } = renderHook(() => useGameLoop());
      unmount();
    }).not.toThrow();
    expect(frameDriver.startFrameDriver).toHaveBeenCalledTimes(1);
    expect(frameDriver.stopFrameDriver).toHaveBeenCalledTimes(1);
  });
});

describe('useGameLoop — GPU-memory sampler PRODUCTION wiring (Fix 2, BLOCKER close-out for #590)', () => {
  it('the REAL registration path (`loaders/registerProviders.ts`, exactly what `runtime/index.ts` ' +
     'imports for this side effect) installs a sampler that actually starts sampling — nothing ' +
     'test-provided', async () => {
    // Unlike every test above, this does NOT call `gpuMemorySamplerProvider.provide(...)` itself.
    // `beforeEach` already reset the slot; importing the production loader here is what must
    // (re)provide it. This file has not imported `loaders/gpuMemoryReport.ts` (directly or via
    // `registerProviders.ts`) anywhere above, so this is the module's first evaluation in this
    // suite and its self-registering `gpuMemorySamplerProvider.provide(...)` call (bottom of that
    // file) genuinely runs here.
    await import('../../src/runtime/loaders/registerProviders');

    const sampler = gpuMemorySamplerProvider.get();
    expect(sampler).not.toBeNull();

    const { getGpuMemoryReport, __resetGpuMemoryReportForTest } = await import('../../src/runtime/loaders/gpuMemoryReport');
    __resetGpuMemoryReportForTest();
    expect(getGpuMemoryReport()).toBeNull(); // sanity: nothing sampled yet

    sampler!.start(); // the exact call `useGameLoop.ts` makes on mount
    // `startGpuMemorySampling()` seeds an immediate sample before the first `setInterval` tick —
    // so a report appearing HERE, synchronously, proves the sampler actually ran, not merely that
    // `start` is a callable no-op (a mock would pass the `sampler).not.toBeNull()` check above
    // too — this is the assertion a mock cannot fake).
    expect(getGpuMemoryReport()).not.toBeNull();

    sampler!.stop();
    __resetGpuMemoryReportForTest();
  });
});
