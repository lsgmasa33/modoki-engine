/** Integration: the Phase-6 ring-buffer seams sit at the BOUNDARY, not in the producer.
 *
 *  Each of these streams has an in-process consumer that reads the producer directly:
 *    - `diagnose` reads `dumpConsoleLogs({level:'error'}).logs`  (agentBridge, module-private)
 *    - `WatchTab.tsx` imports `readWatch` and renders `series[].samples` into a Sparkline
 *    - `JournalTab.tsx` imports `journalEvents()` and tail-slices its own view
 *    - `inputRoutes.ts` calls the `enact-handles` OP to resolve tap_handle coordinates
 *
 *  So the summaries live in the agent ops (and, for handles, in the HTTP router — because
 *  `inputRoutes` consumes the op itself). If a future refactor pushes a default tail down
 *  into a producer, the human's sparkline goes blank and `modoki_diagnose` quietly stops
 *  reporting errors, with nothing failing. These tests are that alarm.
 *
 *  See docs/mcp-response-budget.md — "shape the payload at the BOUNDARY, never in the PRODUCER". */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld } from 'koota';
import {
  createTestWorld, type TestWorld, Transform, EntityAttributes, Time, setCurrentWorld,
  emit, journalEvents, clearJournal, setJournalEnabled,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { computeDiagnostics } from '../../app/debug/diagnose';
import { runAgentOp, dumpSceneState } from '../../app/debug/agentBridge';
import { startWatch, readWatch, clearWatch, __tickWatchesForTest } from '../../app/debug/watch';
import { registerHandleProvider } from '@modoki/engine/runtime';

registerAllTraits();

let game: TestWorld | undefined;
beforeEach(() => { game = createTestWorld({}); clearJournal(); clearWatch(); });
afterEach(() => { game?.dispose(); game = undefined; vi.restoreAllMocks(); });

/** Load the bridge fresh (module-private console ring starts empty), with console.* silenced
 *  BEFORE capture wraps it, so 100+ seeded entries don't spam the test output. */
async function freshBridge() {
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const mod = await import('../../app/debug/agentBridge');
  mod.installConsoleCapture();
  return mod;
}

describe('console-logs: the op tails, the producer does not', () => {
  it('a bare op read returns the last 50 + a byLevel histogram of the WHOLE ring', async () => {
    const { runAgentOp } = await freshBridge();
    for (let i = 0; i < 120; i++) console.log(`msg ${i}`);
    console.error('boom'); // an error at the very end

    const r = await runAgentOp('console-logs', {}) as {
      logs: Array<{ text: string }>; total: number; byLevel: Record<string, number>; truncated?: boolean; hint?: string;
    };
    expect(r.logs.length).toBe(50);
    expect(r.total).toBe(121);
    // The histogram covers everything, not just the 50 shown — the error is at index 120,
    // so it IS in the tail here; the "counted but not shown" case is covered in
    // streamSummary.test.ts.
    expect(r.byLevel.log).toBe(120);
    expect(r.byLevel.error).toBe(1);
    expect(r.truncated).toBe(true);
    expect(r.hint).toContain('limit=N');
  });

  it('an error that scrolled off the tail is still COUNTED', async () => {
    const { runAgentOp } = await freshBridge();
    console.error('early boom');                       // oldest
    for (let i = 0; i < 60; i++) console.log(`m${i}`); // pushes it out of the last-50 window

    const r = await runAgentOp('console-logs', {}) as {
      logs: Array<{ level: string }>; byLevel: Record<string, number>;
    };
    expect(r.logs.some((l) => l.level === 'error')).toBe(false); // not shown
    expect(r.byLevel.error).toBe(1);                              // but visible in the counts
  });

  it('an explicit limit overrides the default', async () => {
    const { runAgentOp } = await freshBridge();
    for (let i = 0; i < 30; i++) console.log(`m${i}`);
    const r = await runAgentOp('console-logs', { limit: 3 }) as { logs: unknown[]; total: number };
    expect(r.logs).toHaveLength(3);
    expect(r.total).toBe(30);
  });

  it('diagnose reads the PRODUCER, so it is unaffected by the op-level tail', async () => {
    // The failure this guards: push the tail into `dumpConsoleLogs` and diagnose's error list
    // silently truncates. diagnose applies its own slice(-20) — the point is that what reaches
    // it is the full producer output, not a 50-entry excerpt.
    await freshBridge();
    const errors = Array.from({ length: 80 }, (_, i) => ({ level: 'error' as const, ts: 0, text: `E${i}` }));
    const r = computeDiagnostics({ consoleErrors: errors });
    expect(r.consoleErrors.length).toBe(20);                    // diagnose's own cap
    expect(r.consoleErrors[19].text).toBe('E79');               // the NEWEST error survived
    expect(r.ok).toBe(false);
  });
});

describe('journal-events: the op tails, journalEvents() stays whole', () => {
  it('bare read tails to 100 with byType over the whole ring; journalEvents() is untouched', async () => {
    setJournalEnabled(true);
    for (let i = 0; i < 150; i++) emit(i % 5 === 0 ? 'score' : 'match', { i });

    const r = await runAgentOp('journal-events', {}) as {
      count: number; total: number; byType: Record<string, number>; events: unknown[]; truncated?: boolean;
    };
    expect(r.events).toHaveLength(100);
    expect(r.count).toBe(100);
    expect(r.total).toBe(150);
    expect(r.byType).toEqual({ score: 30, match: 120 });
    expect(r.truncated).toBe(true);

    // THE INVARIANT: the producer still returns everything, for JournalTab.
    expect(journalEvents()).toHaveLength(150);
  });

  it('type= narrows and limit= overrides', async () => {
    setJournalEnabled(true);
    for (let i = 0; i < 20; i++) emit('match', { i });
    for (let i = 0; i < 5; i++) emit('win', { i });

    const only = await runAgentOp('journal-events', { type: 'win' }) as { total: number };
    expect(only.total).toBe(5);
    const few = await runAgentOp('journal-events', { limit: 2 }) as { events: unknown[] };
    expect(few.events).toHaveLength(2);
  });
});

describe('watch-read: the op strips samples, readWatch keeps them for WatchTab', () => {
  /** The sampler normally runs off a frameDriver rAF callback, which `createTestWorld.step()`
   *  does not drive. Without ticking it, `series` is EMPTY — and a `for (const s of series)`
   *  assertion then passes vacuously, no matter what the code does. (It did, on the first
   *  draft of this file.) So: build a koota world with a Time entity and tick explicitly. */
  function watchWorld() {
    const w = createWorld();
    setCurrentWorld(w);
    const timeEnt = w.spawn(Time({ frame: 0 }));
    const tick = (frame: number, mutate?: () => void) => {
      timeEnt.set(Time, { ...timeEnt.get(Time)!, frame });
      mutate?.();
      __tickWatchesForTest();
    };
    return { w, tick };
  }

  it('bare read returns stats without samples; samples=true returns them', async () => {
    const { w, tick } = watchWorld();
    const e = w.spawn(EntityAttributes({ guid: 'ball', name: 'Ball' }), Transform({ x: 0 }));

    const started = startWatch({ component: 'Transform', guids: ['ball'], fields: ['x'] });
    expect(started.ok).toBe(true);
    tick(1);
    tick(2, () => e.set(Transform, { ...e.get(Transform)!, x: 5 }));
    tick(3, () => e.set(Transform, { ...e.get(Transform)!, x: 2 }));

    const bare = await runAgentOp('watch-read', { id: started.id }) as {
      ok: boolean; series: Array<Record<string, unknown>>; totalSamples: number; hint?: string;
    };
    expect(bare.ok).toBe(true);
    expect(bare.series.length).toBeGreaterThan(0);   // guard against a vacuous pass
    expect(bare.totalSamples).toBeGreaterThan(0);
    for (const s of bare.series) {
      expect('samples' in s).toBe(false);
      expect(s.stats).toBeTruthy();                  // stats are what replaced them
    }
    expect(bare.hint).toContain('samples=true');

    const raw = await runAgentOp('watch-read', { id: started.id, samples: true }) as {
      series: Array<{ samples?: Array<{ value: number }> }>;
    };
    expect(raw.series.length).toBeGreaterThan(0);
    expect(raw.series[0].samples?.map((p) => p.value)).toEqual([0, 5, 2]);

    // THE INVARIANT: the producer always carries samples — WatchTab.tsx:89 renders them into
    // a Sparkline. Stripping them THERE (rather than at the op) blanks the human's chart.
    const direct = readWatch(started.id!) as { series: Array<{ samples?: unknown[] }> };
    expect(direct.series.length).toBeGreaterThan(0);
    for (const s of direct.series) expect(Array.isArray(s.samples)).toBe(true);
  });

  it('a missing watch id still reports its error, unwrapped', async () => {
    const r = await runAgentOp('watch-read', { id: 'nope' }) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('nope');
  });

  it('a bare read DEFAULTS to a 100-series cap (F7); an explicit limit overrides it', async () => {
    const { w, tick } = watchWorld();
    // 120 entities, one field each → 120 moving series on a broad (no guids/names) Transform watch.
    const ents = Array.from({ length: 120 }, (_, i) =>
      w.spawn(EntityAttributes({ guid: `e${i}`, name: `E${i}` }), Transform({ x: 0 })));
    const started = startWatch({ component: 'Transform', fields: ['x'] });
    expect(started.ok).toBe(true);
    tick(1);
    tick(2, () => ents.forEach((e, i) => e.set(Transform, { ...e.get(Transform)!, x: i + 1 }))); // all move

    // Bare read (no limit): capped at 100, and the truncation is announced — not a silent 120-series flood.
    const bare = await runAgentOp('watch-read', { id: started.id }) as { series: unknown[]; seriesTotal: number; seriesTruncated?: boolean };
    expect(bare.series).toHaveLength(100);
    expect(bare.seriesTotal).toBe(120);
    expect(bare.seriesTruncated).toBe(true);

    // An explicit (larger) limit still returns everything — the default is a backstop, not a ceiling.
    const all = await runAgentOp('watch-read', { id: started.id, limit: 500 }) as { series: unknown[]; seriesTruncated?: boolean };
    expect(all.series).toHaveLength(120);
    expect(all.seriesTruncated).toBeUndefined();
  });
});

/** THE ARCHITECTURAL EXCEPTION, pinned.
 *
 *  Every other stream summarizes in its agent op. `enact-handles` must NOT, because
 *  `engine/electron/inputRoutes.ts:168` calls that op directly —
 *  `requestRenderer('enact-handles', {ids:[id]})` — to turn a handle id into coordinates for
 *  `tap_handle`/`drag_handle`. Summarize the op and trusted input breaks with a 404 while the
 *  router tests, the inputRoutes tests (which mock the op) and the handlesDump tests (which call
 *  the producer) all stay green. That gap was real: a reviewer mutated the op to strip
 *  `handles[]` and 95 tests passed. This is the missing alarm.
 *
 *  The SUMMARY lives in the router — see editorActionRouter.test.ts. */
describe('enact-handles: the OP is a passthrough — the ROUTER summarizes', () => {
  let unregister: (() => void) | undefined;
  afterEach(() => { unregister?.(); unregister = undefined; });

  it('the op returns full handle geometry, never counts', async () => {
    unregister = registerHandleProvider(() => [
      { id: 'chrome.btn', kind: 'button', editor: 'chrome', x: 11, y: 22 },
      { id: 'dope.key.0', kind: 'keyframe', editor: 'dopesheet', x: 33, y: 44 },
    ]);

    const r = await runAgentOp('enact-handles', {}) as {
      handles?: Array<{ id: string; x: number; y: number }>;
      byEditor?: unknown; byKind?: unknown;
    };
    expect(Array.isArray(r.handles)).toBe(true);
    expect(r.handles).toHaveLength(2);
    // Coordinates must survive — inputRoutes reads .x/.y off this to aim a trusted click.
    expect(r.handles![0]).toMatchObject({ id: 'chrome.btn', x: 11, y: 22 });
    // And the op must NOT have applied the router's summary shape.
    expect(r.byEditor).toBeUndefined();
    expect(r.byKind).toBeUndefined();
  });

  it('an ids= query (the tap_handle resolution path) returns that handle with coordinates', async () => {
    unregister = registerHandleProvider(() => [
      { id: 'want', kind: 'button', editor: 'chrome', x: 7, y: 8 },
      { id: 'other', kind: 'button', editor: 'chrome', x: 1, y: 2 },
    ]);
    // Exactly what engine/electron/inputRoutes.ts:168 issues.
    const r = await runAgentOp('enact-handles', { ids: ['want'] }) as { handles?: Array<{ id: string; x: number; y: number }> };
    expect(r.handles).toHaveLength(1);
    expect(r.handles![0]).toMatchObject({ id: 'want', x: 7, y: 8 });
  });
});

/** Float precision is applied at the OP, never in the producer.
 *
 *  `dumpSceneState` / `computeLayoutBounds` / `readWatch` feed the editor's Inspector, gizmos and
 *  Sparkline in-process. Rounding there would quietly degrade what the human sees and edits —
 *  the same class of mistake as summarizing in a producer, but harder to spot because the numbers
 *  still look plausible. */
describe('float precision: the op rounds, the producer stays exact', () => {
  const EXACT = 247.13061935179246;
  const ROUNDED = 247.130619;

  it('scene-state op rounds to 9 sig; dumpSceneState keeps float64', async () => {
    game!.spawn(Transform({ x: EXACT }), EntityAttributes({ name: 'Precise', guid: 'p-guid' }));

    const viaOp = await runAgentOp('scene-state', { trait: 'Transform', name: 'Precise' }) as {
      entities: Array<{ traits: { Transform: { x: number } } }>;
    };
    expect(viaOp.entities[0].traits.Transform.x).toBe(ROUNDED);

    // THE INVARIANT: the producer is untouched.
    const direct = dumpSceneState({ trait: 'Transform', name: 'Precise' });
    expect((direct.entities[0] as { traits: { Transform: { x: number } } }).traits.Transform.x).toBe(EXACT);
  });

  it('precision=0 returns the exact float64 through the op', async () => {
    game!.spawn(Transform({ x: EXACT }), EntityAttributes({ name: 'Exact', guid: 'e-guid' }));
    const r = await runAgentOp('scene-state', { trait: 'Transform', name: 'Exact', precision: 0 }) as {
      entities: Array<{ traits: { Transform: { x: number } } }>;
    };
    expect(r.entities[0].traits.Transform.x).toBe(EXACT);
  });

  it('a garbage precision falls back to the default rather than disabling rounding', async () => {
    game!.spawn(Transform({ x: EXACT }), EntityAttributes({ name: 'Garbage', guid: 'g2-guid' }));
    const r = await runAgentOp('scene-state', { trait: 'Transform', name: 'Garbage', precision: NaN }) as {
      entities: Array<{ traits: { Transform: { x: number } } }>;
    };
    expect(r.entities[0].traits.Transform.x).toBe(ROUNDED);
  });

  it('integer-valued fields (id, parentId, entityCount) are never touched', async () => {
    game!.spawn(Transform({ x: EXACT }), EntityAttributes({ name: 'Ints', guid: 'i-guid' }));
    const r = await runAgentOp('scene-state', { name: 'Ints' }) as { entityCount: number; entities: Array<{ id: number }> };
    expect(Number.isInteger(r.entities[0].id)).toBe(true);
    expect(Number.isInteger(r.entityCount)).toBe(true);
  });
});
