/** Type sidecar for `loadVendorPlugins.mjs` — see that file for the design rationale.
 *  Hand-written for the same reason as `projectRoots.d.mts`: the module is plain JS because its
 *  consumers are Node scripts that cannot import TypeScript, but a test imports it and is
 *  typechecked. */

/** The subset of `engine/plugins/vendorPlugins.ts` that `.mjs` callers use. Deliberately narrow —
 *  widen it as callers need more, rather than mirroring the whole module here where it could drift
 *  from the real one silently. */
export interface VendorPluginsModule {
  vendorEnginePlugins(
    projectRoot: string,
    engineRoot: string,
    opts?: { canBuild?: boolean },
  ): {
    changed: boolean;
    needsInstall: boolean;
    vendored: string[];
    expectedVendor: Record<string, string>;
  };
  writeVendorMarker(projectRoot: string, specs: Record<string, string>): void;
}

/** Load `engine/plugins/vendorPlugins.ts` by bundling it with esbuild first, or `null` when that
 *  is not possible here (no engine sources, or no esbuild — i.e. the packaged editor). */
export declare function loadVendorPlugins(repoRoot: string): Promise<VendorPluginsModule | null>;
