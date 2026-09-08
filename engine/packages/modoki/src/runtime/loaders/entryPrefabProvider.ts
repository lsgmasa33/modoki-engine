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

/** The unit a prefab root's `UIElement` length ACTUALLY has, narrowed to the two units
 *  `resolveEntrySize` understands (matching `en.entryWidthUnit`/`entryHeightUnit`, which are
 *  themselves typed `'px' | '%'` at the `entriesSystem.ts` call site).
 *
 *  ⚠️ **An absent unit means `'%'`, not `'px'`.** Every `UIElement` length unit defaults to `'%'`
 *  (`runtime/traits/UIElement.ts`) and a scene/prefab save strips a field equal to its default, so
 *  a bare number with no unit key is the common on-disk shape for a percentage — mirrors
 *  `unitOrDefault` in `sceneValidation.ts`. Only an explicit `'px'` reads as px. */
function rootUnit(unit: unknown): 'px' | '%' {
  return unit === 'px' ? 'px' : '%';
}

export const entryPrefabProvider: EntryPrefabProvider = {
  rootSize(prefabGuid) {
    const prefab = cached(prefabGuid);
    // No cached prefab yet: 0 in either unit is the same 0, but `'px'` is the honest label —
    // there is no authored unit to report.
    if (!prefab?.entities?.length) return { width: 0, widthUnit: 'px', height: 0, heightUnit: 'px' };
    const rootLocal = prefab.rootLocalId ?? prefab.entities[0].localId;
    const root = prefab.entities.find(e => e.localId === rootLocal) ?? prefab.entities[0];
    const ui = root.traits?.['UIElement'] as
      { width?: number; height?: number; widthUnit?: string; heightUnit?: string } | undefined;
    return {
      width: ui?.width ?? 0,
      widthUnit: rootUnit(ui?.widthUnit),
      height: ui?.height ?? 0,
      heightUnit: rootUnit(ui?.heightUnit),
    };
  },
  // ⚠️ "Cached" means SPAWNABLE, which is a hair stricter than `spawnInstance`'s own guard and
  // deliberately so. That guard is `!prefab?.entities`, and `[]` is truthy — so a prefab file
  // with an empty `entities` passes it, reaches `spawnPrefabInstance`, gets `0` back from
  // `instantiatePrefabIntoWorld` (no root to return), and lands in the silent-retry-forever hole
  // this whole diagnostic exists to light up. Reporting it "cached" would suppress the warning
  // for precisely that case. Agreement with the spawn path is the invariant here, and it is
  // agreement about the OUTCOME — can this produce an instance — not about the expression.
  isCached(prefabGuid) { return (cached(prefabGuid)?.entities?.length ?? 0) > 0; },
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
