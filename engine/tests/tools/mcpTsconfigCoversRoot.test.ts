/** Every `.ts` at the modoki-mcp package root is in that package's tsconfig `include` (#894 review).
 *
 *  ⚠️ This guard exists because the hand-maintained list has ALREADY failed once, in the commit that
 *  created it. `include` was `["src"]`, so the root executables — `gen-surface-ledger.ts`,
 *  `gen-tool-catalog.ts`, `test-live-tools.ts` — were typechecked by NOTHING; a deliberate type
 *  error in one left all four `npm run typecheck` legs green. The first fix listed two of the three
 *  and left `test-live-tools.ts` out, which is the worst one to miss: CLAUDE.md mandates it after
 *  any `engine/tools/**` change, it only runs when a human drives the live gate by hand, and it had
 *  accumulated four real type errors while nothing compiled it.
 *
 *  A comment saying "keep this list complete" is the shadowing-constant-kept-in-sync-by-hand shape
 *  CLAUDE.md warns about: it goes stale on the first file somebody adds, silently. So the list is
 *  DERIVED and compared instead of trusted. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../tools/modoki-mcp',
);

describe('modoki-mcp tsconfig covers every root .ts (#894)', () => {
  it('the include list names every root-level TypeScript file', () => {
    const raw = fs.readFileSync(path.join(pkgRoot, 'tsconfig.json'), 'utf8');
    // The file carries `//` comments (jsonc), which JSON.parse rejects — strip whole-line ones.
    const parsed = JSON.parse(raw.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')) as
      { include?: string[] };
    const include = new Set(parsed.include ?? []);
    expect(include.size, 'tsconfig has no include list at all').toBeGreaterThan(0);

    const rootTs = fs.readdirSync(pkgRoot)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
      .filter((f) => fs.statSync(path.join(pkgRoot, f)).isFile());
    // A floor, so a broken readdir cannot pass this vacuously.
    expect(rootTs.length, 'no root .ts files found — is the path right?').toBeGreaterThanOrEqual(3);

    const missing = rootTs.filter((f) => !include.has(f));
    expect(
      missing,
      `these root .ts files are typechecked by NOTHING — add them to `
      + `engine/tools/modoki-mcp/tsconfig.json's "include": ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
