/**
 * `runtime/core/errorText.ts` is the only place in SCAN_DIRS that turns an `Error` into text (#1055).
 *
 * `err.stack || err.message` was hand-written at NINE lines across six files. On V8 it reads fine,
 * because V8's stack starts with `Name: message`. On JavaScriptCore (every iOS WKWebView) the stack is
 * frames only, so the message was dropped: every uncaught error and every `console.error(err)`
 * reached Crashlytics from iOS as a bare stack frame (OBSERVED, iPad mini 5, 2026-09-11). The issue
 * reported one of the nine; the sweep for the fix found the rest, in the console ring, the device
 * bridge, the uncaught capture, renderer recovery and a sprite-material warning. A tenth copy is the
 * likeliest regression, so this fails at authorship.
 *
 * ── What it detects ─────────────────────────────────────────────────────────────────────────────
 * The PAIR: a `.stack` read whose `||`/`??` fallback is a `.message`, or a template opening with
 * `${….name}`. A bare `e.stack ?? ''` or `(err?.stack || '')` is a call-site trace or a deliberately
 * separate stack field, not an Error rendered as text, and does not match.
 *
 * ── Blind spots, stated rather than discovered later ────────────────────────────────────────────
 *   - a ternary (`err.stack ? err.stack : err.message`) or a destructured `{ stack, message }`;
 *   - a stack printed on its own with the message nowhere, which needs flow analysis;
 *   - anything outside SCAN_DIRS. Those roots run on Node or Electron's main process (V8), where the
 *     header is always written, so the instances there are pinned below instead of migrated.
 *
 * Comments are stripped by the shared reader (`readScannedSource`), because prose here and at the
 * migrated sites names the pattern this polices.
 */

import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { deriveUnscannedRoots, expectedLedgerRows } from '../helpers/unscannedRoots';

const SCAN_DIRS = ['engine/packages/modoki/src', 'engine/app'];

/** Outside SCAN_DIRS, and deliberately left: each runs in Node or Electron's main process, where V8
 *  always writes the `Name: message` header, so `stack || message` loses nothing there. A NEW row
 *  fails the last test below; decide deliberately whether it can run on JavaScriptCore. */
const KNOWN_OUTSIDE_SCAN_DIRS: readonly string[] = [
  'engine/electron/crashSink.ts :: stack-or-message',
  'engine/electron/fileLog.ts :: stack-or-message',
  'engine/electron/main.ts :: stack-or-message',
];

const UNSCANNED_ROOTS: readonly string[] = deriveUnscannedRoots(SCAN_DIRS);

const STACK_OR_MESSAGE = /\.stack\s*(?:\|\||\?\?)\s*(?:[\w$.?]+\.message\b|`\$\{[\w$.?]+\.name\})/;

function scannedFiles(roots: readonly string[]): Array<{ rel: string; abs: string }> {
  return repoFiles({
    under: [...roots],
    match: (rel) => /\.tsx?$/.test(rel) && !rel.includes('.test.'),
    exclude: ['node_modules', 'dist'],
    floor: 0, // callers assert their own non-vacuity
  });
}

function offenders(roots: readonly string[]): string[] {
  return scannedFiles(roots)
    .filter(({ abs }) => STACK_OR_MESSAGE.test(readScannedSource(abs).code))
    .map(({ rel }) => rel)
    .sort();
}

describe('errorText is the only Error-to-text rendering (#1055)', () => {
  it('the detector matches every shape the migration removed, and none of the legitimate stack reads', () => {
    const removed = [
      'if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;',
      'if (v instanceof Error) return (v.stack || v.message) + formatCauseChain(v);',
      ': val instanceof Error ? (val.stack || val.message) + formatCauseChain(val)',
      'if (value instanceof Error) return value.stack || value.message;',
      ': v instanceof Error ? (v.stack || v.message)',
      'const msg = e.error instanceof Error ? (e.error.stack || e.error.message) : String(e.message);',
      'const msg = r instanceof Error ? (r.stack || r.message) : String(r);',
      'if (e instanceof Error) return e.stack || `${e.name}: ${e.message}`;',
      'failed: ${e instanceof Error ? e.stack || e.message : String(e)}',
      'const detail = err?.stack ?? err?.message;',
    ];
    for (const line of removed) expect(STACK_OR_MESSAGE.test(line), line).toBe(true);

    const legitimate = [
      "get() { return e.stack ?? ''; },",
      "computedStack = (err?.stack || '').split('\\n').slice(3).join('\\n').trim();",
      "const stack = (new Error().stack ?? '').split('\\n').slice(3).join('\\n');",
      'if (stackStr) entry.stack = stackStr.slice(0, STASH_MAX_STACK);',
      'if (value instanceof Error) return errorText(value);',
    ];
    for (const line of legitimate) expect(STACK_OR_MESSAGE.test(line), line).toBe(false);
  });

  it('SCAN_DIRS is non-vacuous', () => {
    expect(scannedFiles(SCAN_DIRS).length, 'the corpus collapsed; the check below would pass having '
      + 'read nothing').toBeGreaterThan(500);
  });

  it('no file in SCAN_DIRS renders an Error as `stack || message`: use errorText', () => {
    expect(offenders(SCAN_DIRS), 'An Error is rendered as `stack || message` (or `stack || `${name}…``). '
      + 'On iOS that drops the message, because a JavaScriptCore stack has no header line. Use '
      + '`errorText` from runtime/core/errorText.ts.').toEqual([]);
  });

  it('the roots this guard does NOT scan hold exactly the pinned V8-only instances', () => {
    expect(scannedFiles(UNSCANNED_ROOTS).length, 'the unscanned-roots corpus is empty; this would pass '
      + 'having examined nothing').toBeGreaterThan(50);
    expect(offenders(UNSCANNED_ROOTS).map((rel) => `${rel} :: stack-or-message`))
      .toEqual(expectedLedgerRows(KNOWN_OUTSIDE_SCAN_DIRS, UNSCANNED_ROOTS));
  });
});
