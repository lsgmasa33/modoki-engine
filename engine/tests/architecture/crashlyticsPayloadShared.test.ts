/**
 * Every `recordException(` call in a game, demo or template sends the engine's
 * `crashlyticsExceptionOptions(...)`, never a hand-built payload (#1063).
 *
 * A bare `{ message }` gives the plugin no grouping inputs: iOS falls back to domain `""` and code
 * `-1001`, and Android to the plugin's own Java stack. So every JS report from that game most likely
 * lands in ONE Crashlytics console issue, and a new kind of failure raises no alert. Three wrappers
 * carried that shape (court, wordweave, 3d-test) and each game grows its own wrapper, so the next one
 * is the likeliest regression. This fails it at authorship.
 *
 * ── Blind spots, stated rather than discovered later ────────────────────────────────────────────
 *   - an options object built elsewhere and passed by name (`recordException(opts)`) is refused,
 *     even if `opts` came from the helper. Inline the call;
 *   - a wrapper that calls the helper with the wrong platform string is not caught. The per-game
 *     `services.test.ts` payload assertions cover that;
 *   - a call outside the scanned roots.
 *
 * Comments are stripped by the shared reader, because the wrappers' own prose names the bad shape.
 */

import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasInternalGames } from '../helpers/repoLayout';

const SCAN_ROOTS = ['games', 'demos', 'engine/templates'];

/** A CALL (the paren is required) whose first argument is not the shared helper.
 *  ⚠️ The whitespace after `(` lives INSIDE the lookahead: outside it, `\s*` backtracks to zero
 *  characters and `( crashlyticsExceptionOptions(` reads as hand-built. */
const HAND_BUILT = /\brecordException\s*\((?!\s*crashlyticsExceptionOptions\s*\()/;
const ANY_CALL = /\brecordException\s*\(/;

function scanned(): Array<{ rel: string; code: string }> {
  return repoFiles({
    under: SCAN_ROOTS,
    match: (rel) => /\.tsx?$/.test(rel) && !rel.includes('.test.'),
    exclude: ['node_modules', 'dist'],
    floor: 0, // non-vacuity is asserted below, against the calls themselves
  }).map(({ rel, abs }) => ({ rel, code: readScannedSource(abs).code }));
}

describe('Crashlytics payload is built by the engine helper (#1063)', () => {
  const files = scanned();

  // The three wrappers live under `games/`, which the public engine snapshot does not ship: there the
  // scan legitimately finds no caller, so this non-vacuity check skips rather than failing the public
  // gate. `!hasInternalGames`, not `!hasAnyProject` — the snapshot ships demos, and demos carry none.
  it.skipIf(!hasInternalGames())('scans the wrappers it exists for — the population is not empty', () => {
    const callers = files.filter((f) => ANY_CALL.test(f.code)).map((f) => f.rel);
    expect(callers).toEqual(expect.arrayContaining([
      'games/3d-test/packages/app-services/src/crashlytics.ts',
      'games/court/packages/app-services/src/crashlytics.ts',
      'games/wordweave/packages/app-services/src/crashlytics.ts',
    ]));
  });

  it('no recordException call hand-builds its payload', () => {
    const offenders = files.filter((f) => HAND_BUILT.test(f.code)).map((f) => f.rel).sort();
    expect(offenders, 'send crashlyticsExceptionOptions(message, Capacitor.getPlatform())').toEqual([]);
  });

  it('the pattern refuses the old shape and accepts the helper (both sides of the guard)', () => {
    expect(HAND_BUILT.test('await FirebaseCrashlytics.recordException({ message });')).toBe(true);
    expect(HAND_BUILT.test('FirebaseCrashlytics.recordException(opts)')).toBe(true);
    expect(HAND_BUILT.test('FirebaseCrashlytics.recordException(crashlyticsExceptionOptions(m, p))')).toBe(false);
    expect(HAND_BUILT.test('FirebaseCrashlytics.recordException\n  ( crashlyticsExceptionOptions(m, p))')).toBe(false);
    expect(ANY_CALL.test('recordException is named here without a call')).toBe(false);
  });
});
