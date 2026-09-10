/** `ps -Axo` is macOS-only, and no Mac gate can see that it is (#1037 follow-up).
 *
 *  `x` is a BSD-style option. Linux `procps` parses a DASH-prefixed bundle as UNIX-style, where
 *  `x` is not an option at all, and refuses:
 *
 *      error: must set personality to get -x option
 *
 *  So `ps -Axo command=` throws on Linux and works on macOS. Two sites shipped to `main` on
 *  2026-09-10 — `engine/scripts/livePackagedEditor.mjs` and
 *  `engine/tests/architecture/cleanPackagedCacheLinkGuard.test.ts` — and reddened the free public
 *  ubuntu leg AFTER the hub's `npm run verify` had gone green, because every clone that runs that
 *  gate is a Mac. That is the whole reason this guard is STATIC: the dynamic check for it does not
 *  exist on any machine this repo develops on, so a round-trip through public CI was the only
 *  detector, and it costs a red `main` each time.
 *
 *  ⚠️ **What is forbidden is the MIX, not BSD syntax.** `ps axo command=` (no dash) is BSD-style
 *  and procps accepts it; `ps -Ao` / `ps -eo` are UNIX-style and both accept it. Only a
 *  dash-prefixed bundle containing `x` is unportable. The accept-side cases below pin that, so a
 *  future edit cannot quietly widen this into "no BSD `ps` anywhere".
 *
 *  ⚠️ **Matches `.code`, never `raw`** (#812). Both fixes above explain themselves in a comment
 *  that necessarily QUOTES `-Axo`; matching raw text would flag the fix as the defect.
 */
import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';


/** This file spells every offending form as a test fixture, in string literals that survive the
 *  comment strip. It is the scanner's own rule literals — excluded for the same reason
 *  `scan-publish-safety.mjs` skips itself. */
const SELF = 'engine/tests/architecture/psFlagPortability.test.ts';

/** A `ps` call whose dash-prefixed option bundle contains `x`.
 *
 *  Anchored on the `ps` token so an unrelated `-x` (e.g. `tar -x`) cannot match, and stopped at a
 *  shell/JS separator so a later command on the same line is not attributed to `ps`. */
const BSD_PS = /\bps\b[^\n;&|)]*?[\s,'"[]-[A-Za-z]*x/;

export function usesUnportablePsFlags(code: string): boolean {
  return BSD_PS.test(code);
}

describe('ps flag portability — a dash-bundle with `x` is macOS-only (#1037)', () => {
  it('rejects the two forms that actually shipped, and the bare -x', () => {
    // The exact strings from the two sites that reddened ubuntu on 2026-09-10.
    expect(usesUnportablePsFlags(`execFileSync('ps', ['-Axo', 'pid=,command='])`)).toBe(true);
    expect(usesUnportablePsFlags(`execFileSync('ps', ['-Axo', 'command='])`)).toBe(true);
    // Shell spellings of the same mistake.
    expect(usesUnportablePsFlags('ps -Axo command=')).toBe(true);
    expect(usesUnportablePsFlags('ps -ax')).toBe(true);
    expect(usesUnportablePsFlags('ps -x')).toBe(true);
  });

  it('ACCEPTS the portable forms — this guard must not read as "no BSD ps anywhere"', () => {
    // UNIX-style: what both fixes moved TO.
    expect(usesUnportablePsFlags(`execFileSync('ps', ['-Ao', 'pid=,comm='])`)).toBe(false);
    expect(usesUnportablePsFlags(`execFileSync('ps', ['-Ao', 'pid=,command='])`)).toBe(false);
    expect(usesUnportablePsFlags('ps -eo command=')).toBe(false);
    // Pure BSD, no dash — procps accepts this, so it is NOT the defect.
    expect(usesUnportablePsFlags('ps axo command=')).toBe(false);
    expect(usesUnportablePsFlags('ps aux')).toBe(false);
    // A `-x` that has nothing to do with `ps`.
    expect(usesUnportablePsFlags('tar -xzf bundle.tgz')).toBe(false);
    expect(usesUnportablePsFlags('ps -Ao command= ; tar -xf foo')).toBe(false);
  });

  it('no file in the tooling corpus uses an unportable `ps` bundle', () => {
    const files = repoFiles({
      under: ['engine/scripts', 'engine/tests', 'engine/tools', 'engine/plugins', 'engine/electron', 'scripts'],
      match: /\.(mjs|cjs|js|ts|tsx|sh)$/,
      exclude: ['node_modules', 'dist'],
      // Non-vacuity is asserted below against the real count; this floor only catches a corpus
      // that has collapsed entirely (a bad `under`, a git failure).
      floor: 200,
    });

    expect(files.length, 'corpus collapsed — the scan below would pass vacuously').toBeGreaterThan(200);

    // `abs` is the module's own join; `rel` must never be round-tripped through `node:path`.
    const offenders: string[] = [];
    for (const { rel, abs } of files) {
      if (rel === SELF) continue;
      const { code } = readScannedSource(abs);
      if (usesUnportablePsFlags(code)) offenders.push(rel);
    }
    expect(offenders, 'use `ps -Ao`/`ps -eo` (UNIX) or `ps axo` (BSD, no dash) — a dash-bundle '
      + 'containing `x` throws on Linux procps and the Mac gate cannot see it').toEqual([]);
  });
});
