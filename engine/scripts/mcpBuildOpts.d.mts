/** Type sidecar for mcpBuildOpts.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */
import type { BuildOptions } from 'esbuild';

/** `engine/tools/modoki-mcp` — the tool is deliberately NOT a root workspace. */
export declare const mcpDir: string;

/** The entry the shipped bundle is built FROM. */
export declare const mcpEntry: string;

/** The artifact that actually ships, and that `connectClaude.ts` names in the user's `.mcp.json`. */
export declare const mcpOutfile: string;

/** The esbuild options `build-electron.mjs` uses. Imported rather than restated by
 *  `engine/tests/electron/mcpBundle.test.ts` so the two cannot drift (#945 B1). */
export declare const mcpOpts: BuildOptions;
