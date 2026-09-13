/**
 * ⚠️ **A source-scanning guard classifies an occurrence by its own NODE, never by distance (#1144).**
 *
 * The defect this module exists to end: a guard found an occurrence, then decided whether it
 * complied by searching a FIXED-WIDTH text window beside it — `src.slice(at, at + 400)`, a
 * `[\s\S]{0,300}` span, a ±90-char segment. The window is not the occurrence's extent, so it fails
 * both ways:
 *
 * - **too wide** — a NEIGHBOURING occurrence's token vouches for this one. Observed three times:
 *   `adbTargeting` read an un-targeted `adb devices -l` as targeted because the next call's
 *   `adbArgs(` sat within 400 chars (#1140); `rawSourceReads` excused a raw read because the next
 *   line's `JSON.parse(` did; `crFragileLineParses` excused a CR-fragile match because the next
 *   loop's `line.trim()` did.
 * - **too narrow** — a per-LINE match cannot see a call a formatter wrapped (#1108, #1128).
 *
 * ⚠️ **Parse — do not write a tokenizer.** Before the AST, #1140 tried a hand-balanced paren scan
 * (over-read on a quote inside a regex literal) and then a regex-vs-division heuristic on top (still
 * over-read on `w! / 2`, `=> /'/`, `+ /'/`, a deep-indented `/`, a backtick inside `${}`). Every one
 * of those is a private tokenizer being wrong; TypeScript's parser is not a tokenizer this repo
 * maintains.
 *
 * ⚠️ **Deliberately NOT a generic "extent" API.** Each guard asks a different question of its node —
 * is this read's RESULT parsed (dataflow along one binding), does this regex sit in THAT loop's body
 * (scope), does THIS call's own options object say `kind: 'cli'` (argument shape). One text extent
 * for all of them is the window again with better bounds. What this module does is make the node
 * the unit, and give the few walks those questions share one spelling.
 *
 * Comments and Markdown prose have no AST; whitespace-collapsing a matched span is the right tool
 * there, and nothing here applies.
 *
 * The rule, its measured instances and the four ways #1144's own first cut still failed open (the
 * node is not enough — a count, a refusal, a finally and a binding's reads must be the occurrence's
 * too): `docs/verify-and-ci.md` § "Exemption GRAIN".
 */

import ts from 'typescript';

/** The parser mode a file's extension asks for. `.mjs`/`.cjs`/`.js` as JS, so a JS-only construct
 *  is not a diagnostic; `.tsx`/`.jsx` with JSX, so a `<Tag>` is not a type assertion. */
export function scriptKindFor(label: string): ts.ScriptKind {
  if (label.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (label.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(label)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Parse `code` (normally `readScannedSource(abs).code` — comment blanking is length-preserving, so
 * offsets and lines still line up) with parent pointers set.
 *
 * ⚠️ **Throws when it does not parse.** `createSourceFile` never throws on its own: handed garbage,
 * it returns a stump whose walk finds no occurrences, and a forbidden-pattern guard reads "none
 * found" as a pass. `label` names the file in the error.
 */
export function parseSource(code: string, label: string): ts.SourceFile {
  const sf = ts.createSourceFile(label, code, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKindFor(label));
  const parsed = sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
  const diags = parsed.parseDiagnostics ?? [];
  if (diags.length > 0) {
    const d = diags[0];
    const line = d.start === undefined ? '?' : sf.getLineAndCharacterOfPosition(d.start).line + 1;
    throw new Error(`${label}:${line}: did not parse (${ts.flattenDiagnosticMessageText(d.messageText, ' ')}), `
      + 'so no occurrence in it can be located — a guard walking it would report none and pass');
  }
  return sf;
}

/** The name a call is made by: `f(…)` → `f`, `a.b.f(…)` → `f`, `a?.f(…)` → `f`; anything else
 *  (`(g())(…)`, `a[k](…)`) → `undefined`. */
export function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** Every node in `root` (inclusive) that `pick` accepts, in source order. */
export function findNodes<T extends ts.Node>(root: ts.Node, pick: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node): void => {
    if (pick(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

/** Every call in `root` made by one of `names` (see `calleeName`), in source order. */
export function callsTo(root: ts.Node, ...names: string[]): ts.CallExpression[] {
  const wanted = new Set(names);
  return findNodes(root, (n): n is ts.CallExpression => ts.isCallExpression(n) && wanted.has(calleeName(n) ?? ''));
}

/** A node whose VALUE is its operand's value: parentheses, `as`, `satisfies`, `<T>x`, `x!`, `await`. */
function isValueWrapper(n: ts.Node): n is ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression
  | ts.TypeAssertion | ts.NonNullExpression | ts.AwaitExpression {
  return ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)
    || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n) || ts.isAwaitExpression(n);
}

/** `e` with every value wrapper peeled off its OUTSIDE: `(x as T)!` → `x`. */
export function unwrapValue(e: ts.Expression): ts.Expression {
  let cur: ts.Expression = e;
  while (isValueWrapper(cur)) cur = cur.expression;
  return cur;
}

/** The outermost node that still carries `e`'s value — climbing value wrappers UP from `e`. */
export function valueCarrier(e: ts.Expression): ts.Expression {
  let cur: ts.Expression = e;
  while (cur.parent && isValueWrapper(cur.parent)) cur = cur.parent;
  return cur;
}

/** The identifier `e`'s value is bound to by `const x = e` / `let x = e`, or `undefined` when it is
 *  not a plain declaration initialiser (a destructure, an argument, a return, …). */
export function boundIdentifier(e: ts.Expression): ts.Identifier | undefined {
  const carrier = valueCarrier(e);
  const decl = carrier.parent;
  // No `decl.initializer === carrier`: an EXPRESSION's parent declaration can only hold it as the
  // initializer (the name is a binding, the annotation a type). Mutation-checked redundant.
  if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) return decl.name;
  return undefined;
}

/** The function `n` runs in — the nearest function-like ancestor, or the file for top-level code. A
 *  branch inside a nested function that nobody calls is not a branch of the code around it. */
export function enclosingFunction(n: ts.Node): ts.Node {
  let cur: ts.Node | undefined = n.parent;
  while (cur && !ts.isFunctionLike(cur) && !ts.isSourceFile(cur)) cur = cur.parent;
  return cur ?? n.getSourceFile();
}

/** One checker per parsed file, built on demand — only a guard that follows a BINDING pays for it. */
const checkers = new WeakMap<ts.SourceFile, ts.TypeChecker>();

/**
 * A type checker over `sf` ALONE — no lib, no imports resolved — which is all name resolution needs:
 * which declaration an identifier refers to is decided by the file's own scopes. The host hands the
 * program the very `SourceFile` the caller walks, so a node from `sf` resolves in it.
 */
function checkerFor(sf: ts.SourceFile): ts.TypeChecker {
  const cached = checkers.get(sf);
  if (cached) return cached;
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === sf.fileName ? sf : undefined),
    fileExists: (name) => name === sf.fileName,
    readFile: () => undefined,
    writeFile: () => {},
    getDefaultLibFileName: () => 'lib.d.ts',
    getCurrentDirectory: () => '',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram([sf.fileName], { noLib: true, noResolve: true, types: [], allowJs: true }, host);
  // ⚠️ `createProgram` silently DROPS a root whose extension it does not support (`x.txt`, `X.TS`, no
  // extension), and every lookup then resolves to nothing — `readsOf` returns [] and a guard following
  // a binding sees no loops at all. The stump-parse trap `parseSource` refuses, one layer down.
  if (program.getSourceFile(sf.fileName) !== sf) {
    throw new Error(`${sf.fileName}: the checker did not take this file (an extension TypeScript does not `
      + 'compile?), so no name in it can be resolved — a guard following a binding would silently find nothing');
  }
  const checker = program.getTypeChecker();
  checkers.set(sf, checker);
  return checker;
}

/** The symbol an identifier USES — for a `{ x }` shorthand, the variable `x`, not the property. */
function valueSymbolAt(checker: ts.TypeChecker, id: ts.Identifier): ts.Symbol | undefined {
  return ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
    ? checker.getShorthandAssignmentValueSymbol(id.parent)
    : checker.getSymbolAtLocation(id);
}

/** The declaration an identifier resolves to, by the file's own scopes, or `undefined`. */
export function declarationOf(id: ts.Identifier): ts.Declaration | undefined {
  const sym = valueSymbolAt(checkerFor(id.getSourceFile()), id);
  return sym?.valueDeclaration ?? sym?.declarations?.[0];
}

/**
 * The READS of the binding `id` declares: every identifier that RESOLVES to that same declaration,
 * minus the declaration name itself.
 *
 * ⚠️ **By symbol, not by name (#1144 close-out).** The first version matched identifiers spelled
 * like `id` within its declaring scope, and at file top level that scope is the whole file — so a
 * `function parse(raw) { return JSON.parse(raw); }` sixty lines away, whose `raw` is its own
 * PARAMETER, excused a top-level `const raw = readFileSync(…)` that was matched raw. A sibling
 * function is exactly the neighbour this module exists to stop vouching, reached by a different
 * road. The checker resolves shadowing the way the language does.
 */
export function readsOf(id: ts.Identifier): ts.Identifier[] {
  const sf = id.getSourceFile();
  const checker = checkerFor(sf);
  const target = checker.getSymbolAtLocation(id);
  if (!target) return [];
  return findNodes(sf, (n): n is ts.Identifier =>
    ts.isIdentifier(n) && n !== id && n.text === id.text && valueSymbolAt(checker, n) === target);
}

/** A function-like node's body: the `{ … }` block, or a concise arrow's expression. `undefined` for
 *  anything that is not an inline function (a reference, a call, a literal). */
export function functionBodyOf(n: ts.Node | undefined): ts.ConciseBody | undefined {
  if (!n) return undefined;
  const e = ts.isExpression(n) ? unwrapValue(n) : n;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isFunctionDeclaration(e)) return e.body;
  return undefined;
}

/** The text BETWEEN a block's braces — what a hand-balanced brace scan used to return. */
export function blockInnerText(block: ts.Block): string {
  const sf = block.getSourceFile();
  return sf.text.slice(block.getStart(sf) + 1, block.getEnd() - 1);
}

/**
 * Every NAMED function in `root`, in source order: `function f() {…}` declarations, and `const`/`let`
 * bindings whose initialiser is an arrow or function expression. A concise arrow counts — its body
 * is the expression — because `const move = (p) => showLevel(p)` moves just as a block body does.
 */
export function namedFunctions(root: ts.Node): Array<{ name: string; body: ts.ConciseBody }> {
  const out: Array<{ name: string; body: ts.ConciseBody }> = [];
  for (const n of findNodes(root, (x): x is ts.FunctionDeclaration | ts.VariableDeclaration =>
    ts.isFunctionDeclaration(x) || ts.isVariableDeclaration(x))) {
    if (ts.isFunctionDeclaration(n)) {
      if (n.name && n.body) out.push({ name: n.name.text, body: n.body });
      continue;
    }
    const body = ts.isIdentifier(n.name) && n.initializer ? functionBodyOf(n.initializer) : undefined;
    if (body && ts.isIdentifier(n.name)) out.push({ name: n.name.text, body });
  }
  return out;
}

/** A string literal's value (`'a'`, `"a"`, a template with no substitutions), or `undefined`. */
export function stringValueOf(e: ts.Expression | undefined): string | undefined {
  if (!e) return undefined;
  const u = unwrapValue(e);
  return ts.isStringLiteralLike(u) ? u.text : undefined;
}

/**
 * An object literal's OWN top-level keys, as NAMES — `{ a: 1, b, 'c': 2, ['d']: 3, e() {} }` →
 * `['a', 'b', 'c', 'd', 'e']`, a spread as `'...'`, a non-literal computed key as its source text in
 * brackets — or `undefined` when `e` is not an object literal. Nested literals' keys are not its keys.
 */
export function objectLiteralKeys(e: ts.Expression | undefined): string[] | undefined {
  if (!e) return undefined;
  const u = unwrapValue(e);
  if (!ts.isObjectLiteralExpression(u)) return undefined;
  const sf = u.getSourceFile();
  return u.properties.map((p) => {
    if (ts.isSpreadAssignment(p)) return '...';
    const name = p.name;
    if (!name) return '?';
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
    return name.getText(sf);
  });
}

/** True for a `{ … }` block — so a caller holding a `ConciseBody` needs no `typescript` import. */
export function isBlock(n: ts.Node | undefined): n is ts.Block {
  return !!n && ts.isBlock(n);
}

/** The name of every call made anywhere inside `root` (see `calleeName`), in source order. */
export function calledNames(root: ts.Node): string[] {
  return findNodes(root, ts.isCallExpression).map(calleeName).filter((n): n is string => n !== undefined);
}

/** 1-based line of `n`'s first non-trivia character. */
export function lineOf(n: ts.Node): number {
  const sf = n.getSourceFile();
  return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
}
