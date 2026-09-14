/** Every project that declares dependencies must be INSTALLED by the root postinstall (#215).
 *
 *  `bootstrap-game-deps.mjs` used to select on `pkg.workspaces` alone, which reads as "does this
 *  project own sub-packages to link?" — and silently answered "no install needed" for the 14
 *  projects that own no sub-packages but do declare real dependencies. A fresh clone therefore got
 *  no `node_modules` for any of them, and their native builds failed at package resolution:
 *
 *      xcodebuild: error: Could not resolve package dependencies:
 *        the package at '…/games/court/node_modules/@capacitor/haptics' cannot be accessed
 *
 *  The committed `Package.swift` is right to point at the project's OWN node_modules (the
 *  self-contained-game rule); nothing populated it. It is also what makes `cap sync` rewrite that
 *  file into a portability violation — with the package missing locally, Capacitor resolves it to
 *  the repo root and writes an escaping path.
 *
 *  The SWEEP below is the assertion that matters: it walks the real projects on disk, so a project
 *  added later with dependencies and no `workspaces` key cannot reintroduce this silently. The
 *  unit cases just pin the rule's two independent halves.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectNeedsInstall } from '../../scripts/projectNeedsInstall.mjs';
import { discoverProjects } from '../../scripts/projectRoots.mjs';
// Project presence is asked in exactly ONE place (#98) — never an inline `existsSync('games')`.
import { hasAnyProject } from '../helpers/repoLayout';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { calleeName, declarationOf, enclosingFunction, findNodes, flatText, guardProves, guardsOf, lineOf, parseSource, ts, unwrapValue } from '@modoki/engine/testing/sourceAst';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Comments stripped via the shared scanner (@modoki/engine/testing, #419) — these scripts
 *  DISCUSS the wrong pattern at length, and matching prose instead of code is how a guard like
 *  this turns into a false positive. */
function codeOf(scriptName: string): string {
  const raw = readFileSync(path.join(repoRoot, 'engine', 'scripts', scriptName), 'utf8');
  const stripped = stripComments(raw);
  assertScanIsSane(raw, stripped, scriptName);
  return stripped;
}

/** Whether `e` names a path containing `node_modules` — a string holding it anywhere inside `e`, or a
 *  name bound (`const nm = …`) to such an expression. One hop: a name bound to a name is not followed. */
function namesNodeModules(e: ts.Expression): boolean {
  const isText = (x: ts.Node): x is ts.StringLiteralLike | ts.TemplateLiteralLikeNode => ts.isStringLiteralLike(x)
    || ts.isTemplateHead(x) || ts.isTemplateMiddle(x) || ts.isTemplateTail(x);
  const literal = (n: ts.Node) => findNodes(n, (x): x is ts.StringLiteralLike | ts.TemplateLiteralLikeNode =>
    isText(x) && x.text.includes('node_modules')).length > 0;
  if (literal(e)) return true;
  const u = unwrapValue(e);
  if (!ts.isIdentifier(u)) return false;
  const decl = declarationOf(u);
  return !!decl && ts.isVariableDeclaration(decl) && !!decl.initializer && literal(decl.initializer);
}

/** Every `continue`/`return` in `code` that runs only when a `node_modules` path EXISTS — the jump's
 *  own condition proves `existsSync(<…node_modules…>)` true.
 *
 *  ⚠️ **The jump's OWN condition (#1179).** The line filter this replaces wanted `node_modules`,
 *  `existsSync` and `continue|return` on ONE line: `if (existsSync(nm)) {\n  continue\n}` — the
 *  shape a formatter produces — passed, and a line holding an unrelated early `continue` beside a
 *  presence test failed. It also ignored polarity, so `if (!existsSync(nm)) { install(); continue }`
 *  read as the defect. */
function skipsOnPresentNodeModules(code: string, label: string): string[] {
  const isCheck = (e: ts.Expression) => ts.isCallExpression(e) && calleeName(e) === 'existsSync'
    && e.arguments.length > 0 && namesNodeModules(e.arguments[0]);
  // `existsSync(nm) === true` is the same test spelt longer.
  const isPresence = (e: ts.Expression): boolean => isCheck(e) || (ts.isBinaryExpression(e)
    && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(e.operatorToken.kind)
    && ((isCheck(unwrapValue(e.left)) && e.right.kind === ts.SyntaxKind.TrueKeyword) || (isCheck(unwrapValue(e.right)) && e.left.kind === ts.SyntaxKind.TrueKeyword)));
  const sf = parseSource(code, label);
  const jumps = findNodes(sf, (n): n is ts.ContinueStatement | ts.ReturnStatement => ts.isContinueStatement(n) || ts.isReturnStatement(n))
    .filter((jump) => guardsOf(jump).some((g) => enclosingFunction(g.by) === enclosingFunction(jump) && guardProves(g, isPresence)))
    .map((jump) => `${label}:${lineOf(jump)}: ${flatText(jump)}`);
  // ⚠️ A presence test RETURNED from a helper (`function hasNM(d) { return existsSync(…) }`) moves the
  // decision to every caller's `if (hasNM(d)) continue`, which no jump above can see — so the returned
  // test is itself the offender (#1179 P3 review: the line form caught the caller by accident of text).
  // A returned value is read by POLARITY, as a gate is: `existsSync(nm) && fresh(d)`, `!!existsSync(nm)`
  // and `existsSync(nm) ? true : false` all return "present"; `!existsSync(nm)` does not.
  const returnsPresence = (v: ts.Expression): boolean => {
    const u = unwrapValue(v);
    if (ts.isConditionalExpression(u)) return guardProves({ test: u.condition, holds: true, by: u }, isPresence) || returnsPresence(u.whenTrue) || returnsPresence(u.whenFalse);
    return guardProves({ test: u, holds: true, by: u }, isPresence);
  };
  const returned = [
    ...findNodes(sf, (n): n is ts.ReturnStatement => ts.isReturnStatement(n) && !!n.expression).map((r) => r.expression!),
    ...findNodes(sf, (n): n is ts.ArrowFunction => ts.isArrowFunction(n) && !ts.isBlock(n.body)).map((f) => f.body as ts.Expression),
  ].filter(returnsPresence).map((e) => `${label}:${lineOf(e)}: returns ${flatText(e)}`);
  return [...jumps, ...returned];
}

describe('the skip detector reads each jump\'s own condition (#1179)', () => {
  const flags = (src: string) => skipsOnPresentNodeModules(stripComments(src), 'fixture.mjs').length;

  it.each([
    ['the one-line shape', "for (const d of dirs) { if (existsSync(join(d, 'node_modules'))) continue; install(d); }"],
    ['the shape a formatter wraps', "for (const d of dirs) {\n  if (\n    existsSync(path.join(d, 'node_modules'))\n  ) {\n    log('skip');\n    continue;\n  }\n}"],
    ['a presence test through a binding', "function f(d) {\n  const nm = path.join(d, 'node_modules');\n  if (fs.existsSync(nm) && fresh) return;\n  install(d);\n}"],
    ['a presence test spelt `=== true`', "for (const d of dirs) { if (existsSync(join(d, 'node_modules')) === true) continue; }"],
    ['a presence test returned from a helper the loop calls', "function hasNM(d) { return existsSync(join(d, 'node_modules')); }\nfor (const d of dirs) { if (hasNM(d)) continue; install(d); }"],
    ['a presence test returned from a concise arrow', "const hasNM = (d) => existsSync(join(d, 'node_modules'));"],
    ['a presence test returned ANDed with another', "function installed(d) { return existsSync(join(d, 'node_modules')) && existsSync(join(d, 'package-lock.json')); }"],
    ['a presence test returned as !!', "function installed(d) { return !!existsSync(join(d, 'node_modules')); }"],
    ['a presence test returned through a ternary', "function installed(d) { return existsSync(join(d, 'node_modules')) ? true : false; }"],
    ['an early exit on ABSENCE failing', "function f(d) {\n  if (!existsSync(`${d}/node_modules`)) {\n    install(d);\n  } else {\n    return;\n  }\n}"],
  ])('flags %s', (_why, src) => {
    expect(flags(src)).toBe(1);
  });

  it.each([
    ['an install on absence, then a continue', "for (const d of dirs) { if (!existsSync(join(d, 'node_modules'))) { install(d); continue; } }"],
    ['an unrelated early continue on the same line as a presence read', "for (const d of dirs) { if (!d.isDirectory()) continue; const had = existsSync(join(d.name, 'node_modules')); }"],
    ['an ABSENCE test returned from a helper', "function missing(d) { return !existsSync(join(d, 'node_modules')); }"],
    ['a presence test of a different path', "for (const d of dirs) { if (existsSync(join(d, 'package.json'))) continue; }"],
    ['a return inside a callback under the presence test', "if (existsSync('node_modules')) { list.forEach((x) => { return x; }); }"],
  ])('does not flag %s', (_why, src) => {
    expect(flags(src)).toBe(0);
  });
});

describe('projectNeedsInstall — the rule', () => {
  it('selects a project that owns sub-packages to LINK', () => {
    expect(projectNeedsInstall({ workspaces: ['packages/*'] })).toBe(true);
  });

  it('selects a project that only declares dependencies — the #215 case', () => {
    // games/court's exact shape: 10 deps, no `workspaces`. This returned false, and that single
    // false is the whole bug.
    expect(projectNeedsInstall({ dependencies: { '@capacitor/haptics': '^8.0.2' } })).toBe(true);
    expect(projectNeedsInstall({ devDependencies: { vitest: '^3' } })).toBe(true);
  });

  it('skips a project with neither — nothing to link and nothing to install', () => {
    expect(projectNeedsInstall({})).toBe(false);
    expect(projectNeedsInstall({ dependencies: {}, devDependencies: {} })).toBe(false);
    expect(projectNeedsInstall({ name: 'x', scripts: { build: 'tsc' } })).toBe(false);
  });

  it('tolerates junk rather than throwing inside the root postinstall', () => {
    expect(projectNeedsInstall(null as never)).toBe(false);
    expect(projectNeedsInstall(undefined as never)).toBe(false);
  });
});

describe('the bootstrap scripts never treat a present node_modules as "installed"', () => {
  // A source-level guard, because the failure it prevents is invisible from any unit test: npm
  // would have to actually run. `existsSync(node_modules) → continue` reads as a cheap
  // idempotence win and is #215's exact shape — a folder that EXISTS but is STALE (a dependency
  // added after the last install) makes "already installed" true and wrong. `games/court` shipped
  // that way and its iOS build died at package resolution; `bootstrap-mcp-deps.mjs` carried the
  // same shortcut for engine/tools/*, where it would strand an MCP server on a missing package.
  const SCRIPTS = ['bootstrap-game-deps.mjs', 'bootstrap-mcp-deps.mjs'];

  for (const name of SCRIPTS) {
    it(`${name} re-runs npm install rather than skipping on an existing node_modules`, () => {
      const offenders = skipsOnPresentNodeModules(codeOf(name), name);
      expect(offenders, `${name} skips on a present-but-possibly-stale node_modules`).toEqual([]);
    });
  }

  it('engine/tools/* has exactly ONE installer, so the rule cannot be fixed in only half the places', () => {
    // Both scripts run back to back in the root postinstall. When both walked engine/tools, the
    // second always found node_modules the first had just created and installed nothing — a
    // duplicate that was dead in the normal flow, and a second place for the rule to drift.
    const owners = SCRIPTS.filter((name) => {
      const code = codeOf(name);
      return /'engine',\s*'tools'/.test(code) || /engine\/tools/.test(code);
    });
    expect(owners).toEqual(['bootstrap-mcp-deps.mjs']);
  });
});

describe('projectNeedsInstall — the real projects on disk', () => {
  /** Every discovered project that ships a package.json, with its parsed manifest. */
  const manifests = discoverProjects(repoRoot)
    .map((proj: { dir: string; root: string; name: string }) => {
      const pkgPath = path.join(proj.dir, 'package.json');
      if (!existsSync(pkgPath)) return null;
      try {
        return { label: `${proj.root}/${proj.name}`, pkg: JSON.parse(readFileSync(pkgPath, 'utf8')) };
      } catch {
        return null;
      }
    })
    .filter((m): m is { label: string; pkg: Record<string, unknown> } => m !== null);

  it('every project that declares dependencies is selected for install', () => {
    const declaresDeps = manifests.filter(
      (m) =>
        Object.keys((m.pkg.dependencies ?? {}) as object).length > 0 ||
        Object.keys((m.pkg.devDependencies ?? {}) as object).length > 0,
    );

    // ⚠️ Non-vacuity guard. `discoverProjects` returns [] where games/ and demos/ are absent (the
    // public OSS snapshot), and this whole sweep would then pass by having nothing to check —
    // which is how a guard rots into decoration. Assert emptiness is REAL emptiness.
    if (manifests.length === 0) {
      expect(hasAnyProject(), 'found no manifests, so there must genuinely be no projects').toBe(false);
      return;
    }
    expect(declaresDeps.length, 'this repo really does have projects with dependencies').toBeGreaterThan(0);

    const skipped = declaresDeps.filter((m) => !projectNeedsInstall(m.pkg)).map((m) => m.label);
    expect(skipped, 'these would get NO node_modules on a fresh clone and fail their native build').toEqual([]);
  });
});
