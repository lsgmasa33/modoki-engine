/** ARCHITECTURE GUARD — a prefab member STEP is parsed in one place, and the stored-root predicate
 *  is spelled in one place (#1468 Phase 1).
 *
 *  ## What went wrong without it
 *
 *  A member's identity is a path of STEPS: a numeric `PrefabInstance.localId`, or `'+' + key` for a
 *  template-keyed added node (#1387). Reading that path back from its `.`-joined text was written by
 *  hand at **eleven** sites, in three mutually inconsistent recipes:
 *
 *      key.split('.').map((x) => (x.startsWith('+') ? x : Number(x)))   // 7 sites
 *      key.split('.').map(Number)                                       // 3 sites — drops the '+' shape
 *      Number(key.split('.').pop())                                     // 1 site
 *
 *  The second recipe is the tell: it cannot express a `'+key'` step at all, so the two shapes had
 *  already drifted apart in the tree. And `Number('+1')` is **1**, not `NaN` — so a coerce-first
 *  recipe silently turns a template key of "1" into localId 1, naming a different node. Template
 *  keys are guid-shaped, which is the only reason that never fired.
 *
 *  The same sprawl made `localId`'s SPELLING load-bearing in eleven places at once. #1468 § 3.5
 *  needs a later localId → node-guid switch to be a sigil addition; with eleven hand-rolled parsers
 *  it was a restructure, and the `MemberStep = number | string` union did **not** make it cheap —
 *  every one of those sites coerced back to a number regardless.
 *
 *  Six more sites spelled the stored-root predicate inline (`pi.rootInstanceId === selfId &&
 *  !pi.parentLocalId`), once per identity walk, which is how three walks came to be "change all
 *  three" by hand.
 *
 *  ## What is banned, and what deliberately is not
 *
 *  **Banned (scan 1):** mapping over a `.split('.')`. That is the step-parse shape, and
 *  `parseStep`/`parseSteps`/`memberPathSteps` in `assetRefRules.ts` exist to replace it.
 *
 *  **Banned (scan 2):** comparing `X.rootInstanceId` for equality in an expression that ALSO tests
 *  `X.parentLocalId` for TRUTHINESS. That pair is the stored-root / owned-root question, and
 *  `isStoredRoot` / `isOwnedRoot` answer it.
 *
 *  **NOT banned — exempted by SHAPE, not by a file list:** an expression that compares
 *  `parentLocalId` against a VALUE (`pi.parentLocalId !== step`, `pi.parentLocalId === lid`). That
 *  asks *which row produced this nested root*, not *is this a stored root* — a different question
 *  that happens to read the same two fields. Exempting by shape rather than by an allowlist is
 *  deliberate: a hand-maintained list of offenders goes stale on the first file somebody adds.
 *
 *  ⚠️ **The FORMAT side is NOT guarded, and that is a decision rather than an oversight.**
 *  `memberPathKey` is `memberPathSteps`' inverse, and the close-out sweep for this change found
 *  four sites still spelling it by hand as `steps.join('.')` (fixed in the same pass). A guard for
 *  it would have to ban `.join('.')` and then exempt five legitimate joins over DIFFERENT key
 *  spaces — the nested-frame `chain`, the pose chain, `prefabOverrides`' own path grammar — because
 *  what separates them is the RECEIVER'S TYPE, which needs a `ts.Program` rather than the per-file
 *  parse these scans use. A guard that is mostly exemptions teaches people to add exemptions, so
 *  the floor is recorded here and in the plan instead. ⚠️ Phase 2B adds member ROWS and more path
 *  formatting; if a fifth copy appears there, pay for the type-aware scan rather than re-deciding
 *  this.
 *
 *  ⚠️ **Known floor, stated rather than hidden — and TESTED, because the first version of this
 *  paragraph was wrong in the dangerous direction.** It claimed scan 2 could not see
 *  `(pi.parentLocalId || 0) > 0`. It can: `isTruthinessTest` returns true on the `||` branch, and
 *  there is now a fixture asserting exactly that. A documented gap that is not real is worse than
 *  an undocumented one — it reads as permission, and the next author writes the shape without
 *  checking. **Every floor claimed below has a fixture proving the detector's behaviour on it.**
 *
 *  **Scan 2's floors:** a predicate that reaches either field through a HELPER CALL rather than a
 *  property access or a local. (A local bound in an OUTER function and tested inside a callback is
 *  covered — `localsFor` unions the enclosing-function chain, and `localsBoundTo` contributes only
 *  each level's own declarations so the top level is not the whole file.)
 *
 *  **Scan 1's floors, which are wider — it keys on the loop expression BEING the `split` call and
 *  on the body's coercion:** a two-step `const segs = key.split('.'); for (const s of segs) …`
 *  (idiomatic in this repo — `runtime/animation/pathValue.ts`'s `getPath` is written that way), a `forEach`
 *  or `reduce` in place of `map`, and a body that delegates the coercion to a helper. `Number(`,
 *  `parseInt(` and a unary `+` on the loop variable are all covered.
 *
 *  ⚠️ **That list is stated because the OPPOSITE mistake is the one this file already made once.**
 *  Finding 1 was a floor claimed that did not exist, which reads as permission; an unstated floor
 *  reads as coverage. Neither is acceptable, and a floor list that is silently incomplete is the
 *  same defect wearing the other face.
 *
 *  ## Why the detectors are unit-tested below
 *
 *  Per `docs/falsifiable-tests.md`, a guard proving it REJECTS bad input never proves it ACCEPTS
 *  good input, and that half has hidden two defects in this repo. Both detectors therefore run
 *  against inline fixtures — offending and exempt — before they run over the corpus, so a corpus
 *  sweep that finds nothing is evidence rather than silence.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { REPO_ROOT } from '../helpers/repoLayout';
import { accessPath, enclosingFunction, findNodes, lineOf, parseSource, ts } from '@modoki/engine/testing/sourceAst';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/** The one module allowed to spell either rule — where `parseStep` and `isStoredRoot` live. */
const OWNER = 'engine/packages/modoki/src/runtime/core/assetRefRules.ts';

type Hit = { line: number; text: string };

/** Scan 1 — parsing the text of a `.`-joined path by hand. Two shapes, because the historical
 *  eleven were `.map(...)` but the most likely REGRESSION is a `for…of`: `parseMemberToken` and
 *  `nestedFrames` both already iterate a `.split('.')` for other reasons, so inlining the grammar
 *  back into such a loop is the cheapest way to re-create the sprawl. A `for…of` counts only when
 *  its BODY makes the grammar decision (`Number(…)` or `.startsWith('+')`), which is what separates
 *  it from the two legitimate iterations. */
function handRolledStepParses(sf: ts.SourceFile): Hit[] {
  const splitsOnDot = (e: ts.Node): boolean => ts.isCallExpression(e)
    && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'split'
    && e.arguments.length > 0 && ts.isStringLiteral(e.arguments[0]!) && (e.arguments[0] as ts.StringLiteral).text === '.';

  const out: Hit[] = [];
  // (a) `X.split('.').map(…)` / `.flatMap(…)` — the eleven historical spellings.
  for (const call of findNodes(sf, (n): n is ts.CallExpression => ts.isCallExpression(n))) {
    if (!ts.isPropertyAccessExpression(call.expression)) continue;
    const m = call.expression.name.text;
    if (m !== 'map' && m !== 'flatMap') continue;
    if (!splitsOnDot(call.expression.expression)) continue;
    out.push({ line: lineOf(call), text: call.getText().replace(/\s+/g, ' ').slice(0, 100) });
  }
  // (b) `for (… of X.split('.'))` whose body decides the grammar. The body test covers the three
  // ways a part is turned into a number (`Number(`, `parseInt(`, a unary `+` on the loop variable)
  // and the added-key sigil check; anything else is one of the legitimate iterations.
  for (const loop of findNodes(sf, (n): n is ts.ForOfStatement => ts.isForOfStatement(n))) {
    if (!splitsOnDot(loop.expression)) continue;
    const body = loop.statement.getText();
    const decl = ts.isVariableDeclarationList(loop.initializer) ? loop.initializer.declarations[0] : undefined;
    const v = decl && ts.isIdentifier(decl.name) ? decl.name.text : '';
    const unaryPlus = !!v && new RegExp(`[^\\w.)\\]]\\+\\s*${v}\\b`).test(body);
    if (!/\b(Number|parseInt)\s*\(/.test(body) && !/startsWith\(\s*['"]\+['"]\s*\)/.test(body) && !unaryPlus) continue;
    out.push({ line: lineOf(loop), text: loop.getText().replace(/\s+/g, ' ').slice(0, 100) });
  }
  return out;
}

/** The locals a file binds from a `.parentLocalId` / `.rootInstanceId` read, by assignment or by
 *  destructuring. Testing THAT name is the same predicate as testing the property, and a scan scoped
 *  to one statement cannot see the declaration that made it.
 *  ⚠️ This is the hole the first cut of this guard had: `prefab.ts`'s `applyStructureByRootInstance`
 *  was written exactly that way, so the one migrated spelling the guard most needed to catch was
 *  the one it could not see. */
function localsBoundTo(sf: ts.Node, field: 'parentLocalId' | 'rootInstanceId'): Set<string> {
  const names = new Set<string>();
  // `const parentLocalId = (piData.parentLocalId as number) || 0;`
  for (const decl of findNodes(sf, (n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n))) {
    if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
    if (enclosingFunction(decl) !== sf) continue; // belongs to a NESTED function — see `localsFor`
    const reads = findNodes(decl.initializer, (n): n is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(n));
    if (reads.some((r) => r.name.text === field)) names.add(decl.name.text);
  }
  // `const { rootInstanceId, parentLocalId } = pi;` — binds the name with no property access at all.
  for (const el of findNodes(sf, (n): n is ts.BindingElement => ts.isBindingElement(n))) {
    if (enclosingFunction(el) !== sf) continue;
    const src = el.propertyName ?? el.name;
    if (ts.isIdentifier(src) && src.text === field && ts.isIdentifier(el.name)) names.add(el.name.text);
  }
  return names;
}

/** Is this `.parentLocalId` read tested for TRUTHINESS (rather than compared against a value)? */
function isTruthinessTest(access: ts.Node): boolean {
  let node: ts.Node = access;
  let parent = node.parent;
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isAsExpression(parent))) {
    node = parent; parent = node.parent;
  }
  if (!parent) return false;
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isIfStatement(parent) && parent.expression === node) return true;
  if (ts.isConditionalExpression(parent) && parent.condition === node) return true;
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    return op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken;
  }
  return false;
}

/** Scan 2 — a statement comparing `X.rootInstanceId` for equality that also tests `X.parentLocalId`
 *  for truthiness: the stored-root / owned-root predicate, spelled by hand. */
function handRolledRootPredicates(sf: ts.SourceFile): Hit[] {
  // ⚠️ Per enclosing FUNCTION, not per file. A file-wide scan reads a name bound in one function as
  // bound in every other — `prefab.ts` binds a local `rootInstanceId` somewhere in its 4k lines, which
  // made an unrelated loop over a PARAMETER of that name a false positive on this guard's first
  // widening. Memoised so the corpus sweep stays linear.
  const localsCache = new Map<ts.Node, { pl: Set<string>; ri: Set<string> }>();
  const ownLocals = (fn: ts.Node): { pl: Set<string>; ri: Set<string> } => {
    let hit = localsCache.get(fn);
    if (!hit) { hit = { pl: localsBoundTo(fn, 'parentLocalId'), ri: localsBoundTo(fn, 'rootInstanceId') }; localsCache.set(fn, hit); }
    return hit;
  };
  /** Every local in SCOPE at `n`: its own function's, plus each enclosing function's. A predicate
   *  whose local is bound in an outer body and tested inside a callback is one statement to a reader
   *  and two functions to the AST. ⚠️ Each level contributes only its OWN declarations — that is what
   *  `localsBoundTo`'s nested-function skip buys, and without it the top level is the whole FILE,
   *  which read `prefab.ts`'s local `rootInstanceId` as binding a same-named parameter in an
   *  unrelated loop. */
  const localsFor = (n: ts.Node): { pl: Set<string>; ri: Set<string> } => {
    const pl = new Set<string>();
    const ri = new Set<string>();
    for (let fn: ts.Node = enclosingFunction(n), guard = 0; guard < 64; guard++) {
      const own = ownLocals(fn);
      for (const x of own.pl) pl.add(x);
      for (const x of own.ri) ri.add(x);
      if (ts.isSourceFile(fn) || !fn.parent) break;
      fn = enclosingFunction(fn.parent);
    }
    return { pl, ri };
  };
  const EQ = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);
  const out: Hit[] = [];
  const seen = new Set<ts.Node>();
  for (const cmp of findNodes(sf, (n): n is ts.BinaryExpression => ts.isBinaryExpression(n))) {
    if (!EQ.has(cmp.operatorToken.kind)) continue;
    const { pl: locals, ri: rootLocals } = localsFor(cmp);
    const namesRoot = (side: ts.Node): boolean => (accessPath(side as ts.Expression) ?? '').endsWith('.rootInstanceId')
      || (ts.isIdentifier(side) && rootLocals.has(side.text));
    if (!namesRoot(cmp.left) && !namesRoot(cmp.right)) continue;
    // The whole statement, so `const x = a && b;` and a multi-clause `if` are both covered.
    let stmt: ts.Node = cmp;
    while (stmt.parent && !ts.isStatement(stmt.parent)) stmt = stmt.parent;
    const scope = stmt.parent ?? stmt;
    if (seen.has(scope)) continue;
    const truthy: ts.Node[] = findNodes(scope, (n): n is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(n))
      .filter((a) => a.name.text === 'parentLocalId' && isTruthinessTest(a));
    // …and the same test written through a local bound from `.parentLocalId` (see `localsBoundTo`).
    for (const id of findNodes(scope, (n): n is ts.Identifier => ts.isIdentifier(n))) {
      if (!locals.has(id.text)) continue;
      if (ts.isVariableDeclaration(id.parent) || ts.isBindingElement(id.parent) || ts.isPropertyAccessExpression(id.parent)) continue;
      if (isTruthinessTest(id)) truthy.push(id);
    }
    if (!truthy.length) continue;
    seen.add(scope);
    out.push({ line: lineOf(cmp), text: scope.getText().split('\n')[0]!.trim().slice(0, 110) });
  }
  return out;
}

const fixture = (code: string) => parseSource(code, 'fixture.ts');

describe('the detectors fire on the shapes they exist for (ACCEPT side)', () => {
  it('scan 1 catches all three historical step-parse recipes', () => {
    expect(handRolledStepParses(fixture(
      "const a = key.split('.').map((x) => (x.startsWith('+') ? x : Number(x)));"))).toHaveLength(1);
    expect(handRolledStepParses(fixture("const b = key.split('.').map(Number);"))).toHaveLength(1);
    expect(handRolledStepParses(fixture(
      "const c = pathKey.split('.').map((s) => Number(s));"))).toHaveLength(1);
  });

  it('scan 1 does NOT fire on a split that is not a step parse', () => {
    expect(handRolledStepParses(fixture("const v = version.split('.');"))).toHaveLength(0);
    expect(handRolledStepParses(fixture("const p = name.split('/').map(Number);"))).toHaveLength(0);
  });

  it('scan 2 catches the stored-root and owned-root spellings', () => {
    expect(handRolledRootPredicates(fixture(
      'const storedRoot = !!pi && pi.rootInstanceId === selfId && !pi.parentLocalId;'))).toHaveLength(1);
    expect(handRolledRootPredicates(fixture(
      'if (!pi || pi.rootInstanceId !== e.id || !pi.parentLocalId) return;'))).toHaveLength(1);
    expect(handRolledRootPredicates(fixture(
      'if (pi.rootInstanceId === e.id && pi.parentLocalId) frames.add(e.id);'))).toHaveLength(1);
    expect(handRolledRootPredicates(fixture(
      'const t = !(p.rootInstanceId === id && !p.parentLocalId);'))).toHaveLength(1);
  });


  it('scan 1 catches the for…of and flatMap re-spellings, not just .map', () => {
    // ⚠️ The likeliest REGRESSION, not a historical shape: `parseMemberToken` already iterates a
    // `.split('.')`, so inlining the grammar back into that loop is the cheap way to undo Phase 1.
    expect(handRolledStepParses(fixture(
      "for (const part of key.split('.')) out.push(part.startsWith('+') ? part : Number(part));"))).toHaveLength(1);
    expect(handRolledStepParses(fixture(
      "for (const p of body.split('.')) { if (/^\\d+$/.test(p)) path.push(Number(p)); }"))).toHaveLength(1);
    expect(handRolledStepParses(fixture("const z = key.split('.').flatMap((x) => [Number(x)]);"))).toHaveLength(1);
  });

  it('scan 1 leaves the two LEGITIMATE .split(\'.\') iterations alone', () => {
    // `parseMemberToken`'s loop — it delegates the grammar to `parseStep`, so the body makes no
    // decision of its own. This is the shape that must stay silent or the guard is unusable.
    expect(handRolledStepParses(fixture(
      "for (const part of body.split('.')) { const step = parseStep(part); if (step === null) return null; path.push(step); }")))
      .toHaveLength(0);
    // `nestedFrames` — builds frame STRINGS from the raw text; never turns a part into a step.
    expect(handRolledStepParses(fixture(
      "for (const lid of key.split('.')) frames.push(`${frames[frames.length - 1]}/${lid}`);"))).toHaveLength(0);
  });

  it('scan 2 catches the HOISTED-LOCAL spelling — the one the first cut of this guard missed', () => {
    // ⚠️ This is `prefab.ts`'s pre-#1468 `applyStructureByRootInstance`, verbatim. The truthiness
    // test is on a local, not on `X.parentLocalId`, so a statement-scoped scan cannot see it — and
    // it is behaviour-identical, so NO unit or integration test can catch it either. The guard was
    // the only thing that could, and it could not. Found by the Phase 1 close-out review.
    expect(handRolledRootPredicates(fixture(
      'const parentLocalId = (piData.parentLocalId as number) || 0;\n'
      + 'if (parentLocalId && piData.rootInstanceId === entity.id()) nestedRoots.push([parentLocalId, entity.id()]);')))
      .toHaveLength(1);
  });

  it('scan 2 catches a local bound in an OUTER function and tested inside a callback', () => {
    // The AST sees two functions; a reader sees one predicate. `localsFor` unions the enclosing chain.
    expect(handRolledRootPredicates(fixture(
      'function f() {\n'
      + '  const parentLocalId = (pi.parentLocalId) || 0;\n'
      + '  rows.forEach((p) => { if (parentLocalId && p.rootInstanceId === id) push(1); });\n'
      + '}'))).toHaveLength(1);
  });

  it('scan 1 catches parseInt and a unary + on the loop variable', () => {
    expect(handRolledStepParses(fixture(
      "for (const p of key.split('.')) out.push(parseInt(p, 10));"))).toHaveLength(1);
    expect(handRolledStepParses(fixture(
      "for (const p of key.split('.')) out.push(p[0] === '+' ? p : +p);"))).toHaveLength(1);
  });

  it('scan 2 catches the DESTRUCTURED spelling', () => {
    expect(handRolledRootPredicates(fixture(
      'const { rootInstanceId, parentLocalId } = pi;\n'
      + 'if (rootInstanceId === id && !parentLocalId) return true;'))).toHaveLength(1);
  });

  it("scan 2 DOES catch the `(x.parentLocalId || 0) > 0` form — asserted because the docblock once claimed it did not", () => {
    // ⚠️ This test exists because the first cut of this file stated the opposite as a "known floor".
    // A documented gap that is not real is worse than an undocumented one: it reads as permission.
    // `isTruthinessTest` returns true on the `||` branch, so the whole statement is a hit.
    expect(handRolledRootPredicates(fixture(
      'if (pi.rootInstanceId !== id || (pi.parentLocalId || 0) > 0) return;'))).toHaveLength(1);
  });

  it('scan 2 does NOT fire when parentLocalId is compared against a VALUE — a different question', () => {
    // "which row produced this nested root", not "is this a stored root".
    expect(handRolledRootPredicates(fixture(
      'if (!pi || pi.rootInstanceId !== e.id || pi.parentLocalId !== step) continue;'))).toHaveLength(0);
    expect(handRolledRootPredicates(fixture(
      'return pi.rootInstanceId === e.id() ? pi.parentLocalId === lid : pi.localId === lid;'))).toHaveLength(0);
    // …and not on an object literal that merely names both fields.
    expect(handRolledRootPredicates(fixture(
      'const d = { rootInstanceId: rootEcsId, parentLocalId: 0 };'))).toHaveLength(0);
  });
});

describe('the corpus holds exactly one spelling of each', () => {
  const files: string[] = repoFiles({
    under: ['engine/packages/modoki/src', 'engine/app', 'engine/plugins', 'engine/tools', 'engine/scripts'],
    match: (rel: string) => /\.(tsx?|mjs)$/.test(rel) && !rel.endsWith('.d.ts') && !rel.endsWith('.test.ts'),
    exclude: ['dist', 'node_modules'],
    floor: 500,
  }).map(({ rel }: { rel: string }) => rel);

  /** Does this file know what a prefab member IS? A file with none of this vocabulary cannot be
   *  parsing a member step, whatever it splits on '.' — `engine/scripts/releaseBranch.mjs` parses
   *  SEMVER with a byte-identical `String(version).split('.').map(Number)`, and no structural rule
   *  can tell the two apart. Exempting by the file's own content rather than by a path list keeps
   *  that honest and self-maintaining: the moment such a file learns about members, it is scanned. */
  const KNOWS_MEMBERS = /\b(localId|parentLocalId|MemberStep|memberStep|deriveMemberGuid|addedKeyStep|rootInstanceId)\b/;

  it('scans a corpus large enough to mean something, and reaches the walks it is about', () => {
    expect(files.length).toBeGreaterThan(500);
    // ⚠️ The file-side walk's caller lives in `engine/plugins`, NOT in the package — an earlier cut
    // of this guard scanned only the package and `engine/app` and would have missed it entirely.
    expect(files).toContain('engine/plugins/asset-fs-ops.ts');
    expect(files).toContain('engine/packages/modoki/src/runtime/loaders/memberPaths.ts');
    expect(files).toContain('engine/packages/modoki/src/runtime/core/copyIdentity.ts');
  });

  it('no site outside assetRefRules parses a member step by hand', () => {
    const offenders: string[] = [];
    let owned = 0;
    for (const rel of files) {
      const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      const stripped = stripComments(raw);
      assertScanIsSane(raw, stripped, rel);
      if (!KNOWS_MEMBERS.test(stripped)) continue;
      const hits = handRolledStepParses(parseSource(stripped, rel));
      if (!hits.length) continue;
      if (rel === OWNER) { owned += hits.length; continue; }
      for (const h of hits) offenders.push(`${rel}:${h.line} — ${h.text}`);
    }
    // Non-vacuous: the owner's own `parseSteps` IS the banned shape, and the scan sees it.
    expect(owned, 'the scan no longer sees `parseSteps` in assetRefRules — it has gone vacuous').toBe(1);
    expect(offenders, 'use parseStep / memberPathSteps from runtime/core/assetRefRules').toEqual([]);
  });

  it('no site outside assetRefRules spells the stored-root predicate by hand', () => {
    const offenders: string[] = [];
    let owned = 0;
    for (const rel of files) {
      const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      const stripped = stripComments(raw);
      const hits = handRolledRootPredicates(parseSource(stripped, rel));
      if (!hits.length) continue;
      if (rel === OWNER) { owned += hits.length; continue; }
      for (const h of hits) offenders.push(`${rel}:${h.line} — ${h.text}`);
    }
    expect(owned, 'the scan no longer sees isStoredRoot/isOwnedRoot — it has gone vacuous').toBeGreaterThan(0);
    expect(offenders, 'use isStoredRoot / isOwnedRoot from runtime/core/assetRefRules').toEqual([]);
  });
});
