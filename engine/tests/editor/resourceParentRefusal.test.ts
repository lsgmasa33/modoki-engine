/** Nothing is parented under a resource entity, on any path that creates a parent link (#1248).
 *
 *  Since #1248 every entity carries EntityAttributes, so the Transient Time and Input singletons are
 *  Hierarchy rows with guids. A child under one is dropped from every save and Play snapshot along with
 *  its parent. `reparentRefusal` guarded the moves; these are the CREATING paths a close-out review found
 *  still writing the link unchecked, each driven the way production drives it (the editor agent ops, the
 *  Hierarchy's cross-scene move). One case per path, each naming the mutation that turns it red. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestWorld, type TestWorld, setPlayState, Transform, EntityAttributes, Input, getCurrentWorld,
  parentOrRootFor, reparentRefusal,
} from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved, serializeScene } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefab';
import { Transient } from '../../packages/modoki/src/runtime/core/traits/Transient';
import { moveEntityToScene } from '../../packages/modoki/src/editor/undo/entityActions';
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

const parentOf = (id: number) => ((getCurrentWorld().entities.find((e) => e.id() === id)!.get(EntityAttributes)) as { parentId: number }).parentId;
const guidOf = (e: { get(t: unknown): unknown }) => (e.get(EntityAttributes) as { guid: string }).guid;
const spawnInput = () => game!.spawn(Input(), Transient);

describe('a resource entity holds no children (#1248)', () => {
  // Mutation: drop `refuseResourceParent` from agentEditorOps.ts's resolveParentId.
  it('editor create-entity with a resource parentGuid is refused, and nothing is created', async () => {
    const input = spawnInput();
    const before = getCurrentWorld().entities.length;
    await expect(runAgentOp('create-entity', { spec: { kind: 'empty' }, parentGuid: guidOf(input) }))
      .rejects.toThrow(/is a resource/);
    expect(getCurrentWorld().entities.length).toBe(before);
  });

  // Mutation: drop the parentRefusal re-root in apply-scene-ops' addEntity branch.
  it('apply-scene-ops addEntity under a resource is created at the ROOT, with a warning', async () => {
    const input = spawnInput();
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'addEntity', name: 'Kid', parentId: guidOf(input), traits: { Transform: {} } }],
    }) as { created: Array<{ id: number }>; warnings?: string[] };
    expect(parentOf(r.created[0].id)).toBe(0);
    expect(r.warnings?.join('\n')).toMatch(/is a resource/);
  });

  // The close-out re-review's probe: the parent given ONLY inside the authored EntityAttributes, no op.name.
  // Mutation: restore the `else if (op.name)` guard on the EntityAttributes merge.
  it('apply-scene-ops addEntity with the resource parent INSIDE authored EntityAttributes also lands at the root', async () => {
    const input = spawnInput();
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'addEntity', traits: { Transform: {}, EntityAttributes: { name: 'Kid', parentId: input.id() } } }],
    }) as { created: Array<{ id: number }>; warnings?: string[] };
    expect(parentOf(r.created[0].id)).toBe(0);
    expect(r.warnings?.join('\n')).toMatch(/is a resource/);
    const saved = await serializeScene();
    expect(saved.entities.map((e) => e.name)).toContain('Kid');
  });

  // Accept side of the same merge: a REAL parent given only in authored EntityAttributes is honoured.
  it('apply-scene-ops addEntity honours an ordinary parent given only inside authored EntityAttributes', async () => {
    const box = game!.spawn(Transform(), EntityAttributes({ name: 'Box' }));
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'addEntity', traits: { Transform: {}, EntityAttributes: { name: 'Kid', parentId: guidOf(box) } } }],
    }) as { created: Array<{ id: number }> };
    expect(parentOf(r.created[0].id)).toBe(box.id());
  });

  // Mutation: drop `refuseResourceParent` from the prefab op's instantiate branch.
  it('prefab instantiate under a resource parentGuid is refused', async () => {
    const input = spawnInput();
    const PATH = '/p1248.prefab.json';
    setPrefabCache(PATH, {
      id: 'c1248000-0000-4000-8000-000000000001', version: 2, name: 'Kit', rootLocalId: 1,
      entities: [{ localId: 1, name: 'Kit', traits: { EntityAttributes: { name: 'Kit', parentId: 0 }, Transform: {} } }],
    } as never);
    try {
      await expect(runAgentOp('prefab', { action: 'instantiate', path: PATH, parentGuid: guidOf(input) }))
        .rejects.toThrow(/is a resource/);
    } finally { setPrefabCache(PATH, null); }
  });

  // Mutation: drop `{ move: true }` from reparent-entity's resolveParentId call.
  it('agent reparent-entity allows a reorder under the resource parent the entity already has', async () => {
    const input = spawnInput();
    const kid = game!.spawn(Transform(), EntityAttributes({ name: 'Kid', parentId: input.id() }));
    await expect(runAgentOp('reparent-entity', { guid: guidOf(kid), parentGuid: guidOf(input), sortOrder: 5 }))
      .resolves.toBeDefined();
    // …while a NEW link under it is still refused.
    const other = game!.spawn(Transform(), EntityAttributes({ name: 'Other' }));
    await expect(runAgentOp('reparent-entity', { guid: guidOf(other), parentGuid: guidOf(input) })).rejects.toThrow(/resource/);
  });

  // Mutation: drop the reparentRefusal check in apply-scene-ops' setTrait branch.
  it('apply-scene-ops setTrait EntityAttributes.parentId onto a resource is refused and leaves the parent alone', async () => {
    const input = spawnInput();
    const kid = game!.spawn(Transform(), EntityAttributes({ name: 'Kid' }));
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { guid: guidOf(kid) }, trait: 'EntityAttributes', fields: { parentId: input.id() } }],
    }) as { errors: string[] };
    expect(r.errors.join('\n')).toMatch(/refused \(resource\)/);
    expect(parentOf(kid.id())).toBe(0);
  });

  // Mutation: drop `&& !parentRefusal(opts.newParentId)` in entityActions.ts's moveEntityToScene.
  it('a cross-scene move dropped on a resource row re-roots, so the moved entity is still saved', async () => {
    const input = spawnInput();
    const base = game!.spawn(Transform(), EntityAttributes({ name: 'BaseThing', sourceScene: 'b0000000-0000-4000-8000-000000000001' }));
    const res = moveEntityToScene(base.id(), '', { newParentId: input.id() });
    expect(res.ok).toBe(true);
    expect(res.reRooted).toBe(true);
    expect(parentOf(base.id())).toBe(0);
    const saved = await serializeScene();
    expect(saved.entities.map((e) => e.name)).toContain('BaseThing');
  });

  it('parentOrRootFor re-roots only a resource parent', () => {
    const input = spawnInput();
    const plain = game!.spawn(Transform(), EntityAttributes({ name: 'Plain' }));
    expect(parentOrRootFor(input.id())).toBe(0);
    expect(parentOrRootFor(plain.id())).toBe(plain.id());
    expect(parentOrRootFor(0)).toBe(0);
  });

  // Mutation: drop `newParentId !== currentParentOf(entityId)` in hierarchy.ts's reparentRefusal.
  it('a reorder under the parent an entity ALREADY has is legal, even when that parent is a resource', () => {
    const input = spawnInput();
    // A legacy link a scene file authored — the refusal judges new links only.
    const kid = game!.spawn(Transform(), EntityAttributes({ name: 'Kid', parentId: input.id() }));
    expect(reparentRefusal(kid.id(), input.id())).toBeNull();
    expect(reparentRefusal(kid.id(), 0)).toBeNull(); // …and it can still be moved out
  });
});
