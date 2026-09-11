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
import { effectivePrefabRootTraits } from './prefabOverrides';
import { getTraitByName } from '../core/ecs/traitRegistry';
import { isPersistentTraitField } from '../core/ecs/traitSchema';
import { readUILength } from '../traits/uiLength';

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

/** One axis of the prefab root's size, as the pool can use it.
 *
 *  The value and its unit are read TOGETHER, through the one length table (`readUILength`, #840), so
 *  an absent unit is that field's own default — `%` for `width`/`height`, the common on-disk shape
 *  once a save strips a default-valued unit key.
 *
 *  ⚠️ **Only `px` and `%` survive.** A pooled row's size resolves against the SCROLL VIEW
 *  (`resolveEntrySize`), and nothing on that path can see the device viewport — so a root authored
 *  `50vh` has no honest px answer here. Before #840 it was folded into `%` and silently read as 50% of
 *  the view. **The owner's decision was to REFUSE it, not guess:** the axis reads 0 (the row visibly
 *  has no size on it) and `refusedUnit` carries the authored unit, which `entriesSystem` names in a
 *  warning when a view actually delegates that axis to the prefab. Any other non-px/% string is
 *  refused the same way. */
function rootAxis(ui: unknown, axis: 'width' | 'height'): { value: number; unit: 'px' | '%'; refusedUnit?: string } {
  const { value, unit } = readUILength(ui as object | undefined, axis);
  if (unit === 'px' || unit === '%') return { value, unit };
  // A ZERO is no size in any unit. Refusing it would warn that the axis is 0 until the root authors
  // px/% (false advice: 0px is still 0) and disagree with the validator, which is silent on 0. A save
  // strips a zero height, so a root left at a bare viewport unit key by a dropdown pick is a real shape
  // (#840 close-out review).
  if (value === 0) return { value: 0, unit: 'px' };
  return { value: 0, unit: 'px', refusedUnit: unit };
}

/** The spawner's field filter: an override field counts when its trait PERSISTS it. */
function acceptPersistentField(traitName: string, field: string): boolean {
  const meta = getTraitByName(traitName);
  return !!meta && isPersistentTraitField(meta, field);
}

/** The spawner's trait-NAME rule: an override adds a tag as a tag and a component as a component —
 *  even one with no accepted field — and skips a name the registry does not know. */
function registryTraitKind(traitName: string): 'component' | 'tag' | undefined {
  const meta = getTraitByName(traitName);
  return meta ? (meta.category === 'tag' ? 'tag' : 'component') : undefined;
}

/** The trait bag a spawned instance's ROOT entity carries, or `null` when no root would be spawned
 *  — the prefab is not cached, or it is but its root does not resolve (a nested-instance root whose
 *  child prefab is not cached, or no row at `rootLocalId`). ⚠️ `null` is a different answer from
 *  "cached with no traits" (`{}`): `rootSize`'s two branches and `isCached` depend on telling those
 *  apart.
 *
 *  Composed by `effectivePrefabRootTraits`, the same function `sceneValidation.ts` uses, so the
 *  validator, the pool and the spawned entity all describe one root (#1031). Before that, both read
 *  the root ROW's own `traits` — blind to a nested-instance root, whose row carries little more than
 *  `EntityAttributes` while the real `UIElement` lives in the child prefab plus the row's overrides.
 *  That reported a 0 size and no authored record, silencing every pooled-row authoring warning.
 *
 *  ⚠️ Do NOT "fix" an unresolvable root by falling back to the pooled entity's live `UIElement` —
 *  that is the #1026 defect this file exists to remove. And never mutate the result: it can alias the
 *  prefab CACHE's own objects. */
function rootTraits(prefabGuid: string): Record<string, unknown> | null {
  const prefab = cached(prefabGuid);
  if (!prefab?.entities?.length) return null;
  return effectivePrefabRootTraits(prefab, (ref) => getCachedPrefab(ref), {
    acceptField: acceptPersistentField,
    traitKind: registryTraitKind,
  });
}

export const entryPrefabProvider: EntryPrefabProvider = {
  rootSize(prefabGuid) {
    const traits = rootTraits(prefabGuid);
    // No resolvable root yet: 0 in either unit is the same 0, but `'px'` is the honest label —
    // there is no authored unit to report.
    if (!traits) return { width: 0, widthUnit: 'px', height: 0, heightUnit: 'px' };
    const ui = traits['UIElement'];
    const w = rootAxis(ui, 'width');
    const h = rootAxis(ui, 'height');
    return {
      width: w.value, widthUnit: w.unit,
      height: h.value, heightUnit: h.unit,
      ...(w.refusedUnit !== undefined ? { refusedWidthUnit: w.refusedUnit } : {}),
      ...(h.refusedUnit !== undefined ? { refusedHeightUnit: h.refusedUnit } : {}),
    };
  },
  rootAuthoredUI(prefabGuid) {
    return rootTraits(prefabGuid)?.['UIElement'] as Record<string, unknown> | undefined;
  },
  // ⚠️ "Cached" means SPAWNABLE — can `spawnInstance` produce an instance — and agreement with the
  // spawn path about that OUTCOME is the invariant, not agreement about an expression. So it asks
  // whether the ROOT resolves, which is stricter than `spawnInstance`'s own `!prefab?.entities`
  // guard in two ways, both deliberate: `[]` is truthy, and a nested-instance root whose child
  // prefab is not cached yet (#1031) both pass that guard and then get `0` back from
  // `instantiatePrefabIntoWorld`. Reporting either "cached" would suppress `entriesSystem`'s
  // never-caches warning for precisely the case it exists to light up.
  isCached(prefabGuid) { return rootTraits(prefabGuid) !== null; },
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
