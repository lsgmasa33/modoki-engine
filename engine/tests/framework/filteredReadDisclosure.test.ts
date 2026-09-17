/** A filtered read that matches nothing must say what its filter left out (#1214,
 *  docs/mcp-tool-conventions.md §2 "A filtered read discloses its population").
 *
 *  The #1208 sweep found 17 of 33 filtered reads answering an empty result with nothing beside it, so
 *  a typo'd filter read exactly like "nothing exists" — and no shared rule made a read disclose, so
 *  each one re-decided. This runs the REAL ops with a filter that cannot match, over a world where the
 *  unfiltered read is NOT empty, and fails unless the reply carries the whole-ring numbers (a ring) or
 *  a hint naming the unfiltered count (a set). A read added to this table with neither goes red; so
 *  does any listed read that regresses. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestWorld, type TestWorld, EntityAttributes, Transform, setPlayState, registerBoundsProvider, emit, clearJournal,
} from '@modoki/engine/runtime';
import { editorEmit, clearEditorJournal } from '@modoki/engine/editor';
import { recordConsoleRingEntry } from '@modoki/engine/runtime/core/consoleRing';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld;
let unregister: () => void = () => {};

beforeAll(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  const a = game.spawn(Transform(), EntityAttributes({ name: 'Player', layer: '3d' })).id();
  game.spawn(Transform(), EntityAttributes({ name: 'Enemy', layer: '3d' }));
  unregister = registerBoundsProvider(() => [
    { id: a, layer: '3d', screen: { x: 0, y: 0, w: 10, h: 10 }, onScreen: true, surface: 'game-3d' },
  ], 'game-3d');
  clearEditorJournal(); clearJournal();
  editorEmit('!select');
  emit('match', {});
  // Straight into the shared ring — vitest does not install the console capture.
  recordConsoleRingEntry('warn', ['filteredReadDisclosure: a warning, so the ring is not empty']);
});

afterAll(() => {
  unregister();
  game.dispose();
});

/** A set read: an empty filtered result must carry a hint naming the unfiltered population. */
const SETS = [
  ['scene-state', { name: 'Plyer' }, 'entity'],
  ['scene-state', { where: 'Transform.x > 1000' }, 'entity'],
  ['layout-bounds', { layer: '2d' }, 'rect'],
] as const;

/** A ring read: every filtered result carries `ringTotal` and a non-empty whole-ring histogram. */
const RINGS = [
  ['console-logs', { level: 'error' }, 'byLevel'],
  ['journal-events', { type: 'no-such-event' }, 'byType'],
  ['editor-journal', { type: '!transform' }, 'byType'],
] as const;

describe('a SET read that matched nothing names what exists', () => {
  it.each(SETS)('%s %j', async (op, params, what) => {
    const r = await runAgentOp(op, params) as { totalCount?: number; hint?: string };
    expect(r.totalCount).toBe(0);
    expect(r.hint).toMatch(new RegExp(`no ${what} matches .*, but [1-9]\\d* [a-z ]*exist`));
  });

  it('a name miss lists the closest live name first', async () => {
    const r = await runAgentOp('scene-state', { name: 'Plyer' }) as { hint: string };
    expect(r.hint).toMatch(/name ∈ \{Player, /);
  });

  it('a layer miss names the layers that DO have rects', async () => {
    const r = await runAgentOp('layout-bounds', { layer: '2d' }) as { hint: string; layerCounts: Record<string, number> };
    expect(r.layerCounts).toEqual({});
    expect(r.hint).toMatch(/layer ∈ \{3d\}/);
  });

  // Close-out review: the second pass dropped only `layer`, so a typo'd name beside it answered
  // "0 unfiltered — the filter is not why this is empty" while the name was exactly why.
  it('a layer miss counts the population with NO filter, not just without layer', async () => {
    const r = await runAgentOp('layout-bounds', { layer: '2d', name: 'Plyer' }) as { hint: string };
    expect(r.hint).toMatch(/no rect matches layer=2d, name=Plyer, but 1 exist with no filter/);
  });

  // Close-out review: the op's own "Stats only" sentence overwrote readWatch's hint on every
  // default (samples:false) read — the MCP path — so the fix never reached a caller.
  it('watch-read keeps the empty-filter hint on the default stats read', async () => {
    const started = await runAgentOp('watch-start', { component: 'Transform', fields: ['x'] }) as { id: string };
    try {
      const r = await runAgentOp('watch-read', { id: started.id, name: 'Plyer' }) as { hint?: string; seriesTotal: number };
      expect(r.seriesTotal).toBe(0);
      expect(r.hint).toMatch(/^no series matches name=Plyer/);
      const bare = await runAgentOp('watch-read', { id: started.id }) as { hint?: string };
      expect(bare.hint).toMatch(/^Stats only/);
    } finally { await runAgentOp('watch-clear', { id: started.id }); }
  });

  // The accept side: a filter that DID match gets no empty-filter hint.
  it('a filter that matched carries no empty-filter hint', async () => {
    const r = await runAgentOp('scene-state', { name: 'Play' }) as { totalCount: number; hint?: string };
    expect(r.totalCount).toBe(1);
    expect(r.hint ?? '').not.toMatch(/exist unfiltered/);
    const l = await runAgentOp('layout-bounds', { layer: '3d' }) as { hint?: string };
    expect(l.hint ?? '').not.toMatch(/exist unfiltered/);
  });

  // A stale guid is already explained by its own warning; the hint would only repeat it.
  it('a guid miss keeps its own warning and adds no second explanation', async () => {
    const r = await runAgentOp('scene-state', { guid: 'no-such-guid' }) as { warnings?: string[]; hint?: string };
    expect(r.warnings?.join(' ')).toMatch(/matched no entity/);
    expect(r.hint).toBeUndefined();
  });
});

describe('a RING read describes the whole ring whatever the filter', () => {
  it.each(RINGS)('%s %j', async (op, params, hist) => {
    const r = await runAgentOp(op, params) as Record<string, unknown>;
    expect(r.totalCount ?? r.editorTotal).toBe(0);
    expect(r.ringTotal).toBeGreaterThan(0);
    expect(Object.keys(r[hist] as object).length).toBeGreaterThan(0);
  });
});
