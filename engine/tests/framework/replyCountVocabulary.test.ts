/** Count fields mean one thing on every reply (#1217, #1223 D3; docs/mcp-tool-conventions.md §2).
 *
 *  `entityCount` meant three things: the rows get_scene_state returned (after its default resource
 *  filter), every entity in the world (editor state, load_scene, the `!scene-load` journal event), and
 *  the distinct entities behind get_layout_bounds' rects. An agent that mutated and then compared two
 *  tools' `entityCount` saw them disagree by a constant nothing explained (F8: 136 vs 137). The names now:
 *  - `returnedCount` — rows in this reply; `totalCount` — everything the query matched before a limit.
 *    Both present whenever a filter or limit could apply (get_scene_state: always).
 *  - `worldEntityTotal` — every entity in the world, resources included.
 *  - `entityTotal` — distinct entities behind a rect count (get_layout_bounds).
 *
 *  Like replyEntityNaming.test.ts this runs the REAL ops and walks each reply, so a count field added
 *  later under the old name to any op listed below is caught without anyone naming the field. The
 *  load-scene ops are not walked: the editor's (and its `!scene-load` event) needs a real scene load,
 *  pinned by loadSceneTailSupersede.test.ts's `toEqual` on the payload, and the device's is replaced by
 *  the editor's once editor ops register, so liveLifecycleOps.test.ts pins it on both success returns. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestWorld, type TestWorld, EntityAttributes, Transform, setPlayState, registerBoundsProvider, getAllEntities,
} from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { retiredCountKeys } from '@modoki/engine/testing/replyVocabulary';

registerAllTraits();
registerEditorAgentOps();

// The retired names and the walker live in a shared helper so a GAME's tool tests walk their
// replies with the same rule (#1561) — `@modoki/engine/testing/replyVocabulary`.
const retiredKeys = retiredCountKeys;

let game: TestWorld;
let unregister: () => void = () => {};

beforeAll(() => {
  game = createTestWorld({}); // the harness spawns its Time singleton, a RESOURCE entity
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
  const a = game.spawn(Transform(), EntityAttributes({ name: 'CountA', layer: '3d' })).id();
  game.spawn(Transform(), EntityAttributes({ name: 'CountB', layer: '3d' }));
  game.spawn(Transform(), EntityAttributes({ name: 'Other', layer: '3d' }));
  // One 3D entity measured by TWO surfaces, as the editor's Scene and Game panels both do: two rects, one entity.
  unregister = registerBoundsProvider(() => [
    { id: a, layer: '3d', screen: { x: 0, y: 0, w: 10, h: 10 }, onScreen: true, surface: 'scene-view' },
    { id: a, layer: '3d', screen: { x: 5, y: 5, w: 10, h: 10 }, onScreen: true, surface: 'game-3d' },
  ], 'game-3d');
});

afterAll(() => {
  unregister();
  game.dispose();
});

type SceneReply = { returnedCount?: number; totalCount?: number; resourcesExcluded?: number; truncated?: boolean; entities: unknown[] };

describe('the walker', () => {
  it('flags a retired name at any depth, and nothing else', () => {
    expect(retiredKeys({ entityCount: 1 })).toEqual(['$.entityCount']);
    expect(retiredKeys({ a: [{ b: { entityCount: 0 } }] })).toEqual(['$.a[0].b.entityCount']);
    expect(retiredKeys({ returnedCount: 1, totalCount: 2, worldEntityTotal: 3, entityTotal: 1 })).toEqual([]);
  });

  // #1266: the top-level/nested split. Mutation: drop the `path === '$'` clause and the nested
  // case below is flagged too, which is what took `diagnose`'s four qualified counts red.
  it('flags a bare top-level count/total, and leaves a nested one alone', () => {
    expect(retiredKeys({ count: 1 })).toEqual(['$.count']);
    expect(retiredKeys({ total: 1 })).toEqual(['$.total']);
    expect(retiredKeys({ refs: { issues: [], count: 0 } })).toEqual([]);
    expect(retiredKeys({ ringTotal: 9 })).toEqual([]);
    // …but a retired name is still caught at ANY depth.
    expect(retiredKeys({ refs: { entityCount: 0 } })).toEqual(['$.refs.entityCount']);
  });
});

describe('no reply emits entityCount (#1223 D3)', () => {
  it.each([
    ['scene-state', {}],
    ['scene-state', { name: 'Count' }],
    ['scene-state', { limit: 1 }],
    ['scene-state', { resources: true, full: true }],
    ['layout-bounds', {}],
    ['layout-bounds', { entities: true, limit: 1 }],
    ['editor-state', {}],
    ['set-selection', { guids: [] }],
    ['diagnose', {}],
    ['journal-events', {}],
    ['editor-journal', {}],
    // #1266 widened the walk to the three ops that spelled `count`/`total`: the journals and the
    // console ring answer both, `enact-handles` answered a bare `count`, and `diagnose`'s video
    // cache carried a third.
    ['console-logs', {}],
    ['console-logs', { level: 'warn' }],
    ['enact-handles', {}],
  ] as const)('%s %j', async (op, params) => {
    expect(retiredKeys(await runAgentOp(op, params))).toEqual([]);
  });
});

// The journals' and the console ring's THREE-number contract (returnedCount / totalCount /
// ringTotal) is not re-asserted here. `ringBufferSeams.test.ts` and `journalControlOp.test.ts`
// already pin it on a SEEDED ring, where the three genuinely differ — a check here would read
// `typeof x === 'number'` on an empty ring, which passes whatever the numbers mean. This file's
// job for those ops is the walk above: the retired names are gone from their replies.

// `enact-handles`' own counts are NOT asserted here either, for the reason above plus a sharper
// one: this file registers no handle provider and jsdom exposes no `[data-ui-id]` chrome, so the
// op answers ZERO handles — a check here would be `0 === 0` against two fields that
// `handlesDump.ts` sets from the SAME expression, which no mutation can tell apart. The real cover
// is `tests/electron/handlesDump.test.ts` (seeded providers, 2/2 and 1/1) for the producer, and
// `tests/tools/handlesReplyShape.test.ts` for the summary that must DROP `returnedCount`. The walk
// above is this file's job for it: the retired names are gone from the reply.

describe('get_scene_state: returnedCount + totalCount, both always (§2)', () => {
  // The rule's own words: a total that appears only when truncation happened is not recoverable.
  // Mutation: emit totalCount only when `truncated`, as before.
  it('a filtered read with no limit carries both', async () => {
    const r = await runAgentOp('scene-state', { name: 'Count' }) as SceneReply;
    expect(r.returnedCount).toBe(2);
    expect(r.totalCount).toBe(2);
    expect(r.truncated).toBeUndefined();
  });

  it('a limit that bites: returnedCount is the rows, totalCount every match', async () => {
    const r = await runAgentOp('scene-state', { name: 'Count', limit: 1 }) as SceneReply;
    expect(r.entities).toHaveLength(1);
    expect(r).toMatchObject({ returnedCount: 1, totalCount: 2, truncated: true });
  });

  // F8's constant: the untargeted read drops resources, so it sits below the world total by exactly the
  // resources it left out. Mutation: drop `resourcesExcluded` from dumpSceneState's reply.
  it('the bare index names the resources its default filter left out, which close the gap to worldEntityTotal', async () => {
    const bare = await runAgentOp('scene-state', {}) as SceneReply;
    const state = await runAgentOp('editor-state', {}) as { worldEntityTotal: number };
    expect(bare.resourcesExcluded).toBeGreaterThanOrEqual(1);
    expect(bare.totalCount! + bare.resourcesExcluded!).toBe(state.worldEntityTotal);
    const withResources = await runAgentOp('scene-state', { resources: true }) as SceneReply;
    expect(withResources.resourcesExcluded).toBeUndefined();
    expect(withResources.totalCount).toBe(state.worldEntityTotal);
  });
});

describe('editor state: worldEntityTotal counts the whole world', () => {
  // Mutation: count `all.filter((e) => !e.isResource)` in readEditorState.
  it('equals every entity, resources included', async () => {
    const r = await runAgentOp('editor-state', {}) as { worldEntityTotal: number };
    expect(r.worldEntityTotal).toBe(getAllEntities().length);
    expect(getAllEntities().some((e) => e.isResource)).toBe(true); // the fixture can tell the two apart
  });
});

describe('get_layout_bounds: totalCount/returnedCount count rects, entityTotal entities', () => {
  // Mutation: entityTotal = entries.length.
  it('one entity on two surfaces is two rects and one entity', async () => {
    const r = await runAgentOp('layout-bounds', {}) as { totalCount: number; entityTotal: number; returnedCount?: number; surfaceNote?: string };
    expect(r.totalCount).toBe(2);
    expect(r.entityTotal).toBe(1);
    expect(r.returnedCount).toBeUndefined(); // no rects came back on a counts-only call
    expect(r.surfaceNote).toContain('`entityTotal`');
  });

  // Mutation: returnedCount = entries.length.
  it('a limit on the rect list: returnedCount is what came back, totalCount every rect', async () => {
    const r = await runAgentOp('layout-bounds', { entities: true, limit: 1 }) as { totalCount: number; returnedCount: number; truncated?: boolean; entities: unknown[] };
    expect(r.entities).toHaveLength(1);
    expect(r).toMatchObject({ returnedCount: 1, totalCount: 2, truncated: true });
  });
});
