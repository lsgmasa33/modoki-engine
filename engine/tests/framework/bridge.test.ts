/** Debug-bridge pure-helper tests. These now import the REAL functions from app/debug/bridgeHelpers
 *  (previously the test re-implemented them, so a change to the shipping code wouldn't fail here —
 *  code-review T7). Covers safeStringify, screenshotToCSS (incl. the L5 param-precedence), the console
 *  ring, and handleEval. */

import { describe, it, expect, afterEach } from 'vitest';
import { safeStringify, screenshotToCSS, handleEval, EVAL_ASYNC_TIMEOUT_MS, PENDING_PROMISE_MARKER, clampEvalTimeout, DEVICE_EVAL_TIMEOUT_MS, DEVICE_EVAL_MAX_TIMEOUT_MS, EDITOR_EVAL_MAX_TIMEOUT_MS } from '../../app/debug/bridgeHelpers';
import { consoleRing } from '../../app/debug/deviceConsoleCapture';
import { installConsoleRing, __resetConsoleRingForTest } from '@modoki/engine/runtime/core/consoleRing';

describe('safeStringify', () => {
  it('returns strings as-is', () => expect(safeStringify('hello')).toBe('hello'));
  it('JSON-stringifies numbers', () => expect(safeStringify(42)).toBe('42'));
  it('JSON-stringifies objects', () => expect(safeStringify({ a: 1 })).toBe('{"a":1}'));
  it('JSON-stringifies arrays', () => expect(safeStringify([1, 2, 3])).toBe('[1,2,3]'));
  // An Error JSON-stringifies to `{}` (no own enumerable props) — the empty-looking-result trap
  // that made a real device boot error reach `diagnose` as a literal `{}` (#157). `console.error(err)`
  // is how failures are usually reported, so this is the common path, not an edge case.
  it('serializes an Error to its stack, never a bare {}', () => {
    const out = safeStringify(new Error('boom'));
    expect(out).not.toBe('{}');
    expect(out).toContain('boom');
  });
  it('falls back to the message when an Error carries no stack', () => {
    const e = new Error('no-stack'); e.stack = '';
    expect(safeStringify(e)).toBe('no-stack');
  });
  // NESTED too — the thenable case beside it is nested-aware, and a rejection value or a `cause`
  // arrives wrapped. The first cut fixed only the top level, leaving `{"cause":{}}`.
  it('serializes an Error nested in an object', () => {
    const out = safeStringify({ cause: new Error('boom') });
    expect(out).not.toContain('{}');
    expect(out).toContain('boom');
  });
  it('serializes an Error nested in an array', () => {
    expect(safeStringify([new Error('boom')])).toContain('boom');
  });
  it('JSON-stringifies null', () => expect(safeStringify(null)).toBe('null'));
  it('JSON-stringifies booleans', () => expect(safeStringify(true)).toBe('true'));
  it('falls back to String() for circular references', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(safeStringify(obj)).toBe('[object Object]');
  });
  it('handles undefined', () => expect(safeStringify(undefined)).toBe(undefined)); // JSON.stringify(undefined) === undefined
});

describe('screenshotToCSS', () => {
  it('returns raw coords when no screen info', () => {
    expect(screenshotToCSS(100, 200, {})).toEqual({ x: 100, y: 200 });
  });

  it('converts iOS coords using lastScreenInfo', () => {
    const lastScreenInfo = { imageWidth: 1800, imageHeight: 3900, screenWidth: 1260, screenHeight: 2730 };
    const r = screenshotToCSS(900, 1950, { lastScreenInfo, dpr: 3 }); // scale 1260/1800=0.7
    expect(r.x).toBeCloseTo(210); // 900*0.7/3
    expect(r.y).toBeCloseTo(455); // 1950*0.7/3
  });

  it('converts Android coords using the screenInfo param', () => {
    const screenInfo = { imgW: 600, imgH: 1300, nativeW: 1080, nativeH: 2340 };
    const r = screenshotToCSS(300, 650, { screenInfo, dpr: 2.625 });
    expect(r.x).toBeCloseTo(205.71, 1); // 300*1080/600/2.625
    expect(r.y).toBeCloseTo(445.71, 1); // 650*2340/1300/2.625
  });

  it('PREFERS the explicit screenInfo param over a stale lastScreenInfo (L5)', () => {
    const lastScreenInfo = { imageWidth: 1000, imageHeight: 2000, screenWidth: 500, screenHeight: 1000 };
    const screenInfo = { imgW: 600, imgH: 1200, nativeW: 1080, nativeH: 2160 };
    const r = screenshotToCSS(300, 600, { lastScreenInfo, screenInfo, dpr: 3 });
    // Uses screenInfo (Android): x = 300*1080/600/3 = 180 (NOT the lastScreenInfo path → 50).
    expect(r.x).toBeCloseTo(180);
    expect(r.y).toBeCloseTo(360); // 600*2160/1200/3
  });

  it('treats dpr<=0 as 1', () => {
    const lastScreenInfo = { imageWidth: 400, imageHeight: 800, screenWidth: 400, screenHeight: 800 };
    const r = screenshotToCSS(200, 400, { lastScreenInfo, dpr: 0 });
    expect(r).toEqual({ x: 200, y: 400 });
  });
});

// ⚠️ Repointed (#596/#597 close-out review) from `bridgeHelpers.ts`'s now-DELETED `createConsoleRing`
// — a private buffer with no production caller anywhere (`bridge.ts` reads `deviceConsoleCapture.ts`'s
// `consoleRing` instead, always did since #591). This describe block now exercises THAT object
// directly: same public shape (`push`/`entries`/`query`), but backed by the ONE shared ring
// (`runtime/core/consoleRing.ts`) rather than a disconnected duplicate. Concretely, that means these
// tests now run through `recordConsoleRingEntry` → `record` → `stringifyArg` — the actual shared
// serializer `bridge.ts:546-547` depends on — so a regression there (the Error-stack one this same
// review found and fixed) would fail HERE too, which the dead copy structurally could not do.
describe('console ring (the live shared-ring projection, deviceConsoleCapture.ts)', () => {
  afterEach(() => {
    __resetConsoleRingForTest();
  });

  it('captures entries', () => {
    installConsoleRing();
    consoleRing.push('log', ['hello']);
    consoleRing.push('warn', ['warning!']);
    expect(consoleRing.entries).toHaveLength(2);
    expect(consoleRing.entries[0]).toMatchObject({ level: 'log', args: ['hello'] });
    expect(consoleRing.entries[1].level).toBe('warn');
  });

  it('enforces max size by dropping oldest', () => {
    installConsoleRing({ capacity: 3, bootPrefix: 0 });
    for (const c of ['a', 'b', 'c', 'd']) consoleRing.push('log', [c]);
    expect(consoleRing.entries.map((e) => e.args[0])).toEqual(['b', 'c', 'd']);
  });

  it('query returns last N', () => {
    installConsoleRing();
    for (let i = 0; i < 10; i++) consoleRing.push('log', [`msg${i}`]);
    expect(consoleRing.query(3).map((e) => e.args[0])).toEqual(['msg7', 'msg8', 'msg9']);
  });

  it('query filters by level', () => {
    installConsoleRing();
    consoleRing.push('log', ['a']); consoleRing.push('error', ['b']); consoleRing.push('log', ['c']); consoleRing.push('error', ['d']);
    expect(consoleRing.query(10, 'error').map((e) => e.args[0])).toEqual(['b', 'd']);
  });

  // The assertion that matters: aimed at the dead `createConsoleRing`, this could only ever exercise
  // `bridgeHelpers.ts`'s OWN `safeStringify` — never the shared ring's `stringifyArg`, and never what
  // `bridge.ts` actually ships. Aimed here, an Error argument proves it now would have caught the
  // Error-stack regression (`consoleRing.ts`'s own close-out fix — see `consoleRing.test.ts`).
  it('stringifies non-string args, including an Error kept as its stack', () => {
    installConsoleRing();
    const err = new Error('boom');
    consoleRing.push('log', [42, { key: 'val' }, true, err]);
    expect(consoleRing.entries[0].args.slice(0, 3)).toEqual(['42', '{"key":"val"}', 'true']);
    expect(consoleRing.entries[0].args[3]).toBe(err.stack || err.message);
  });
});

describe('handleEval', () => {
  it('evaluates a return expression', async () => expect(await handleEval('return 2 + 3')).toBe('5'));
  it('returns a string result as-is', async () => expect(await handleEval('return "hello"')).toBe('hello'));
  it('JSON-stringifies an object result', async () => expect(await handleEval('return { a: 1 }')).toBe('{"a":1}'));
  it('returns undefined with no return statement', async () => expect(await handleEval('2 + 3')).toBeUndefined());
  it('surfaces a runtime error as Error: …', async () => expect(await handleEval('throw new Error("boom")')).toBe('Error: boom'));
  it('surfaces a syntax error', async () => expect(await handleEval('}{invalid')).toMatch(/Error:/));

  it('awaits a returned promise and serializes its resolved value', async () => {
    expect(await handleEval('return Promise.resolve({ ok: true })')).toBe('{"ok":true}');
  });
  it('awaits a returned promise resolving to a primitive', async () => {
    expect(await handleEval('return Promise.resolve(42)')).toBe('42');
  });
  it('surfaces a rejected promise as an Error: …', async () => {
    expect(await handleEval('return Promise.reject(new Error("nope"))')).toBe('Error: nope');
  });
  it('times out a never-resolving promise instead of hanging', async () => {
    const result = await handleEval('return new Promise(() => {})');
    expect(result).toMatch(/Error: eval timed out/);
  }, EVAL_ASYNC_TIMEOUT_MS + 2000);

  /** #145: the body is compiled with the async constructor, so `await` parses. `return await p` and
   *  the bare `return p` workaround must come back IDENTICALLY — the whole point is that an agent
   *  writing the obvious thing gets the same answer, not a syntax error. */
  describe('async code (#145)', () => {
    it('accepts top-level await', async () => {
      expect(await handleEval('const r = await Promise.resolve({ ok: true }); return r;')).toBe('{"ok":true}');
    });
    it('gives `return await p` and `return p` the same result', async () => {
      const code = 'Promise.resolve({ a: 1, b: [2, 3] })';
      expect(await handleEval(`return await ${code};`)).toBe(await handleEval(`return ${code};`));
    });
    it('composes several awaited reads into one object — the case the workaround could not reach', async () => {
      const out = await handleEval(
        'const a = await Promise.resolve(1); const b = await Promise.resolve(2); return { a, b };',
      );
      expect(out).toBe('{"a":1,"b":2}');
    });
    it('surfaces a rejected await as an Error: …', async () => {
      expect(await handleEval('await Promise.reject(new Error("nope")); return 1;')).toBe('Error: nope');
    });
    it('passes the injected `modoki` arg through to awaited calls', async () => {
      const api = { read: () => Promise.resolve('v') };
      expect(await handleEval('return await modoki.read();', api)).toBe('v');
    });
    it('still injects `modoki` as a sync value', async () => {
      expect(await handleEval('return modoki.n;', { n: 7 })).toBe('7');
    });
  });

  /** The budget is caller-supplied now. The fixed 5000 was UNREACHABLE on both surfaces — the
   *  editor relay gave up at 3000ms and the device transport at 5000ms with an earlier start — so
   *  the number that mattered was never this one. Each caller now sizes its transport from it. */
  describe('timeoutMs', () => {
    it('a short budget abandons a slow body and names the budget', async () => {
      const out = await handleEval('await new Promise(r => setTimeout(r, 5000)); return 1;', undefined, 60);
      expect(out).toMatch(/Error: eval timed out after 60ms/);
    });

    it('a body that finishes inside the budget is unaffected', async () => {
      expect(await handleEval('await new Promise(r => setTimeout(r, 10)); return 7;', undefined, 2000)).toBe('7');
    });

    it('defaults to EVAL_ASYNC_TIMEOUT_MS when omitted', async () => {
      // Pinned by the MESSAGE rather than by timing, so it cannot pass by accident on a slow box.
      const out = await handleEval('return new Promise(() => {})');
      expect(out).toBe(`Error: eval timed out after ${EVAL_ASYNC_TIMEOUT_MS}ms (the code did not finish — an unresolved Promise, or a budget too small for what it awaits)`);
    }, EVAL_ASYNC_TIMEOUT_MS + 2000);
  });

  /** Ordering invariant, asserted as data because the layers cannot see each other.
   *
   *  The device ceiling used to be pinned UNDER the transport's fixed 5000ms request deadline —
   *  above it, the eval's own timeout message was unreachable, which was the bug that shape
   *  replaced. #153 made the transport deadline per-request and sized from the op's own budget, so
   *  the constraint that remains is a DEFAULT one: an eval that names no budget must still finish
   *  inside the 5000ms connection default, or it goes back to reporting a dead link. The ceiling
   *  itself is free to exceed that, because reaching it requires asking — and asking is what
   *  raises the transport deadline too. */
  describe('the ceilings encode their transports', () => {
    it('the device DEFAULT still finishes inside the 5000ms connection deadline', () => {
      expect(DEVICE_EVAL_TIMEOUT_MS).toBeLessThan(5000);
      expect(DEVICE_EVAL_TIMEOUT_MS).toBeLessThanOrEqual(DEVICE_EVAL_MAX_TIMEOUT_MS);
    });
    it('the device ceiling is no longer capped by the transport (#153)', () => {
      expect(DEVICE_EVAL_MAX_TIMEOUT_MS).toBeGreaterThan(5000);
    });
    it('the editor ceiling stays larger — the device pays a network hop the editor does not', () => {
      expect(EDITOR_EVAL_MAX_TIMEOUT_MS).toBeGreaterThan(DEVICE_EVAL_MAX_TIMEOUT_MS);
    });
  });

  describe('clampEvalTimeout', () => {
    it('passes a value inside the range through', () => expect(clampEvalTimeout(1234, 5000, 25_000)).toBe(1234));
    it('clamps above the max rather than refusing', () => expect(clampEvalTimeout(999_999, 5000, 25_000)).toBe(25_000));
    it('floors at 50ms', () => expect(clampEvalTimeout(1, 5000, 25_000)).toBe(50));
    it('falls back to the default for undefined/NaN/zero/negative', () => {
      for (const bad of [undefined, null, NaN, 0, -5, 'abc', {}]) {
        expect(clampEvalTimeout(bad, 5000, 25_000)).toBe(5000);
      }
    });
    it('accepts a numeric string (query/JSON callers)', () => expect(clampEvalTimeout('900', 5000, 25_000)).toBe(900));
    it('truncates a fractional value to an integer ms', () => expect(clampEvalTimeout(120.9, 5000, 25_000)).toBe(120));
  });

  /** The silent half of #145 — a pending promise NESTED in a returned value is not awaited by the
   *  top-level race, and used to serialize to `{}`: an empty-looking RESULT rather than a mistake. */
  describe('un-awaited nested promise', () => {
    it('names itself instead of serializing to {}', async () => {
      const out = await handleEval('return { a: Promise.resolve(1) };');
      expect(out).not.toBe('{"a":{}}');
      expect(out).toContain(PENDING_PROMISE_MARKER);
    });
    it('names itself inside an array too', async () => {
      expect(await handleEval('return [Promise.resolve(1)];')).toBe(JSON.stringify([PENDING_PROMISE_MARKER]));
    });
    it('leaves a resolved value alone', async () => {
      expect(await handleEval('return { a: await Promise.resolve(1) };')).toBe('{"a":1}');
    });
  });
});
