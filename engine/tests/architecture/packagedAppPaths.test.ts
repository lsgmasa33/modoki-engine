/** Guard: the Windows packaged-app reap is scoped by executable PATH, never by image name.
 *
 *  `killPackaged` used to run `taskkill /F /IM "<name>.exe"` on Windows, which is machine-wide BY
 *  CONSTRUCTION — an image name cannot tell this clone's packaged app from a sibling clone's, or
 *  from the copy a user installed to `%LOCALAPPDATA%\Programs`. MEASURED 2026-08-02: a
 *  `test-packaged.sh` run killed the editor the repo owner was actively testing.
 *
 *  That is the same defect #69 fixed for macOS (`pkill -f` anchored to the bundle path rather than
 *  the product name). Windows was never covered, and `reapScoping.test.ts` could not catch it: that
 *  guard is a text scan for `pkill -f` patterns in `engine/scripts/**`, and this is a `taskkill` /
 *  PowerShell call inside a .mjs. Hence a separate guard, asserting the property directly.
 *
 *  Tests the COMMAND STRING, not an execution: proving the scoping by running it needs two live
 *  packaged instances plus the willingness to kill one, which is exactly the experiment that is
 *  expensive to get wrong. `winKillCommand` is pure so the property is checkable for free. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { winKillCommand, killPackaged, altPathSpelling, appSupportRoot, defaultToolchainDir, SHARED_DIR, binInAppDir } from '../../scripts/packagedAppPaths.mjs';
import { makeDirLink, makeFixtureRoot } from '../helpers/linkFixture';

const APP = 'C:\\Users\\dev\\AppData\\Local\\Temp\\modoki-pkg-test-modoki\\win-unpacked';
const OTHER = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Modoki Editor';

describe('winKillCommand — path-scoped, never image-name-only', () => {
  it('filters on ExecutablePath under the given appDir', () => {
    const cmd = winKillCommand(APP, 'Modoki Editor');
    expect(cmd).toContain('ExecutablePath');
    expect(cmd).toContain('StartsWith');
    expect(cmd).toContain(APP);
    // The whole point: a DIFFERENT packaged install must not be selected by this command.
    expect(cmd).not.toContain(OTHER);
  });

  /** ⚠️ **`winKillCommand` emits ONE spelling and must stay that way** (#958 close-out review).
   *
   *  A commit briefly made it OR in a second clause from `altPathSpelling`. Two things were wrong,
   *  and these cases pin both so the change cannot come back quietly:
   *
   *   1. It was REDUNDANT — `killPackaged` already loops `[appDir, alt]` and calls this once per
   *      spelling, so the set match existed. The measurement that motivated it drove this function
   *      directly, which is not how it is ever called. Measuring the wrong LEVEL is how a
   *      non-defect gets a fix.
   *   2. It BYPASSED the width guard. `killPackaged` admits the alternate only when
   *      `altRaw.length >= 10`; recomputing here skipped that, and a junction whose target is `C:\`
   *      emitted `StartsWith('C:\')` — with the Name filter, every packaged editor on the drive.
   *
   *  ⚠️ These need a REAL link on disk, because `altPathSpelling` resolves through
   *  `realpathSync.native`. A fabricated pair of strings would assert the fixture. */
  describe('one spelling per invocation, and the width guard that keeps it safe (#958)', () => {
    it('emits exactly ONE prefix even when the appDir is reached through a link', () => {
      const root = makeFixtureRoot('pkgpaths-');
      try {
        const real = path.join(root, 'win-unpacked');
        const link = path.join(root, 'via-link');
        fs.mkdirSync(real, { recursive: true });
        makeDirLink(real, link);

        const cmd = winKillCommand(link, 'Modoki Editor');
        expect(cmd).toContain(`${link}\\`);
        expect(cmd).not.toContain(`${real}\\`);
        expect(cmd).not.toContain(' -or ');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('a SHALLOW link target never reaches the emitted command — the drive-root widening', () => {
      // The concrete disaster the redundant fix enabled, pinned at the level that owns the guard.
      // `killPackaged` is what decides whether an alternate is used at all, and its rule is the
      // width check. Asserted on the DERIVATION rather than by running a reap, because proving it
      // by execution needs two packaged instances and the willingness to kill one.
      const altRaw = altPathSpelling('C:\\');
      const admitted = altRaw !== null && altRaw.length >= 10 ? altRaw : null;
      expect(altRaw === null || altRaw.length < 10).toBe(true);
      expect(admitted).toBeNull();
    });

    it('killPackaged supplies the second spelling, and only when it clears the width guard', () => {
      const root = makeFixtureRoot('pkgpaths-alt-');
      try {
        const real = path.join(root, 'a-long-enough-appdir-name-win-unpacked');
        const link = path.join(root, 'via-link-also-long-enough');
        fs.mkdirSync(real, { recursive: true });
        makeDirLink(real, link);

        // A link resolves to a distinct, long-enough spelling → the loop gets both.
        expect(altPathSpelling(link)).toBe(real);
        expect(altPathSpelling(link)!.length).toBeGreaterThanOrEqual(10);
        // A plain dir has no distinct second spelling → the loop gets one.
        expect(altPathSpelling(real)).toBeNull();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('never uses taskkill /IM, the machine-wide form it replaced', () => {
    const cmd = winKillCommand(APP, 'Modoki Editor');
    expect(cmd).not.toMatch(/\/IM\b/);
    expect(cmd.toLowerCase()).not.toContain('taskkill');
  });

  it('scopes to the app dir as a directory PREFIX, so helpers nested deeper still match', () => {
    // Equality would miss `<appDir>\<name>.exe` itself and every nested helper — the reap would
    // silently do nothing, which looks identical to "nothing was running".
    expect(winKillCommand(APP)).toContain(`${APP}\\`);
  });

  it('omitting appDir means every packaged instance — the documented clean-install case', () => {
    // clean-packaged-cache.mjs deliberately wants machine-wide here (it simulates a fresh
    // install). Still narrower than the old default: opt-in rather than the only behaviour.
    const cmd = winKillCommand(undefined, 'Modoki Editor');
    expect(cmd).not.toContain('ExecutablePath -like');
    expect(cmd).toContain('Modoki Editor.exe');
  });

  it("doubles single quotes so a path can't break out of the PowerShell literal", () => {
    const cmd = winKillCommand("C:\\it's\\app-dir-long-enough", 'Modoki Editor');
    expect(cmd).toContain("it''s");
  });

  // `-like` would read these as a character class and match NOTHING — a reap that silently does
  // nothing, indistinguishable from "nothing was running". `[` and `]` are legal in Windows paths.
  it('treats wildcard characters in the path literally, not as a pattern', () => {
    const dir = 'C:\\Temp\\modoki-pkg[1]\\win-unpacked';
    const cmd = winKillCommand(dir, 'Modoki Editor');
    expect(cmd).toContain(dir);          // embedded verbatim
    expect(cmd).not.toContain('-like');  // an exact StartsWith, not a wildcard match
    expect(cmd).toContain('StartsWith');
  });

  it('compares case-insensitively — Win32_Process reports on-disk casing, not the caller spelling', () => {
    expect(winKillCommand(APP)).toContain('OrdinalIgnoreCase');
  });

  it('collapses a trailing separator so the prefix stays exactly one directory boundary', () => {
    // Without normalising, `…\win-unpacked\` + `\` would look for `…\win-unpacked\\` and match
    // nothing; without a trailing separator at all, `…\win-unpacked` would also match a sibling
    // `…\win-unpacked-old`.
    const cmd = winKillCommand('C:\\Temp\\app-dir-here\\', 'Modoki Editor');
    expect(cmd).toContain("app-dir-here\\'");
    expect(cmd).not.toContain("app-dir-here\\\\'");
  });

  // The empty/short-appDir guard now covers win32 too. It previously did NOT (`platform !== 'win32'`),
  // which was consistent while Windows ignored appDir entirely — and became a hole the moment the
  // Windows branch started building a path filter from it: an empty string would widen `-like '\*'`
  // to match everything.
  it('refuses an empty or implausibly short appDir on every platform', () => {
    expect(() => killPackaged('')).toThrow(/refusing to reap/);
    expect(() => killPackaged('C:\\x')).toThrow(/refusing to reap/);
  });
});

/** The ONE place a hardcoded path shape is correct, because here the literal IS the specification
 *  rather than a copy of it — the same reason a golden file is legitimate where a duplicated
 *  constant is not.
 *
 *  ⚠️ **This is the leg that makes "derive, don't copy" safe, and it did not exist.** Nothing in the
 *  tree asserted what `appSupportRoot()` returns per platform: `userDataDir.test.ts` takes the
 *  Application Support path as an INPUT parameter (it pins consumption, not derivation), and the
 *  other suites use the literal only to build fixture paths. So callers deriving off a shared helper
 *  could not drift from each other — and nothing would have noticed if the helper itself were wrong.
 *  If darwin returned `~/Library/Caches`, script and fixture would move together, the #883 exemption
 *  case would stay green, and the wipe would be cleaning the wrong directory in production.
 *
 *  ⚠️ **Driven through the INJECTED platform, not `process.platform`** — otherwise each leg could
 *  only assert its own shape, and the darwin branch is the one no gate this repo runs would ever
 *  execute — the public `check` matrix was `[ubuntu-latest, windows-latest]` when these were
 *  written, and gained `macos-14` on 2026-09-09; the injection is what makes the rule pinnable
 *  from ANY leg rather than only the one that happens to run it. Separators are folded
 *  to `/` before comparing so the SEGMENT SEQUENCE is what is pinned, which is the actual rule;
 *  comparing raw would just re-derive `path.join` in the assertion. */
describe('appSupportRoot — the per-platform rule, pinned to literals', () => {
  const seg = (p: string) => p.split(path.sep).join('/');
  const HOME = path.join(path.sep, 'home-fixture');
  const h = seg(HOME);

  it('darwin: ~/Library/Application Support, from the HOME it is given', () => {
    expect(seg(appSupportRoot('darwin', {}, HOME))).toBe(`${h}/Library/Application Support`);
  });

  it('⚠️ darwin IGNORES the environment — the asymmetry that broke a test on macOS only', () => {
    // win32 and linux honour an env var; darwin honours NEITHER. A fixture that sandboxes the
    // environment therefore moves this root on two platforms and not on the third, which is exactly
    // how cleanPackagedCacheLinkGuard's exemption case passed on Windows + Linux and failed on
    // every Mac. Pinned here so the asymmetry is a stated rule rather than a trap.
    const noisy = { APPDATA: '/x/appdata', XDG_CONFIG_HOME: '/y/xdg' };
    expect(seg(appSupportRoot('darwin', noisy, HOME))).toBe(`${h}/Library/Application Support`);
  });

  it('win32: %APPDATA%, falling back to ~/AppData/Roaming', () => {
    // ⚠️ `String.raw`, not escaped literals. Written through a bash heredoc the doubled backslashes
    // collapsed, so this read `'C:\Users\me\AppData\Roaming'` — where `\U`, `\m`, `\A` and `\R` are
    // useless escapes that evaluate to the bare letter. The case still PASSED, because the argument
    // and the expectation were mangled IDENTICALLY: two sides agreeing on a corrupted value, which
    // is this repo's recurring shape and not a Windows one. `no-useless-escape` caught it.
    const roaming = String.raw`C:\Users\me\AppData\Roaming`;
    expect(appSupportRoot('win32', { APPDATA: roaming }, HOME)).toBe(roaming);
    expect(roaming.split('\\')).toHaveLength(5); // the separators survived — not `C:Usersme…`
    expect(seg(appSupportRoot('win32', {}, HOME))).toBe(`${h}/AppData/Roaming`);
  });

  it('linux: $XDG_CONFIG_HOME, falling back to ~/.config', () => {
    expect(appSupportRoot('linux', { XDG_CONFIG_HOME: '/xdg/config' }, HOME)).toBe('/xdg/config');
    expect(seg(appSupportRoot('linux', {}, HOME))).toBe(`${h}/.config`);
  });

  it('defaultToolchainDir hangs off that root — so the two cannot drift', () => {
    // The composition #883's fixture depends on. Asserted against the CURRENT platform's root
    // (which the three cases above have already pinned) rather than re-deriving it.
    expect(seg(defaultToolchainDir())).toBe(`${seg(appSupportRoot())}/${SHARED_DIR}/toolchain`);
  });
});

/** `binInAppDir`'s three branches, pinned to literals — the sibling `appSupportRoot`'s fix turned
 *  up in close-out's step-1 sweep. Same shape: an exported, platform-branching PATH derivation with
 *  two consumers and, until now, no test at all.
 *
 *  Why it matters beyond symmetry: one consumer is `assert-app-csp.mjs`, which SPAWNS this path. A
 *  wrong answer there does not fail loudly — it launches nothing, and the CSP gate passes over an
 *  app it never started.
 *
 *  ⚠️ The `.app` branch keys on the ARGUMENT, not the platform, and that is deliberate (a caller
 *  handed a bundle gets its layout wherever the check runs) — so it is assertable everywhere. Only
 *  the win32/else split needed the injected `platform`. */
describe('binInAppDir — the per-platform layout, pinned to literals', () => {
  const seg = (p: string) => p.split(path.sep).join('/');

  it('a .app bundle gets the macOS layout on ANY platform — it keys on the argument', () => {
    for (const plat of ['darwin', 'win32', 'linux'] as NodeJS.Platform[]) {
      expect(seg(binInAppDir('/out/Modoki Editor.app', 'Modoki Editor', plat)))
        .toBe('/out/Modoki Editor.app/Contents/MacOS/Modoki Editor');
    }
  });

  it('win32: <appDir>/<productName>.exe', () => {
    expect(seg(binInAppDir('/out/win-unpacked', 'Modoki Editor', 'win32')))
      .toBe('/out/win-unpacked/Modoki Editor.exe');
  });

  it('linux: the product name lowercased and dash-joined', () => {
    expect(seg(binInAppDir('/out/linux-unpacked', 'Modoki Editor', 'linux')))
      .toBe('/out/linux-unpacked/modoki-editor');
  });
});
