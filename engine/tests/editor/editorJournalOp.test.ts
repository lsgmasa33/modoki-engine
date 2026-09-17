/** The `editor-journal` agent op — tail + histogram at the boundary (mcp-response-budget Phase 6).
 *
 *  This op had NO test before. It is also the widest payload on the editor surface: `merged:1`
 *  used to return BOTH full rings, and the game events TWICE over (once raw under `game`, once
 *  again inside `timeline`). On a busy Play session that is hundreds of thousands of tokens.
 *
 *  The producers stay whole: `readEditorJournal()` and `journalEvents()` are read in-process by
 *  the Debug Menu's JournalTab, which does its own tail. Only the op summarizes. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  editorEmit, readEditorJournal, clearEditorJournal, setEditorJournalEnabled, withEditorActor,
} from '@modoki/engine/editor';
import {
  emit, journalEvents, clearJournal, setJournalEnabled, createTestWorld, type TestWorld,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { EDITOR_JOURNAL_TAIL_DEFAULT } from '../../app/debug/streamSummary';

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  clearEditorJournal(); clearJournal();
  setEditorJournalEnabled(true); setJournalEnabled(true);
});
afterEach(() => { game?.dispose(); game = undefined; });

// Mirrors the `editor`/`timeline` item shapes the op actually returns (readEditorJournal's
// EditorEvent — seq/cap/ts/type/source/payload — isn't exported from editorJournal.ts, so
// this is hand-typed rather than imported; kept accurate to that shape, not a partial guess).
type Result = {
  editor: Array<{ seq: number; cap: number; ts: number; type: string; source: 'human' | 'agent'; payload?: unknown }>;
  editorTotal: number; byType: Record<string, number>;
  truncated?: boolean; hint?: string;
  game?: unknown[]; gameTotal?: number; gameByType?: Record<string, number>;
  timeline?: Array<{ stream: 'editor' | 'game'; cap: number; ts: number; type: string }>;
  timelineTotal?: number;
};

describe('editor-journal: tail + histogram at the op', () => {
  it('bare read returns the last 100 with byType over the WHOLE ring', async () => {
    for (let i = 0; i < 130; i++) editorEmit(i % 10 === 0 ? '!create' : '!edit', { i });

    const r = await runAgentOp('editor-journal', {}) as Result;
    expect(r.editor).toHaveLength(100);
    expect(r.editorTotal).toBe(130);
    // 13 multiples of 10 in [0,129]. Counted over all 130, not over the 100 shown.
    expect(r.byType).toEqual({ '!create': 13, '!edit': 117 });
    expect(Object.values(r.byType).reduce((a, b) => a + b, 0)).toBe(r.editorTotal);
    expect(r.truncated).toBe(true);
    expect(r.hint).toContain('limit=N');

    // THE INVARIANT: the producer stays whole for JournalTab.
    expect(readEditorJournal()).toHaveLength(130);
  });

  it('an event type that scrolled off the tail is still COUNTED', async () => {
    editorEmit('!delete', { first: true });               // oldest
    for (let i = 0; i < 120; i++) editorEmit('!edit', { i });

    const r = await runAgentOp('editor-journal', {}) as Result;
    expect(r.editor.some((e) => e.type === '!delete')).toBe(false); // not shown
    expect(r.byType['!delete']).toBe(1);                            // but visible
  });

  it('an explicit limit wins over the default', async () => {
    for (let i = 0; i < 20; i++) editorEmit('!edit', { i });
    const r = await runAgentOp('editor-journal', { limit: 3 }) as Result;
    expect(r.editor).toHaveLength(3);
    expect(r.editorTotal).toBe(20);
  });

  it('type= and source= still shape the editor array', async () => {
    editorEmit('!edit', { a: 1 });
    editorEmit('!create', { b: 2 });
    const r = await runAgentOp('editor-journal', { type: '!create' }) as Result;
    expect(r.editorTotal).toBe(1);
    expect(r.editor[0].type).toBe('!create');
  });

  it('under the limit: no truncated flag, no hint', async () => {
    editorEmit('!save', {});
    const r = await runAgentOp('editor-journal', {}) as Result;
    expect(r.truncated).toBeUndefined();
    expect(r.hint).toBeUndefined();
  });
});

describe('editor-journal merged=1: BOTH streams are tailed', () => {
  it('tails `game` and `timeline`, and reports their totals', async () => {
    for (let i = 0; i < 40; i++) editorEmit('!edit', { i });
    for (let i = 0; i < 250; i++) emit(i % 5 === 0 ? 'score' : 'match', { i });

    const r = await runAgentOp('editor-journal', { merged: true }) as Result;

    // The raw game stream is tailed (it used to come back entire — 10,000 events at cap).
    expect(r.game).toHaveLength(100);
    expect(r.gameTotal).toBe(250);
    expect(r.gameByType).toEqual({ score: 50, match: 200 });

    // The interleaved axis is tailed LAST, so the newest correlated slice survives.
    expect(r.timelineTotal).toBe(290);          // 40 editor + 250 game
    expect(r.timeline).toHaveLength(100);
    expect(r.truncated).toBe(true);
    expect(r.hint).toContain('sinceCap');

    // Producers untouched.
    expect(journalEvents()).toHaveLength(250);
    expect(readEditorJournal()).toHaveLength(40);
  });

  it('the timeline keeps its interleaved ordering and stream tags', async () => {
    editorEmit('!play', {});
    emit('match', { i: 1 });
    editorEmit('!stop', {});

    const r = await runAgentOp('editor-journal', { merged: true }) as Result;
    expect(r.timeline!.map((e) => e.stream)).toEqual(['editor', 'game', 'editor']);
    expect(r.timelineTotal).toBe(3);
    expect(r.truncated).toBeUndefined(); // under the tail
  });

  it('sinceCap still windows the timeline (the precise cursor survives the tail)', async () => {
    editorEmit('!play', {});
    emit('match', { i: 1 });
    const first = await runAgentOp('editor-journal', { merged: true }) as Result & { timeline: Array<{ cap: number }> };
    const lastCap = first.timeline[first.timeline.length - 1].cap;

    emit('win', { i: 2 });
    const next = await runAgentOp('editor-journal', { merged: true, sinceCap: lastCap }) as Result;
    expect(next.timeline).toHaveLength(1); // only the newer event
  });

  it('limit=0 empties EVERY stream — including the hand-rolled timeline (slice(-0) trap)', () => {
    // `slice(-0)` is `slice(0)`: the whole array. The editor/game streams go through
    // tailWithCounts and were safe; the timeline was hand-rolled and returned BOTH full rings
    // for a caller who asked for zero events. That is the plan's ~582k-token worst case,
    // produced by the request that asked for the least.
    for (let i = 0; i < 5; i++) editorEmit('!edit', { i });
    for (let i = 0; i < 5; i++) emit('match', { i });
    return runAgentOp('editor-journal', { merged: true, limit: 0 }).then((r) => {
      const res = r as Result;
      expect(res.editor).toHaveLength(0);
      expect(res.game).toHaveLength(0);
      expect(res.timeline).toHaveLength(0);
      // ...but the totals and histograms still answer "what happened?"
      expect(res.editorTotal).toBe(5);
      expect(res.gameTotal).toBe(5);
      expect(res.timelineTotal).toBe(10);
      expect(res.byType).toEqual({ '!edit': 5 });
    });
  });

  it('a NaN limit falls back to the default rather than disabling the tail', async () => {
    for (let i = 0; i < 5; i++) editorEmit('!edit', { i });
    const r = await runAgentOp('editor-journal', { merged: true, limit: NaN }) as Result;
    expect(r.editor).toHaveLength(5);      // under the default of 100
    expect(r.timeline).toHaveLength(5);
  });

  it('without merged=1 there is no game/timeline at all', async () => {
    emit('match', { i: 1 });
    const r = await runAgentOp('editor-journal', {}) as Result;
    expect(r.game).toBeUndefined();
    expect(r.timeline).toBeUndefined();
    expect(r.gameTotal).toBeUndefined();
  });
});

// C7 re-audit: since/sinceCap are FORWARD cursors, so a cursored poll must return the OLDEST
// events after the cursor (contiguous) + a nextSeq/nextCap — NOT the newest tail, which would
// permanently drop the oldest-after-cursor block when >limit events accrue between polls.
describe('editor-journal: forward cursor windows oldest-after-cursor', () => {
  it('a cursored editor poll returns the OLDEST after `since` + nextSeq, not the newest tail', async () => {
    for (let i = 0; i < 130; i++) editorEmit('!edit', { i });
    const all = readEditorJournal() as Array<{ seq: number }>; // ascending, all 130
    const startSeq = all[0].seq;

    const r = await runAgentOp('editor-journal', { since: startSeq, limit: 50 }) as Result & { nextSeq: number; editor: Array<{ seq: number }> };
    expect(r.editor).toHaveLength(50);
    expect(r.editor[0].seq).toBe(all[1].seq);                        // the event right after the cursor
    expect(r.editor.some((e) => e.seq === all[all.length - 1].seq)).toBe(false); // NOT the newest 50
    expect(r.truncated).toBe(true);
    expect(r.nextSeq).toBe(r.editor[49].seq);

    // Advancing by nextSeq is contiguous — the next window begins at the very next event, no gap.
    const r2 = await runAgentOp('editor-journal', { since: r.nextSeq, limit: 50 }) as Result & { editor: Array<{ seq: number }> };
    const idx = all.findIndex((e) => e.seq === r.nextSeq);
    expect(r2.editor[0].seq).toBe(all[idx + 1].seq);
  });

  it('a cursored timeline poll returns the OLDEST after sinceCap + nextCap', async () => {
    for (let i = 0; i < 60; i++) emit('match', { i });
    const all = await runAgentOp('editor-journal', { merged: true, limit: 1000 }) as Result & { timeline: Array<{ cap: number }> };
    const caps = all.timeline.map((e) => e.cap);                     // ascending
    const r = await runAgentOp('editor-journal', { merged: true, sinceCap: caps[0] - 1, limit: 20 }) as Result & { nextCap: number; timeline: Array<{ cap: number }> };
    expect(r.timeline.map((e) => e.cap)).toEqual(caps.slice(0, 20)); // OLDEST 20, in order
    expect(r.truncated).toBe(true);
    expect(r.nextCap).toBe(caps[19]);
  });
});

// #28 — the long-poll twin of editor-journal.
describe('wait-for-edit op', () => {
  it('resolves immediately when a matching event is already pending', async () => {
    editorEmit('!edit');
    const r = await runAgentOp('wait-for-edit', { since: 0, timeoutMs: 5000 }) as { timedOut: boolean; events: unknown[] };
    expect(r.timedOut).toBe(false);
    expect(r.events).toHaveLength(1);
  });

  it('times out with {events:[], timedOut:true} — a normal result, not a thrown error', async () => {
    const r = await runAgentOp('wait-for-edit', { since: 0, timeoutMs: 20 }) as { timedOut: boolean; events: unknown[] };
    expect(r.timedOut).toBe(true);
    expect(r.events).toEqual([]);
  });

  it('defaults source to "human" — an agent-sourced edit does not wake it', async () => {
    const p = runAgentOp('wait-for-edit', { since: 0, timeoutMs: 200 }) as Promise<{ timedOut: boolean }>;
    withEditorActor('agent', () => editorEmit('!edit')); // must be ignored
    const r = await p;
    expect(r.timedOut).toBe(true);
  });

  it('a human edit wakes it before the deadline', async () => {
    const p = runAgentOp('wait-for-edit', { since: 0, timeoutMs: 5000 }) as Promise<{ timedOut: boolean; events: Array<{ type: string }> }>;
    editorEmit('!select');
    const r = await p;
    expect(r.timedOut).toBe(false);
    expect(r.events.map((e) => e.type)).toEqual(['!select']);
  });

  // Regression guard for the fix: this op is registered via the RAW op registry
  // (bypassing the `registerAgentOp` wrapper that shadows every other op), specifically
  // BECAUSE that wrapper holds the ambient actor='agent' for the whole lifetime of an
  // async handler — and this handler can legitimately be in flight for up to two minutes.
  // If it were wrapped, any human editor action committed anywhere while a wait-for-edit
  // call is parked would be mis-tagged source:'agent' in the journal.
  it('does NOT hold the ambient actor as "agent" while parked — a concurrent human edit stays tagged human', async () => {
    const p = runAgentOp('wait-for-edit', { since: 0, timeoutMs: 5000 }) as Promise<unknown>;
    await Promise.resolve(); // let the op start and register its listener
    editorEmit('!select'); // simulates an unrelated human UI action while the op is in flight
    expect(readEditorJournal()[0].source).toBe('human');
    await p; // resolves via the emit above — nothing left parked
  });
});

// #1214: `byType` described the FILTERED list, so a type filter that matched nothing read as an empty
// ring. It now describes the whole ring, beside `ringTotal`, like journal-events and console-logs.
describe('a filtered read still describes the whole ring (#1214)', () => {
  it('type filter that matches nothing: editorTotal 0, but ringTotal/byType show the ring', async () => {
    for (let i = 0; i < 3; i++) editorEmit('!select', { i });
    const r = await runAgentOp('editor-journal', { type: '!transform' }) as Result & { ringTotal: number };
    expect(r.editorTotal).toBe(0);
    expect(r.ringTotal).toBe(3);
    expect(r.byType).toEqual({ '!select': 3 });
  });
});

// #1214 B-3: `seq` restarts on a renderer reload, so a pre-reload cursor filtered out every new event.
describe('a cursor from an earlier journal life is reset, not trusted (#1214 B-3)', () => {
  type Cursored = Result & { epoch: string; cursorReset?: string };

  it('every reply carries the epoch, and a matching epoch keeps the cursor', async () => {
    editorEmit('!select');
    const first = await runAgentOp('editor-journal', {}) as Cursored;
    expect(typeof first.epoch).toBe('string');
    const seq = first.editor[0].seq;
    editorEmit('!edit');
    const next = await runAgentOp('editor-journal', { since: seq, epoch: first.epoch }) as Cursored;
    expect(next.editor.map((e) => e.type)).toEqual(['!edit']);
    expect(next.cursorReset).toBeUndefined();
  });

  it('a different epoch replays this life and says why', async () => {
    editorEmit('!select');
    editorEmit('!edit');
    const tip = readEditorJournal().at(-1)!.seq;
    const r = await runAgentOp('editor-journal', { since: tip, epoch: 'an-earlier-life' }) as Cursored;
    expect(r.editor.map((e) => e.type)).toEqual(['!select', '!edit']);
    expect(r.cursorReset).toMatch(/an-earlier-life/);
  });

  it('with no epoch, a cursor past the counter is reset too', async () => {
    editorEmit('!select');
    const r = await runAgentOp('editor-journal', { since: 1e9 }) as Cursored;
    expect(r.editor.map((e) => e.type)).toEqual(['!select']);
    expect(r.cursorReset).toMatch(/past the newest event/);
  });

  it('wait-for-edit with a stale cursor returns the pending events at once instead of parking', async () => {
    editorEmit('!select');
    const r = await runAgentOp('wait-for-edit', { since: 1e9, timeoutMs: 5_000 }) as { events: unknown[]; timedOut: boolean; cursorReset?: string };
    expect(r.timedOut).toBe(false);
    expect(r.events).toHaveLength(1);
    expect(r.cursorReset).toMatch(/past the newest event/);
  });

  it('wait-for-edit honours a mismatched epoch too, not only a cursor past the counter', async () => {
    editorEmit('!select');
    const tip = readEditorJournal().at(-1)!.seq;
    const r = await runAgentOp('wait-for-edit', { since: tip, epoch: 'an-earlier-life', timeoutMs: 5_000 }) as { events: unknown[]; timedOut: boolean; cursorReset?: string };
    expect(r.timedOut).toBe(false);
    expect(r.events).toHaveLength(1);
    expect(r.cursorReset).toMatch(/an-earlier-life/);
  });

  // Close-out review: a reset replays the whole life, and an uncapped reply past the transport's
  // text cap lost the very fields that announce the reset.
  it('a reset wait-for-edit is head-capped, contiguous, and leads with the cursor fields', async () => {
    for (let i = 0; i < EDITOR_JOURNAL_TAIL_DEFAULT + 5; i++) editorEmit('!select', { i });
    const r = await runAgentOp('wait-for-edit', { since: 1e9, timeoutMs: 5_000 }) as Record<string, unknown> & { events: Array<{ seq: number }>; nextSeq: number };
    expect(Object.keys(r)[0]).toBe('cursorReset');
    expect(Object.keys(r).at(-1)).toBe('events');
    expect(r.events).toHaveLength(EDITOR_JOURNAL_TAIL_DEFAULT);
    expect(r).toMatchObject({ truncated: true, totalCount: EDITOR_JOURNAL_TAIL_DEFAULT + 5 });
    expect(r.nextSeq).toBe(r.events.at(-1)!.seq);
    // The follow-up is a normal (non-reset) call, and it is capped too — capping only the reset
    // moved the flood to this call (close-out review).
    const next = await runAgentOp('wait-for-edit', { since: r.nextSeq, epoch: r.epoch, timeoutMs: 5_000 }) as Record<string, unknown> & { events: Array<{ seq: number }> };
    expect(next.events).toHaveLength(5);
    expect(next).not.toHaveProperty('truncated');
    expect(next).not.toHaveProperty('cursorReset');
    for (let i = 0; i < EDITOR_JOURNAL_TAIL_DEFAULT + 1; i++) editorEmit('!select', { i });
    const far = await runAgentOp('wait-for-edit', { since: next.events.at(-1)!.seq, epoch: r.epoch, timeoutMs: 5_000 }) as Record<string, unknown> & { events: unknown[] };
    expect(far.events).toHaveLength(EDITOR_JOURNAL_TAIL_DEFAULT);
    expect(far).toMatchObject({ truncated: true, totalCount: EDITOR_JOURNAL_TAIL_DEFAULT + 1, hint: expect.stringMatching(/Call again with since=/) });
  });

  it('a merged timeline cursor from an earlier life is reset too', async () => {
    editorEmit('!select');
    const r = await runAgentOp('editor-journal', { merged: true, sinceCap: 1e9, epoch: 'an-earlier-life' }) as { timeline: unknown[]; cursorReset?: string };
    expect(r.timeline.length).toBeGreaterThan(0);
    expect(r.cursorReset).toMatch(/sinceCap=1000000000 was issued under epoch an-earlier-life/);
    const same = await runAgentOp('editor-journal', { merged: true, sinceCap: 1e9, epoch: (r as unknown as { epoch: string }).epoch }) as { timeline: unknown[]; cursorReset?: string };
    expect(same.timeline).toHaveLength(0);
    expect(same.cursorReset).toBeUndefined();
  });

  it('a wait-for-edit timeout counts what arrived but did not match', async () => {
    const p = runAgentOp('wait-for-edit', { type: '!transform', timeoutMs: 50 }) as Promise<{ timedOut: boolean; epoch: string; skipped?: { total: number; byType: Record<string, number>; bySource: Record<string, number> } }>;
    editorEmit('!select');
    await withEditorActor('agent', () => editorEmit('!edit'));
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(typeof r.epoch).toBe('string');
    expect(r.skipped).toEqual({ total: 2, byType: { '!select': 1, '!edit': 1 }, bySource: { human: 1, agent: 1 } });
  });

  it('a quiet timeout carries no skipped block', async () => {
    const r = await runAgentOp('wait-for-edit', { timeoutMs: 50 }) as Record<string, unknown>;
    expect(r).toMatchObject({ timedOut: true });
    expect(r).not.toHaveProperty('skipped');
  });
});
