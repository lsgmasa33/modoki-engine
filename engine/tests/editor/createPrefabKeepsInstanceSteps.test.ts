/** #1882 M2 (a): a Create Prefab of an INSTANCE ROOT numbers each row of that instance's own frame by the step it had in
 *  the instance (#1759's rule for a Replace; Unity keeps fileIDs), and every other row above the source's mark.
 *
 *  The root keeps its guid through the Create, and every member keeps the guid it derived from that root under the
 *  SOURCE's numbering (the scene pins it). Numbered by position, the new prefab handed those steps to other nodes, so a
 *  row later added at an old path derived a kept member's guid: hunt seed 1044, where B kept R|2.3 while R numbered it 4
 *  and Q's new row 3, under R's nested Q at step 2, derived R|2.3 — two entities on one guid. */

import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, readTraitData, writeTraitField, setRunMode, spawnEntity, EntityAttributes, Transform } from '@modoki/engine/runtime';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { instantiatePrefabInstance } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { serializePrefab } from '../../packages/modoki/src/editor/scene/prefabSerialize';
import { deriveMemberGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { rowPathInPrefab } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const Q = 'cccccccc-0000-4000-8000-000000188201';
const P = 'cccccccc-0000-4000-8000-000000188202';
const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, name, nodeGuid: `eeeeeeee-0000-4000-8000-0000001882${String(localId).padStart(2, '0')}`, ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: localId, y: 0, z: 0 } },
});
const qDoc = { id: Q, version: 6, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0), row(2, 'M', 1)] } as unknown as PrefabFile;
/** #1882's P: R → A → B, and R → C (a Q row). A mark above its rows, so "above the mark" differs from "above the rows". */
const pDoc = { id: P, version: 6, name: 'P', rootLocalId: 1, nextLocalId: 7, entities: [
  row(1, 'R', 0), row(2, 'A', 1), row(3, 'B', 2), { ...row(4, 'C', 1), prefab: Q },
] } as unknown as PrefabFile;

const ea = () => getTraitByName('EntityAttributes')!;
const idNamed = (name: string) => getAllEntities().find((e) => e.name === name)!.id;
const guidOf = (id: number) => readTraitData(id, ea())?.guid as string;
const lidOf = (file: PrefabFile, name: string) => file.entities.find((r) => r.name === name)!.localId!;

beforeEach(() => {
  setRunMode('stopped');
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  setPrefabCache(Q, qDoc);
  setPrefabCache(P, pDoc);
});

async function instanceWithExtra(): Promise<number> {
  const root = await instantiatePrefabInstance(pDoc, '/assets/prefabs/P.prefab.json', 0, () => true);
  // A plain child the user added under the instance: no step in P, so it is numbered above P's mark.
  const extra = spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Extra', parentId: root, guid: 'dddddddd-0000-4000-8000-000000188299' }));
  writeTraitField(extra.id(), ea(), 'parentId', root);
  return root;
}

describe('Create Prefab of an instance root keeps each member\'s step (#1882 M2 a)', () => {
  // Mutation: `instanceStepNumbering` returns null (the positional plan) — A/B/C are renumbered and the derivation no
  // longer equals the kept guid.
  it('A, B and the nested row (C, written as its root QR) keep 2, 3, 4; a plain added child goes above P\'s mark (7)', async () => {
    const root = await instanceWithExtra();
    const file = serializePrefab(root)!;
    expect(file).not.toBeNull();
    expect(Object.fromEntries(['R', 'A', 'B', 'QR', 'Extra'].map((n) => [n, lidOf(file, n)])))
      .toEqual({ R: 1, A: 2, B: 3, QR: 4, Extra: 7 });
    expect(file.nextLocalId).toBeGreaterThan(7);
  });

  it('so every kept member guid IS what the new prefab derives at its row: no old path is left for another node', async () => {
    const root = await instanceWithExtra();
    const file = serializePrefab(root)!;
    const anchor = guidOf(root);
    for (const name of ['A', 'B']) {
      expect(deriveMemberGuid(anchor, rowPathInPrefab(file as never, lidOf(file, name))), name).toBe(guidOf(idNamed(name)));
    }
  });

  // #1880 close-out review 4. Mutation: drop `keptFrom` from `advanceLocalIdCounter` — the mark is 5 (R's rows + 1), and a
  // later row could take P's freed 5 or 6, whose old derivation a scene pin may still hold.
  it('the new prefab\'s mark carries the source document\'s (7), not just its own rows\' (5)', async () => {
    const root = await instantiatePrefabInstance(pDoc, '/assets/prefabs/P.prefab.json', 0, () => true);
    const file = serializePrefab(root)!;
    expect(Math.max(...file.entities.map((e) => e.localId!))).toBe(4); // premise: no row above P's own
    expect(file.nextLocalId).toBeGreaterThanOrEqual(7);
  });

  it('(accept) a Create of a SUBTREE of the instance keeps the positional plan: it anchors on a new root', async () => {
    await instanceWithExtra();
    const file = serializePrefab(idNamed('A'))!;
    expect(Object.fromEntries(['A', 'B'].map((n) => [n, lidOf(file, n)]))).toEqual({ A: 1, B: 2 });
  });
});
