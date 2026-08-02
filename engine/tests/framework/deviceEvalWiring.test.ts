/** #83, the SEAM: `device_eval` code must actually SEE the injected `modoki` object.
 *
 *  `deviceEvalApi.test.ts` proves `makeDeviceEvalApi()` builds the right object — but it calls that
 *  builder directly, which is precisely the gap this repo's close-out pass warns about: nothing
 *  there exercises the path production takes. Delete the `await makeDeviceEvalApi()` argument from
 *  `handleEval` and every assertion in that file still passes, while `device_eval` silently goes
 *  back to `modoki === undefined` — the exact bug #83 was filed for.
 *
 *  So this file drives the real chain instead: `handleEval(params)` → `handleEval(code, arg)` in
 *  bridgeHelpers → `new Function('modoki', code)`. That is what the bridge's `case 'eval':` dispatch
 *  calls, one hop above. Asserted from INSIDE the evaluated code, because that is the only vantage
 *  point that can tell "the object was built" apart from "the object was handed to the caller's code".
 *
 *  Note the distinction this pins, which a `typeof` check alone cannot: an UNDECLARED identifier and
 *  a declared-but-undefined parameter both answer `'undefined'` to `typeof`. Only a bare reference
 *  throws. Both are asserted below — that ambiguity cost real time when verifying #83 on device
 *  (a stale app answered `typeof modoki === 'undefined'`, which read as "my change is missing"
 *  when the truth was "another app is answering"). */

import { describe, it, expect } from 'vitest';
import { registerAgentOp } from '../../app/debug/agentBridge';
import { handleEval } from '../../app/debug/bridge';

/** `handleEval` safe-stringifies whatever the code returns (that is the documented device_eval
 *  contract — "compact, size-capped JSON; survives a circular result"), so a non-scalar comes back
 *  as a JSON STRING, not a live object. Parse it here rather than asserting against the raw string:
 *  the point of these tests is what the evaluated code saw, not how the reply was encoded. */
const evalObject = async (code: string): Promise<unknown> => JSON.parse(String(await handleEval({ code })));

describe('device_eval wiring — the injected object reaches the evaluated code (#83)', () => {
  it('`modoki` is DECLARED in the evaluated scope, not merely undefined', async () => {
    // A bare reference throws ReferenceError when undeclared; `typeof` would not distinguish it.
    const result = await handleEval({ code: 'try { modoki; return "declared"; } catch (e) { return "undeclared"; }' });
    expect(result).toBe('declared');
  });

  it('`modoki` is the scripting OBJECT, with call/ops', async () => {
    const result = await evalObject('return { t: typeof modoki, call: typeof modoki.call, ops: typeof modoki.ops };');
    expect(result).toEqual({ t: 'object', call: 'function', ops: 'function' });
  });

  it('the evaluated code can invoke a real op through the injected object', async () => {
    registerAgentOp('probe-eval-wiring-op', (params) => ({ echoed: params }));
    const result = await evalObject('return modoki.call("probe-eval-wiring-op", { n: 7 });');
    expect(result).toEqual({ echoed: { n: 7 } });
  });

  it('a generated camelCase method is reachable from the evaluated code', async () => {
    registerAgentOp('probe-eval-wiring-two-words', () => 'ok');
    const result = await handleEval({ code: 'return modoki.probeEvalWiringTwoWords();' });
    expect(result).toBe('ok');
  });

  it('the device object stays NARROWER than the editor\'s, as seen from the code (#83)', async () => {
    const result = await evalObject('return { api: typeof modoki.api, composite: typeof modoki.composite };');
    expect(result).toEqual({ api: 'undefined', composite: 'undefined' });
  });
});
