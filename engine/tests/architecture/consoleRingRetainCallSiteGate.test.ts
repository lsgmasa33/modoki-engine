import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { callsTo, lineOf, parseSource, ts, unwrapValue } from '@modoki/engine/testing/sourceAst';

/**
 * `ConsoleRingOptions.retainCallSite` (#626) opts a `warn`/`error` ring entry into retaining a live
 * `Error` object, captured at the console call site, so the editor Console panel can still show
 * WHERE a call came from even when it logged no `Error` itself. That per-entry retention is a real
 * cost — #154's low-end device budget must not pay it — so it must be turned on ONLY for the editor,
 * never unconditionally.
 *
 * Modeled on `deviceConsoleCaptureInstallOrder.test.ts`'s gate-text pins: this parses the actual
 * `installConsoleRing(...)` call rather than grepping loosely, so a comment that merely MENTIONS
 * `retainCallSite: __MODOKI_EDITOR__` cannot satisfy it in place of the real call doing so.
 *
 * ⚠️ **EVERY call's OWN options object is read from the parse (#1179).** The old form took the FIRST
 * line naming `installConsoleRing(` and tested that line's text: a second call was never looked at,
 * and a wrapped options object moved the property off the line that was read.
 */

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app');
const INSTALL_CONSOLE_RING = path.join(appDir, 'installConsoleRing.ts');

/** Each `installConsoleRing(…)` call and the value its options literal gives `retainCallSite` — the
 *  identifier's name, the source text of anything else, or `'<absent>'` (not an inline literal, or
 *  no such property: both leave the gate unproven). */
function retainCallSiteArgs(code: string, label: string): Array<{ line: number; value: string }> {
  const sf = parseSource(code, label);
  return callsTo(sf, 'installConsoleRing').map((c) => {
    const opts = c.arguments[0] ? unwrapValue(c.arguments[0]) : undefined;
    const prop = opts && ts.isObjectLiteralExpression(opts)
      ? opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'retainCallSite')
      : undefined;
    const v = prop ? unwrapValue(prop.initializer) : undefined;
    return { line: lineOf(c), value: v === undefined ? '<absent>' : ts.isIdentifier(v) ? v.text : v.getText(sf) };
  });
}

describe('installConsoleRing retainCallSite gate (#626)', () => {
  it('passes retainCallSite: __MODOKI_EDITOR__ to EVERY installConsoleRing call — never a bare `true`', () => {
    const src = fs.readFileSync(INSTALL_CONSOLE_RING, 'utf8');
    const stripped = stripComments(src);
    assertScanIsSane(src, stripped, 'app/installConsoleRing.ts');

    const calls = retainCallSiteArgs(stripped, 'app/installConsoleRing.ts');
    expect(calls.length, 'could not find the installConsoleRing(...) call in app/installConsoleRing.ts').toBeGreaterThanOrEqual(1);
    expect(
      calls.filter((c) => c.value !== '__MODOKI_EDITOR__').map((c) => `line ${c.line}: retainCallSite = ${c.value}`),
      'every installConsoleRing(...) call must pass "retainCallSite: __MODOKI_EDITOR__" — retaining a live '
        + 'Error per warn/error ring entry is a real cost only the editor should pay, and a bare `true` turns '
        + "it on for EVERY build (including a device one), which is exactly #154's low-end budget regression.",
    ).toEqual([]);
  });

  it('the detector reads a wrapped options object and judges a second call (#1179)', () => {
    const src = [
      'installConsoleRing({',
      '  capacity: 512,',
      '  retainCallSite: __MODOKI_EDITOR__,',
      '});',
      'installConsoleRing({ retainCallSite: true }); installConsoleRing(opts);',
    ].join('\n');
    expect(retainCallSiteArgs(src, 'a.ts')).toEqual([
      { line: 1, value: '__MODOKI_EDITOR__' }, { line: 5, value: 'true' }, { line: 5, value: '<absent>' },
    ]);
  });
});
