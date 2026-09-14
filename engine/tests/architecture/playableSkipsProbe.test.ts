/** The playable-ad build actually WIRES the boot-probe refusal (#221 W2 item 5).
 *
 *  ⚠️ **THE GUARD EXISTS BECAUSE THE UNIT TESTS CANNOT SEE THE WIRING.** `bootProbeAllowed.test.ts`
 *  proves both call sites obey the flag — mutation-checked, both fail when the guard is removed —
 *  but nothing there proves anyone ever SETS it. `main.tsx` is the only setter, it runs at module
 *  scope during app bootstrap, and it is not reachable from a jsdom unit test. Delete that line and
 *  every test in this repo stays green while every playable ad silently pays 1.6-1.8 s of blocked
 *  launch again. That is precisely the "mechanism that cannot fire" shape this codebase keeps
 *  producing, so the wiring gets a guard of its own.
 *
 *  ⚠️ It also pins the ARGUMENT, not just the call. `setBootProbeAllowed(true)` would satisfy a
 *  "the function is called" assertion and mean the opposite of the feature.
 *
 *  ⚠️ And it pins that the call is SYNCHRONOUS at module scope rather than inside `bootPlayable`:
 *  that module arrives through a dynamic import, and `App.tsx`'s boot effect resolves the tier
 *  without waiting for it — so a flag set from there would land after the probe had already run.
 *  A source-text check is the only cheap way to hold that ordering.
 *
 *  ⚠️ **EVERY call is judged, from the parse (#1179).** The old form took the FIRST line mentioning
 *  the setter and read module scope off its indentation, so a second `setBootProbeAllowed(true)`
 *  inside the dynamic-import callback was never looked at, and "not indented" is not "not in a
 *  function" (a column-0 line inside a multi-line arrow passes).
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { callsTo, enclosingFunction, lineOf, parseSource, ts, unwrapValue } from '@modoki/engine/testing/sourceAst';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const mainTsx = readScannedSource(resolve(repoRoot, 'engine/app/main.tsx')).code;

/** Every `setBootProbeAllowed(…)` call: whether its argument is exactly `!__MODOKI_PLAYABLE__`, and
 *  whether it runs in no function at all (module scope). */
function probeSetters(code: string, label: string): Array<{ line: number; negatedPlayable: boolean; moduleScope: boolean }> {
  const sf = parseSource(code, label);
  return callsTo(sf, 'setBootProbeAllowed').map((c) => {
    const arg = c.arguments.length === 1 ? unwrapValue(c.arguments[0]!) : undefined;
    const negatedPlayable = !!arg && ts.isPrefixUnaryExpression(arg) && arg.operator === ts.SyntaxKind.ExclamationToken
      && ts.isIdentifier(unwrapValue(arg.operand)) && (unwrapValue(arg.operand) as ts.Identifier).text === '__MODOKI_PLAYABLE__';
    return { line: lineOf(c), negatedPlayable, moduleScope: ts.isSourceFile(enclosingFunction(c)) };
  });
}

describe('a playable ad refuses the boot ramp probe', () => {
  const setters = probeSetters(mainTsx, 'main.tsx');

  it('⭐ main.tsx sets the flag from __MODOKI_PLAYABLE__, negated — every call', () => {
    expect(setters.length).toBeGreaterThanOrEqual(1);
    expect(setters.filter((s) => !s.negatedPlayable).map((s) => `line ${s.line}`)).toEqual([]);
  });

  it('⚠️ and does it at module scope, not inside a dynamic import callback — every call', () => {
    // `bootPlayable` is loaded with `import('./playable/bootPlayable').then(...)`. Anything set in
    // that callback lands too late for the tier resolution, so no setter may run inside a function.
    expect(setters.filter((s) => !s.moduleScope).map((s) => `line ${s.line}`)).toEqual([]);
  });

  it('the detector judges a SECOND call, and a wrapped one (#1179)', () => {
    const src = [
      'setBootProbeAllowed(',
      '  !__MODOKI_PLAYABLE__,',
      ');',
      "import('./playable/bootPlayable').then(() => {",
      'setBootProbeAllowed(true);',
      '});',
    ].join('\n');
    expect(probeSetters(src, 'main.tsx')).toEqual([
      { line: 1, negatedPlayable: true, moduleScope: true },
      { line: 5, negatedPlayable: false, moduleScope: false },
    ]);
  });
});
