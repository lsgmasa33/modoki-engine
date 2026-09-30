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
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
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

  // A base instance's member under a primary parent: a prefab-supplied object does not move (#1869). Same mutation.
  it('a member moved into another scene is refused, still linked where it was', async () => {
    const { root, slot } = await instance(true);
    const shelf = spawn('Shelf');
    const r = await setParent(attrs(slot).guid, shelf);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^set-traits: refused to move or reorder \d+ — Can't restructure a prefab instance/);
    expect(attrs(slot).parentId).toBe(root);
    expect(link(slot)).toBe(root);
  });

  // A refused member move says "Nothing was applied" ONCE on every agent route: `reparentRefusalText` gives the reason
  // and each caller closes it. Mutation: put "Nothing was applied." back on the restructure case in
  // reparentRefusalText — the two field-write routes say it twice; drop it from reparent-entity's throw — that one says
  // it zero times.
  it('a refused member move says "Nothing was applied" exactly once, on each route', async () => {
    const { slot } = await instance();
    const shelf = spawn('Shelf');
    const once = (text: string) => expect(text.match(/Nothing was applied/g), text).toHaveLength(1);
    const traits = await setParent(attrs(slot).guid, shelf);
    expect(traits.error).toMatch(/^set-traits: refused to move or reorder \d+ — Can't restructure a prefab instance.*only objects the scene added move inside an instance\. Nothing was applied to any of the 1 target\.$/);
    once(traits.error!);
    const ops = await runAgentOp('apply-scene-ops', { ops: [{ op: 'setTrait', entity: { guid: attrs(slot).guid }, trait: 'EntityAttributes', fields: { parentId: shelf } }] }) as { errors: string[] };
    expect(ops.errors).toHaveLength(1);
    expect(ops.errors[0]).toMatch(/refused to move or reorder \d+ — .*inside an instance\. Nothing was applied to entity \d+\.$/);
    once(ops.errors[0]);
    const thrown = await runAgentOp('reparent-entity', { guid: attrs(slot).guid, parentGuid: attrs(shelf).guid }).then(() => '', (e: Error) => e.message);
    expect(thrown).toMatch(/inside an instance\. Nothing was applied\.$/);
    once(thrown);
  });

  // #1869: a same-scene member move is refused like reparent-entity's, before anything is written — no entry, still
  // linked. So is a new sortOrder (a reorder), on its own or beside the parent. A node the SCENE added under the instance
  // takes both. Mutation: drop restructureRefusal in planReparent — the parent write lands; drop the sortOrder pre-check
  // in writeTraitAsEditor — the reorder lands (the field write's own gate refuses mid-call, after the check passed).
  it('a same-scene member move or reorder is refused with nothing applied; a scene-added node moves and reorders', async () => {
    const { root, slot } = await instance();
    const shelf = spawn('Shelf');
    const sortOf = (id: number) => (live(id).get(EntityAttributes) as { sortOrder: number }).sortOrder;
    const slotSort = sortOf(slot);
    for (const set of [{ 'EntityAttributes.parentId': shelf }, { 'EntityAttributes.sortOrder': 7 }, { 'EntityAttributes.sortOrder': 7, 'Transform.x': 3 }]) {
      const r = await runAgentOp('set-traits', { guid: attrs(slot).guid, set }) as Reply;
      expect(r.ok, JSON.stringify(set)).toBe(false);
      expect(r.error, JSON.stringify(set)).toMatch(/Can't restructure a prefab instance/);
      expect([attrs(slot).parentId, sortOf(slot)]).toEqual([root, slotSort]);
      expect(link(slot)).toBe(root);
      expect(canUndo(), JSON.stringify(set)).toBe(false);
    }
    // The other two agent routes: reparent-entity with a sortOrder alone (a reorder under the same parent), and
    // apply-scene-ops' setTrait. Mutation: stop passing the sortOrder to planReparent in reparent-entity — it answers
    // "nothing changed" instead of the rule.
    await expect(runAgentOp('reparent-entity', { guid: attrs(slot).guid, parentGuid: attrs(root).guid, sortOrder: 7 })).rejects.toThrow(/refused to move or reorder \d+ — Can't restructure a prefab instance/);
    const ops = await runAgentOp('apply-scene-ops', { ops: [{ op: 'setTrait', entity: { guid: attrs(slot).guid }, trait: 'EntityAttributes', fields: { sortOrder: 7 } }] }) as { errors: string[] };
    expect(ops.errors.join('\n')).toMatch(/refused to reorder \d+ — Can't restructure a prefab instance/);
    expect([sortOf(slot), canUndo()]).toEqual([slotSort, false]);
    // …and the agent's Create Prefab on a member (#1792's second route; Unity: "Can't save part of a Prefab instance as a
    // Prefab"). Mutation: drop the `partOfInstanceRefusal` call in the agent op — it goes on to write a file.
    await expect(runAgentOp('prefab', { action: 'create', entityGuid: attrs(slot).guid, path: '/p1869.prefab.json' })).rejects.toThrow(/Create Prefab refused — Can't save part of a prefab instance as a prefab/);
    expect([link(slot), canUndo()]).toEqual([root, false]);
    const added = spawn('Added', { parentId: root });
    // A dry run answers what the call would, for a mixed selection too (#1869 close-out review, finding 2: the pre-check
    // asked only the placeholder and parent rules, so a dry run said ok:true for a reorder the real call refused, and the
    // real call reached the mid-write backstop). Mutation: drop the sortOrder check in `editorTraitWriter.refusal`.
    const addedSort = sortOf(added);
    for (const dryRun of [true, false]) {
      const r = await runAgentOp('set-traits', { guid: [attrs(added).guid, attrs(slot).guid], set: { 'EntityAttributes.sortOrder': 7 }, dryRun }) as Reply;
      expect(r.ok, `dryRun ${dryRun}`).toBe(false);
      expect(r.error).toMatch(/^set-traits: refused to reorder \d+ — Can't restructure a prefab instance.*Nothing was applied to any of the 2 targets\./);
    }
    expect([sortOf(added), sortOf(slot), canUndo()]).toEqual([addedSort, slotSort, false]);
    expect((await runAgentOp('set-traits', { guid: attrs(added).guid, set: { 'EntityAttributes.sortOrder': 7 } }) as Reply).ok).toBe(true);
    expect((await setParent(attrs(added).guid, shelf)).ok).toBe(true);
    expect([attrs(added).parentId, sortOf(added)]).toEqual([shelf, 7]);
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
