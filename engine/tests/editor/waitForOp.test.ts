// @vitest-environment jsdom
/** The `wait-for` op (#1154) through the real registry and the real readers — the seam the pure
 *  suite (waitFor.test.ts) cannot see: that each condition kind is bound to the resolver its
 *  matching read tool uses, and that an unevaluable condition is refused before parking. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { editorEmit, readEditorJournal, clearEditorJournal, setEditorJournalEnabled, withEditorActor } from '@modoki/engine/editor';
import { setRunMode, setManualNow, restoreRealClock, createTestWorld, Transform, EntityAttributes } from '@modoki/engine/runtime';
import { recordConsoleRingEntry } from '@modoki/engine/runtime/core/consoleRing';

registerAllTraits();
registerEditorAgentOps();

type Result = { satisfied: boolean; timedOut?: boolean; observation?: Record<string, unknown>; lastObservation?: Record<string, unknown> };

beforeEach(() => { setRunMode('stopped'); clearEditorJournal(); setEditorJournalEnabled(true); });
afterEach(() => { document.body.innerHTML = ''; });

async function refusalText(p: Promise<unknown>): Promise<string> {
  try { return JSON.stringify(await p); } catch (e) { return e instanceof Error ? e.message : String(e); }
}

describe('wait-for op', () => {
  it('refuses an unevaluable condition up front instead of timing out on it', async () => {
    const started = performance.now();
    const text = await refusalText(runAgentOp('wait-for', { chrome: {}, timeoutMs: 5000 }));
    expect(text).toMatch(/chrome needs a label or an id/);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('refuses a where naming an unknown trait — the scene-state parser, not a second copy', async () => {
    expect(await refusalText(runAgentOp('wait-for', { entity: { where: 'NoSuchTrait.x = 1' }, timeoutMs: 5000 }))).toMatch(/unknown trait "NoSuchTrait"/);
  });

  // #1223 D3: the reader asks scene-state for one example row (`limit:1`) and counts from `totalCount`,
  // which is every match. It fell back to `entityCount` when nothing was truncated; that field is gone.
  // Mutation: count from `returnedCount` (the one row) instead of `totalCount`.
  it('entity: matches counts every entity the query matched, not the one example row', async () => {
    const game = createTestWorld({});
    try {
      for (let i = 0; i < 3; i++) game.spawn(Transform(), EntityAttributes({ name: 'Waitee' }));
      const r = await runAgentOp('wait-for', { entity: { name: 'Waitee' }, timeoutMs: 50 }) as Result;
      expect(r).toMatchObject({ satisfied: true, observation: { matches: 3 } });
      const gone = await runAgentOp('wait-for', { entity: { name: 'Nobody', absent: true }, timeoutMs: 50 }) as Result;
      expect(gone).toMatchObject({ satisfied: true, observation: { matches: 0 } });
    } finally { game.dispose(); }
  });

  it('editor: reads the live editor state', async () => {
    const r = await runAgentOp('wait-for', { editor: { runMode: 'stopped' }, timeoutMs: 50 }) as Result;
    expect(r).toMatchObject({ satisfied: true, observation: { runMode: 'stopped' } });
  });

  it('chrome: reads the chrome handles modoki_handles reports, and wakes when the control appears', async () => {
    const p = runAgentOp('wait-for', { chrome: { id: 'wait-for-probe', value: 'ready' }, timeoutMs: 2000 }) as Promise<Result>;
    const add = (id: string, value: string) => {
      const input = document.createElement('input');
      input.setAttribute('data-ui-id', id);
      input.value = value;
      // chromeHandles drops a zero-size element, and jsdom lays nothing out.
      input.getBoundingClientRect = () => ({ x: 10, y: 10, width: 80, height: 20, top: 10, left: 10, right: 90, bottom: 30, toJSON: () => ({}) });
      document.body.appendChild(input);
    };
    // A decoy with a different id: an aim that ignored `id` would see two controls and stay ambiguous.
    add('wait-for-decoy', 'ready');
    setTimeout(() => add('wait-for-probe', 'ready'), 60);
    expect(await p).toMatchObject({ satisfied: true, observation: { matches: 1, id: 'wait-for-probe', meta: { value: 'ready' } } });
  });

  it('console: wakes on a ring entry recorded after the call', async () => {
    recordConsoleRingEntry('info', ['wait-for probe line']); // before: must not count
    const p = runAgentOp('wait-for', { console: { match: 'wait-for probe line' }, timeoutMs: 150 }) as Promise<Result>;
    expect(await p).toMatchObject({ satisfied: false, timedOut: true });
    const q = runAgentOp('wait-for', { console: { match: 'wait-for probe line' }, timeoutMs: 2000 }) as Promise<Result>;
    setTimeout(() => recordConsoleRingEntry('info', ['wait-for probe line']), 60);
    expect(await q).toMatchObject({ satisfied: true, observation: { text: 'wait-for probe line' } });
  });

  it('console lookbackMs: a line recorded just before the call is admitted by the real ring watermark', async () => {
    recordConsoleRingEntry('info', ['wait-for lookback probe']);
    const r = await runAgentOp('wait-for', { console: { match: 'wait-for lookback probe', lookbackMs: 5000 }, timeoutMs: 50 }) as Result;
    expect(r).toMatchObject({ satisfied: true, observation: { text: 'wait-for lookback probe' } });
  });

  it('console lookbackMs: a line OLDER than the window is still refused, through the real watermark', async () => {
    // The harness in waitFor.test.ts has its own watermark, so only this case can fail when the
    // op's cutoff loop is broken (close-out review 2 replaced it with "return 0" and nothing went red).
    try {
      // Far past any real `rawNow()` an earlier entry in this worker's ring can carry, so the ring
      // stays ordered by `mono` and the probe is the only thing the window decides about.
      setManualNow(1e12 - 60_000);
      recordConsoleRingEntry('info', ['wait-for stale lookback probe']);
      setManualNow(1e12);
      const r = await runAgentOp('wait-for', { console: { match: 'wait-for stale lookback probe', lookbackMs: 5000 }, timeoutMs: 50 }) as Result;
      expect(r).toMatchObject({ satisfied: false, timedOut: true });
    } finally {
      restoreRealClock();
    }
  });

  it('is not attributed: a human edit made during the park stays source:human', async () => {
    const p = runAgentOp('wait-for', { editor: { runMode: 'playing' }, timeoutMs: 150 });
    editorEmit('!select');
    await p;
    expect(readEditorJournal({ type: '!select' }).at(-1)?.source).toBe('human');
    // Premise check: the same emit inside an agent bracket IS attributed, so the assertion above can fail.
    withEditorActor('agent', () => editorEmit('!select'));
    expect(readEditorJournal({ type: '!select' }).at(-1)?.source).toBe('agent');
  });
});
