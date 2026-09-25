/** The `console-logs` op's filters (#1559) — the one reader behind `modoki_get_console_logs` AND
 *  `device_console_logs`:
 *  - `level` is a THRESHOLD (this level or worse), as on the journals — it was an exact match;
 *  - `since` is a ring SEQ cursor, handed back as `nextSeq` — it was an epoch-ms timestamp;
 *  - `sinceMs` is the clock form, and naming both is refused AMBIGUOUS;
 *  - a timestamp-sized `since` is refused with a pointer to `sinceMs`, not answered with nothing;
 *  - a cursor above the newest seq (the ring restarted) reads from the start and says so.
 *  Owner decisions, 2026-09-25. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installConsoleRing, recordConsoleRingEntry, __resetConsoleRingForTest } from '@modoki/engine/runtime/core/consoleRing';
import { _resetConsoleSourceForTests } from '../../app/debug/consoleSource';
import { runAgentOp } from '../../app/debug/agentBridge';

type Reply = {
  ok?: false; code?: string; error?: string; options?: string[];
  logs: Array<{ seq: number; level: string; ts: number; text: string }>;
  returnedCount: number; totalCount: number; ringTotal: number; nextSeq: number; epoch: string; cursorReset?: string; truncated?: true; hint?: string;
};
const read = async (p: Record<string, unknown> = {}) => (await runAgentOp('console-logs', p)) as Reply;
const texts = (r: Reply) => r.logs.map((l) => l.text);

beforeEach(() => {
  _resetConsoleSourceForTests();
  __resetConsoleRingForTest();
  installConsoleRing({ capacity: 100, bootPrefix: 0 });
  recordConsoleRingEntry('log', ['a-log']);
  recordConsoleRingEntry('info', ['b-info']);
  recordConsoleRingEntry('warn', ['c-warn']);
  recordConsoleRingEntry('error', ['d-error']);
});
afterEach(() => { __resetConsoleRingForTest(); });

describe('level is a threshold (#1559 C-5)', () => {
  it('warn returns warnings AND errors', async () => {
    expect(texts(await read({ level: 'warn' }))).toEqual(['c-warn', 'd-error']);
  });
  it('log and info both mean everything — info is accepted and ranks with log', async () => {
    expect(texts(await read({ level: 'log' }))).toEqual(['a-log', 'b-info', 'c-warn', 'd-error']);
    expect(texts(await read({ level: 'info' }))).toEqual(['a-log', 'b-info', 'c-warn', 'd-error']);
  });
  it('an unknown level is refused, naming the four', async () => {
    const r = await read({ level: 'wran' });
    expect(r).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', options: ['log', 'info', 'warn', 'error'] });
  });
});

describe('since is a seq cursor, sinceMs the clock (#1559 C-6)', () => {
  it('entries carry seq, and nextSeq reads only what came after', async () => {
    const first = await read();
    expect(first.logs.map((l) => l.seq)).toEqual([1, 2, 3, 4]);
    expect(first.nextSeq).toBe(4);
    recordConsoleRingEntry('log', ['e-new']);
    const next = await read({ since: first.nextSeq });
    expect(texts(next)).toEqual(['e-new']);
    expect(next.nextSeq).toBe(5);
  });

  it('nextSeq is the newest seq in the WHOLE ring, not the filtered page', async () => {
    const r = await read({ level: 'warn', since: 0 });
    expect(texts(r)).toEqual(['c-warn', 'd-error']);
    recordConsoleRingEntry('log', ['e-new']);
    // A level-filtered poll must not re-read the lines it filtered out last time — nor stall on them.
    expect((await read({ level: 'warn', since: r.nextSeq })).nextSeq).toBe(5);
  });

  it('sinceMs filters by the clock', async () => {
    const all = (await read()).logs;
    const r = await read({ sinceMs: all[0].ts - 1 });
    expect(r.logs.length).toBe(4);
    expect((await read({ sinceMs: all[3].ts + 60_000 })).logs).toEqual([]);
  });

  it('since and sinceMs together are refused AMBIGUOUS', async () => {
    expect(await read({ since: 1, sinceMs: 1 })).toMatchObject({ ok: false, code: 'AMBIGUOUS', options: ['since', 'sinceMs'] });
  });

  it('a timestamp passed as since is refused and pointed at sinceMs — not answered with nothing', async () => {
    const r = await read({ since: 1_758_800_000_000 });
    expect(r).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', options: ['sinceMs'] });
    expect(r.error).toMatch(/use sinceMs=1758800000000/);
  });

  it('a cursor above the newest seq (the ring restarted) reads from the start and says so', async () => {
    const r = await read({ since: 50 });
    expect(texts(r)).toEqual(['a-log', 'b-info', 'c-warn', 'd-error']);
    expect(r.cursorReset).toMatch(/past the newest seq this ring has issued \(4\)/);
    expect(r.nextSeq).toBe(4);
  });

  // #1559 review, observed: a restart is invisible to the cursor's VALUE once the new ring has logged
  // past it — a game-code edit reloads the page, boot logs past the old cursor, and the boot error the
  // edit caused was silently skipped. The epoch is the ring's identity; a mismatch replays from 1.
  it('a stale epoch replays from the start even when the new ring has logged past the cursor', async () => {
    const before = await read();
    expect(before.nextSeq).toBe(4);
    __resetConsoleRingForTest();
    installConsoleRing({ capacity: 100, bootPrefix: 0 });
    recordConsoleRingEntry('error', ['BOOT ERROR']);
    for (let i = 0; i < 9; i++) recordConsoleRingEntry('log', [`new-${i}`]);
    const after = await read({ since: before.nextSeq, epoch: before.epoch });
    expect(texts(after)[0]).toBe('BOOT ERROR');
    expect(after.cursorReset).toMatch(/restarted since/);
    expect(after.epoch).not.toBe(before.epoch);
  });

  // Re-review: a real reload changes `timeOrigin` and NOTHING else — the ring's generation is module
  // state that restarts at the same value on every load. So the reload case is modelled here by moving
  // timeOrigin alone; the test above (a generation bump) cannot tell an epoch without timeOrigin apart.
  it('a reload — a new timeOrigin, the ring generation unchanged — reads as a stale epoch', async () => {
    const before = await read();
    const original = Object.getOwnPropertyDescriptor(performance, 'timeOrigin');
    const shifted = performance.timeOrigin + 60_000;
    Object.defineProperty(performance, 'timeOrigin', { configurable: true, get: () => shifted });
    try {
      const after = await read({ since: 2, epoch: before.epoch });
      expect(after.cursorReset).toMatch(/restarted since/);
      expect(texts(after)[0]).toBe('a-log');
    } finally {
      if (original) Object.defineProperty(performance, 'timeOrigin', original);
      else delete (performance as unknown as { timeOrigin?: number }).timeOrigin;
    }
  });

  it('an empty epoch is absent, not a restart on every call', async () => {
    expect((await read({ since: 2, epoch: '' })).cursorReset).toBeUndefined();
  });

  it('the current epoch with a live cursor is not a reset', async () => {
    const first = await read();
    recordConsoleRingEntry('log', ['e-new']);
    const next = await read({ since: first.nextSeq, epoch: first.epoch });
    expect(texts(next)).toEqual(['e-new']);
    expect(next.cursorReset).toBeUndefined();
  });

  // #1559 review, observed: a cursored read returned the NEWEST 50 of an error storm and a nextSeq past
  // the rest, so the FIRST error — the cause — could never be read. A cursor pages oldest-first.
  it('a cursored read pages OLDEST-first, and nextSeq continues after the page — nothing is skipped', async () => {
    const start = await read();
    recordConsoleRingEntry('error', ['FIRST ERROR']);
    for (let i = 0; i < 80; i++) recordConsoleRingEntry('error', [`cascade-${i}`]);
    const page1 = await read({ since: start.nextSeq, limit: 50 });
    expect(texts(page1)[0]).toBe('FIRST ERROR');
    expect(page1.returnedCount).toBe(50);
    expect(page1.totalCount).toBe(81);
    expect(page1.truncated).toBe(true);
    expect(page1.nextSeq).toBe(page1.logs.at(-1)!.seq);
    expect(page1.hint).toMatch(/OLDEST 50 of 81/);
    const page2 = await read({ since: page1.nextSeq, limit: 50 });
    expect(page2.returnedCount).toBe(31);
    expect(texts(page2).at(-1)).toBe('cascade-79');
  });

  it('limit:0 on a cursored read holds the cursor — nextSeq never moves past unread rows', async () => {
    const r = await read({ since: 1, limit: 0 });
    expect(r.returnedCount).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.nextSeq).toBe(1);
  });

  it('a negative limit is 0 — an empty page is not "truncated"', async () => {
    const r = await read({ since: 4, limit: -3 });
    expect(r.returnedCount).toBe(0);
    expect(r.truncated).toBeUndefined();
  });

  it('a level-filtered cursored poll pages the matches oldest-first and skips none', async () => {
    const start = await read();
    for (let i = 0; i < 6; i++) recordConsoleRingEntry(i % 2 ? 'error' : 'log', [`mix-${i}`]);
    const p1 = await read({ since: start.nextSeq, level: 'error', limit: 2 });
    expect(texts(p1)).toEqual(['mix-1', 'mix-3']);
    const p2 = await read({ since: p1.nextSeq, level: 'error', limit: 2 });
    expect(texts(p2)).toEqual(['mix-5']);
    expect(p2.truncated).toBeUndefined();
    expect(p2.nextSeq).toBe(start.nextSeq + 6);
  });

  it('a BARE read is still a tail — the newest entries', async () => {
    for (let i = 0; i < 60; i++) recordConsoleRingEntry('log', [`t-${i}`]);
    const r = await read();
    expect(texts(r).at(-1)).toBe('t-59');
    expect(r.returnedCount).toBe(50);
  });

  it('a seq passed as sinceMs is refused and pointed at since', async () => {
    expect(await read({ sinceMs: 3 })).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', options: ['since'] });
  });

  it('a live cursor carries no cursorReset', async () => {
    expect((await read({ since: 2 })).cursorReset).toBeUndefined();
  });
});
