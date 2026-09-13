/** Which worlds hold a scene that has FINISHED loading (#1135).
 *
 *  ⚠️ **A game system cannot tell "the scene is not here yet" from "the scene has no X" by looking at
 *  the world.** GAME systems tick from the app's first frame, several frames before `loadScene`
 *  (docs/scene-loading.md § "GAME systems tick before the first scene exists"), so an empty world is
 *  routine at every boot — and the same empty world is also what a scene that genuinely authors
 *  nothing of the kind produces. The engine had no answer to tell them apart: `sceneManager.getCurrent()`
 *  is module-scoped and never set by `createTestWorld`, `@scene-loaded` is a journal event that store
 *  builds turn off, and `onWorldSwap` fires on EVERY promote (an `unloadAll`'s empty world, a test
 *  world) so it means "the world changed", not "a scene arrived". Three games each invented their own
 *  answer — a frame count, a per-game singleton, and silence.
 *
 *  So this is the one: `SceneManager.loadScene` marks the world it promotes, just before
 *  `setCurrentWorld`, with the scene file's path. A world is marked once and never unmarked, and the
 *  mark dies with the world (a `WeakMap`), so a later scene is a new world with its own mark.
 *
 *  ⚠️ **Only a scene FILE marks** (`isSceneFilePath`). `replaceWorldContent` (the editor's Create
 *  Scene) promotes an empty world with no file behind it; marking it would make every game system that
 *  needs an authored entity report an authoring defect the instant an author starts a blank scene. The
 *  same holds for an untitled scene's Play/Stop reload (path `''`) and the prefab-edit world.
 *  `unloadAll`'s world is not a scene at all. Headless tests opt in through
 *  `createTestWorld({ scenePath })`. */

import type { World } from 'koota';

/** The synthetic scene path of the editor's isolated prefab-edit world: `<prefix><prefab guid>`. Not a
 *  FILE — nothing may fetch, load or save it. Defined here, beside the one runtime question it answers
 *  (`isSceneFilePath`), and re-exported by `editor/scene/prefabEditWorld.ts` for the editor. */
export const PREFAB_EDIT_SCENE_PREFIX = '/__prefab-edit__/';

/** Is `path` a real scene FILE, as opposed to a world the editor constructed?
 *
 *  ⚠️ **`loadScene` is not only called with files** (#1135 review). The editor reloads a Play-mode or
 *  timeline-preview snapshot through `loadScene(path ?? '', { preloaded })` — `''` for an untitled
 *  Create Scene world — and enters prefab edit through `loadScene('/__prefab-edit__/<guid>')`, whose
 *  scaffold authors a `Canvas2D` only for a prefab that draws in 2D. Marking those worlds made a second
 *  Play in a blank scene, or Play inside a UI-only prefab, report a missing host as an authoring
 *  defect. */
export function isSceneFilePath(path: string): boolean {
  return path !== '' && !path.startsWith(PREFAB_EDIT_SCENE_PREFIX);
}

const loaded = new WeakMap<World, string>();

/** Record that `world` holds the fully loaded scene at `path`. */
export function markSceneLoaded(world: World, path: string): void {
  loaded.set(world, path);
}

/** The path of the scene file `world` finished loading, or `undefined` while no scene has — the
 *  pre-scene boot window, an editor Create Scene world, or a test world that did not opt in. */
export function loadedScenePath(world: World): string | undefined {
  return loaded.get(world);
}
