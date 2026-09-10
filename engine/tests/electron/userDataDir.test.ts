import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import realFs from 'node:fs';
import { readScannedSource } from '@modoki/engine/testing';
import {
  resolveUserDataDir,
  resolveToolchainDir,
  shouldOverrideUserData,
  adoptLegacyToolchain,
  multiProfileKey,
  PACKAGED_DIR,
  DEV_DIR,
} from '../../electron/userDataDir';
import { makeDirLink } from '../helpers/linkFixture';

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

  it('packaged → a PER-INSTALL dir UNDER the product dir', () => {
    expect(path.dirname(packaged())).toBe(path.join(APPDATA, PACKAGED_DIR));
    expect(path.basename(packaged())).toMatch(/^[0-9a-f]{8}$/);
  });

  /** ⚠️ **DELIBERATE REVERSAL (#1036).** This assertion used to be `expect(a).toBe(b)`, titled
   *  "packaged is INDEPENDENT of the install path — one shipped app, one profile". Both halves of
   *  that justification were false. Nothing calls `requestSingleInstanceLock`, so "one shipped app"
   *  is a macOS Finder convention rather than a property of this app — every packaged launch path
   *  in this repo starts the binary directly. And a machine really does carry several packaged
   *  builds: each clone's `smoke-packaged.sh` writes one under `modoki-pkg-smoke-$CLONE`.
   *
   *  The flat dir was never a decision about shipped apps; it was §14.2's per-clone fix never being
   *  applied to this branch, and it stayed invisible because a real end user has exactly ONE
   *  install — for whom "all installs share one dir" and "each install gets its own dir" name the
   *  same directory. Do not "restore" the old assertion on the strength of its old title. */
  it('packaged DEPENDS on the install path — two installs must not share one profile', () => {
    const a = resolveUserDataDir({ appData: APPDATA, isPackaged: true, repoRoot: '/Applications/x' });
    const b = resolveUserDataDir({ appData: APPDATA, isPackaged: true, repoRoot: '/Users/me/Desktop/y' });
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.join(APPDATA, PACKAGED_DIR));
    expect(path.dirname(b)).toBe(path.join(APPDATA, PACKAGED_DIR));
  });

  /** ⚠️ Two DIFFERENT spellings of one install, not one spelling compared to itself. The first
   *  draft of this was `at(X) === at(X)` — same pure function, same literal argument — which
   *  passes if the resolver returns a constant, ignores `appData`, ignores `subKey`, or is
   *  deleted and rewritten. The only mutation it could catch was genuine nondeterminism. Its
   *  title also claimed "an in-place upgrade keeps its profile", a property the resolver cannot
   *  exercise: it takes no version input at all. (#1036 review F4.) */
  it('packaged is STABLE across spellings of one install — a re-launch keeps its profile', () => {
    const at = (r: string) => resolveUserDataDir({ appData: APPDATA, isPackaged: true, repoRoot: r });
    const canonical = '/Applications/Modoki Editor.app/Contents/Resources/app.asar.unpacked';
    expect(at(canonical + '/')).toBe(at(canonical));
    expect(at('/Applications/Modoki Editor.app/Contents/Resources/foo/../app.asar.unpacked'))
      .toBe(at(canonical));
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

  /** ⚠️ **DELIBERATE REVERSAL (#1036)** — see the packaged/install-path note above for why
   *  "single-instance" was never true of this app. A packaged editor nests exactly like dev. */
  it('the subKey nests when packaged too — the flavours obey ONE rule', () => {
    const base = resolveUserDataDir({ appData: APPDATA, isPackaged: true, repoRoot: '/x' });
    const a = resolveUserDataDir({ appData: APPDATA, isPackaged: true, repoRoot: '/x', subKey: 'game-a' });
    const b = resolveUserDataDir({ appData: APPDATA, isPackaged: true, repoRoot: '/x', subKey: 'game-b' });
    expect(path.dirname(a)).toBe(base);
    expect(a).not.toBe(b);
  });

  /** ⚠️ **The property every editor-level file depends on** (#1036 review F2). `main.ts` computes
   *  `base` with `subKey: null` and hands THAT to `setUiPrefsDir` and `profileBaseDir` (→
   *  `editorStateDir()` → `instance-tokens.json`, `cdp.json`, the port memos). If `base` ever
   *  became the joined path, every one of those files would move inside one project's profile —
   *  which is the regression 2b7351a23 exists to fix, and it would not red a single test that
   *  existed before this one. Pinning the VALUE, not the spelling of the call. */
  it('a subKey result is strictly UNDER the subKey-less base — never equal to it', () => {
    for (const isPackaged of [true, false]) {
      const base = resolveUserDataDir({ appData: APPDATA, isPackaged, repoRoot: '/r', subKey: null });
      const sub = resolveUserDataDir({ appData: APPDATA, isPackaged, repoRoot: '/r', subKey: 'game-a' });
      expect(sub).not.toBe(base);
      expect(path.dirname(sub)).toBe(base);
    }
  });

  it('no flavour branch survives: dev and packaged differ ONLY by the flavour dir', () => {
    // The point of #1036 is that the special case is gone, not that it moved. If a future edit
    // reintroduces a branch, these two stop being the same shape and this reds.
    const shape = (isPackaged: boolean) => {
      const p = resolveUserDataDir({ appData: APPDATA, isPackaged, repoRoot: '/r', subKey: 'game-a' });
      return path.relative(path.join(APPDATA, isPackaged ? PACKAGED_DIR : DEV_DIR), p);
    };
    expect(shape(true)).toBe(shape(false));
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

/** #899 — the identity these two derive must survive a SPELLING change of the same directory.
 *
 *  These need a REAL filesystem (a symlink is the whole point), unlike the layout tests above
 *  which are deliberately pure. `os.tmpdir()` is realpath'd first: on macOS it is itself a
 *  symlink (/var -> /private/var), which would let both sides agree for the wrong reason and
 *  make these pass against the very bug they exist to catch. */
describe('#899 — a symlinked spelling is the SAME clone', () => {
  let base = '';
  let real = '';
  let link = '';
  beforeEach(() => {
    base = realFs.mkdtempSync(path.join(realFs.realpathSync.native(os.tmpdir()), 'udd-899-'));
    real = path.join(base, 'modoki-qa');
    realFs.mkdirSync(real);
    link = path.join(base, 'link');
    makeDirLink(real, link);
  });
  afterEach(() => { realFs.rmSync(base, { recursive: true, force: true }); });

  // cloneId is module-private; resolveUserDataDir is the exported wrapper that reaches it.
  // #899 filed these two READ-ONLY because that route was not found — it is this one.
  it('resolveUserDataDir: one profile dir, not two ("prefs randomly reset")', () => {
    const dir = (repoRoot: string) => resolveUserDataDir({ appData: APPDATA, isPackaged: false, repoRoot });
    expect(dir(link)).toBe(dir(real));
  });

  it('multiProfileKey: one sub-profile, and the slug names the PROJECT not the link', () => {
    expect(multiProfileKey(link)).toBe(multiProfileKey(real));
    expect(multiProfileKey(link)).toMatch(/^modoki-qa-[0-9a-f]{8}$/);
  });

  // The other direction. Folding two spellings together is only correct while two genuinely
  // different clones still get different profiles — otherwise they would fight over one
  // LevelDB lock, which is the failure this whole module exists to prevent.
  it('still gives two DIFFERENT clones two different profiles', () => {
    const other = path.join(base, 'modoki-ai2');
    realFs.mkdirSync(other);
    const dir = (repoRoot: string) => resolveUserDataDir({ appData: APPDATA, isPackaged: false, repoRoot });
    expect(dir(other)).not.toBe(dir(real));
    expect(multiProfileKey(other)).not.toBe(multiProfileKey(real));
  });
});

/** ⚠️ NOT a defect, pinned so it is not "fixed" a third time. `docs/windows.md` and #899 both
 *  stated that `multiProfileKey` had drifted from its two siblings by losing a trailing-slash
 *  trim, and that `MODOKI_PROJECT=…/x/` and `…/x` therefore minted two profiles. `path.resolve`
 *  strips a trailing separator itself, so the trim was dead code in the siblings and its absence
 *  here changed nothing. A fix was scoped for this non-defect twice. */
describe('multiProfileKey — the trailing-slash "drift" that never existed (#899)', () => {
  it('a trailing separator was never a second profile', () => {
    expect(multiProfileKey('/Users/me/Projects/modoki/games/court/')).toBe(
      multiProfileKey('/Users/me/Projects/modoki/games/court'));
  });
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
  const raw = readScannedSource(path.join(__dirname, '..', '..', 'electron', 'main.ts')).code;
  // Comments here DISCUSS getPath('userData')/setName by name, so match against CODE only —
  // blank the comment lines rather than drop them, to keep every offset comparable.
  const src = raw
    .split('\n')
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

  /** ⚠️ **The accessor must not LAUNDER the read past the rule above** (#1036 §2d review F1).
   *
   *  `editorStateDir()` is `profileBaseDir ?? app.getPath('userData')`, and it was moved below the
   *  setPath precisely because the guard above fired on it. That answered the guard's COMPLAINT
   *  without answering what the guard is FOR: function declarations hoist and `profileBaseDir` is
   *  null until the block runs, so a call placed anywhere above the setPath returns Electron's
   *  DEFAULT userData — silently, and with the literal `app.getPath('userData')` nowhere near the
   *  call site, so the assertion above cannot see it.
   *
   *  Driven, not argued: adding `readCdpEnabled(editorStateDir())` inside the project-decision
   *  block makes the packaged app read `<appData>/modoki-app/cdp.json`, miss, and return `true`
   *  (opt-out model) — re-enabling a remote-debugging port the user turned off, with all 59 tests
   *  in this file green. That is the `app.setName`/ff364b47 shape exactly. */
  it('NO editorStateDir() call appears above the setPath either', () => {
    const at = src.indexOf("app.setPath('userData'");
    const above = src.slice(0, at);
    // the DECLARATION is below the setPath; any *call* above it reads the wrong dir
    expect(above).not.toMatch(/editorStateDir\(\)/);
  });

  /** ⚠️ The same ordering hazard one level up (#1036 §2d review F1, second half). The memoised
   *  project decision reads recents, and `getRecentProjects()` resolves to the SCOPED file only
   *  once `setRecentsScope` has run. Move that call below the profile block — a plausible tidy-up,
   *  since it reads as "recents setup" next to "profile setup" — and the memo silently reads
   *  `globalRecentsFile()`, the pre-scoping junk drawer that mixes every clone's projects. The
   *  `getRecentProjects()` count-of-one guard below still passes. */
  it('setRecentsScope runs BEFORE the project decision that reads recents', () => {
    const scope = src.indexOf('setRecentsScope(');
    const choice = src.indexOf('chooseInitialProject(');
    expect(scope).toBeGreaterThan(-1);
    expect(choice).toBeGreaterThan(-1);
    expect(scope).toBeLessThan(choice);
  });

  it('the dead app.setName rename is gone from the CODE (comments may still explain it)', () => {
    expect(src).not.toMatch(/app\.setName\(/);
  });

  it('the toolchain is never hung off userData again (that duplicated it per flavour)', () => {
    expect(src).not.toMatch(/getPath\(\s*'userData'\s*\)\s*,\s*'toolchain'/);
  });

  // ── #1036: the profile is keyed on the PROJECT, decided above the setPath ──

  it('decides the project ABOVE the setPath — otherwise there is nothing to key on', () => {
    const at = src.indexOf("app.setPath('userData'");
    expect(src.indexOf('chooseInitialProject(')).toBeGreaterThan(-1);
    expect(src.indexOf('chooseInitialProject(')).toBeLessThan(at);
  });

  /** ⚠️ **ONE decision, computed once — not two that are expected to agree** (#1036 review F3/F5).
   *
   *  This test used to assert `toHaveLength(2)`: the profile block and `resolveInitialProject()`
   *  each called `chooseInitialProject` with a hand-copied six-field option object. Two ways that
   *  breaks, neither of which any other test can see:
   *   - edit `devFallback` at one site (a renamed default game) and the profile keys on the old
   *     project while the editor opens the new one;
   *   - `recents` is a machine-wide file with concurrent writers (`addRecentProject` from a
   *     sibling editor), so the two reads can differ across the module-load → whenReady window
   *     even with identical code.
   *  Both present as "my prefs reset". The fix is memoisation, so this now pins ONE call site. */
  it('calls chooseInitialProject exactly ONCE — both consumers share the memoised decision', () => {
    expect(src.match(/chooseInitialProject\(/g) ?? []).toHaveLength(1);
    // …and that one call is inside the memo, which both consumers go through.
    expect(src).toMatch(/initialChoice \?\?= chooseInitialProject\(/);
    // ⚠️ 4, not 3: the regex matches the DECLARATION too (`function initialProjectChoice()`), so a
    // floor of 3 was satisfied by declaration + the two profile-block calls alone, with
    // `resolveInitialProject` free to recompute. (#1036 §2d review F4.)
    expect((src.match(/initialProjectChoice\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // …and the profile block must not hand-roll the env/recents precedence beside it.
    const at = src.indexOf("app.setPath('userData'");
    const above = src.slice(0, at);
    expect(above).not.toMatch(/MODOKI_PROJECT\s*(\|\||\?\?)/);
    expect(above).not.toMatch(/recents\s*\[\s*0\s*\]/);
  });

  /** ⚠️ **The guard for the CLASS, not the two call sites I happened to fix** (#1036 review F1).
   *
   *  `getPath('userData')` is now the PROJECT profile. Every consumer must therefore make a
   *  decision — project-level or editor-level — and the first pass through this file got 2 of 7
   *  right by hand. The one that mattered: `readCdpEnabled`/`writeCdpEnabled` are an EDITOR
   *  preference, and `readCdpEnabled` defaults to ON when the file is absent (`cdp.ts:76`,
   *  opt-out model). Written under project A and read under project B, a user's decision to turn
   *  the remote-debugging port OFF silently reverts to ON, with the checkbox still showing OFF —
   *  deterministic on a fresh packaged install, whose first launch has no recents and so no
   *  sub-key. The port memos and `readLastPort`/`writeLastPort` are the same class.
   *
   *  So: an allowlist. A new `getPath('userData')` must either go through `editorStateDir()` or
   *  be added here WITH a reason — which is the point at which someone has to think about it.
   *
   *  ⚠️ **Reach: main.ts ONLY.** This scans one file, so it cannot see `fileLog.ts:244` or
   *  `zoom.ts:47`, both of which read `getPath('userData')` too. Both were audited by hand and
   *  are deliberate (logs follow the project so two editors stop interleaving one `main.log`;
   *  zoom's is the `--user-data-dir` fallback) — but do not read this guard as covering the
   *  whole class, because its docblock used to imply that. (#1036 §2d review F3.) */
  it('getPath("userData") appears ONLY at sanctioned sites — editor-level files use editorStateDir()', () => {
    const allowed: [RegExp, string][] = [
      [/function editorStateDir\(\)/, 'the accessor itself — its fallback when --user-data-dir was passed'],
      [/'vite-cache'/, "per-PROJECT dep-optimizer cache — correctly scoped to the project profile"],
      [/'\.vite-cache-build'/, 'the signature file pairing with vite-cache, same scope'],
      [/mkdirSync\(app\.getPath\('userData'\)/, 'creating that same vite-cache parent'],
    ];
    const offenders = src.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((x) => /getPath\(\s*'userData'\s*\)/.test(x.line))
      .filter((x) => !allowed.some(([re]) => re.test(x.line)))
      .map((x) => `main.ts:${x.n}  ${x.line}`);
    expect(offenders, 'a new userData consumer: use editorStateDir(), or allowlist it with a reason')
      .toEqual([]);
  });

  /** ⚠️ The subKey-less `base` is what makes `editorStateDir()` and `setUiPrefsDir()` mean
   *  "editor level" at all (#1036 review F2). The resolver-level test above pins the VALUE
   *  relationship; this pins that main.ts actually takes the un-joined one. */
  it('the editor-level dir is the subKey-LESS base, and only setPath gets the joined path', () => {
    expect(src).toMatch(/subKey:\s*null/);
    expect(src).toMatch(/setUiPrefsDir\(base\)/);
    expect(src).toMatch(/profileBaseDir = base/);
    // the joined path is built inline at the setPath and nowhere else
    expect(src.match(/path\.join\(base, profileSubKey\)/g) ?? []).toHaveLength(1);
  });

  /** ⚠️ The editor's OWN files must NOT follow the project sub-profile (#1036). Found by running
   *  it: a live launch wrote a SECOND `instance-tokens.json` inside the project profile, which
   *  mints a fresh token per project — so every existing `.mcp.json` `MODOKI_TOKEN` stops matching
   *  and every MCP call 403s with "WRONG EDITOR: this .mcp.json was written for a different editor
   *  or project", for the same editor and the same project. `ui-prefs.json` is the same shape
   *  (testboard q1k7p2hGZB9lGvYi11go). Both go through `editorStateDir()`. */
  it('the token store does NOT follow the project profile — it uses editorStateDir()', () => {
    expect(src).toMatch(/ensureToken\(\s*editorStateDir\(\)/);
    expect(src).not.toMatch(/ensureToken\(\s*app\.getPath\(\s*'userData'\s*\)/);
  });

  /** ⚠️ Bans the NAME, not one spelling of it (#1036 review F8). The first version was
   *  `not.toMatch(/MODOKI_MULTI\s*\?/)`, which a plain `if (process.env.MODOKI_MULTI) …` — the most
   *  natural way anyone would reintroduce the gate — walks straight past. `src` is comment-stripped
   *  (`readScannedSource`), so the surviving explanatory mention at main.ts:147 does not count. */
  it('MODOKI_MULTI appears nowhere in main.ts CODE — the special case is GONE, not moved', () => {
    // A reintroduced gate means packaged (and a plain dev launch) silently stop being
    // project-keyed, which is invisible in every unit test of the resolvers.
    expect(src).not.toMatch(/MODOKI_MULTI/);
  });

  it('recents are read in exactly ONE place — the memo', () => {
    // The precedence bans below are spelling-based and a determined author routes around them;
    // this is the structural version. A second `getRecentProjects()` is the shape every
    // re-implementation of the decision must take.
    expect(src.match(/getRecentProjects\(\)/g) ?? []).toHaveLength(1);
  });
});

/** ⚠️ **The TRANSITIVE half of the ordering guard (#1036).**
 *
 *  The guard above reads main.ts's own source, so it can only see a `getPath('userData')`
 *  written THERE. #1036 put a recents lookup above the setPath, and that lookup reaches into
 *  `projects.ts` — which is where such a read would now hide, invisible to the source-order
 *  check and to every unit test.
 *
 *  Recents live outside userData ON PURPOSE (projects.ts: "All recents live under a FIXED
 *  modoki-app dir … NOT app.getPath('userData')"). That comment is the intent; this is the
 *  enforcement. If it ever becomes false, `app.setName`/`setPath` is silently demoted exactly
 *  as it was in ff364b47 — no throw, no log, the profile just moves. */
describe('recents must not be keyed on userData — the transitive ordering invariant (#1036)', () => {
  const src = readScannedSource(path.join(__dirname, '..', '..', 'electron', 'projects.ts')).code;

  it('projects.ts never reads app.getPath("userData")', () => {
    expect(src).not.toMatch(/getPath\(\s*['"]userData['"]\s*\)/);
  });

  it('…and derives the recents dir from appData instead', () => {
    // Pins the positive too: a guard that only bans something passes just as well on an empty
    // file, or on one that stopped deriving the path here at all.
    expect(src).toMatch(/getPath\(\s*['"]appData['"]\s*\)/);
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
  const raw = readScannedSource(path.join(__dirname, '..', '..', 'electron', 'main.ts')).code;
  // ⚠️ No private comment blanker (#816): `raw` here comes from a stripped read, so a comment
  // line is already whitespace and this filter matched nothing. It was the #419 multiplicity
  // in a shape that rule cannot see — it bans `.replace(...)` strippers, not a line filter.
  const src = raw;

  it('adoptLegacyToolchain runs at module scope, above initFileLog()', () => {
    expect(src.indexOf('adoptLegacyToolchain(')).toBeGreaterThan(-1);
    expect(src.indexOf('adoptLegacyToolchain(')).toBeLessThan(src.indexOf('initFileLog();'));
  });

  it('it runs BEFORE the first ensureNodeProvisioned() call site', () => {
    expect(src.indexOf('adoptLegacyToolchain(')).toBeLessThan(src.indexOf('ensureNodeProvisioned()'));
  });
});
