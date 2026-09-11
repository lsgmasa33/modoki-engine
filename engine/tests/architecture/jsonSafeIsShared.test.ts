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
 *   - A HAND REPLACER: a `JSON.stringify(…)` call whose argument text holds both an inline function
 *     (`=>` or `function`) and `instanceof Error`. The call is cut out with a paren-balancing scan
 *     that skips string and template literals, so the first argument can be anything (an object
 *     literal, a spread, a cast, a nested call) and the replacer any shape (expression- or
 *     block-bodied, typed, a `function` expression). Pass `jsonSafeReplacer`, or `toJsonSafe` the
 *     value. A regex was tried first and lost to exactly those shapes, twice (close-out review).
 *     This deliberately also flags a stringify whose ARGUMENT maps Errors by hand
 *     (`JSON.stringify(list.map((e) => e instanceof Error ? … : e))`): that is rendering Errors for
 *     JSON too.
 *   - A HELPER COPY: a second definition of the module's own helpers (`isThenable` as a function or a
 *     const, typed or not; the marker; the cause-chain cap). Import them.
 *
 * ── Blind spots, stated rather than discovered later ────────────────────────────────────────────
 *   - a replacer declared elsewhere and passed by name;
 *   - `JSON.stringify` reached through an alias (`const enc = JSON.stringify`);
 *   - a hand-rolled walk that never calls `JSON.stringify`;
 *   - a regex literal containing a quote, or a backtick nested inside a template's `${…}`, inside the
 *     call: the literal-skipping scan can then end the call early or late;
 *   - anything outside SCAN_DIRS (the Node/Electron-main roots, whose bridge replies are already
 *     text by the time they get there).
 *   It FALSE-positives, loudly, on a stringify whose arguments test `instanceof Error` for another
 *   reason (`results.filter((r) => !(r instanceof Error))`, a per-item `failed:` flag) or hold the word
 *   `function` in a string literal. Restructure the call if one appears; none exists in the tree.
 *
 * A one-off `e instanceof Error ? errorText(e) : String(e)` is NOT a replacer and does not match:
 * rendering one known Error is `errorText`'s job, and `errorTextIsShared.test.ts` polices that.
 * Comments are stripped by the shared reader (`readScannedSource`), because the prose at the migrated
 * sites names the pattern this polices.
 */

import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const SCAN_DIRS = ['engine/packages/modoki/src', 'engine/app', 'games', 'demos'];
const HOME = 'engine/packages/modoki/src/runtime/core/jsonSafe.ts';

// Anchored on a DECLARATION: a bare `NAME\s*[:=]` also matched the `:` of `? PENDING_PROMISE_MARKER : x`.
const HELPER_COPY = /function\s+isThenable\b|(?:const|let|var)\s+(?:isThenable|PENDING_PROMISE_MARKER|CAUSE_CHAIN_DEPTH_CAP)\s*[:=]/;

/** The argument text of every `JSON.stringify(…)` call in `code`, nested calls included. */
function stringifyCallArgs(code: string): string[] {
  const out: string[] = [];
  const start = /JSON\.stringify\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = start.exec(code)) !== null) {
    const from = m.index + m[0].length;
    let i = from;
    let depth = 1;
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (c === '"' || c === "'" || c === '`') {
        i++;
        while (i < code.length && code[i] !== c) i += code[i] === '\\' ? 2 : 1;
      } else if (c === '(') {
        depth++;
      } else if (c === ')') {
        depth--;
      }
      i++;
    }
    out.push(code.slice(from, i - 1));
  }
  return out;
}

function hasHandReplacer(code: string): boolean {
  return stringifyCallArgs(code).some((args) => /=>|\bfunction\b/.test(args) && /\binstanceof\s+Error\b/.test(args));
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
      const { code } = readScannedSource(abs);
      return [
        ...(hasHandReplacer(code) ? [`${rel} :: hand-written replacer`] : []),
        ...(HELPER_COPY.test(code) ? [`${rel} :: helper copy`] : []),
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
      ': JSON.stringify(payload, (_k, v: unknown) => (v instanceof Error ? errorText(v) : v)) ?? String(payload);',
      // Shapes two review rounds found a regex missed.
      'JSON.stringify(v, (_k, val) => { if (isThenable(val)) return M; if (val instanceof Error) return errorText(val); return val; })',
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
    for (const line of replacers) expect(hasHandReplacer(line), line).toBe(true);

    const helpers = [
      'const isThenable = (v: unknown) => !!v;',
      'const isThenable: (v: unknown) => boolean = (v) => !!v;',
      'function isThenable(v: unknown): boolean {',
      "const PENDING_PROMISE_MARKER = '[unresolved Promise — did you forget `await`?]';",
      'const CAUSE_CHAIN_DEPTH_CAP = 4;',
    ];
    for (const line of helpers) expect(HELPER_COPY.test(line), line).toBe(true);
  });

  it('the detector does not match the legitimate shapes', () => {
    const legitimate = [
      "return typeof value === 'string' ? value : JSON.stringify(value, jsonSafeReplacer);",
      'const msg = r instanceof Error ? errorText(r) : String(r);',
      'const s = JSON.stringify(payload);\nconst isErr = (e: unknown) => e instanceof Error;',
      "const s = JSON.stringify(a) + list.map((e) => e instanceof Error ? 1 : 0).join(',');",
      "const s = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));\nif (e instanceof Error) report(e);",
      // A `(` inside a string must not hold the call open: without literal skipping this swallows the
      // unrelated check on the next line.
      "const s = JSON.stringify({ note: 'a ( b', f: (x) => x });\nif (e instanceof Error) report(e);",
      "import { PENDING_PROMISE_MARKER, isThenable } from './jsonSafe';",
      'if (isThenable(v)) return PENDING_PROMISE_MARKER;',
      'return isThenable(v) ? PENDING_PROMISE_MARKER : String(v);',
      'const depth = deep ? CAUSE_CHAIN_DEPTH_CAP : 1;',
    ];
    for (const line of legitimate) {
      expect(hasHandReplacer(line) || HELPER_COPY.test(line), line).toBe(false);
    }
  });

  it('the scanned corpus is non-vacuous, and holds the home module', () => {
    const files = scannedFiles();
    expect(files.length, 'the corpus collapsed; the check below would pass having read nothing')
      .toBeGreaterThan(500);
    const home = files.find((f) => f.rel === HOME);
    expect(home, `${HOME} moved; update HOME or this guard exempts nothing`).toBeDefined();
    expect(HELPER_COPY.test(readScannedSource(home!.abs).code),
      'the home module no longer defines the helpers, so the exemption is exempting nothing').toBe(true);
  });

  it('no other file hand-writes the replacer or re-defines its helpers', () => {
    expect(offenders(), 'Import from runtime/core/jsonSafe.ts instead: `jsonSafeReplacer` for '
      + '`JSON.stringify`, `toJsonSafe` for a value a transport stringifies, `renderError` for one '
      + 'Error, `isThenable`/`PENDING_PROMISE_MARKER` for the promise case.').toEqual([]);
  });
});
