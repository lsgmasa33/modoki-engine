/**
 * ⚠️ **A `node:path` result must never be COMPARED against a forward-slash string literal (#1435).**
 *
 * `path.relative()`/`join()`/`resolve()` return `\`-separated paths on win32. A test that compares
 * one of those against a hand-authored `'games/wordweave/runtime/rarity.ts'` passes on every Mac and
 * fails — or, worse, silently stops matching — on Windows. This is the class #798 gave a shared
 * helper, #847/#849 swept, and #799 asked to be GUARDED rather than caught by hand: *"eight instances
 * in eighteen days"*. #968 then recorded that retiring the private `ci.yml` removed the only Windows
 * leg, so since then the class has been held by discipline and not by a gate.
 *
 * Instance 10 (#1435) proved discipline is not enough, and it proved something sharper about the two
 * guards that already exist for this family. `corpusProducerIsShared` says "use `repoFiles()`" and
 * `corpusConsumerPins` says "if you discard its POSIX `rel`, carry a non-vacuity pin" — both are
 * scoped to the shared corpus producer. `wordbankExportImports.test.ts` never called it: it scraped
 * `../games/...` specifiers out of `wordbank/export.mjs` and resolved them with `path.resolve`, so it
 * was out of BOTH guards' reach by construction. That is a third leak shape beside the two
 * `docs/windows.md` § Paths enumerates (discard-`rel`; `abs` vs a separately-derived `abs`):
 * **a path built from a specifier string, then compared as a repo-relative path.** This guard keys
 * off the comparison instead of off the producer, so it sees all three.
 *
 * ## What counts as an offender
 *
 * A `node:path` call whose value reaches a forward-slash string literal through an EQUALITY or
 * MEMBERSHIP test:
 *
 *   - `path.relative(a, b) === 'x/y.ts'`            (and `!==`, `==`, `!=`, either way round)
 *   - `expect(path.join(a, b)).toEqual('x/y')`      (`toBe`/`toStrictEqual`/`toContain`/`toMatch`,
 *                                                    and an array literal of such strings)
 *   - `path.relative(a, b).endsWith('x/y.ts')`      (`startsWith`/`includes`)
 *
 * ⚠️ **Interpolating a path into a MESSAGE is not an offender, and that distinction is the whole
 * reason this guard is cheap enough to adopt.** The corpus holds ~20 sites that build an offender
 * label or an `expect(…, msg)` string out of `path.relative` — `reapScoping`, `mcpBundle`,
 * `docCitations` and friends. A backslash there makes a failure message read oddly on one platform;
 * it changes no verdict. The detector therefore only looks at operands of a comparison, which
 * excludes template literals and `expect`'s second argument structurally rather than by a ledger row
 * per benign site. Sizing a guard so its population is ~0 is what makes the rule adoptable: #799's
 * eight instances were never fixed as a class because the naive detector's population was ~62.
 *
 * ⚠️ **A symmetric comparison is not an offender either** — `expect(path.relative(…)).toContain(
 * path.join('android', 'app'))` is platform-symmetric, because both sides are separator-native. Only
 * a STRING LITERAL on the other side is a defect, so `generateIcons`/`userDataDir`/`defaultFont` stay
 * out without rows of their own.
 *
 * ## ⚠️ The reach is ONE EXPRESSION — a path bound to a variable first is out of scope
 *
 * The walk climbs from the producer call to the comparison and **stops at the enclosing statement**,
 * so this is caught:
 *
 *     expect(path.relative(REPO, f)).toBe('games/x/y.ts')       // ← flagged
 *
 * and this is NOT:
 *
 *     const rel = path.relative(REPO, f);
 *     expect(rel).toBe('games/x/y.ts');                          // ← invisible
 *
 * Measured on the shipped scan: **1,795 of 4,501 scanned producer calls (~40%) bail at a statement
 * boundary**, overwhelmingly that binding shape — and the second snippet is instance 10's own defect
 * one refactor away. Following the value would mean dataflow along the binding (`boundIdentifier` +
 * `readsOf` in `sourceAst.ts` exist for it); that is a deliberate follow-up, not a silent gap, and the
 * corpus has zero live instances of it today.
 *
 * Same boundary or a neighbouring one — notably, and NOT an exhaustive list, all currently zero in the
 * corpus: element access `path.relative(a, b)['endsWith']('x/y')` (both the membership arm and
 * `calleeName` key on a property access), `.endsWith.call(…)`, a block-bodied
 * `.map(function (x) { return path.relative(a, x); })` (bails at the `ReturnStatement`),
 * `expect(x).not.toBe('a/b')`, a
 * comparison against a const-referenced literal, `String.raw`, `expect.soft`,
 * `toEqual(expect.stringContaining('a/b'))`, `toMatch(/a\/b/)` (a regex literal — `hasSlashLiteral`
 * reads strings only), a nested array literal, and `new Set([…]).has(x)`. A no-substitution template
 * literal IS covered, via `stringValueOf`'s `isStringLiteralLike`.
 *
 * **So the honest claim is "loud on the single-expression shape", not "this class can no longer be
 * written."** `docs/windows.md` § Paths states the same bound; an overstatement there is what would
 * let instance 11 land quietly.
 *
 * ## Why this is a text test on the node, not on a window
 *
 * Normalisation is recognised from the extent of the enclosing comparison operand, never from a
 * fixed-width slice beside the call — `sourceAst`'s own docblock has the three-instance scar for
 * distance-based classification (#1144). The sanctioned spellings are `toPosix()` (the shared one,
 * #798) and the three legacy inline forms `docs/windows.md` § Paths leaves alone.
 *
 * ⚠️ **`floor` is on `scanned`, not on `population`.** The goal state here is an EMPTY population, so
 * flooring the offenders would refuse exactly the outcome the guard exists to produce
 * (`exemptionLedger`'s own `scanned` docblock). What has to stay non-vacuous is the SCAN, so the
 * floor is on the number of `node:path` calls the detector actually examined.
 */
import { describe, expect, it } from 'vitest';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import {
  accessPath, calleeName, findNodes, flatText, importsIn, lineOf, parseSource, stringValueOf, ts, unwrapValue,
} from '@modoki/engine/testing/sourceAst';

/** The `node:path` producers that return a separator-native string. `sep`/`delimiter` are not calls,
 *  and `basename`/`extname` cannot contain a separator, so neither can collide with a `/` literal. */
const PATH_PRODUCERS: readonly string[] = ['relative', 'join', 'resolve', 'normalize', 'dirname'];

/** Equality/membership matchers. `toMatch` is included because `toMatch('a/b')` on a string argument
 *  is a substring test, not a regex — the same silent miss. */
const MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toContain', 'toContainEqual', 'toMatch']);

/** String methods that test membership against their argument. */
const MEMBERSHIP = new Set(['endsWith', 'startsWith', 'includes']);

const EQUALITY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** The sanctioned normalisations: the shared helper (#798) plus the three legacy inline spellings
 *  `docs/windows.md` § Paths deliberately leaves in place. Matched over the enclosing operand's own
 *  extent — never a fixed-width window beside the call (#1144). */
const NORMALISED: readonly RegExp[] = [
  /\btoPosix\s*\(/,
  /\.split\(\s*\/\[\\\\\/\]\/\s*\)/, //      .split(/[\\/]/)
  /\.replace\(\s*\/\\\\\/g\s*,/, //          .replace(/\\/g, '/')
  /\.split\(\s*(?:path\.)?sep\s*\)/, //      .split(path.sep) / .split(sep)
];

/** Does `e` hold a forward slash inside a plain string literal? A literal with no `/` (`'games'`,
 *  `'.ts'`) is separator-free and compares identically on both platforms. */
const hasSlashLiteral = (e: ts.Expression): boolean => {
  const direct = stringValueOf(e);
  if (direct !== undefined) return direct.includes('/');
  // An array literal of paths — `toEqual(['a/b.ts', 'c/d.ts'])`.
  const u = unwrapValue(e);
  if (ts.isArrayLiteralExpression(u)) return u.elements.some((el) => (stringValueOf(el) ?? '').includes('/'));
  return false;
};

/** Every `node:path` producer call in `sf`, however it is spelled.
 *
 *  `import * as path` / `import path` put the producers behind a namespace; `import { join }` puts one
 *  in scope under a bare name. Both are read from the file's OWN imports rather than assumed to be
 *  spelled `path`, because a local `join` helper is not a path producer and flagging one would be a
 *  false positive nobody can act on. */
const pathProducerCalls = (sf: ts.SourceFile): ts.CallExpression[] => {
  const dottedWanted = new Set<string>();
  const bare = new Set<string>();
  for (const edge of importsIn(sf)) {
    if (!/^(node:)?path$/.test(edge.spec)) continue;
    for (const b of edge.bindings) {
      if (b.imported === '*' || b.imported === 'default') {
        for (const p of PATH_PRODUCERS) dottedWanted.add(`${b.local}.${p}`);
      } else if (PATH_PRODUCERS.includes(b.imported)) {
        bare.add(b.local);
      }
    }
  }

  return findNodes(sf, (n): n is ts.CallExpression => {
    if (!ts.isCallExpression(n)) return false;
    const dotted = accessPath(n.expression);
    if (dotted !== undefined && dottedWanted.has(dotted)) return true;
    const name = calleeName(n);
    return name !== undefined && bare.has(name);
  });
};

/** Collection methods whose CALLBACK's return value becomes the collection's elements, so a path
 *  built inside one still reaches the comparison downstream. This is the shape instance 10 wore:
 *  `expect(imports.map((i) => path.relative(REPO, i.file)).sort()).toEqual([...])`. Without it the
 *  walk stops at `.map(`'s argument list and the guard misses the very defect it was written for. */
const VALUE_PRESERVING_CALLBACKS = new Set(['map', 'flatMap']);

/** Wrappers that hand the path value straight on, so the walk should continue through them.
 *
 *  ⚠️ **`toPosix` here is belt-and-braces and provably INERT** — removing it leaves every test and
 *  whole corpus scan green, because either route already pardons: if the walk continues through
 *  toPosix(...) then the comparison operand IS that call, whose flatText matches NORMALISED; if it does
 *  not, the argument-bail pardons instead. Kept for intent (a reader should see that a normaliser is
 *  pass-through rather than consumption) and recorded here as untestable, so nobody later mistakes it
 *  for load-bearing and builds on it. */
const PASS_THROUGH = new Set(['expect', 'toPosix']);

/** Walk up from `call` to the comparison that consumes its value, and report the forward-slash
 *  literal it is tested against. Stops at the enclosing statement: past that the value is no longer
 *  an operand of anything.
 *
 *  ⚠️ **A path handed to ANOTHER function as an argument is not the compared value.** Twelve sites
 *  were flagged by the first cut of this walk, and all twelve were the same false positive:
 *  `expect(absToAssetUrl(path.join(tmp, 'fx', 'spark.json'), …)).toBe('/assets/FX/Spark.json')`,
 *  `expect(fs.readFileSync(path.join(dest, 'run.sh'), 'utf8')).toContain('#!/bin/sh')`,
 *  `expect(relativiseUnderProject(root, path.join(…))).toBe('art/icon.png')`. In each, the separator-
 *  native path is an INPUT to a function whose POSIX-producing return is what the literal describes —
 *  `absToAssetUrl` and `relativiseUnderProject` exist precisely to emit a `/` spelling, and a shebang
 *  is file content, not a path. Flagging those would have made the guard's population 12 instead of
 *  0, which is how a rule of this shape gets abandoned rather than adopted. */
const slashComparison = (
  call: ts.CallExpression,
): { literal: ts.Expression; operand: ts.Node; shape: string } | undefined => {
  let node: ts.Node = call;
  for (let hop = 0; hop < 16; hop += 1) {
    const parent: ts.Node | undefined = node.parent;
    if (parent === undefined || ts.isStatement(parent)) return undefined;

    // The value was consumed as an argument by something other than a pass-through wrapper or a
    // value-preserving callback host — whatever is compared downstream is that callee's output, not
    // this path.
    if (ts.isCallExpression(parent) && parent.arguments.some((a) => a === node)) {
      const callee = calleeName(parent) ?? '';
      const isCallbackHost = VALUE_PRESERVING_CALLBACKS.has(callee)
        && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
      if (!PASS_THROUGH.has(callee) && !isCallbackHost) return undefined;
    }

    // `x === 'a/b'` / `'a/b' === x`
    if (ts.isBinaryExpression(parent) && EQUALITY_OPERATORS.has(parent.operatorToken.kind)) {
      const other = parent.left === node ? parent.right : parent.left;
      if (hasSlashLiteral(other)) return { literal: other, operand: node, shape: 'equality' };
    }

    // `x.endsWith('a/b')` — ⚠️ `node`'s parent is the PROPERTY ACCESS, and the call is one hop further
    // out. Asking for `isCallExpression(parent) && parent.expression.expression === node` (the first
    // cut here) is unsatisfiable for every well-formed AST, optional chain included: if `node` is the
    // object of a property access then `node.parent` IS that property access, never the call around
    // it. It shipped as dead code, and the review that caught it is why step 3 below pins each of the
    // three shapes on synthetic source — one mutation per SHAPE, not one per guard (#1435).
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node
      && MEMBERSHIP.has(parent.name.text)) {
      const membershipCall = parent.parent;
      if (membershipCall !== undefined && ts.isCallExpression(membershipCall)
        && membershipCall.expression === parent && membershipCall.arguments.length > 0
        && hasSlashLiteral(membershipCall.arguments[0])) {
        return { literal: membershipCall.arguments[0], operand: node, shape: `.${parent.name.text}()` };
      }
    }

    // `expect(x).toEqual('a/b')` — `node` is the argument of `expect(...)`, so the matcher call is two
    // hops further out. Only the FIRST argument is the expected value; a second is a message.
    if (ts.isCallExpression(parent) && calleeName(parent) === 'expect' && parent.arguments[0] === node) {
      const access = parent.parent;
      if (access !== undefined && ts.isPropertyAccessExpression(access) && MATCHERS.has(access.name.text)) {
        const matcher = access.parent;
        if (matcher !== undefined && ts.isCallExpression(matcher) && matcher.arguments.length > 0
          && hasSlashLiteral(matcher.arguments[0])) {
          return { literal: matcher.arguments[0], operand: node, shape: `expect().${access.name.text}()` };
        }
      }
    }

    node = parent;
  }
  return undefined;
};

/** Every root holding tests that `verify` runs.
 *
 *  ⚠️ **Not all from one config, and the first cut said otherwise.** `engine/tests`,
 *  `engine/templates/starter`, `games` and `demos` come from `engine/vite.config.ts`'s `include`;
 *  `engine/packages/modoki/tests` is EXCLUDED there (`exclude: ['packages/**']`) and runs under its own
 *  `engine/packages/modoki/vitest.config.ts` as `verify`'s second suite. Both belong in the scan — only
 *  the derivation was mis-stated.
 *  ⚠️ **This list and `isScannedTestFile` are a hand-maintained restatement of those two include
 *  lists, so they SHADOW them.** That is tolerable only because the predicate is a SUPERSET (any
 *  `*.test.ts`, plus anything under a `tests/` dir), so a new glob inside these roots is already
 *  covered and only a new ROOT needs a hand edit. Swept at #1435: zero files match
 *  `isScannedTestFile` anywhere outside `TEST_ROOTS`.
 *
 *  ⚠️ **`engine/templates/starter` is in the list deliberately** — it is not dead sample code: vitest
 *  runs `templates/starter/tests/**` , it SHIPS in the OSS snapshot, and it is the source a scaffolded
 *  project is born from, so a POSIX-literal comparison there is copied into every new project. Its
 *  `tapTargets.test.ts` already imports `{ dirname, join } from 'node:path'`, so the producer is
 *  present and only the comparison is missing. Found by close-out review, which also caught that the
 *  first cut's "every project's `tests/`" overstated what the scan reached. */
const TEST_ROOTS = [
  'engine/tests', 'engine/packages/modoki/tests', 'engine/templates/starter', 'games', 'demos',
];

/** A file the scan reads: any test file, plus any module under a `tests/` directory.
 *
 *  ⚠️ **Both halves are needed, and the `tests/`-segment half alone was a gap.** vitest's include list
 *  runs `games/*` + `demos/*`'s `packages/*​/**​/*.test.ts`, which carry NO `tests/` path segment, so a
 *  `tests/`-only predicate silently skipped them. The test-file half alone is not enough either: a
 *  shared fixture under `tests/` (`games/court/tests/chromeFixture.ts`,
 *  `engine/tests/helpers/repoLayout.ts`) is not named `*.test.ts` and can hold the comparison just as
 *  easily as the spec that imports it. */
const isScannedTestFile = (rel: string): boolean =>
  /\.test\.tsx?$/.test(rel) || (/\.tsx?$/.test(rel) && /(^|\/)tests\//.test(rel));

describe('a node:path result is never compared against a forward-slash literal (#1435)', () => {
  const files = repoFiles({ under: TEST_ROOTS, match: isScannedTestFile, floor: 200 });

  it('no test compares separator-native path output against a POSIX literal', () => {
    const population: Array<{ item: string; site: string }> = [];
    let scanned = 0;

    for (const { rel, abs } of files) {
      const sf = parseSource(readScannedSource(abs).code, rel);
      for (const call of pathProducerCalls(sf)) {
        scanned += 1;
        const hit = slashComparison(call);
        if (hit === undefined) continue;
        // Normalisation is read off the operand's OWN extent, not a window beside the call (#1144).
        if (NORMALISED.some((re) => re.test(flatText(hit.operand)))) continue;
        const producer = accessPath(call.expression) ?? calleeName(call) ?? '<?>';
        population.push({
          item: `${rel}::${producer}:${hit.shape}`,
          site: `${rel}:${lineOf(call)} — ${producer}(…) vs ${JSON.stringify(stringValueOf(hit.literal) ?? '[…]')}`,
        });
      }
    }

    assertExemptionLedger({
      label: 'node:path output compared to a POSIX literal, in posixLiteralComparison',
      population,
      scanned,
      floor: 150,
      fix: 'Wrap the path value in `toPosix()` from engine/scripts/pathPosix.mjs (#798), or better, '
        + "key off `repoFiles()`'s POSIX `rel` and never build a native path at all (#1264).",
    });
  });
});

/** Run the detector over synthetic source and report each offender's `shape`.
 *
 *  This exists because the corpus scan above CANNOT pin the detector: its healthy state is an empty
 *  population, so every arm of `slashComparison` could be broken and the corpus assertion would still
 *  be green. The membership arm shipped exactly that way — unsatisfiable for every well-formed AST,
 *  and invisible because the one mutation run against it (reverting `toPosix` in
 *  `wordbankExportImports`) exercises the `expect()` arm only. **One case per shape, accept AND
 *  reject** (#1435). */
const detect = (body: string): string[] => {
  const code = "import * as path from 'node:path';\n"
    + "import { toPosix } from '../../scripts/pathPosix.mjs';\n"
    + `declare const a: string, b: string, xs: string[], offenders: string[];\n${body}\n`;
  const sf = parseSource(code, 'synthetic.test.ts');
  const calls = pathProducerCalls(sf);
  // ⚠️ Non-vacuity pin on the HELPER itself. Without it, a break in the prelude above (a renamed
  // import, a parse change) leaves `calls` empty and every REJECT case below passes for the wrong
  // reason, all at once — the accept cases would catch it, but only by accident of sharing a prelude.
  expect(calls.length, `synthetic source produced no node:path producer call:\n${body}`)
    .toBeGreaterThan(0);
  const shapes: string[] = [];
  for (const call of calls) {
    const hit = slashComparison(call);
    if (hit === undefined) continue;
    if (NORMALISED.some((re) => re.test(flatText(hit.operand)))) continue;
    shapes.push(hit.shape);
  }
  return shapes;
};

describe('the detector, on synthetic source — one case per SHAPE, accept and reject (#1435)', () => {
  describe('accepts', () => {
    it('a direct equality comparison', () => {
      expect(detect("const bad = path.relative(a, b) === 'games/x/y.ts';")).toEqual(['equality']);
    });

    it('a reversed equality comparison', () => {
      expect(detect("const bad = 'games/x/y.ts' !== path.relative(a, b);")).toEqual(['equality']);
    });

    it('an expect() matcher', () => {
      expect(detect("expect(path.relative(a, b)).toBe('games/x/y.ts');")).toEqual(['expect().toBe()']);
    });

    it('an expect() matcher against an ARRAY literal', () => {
      expect(detect("expect(path.relative(a, b)).toEqual(['games/x/y.ts', 'games/p/q.ts']);"))
        .toEqual(['expect().toEqual()']);
    });

    // ⚠️ The arm that shipped dead. If this goes green while the corpus scan stays green, the
    // membership shape is inert again.
    it('a membership test — the shape that shipped as unreachable code', () => {
      expect(detect("const bad = path.relative(a, b).endsWith('games/x/y.ts');")).toEqual(['.endsWith()']);
      expect(detect("const bad = path.relative(a, b).includes('/scenes/');")).toEqual(['.includes()']);
    });

    // Instance 10's own shape: the value is built inside a `.map` callback, so the walk has to cross
    // the callback boundary to reach the comparison.
    it('a value built inside a .map callback', () => {
      expect(detect("expect(xs.map((x) => path.relative(a, x)).sort()).toEqual(['games/x/y.ts']);"))
        .toEqual(['expect().toEqual()']);
    });

    it('a producer imported under a bare name', () => {
      const code = "import { relative } from 'node:path';\ndeclare const a: string, b: string;\n"
        + "const bad = relative(a, b) === 'games/x/y.ts';";
      const sf = parseSource(code, 'synthetic.test.ts');
      const shapes = pathProducerCalls(sf).map((c) => slashComparison(c)?.shape).filter(Boolean);
      expect(shapes).toEqual(['equality']);
    });
  });

  describe('rejects', () => {
    it('a comparison that normalises through toPosix', () => {
      expect(detect("expect(toPosix(path.relative(a, b))).toBe('games/x/y.ts');")).toEqual([]);
    });

    it('a comparison that normalises inline', () => {
      expect(detect("const ok = path.relative(a, b).split(path.sep).join('/') === 'games/x/y.ts';"))
        .toEqual([]);
    });

    // The twelve real false positives the first cut flagged, in miniature.
    it('a path CONSUMED as an argument by something else', () => {
      expect(detect("expect(absToAssetUrl(path.join(a, b))).toBe('/assets/x.json');")).toEqual([]);
    });

    // ⚠️ The matcher MUST carry a slash literal. The first cut asserted on `.toEqual([])`, which
    // `hasSlashLiteral` refuses anyway — so the case passed whether or not the message exclusion
    // existed, and deleting the exclusion left all 14 tests green. Found by close-out review: a reject
    // case has to go RED under the mutation that removes ITS OWN exclusion, not merely be green today.
    it("a path interpolated into a MESSAGE — expect()'s SECOND argument", () => {
      expect(detect("expect(a, `at ${path.relative(a, b)}`).toBe('games/x/y.ts');")).toEqual([]);
    });

    it('a literal with no separator in it', () => {
      expect(detect("const ok = path.relative(a, b) === 'games';")).toEqual([]);
    });

    it('a symmetric comparison against another path call', () => {
      expect(detect("expect(path.relative(a, b)).toBe(path.join('games', 'x'));")).toEqual([]);
    });
  });
});
