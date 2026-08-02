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

describe('journal-events: a FILTERED read must not destroy the rest of the ring', () => {
  /** `clear:true` used to call clearJournal() unconditionally — so a filtered read returned its
   *  slice and wiped every OTHER event too, including the human's. The ring is flat and has no
   *  selective clear, so the honest move is to refuse rather than over-delete: destroying data the
   *  caller did not ask about, and never saw, is not something to do on a best guess. */
  const emitSome = () => {
    emit('match', { n: 1 });
    emit('score', { n: 2 });
    emit('match', { n: 3 });
  };

  it('REFUSES clear:true when a filter is present, and clears NOTHING', async () => {
    game = createTestWorld();
    emitSome();
    const r = await journal({ type: 'match', clear: true }) as unknown as { ok?: boolean; error?: string; hint?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/REFUSED/);
    expect(r.error).toMatch(/type=match/);
    // The load-bearing half: the score event the caller never asked about is still there.
    const after = await journal({}) as unknown as { events: { type: string }[] };
    expect(after.events.map((e) => e.type).sort()).toEqual(['match', 'match', 'score']);
  });

  it('an UNFILTERED clear:true still clears everything — that one really does mean ALL', async () => {
    game = createTestWorld();
    emitSome();
    await journal({ clear: true });
    const after = await journal({}) as unknown as { events: unknown[] };
    expect(after.events).toHaveLength(0);
  });
});

describe('journal-events: byType describes the RING, not the filtered slice', () => {
  it('a filtered read still reports the whole-ring histogram + its own filter', async () => {
    game = createTestWorld();
    emit('match', { n: 1 });
    emit('score', { n: 2 });
    emit('match', { n: 3 });
    const r = await journal({ type: 'match' }) as unknown as {
      count: number; total: number; ringTotal: number; byType: Record<string, number>; filter?: Record<string, string>;
    };
    expect(r.count).toBe(2);       // returned
    expect(r.total).toBe(2);       // matching the filter
    expect(r.ringTotal).toBe(3);   // in the ring
    // The histogram is the whole point: `{match:2}` alone reads as "this ring holds only matches".
    expect(r.byType).toEqual({ match: 2, score: 1 });
    expect(r.filter).toEqual({ type: 'match' });
  });

  it('an unfiltered read reports the same numbers on both keys, with no `filter` echo', async () => {
    game = createTestWorld();
    emit('match', { n: 1 });
    const r = await journal({}) as unknown as { total: number; ringTotal: number; filter?: unknown };
    expect(r.total).toBe(r.ringTotal);
    expect(r.filter).toBeUndefined();
  });
});
