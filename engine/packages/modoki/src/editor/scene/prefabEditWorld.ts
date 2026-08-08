/** Is the LIVE world the synthetic prefab-edit world?
 *
 *  A leaf module on purpose. `prefabEdit.ts` already imports `saveScene`/`loadScene` from
 *  `serialize.ts`, so `serialize.ts` cannot import back from `prefabEdit.ts` — and the save path is
 *  exactly where this question has to be asked. Keeping the prefix and the predicate here lets both
 *  sides read ONE definition instead of hand-copying `startsWith('/__prefab-edit__/')`, which is how
 *  the editor ended up with several places that each decide "am I in prefab-edit?" for themselves.
 */

import { sceneManager } from '../../runtime/scene/SceneManager';

/** Synthetic scene path for the isolated prefab-edit world: `<prefix><prefab guid>`. Not a FILE —
 *  nothing may try to fetch, load or save it. */
export const PREFAB_EDIT_SCENE_PREFIX = '/__prefab-edit__/';

/**
 * True when the loaded scene is a prefab-edit world.
 *
 * ⚠️ **This is the GROUND TRUTH, and the `editingPrefab` store flag is not.** The flag can be out of
 * sync in both directions: cleared while the world is still synthetic (an exit whose scene reload
 * failed — the editor stays in the prefab world with the flag gone), or set while a real scene is
 * loaded (opening a scene from the Assets panel bypasses `exitPrefabEditing`). Anything deciding
 * *what may be written to disk* must ask the WORLD, because the world is what would be written.
 *
 * Pure — unlike `isEditingPrefab()`, which self-heals a stale flag as a side effect, so it is unsafe
 * to call from a probe or a guard that must not mutate editor state.
 */
export function isPrefabEditWorld(): boolean {
  return (sceneManager.getCurrent()?.path ?? '').startsWith(PREFAB_EDIT_SCENE_PREFIX);
}
