/** Type sidecar for `staleNodeModulesWarning.mjs` — see that file for the design rationale.
 *  Hand-written because the module is plain JS (`build-web.mjs`, a CLI script, cannot import
 *  TypeScript), but `engine/plugins/vite-asset-scanner.ts` imports it and is typechecked normally.
 *  Same pattern as `buildClaimsStore.mjs`/`buildClaimsStore.d.mts`. */

/** The shared "package.json could not be read, so the #685 stale-node_modules check did not run"
 *  sentence for `projectRoot` — no caller-specific prefix included, see the `.mjs` for why. */
export declare function describeUnreadablePackageJsonWarning(projectRoot: string): string;
