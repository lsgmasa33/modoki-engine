/** Guard: the packaged editor's Vite dep-cache bust signature is built from CONTENT, never
 *  from a file timestamp.
 *
 *  `main.ts` wipes `userData/vite-cache` when the app build changes, because Vite keys its
 *  dep-optimize cache on the LOCKFILE and would otherwise reuse a stale pre-bundled
 *  `@modoki/engine` chunk across an app update. The signature it compares must therefore be a
 *  stable property of the build.
 *
 *  It used to be `${version}:${size}:${mtimeMs}` of `__filename`, which CANNOT work in a
 *  packaged app (#21, measured on packaged Windows 2026-08-02): `__filename` is a path inside
 *  `app.asar`, and Electron's asar `stat` shim reports real sizes but FABRICATES timestamps —
 *  `mtimeMs` came back as the current wall-clock on every launch. The signature never matched
 *  itself, so the editor wiped and cold-re-optimized its entire dep graph on EVERY boot rather
 *  than only after an update. That is the precise opposite of the block's intent, and it meant
 *  every single launch paid the cold-scan race window that #21 is about.
 *
 *  The failure was invisible from the outside — the app booted fine, just always cold — and it
 *  is unreachable from a unit test (it needs a real packaged app + asar). Hence a source guard:
 *  a timestamp must never come back into this signature. The measurements and the general rule
 *  ("never key packaged-build identity on a file timestamp") live in docs/build.md § "Packaged
 *  editor loop", which owns them — this header covers only why the GUARD exists.
 *
 *  KNOWN GAP, accepted: this reads one file's signature block and what `buildSig` is computed from
 *  (see `bustBlock`). It cannot prove the signature is stable, only that it is not derived from the one
 *  input already known to be fabricated under asar. A future signature built from some other unstable
 *  input would pass, and so would a timestamp reaching it through a function call or a parameter. */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { calledNames, callsTo, declarationOf, findNodes, functionsNamed, parseSource, statementOf, ts, unwrapValue, variablesNamed } from '@modoki/engine/testing/sourceAst';

const mainTs = path.resolve(__dirname, '../../electron/main.ts');

const TIMESTAMPS = ['mtimeMs', 'mtime', 'ctimeMs', 'ctime', 'birthtimeMs', 'birthtime'];

interface BustBlock {
  /** The `try { … }` block that computes `buildSig` — the cache wipe and the browser-cache clear. */
  block: ts.Block;
  /** `buildSig`'s initializer, plus the declaration of every variable it reads — a destructure's pattern
   *  included — transitively, wherever in the file that variable is declared: everything the signature is
   *  computed from. */
  inputs: ts.Node[];
}

/**
 * The vite-cache bust block, from the parser (#1195), comments blanked by the shared scanner — this
 * file's own prose explains the mtime hazard at length and must not read as a violation of it.
 *
 * It used to be the text from the `try {` before `const sigFile = path.join` to the next
 * `process.env.MODOKI_VITE_CACHEDIR`: a timestamp read declared ABOVE that `try` and fed into the
 * signature was outside the slice, and a clear moved into the `catch` was still inside it.
 */
function bustBlock(code: string, label: string): BustBlock {
  const sf = parseSource(code, label);
  const sig = variablesNamed(sf, 'buildSig');
  expect(sig.length, `could not locate the vite-cache bust block (\`const buildSig\`) in ${label} — if it `
    + 'moved or was renamed, retarget this guard rather than deleting it').toBe(1);
  const tryStmt = ts.findAncestor(sig[0], ts.isTryStatement);
  expect(tryStmt && ts.findAncestor(sig[0], ts.isBlock) === tryStmt.tryBlock, `${label}: buildSig is no longer computed at the top of a try block`)
    .toBe(true);
  const inputs: ts.Node[] = [];
  const seen = new Set<ts.Node>();
  const follow = (n: ts.Node | undefined): void => {
    if (!n || seen.has(n)) return;
    seen.add(n);
    inputs.push(n);
    for (const id of findNodes(n, ts.isIdentifier)) {
      const d = declarationOf(id);
      // A parameter is not followed: its value comes from a caller, not from a declaration here.
      const decl = d && ts.findAncestor(d, (a) => ts.isVariableDeclaration(a) || ts.isFunctionLike(a));
      if (decl && ts.isVariableDeclaration(decl)) follow(decl);
    }
  };
  follow(sig[0].initializer);
  return { block: tryStmt!.tryBlock, inputs };
}

/** Every timestamp property `nodes` read — `st.mtimeMs`, `st['mtimeMs']`, `const { mtimeMs } = st` — once
 *  each however many of `nodes` hold it. A word in a string or a log message is not a read. */
function timestampReads(nodes: readonly ts.Node[]): string[] {
  const keys = new Set(nodes.flatMap((n) => [
    ...findNodes(n, ts.isIdentifier),
    ...findNodes(n, ts.isElementAccessExpression).map((ea) => ea.argumentExpression).filter(ts.isStringLiteralLike),
  ]));
  return [...keys].map((k) => k.text).filter((name) => TIMESTAMPS.includes(name));
}

/** The timestamps the bust block reads, or its signature is computed from. */
function signatureTimestamps({ block, inputs }: BustBlock): string[] {
  return timestampReads([block, ...inputs]);
}

/** The browser-cache clears in `block`, and whether each runs as a statement of its own in the SAME
 *  statement list as the dep-cache wipe (`fs.rmSync(cacheDir, …)`) — the branch the build signature
 *  decides, unconditionally within it. */
function clearsBesideWipe(block: ts.Block): Array<{ clear: string; besideWipe: boolean }> {
  const wipes = callsTo(block, 'rmSync').map((w) => statementOf(w).parent);
  expect(wipes.length, 'expected one dep-cache wipe (rmSync) in the bust block').toBe(1);
  return callsTo(block, 'clearBrowserCaches', 'clearCache', 'clearData')
    .map((c) => {
      const stmt = statementOf(c);
      const own = ts.isExpressionStatement(stmt) && unwrapValue(stmt.expression) === c;
      return { clear: c.expression.getText(), besideWipe: own && stmt.parent === wipes[0] };
    });
}

/** Whether the dep-cache wipe runs only when the signature CHANGED: some enclosing `if` holds it in its THEN-branch,
 *  and that `if`'s test is a signature change — a `!==`/`!=` with `buildSig` on one side and, on the other, a value
 *  that can be a prior signature (`isPriorValue`) — or an `&&` with such a comparison as one conjunct
 *  (it only narrows). No `||` that would wipe on another condition too, no wipe in the `else`. Without it the wipe
 *  (and the clear beside it) runs on every boot — #21's symptom by a different road (#1195 close-out review; the
 *  else-branch, the other side and the nested/`&&` accept shapes are the second §2d round). */
function isSignatureChange(e: ts.Expression): boolean {
  const t = unwrapValue(e);
  if (!ts.isBinaryExpression(t)) return false;
  if (t.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return isSignatureChange(t.left) || isSignatureChange(t.right);
  if (t.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken && t.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken) return false;
  const isSig = (x: ts.Expression) => { const u = unwrapValue(x); return ts.isIdentifier(u) && u.text === 'buildSig'; };
  return [[t.left, t.right], [t.right, t.left]].some(([sig, other]) => isSig(sig!) && isPriorValue(other!));
}

/** Whether `x` can be a PRIOR signature read from somewhere: a variable, a property or element read, or a call
 *  (`prev`, `state?.buildSig`, `prev.trim()`, `readFileSync(…)`) — and not a constant (a literal, `void`, a negated
 *  number, an array or object literal, or a `const` initialised to one), nor anything that reads `buildSig` itself.
 *  An allowlist: the denylist it replaced let `buildSig !== void 0`, `!== []` and `const none = ''` through, each
 *  a wipe on every boot (#1195 close-out, third §2d round). */
function isPriorValue(x: ts.Expression): boolean {
  const u = unwrapValue(x);
  const readShape = ts.isIdentifier(u) || ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u)
    || ts.isCallExpression(u) || ts.isAwaitExpression(u) || ts.isNonNullExpression(u);
  if (!readShape || isConstant(u)) return false;
  // `buildSig` as a VALUE; `state.buildSig` and `{ buildSig: … }` only name a property.
  return !findNodes(u, ts.isIdentifier).some((i) => i.text === 'buildSig'
    && !(ts.isPropertyAccessExpression(i.parent) && i.parent.name === i) && !(ts.isPropertyAssignment(i.parent) && i.parent.name === i));
}
function isConstant(x: ts.Expression): boolean {
  const u = unwrapValue(x);
  if (ts.isLiteralExpression(u) || ts.isNoSubstitutionTemplateLiteral(u) || ts.isVoidExpression(u)
    || ts.isArrayLiteralExpression(u) || ts.isObjectLiteralExpression(u)
    || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(u.kind)) return true;
  if (ts.isPrefixUnaryExpression(u)) return isConstant(u.operand);
  if (!ts.isIdentifier(u)) return false;
  if (u.text === 'undefined') return true;
  const d = declarationOf(u);
  return !!d && ts.isVariableDeclaration(d) && !!d.initializer && !!(ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) && isConstant(d.initializer);
}
function wipeGatedOnSignature(block: ts.Block): boolean {
  const wipes = callsTo(block, 'rmSync');
  expect(wipes.length, 'expected one dep-cache wipe (rmSync) in the bust block').toBe(1);
  const wipe = wipes[0]!;
  for (let n: ts.Node = wipe; n.parent && n !== block; n = n.parent) {
    const p = n.parent;
    if (ts.isIfStatement(p) && p.thenStatement === n && isSignatureChange(p.expression)) return true;
  }
  return false;
}

const main = () => readScannedSource(mainTs).code;

describe('packaged Vite dep-cache bust signature (#21)', () => {
  it('does not derive the signature from a file timestamp', () => {
    const offenders = signatureTimestamps(bustBlock(main(), 'main.ts'));
    expect(
      offenders,
      'Electron\'s asar stat shim fabricates timestamps for paths inside app.asar, so a '
        + 'timestamp-derived signature never matches itself and the dep cache is wiped on every '
        + 'boot (#21). Derive the signature from file CONTENT instead.',
    ).toEqual([]);
  });

  it('derives the signature from a content hash', () => {
    const { inputs } = bustBlock(main(), 'main.ts');
    expect(
      inputs.some((e) => calledNames(e).includes('createHash')),
      'the bust signature should hash the packaged main.cjs so it changes exactly when the '
        + 'build does — and not otherwise',
    ).toBe(true);
  });

  /** #110: wiping `vite-cache` alone accomplishes NOTHING across an app update. Vite serves
   *  `/deps/*.js?v=<browserHash>` as `Cache-Control: immutable`, and browserHash keys on the
   *  lockfile — not on @modoki/engine source — so an engine-only update leaves the dep URL
   *  byte-identical and Chromium replays the PRE-UPDATE body out of its own disk cache, which
   *  lives in userData and survives the update just like the dep-cache does. The freshly
   *  re-optimized chunk is never read and the renderer dies with "does not provide an export
   *  named '<newly-added export>'".
   *
   *  Measured on packaged Windows 0.3.7: the on-disk dep contained the export, its browserHash
   *  matched the failing URL's `?v=`, and clearing the browser caches (`Cache/` + `Code Cache/`)
   *  fixed it. The clears are therefore ONE fix, and this guard exists because dropping the
   *  browser half is invisible locally — it only bites on update-over-install, a path
   *  `smoke:packaged` never takes (it starts from a fresh profile).
   *
   *  Matches the `clearBrowserCaches()` helper OR a direct call, so the block can be refactored
   *  without tripping this — what must not happen is the browser cache going unclaimed entirely. It
   *  must run in the wipe's own branch: a clear in the `catch`, or on every boot, is not this fix. */
  it('clears the renderer browser caches alongside the dep-cache wipe', () => {
    const { block } = bustBlock(main(), 'main.ts');
    expect(
      clearsBesideWipe(block).some((c) => c.besideWipe),
      'the buildSig branch must ALSO clear the renderer\'s browser caches (clearBrowserCaches() '
        + '— session.clearCache() + session.clearCodeCaches()). Without it the vite-cache wipe is '
        + 'a no-op across an app update: the dep URL is unchanged and served immutable, so the '
        + 'renderer re-reads the stale pre-update chunk from disk and crashes on a newly-added '
        + 'export (#110).',
    ).toBe(true);
    expect(wipeGatedOnSignature(block), 'the wipe and the clear must run only when the build signature changed — '
      + 'unconditionally they cold-re-optimize on every boot, which is #21').toBe(true);
  });

  /** The helper must clear BOTH caches. They are separate Electron APIs over separate userData
   *  dirs, and the measured #110 repair deleted both — clearing only the HTTP cache would ship
   *  something narrower than what was demonstrated to work. */
  it('clearBrowserCaches clears the V8 code cache as well as the HTTP cache', () => {
    const fns = functionsNamed(parseSource(main(), 'main.ts'), 'clearBrowserCaches');
    expect(fns.length, 'clearBrowserCaches() not found in engine/electron/main.ts — if it was renamed, '
      + 'retarget this guard rather than deleting it').toBe(1);
    const called = calledNames(fns[0]!.body);
    expect(called.includes('clearCache'), 'must clear the HTTP cache').toBe(true);
    expect(
      called.includes('clearCodeCaches'),
      'must ALSO clear V8\'s compiled-code cache — a separate Electron API over a separate '
        + 'userData dir (Code Cache/). clearCache() does not touch it.',
    ).toBe(true);
  });

  it('reads the signature\'s inputs and the wipe\'s branch, not a slice of text (#1195)', () => {
    const probe = (body: string) => bustBlock(`async function boot() {\n${body}\n}`, 'probe.ts');
    // A timestamp declared ABOVE the try and fed in; one merely mentioned in a log message is not a read.
    const above = probe("const stamp = fs.statSync(__filename)['mtimeMs'];\ntry { const v = `${stamp}`; const buildSig = `${v}`; } catch {}");
    expect(signatureTimestamps(above)).toEqual(['mtimeMs']);
    const destructured = probe('const { mtime: t } = fs.statSync(f);\ntry { const buildSig = String(t); } catch {}');
    expect(signatureTimestamps(destructured)).toEqual(['mtime']);
    const logged = probe("try { const hash = createHash('sha256').digest('hex'); const buildSig = hash; console.log('not mtime'); } catch {}");
    expect(signatureTimestamps(logged)).toEqual([]);
    // A read inside the block that ALSO feeds the signature is one read, not two.
    expect(signatureTimestamps(probe('try { const t = st.mtimeMs; const buildSig = String(t); } catch {}'))).toEqual(['mtimeMs']);
    // The wipe gated on the signature, and not.
    expect(wipeGatedOnSignature(probe('try { const buildSig = h; if (prev !== buildSig) { fs.rmSync(d); } } catch {}').block)).toBe(true);
    expect(wipeGatedOnSignature(probe('try { const buildSig = h; { fs.rmSync(d); } } catch {}').block)).toBe(false);
    expect(wipeGatedOnSignature(probe('try { const buildSig = h; if (other) { fs.rmSync(d); } } catch {}').block)).toBe(false);
    expect(wipeGatedOnSignature(probe('try { const buildSig = h; if (prev !== buildSig || app.isPackaged) { fs.rmSync(d); } } catch {}').block)).toBe(false);
    expect(wipeGatedOnSignature(probe('try { const buildSig = h; if (prev !== buildSig) fs.rmSync(d); } catch {}').block)).toBe(true);
    // The wipe in the ELSE runs exactly when the signature did not change; the other side must be a real prior value.
    expect(wipeGatedOnSignature(probe('try { const buildSig = h; if (prev !== buildSig) {} else { fs.rmSync(d); } } catch {}').block)).toBe(false);
    expect(wipeGatedOnSignature(probe("try { const buildSig = h; if (buildSig !== '') { fs.rmSync(d); } } catch {}").block)).toBe(false);
    expect(wipeGatedOnSignature(probe('try { const buildSig = h; if (buildSig != buildSig + 1) { fs.rmSync(d); } } catch {}').block)).toBe(false);
    // Constants on the other side, however spelled, wipe every boot; a stored format that names the property does not (third §2d round).
    for (const other of ['void 0', '[]', '-1', 'null', 'undefined', 'none', "'v' + 1"]) {
      expect(wipeGatedOnSignature(probe(`try { const none = ''; const buildSig = h; if (buildSig !== ${other}) { fs.rmSync(d); } } catch {}`).block), other).toBe(false);
    }
    // …including a `const` initialised to any constant spelling — but not a `let` a later read may overwrite.
    for (const init of ["''", 'void 0', '[]', '-1', 'null']) {
      expect(wipeGatedOnSignature(probe(`try { const none = ${init}; const buildSig = h; if (buildSig !== none) { fs.rmSync(d); } } catch {}`).block), init).toBe(false);
    }
    for (const other of ['prevState?.buildSig', 'JSON.parse(raw).buildSig', 'prev.trim()', 'await readPrev()', 'stored']) {
      expect(wipeGatedOnSignature(probe(`try { let stored = ''; if (fs.existsSync(f)) stored = load(); const buildSig = h; if (${other} !== buildSig) { fs.rmSync(d); } } catch {}`).block), other).toBe(true);
    }
    // Narrowing is still gated: an inner existence check, or an `&&` beside the comparison.
    expect(wipeGatedOnSignature(probe('try { const buildSig = h; if (prev !== buildSig) { if (fs.existsSync(d)) fs.rmSync(d); } } catch {}').block)).toBe(true);
    expect(wipeGatedOnSignature(probe('try { const buildSig = h; if (prev !== buildSig && !keep) { fs.rmSync(d); } } catch {}').block)).toBe(true);
    expect(wipeGatedOnSignature(probe('try { const buildSig = h; if (prev !== buildSig || keep) { fs.rmSync(d); } } catch {}').block)).toBe(false);
    expect(logged.inputs.some((e) => calledNames(e).includes('createHash'))).toBe(true);
    // A hash computed in the block but never fed to the signature is not what the signature derives from.
    const unused = probe("try { createHash('sha256'); const buildSig = `${app.getVersion()}`; } catch {}");
    expect(unused.inputs.some((e) => calledNames(e).includes('createHash'))).toBe(false);
    // A parameter's value comes from a caller: the function around it is not an input.
    const param = probe("const mk = (h) => { const unrelated = createHash('x'); try { const buildSig = h; } catch {} };");
    expect(param.inputs.some((e) => calledNames(e).includes('createHash'))).toBe(false);
    // The clear in the wipe's branch, beside it but outside the branch, and in the catch (not in the block at all).
    const clears = (tail: string) => clearsBesideWipe(probe(`try { const buildSig = h; if (prev !== buildSig) { fs.rmSync(d); ${tail} } } catch { await clearCache(); }`).block);
    expect(clears('await clearBrowserCaches();')).toEqual([{ clear: 'clearBrowserCaches', besideWipe: true }]);
    expect(clears('if (x) await session.clearData();')).toEqual([{ clear: 'session.clearData', besideWipe: false }]);
    expect(clears('')).toEqual([]);
    // Loud when the block cannot be found.
    expect(() => probe('const buildSig = 1;')).toThrow(/top of a try block/);
    expect(() => probe('try {} catch {}')).toThrow(/could not locate/);
  });
});
