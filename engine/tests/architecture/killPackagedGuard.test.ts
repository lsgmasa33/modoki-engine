/** Guard: `packagedAppPaths.killPackaged` refuses to build a `pkill -f` pattern from an
 *  empty/implausibly-short appDir (#69 follow-up — sibling to reapScoping.test.ts).
 *
 *  `reapScoping.test.ts` scans SOURCE TEXT for `pkill -f "..."` and can require the
 *  bash-only `${VAR:?msg}` fail-if-empty form. That scan cannot see this file's call —
 *  `execFileSync('pkill', ['-f', pattern], ...)` builds `pattern` from a JS variable, not a
 *  shell expansion — so this is the JS-side equivalent: a runtime test that proves an
 *  empty/short `appDir` throws BEFORE `pkill` is ever invoked, instead of silently falling
 *  back to a pattern (`/Contents/MacOS`) that would match every clone's Electron process on
 *  this machine. Mocks `node:child_process` so the assertion is "pkill was never called",
 *  not just "the function threw" — a guard that threw AFTER already calling pkill would be
 *  worthless. */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { killPackaged, altPathSpelling, REAP_KILLED, REAP_NONE, REAP_ERROR, productName } from '../../scripts/packagedAppPaths.mjs';

vi.mock('node:child_process', () => {
  const execFileSyncMock = vi.fn();
  return { execFileSync: execFileSyncMock, default: { execFileSync: execFileSyncMock } };
});

describe.skipIf(process.platform === 'win32')('packagedAppPaths.killPackaged refuses an empty/short appDir', () => {
  // this guard, and the mocked pattern assertions below, are POSIX-only (see the source comment
  // in killPackaged) — Windows goes through PowerShell + Win32_Process.ExecutablePath, a
  // different code path entirely (covered by packagedAppPaths.test.ts).
  beforeEach(() => {
    vi.mocked(execFileSync).mockClear();
  });

  it('throws and never calls execFileSync for an empty or too-short appDir', () => {
    expect(() => killPackaged('')).toThrow(/refusing to reap with an empty\/short appDir/);
    expect(() => killPackaged('/a')).toThrow(/refusing to reap with an empty\/short appDir/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('still allows a deliberately omitted appDir (the machine-wide packaged fallback)', () => {
    expect(() => killPackaged(undefined, 'Modoki Editor')).not.toThrow();
    // Anchored to the BUNDLE PATH, never the bare product name — see the next test for why.
    expect(execFileSync).toHaveBeenCalledWith('pkill', ['-f', 'Modoki Editor.app/Contents/'], { stdio: 'ignore' });
  });

  it('accepts a plausible full appDir and builds a bundle-scoped pattern', () => {
    const appDir = '/tmp/modoki-pkg-test-modoki-ai/mac-arm64/Modoki Editor.app';
    expect(() => killPackaged(appDir)).not.toThrow();
    expect(execFileSync).toHaveBeenCalledWith('pkill', ['-f', `${appDir}/Contents/`], { stdio: 'ignore' });
  });

  /**
   * REGRESSION (2026-08-01): the no-appDir fallback used to be the bare product name, and it was
   * MEASURED killing dev editors — the direct cause of the repeated
   * `CHILD PROCESS GONE ... reason=killed exitCode=15` deaths in /tmp/modoki-editor-5180.log.
   *
   * The mechanism is not obvious, which is why it survived #69: Electron passes the APP NAME to
   * every child process in `--user-data-dir`, so `pkill -f "Modoki Editor"` matches a DEV
   * editor's GPU/network/audio helpers on EVERY clone — while missing the dev MAIN process,
   * whose command line has no user-data-dir. Hence the signature that made it look like a GPU
   * fault: the helpers die, the main process survives and logs the deaths with nothing to blame.
   *
   * These are real `ps -Ao command` lines captured from this machine, not hand-written
   * approximations — the bug lives in the exact text Electron produces, so a paraphrase could
   * pass while the real thing still matched.
   */
  const DEV_HELPER_CMDLINES = [
    '/Users/x/Projects/modoki-ai/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper --type=gpu-process --user-data-dir=/Users/x/Library/Application Support/Modoki Editor (dev)/913be5b9',
    '/Users/x/Projects/modoki-ai/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper --type=utility --utility-sub-type=network.mojom.NetworkService --user-data-dir=/Users/x/Library/Application Support/Modoki Editor (dev)/913be5b9',
  ];
  const PACKAGED_CMDLINES = [
    '/tmp/modoki-pkg/mac-arm64/Modoki Editor.app/Contents/MacOS/Modoki Editor',
    '/tmp/modoki-pkg/mac-arm64/Modoki Editor.app/Contents/Frameworks/Modoki Editor Helper.app/Contents/MacOS/Modoki Editor Helper --type=gpu-process',
  ];

  it('the machine-wide fallback pattern cannot match a DEV editor process', () => {
    killPackaged(undefined, 'Modoki Editor');
    const pattern = vi.mocked(execFileSync).mock.calls.at(-1)?.[1]?.[1] as string;
    // `pkill -f` is a substring/regex match over the full command line.
    for (const cmd of DEV_HELPER_CMDLINES) {
      expect(cmd.includes(pattern), `dev helper must NOT match ${pattern}:\n${cmd}`).toBe(false);
    }
    // …and it must still do its actual job.
    for (const cmd of PACKAGED_CMDLINES) {
      expect(cmd.includes(pattern), `packaged process MUST match ${pattern}:\n${cmd}`).toBe(true);
    }
  });

  it('sanity: productName() still resolves through the mocked module', () => {
    expect(typeof productName()).toBe('string');
  });
});

/** #959 — the SECOND SPELLING. `killPackaged`'s appDir is caller-supplied by five scripts, and a
 *  clone (or a temp dir) reached through a symlink puts one spelling in our pattern while the
 *  process we are hunting carries the other in its argv. `repo-reap.sh` solved this for the bash
 *  reaps by matching a SET of spellings; this is the same contract in JS.
 *
 *  ⚠️ **The symlink is MANUFACTURED**, exactly as in `repoReapSpellings.test.ts`: no clone on this
 *  machine is reached through one, so a test using ordinary paths would pass with the mechanism
 *  deleted — this repo's dominant defect class.
 *
 *  ⚠️ **The base is `realpathSync.native(os.tmpdir())`, not `os.tmpdir()`.** On macOS the temp dir
 *  is ITSELF reached through a symlink (`/var` → `/private/var`), so a control built on the raw
 *  value would find a second spelling it did not create and assert the opposite of what it means.
 *
 *  ⚠️ **Nothing here can reach a real process**: `node:child_process` is mocked at the top of this
 *  file, so every `pkill` below is a recorded call, not an executed one. */
describe.skipIf(process.platform === 'win32')('killPackaged matches BOTH spellings of an appDir (#959)', () => {
  let base: string;
  let dirs: string[] = [];

  beforeEach(() => {
    vi.mocked(execFileSync).mockClear();
    vi.mocked(execFileSync).mockReturnValue(undefined as never);
    base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'modoki-killpkg-'));
    dirs.push(base);
  });

  afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  /** A real app dir plus a symlinked route to it. Returns both spellings of the SAME app dir. */
  function symlinkedApp() {
    const real = path.join(base, 'real');
    const app = path.join(real, 'mac-arm64', 'Modoki Editor.app');
    fs.mkdirSync(app, { recursive: true });
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link, 'dir');
    return { viaLink: path.join(link, 'mac-arm64', 'Modoki Editor.app'), viaReal: app };
  }

  const patterns = () => vi.mocked(execFileSync).mock.calls.map((c) => (c[1] as string[])[1]);

  it('reaps the LINK spelling AND the real one when handed the link', () => {
    const { viaLink, viaReal } = symlinkedApp();
    killPackaged(viaLink);
    expect(patterns()).toEqual([`${viaLink}/Contents/`, `${viaReal}/Contents/`]);
  });

  it('as TWO invocations, never an ERE alternation (#69)', () => {
    const { viaLink } = symlinkedApp();
    killPackaged(viaLink);
    // `pkill -f` takes an ERE: a single pattern joining the two with "|" would match every
    // process on the machine the moment either side were empty. Two calls cannot do that.
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(2);
    for (const p of patterns()) expect(p).not.toContain('|');
  });

  it('CONTROL: a path with no symlink in it reaps ONCE', () => {
    const app = path.join(base, 'plain', 'mac-arm64', 'Modoki Editor.app');
    fs.mkdirSync(app, { recursive: true });
    killPackaged(app);
    expect(patterns()).toEqual([`${app}/Contents/`]);
  });

  it('CONTROL: a NONEXISTENT appDir reaps once — an unresolvable path yields no second spelling', () => {
    // The common case when there is nothing to reap anyway. `realpathSync.native` throws here,
    // and the catch must yield NOTHING rather than falling back to something broader.
    const app = path.join(base, 'gone', 'mac-arm64', 'Modoki Editor.app');
    killPackaged(app);
    expect(patterns()).toEqual([`${app}/Contents/`]);
  });

  it('the ALTERNATE spelling clears the same width guard as the argument', () => {
    // A 40-char appDir can be a symlink to a very short real path, and the empty/short check only
    // ever saw the ARGUMENT — so an unchecked alternate slipped a pattern past the one guard whose
    // stated contract is that every branch here guards against WIDENING the match.
    //
    // `realpathSync.native` is stubbed rather than staged on disk: producing a genuinely <10-char
    // ABSOLUTE real path means writing outside the temp root, which a test must not do. The stub
    // is of the resolver, not of the guard under test.
    const app = path.join(base, 'widthguard', 'mac-arm64', 'Modoki Editor.app');
    fs.mkdirSync(app, { recursive: true });
    const spy = vi.spyOn(fs.realpathSync, 'native').mockReturnValue('/m/x');
    try {
      killPackaged(app);
      // Exactly ONE reap: the argument's. The 4-char alternate is dropped, not reaped.
      expect(patterns()).toEqual([`${app}/Contents/`]);
      expect(patterns().some((p) => p.startsWith('/m/x')), 'a 4-char real path became a reap pattern').toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('CONTROL: the machine-wide fallback (no appDir) stays a single reap', () => {
    killPackaged(undefined, 'Modoki Editor');
    expect(patterns()).toEqual(['Modoki Editor.app/Contents/']);
  });

  describe('altPathSpelling — every branch yields NOTHING rather than something wider', () => {
    it('returns null for an empty or non-string path', () => {
      expect(altPathSpelling('')).toBeNull();
      expect(altPathSpelling(undefined)).toBeNull();
    });

    it('returns null when the path does not resolve', () => {
      expect(altPathSpelling(path.join(base, 'no-such-thing'))).toBeNull();
    });

    it('returns null when the spellings are identical', () => {
      const d = path.join(base, 'same');
      fs.mkdirSync(d, { recursive: true });
      expect(altPathSpelling(d)).toBeNull();
    });

    it('returns the real spelling when they differ', () => {
      const real = path.join(base, 'r2');
      fs.mkdirSync(real, { recursive: true });
      const link = path.join(base, 'l2');
      fs.symlinkSync(real, link, 'dir');
      expect(altPathSpelling(link)).toBe(real);
    });
  });
});

/** #944's half — a reap that cannot say what it did. `pkill` has THREE exit states and they all
 *  used to land in one silent `catch`, which is why every bash caller appends `|| true` and the
 *  silence became structural. */
describe.skipIf(process.platform === 'win32')('killPackaged reports its outcome (#944)', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockClear();
  });

  const failWith = (status: unknown) => {
    vi.mocked(execFileSync).mockImplementation(() => {
      const e = new Error('pkill') as Error & { status?: unknown };
      e.status = status;
      throw e;
    });
  };

  it('KILLED when pkill exits 0 — it matched and signalled', () => {
    vi.mocked(execFileSync).mockReturnValue(undefined as never);
    expect(killPackaged(undefined, 'Modoki Editor')).toBe(REAP_KILLED);
  });

  it('NONE when pkill exits 1 — the normal "nothing running" case', () => {
    failWith(1);
    expect(killPackaged(undefined, 'Modoki Editor')).toBe(REAP_NONE);
  });

  it('ERROR when pkill exits 2 — a usage error must NOT read as "nothing was running"', () => {
    // This is the state the single catch erased. `exit 0` is still right for the caller, but the
    // caller has to be able to TELL, or a reap that never ran looks exactly like a clean one.
    failWith(2);
    expect(killPackaged(undefined, 'Modoki Editor')).toBe(REAP_ERROR);
  });

  it('ERROR when pkill is missing entirely (no numeric status)', () => {
    failWith(undefined);
    expect(killPackaged(undefined, 'Modoki Editor')).toBe(REAP_ERROR);
  });

  it('an ERROR on either spelling is never masked by a success on the other', () => {
    const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'modoki-killpkg-o-'));
    try {
      const real = path.join(base, 'real', 'mac-arm64', 'Modoki Editor.app');
      fs.mkdirSync(real, { recursive: true });
      fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'), 'dir');
      let n = 0;
      vi.mocked(execFileSync).mockImplementation(() => {
        if (++n === 1) return undefined as never; // first spelling: killed
        const e = new Error('pkill') as Error & { status?: unknown };
        e.status = 2; // second spelling: usage error
        throw e;
      });
      expect(killPackaged(path.join(base, 'link', 'mac-arm64', 'Modoki Editor.app'))).toBe(REAP_ERROR);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});


/** Close-out review findings, pinned. Each of these was CONFIRMED against the running code, and
 *  each is a way the #944 half of the fix reached nobody. */
describe('the reap outcome actually reaches a consumer (#944 close-out)', () => {
  // Through the shared reader, and STRIPPED. That matters here rather than being ceremony: the
  // source's own comments discuss `console.error`/`FAILED to reap` at length (they explain this
  // very defect), so a raw scan would find a COMMENT before the code and assert on prose (#812).
  const cliSource = readScannedSource(
    path.resolve(__dirname, '../../scripts/packagedAppPaths.mjs'), { language: 'js' },
  ).code;

  it('the ERROR verdict is printed on stdout, not a stream every caller mutes', () => {
    // MEASURED: all five bash callers invoke this as `node "$PATHS" kill … 2>/dev/null || true`,
    // so an alarm on stderr is discarded by every consumer that exists — the two HARMLESS
    // outcomes printed and the one that matters did not. A text scan, because the alternative is
    // spawning the CLI with pkill removed from PATH, which is not portable in-suite.
    const line = cliSource.split('\n').find((l) => l.includes('FAILED to reap'));
    expect(line, 'the ERROR branch disappeared').toBeDefined();
    expect(
      line,
      'the reap ERROR must go to stdout — every bash caller redirects stderr to /dev/null, so '
        + 'console.error here makes the whole reporting half of #944 a no-op',
    ).toMatch(/console\.log/);
  });

  it('every bash caller still mutes stderr — the premise of the rule above', () => {
    // Anti-vacuity: if a future change dropped `2>/dev/null` from the call sites, the rule above
    // would be defending a constraint that no longer applies, and should be revisited rather
    // than silently kept.
    const scripts = ['test-packaged.sh', 'smoke-packaged.sh', 'assert-app-renders.sh', 'repro-cold-boot.sh']
      .map((f) => path.resolve(__dirname, '../../scripts', f))
      .filter((f) => fs.existsSync(f));
    const callers = scripts.flatMap((f) => readScannedSource(f, { language: 'shell' }).code
      .split('\n').filter((l) => /\$PATHS" kill/.test(l)));
    expect(callers.length, 'no `$PATHS kill` call sites found — this rule lost its subject').toBeGreaterThan(0);
    for (const c of callers) expect(c).toContain('2>/dev/null');
  });
});

describe('the Windows branch decodes its OWN exit codes (#944 close-out)', () => {
  it('does not route PowerShell through pkill’s vocabulary', () => {
    // CONFIRMED defect: one shared catch served both branches and mapped `status === 1` to
    // REAP_NONE. `powershell.exe -Command` exits 1 on a TERMINATING error (WMI unavailable,
    // access denied), so a Windows reap that failed outright reported "nothing running" — the
    // exact silence #944 exists to remove, on the branch that had just gained the count.
    const src = readScannedSource(
      path.resolve(__dirname, '../../scripts/packagedAppPaths.mjs'), { language: 'js' },
    ).code;
    const win = src.slice(src.indexOf("if (process.platform === 'win32')"), src.indexOf('const pattern ='));
    expect(win, 'the win32 branch must catch and decode for itself').toMatch(/catch\s*\{[^}]*REAP_ERROR/);
    expect(win, 'an unparseable count is an ERROR, never an empty match').toMatch(/Number\.isFinite/);
  });
});
