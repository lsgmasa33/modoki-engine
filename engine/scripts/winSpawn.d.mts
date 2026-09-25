/** Type sidecar for winSpawn.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** A Windows batch file (`.cmd`/`.bat` on win32): the only thing that needs cmd.exe to run it. */
export declare function needsWinShell(command: string, platform?: NodeJS.Platform): boolean;

/** Resolve a bare binary name on PATH the way a shell would (PATHEXT on win32), or null. */
export declare function whichSync(
  bin: string,
  opts?: { platform?: NodeJS.Platform; pathEnv?: string; pathExt?: string },
): string | null;

/** The cmd.exe command line that runs `command` with exactly `args` through a batch file. */
export declare function winBatchCommandLine(command: string, args: string[]): string;

export interface SpawnPlan {
  command: string;
  args: string[];
  /** Spread into the spawn options. Always `shell: false`. */
  options: { shell: false; windowsVerbatimArguments?: true };
}

/** `command` + `args` → a no-shell spawn that delivers `args` byte-exact, batch files included.
 *  A bare name is resolved on `opts.env`'s PATH (default: this process's) on win32. */
export declare function toSpawn(
  command: string,
  args?: string[],
  opts?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; comspec?: string },
): SpawnPlan;
