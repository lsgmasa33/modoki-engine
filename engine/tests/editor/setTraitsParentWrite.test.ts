/** An editor `set-traits` write of `EntityAttributes.parentId` is a reparent, and answers to the editor's one reparent
 *  rule (#1787).
 *
 *  `set-traits` is the DEVICE's raw op (`app/debug/liveMutate.ts`), reached in the editor through `modoki_eval`'s
 *  `modoki.setTraits`. Its parentId write went straight to the field, past `planReparent`: a primary entity landed
 *  under a base scene's parent (#1429's state), and a prefab member left its instance still linked, with no unpack and
 *  no undo (#1434's shape). The editor now replaces the op with its own writer (#1816, `editorTraitWriter`), so every
 *  target is planned before any write, a refusal carries `reparent-entity`'s words, and a same-scene move goes through
 *  `applyReparent`. The rest of the editor writer's contract is `editorSetTraitsOwner.test.ts`.
 *
 *  Each case names the mutation that turns it red. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState, Transform, EntityAttributes, getCurrentWorld, transformPropagationSystem } from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved, canUndo, undo, redo } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefab';
import { clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { getTraitByName } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp, applySetTraits } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

const BASE = 'b1787000-0000-4000-8000-000000000001';
const PATH = '/p1787.prefab.json';

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory(); markSceneSaved(); clearAllSceneDirty();
  setPrefabCache(PATH, {
    id: 'c1787000-0000-4000-8000-000000000001', version: 2, name: 'Kit', rootLocalId: 1,
    entities: [
      { localId: 1, name: 'Kit', traits: { EntityAttributes: { name: 'Kit', parentId: 0 }, Transform: {} } },
      { localId: 2, name: 'Slot', traits: { EntityAttributes: { name: 'Slot', parentId: 1 }, Transform: {} } },
    ],
  } as never);
});
afterEach(() => { setPrefabCache(PATH, null); game?.dispose(); game = undefined; clearAllSceneDirty(); });

const live = (id: number) => getCurrentWorld().entities.find((e) => e.id() === id)!;
const attrs = (id: number) => live(id).get(EntityAttributes) as { parentId: number; sourceScene: string; guid: string };
const byName = (name: string) => getCurrentWorld().entities.find((e) => (e.get(EntityAttributes) as { name?: string } | undefined)?.name === name)!.id();
const spawn = (name: string, extra: Record<string, unknown> = {}) =>
  (game!.spawn(Transform(), EntityAttributes({ name, guid: crypto.randomUUID(), ...extra })) as unknown as { id(): number }).id();
const link = (id: number) => {
  const pi = getTraitByName('PrefabInstance')!;
  return live(id).has(pi.trait) ? (live(id).get(pi.trait) as { rootInstanceId: number }).rootInstanceId : null;
};
type Reply = { ok: boolean; error?: string; savedNote?: string };
const setParent = (guid: string | string[], parentId: number, extra: Record<string, unknown> = {}) =>
  runAgentOp('set-traits', { guid, set: { 'EntityAttributes.parentId': parentId, ...extra } }) as Promise<Reply>;

/** A Kit/Slot instance instantiated live; `inBase` stamps it as a base scene's, as a chain load does. */
async function instance(inBase = false): Promise<{ root: number; slot: number }> {
  const { rootId } = await runAgentOp('prefab', { action: 'instantiate', path: PATH }) as { rootId: number };
  const slot = byName('Slot');
  if (inBase) for (const id of [rootId, slot]) live(id).set(EntityAttributes, { ...attrs(id), sourceScene: BASE });
  clearHistory(); markSceneSaved(); clearAllSceneDirty();
  return { root: rootId, slot };
}

describe('set-traits parentId in the editor goes through planReparent (#1787)', () => {
  // Mutation: drop the `deps.writer?.refusal` call in applyLiveMutate — the write lands, ok:true.
  it('a parent from another scene is a scene move: refused with reparent-entity\'s way out, nothing moved', async () => {
    const child = spawn('Child');
    const baseParent = spawn('BaseParent', { sourceScene: BASE });
    const r = await setParent(attrs(child).guid, baseParent);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^set-traits: EntityAttributes\.parentId \d+ belongs to another scene .* use reparent-entity with moveToScene: true\. Nothing was applied/);
    expect(attrs(child).parentId).toBe(0);
    expect(canUndo()).toBe(false);
  });

  // A base instance's member under a primary parent would split the instance across two files. Same mutation.
  it('a member moved into another scene is refused as instance-member, still linked where it was', async () => {
    const { root, slot } = await instance(true);
    const shelf = spawn('Shelf');
    const r = await setParent(attrs(slot).guid, shelf);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^set-traits: refused to move \d+ under \d+ — .*split across two scene files/);
    expect(attrs(slot).parentId).toBe(root);
    expect(link(slot)).toBe(root);
  });

  // The #1434 half: a same-scene move out of the instance unpacks, as reparent-entity's does, and is one undo entry.
  // Mutation: send the editor's set-traits through applySetTraits(params) with no writer — still linked, no undo.
  it('a same-scene member move unpacks it like reparent-entity, and undoes', async () => {
    const viaOp = await instance();
    const shelfA = spawn('ShelfA');
    await runAgentOp('reparent-entity', { guid: attrs(viaOp.slot).guid, parentGuid: attrs(shelfA).guid });
    const expected = link(viaOp.slot);
    game!.dispose(); game = createTestWorld({}); setPlayState('stopped');

    const { root, slot } = await instance();
    const shelf = spawn('Shelf');
    const r = await setParent(attrs(slot).guid, shelf);
    expect(r.ok).toBe(true);
    expect(attrs(slot).parentId).toBe(shelf);
    expect(link(slot)).toBe(expected);
    expect(link(slot)).not.toBe(root);
    expect(r.savedNote).toMatch(/one undo entry/);
    expect(canUndo()).toBe(true);
    await undo();
    expect(attrs(slot).parentId).toBe(root);
    expect(link(slot)).toBe(root);
  });

  // #1787 refused parentId beside another field, because the reparent was an undo entry and every other write was raw
  // (the redo restored the reparent's pre-write compensation, x=-10 for a written 5). Every write is undoable now and
  // the call is one composite, parent first, so the pair is accepted and call / undo / redo agree, in either key order.
  // Mutation: drop the parent-first ordering in editorTraitWriter.write — with the Transform key first, the reparent's
  // world-pose compensation lands after the written x and rewrites it.
  it('parentId with another field in the same call: one undo entry restores both, and redo lands both', async () => {
    for (const set of [{ 'Transform.x': 5, 'EntityAttributes.parentId': 0 }, { 'EntityAttributes.parentId': 0, 'Transform.x': 5 }]) {
      const p = spawn('P'); const a = spawn('A');
      live(p).set(Transform, { ...(live(p).get(Transform) as object), x: 10 });
      transformPropagationSystem(getCurrentWorld());
      clearHistory();
      const r = await runAgentOp('set-traits', { guid: attrs(a).guid, set: { ...set, 'EntityAttributes.parentId': p } }) as Reply;
      expect(r.ok, JSON.stringify(set)).toBe(true);
      const state = () => [attrs(a).parentId, (live(a).get(Transform) as { x: number }).x];
      expect(state()).toEqual([p, 5]);
      await undo();
      expect(state()).toEqual([0, 0]);
      expect(canUndo()).toBe(false);
      await redo();
      expect(state()).toEqual([p, 5]);
    }
  });

  // Accept side. Mutation: make fieldParentWriteRefusal answer a same-scene plan with a refusal.
  it('a plain same-scene reparent passes', async () => {
    const a = spawn('A'); const b = spawn('B');
    const r = await setParent(attrs(a).guid, b);
    expect(r.ok).toBe(true);
    expect(attrs(a).parentId).toBe(b);
  });

  // Plan every target, then write any. Mutation: plan only `ids[0]` in guardEditorParentWrite — the allowed target
  // (first) moves before the refused one is ever asked.
  it('a mixed batch — one allowed target, one refused — writes nothing to either', async () => {
    const allowed = spawn('Allowed');
    const { slot } = await instance(true);
    const shelf = spawn('Shelf');
    const r = await setParent([attrs(allowed).guid, attrs(slot).guid], shelf);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Nothing was applied to any of the 2 targets/);
    expect(attrs(allowed).parentId).toBe(0);
    expect(canUndo()).toBe(false);
  });
});

describe('without the editor writer (a device), set-traits writes parentId raw as before (#1787)', () => {
  // `applySetTraits` with no writer IS the device's op. Mutation: make the write loop skip a parentId write when no
  // writer is given — the device write vanishes.
  it('a same-scene member move lands raw, still linked, with the device note', async () => {
    const { root, slot } = await instance();
    const shelf = spawn('Shelf');
    const r = applySetTraits({ guid: attrs(slot).guid, set: { 'EntityAttributes.parentId': shelf } }) as Reply;
    expect(r.ok).toBe(true);
    expect(attrs(slot).parentId).toBe(shelf);
    expect(link(slot)).toBe(root);
    expect(r.savedNote).toMatch(/a relaunch is the undo/);
    expect(canUndo()).toBe(false);
  });

  // Raw, but still judged: the device asks the same parent rule the editor and the file do (`parentLinkRefusal`, #1825).
  // Mutation: return null for 'cycle' in parentLinkRefusal — the device stores the cycle.
  it('a cycle is refused by the shared parent rule, nothing written', () => {
    const a = spawn('A'); const b = spawn('B', { parentId: a });
    const r = applySetTraits({ guid: attrs(a).guid, set: { 'EntityAttributes.parentId': b } }) as Reply;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/would make entity \d+ its own ancestor/);
    expect(attrs(a).parentId).toBe(0);
  });
});
