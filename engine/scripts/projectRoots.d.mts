/** Type sidecar for `projectRoots.mjs` — see that file for the design rationale.
 *  Hand-written because the module is plain JS (three of its consumers are Node
 *  scripts that cannot import TypeScript), but `vite-asset-scanner.ts` imports it
 *  and is typechecked transitively via `engine/tsconfig.node.json`'s `vite.config.ts`. */

/** Repo-root-relative directories that hold self-contained Modoki projects. */
export declare const PROJECT_ROOT_DIRS: readonly string[];

export interface DiscoveredProject {
  /** The root it lives under — `'games'` or `'demos'`. */
  root: string;
  /** The project's directory name, e.g. `'3d-physics-demo'`. */
  name: string;
  /** Absolute path to the project directory. */
  dir: string;
}

export interface ProjectAssetRoot {
  /** Served URL prefix, e.g. `/demos/3d-physics-demo/assets`. */
  urlPrefix: string;
  /** Absolute path to the project's `runtime/assets`. */
  absDir: string;
}

export declare function discoverProjects(repoRoot: string): DiscoveredProject[];
export declare function projectAssetRoots(repoRoot: string): ProjectAssetRoot[];
export declare function isProjectDir(repoRoot: string, abs: string): boolean;
