/** `.gitignore` and `engine/eslint.config.js`'s `ignores` must AGREE about what is not source.
 *
 *  Two hand-maintained lists decide which files a tree-walker may skip, and they are not the same
 *  list: `ignores` legitimately carries TRACKED trees that must not be linted (`engine/templates/`,
 *  `android/`, `ios/`, `Pods/`). But every gitignored build artifact in it is a manual mirror, and
 *  the mirror has drifted four times, each time turning `npm run verify` red for a reason that had
 *  nothing to do with anyone's change:
 *
 *    - `ads/` — a COMPLETED playable build inlines everything into one HTML and leaves no JS, so
 *      lint stays green; an ABORTED one strands a minified `ads/assets/index-*.js`. Measured:
 *      **33,482 errors** from one interrupted build, pointing at files the developer never wrote.
 *    - `subgame-dist/` — **1,657 errors**, almost all from vendored basis/ktx transcoder blobs,
 *      after running the DOCUMENTED sub-game build.
 *    - `.claude/worktrees/` — **36 errors** from a stale agent worktree, in code that is not even
 *      on the current branch.
 *    - `engine/vite.config*.cjs` — #879, and the one that is not merely noisy (below).
 *
 *  The `ignores` list carries that lesson in prose twice ("this list has to agree with .gitignore
 *  or the gate breaks for a reason nobody wrote down"), written by two different authors after two
 *  different red gates, and it drifted again anyway. The tracker issue for the seam itself is #885;
 *  this file is the guard for today's tree.
 *
 *  ## The transient half is worse than noisy — it is FATAL, from the other lane (#879)
 *
 *  `verify` runs two lanes over ONE working tree (`engine/scripts/verify.mjs`). Two producers write
 *  a CJS Vite config into `engine/` and remove it again:
 *
 *    - `engine/scripts/stage-vite-config.cjs` emits `engine/vite.config.cjs` at electron-builder's
 *      `beforePack`; `clean-vite-config.cjs` removes it at `afterPack`. Its own comment records
 *      that a pack which FAILS or is interrupted in between strands it in the source tree.
 *    - `engine/tests/plugins/packagedViteConfig.test.ts` writes the same bundle as
 *      `vite.config.__packagedtest-<pid>.cjs` and removes it in a `finally`. It must load from
 *      inside `engine/` — the bundle collapses the plugin graph into one file whose modules locate
 *      themselves via `__dirname` — so it cannot simply move to a temp dir.
 *
 *  `.cjs` is a linted extension, so a STRANDED artifact gets linted, and one that is MID-FLIGHT is
 *  stat'd by the other lane's `eslint` and then read after the `finally` removed it:
 *  `ENOENT … readAndVerifyFile`, which ESLint treats as **fatal, not skippable**. The gate reports
 *  `[FAIL]` for a lane with zero failing tests — indistinguishable at a glance from a real failure.
 *
 *  ⚠️ **ESLint is the reader that DIES, not the only reader.** Two app-lane guards also enumerate
 *  by extension and then read: `buildWebCallSites.test.ts` (`.ts|.mjs|.sh` under `engine/**`, at
 *  MODULE scope, through `readScannedSource`, which does not catch) would throw during COLLECTION,
 *  and `noNulBytesInSource.test.ts` (which includes `.cjs`) survives only because its read sits in
 *  a `try/catch`. So a fix that satisfies ESLint alone is not a fix — see `docs/verify-and-ci.md`.
 *
 *  ## Why it asks the resolvers, and derives the names from the producers
 *
 *  ⚠️ **It asks the REAL resolvers, never the config text.** `ESLint#isPathIgnored` and
 *  `git check-ignore` are the two things that actually decide, so an entry that is present in the
 *  file but does not match — a wrong base path, a glob missing its leading recursive segment —
 *  fails here where a grep of the `ignores` array would happily vouch for it.
 *
 *  ⚠️ **The transient filenames are re-derived from the producers' own source.** Renaming or
 *  RELOCATING the probe while leaving the globs alone would silently reopen #879, and a guard
 *  holding its own copy of the name cannot see that. Both extractions take the whole
 *  `path.join(<dir>, …)` expression — not just the filename — because `*` does not cross `/` in
 *  either resolver, so a probe moved to `engine/scratch/` stops matching while its basename still
 *  does. Both read through `readScannedSource`, so a COMMENTED-OUT producer cannot satisfy them
 *  (#812): the first version of this guard used raw `fs.readFileSync`, and commenting out the
 *  `writeFileSync(probe, …)` line left the filename in dead code where the regex still found it.
 *
 *  ⚠️ **What it CANNOT see.** It covers the producers that exist, not the class. A new test writing
 *  some other linted extension into a linted directory reintroduces the same race with this guard
 *  green — that rule lives in `docs/verify-and-ci.md`, not in an assertion. */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ESLint } from 'eslint';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ESLINT_CONFIG = path.join(REPO_ROOT, 'engine/eslint.config.js');

/** One ESLint instance for the file — construction parses the flat config (the expensive half) and
 *  `isPathIgnored` is a pure query. `cwd` is set explicitly: flat-config `ignores` resolve against
 *  the CWD, not the config file's directory, and `npm run lint` runs from the repo root. Passing it
 *  is what makes a repo-root-relative entry like `engine/vite.config*.cjs` testable at all. */
const eslint = new ESLint({ cwd: REPO_ROOT, overrideConfigFile: ESLINT_CONFIG });

/** `true` if git ignores `rel` **because of the tracked `.gitignore`**.
 *
 *  ⚠️ The source check is the point, not decoration. `check-ignore` answers from any source —
 *  `.git/info/exclude`, `core.excludesFile`, a nested `.gitignore` — so on a machine whose global
 *  excludes carry `*.cjs`, deleting the repo's own rule would leave this green here and the hole
 *  open in every other clone. `-v` names the source; `-q` cannot.
 *
 *  A status other than 0/1 (128 — bad path, not a repo) or `null` (spawn failed) is a broken
 *  instrument and throws, rather than reading as a clean "not ignored". */
function ignoredByRepoGitignore(rel: string): boolean {
  const r = spawnSync('git', ['check-ignore', '-v', '--no-index', rel], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`git check-ignore failed for ${rel}: status=${r.status} ${r.stderr ?? ''}`);
  }
  if (r.status === 1) return false;
  const source = (r.stdout ?? '').split(':')[0];
  if (source !== '.gitignore') {
    throw new Error(
      `${rel} is ignored by ${source}, not the repo's tracked .gitignore. That rule does not exist `
      + 'in another clone, so this guard would be green here and the hole open everywhere else.');
  }
  return true;
}

/** `true` if `rel` is in git's index — asked through the shared corpus producer, which is the one
 *  sanctioned enumerator (`corpusProducerIsShared.test.ts` forbids spawning the enumeration
 *  directly, and caught this helper's first version doing exactly that). `includeUntracked: false`
 *  is what makes the answer mean TRACKED rather than merely present.
 *
 *  ⚠️ **It asserts trackedness; it cannot REFUTE it.** `floor: 1` is required, so an untracked
 *  path THROWS rather than returning `false` — which is the behaviour worth having (a broken
 *  enumeration cannot read as a clean negative), but it means this is only usable as
 *  `expect(isTracked(x)).toBe(true)`. Verified both ways against the real corpus:
 *  `engine/vite.config.ts` → `true`, `engine/vite.config.cjs` → throws. */
function isTracked(rel: string): boolean {
  return repoFiles({
    match: new RegExp(`^${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    includeUntracked: false,
    floor: 1,
  }).some((f: { rel: string }) => f.rel === rel);
}

/** The repo-relative path a producer actually writes, read out of its source rather than restated
 *  here. `dirExpr` is the directory variable expected in the `path.join`, and `dirRel` is what that
 *  variable resolves to — asserted below rather than assumed, so a RELOCATED probe fails. */
function extractWritePath(
  producerRel: string, pattern: RegExp, hint: string,
): { dirVar: string; basename: string } {
  const { code } = readScannedSource(path.join(REPO_ROOT, producerRel));
  const m = pattern.exec(code);
  if (!m) {
    throw new Error(
      `${producerRel}: ${hint} — this guard can no longer find what the producer writes, so every `
      + 'assertion resting on it would be checking a path nothing creates. If the artifact moved '
      + 'or was renamed, update this guard and the `engine/vite.config*.cjs` globs in '
      + 'engine/eslint.config.js and .gitignore together — they are one decision (#879).');
  }
  return { dirVar: m[1], basename: m[2] };
}

/** `packagedViteConfig.test.ts`'s probe. `${process.pid}` is substituted with a concrete number:
 *  the glob has to match whatever pid it runs under, and a literal `${process.pid}` in a path
 *  would not exercise that. */
function probeProducer() {
  const { dirVar, basename } = extractWritePath(
    'engine/tests/plugins/packagedViteConfig.test.ts',
    /path\.join\((\w+), `(vite\.config\.[^`]*)`\)/,
    'no `path.join(<dir>, `vite.config.…`)` probe found',
  );
  return { dirVar, rel: `engine/${basename.replace('${process.pid}', '424242')}` };
}

/** `stage-vite-config.cjs`'s staged config. Anchored on the `outfile` BINDING: the stager also
 *  joins `repoRoot`+`engine` to read the SOURCE `vite.config.ts`, and a looser pattern picked that
 *  up and quietly checked the wrong file. */
function stagedProducer() {
  const { code } = readScannedSource(path.join(REPO_ROOT, 'engine/scripts/stage-vite-config.cjs'));
  const m = /const\s+outfile\s*=\s*path\.join\(\s*repoRoot\s*,\s*'engine'\s*,\s*'([^']+)'\s*\)/.exec(code);
  if (!m) {
    throw new Error(
      'stage-vite-config.cjs no longer binds `outfile` to path.join(repoRoot, \'engine\', …). '
      + 'If the staged config moved, update this guard and the `engine/vite.config*.cjs` globs in '
      + 'engine/eslint.config.js and .gitignore together — they are one decision (#879).');
  }
  return `engine/${m[1]}`;
}

describe('.gitignore and eslint `ignores` agree about what is not source', () => {
  describe('transient artifacts written into engine/ (#879)', () => {
    it('the extraction is not vacuous — both producers still write where this guard thinks', () => {
      // Without this, a producer that stopped matching would leave every assertion below checking
      // a path nothing creates, and the file would be green for the emptiest possible reason.
      const probe = probeProducer();
      expect(probe.rel).toMatch(/^engine\/vite\.config\..*424242.*\.cjs$/);
      expect(stagedProducer()).toBe('engine/vite.config.cjs');
    });

    it('the probe is written into engine/ ITSELF, which is what the glob assumes', () => {
      // `*` does not cross `/` in either resolver, so a probe relocated to engine/scratch/ would
      // stop matching while its basename still did. Pinning the DIRECTORY is what catches that;
      // pinning the filename alone cannot.
      const { code } = readScannedSource(
        path.join(REPO_ROOT, 'engine/tests/plugins/packagedViteConfig.test.ts'));
      expect(probeProducer().dirVar).toBe('engineDir');
      expect(code).toMatch(/const\s+engineDir\s*=\s*path\.join\(repoRoot,\s*'engine'\)/);
    });

    it('ESLint does not read the probe — the mid-flight ENOENT that reddens the gate', async () => {
      expect(await eslint.isPathIgnored(probeProducer().rel)).toBe(true);
    });

    it('ESLint does not read the staged config — the stranded-after-an-interrupted-pack case', async () => {
      expect(await eslint.isPathIgnored(stagedProducer())).toBe(true);
    });

    it('the repo\'s own .gitignore ignores both, keeping a stranded one out of every corpus', () => {
      // repoFiles() enumerates with `git ls-files --others --exclude-standard`, so this half is
      // what keeps a stranded artifact out of the ~94 corpus consumers, not just out of lint.
      expect(ignoredByRepoGitignore(probeProducer().rel)).toBe(true);
      expect(ignoredByRepoGitignore(stagedProducer())).toBe(true);
    });
  });

  describe('generated build output', () => {
    // Each is a gitignored build artifact that has (or can have) lintable JS in it.
    it.each([
      'games/3d-test/ads/assets/index-BUipsJNt.js', // playable-ad export — the 33,482-error one
      'games/3d-test/dist/assets/index-abc123.js',  // web/native build output
      'engine/packages/modoki/dist/index.js',
      'games/3d-test/subgame-dist/assets/index-abc.js',
      '.claude/worktrees/some-session/engine/app/main.tsx',
    ])('ESLint ignores %s', async (rel) => {
      expect(await eslint.isPathIgnored(rel)).toBe(true);
    });

    it('and so does an ABSOLUTE path — callers hold both shapes', async () => {
      // The relative cases above are what pin base-path resolution; this pins that the same entry
      // still answers for an absolute path, which is how most callers actually hold a file.
      expect(await eslint.isPathIgnored(path.join(REPO_ROOT, 'games/3d-test/ads/assets/x.js')))
        .toBe(true);
    });
  });

  describe('ACCEPT SIDE — nothing real was swept up', () => {
    it('the real engine/vite.config.ts is still linted, still unignored, and still tracked', async () => {
      // Without this, "make the ENOENT stop" is satisfiable by widening the glob until it swallows
      // the actual Vite config — taking the repo's own build config out of the lint gate AND out
      // of git, with every reject-side assertion above still green.
      expect(await eslint.isPathIgnored('engine/vite.config.ts')).toBe(false);
      expect(ignoredByRepoGitignore('engine/vite.config.ts')).toBe(false);
      expect(isTracked('engine/vite.config.ts')).toBe(true);
    });

    it.each([
      'engine/app/main.tsx',              // two directories from the glob — catches a base-path slip
      'engine/plugins/buildStepShell.ts',
      'engine/packages/modoki/src/runtime/core/rng.ts',
    ])('still LINTS real source: %s', async (rel) => {
      // The distinguishing observation for the build-output block: an ignore list of `**/*` would
      // pass every assertion above while silently linting nothing at all.
      expect(await eslint.isPathIgnored(rel)).toBe(false);
    });
  });
});
