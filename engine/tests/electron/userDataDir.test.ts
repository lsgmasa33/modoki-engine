import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import realFs from 'node:fs';
import {
  resolveUserDataDir,
  resolveToolchainDir,
  shouldOverrideUserData,
  adoptLegacyToolchain,
  multiProfileKey,
  PACKAGED_DIR,
  DEV_DIR,
} from '../../electron/userDataDir';

/**
 * WHERE the editor keeps its state. Every property here was a real, measured bug:
 *
 *  - The SHIPPED editor stored its 1.2GB toolchain + prefs in a dev-looking `modoki-app`
 *    while `appData/Modoki Editor` collected only strays — because the `setName` rename
 *    meant to place it had been demoted to a no-op by an EARLIER userData read (Electron
 *    caches the path on first read; see the ordering guard at the bottom of this file).
 *  - Every dev CLONE resolved to the SAME `appData/Electron`, so the several editors
 *    CLAUDE.md RULE 2 runs at once shared one Chromium profile: the first took the Local
 *    Storage LevelDB lock and later ones silently got NONE (measured via lsof — prefs just
 *    stopped persisting, no error anywhere).
 *  - The toolchain hung off userData, so each flavour got its own copy (npm-tools was
 *    duplicated across dev and packaged) — and any userData move would have re-downloaded
 *    1.2GB.
 *
 * These are only observable on a real packaged launch, so they're pinned here.
 */
const APPDATA = '/Users/me/Library/Application Support';

describe('resolveUserDataDir', () => {
  const packaged = () => resolveUserDataDir({ appData: APPDATA, isPackaged: true, repoRoot: '/Applications/Modoki Editor.app/…/app.asar.unpacked' });
  const dev = (repoRoot: string) => resolveUserDataDir({ appData: APPDATA, isPackaged: false, repoRoot });

  it('packaged → the PRODUCT dir (what setName was supposed to give us)', () => {
    expect(packaged()).toBe(path.join(APPDATA, PACKAGED_DIR));
  });

  it('packaged is INDEPENDENT of the install path — one shipped app, one profile', () => {
    const a = resolveUserDataDir({ appData: APPDATA, isPackaged: true, repoRoot: '/Applications/x' });
    const b = resolveUserDataDir({ appData: APPDATA, isPackaged: true, repoRoot: '/Users/me/Desktop/y' });
    expect(a).toBe(b);
  });

  it('dev → a PER-CLONE dir, so RULE 2 clones stop sharing one Chromium profile', () => {
    const a = dev('/Users/me/Projects/modoki');
    const b = dev('/Users/me/Projects/modoki-ai');
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.join(APPDATA, DEV_DIR));
    expect(path.dirname(b)).toBe(path.join(APPDATA, DEV_DIR));
  });

  it('dev NEVER collides with packaged', () => {
    expect(dev('/Users/me/Projects/modoki')).not.toBe(packaged());
  });

  it('a clone id is STABLE across calls — a profile must survive a relaunch', () => {
    expect(dev('/Users/me/Projects/modoki')).toBe(dev('/Users/me/Projects/modoki'));
  });

  it('the clone id is filesystem-safe and short (it is a folder name, not a path)', () => {
    const leaf = path.basename(dev('/Users/me/Projects/modoki'));
    expect(leaf).toMatch(/^[0-9a-f]{8}$/);
  });

  it('a trailing separator is the SAME clone (the id IS the profile identity)', () => {
    // Any spelling drift of one clone silently hands the user an EMPTY profile — prefs
    // "randomly" reset. instanceToken.rootKey normalises for the same reason.
    expect(dev('/Users/me/Projects/modoki/')).toBe(dev('/Users/me/Projects/modoki'));
  });

  it('a non-normalised path is the SAME clone', () => {
    expect(dev('/Users/me/Projects/foo/../modoki')).toBe(dev('/Users/me/Projects/modoki'));
  });

  it('the clone PATH does not leak into the dir name', () => {
    expect(dev('/Users/me/Projects/modoki')).not.toContain('Projects');
  });

  it('keys on the clone PATH, not the branch — switching branches keeps the profile', () => {
    // Nothing but repoRoot is an input; this pins that contract against a future signature
    // that sneaks in a branch/version and silently resets everyone's prefs on checkout.
    expect(dev('/Users/me/Projects/modoki')).toBe(dev('/Users/me/Projects/modoki'));
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'case-insensitive FS: the same clone spelled differently is ONE profile',
    () => {
      expect(dev('/Users/me/Projects/Modoki')).toBe(dev('/Users/me/projects/modoki'));
    },
  );

  // ── §14.4 — MODOKI_MULTI sub-profiles ──
  const withSub = (repoRoot: string, subKey: string | null) =>
    resolveUserDataDir({ appData: APPDATA, isPackaged: false, repoRoot, subKey });

  it('a subKey nests UNDER the clone dir — co-running MULTI editors stop sharing one profile', () => {
    const clone = dev('/Users/me/Projects/modoki');
    const a = withSub('/Users/me/Projects/modoki', 'game-a');
    const b = withSub('/Users/me/Projects/modoki', 'game-b');
    expect(a).not.toBe(b);            // two MULTI editors, two profiles
    expect(path.dirname(a)).toBe(clone); // both under THIS clone
    expect(path.dirname(b)).toBe(clone);
  });

  it('no subKey (the normal single-editor case) is UNCHANGED', () => {
    expect(withSub('/Users/me/Projects/modoki', null)).toBe(dev('/Users/me/Projects/modoki'));
  });

  it('the subKey is ignored when packaged (single-instance never needs sub-profiles)', () => {
    const a = resolveUserDataDir({ appData: APPDATA, isPackaged: true, repoRoot: '/x', subKey: 'game-a' });
    expect(a).toBe(path.join(APPDATA, PACKAGED_DIR)); // no nesting
  });
});

describe('multiProfileKey (§14.4)', () => {
  it('null for no project — falls back to the shared clone profile', () => {
    expect(multiProfileKey(undefined)).toBeNull();
    expect(multiProfileKey(null)).toBeNull();
    expect(multiProfileKey('')).toBeNull();
    expect(multiProfileKey('   ')).toBeNull();
  });

  it('a readable slug + short hash, filesystem-safe', () => {
    const k = multiProfileKey('/Users/me/Projects/modoki/games/3d-test');
    expect(k).toMatch(/^3d-test-[0-9a-f]{8}$/);
  });

  it('STABLE across calls — a relaunch of the same MULTI editor keeps its profile', () => {
    expect(multiProfileKey('games/3d-test')).toBe(multiProfileKey('games/3d-test'));
  });

  it('DISTINCT projects → distinct keys (the whole point)', () => {
    expect(multiProfileKey('games/3d-test')).not.toBe(multiProfileKey('games/sling'));
  });

  it('same basename in DIFFERENT locations does not collide (the hash disambiguates)', () => {
    const a = multiProfileKey('/Users/me/repoA/games/demo');
    const b = multiProfileKey('/Users/me/repoB/games/demo');
    expect(a).not.toBe(b);
    expect(a!.startsWith('demo-')).toBe(true);
    expect(b!.startsWith('demo-')).toBe(true);
  });

  it('a trailing slash is the SAME project (stable key)', () => {
    expect(multiProfileKey('/x/games/3d-test/')).toBe(multiProfileKey('/x/games/3d-test'));
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'case-insensitive FS: differently-cased path is the SAME project',
    () => {
      expect(multiProfileKey('/X/Games/Demo')).toBe(multiProfileKey('/x/games/demo'));
    },
  );
});

describe('resolveToolchainDir', () => {
  it('is MACHINE-level — outside userData, so a profile move costs no re-download', () => {
    const tc = resolveToolchainDir(APPDATA);
    for (const ud of [
      resolveUserDataDir({ appData: APPDATA, isPackaged: true, repoRoot: '/x' }),
      resolveUserDataDir({ appData: APPDATA, isPackaged: false, repoRoot: '/Users/me/Projects/modoki' }),
    ]) {
      expect(tc.startsWith(ud + path.sep)).toBe(false);
    }
  });

  it('is the SAME for dev and packaged — a JDK is a JDK (npm-tools was duplicated before)', () => {
    expect(resolveToolchainDir(APPDATA)).toBe(resolveToolchainDir(APPDATA));
    expect(resolveToolchainDir(APPDATA)).toContain('toolchain');
  });

  it('does not depend on the clone or the install path', () => {
    // The signature takes ONLY appData — the type system is the guard, this documents why.
    expect(resolveToolchainDir('/other/appData')).toBe(path.join('/other/appData', 'Modoki', 'toolchain'));
  });
});

describe('shouldOverrideUserData', () => {
  // Caught by the CSP smoke, not by review: assert-app-csp.mjs spawns the packaged app with
  // `--user-data-dir=<temp>` to isolate its profile, and an UNCONDITIONAL setPath made that
  // flag a no-op — the same "a later write beats an earlier decision" bug this module
  // exists to fix, pointed the other way.
  it('overrides by default (a normal launch has no such switch)', () => {
    expect(shouldOverrideUserData(['/path/Electron', 'main.cjs'])).toBe(true);
  });

  it('does NOT override an explicit --user-data-dir=<path> (the CSP smoke)', () => {
    expect(shouldOverrideUserData(['/x/app', '--remote-debugging-port=9333', '--user-data-dir=/tmp/csp'])).toBe(false);
  });

  it('does NOT override the space-separated form either', () => {
    expect(shouldOverrideUserData(['/x/app', '--user-data-dir', '/tmp/csp'])).toBe(false);
  });

  it('is not fooled by a look-alike flag', () => {
    expect(shouldOverrideUserData(['/x/app', '--user-data-dir-suffix=nope'])).toBe(true);
  });
});

/**
 * REGRESSION GUARD — ordering, not logic.
 *
 * Electron RESOLVES AND CACHES userData on its FIRST read, so whoever reads first wins.
 * This broke for real: `initFileLog()` (added at main.ts:28 by ff364b47, a Windows crash
 * fix) reads userData, which silently demoted the `app.setName('Modoki Editor')` 240 lines
 * below it to a no-op — relocating the shipped editor's entire profile (1.2GB toolchain,
 * prefs, caches) from `Modoki Editor` to `modoki-app`. Nothing threw and nothing logged;
 * the directory just moved. A Jul-16 build (no initFileLog) still used `Modoki Editor`.
 *
 * No unit test of the resolvers could have caught that — the bug was WHERE the call sits.
 * So assert the source order directly: any userData read above the setPath re-breaks it.
 */
describe('main.ts must fix userData before anything reads it', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.ts'), 'utf8');
  // Comments here DISCUSS getPath('userData')/setName by name, so match against CODE only —
  // blank the comment lines rather than drop them, to keep every offset comparable.
  const src = raw
    .split('\n')
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
    .join('\n');

  it('guards the setPath behind shouldOverrideUserData (never clobber --user-data-dir)', () => {
    expect(src).toMatch(/shouldOverrideUserData\(process\.argv\)/);
  });

  it("calls app.setPath('userData', …) exactly once", () => {
    expect(src.match(/app\.setPath\(\s*'userData'/g) ?? []).toHaveLength(1);
  });

  it('setPath comes BEFORE initFileLog() — the reader that caused the regression', () => {
    expect(src.indexOf("app.setPath('userData'")).toBeLessThan(src.indexOf('initFileLog();'));
  });

  it('NO app.getPath("userData") appears above the setPath', () => {
    const at = src.indexOf("app.setPath('userData'");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(0, at)).not.toMatch(/app\.getPath\(\s*'userData'\s*\)/);
  });

  it('the dead app.setName rename is gone from the CODE (comments may still explain it)', () => {
    expect(src).not.toMatch(/app\.setName\(/);
  });

  it('the toolchain is never hung off userData again (that duplicated it per flavour)', () => {
    expect(src).not.toMatch(/getPath\(\s*'userData'\s*\)\s*,\s*'toolchain'/);
  });
});


/**
 * ADOPT the pre-existing toolchain instead of re-fetching it.
 *
 * Pinning `resolveToolchainDir` moved where we LOOK, not the data — so the first cut
 * silently re-downloaded ~1.2GB (JDK 336M + Android SDK 527M + Node + Ruby) and would have
 * left Android/iOS builds broken until it finished. The commit and docs claimed the
 * opposite ("not re-downloaded") while the smoke log plainly said
 * `provisioned Node v22.23.1 → …/Modoki/toolchain/node`.
 */
describe('adoptLegacyToolchain', () => {
  let dir: string;
  const tc = (name: string) => path.join(dir, name, 'toolchain');
  beforeEach(() => { dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tc-')); });
  afterEach(() => { realFs.rmSync(dir, { recursive: true, force: true }); });
  const seed = (p: string, marker: string) => {
    realFs.mkdirSync(path.join(p, marker), { recursive: true });
  };

  it("adopts the PACKAGED app's toolchain (the one holding the JDK + Android SDK)", () => {
    seed(tc('modoki-app'), 'android-sdk');
    expect(adoptLegacyToolchain(dir, realFs)).toBe(tc('modoki-app'));
    // the data MOVED — not re-downloaded, and not left behind
    expect(realFs.existsSync(path.join(resolveToolchainDir(dir), 'android-sdk'))).toBe(true);
    expect(realFs.existsSync(tc('modoki-app'))).toBe(false);
  });

  it("falls back to dev's toolchain when there is no packaged one", () => {
    seed(tc('Electron'), 'npm-tools');
    expect(adoptLegacyToolchain(dir, realFs)).toBe(tc('Electron'));
    expect(realFs.existsSync(path.join(resolveToolchainDir(dir), 'npm-tools'))).toBe(true);
  });

  it('prefers the PACKAGED toolchain over dev (it has the full set)', () => {
    seed(tc('modoki-app'), 'android-sdk');
    seed(tc('Electron'), 'npm-tools');
    expect(adoptLegacyToolchain(dir, realFs)).toBe(tc('modoki-app'));
    expect(realFs.existsSync(path.join(resolveToolchainDir(dir), 'android-sdk'))).toBe(true);
  });

  it('NO-OPs once the target exists — never merges into a live toolchain', () => {
    seed(resolveToolchainDir(dir), 'node');
    seed(tc('modoki-app'), 'android-sdk');
    expect(adoptLegacyToolchain(dir, realFs)).toBeNull();
    expect(realFs.existsSync(tc('modoki-app'))).toBe(true); // left untouched
  });

  it('is idempotent — a second call adopts nothing', () => {
    seed(tc('modoki-app'), 'jdk');
    expect(adoptLegacyToolchain(dir, realFs)).toBe(tc('modoki-app'));
    expect(adoptLegacyToolchain(dir, realFs)).toBeNull();
  });

  it('no legacy dir → null, and provisioning simply proceeds', () => {
    expect(adoptLegacyToolchain(dir, realFs)).toBeNull();
  });

  it('never throws when the rename fails (a lost race must not block startup)', () => {
    seed(tc('modoki-app'), 'jdk');
    const boom = { ...realFs, renameSync: () => { throw new Error('EXDEV'); } } as unknown as Parameters<typeof adoptLegacyToolchain>[1];
    expect(() => adoptLegacyToolchain(dir, boom)).not.toThrow();
    expect(adoptLegacyToolchain(dir, boom)).toBeNull();
  });
});

/**
 * ORDERING — the adopt is a no-op once the target exists, and ensureNodeProvisioned()
 * CREATES <toolchain>/node. So a late adopt silently loses the JDK + Android SDK. The first
 * cut had exactly this bug: the smoke log showed Node provisioned into the fresh dir.
 */
describe('main.ts must adopt the toolchain before anything provisions it', () => {
  const raw = realFs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.ts'), 'utf8');
  const src = raw.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n');

  it('adoptLegacyToolchain runs at module scope, above initFileLog()', () => {
    expect(src.indexOf('adoptLegacyToolchain(')).toBeGreaterThan(-1);
    expect(src.indexOf('adoptLegacyToolchain(')).toBeLessThan(src.indexOf('initFileLog();'));
  });

  it('it runs BEFORE the first ensureNodeProvisioned() call site', () => {
    expect(src.indexOf('adoptLegacyToolchain(')).toBeLessThan(src.indexOf('ensureNodeProvisioned()'));
  });
});
