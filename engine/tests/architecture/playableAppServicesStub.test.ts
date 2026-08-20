import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hasInternalGames } from '../helpers/repoLayout';

/**
 * A `--target playable` build ALIASES every `@<game>/app-services` import to
 * `engine/plugins/playable-appservices-stub.ts` (see `engine/vite.config.ts`), so an ad creative
 * ships none of the native SDK weight. The stub therefore has to export every name a game's
 * runtime imports from that package — and when it does not, Rollup fails the build outright:
 *
 *   [MISSING_EXPORT] "track" is not exported by "engine/plugins/playable-appservices-stub.ts"
 *
 * ⚠️ IT FAILS ONLY ON `--target playable`, WHICH NOTHING ROUTINELY RUNS. `npm run verify` cannot
 * see it, the web and native builds are fine, and the whole test suite is green. That is exactly
 * how it broke: `track`/`setTrackProperty` were added to `games/court/runtime/systems.ts` and
 * nothing told the stub. This guard derives the required set from the games rather than from a
 * hand-kept list, so the next export cannot slip through the same gap.
 *
 * It is a CHEAP proxy for the real thing (running the playable build), which costs minutes — so
 * it checks the one failure mode that has actually happened, not that a playable build succeeds.
 */

const repoRoot = path.resolve(__dirname, '../../..');
const STUB = path.join(repoRoot, 'engine/plugins/playable-appservices-stub.ts');

/** Names the stub actually exports. */
function stubExports(): Set<string> {
  const src = readFileSync(STUB, 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  return names;
}

/**
 * Names the games ask for, in the two shapes that actually appear:
 *   `import { track } from '@court/app-services'`            — static named import
 *   `import('@court/app-services').then((m) => m.register())` — dynamic member access
 * The second is how `game.ts` wires `registerAppServices`, and it is NOT caught by Rollup at
 * build time — it fails at RUNTIME in the ad, which is worse. Both are covered.
 */
function requiredNames(): Map<string, string[]> {
  // ⚠️ Listed broadly and filtered HERE, not with a `**` pathspec. git's wildmatch made
  // `games/*/runtime/**/*.ts` require an intermediate directory, so it silently skipped
  // `games/court/runtime/systems.ts` — the very file that broke the build. The first draft of
  // this guard passed happily with the stub's `track` export renamed away.
  const files = execFileSync('git', ['ls-files', 'games', 'demos'], { cwd: repoRoot, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
    .filter((f) => /\.tsx?$/.test(f))
    // The app-services package DEFINES these names; it is not a consumer of the stub.
    .filter((f) => !f.includes('/packages/'))
    .filter((f) => !f.includes('/tests/'));

  const out = new Map<string, string[]>();
  const add = (name: string, where: string) => {
    const list = out.get(name) ?? [];
    if (!list.includes(where)) list.push(where);
    out.set(name, list);
  };

  for (const rel of files) {
    const src = readFileSync(path.join(repoRoot, rel), 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@[^/']+\/app-services'/g)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (name) add(name, rel);
      }
    }
    for (const m of src.matchAll(/import\(\s*'@[^/']+\/app-services'\s*\)[\s\S]{0,120}?\bm\.([A-Za-z_$][\w$]*)/g)) {
      add(m[1], rel);
    }
  }
  return out;
}

/** ⚠️ Gated on `hasInternalGames()`, and the gate is load-bearing rather than defensive.
 *  This guard DERIVES its required set by scanning `games/**` — which is exactly why it is
 *  a good guard here and why it cannot run in the public snapshot, where `games/` is not
 *  shipped at all. There the scan matches nothing, the "guard the guard" assertion below
 *  fires, and a test that is merely inapplicable reads as a real failure on the public gate.
 *  `hasInternalGames()` (not `hasAnyProject()`) is the correct predicate: the snapshot does
 *  ship demos, and no demo has an app-services package for this to find. */
describe.skipIf(!hasInternalGames())('the playable app-services stub keeps up with the games (#269)', () => {
  it('exports every name a game imports from its app-services package', () => {
    const required = requiredNames();
    // Guard the guard: if the scan finds nothing, every assertion below is vacuous. At least
    // `register` is always imported — `game.ts` cannot wire `registerAppServices` without it.
    expect(required.size, 'the import scan matched nothing — the queries have gone stale').toBeGreaterThan(0);
    expect([...required.keys()]).toContain('register');

    const exported = stubExports();
    const missing = [...required.entries()].filter(([name]) => !exported.has(name));
    expect(
      missing.map(([name, where]) => `${name} (imported by ${where.join(', ')})`),
      'these names would fail a --target playable build with [MISSING_EXPORT]',
    ).toEqual([]);
  });
});
