import { PREFAB_EDIT_SCENE_PREFIX } from '../core/ecs/sceneLoaded';

/** One KEY per scene file, whichever form its path arrives in (#1750: the scene-file debt is keyed by it, and a change
 *  must reach the scene whether or not it is open).
 *
 *  Two path forms name the same scene:
 *   - the dev-server broadcast / asset manifest: `/assets/scenes/x.json`
 *   - the editor "open scene": Vite's absolute `/@fs/<abspath>/…/runtime/assets/scenes/x.json`
 *
 *  Separators become `/` first (a Windows path can carry `\`), then `runtime/assets` collapses to `assets`, the query
 *  goes, and the key is the suffix from the last `/assets/` — so an absolute `/@fs/C:/…` path, the same path with a
 *  lower-case drive letter, and a clean `/assets/…` broadcast all resolve to one key. Only one project is open at a
 *  time, so the `/assets/…` suffix uniquely identifies a scene (no cross-project collision). A path with no `/assets/`
 *  segment (a synthetic prefab-edit key, a test's bare path) is returned with only its separators normalised.
 *
 *  ⚠️ The suffix is CASE-FOLDED (#1786). Windows and macOS resolve a path case-insensitively, so a scene opened as
 *  `/assets/scenes/Empty.scene.json` loads the file `empty.scene.json` — and the watcher reports that file by its
 *  on-disk name. Observed on Windows: with the keys case-kept, the disk edit matched no loaded scene, the reload was
 *  skipped silently and the undo-history debt went under the other spelling. A key, not a path: nothing fetches it.
 *  The price is paid only on a case-SENSITIVE filesystem (the editor ships on neither), by two scenes whose names
 *  differ only in case: they share a key, so a change to one reloads the other with the disk-wins loss of its unsaved
 *  edits (#1164), and — the undo manager keys its parked stacks by this key too — opening one from the other is a
 *  same-key history swap that keeps the first scene's stack live over the second's world. Not folding costs a loss on
 *  the platforms the editor does ship on, the other way round: the missed reload leaves the world behind disk, and the
 *  next save writes the stale world over the external change.
 *
 *  The `/assets/` segment is found case-insensitively too (a `/@fs/` path spells the folder as it is on disk), and a
 *  percent-encoded spelling (`2D%20Animation`) is decoded: the server resolves both, while the watcher reports the
 *  literal on-disk name. A dot segment (`scenes/./x`) is NOT collapsed.
 *
 *  A synthetic prefab-edit key (`PREFAB_EDIT_SCENE_PREFIX` + guid, or + the prefab's PATH when it has no guid) is
 *  returned whole: cut at an `/assets/` inside it, it would lose the prefix that `adopt` reads to drop the edit
 *  world's stack (U27). */
export function normScenePath(p: string): string {
  if (p.startsWith(PREFAB_EDIT_SCENE_PREFIX)) return p;
  let s = p.replace(/\\/g, '/').split('?')[0];
  try { s = decodeURI(s); } catch { /* a malformed escape — keep the spelling as given */ }
  const folded = s.toLowerCase().replace('/runtime/assets/', '/assets/');
  const i = folded.lastIndexOf('/assets/');
  return i >= 0 ? folded.slice(i) : s;
}
