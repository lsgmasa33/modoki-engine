/** The live-packaged-editor predicate (#1037) — `engine/scripts/livePackagedEditor.mjs`.
 *
 *  The pure half is unit-tested here rather than driven through the CLI, because the case that
 *  MATTERS cannot be produced on demand any other way: "a process exists whose argv merely mentions
 *  the bundle path". That is the case the old `pgrep -f` predicate got wrong, it fired on four
 *  clones' `verify` runs, and nothing in the suite built it — the failures were only ever observed
 *  as flakes. A decoy row is the whole point.
 *
 *  ⚠️ **WHAT THIS FILE DOES NOT COVER, stated because the gap is on the dangerous side.** Every row
 *  here is synthetic, so nothing proves `listProcesses` SURFACES a real packaged editor in the
 *  shape `isPackagedExecutable` expects — and that is the direction whose failure deletes a live
 *  app's state rather than merely refusing a wipe. What was checked by hand instead (2026-09-10):
 *
 *   - `listProcesses()` against this machine's real `ps`: **845 rows, 0 malformed, 843 joined to
 *     their command by pid**, including executable paths containing spaces (the parse hazard the
 *     two-query join exists for).
 *   - The accept side end-to-end, with a live decoy carrying the bundle path in its argv:
 *     `pgrep -f` matches it and would refuse; this predicate returns 0 blockers.
 *   - The exe path a REAL packaged smoke reports, quoted from the hub's own capture on #1037
 *     (`…/modoki-pkg-smoke-modoki-qa/mac-arm64/Modoki Editor.app/Contents/MacOS/Modoki Editor`),
 *     matches the `/${NAME}.app/Contents/` anchor.
 *
 *  A genuine end-to-end reject case does NOT need a signed bundle after all (2026-09-11): a copied
 *  system binary will not run under macOS code signing (tried, twice), but macOS `ps -o comm=`
 *  reports `argv[0]`, so `node` spawned with `argv0` set to a bundle path IS a packaged editor to
 *  `listProcesses`. `cleanPackagedCacheLinkGuard.test.ts` now drives both sides that way through the
 *  real CLI (darwin only).
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  userDataDirCandidatesFromCommand, isPackagedExecutable, blockingEditors, listProcesses, findBlockingEditors,
  sharedStatePaths, stagingRoots, editorHomeDir,
} from '../../scripts/livePackagedEditor.mjs';

/** #1037 reopened — the input `defaultUserData` is derived from. Asked in a CHILD carrying a
 *  redirected `$HOME`, because that redirect is the whole subject and this worker's env is shared. */
describe('editorHomeDir — the EDITOR\'s home, not this process\'s $HOME (#1037)', () => {
  function inChildWithHome(home: string): { darwin: string; linux: string } {
    const mod = pathToFileURL(path.resolve(__dirname, '../../scripts/livePackagedEditor.mjs')).href;
    const code = `import(${JSON.stringify(mod)}).then((m) => process.stdout.write(JSON.stringify({ darwin: m.editorHomeDir('darwin'), linux: m.editorHomeDir('linux') })))`;
    return JSON.parse(execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, HOME: home } }));
  }

  /** Electron on darwin reports the passwd home under `HOME=/tmp/fakehome` (measured with the dev
   *  binary, `app.getPath('home'|'appData')`). Mutation-checked: `return os.homedir()` on darwin
   *  turns this red. */
  // Skipped as ROOT: there the darwin branch deliberately follows $HOME (next case), so this one's
  // premise — the passwd home wins — does not apply to a root runner.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('ignores a redirected $HOME on darwin, as Electron does — and honours it on linux, as Chromium does there', () => {
    const got = inChildWithHome('/tmp/cpc-fake-home');
    expect(got.darwin).toBe(os.userInfo().homedir);
    expect(got.linux).toBe('/tmp/cpc-fake-home');
  });

  /** Close-out review of #1037: under `sudo -E` the script is uid 0 with `$HOME` still the user's, so
   *  the passwd home is `/var/root` and a live editor's state would be attributed away from every
   *  candidate — failing OPEN, through BOTH `editorHomeDir` and `sharedStatePaths`.
   *
   *  ⚠️ Root is faked by replacing `process.getuid` in the child and calling with NO `uid` argument —
   *  the path `clean-packaged-cache.mjs` actually takes. The first version passed `uid: 0` explicitly,
   *  and the scoped review showed `uid = process.getuid` (never called, so never `=== 0`) left it
   *  green while the CLI's own call failed open. Mutation-checked: that default, and dropping the
   *  root branch of `invokingUserHome`, each redden this. */
  it.skipIf(process.platform === 'win32')('as ROOT (default uid), both derivations follow $HOME — sudo -E must not fail open', () => {
    const mod = pathToFileURL(path.resolve(__dirname, '../../scripts/livePackagedEditor.mjs')).href;
    const code = `process.getuid = () => 0; import(${JSON.stringify(mod)}).then((m) => process.stdout.write(JSON.stringify({ home: m.editorHomeDir('darwin'), shared: m.sharedStatePaths('com.example.app', 'Modoki Editor', 'darwin') })))`;
    const got = JSON.parse(execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, HOME: '/tmp/cpc-invoking-user-home' } }));
    expect(got.home).toBe('/tmp/cpc-invoking-user-home');
    expect(got.shared.length).toBeGreaterThan(0);
    for (const p of got.shared) expect(p.startsWith('/tmp/cpc-invoking-user-home/')).toBe(true);
  });

  it('is this process\'s home when $HOME is not redirected — production is unchanged', () => {
    if (process.platform === 'darwin') expect(editorHomeDir('darwin')).toBe(os.homedir());
    expect(editorHomeDir('linux')).toBe(os.homedir());
  });
});

const NAME = 'Modoki Editor';
const SUPPORT = '/Users/dev/Library/Application Support';
const DEFAULT_UD = path.join(SUPPORT, NAME);
const CANDIDATES = [DEFAULT_UD, '/Users/dev/Library/Caches/com.modokiengine.editor'];
const opts = { productName: NAME, candidates: CANDIDATES, defaultUserData: DEFAULT_UD, platform: 'darwin' };

/** A real packaged editor's main process: runs from the bundle, no `--user-data-dir`. */
const REAL = {
  pid: 1,
  exe: `/Applications/${NAME}.app/Contents/MacOS/${NAME}`,
  command: `/Applications/${NAME}.app/Contents/MacOS/${NAME}`,
};

describe('#1037 — argv is not evidence that an editor is running', () => {
  /** ⚠️ THE case. Three observed shapes, one predicate: a shell heredoc quoting the path, a grep
   *  looking for it, and — the self-reinforcing one — the `pgrep` a human types to debug this very
   *  issue. None of them is an editor, and `pgrep -f` counted all three. */
  it.each([
    ['a shell running a heredoc that quotes the path',
      `/bin/zsh -c cat > /tmp/c.md <<'EOF'\n… ${NAME}.app/Contents/MacOS … \nEOF`],
    ['a grep looking for it', `grep -r ${NAME}.app/Contents /Users/dev/repo`],
    ['the pgrep typed to debug this issue', `pgrep -f ${NAME}.app`],
  ])('does NOT count %s', (_label, command) => {
    const rows = [{ pid: 99, exe: '/bin/zsh', command }];
    expect(blockingEditors(rows, opts)).toEqual([]);
  });

  /** The reject side, which narrowing must not cost. Without this the test above passes for a
   *  predicate stuck at "nothing ever blocks", which would delete a live editor's state. */
  it('DOES count a process executing the bundle with no --user-data-dir (the default)', () => {
    const hit = blockingEditors([REAL], opts);
    expect(hit).toHaveLength(1);
    expect(hit[0].userData).toBe(DEFAULT_UD);
  });
});

describe('#1037 — whose editor is it', () => {
  /** The sibling-clone smoke that started this: a REAL packaged binary, but pointed at its own
   *  session scratchpad. It is executing the bundle, so question 1 says yes and only question 2
   *  can save it. */
  it('does NOT block on another clone smoke, whose user-data-dir is its own scratchpad', () => {
    const rows = [{
      pid: 47551,
      exe: `/var/folders/nt/T/modoki-pkg-smoke-modoki-qa/mac-arm64/${NAME}.app/Contents/MacOS/${NAME}`,
      command: `…/${NAME} --user-data-dir=/private/tmp/claude-501/-Users-dev-modoki-qa/sess/scratchpad/ud-probe`,
    }];
    expect(blockingEditors(rows, opts)).toEqual([]);
  });

  it('DOES block when that same binary points at one of OUR candidates', () => {
    const rows = [{
      pid: 47551,
      exe: `/var/folders/nt/T/modoki-pkg-smoke-modoki-qa/mac-arm64/${NAME}.app/Contents/MacOS/${NAME}`,
      command: `…/${NAME} --user-data-dir=${DEFAULT_UD}`,
    }];
    expect(blockingEditors(rows, opts)).toHaveLength(1);
  });

  /** A fixture run under `sandboxEnv` redirects HOME, so every candidate is inside the fixture and
   *  the developer's real editor is not under any of them. This is the suite's own false red. */
  it('does NOT block a fixture-only run, even with the real editor live', () => {
    const fixture = { ...opts, candidates: ['/tmp/cpc-fixture-abc/home-ish'], defaultUserData: DEFAULT_UD };
    expect(blockingEditors([REAL], fixture)).toEqual([]);
  });

  /** The dev editor: `Electron.app`, and it mentions the product name only inside a data-dir path
   *  — precisely the string match that made the old predicate look like it covered dev, while
   *  `pgrep` could not see the dev MAIN process at all. */
  it('does NOT count a dev editor (Electron.app), whatever its data dir says', () => {
    const rows = [{
      pid: 5,
      exe: '/Users/dev/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      command: `Electron --user-data-dir=${SUPPORT}/${NAME} (dev)/abc123`,
    }];
    expect(blockingEditors(rows, opts)).toEqual([]);
  });
});

/** Close-out review finding 1. Four of the nine darwin candidates are keyed on the BUNDLE ID —
 *  `Preferences/<appId>.plist`, `HTTPStorages/<appId>`, `Caches/<appId>`, `Saved Application
 *  State/<appId>.savedState` — and every clone's build carries the same appId, so a live packaged
 *  editor holds them whatever `--user-data-dir` it was launched with. A userData-only identity test
 *  hands them to the delete while a sibling's smoke is using them, and `--force` never even warns
 *  because it sees zero blockers. */
describe('#1037 — bundle-id-scoped state is held regardless of --user-data-dir', () => {
  const SHARED = ['/Users/dev/Library/Caches/com.modokiengine.editor'];
  const FOREIGN = {
    pid: 47551,
    exe: `/var/folders/nt/T/modoki-pkg-smoke-modoki-qa/mac-arm64/${NAME}.app/Contents/MacOS/${NAME}`,
    command: `…/${NAME} --user-data-dir=/private/tmp/sess/scratchpad/ud-probe`,
  };

  it('BLOCKS a foreign-userData editor when a candidate is shared bundle-id state', () => {
    const withShared = { ...opts, candidates: SHARED, sharedStatePaths: SHARED };
    expect(blockingEditors([FOREIGN], withShared)).toHaveLength(1);
  });

  /** The control, and the reason this cannot just block always: a SANDBOXED run redirects HOME, so
   *  its candidates sit under a fixture and match none of the real shared paths. The caller
   *  resolves `sharedStatePaths` against `os.userInfo().homedir`, which ignores `$HOME` — that
   *  difference is the entire mechanism, and without it the guard suite goes red again. */
  it('does NOT block when the candidates are a sandbox fixture, not the real shared paths', () => {
    const sandboxed = { ...opts, candidates: ['/tmp/cpc-fixture-abc/Library/Caches/com.modokiengine.editor'], sharedStatePaths: SHARED };
    expect(blockingEditors([FOREIGN], sandboxed)).toEqual([]);
  });
});

/** Close-out review finding 4. Electron passes `--user-data-dir` to helpers but not to the main
 *  process, and `chrome_crashpad_handler` never gets one — so defaulting every flagless in-bundle
 *  process to OUR userData lets one helper inside a sibling's staged smoke bundle re-create the
 *  exact false red this module exists to remove. */
describe('#1037 — a flagless helper inside a STAGED bundle is not this installation', () => {
  const STAGING = ['/var/folders/nt/T'];
  const HELPER = {
    pid: 47552,
    exe: `/var/folders/nt/T/modoki-pkg-smoke-modoki-qa/mac-arm64/${NAME}.app/Contents/Frameworks/chrome_crashpad_handler`,
    command: `chrome_crashpad_handler --database=/var/folders/nt/T/crashpad`,
  };

  it('does NOT block — the staged copy is a smoke, not this machine\'s install', () => {
    expect(blockingEditors([HELPER], { ...opts, stagingRoots: STAGING })).toEqual([]);
  });

  /** The control: the SAME flagless shape outside a staging root is the real installed editor, and
   *  it must still block. Narrowing must not cost the reject side. */
  it('still blocks a flagless in-bundle process that is NOT staged', () => {
    const installed = { ...HELPER, exe: `/Applications/${NAME}.app/Contents/Frameworks/chrome_crashpad_handler` };
    expect(blockingEditors([installed], { ...opts, stagingRoots: STAGING })).toHaveLength(1);
  });
});

/** ⚠️ **THE SEAM, and the case both earlier rounds of tests could not see.**
 *
 *  Every other case in this file constructs `opts` by hand, and the close-out review found that
 *  shape is one the CLI never produces: with `sharedStatePaths` populated the way
 *  `clean-packaged-cache.mjs` populates it, the shared-state branch was true for EVERY packaged
 *  process on a real Mac — so a sibling clone's smoke blocked this clone's run, which is #1037
 *  restored by its own fix, and the staging exemption added in the same commit could never fire.
 *  Both unit suites stayed green throughout.
 *
 *  So these cases use the REAL builders (`sharedStatePaths`, `stagingRoots` — exported for exactly
 *  this reason) against a realistic candidate list, i.e. the options the caller actually builds. */
describe('#1037 — driven with the options clean-packaged-cache actually builds', () => {
  const APP_ID = 'com.modokiengine.editor';
  const realHome = os.userInfo().homedir;
  /** What `targets()` produces on a real (non-sandboxed) darwin run: userData plus the
   *  bundle-id-keyed paths. */
  const realRunOpts = {
    productName: NAME,
    candidates: [
      path.join(realHome, 'Library', 'Application Support', NAME),
      path.join(realHome, 'Library', 'Caches', APP_ID),
      path.join(realHome, 'Library', 'Preferences', `${APP_ID}.plist`),
    ],
    defaultUserData: path.join(realHome, 'Library', 'Application Support', NAME),
    platform: 'darwin' as const,
    sharedStatePaths: sharedStatePaths(APP_ID, NAME, 'darwin'),
    stagingRoots: stagingRoots(),
  };
  const staged = path.join(os.tmpdir(), 'modoki-pkg-smoke-modoki-qa', 'mac-arm64');

  it('does NOT block a sibling clone\'s staged smoke MAIN process', () => {
    const rows = [{
      pid: 47551,
      exe: path.join(staged, `${NAME}.app`, 'Contents', 'MacOS', NAME),
      command: `${NAME} --user-data-dir=${path.join(os.tmpdir(), 'modoki-smoke-userdata-modoki-qa')}`,
    }];
    expect(blockingEditors(rows, realRunOpts)).toEqual([]);
  });

  it('does NOT block a sibling clone\'s staged crashpad HELPER, which carries no data dir', () => {
    const rows = [{
      pid: 47552,
      exe: path.join(staged, `${NAME}.app`, 'Contents', 'Frameworks', 'chrome_crashpad_handler'),
      command: `chrome_crashpad_handler --database=${path.join(os.tmpdir(), 'crashpad')}`,
    }];
    expect(blockingEditors(rows, realRunOpts)).toEqual([]);
  });

  /** The reject side under the same real options — without it, "never block" passes both cases
   *  above. An INSTALLED editor holds the bundle-id-keyed caches whatever its data dir. */
  it('DOES block the installed editor, flagless, under those same options', () => {
    const rows = [{
      pid: 1,
      exe: `/Applications/${NAME}.app/Contents/MacOS/${NAME}`,
      command: `/Applications/${NAME}.app/Contents/MacOS/${NAME}`,
    }];
    expect(blockingEditors(rows, realRunOpts)).toHaveLength(1);
  });

  /** …and an installed editor pointed at a FOREIGN data dir still blocks, because the bundle-id
   *  paths are not its data dir's to move. This is the half the userData-only model got wrong. */
  it('DOES block the installed editor even with a foreign --user-data-dir', () => {
    const rows = [{
      pid: 2,
      exe: `/Applications/${NAME}.app/Contents/MacOS/${NAME}`,
      command: `${NAME} --user-data-dir=/tmp/somewhere-else`,
    }];
    expect(blockingEditors(rows, realRunOpts)).toHaveLength(1);
  });
});

describe('userDataDirCandidatesFromCommand', () => {
  it.each([
    ['--user-data-dir=/a/b', '/a/b'],
    ['--user-data-dir /a/b', '/a/b'],
    ['--user-data-dir="/a/b c"', '/a/b c'],
    ["--user-data-dir='/a/b c'", '/a/b c'],
  ])('reads %s', (cmd, want) => {
    expect(userDataDirCandidatesFromCommand(`app ${cmd} --other`)).toContain(want);
  });

  /** ⚠️ `[]`, NOT `['']` — absence means "falls back to the platform default", and a caller that
   *  read it as "no state" would let the developer's own editor through. */
  it.each([
    ['absent', 'app --enable-features=X'],
    ['present with no value', 'app --user-data-dir --enable-features=X'],
    ['empty', 'app --user-data-dir=""'],
  ])('returns [] when the flag is %s — which means "the default", not "no state"', (_l, cmd) => {
    expect(userDataDirCandidatesFromCommand(cmd)).toEqual([]);
  });

  /** ⚠️ THE close-out review finding, and every one of these failed OPEN before the fix: the
   *  over-long reading resolved outside every candidate, so a live editor holding the DEFAULT
   *  userData read as "not ours" and its state was deleted. `ps` joins argv with spaces and the
   *  macOS default contains two, so no parser can pick the right reading — it has to offer both. */
  it.each([
    ['a trailing positional', `--user-data-dir=${DEFAULT_UD} /Users/dev/projects/court`],
    ['a trailing non-"--" flag', `--user-data-dir=${DEFAULT_UD} -psn_0_12345`],
  ])('offers the spaces-containing path as a reading when followed by %s', (_l, tail) => {
    expect(userDataDirCandidatesFromCommand(`app ${tail}`)).toContain(DEFAULT_UD);
  });

  /** Chromium honours the LAST occurrence, so an earlier one is a path this process is not using. */
  it('takes the last --user-data-dir, not the first', () => {
    const got = userDataDirCandidatesFromCommand(`app --user-data-dir=/tmp/first --foo --user-data-dir=${DEFAULT_UD}`);
    expect(got).toContain(DEFAULT_UD);
    expect(got).not.toContain('/tmp/first');
  });
});

/** The same shapes, through the predicate — because "offers a reading" only matters if it BLOCKS. */
describe('#1037 — an ambiguous command line fails CLOSED', () => {
  it.each([
    ['a trailing positional', `${DEFAULT_UD} /Users/dev/projects/court`],
    ['a trailing non-"--" flag', `${DEFAULT_UD} -psn_0_12345`],
  ])('still blocks when the default userData is followed by %s', (_l, tail) => {
    const rows = [{ ...REAL, command: `${REAL.exe} --user-data-dir=${tail}` }];
    expect(blockingEditors(rows, opts)).toHaveLength(1);
  });
});

describe('listProcesses — an unreadable table is not an empty one', () => {
  /** ⚠️ `null`, not `[]`. The one caller deletes things, and `[]` reads as "nothing is running" —
   *  the exact silence `packagedAppPaths.mjs` had to remove for its win32 reap (#944).
   *
   *  ⚠️ The FIRST version of this case asserted on a bogus platform string, which falls through to
   *  the posix branch, runs `ps` successfully and returns rows — it passed without ever reaching
   *  the catch. Forcing the spawn to throw is the only way in. */
  it('returns null when the spawn genuinely fails — not an empty list', () => {
    // ⚠️ No mock. `vi.doMock` on a node builtin does not take here (`resetModules` does not reset
    // builtins, so the fresh import still got the real `execFileSync`), and a mock of the thing
    // under test would be proving the mock anyway. Emptying PATH makes the real `ps` spawn throw
    // ENOENT, which is the actual catch this contract is about.
    const old = process.env.PATH;
    try {
      process.env.PATH = '';
      expect(listProcesses('darwin')).toBeNull();
      expect(findBlockingEditors({ ...opts, candidates: CANDIDATES })).toBeNull();
    } finally {
      process.env.PATH = old;
    }
  });

  /** The control: on THIS machine the enumeration really works, so `null` above means the throw
   *  and not a module that cannot enumerate at all. */
  it('returns real rows on this machine — so the null above is the throw, not a broken module', () => {
    const rows = listProcesses();
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThan(10);
  });
});

describe('isPackagedExecutable', () => {
  it('anchors to the bundle, not the basename — a same-named binary elsewhere is not it', () => {
    expect(isPackagedExecutable(`/tmp/${NAME}`, NAME, 'darwin')).toBe(false);
    expect(isPackagedExecutable(`/x/${NAME}.app/Contents/MacOS/${NAME}`, NAME, 'darwin')).toBe(true);
  });

  it('matches a HELPER inside the bundle too — they hold the profile as much as the main does', () => {
    expect(isPackagedExecutable(
      `/x/${NAME}.app/Contents/Frameworks/${NAME} Helper (GPU).app/Contents/MacOS/${NAME} Helper (GPU)`,
      NAME, 'darwin',
    )).toBe(true);
  });

  it('matches the exe leaf on win32, and is case-insensitive there', () => {
    expect(isPackagedExecutable(`C:\\Users\\x\\AppData\\Local\\${NAME}\\${NAME}.exe`, NAME, 'win32')).toBe(true);
    expect(isPackagedExecutable(`C:\\x\\${NAME.toUpperCase()}.EXE`, NAME, 'win32')).toBe(true);
    expect(isPackagedExecutable(`C:\\x\\not-${NAME}.exe`, NAME, 'win32')).toBe(false);
  });
});
