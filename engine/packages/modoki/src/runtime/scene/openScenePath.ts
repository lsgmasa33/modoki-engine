import { sceneManager } from './SceneManager';

/** Editor-only: the file the editor's next save writes (`getCurrentScenePath`), installed by the editor (#1712, #1718).
 *  Unset in the game runtime, where `SceneManager` is the only answer. */
let editorScenePath: (() => string | null) | null = null;

/** Editor-only: install the editor's scene-path reader. Called from `agentEditorOps.ts`. */
export function setEditorScenePathReader(fn: (() => string | null) | null): void {
  editorScenePath = fn;
}

/** The scene FILE the open world is bound to: `SceneManager`'s primary when it has one, else the file the editor
 *  saves it to (#1712). Every reader that NAMES the open scene asks this (#1718: the take recorder, the SceneView label,
 *  the capture status, the bridge's hot reload and `load-scene`).
 *
 *  ⚠️ Not `sceneManager.getCurrent()?.path` alone. A world made by `newScene()` goes through `replaceWorldContent`,
 *  which leaves `getCurrent()` null by design, and a save that later gives it a file (`save_all {path}`, a first Cmd+S,
 *  Assets → Create Scene) tells only the editor. Asking `SceneManager` alone dropped every outside change to that scene
 *  (#1712), refused a take ("no scene is open") and labelled it Untitled until it was reopened. `SceneManager` still
 *  wins whenever it answers, so the prefab-edit world keeps its synthetic path (the editor's is null there) and a
 *  loaded scene reads exactly as before.
 *
 *  ⚠️ NOT a `SceneManager` primary entry for such a world: that would make `getCurrentSceneId()` non-null and move font
 *  and texture ownership in scene3DSync/Scene2D for every untitled scene (#1712's design). A reader that asks WHICH
 *  WORLD IS LOADED, rather than which file it is — the prefab-edit prefix check, a supersede's winner, the capture's
 *  readiness hold — keeps asking `SceneManager`. */
export function openScenePath(): string | null {
  return sceneManager.getCurrent()?.path ?? editorScenePath?.() ?? null;
}
