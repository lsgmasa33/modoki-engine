/** Type sidecar for `stamp-plugin-builds.mjs` — see that file for the design rationale.
 *  Hand-written for the same reason as `loadVendorPlugins.d.mts`: the module is plain JS because
 *  it runs from `postinstall` where TypeScript cannot be imported, but a test imports it and is
 *  typechecked. */

/** The shape `buildPluginsWorkspaces` reads out of a parsed root package.json. Deliberately
 *  minimal — it only ever looks at one script. */
export interface PackageJsonWithScripts {
  scripts?: Record<string, string>;
}

/** The workspace dirs named in the root `build:plugins` script, in the order they appear.
 *
 *  This is the SAFETY boundary of #395, not a convenience: the stamper may only vouch for dists
 *  that `build:plugins` actually built, never the wider set `listEnginePlugins` discovers, because
 *  those two are permitted to diverge (`pluginBuildCoverage.test.ts`). Returns `[]` when the script
 *  is missing or reshaped, which stamps nothing — one redundant rebuild, never a stale trust. */
export declare function buildPluginsWorkspaces(pkgJson: PackageJsonWithScripts | null | undefined): string[];

/** One planned stamp target: the `--workspace` string as written, and its absolute dir. */
export interface PlannedStampDir {
  rel: string;
  dir: string;
}

/** The dirs this install may stamp — derived from `build:plugins`, NEVER from `listEnginePlugins`.
 *  This is the #395 safety boundary in one testable place; see the .mjs for why. */
export declare function plannedStampDirs(
  repoRoot: string,
  pkgJson: PackageJsonWithScripts | null | undefined,
): PlannedStampDir[];
