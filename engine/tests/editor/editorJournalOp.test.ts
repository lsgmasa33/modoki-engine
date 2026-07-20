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
  editorEmit, readEditorJournal, clearEditorJournal, setEditorJournalEnabled,
} from '@modoki/engine/editor';
import {
  emit, journalEvents, clearJournal, setJournalEnabled, createTestWorld, type TestWorld,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  clearEditorJournal(); clearJournal();
  setEditorJournalEnabled(true); setJournalEnabled(true);
});
afterEach(() => { game?.dispose(); game = undefined; });

type Result = {
  editor: Array<{ type: string }>; editorTotal: number; byType: Record<string, number>;
  truncated?: boolean; hint?: string;
  game?: unknown[]; gameTotal?: number; gameByType?: Record<string, number>;
  timeline?: Array<{ stream: string }>; timelineTotal?: number;
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
