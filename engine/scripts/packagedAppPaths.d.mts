/** Type sidecar for packagedAppPaths.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** electron-builder.yml's `productName` (e.g. "Modoki Editor"). */
export declare function productName(): string;

export interface ResolvedPackagedApp {
  appDir: string;
  bin: string;
  found: boolean;
  platform: NodeJS.Platform;
}

/** Resolve the built app inside an electron-builder `--dir` output dir. */
export declare function resolvePackagedApp(outDir: string, name?: string): ResolvedPackagedApp;

/** The executable inside an already-known app dir (`.app` bundle on macOS, unpacked dir elsewhere). */
export declare function binInAppDir(appDir: string, name?: string): string;

/** The packaged editor's userData dir — `<app support root>/<productName>`. */
export declare function packagedUserData(): string;

/** Drop the packaged Vite dep-cache; returns the paths removed (empty if there was none). */
export declare function clearViteCache(): string[];

/** The PowerShell that reaps the packaged app on Windows, scoped to `appDir` by executable path.
 *  Pure and exported so the SCOPING is unit-testable without spawning or killing anything
 *  (`engine/tests/architecture/packagedAppPaths.test.ts`). Omitting `appDir` means "any packaged
 *  instance, any clone" — the deliberate machine-wide case. */
export declare function winKillCommand(appDir?: string, name?: string): string;

/** Kill a leftover packaged instance. `appDir` omitted means "any packaged instance, any
 *  clone" (a caller that means that deliberately — see the .mjs source comment). Throws on EVERY
 *  platform when `appDir` is passed but empty/implausibly short: since the Windows branch became
 *  path-scoped too, an empty value would widen the match there just as it does on POSIX. */
export declare function killPackaged(appDir?: string, name?: string): void;
