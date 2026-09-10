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

/** The prefab ROOT's trait bag, or `null` when the prefab is not cached (⚠️ which is a different
 *  answer from "cached with no traits" — `rootSize`'s two branches below depend on telling those
 *  apart, so this must keep returning `null` only for the uncached case).
 *
 *  Extracted in #1026 because `rootAuthoredUI` needs the same root resolution `rootSize` does, and
 *  a second copy of "`rootLocalId`, falling back to `entities[0]`" is exactly the drift
 *  `sceneValidation.ts`'s own root resolution already has to keep in step with by hand.
 *
 *  ⚠️ **BLIND TO A NESTED-INSTANCE ROOT, and both callers inherit that.** This reads the prefab
 *  FILE row's own `traits`. If `rootLocalId` names a nested-instance row (one carrying
 *  `entry.prefab` — see `loadSceneFile`'s prefab instantiation), the effective root's `UIElement`
 *  lives in the CHILD prefab plus that row's `entry.overrides`, and the row itself carries little
 *  more than `EntityAttributes`. Such a prefab therefore reports no authored size (`rootSize`
 *  answers 0 — a pre-existing blindness) and no authored record at all (`rootAuthoredUI` answers
 *  `undefined`), which collapses every pooled-row authoring warning to the trait defaults and
 *  silences them permanently — including the real `width: 200px` trap the warnings exist for.
 *
 *  **Latent, not live**: all six entry prefabs referenced by a `UIEntries` in `games/` are
 *  `rootLocalId: 1` on a plain row. Filed rather than fixed here because resolving a nested root
 *  means composing the child prefab with the row's overrides, which is `rootSize`'s bug too and is
 *  a change to both answers, not a guard on one. **#1031.** ⚠️ Do NOT "fix" it by falling back to
 *  the pooled entity's live `UIElement` — that is the #1026 defect this file exists to remove. */
function rootTraits(prefabGuid: string): Record<string, unknown> | null {
  const prefab = cached(prefabGuid);
  if (!prefab?.entities?.length) return null;
  const rootLocal = prefab.rootLocalId ?? prefab.entities[0].localId;
  const root = prefab.entities.find(e => e.localId === rootLocal) ?? prefab.entities[0];
  return (root.traits ?? {}) as Record<string, unknown>;
}

export const entryPrefabProvider: EntryPrefabProvider = {
  rootSize(prefabGuid) {
    const traits = rootTraits(prefabGuid);
    // No cached prefab yet: 0 in either unit is the same 0, but `'px'` is the honest label —
    // there is no authored unit to report.
    if (!traits) return { width: 0, widthUnit: 'px', height: 0, heightUnit: 'px' };
    const ui = traits['UIElement'] as
      { width?: number; height?: number; widthUnit?: string; heightUnit?: string } | undefined;
    return {
      width: ui?.width ?? 0,
      widthUnit: rootUnit(ui?.widthUnit),
      height: ui?.height ?? 0,
      heightUnit: rootUnit(ui?.heightUnit),
    };
  },
  rootAuthoredUI(prefabGuid) {
    return rootTraits(prefabGuid)?.['UIElement'] as Record<string, unknown> | undefined;
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
