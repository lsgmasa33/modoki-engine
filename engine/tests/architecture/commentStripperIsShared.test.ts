/**
 * ⚠️ **No test may grow a private comment stripper — there is ONE scanner (#419).**
 *
 * The rule this enforces is in `docs/verify-and-ci.md` § "Source-scanning guards", and without
 * this file it was a rule with no enforcement in a repo whose whole thesis is enforcement. That is
 * not a hypothetical gap: **twelve** guards independently grew the same broken stripper, and when
 * the first sweep migrated them it missed sixteen more, in a repo where the defect had already
 * been found and fixed twice (#411, #418) without anyone noticing the copies.
 *
 * The banned shape is the one they all had:
 *
 *     .replace(BLOCK_LAZY, '')      then some line-comment removal
 *
 * where `BLOCK_LAZY` is a lazy `/*`…`*` + `/` regex. A `/*` sequence written inside a **line**
 * comment opens a phantom block that runs to the next real terminator, and everything between is
 * DELETED. Every guard using it is a forbidden-pattern guard, so deleting source LOWERS the
 * offender count — it fails silent and GREEN, the only direction that matters. Measured: that
 * shape hid 82 lines of `Scene3D.tsx`, including 22 imports, from the determinism guard.
 *
 * ⚠️ **This guard strips its own input with the shared scanner**, so a file that DISCUSSES the
 * broken regex in prose (several of them do — it is the scar they carry) is not an offender.
 * Which also makes it a live user of the thing it is protecting.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { REPO_ROOT } from '../helpers/repoLayout';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/**
 * The lazy block-comment regex, as it is written in source. This exact substring is the defect.
 *
 * ⚠️ **Assembled from two halves rather than written out, and that is not obfuscation.** This
 * guard strips comments but KEEPS string contents — deliberately, since a stripper hides in code,
 * not in prose. So spelling the banned shape as one literal makes this file its own first
 * offender, which is exactly what happened on its first run. Splitting it is the honest fix:
 * allowlisting itself would have put a hole in the one file that must not have one.
 */
const BLOCK_LAZY = String.raw`\/\*[\s\S]` + String.raw`*?\*\/`;

/** A `.replace(...)` whose pattern matches `//` — the other half of a hand-rolled stripper. */
const LINE_STRIP = /\.replace\(\s*\/[^/\n]*\\\/\\\/[^/\n]*\/[a-z]*\s*,/;

/**
 * Files allowed to contain the banned shape, each for a stated reason.
 *
 * ⚠️ Keep this SMALL and keep the reasons real. An entry here is a file that can silently delete
 * the code it inspects; "it was easier" is not a reason.
 */
const ALLOW = new Map<string, string>([
  [
    'engine/packages/modoki/tests/helpers/sourceScanner.test.ts',
    'defines `brokenRegexStrip` deliberately, as the thing it pins the shared scanner against — '
    + 'the one place the broken shape must exist so its failure can be asserted',
  ],
]);

/** Test roots that own source-scanning guards, git-enumerated (#771/#799) rather than a
 *  hand-rolled recursive walk. A root that is absent (the public OSS checkout has no `games/`)
 *  contributes nothing rather than failing — `repoFiles()`'s `under` list needs no existence
 *  check of its own, unlike the old walker's per-root `fs.existsSync`.
 *
 *  A test file counts only under `engine/tests/`, `engine/packages/modoki/tests/`, or a project's
 *  own DIRECT `tests/` folder (`games/<id>/tests/**`, `demos/<id>/tests/**`) — the same scope the
 *  old walker's root list enumerated, not every `.test.tsx?` anywhere under `games/`/`demos/`. */
function testFiles(): string[] {
  return repoFiles({
    under: ['engine/tests', 'engine/packages/modoki/tests', 'games', 'demos'],
    match: (rel) => {
      const isTestFile = /\.test\.tsx?$/.test(rel) || /(^|\/)sourceScanner\.ts$/.test(rel);
      if (!isTestFile) return false;
      if (rel.startsWith('engine/tests/') || rel.startsWith('engine/packages/modoki/tests/')) return true;
      return /^(games|demos)\/[^/]+\/tests\//.test(rel);
    },
    floor: 0,
  }).map(({ abs }) => abs);
}

describe('there is ONE comment scanner, and tests import it (#419)', () => {
  const files = testFiles().map((abs) => {
    const raw = fs.readFileSync(abs, 'utf8');
    return { rel: path.relative(REPO_ROOT, abs).replace(/\\/g, '/'), raw, code: stripComments(raw) };
  });

  it('scans a non-empty set of test files across engine AND project suites', () => {
    // Without this the whole guard is a cheerful no-op the day a root stops matching.
    expect(files.length, 'the walk found no test files').toBeGreaterThan(200);
    expect(files.some((f) => f.rel.startsWith('engine/tests/')), 'engine/tests not reached').toBe(true);
    expect(
      files.some((f) => f.rel.startsWith('engine/packages/modoki/tests/')),
      'the package suite not reached',
    ).toBe(true);
  });

  it('the comment strip is length- and line-exact (a regex stripper would not be)', () => {
    for (const f of files) assertScanIsSane(f.raw, f.code, f.rel);
  });

  it('no test file hand-rolls a block-comment stripper', () => {
    const offenders = files
      .filter((f) => !ALLOW.has(f.rel))
      .filter((f) => f.code.includes(BLOCK_LAZY))
      .map((f) => f.rel);
    expect(
      offenders,
      'these files strip block comments with a lazy regex, which DELETES code whenever a `/*` '
      + 'appears inside a line comment — and a forbidden-pattern guard reads the deletion as a '
      + `PASS. Import { stripComments } from '@modoki/engine/testing' instead (#419):\n`
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('no test file hand-rolls a line-comment stripper', () => {
    const offenders = files
      .filter((f) => !ALLOW.has(f.rel))
      .filter((f) => LINE_STRIP.test(f.code))
      .map((f) => f.rel);
    expect(
      offenders,
      'these files strip line comments with a private regex. Even where it does not delete, a '
      + 'second stripper is a second thing to fix — that multiplicity is what let one copy be '
      + `fixed twice while eleven carried the original bug. Use '@modoki/engine/testing' (#419):\n`
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('every allowlist entry still exists and still needs to be there', () => {
    // A stale allowlist is a hole nobody is looking at.
    for (const [rel, reason] of ALLOW) {
      const f = files.find((x) => x.rel === rel);
      expect(f, `allowlisted file ${rel} no longer exists — drop the entry`).toBeDefined();
      expect(
        f!.code.includes(BLOCK_LAZY) || LINE_STRIP.test(f!.code),
        `${rel} no longer hand-rolls a stripper — drop the allowlist entry (${reason})`,
      ).toBe(true);
    }
  });
});
