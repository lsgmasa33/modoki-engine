/** The open project's scene paths in ONE spelling (#1898).
 *
 *  A scene of the open project can be addressed two ways: the asset-scanner's `/assets/<rest>`, and Vite's
 *  `/@fs/<abs>/runtime/assets/<rest>` — what a game's `config.ts` `?url` import resolves to (a scaffolded project's
 *  default scene), and what an explicit `/@fs/` load names. Both fetch the same file, but everything that compares
 *  paths — `modoki_wait_for {editor:{scenePath}}`, the edit routes, the persisted last scene — only knows `/assets/`.
 *  So the editor stores the `/assets/` form, and this module is the one place that maps the other one to it.
 *
 *  ⚠️ The `/@fs/…/runtime/assets/` shape alone does NOT prove the file is the open project's: findAssetRoots serves
 *  THREE roots that all end in `/runtime/assets/` — `/assets` (the open project), `/modoki/assets` (the engine's
 *  built-ins) and `/<root>/<id>/assets` (every other project in a multi-project repo). Rewriting either of the last two
 *  to `/assets/…` names a same-named file under the open project instead, so the rewrite is taken only when `<abs>`
 *  IS the open project's root, by ORIGIN.
 *
 *  ⚠️ Vite's `/@fs/` path is a REALPATH and the project root is whatever spelling it was opened by. A project reached
 *  through a link (`/tmp` → `/private/tmp`, `/var` → `/private/var` on macOS) failed that origin check on every boot, so
 *  the raw `/@fs/` spelling was stored and persisted as the last scene (#1898). Main therefore reports the root's
 *  realpath too, and the check accepts either. */

// `/@fs/<abs>/runtime/assets/<rest>` — the flat-project layout, `<projectRoot>/runtime/assets` served as `/assets`.
const FS_RUNTIME_ASSETS_RE = /^\/@fs\/(.*)\/runtime\/assets\/(.+)$/;

/** Normalize a filesystem path for a Windows-safe prefix comparison: forward slashes,
 *  lowercase (Windows paths are case-insensitive), no trailing separator. */
function normalizeFsPath(p: string): string {
  const s = p.replace(/\\/g, '/').toLowerCase();
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}


/** Does `scenePath` have the `/@fs/<abs>/runtime/assets/<rest>` shape? Then `{abs, assetPath}` with `assetPath` the
 *  `/assets/<rest>` it would be IF `<abs>` is the open project — unconfirmed; the caller decides by origin or manifest. */
export function matchFsRuntimeAsset(scenePath: string): { abs: string; assetPath: string } | null {
  const m = scenePath.match(FS_RUNTIME_ASSETS_RE);
  if (!m) return null;
  // `/@fs/` swallows a POSIX path's own leading slash — `/@fs/Users/x` is `/Users/x` — but not a drive letter's
  // (`/@fs/E:/x` is `E:/x`). Captured without it, a POSIX `<abs>` never sat inside its root, so every Mac/Linux boot
  // kept the `/@fs/` spelling (#1898): the tests of this check only ever used Windows paths.
  const abs = /^[A-Za-z]:/.test(m[1]) ? m[1] : `/${m[1]}`;
  return { abs, assetPath: `/assets/${m[2]}` };
}

/** The open project's root spellings — as opened, and its realpath (`/api/identity`). Empty until boot reads them. */
let _openProjectRoots: readonly string[] = [];

export function setOpenProjectRoots(roots: readonly (string | null | undefined)[]): void {
  _openProjectRoots = [...new Set(roots.filter((r): r is string => typeof r === 'string' && r.length > 0))];
}

export function getOpenProjectRoots(): readonly string[] {
  return _openProjectRoots;
}

/** Is `abs` one of `roots` — the open project's `<root>` itself, whose `runtime/assets` IS `/assets`? Not a folder
 *  inside it: `<root>/node_modules/<pkg>/src/runtime/assets/x` is another file than `/assets/x` (close-out review F6),
 *  and so is a `runtime/assets` chain nested under the project's own assets (the capture's `.*` is greedy). Null when
 *  there are no roots to judge by — "unknown", not "no". */
export function isProjectRoot(abs: string, roots: readonly string[] = _openProjectRoots): boolean | null {
  if (roots.length === 0) return null;
  const a = normalizeFsPath(abs);
  return roots.some((root) => normalizeFsPath(root) === a);
}

/** `scenePath` in the open project's `/assets/` spelling when it is one of its `/@fs/` files; otherwise unchanged —
 *  another root's file, a path of any other shape, or no known root to confirm the origin by. */
export function toOpenProjectScenePath(scenePath: string, roots: readonly string[] = _openProjectRoots): string {
  const fs = matchFsRuntimeAsset(scenePath);
  return fs && isProjectRoot(fs.abs, roots) === true ? fs.assetPath : scenePath;
}
