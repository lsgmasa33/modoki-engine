/**
 * The V8 heap the gate's and the builds' large `tsc` programs run under (#1885) — the single
 * source for the root and `@modoki/engine` `typecheck` scripts (through `tsc.mjs`),
 * `typecheck-projects.mjs`, `build-web.mjs` and `build-subgame.mjs`. The MCP servers' and the
 * capacitor plugins' own `tsc` runs stay bare: they pin their own TypeScript, and each program is
 * well under 1 GB (the measured table is in the doc below).
 *
 * WHY: Node sizes its default old-space limit from the machine's RAM, so on a 7-8 GB machine —
 * the free public CI's `macos-14` runner, and any contributor's 8 GB laptop — every `tsc` gets
 * ~2 GB. The COLD `engine/tsconfig.test.json` program already needs more than that (it OOMed the
 * public CI in 2 of 3 runs). Measured floors and headroom: docs/verify-and-ci.md § "The typecheck's
 * heap". A cap, not a reservation: a program that needs 1 GB still uses 1 GB.
 *
 * ⚠️ A node FLAG, never `NODE_OPTIONS=… cmd` in an npm script — a POSIX env prefix does not run
 * under Windows' cmd.exe (docs/windows.md), and the private package.json ships verbatim into the
 * public snapshot, whose CI has a Windows leg.
 */
export const TSC_HEAP_MB = 4096;

/** Node arguments to put BEFORE the tsc bin: `execFileSync(process.execPath, [...TSC_NODE_ARGS, tscBin, ...])`. */
export const TSC_NODE_ARGS = Object.freeze([`--max-old-space-size=${TSC_HEAP_MB}`]);
