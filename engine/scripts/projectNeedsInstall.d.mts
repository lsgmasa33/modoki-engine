/** Type sidecar for `projectNeedsInstall.mjs` — see that file for the design rationale.
 *  Hand-written because the module is plain JS (it is imported by `bootstrap-game-deps.mjs`,
 *  a Node script that cannot import TypeScript), while `projectNeedsInstall.test.ts` imports
 *  it and IS typechecked (`engine/tsconfig.test.json`). */

/** The shape this rule reads — a project's `package.json`, of which only three fields matter.
 *  The index signature is load-bearing, not laziness: callers pass a REAL parsed package.json
 *  (name, version, scripts, …), and an exact type would reject it at every call site. */
export interface ProjectManifest {
  workspaces?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/** True when this project's `package.json` means "run npm install in my folder": it owns
 *  sub-packages to LINK (`workspaces`), or declares dependencies to INSTALL (#215). */
export declare function projectNeedsInstall(pkg: ProjectManifest | null | undefined): boolean;
