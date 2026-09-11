/** `runtime/core/jsonSafe.ts` — the one rendering of an Error or a pending thenable for JSON (#1068).
 *
 *  Every "renders as text" assertion reads the output of a BARE `JSON.stringify`, the way a transport
 *  would, because a value with the raw Error still inside it looks fine as an object and serializes
 *  to `{}`. */

import { describe, it, expect } from 'vitest';
import {
  PENDING_PROMISE_MARKER, isThenable, jsonSafeReplacer, renderError, toJsonSafe,
} from '../../../src/runtime/core/jsonSafe';

describe('toJsonSafe', () => {
  it('renders an Error nested in an object as text that a bare JSON.stringify keeps', () => {
    const out = JSON.stringify(toJsonSafe({ payload: { error: new Error('nested') } }));
    expect(out).toContain('Error: nested');
    expect(out).not.toContain('"error":{}');
  });

  it('renders an Error nested in an array, and a top-level Error', () => {
    expect(JSON.stringify(toJsonSafe([1, new Error('in array')]))).toContain('Error: in array');
    expect(toJsonSafe(new Error('top'))).toMatch(/^Error: top/);
  });

  it('renders a nested thenable as the marker', () => {
    const pending = new Promise(() => {});
    expect(toJsonSafe({ p: pending })).toEqual({ p: PENDING_PROMISE_MARKER });
  });

  it('returns the SAME reference when nothing inside needs rendering (copy-on-write)', () => {
    const v = { a: [1, { b: 'x' }], n: NaN, d: new Date(0), bytes: new Float32Array(3) };
    expect(toJsonSafe(v)).toBe(v);
  });

  it('rebuilds only the path to a rendered value, and never mutates the input', () => {
    const sibling = { keep: true };
    const err = new Error('e');
    const inner = { err };
    const v = { sibling, list: [0, inner] };
    const out = toJsonSafe(v) as { sibling: unknown; list: unknown[] };
    expect(out).not.toBe(v);
    expect(out.sibling).toBe(sibling);
    expect(out.list[1]).toEqual({ err: renderError(err) });
    expect(inner.err).toBe(err);
  });

  it('agrees with JSON.stringify + jsonSafeReplacer on the encoded result', () => {
    const v = { e: new Error('same'), arr: [new Error('x'), 2], p: new Promise(() => {}), s: 'plain' };
    expect(JSON.stringify(toJsonSafe(v))).toBe(JSON.stringify(v, jsonSafeReplacer));
  });

  // close-out review: `JSON.stringify` runs the replacer over a `toJSON` RESULT, so the device path
  // rendered an Error inside one while a walk that skipped `toJSON` objects sent `{}`.
  it('renders an Error inside what toJSON returns, as the replacer path does', () => {
    // One Error, created outside `toJSON`: a fresh one per call would carry a different stack for each
    // caller (the walk vs `JSON.stringify`), and the comparison would fail on the frames.
    const err = new Error('via toJSON');
    const wrapped = { toJSON: () => ({ err }) };
    const v = { t: wrapped };
    expect(JSON.stringify(toJsonSafe(v))).toBe(JSON.stringify(v, jsonSafeReplacer));
    expect(JSON.stringify(toJsonSafe(v))).toContain('Error: via toJSON');
  });

  it('passes the property key to toJSON, as JSON.stringify does', () => {
    const seen: string[] = [];
    const probe = { toJSON: (k: string) => { seen.push(k); return 1; } };
    toJsonSafe({ a: probe, list: [probe] });
    expect(seen).toEqual(['a', '0']);
  });

  // close-out review: `out[key] = next` on a `{}` treats an own `__proto__` key as the prototype.
  it('keeps an own __proto__ key when its container is copied', () => {
    const v = JSON.parse('{"__proto__":{"x":1},"e":0}') as Record<string, unknown>;
    v.e = new Error('boom');
    const out = toJsonSafe(v) as object;
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(JSON.stringify(out)).toBe(JSON.stringify(v, jsonSafeReplacer));
  });

  // Scoped re-review: the case above only exercised the loop that copies the keys BEFORE the first
  // rendered one; a `__proto__` key after it went through the other `defineOwn` call, untested.
  it('keeps an own __proto__ key that comes AFTER the rendered key', () => {
    const v = JSON.parse('{"e":0,"__proto__":{"x":1}}') as Record<string, unknown>;
    v.e = new Error('boom');
    const out = toJsonSafe(v) as object;
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(JSON.stringify(out)).toBe(JSON.stringify(v, jsonSafeReplacer));
  });

  it('hands a root toJSON the key the caller says the result will sit under', () => {
    const seen: string[] = [];
    const probe = { toJSON: (k: string) => { seen.push(k); return 1; } };
    toJsonSafe(probe);
    toJsonSafe(probe, 'result');
    expect(seen).toEqual(['', 'result']);
  });

  // Scoped re-review: a copied projection kept its own `toJSON`, which the transport then called,
  // sending `{"t":"INNER"}` where the replacer path sends `{"t":{"e":"Error: …"}}`.
  it("does not let a projected value's own toJSON reach the wire", () => {
    const err = new Error('boom');
    const inner = (): string => 'INNER';
    const v = { t: { toJSON: () => ({ toJSON: inner, e: err }) } };
    expect(JSON.stringify(toJsonSafe(v))).toBe(JSON.stringify(v, jsonSafeReplacer));
  });

  it('leaves a typed-array view alone without consulting its toJSON', () => {
    let called = false;
    const view = Object.assign(new Uint8Array(2), { toJSON: () => { called = true; return 1; } });
    const v = { view };
    expect(toJsonSafe(v)).toBe(v);
    expect(called).toBe(false);
  });

  it('leaves a cycle as it is rather than recursing forever', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(toJsonSafe(a)).toBe(a);
  });

  it('returns the value unchanged when a getter throws, rather than throwing on a reply path', () => {
    const v = {};
    Object.defineProperty(v, 'boom', { enumerable: true, get() { throw new Error('getter'); } });
    expect(toJsonSafe(v)).toBe(v);
  });
});

describe('renderError', () => {
  it('is errorText plus one caused-by line per Error in the cause chain', () => {
    const e = Object.assign(new Error('outer'), { cause: new Error('inner') });
    const text = renderError(e);
    expect(text).toMatch(/^Error: outer/);
    expect(text).toContain('\n  caused by: Error: inner');
  });
});

describe('jsonSafeReplacer', () => {
  it('renders nested Errors and thenables, and passes everything else through', () => {
    const out = JSON.stringify({ e: new Error('r'), p: new Promise(() => {}), n: 1 }, jsonSafeReplacer);
    expect(out).toContain('Error: r');
    expect(JSON.parse(out).p).toBe(PENDING_PROMISE_MARKER);
    expect(out).toContain('"n":1');
  });

  it('isThenable is true for a promise-like and false for a plain object', () => {
    expect(isThenable({ then: () => {} })).toBe(true);
    expect(isThenable({ then: 1 })).toBe(false);
  });
});
