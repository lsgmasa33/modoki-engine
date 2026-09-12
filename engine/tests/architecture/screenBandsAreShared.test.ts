/**
 * The band stack has ONE implementation, and it is the engine's (#800).
 *
 * `ScreenBand` + `solveBands` were written TWICE, independently, three days apart — wordweave #773
 * and court #791 — and the two copies were arithmetically identical: same clamps, same
 * floors-then-flex split, same first-wins-on-duplicate `byRole`, same sort. The second copy was
 * landed knowingly (#791 was scoped to Court, and widening it would have dragged another game and
 * the engine into a change aimed at one), and #800 is the ticket that came back for it.
 *
 * This guard enforces the "one implementation" half: a third COPY fails here, at authorship, on the
 * clone that wrote it — rather than being found by whoever next reads both games side by side.
 * Same shape and same reason as `abandonmentIsShared.test.ts` (#801).
 *
 * ⚠️ **Three limits, stated rather than papered over.** What it reliably catches is the COPY-PASTE,
 * which is how both existing copies actually arose — wordweave's was written first and Court's was
 * written against it three days later.
 *
 *  1. **A rename defeats it.** It matches the literal identifiers `solveBands` and
 *     `SCREEN_BAND_DEFAULTS`, so a third copy called `solveStack` is invisible.
 *  2. **Import-AND-declare passes.** A file that imports the engine's `solveBands` (under any
 *     alias) and also declares its own satisfies the delegation check. That is the shape a copy in
 *     `court/layout.ts` would be forced into, since it already imports the name.
 *  3. **A namespace import reads as no-import** (`import * as engine from …` + `engine.solveBands`)
 *     and would FAIL a legitimate delegator. Nothing in the repo does this today, and a false
 *     failure is the safe direction — it argues with an author rather than waving a copy through.
 *
 * ── What it checks, and why it is DELEGATION rather than absence ─────────────────────────────────
 *
 * A game may legitimately declare something called `solveBands`: wordweave keeps a thin wrapper that
 * decorates the engine's VERTICAL solve with the `x`/`w` of its side margins, because Court's
 * horizontal story is deliberately outside its band stack and a shared solver inventing an `x`
 * would be answering a question one of its two callers never asks. So "no game declares
 * `solveBands`" is the wrong rule — it would fail on the correct code.
 *
 * The rule that separates a wrapper from a re-implementation is: **a game file that declares
 * `solveBands` must also import the engine's.** A hand-rolled copy imports nothing and fails.
 *
 * The trait is simpler: its schema is the engine's outright, so a game that re-declares
 * `SCREEN_BAND_DEFAULTS` has grown a second trait shape, and the two would drift field by field.
 * (Both games still call `registerTrait` themselves, with their own Inspector rows and their own
 * role vocabulary — that is required, not a smell. See the trait's banner for what registering it
 * in the engine would silently break.)
 *
 * ⚠️ Gated on `hasInternalGames()`: the public OSS snapshot carries no `games/`, and a guard that
 * counts paths under it is a known publish hazard — it would either fail there or, worse, pass
 * vacuously. The population assertion below is what stops the gated case being silent.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasInternalGames } from '../helpers/repoLayout';

/** Every game/demo module a band solver could plausibly regrow in — `runtime/` plus each game's own
 *  workspace packages (`packages/<name>/src`; Court already ships one, and a guard that cannot see
 *  a directory a game HAS is a guard with a hole). Tests are excluded deliberately: a test naming
 *  `solveBands` is using it, which is the point.
 *
 *  ⚠️ Do not write that glob with a star-slash inside this comment — it terminates the block, and
 *  the file then parses as code from here down. It did exactly that in review. */
function gameRuntimeFiles(): { abs: string; rel: string }[] {
  return repoFiles({ under: ['games', 'demos'], match: /\.tsx?$/, floor: 10 })
    .filter(({ rel }) => rel.includes('/runtime/') || /\/packages\/[^/]+\/src\//.test(rel))
    .filter(({ rel }) => !rel.includes('/ios/') && !rel.includes('/android/'))
    // ⚠️ BOTH spellings of "a test". `/tests/` catches each game's own suite directory; the
    // filename check catches COLOCATED tests, which the widened population brought in — Court
    // alone ships five (`packages/app-services/src/*.test.ts`). Without it the banner's "tests are
    // excluded deliberately" was false for half the new population, and a colocated test with a
    // local `solveBands` stub would have been failed and told to import the engine's.
    .filter(({ rel }) => !rel.includes('/tests/') && !rel.includes('/node_modules/')
      && !/\.(test|spec)\.tsx?$/.test(rel));
}

const DECLARES_SOLVE = /(?:export\s+)?(?:function|const)\s+solveBands\b/;
/**
 * The engine's solver, imported under any alias — wordweave imports it as `solveVerticalBands`.
 *
 * ⚠️ Matched as an IMPORT STATEMENT, not just "the word near an engine import". The first version
 * was `/\bsolveBands\b[^;]*from\s+'@modoki\/engine/`, and `[^;]*` spans newlines — so a DOC COMMENT
 * mentioning `solveBands` sitting above any unrelated `@modoki/engine` import satisfied it, and a
 * hand-rolled solver in such a file would have passed (found in review).
 */
const IMPORTS_ENGINE_SOLVE = /import\s*\{[^}]*\bsolveBands\b[^}]*\}\s*from\s*['"]@modoki\/engine/;
const DECLARES_TRAIT_SCHEMA = /(?:export\s+)?const\s+SCREEN_BAND_DEFAULTS\s*=\s*\{/;

describe.skipIf(!hasInternalGames())('the band model is not re-implemented per game (#800)', () => {
  it('scans a real population — a vacuous pass is a failure', () => {
    // ⚠️ Without this, every assertion below passes trivially the day the filter stops matching —
    // the exact way a corpus guard dies silently (`repoFiles`' own `floor` covers the enumeration,
    // not this filter).
    const files = gameRuntimeFiles();
    expect(files.length, 'no game runtime files matched — the filter is broken').toBeGreaterThan(10);
    const names = files.map((f) => f.rel);
    expect(names, 'court/runtime/layout.ts is the file this guard exists for')
      .toContain('games/court/runtime/layout.ts');
    expect(names, 'wordweave/runtime/screen.ts is the other one')
      .toContain('games/wordweave/runtime/screen.ts');
  });

  it('any game declaring solveBands DELEGATES to the engine rather than re-deriving it', () => {
    const offenders: string[] = [];
    for (const { abs, rel } of gameRuntimeFiles()) {
      const src = readFileSync(abs, 'utf8');
      if (!DECLARES_SOLVE.test(src)) continue;
      if (!IMPORTS_ENGINE_SOLVE.test(src)) offenders.push(rel);
    }
    expect(offenders, 'these declare their own solveBands without importing the engine\'s — the '
      + 'band arithmetic has regrown. Import `solveBands` from `@modoki/engine/runtime` and keep '
      + 'only what is genuinely per-game (the role vocabulary, the fallback, any horizontal '
      + 'decoration).').toEqual([]);
  });

  it('no game re-declares the ScreenBand trait schema', () => {
    const offenders = gameRuntimeFiles()
      .filter(({ abs }) => DECLARES_TRAIT_SCHEMA.test(readFileSync(abs, 'utf8')))
      .map(({ rel }) => rel);
    expect(offenders, 'these declare their own SCREEN_BAND_DEFAULTS — the trait schema is the '
      + 'engine\'s, and a second copy drifts field by field. Re-export the engine\'s instead; '
      + 'registering it per-game with your own Inspector rows is still correct.').toEqual([]);
  });
});
