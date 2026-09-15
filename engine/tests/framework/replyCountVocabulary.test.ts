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

registerAllTraits();
registerEditorAgentOps();

const RETIRED = new Set(['entityCount']);

/** Every path in `reply` whose key is a retired count name. */
function retiredKeys(reply: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, path: string) => {
    if (Array.isArray(v)) { v.forEach((el, i) => visit(el, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, el] of Object.entries(v)) {
        if (RETIRED.has(k)) out.push(`${path}.${k}`);
        visit(el, `${path}.${k}`);
      }
    }
  };
  visit(JSON.parse(JSON.stringify(reply ?? null)), '$');
  return out;
}

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
  ] as const)('%s %j', async (op, params) => {
    expect(retiredKeys(await runAgentOp(op, params))).toEqual([]);
  });
});

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
