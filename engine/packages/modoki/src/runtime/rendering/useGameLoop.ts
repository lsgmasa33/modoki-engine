/** Game loop hook — registers an ECS pipeline with the shared frame driver.
 *  @param pipeline - Function that runs all ECS systems for one frame.
 *                    Called with getCurrentWorld() each frame. */

import { useEffect } from 'react';
import { getCurrentWorld } from '../core/ecs/world';
import { registerFrameCallback, unregisterFrameCallback, startFrameDriver, stopFrameDriver, PRIORITY_ECS } from './frameDriver';
import { gpuMemorySamplerProvider } from '../core/gpuMemorySamplerProvider';
import type { World } from 'koota';

export function useGameLoop(pipeline?: (world: World) => void) {
  useEffect(() => {
    if (pipeline) {
      registerFrameCallback('ecs', () => pipeline(getCurrentWorld()), PRIORITY_ECS);
    }
    startFrameDriver();
    // Phase 3 of #590 (docs/plans/ios-rendering-update-wedge.md): the GPU-memory sampler's
    // lifetime matches the game's, same as the frame driver — it runs on its own `setInterval`
    // (not a frame callback), specifically so it keeps sampling if the frame loop itself dies.
    // Reached through a provider slot, not a direct import: the sampler lives in `loaders/`
    // (L3), and this file is `rendering/` (L2) — see `docs/architecture-layers.md`'s
    // registration-inversion pattern.
    gpuMemorySamplerProvider.get()?.start();

    return () => {
      if (pipeline) {
        unregisterFrameCallback('ecs');
      }
      stopFrameDriver();
      gpuMemorySamplerProvider.get()?.stop();
    };
  }, [pipeline]);
}
