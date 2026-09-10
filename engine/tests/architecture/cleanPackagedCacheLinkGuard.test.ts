/** `clean-packaged-cache.mjs` must REFUSE when a target path is a link (#883).
 *
 *  The defect: `rmSync(<link>, {recursive: true, force: true})` removes the LINK and leaves the
 *  payload. Measured both ways — Windows junction and POSIX directory symlink — so this is a
 *  cross-platform bug that was merely FOUND on Windows, and the guard and this suite are
 *  unconditional. Before the guard the script printed `[done] removed N path(s)` with a multi-GB
 *  provision untouched: a report that is wrong in the one direction a clean-install test cannot
 *  tolerate.
 *
 *  ⚠️ **Driven through the CLI, not by importing a function.** The script is a top-level program:
 *  its guard, its `--dry-run` handling and its exit code only exist in the way it is actually run
 *  (`npm run clean:packaged-cache`). A unit test around an exported helper would assert the
 *  predicate and say nothing about whether the run stops.
 *
 *  ⚠️ **Every case passes `--dry-run`, and that is a SAFETY requirement, not a convenience.**
 *  `targets()` names this machine's real `%APPDATA%\Modoki Editor` / `~/Library/Application
 *  Support/…`; a test that let the delete loop run would wipe the developer's own packaged editor
 *  state. `--dry-run` is also the sharper test of the contract: the guard is specified to exit
 *  non-zero even there, because the honest answer to "what would this do" is "report success and
 *  delete almost nothing".
 *
 *  ⚠️ **Every payload here is TOOLCHAIN-SHAPED (`<payload>/node/big.bin`, never `<payload>/big.bin`)
 *  and must stay that way.** After #1005 the script also refuses a toolchain candidate whose
 *  top-level entries it does not own, and a bare `big.bin` at the root is exactly such an entry —
 *  so a flat payload makes the #1005 guard fire FIRST and these link cases never reach the code
 *  they are testing. Three of them failed that way when the guard landed. The nesting costs one
 *  `mkdirSync` and makes the fixture representative of what MODOKI_TOOLCHAIN_DIR actually points at.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeDirLink, makeFixtureRoot, canMakeDirLink } from '../helpers/linkFixture';
import { isUnderOrSame } from '../../scripts/pathIdentity.mjs';

const CLI = path.resolve(__dirname, '../../scripts/clean-packaged-cache.mjs');

/** `--toolchain` is what puts `MODOKI_TOOLCHAIN_DIR` on the candidate list, which is the only
 *  target this suite can point at a fixture.
 *
 *  ⚠️ **The environment is made HERMETIC, and that is not tidiness.** `targets()` derives its other
 *  candidates from `APPDATA` / `LOCALAPPDATA` / `XDG_CONFIG_HOME` / `HOME`, so an inherited env
 *  leaves this developer's REAL `%APPDATA%\Modoki Editor`, `~/Library/Logs/Modoki Editor` and so on
 *  on the list. The reject cases survive that; the **accept** case does not — it would go red on any
 *  machine where one of those happens to be a symlink, which is an ordinary Dropbox / iCloud /
 *  dotfiles arrangement and nothing to do with the fixture. Pointing all four at an empty temp dir
 *  makes every case depend on the fixture alone. (Found by close-out review; on the one Mac that
 *  had checked, all eight real targets happened to be plain directories — i.e. the suite was
 *  passing on luck, and measuring it is what showed the luck rather than the property.) */
function sandboxEnv(sandbox: string, toolchainDir?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Set UNCONDITIONALLY. Spreading it only when provided left the developer's own
    // MODOKI_TOOLCHAIN_DIR inherited from process.env — observed putting this machine's real
    // provisioned toolchain on the candidate list. Harmless while only the dry-run helper used
    // that form, and one call away from mattering now that a real delete exists.
    MODOKI_TOOLCHAIN_DIR: toolchainDir ?? '',
    APPDATA: sandbox,
    LOCALAPPDATA: sandbox,
    XDG_CONFIG_HOME: sandbox,
    HOME: sandbox,
    USERPROFILE: sandbox,
  };
}

/** Where `--toolchain` looks by default **inside the sandbox** — asked of the same helper the
 *  script uses, in a child carrying the same environment.
 *
 *  ⚠️ **Not computed in THIS process, and not hardcoded.** Hardcoding
 *  `path.join(sandbox, 'Modoki', 'toolchain')` is what made this suite pass on Windows and Linux
 *  and fail on every Mac: `appSupportRoot()` reads `APPDATA` on win32 and `XDG_CONFIG_HOME` on
 *  linux, but on **darwin it reads neither** — it derives from `os.homedir()` — so the sandboxed
 *  default lands under `<sandbox>/Library/Application Support/…` there and nowhere near the
 *  fixture. Calling the helper in-process would be just as wrong: this process does not carry the
 *  sandbox env. Spawning a child that does is the only form that cannot drift from the subject, and
 *  it needs no assumption about whether `os.homedir()` honours `HOME`.
 *
 *  ⚠️ **The obvious mutation check does NOT discriminate here, and that is a property of deriving,
 *  not a gap.** "Break `appSupportRoot()`'s branch and confirm the case reddens" is the right check
 *  for a HARDCODED fixture — it stays green because it does not follow the subject. A DERIVED
 *  fixture legitimately stays green too, because both sides move together; measured on `win`,
 *  removing the `APPDATA` read left all 4 cases passing. The mutations that DO discriminate make
 *  the two sides DISAGREE:
 *    · the script's default diverges from the helper the test asks → this case reddens (proves the
 *      fixture tracks the script's real default rather than a copy of it)
 *    · the exemption itself removed                                → this case reddens
 *  Both verified. Mutate the AGREEMENT, not the shared derivation. */
function defaultToolchainDirUnder(sandbox: string): string {
  const mod = pathToFileURL(path.resolve(__dirname, '../../scripts/packagedAppPaths.mjs')).href;
  const code = `import(${JSON.stringify(mod)}).then((m) => process.stdout.write(m.defaultToolchainDir()))`;
  return execFileSync('node', ['-e', code], { encoding: 'utf8', env: sandboxEnv(sandbox) }).trim();
}

/** The script's OWN `appSupportRoot()`, evaluated INSIDE the sandbox — same shape and same reason
 *  as `defaultToolchainDirUnder` above: it reads a different env var per platform (and none at all
 *  on darwin), so computing it in this process, or hardcoding it, is wrong on some platform. */
function appSupportRootUnder(sandbox: string): string {
  const mod = pathToFileURL(path.resolve(__dirname, '../../scripts/packagedAppPaths.mjs')).href;
  const code = `import(${JSON.stringify(mod)}).then((m) => process.stdout.write(m.appSupportRoot()))`;
  return execFileSync('node', ['-e', code], { encoding: 'utf8', env: sandboxEnv(sandbox) }).trim();
}

function run(toolchainDir: string, sandbox: string): { out: string; status: number } {
  return spawnCli(['--toolchain', '--dry-run'], toolchainDir, sandbox);
}

function spawnCli(args: string[], toolchainDir: string, sandbox: string): { out: string; status: number } {
  const env = sandboxEnv(sandbox, toolchainDir);
  try {
    const out = execFileSync('node', [CLI, ...args], { encoding: 'utf8', env });
    return { out, status: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? -1 };
  }
}

/** A REAL delete — the only way to observe what the run LEAVES BEHIND, which `--dry-run` cannot
 *  show by construction.
 *
 *  ⚠️ **The sandbox is asserted before the real run, not assumed.** This file's rule is that every
 *  case passes `--dry-run` because `targets()` names the developer's actual packaged state; the one
 *  case that cannot obey it earns the exception by first proving, from the script's OWN output,
 *  that every path it would touch is inside the fixture. If a platform ever derived a candidate
 *  from something `sandboxEnv` does not override, this fails loudly here instead of deleting a real
 *  directory — which is the positive control the safety rule is really asking for. */
function runForReal(toolchainDir: string, sandbox: string): { out: string; status: number } {
  const dry = spawnCli(['--toolchain', '--dry-run'], toolchainDir, sandbox);
  // ⚠️ Filtered by `path.isAbsolute`, not by a shape-match on the summary line. The summary shares
  // the prefix (`[dry-run] would remove 2 path(s).`) and an earlier filter special-cased that exact
  // wording — which only held because `--toolchain` suppresses the `(toolchain kept …)` suffix.
  // Every real target is an absolute path; no summary line is.
  const touched = [...dry.out.matchAll(/^\s*(?:\[dry-run\] would remove|\[remove\])\s+(.+)$/gm)]
    .map((m) => m[1].trim())
    .filter((t) => path.isAbsolute(t));
  expect(dry.status, `dry-run refused, so the real run's targets are unknown:\n${dry.out}`).toBe(0);
  expect(touched.length, `dry-run named no targets — refusing to run for real:\n${dry.out}`).toBeGreaterThan(0);
  for (const t of touched) {
    // ⚠️ **`isUnderOrSame`, NOT a hand-rolled `path.relative(...).startsWith('..')`** — which is
    // what this line was, and it is UNSOUND on win32 exactly where it matters. `path.win32.relative`
    // returns an ABSOLUTE path when the two are on different drives, so `startsWith('..')` is false
    // and an out-of-sandbox path reads as inside. Measured on this clone, which has that split
    // (`TEMP=E:\dev-temp`, profile on `C:`):
    //     relative(E:\…\sandbox, C:\Users\…\Modoki Editor) = "C:\Users\…\Modoki Editor"
    //     .startsWith('..') = false          isUnderOrSame(...) = false
    // So the guard authorising a real `rmSync` could not detect the one thing it exists to detect.
    // `pathIdentity.mjs` already owns this predicate and its docblock records `startsWith('..')` as
    // "WRONG and this function shipped it once"; mine was the ninth hand-roll, uncaught because
    // `pathIdentityIsShared.test.ts` scopes to non-test sources.
    expect(
      isUnderOrSame(sandbox, t),
      `REFUSING the real run: ${t} is OUTSIDE the sandbox ${sandbox} — sandboxEnv does not cover this platform`,
    ).toBe(true);
  }
  return spawnCli(['--toolchain'], toolchainDir, sandbox);
}

/** The script's OTHER refusal — a live packaged editor — also exits 1, and would make a reject
 *  case pass for the wrong reason and the accept case fail for one. Tell them apart by the text. */
const RUNNING = /is currently running/;

/** #1037 — **`--dry-run` must never be gated on liveness**, and this is the case the fix's own
 *  design named and then did not build. It shipped as "structural, therefore covered", which is the
 *  reasoning this repo keeps punishing: the branch `DRY_RUN ? [] : blockingEditors()` is one edit
 *  away from being re-ordered back, and nothing would have noticed.
 *
 *  The discriminator is an environment where the liveness check CANNOT SUCCEED: with `PATH`
 *  emptied, the script's `ps` spawn throws ENOENT, `listProcesses` returns `null`, and a real run
 *  must refuse rather than assume nothing is running. A dry run in the SAME environment must still
 *  work — because it deletes nothing, so what is alive cannot change its answer. Two flags, one
 *  environment, opposite outcomes; neither assertion means anything without the other.
 *
 *  ⚠️ Spawned via `process.execPath`, not `'node'` — with `PATH` emptied the child could not
 *  otherwise be found, and the test would "pass" by failing to start the subject at all. */
/** #1037 case 6 — **the false red, reproduced and then shown gone, through the REAL CLI.**
 *
 *  The unit suite proves the predicate ignores a process that merely mentions the bundle path. This
 *  proves the thing that actually happened: the six cases in this file went red on four different
 *  clones because SOMETHING unrelated held that string in its argv. So hold one open on purpose and
 *  drive the real script, which is the only form that can say the gate is fixed rather than that
 *  the predicate is.
 *
 *  ⚠️ **The decoy carries the marker in its own ARGV, which is the whole point and also the
 *  hazard.** `repoReapSpellings.test.ts` records the same trap: a test that spells the pattern into
 *  its own command line matches itself, and BSD `pgrep` hides that by skipping its own ancestor
 *  chain while `procps` does not. Here only the CHILD gets the string — `execFileSync`/`spawn` pass
 *  argv to the child, and this worker's own argv is untouched — so the marker cannot come back
 *  through the parent. */
describe('clean-packaged-cache: a process merely MENTIONING the bundle does not red the gate (#1037)', () => {
  const MARKER = `/Applications/${'Modoki Editor'}.app/Contents/MacOS/${'Modoki Editor'}`;

  /** Is a process alive whose ARGV contains the marker? Read through `ps`, never `pgrep -f` — the
   *  diagnostic for this bug is itself an instance of it. */
  function decoyVisible(): boolean {
    const out = execFileSync('ps', ['-Axo', 'command='], { encoding: 'utf8' });
    return out.split('\n').some((l) => l.includes(MARKER) && l.includes('-e'));
  }

  it.skipIf(process.platform === 'win32')('the six cases stay green with a decoy held open', () => {
    const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', MARKER], {
      stdio: 'ignore', detached: false,
    });
    try {
      // The control: without this the case passes when the decoy failed to start, which is the
      // shape that makes "it stayed green" mean nothing.
      const deadline = Date.now() + 5000;
      let seen = false;
      while (Date.now() < deadline && !(seen = decoyVisible())) { /* spin briefly */ }
      expect(seen, 'the decoy never appeared in the process table — the case would be vacuous').toBe(true);

      // ⚠️ **A REAL run, not `--dry-run`** — and the first version of this case used the dry one,
      // which made it unfalsifiable. `--dry-run` now short-circuits the liveness check entirely
      // (that is its own rule, tested above), so with it the predicate is never consulted and the
      // case passed with the ORIGINAL #1037 bug restored. Mutation-checked after the change:
      // matching argv instead of the executable now turns this red.
      // `runForReal` proves every target is inside the fixture before it deletes anything.
      const base = makeFixtureRoot('cpc-decoy-');
      const tc = path.join(base, 'tc');
      fs.mkdirSync(tc, { recursive: true });
      const { out, status } = runForReal(tc, base);

      expect(out, 'the decoy must not be read as a running editor').not.toMatch(RUNNING);
      expect(out).not.toMatch(/is currently running out of the state/i);
      expect(status, `expected a clean run, got ${status}:\n${out}`).toBe(0);
    } finally {
      decoy.kill('SIGKILL');
    }
  });
});

describe('clean-packaged-cache: --dry-run is never gated on liveness (#1037)', () => {
  function spawnWithoutPath(args: string[], sandbox: string): { out: string; status: number } {
    const env = { ...sandboxEnv(sandbox), PATH: '', Path: '' };
    try {
      const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
      return { out, status: 0 };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? -1 };
    }
  }

  it('REFUSES a real run when the process table cannot be read — it must not assume "nothing is running"', () => {
    const base = makeFixtureRoot('cpc-nopath-real-');
    const { out, status } = spawnWithoutPath([], base);
    expect(status, `expected a refusal, got:\n${out}`).not.toBe(0);
    expect(out).toMatch(/could not read the process table/i);
  });

  /** The half that is the actual subject: SAME unreadable process table, `--dry-run` proceeds. */
  it('does NOT refuse a --dry-run in that same environment', () => {
    const base = makeFixtureRoot('cpc-nopath-dry-');
    const { out, status } = spawnWithoutPath(['--dry-run'], base);
    expect(status, `--dry-run must not be gated on liveness, but it exited ${status}:\n${out}`).toBe(0);
    expect(out).not.toMatch(/could not read the process table/i);
    expect(out).not.toMatch(RUNNING);
  });
});

describe.skipIf(!canMakeDirLink())('clean-packaged-cache refuses a linked target (#883)', () => {
  it('REFUSES, naming the link and what it resolves to', () => {
    const base = makeFixtureRoot('cpc-link-');
    try {
      const real = path.join(base, 'toolchain-real');
      const link = path.join(base, 'toolchain-link');
      fs.mkdirSync(real);
      fs.mkdirSync(path.join(real, 'node'), { recursive: true });
      fs.writeFileSync(path.join(real, 'node', 'big.bin'), 'payload');
      makeDirLink(real, link);

      const { out, status } = run(link, base);

      expect(out, 'a packaged editor is running on this machine — quit it and re-run').not.toMatch(RUNNING);
      expect(status).toBe(1);
      expect(out).toContain('REFUSING to run');
      // The link AND the target: a refusal that does not name what the payload actually is leaves
      // the reader unable to delete it by hand, which is the only remedy the message offers.
      expect(out).toContain(link);
      expect(out).toContain(fs.realpathSync.native(real));

      // ⚠️ The load-bearing half. Without this the suite would pass over a guard that refused and
      // then fell through, or one placed after the loop — and under `--dry-run` neither would be
      // visible as data loss. The loop's wording is `[dry-run] would remove`, per-path AND in the
      // summary, so this one line covers both.
      //
      // ⚠️ **The sentinel is the BRACKETED PREFIX, not the fragment `would remove`.** It was the
      // fragment until #990, and that made it ambiguous rather than wrong: the refusal message now
      // explains what a recursive delete WOULD REMOVE, so the fragment matched the refusal itself
      // and this assertion failed on a guard that was working perfectly. A sentinel proving "the
      // loop was not reached" has to match something only the loop can emit. Tightening, not
      // relaxing — mutation-checked by disabling the guard and confirming this goes red.
      //
      // (A `not.toContain('[done] removed')` used to sit here too and was deleted as VACUOUS: under
      // `--dry-run` the summary is always `[dry-run] would remove N path(s)`, so no code path can
      // emit `[done] removed` and the assertion could not fail. Close-out review.)
      expect(out).not.toContain('[dry-run] would remove');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('REFUSES a DANGLING link too — the check that has to run before existsSync', () => {
    const base = makeFixtureRoot('cpc-dangle-');
    try {
      const link = path.join(base, 'toolchain-link');
      makeDirLink(path.join(base, 'never-created'), link);
      // The premise, asserted rather than assumed: this is the case `existsSync` cannot see.
      // Measured identically on macOS (POSIX symlink) and Windows (junction).
      expect(fs.existsSync(link)).toBe(false);
      expect(fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()).toBe(true);

      const { out, status } = run(link, base);

      expect(out, 'a packaged editor is running on this machine — quit it and re-run').not.toMatch(RUNNING);
      expect(status).toBe(1);
      expect(out).toContain('REFUSING to run');
      // Not silently omitted, and not crashed on: `realpathSync` throws ENOENT here, and a
      // catch-and-return-false resolver would have failed OPEN at exactly this point.
      expect(out).toContain('DANGLING');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('does NOT refuse a real directory — the accept side', () => {
    const base = makeFixtureRoot('cpc-plain-');
    try {
      const real = path.join(base, 'toolchain-real');
      fs.mkdirSync(real);

      const { out, status } = run(real, base);

      expect(out, 'a packaged editor is running on this machine — quit it and re-run').not.toMatch(RUNNING);
      expect(status).toBe(0);
      expect(out).not.toContain('REFUSING to run');
      // ⚠️ It must reach the DELETE LOOP and consider the fixture — `would remove <path>` is that
      // loop's own line. A bare `toContain(real)` was here first and was VACUOUS: the
      // `removed === 0` branch prints every candidate verbatim under `Checked N path(s):`, so
      // disabling the delete loop entirely (`if (!existsSync(p)) continue` → bare `continue`) left
      // all three accept assertions green — the exact "guard fell through / ran after the loop"
      // family the reject cases exist to catch. Close-out review measured it.
      expect(out).toContain(`would remove ${real}`);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  /** ⚠️ **The exemption above, applied to the WRONG pair, re-opened #883 verbatim** — and the
   *  accept case could not see it, because it builds link -> REAL DIRECTORY, where both the correct
   *  predicate and the broken one agree. The distinguishing fixture is link -> LINK.
   *
   *  The broken condition used `samePath`, which canonicalises BOTH sides through links — exactly
   *  the resolution this guard exists to see through. Two candidates that are each a link to the
   *  same target therefore exempted EACH OTHER, and the run printed `[done] removed 2 path(s)`,
   *  exit 0, with the payload intact. Measured through the real CLI before the fix. */
  it('REFUSES two links that point at the SAME target — they must not exempt each other (#883)', () => {
    const base = makeFixtureRoot('cpc-mutual-');
    try {
      const payload = path.join(base, 'PAYLOAD');
      const dflt = defaultToolchainDirUnder(base);
      const link = path.join(base, 'toolchain-link');
      fs.mkdirSync(payload, { recursive: true });
      fs.mkdirSync(path.join(payload, 'node'), { recursive: true });
      fs.writeFileSync(path.join(payload, 'node', 'big.bin'), 'payload');
      fs.mkdirSync(path.dirname(dflt), { recursive: true });
      makeDirLink(payload, dflt);   // the DEFAULT location is a link to the payload
      makeDirLink(payload, link);   // and so is the override

      const { out, status } = run(link, base);

      expect(out, 'a packaged editor is running on this machine — quit it and re-run').not.toMatch(RUNNING);
      expect(status).toBe(1);
      expect(out).toContain('REFUSING to run');
      // The load-bearing half: neither entry reached the delete loop. Bracketed prefix, not the
      // bare fragment — see the note on the same assertion above (#990).
      expect(out).not.toContain('[dry-run] would remove');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  /** ⚠️ **A SUCCESSFUL run must not leave a dangling link that blocks every later run.**
   *  `existsSync` follows links, so once the delete loop removed the real directory the junction
   *  pointing at it read as absent and was skipped — and the guard then refused on it forever,
   *  with a remedy message blaming a human for hand-deleting the target. The script's own success
   *  created the state. This is the only case that runs for REAL: what a run LEAVES BEHIND is
   *  invisible to `--dry-run` by construction. */
  it('leaves NOTHING dangling — a second run is clean, not a permanent refusal', () => {
    const base = makeFixtureRoot('cpc-dangle2-');
    try {
      const real = path.join(base, 'REAL');
      const dflt = defaultToolchainDirUnder(base);
      fs.mkdirSync(real, { recursive: true });
      fs.mkdirSync(path.join(real, 'node'), { recursive: true });
      fs.writeFileSync(path.join(real, 'node', 'big.bin'), 'payload');
      fs.mkdirSync(path.dirname(dflt), { recursive: true });
      makeDirLink(real, dflt);      // the DEFAULT is a link to the override's real directory

      // No `not.toMatch(RUNNING)` here: `runForReal` already asserts the dry run exited 0, which
      // cannot hold while a packaged editor is running (that check precedes the DRY_RUN branch).
      // A second assertion for the same condition is the vacuous shape this file deleted from
      // case 1 — it reads like extra rigour and can never fail independently.
      const first = runForReal(real, base);
      expect(first.status, `the real run failed:\n${first.out}`).toBe(0);
      expect(fs.existsSync(path.join(real, 'node', 'big.bin')), 'the payload should be gone').toBe(false);
      expect(
        fs.lstatSync(dflt, { throwIfNoEntry: false }),
        'the link that pointed at the deleted payload is still on disk — it will refuse forever',
      ).toBeUndefined();

      // The property that actually matters, and the one a lstat assertion alone would not prove.
      const second = run(real, base);
      expect(second.status, `the second run refused:\n${second.out}`).toBe(0);
      expect(second.out).not.toContain('REFUSING to run');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('does NOT refuse a link whose target is ITSELF a candidate — the payload is deleted via that entry', () => {
    // The configuration `targets()`' raw-keyed dedupe exists to rescue, and which the first version
    // of this guard broke: `MODOKI_TOOLCHAIN_DIR` junctioned TO the default location — "an ordinary
    // Windows move when C: is small", in the script's own words. Both the link and the real default
    // are listed, so `rmSync` on the default deletes the payload; refusing here is a FALSE refusal
    // that makes `--toolchain` permanently unusable for a documented setup.
    const base = makeFixtureRoot('cpc-covered-');
    try {
      // ⚠️ **Asked of the script's own helper, never re-derived** — and this case failed on macOS
      // for exactly that reason. It hardcoded `path.join(base, 'Modoki', 'toolchain')`, which is
      // the real default only where `appSupportRoot()` honours the sandboxed environment: win32
      // reads `APPDATA`, linux reads `XDG_CONFIG_HOME`, and **darwin reads NEITHER** — it derives
      // from `os.homedir()`, so the default sits at `<base>/Library/Application Support/Modoki/
      // toolchain` and the fixture's directory was not a candidate at all. The exemption could not
      // fire, the guard refused, and the case was green on Windows and Linux and red on every Mac.
      // The public CI `check` matrix was [ubuntu, windows] when this was found, so nothing this
      // repo ran could have caught it — it took a real macOS run. `macos-14` joined that matrix on
      // 2026-09-09 BECAUSE of this defect, so an equivalent one would now be caught automatically.
      //
      // `defaultToolchainDir()` is exported from `packagedAppPaths.mjs` rather than from the script
      // under test, which is a top-level program: importing THAT for the path would run the wipe.
      const dflt = defaultToolchainDirUnder(base);
      fs.mkdirSync(path.dirname(dflt), { recursive: true });
      const link = path.join(base, 'toolchain-link');
      fs.mkdirSync(dflt, { recursive: true });
      fs.mkdirSync(path.join(dflt, 'node'), { recursive: true });
      fs.writeFileSync(path.join(dflt, 'node', 'big.bin'), 'payload');
      makeDirLink(dflt, link);

      const { out, status } = run(link, base);

      expect(out, 'a packaged editor is running on this machine — quit it and re-run').not.toMatch(RUNNING);
      expect(status).toBe(0);
      expect(out).not.toContain('REFUSING to run');
      // Both entries reach the loop: the link AND the real default. The second is the one that
      // actually removes the payload, which is why the first is safe to pass.
      expect(out).toContain(`would remove ${link}`);
      expect(out).toContain(`would remove ${dflt}`);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

/** The SECOND half of #1005: this script deletes `MODOKI_TOOLCHAIN_DIR` recursively and, unlike
 *  `uninstallAll()`, asked NOTHING about it first.
 *
 *  ⚠️ **This is not the link/mount guard above, and neither one subsumes the other.**
 *  `findDeleteBoundaries` answers "would a recursive delete MISREPORT this subtree?" — a link, a
 *  mount, a drive root. A home directory or a repo root is a perfectly ordinary, self-contained
 *  tree: no boundary exists, the walk is happy, and the script would delete it and report success.
 *  The question this guard asks is the other one — "is this OURS to delete at all?"
 *
 *  ⚠️ **No links here on purpose, so it runs unconditionally** — unlike the suite above it needs no
 *  `canMakeDirLink()`, and it must stay that way: the defect has nothing to do with link support and
 *  a `skipIf` would silently drop this cover on any machine without Developer Mode.
 */
describe('clean-packaged-cache refuses a toolchain candidate that is not a toolchain (#1005)', () => {
  it('REFUSES a directory holding foreign entries, names them, and removes nothing', () => {
    const base = makeFixtureRoot('cpc-nottc-');
    try {
      const homeish = path.join(base, 'home-ish');
      fs.mkdirSync(path.join(homeish, 'Documents'), { recursive: true });
      fs.mkdirSync(path.join(homeish, 'Desktop'), { recursive: true });
      fs.mkdirSync(path.join(homeish, 'node'), { recursive: true }); // one owned entry is not enough

      const { out, status } = run(homeish, base);

      expect(out, 'a packaged editor is running on this machine — quit it and re-run').not.toMatch(RUNNING);
      expect(status).toBe(1);
      expect(out).toContain('REFUSING to run');
      expect(out).toContain('Documents');
      expect(out).toContain('Desktop');
      // ⚠️ The refusal must not reach the delete loop at all — a guard that prints and then removes
      // is the exact failure shape #883 was.
      expect(out).not.toContain('would remove');
      expect(fs.existsSync(path.join(homeish, 'Documents'))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // ⚠️ THE ACCEPT SIDE. Proving the refusal fires says nothing about whether a real toolchain still
  // gets cleaned — and a guard that refuses everything would pass the case above.
  it('ACCEPTS a toolchain-shaped root whose basename is not "toolchain"', () => {
    const base = makeFixtureRoot('cpc-realtc-');
    try {
      const tc = path.join(base, 'modoki-toolchain'); // the `win` clone's actual shape
      fs.mkdirSync(path.join(tc, 'node'), { recursive: true });
      fs.mkdirSync(path.join(tc, 'jdk'), { recursive: true });
      fs.writeFileSync(path.join(tc, 'settings.json'), '{}');

      const { out, status } = run(tc, base);

      expect(out, 'a packaged editor is running on this machine — quit it and re-run').not.toMatch(RUNNING);
      expect(status).toBe(0);
      expect(out).not.toContain('REFUSING to run');
      expect(out).toContain(`would remove ${tc}`);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('ACCEPTS an empty toolchain dir, and one that does not exist', () => {
    const base = makeFixtureRoot('cpc-emptytc-');
    try {
      const empty = path.join(base, 'empty-tc');
      fs.mkdirSync(empty, { recursive: true });
      expect(run(empty, base).status).toBe(0);

      // Absent: `readdir` throws, and absence is not evidence of a foreign directory.
      expect(run(path.join(base, 'no-such-dir'), base).status).toBe(0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  /** ⚠️ **THE SCOPING, covered by a POSITIVE CONTROL rather than by a count.**
   *
   *  The check must apply to the toolchain candidates and to NOTHING else: the others (packaged
   *  userData, the Chromium cache, the install dir) are paths the script derives itself, not a
   *  user-supplied free path, so asking "does this look like a toolchain?" of them is a category
   *  error — and would refuse a run over a userData dir that legitimately holds anything at all.
   *
   *  The first version of this cover asserted the refusal named `1 toolchain candidate(s)`. **That
   *  could not fail**: removing the `toolchainRoot` filter left it green, because in the hermetic
   *  sandbox the other candidates do not exist, so `readdir` throws for them and they contribute
   *  nothing either way. Caught by mutation-checking the filter. What discriminates is building a
   *  non-toolchain candidate that DOES exist and DOES hold foreign entries, then proving the run
   *  ignores it — with the "would remove" line as the control that it really was on the list, so
   *  this cannot pass by the candidate being absent again. */
  it('applies to TOOLCHAIN candidates only — a foreign-looking userData dir is not its business', () => {
    const base = makeFixtureRoot('cpc-scope-');
    try {
      const tc = path.join(base, 'modoki-toolchain');
      fs.mkdirSync(path.join(tc, 'node'), { recursive: true });

      // A NON-toolchain candidate, holding exactly what would trip the guard if it were in scope.
      // `<appSupportRoot>/modoki-app` is the "legacy pre-rename userData" entry — a literal in
      // `targets()` on every platform, so this is derived, not guessed.
      const legacyUserData = path.join(appSupportRootUnder(base), 'modoki-app');
      fs.mkdirSync(path.join(legacyUserData, 'Documents'), { recursive: true });
      fs.mkdirSync(path.join(legacyUserData, 'Desktop'), { recursive: true });

      const { out, status } = run(tc, base);

      expect(out, 'a packaged editor is running on this machine — quit it and re-run').not.toMatch(RUNNING);
      // The control: it really is a candidate. Without this the case passes when it is absent —
      // which is precisely how the version this replaced managed to survive its own mutation.
      expect(out, 'the non-toolchain candidate was not on the list, so this proves nothing')
        .toContain(`would remove ${legacyUserData}`);
      expect(status).toBe(0);
      expect(out).not.toContain('REFUSING to run');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
