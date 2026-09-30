/** Type sidecar for chrome-devtools-mcp.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */
import type { ChildProcess, SpawnOptions } from 'node:child_process';

/** The CDP port the server attaches to: `MODOKI_CDP_PORT`, or 9222 when unset or empty. */
export declare function cdpPortFromEnv(env?: Record<string, string | undefined>): string;

/** The `npx` argument list for chrome-devtools-mcp, extra arguments appended. */
export declare function chromeDevtoolsArgs(env?: Record<string, string | undefined>, extra?: readonly string[]): string[];

/** The signals the wrapper forwards to its child. */
export declare const FORWARDED_SIGNALS: readonly ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Run a `toSpawn` result with inherited stdio and forwarded signals; this process ends the way it did. */
export declare function runTransparent(s: { command: string; args: readonly string[]; options?: SpawnOptions }): ChildProcess;
