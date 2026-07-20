/** Unit: tail-with-counts, the summary-first shape for the append-only agent streams
 *  (docs/mcp-response-budget.md Phase 6).
 *
 *  The invariant that is easy to get wrong and impossible to notice: the histogram must be
 *  computed over the FULL filtered set, BEFORE the tail slice. Count after slicing and
 *  `byType` silently becomes "the types among the 50 I showed you" — a summary of the
 *  excerpt, wearing the costume of a summary of the buffer. */

import { describe, it, expect } from 'vitest';
import {
  tailWithCounts,
  takeTail,
  tailHint,
  CONSOLE_TAIL_DEFAULT,
  JOURNAL_TAIL_DEFAULT,
  EDITOR_JOURNAL_TAIL_DEFAULT,
} from '../../app/debug/streamSummary';

const ev = (type: string, i: number) => ({ type, i });
const stream = (n: number) => Array.from({ length: n }, (_, i) => ev(i % 3 === 0 ? 'error' : 'log', i));

describe('tailWithCounts — the tail', () => {
  it('returns the LAST n items (streams are append-ordered, newest last)', () => {
    const r = tailWithCounts(stream(10), (e) => e.type, { defaultLimit: 3 });
    expect(r.items.map((e) => e.i)).toEqual([7, 8, 9]);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(10);
  });

  it('returns everything, untruncated, when under the limit', () => {
    const r = tailWithCounts(stream(3), (e) => e.type, { defaultLimit: 10 });
    expect(r.items).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  it('an EXPLICIT limit always wins over the default — including a huge one', () => {
    const items = stream(500);
    expect(tailWithCounts(items, (e) => e.type, { limit: 5, defaultLimit: 100 }).items).toHaveLength(5);
    // The "give me everything" escape hatch.
    const all = tailWithCounts(items, (e) => e.type, { limit: 10_000, defaultLimit: 100 });
    expect(all.items).toHaveLength(500);
    expect(all.truncated).toBe(false);
  });

  it('limit 0 is honoured (counts-only read), not treated as "unset"', () => {
    // `?? defaultLimit` on a `0` would fall through if written `||`. It must not.
    const r = tailWithCounts(stream(10), (e) => e.type, { limit: 0, defaultLimit: 5 });
    expect(r.items).toHaveLength(0);
    expect(r.total).toBe(10);
    expect(r.byType).toEqual({ error: 4, log: 6 });
  });

  it('does not alias the input array', () => {
    const src = stream(3);
    const r = tailWithCounts(src, (e) => e.type, { defaultLimit: 10 });
    r.items.push(ev('log', 99));
    expect(src).toHaveLength(3);
  });

  it('handles an empty stream', () => {
    const r = tailWithCounts([], () => 'x', { defaultLimit: 5 });
    expect(r).toEqual({ items: [], total: 0, truncated: false, byType: {} });
  });

  it('a NaN limit falls back to the default — it must NEVER disable the tail', () => {
    // `?limit=abc` reaches here as NaN. `NaN ?? 50` is NaN; `length > NaN` is false and
    // `NaN <= 0` is false, so a naive implementation returns the WHOLE ring. That is a
    // full-buffer flood produced by a typo.
    const r = tailWithCounts(stream(200), (e) => e.type, { limit: NaN, defaultLimit: 50 });
    expect(r.items).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it('Infinity is likewise not a limit', () => {
    const r = tailWithCounts(stream(200), (e) => e.type, { limit: Infinity, defaultLimit: 50 });
    expect(r.items).toHaveLength(50);
  });

  it('exactly-full is NOT truncated (the > vs >= boundary)', () => {
    const r = tailWithCounts(stream(50), (e) => e.type, { defaultLimit: 50 });
    expect(r.items).toHaveLength(50);
    expect(r.truncated).toBe(false); // 50 of 50 shown — nothing was dropped
    const one = tailWithCounts(stream(51), (e) => e.type, { defaultLimit: 50 });
    expect(one.truncated).toBe(true);
  });
});

describe('takeTail — the only place the tail arithmetic lives', () => {
  const xs = [1, 2, 3, 4, 5];
  it('takes the last n', () => expect(takeTail(xs, 2, 99).items).toEqual([4, 5]));
  it('limit 0 returns [] (slice(-0) is the whole array)', () => expect(takeTail(xs, 0, 99).items).toEqual([]));
  it('NaN falls back to the default', () => expect(takeTail(xs, NaN, 2).items).toEqual([4, 5]));
  it('negative is clamped to []', () => expect(takeTail(xs, -3, 99).items).toEqual([]));
  it('under the limit is untruncated and copied', () => {
    const r = takeTail(xs, 99, 99);
    expect(r.truncated).toBe(false);
    r.items.push(6);
    expect(xs).toHaveLength(5); // no aliasing
  });
});

describe('tailWithCounts — counts cover the WHOLE set, not the excerpt', () => {
  it('byType histograms all 100 items even when only 3 are returned', () => {
    const r = tailWithCounts(stream(100), (e) => e.type, { defaultLimit: 3 });
    expect(r.items).toHaveLength(3);
    // 34 multiples of 3 in [0,99] → 34 errors, 66 logs. If the histogram were computed
    // after slicing it would report at most 3 events total.
    expect(r.byType).toEqual({ error: 34, log: 66 });
    expect(Object.values(r.byType).reduce((a, b) => a + b, 0)).toBe(r.total);
  });

  it('an error present ONLY outside the tail still shows up in byType', () => {
    // The whole point: "did anything throw during that Play session?" must be answerable
    // even when the throw scrolled off the visible tail.
    const items = [ev('error', 0), ...Array.from({ length: 50 }, (_, i) => ev('log', i + 1))];
    const r = tailWithCounts(items, (e) => e.type, { defaultLimit: 5 });
    expect(r.items.some((e) => e.type === 'error')).toBe(false); // not in the tail
    expect(r.byType.error).toBe(1);                              // but counted
  });
});

describe('tailHint', () => {
  it('names the counts and the way to get more', () => {
    const h = tailHint('events', 50, 1200, ', or narrow with type=');
    expect(h).toContain('last 50 of 1200 events');
    expect(h).toContain('limit=N');
    expect(h).toContain('type=');
  });
});

describe('tail defaults are sane', () => {
  it('are positive and bounded well under their ring caps (500 / 10000 / 2000)', () => {
    expect(CONSOLE_TAIL_DEFAULT).toBeGreaterThan(0);
    expect(CONSOLE_TAIL_DEFAULT).toBeLessThan(500);
    expect(JOURNAL_TAIL_DEFAULT).toBeLessThan(10_000);
    expect(EDITOR_JOURNAL_TAIL_DEFAULT).toBeLessThan(2_000);
  });
});
