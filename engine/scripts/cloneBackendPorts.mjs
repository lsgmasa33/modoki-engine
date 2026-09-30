/**
 * The clone → editor backend port TABLE and its lookup, with NO top-level effects (#1894).
 *
 * Split out of `editorPorts.mjs`, which re-exports every name here, so every existing importer,
 * the table-parsing guard (`editorPorts.test.ts`) and the bash CLI are unchanged. The split
 * exists because `editorPorts.mjs` runs its CLI at top level whenever `isEntryPoint(import.meta.url)`
 * — and a BUNDLE inlines it: in `engine/tools/modoki-mcp/dist/index.js` (esbuild, the server the
 * packaged editor spawns) `import.meta.url` IS `process.argv[1]`, so importing `editorPorts.mjs`
 * into the MCP server would run the CLI inside it, beside a stdio protocol that owns stdout.
 * The MCP servers import THIS module instead, to derive their backend from the clone they run
 * in when `MODOKI_BACKEND` is unset (`engine/tools/shared/backendUrl.ts`).
 *
 * ⚠️ Keep it effect-free: no CLI, no I/O at import, and import only modules that are themselves
 * effect-free. Guarded by `engine/tests/architecture/cloneBackendPorts.test.ts`.
 *
 * The table's rationale (why it is keyed on the directory, why an unknown one is `null`) lives
 * in `editorPorts.mjs`'s header, which is still where a reader of RULE 2 lands.
 */
import path from 'node:path';
import { canonicalPath, pathCaseKey } from './pathIdentity.mjs';
/**
 * Clone directory basename → pinned editor backend port.
 *
 * Kept in step with the table in `docs/clones-and-ports.md` § RULE 2 by
 * `engine/tests/architecture/editorPorts.test.ts`, which PARSES that table rather
 * than trusting a comment.
 *
 * The Windows clone is deliberately absent: it is its own machine, so nothing can
 * collide there, and it has no assigned port in the table either.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const CLONE_BACKEND_PORTS = Object.freeze({
  'modoki': 5179,
  'modoki-ai': 5180,
  'modoki-ai2': 5181,
  'modoki-ai3': 5182,
  'modoki-qa': 5183,
});

/** The same table keyed by `pathCaseKey`, for the case-insensitive fallback in
 *  `backendPortForClone` (#881). DERIVED from the table above rather than hand-written, so a clone
 *  added to one is in the other by construction — a second hand-kept list is how #798's five
 *  `toPosix` copies happened. */
const CLONE_BACKEND_PORTS_BY_CASE_KEY = new Map(
  Object.entries(CLONE_BACKEND_PORTS).map(([name, port]) => [pathCaseKey(name), port]),
);
// ⚠️ Two table names folding to one key would silently drop a clone from this fallback — a `Map`
// keeps the last write and says nothing. That check lives in `editorPorts.test.ts`, NOT here as a
// module-load `throw`, which is what #881 first wrote and review rejected for three reasons:
// it fires only on case-INSENSITIVE platforms (so the public Linux CI leg stays green on the
// very edit that breaks every Mac clone); it would kill `modoki-mcp`, which imports this module,
// rather than degrade one clone; and every shell caller wraps this file in `|| true`, so a throw
// degrades ALL of them to auto ports with a stack trace where the guarded bug degrades exactly
// one. It also contradicts this file's own CLI contract below — "always exits 0 … a non-zero exit
// inside a command substitution would kill the launch rather than degrade it".

/**
 * The pinned backend port for the clone at `repoRoot`, or `null` when the
 * directory is not one of the known clones (→ the caller should use auto ports).
 *
 * @param {string} repoRoot absolute path to the repo root
 * @returns {number | null}
 */
export function backendPortForClone(repoRoot) {
  // #881: `path.resolve` + a case-SENSITIVE object lookup was two misses in one line. `resolve`
  // normalises separators and `..` but neither drive-letter case, a `subst` mapping nor a symlink,
  // so `E:/Projects/MODOKI` — or a clone reached through a junction — produced a `name` that is not
  // a key here, returned `null`, and dropped the clone onto AUTO ports. That is #349's failure
  // wearing a different cause: the editor comes up on a port no sibling expects, and every
  // `MODOKI_BACKEND` aimed at this clone drives someone else's.
  //
  // ⚠️ **Drive-letter case is in that list because `resolve` does not fix it — NOT because it can
  // break THIS lookup. It cannot: the key is a `basename`, which no drive letter reaches.** Driven
  // on `win` (#893): `e:\Projects\modoki` and `E:\Projects\modoki` both key `"modoki"`, and so does
  // the drive-relative `e:`. The misses that actually land here are a `subst` (basename `""`), a
  // case-flipped NAME (`"MODOKI"`), and a junction whose own name is not a clone name. Reading the
  // sentence above as "flip the drive letter and lose your port" is a real misreading — #893's
  // checklist made it and went looking for the wrong half. Table: docs/windows.md § Paths.
  //
  // `canonicalPath` fixes the spelling where the directory EXISTS (`.native` expands `subst`,
  // junctions and drive case). `pathCaseKey` carries the rest: `.native` throws on a path that is
  // gone and the fallback is bare `resolve`, which folds nothing — and this function is called with
  // a not-yet-created root by the scaffolder path. Both halves are needed; neither is redundant.
  const name = path.basename(canonicalPath(repoRoot));
  const exact = CLONE_BACKEND_PORTS[name];
  if (exact !== undefined) return exact;
  const folded = CLONE_BACKEND_PORTS_BY_CASE_KEY.get(pathCaseKey(name));
  return folded ?? null;
}

/**
 * The backend URL for the clone at `repoRoot`, for consumers that want a URL and
 * have no other signal — notably the MCP servers, whose only alternative default
 * was a hardcoded hub port.
 *
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function backendUrlForClone(repoRoot) {
  const port = backendPortForClone(repoRoot);
  return port === null ? null : `http://127.0.0.1:${port}`;
}
