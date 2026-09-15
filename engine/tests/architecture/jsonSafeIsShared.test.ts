/**
 * `runtime/core/jsonSafe.ts` is the only place that renders an `Error` or a pending thenable for JSON
 * (#1068).
 *
 * The replacer that turns them into text was hand-written three times: the device bridge's
 * `safeStringify`, the console ring's `stringifyArg`, and `journalError`'s Crashlytics text. The
 * copies drifted (only one appended the cause chain, one knew nothing of thenables), and the two
 * EDITOR transports had no copy at all, so an Error in an editor op reply arrived as `{}`. A fourth
 * hand-written copy is the likeliest regression, so this fails at authorship.
 *
 * ── What it detects ─────────────────────────────────────────────────────────────────────────────
 *   - A HAND REPLACER: a `JSON.stringify(…)` call whose arguments hold both an inline function (an
 *     arrow or a `function` expression) and an `x instanceof Error` test, as NODES (#1195), so the first
 *     argument can be anything (an object literal, a spread, a cast, a nested call) and the replacer
 *     any shape (expression- or block-bodied, typed). Pass `jsonSafeReplacer`, or `toJsonSafe` the
 *     value. A regex was tried first and lost to exactly those shapes, twice (close-out review); the
 *     paren-balancing text scan that replaced it could still end a call early on a regex literal or a
 *     backtick nested inside a template's `${…}`.
 *     This deliberately also flags a stringify whose ARGUMENT maps Errors by hand
 *     (`JSON.stringify(list.map((e) => e instanceof Error ? … : e))`): that is rendering Errors for
 *     JSON too.
 *   - A HELPER COPY: a second DECLARATION of the module's own helpers (`isThenable` as a function or a
 *     variable, typed or not; the marker; the cause-chain cap). Import them.
 *
 * ── Blind spots, stated rather than discovered later ────────────────────────────────────────────
 *   - a replacer declared elsewhere and passed by name;
 *   - `JSON.stringify` reached through an alias (`const enc = JSON.stringify`);
 *   - a hand-rolled walk that never calls `JSON.stringify`;
 *   - anything outside SCAN_DIRS (the Node/Electron-main roots, whose bridge replies are already
 *     text by the time they get there).
 *   It FALSE-positives, loudly, on a stringify whose arguments test `instanceof Error` for another
 *   reason (`results.filter((r) => !(r instanceof Error))`, a per-item `failed:` flag). Restructure the
 *   call if one appears; none exists in the tree.
 *
 * A one-off `e instanceof Error ? errorText(e) : String(e)` is NOT a replacer and does not match:
 * rendering one known Error is `errorText`'s job, and `errorTextIsShared.test.ts` polices that.
 * Comments are stripped by the shared reader (`readScannedSource`), because the prose at the migrated
 * sites names the pattern this polices.
 */

import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { accessPath, callsToPath, findNodes, flatText, parseSource, ts } from '@modoki/engine/testing/sourceAst';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const SCAN_DIRS = ['engine/packages/modoki/src', 'engine/app', 'games', 'demos'];
const HOME = 'engine/packages/modoki/src/runtime/core/jsonSafe.ts';

const HELPER_NAMES = ['isThenable', 'PENDING_PROMISE_MARKER', 'CAUSE_CHAIN_DEPTH_CAP'];

/** Every DECLARATION of one of the home module's helpers in `sf` — `function isThenable`, or a variable
 *  named after any of them (typed or not). A reference (`isThenable(v)`, `x ? PENDING_PROMISE_MARKER : y`) or
 *  an import binding is not one. It used to be a regex anchored on `function|const|let|var NAME`. */
function helperCopies(sf: ts.SourceFile): string[] {
  return findNodes(sf, (n): n is ts.FunctionDeclaration | ts.VariableDeclaration =>
    (ts.isFunctionDeclaration(n) && n.name?.text === 'isThenable')
    || (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && HELPER_NAMES.includes(n.name.text)))
    .map((d) => (d.name as ts.Identifier).text);
}

/** Every `JSON.stringify(…)` call in `sf` (nested calls included) whose arguments hold both an inline function
 *  and an `… instanceof Error` test, as flat text. */
function handReplacers(sf: ts.SourceFile): string[] {
  return callsToPath(sf, 'JSON.stringify').filter((call) => call.arguments.some((arg) =>
    findNodes(arg, (n): n is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(n) || ts.isFunctionExpression(n)).length > 0)
    && call.arguments.some((arg) => findNodes(arg, (n): n is ts.BinaryExpression => ts.isBinaryExpression(n)
      && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && accessPath(n.right) === 'Error').length > 0))
    .map(flatText);
}

/** `code` parsed as `label` — only paid for when the raw text could hold what either detector looks for. */
function parsedIfRelevant(code: string, label: string): ts.SourceFile | undefined {
  const could = (code.includes('stringify') && code.includes('instanceof')) || HELPER_NAMES.some((n) => code.includes(n));
  return could ? parseSource(code, label) : undefined;
}

function scannedFiles(): Array<{ rel: string; abs: string }> {
  return repoFiles({
    under: SCAN_DIRS,
    match: (rel) => /\.tsx?$/.test(rel) && !rel.includes('.test.'),
    exclude: ['node_modules', 'dist'],
    floor: 0, // the non-vacuity test below asserts its own floor
  });
}

function offenders(): string[] {
  return scannedFiles()
    .filter(({ rel }) => rel !== HOME)
    .flatMap(({ rel, abs }) => {
      const sf = parsedIfRelevant(readScannedSource(abs).code, rel);
      if (!sf) return [];
      return [
        ...(handReplacers(sf).length ? [`${rel} :: hand-written replacer`] : []),
        ...(helperCopies(sf).length ? [`${rel} :: helper copy`] : []),
      ];
    })
    .sort();
}

describe('jsonSafe is the only JSON rendering of an Error or thenable (#1068)', () => {
  it('the detector matches every shape the migration removed, and every shape a review found missed', () => {
    const replacers = [
      // The three copies the migration removed.
      'JSON.stringify(value, (_k, v) => (\n        isThenable(v) ? PENDING_PROMISE_MARKER\n          : v instanceof Error ? errorText(v)\n            : v));',
      'const json = JSON.stringify(v, (_k, val) => (\n      isThenable(val) ? PENDING_PROMISE_MARKER\n        : val instanceof Error ? errorText(val) + formatCauseChain(val)\n          : val));',
      'const t = ok ? x : JSON.stringify(payload, (_k, v: unknown) => (v instanceof Error ? errorText(v) : v)) ?? String(payload);',
      // Shapes two review rounds found a regex missed.
      'JSON.stringify(v, (_k, val) => { if (isThenable(val)) return M; if (val instanceof Error) return errorText(val); return val; })',
      // Shapes the paren-balancing TEXT scan could end early (#1195): a quote in a regex literal, a backtick inside `${…}`.
      "JSON.stringify(v, (_k, x) => (/'/.test(String(x)) ? 1 : x instanceof Error ? String(x) : x))",
      'JSON.stringify(v, (_k, x) => `${x instanceof Error ? `${x.message}` : x}`)',
      'JSON.stringify(\n  v,\n  function replace(_k, x) { return x instanceof Error ? String(x) : x; },\n)',
      'JSON.stringify(v, function (_k, val) { return val instanceof Error ? String(val) : val; })',
      'JSON.stringify(obj.payload, (k, val) => val instanceof Error ? val.message : val, 2)',
      'JSON.stringify({ ok: false, error }, (_k, v) => v instanceof Error ? errorText(v) : v)',
      'JSON.stringify({ ...payload, at: tick }, (_k, v) => (v instanceof Error ? String(v) : v))',
      'JSON.stringify([a, b], (_k, v) => (v instanceof Error ? String(v) : v))',
      'JSON.stringify(x as Record<string, unknown>, (_k, v) => (v instanceof Error ? String(v) : v))',
      'JSON.stringify(p, (_k: string, v: unknown): unknown => (v instanceof Error ? String(v) : v))',
      'JSON.stringify(p, (k, v = fallback()) => (v instanceof Error ? String(v) : v))',
      'JSON.stringify(f(g(x)), (_k, v) => (v instanceof Error ? String(v) : v))',
      // A `)` inside a string must not close the call early: without literal skipping this is missed.
      "JSON.stringify(v, (_k, x) => x === ')' ? 1 : x instanceof Error ? String(x) : x)",
    ];
    for (const line of replacers) expect(handReplacers(parseSource(line, 'probe.ts')), line).toHaveLength(1);

    const helpers = [
      'const isThenable = (v: unknown) => !!v;',
      'const isThenable: (v: unknown) => boolean = (v) => !!v;',
      'function isThenable(v: unknown): boolean { return !!v; }',
      'export let PENDING_PROMISE_MARKER: string;',
      "const PENDING_PROMISE_MARKER = '[unresolved Promise — did you forget `await`?]';",
      'const CAUSE_CHAIN_DEPTH_CAP = 4;',
    ];
    for (const line of helpers) expect(helperCopies(parseSource(line, 'probe.ts')), line).toHaveLength(1);
  });

  it('the detector does not match the legitimate shapes', () => {
    const legitimate = [
      "return typeof value === 'string' ? value : JSON.stringify(value, jsonSafeReplacer);",
      'const msg = r instanceof Error ? errorText(r) : String(r);',
      // An inline function and an Error test in the same statement, but not in the stringify's own arguments.
      "const s = JSON.stringify(v, (_k, x) => x) + (e instanceof Error ? 'e' : '');",
      // A string holding both is not code.
      "const s = JSON.stringify({ doc: 'function (v) { return v instanceof Error; }' });",
      // One known Error rendered in place, with no replacer function: errorText's job, not this guard's.
      'const s = JSON.stringify({ error: e instanceof Error ? errorText(e) : e });',
      // The `Error` it tests is a different class's.
      'const s = JSON.stringify(v, (_k, x) => (x instanceof MyError ? String(x) : x));',
      'const s = JSON.stringify(payload);\nconst isErr = (e: unknown) => e instanceof Error;',
      "const s = JSON.stringify(a) + list.map((e) => e instanceof Error ? 1 : 0).join(',');",
      "const s = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));\nif (e instanceof Error) report(e);",
      // A `(` inside a string must not hold the call open: without literal skipping this swallows the
      // unrelated check on the next line.
      "const s = JSON.stringify({ note: 'a ( b', f: (x) => x });\nif (e instanceof Error) report(e);",
      "import { PENDING_PROMISE_MARKER, isThenable } from './jsonSafe';",
      'function f(v) { if (isThenable(v)) return PENDING_PROMISE_MARKER; }',
      'class C { isThenable(v) { return !!v; } }',
      'return isThenable(v) ? PENDING_PROMISE_MARKER : String(v);',
      'const depth = deep ? CAUSE_CHAIN_DEPTH_CAP : 1;',
    ];
    for (const line of legitimate) {
      const sf = parseSource(line, 'probe.ts');
      expect([...handReplacers(sf), ...helperCopies(sf)], line).toEqual([]);
    }
  });

  it('parses a file only when its text could hold either shape — including a helper copy in a file with no stringify', () => {
    expect(parsedIfRelevant('const CAUSE_CHAIN_DEPTH_CAP = 4;', 'a.ts')).toBeDefined();
    expect(parsedIfRelevant('JSON.stringify(v, (_k, x) => x instanceof Error ? 1 : x);', 'b.ts')).toBeDefined();
    expect(parsedIfRelevant('JSON.stringify(v);', 'c.ts')).toBeUndefined();
  });

  it('the scanned corpus is non-vacuous, and holds the home module', () => {
    const files = scannedFiles();
    expect(files.length, 'the corpus collapsed; the check below would pass having read nothing')
      .toBeGreaterThan(500);
    const home = files.find((f) => f.rel === HOME);
    expect(home, `${HOME} moved; update HOME or this guard exempts nothing`).toBeDefined();
    expect(helperCopies(parseSource(readScannedSource(home!.abs).code, HOME)).sort(),
      'the home module no longer defines the helpers, so the exemption is exempting nothing').toEqual([...HELPER_NAMES].sort());
  });

  it('no other file hand-writes the replacer or re-defines its helpers', () => {
    expect(offenders(), 'Import from runtime/core/jsonSafe.ts instead: `jsonSafeReplacer` for '
      + '`JSON.stringify`, `toJsonSafe` for a value a transport stringifies, `renderError` for one '
      + 'Error, `isThenable`/`PENDING_PROMISE_MARKER` for the promise case.').toEqual([]);
  });
});
