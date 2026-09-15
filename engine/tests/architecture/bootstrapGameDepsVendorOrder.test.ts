/** `bootstrap-game-deps.mjs` must vendor engine plugins BEFORE installing a game's deps, and
 *  record the vendor marker only AFTER the install succeeds (#650, the smaller half of that
 *  issue). `engine/electron/main.ts`'s `ensureProjectDeps` already runs vendor → install →
 *  write-marker in that order, with its own vendoring-failure `catch` comment explaining why: vendoring is
 *  what rewrites an engine plugin's dep from the placeholder `"*"` to a real
 *  `file:plugins/<name>-<hash>.tgz`, and those plugins are not on the public npm registry — so
 *  installing first (or never vendoring at all, which is what this script did before #650) means
 *  `npm install` here can resolve a STALE committed tarball spec with no error at all.
 *
 *  Why a SOURCE assertion — same posture as `cliNativeBuildHeals.test.ts` (see its header): this
 *  script runs from the root `postinstall`, over every real project in the repo; actually
 *  exercising the ordering would mean running a real `npm install` per project, far too heavy for
 *  `npm test`. `engine/tests/electron/projectDeps.test.ts` covers `main.ts`'s OWN helpers
 *  (`composeDepsInstallError`, `hasStaleWorkspaceLink`) but — checked while writing this test —
 *  does not itself assert `main.ts`'s vendor-before-install ORDERING behaviourally either; that
 *  fact lives only in `main.ts`'s source today. This is the first behavioural-shape (source)
 *  guard for the ordering, on the `bootstrap-game-deps.mjs` side of it. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';
import { accessPath, callsTo, enclosingFunction, importBindings, parseSource, precedingStatements, stringValueOf, ts } from '@modoki/engine/testing/sourceAst';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const script = path.join(repoRoot, 'engine', 'scripts', 'bootstrap-game-deps.mjs');
const src = readScannedSource(script).code;

// ⚠️ **Read through the parser (#1195).** The ordering used to be the first TEXT occurrence of each call
// (`indexOf`), "inside the install's try" the offsets between an install log line and the next
// `'} catch (e) {'`, and the vendoring catch body the text from `'catch (e) {'` to the next `'\n  }'` — so a
// second call, a reworded log line or a re-indented closer each moved what was being checked.

/** The three calls this ordering is about, each exactly once. */
function orderingCalls(sf: ts.SourceFile): { vendor: ts.CallExpression; install: ts.CallExpression; marker: ts.CallExpression } {
  const one = (what: string, calls: ts.CallExpression[]) => {
    expect(calls.length, `expected exactly one ${what} in bootstrap-game-deps.mjs`).toBe(1);
    return calls[0]!;
  };
  return {
    vendor: one('vendorEnginePlugins(…)', callsTo(sf, 'vendorEnginePlugins')),
    install: one("npmRun(['install', …])", callsTo(sf, 'npmRun').filter((c) => {
      const list = c.arguments[0];
      return !!list && ts.isArrayLiteralExpression(list) && stringValueOf(list.elements[0]) === 'install';
    })),
    marker: one('writeVendorMarker(…)', callsTo(sf, 'writeVendorMarker')),
  };
}

/** Whether `earlier` sits in a statement that has already RUN whenever `later`'s statement runs — an earlier
 *  statement of a list enclosing `later`, up to its function — and runs in that same function: a closure merely
 *  DEFINED earlier has not run. */
function runsBefore(earlier: ts.Node, later: ts.Node): boolean {
  return enclosingFunction(earlier) === enclosingFunction(later)
    && precedingStatements(later).some((s) => s.pos <= earlier.pos && earlier.end <= s.end);
}

/** The nearest `try` whose TRY block holds `n` (not its catch or finally). */
function tryAround(n: ts.Node): ts.TryStatement | undefined {
  for (let cur: ts.Node = n; cur.parent; cur = cur.parent) {
    if (ts.isTryStatement(cur.parent) && cur.parent.tryBlock === cur) return cur.parent;
  }
  return undefined;
}

/** Whether a vendoring error is caught AND its catch closes before the install: the nearest `try` around the vendor
 *  call has a catch and ends before the install starts. A vendor call moved into the install's own `try` has a catch
 *  too, and a vendoring throw then jumps past the install (#1195 close-out, third §2d round). */
function vendorErrorAbsorbedBeforeInstall(vendor: ts.Node, install: ts.Node): boolean {
  const t = tryAround(vendor);
  return !!t?.catchClause && t.end <= install.getStart();
}

/** Every way the install can be skipped once `vendor` has run, in source order:
 *  - an exit after the vendor call and before the install call in the SAME function — the vendoring catch, and
 *    any statement between the two: `return`, `throw`, `process.exit(…)`, and a `break`/`continue` whose target
 *    loop or switch is NOT itself wholly between them (one leaving an inner loop there skips nothing);
 *  - `gated`: anything wrapped around the install below the node that also holds the vendor call that may not
 *    evaluate it — an `if`/`else` branch, a `? :` arm, the right of `&&`/`||`/`??`/`||=`, a `switch` case, a loop
 *    body that may run zero times, a `catch`, an optional chain. What evaluates it unconditionally is allowed: a
 *    block, its statement or declaration, a `try` block or `finally`, `await`, parentheses, a call's callee or
 *    argument, a property read on it, a test of an `if`/`switch`/`while`, a `do` body, the left of any operator.
 *
 *  ⚠️ Not just the catch (#1195 close-out review). The text reader this replaced scanned everything from the
 *  vendor call to the install call (its `'\n  }'` closer never matched this file's indent), so an
 *  `if (!vendorResult) continue;` placed between them was red; a catch-only reader passed it. And a `break` here
 *  leaves the per-project loop, skipping this project and every later one (§2d re-review). `gated` is an
 *  allowlist of what cannot skip, not a list of what can: `guardsOf` models `if`/`? :`/`&&`/`||`, and
 *  `r ?? npmRun(…)`, `r ||= npmRun(…)` or a `switch` around the install each passed it (second §2d round). */
function exitsBetween(vendor: ts.Node, install: ts.Node): string[] {
  const fn = enclosingFunction(install);
  const out: string[] = [];
  const visit = (x: ts.Node): void => {
    if (x !== fn && ts.isFunctionLike(x)) return;
    if (x.pos >= vendor.end && x.end <= install.pos) {
      if (ts.isContinueStatement(x) || ts.isBreakStatement(x)) {
        const target = jumpTarget(x);
        const inside = !!target && target.pos >= vendor.end && target.end <= install.pos;
        if (!inside) out.push(ts.isBreakStatement(x) ? 'break' : 'continue');
      } else if (ts.isReturnStatement(x)) out.push('return');
      else if (ts.isThrowStatement(x)) out.push('throw');
      else if (ts.isCallExpression(x) && accessPath(x.expression) === 'process.exit') out.push('process.exit');
    }
    ts.forEachChild(x, visit);
  };
  visit(fn);
  const transparent = (child: ts.Node, parent: ts.Node): boolean => {
    // An optional chain may short-circuit before it reaches the install — unless the install is its head, which runs first.
    if (ts.isOptionalChain(parent as ts.Expression) && (parent as ts.PropertyAccessExpression | ts.CallExpression).expression !== child) return false;
    if (ts.isBlock(parent) || ts.isExpressionStatement(parent) || ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent)
      || ts.isVariableStatement(parent) || ts.isVariableDeclarationList(parent) || ts.isVariableDeclaration(parent)
      || ts.isTryStatement(parent) // its block or `finally`; a `catch` is gated by the CatchClause above it
      || ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent) || ts.isPrefixUnaryExpression(parent)
      || ts.isPostfixUnaryExpression(parent) || ts.isTypeOfExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)
      || ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent) || ts.isReturnStatement(parent)) return true;
    // Evaluated before anything decides: a call's callee and arguments, an `if`/`switch`/`while` test, a `do` body,
    // a condition's test, and either side of a binary operator except the right of `&&`/`||`/`??` (and their `=`).
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return true;
    if ((ts.isIfStatement(parent) || ts.isSwitchStatement(parent) || ts.isWhileStatement(parent)) && parent.expression === child) return true;
    if (ts.isDoStatement(parent)) return true;
    if (ts.isConditionalExpression(parent)) return parent.condition === child;
    if (ts.isBinaryExpression(parent)) {
      const shortCircuit = [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken];
      return parent.left === child || !shortCircuit.includes(parent.operatorToken.kind);
    }
    return false;
  };
  for (let n: ts.Node = install; n.parent && !(n.parent.pos <= vendor.pos && vendor.end <= n.parent.end); n = n.parent) {
    if (!transparent(n, n.parent)) { out.push('gated'); break; }
  }
  return out;
}

/** The loop or switch a `break`/`continue` leaves: the labelled statement's body, or the nearest enclosing
 *  iteration statement (and, for an unlabelled `break`, switch). */
function jumpTarget(j: ts.BreakOrContinueStatement): ts.Node | undefined {
  if (j.label) {
    const labelled = ts.findAncestor(j, (a): a is ts.LabeledStatement => ts.isLabeledStatement(a) && a.label.text === j.label!.text);
    return labelled?.statement;
  }
  return ts.findAncestor(j.parent, (a) => ts.isIterationStatement(a, false) || (ts.isBreakStatement(j) && ts.isSwitchStatement(a)) || ts.isFunctionLike(a));
}

describe('bootstrap-game-deps.mjs vendors before installing (#650)', () => {
  const sf = parseSource(src, 'bootstrap-game-deps.mjs');

  it('loads vendorPlugins.ts through the shared loadVendorPlugins.mjs seam (plain .mjs cannot import TypeScript)', () => {
    expect(importBindings(sf, './loadVendorPlugins.mjs').filter((b) => !b.typeOnly).map((b) => b.imported)).toContain('loadVendorPlugins');
  });

  it('calls vendorEnginePlugins and npmRun([\'install\'...) — the two calls this ordering is about', () => {
    const { vendor, install } = orderingCalls(sf);
    expect(vendor && install).toBeTruthy();
  });

  it('runs vendorEnginePlugins BEFORE the install call for each project', () => {
    const { vendor, install } = orderingCalls(sf);
    expect(runsBefore(vendor, install)).toBe(true);
  });

  it('writes the vendor marker AFTER the install call, not before', () => {
    const { install, marker } = orderingCalls(sf);
    expect(runsBefore(install, marker)).toBe(true);
  });

  it('the marker write sits INSIDE the install\'s own try block (only meaningful once install succeeded)', () => {
    // A marker written after a FAILED install would record a vendor spec nothing actually installed.
    const { install, marker } = orderingCalls(sf);
    expect(tryAround(install), 'the install is no longer inside a try').toBeDefined();
    expect(tryAround(marker)).toBe(tryAround(install));
  });

  it('vendoring failure is non-fatal — the install still runs (a game with no engine plugin still installs fine)', () => {
    // The vendoring call is caught, and nothing between it and the install — its catch included — can skip
    // the install: a caught vendoring error, or a project with nothing to vendor, must fall through to it.
    const { vendor, install } = orderingCalls(sf);
    expect(vendorErrorAbsorbedBeforeInstall(vendor, install), 'vendorEnginePlugins is no longer inside a try whose catch closes before the install').toBe(true);
    expect(exitsBetween(vendor, install)).toEqual([]);
  });

  it('reads the calls, their order, the try and every exit between them as nodes (#1195)', () => {
    const probe = parseSource([
      'for (const g of games) {',
      '  if (mod) {',
      "    try { r = mod.vendorEnginePlugins(g); } catch (e) {\n      warn(`}`);\n  if (bad(e)) continue;\n    }",
      '  }',
      "  const later = () => { try { x(); } catch { return; } };",
      "  try { npmRun(['install', '--no-audit'], g); if (r) mod.writeVendorMarker(g); } catch (e) { continue; }",
      '}',
    ].join('\n'), 'probe.mjs');
    const { vendor, install, marker } = orderingCalls(probe);
    expect(runsBefore(vendor, install)).toBe(true);
    expect(runsBefore(install, vendor)).toBe(false);
    expect(runsBefore(install, marker)).toBe(true);
    expect(tryAround(marker)).toBe(tryAround(install));
    // The catch's `continue` counts; the nested closure's `return`, and the install's own catch, do not.
    expect(exitsBetween(vendor, install)).toEqual(['continue']);
    // A marker in the catch is not in the install's try; a call outside any try has none.
    const inCatch = parseSource("try { npmRun(['install']); } catch (e) { writeVendorMarker(g); }\nvendorEnginePlugins(g);", 'p2.mjs');
    const c2 = orderingCalls(inCatch);
    expect(tryAround(c2.marker)).toBeUndefined();
    expect(tryAround(c2.vendor)).toBeUndefined();
    expect(() => orderingCalls(parseSource("npmRun(['ci']); vendorEnginePlugins(); writeVendorMarker();", 'p3.mjs'))).toThrow(/npmRun/);
    // Between the catch and the install: a skip, an exit, a throw — each counted; a `break` in a nested loop is not.
    const between = (mid: string) => {
      const c = orderingCalls(parseSource(`function f() { for (const g of gs) {\n  try { vendorEnginePlugins(g); } catch {}\n  ${mid}\n  npmRun(['install']); writeVendorMarker(g);\n} }`, 'p4.mjs'));
      return exitsBetween(c.vendor, c.install);
    };
    expect(between('if (!r) continue;')).toEqual(['continue']);
    expect(between("if (!r) process.exit(1);")).toEqual(['process.exit']);
    expect(between("if (!r) throw new Error('x');")).toEqual(['throw']);
    expect(between('if (!r) return;')).toEqual(['return']);
    expect(between('for (const x of xs) { if (x) break; }')).toEqual([]);
    expect(between('for (const x of xs) { if (x) continue; }')).toEqual([]);
    // …but one leaving the per-project loop skips this and every later install, and a gate around the install skips it too.
    expect(between('if (!r) break;')).toEqual(['break']);
    const gated = orderingCalls(parseSource("for (const g of gs) {\n  try { vendorEnginePlugins(g); } catch {}\n  if (r || !mod) { npmRun(['install']); writeVendorMarker(g); }\n}", 'p5.mjs'));
    expect(exitsBetween(gated.vendor, gated.install)).toEqual(['gated']);
    const catchBreak = orderingCalls(parseSource("for (const g of gs) {\n  try { vendorEnginePlugins(g); } catch { warn(); break; }\n  npmRun(['install']); writeVendorMarker(g);\n}", 'p6.mjs'));
    expect(exitsBetween(catchBreak.vendor, catchBreak.install)).toEqual(['break']);
    // A labelled break from an inner loop leaves the per-project loop; a `switch` is a `break` target, never a
    // `continue` one (second §2d round).
    const labelled = orderingCalls(parseSource("outer: for (const g of gs) {\n  try { vendorEnginePlugins(g); } catch {}\n  for (const x of xs) { if (x) break outer; }\n  npmRun(['install']); writeVendorMarker(g);\n}", 'p7.mjs'));
    expect(exitsBetween(labelled.vendor, labelled.install)).toEqual(['break']);
    expect(between('switch (k) { case 1: continue; }')).toEqual(['continue']);
    expect(between('switch (k) { case 1: break; }')).toEqual([]);
    // Every other wrapper that can skip the install is `gated`; one that cannot, and a gate the vendor call
    // shares, are not.
    const wrapped = (install: string, before = '') => {
      const c = orderingCalls(parseSource(`async function f() { for (const g of gs) {\n  try { vendorEnginePlugins(g); } catch {}\n  ${before}${install}\n  writeVendorMarker(g);\n} }`, 'p8.mjs'));
      return exitsBetween(c.vendor, c.install);
    };
    for (const shape of ["r ?? npmRun(['install']);", "r ||= npmRun(['install']);", "switch (r ? 1 : 0) { case 1: npmRun(['install']); }",
      "for (const _ of (r ? [1] : [])) { npmRun(['install']); }", "while (!r) { npmRun(['install']); }", "r ? npmRun(['install']) : 0;",
      "try { check(); } catch { npmRun(['install']); }"]) {
      expect(wrapped(shape), shape).toEqual(['gated']);
    }
    expect(wrapped("try { const out = await (npmRun(['install'])); } catch (e) { continue; }")).toEqual([]);
    expect(wrapped("try { check(); } finally { npmRun(['install']); }")).toEqual([]);
    // An install evaluated unconditionally by what wraps it is not gated (third §2d round)…
    for (const shape of ["res = npmRun(['install']);", "log(npmRun(['install']));", "npmRun(['install']).toString();",
      "const ok = npmRun(['install']).length;", "if (npmRun(['install']).status !== 0) throw new Error('x');",
      "do { npmRun(['install']); } while (false);", "const s = npmRun(['install']) ?? 0;", "npmRun(['install']) ? a() : b();", "if (npmRun(['install'])?.status) log();"]) {
      expect(wrapped(shape), shape).toEqual([]);
    }
    // …but an optional chain, a `? :` arm and the right of an `&&` still are.
    for (const shape of ["r?.done(npmRun(['install']));", "const s = r ? 0 : npmRun(['install']).status;", "ok && log(npmRun(['install']));"]) {
      expect(wrapped(shape), shape).toEqual(['gated']);
    }
    // A vendoring error must be absorbed by a catch that closes before the install, not by the install's own.
    const absorbed = (body: string) => {
      const c = orderingCalls(parseSource(`for (const g of gs) {\n${body}\n  writeVendorMarker(g);\n}`, 'p10.mjs'));
      return vendorErrorAbsorbedBeforeInstall(c.vendor, c.install);
    };
    expect(absorbed("  try { vendorEnginePlugins(g); } catch {}\n  try { npmRun(['install']); } catch { continue; }")).toBe(true);
    expect(absorbed("  try { vendorEnginePlugins(g);\n    npmRun(['install']); } catch { continue; }")).toBe(false);
    expect(absorbed("  try { vendorEnginePlugins(g); } finally {}\n  npmRun(['install']);")).toBe(false);
    const shared = orderingCalls(parseSource("for (const g of gs) {\n  if (mod) {\n    try { vendorEnginePlugins(g); } catch {}\n    npmRun(['install']);\n  }\n  writeVendorMarker(g);\n}", 'p9.mjs'));
    expect(exitsBetween(shared.vendor, shared.install)).toEqual([]);
    // A vendoring closure DEFINED before the install has not run before it.
    const defined = orderingCalls(parseSource("const later = () => vendorEnginePlugins(g);\nnpmRun(['install']);\nwriteVendorMarker(g);", 'p6.mjs'));
    expect(runsBefore(defined.vendor, defined.install)).toBe(false);
  });
});
