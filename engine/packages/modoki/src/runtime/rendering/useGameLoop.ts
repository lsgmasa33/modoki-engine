/** Game loop hook — registers an ECS pipeline with the shared frame driver.
 *  @param pipeline - Function that runs all ECS systems for one frame.
 *                    Called with getCurrentWorld() each frame. */

import { useEffect } from 'react';
import { getCurrentWorld } from '../ecs/world';
import { registerFrameCallback, unregisterFrameCallback, startFrameDriver, stopFrameDriver, PRIORITY_ECS } from './frameDriver';
import type { World } from 'koota';

export function useGameLoop(pipeline?: (world: World) => void) {
  useEffect(() => {
    if (pipeline) {
      registerFrameCallback('ecs', () => pipeline(getCurrentWorld()), PRIORITY_ECS);
    }
    startFrameDriver();

    return () => {
      if (pipeline) {
        unregisterFrameCallback('ecs');
      }
      stopFrameDriver();
    };
  }, [pipeline]);
}
