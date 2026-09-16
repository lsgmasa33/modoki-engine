/** Warm the EDITOR prefab cache for every prefab instance a scene brings in (#1295).
 *
 *  The editor keeps its own `Map` of parsed prefab files, separate from the runtime's
 *  refcounted one, and several editor readers consult it SYNCHRONOUSLY while walking the live
 *  tree — `planPrefabRows`, `captureInstanceStructure`/`captureNestedRef`,
 *  `captureNestedInstanceOverrides`. Every one of them treats a miss as "not a prefab" and
 *  silently discards data (#1284: Create Prefab wrote copies instead of a reference, with only
 *  a console.warn).
 *
 *  A scene load used to leave that map EMPTY, because the loader fills the runtime cache
 *  instead — so the normal state, right after opening a scene, was that every live instance
 *  was invisible to those readers. This closes that by warming once per swap.
 *
 *  ⚠️ **It is very nearly free, and that is not an accident.** `SceneManager` has already
 *  walked the scene's prefabs transitively and acquired each into the runtime cache before this
 *  hook runs, and both caches parse the same bytes through the same
 *  `migrateUIAnchorZIndexStructured` pass. So the common case here is a `Map.get` plus a
 *  `Map.set` — no fetch, no parse. The fallback fetch only fires for a source the runtime cache
 *  cannot key, i.e. a raw internal asset path on an instance whose scene has never been saved.
 *  Measured over the repo's 56 scenes: at most 4 distinct prefabs per scene, median 0.
 *
 *  ⚠️ Registered as a **beforeSwap** hook, not a post-load one, and the distinction matters: the
 *  loader AWAITS these, so no gesture can land in a window where the cache is still cold. A
 *  post-swap hook would leave exactly that window.
 *
 *  ⚠️ It is NOT a barrier, though — `fireBeforeSwapHooks` wraps each hook in try/catch and only
 *  `console.warn`s, so a throw mid-loop leaves a PARTIALLY warmed cache and the swap proceeds
 *  anyway. Nothing here realistically throws (the fetch swallows its own errors), but do not
 *  read the await as a guarantee that the cache is complete. */

import type { World } from 'koota';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { getCachedPrefab } from '../../runtime/loaders/meshTemplateCache';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { isGuid } from '../../runtime/loaders/assetManifest';
import { getPrefabSource, isEditorPrefabCached, primeEditorPrefabCache, type PrefabFile } from './prefab';

/** Every distinct `PrefabInstance.source` in `world`. Read off the STAGING world the hook is
 *  handed — `getAllEntities()` would read the world being replaced. */
function liveSources(world: World): string[] {
  const meta = getTraitByName('PrefabInstance');
  if (!meta) return [];
  const out = new Set<string>();
  world.query(meta.trait).updateEach(([pi]) => {
    const src = (pi as Record<string, unknown>).source;
    if (typeof src === 'string' && src) out.add(src);
  });
  return [...out];
}

export async function warmEditorPrefabCacheFor(world: World): Promise<void> {
  for (const source of liveSources(world)) {
    if (isEditorPrefabCached(source)) continue;
    // ⚠️ GUID only. `getCachedPrefab` resolves the ref internally via `resolveRef`, which
    // REJECTS an internal asset path with a loud console.error — and a raw path is precisely
    // the case the fetch below exists for, so asking anyway would print an integrity error on
    // the one input this branch is designed to handle. `fetchPrefabSource` dodges the same
    // edge deliberately (it uses `assetUrl` for a non-guid); this matches it.
    if (isGuid(source)) {
      // The loader already fetched, parsed and migrated this — take it rather than re-reading.
      const shared = getCachedPrefab(source) as PrefabFile | undefined;
      if (shared) { primeEditorPrefabCache(source, shared); continue; }
    }
    // Not in the runtime cache, or not keyable by it (a raw asset path on an instance whose
    // scene has never been saved) — fetch it.
    await getPrefabSource(source);
  }
}

/** Install the hook. Returns the un-installer, for the caller's teardown scope. */
export function installEditorPrefabCacheWarm(): () => void {
  const hook = (world: World) => warmEditorPrefabCacheFor(world);
  sceneManager.registerBeforeSwap(hook);
  return () => sceneManager.unregisterBeforeSwap(hook);
}
