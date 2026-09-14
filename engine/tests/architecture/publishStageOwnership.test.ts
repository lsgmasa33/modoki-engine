/** Guard: `publish-engine-oss.sh` never deletes a `.git` it did not create.
 *
 *  The in-stage guard run (step 4b) needs the staging dir to be a real git checkout, because the
 *  public runner checks the snapshot OUT and shipped guards ask git about it — `cliToolchainRecipes`
 *  enumerates via `git ls-files`. So the step does `git init` → `add -Af` → `commit`, runs the
 *  guards, then removes the `.git` again.
 *
 *  That is safe ONLY while the staging dir belongs to the script. It usually does — `mktemp -d` —
 *  but `--out DIR` makes `$STAGE` whatever the caller named, and it is not validated. A
 *  pre-existing `.git` there survives the `rm -rf "$STAGE"/*` wipe near the top, because that glob
 *  skips dotfiles. So the first version of step 4b would init over a caller's repository, commit
 *  into it, and then delete its `.git`.
 *
 *  Measured, not theorised: staging into a throwaway repo with `--out` destroyed its `.git` and the
 *  script still exited 0. Losing the working tree to the wipe is recoverable from `.git`; deleting
 *  `.git` is not — that is the whole history, and `--out <a local clone of the public repo>` is a
 *  plausible thing for someone to type.
 *
 *  The rule: every `.git` removal under `$STAGE` must be dominated by the refusal branch that
 *  bails when one already exists. Asserted structurally (order in the file) rather than by running
 *  the script, which would mean assembling a whole snapshot per test. */
import { describe, it, expect } from 'vitest';
import { found } from '@modoki/engine/testing/inOrder';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { hasPublishScripts } from '../helpers/repoLayout';

const SCRIPT = path.resolve(__dirname, '../../../scripts/publish-engine-oss.sh');

// THIS FILE SHIPS; THE SCRIPT IT READS DOES NOT. `publish-engine-oss.sh`'s manifest ships
// `engine build docs` + root configs, so root `scripts/` is absent from the public snapshot —
// and step 4b now runs the shipped guards INSIDE that snapshot, where the unconditional
// readFileSync above was an ENOENT before a single assertion ran. Read lazily and skip, rather
// than assert on a file the snapshot is never supposed to contain.
// The private-repo tripwire (`repoLayoutGuard.test.ts`) is what stops this skip going silent here.
const SRC = hasPublishScripts() ? fs.readFileSync(SCRIPT, 'utf8') : '';

describe.skipIf(!hasPublishScripts())('publish-engine-oss.sh owns the .git it deletes', () => {
  const src = SRC;

  it('refuses to touch a staging dir that already contains a .git', () => {
    // The branch itself must exist. Without it the script has no way to tell "my temp dir" from
    // "the caller's repo", and every other assertion here is vacuous.
    expect(src, 'the pre-existing-.git refusal branch is gone').toMatch(
      /elif\s+\[\s+-e\s+"\$\{STAGE\}\/\.git"\s+\]\s*;\s*then/,
    );
  });

  it('never removes $STAGE/.git before that refusal', () => {
    const guardAt = found(src.search(/elif\s+\[\s+-e\s+"\$\{STAGE\}\/\.git"\s+\]\s*;\s*then/), 'the pre-existing-.git refusal branch');

    // Every `rm -rf …/.git` aimed at the stage must come AFTER the refusal — i.e. inside the
    // else-branch the refusal protects. One appearing earlier would run unconditionally.
    const removals = [...src.matchAll(/rm\s+-rf\s+"\$\{STAGE\}\/\.git"/g)].map((m) => m.index ?? -1);
    expect(removals.length, 'no $STAGE/.git removal found — did step 4b change shape?')
      .toBeGreaterThan(0);
    for (const at of removals) {
      expect(at, `a $STAGE/.git removal at offset ${at} is not protected by the refusal`)
        .toBeGreaterThan(guardAt);
    }
  });

  it('creates the throwaway repo only inside the guarded branch', () => {
    const guardAt = found(src.search(/elif\s+\[\s+-e\s+"\$\{STAGE\}\/\.git"\s+\]\s*;\s*then/), 'the pre-existing-.git refusal branch');
    // Same argument in the other direction: an unguarded `git init` would reinitialise a caller's
    // repo and stage a commit into it even if the deletion were somehow avoided.
    const inits = [...src.matchAll(/git\s+-C\s+"\$STAGE"\s+init/g)];
    // A floor, or a renamed `git init` matches nothing and the loop below asserts nothing (#1181 review).
    expect(inits.length, 'no git init on $STAGE found — did step 4b change shape?').toBeGreaterThan(0);
    for (const m of inits) {
      expect(m.index ?? -1, 'git init on $STAGE runs before the pre-existing-.git refusal')
        .toBeGreaterThan(guardAt);
    }
  });
});

/** #1117: every temp path the script mints is removed on EXIT, and nothing the caller named is.
 *
 *  Run for real, not read structurally: `GIT_DIR` pointed at nothing makes the manifest's
 *  `git ls-files` fail right after the stage dir AND the manifest file are minted, so each run
 *  exits 1 in about a second, inside a private `TMPDIR`. That path is the one a trap exists for.
 *  Before #1117, a failure (or a completed dry run) left both behind every time. */
describe.skipIf(!hasPublishScripts() || process.platform === 'win32')('publish-engine-oss.sh removes the temp dirs it mints', () => {
  const runEarlyFailure = (extraEnv: Record<string, string>, args: string[] = []) => {
    const tmp = makeScratchDir('modoki-pubtmp-');
    const r = spawnSync('bash', [SCRIPT, ...args.map((a) => a.replace('<tmp>', tmp))], {
      env: { ...process.env, TMPDIR: tmp, GIT_DIR: path.join(tmp, 'no-such-git-dir'), ...extraEnv },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    // Non-vacuity: the run must have got PAST minting the stage, and failed where expected.
    expect(r.status, out).toBe(1);
    expect(out, 'the run failed before minting the stage, so no removal was exercised').toMatch(/staging: /);
    expect(out).toMatch(/not a git repository/);
    return { tmp, left: fs.readdirSync(tmp).sort() };
  };

  it('removes the minted stage and the manifest on a failing exit', () => {
    expect(runEarlyFailure({}).left).toEqual([]);
  });

  it('keeps the minted stage, and only the stage, under MODOKI_KEEP_STAGE=1', () => {
    const { left } = runEarlyFailure({ MODOKI_KEEP_STAGE: '1' });
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^modoki-oss-(?!manifest-)/);
  });

  it('never removes an --out dir the caller named', () => {
    const { tmp, left } = runEarlyFailure({}, ['--out', '<tmp>/caller-out']);
    expect(left).toEqual(['caller-out']);
    expect(fs.statSync(path.join(tmp, 'caller-out')).isDirectory()).toBe(true);
  });
});

/** #1117, the sibling: `publish-demo.sh` mints its stage the same way and now removes it on EXIT by
 *  the same rule.
 *
 *  ⚠️ **Run against a THROWAWAY repo, never this checkout** (#1117 close-out review). The script
 *  refuses a demo dir with uncommitted changes BEFORE it mints the stage, and a live editor writes
 *  `.meta.json` and scene saves behind your back (#18). Pointed at the real `demos/`, every clone
 *  with that demo open would go red for a reason unrelated to its work. So the script is copied into
 *  a scratch repo holding one committed demo. It checks git before minting, so `GIT_DIR` cannot
 *  force the failure here. A failing `tar` does, since `git archive | tar` is the first step after
 *  the mint. */
describe.skipIf(!hasPublishScripts() || process.platform === 'win32')('publish-demo.sh removes the stage it mints', () => {
  const DEMO_SCRIPT = path.resolve(__dirname, '../../../scripts/publish-demo.sh');
  // No inherited GIT_* (a hook exports GIT_DIR/GIT_INDEX_FILE): the fixture must never write into the OUTER repo.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.email=t@local', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' });
    expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
  };
  const runEarlyFailure = (extraEnv: Record<string, string>, args: string[] = []) => {
    const tmp = makeScratchDir('modoki-pubdemo-');
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'oss'));
    fs.mkdirSync(path.join(repo, 'demos', 'fixture-demo'), { recursive: true });
    fs.copyFileSync(DEMO_SCRIPT, path.join(repo, 'scripts', 'publish-demo.sh'));
    fs.writeFileSync(path.join(repo, 'oss', 'LICENSE-MIT-DEMO'), 'MIT\n');
    fs.writeFileSync(path.join(repo, 'demos', 'fixture-demo', 'README.md'), '# fixture\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'fixture');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'tar'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const scratch = path.join(tmp, 't');
    fs.mkdirSync(scratch);
    const r = spawnSync('bash', [path.join(repo, 'scripts', 'publish-demo.sh'), 'fixture-demo', ...args.map((a) => a.replace('<tmp>', scratch))], {
      cwd: repo,
      env: { ...env, TMPDIR: `${scratch}/`, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...extraEnv },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    // Non-vacuity: it got PAST minting the stage and failed where expected.
    expect(r.status, out).not.toBe(0);
    expect(out, 'the run failed before minting the stage').toMatch(/staging: /);
    return { scratch, left: fs.readdirSync(scratch).sort() };
  };

  it('removes the minted stage on a failing exit', () => {
    expect(runEarlyFailure({}).left).toEqual([]);
  });

  it('keeps it under MODOKI_KEEP_STAGE=1', () => {
    expect(runEarlyFailure({ MODOKI_KEEP_STAGE: '1' }).left).toEqual([expect.stringMatching(/^modoki-demo-/)]);
  });

  it('never removes an --out dir the caller named', () => {
    const { scratch, left } = runEarlyFailure({}, ['--out', '<tmp>/caller-out']);
    expect(left).toEqual(['caller-out']);
    expect(fs.statSync(path.join(scratch, 'caller-out')).isDirectory()).toBe(true);
  });
});
