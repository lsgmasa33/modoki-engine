/** Instantiate's undo → redo brings back the SAME identities (Unity: undo/redo restores the same objects, with the same
 *  identities), through the real respawn (`instantiatePrefabInstance`), so every member lands where a reload puts it.
 *
 *  The redo mints the ROOT guid it recorded, before the members derive (`prefabInstantiateUndo.ts`). The root is the
 *  instance's whole identity: each member's guid is `deriveMemberGuid(root, its template path)`, the load's own rule.
 *  - #1880 T4 / hunt seed 1044: the redo used to derive the members from a throwaway root guid and then stamp the
 *    captured guids back by `name#siblingIndex`. A row added between the undo and the redo whose name sorts first shifted
 *    every index, so only the root came back; every member kept a guid no reload would give it.
 *  - #1831 hunt seed 5785: two siblings with one name and one sortOrder were told apart by ECS id in that stamp, so a
 *    respawn in another id order swapped their guids. Derived by template path, they cannot swap. */

import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, readTraitData, setRunMode, spawnEntity, EntityAttributes } from '@modoki/engine/runtime';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { instantiatePrefabInstance } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { makePrefabInstantiateAction } from '../../packages/modoki/src/editor/undo/prefabInstantiateUndo';
import { deleteEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { deriveMemberGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { indexEntityGuid } from '../../packages/modoki/src/runtime/core/ecs/world';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const PATH = '/assets/prefabs/Twin.prefab.json';
const row = (localId: number, name: string, parentId: number) => ({
  localId, name, nodeGuid: `eeeeeeee-0000-4000-8000-0000001044${String(localId).padStart(2, '0')}`,
  traits: { EntityAttributes: { name, parentId, guid: '', sortOrder: 0 }, Transform: { x: localId, y: 0, z: 0 } },
});
/** R → Twin, Twin (one name, one sortOrder), and a grandchild under the second so a shift reaches a deeper path too. */
const base = (): PrefabFile => ({ id: 'cccccccc-0000-4000-8000-000000001044', version: 6, name: 'Twin', rootLocalId: 1,
  entities: [row(1, 'R', 0), row(2, 'Twin', 1), row(3, 'Twin', 1), row(4, 'Leaf', 3)] } as unknown as PrefabFile);

const ea = () => getTraitByName('EntityAttributes')!;
const pi = () => getTraitByName('PrefabInstance')!;
const guidOf = (id: number) => (readTraitData(id, ea())?.guid as string) || '';
/** Each member of the instance under `rootId`, by its template localId → its guid. */
function memberGuids(rootId: number): Record<number, string> {
  const out: Record<number, string> = {};
  for (const e of getAllEntities()) {
    const p = readTraitData(e.id, pi()) as { localId?: number; rootInstanceId?: number } | null;
    if (e.id !== rootId && p?.rootInstanceId === rootId && p.localId) out[p.localId] = guidOf(e.id);
  }
  return out;
}
/** What a reload derives for each member: its path below the root, anchored on the root guid. */
const reloadDerives = (root: string, doc: PrefabFile): Record<number, string> => {
  const parent = new Map(doc.entities.map((r) => [r.localId!, (r.traits.EntityAttributes as { parentId: number }).parentId]));
  const out: Record<number, string> = {};
  for (const r of doc.entities) {
    if (r.localId === 1) continue;
    const path: number[] = [];
    for (let cur = r.localId!; cur && cur !== 1; cur = parent.get(cur) ?? 0) path.unshift(cur);
    out[r.localId!] = deriveMemberGuid(root, path);
  }
  return out;
};
const liveRoot = (guid: string) => getAllEntities().find((e) => guidOf(e.id) === guid)?.id ?? 0;

beforeEach(() => {
  setRunMode('stopped');
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
});

describe('Instantiate → Undo → Redo gives back the root guid, and every member what a reload derives (#1880 T4, seeds 1044/5785)', () => {
  it('a row whose name sorts FIRST, added to the prefab between the undo and the redo, moves no member', async () => {
    // Mutation: the redo does not pass the recorded root guid (`opts.respawn(undefined)`) — every guid differs; the root
    // is a fresh one and the members derive from it (the pre-fix members, 1044's shape).
    let doc = base();
    const first = await instantiatePrefabInstance(doc, PATH, 0, () => true);
    const root = guidOf(first);
    expect(memberGuids(first), 'premise: the instantiate derives from the root').toEqual(reloadDerives(root, doc));
    const before = memberGuids(first);
    const action = makePrefabInstantiateAction({
      label: 'Instantiate "Twin"', initialId: first,
      respawn: (rootGuid) => instantiatePrefabInstance(doc, PATH, 0, () => true, rootGuid),
      remove: (id) => deleteEntity(id),
    });
    await action.undo();
    expect(liveRoot(root), 'premise: the instance is gone').toBe(0);
    // An outside edit: a plain row "Aaa" under the root, numbered above the rest (the shape 1044's `outsideEdit` wrote).
    doc = { ...doc, entities: [...doc.entities, row(5, 'Aaa', 1)] } as PrefabFile;
    await action.redo();
    const again = liveRoot(root);
    expect(again, 'the root came back under its recorded guid').toBeGreaterThan(0);
    const after = memberGuids(again);
    expect(after).toEqual(reloadDerives(root, doc));
    for (const lid of [2, 3, 4]) expect(after[lid], `member ${lid} kept its guid`).toBe(before[lid]);
  });

  it('two same-named siblings keep their own guids through two undo → redo cycles', async () => {
    const doc = base();
    const first = await instantiatePrefabInstance(doc, PATH, 0, () => true);
    const root = guidOf(first);
    const before = memberGuids(first);
    expect(before[2]).not.toBe(before[3]);
    const action = makePrefabInstantiateAction({
      label: 'Instantiate "Twin"', initialId: first,
      respawn: (rootGuid) => instantiatePrefabInstance(doc, PATH, 0, () => true, rootGuid),
      remove: (id) => deleteEntity(id),
    });
    for (let i = 0; i < 2; i++) {
      await action.undo();
      await action.redo();
      expect(memberGuids(liveRoot(root))).toEqual(before);
    }
  });

  it('(accept) a recorded root guid another live entity holds is NOT taken: the redo mints a fresh one, no duplicate', async () => {
    // Mutation: drop the `!findEntityByGuid(rootGuid)` test in `spawnPrefabInstance` — two entities hold the root guid.
    const doc = base();
    const first = await instantiatePrefabInstance(doc, PATH, 0, () => true);
    const root = guidOf(first);
    const action = makePrefabInstantiateAction({
      label: 'Instantiate "Twin"', initialId: first,
      respawn: (rootGuid) => instantiatePrefabInstance(doc, PATH, 0, () => true, rootGuid),
      remove: (id) => deleteEntity(id),
    });
    await action.undo();
    const squatter = spawnEntity(getCurrentWorld(), EntityAttributes({ name: 'Squatter', guid: root }));
    indexEntityGuid(squatter);
    await action.redo();
    const holders = getAllEntities().filter((e) => guidOf(e.id) === root);
    expect(holders.map((e) => e.name)).toEqual(['Squatter']);
    const respawned = getAllEntities().find((e) => e.name === 'R')!;
    expect(guidOf(respawned.id)).not.toBe(root);
    expect(memberGuids(respawned.id)).toEqual(reloadDerives(guidOf(respawned.id), doc));
    // …and the next undo → redo restores the guid this redo minted, not the squatter's.
    const minted = guidOf(respawned.id);
    await action.undo();
    // That undo takes out the respawn, never the squatter that holds the recorded guid (#2061 close-out review).
    expect(getAllEntities().filter((e) => e.name === 'Squatter')).toHaveLength(1);
    expect(liveRoot(minted)).toBe(0);
    await action.redo();
    expect(liveRoot(minted)).toBeGreaterThan(0);
  });
});
