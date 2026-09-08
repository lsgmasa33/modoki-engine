/** Guard: the hook installer actually puts every tracked hook where git will run it (#909).
 *
 *  `engine/scripts/git-hooks/*` is a SOURCE that `install-git-hooks.mjs` COPIES into the git common
 *  dir's `hooks/`. Git runs the copy. So the hook's behaviour has two axes — source-correct, and
 *  installed-current — and every test there was drove the source path directly:
 *
 *      const HOOK = path.join(REPO, 'engine/scripts/git-hooks/prepare-commit-msg');
 *      spawnSync('sh', [HOOK, msgFile], { cwd: dir });
 *
 *  A test on the first axis can never fail for the second. Measured: the `release_*` exemption was
 *  written, its three tests went green, three mutation checks went red, `npm run verify` went green
 *  — and on two separate clones git kept running the copy from before the edit, prefixing real
 *  release commits with the branch name the edit removed. This is the
 *  `vendored-src-is-not-the-running-build` shape: instrument the artifact that executes.
 *
 *  ⚠️ **This does NOT check whether THIS clone's hooks are current, deliberately.** That check goes
 *  red for the state of a developer's machine rather than for anything in the diff, and needs a skip
 *  for a clone with no hooks — the skip being where that class of guard usually dies. `verify.mjs`
 *  heals instead, by re-running the installer as a preamble. A test here as well would be checking a
 *  condition the same gate had just repaired one step earlier: a guard that cannot fail.
 *
 *  What IS falsifiable, with no machine-state dependency at all, is the installer itself — run it
 *  into a throwaway repo and look at what landed. Break the copy, the mode, or the destination and
 *  this goes red on any machine. */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readScannedSource } from '@modoki/engine/testing';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const INSTALLER = path.join(REPO, 'engine/scripts/install-git-hooks.mjs');
const SRC_DIR = path.join(REPO, 'engine/scripts/git-hooks');

/** The developer's own git config, neutralised.
 *
 *  ⚠️ **Without this the suite goes red for the state of somebody's MACHINE, which the header above
 *  swears it does not do** (close-out review). A global `core.hooksPath` — routine with a pre-commit
 *  framework — changes where git says hooks live, so the fixtures below would look in one place
 *  while the installer wrote to another. Pointing both config scopes at a nonexistent file is the
 *  documented way to make `git` ignore them. */
const NEUTRAL_GIT = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'modoki-no-such-gitconfig'),
  GIT_CONFIG_SYSTEM: path.join(os.tmpdir(), 'modoki-no-such-gitconfig'),
};

const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** A throwaway git repo with the tracked hooks installed into it, exactly as `npm install` would.
 *  Returns the repo dir and the hooks dir the installer chose (which it derives from git itself,
 *  so this asserts against git's answer rather than assuming `.git/hooks`). */
function repoWithHooksInstalled(): { dir: string; hooksDir: string; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-hooks-'));
  tmps.push(dir);
  execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'pipe' });
  const r = spawnSync(process.execPath, [INSTALLER], { cwd: dir, encoding: 'utf8', env: NEUTRAL_GIT });
  expect(r.status, `installer failed:\n${r.stdout}${r.stderr}`).toBe(0);
  const common = execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8', cwd: dir, env: NEUTRAL_GIT,
  }).trim();
  return { dir, hooksDir: path.join(path.resolve(dir, common), 'hooks'), output: `${r.stdout}${r.stderr}` };
}

const trackedHooks = () => fs.readdirSync(SRC_DIR);

describe('install-git-hooks puts every tracked hook where git runs it (#909)', () => {
  it('installs each one byte-identical to its source', () => {
    const { hooksDir } = repoWithHooksInstalled();
    const names = trackedHooks();
    expect(names.length, 'no tracked hooks found — this suite would be vacuous').toBeGreaterThan(0);
    for (const name of names) {
      const dest = path.join(hooksDir, name);
      expect(fs.existsSync(dest), `${name} was not installed to ${dest}`).toBe(true);
      expect(fs.readFileSync(dest).equals(fs.readFileSync(path.join(SRC_DIR, name))), name).toBe(true);
    }
  });

  /** ⚠️ **TWO mechanisms deliver this property, so ONE mutation proves nothing about this test.**
   *  Deleting the installer's `chmodSync` leaves it green: `copyFileSync` inherits the source's
   *  mode, and git tracks the executable bit, so the tracked hook is already 0755. Measured — that
   *  mutation was run and all 47 tests stayed green. It goes red only when BOTH providers are
   *  broken (no `chmodSync` *and* a `chmod 644` source), which was also measured. Kept because the
   *  property is real and both providers are losable — a hook mode git cannot run is a hook that
   *  silently does nothing, which is this whole issue — but do not read a lone green `chmod`
   *  mutation as evidence the assertion works. */
  it.skipIf(process.platform === 'win32')('installs it EXECUTABLE — git silently ignores a hook it cannot run', () => {
    const { hooksDir } = repoWithHooksInstalled();
    for (const name of trackedHooks()) {
      expect(fs.statSync(path.join(hooksDir, name)).mode & 0o111, name).not.toBe(0);
    }
  });

  it('re-installing over a STALE copy replaces it, and says so', () => {
    // The whole point. This is the state both clones were in: a hook already present, and behind.
    const { dir, hooksDir } = repoWithHooksInstalled();
    const name = trackedHooks()[0];
    const dest = path.join(hooksDir, name);
    fs.writeFileSync(dest, '#!/bin/sh\n# a stale hook from before some edit\nexit 0\n');

    const r = spawnSync(process.execPath, [INSTALLER], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(dest).equals(fs.readFileSync(path.join(SRC_DIR, name)))).toBe(true);
    expect(r.stdout, 'a real rewrite must be reported — it is the only signal the user gets').toContain(name);
  });

  it('says NOTHING when every hook is already current', () => {
    // `verify` runs the installer on every gate, so an unconditional line per hook would be noise
    // on every run — and the one run where it matters would look identical to the rest.
    const { dir } = repoWithHooksInstalled();
    const r = spawnSync(process.execPath, [INSTALLER], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`.trim()).toBe('');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'FAILS LOUDLY when it cannot write — this is what the gate must not swallow', () => {
      // ⚠️ Added because the gate's reporting had swallowed exactly this (close-out review 2): an
      // allow-list filter kept only `[hooks] installed …` lines, so an EACCES stack trace became the
      // empty string and `verify` printed nothing and went green while the hook stayed stale. This
      // pins the input side — the installer really does fail loudly — so the shape assertion below
      // about verify's own handling is about something that can actually happen.
      // Skipped as root (who can write anywhere) and on win32 (no POSIX mode bits to revoke).
      const { dir, hooksDir } = repoWithHooksInstalled();
      // ⚠️ REMOVE the hook, then revoke write on the dir. Leaving a stale file there does NOT
      // reproduce a failure — measured: creating the `.tmp-<pid>` file needs write on the DIRECTORY
      // and fails, but the fallback's overwrite of an existing writable FILE succeeds, so the
      // install completes (non-atomically). Both paths have to be blocked to make it fail at all.
      fs.rmSync(path.join(hooksDir, 'prepare-commit-msg'));
      fs.chmodSync(hooksDir, 0o500); // r-x: nothing can be created here
      try {
        const r = spawnSync(process.execPath, [INSTALLER], { cwd: dir, encoding: 'utf8', env: NEUTRAL_GIT });
        expect(r.status, 'the installer swallowed an unwritable hooks dir').not.toBe(0);
        expect(`${r.stdout}${r.stderr}`.trim(), 'it failed silently').not.toBe('');
      } finally {
        fs.chmodSync(hooksDir, 0o700); // so afterEach can remove it
      }
    },
  );

  it('the gate re-installs them, so an edited hook source cannot stay stale', () => {
    // The staleness half, pinned where the decision lives rather than by inspecting this machine.
    // ⚠️ Comment-STRIPPED (#812), and here that is load-bearing rather than ceremony: the docblock
    // this assertion is about names `install-git-hooks.mjs` twice, so a raw read is satisfied by the
    // PROSE explaining the call and stays green after the call itself is deleted.
    const { code: verify } = readScannedSource(path.join(REPO, 'engine/scripts/verify.mjs'));
    expect(
      verify,
      'verify.mjs no longer spawns install-git-hooks.mjs at all.',
    ).toContain('install-git-hooks.mjs');
    // ⚠️ **The containment check above is NOT enough, and shipping it alone was the defect**
    // (close-out review). The literal `install-git-hooks.mjs` lives INSIDE `installGitHooks()`, so
    // deleting the one load-bearing line — the CALL in `main()` — leaves it green while the heal is
    // dead. Measured: an isolated mutation removing only `installGitHooks();` kept all 5 tests
    // passing. My original mutation check deleted the call AND changed the path string, so it went
    // red for the wrong reason and I credited it to this assertion. Nothing else covers it either:
    // `tsc` does not typecheck `.mjs`, and the unused function is an eslint WARNING with no
    // --max-warnings on the lint script. So require the invocation, parens and all.
    // ⚠️ **A source-SHAPE guard standing in for a behavioural one; both halves were measured**
    //  (close-out review). It CATCHES the realistic regression — the call deleted while the
    //  function stays, which the containment check above cannot see. It does NOT catch a call that
    //  is present but unreachable (`if (false)`, behind an env flag, inside a helper nobody runs),
    //  which is this very defect one level up. Matching any invocation rather than a bare `()` is
    //  deliberate: `installGitHooks(repoRoot)` and `await installGitHooks()` are live heals that
    //  the stricter pattern called dead.
    //
    //  ⚠️ **The behavioural version is not cheap, and that is a fact about verify.mjs**: it derives
    //  `repoRoot` from `__dirname`, so spawning it against a throwaway repo heals THIS clone
    //  instead. Driving it properly means copying verify.mjs and the installer into a fake tree —
    //  testing a copy, the anti-pattern #909 is about. Recorded rather than worked around.
    expect(
      verify,
      'verify.mjs defines installGitHooks() but no longer CALLS it. Editing a hook source goes '
        + 'back to changing nothing until the next `npm install` — silently (#909).',
    ).toMatch(/(?<!function\s)installGitHooks\s*\(/);

    // ⚠️ And it must SURFACE a failure rather than filter it away. The first version of this heal
    // kept only `[hooks] installed …` lines, which also discarded the installer's stack trace — so
    // an unwritable hooks dir (proved reachable by the test above) printed NOTHING and went green.
    // Shape assertions, for the reason documented above: verify.mjs cannot be driven cheaply.
    expect(
      verify,
      "verify.mjs ignores the installer's exit status again — a failed install would be silent.",
    ).toMatch(/r\.status\s*!==\s*0/);
    expect(
      verify,
      'verify.mjs filters the installer output with an ALLOW-list again. That is what swallowed '
        + "the EACCES stack trace: filter OUT the known-noise line, never filter IN one shape.",
    ).not.toMatch(/startsWith\('\[hooks\] installed/);
  });

  it('does NOT write into core.hooksPath — it warns that the install is inert', () => {
    // ⚠️ **The regression here is DESTRUCTIVE, and it shipped for one commit** (close-out review).
    // A version of the installer resolved its write target through `git rev-parse --git-path hooks`
    // on the reasoning that this is where git RUNS hooks — which is true, and the wrong question.
    // `core.hooksPath` is typically ONE directory shared by every repo on the machine, and
    // `alreadyInstalled` returns false on any content mismatch, so `npm run verify` in this clone
    // replaced the developer's own hook, in every repo, with one line of output and no backup.
    // Reproduced before the revert. The write target is the clone; the lookup dir is only REPORTED.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-hookspath-'));
    tmps.push(dir);
    const theirs = path.join(dir, 'their-shared-hooks');
    fs.mkdirSync(theirs);
    const theirHook = path.join(theirs, 'prepare-commit-msg');
    const theirContent = "#!/bin/sh\n# someone else's pre-commit framework\nexit 0\n";
    fs.writeFileSync(theirHook, theirContent);

    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'pipe' });
    execFileSync('git', ['-C', dir, 'config', 'core.hooksPath', theirs], { stdio: 'pipe' });

    const r = spawnSync(process.execPath, [INSTALLER], { cwd: dir, encoding: 'utf8', env: NEUTRAL_GIT });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);

    // The load-bearing assertion: their file is byte-for-byte untouched.
    expect(
      fs.readFileSync(theirHook, 'utf8'),
      'the installer overwrote a hook in a directory shared with every repo on this machine',
    ).toBe(theirContent);

    // Ours went into the clone, where the blast radius is our own .git…
    expect(fs.existsSync(path.join(dir, '.git/hooks/prepare-commit-msg'))).toBe(true);
    // …and the user is told it will not run, because a silent inert install IS #909.
    expect(r.stdout).toMatch(/core\.hooksPath/);
    expect(r.stdout).toMatch(/INERT/);
  });
});
