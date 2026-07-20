/** Debug-bridge pure-helper tests. These now import the REAL functions from app/debug/bridgeHelpers
 *  (previously the test re-implemented them, so a change to the shipping code wouldn't fail here —
 *  code-review T7). Covers safeStringify, screenshotToCSS (incl. the L5 param-precedence), the console
 *  ring, and handleEval. */

import { describe, it, expect } from 'vitest';
import { safeStringify, screenshotToCSS, createConsoleRing, handleEval } from '../../app/debug/bridgeHelpers';

describe('safeStringify', () => {
  it('returns strings as-is', () => expect(safeStringify('hello')).toBe('hello'));
  it('JSON-stringifies numbers', () => expect(safeStringify(42)).toBe('42'));
  it('JSON-stringifies objects', () => expect(safeStringify({ a: 1 })).toBe('{"a":1}'));
  it('JSON-stringifies arrays', () => expect(safeStringify([1, 2, 3])).toBe('[1,2,3]'));
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

describe('console ring', () => {
  it('captures entries', () => {
    const ring = createConsoleRing(200);
    ring.push('log', ['hello']);
    ring.push('warn', ['warning!']);
    expect(ring.entries).toHaveLength(2);
    expect(ring.entries[0]).toMatchObject({ level: 'log', args: ['hello'] });
    expect(ring.entries[1].level).toBe('warn');
  });

  it('enforces max size by dropping oldest', () => {
    const ring = createConsoleRing(3);
    for (const c of ['a', 'b', 'c', 'd']) ring.push('log', [c]);
    expect(ring.entries.map((e) => e.args[0])).toEqual(['b', 'c', 'd']);
  });

  it('query returns last N', () => {
    const ring = createConsoleRing(200);
    for (let i = 0; i < 10; i++) ring.push('log', [`msg${i}`]);
    expect(ring.query(3).map((e) => e.args[0])).toEqual(['msg7', 'msg8', 'msg9']);
  });

  it('query filters by level', () => {
    const ring = createConsoleRing(200);
    ring.push('log', ['a']); ring.push('error', ['b']); ring.push('log', ['c']); ring.push('error', ['d']);
    expect(ring.query(10, 'error').map((e) => e.args[0])).toEqual(['b', 'd']);
  });

  it('stringifies non-string args', () => {
    const ring = createConsoleRing(200);
    ring.push('log', [42, { key: 'val' }, true]);
    expect(ring.entries[0].args).toEqual(['42', '{"key":"val"}', 'true']);
  });
});

describe('handleEval', () => {
  it('evaluates a return expression', () => expect(handleEval('return 2 + 3')).toBe('5'));
  it('returns a string result as-is', () => expect(handleEval('return "hello"')).toBe('hello'));
  it('JSON-stringifies an object result', () => expect(handleEval('return { a: 1 }')).toBe('{"a":1}'));
  it('returns undefined with no return statement', () => expect(handleEval('2 + 3')).toBeUndefined());
  it('surfaces a runtime error as Error: …', () => expect(handleEval('throw new Error("boom")')).toBe('Error: boom'));
  it('surfaces a syntax error', () => expect(handleEval('}{invalid')).toMatch(/Error:/));
});
