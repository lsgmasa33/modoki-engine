import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import realFs from 'node:fs';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { calleeName, callsTo, callsToPath, enclosingFunction, enclosingNamedFunction, flatText, lineOf, parseSource, referencesToPath, statementOf, stringValueOf, ts, unwrapValue } from '@modoki/engine/testing/sourceAst';
import {
  resolveUserDataDir,
  resolveToolchainDir,
  shouldOverrideUserData,
  adoptLegacyToolchain,
  adoptLegacyEditorState,
  multiProfileKey,
  PACKAGED_DIR,
  DEV_DIR,
} from '../../electron/userDataDir';
import { makeDirLink } from '../helpers/linkFixture';
import { readCdpEnabled } from '../../electron/cdp';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

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
    base = makeScratchDir('udd-899-', { canonical: true });
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
 * This broke for real: `initFileLog()` (added to main.ts's top level by ff364b47, a Windows crash
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
  const src = raw;
  // ⚠️ **Positions come from the PARSE, not `src.indexOf("app.setPath('userData'")` (#1179).** A
  // formatter-wrapped `app.setPath(\n  'userData', …)` made that `-1`, and `expect(-1)
  // .toBeLessThan(initFileLog)` PASSED — the one ordering this describe exists for went green on a
  // file where it could no longer find the setPath at all. Every anchor below is a found CALL.
  const sf = parseSource(src, 'main.ts');
  const userDataCalls = (method: string): ts.CallExpression[] =>
    callsToPath(sf, method).filter((c) => stringValueOf(c.arguments[0]) === 'userData');
  const setPaths = userDataCalls('app.setPath');
  const at = setPaths[0]?.getStart(sf) ?? Number.NaN;
  /** Start offset of the first CALL named `name`, or NaN (which no comparison passes). */
  const firstCallAt = (name: string): number => callsTo(sf, name)[0]?.getStart(sf) ?? Number.NaN;
  /**
   * Where a call runs, for a ledger key: the nearest NAMED function (or `<module>`), then — when the
   * call sits in an anonymous callback below that — the SHORT name of the call the callback is handed
   * to, with its first string argument when it has one: `<module>>then(…)`,
   * `<module>>handle('modoki:x')`, `outer>forEach(…)`.
   *
   * ⚠️ Short names on purpose, and the named function always kept (#1179 P1 re-review): keyed on the
   * host call's full text, a `.catch` handler off `app.whenReady().then(async () => { …800 lines… })`
   * got an 18 KB key that went stale on any edit to startup; and returning the innermost host INSTEAD
   * of the named function let `memo(() => …)` carry a pardon into any other function using `memo`.
   */
  const scopeOf = (c: ts.Node): string => {
    const named = enclosingNamedFunction(c);
    let host = '';
    for (let cur = c.parent; cur && cur !== named?.node; cur = cur.parent) {
      const p = cur.parent;
      if (!ts.isFunctionLike(cur) || !p || !(ts.isCallExpression(p) || ts.isNewExpression(p))) continue;
      const callee = ts.isNewExpression(p) ? `new ${flatText(p.expression)}` : calleeName(p) ?? '<?>';
      const tag = p.arguments?.[0] && stringValueOf(p.arguments[0]);
      host = `>${callee}(${tag === undefined ? '…' : `'${tag}'`})`;
      break; // the innermost host — the named function above it is already in the key
    }
    return `${named?.name ?? '<module>'}${host}`;
  };
  const VITE_CACHE_FN = '<module>>then(…)';
  /** True when `c` sits in the THEN branch of an `if` whose condition IS `shouldOverrideUserData(
   *  process.argv)` — `!shouldOverrideUserData(…)` and `… || true` merely contain the call, and each
   *  inverts or voids the gate (#1179 P1 re-review). */
  const gatedByOverride = (c: ts.Node): boolean => {
    for (let cur: ts.Node = c; cur.parent; cur = cur.parent) {
      const p = cur.parent;
      if (!ts.isIfStatement(p) || p.thenStatement !== cur) continue;
      const cond = unwrapValue(p.expression);
      if (ts.isCallExpression(cond) && calleeName(cond) === 'shouldOverrideUserData' && cond.arguments.length === 1
        && flatText(cond.arguments[0]!) === 'process.argv') return true;
    }
    return false;
  };

  it('guards the setPath behind shouldOverrideUserData (never clobber --user-data-dir)', () => {
    // ⚠️ THE setPath call itself must sit in the THEN branch of an `if` whose condition calls
    // `shouldOverrideUserData(process.argv)` (#1179 P1 review). This was a whole-file regex: moving
    // the setPath below the closing brace made it unconditional, clobbering `--user-data-dir`, with
    // the regex still satisfied by the `if` left behind.
    expect(setPaths.map(gatedByOverride)).toEqual([true]);
  });

  it('the gate detector accepts only THE call as the condition, and only its then-branch (#1179 re-review)', () => {
    const probe = parseSource([
      "if (shouldOverrideUserData(process.argv)) { app.setPath('userData', a); }",
      "if (!shouldOverrideUserData(process.argv)) app.setPath('userData', b);",
      "if (shouldOverrideUserData(process.argv) || true) app.setPath('userData', c);",
      "if (shouldOverrideUserData(process.argv)) {} else { app.setPath('userData', d); }",
      "if (shouldOverrideUserData(process.argv)) {}\napp.setPath('userData', e);",
    ].join('\n'), 'probe.ts');
    expect(callsToPath(probe, 'app.setPath').map(gatedByOverride)).toEqual([true, false, false, false, false]);
  });

  it('scopeOf keys a call by its named function PLUS a short host, never a host that swallows the function (#1179 re-review)', () => {
    const probe = parseSource([
      "function outer() { arr.forEach(() => { app.getPath('userData'); }); }",
      "function editorStateDir() { return memo(() => app.getPath('userData')); }",
      "function crashDumpDir() { return memo(() => app.getPath('userData')); }",
      "app.whenReady().then(async () => { longBody(); }).catch((e) => { app.getPath('userData'); });",
      "ipcMain.handle('modoki:x', async () => { app.getPath('userData'); });",
      "new Promise((r) => { app.getPath('userData'); });",
      "app.getPath('userData');",
    ].join('\n'), 'probe.ts');
    expect(callsToPath(probe, 'getPath').map(scopeOf)).toEqual([
      'outer>forEach(…)', 'editorStateDir>memo(…)', 'crashDumpDir>memo(…)', '<module>>catch(…)',
      "<module>>handle('modoki:x')", '<module>>new Promise(…)', '<module>',
    ]);
  });

  it("calls app.setPath('userData', …) exactly once", () => {
    expect(setPaths).toHaveLength(1);
  });

  it('…and that call, and every initFileLog() call, runs at MODULE LOAD — source order is only run order there', () => {
    // Every ordering check below compares source POSITIONS. That is run order only for code that
    // runs as the module loads: a setPath moved into `const later = () => app.setPath(…)` keeps its
    // position above initFileLog() and runs after it (found by the #1179 mutation check); and an
    // `initFileLog()` moved into `function bootLog()` that is CALLED above the setPath keeps its
    // position below it and runs first (#1179 P1 review).
    //
    // ⚠️ NOT covered: `chooseInitialProject` runs inside the memo `initialProjectChoice()`, so its
    // position is not its run time, and the "decides the project ABOVE the setPath" check below reads
    // the memo body's position. Pre-existing; resolving call order is not a source-position question.
    expect(setPaths.map((c) => ts.isSourceFile(enclosingFunction(c)))).toEqual([true]);
    const logInits = callsTo(sf, 'initFileLog');
    expect(logInits.length).toBeGreaterThanOrEqual(1);
    expect(logInits.filter((c) => !ts.isSourceFile(enclosingFunction(c))).map((c) => `main.ts:${lineOf(c)}`)).toEqual([]);
  });

  it('setPath comes BEFORE initFileLog() — the reader that caused the regression', () => {
    expect(Number.isFinite(at) && Number.isFinite(firstCallAt('initFileLog'))).toBe(true);
    expect(at).toBeLessThan(firstCallAt('initFileLog'));
  });

  it('NO getPath("userData") appears above the setPath', () => {
    expect(Number.isFinite(at)).toBe(true);
    expect(userDataCalls('getPath').filter((c) => c.getStart(sf) < at).map((c) => `main.ts:${lineOf(c)}`)).toEqual([]);
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
    // the DECLARATION is below the setPath; any READ of it above — a call, or the function handed
    // on to be called — reads the wrong dir. A declaration's own name is not a read.
    expect(Number.isFinite(at)).toBe(true);
    expect(referencesToPath(sf, 'editorStateDir').filter((r) => r.getStart(sf) < at).map((r) => `main.ts:${lineOf(r)}`)).toEqual([]);
  });

  /** ⚠️ The same ordering hazard one level up (#1036 §2d review F1, second half). The memoised
   *  project decision reads recents, and `getRecentProjects()` resolves to the SCOPED file only
   *  once `setRecentsScope` has run. Move that call below the profile block — a plausible tidy-up,
   *  since it reads as "recents setup" next to "profile setup" — and the memo silently reads
   *  `globalRecentsFile()`, the pre-scoping junk drawer that mixes every clone's projects. The
   *  `getRecentProjects()` count-of-one guard below still passes. */
  it('setRecentsScope runs BEFORE the project decision that reads recents', () => {
    const scope = firstCallAt('setRecentsScope');
    const choice = firstCallAt('chooseInitialProject');
    expect(Number.isFinite(scope) && Number.isFinite(choice)).toBe(true);
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
    expect(Number.isFinite(at) && Number.isFinite(firstCallAt('chooseInitialProject'))).toBe(true);
    expect(firstCallAt('chooseInitialProject')).toBeLessThan(at);
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
    expect(Number.isFinite(at)).toBe(true);
    const above = src.slice(0, at);
    expect(above).not.toMatch(/MODOKI_PROJECT\s*(\|\||\?\?)/);
    expect(above).not.toMatch(/recents\s*\[\s*0\s*\]/);
  });

  /** ⚠️ **The guard for the CLASS, not the two call sites I happened to fix** (#1036 review F1).
   *
   *  `getPath('userData')` is now the PROJECT profile. Every consumer must therefore make a
   *  decision — project-level or editor-level — and the first pass through this file got 2 of 7
   *  right by hand. The one that mattered: `readCdpEnabled`/`writeCdpEnabled` are an EDITOR
   *  preference, and `readCdpEnabled` defaults to ON when the file is absent (`cdp.ts`'s `readCdpEnabled`,
   *  opt-out model). Written under project A and read under project B, a user's decision to turn
   *  the remote-debugging port OFF silently reverts to ON, with the checkbox still showing OFF —
   *  deterministic on a fresh packaged install, whose first launch has no recents and so no
   *  sub-key. The port memos and `readLastPort`/`writeLastPort` are the same class.
   *
   *  So: an allowlist. A new `getPath('userData')` must either go through `editorStateDir()` or
   *  be added here WITH a reason — which is the point at which someone has to think about it.
   *
   *  ⚠️ **Reach: main.ts ONLY.** This scans one file, so it cannot see `fileLog.ts`'s `initFileLog` or
   *  `zoom.ts`'s `prefsFile`, both of which read `getPath('userData')` too. Both were audited by hand and
   *  are deliberate (logs follow the project so two editors stop interleaving one `main.log`;
   *  zoom's is the `--user-data-dir` fallback) — but do not read this guard as covering the
   *  whole class, because its docblock used to imply that. (#1036 §2d review F3.) */
  it('getPath("userData") appears ONLY at sanctioned sites — editor-level files use editorStateDir()', () => {
    // ⚠️ **SPENT per CALL, keyed by the statement it sits in (#1140, #1179).** These were four
    // regexes tested with `.some()` and no staleness check, so `/'vite-cache'/` pardoned every line
    // in main.ts that mentions the cache dir AND reads userData — a second consumer spelled near it
    // inherited the reason — and a site that moved to editorStateDir() left its regex pardoning
    // nothing, silently. Then they were keyed per LINE, and a wrapped `getPath(\n  'userData',\n)`
    // never entered the population at all. Now every `getPath('userData')` CALL is one occurrence,
    // keyed `<enclosing named function>::<statement, whitespace-collapsed>` — so, deliberately, a pure
    // re-wrap of a pardoned statement no longer reddens; changing what it DOES, or moving it to
    // another function, still does. ⚠️ The function name is load-bearing: keyed on the statement
    // alone, `return profileBaseDir ?? app.getPath('userData');` pardoned that body in ANY function, so
    // a `crashDumpDir()` copying it inherited the accessor's reason (#1179 P1 review).
    const allowed: ReadonlyArray<{ item: string; count?: number; reason: string }> = [
      { item: "editorStateDir::return profileBaseDir ?? app.getPath('userData');",
        reason: 'the accessor itself — its fallback when --user-data-dir was passed' },
      { item: `${VITE_CACHE_FN}::const cacheDir = path.join(app.getPath('userData'), 'vite-cache');`,
        reason: 'per-PROJECT dep-optimizer cache — correctly scoped to the project profile' },
      { item: `${VITE_CACHE_FN}::const sigFile = path.join(app.getPath('userData'), '.vite-cache-build');`,
        reason: 'the signature file pairing with vite-cache, same scope' },
      { item: `${VITE_CACHE_FN}::fs.mkdirSync(app.getPath('userData'), { recursive: true });`,
        reason: 'creating that same vite-cache parent' },
    ];
    assertExemptionLedger({
      label: 'allowed userData consumers in main.ts',
      population: userDataCalls('getPath').map((c) => {
        const item = `${scopeOf(c)}::${flatText(statementOf(c))}`;
        return { item, site: `main.ts:${lineOf(c)}  ${item}` };
      }),
      exempt: allowed,
      floor: 1,
      fix: 'a new userData consumer: use editorStateDir(), or add its line to `allowed` with a reason',
    });
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
   *  (`readScannedSource`), so the surviving explanatory mention in main.ts's `shouldOverrideUserData` block does not count. */
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
  beforeEach(() => { dir = makeScratchDir('modoki-tc-'); });
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

/** #1041 — `3c61ce6fe` (#1036) keyed the packaged profile, so an EXISTING install's state files sit
 *  one directory up and every reader keyed off `editorStateDir()` reads "absent" as "never chosen".
 *  `readCdpEnabled` fails OPEN on that, so a deliberately-closed CDP port silently reopens once.
 *
 *  ⚠️ The load-bearing pair is "legacy present → honoured" AND "both absent → still ON". Getting
 *  those backwards turns a one-launch reversion into a PERMANENT one, or breaks a clean install's
 *  agent-first default. Neither test can catch that alone. */
describe('adoptLegacyEditorState (#1041)', () => {
  let appData: string;
  /** The post-#1036 keyed profile: `<appData>/Modoki Editor/<install-id>`. */
  let target: string;
  const legacy = () => path.join(appData, PACKAGED_DIR);
  const seedLegacy = (name: string, body: string) => {
    realFs.mkdirSync(legacy(), { recursive: true });
    realFs.writeFileSync(path.join(legacy(), name), body);
  };
  const seedTarget = (name: string, body: string) => {
    realFs.mkdirSync(target, { recursive: true });
    realFs.writeFileSync(path.join(target, name), body);
  };
  const read = (name: string) => realFs.readFileSync(path.join(target, name), 'utf8');

  beforeEach(() => {
    appData = makeScratchDir('modoki-1041-');
    target = path.join(appData, PACKAGED_DIR, 'deadbeef');
  });
  afterEach(() => { realFs.rmSync(appData, { recursive: true, force: true }); });

  it('adopts a legacy CDP opt-OUT, so the port stays closed after the upgrade (the bug)', () => {
    seedLegacy('cdp.json', '{"enabled": false}');
    expect(adoptLegacyEditorState(appData, target, realFs)).toEqual(['cdp.json']);
    expect(readCdpEnabled(target)).toBe(false);
  });

  it('a clean install with NO legacy dir still defaults CDP ON (the other half of the pair)', () => {
    expect(adoptLegacyEditorState(appData, target, realFs)).toEqual([]);
    expect(readCdpEnabled(target)).toBe(true);
  });

  it('COPIES rather than moves — a sibling install must still find the opt-out', () => {
    seedLegacy('cdp.json', '{"enabled": false}');
    adoptLegacyEditorState(appData, target, realFs);
    expect(realFs.existsSync(path.join(legacy(), 'cdp.json'))).toBe(true);
    // …and a second install keyed differently adopts it independently.
    const other = path.join(appData, PACKAGED_DIR, 'feedface');
    expect(adoptLegacyEditorState(appData, other, realFs)).toEqual(['cdp.json']);
    expect(readCdpEnabled(other)).toBe(false);
  });

  it('NEVER clobbers a choice already made in the new profile — either direction', () => {
    seedLegacy('cdp.json', '{"enabled": false}');
    seedTarget('cdp.json', '{"enabled": true}');
    expect(adoptLegacyEditorState(appData, target, realFs)).toEqual([]);
    expect(readCdpEnabled(target)).toBe(true);

    const t2 = path.join(appData, PACKAGED_DIR, 'cafe0000');
    realFs.mkdirSync(t2, { recursive: true });
    realFs.writeFileSync(path.join(t2, 'cdp.json'), '{"enabled": false}');
    seedLegacy('cdp.json', '{"enabled": true}');
    expect(adoptLegacyEditorState(appData, t2, realFs)).toEqual([]);
    expect(readCdpEnabled(t2)).toBe(false);
  });

  it('adopts the whole state set, not just the file #1041 was filed about', () => {
    // Matched by EXTENSION — `ui-prefs.json` is a bare literal in zoom.ts, so a name list would
    // have missed it. These are the five real state files as of 2026-09-10.
    for (const n of ['cdp.json', 'cdp-port.json', 'backend-port.json', 'instance-tokens.json', 'ui-prefs.json']) {
      seedLegacy(n, '{}');
    }
    expect(adoptLegacyEditorState(appData, target, realFs).sort()).toEqual(
      ['backend-port.json', 'cdp-port.json', 'cdp.json', 'instance-tokens.json', 'ui-prefs.json'],
    );
  });

  it("leaves Chromium's own profile data alone — it is extension-less or directories", () => {
    // Verified against a real pre-#1036 profile: the only *.json at that root were ours.
    seedLegacy('cdp.json', '{"enabled": false}');
    for (const n of ['Preferences', 'Local State', 'Cookies', 'DIPS', 'Network Persistent State']) {
      seedLegacy(n, 'binary-ish');
    }
    realFs.mkdirSync(path.join(legacy(), 'GPUCache'), { recursive: true });
    expect(adoptLegacyEditorState(appData, target, realFs)).toEqual(['cdp.json']);
    expect(realFs.readdirSync(target)).toEqual(['cdp.json']);
  });

  /** ⚠️ The return value alone CANNOT fail here — `copyFileSync` on a directory throws EISDIR and
   *  the per-file catch swallows it, so `[]` comes back with or without the `isFile` check. The
   *  distinguishing observation is the target DIR: the guard skips before `mkdirSync`, so a legacy
   *  dir holding nothing but a `.json`-named FOLDER must not conjure an empty profile. */
  it('skips a DIRECTORY that happens to end in .json — without creating the profile dir', () => {
    realFs.mkdirSync(path.join(legacy(), 'weird.json'), { recursive: true });
    expect(adoptLegacyEditorState(appData, target, realFs)).toEqual([]);
    expect(realFs.existsSync(target)).toBe(false);
  });

  it('is idempotent — a second launch adopts nothing and changes nothing', () => {
    seedLegacy('cdp.json', '{"enabled": false}');
    expect(adoptLegacyEditorState(appData, target, realFs)).toEqual(['cdp.json']);
    expect(adoptLegacyEditorState(appData, target, realFs)).toEqual([]);
    expect(read('cdp.json')).toBe('{"enabled": false}');
  });

  /** ⚠️ Asserting only the `[]` return is UNFALSIFIABLE — with the never-clobber guard in place,
   *  every entry would `continue` anyway, and `copyFileSync(x, x)` throws into the per-file catch
   *  regardless. So this asserts the guard's own observable effect: it returns BEFORE the directory
   *  is ever read. A spy that throws on `readdirSync` is the only thing that can tell the two
   *  apart. */
  it('no-ops when the target IS the legacy dir (a pre-#1036 flat layout) — without even reading it', () => {
    seedLegacy('cdp.json', '{"enabled": false}');
    // RECORDS rather than throws: the function catches a failing `readdirSync` and returns `[]`,
    // so a tripwire that throws is swallowed and proves nothing — the first draft of this test.
    let didRead = false;
    const spy = {
      ...realFs,
      readdirSync: (p: string) => { didRead = true; return realFs.readdirSync(p) as unknown as string[]; },
    } as unknown as Parameters<typeof adoptLegacyEditorState>[2];
    expect(adoptLegacyEditorState(appData, legacy(), spy)).toEqual([]);
    expect(didRead, 'the unkeyed-target guard must return before the directory is read').toBe(false);
  });
});
