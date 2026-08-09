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

/** The subset of `engine/plugins/healNativeConfig.ts` that `.mjs` callers use (#150). */
export interface HealNativeConfigModule {
  healNativeConfig(projectRoot: string): { notes: string[] };
}

/** The subset of `engine/plugins/addNativeTarget.ts` that `.mjs` callers use (#150). */
export interface AddNativeTargetModule {
  ensureCapacitorDeps(
    projectRoot: string,
    platform: 'ios' | 'android',
    editorRoot: string,
  ): { changed: boolean; notes: string[] };
}

/** `loadEnginePluginModule`'s return type varies by which entry was loaded — untyped generic
 *  module shape here (narrow at the call site via the specific `*Module` interfaces above),
 *  rather than a union that would force every caller to discriminate. */
export type EnginePluginModule = Record<string, unknown>;

/** Load an `engine/plugins/*.ts` implementation by bundling it with esbuild first, or `null` when
 *  that is not possible here (no engine sources, or no esbuild — i.e. the packaged editor).
 *  `relPathFromEngineDir` is relative to `engine/` (e.g. `plugins/vendorPlugins.ts`). */
export declare function loadEnginePluginModule(
  repoRoot: string,
  relPathFromEngineDir: string,
): Promise<EnginePluginModule | null>;

/** Load `engine/plugins/vendorPlugins.ts` by bundling it with esbuild first, or `null` when that
 *  is not possible here (no engine sources, or no esbuild — i.e. the packaged editor). */
export declare function loadVendorPlugins(repoRoot: string): Promise<VendorPluginsModule | null>;
