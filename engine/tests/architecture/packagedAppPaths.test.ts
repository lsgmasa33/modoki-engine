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
import { winKillCommand, killPackaged } from '../../scripts/packagedAppPaths.mjs';

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
