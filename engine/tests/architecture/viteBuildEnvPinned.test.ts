/** #2092 — every `vite build` a shipping build script spawns pins NODE_ENV through `viteBuildEnv`.
 *
 *  `/api/build` and the editor's OTA publish run these scripts from inside a Vite dev server, which sets
 *  `NODE_ENV=development`; a child that inherits it builds with `import.meta.env.DEV` true, which opens
 *  `engine/app/main.tsx`'s debug-bridge gate whatever `build.debugBuild` says, and ships every DEV-gated branch.
 *  `buildTargetParse.test.ts` proves the helper; this proves the CALL SITES use it — a revert to the plain
 *  `run(node, [viteBin, 'build', …])` would leave that unit test green. The end-to-end proof is
 *  `npm run smoke:debug-flag`, whose flag-off leg now builds with NODE_ENV=development (too slow for the gate). */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';

const SCRIPTS = ['build-web.mjs', 'build-subgame.mjs'];

/** Each statement that spawns `vite build` — from the `viteBin, 'build'` argv (either quote, any line breaks) to the
 *  `);` that ends the call — in source read with comments stripped by the shared scanner. Whole-source, not per
 *  line, so a call wrapped across lines is neither skipped nor misread. */
function viteBuildCalls(src: string): string[] {
  const calls: string[] = [];
  for (const m of src.matchAll(/\bviteBin\s*,\s*['"]build['"]/g)) {
    const end = src.indexOf(');', m.index);
    calls.push(src.slice(m.index, end < 0 ? undefined : end));
  }
  return calls;
}

describe('shipping build scripts pin NODE_ENV for their vite build (#2092)', () => {
  it.each(SCRIPTS)('%s spawns vite build only with viteBuildEnv(...)', (name) => {
    const src = readScannedSource(path.join(__dirname, '../../scripts', name)).code;
    const calls = viteBuildCalls(src);
    expect(calls.length, `${name}: no vite build call found — the guard is looking at the wrong shape`).toBeGreaterThan(0);
    for (const call of calls) expect(call, `${name}: a vite build without the NODE_ENV pin`).toMatch(/env:\s*viteBuildEnv\(/);
  });
});
