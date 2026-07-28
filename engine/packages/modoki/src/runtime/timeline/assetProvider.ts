/** Provider slot for the timeline-asset lookup + prefab-spawn seam (P7 C14): `loaders/
 *  {timelineCache,meshTemplateCache,loadSceneFile}.ts`. Consumed by
 *  `timeline/timelineSystem.ts`. A control track instantiating a prefab is a genuine
 *  composition capability (`spawnPrefabInstance`), not a layering violation to route
 *  around — it's injected here rather than left as a direct `loaders/` import. */

import type { World } from 'koota';
import { createProviderSlot } from '../core/providerSlot';
import type { TimelineDef } from './types';

export interface TimelineAssetProvider {
  getTimeline(ref: string): TimelineDef | null;
  getCachedPrefab(prefabRef: string): unknown | undefined;
  spawnPrefabInstance(
    world: World,
    prefab: { entities: unknown[]; rootLocalId?: number; id?: string },
    opts?: { parentId?: number; rootTransform?: Record<string, unknown>; source?: string; guidSeed?: string; forceTransient?: boolean },
  ): number;
}

export const timelineAssetProvider = createProviderSlot<TimelineAssetProvider>('timelineAssetProvider');
