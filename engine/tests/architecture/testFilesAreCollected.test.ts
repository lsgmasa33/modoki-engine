import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import viteConfig from '../../vite.config';

/**
 * A test file that no `test.include` glob matches NEVER RUNS, and says nothing when it
 * doesn't — the same unreachable-mechanism shape this repo keeps paying for (a tool that
 * 400s on every call, an authored prefab field nobody reads, a reap pattern that matches
 * no process). `engine/vite.config.ts` lists includes DIRECTORY BY DIRECTORY, so a new
 * `tests/<something>/` is invisible until someone remembers to add it, and the failure
 * mode is a green suite. Caught while adding `tests/app/` for #267.
 *
 * This is deliberately about COLLECTION, not correctness: it proves vitest would pick each
 * file up, nothing about what the file asserts.
 */

const engineDir = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(engineDir, '..');

/** The globs are relative to vitest's root, which is `engine/`. */
function toVitestRelative(repoRelPath: string): string {
  return path.relative(engineDir, path.join(repoRoot, repoRelPath)).split(path.sep).join('/');
}

function includeGlobs(): string[] {
  // The game/demo globs live behind a `MODOKI_COVERAGE_ENGINE_ONLY` spread (they are dropped
  // from `npm run coverage`). This guard is about the ORDINARY run, and it must answer the
  // same way whichever run collects it — resolve with that flag neutralised, or a coverage
  // run would report every game test as orphaned.
  const coverageFlag = process.env.MODOKI_COVERAGE_ENGINE_ONLY;
  delete process.env.MODOKI_COVERAGE_ENGINE_ONLY;
  const resolved = typeof viteConfig === 'function'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (viteConfig as any)({ command: 'serve', mode: 'test' })
    : viteConfig;
  if (coverageFlag !== undefined) process.env.MODOKI_COVERAGE_ENGINE_ONLY = coverageFlag;
  const include = resolved?.test?.include;
  // Guard the guard: a config shape change must fail loudly here rather than silently
  // produce an empty glob list, which would make every assertion below vacuous.
  expect(Array.isArray(include), 'vite.config.ts no longer exposes test.include as an array').toBe(true);
  expect(include.length).toBeGreaterThan(5);
  return include as string[];
}

describe('every test file on disk is collected by vitest', () => {
  it('no test file is orphaned by the include list', () => {
    // `--others --exclude-standard` as well as the tracked set: a test file is at its most
    // orphanable BEFORE it is committed, which is exactly when the author would want to hear
    // about it. (Written with tracked-only first — and it passed happily with the include
    // glob for the brand-new, still-untracked `tests/app/` deleted.)
    // `execFileSync`, NOT a shell string — the repo's established shape for this
    // (privateBuildFields, noNulBytesInSource, metaSidecarChurn, cliToolchainRecipes all do
    // it this way). `execSync` spawns cmd.exe on Windows, which does NOT strip single quotes,
    // so quoted globs reach git literally and it matches nothing: measured here, the quoted
    // form returns 0 paths where the expanded form returns 1093. That would have failed the
    // `win` clone and the Windows CI leg on the sanity assert below, for a reason having
    // nothing to do with orphaned tests.
    const tracked = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '*.test.ts', '*.test.tsx'],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean);

    const candidates = tracked.filter((f) => (
      // The engine PACKAGE is its own vitest project with its own config.
      !f.startsWith('engine/packages/modoki/tests/')
      // Playwright specs, driven by playwright.config.ts — not vitest.
      && !f.startsWith('engine/tests/e2e/')
      // NOTE: game/demo `packages/**` tests are deliberately NOT excluded — they are globbed
      // (`../games/*/packages/*/**/*.test.ts`) and so are exactly what this should check. Only
      // `.test.ts` is, though: a `.test.tsx` there is orphaned, and this is what would say so.
    ));

    expect(candidates.length).toBeGreaterThan(100); // sanity: the query still finds the suite

    const isMatch = picomatch(includeGlobs());
    const orphans = candidates.filter((f) => !isMatch(toVitestRelative(f)));

    expect(orphans, `these test files match no test.include glob in engine/vite.config.ts, so they never run:\n  ${orphans.join('\n  ')}`)
      .toEqual([]);
  });

  it('every include glob points at a directory that exists', () => {
    // The reverse failure: a glob left behind by a rename matches nothing and quietly
    // narrows the suite. Only checks the static prefix — game/demo globs legitimately
    // match nothing in a checkout without that project root, so those are skipped.
    const stale = includeGlobs().filter((g) => {
      if (g.startsWith('../games/') || g.startsWith('../demos/')) return false;
      const staticPrefix = g.split('*')[0].replace(/\/[^/]*$/, '');
      return staticPrefix.length > 0 && !existsSync(path.join(engineDir, staticPrefix));
    });
    expect(stale, `include globs whose directory does not exist: ${stale.join(', ')}`).toEqual([]);
  });
});
