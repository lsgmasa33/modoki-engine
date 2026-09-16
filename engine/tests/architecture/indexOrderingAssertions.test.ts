/**
 * Guard: no ordering assertion compares a raw `indexOf`-family position (#1181).
 *
 * `expect(s.indexOf(a)).toBeLessThan(s.indexOf(b))` reads `-1` for a missing `a`, and `-1` is less
 * than every real position — so the assertion is green exactly when the thing it orders never
 * appeared. The census found 114 such comparisons in 54 files (the issue was filed with 21); about 40 had no
 * presence check of any kind, and one (`userDataDir.test.ts`, a formatter-wrapped `setPath(`) was
 * observed passing on an absent subject.
 *
 * The replacement is `@modoki/engine/testing/inOrder`: `expectInOrder(haystack, needles)`, or
 * `found(index, what)` wrapped around a position where it is produced. Both fail naming what is
 * missing.
 *
 * What is refused: a `toBeLessThan[OrEqual]` whose ACTUAL, or a `toBeGreaterThan[OrEqual]` whose
 * EXPECTED, is an `indexOf` / `lastIndexOf` / `findIndex` / `findLastIndex` / `search` call —
 * directly, or through the `const`/`let` it was bound to. That is the side on which `-1` passes;
 * `.not` swaps it. The other side is not refused: a missing needle there reads `-1` and fails. The
 * boolean spelling, `expect(a < b).toBe(true)` (or `toBeTruthy`, or asserted `false`, which flips the
 * side), is refused by the same rule, including each comparison a `&&`/`||`/`!` asserts; and a call
 * to a same-file single-return helper is followed to the index it returns.
 *
 * ⚠️ **A presence pin elsewhere in the test does NOT excuse a site, deliberately** (owner,
 * 2026-09-14). Whether an `expect(at).toBeGreaterThan(-1)` three lines up pins THIS operand is an
 * adjunct question, and adjunct pardons are the ones that fail open (docs/verify-and-ci.md
 * § Exemption GRAIN) — a pin for a re-bound variable, or for the same needle in a different
 * haystack, reads identically. So `found()` goes where the index is produced, and the pin line goes.
 *
 * Deliberately NOT covered: ordering outside `expect` (`if (a < b)`, `assert(a < b)`); a position
 * from an imported helper, or a same-file one whose body is not a single expression/`return`; a
 * position carried by destructuring, an array element, a reassignment, an object property or a
 * pass-through call; and a comparison no boolean asserts on its own (a disjunct asserted true, a
 * conjunct asserted false). The list, and the probe that found no live instance: Shape (H).
 *
 * Why and the shapes: docs/falsifiable-tests.md § Shape (H).
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { declarationOf, findNodes, lineOf, parseSource, unwrapValue } from '@modoki/engine/testing/sourceAst';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const INDEX_CALLS = new Set(['indexOf', 'lastIndexOf', 'findIndex', 'findLastIndex', 'search']);
const LESS = new Set(['toBeLessThan', 'toBeLessThanOrEqual']);
const GREATER = new Set(['toBeGreaterThan', 'toBeGreaterThanOrEqual']);
const MODIFIERS = new Set(['not', 'resolves', 'rejects']);
const BOOLEAN_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toBeTruthy', 'toBeFalsy']);
const RELATIONAL = new Set([
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
]);

/** `expect(…)` or `expect.soft(…)` — vitest and Playwright spell it the same. */
function isExpectCall(e: ts.Expression): e is ts.CallExpression {
  if (!ts.isCallExpression(e)) return false;
  const c = e.expression;
  return (ts.isIdentifier(c) && c.text === 'expect')
    || (ts.isPropertyAccessExpression(c) && c.name.text === 'soft' && ts.isIdentifier(c.expression) && c.expression.text === 'expect');
}

/** The single value a same-file function returns: a concise arrow's body, or the expression of a
 *  body that is exactly one `return`. `undefined` for anything else. */
function returnedValue(fn: ts.Node | undefined): ts.Expression | undefined {
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) || !fn.body) return undefined;
  if (!ts.isBlock(fn.body)) return fn.body;
  const [only, ...rest] = fn.body.statements;
  return rest.length === 0 && only && ts.isReturnStatement(only) ? only.expression : undefined;
}

/** Whether `e` evaluates to a raw index-family result: the call itself; a binding initialised from
 *  one (followed through `const a = b` chains); or a call to a same-file helper that returns one
 *  (`const idx = (p) => list.findIndex(p)` — chromeLetterbox had exactly that, #1181 close-out). */
function isRawIndexPosition(e: ts.Expression, depth = 0): boolean {
  const v = unwrapValue(e);
  if (depth > 4) return false;
  if (ts.isCallExpression(v)) {
    if (ts.isPropertyAccessExpression(v.expression)) return INDEX_CALLS.has(v.expression.name.text);
    if (ts.isIdentifier(v.expression)) {
      const decl = declarationOf(v.expression);
      const fn = decl && ts.isVariableDeclaration(decl) ? decl.initializer : decl;
      const ret = returnedValue(fn);
      return ret !== undefined && isRawIndexPosition(ret, depth + 1);
    }
    return false;
  }
  if (ts.isIdentifier(v)) {
    const decl = declarationOf(v);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return isRawIndexPosition(decl.initializer, depth + 1);
  }
  return false;
}

/**
 * The relational comparisons a boolean ACTUAL asserts, each with the truth value it must have.
 * `a && b` asserted true asserts both; `a || b` asserted false asserts both false; `!a` flips. A
 * disjunction asserted true (or a conjunction asserted false) asserts no single comparison, so it
 * yields nothing. renderFrameFlushOrdering spelled its pins inline as
 * `idx >= 0 && idx < other` — sound, but dropping only the pin conjunct left it vacuous and silent.
 */
function assertedComparisons(e: ts.Expression, truth: boolean): Array<{ cmp: ts.BinaryExpression; truth: boolean }> {
  const v = unwrapValue(e);
  if (ts.isPrefixUnaryExpression(v) && v.operator === ts.SyntaxKind.ExclamationToken) return assertedComparisons(v.operand, !truth);
  if (!ts.isBinaryExpression(v)) return [];
  const op = v.operatorToken.kind;
  if ((op === ts.SyntaxKind.AmpersandAmpersandToken && truth) || (op === ts.SyntaxKind.BarBarToken && !truth)) {
    return [...assertedComparisons(v.left, truth), ...assertedComparisons(v.right, truth)];
  }
  return RELATIONAL.has(op) ? [{ cmp: v, truth }] : [];
}

interface OrderingScan {
  /** Every ordering matcher on an `expect` the detector examined. */
  examined: number;
  /** The ones whose vacuous side is a raw index position. */
  offenders: Array<{ line: number; text: string }>;
}

function scanOrderings(code: string, label: string): OrderingScan {
  const sf = parseSource(code, label);
  const out: OrderingScan = { examined: 0, offenders: [] };
  for (const call of findNodes(sf, ts.isCallExpression)) {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) continue;
    const matcher = callee.name.text;
    const boolean = BOOLEAN_MATCHERS.has(matcher);
    if (!LESS.has(matcher) && !GREATER.has(matcher) && !boolean) continue;
    let target = callee.expression;
    let negated = false;
    while (ts.isPropertyAccessExpression(target) && MODIFIERS.has(target.name.text)) {
      if (target.name.text === 'not') negated = !negated;
      target = target.expression;
    }
    if (!isExpectCall(target)) continue;
    const actual = target.arguments[0];
    if (!actual) continue;
    const vacuous: ts.Expression[] = [];
    if (boolean) {
      // `expect(a < b).toBe(true)`: the comparison is the ACTUAL, and the matcher says which way it
      // must come out. Found by the #1181 close-out review — geometryRelease's unload/destroy order
      // passed with its `.unload(` needle absent, because nothing here looked inside a boolean.
      let assertsTrue: boolean;
      if (matcher === 'toBeTruthy') assertsTrue = true;
      else if (matcher === 'toBeFalsy') assertsTrue = false;
      else {
        const arg = call.arguments[0];
        if (!arg || (arg.kind !== ts.SyntaxKind.TrueKeyword && arg.kind !== ts.SyntaxKind.FalseKeyword)) continue;
        assertsTrue = arg.kind === ts.SyntaxKind.TrueKeyword;
      }
      if (negated) assertsTrue = !assertsTrue;
      const comparisons = assertedComparisons(actual, assertsTrue);
      if (comparisons.length === 0) continue;
      out.examined++;
      for (const { cmp, truth } of comparisons) {
        // Asserting `a < b` true, or `a > b` false, needs `a` to be the smaller: that side passes on -1.
        const lessOp = cmp.operatorToken.kind === ts.SyntaxKind.LessThanToken
          || cmp.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken;
        vacuous.push(lessOp === truth ? cmp.left : cmp.right);
      }
    } else {
      const bound = call.arguments[0];
      if (!bound) continue;
      out.examined++;
      // `-1` passes on the side that should be SMALLER: the actual of a less-than, the expected of a
      // greater-than. `.not` turns one into the other.
      vacuous.push(LESS.has(matcher) !== negated ? actual : bound);
    }
    for (const side of vacuous.filter((s) => isRawIndexPosition(s))) {
      out.offenders.push({ line: lineOf(call), text: `${side.getText(sf)} in ${call.getText(sf).replace(/\s+/g, ' ')}` });
    }
  }
  return out;
}

const offenderLines = (code: string): number[] => scanOrderings(code, 'fixture.ts').offenders.map((o) => o.line);

/**
 * Files #1179 (work-ai2) is rewriting on an unpushed branch. #1181 does not edit them, so the two
 * branches do not conflict; whichever lands second converts what is left and deletes its row.
 * Counts are exact — the ledger reports a row that over-blesses.
 *
 * ⚠️ `games/court/tests/cellMapDiscipline.test.ts` was the third row here. #1240 P3 replaced that
 * file's `indexOf` ordering with node positions inside `layoutBoard`'s body, so the two occurrences
 * this blessed are gone and the row went with them — which is the rule above working, not a
 * relaxation.
 */
const IN_FLIGHT_1179 = [
  { item: 'engine/tests/electron/userDataDir.test.ts', count: 2 },
  { item: 'engine/tests/architecture/earlyConsoleShim.test.ts', count: 4 },
].map((r) => ({ ...r, reason: '#1179 is rewriting this file on work-ai2; convert with found()/expectInOrder once it lands' }));

describe('indexOrderingAssertions detector', () => {
  it('refuses the raw forms, on the side where -1 passes', () => {
    expect(offenderLines([
      "expect(s.indexOf('a')).toBeLessThan(s.indexOf('b'));",       // 1 direct
      "expect(s.indexOf('b')).toBeGreaterThan(s.indexOf('a'));",    // 2 mirror
      "const at = s.indexOf('a');",
      "expect(at).toBeLessThanOrEqual(9);",                         // 4 bound, constant bound
      "expect(xs.findIndex((x) => x > 1), 'msg').toBeLessThan(3);", // 5 message argument
      "expect(9).toBeGreaterThanOrEqual(s.lastIndexOf('a'));",      // 6
      "expect(s.search(/a/)).not.toBeGreaterThan(4);",              // 7 .not flips the side
      "expect.soft((s.indexOf('a') as number)).toBeLessThan(2);",   // 8 soft, wrapped
      "const b = at;",
      "expect(b).toBeLessThan(3);",                                 // 10 through a binding chain
      "expect(s.indexOf('a') < s.indexOf('b'), 'm').toBe(true);",   // 11 boolean form
      "expect(9 > at).toBeTruthy();",                               // 12 boolean, the right side
      "expect(s.indexOf('a') >= 3).toBe(false);",                   // 13 asserted false flips the side
      "expect(s.indexOf('a') <= 3).not.toEqual(false);",            // 14 .not on a boolean
      "expect(s.indexOf('a') < s.indexOf('b')).toBe(false);",       // 15 asserted false: needs a >= b, so a missing b passes
      "expect(s.indexOf('a') > 3).toBeFalsy();",                    // 16 toBeFalsy flips the side
      "expect(((s.indexOf('a') < 2))).toStrictEqual(true);",        // 17 parenthesised, toStrictEqual
      "expect(i >= 0 && s.indexOf('a') < s.indexOf('b')).toBe(true);", // 18 a conjunct
      "expect(!(s.indexOf('a') >= 3)).toBe(true);",                 // 19 negation flips the side
      "expect(x || s.indexOf('a') > 5).toBe(false);",               // 20 a disjunct asserted false
      "const pos = (n: string) => s.indexOf(n);",
      "expect(pos('a')).toBeLessThan(pos('b'));",                   // 22 a same-file arrow helper
      "function at2(n: string) { return xs.findIndex((x) => x === n); }",
      "expect(at2('a') < 3).toBe(true);",                           // 24 a same-file function helper
      "expect(!(s.indexOf('a') < 3)).toBe(false);",                 // 25 double flip: asserts a < 3, which -1 passes
    ].join('\n'))).toEqual([1, 2, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24, 25]);
  });

  it('accepts found()-wrapped positions, the side where -1 fails, and non-orderings', () => {
    expect(offenderLines([
      "expect(found(s.indexOf('a'), 'a')).toBeLessThan(s.indexOf('b'));",
      "const at = found(s.indexOf('a'), 'a');",
      "expect(at).toBeLessThan(s.indexOf('b'));",
      "expect(s.indexOf('a')).toBeGreaterThan(-1);",                // the pin itself: -1 fails it
      "expect(9).toBeLessThan(s.indexOf('a'));",                    // raw on the failing side
      "expect(s.indexOf('a')).not.toBeLessThan(0);",                // .not: the actual is the failing side
      "expect(s.indexOf('a')).toBe(3);",
      "expect(s.length).toBeLessThan(10);",
      "if (s.indexOf('a') < s.indexOf('b')) ok();",                 // outside expect: not covered
      "expect(s.indexOf('a') > -1).toBe(true);",                    // boolean presence pin: -1 fails it
      "expect(9 < s.indexOf('a')).toBe(true);",                     // boolean, raw on the failing side
      "expect(s.indexOf('a') < 3).toBe(false);",                    // asserted false: needs a >= 3, so -1 fails
      "expect(s.indexOf('a') === 2).toBe(true);",                   // not relational
      "expect(s.indexOf('a') < 3).toBe(x);",                        // not a boolean literal
      "expect(s.indexOf('a') < 3).toBeFalsy();",                    // toBeFalsy: needs a >= 3, so -1 fails
      "expect(s.indexOf('a') < 2 || x).toBe(true);",                // a disjunction asserted true asserts no comparison
      "expect(!(s.indexOf('a') < 3)).toBe(true);",                  // negation: needs a >= 3, so -1 fails
      "const pos2 = (n: string) => found(s.indexOf(n), n);",
      "expect(pos2('a')).toBeLessThan(3);",                         // a helper that wraps found()
    ].join('\n'))).toEqual([]);
  });

  it('KNOWN GAPS: vacuous shapes the detector does not follow (Shape (H) lists them)', () => {
    // Each of these IS vacuous — a missing 'a' reads -1 and passes. They are pinned as undetected so
    // the documented list stays true; a detector that learns one should move it to the refused rows
    // and delete it from docs/falsifiable-tests.md § Shape (H).
    expect(offenderLines([
      "const many = (n: string) => { const i = s.indexOf(n); return i; };",
      "expect(many('a')).toBeLessThan(3);",
      "const [d1, d2] = [s.indexOf('a'), s.indexOf('b')];",
      "expect(d1).toBeLessThan(d2);",
      "expect(Math.min(s.indexOf('a'), 9)).toBeLessThan(3);",
    ].join('\n'))).toEqual([]);
  });

  it('counts every ordering matcher on an expect it examines', () => {
    expect(scanOrderings([
      'expect(1).toBeLessThan(2);', 'expect(1).not.toBeGreaterThan(2);', 'foo.toBeLessThan(1);',
      'expect(1 < 2).toBe(true);', 'expect(ok).toBe(true);', 'expect(1 < 2).toBe(x);',
    ].join('\n'), 'f.ts').examined).toBe(3);
  });
});

describe('indexOrderingAssertions on the real tree', () => {
  it('has no raw index position on the vacuous side of an ordering assertion', () => {
    const files = repoFiles({
      under: ['engine', 'games', 'demos'],
      match: /\/(tests|e2e|__tests__)\/.*\.(tsx?|[cm]?js)$|\.(test|spec)\.(tsx?|[cm]?js)$/,
      exclude: ['node_modules', 'dist'],
      floor: 300,
    });
    const population: Array<{ item: string; site: string }> = [];
    let examined = 0;
    for (const { rel, abs } of files) {
      const { code } = readScannedSource(abs);
      // No content prefilter, deliberately: a matcher-name one skipped geometryRelease, whose only
      // ordering check was the boolean `expect(a < b).toBe(true)` (#1181 close-out review), and once
      // the tree is clean no test can see a prefilter that skips too much.
      const scan = scanOrderings(code, rel);
      examined += scan.examined;
      for (const o of scan.offenders) population.push({ item: rel, site: `${rel}:${o.line}  ${o.text}` });
    }
    assertExemptionLedger({
      label: 'IN_FLIGHT_1179 in indexOrderingAssertions',
      population,
      exempt: IN_FLIGHT_1179,
      scanned: examined,
      floor: 500,
      fix: 'ordering assertion(s) on a raw indexOf-family position. A missing needle reads -1 and '
        + 'passes. Use expectInOrder(haystack, [a, b]) from @modoki/engine/testing/inOrder, or wrap the '
        + "position where it is produced: const at = found(src.indexOf('x'), 'x'). A separate "
        + 'toBeGreaterThan(-1) pin does not satisfy this guard. An ABSENCE check spells itself '
        + 'toBe(-1) or not.toContain, not an ordering — docs/falsifiable-tests.md § Shape (H).',
    });
  });
});
