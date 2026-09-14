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

/** Re-exported so a project's own tests (`games/<id>/tests`) can write a per-guard walk without
 *  importing `typescript` by name — a game reaches the engine only through `@modoki/engine`. (The
 *  module itself still has to resolve: it is a devDependency of the package, so a game copied OUT of
 *  the monorepo needs `typescript` installed to run these tests at all.) */
export { ts };

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

/**
 * The dotted name an expression reads, however it is formatted (#1179): `performance\n  .now` →
 * `'performance.now'`, `(mesh.material as Material)` → `'mesh.material'`, `a?.b!` → `'a.b'`,
 * `o['k']` → `'o.k'`, `process.argv[1]` → `'process.argv[1]'`, `import.meta.url` → `'import.meta.url'`,
 * `this.x` → `'this.x'`. `undefined` when any link is not a name — a call (`f().x`), a computed key
 * (`o[k]`), a literal — because such a chain has no spelling a guard could have meant.
 */
export function accessPath(e: ts.Expression): string | undefined {
  const p = chainPath(e);
  return p === undefined || p.includes(UNNAMED) ? undefined : p;
}

/** Stands in for a link with no name (`f()`, `o[k]`) inside `chainPath`. Not a legal identifier, so
 *  no wanted path can contain it. */
const UNNAMED = '<?>';

/** `accessPath`, except an unnamed link survives as `UNNAMED` — so `f().getPath` is `'<?>.getPath'`,
 *  which a SUFFIX match on `getPath` still finds, and `accessPath` refuses. */
function chainPath(e: ts.Expression): string | undefined {
  const u = unwrapValue(e);
  if (ts.isIdentifier(u)) return u.text;
  if (u.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isMetaProperty(u)) return `${ts.tokenToString(u.keywordToken)}.${u.name.text}`;
  if (ts.isPropertyAccessExpression(u)) {
    if (!ts.isIdentifier(u.name)) return undefined; // `#private`
    return `${chainPath(u.expression) ?? UNNAMED}.${u.name.text}`;
  }
  if (ts.isElementAccessExpression(u)) {
    const base = chainPath(u.expression) ?? UNNAMED;
    const k = unwrapValue(u.argumentExpression);
    if (ts.isStringLiteralLike(k)) return `${base}.${k.text}`;
    if (ts.isNumericLiteral(k)) return `${base}[${k.text}]`;
  }
  return undefined;
}

/** `path` names one of `wanted` — equal to it, or ending in it on a segment boundary, the way the
 *  `\bperformance\.now` regexes these replace matched: `globalThis.performance.now` names
 *  `performance.now`; `myperformance.now` does not. */
function pathNames(path: string | undefined, wanted: readonly string[]): string | undefined {
  if (path === undefined) return undefined;
  return wanted.find((w) => path === w || path.endsWith(`.${w}`));
}

/** True when `id` sits in a NAME position rather than reading a value: a declaration's own name, a
 *  property access's member name, an import/export clause, a type. A `{ x }` shorthand is a read. */
function isNamePosition(id: ts.Identifier): boolean {
  const p: ts.Node = id.parent;
  const named = p as ts.Node & { name?: ts.Node; propertyName?: ts.Node };
  if (ts.isShorthandPropertyAssignment(p)) return false;
  // `newGuid<string>` (an instantiation expression) and a CLASS's `extends X` both evaluate their
  // operand at runtime; only `implements X` and an interface's `extends X` are pure types.
  if (ts.isExpressionWithTypeArguments(p) && !(ts.isHeritageClause(p.parent)
    && (p.parent.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(p.parent.parent)))) return false;
  // `name`/`propertyName` covers every declaration, `import x`/`import * as x`/`import x =`, and a
  // member name; the rest are positions that are types or jump targets.
  if (named.name === id || named.propertyName === id) return true;
  return ts.isQualifiedName(p) || ts.isTypeNode(p) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p);
}

/**
 * Every place in `root` that READS one of `paths` (see `accessPath` for the spelling and the suffix
 * rule), in source order — called or not. A call is the common case, but `mint = newGuid` and
 * `const now = performance.now.bind(performance)` hand the same function on to be called later, and
 * a `\bnewGuid\s*\(` line match never saw either. So does `const { now } = performance`, which is
 * returned as its binding element.
 *
 * Only the outermost node of a chain counts (`a.b.c` is one read of `a.b.c`, not also of `a.b`),
 * and a declaration's own name is not a read of it (`function newGuid()`).
 *
 * ⚠️ **Not reached, and not claimed** (probed in the #1179 P1 review; none occurs in the tree, and the
 * per-line regexes this replaces missed them too): an ALIAS (`const p = performance; p.now()` — that
 * is dataflow, see `readsOf`); a destructure from anything but a named chain (`= await import(…)`,
 * `= a ?? b`), in an assignment (`({ now } = performance)`) or a parameter default; a nested pattern.
 */
export function referencesToPath(root: ts.Node, ...paths: string[]): Array<ts.Expression | ts.BindingElement> {
  const out: Array<ts.Expression | ts.BindingElement> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const inner = n.parent && (ts.isPropertyAccessExpression(n.parent) || ts.isElementAccessExpression(n.parent))
        && n.parent.expression === n;
      const named = ts.isIdentifier(n) && isNamePosition(n);
      // A link inside a longer matching chain is not a read of its own; a chain whose longer form
      // does NOT match (`performance.now.bind`) still reads `performance.now` here.
      const outerMatches = inner && pathNames(chainPath(n.parent as ts.Expression), paths) !== undefined;
      if (!named && !outerMatches && pathNames(chainPath(n), paths) !== undefined) {
        out.push(n);
      }
    }
    if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && ts.isVariableDeclaration(n.parent.parent)
      && n.parent.parent.initializer && !n.dotDotDotToken) {
      const base = chainPath(n.parent.parent.initializer);
      const key = n.propertyName ?? n.name;
      if (base !== undefined && ts.isIdentifier(key) && pathNames(`${base}.${key.text}`, paths) !== undefined) out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

/** The call `ref` is the callee of — `performance\n  .now()`, `(a as B).f?.()` — or `undefined`
 *  when the read is not called on the spot. */
export function callOf(ref: ts.Node): ts.CallExpression | undefined {
  if (!ts.isExpression(ref)) return undefined;
  const carrier = valueCarrier(ref);
  const p = carrier.parent;
  return p && ts.isCallExpression(p) && p.expression === carrier ? p : undefined;
}

/** Every CALL in `root` whose callee reads one of `paths` — `referencesToPath` filtered to the
 *  reads that are called on the spot. */
export function callsToPath(root: ts.Node, ...paths: string[]): ts.CallExpression[] {
  return referencesToPath(root, ...paths).map(callOf).filter((c): c is ts.CallExpression => c !== undefined);
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

/** The symbol an identifier USES — for a `{ x }` shorthand, the variable `x`, not the property; for
 *  `export { x }` / `export { x as y }`, the local `x`, not the export alias (#1179). */
function valueSymbolAt(checker: ts.TypeChecker, id: ts.Identifier): ts.Symbol | undefined {
  const p = id.parent;
  if (ts.isShorthandPropertyAssignment(p) && p.name === id) return checker.getShorthandAssignmentValueSymbol(p);
  // Only the un-aliased `export { x }` needs this: in `export { x as y }` the checker already resolves
  // `x` to the local, and an `export { x } from './m'` target resolves to nothing under `noResolve`,
  // so it can never equal a binding of this file. Both mutation-checked redundant.
  if (ts.isExportSpecifier(p) && p.name === id) {
    return checker.getExportSpecifierLocalTargetSymbol(p);
  }
  return checker.getSymbolAtLocation(id);
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

/** The statement `n` belongs to: the nearest ancestor-or-self whose parent holds statements (a
 *  block, a file, a module block, a `case`). For code at the top of a concise arrow body, that is
 *  whatever statement the arrow itself sits in. */
export function statementOf(n: ts.Node): ts.Node {
  let cur = n;
  while (cur.parent && !(ts.isBlock(cur.parent) || ts.isSourceFile(cur.parent) || ts.isModuleBlock(cur.parent)
    || ts.isCaseClause(cur.parent) || ts.isDefaultClause(cur.parent) || ts.isClassLike(cur.parent))) cur = cur.parent;
  return cur; // a class MEMBER is its own unit — never the whole class
}

/**
 * The nearest NAMED function `n` runs in, climbing past anonymous callbacks: a function or method
 * declaration, an accessor, or an arrow/function expression bound by `const x =`, `x: …` in an object
 * literal, or a class field. `undefined` when NO named function encloses it — module scope, but also
 * code whose only enclosing functions are unnamed: an IIFE, `export default function () {}`, a
 * computed method name, an arrow assigned with `x = () => …` or wrapped in a ternary or cast, a class
 * static block. A key built on it alone lumps all of those together.
 *
 * For a ledger KEY, pair it with the statement: a statement's text alone (`return base ??
 * app.getPath('userData');`) matches that same statement in ANY function, so a pardon written for one
 * accessor silently moves to a copy of its body elsewhere (#1179 P1 review).
 */
export function enclosingNamedFunction(n: ts.Node): { name: string; node: ts.Node } | undefined {
  for (let cur = n.parent; cur; cur = cur.parent) {
    if (!ts.isFunctionLike(cur)) continue;
    if (ts.isConstructorDeclaration(cur)) return { name: 'constructor', node: cur };
    const own =(cur as ts.Node & { name?: ts.Node }).name;
    if (own && (ts.isIdentifier(own) || ts.isStringLiteral(own) || ts.isPrivateIdentifier(own))) return { name: own.text, node: cur };
    const holder = cur.parent;
    const bound = holder && (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder))
      && holder.initializer === cur ? holder.name : undefined;
    if (bound && (ts.isIdentifier(bound) || ts.isStringLiteral(bound) || ts.isPrivateIdentifier(bound))) return { name: bound.text, node: cur };
  }
  return undefined;
}

/** `n`'s source text with every whitespace run collapsed to one space — for a ledger KEY or a
 *  message, where a formatter's wrap must not change the name. Never for classifying: that is
 *  what the node is for. Comments inside `n` stay as the source has them (blank them first with
 *  `readScannedSource`). */
export function flatText(n: ts.Node): string {
  return n.getText(n.getSourceFile()).replace(/\s+/g, ' ').trim();
}

/**
 * The smallest readable unit naming WHERE `n` sits, as flat text — for a ledger key or a message. Its
 * statement (`flatText(statementOf(n))`), narrowed in the two places a statement is too big to be a key:
 *
 * - inside an OBJECT LITERAL, the innermost member holding `n` — `cellCenters` for the shorthand in a
 *   700-line `export const __testing = { … }`, not the whole export;
 * - in the HEAD of a compound statement, the head alone — `for (const c of cellCenters.values())`,
 *   `if (ready(cellCenters))`, not the loop or branch body. In a body that is not a block
 *   (`for (…) x = f(n)`), the body statement, narrowed the same way.
 *
 * A key is still paired with its function (see `enclosingNamedFunction`): a member or a head alone
 * matches the same text anywhere else.
 */
export function siteText(n: ts.Node): string {
  const sf = n.getSourceFile();
  let stmt = statementOf(n);
  for (;;) {
    for (let cur: ts.Node = n; cur !== stmt; cur = cur.parent) {
      if (ts.isObjectLiteralElementLike(cur)) return flatText(cur);
    }
    const bodies = compoundBodies(stmt);
    const body = bodies.find((b) => b.getStart(sf) <= n.getStart(sf) && n.end <= b.end);
    if (body) { stmt = body; continue; }
    const head = bodies[0] ?? (ts.isSwitchStatement(stmt) ? stmt.caseBlock : undefined);
    if (!head) return flatText(stmt);
    return sf.text.slice(stmt.getStart(sf), head.getStart(sf)).replace(/\s+/g, ' ').trim();
  }
}

/** The statements a compound statement runs, in source order — empty for a simple one (and for a
 *  `switch`, whose clauses `statementOf` already stops at). */
function compoundBodies(s: ts.Node): ts.Statement[] {
  if (ts.isIfStatement(s)) return s.elseStatement ? [s.thenStatement, s.elseStatement] : [s.thenStatement];
  if (ts.isForStatement(s) || ts.isForInStatement(s) || ts.isForOfStatement(s) || ts.isWhileStatement(s)
    || ts.isLabeledStatement(s)) return [s.statement];
  return [];
}

/** 1-based line of `n`'s first non-trivia character. */
export function lineOf(n: ts.Node): number {
  const sf = n.getSourceFile();
  return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
}

const printer = ts.createPrinter({ removeComments: true });

/** `n` as the TypeScript printer spells it, whitespace collapsed — for COMPARING code written in two
 *  places (a gate mirrored across files, a pinned expression), where a formatter's wrap must not make
 *  equal code differ. `flatText` keeps the source's spacing inside a wrap (`( a || b`); this does
 *  not. Parentheses the source wrote stay: they are nodes, not formatting. */
export function printedText(n: ts.Node): string {
  return printer.printNode(ts.EmitHint.Unspecified, n, n.getSourceFile()).replace(/\s+/g, ' ').trim();
}

/** The statement list `p` holds, when it holds one. */
function statementListOf(p: ts.Node): readonly ts.Node[] | undefined {
  if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) return p.statements;
  return undefined;
}

/** A statement that leaves the enclosing list on EVERY path: `return`, `throw`, `continue`, `break`,
 *  a block holding one at its top level, or an `if` both of whose branches do. Syntactic only — a
 *  call that always throws, or `process.exit()`, is not known to exit. */
function alwaysExits(s: ts.Statement): boolean {
  if (ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isContinueStatement(s) || ts.isBreakStatement(s)) return true;
  if (ts.isBlock(s)) return s.statements.some(alwaysExits);
  if (ts.isIfStatement(s)) return !!s.elseStatement && alwaysExits(s.thenStatement) && alwaysExits(s.elseStatement);
  return false;
}

/** One condition code runs under: `test` held (`holds: true`) or had failed (`holds: false`) whenever
 *  it executes. `by` is the node that imposes it — the `if`, the `? :`, the `&&`/`||`, or the
 *  early-exit `if` above. */
export interface Guard { test: ts.Expression; holds: boolean; by: ts.Node }

/**
 * Every condition `n` runs under, innermost first — what a gate check reads instead of "the nearest
 * `if (` line above", which vouches for an occurrence that sits AFTER that `if`'s block, or inside a
 * nested one (#1179):
 * - the THEN (holds) or ELSE (failed) branch of an `if`, and the two arms of a `? :`;
 * - the right operand of `a && n` (holds) or `a || n` (failed);
 * - an EARLIER statement of an enclosing list that is `if (T) <always exits>` with no `else` — `T`
 *   failed, or control would not have reached `n` (an early `return`, `throw`, `continue`, `break`).
 *
 * ⚠️ **It climbs THROUGH functions.** A gate dominating where a closure is CREATED dominates what the
 * closure does, which is the question a build's dead-code elimination asks (`textureResolver`'s probe
 * factory is an arrow built below its `if (!__MODOKI_MODULE_RENDER3D__) return`). A function
 * DECLARATION is hoisted to the top of its OWN statement list, so code above an early exit in that list
 * can call it: the early exits before a declaration are not its guards. The branches ENCLOSING that list
 * still are — in a module a block-level declaration is scoped to its block (#1179 P3 re-review: stopping
 * at the declaration instead dropped a real enclosing `if` and let a nested gate pass as the only one).
 *
 * Not a guard: a loop condition, a `switch` case, a `try`, `??`, and an exit that is not syntactically
 * certain (see `alwaysExits`).
 */
export function guardsOf(n: ts.Node): Guard[] {
  const out: Guard[] = [];
  for (let cur: ts.Node = n, p = n.parent; p; cur = p, p = p.parent) {
    if (ts.isIfStatement(p)) {
      if (cur !== p.expression) out.push({ test: p.expression, holds: cur === p.thenStatement, by: p });
    } else if (ts.isConditionalExpression(p)) {
      if (cur === p.whenTrue || cur === p.whenFalse) out.push({ test: p.condition, holds: cur === p.whenTrue, by: p });
    } else if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (cur === p.right && (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken)) {
        out.push({ test: p.left, holds: op === ts.SyntaxKind.AmpersandAmpersandToken, by: p });
      }
    } else {
      const list = statementListOf(p);
      if (!list || ts.isFunctionDeclaration(cur)) continue;
      for (let j = list.indexOf(cur) - 1; j >= 0; j -= 1) {
        const s = list[j];
        if (ts.isIfStatement(s) && !s.elseStatement && alwaysExits(s.thenStatement)) out.push({ test: s.expression, holds: false, by: s });
      }
    }
  }
  return out;
}

/** Whether `guard` proves `isAtom` TRUE where it applies: the atom itself held, `!atom` failed, either
 *  side of a held `&&`, either side of a failed `||` (parentheses and casts peeled). Anything it cannot
 *  decide — `a ? b : c`, `a === true`, a variable holding the test — proves nothing.
 *
 *  `value: false` asks the mirror question — the atom is proven FALSE: `if (refused()) return;` above,
 *  or `if (!refused()) { … }` around. Not `!guardProves(…)`: "not proven true" is not "proven false". */
export function guardProves(guard: Guard, isAtom: (e: ts.Expression) => boolean, value = true): boolean {
  const proves = (test: ts.Expression, holds: boolean): boolean => {
    const e = unwrapValue(test);
    if (isAtom(e)) return holds === value;
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return proves(e.operand, !holds);
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken && holds) return proves(e.left, true) || proves(e.right, true);
      if (op === ts.SyntaxKind.BarBarToken && !holds) return proves(e.left, false) || proves(e.right, false);
    }
    return false;
  };
  return proves(guard.test, guard.holds);
}

/**
 * The statements that have already run whenever `n`'s own statement runs, nearest first: its earlier
 * siblings, then the earlier siblings of each statement enclosing it, up to the enclosing FUNCTION's
 * body (a function's caller decides what ran before it). A statement nested inside an earlier branch,
 * loop or `try` is not listed — only the enclosing lists' own entries are, which is what makes "the
 * pre-flight ran before the delete" a claim about THIS delete rather than about a line nearby.
 *
 * (An earlier sibling can still have exited, and then `n` never runs — `guardsOf` reads those.)
 */
export function precedingStatements(n: ts.Node): ts.Statement[] {
  const out: ts.Statement[] = [];
  for (let cur: ts.Node = n, p = n.parent; p && !ts.isFunctionLike(p); cur = p, p = p.parent) {
    const list = statementListOf(p);
    if (!list) continue;
    for (let j = list.indexOf(cur) - 1; j >= 0; j -= 1) out.push(list[j] as ts.Statement);
  }
  return out;
}

/** One module edge a file writes — see `importsIn`. */
export interface ModuleEdge {
  /** The specifier as written: `'./a'`, `'three/webgpu'`. */
  spec: string;
  /** `import … from` / `import 'x'` / `import x = require('x')` · `export … from` · `import('x')`. */
  kind: 'import' | 'reexport' | 'dynamic';
  /** Erased from the emitted JavaScript: `import type`, `export type … from`, `import type x = require()`.
   *  NOT an import whose every specifier is `type`-marked — under `verbatimModuleSyntax` (this repo) that
   *  still emits `import {} from 'x'`, which runs the module. */
  typeOnly: boolean;
  /** What it binds, by the name the MODULE exports (`imported`) and the name this file uses (`local`):
   *  `{ a as b }` → `a`/`b`; a default import → `default`; `* as ns` → `*`; `import x = require()` → `*`.
   *  Empty for a side-effect import, `export * from`, and `import()` (whose result is the whole module). */
  bindings: Array<{ imported: string; local: string }>;
  node: ts.Node;
}

/**
 * Every module edge in `sf`, in source order — static imports, re-exports and literal `import('…')`
 * calls — read from the declarations themselves (#1179).
 *
 * It replaces a statement joiner that took an `import` at COLUMN 0 and appended lines until one matched
 * `from '…'`, then regexed that text. It never saw an `export … from '…'` edge (a barrel's whole reason
 * to exist), an `import` that does not start its line, or `import()` of a template literal; and it read
 * dynamic imports out of RAW text, comments and strings included. `typeof import('x')` is a type node,
 * not a call, and is not an edge; an `import()` whose specifier is not a literal names no module and is
 * skipped.
 */
export function importsIn(sf: ts.SourceFile): ModuleEdge[] {
  const out: ModuleEdge[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)) {
      const clause = n.importClause;
      const bindings: ModuleEdge['bindings'] = [];
      if (clause?.name) bindings.push({ imported: 'default', local: clause.name.text });
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) bindings.push({ imported: '*', local: named.name.text });
      if (named && ts.isNamedImports(named)) {
        for (const e of named.elements) bindings.push({ imported: (e.propertyName ?? e.name).text, local: e.name.text });
      }
      out.push({ spec: n.moduleSpecifier.text, kind: 'import', typeOnly: !!clause?.isTypeOnly, bindings, node: n });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)
      && ts.isStringLiteralLike(n.moduleReference.expression)) {
      out.push({ spec: n.moduleReference.expression.text, kind: 'import', typeOnly: n.isTypeOnly, bindings: [{ imported: '*', local: n.name.text }], node: n });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) {
      const clause = n.exportClause;
      const bindings: ModuleEdge['bindings'] = [];
      if (clause && ts.isNamespaceExport(clause)) bindings.push({ imported: '*', local: clause.name.text });
      if (clause && ts.isNamedExports(clause)) {
        for (const e of clause.elements) bindings.push({ imported: (e.propertyName ?? e.name).text, local: e.name.text });
      }
      out.push({ spec: n.moduleSpecifier.text, kind: 'reexport', typeOnly: n.isTypeOnly, bindings, node: n });
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) ? n.arguments[0].text : undefined;
      if (spec !== undefined) out.push({ spec, kind: 'dynamic', typeOnly: false, bindings: [], node: n });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
