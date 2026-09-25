/** journal-events op — the Tier-2 capture CONTROL path (action:start|stop) and the read-path
 *  capture reporting. These `ok:false` shapes are what the MCP client's isFailureBody depends on,
 *  and the captureHint is what stops an empty @contact read from being misread as "no contacts"
 *  rather than "not capturing". All had zero coverage.
 *
 *  Note: createTestWorld opens every Tier-2 capture by default (headless full observability), so
 *  each test starts with @contact ACTIVE and dispose() closes it again (verboseCaptureState is
 *  process-global). */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, emit, type TestWorld } from '@modoki/engine/runtime';
import { runAgentOp } from '../../app/debug/agentBridge';

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; });

type CaptureState = { types: string[]; active: string[] };
type Reply = { ok?: boolean; reason?: string; action?: string; type?: string; captures: CaptureState; captureHint?: string };
const journal = (args: Record<string, unknown>) => runAgentOp('journal-events', args) as Promise<Reply>;

describe('journal-events: Tier-2 capture control', () => {
  it('stop then start @contact flips captures.active and echoes it', async () => {
    game = createTestWorld(); // @contact active by default
    const stopped = await journal({ action: 'stop', type: '@contact' });
    expect(stopped.ok).toBe(true);
    expect(stopped.captures.active).not.toContain('@contact');

    const started = await journal({ action: 'start', type: '@contact' });
    expect(started.ok).toBe(true);
    expect(started.captures.active).toContain('@contact');
    expect(started.captures.types).toContain('@contact'); // @contact is a known Tier-2 type
  });

  it('action without a type → ok:false naming the requirement', async () => {
    game = createTestWorld();
    const r = await journal({ action: 'start' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/type/i);
  });

  it('starting a NON-verbose (always-on) type → ok:false naming the watch-gated types', async () => {
    game = createTestWorld();
    const r = await journal({ action: 'start', type: 'match' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/@contact/); // it lists the watch-gated types
  });
});

describe('journal-events: read-path capture reporting', () => {
  it('a bare read with @contact idle surfaces captureHint + excludes it from captures.active', async () => {
    game = createTestWorld();
    await journal({ action: 'stop', type: '@contact' }); // make it idle
    const r = await journal({});
    expect(r.captures.active).not.toContain('@contact');
    expect(r.captureHint).toMatch(/@contact/);
    expect(r.captureHint).toMatch(/start/i);
  });

  it('a bare read with @contact capturing has NO captureHint', async () => {
    game = createTestWorld(); // @contact active by default
    const r = await journal({});
    expect(r.captures.active).toContain('@contact');
    expect(r.captureHint).toBeUndefined();
  });
});

describe('journal-events: a read never deletes — `clear` is retired, `sinceCap` is the baseline (#1561)', () => {
  /** `clear:true` made a READ destroy the ring it read — the evidence the next verification read
   *  depends on (mcp-tool-conventions.md §7). Its one real use was a clean baseline before an action,
   *  which the capture-counter cursor now gives without deleting anything. */
  type Read = {
    ok?: boolean; code?: string; error?: string; options?: string[];
    events: { type: string; cap: number }[]; returnedCount: number; totalCount: number; ringTotal: number;
    byType: Record<string, number>; nextCap: number; epoch: string; cursorReset?: string; truncated?: boolean; hint?: string;
  };
  const read = (args: Record<string, unknown>) => journal(args) as unknown as Promise<Read>;

  it('REFUSES clear — any value, filtered or not — with the replacement, and deletes nothing', async () => {
    game = createTestWorld();
    emit('match', { n: 1 });
    emit('score', { n: 2 });
    for (const args of [{ clear: true }, { clear: false }, { type: 'match', clear: true }]) {
      const r = await read(args);
      expect(r.ok, JSON.stringify(args)).toBe(false);
      expect(r.code).toBe('UNKNOWN_PARAM');
      expect(r.options).toEqual(['sinceCap', 'epoch']);
      expect(r.error).toMatch(/sinceCap/);
      expect(r.events).toBeUndefined();
    }
    expect((await read({})).events.map((e) => e.type)).toEqual(['match', 'score']);
  });

  it('a limit:0 read is a baseline: sinceCap=nextCap returns only what came after, counted as the ring', async () => {
    game = createTestWorld();
    emit('match', { n: 1 });
    emit('score', { n: 2 });
    const base = await read({ limit: 0 });
    expect(base.events).toEqual([]);
    emit('match', { n: 3 });
    emit('win', {});
    const after = await read({ sinceCap: base.nextCap, epoch: base.epoch });
    expect(after.events.map((e) => e.type)).toEqual(['match', 'win']);
    // The window IS the ring for this read — exactly what a clear used to make it.
    expect(after.ringTotal).toBe(2);
    expect(after.byType).toEqual({ match: 1, win: 1 });
    expect(after.cursorReset).toBeUndefined();
    // ...and nothing was deleted to get there.
    expect((await read({})).ringTotal).toBe(4);
  });

  it('a filter narrows the rows INSIDE the window; the window still counts every type', async () => {
    game = createTestWorld();
    emit('match', { n: 1 });
    const base = await read({ limit: 0 });
    emit('match', { n: 2 });
    emit('score', { n: 3 });
    const r = await read({ sinceCap: base.nextCap, epoch: base.epoch, type: 'match' });
    expect(r.events.map((e) => e.type)).toEqual(['match']);
    expect(r.totalCount).toBe(1);
    expect(r.ringTotal).toBe(2);
    expect(r.byType).toEqual({ match: 1, score: 1 });
  });

  it('a cursored read cut short returns the OLDEST after the cursor and continues with no gap', async () => {
    game = createTestWorld();
    const base = await read({ limit: 0 });
    for (let i = 0; i < 5; i++) emit('tick', { i });
    const seen: number[] = [];
    let cap = base.nextCap;
    for (let page = 0; page < 4; page++) {
      const r = await read({ sinceCap: cap, epoch: base.epoch, limit: 2 });
      seen.push(...r.events.map((e) => (e as unknown as { payload: { i: number } }).payload.i));
      cap = r.nextCap;
    }
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it('a cursored limit:0 read that is cut short read nothing, so its cursor does not move', async () => {
    game = createTestWorld();
    const base = await read({ limit: 0 });
    emit('match', { n: 1 });
    const r = await read({ sinceCap: base.nextCap, epoch: base.epoch, limit: 0 });
    expect(r.truncated).toBe(true);
    expect(r.nextCap).toBe(base.nextCap);
  });

  it('a cursor from an earlier life of the counter is reset and says so, not trusted', async () => {
    game = createTestWorld();
    for (let i = 0; i < 20; i++) emit('old', { i });
    const stale = await read({ limit: 0 });
    game.dispose(); // the harness teardown restarts the capture counter: a new life, as a reload does
    game = createTestWorld();
    emit('fresh', {});
    // With its epoch: detected even though nothing about the number looks wrong.
    const withEpoch = await read({ sinceCap: 0, epoch: stale.epoch });
    expect(withEpoch.cursorReset).toMatch(/restarted/);
    expect(withEpoch.events.map((e) => e.type)).toEqual(['fresh']);
    // Without it: a cursor past the newest cap cannot be from this life either.
    const noEpoch = await read({ sinceCap: stale.nextCap });
    expect(noEpoch.cursorReset).toMatch(/past the newest/);
    expect(noEpoch.events.map((e) => e.type)).toEqual(['fresh']);
    // And a current epoch is trusted as-is.
    expect((await read({ sinceCap: 0, epoch: noEpoch.epoch })).cursorReset).toBeUndefined();
    // A BLANK epoch is absent, not a different life — device_journal forwards "" (#1561 review).
    const blank = await read({ sinceCap: noEpoch.nextCap, epoch: '' });
    expect(blank.cursorReset).toBeUndefined();
    expect(blank.events).toEqual([]);
  });

  it('events LOST after the cursor are said out loud — eviction past the ring cap, or a clear (#1561 review)', async () => {
    game = createTestWorld();
    const base = await read({ limit: 0 });
    emit('match', { n: 1 });
    const quiet = await read({ sinceCap: base.nextCap, epoch: base.epoch }) as Read & { gapNote?: string };
    expect(quiet.gapNote).toBeUndefined();          // accept side: nothing lost, nothing claimed
    expect(quiet.hint ?? '').not.toMatch(/lost/);

    for (let i = 0; i < 10_050; i++) emit('tick', { i });   // 51 events past the 10,000 cap
    const r = await read({ sinceCap: base.nextCap, epoch: base.epoch, limit: 2 }) as Read & { gapNote?: string; droppedThroughCap?: number };
    expect(r.gapNote).toMatch(/were lost/);
    expect(r.droppedThroughCap).toBeGreaterThan(base.nextCap);
    expect(r.hint).not.toMatch(/with no gap/);
    // A cursor taken AFTER the loss has no gap.
    const fresh = await read({ limit: 0 });
    emit('match', { n: 2 });
    expect((await read({ sinceCap: fresh.nextCap, epoch: fresh.epoch }) as Read & { gapNote?: string }).gapNote).toBeUndefined();

    // A clear through the explicit clear-journal op is a loss too.
    const beforeClear = await read({ limit: 0 });
    emit('score', {});
    await runAgentOp('clear-journal', {});
    expect((await read({ sinceCap: beforeClear.nextCap, epoch: beforeClear.epoch }) as Read & { gapNote?: string }).gapNote).toMatch(/were lost/);
  });

  it('a non-numeric or negative sinceCap is refused, not read as "no cursor"', async () => {
    game = createTestWorld();
    for (const sinceCap of ['abc', -1, Number.NaN]) {
      const r = await read({ sinceCap });
      expect(r.code, String(sinceCap)).toBe('REFUSED_BY_OP');
      expect(r.events).toBeUndefined();
    }
  });
});

describe('journal-events: an unknown vocabulary value is REFUSED with a code and options (#1072)', () => {
  /** The CODE is what makes these refusals reach an agent as failures: this op answers a GET relay,
   *  and the MCP client does not check a plain read's `ok` — only its status, which `relayJson`
   *  derives from the code. `routeVocabularyForwarding.test.ts` drives the same thing through the
   *  route; these pin what the op itself decides. */
  type Refusal = { ok?: boolean; code?: string; error?: string; options?: string[]; events?: unknown; captures?: CaptureState };

  it('an unknown level: code + the levels, nothing read', async () => {
    game = createTestWorld();
    emit('match', { n: 1 });
    const r = await journal({ level: 'wran' }) as unknown as Refusal;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUSED_BY_OP');
    expect(r.options).toEqual(['info', 'warn', 'error']);
    expect(r.events).toBeUndefined();
    const after = await journal({}) as unknown as { events: unknown[] };
    expect(after.events).toHaveLength(1);
  });

  it('a non-string level is refused the same way, not thrown', async () => {
    game = createTestWorld();
    const r = await journal({ level: 2 }) as unknown as Refusal;
    expect(r.code).toBe('REFUSED_BY_OP');
  });

  it('an unknown action: code + the verbs, and the capture state is untouched', async () => {
    game = createTestWorld(); // @contact active by default
    const r = await journal({ action: 'strat', type: '@contact' }) as unknown as Refusal;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUSED_BY_OP');
    expect(r.options).toEqual(['start', 'stop']);
    expect(r.events).toBeUndefined(); // it did not fall through to a read
    expect(r.captures?.active).toContain('@contact');
  });
});

describe('journal-events: byType describes the RING, not the filtered slice', () => {
  it('a filtered read still reports the whole-ring histogram + its own filter', async () => {
    game = createTestWorld();
    emit('match', { n: 1 });
    emit('score', { n: 2 });
    emit('match', { n: 3 });
    const r = await journal({ type: 'match' }) as unknown as {
      returnedCount: number; totalCount: number; ringTotal: number; byType: Record<string, number>; filter?: Record<string, string>;
    };
    expect(r.returnedCount).toBe(2);       // returned
    expect(r.totalCount).toBe(2);       // matching the filter
    expect(r.ringTotal).toBe(3);   // in the ring
    // The histogram is the whole point: `{match:2}` alone reads as "this ring holds only matches".
    expect(r.byType).toEqual({ match: 2, score: 1 });
    expect(r.filter).toEqual({ type: 'match' });
  });

  it('an unfiltered read reports the same numbers on both keys, with no `filter` echo', async () => {
    game = createTestWorld();
    emit('match', { n: 1 });
    const r = await journal({}) as unknown as { totalCount: number; ringTotal: number; filter?: unknown };
    expect(r.totalCount).toBe(r.ringTotal);
    expect(r.filter).toBeUndefined();
  });
});
