/** #1216 C-6 / #1223 P4 — a delete names what its cascade took, on both surfaces.
 *
 *  Both `delete-entities` ops remove the whole subtree of every entity they are given, and answered only
 *  with the entities they were named: deleting a parent removed its children without a word. They now
 *  add `alsoDeleted` (guids), capped, with `alsoDeletedTotal` past the cap. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestWorld, type TestWorld, EntityAttributes, Transform, setPlayState, guidOfEntityId, findEntityByGuid,
} from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { deleteEntitiesLive } from '../../app/debug/liveLifecycle';
import { ALSO_DELETED_CAP, descendantsOf } from '../../app/debug/entityRef';

registerAllTraits();
registerEditorAgentOps();

type DeleteReply = { deleted: string[]; alsoDeleted?: string[]; alsoDeletedTotal?: number };

let game: TestWorld;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
});
afterEach(() => game.dispose());

/** P → C → G, plus a sibling S under P — DURABLE guids, so the editor's mint changes none of them and a
 *  guid read before the delete is the one the reply must name. (The undo case below uses runtime guids.) */
function tree() {
  const d = (n: number) => `d1216c60-0000-4000-8000-00000000000${n}`;
  const p = game.spawn(Transform(), EntityAttributes({ name: 'P', guid: d(1) })).id();
  const c = game.spawn(Transform(), EntityAttributes({ name: 'C', guid: d(2), parentId: p })).id();
  const g = game.spawn(Transform(), EntityAttributes({ name: 'G', guid: d(3), parentId: c })).id();
  const s = game.spawn(Transform(), EntityAttributes({ name: 'S', guid: d(4), parentId: p })).id();
  const guids = new Map([p, c, g, s].map((id) => [id, guidOfEntityId(id)!]));
  const guid = (id: number) => guids.get(id)!;
  return { p, c, g, s, guid };
}

describe.each([
  { surface: 'editor', del: async (args: object) => await runAgentOp('delete-entities', args) as DeleteReply },
  { surface: 'device', del: async (args: object) => deleteEntitiesLive(args) as DeleteReply },
])('$surface delete-entities', ({ del }) => {
  // Mutation: drop `...also` from the op's reply.
  it('names the descendants a parent\'s delete took with it', async () => {
    const t = tree();
    const r = await del({ guid: t.guid(t.p) });
    expect(r.deleted).toEqual([t.guid(t.p)]);
    expect(new Set(r.alsoDeleted)).toEqual(new Set([t.guid(t.c), t.guid(t.g), t.guid(t.s)]));
    expect(r.alsoDeletedTotal).toBeUndefined();
  });

  // Mutation: in descendantsOf, seed `seen` with nothing instead of the roots.
  it('an entity that was named is in `deleted`, never also in `alsoDeleted`', async () => {
    const t = tree();
    const r = await del({ guids: [t.guid(t.p), t.guid(t.c)] });
    expect(new Set(r.alsoDeleted)).toEqual(new Set([t.guid(t.g), t.guid(t.s)]));
  });

  it('a leaf delete carries no `alsoDeleted` at all', async () => {
    const t = tree();
    expect(await del({ guid: t.guid(t.g) })).not.toHaveProperty('alsoDeleted');
  });

  // Mutation: drop the `alsoDeletedTotal` spread, or slice past the cap.
  it('past the cap it names the first ones and counts them all', async () => {
    const p = game.spawn(Transform(), EntityAttributes({ name: 'Big' })).id();
    const n = ALSO_DELETED_CAP + 5;
    for (let i = 0; i < n; i++) game.spawn(Transform(), EntityAttributes({ name: `k${i}`, parentId: p }));
    const r = await del({ guid: guidOfEntityId(p)! });
    expect(r.alsoDeleted).toHaveLength(ALSO_DELETED_CAP);
    expect(r.alsoDeletedTotal).toBe(n);
  });
});

/** #1262 — `apply-scene-ops`' removeEntity is the same cascade in a third tool, and answered `changed:1`. */
describe('editor apply-scene-ops removeEntity', () => {
  type OpsReply = DeleteReply & { changed: number; alsoDeletedNoGuidIds?: number[] };
  const remove = async (...guids: string[]) =>
    await runAgentOp('apply-scene-ops', { ops: guids.map((guid) => ({ op: 'removeEntity', entity: { guid } })) }) as OpsReply;

  // Mutation: drop `alsoDeleted.add(...)` in applySceneOpsLive, or the op wrapper's `alsoDeleted` spread.
  it('names the descendants a parent\'s remove took with it', async () => {
    const t = tree();
    const r = await remove(t.guid(t.p));
    expect(r.changed).toBe(1);
    expect(new Set(r.alsoDeleted)).toEqual(new Set([t.guid(t.c), t.guid(t.g), t.guid(t.s)]));
    expect(r).not.toHaveProperty('alsoDeletedTotal');
  });

  it('a leaf remove carries no `alsoDeleted` at all', async () => {
    const t = tree();
    expect(await remove(t.guid(t.g))).not.toHaveProperty('alsoDeleted');
  });

  // Mutation: build the tally per op instead of once per call (only the last op's cascade survives).
  it('lists across every remove in the call', async () => {
    const t = tree();
    const r = await remove(t.guid(t.c), t.guid(t.s));
    expect(r.changed).toBe(2);
    expect(r.alsoDeleted).toEqual([t.guid(t.g)]);
    const q = game.spawn(Transform(), EntityAttributes({ name: 'Q' })).id();
    game.spawn(Transform(), EntityAttributes({ name: 'Q1', parentId: q }));
    const w = game.spawn(Transform(), EntityAttributes({ name: 'W' })).id();
    game.spawn(Transform(), EntityAttributes({ name: 'W1', parentId: w }));
    expect((await remove(guidOfEntityId(q)!, guidOfEntityId(w)!)).alsoDeleted).toHaveLength(2);
  });

  // Mutation: drop the op wrapper's `alsoDeletedTotal` spread.
  it('past the cap it names the first ones and counts them all', async () => {
    const p = game.spawn(Transform(), EntityAttributes({ name: 'Big' })).id();
    const n = ALSO_DELETED_CAP + 5;
    for (let i = 0; i < n; i++) game.spawn(Transform(), EntityAttributes({ name: `k${i}`, parentId: p }));
    const r = await remove(guidOfEntityId(p)!);
    expect(r.alsoDeleted).toHaveLength(ALSO_DELETED_CAP);
    expect(r.alsoDeletedTotal).toBe(n);
  });

  // Mutation: drop the `ensureGuid` loop before the remove — the runtime guids named would be re-minted on undo.
  it('every alsoDeleted guid resolves after undo', async () => {
    const p = game.spawn(Transform(), EntityAttributes({ name: 'RP' })).id();
    const c = game.spawn(Transform(), EntityAttributes({ name: 'RC', parentId: p })).id();
    game.spawn(Transform(), EntityAttributes({ name: 'RG', parentId: c }));
    expect(guidOfEntityId(c)).toMatch(/^00000000-/);
    const r = await remove(guidOfEntityId(p)!);
    expect(r.alsoDeleted).toHaveLength(2);
    await runAgentOp('undo', {});
    for (const guid of r.alsoDeleted ?? []) expect(findEntityByGuid(guid), guid).toBeDefined();
  });
});

describe('editor: a named descendant\'s guid is the one undo brings back', () => {
  // The editor mints durable guids over runtime ones before its undo snapshot; a descendant it named by
  // its RUNTIME guid would be re-minted on undo, and the reply's guid would name nothing.
  // Mutation: drop the `ensureGuid` loop over the descendants.
  it('every alsoDeleted guid resolves after undo', async () => {
    const p = game.spawn(Transform(), EntityAttributes({ name: 'RP' })).id();
    const c = game.spawn(Transform(), EntityAttributes({ name: 'RC', parentId: p })).id();
    game.spawn(Transform(), EntityAttributes({ name: 'RG', parentId: c }));
    expect(guidOfEntityId(c)).toMatch(/^00000000-/);
    const r = await runAgentOp('delete-entities', { guid: guidOfEntityId(p)! }) as DeleteReply;
    expect(r.alsoDeleted).toHaveLength(2);
    await runAgentOp('undo', {});
    for (const guid of r.alsoDeleted ?? []) expect(findEntityByGuid(guid), guid).toBeDefined();
  });
});

describe('descendantsOf', () => {
  // `EntityAttributes.parentId` is a plain field, so a parent cycle is reachable (liveMutate's
  // guardParentWrite blocks new ones; this walk must still end on an old one).
  it('terminates on a parent cycle and never lists a root', () => {
    const a = game.spawn(Transform(), EntityAttributes({ name: 'A' })).id();
    const b = game.spawn(Transform(), EntityAttributes({ name: 'B', parentId: a })).id();
    game.world.query(EntityAttributes).forEach((e) => { if (e.id() === a) e.set(EntityAttributes, { name: 'A', parentId: b }); });
    expect(descendantsOf([a])).toEqual([b]);
  });
});
