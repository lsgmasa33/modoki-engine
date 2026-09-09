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
export declare function binInAppDir(appDir: string, name?: string, platform?: NodeJS.Platform): string;

/** The packaged editor's userData dir — `<app support root>/<productName>`. */
export declare function packagedUserData(): string;

/** Drop the packaged Vite dep-cache; returns the paths removed (empty if there was none). */
export declare function clearViteCache(): string[];

/** The PowerShell that reaps the packaged app on Windows, scoped to `appDir` by executable path.
 *  Pure and exported so the SCOPING is unit-testable without spawning or killing anything
 *  (`engine/tests/architecture/packagedAppPaths.test.ts`). Omitting `appDir` means "any packaged
 *  instance, any clone" — the deliberate machine-wide case. */
export declare function winKillCommand(appDir?: string, name?: string): string;

/** The clone's OTHER spelling of an absolute path (`realpathSync.native`), or null when there is
 *  no distinct one — no path, unresolvable, non-absolute, or identical. `reap_alt_pattern`'s
 *  contract from `lib/repo-reap.sh`, in JS (#959). */
export declare function altPathSpelling(p?: string): string | null;

/** How a reap turned out. `exit 0` is right for all three, but they are not the same event and
 *  collapsing them into one silent catch is what made every bash caller's `|| true` structural
 *  (#944). */
export declare const REAP_KILLED: 'killed';
export declare const REAP_NONE: 'none';
export declare const REAP_ERROR: 'error';
export type ReapOutcome = typeof REAP_KILLED | typeof REAP_NONE | typeof REAP_ERROR;

/** Decode the win32 reap's stdout into an outcome. Pure + exported so the decision is unit
 *  testable without spawning: every behavioural case in killPackagedGuard.test.ts is
 *  skipIf(win32), so on a Mac nothing else executes that branch. Empty/unparseable stdout is an
 *  ERROR, never an empty match — the count is Windows' only signal (#944). */
export declare function decodeWinReap(stdout: string | undefined): ReapOutcome;

/** Kill a leftover packaged instance. `appDir` omitted means "any packaged instance, any
 *  clone" (a caller that means that deliberately — see the .mjs source comment). Throws on EVERY
 *  platform when `appDir` is passed but empty/implausibly short: since the Windows branch became
 *  path-scoped too, an empty value would widen the match there just as it does on POSIX. */
export declare function killPackaged(appDir?: string, name?: string): ReapOutcome;

/** The OS "application support" root Electron puts userData dirs under.
 *
 *  ⚠️ Pure/platform-injectable, and the three branches do NOT read the same inputs: win32 honours
 *  `APPDATA`, linux honours `XDG_CONFIG_HOME`, **darwin honours neither** and derives from `home`
 *  alone. The parameters exist so that asymmetry is pinnable from any platform — the darwin branch
 *  is the one no leg this repo runs would otherwise execute. */
export declare function appSupportRoot(
  platform?: NodeJS.Platform,
  env?: NodeJS.ProcessEnv,
  home?: string,
): string;

/** `engine/electron/userDataDir.ts`'s SHARED_DIR — the machine-level root the provisioned Build
 *  Support toolchain lives under, shared by every clone rather than per-app. */
export declare const SHARED_DIR: 'Modoki';

/** Where `--toolchain` looks when `MODOKI_TOOLCHAIN_DIR` is unset. Exported so a TEST can build a
 *  fixture at the real default instead of re-deriving it — `clean-packaged-cache.mjs` is a
 *  top-level program and importing IT for the path would run the wipe. */
export declare function defaultToolchainDir(): string;
