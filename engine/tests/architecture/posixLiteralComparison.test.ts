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
 * ## ⚠️ The reach is one expression PLUS the stable bindings that carry it
 *
 * The walk climbs from the producer call to the comparison and stops at the enclosing statement —
 * unless that statement BINDS the value, in which case it continues from every read of the name
 * (#1439). So both of these are caught:
 *
 *     expect(path.relative(REPO, f)).toBe('games/x/y.ts')       // ← flagged
 *
 *     const rel = path.relative(REPO, f);
 *     expect(rel).toBe('games/x/y.ts');                          // ← flagged (was invisible before #1439)
 *
 * Before #1439, **1,795 of 4,501 scanned producer calls (~40%) bailed at a statement boundary**,
 * overwhelmingly that binding shape — the second snippet is instance 10's own defect one refactor
 * away. (That 4,501 over-counted: 190 were METHODS sharing a bare-imported producer's name —
 * `xs.join(',')` — which the #1439 close-out stopped counting.) After, on the same corpus: 4,316
 * producer calls, 1,657 binding follows (a binding reachable by two routes is walked on both — hits
 * are deduped per comparison, shortest route kept), the deepest chain 4 bindings with the cap never
 * reached, 56 values stopped by an inline normaliser on the walk, 3 bindings refused as reassigned,
 * population still 0. The expected-value
 * side reads through a bound literal the same way (`const E = 'a/b'; …toBe(E)`).
 * ⚠️ **A reassigned `let`/`var` is refused, not followed** (`isStableBinding`) — any write counts:
 * `=`/compound, a destructuring or parenthesised target, a for-of/in target, a `var` redeclaration.
 * Flow-insensitivity is the bound, so `let rel = path.relative(…); rel = toPosix(rel);
 * expect(rel).toBe('a/b')` stays out rather than being flagged wrongly — and so does a genuine
 * offender written that way.
 *
 * Still out of reach — notably, and NOT an exhaustive list, all currently zero in the corpus: element
 * access `path.relative(a, b)['endsWith']('x/y')` (both the membership arm and `calleeName` key on a
 * property access), `.endsWith.call(…)`, a block-bodied
 * `.map(function (x) { return path.relative(a, x); })` (bails at the `ReturnStatement`),
 * `expect(x).not.toBe('a/b')`, `node:path` reached through `await import(…)` or `require(…)` rather
 * than an import statement (3 files — `hmrStaleness`, `otaPublishReleaseRace`, `zoomWheel` — so their
 * producers are never scanned), a destructuring binding, an assignment to an already-declared `let`
 * (`let rel; rel = path.relative(…)` — the walk follows declarations only), `String.raw`,
 * `expect.soft`, `toEqual(expect.stringContaining('a/b'))`, `toMatch(/a\/b/)` (a regex literal —
 * `slashLiteral` reads strings only), and `new Set([…]).has(x)`. A no-substitution template literal
 * and a nested array literal ARE covered (`stringValueOf`'s `isStringLiteralLike`; `slashLiteral`
 * recurses into elements).
 *
 * **So the honest claim is "loud on a value that reaches its comparison through expressions and
 * stable bindings", not "this class can no longer be written."** `docs/windows.md` § Paths states the
 * same bound; an overstatement there is what would let instance 11 land quietly.
 *
 * ## Why this is a text test on the node, not on a window
 *
 * Normalisation is recognised on the walk itself — a hop the VALUE passes through (`normalises`) —
 * never from a fixed-width slice beside the call (`sourceAst`'s own docblock has the three-instance
 * scar for distance-based classification, #1144), and no longer from a text search over the operand
 * either (#1439 review: that pardoned `path.relative(toPosix(a), b)`). The sanctioned spellings are
 * `toPosix()` (the shared one, #798) and the three legacy inline forms `docs/windows.md` § Paths
 * leaves alone.
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
  accessPath, boundIdentifier, calleeName, declarationOf, findNodes, importsIn, lineOf, parseSource,
  readsOf, stringValueOf, ts, unwrapValue,
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

/** The file's `node:path` / `path` import edges. */
const pathImports = (sf: ts.SourceFile) => importsIn(sf).filter((edge) => /^(node:)?path$/.test(edge.spec));

/** The two legacy inline normalisations that do not name the separator, ANCHORED: each is matched
 *  against the text immediately after the value, so it must be a method called ON the value. The third
 *  legacy spelling, `.split(<sep>)`, is `SPLIT_ON`, because how `sep` is spelled depends on the file's
 *  own imports. (The shared `toPosix()` (#798) needs no pattern — see `normalises`.) */
const INLINE_NORMALISED: readonly RegExp[] = [
  /^\s*\??\.split\(\s*\/\[\\\\\/\]\/\s*\)/, //      .split(/[\\/]/)
  /^\s*\??\.replace\(\s*\/\\\\\/g\s*,/, //          .replace(/\\/g, '/')
];

/** `.split(<sep>)` on the value — its argument is read off the call, not matched as text. */
const SPLIT_ON = /^\s*\??\.split\(/;

/** How this file spells `node:path`'s `sep`: `<ns>.sep` for a namespace/default import, the local
 *  name for `import { sep }` / `{ sep as SEP }`. Read from the imports — the same way
 *  `pathProducerCalls` finds the producers — so `import nodePath` + `.split(nodePath.sep)` is
 *  recognised; a hardcoded `path.` flagged it (#1439 close-out review). */
const sepSpellings = new WeakMap<ts.SourceFile, Set<string>>();
const sepSpellingsOf = (sf: ts.SourceFile): Set<string> => {
  let found = sepSpellings.get(sf);
  if (found !== undefined) return found;
  found = new Set();
  for (const edge of pathImports(sf)) {
    for (const b of edge.bindings) {
      if (b.imported === '*' || b.imported === 'default') found.add(`${b.local}.sep`);
      else if (b.imported === 'sep') found.add(b.local);
    }
  }
  sepSpellings.set(sf, found);
  return found;
};

/** Is `node` the receiver of one of the inline normalisations?
 *
 *  ⚠️ **Structural, not a text search over the operand (#1439 review).** The first cut asked whether
 *  the comparison operand's TEXT contained `toPosix(` or an inline spelling, so
 *  `path.relative(toPosix(a), toPosix(b))` — normalised INPUTS, a backslash output on win32 — was
 *  pardoned, and so was `xs.length ? toPosix(a) : path.relative(a, b)`. The walk now asks the question
 *  of each hop it climbs through, so only a normaliser the VALUE passes through counts.
 *
 *  `toPosix(x)` needs no branch here: the value is its ARGUMENT, and a path handed to a function that
 *  is not `PASS_THROUGH` already ends the walk (mutation-checked — a `toPosix` branch was inert). */
const normalises = (node: ts.Node, parent: ts.Node): boolean => {
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) return false;
  const call = parent.parent;
  if (call === undefined || !ts.isCallExpression(call) || call.expression !== parent) return false;
  const sf = node.getSourceFile();
  const tail = sf.text.slice(node.getEnd(), call.getEnd());
  if (INLINE_NORMALISED.some((re) => re.test(tail))) return true;
  // ⚠️ Pardons `.split(sep)` whatever FOLLOWS it — `.split(sep).join(sep)` rebuilds the native
  // spelling and is still pardoned. Implausible enough to leave, and the same as the text search did.
  const arg = call.arguments[0];
  return SPLIT_ON.test(tail) && call.arguments.length === 1 && arg !== undefined
    && sepSpellingsOf(sf).has(arg.getText(sf).replace(/\s+/g, ''));
};

/** How many bindings a value is followed through — `const rel = path.relative(…)` is one,
 *  `const r2 = rel` a second. It is also what TERMINATES the walk (two consts reading each other
 *  parse). Sized as a bound, not from a measured need — see the docblock's figures for the deepest
 *  chain the corpus actually has. */
const MAX_BINDING_HOPS = 4;

/** Is `decl` a binding whose value cannot change after its initialiser — a `const`, or a `let`/`var`
 *  that nothing ever writes to?
 *
 *  ⚠️ **The walk is flow-INSENSITIVE, so a reassigned binding cannot be followed.** In
 *  `let rel = path.relative(a, b); rel = toPosix(rel); expect(rel).toBe('a/b')` every read resolves
 *  to the same declaration, and following it would flag the read AFTER the normalisation — a false
 *  positive nobody can act on. Refusing the whole binding is the honest bound (#1439). */
const isStableBinding = (decl: ts.VariableDeclaration, id: ts.Identifier): boolean => {
  if (ts.isVariableDeclarationList(decl.parent) && (decl.parent.flags & ts.NodeFlags.Const) !== 0) return true;
  return !readsOf(id).some(isWrite);
};

/** Is this occurrence of a name a WRITE to it? `readsOf` returns every occurrence resolving to the
 *  binding, targets included, so the write has to be recognised by position.
 *
 *  ⚠️ **Every assignment-target position, not just `x = …` (#1439 review).** The first cut saw only a
 *  bare identifier on the left of `=`/`+=`, so `[rel] = [toPosix(rel)]`, `({ rel } = …)`, `(rel) = …`,
 *  `for (rel of xs)` and a `var rel` REDECLARATION all left the binding "stable", and the read after the
 *  normalisation was flagged. `++`/`--` are left out: a path or a path literal is a string, and neither
 *  operator means anything on one. */
const isWrite = (r: ts.Identifier): boolean => {
  if (ts.isVariableDeclaration(r.parent) && r.parent.name === r) return true; // `var rel` again
  // Climb out of every target wrapper: `(x)`, `[x]`, `[...x]`, `{ x }`, `{ k: x }`, `{ ...x }`, and the
  // type-only ones — `(x as T)`, `x!`, `<T>x`, `(x satisfies T)` are assignable targets too.
  let cur: ts.Node = r;
  let p: ts.Node = r.parent;
  while (ts.isParenthesizedExpression(p) || ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p)
    || ts.isObjectLiteralExpression(p) || ts.isSpreadAssignment(p)
    || ((ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isTypeAssertionExpression(p)
      || ts.isSatisfiesExpression(p)) && p.expression === cur)
    || (ts.isShorthandPropertyAssignment(p) && p.name === cur)
    || (ts.isPropertyAssignment(p) && p.initializer === cur)) {
    cur = p;
    p = p.parent;
  }
  if (ts.isBinaryExpression(p) && p.left === cur) {
    const k = p.operatorToken.kind;
    return k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
  }
  return (ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === cur;
};

/** The forward-slash string literal `e` stands for, or `undefined`. A literal with no `/`
 *  (`'games'`, `'.ts'`) is separator-free and compares identically on both platforms.
 *
 *  Reads through a stable binding too — `const EXPECTED = 'a/b'; expect(rel).toBe(EXPECTED)` is the
 *  same defect with the literal one binding away, the mirror of the path side's binding (#1439). */
const slashLiteral = (e: ts.Expression, hops = 0): ts.Expression | undefined => {
  const direct = stringValueOf(e);
  if (direct !== undefined) return direct.includes('/') ? e : undefined;
  const u = unwrapValue(e);
  // An array literal of paths — `toEqual(['a/b.ts', 'c/d.ts'])`.
  if (ts.isArrayLiteralExpression(u)) {
    return u.elements.some((el) => ts.isExpression(el) && slashLiteral(el, hops) !== undefined) ? e : undefined;
  }
  if (ts.isIdentifier(u) && hops < MAX_BINDING_HOPS) {
    const decl = declarationOf(u);
    if (decl !== undefined && ts.isVariableDeclaration(decl) && decl.initializer !== undefined
      && ts.isIdentifier(decl.name) && isStableBinding(decl, decl.name)) {
      return slashLiteral(decl.initializer, hops + 1);
    }
  }
  return undefined;
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
  for (const edge of pathImports(sf)) {
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
    // A bare import is called BARE — `join(a, b)`. `calleeName` also answers `join` for `xs.join(',')`
    // and `resolve` for `Promise.resolve(x)`, and once bindings were followed (#1439) those fake
    // producers were carried through variables: 190 of the scanned calls, 68 of the binding follows,
    // and every chain that reached the depth cap started at one (#1439 close-out review).
    return ts.isIdentifier(n.expression) && bare.has(n.expression.text);
  });
};

/** Collection methods whose CALLBACK's return value becomes the collection's elements, so a path
 *  built inside one still reaches the comparison downstream. This is the shape instance 10 wore:
 *  `expect(imports.map((i) => path.relative(REPO, i.file)).sort()).toEqual([...])`. Without it the
 *  walk stops at `.map(`'s argument list and the guard misses the very defect it was written for. */
const VALUE_PRESERVING_CALLBACKS = new Set(['map', 'flatMap']);

/** Wrappers that hand the path value straight on, so the walk should continue through them.
 *  ⚠️ **`toPosix` must NOT be added here.** It used to sit here, provably inert; what exempts
 *  `toPosix(x)` is the argument bail in `walkToComparison` — the value is consumed as an argument, and
 *  the call's POSIX return is not this path. Listing it would make the walk continue past it and flag
 *  every `toPosix`-normalised comparison (mutation-checked: four tests and the corpus go red). */
const PASS_THROUGH = new Set(['expect']);

/** `depth` is how many bindings the walk crossed to reach this comparison. */
type SlashHit = { literal: ts.Expression; operand: ts.Node; shape: string; depth: number };

/** Walk up from `call` to every comparison that consumes its value, and report the forward-slash
 *  literal each is tested against. Stops at the enclosing statement — past that the value is no longer
 *  an operand of anything — unless the statement BINDS it, in which case the walk continues from each
 *  read of the binding (`walkToComparison`, #1439).
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
const slashComparison = (call: ts.CallExpression): SlashHit[] => {
  // One hit per comparison, on its SHORTEST route. Two routes to one comparison are normal
  // (`const r = c ? rel : rel`), and deduping on the result — rather than refusing a binding already
  // visited — cannot drop a hit: a visited-set marked a binding first reached AT the depth cap, so a
  // later, shorter route to it was refused and its comparison never reported (#1439 review).
  const best = new Map<ts.Node, SlashHit>();
  for (const hit of walkToComparison(call, [])) {
    const had = best.get(hit.operand);
    if (had === undefined || hit.depth < had.depth) best.set(hit.operand, hit);
  }
  return [...best.values()];
};

/** One walk of `slashComparison`, from `start` (the producer call, or a READ of a binding it reached).
 *  `via` is the chain of bindings crossed to get here, capped at `MAX_BINDING_HOPS` — which is also
 *  what makes the recursion terminate.
 *
 *  ⚠️ **A binding ends the EXPRESSION, not the value (#1439).** The first cut stopped at the enclosing
 *  statement, so `const rel = path.relative(a, b); expect(rel).toBe('a/b')` — instance 10's own defect
 *  one tidy-up away — was invisible, and 1,795 of 4,501 scanned calls (~40%) bailed there. Now a
 *  walk that reaches a declaration's initialiser continues from every READ of the bound name, resolved
 *  by symbol (`readsOf`), so a same-spelled name in a sibling function is not one of them. */
const walkToComparison = (start: ts.Node, via: readonly string[]): SlashHit[] => {
  const depth = via.length;
  const hitAt = (literal: ts.Expression, operand: ts.Node, s: string): SlashHit[] =>
    [{ literal, operand, depth, shape: depth === 0 ? s : `${s} via ${via.join(' → ')}` }];
  let node: ts.Node = start;
  for (let hop = 0; hop < 16; hop += 1) {
    const parent: ts.Node | undefined = node.parent;
    if (parent === undefined || ts.isStatement(parent)) return [];

    // The value is the receiver of an inline normaliser: from here on it is POSIX. This one check covers
    // one at the producer, at a binding's initialiser, and at a read. (`toPosix(x)` is ended by the
    // argument bail below, not here.)
    if (normalises(node, parent)) return [];

    // `const rel = <the value>` — follow the binding to each of its reads. (A read that is itself a
    // declaration NAME — a `var` redeclaration — never gets here with a follow: `isWrite` counts it, so
    // `isStableBinding` refuses the whole binding first.)
    if (ts.isVariableDeclaration(parent)) {
      if (depth >= MAX_BINDING_HOPS) return [];
      const id = ts.isExpression(node) ? boundIdentifier(node) : undefined;
      if (id === undefined || !isStableBinding(parent, id)) return [];
      return readsOf(id).flatMap((read) => walkToComparison(read, [...via, id.text]));
    }

    // The value was consumed as an argument by something other than a pass-through wrapper or a
    // value-preserving callback host — whatever is compared downstream is that callee's output, not
    // this path.
    if (ts.isCallExpression(parent) && parent.arguments.some((a) => a === node)) {
      const callee = calleeName(parent) ?? '';
      const isCallbackHost = VALUE_PRESERVING_CALLBACKS.has(callee)
        && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
      if (!PASS_THROUGH.has(callee) && !isCallbackHost) return [];
    }

    // `x === 'a/b'` / `'a/b' === x`
    if (ts.isBinaryExpression(parent) && EQUALITY_OPERATORS.has(parent.operatorToken.kind)) {
      const other = parent.left === node ? parent.right : parent.left;
      const literal = slashLiteral(other);
      if (literal !== undefined) return hitAt(literal, node, 'equality');
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
      const literal = membershipCall !== undefined && ts.isCallExpression(membershipCall)
        && membershipCall.expression === parent && membershipCall.arguments.length > 0
        ? slashLiteral(membershipCall.arguments[0]) : undefined;
      if (literal !== undefined) return hitAt(literal, node, `.${parent.name.text}()`);
    }

    // `expect(x).toEqual('a/b')` — `node` is the argument of `expect(...)`, so the matcher call is two
    // hops further out. Only the FIRST argument is the expected value; a second is a message.
    if (ts.isCallExpression(parent) && calleeName(parent) === 'expect' && parent.arguments[0] === node) {
      const access = parent.parent;
      if (access !== undefined && ts.isPropertyAccessExpression(access) && MATCHERS.has(access.name.text)) {
        const matcher = access.parent;
        const literal = matcher !== undefined && ts.isCallExpression(matcher) && matcher.arguments.length > 0
          ? slashLiteral(matcher.arguments[0]) : undefined;
        if (literal !== undefined) {
          return hitAt(literal, node, `expect().${access.name.text}()`);
        }
      }
    }

    node = parent;
  }
  return [];
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
        for (const hit of slashComparison(call)) {
          const producer = accessPath(call.expression) ?? calleeName(call) ?? '<?>';
          const compared = lineOf(hit.operand) === lineOf(call) ? '' : `, compared at :${lineOf(hit.operand)}`;
          population.push({
            item: `${rel}::${producer}:${hit.shape}`,
            site: `${rel}:${lineOf(call)}${compared} — ${producer}(…) vs `
              + JSON.stringify(stringValueOf(hit.literal) ?? '[…]'),
          });
        }
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
    for (const hit of slashComparison(call)) {
      shapes.push(hit.shape);
    }
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
      const shapes = pathProducerCalls(sf).flatMap((c) => slashComparison(c).map((h) => h.shape));
      expect(shapes).toEqual(['equality']);
    });

    // #1439: the value bound to a name first, then compared — instance 10 one tidy-up away.
    it('a path BOUND to a name, then compared — each comparison arm', () => {
      expect(detect("const rel = path.relative(a, b);\nexpect(rel).toBe('games/x/y.ts');"))
        .toEqual(['expect().toBe() via rel']);
      expect(detect("const rel = path.relative(a, b);\nconst bad = rel === 'games/x/y.ts';"))
        .toEqual(['equality via rel']);
      expect(detect("const rel = path.relative(a, b);\nconst bad = rel.endsWith('games/x/y.ts');"))
        .toEqual(['.endsWith() via rel']);
    });

    it('a binding chained through a second name', () => {
      expect(detect("const rel = path.relative(a, b);\nconst r2 = rel;\nexpect(r2).toBe('games/x/y.ts');"))
        .toEqual(['expect().toBe() via rel → r2']);
    });

    it('a let that nothing reassigns', () => {
      expect(detect("let rel = path.relative(a, b);\nexpect(rel).toBe('games/x/y.ts');"))
        .toEqual(['expect().toBe() via rel']);
    });

    // Two reads of `rel` both reach `r`'s declaration; `r` is followed ONCE, not once per read.
    it('a binding reached twice is followed once', () => {
      expect(detect("const rel = path.relative(a, b);\nconst r = xs.length > 0 ? rel : rel;\n"
        + "expect(r).toBe('games/x/y.ts');")).toEqual(['expect().toBe() via rel → r']);
    });

    // A binding first reached at the depth cap must not hide a SHORTER route to the same comparison.
    // Via s → t the walk meets `u` at depth 3 and `v` at the cap; via `|| r` it meets `u` at depth 1.
    it('a comparison reachable by a long route and a short one — reported on the short one', () => {
      expect(detect("const r = path.relative(a, b);\nconst s = r;\nconst t = s;\nconst u = t || r;\n"
        + "const v = u;\nexpect(v).toBe('games/x/y.ts');")).toEqual(['expect().toBe() via r → u → v']);
      // Both routes reach the comparison here, the LONGER one first in source order: kept is the shorter.
      expect(detect("const r = path.relative(a, b);\nconst s = r;\nconst u = s || r;\nexpect(u).toBe('games/x/y.ts');"))
        .toEqual(['expect().toBe() via r → u']);
    });

    // `MAX_BINDING_HOPS` is also what TERMINATES the walk: two consts reading each other parse fine (the
    // TDZ throws only at run time), so without the cap this recursion never returns.
    it('a binding cycle terminates and still reports the comparison', () => {
      expect(detect("const x = path.relative(a, b) || y;\nconst y = x;\nexpect(y).toBe('games/x/y.ts');"))
        .toEqual(['expect().toBe() via x → y']);
    });

    // The inline spellings must be a method called ON the value — not one appearing anywhere after it.
    it('an inline normaliser inside a DIFFERENT call\'s arguments does not pardon the value', () => {
      expect(detect("const bad = path.relative(a, b).concat(a.split(path.sep)[0]) === 'games/x/y.ts';"))
        .toEqual(['equality']);
    });

    // Normalised INPUTS are not a normalised output: path.win32.relative('C:/a', 'C:/a/b/c') is 'b\\c'.
    it('toPosix on the producer\'s ARGUMENTS, or on a sibling branch, does not pardon the value', () => {
      expect(detect("expect(path.relative(toPosix(a), toPosix(b))).toBe('games/x/y.ts');"))
        .toEqual(['expect().toBe()']);
      expect(detect("const rel = path.relative(toPosix(a), b);\nexpect(rel).toBe('games/x/y.ts');"))
        .toEqual(['expect().toBe() via rel']);
      expect(detect("const rel = xs.length > 0 ? toPosix(a) : path.relative(a, b);\n"
        + "expect(rel).toBe('games/x/y.ts');")).toEqual(['expect().toBe() via rel']);
    });

    it('a NESTED array literal', () => {
      expect(detect("expect(path.relative(a, b)).toEqual([['games/x/y.ts']]);")).toEqual(['expect().toEqual()']);
    });

    it('the LITERAL bound to a name — directly and inside an array', () => {
      expect(detect("const E = 'games/x/y.ts';\nexpect(path.relative(a, b)).toBe(E);"))
        .toEqual(['expect().toBe()']);
      expect(detect("const E = 'games/x/y.ts';\nexpect(path.relative(a, b)).toEqual([E]);"))
        .toEqual(['expect().toEqual()']);
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
    // `hasSlashLiteral` (now `slashLiteral`) refuses anyway — so the case passed whether or not the
    // message exclusion existed, and deleting the exclusion left all 14 tests green. Found by close-out
    // review: a reject
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

    // #1439 — each reject goes red under the mutation that removes its own exclusion.
    it('a binding whose INITIALISER normalises', () => {
      expect(detect("const rel = toPosix(path.relative(a, b));\nexpect(rel).toBe('games/x/y.ts');")).toEqual([]);
    });

    it('a bound path normalised at the READ', () => {
      expect(detect("const rel = path.relative(a, b);\nexpect(toPosix(rel)).toBe('games/x/y.ts');")).toEqual([]);
    });

    it('a bound path CONSUMED as an argument by something else', () => {
      expect(detect("const p = path.join(a, b);\nexpect(absToAssetUrl(p)).toBe('/assets/x.json');")).toEqual([]);
    });

    it('a same-spelled name in a sibling function is not a read of the binding', () => {
      expect(detect("const rel = path.relative(a, b);\n"
        + "function f(rel: string) { return rel === 'games/x/y.ts'; }")).toEqual([]);
    });

    // Flow-insensitive: the read after `rel = toPosix(rel)` resolves to the same declaration as the one
    // before it, so a reassigned binding is not followed at all rather than flagged wrongly.
    it('a let that IS reassigned — path side and literal side', () => {
      expect(detect("let rel = path.relative(a, b);\nrel = toPosix(rel);\nexpect(rel).toBe('games/x/y.ts');"))
        .toEqual([]);
      expect(detect("let E = 'games/x/y.ts';\nE = 'games';\nexpect(path.relative(a, b)).toBe(E);")).toEqual([]);
    });

    // A compound write is a write too: the value at the read is no longer the initialiser's.
    it('a let written by a COMPOUND assignment', () => {
      expect(detect("let rel = path.relative(a, b);\nrel += '';\nexpect(rel).toBe('games/x/y.ts');")).toEqual([]);
    });

    // A bare import is called bare: `xs.join(',')` is Array#join and `Promise.resolve` is not path's.
    it('a METHOD sharing a bare-imported producer\'s name is not a producer', () => {
      const shapesIn = (code: string) => pathProducerCalls(parseSource(code, 'synthetic.test.ts'))
        .flatMap((c) => slashComparison(c).map((h) => h.shape));
      const prelude = "import { join, resolve } from 'node:path';\ndeclare const a: string, xs: string[];\n";
      expect(shapesIn(`${prelude}const text = xs.join(',');\nexpect(text).toContain('games/x/y.ts');\n`
        + "const v = Promise.resolve(a);\nexpect(v).toBe('games/x/y.ts');")).toEqual([]);
      // …while the bare call itself still is — the accept half, in the same prelude.
      expect(shapesIn(`${prelude}const bad = join(a, 'x') === 'games/x/y.ts';`)).toEqual(['equality']);
    });

    // `.split(<sep>)` is read off the file's own imports, whatever it named them.
    it('.split(sep) under the file\'s OWN spelling of sep', () => {
      const shapesIn = (code: string) => pathProducerCalls(parseSource(code, 'synthetic.test.ts'))
        .flatMap((c) => slashComparison(c).map((h) => h.shape));
      expect(shapesIn("import nodePath from 'node:path';\ndeclare const a: string, b: string;\n"
        + "expect(nodePath.relative(a, b).split(nodePath.sep).join('/')).toBe('games/x/y.ts');")).toEqual([]);
      expect(shapesIn("import { relative, sep as SEP } from 'node:path';\ndeclare const a: string, b: string;\n"
        + "expect(relative(a, b).split(SEP).join('/')).toBe('games/x/y.ts');")).toEqual([]);
      // A split on something that is NOT the separator normalises nothing.
      expect(detect("const bad = path.relative(a, b).split(a).join('/') === 'games/x/y.ts';")).toEqual(['equality']);
    });

    // Every assignment-TARGET position is a write, not just a bare `rel = …` (#1439 review).
    it.each([
      ['an `as` target', '(rel as string) = toPosix(rel);'],
      ['a non-null target', 'rel! = toPosix(rel);'],
      ['an angle-bracket assertion target', '(<string>rel) = toPosix(rel);'],
      ['a `satisfies` target', '(rel satisfies string) = toPosix(rel);'],
      ['an array destructure', '[rel] = [toPosix(rel)];'],
      ['an object destructure', '({ rel } = { rel: toPosix(rel) });'],
      ['a renamed object destructure', '({ k: rel } = { k: toPosix(rel) });'],
      ['a parenthesised target', '(rel) = toPosix(rel);'],
      ['a for-of target', 'for (rel of xs) { /* */ }'],
    ])('a let written through %s', (_label, write) => {
      expect(detect(`let rel = path.relative(a, b);\n${write}\nexpect(rel).toBe('games/x/y.ts');`)).toEqual([]);
    });

    it('a var REDECLARED — path side and literal side', () => {
      expect(detect("var rel = path.relative(a, b);\nvar rel = toPosix(rel);\nexpect(rel).toBe('games/x/y.ts');"))
        .toEqual([]);
      expect(detect("var E = 'games/x/y.ts';\nvar E = 'games';\nexpect(path.relative(a, b)).toBe(E);")).toEqual([]);
    });
  });
});
