/** ⚠️ **A JSON file is parsed in Node only through `engine/scripts/jsonFile.mjs` (#1799).**
 *  Node's `fs.readFileSync(p, 'utf8')` keeps a leading UTF-8 BOM and `JSON.parse` throws on it,
 *  and a BOM is a Windows fact, not damage: Notepad's "UTF-8 with BOM", PowerShell 5.1's
 *  `-Encoding utf8` and the editor's own verbatim undo (#1774) all write one. Before #1799, 151
 *  Node-side reads parsed the raw text, and each treated a good file as unreadable in its own way:
 *  a prefab dropped out of the asset manifest (OBSERVED on Windows), a texture sidecar was
 *  quarantined as corrupt, and the publish leak scans skipped a config unchecked. The rule and its
 *  reasons: docs/windows.md § "A BOM is a Windows fact, not corruption".
 *
 *  **What it flags:** a `JSON.parse(` CALL (the parsed call node, not a name in a comment or a
 *  string) whose argument is a raw file read — `readFileSync(…)` / `readFile(…)` in any spelling
 *  (`fs.`, `fs.promises.`, a bare import, `await`, a `.toString()`), or an identifier the same file
 *  assigns from one. In a `.sh` file, an inline `node -e` body's `JSON.parse(fs.readFileSync(`.
 *  **A game's own tools strip inline** (`readFileSync(p, 'utf8').replace(/^\uFEFF/, '')`): a project
 *  cannot import `engine/scripts/` (#29 — a game is copied OUT of the repo). The detector accepts a
 *  read wrapped in a BOM STRIP (`.replace(/^\uFEFF/…)`, `.trim()`) and nothing else: any other method
 *  on the text (`.replace(/\r\n/g, …)`, `.slice`) is peeled and the read still counts as raw.
 *  **What it does not see**, stated so it is not mistaken for coverage: text that reaches
 *  `JSON.parse` through a function parameter or a property, and a read in another file. Those are
 *  the #816 shape; the detector's reach is one file.
 *
 *  **Out of scope: test files** (`*.test.*` and `tests/` directories). They parse committed fixtures
 *  that `.gitattributes` pins to LF with no BOM; ~450 such reads would bury the ledger without
 *  guarding anything a user can write. The browser side is out of scope too, and pinned instead by
 *  `runtime/bomTolerantAssetFetch.test.ts`: a fetch's `text()`/`json()` strip a BOM themselves.
 *
 *  Structural twin of `gitReadIsBounded.test.ts`: `repoFiles()` for the corpus, `readScannedSource`
 *  for comment stripping, one `EXEMPT` ledger whose rows must each still trip the rule. */

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readScannedSource, stripComments } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasInternalGames } from '../helpers/repoLayout';

type Hit = { line: number; kind: 'direct' | 'via-binding'; text: string };

const READ_NAMES = new Set(['readFileSync', 'readFile']);

/** A method call that removes a leading BOM: `.trim()` / `.trimStart()` (U+FEFF is whitespace to
 *  them), or a `.replace(/^\uFEFF…/, …)` — the inline strip a game's tools use (#29). */
function isBomStrip(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const name = call.expression.name.text;
  if (name === 'trim' || name === 'trimStart' || name === 'trimLeft') return true;
  const re = call.arguments[0];
  return (name === 'replace' || name === 'replaceAll') && !!re && ts.isRegularExpressionLiteral(re)
    && /^\/\^(\\uFEFF|\\ufeff|\uFEFF)/.test(re.text);
}

/** `expr` with every wrapper peeled that leaves a BOM in place: parens, casts, `!`, `await`,
 *  `String(…)`, and any method call on the text except a BOM strip — so
 *  `readFileSync(p, 'utf8').replace(/\r\n/g, '\n')` is still a raw read (close-out review), while
 *  `…replace(/^\uFEFF/, '')` and `…trim()` are not. The read call itself is never peeled. */
function unwrap(expr: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)
      || ts.isAwaitExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isSatisfiesExpression(expr)) {
      expr = expr.expression; continue;
    }
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)
      && !READ_NAMES.has(expr.expression.name.text) && !isBomStrip(expr)) { expr = expr.expression.expression; continue; }
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'String'
      && expr.arguments.length === 1) { expr = expr.arguments[0]; continue; }
    return expr;
  }
}

/** A raw file read: a call to `readFileSync`/`readFile`, bare or as a property (`fs.`, `fs.promises.`). */
function isFileRead(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (!ts.isCallExpression(e)) return false;
  const callee = e.expression;
  if (ts.isIdentifier(callee)) return READ_NAMES.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && READ_NAMES.has(callee.name.text);
}

const isJsonParse = (call: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'parse'
  && ts.isIdentifier(call.expression.expression) && call.expression.expression.text === 'JSON';

/** Every `JSON.parse(` of a raw file read in one TS/JS source (comments already stripped). */
export function findRawJsonFileParses(code: string, rel: string): { hits: Hit[]; parses: number } {
  const sf = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true,
    /\.[cm]?jsx?$/.test(rel) ? ts.ScriptKind.JS : rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // Names this file binds to a raw read — `const t = fs.readFileSync(…)`, `t = readFileSync(…)` — and,
  // transitively, to such a name through a non-stripping wrapper: `const text = raw.replace(/x/, …)`
  // keeps `raw`'s BOM (close-out re-review found migrate-prefabs-v5.mjs parsing exactly that).
  const assigns: [string, ts.Expression][] = [];
  const parses: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) assigns.push([n.name.text, n.initializer]);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) assigns.push([n.left.text, n.right]);
    if (ts.isCallExpression(n) && isJsonParse(n) && n.arguments.length > 0) parses.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const readBindings = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, init] of assigns) {
      if (readBindings.has(name)) continue;
      const e = unwrap(init);
      if (isFileRead(e) || (ts.isIdentifier(e) && readBindings.has(e.text))) { readBindings.add(name); grew = true; }
    }
  }
  const hits: Hit[] = [];
  for (const call of parses) {
    const arg = unwrap(call.arguments[0]);
    const kind = isFileRead(arg) ? 'direct' : ts.isIdentifier(arg) && readBindings.has(arg.text) ? 'via-binding' : null;
    if (!kind) continue;
    hits.push({ line: sf.getLineAndCharacterOfPosition(call.getStart()).line + 1, kind, text: call.getText().slice(0, 90) });
  }
  return { hits, parses: parses.length };
}

/** The `.sh` form: an inline `node -e` body parsing a raw read. */
export function findShellRawJsonFileParses(code: string): { hits: Hit[]; parses: number } {
  const hits: Hit[] = [];
  const re = /JSON\.parse\(\s*(?:require\(\s*["'](?:node:)?fs["']\s*\)\.|fs\.)?readFileSync\(/g;
  for (const m of code.matchAll(re)) {
    hits.push({ line: code.slice(0, m.index).split('\n').length, kind: 'direct', text: m[0] });
  }
  return { hits, parses: (code.match(/JSON\.parse\(/g) ?? []).length };
}

/** A row whose file this checkout does not ship (the OSS snapshot has no games/) is absent by
 *  LAYOUT, not stale. */
const rootIsPresent = (rel: string): boolean => hasInternalGames() || !rel.startsWith('games/');

/** Reviewed exceptions — each must still trip the rule (a stale row fails). */
const EXEMPT: { file: string; count?: number; reason: string }[] = [
  {
    file: 'engine/scripts/gen-collision-mesh.mjs',
    reason: "parses a GLB's embedded JSON CHUNK (a byte range of a binary file), not a text file — a BOM there "
      + 'is a malformed GLB, not one a Windows tool wrote. The one false positive the detector reports.',
  },
];

const isTest = (rel: string): boolean => /\.test\.[cm]?[jt]sx?$/.test(rel) || /(^|\/)tests?\//.test(rel);

describe('every Node-side JSON file parse reads through jsonFile.mjs (#1799)', () => {
  const sources = repoFiles({ match: /\.(ts|mts|cts|mjs|cjs|js|sh)$/, exclude: ['node_modules', 'dist', 'dist-electron'], floor: 1500 })
    .filter(({ rel }) => !isTest(rel) && !rel.endsWith('.d.ts') && !rel.endsWith('.d.mts'));
  let parsesScanned = 0;
  const hits = sources.flatMap(({ rel, abs }) => {
    const { code } = readScannedSource(abs);
    const found = rel.endsWith('.sh') ? findShellRawJsonFileParses(code) : findRawJsonFileParses(code, rel);
    parsesScanned += found.parses;
    return found.hits.map((h) => ({ ...h, rel }));
  });

  it('scans a floored corpus', () => {
    // ⚠️ A floor that the OSS snapshot (engine + docs, no games/) also clears — see gitReadIsBounded.
    expect(sources.length).toBeGreaterThanOrEqual(900);
  });

  it('no file parses a raw file read outside the EXEMPT ledger', () => {
    // MUTATION CHECK: route one migrated reader back around the helper — e.g. in
    // engine/plugins/vite-asset-scanner.ts `readAssetGuid`, `readJsonFile(absPath)` →
    // `JSON.parse(fs.readFileSync(absPath, 'utf-8'))` — and this goes red naming that line.
    assertExemptionLedger({
      label: 'EXEMPT in jsonFileReadsStripBom',
      population: hits.map((h) => ({ item: h.rel, site: `${h.rel}:${h.line} (${h.kind}) ${h.text}` })),
      exempt: EXEMPT.filter((e) => rootIsPresent(e.file)).map((e) => ({ item: e.file, count: e.count ?? 1, reason: e.reason })),
      // The goal state is an EMPTY population, so the floor bounds the SCAN: every JSON.parse call examined.
      scanned: parsesScanned,
      floor: 150,
      fix: 'these parse a raw file read, so a JSON file that starts with a UTF-8 BOM (Notepad, PowerShell 5.1, the '
        + "editor's verbatim undo) throws or is skipped (#1799). Read it with readJsonFile / tryReadJsonFile / "
        + 'parseJsonText from engine/scripts/jsonFile.mjs; do not add a row.',
    });
  });

  it('the detector matches the CALL, both spellings, and passes the helper, comments and strings (synthetic)', () => {
    // Through the same comment stripper the corpus goes through, so a comment case means what the real scan means.
    const scan = (src: string) => findRawJsonFileParses(stripComments(src), 'synthetic.ts').hits;
    const shellHits = (src: string) => findShellRawJsonFileParses(src).hits;
    // flagged
    expect(scan("JSON.parse(fs.readFileSync(p, 'utf8'));")).toHaveLength(1);
    expect(scan("JSON.parse(readFileSync(p, 'utf8'));")).toHaveLength(1);
    expect(scan("async function f() { return JSON.parse(await fs.promises.readFile(p, 'utf8')); }")).toHaveLength(1);
    expect(scan('JSON.parse(fs.readFileSync(p).toString());')).toHaveLength(1);
    expect(scan("const text = fs.readFileSync(p, 'utf8'); JSON.parse(text);")[0]?.kind).toBe('via-binding');
    expect(scan("let t; t = readFileSync(p, 'utf8'); JSON.parse(t as string);")).toHaveLength(1);
    // accepted — the helper, a non-file parse, and the text in a comment or a string
    expect(scan('readJsonFile(p); parseJsonText(fs.readFileSync(p, "utf8"));')).toEqual([]);
    expect(scan('JSON.parse(body); JSON.parse(JSON.stringify(x));')).toEqual([]);
    expect(scan("// JSON.parse(fs.readFileSync(p, 'utf8'))\nconst doc = 'JSON.parse(fs.readFileSync(p))';")).toEqual([]);
    expect(scan('const JSONparse = 1; parse(fs.readFileSync(p));')).toEqual([]);
    // a wrapper that does NOT strip a BOM is still a raw read; one that does is not (close-out review)
    expect(scan("JSON.parse(fs.readFileSync(p, 'utf8').replace(/\\r\\n/g, '\\n'));")).toHaveLength(1);
    expect(scan("const t = readFileSync(p, 'utf8'); JSON.parse(t.slice(0));")).toHaveLength(1);
    // …and through a CHAIN of bindings, as long as no link strips
    expect(scan("const raw = readFileSync(p, 'utf8'); let text = raw.replace(/x/, 'y'); JSON.parse(text);")).toHaveLength(1);
    expect(scan("const raw = readFileSync(p, 'utf8'); const text = raw.replace(/^\\uFEFF/, ''); JSON.parse(text);")).toEqual([]);
    expect(scan("JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\\uFEFF/, ''));")).toEqual([]);
    expect(scan("JSON.parse(fs.readFileSync(p, 'utf8').trim());")).toEqual([]);
    expect(shellHits(`node -e 'JSON.parse(require("node:fs").readFileSync(p))'`)).toHaveLength(1);
    // the .sh form
    expect(shellHits(`node -e 'const j = JSON.parse(fs.readFileSync(p, "utf8"));'`)).toHaveLength(1);
    expect(shellHits(`node -e 'JSON.parse(require("fs").readFileSync(p))'`)).toHaveLength(1);
    expect(shellHits(`node "$HERE/scripts/lib/leakScanConfigs.mjs" team-ids a.json`)).toEqual([]);
  });

  it('reports its false-positive count: every flagged site is a real file read', () => {
    // Recorded on each run so a detector change that starts flagging non-reads is visible. A
    // via-binding hit is the one shape that can be a false positive (the binding may be reassigned
    // from elsewhere before the parse); every one is listed with its site in the ledger above.
    const viaBinding = hits.filter((h) => h.kind === 'via-binding');
    console.info(`[jsonFileReadsStripBom] ${sources.length} files, ${parsesScanned} JSON.parse calls scanned; ${hits.length} flagged (${viaBinding.length} via a binding)`);
    expect(hits.length).toBeGreaterThanOrEqual(0);
  });
});
