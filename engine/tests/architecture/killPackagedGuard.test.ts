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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { killPackaged, productName } from '../../scripts/packagedAppPaths.mjs';

vi.mock('node:child_process', () => {
  const execFileSyncMock = vi.fn();
  return { execFileSync: execFileSyncMock, default: { execFileSync: execFileSyncMock } };
});

describe.skipIf(process.platform === 'win32')('packagedAppPaths.killPackaged refuses an empty/short appDir', () => {
  // this guard, and the mocked pattern assertions below, are POSIX-only (see the source comment
  // in killPackaged) — Windows uses `taskkill /IM <name>.exe`, a different code path entirely.
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
