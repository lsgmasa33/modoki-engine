/** Video cache admission/eviction policy. Pure, so these are the real decisions —
 *  not a mock of them. */

import { describe, it, expect } from 'vitest';
import {
  planAdmission, totalBytes, explainRefusal, type CacheEntry,
} from '../../src/runtime/video/videoCachePolicy';

const MB = 1024 * 1024;
const e = (key: string, mb: number, lastUsed: number, pinned = false): CacheEntry =>
  ({ key, bytes: mb * MB, lastUsed, pinned });

describe('planAdmission', () => {
  it('admits with no eviction when it fits', () => {
    const r = planAdmission({
      entries: [e('a', 10, 1)], incomingBytes: 20 * MB, budgetBytes: 100 * MB,
    });
    expect(r).toEqual({ ok: true, evict: [] });
  });

  it('evicts least-recently-USED first, not least-recently-added', () => {
    // 'old' was added first but used most recently — it must survive. This is the
    // whole point of LRU over FIFO: a clip the player keeps returning to should
    // outlive one fetched once and forgotten.
    const entries = [e('old', 40, 99), e('stale', 40, 1)];
    const r = planAdmission({ entries, incomingBytes: 30 * MB, budgetBytes: 100 * MB });
    expect(r).toEqual({ ok: true, evict: ['stale'] });
  });

  it('evicts only as much as it needs, in LRU order', () => {
    const entries = [e('a', 20, 1), e('b', 20, 2), e('c', 20, 3)];
    const r = planAdmission({ entries, incomingBytes: 30 * MB, budgetBytes: 60 * MB });
    // Needs 30 free of 60; 60 used. Dropping a (20) leaves 40+30=70 > 60, so b goes
    // too — but c must NOT, since 20+30 = 50 fits.
    expect(r).toEqual({ ok: true, evict: ['a', 'b'] });
  });

  it('never evicts a pinned entry', () => {
    const entries = [e('pinned', 50, 1, true), e('free', 30, 2)];
    const r = planAdmission({ entries, incomingBytes: 30 * MB, budgetBytes: 100 * MB });
    expect(r).toEqual({ ok: true, evict: ['free'] });
  });

  it('REFUSES rather than emptying the cache for something that still would not fit', () => {
    // 60 pinned + 10 free, budget 100, incoming 50 → even dropping the 10 leaves
    // 60+50 = 110 > 100. Evicting the free entry would be pure loss: the clip still
    // fails and the player re-downloads what we threw away.
    const entries = [e('pinned', 60, 1, true), e('free', 10, 2)];
    const r = planAdmission({ entries, incomingBytes: 50 * MB, budgetBytes: 100 * MB });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('cannot-fit');
      expect(r.freeable).toBe(10 * MB);
    }
  });

  it('distinguishes a clip bigger than the ENTIRE budget from a full cache', () => {
    // Different reason because the fix is different — raise the budget or shrink the
    // clip. Reporting this as "cache full" would send someone deleting files forever.
    const r = planAdmission({ entries: [], incomingBytes: 200 * MB, budgetBytes: 100 * MB });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('exceeds-budget');
  });

  it('treats re-admitting an existing key as a REPLACE, freeing its old bytes', () => {
    // Without this, refreshing a cached clip would need room for two copies and could
    // spuriously evict its neighbours.
    const entries = [e('same', 80, 1), e('other', 15, 2)];
    const r = planAdmission({
      entries, incomingBytes: 80 * MB, budgetBytes: 100 * MB, incomingKey: 'same',
    });
    expect(r).toEqual({ ok: true, evict: [] });
  });

  it('admits exactly at the budget boundary', () => {
    const r = planAdmission({
      entries: [e('a', 50, 1)], incomingBytes: 50 * MB, budgetBytes: 100 * MB,
    });
    expect(r).toEqual({ ok: true, evict: [] });
  });

  it('does not mutate its input', () => {
    const entries = [e('a', 20, 1), e('b', 20, 2)];
    const before = JSON.stringify(entries);
    planAdmission({ entries, incomingBytes: 30 * MB, budgetBytes: 50 * MB });
    expect(JSON.stringify(entries)).toBe(before);
  });

  it('handles an empty cache', () => {
    expect(planAdmission({ entries: [], incomingBytes: 10 * MB, budgetBytes: 100 * MB }))
      .toEqual({ ok: true, evict: [] });
  });
});

describe('totalBytes', () => {
  it('sums entries', () => {
    expect(totalBytes([e('a', 3, 1), e('b', 4, 2)])).toBe(7 * MB);
  });
});

describe('explainRefusal', () => {
  it('tells you to raise the budget or shrink the clip when it can never fit', () => {
    const msg = explainRefusal(
      { ok: false, reason: 'exceeds-budget', needed: 200 * MB, freeable: 100 * MB }, 100 * MB,
    );
    expect(msg).toMatch(/never be cached/);
    expect(msg).toMatch(/videoCacheBudgetMB/);
  });

  it('tells you what is pinned when the cache merely cannot make room', () => {
    const msg = explainRefusal(
      { ok: false, reason: 'cannot-fit', needed: 10 * MB, freeable: 5 * MB }, 100 * MB,
    );
    expect(msg).toMatch(/pinned/);
  });
});
