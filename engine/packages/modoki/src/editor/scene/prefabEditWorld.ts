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
 *  nothing may try to fetch, load or save it. Defined in the runtime since #1135, which must not mark
 *  that world as a loaded scene. */
import { PREFAB_EDIT_SCENE_PREFIX } from '../../runtime/core/ecs/sceneLoaded';
export { PREFAB_EDIT_SCENE_PREFIX };

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
  return prefabEditWorldPath() !== null;
}

/** The loaded prefab-edit world's synthetic path (`/__prefab-edit__/<guid>`), or `null` when a real scene is loaded.
 *  Same ground truth as `isPrefabEditWorld` — the handle the agent edit routes address that world by (#1254),
 *  because it has no asset path to be addressed by. */
export function prefabEditWorldPath(): string | null {
  const p = sceneManager.getCurrent()?.path ?? '';
  return p.startsWith(PREFAB_EDIT_SCENE_PREFIX) ? p : null;
}

/**
 * The prefab-edit world's handle ONLY while the edit SESSION for that same prefab is open — what an agent may edit
 * and then persist with `edit-save`. `session` is the store's `editingPrefab`, passed in so this stays a pure read.
 *
 * ⚠️ **Not `prefabEditWorldPath()`, which is the right question for "may this world be SAVED as a scene" and the
 * wrong one here** (#1254 close-out review). An exit whose return-scene reload fails, or that has no scene to return
 * to, still clears the session while the world stays synthetic. Reporting the world then let a mutate go live and
 * answer "run edit-save" — which refuses without a session, as does `save_all` in that world, so the edit could not
 * reach disk by any route.
 */
export function prefabSessionWorldPath(session: { guid: string } | null | undefined): string | null {
  const world = prefabEditWorldPath();
  return world && session && world === `${PREFAB_EDIT_SCENE_PREFIX}${session.guid}` ? world : null;
}
