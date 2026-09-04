/** Provider slot for start/stop of the GPU-memory sampler (Phase 3 of #590,
 *  docs/plans/ios-rendering-update-wedge.md). Installed by `loaders/gpuMemoryReport.ts`.
 *  Consumed by `rendering/useGameLoop.ts`, which cannot import `loaders/` directly (L2 may not
 *  import L3 — see `docs/architecture-layers.md`'s registration-inversion pattern; this is the
 *  same shape as `rendering/materialProvider.ts`). */

import { createProviderSlot } from './providerSlot';

export interface GpuMemorySampler {
  start(): void;
  stop(): void;
}

export const gpuMemorySamplerProvider = createProviderSlot<GpuMemorySampler>('gpuMemorySampler');
