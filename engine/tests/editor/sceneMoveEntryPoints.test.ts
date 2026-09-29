/** Every way an entity's scene FILE can change asks one question, and a CREATED entity belongs to its target
 *  (#1757, #1760).
 *
 *  `EntityAttributes.sourceScene` names the file that saves an entity. #1757: the prefab `instance-member` refusal
 *  was asked by `planReparent` only, while the Hierarchy's scene-group, scene-folder and empty-area drops called
 *  `moveEntityToScene` directly — one instance split across two files, and later edits to the moved member were
 *  written nowhere. Three generic field writers wrote the stamp raw as well. #1760: a paste kept its SOURCE's stamp
 *  at the root, so after a scene load the copy named a scene that was not loaded and was saved into no file.
 *
 *  Each case drives the call production makes and names the mutation that turns it red. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestWorld, type TestWorld, setPlayState, Transform, EntityAttributes, getCurrentWorld, applyOps, type MutableScene,
} from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved, serializeScene, canUndo, undo, redo, writeTraitFieldWithUndo } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefab';
import { isSceneDirty, clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import {
  moveEntityToScene, sceneMoveRefusal, planReparent, pasteEntityCopy, clipEntity, cutSourceId, planSceneDrop, sceneDropTarget,
} from '../../packages/modoki/src/editor/undo/entityActions';
import { getTraitByName } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

const BASE = 'b1757000-0000-4000-8000-000000000001';
const BASE_FILE = { path: '/assets/scenes/Base1757.json', guid: BASE };
const PATH = '/p1757.prefab.json';

let game: TestWorld | undefined;
const freshWorld = () => {
  game?.dispose();
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
  clearAllSceneDirty();
};
beforeEach(() => {
  freshWorld();
  setPrefabCache(PATH, {
    id: 'c1757000-0000-4000-8000-000000000001', version: 2, name: 'Kit', rootLocalId: 1,
    entities: [
      { localId: 1, name: 'Kit', traits: { EntityAttributes: { name: 'Kit', parentId: 0 }, Transform: {} } },
      { localId: 2, name: 'Slot', traits: { EntityAttributes: { name: 'Slot', parentId: 1 }, Transform: {} } },
    ],
  } as never);
});
afterEach(() => { setPrefabCache(PATH, null); game?.dispose(); game = undefined; clearAllSceneDirty(); });

type Ent = { id(): number; get(t: unknown): unknown };
const live = (id: number) => getCurrentWorld().entities.find((e) => e.id() === id)!;
const attrs = (id: number) => live(id).get(EntityAttributes) as { parentId: number; sourceScene: string; guid: string; name: string };
const byName = (name: string) => getCurrentWorld().entities.find((e) => (e.get(EntityAttributes) as { name?: string } | undefined)?.name === name)!.id();
const spawn = (name: string, extra: Record<string, unknown> = {}) =>
  game!.spawn(Transform(), EntityAttributes({ name, guid: crypto.randomUUID(), ...extra })) as unknown as Ent;
const saved = async (scene?: typeof BASE_FILE) => JSON.stringify((await serializeScene(scene ? { scene } : undefined)).entities);

/** A Kit/Slot instance instantiated live. `inBase` stamps it as a base scene's instance, as a chain load does. */
async function instance(inBase: boolean): Promise<{ root: number; slot: number }> {
  const { rootId } = await runAgentOp('prefab', { action: 'instantiate', path: PATH }) as { rootId: number };
  const slot = byName('Slot');
  if (inBase) for (const id of [rootId, slot]) live(id).set(EntityAttributes, { ...attrs(id), sourceScene: BASE });
  clearHistory(); markSceneSaved(); clearAllSceneDirty();
  return { root: rootId, slot };
}

describe('moveEntityToScene asks the scene-move refusal itself (#1757)', () => {
  // The empty-area demote and a drop on the primary's group call moveEntityToScene(id, '') with no planReparent.
  // Mutation: drop the `sceneMoveRefusal` check at the top of moveEntityToScene.
  it('a base instance MEMBER demoted to the primary is refused, and a later edit still reaches the base file', async () => {
    const { slot } = await instance(true);
    const res = moveEntityToScene(slot, '');
    expect(res).toMatchObject({ ok: false, reason: 'instance-member', movedIds: [] });
    expect(attrs(slot).sourceScene).toBe(BASE);
    expect(canUndo()).toBe(false);
    // The issue's repro: the edit after the drop must dirty the base, the one file that writes Slot.
    writeTraitFieldWithUndo(slot, getTraitByName('Transform')!, 'x', 9);
    expect(isSceneDirty(BASE)).toBe(true);
    expect(await saved()).not.toContain(attrs(slot).guid);
  });

  // The scene-group / scene-folder drop onto a base: moveEntityToScene(id, BASE). Same mutation, other direction.
  it('a primary instance member promoted to a base is refused, nothing stamped', async () => {
    const { slot, root } = await instance(false);
    expect(moveEntityToScene(slot, BASE)).toMatchObject({ ok: false, reason: 'instance-member' });
    expect(attrs(slot).sourceScene).toBe('');
    expect(attrs(root).sourceScene).toBe('');
    expect(canUndo()).toBe(false);
  });

  // Accept side: the whole instance carries its rows, so it moves. Mutation: make sceneMoveRefusal refuse any
  // subtree holding a PrefabInstance.
  it('the whole instance root moves, members with it', async () => {
    const { slot, root } = await instance(false);
    expect(moveEntityToScene(root, BASE)).toMatchObject({ ok: true });
    expect([attrs(root).sourceScene, attrs(slot).sourceScene]).toEqual([BASE, BASE]);
  });

  // The Hierarchy's drops and a row drop give one answer for the same subtree: a member is refused by the restructure
  // rule on both, before the scene question (#1869). Mutation: drop the restructure check in planSceneDrop — it answers
  // `instance-member`; drop it in planReparent — the same.
  it('planReparent and the drops agree on the refusal', async () => {
    const { slot } = await instance(true);
    const primaryParent = spawn('Shelf');
    expect(sceneMoveRefusal(slot)).toBe('instance-member');
    expect(planReparent(slot, primaryParent.id())).toEqual({ kind: 'refused', reason: 'restructure' });
    expect(planSceneDrop(slot, '')).toEqual({ kind: 'refused', reason: 'restructure' });
  });
});

describe('a Hierarchy drop that lands at a scene root: planSceneDrop / sceneDropTarget (#1757 close-out review)', () => {
  // A member dropped on its OWN scene's group crosses no file. Mutation: move the same-scene check in planSceneDrop
  // below the refusal (the drop then toasts "split an instance" for nothing).
  it('a drop on the entity\'s own scene is a no-op, and on another scene the refusal', async () => {
    const { slot } = await instance(true);
    expect(planSceneDrop(slot, BASE)).toEqual({ kind: 'same-scene' });
    expect(planSceneDrop(slot, '')).toEqual({ kind: 'refused', reason: 'restructure' });
  });

  // The world was replaced while the prompt was open: the guid may name another file's entity there. Mutation: drop
  // the world check in sceneDropTarget.
  it('a confirmed drop moves the entity it was shown, and nothing once the world was replaced', () => {
    const e = spawn('Crate');
    const plan = planSceneDrop(e.id(), BASE);
    expect(plan.kind).toBe('move');
    if (plan.kind !== 'move') return;
    expect(sceneDropTarget(plan)).toBe(e.id());
    const guid = attrs(e.id()).guid;
    freshWorld();
    spawn('Crate', { guid });
    expect(sceneDropTarget(plan)).toBeNull();
  });
});

describe('a generic write of EntityAttributes.sourceScene is refused (#1757)', () => {
  const stampOp = (guid: string, sourceScene: string) => ({ ops: [{ op: 'setTrait', entity: { guid }, trait: 'EntityAttributes', fields: { sourceScene } }] });

  // Mutation: drop the fieldWriteRefusal check in apply-scene-ops' setTrait branch.
  it('apply-scene-ops setTrait names the scene move and applies nothing; the current value passes', async () => {
    const e = spawn('Loose');
    const r = await runAgentOp('apply-scene-ops', stampOp(attrs(e.id()).guid, BASE)) as { errors: string[] };
    expect(r.errors.join('\n')).toMatch(/sourceScene is which scene file saves the entity.*moveToScene: true/);
    expect(attrs(e.id()).sourceScene).toBe('');
    const same = await runAgentOp('apply-scene-ops', stampOp(attrs(e.id()).guid, '')) as { errors: string[] };
    expect(same.errors).toEqual([]);
    // A non-string reads as '' downstream but would be stored. Mutation: compare `(value || '')` in fieldWriteRefusal.
    const nul = await runAgentOp('apply-scene-ops', { ops: [{ op: 'setTrait', entity: { guid: attrs(e.id()).guid }, trait: 'EntityAttributes', fields: { sourceScene: null } }] }) as { errors: string[] };
    expect(nul.errors.join('\n')).toMatch(/sourceScene is which scene file saves the entity/);
    expect(attrs(e.id()).sourceScene).toBe('');
  });

  // Mutation: drop the guardFieldWrites call in liveMutate's set-traits.
  it('set-traits refuses it, nothing applied; the current value passes', async () => {
    const e = spawn('Loose', { sourceScene: BASE });
    const r = await runAgentOp('set-traits', { guid: attrs(e.id()).guid, set: { 'EntityAttributes.sourceScene': '' } }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sourceScene is which scene file saves the entity/);
    expect(attrs(e.id()).sourceScene).toBe(BASE);
    const same = await runAgentOp('set-traits', { guid: attrs(e.id()).guid, set: { 'EntityAttributes.sourceScene': BASE } }) as { ok: boolean };
    expect(same.ok).toBe(true);
  });

  // Mutation: drop the fieldWriteRefusal check in sceneMutate's setTrait (then its addEntity check, for the 2nd half).
  it('file-direct scene-mutate refuses a stamp in setTrait and in addEntity', () => {
    const scene = (): MutableScene => ({ entities: [{ id: 1, name: 'A', traits: { EntityAttributes: { name: 'A', guid: 'a1757', parentId: 0 } } }] });
    const set = applyOps(scene(), [{ op: 'setTrait', entity: { guid: 'a1757' }, trait: 'EntityAttributes', fields: { sourceScene: BASE } }]);
    expect(set.errors.join('\n')).toMatch(/sourceScene is which scene file saves the entity/);
    expect((set.scene.entities[0].traits.EntityAttributes as Record<string, unknown>).sourceScene).toBeUndefined();
    const add = applyOps(scene(), [{ op: 'addEntity', name: 'B', traits: { EntityAttributes: { name: 'B', sourceScene: BASE } } }]);
    expect(add.errors.join('\n')).toMatch(/sourceScene is which scene file saves the entity/);
    expect(add.scene.entities).toHaveLength(1);
    // Accept side: an EntityAttributes that never names the stamp (a caller guid, say) is an ordinary create.
    // Mutation: ask fieldWriteRefusal in addEntity whether or not the key is present.
    const plain = applyOps(scene(), [{ op: 'addEntity', name: 'C', traits: { EntityAttributes: { name: 'C', guid: 'c1757' } } }]);
    expect(plain.errors).toEqual([]);
    expect(plain.scene.entities).toHaveLength(2);
  });
});

describe('a created entity belongs to its target scene (#1760)', () => {
  // The issue's repro: copy a base entity, open a scene without that base, paste at the root.
  // Mutation: restore the root exemption in adoptParentScene (`if (!parentId) return own`).
  it('a root paste of a base entity copied in another scene lands in the primary, and is saved there', async () => {
    const src = spawn('Crate', { sourceScene: BASE });
    spawn('Lid', { sourceScene: BASE, parentId: src.id() });
    const clip = clipEntity(src.id(), 'copy')!;
    freshWorld(); // the clipboard outlives a scene load
    const pasted = pasteEntityCopy(clip.snapshot, 0, () => {});
    expect(attrs(pasted).sourceScene).toBe('');
    expect(attrs(byName('Lid')).sourceScene).toBe('');
    expect(await saved()).toMatch(/"Crate"[\s\S]*"Lid"|"Lid"[\s\S]*"Crate"/);
    // Redo respawns the stamped copy, not the source's stamp.
    await undo(); await redo();
    expect(attrs(byName('Crate')).sourceScene).toBe('');
  });

  // Mutation: drop adoptParentScene from pasteEntityCopy's spawn.
  it('a paste under a base entity belongs to that base', async () => {
    const src = spawn('Crate');
    const clip = clipEntity(src.id(), 'copy')!;
    const baseParent = spawn('BaseShelf', { sourceScene: BASE });
    const pasted = pasteEntityCopy(clip.snapshot, baseParent.id(), () => {});
    expect(attrs(pasted)).toMatchObject({ parentId: baseParent.id(), sourceScene: BASE });
    expect(await saved(BASE_FILE)).toContain(attrs(pasted).guid);
  });

  const add = (traits: Record<string, unknown>, parentId?: string) =>
    runAgentOp('apply-scene-ops', { ops: [{ op: 'addEntity', name: 'Born1760', ...(parentId ? { parentId } : {}), traits: { Transform: {}, ...traits } }] }) as Promise<{ errors: string[] }>;

  // An authored stamp is an explicit request: refused, never re-targeted (scene-loading.md § Readers of the world).
  // Mutation: drop the authored-stamp check in apply-scene-ops' addEntity (the root rule then re-targets it silently).
  it('agent addEntity authoring a base stamp at the root is refused, nothing created; a primary stamp passes', async () => {
    const r = await add({ EntityAttributes: { name: 'Born1760', sourceScene: BASE } });
    expect(r.errors.join('\n')).toMatch(/is saved in primary: a new entity belongs to its parent's scene.*Nothing was created/);
    expect(getCurrentWorld().entities.some((e) => (e.get(EntityAttributes) as { name?: string } | undefined)?.name === 'Born1760')).toBe(false);
    const ok = await add({ EntityAttributes: { name: 'Born1760', sourceScene: '' } });
    expect(ok.errors).toEqual([]);
    expect(attrs(byName('Born1760')).sourceScene).toBe('');
  });

  // Same check, under a parent. Mutation: compare the authored stamp against '' instead of createTargetScene(parentId).
  it('under a base parent the base stamp passes, and under a primary parent it is refused', async () => {
    const baseParent = spawn('BaseShelf', { sourceScene: BASE });
    const primaryParent = spawn('Shelf');
    const bad = await add({ EntityAttributes: { name: 'Born1760', sourceScene: BASE } }, attrs(primaryParent.id()).guid);
    expect(bad.errors.join('\n')).toMatch(/Nothing was created/);
    // An explicit primary stamp under a base parent would be re-targeted into the base: refused too. Mutation: test
    // the authored stamp for truthiness (`authoredStamp && …`) in apply-scene-ops' addEntity.
    const blank = await add({ EntityAttributes: { name: 'Born1760', sourceScene: '' } }, attrs(baseParent.id()).guid);
    expect(blank.errors.join('\n')).toMatch(/Nothing was created/);
    const good = await add({ EntityAttributes: { name: 'Born1760', sourceScene: BASE } }, attrs(baseParent.id()).guid);
    expect(good.errors).toEqual([]);
    expect(attrs(byName('Born1760'))).toMatchObject({ parentId: baseParent.id(), sourceScene: BASE });
  });
});

describe('a cut names its source by guid AND world (#1757 scope, the #1750 stale-id family)', () => {
  // The cut's world was replaced: a new world numbers from zero AND can hold the same guid (scene files share guids,
  // #1293), so neither the raw id nor the guid may be trusted. Mutation: drop the world check in cutSourceId.
  it('after a world swap the cut names nothing, even where the same guid and id exist', () => {
    const cut = spawn('Crate');
    const clip = clipEntity(cut.id(), 'cut')!;
    expect(cutSourceId(clip)).toBe(cut.id());
    const guid = attrs(cut.id()).guid;
    freshWorld();
    const twin = spawn('Crate', { guid }); // another file's entity with the same guid, at the same index
    expect(twin.id()).toBe(cut.id());
    expect(cutSourceId(clip)).toBeNull();
  });
});
