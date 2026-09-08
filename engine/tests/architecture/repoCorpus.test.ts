/** Unit test for `engine/scripts/repoCorpus.mjs` — the shared corpus enumerator introduced for
 *  #799/#771/#805 (docs/windows.md § Paths, instances 7/8). Covers the two hazards the module's
 *  own doc-block names: an `execSync`-vs-`execFileSync` regression (which would break silently on
 *  Windows only — the local Mac/Linux gate can't see it) and a `rel` that has been round-tripped
 *  through `node:path` (the exact mistake this module exists to prevent). */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoRoot, repoFiles } from '../../scripts/repoCorpus.mjs';

describe('repoCorpus', () => {
  describe('repoRoot()', () => {
    it('returns a POSIX path with no backslash', () => {
      const root = repoRoot();
      expect(root).not.toMatch(/\\/);
    });

    it('is an ancestor of this test file', () => {
      const root = repoRoot();
      // __dirname here is a node:path-produced, OS-native absolute path; normalise ONLY the
      // comparison side (never repoRoot()'s own output — that is the point of the module).
      const hereNormalised = __dirname.split(/[\\/]/).join('/');
      expect(hereNormalised.toLowerCase().startsWith(root.toLowerCase())).toBe(true);
    });

    it('is cached — repeated calls return the identical string', () => {
      expect(repoRoot()).toBe(repoRoot());
    });
  });

  describe('repoFiles()', () => {
    it('the enumeration found the repo — a vacuous pass is a failure', () => {
      // Floor sits far under the real count (thousands of tracked files) so only a broken
      // enumeration trips it, never ordinary churn.
      expect(repoFiles({ floor: 1 }).length).toBeGreaterThan(500);
    });

    it('every rel contains no backslash and no quote — the quoting/escaping hazards named in the module doc-block', () => {
      const files = repoFiles({ floor: 500 });
      for (const { rel } of files) {
        expect(rel, `rel "${rel}" contains a backslash`).not.toMatch(/\\/);
        expect(rel, `rel "${rel}" contains a double-quote (git C-quoting escaped, or -z was dropped)`).not.toMatch(/"/);
      }
    });

    it('`under` filters to the given prefix, case-insensitively', () => {
      const lower = repoFiles({ under: 'engine/scripts', floor: 1 });
      const upper = repoFiles({ under: 'ENGINE/SCRIPTS', floor: 1 });
      expect(lower.length).toBe(upper.length);
      expect(lower.length).toBeGreaterThan(0);
      for (const { rel } of lower) {
        expect(rel.toLowerCase().startsWith('engine/scripts/')).toBe(true);
      }
      // This very file's own package must be in there.
      expect(lower.some((f) => f.rel.toLowerCase().endsWith('repocorpus.mjs'))).toBe(true);
    });

    it('`under` does not match a same-prefixed sibling directory (segment-wise, not string-wise)', () => {
      // "engine/scripts" must not accidentally match "engine/scripts-extra/..." if such a thing
      // existed — assert the boundary logic directly via a synthetic match instead, since no such
      // sibling exists in this repo: a file under engine/scriptsSomethingElse would false-positive
      // under a naive `startsWith('engine/scripts')` (no slash) but not under this implementation.
      const files = repoFiles({ under: 'engine/scripts', floor: 1 });
      for (const { rel } of files) {
        expect(rel === 'engine/scripts' || rel.startsWith('engine/scripts/')).toBe(true);
      }
    });

    it('`under` accepts an ABSOLUTE path, so callers never round-trip through path.relative', () => {
      // The reason this exists: before it, all 8 call sites holding an absolute project dir wrote
      // `under: path.relative(ROOT, dir).split(path.sep).join('/')`. Each was correct only because
      // it remembered the normalisation; dropping it breaks matching on Windows ONLY, silently —
      // instances 1-8 of docs/windows.md § Paths. Neither rule in corpusProducerIsShared can see
      // that shape, so absorbing it into the API is what makes it unreachable.
      const relForm = repoFiles({ under: 'engine/scripts', match: /\.mjs$/, floor: 1 });

      // The OS-native absolute form — on Windows this carries backslashes, which is the whole point.
      const absNative = path.join(repoRoot(), 'engine', 'scripts');
      expect(repoFiles({ under: absNative, match: /\.mjs$/, floor: 1 }).map((f) => f.rel))
        .toEqual(relForm.map((f) => f.rel));

      // And the POSIX absolute form, which is what repoRoot() itself hands back.
      expect(repoFiles({ under: `${repoRoot()}/engine/scripts`, match: /\.mjs$/, floor: 1 }).map((f) => f.rel))
        .toEqual(relForm.map((f) => f.rel));

      // `under: repoRoot()` normalises to the empty prefix. A naive prefix test would compare
      // against '/' and match NOTHING — a filter that silently empties the corpus.
      expect(repoFiles({ under: repoRoot(), floor: 500 }).length)
        .toBe(repoFiles({ floor: 500 }).length);

      // An absolute path OUTSIDE the work tree is a caller error, not an empty result: returning
      // [] would be indistinguishable from "nothing matched" and would fail open.
      expect(() => repoFiles({ under: path.join(repoRoot(), '..', 'not-this-repo'), floor: 0 }))
        .toThrow(/absolute path outside the repo/);

      // A trailing slash and a leading './' must normalise away. Untreated, `'engine/scripts/'`
      // builds the prefix test `rel.startsWith('engine/scripts//')`, which matches NOTHING and
      // returns [] with no error — a silently empty corpus arriving through the front door of the
      // module written to prevent them.
      for (const spelling of ['engine/scripts/', './engine/scripts', './engine/scripts/']) {
        expect(
          repoFiles({ under: spelling, match: /\.mjs$/, floor: 1 }).map((f) => f.rel),
          `under: ${JSON.stringify(spelling)} must match the plain spelling`,
        ).toEqual(relForm.map((f) => f.rel));
      }
    });

    it('`match` accepts a RegExp', () => {
      const files = repoFiles({ under: 'engine/scripts', match: /\.mjs$/, floor: 1 });
      for (const { rel } of files) expect(rel.endsWith('.mjs')).toBe(true);
    });

    it('`match` accepts a predicate function', () => {
      const files = repoFiles({ under: 'engine/scripts', match: (rel) => rel.endsWith('.mjs'), floor: 1 });
      for (const { rel } of files) expect(rel.endsWith('.mjs')).toBe(true);
    });

    it('a `g`-flagged RegExp is not stateful — it would otherwise drop every other file', () => {
      // `.test()` on a /g/ regex advances lastIndex, so as a filter predicate it alternates
      // true/false. Without the normalisation in `repoFiles`, this returns ~half of `plain`.
      const plain = repoFiles({ under: 'engine/scripts', match: /\.mjs$/, floor: 1 });
      const global = repoFiles({ under: 'engine/scripts', match: /\.mjs$/g, floor: 1 });
      const sticky = repoFiles({ under: 'engine/scripts', match: /\.mjs$/y, floor: 1 });
      expect(global.map((f) => f.rel)).toEqual(plain.map((f) => f.rel));
      expect(sticky.length).toBe(plain.length);
    });

    it('never returns a DIRECTORY — a nested git checkout is reported by --others as one entry', async () => {
      // `git ls-files --others` will not descend another repo's work tree, so it emits the
      // directory itself (trailing slash). `existsSync` passes that happily and the consumer then
      // gets EISDIR from readFileSync. `.claude/worktrees/<id>/` is exactly this shape, so it
      // appears whenever a subagent with `isolation: 'worktree'` is running.
      //
      // The probe CREATES that state rather than asserting over whatever happens to be on disk —
      // with no worktree active the check would pass vacuously and prove nothing.
      const probe = path.join(repoRoot(), '.claude', 'repoCorpus-probe-wt');
      fs.rmSync(probe, { recursive: true, force: true });
      fs.mkdirSync(probe, { recursive: true });
      try {
        execFileSync('git', ['init', '-q', '.'], { cwd: probe });
        fs.writeFileSync(path.join(probe, 'CLAUDE.md'), 'probe\n');

        // Positive control: git really does surface this nested checkout as a bare directory.
        const raw = execFileSync(
          'git',
          ['ls-files', '--others', '--exclude-standard', '-z'],
          { cwd: repoRoot(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        ).split('\0').filter(Boolean);
        expect(
          raw.some((r) => r.includes('repoCorpus-probe-wt')),
          'positive control failed: git did not report the nested checkout at all, so the '
          + 'assertion below cannot distinguish "filtered correctly" from "never present"',
        ).toBe(true);

        // ⚠️ `repoFiles` memoises its raw enumeration per module instance, and earlier tests in
        // this file have already populated it — from before the probe existed. Asserting on the
        // cached list would therefore pass without ever having seen the directory entry, which is
        // the vacuous-probe failure this very module exists to prevent. Reset and re-import to get
        // an instance that enumerates the tree as it is NOW.
        vi.resetModules();
        const fresh = await import('../../scripts/repoCorpus.mjs');
        const files = fresh.repoFiles({ floor: 1 });
        expect(
          files.some((f) => f.rel.includes('repoCorpus-probe-wt')),
          'the fresh enumeration did not include the probe path in any form — the filter cannot '
          + 'be credited for dropping something that was never enumerated',
        ).toBe(false);
        for (const { rel, abs } of files) {
          expect(rel.endsWith('/'), `rel "${rel}" is a directory entry`).toBe(false);
          expect(fs.statSync(abs).isFile(), `abs for "${rel}" is not a regular file`).toBe(true);
        }
      } finally {
        fs.rmSync(probe, { recursive: true, force: true });
      }
    });

    it('`includeUntracked` distinguishes a just-written file, and the per-mode cache does not cross-contaminate (Step 0, #799/#771/#805)', async () => {
      // The raw enumeration is memoised per module — now keyed by `includeUntracked` rather than
      // a single shared slot, because two possible git invocations sharing one cache slot means
      // whichever mode runs first silently wins for every later caller regardless of what it
      // asked for. That is exactly this family's failure shape (a wrong answer, no error), so this
      // creates a real untracked file and calls both modes in BOTH orders, each in its own fresh
      // module instance (`vi.resetModules()`), so neither call can be served by the OTHER call's
      // cache slot — the pre-fix single-cache shape.
      const root = repoRoot();
      // ⚠️ At the repo ROOT with an extension nothing scans — NOT under `engine/scripts/`, where
      // this probe used to live. It exists for ~0.8s while `fileParallelism` has other test files
      // running, and `buildWebCallSites.test.ts` enumerates `engine/**` at MODULE scope then
      // `readFileSync`s each hit with no try/catch. A module init landing inside the probe window,
      // with the read after the `finally` deletes it, is an ENOENT failure in an unrelated file —
      // a flake seam this test creates for its neighbours. `.tmp` is matched by no guard's
      // extension filter (docCitations' TEXT_EXT is md|ts|tsx|mjs|cjs|js|sh|yml|yaml), and the
      // root is outside every `under` root in the repo.
      const probeRel = 'repoCorpus-untracked-probe.tmp';
      const probeAbs = path.join(root, probeRel);
      fs.rmSync(probeAbs, { force: true });
      try {
        fs.writeFileSync(probeAbs, '// untracked probe, never committed\n');

        // Order 1: true first, then false.
        vi.resetModules();
        const fresh1 = await import('../../scripts/repoCorpus.mjs');
        const withUntracked1 = fresh1.repoFiles({ floor: 1, includeUntracked: true });
        expect(withUntracked1.some((f) => f.rel === probeRel)).toBe(true);
        const trackedOnly1 = fresh1.repoFiles({ floor: 1, includeUntracked: false });
        expect(trackedOnly1.some((f) => f.rel === probeRel)).toBe(false);

        // Order 2: false first, then true — the other call order, in ANOTHER fresh instance, so a
        // cache keyed wrong in either direction is caught regardless of which mode a caller
        // happens to ask for first.
        vi.resetModules();
        const fresh2 = await import('../../scripts/repoCorpus.mjs');
        const trackedOnly2 = fresh2.repoFiles({ floor: 1, includeUntracked: false });
        expect(trackedOnly2.some((f) => f.rel === probeRel)).toBe(false);
        const withUntracked2 = fresh2.repoFiles({ floor: 1, includeUntracked: true });
        expect(withUntracked2.some((f) => f.rel === probeRel)).toBe(true);
      } finally {
        fs.rmSync(probeAbs, { force: true });
      }
    });

    it('`floor` is REQUIRED — omitting it throws rather than defaulting to no floor', () => {
      // The floor is the whole anti-vacuity mechanism; a caller that forgets it must not get a
      // silently unfloored corpus, which is the fail-open shape this module exists to close.
      // @ts-expect-error deliberately omitting the required option
      expect(() => repoFiles({ under: 'engine/scripts' })).toThrow(/`floor` is required/);
      // @ts-expect-error deliberately passing no options at all
      expect(() => repoFiles()).toThrow(/`floor` is required/);
    });

    it('`floor` throws when unmet, and the message names the actual count', () => {
      expect(() => repoFiles({ under: 'engine/scripts', match: /\.mjs$/, floor: 100_000 }))
        .toThrow(/matched \d+ file\(s\), below the required floor of 100000/);
    });

    it('a non-vacuity floor on the test\'s own corpus (style: docCitations.test.ts)', () => {
      // This repo always has far more than a handful of .mjs files under engine/scripts — a
      // floor this low only trips if the enumeration itself broke.
      expect(repoFiles({ under: 'engine/scripts', match: /\.mjs$/, floor: 10 }).length).toBeGreaterThan(10);
    });

    it('`rel` is git\'s own output, not recomputed via path.relative — the round-trip this module exists to prevent', () => {
      // On POSIX, `path.relative(root, abs)` would happen to equal `rel` too, so this can't
      // distinguish "git's string" from "recomputed" by inequality alone. What it CAN assert,
      // platform-independently, is the shape that only holds if `rel` was never handed to
      // node:path: it is already forward-slash-only (a `path.relative` result on Windows would
      // contain backslashes here), and `abs` is exactly `rel` appended onto `repoRoot()` with a
      // single joining separator — i.e. `abs`'s tail (from the length of `repoRoot()` onward,
      // POSIX-normalised) equals `rel` itself. A future regression that swaps in
      // `path.relative(root, abs)` for `rel` would reintroduce backslashes on Windows and trip
      // the assertion above; a regression that recomputes `rel` from a re-walked `abs` in some
      // OTHER way is exactly the class of bug `repoFiles`'s single production point (git's `-z`
      // output) is designed to make impossible to reintroduce without touching this file's one
      // producer.
      const root = repoRoot();
      const files = repoFiles({ under: 'engine/scripts', match: /\.mjs$/, floor: 1 });
      for (const { rel, abs } of files) {
        expect(rel).not.toMatch(/\\/);
        const absPosix = abs.split(/[\\/]/).join('/');
        expect(absPosix).toBe(`${root}/${rel}`);
      }
    });
  });
});
