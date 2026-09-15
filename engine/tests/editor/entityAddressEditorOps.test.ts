/** The EDITOR agent ops resolve entity addresses through the one shared resolver (#1223).
 *
 *  Driven the way production drives them (`runAgentOp` on the registered editor ops). The rules
 *  themselves are pinned in `tests/framework/entityAddressResolver.test.ts`; these pin that each
 *  editor seam actually reaches them. Each case names the mutation that turns it red. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState, Transform, EntityAttributes, UIEntry, getCurrentWorld, destroyEntity } from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefab';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
});
afterEach(() => { game?.dispose(); game = undefined; });

const guidOf = (e: { get(t: unknown): unknown }) => (e.get(EntityAttributes) as { guid: string }).guid;
const count = () => getCurrentWorld().entities.length;

describe('editor ops resolve addresses through entityRef.ts (#1223)', () => {
  // Mutation: requireLiveId resolves `{ guid: ref.guid }` alone when a guid is present (the old precedence).
  it('duplicate-entity with a guid AND an id is refused AMBIGUOUS, and nothing is duplicated (D1)', async () => {
    const a = game!.spawn(Transform(), EntityAttributes({ name: 'A' }));
    const b = game!.spawn(Transform(), EntityAttributes({ name: 'B' }));
    const before = count();
    await expect(runAgentOp('duplicate-entity', { guid: guidOf(a), id: b.id() })).rejects.toMatchObject({ code: 'AMBIGUOUS' });
    expect(count()).toBe(before);
  });

  // Mutation: resolveLiveIdOrSkip returns null for EVERY non-ok result (a D2 refusal silently skipped).
  it('delete-entities by the id of an entity that has a guid refuses the call and deletes nothing (D2)', async () => {
    const a = game!.spawn(Transform(), EntityAttributes({ name: 'A' }));
    const b = game!.spawn(Transform(), EntityAttributes({ name: 'B' }));
    await expect(runAgentOp('delete-entities', { guids: [guidOf(b)], ids: [a.id()] }))
      .rejects.toMatchObject({ code: 'REFUSED_BY_OP', options: [guidOf(a)] });
    expect(a.isAlive() && b.isAlive()).toBe(true);
  });

  // Mutation: in resolveParentId, go back to `p.parentGuid ? {guid} : p.parentId ? {id} : 0`.
  it('create-entity with parentGuid beside a non-zero parentId is refused, and creates nothing', async () => {
    const a = game!.spawn(Transform(), EntityAttributes({ name: 'A' }));
    const b = game!.spawn(Transform(), EntityAttributes({ name: 'B' }));
    const before = count();
    await expect(runAgentOp('create-entity', { spec: { kind: 'empty' }, parentGuid: guidOf(a), parentId: b.id() }))
      .rejects.toMatchObject({ code: 'AMBIGUOUS' });
    expect(count()).toBe(before);
  });

  // Close-out review: `parentId: 0` means "the root", so beside a parentGuid it is still two answers.
  // Mutation: in resolveParentId, treat `parentId === 0` as absent whenever parentGuid is given.
  it('create-entity with parentGuid beside parentId:0 is refused too — the root and a parent are two answers', async () => {
    const a = game!.spawn(Transform(), EntityAttributes({ name: 'A' }));
    const before = count();
    await expect(runAgentOp('create-entity', { spec: { kind: 'empty' }, parentGuid: guidOf(a), parentId: 0 }))
      .rejects.toMatchObject({ code: 'AMBIGUOUS' });
    expect(count()).toBe(before);
  });

  // Close-out review: get_editor_state reported the selection by id only, and set_selection now refuses
  // those ids — the smoke's own restore broke. Mutation: drop `guids` from readEditorState's selection.
  it('editor-state reports the selection guids, and set-selection accepts them back (the restore round trip)', async () => {
    const a = game!.spawn(Transform(), EntityAttributes({ name: 'A' }));
    const b = game!.spawn(Transform(), EntityAttributes({ name: 'B' }));
    await runAgentOp('set-selection', { guids: [guidOf(a), guidOf(b)] });
    const sel = (await runAgentOp('editor-state', {}) as { selection: { guid: string | null; guids: Array<string | null> } }).selection;
    expect(sel.guids).toEqual([guidOf(a), guidOf(b)]);
    expect(sel.guid).toBe(guidOf(b));
    await runAgentOp('set-selection', {});
    await expect(runAgentOp('set-selection', { guids: sel.guids })).resolves.toBeDefined();
    expect((await runAgentOp('editor-state', {}) as { selection: { guids: unknown[] } }).selection.guids).toEqual([guidOf(a), guidOf(b)]);
  });

  // Second review: `getAllEntities()` drops a PARKED pool row, so a guid map built from it reported null for
  // a selected entity that has a guid. Mutation: read the guids from a getAllEntities() map again.
  it('editor-state reports the guid of a selected parked pool row, not null', async () => {
    const row = game!.spawn(Transform(), EntityAttributes({ name: 'Row' }), UIEntry({ live: false }));
    await runAgentOp('set-selection', { guids: [guidOf(row)] });
    const sel = (await runAgentOp('editor-state', {}) as { selection: { guids: Array<string | null> } }).selection;
    expect(sel.guids).toEqual([guidOf(row)]);
  });

  // Mutation: drop `{ stale: miss.stale }` from delete-entities' all-miss OpRefusal.
  it('delete-entities whose every ref is a despawned runtime guid refuses NOT_FOUND with stale', async () => {
    const shot = game!.spawn(Transform(), EntityAttributes({ name: 'Shot' }));
    const guid = guidOf(shot);
    destroyEntity(shot);
    await expect(runAgentOp('delete-entities', { guids: [guid] })).rejects.toMatchObject({ code: 'NOT_FOUND', stale: 'despawned' });
  });

  // It used to take `p.parentId ?? 0` raw. Mutation: restore that in the prefab instantiate branch.
  it('prefab instantiate validates parentId — a stale one is refused NOT_FOUND, not written as an orphan link', async () => {
    const PATH = '/p1223.prefab.json';
    setPrefabCache(PATH, {
      id: 'c1223000-0000-4000-8000-000000000001', version: 2, name: 'Kit', rootLocalId: 1,
      entities: [{ localId: 1, name: 'Kit', traits: { EntityAttributes: { name: 'Kit', parentId: 0 }, Transform: {} } }],
    } as never);
    try {
      const before = count();
      await expect(runAgentOp('prefab', { action: 'instantiate', path: PATH, parentId: 99999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(count()).toBe(before);
    } finally { setPrefabCache(PATH, null); }
  });

  // Mutation: drop the `stale` spread from applySceneOpsLive's return.
  it('apply-scene-ops on a despawned runtime guid reports NOT_FOUND with stale in the reply (D4)', async () => {
    const shot = game!.spawn(Transform(), EntityAttributes({ name: 'Shot' }));
    const guid = guidOf(shot);
    destroyEntity(shot);
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { guid }, trait: 'Transform', fields: { x: 1 } }],
    }) as { ok: boolean; code?: string; stale?: string };
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND', stale: 'despawned' });
  });
});
