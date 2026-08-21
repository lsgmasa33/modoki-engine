/** entryPrefabProvider — the L3 half of `UIEntries` pooling.
 *
 *  `runtime/ui/entriesSystem.ts` is an L2 subsystem and may not import the prefab cache, the
 *  asset manifest or the spawner (all L3). So the capability is REGISTERED into it from here,
 *  which is the inversion `docs/architecture-layers.md` prescribes and the ESLint layer zone
 *  enforces. Call `installEntryPrefabProvider()` once during app/runtime setup.
 */
import type { World } from 'koota';
import { setEntryPrefabProvider, type EntryPrefabProvider } from '../ui/entriesSystem';
import { spawnPrefabInstance } from './loadSceneFile';
import { getCachedPrefab } from './meshTemplateCache';

interface CachedPrefab {
  entities: { localId?: number; traits?: Record<string, unknown> }[];
  rootLocalId?: number;
  id?: string;
}

/** ⚠️ `getCachedPrefab` takes the REF (a GUID) and resolves it internally — do NOT resolve to a
 *  path first and hand it that. Doing so re-enters `resolveRef` with an asset PATH, which is
 *  rejected ("path reference no longer supported — use a GUID") and returns undefined, so the
 *  prefab reads as permanently uncached and the pool silently never spawns. Found by running it
 *  in a live editor; every unit test faked this provider and so could not see it. */
function cached(prefabGuid: string): CachedPrefab | null {
  if (!prefabGuid) return null;
  return (getCachedPrefab(prefabGuid) as CachedPrefab | null) ?? null;
}

export const entryPrefabProvider: EntryPrefabProvider = {
  rootSize(prefabGuid) {
    const prefab = cached(prefabGuid);
    if (!prefab?.entities?.length) return { width: 0, height: 0 };
    const rootLocal = prefab.rootLocalId ?? prefab.entities[0].localId;
    const root = prefab.entities.find(e => e.localId === rootLocal) ?? prefab.entities[0];
    const ui = root.traits?.['UIElement'] as { width?: number; height?: number } | undefined;
    return { width: ui?.width ?? 0, height: ui?.height ?? 0 };
  },
  spawnInstance(world: World, prefabGuid, opts) {
    const prefab = cached(prefabGuid);
    // Not cached yet is NORMAL on the first frames of a scene — the caller retries rather than
    // spawning something wrong.
    if (!prefab?.entities) return 0;
    return spawnPrefabInstance(world, prefab as never, {
      parentId: opts.parentId, source: prefabGuid, guidSeed: opts.guidSeed,
    });
  },
};

export function installEntryPrefabProvider(): void { setEntryPrefabProvider(entryPrefabProvider); }
