import { PREFAB_EDIT_SCENE_PREFIX } from '../core/ecs/sceneLoaded';

/** One KEY per scene file, whichever form its path arrives in (#1750: the scene-file debt is keyed by it, and a change
 *  must reach the scene whether or not it is open).
 *
 *  Two path forms name the same scene:
 *   - the dev-server broadcast / asset manifest: `/assets/scenes/x.json`
 *   - the editor "open scene": Vite's absolute `/@fs/<abspath>/…/runtime/assets/scenes/x.json`
 *
 *  Separators become `/` first (a Windows path can carry `\`), the query goes, dot segments and doubled slashes
 *  collapse, and the key is `/assets/` + the path UNDER the asset root — so an absolute `/@fs/C:/…` path, the same
 *  path with a lower-case drive letter, and a clean `/assets/…` broadcast all resolve to one key. Only one project is
 *  open at a time, so the `/assets/…` form uniquely identifies a scene (no cross-project collision). A relative path is
 *  rooted first (`./assets/x` and `assets/x` are `/assets/x`, as the server roots them). A path with no `/assets/`
 *  segment (a test's bare path) is returned rooted, with only its separators and dot segments normalised; `''` — the
 *  untitled scene's history key — stays `''`, and a synthetic prefab-edit key is returned whole (below).
 *
 *  ⚠️ The root is found by ANCHORING, not by the last `/assets/` in the string (#1791): a folder named `Assets` inside
 *  the asset root is legal (nothing refuses the name), and cut at the last `/assets/`,
 *  `/assets/scenes/Assets/nest.scene.json` keyed as `/assets/nest.scene.json` — the key of a DIFFERENT file. Observed on
 *  Windows: a disk edit of `/assets/nest.scene.json` hot-reloaded the open nested scene and discarded its unsaved edits
 *  (#1164's disk-wins), on a case-insensitive disk. So a URL root (`/assets/`, `/modoki/assets/`,
 *  `/<games|demos>/<id>/assets/`) is matched at the START; any other path containing `/runtime/assets/` (Vite's
 *  `/@fs/<abs>/…`, the game app's `/games/<id>/runtime/assets/…`, a bare absolute path) is cut at its LAST one, where
 *  every project keeps its assets. Only a form that is neither falls back to the last `/assets/`. (A folder chain
 *  literally named `runtime/assets` inside the root would still collide in the `/runtime/assets/` cut — telling it
 *  from the project's own would take the project root, which this module does not have.)
 *
 *  Dot segments collapse (#1791): MCP `load_scene`, an agent `save_all {path}` on an untitled scene and the in-app
 *  Save prompt store the path as TYPED, and the server resolves `scenes/./x`. Observed: a scene opened as
 *  `/assets/scenes/./win1791.scene.json` kept that key, so the watcher's `/assets/scenes/win1791.scene.json` matched
 *  nothing and the disk edit was skipped silently — the missed-reload loss described below.
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
 *  literal on-disk name.
 *
 *  A synthetic prefab-edit key (`PREFAB_EDIT_SCENE_PREFIX` + guid, or + the prefab's PATH when it has no guid) is
 *  returned whole: cut at an `/assets/` inside it, it would lose the prefix that `adopt` reads to drop the edit
 *  world's stack (U27). */
export function normScenePath(p: string): string {
  if (p.startsWith(PREFAB_EDIT_SCENE_PREFIX)) return p;
  let s = p.replace(/\\/g, '/').split('?')[0];
  try { s = decodeURI(s); } catch { /* a malformed escape — keep the spelling as given */ }
  // Rooted first: a typed `./assets/x` or `assets/x` names the same file as `/assets/x` (the server roots it too).
  // `''` stays `''` — it is the untitled scene's history key.
  if (s) s = collapseDotSegments(s);
  const folded = s.toLowerCase();
  const root = URL_ASSET_ROOT.exec(folded);
  if (root) return `/assets/${folded.slice(root[0].length)}`;
  const fs = folded.lastIndexOf('/runtime/assets/');
  if (fs >= 0) return folded.slice(fs + '/runtime'.length);
  const i = folded.lastIndexOf('/assets/');
  return i >= 0 ? folded.slice(i) : s;
}

/** An asset-root URL prefix at the START of a path: `/assets/`, `/modoki/assets/`, `/<games|demos>/<id>/assets/`.
 *  (The game app's `/<games|demos>/<id>/runtime/assets/` spelling reaches the `/runtime/assets/` cut instead.)
 *  Lower-case: matched on the folded path. */
const URL_ASSET_ROOT = /^(?:\/modoki|\/(?:games|demos)\/[^/]+)?\/assets\//;

/** `/a/./b`, `/a/x/../b` and `/a//b` → `/a/b`, and ROOTED: `./a/b` and `a/b` → `/a/b`. Key-only: nothing fetches the
 *  result. */
function collapseDotSegments(s: string): string {
  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}
