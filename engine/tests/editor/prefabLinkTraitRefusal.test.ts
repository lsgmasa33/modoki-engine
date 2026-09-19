/** #1454: no GENERIC trait edit adds, removes or writes `PrefabInstance` — the prefab link is made by instantiating
 *  and cut by Detach Prefab, which ends the instance's frame (`endFrames`, #1453). Removed directly, the members
 *  moved out of the instance stayed linked to a dead frame and vanished on reload (the symptom test is in
 *  duplicateCarriesRefs.test.ts). One policy, `traitEditPolicy.ts`, answers every path; these drive each path. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestWorld, type TestWorld, setPlayState, findEntityByGuid, Transform, EntityAttributes, getTraitByName,
  traitRemoveRefusal, traitWriteRefusal,
} from '@modoki/engine/runtime';
import {
  clearHistory, markSceneSaved, canUndo, addTraitToEntitiesWithUndo, removeTraitFromEntitiesWithUndo,
} from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
});
afterEach(() => game.dispose());

const PI = () => getTraitByName('PrefabInstance')!;
const linked = (guid: string) => {
  const e = game.spawn(Transform(), EntityAttributes({ guid, name: guid }));
  e.add(PI().trait({ source: 'aaaaaaaa-0000-4000-8000-000000000001', localId: 1, rootInstanceId: e.id() } as never));
  return e.id();
};
const plain = (guid: string) => game.spawn(Transform(), EntityAttributes({ guid, name: guid })).id();
const hasLink = (guid: string) => findEntityByGuid(guid)!.has(PI().trait);

describe('the policy', () => {
  // The accept side: an ordinary component is removable and writable. Mutation: refuse every trait.
  it('refuses the prefab link and the core traits, and nothing else', () => {
    expect(traitRemoveRefusal('PrefabInstance')).toMatch(/Detach Prefab/);
    expect(traitWriteRefusal('PrefabInstance')).toMatch(/Detach Prefab/);
    expect(traitRemoveRefusal('Transform')).toMatch(/cannot remove core trait 'Transform'/);
    expect(traitRemoveRefusal('EntityAttributes')).toMatch(/cannot remove core trait/);
    expect(traitWriteRefusal('Transform')).toBeNull();
    expect(traitRemoveRefusal('Light')).toBeNull();
    expect(traitWriteRefusal('Light')).toBeNull();
  });
});

describe('the undo helpers (the Inspector, Add Component and every editor caller)', () => {
  // Mutation: drop the refusal in removeTraitFromEntitiesWithUndo.
  it('removeTraitFromEntitiesWithUndo leaves the link and pushes no undo entry', () => {
    const id = linked('r1');
    removeTraitFromEntitiesWithUndo([id], PI());
    expect(hasLink('r1')).toBe(true);
    expect(canUndo()).toBe(false);
  });

  // Mutation: drop the refusal in addTraitToEntitiesWithUndo.
  it('addTraitToEntitiesWithUndo adds no link and pushes no undo entry', () => {
    const id = plain('a1');
    addTraitToEntitiesWithUndo([id], PI());
    expect(hasLink('a1')).toBe(false);
    expect(canUndo()).toBe(false);
  });
});

describe("the agent's live apply-scene-ops", () => {
  // Mutation: drop the live removeTrait refusal (the helper's own refusal then hides it, but silently: no error).
  it('removeTrait PrefabInstance is refused with the reason, and the link stays', async () => {
    linked('l1');
    const r = await runAgentOp('apply-scene-ops', { ops: [{ op: 'removeTrait', entity: { guid: 'l1' }, trait: 'PrefabInstance' }] }) as { ok: boolean; changed: number; errors?: string[] };
    expect(r.changed).toBe(0);
    expect(JSON.stringify(r)).toMatch(/Detach Prefab/);
    expect(hasLink('l1')).toBe(true);
  });

  // Mutation: drop the live setTrait refusal.
  it('setTrait PrefabInstance is refused, adding no link and writing no field', async () => {
    plain('l2');
    linked('l3');
    const r = await runAgentOp('apply-scene-ops', { ops: [
      { op: 'setTrait', entity: { guid: 'l2' }, trait: 'PrefabInstance', fields: { localId: 5 } },
      { op: 'setTrait', entity: { guid: 'l3' }, trait: 'PrefabInstance', fields: { localId: 5 } },
    ] }) as { changed: number };
    expect(r.changed).toBe(0);
    expect(JSON.stringify(r)).toMatch(/Detach Prefab/);
    expect(hasLink('l2')).toBe(false);
    expect((findEntityByGuid('l3')!.get(PI().trait) as { localId: number }).localId).toBe(1);
  });
});

describe("the agent's live addEntity", () => {
  // Close-out review: addEntity carried arbitrary traits into createEntityWithUndo. Mutation: drop the live
  // addEntity refusal.
  it('an addEntity carrying PrefabInstance is refused whole, and nothing is created', async () => {
    const r = await runAgentOp('apply-scene-ops', { ops: [
      { op: 'addEntity', name: 'Fake', traits: { PrefabInstance: { source: 'aaaaaaaa-0000-4000-8000-000000000001', localId: 1 } } },
    ] }) as { changed: number };
    expect(r.changed).toBe(0);
    expect(JSON.stringify(r)).toMatch(/Detach Prefab/);
    expect(game.world.query(PI().trait).length).toBe(0);
  });
});

describe('the device set-traits (liveMutate)', () => {
  // Mutation: drop the refusal in liveMutate's parseWrites.
  it('a PrefabInstance field write is refused, and nothing is applied', async () => {
    plain('d1');
    const r = await runAgentOp('set-traits', { guid: 'd1', set: { 'PrefabInstance.localId': 3, 'Transform.x': 4 } }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Detach Prefab/);
    expect(hasLink('d1')).toBe(false);
    expect((findEntityByGuid('d1')!.get(Transform) as { x: number }).x).toBe(0);
  });
});
