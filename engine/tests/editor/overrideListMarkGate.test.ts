/** #1717: the Apply/Revert override list and the Inspector's highlight show what the scene SAVE keeps — Unity's
 *  recorded-modification model — through the one mark gate the save uses (`gateOnMarks`, `foldMarkedEqual`).
 *
 *  They used to diff a member against its base by VALUE, with no mark gate, while the save captured only override-MARKED
 *  fields. So a value that differed with no mark (a re-import moving the base under an un-edited instance) was listed and
 *  highlighted, Apply wrote it into the prefab, and the scene file never held it; and a marked value equal to its base,
 *  which the save keeps, was listed nowhere.
 *
 *  Driven through a hand-built world (`instantiatePrefab`), with marks written as the editor's own writes leave them.
 *  Each case names the mutation that turns it red. */

import { describe, it, expect } from 'vitest';
import { getCurrentWorld, markOverride, findEntityById, getTraitByName } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { instantiatePrefab, captureInstanceOverrides, type PrefabFile } from '@modoki/engine/editor';
import { collectInstanceOverrideTree } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { memberOverrideKeys, collectComparableTraits } from '../../packages/modoki/src/editor/scene/prefab';

registerAllTraits();

const TF = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
function makePrefab(): PrefabFile {
  return {
    version: 1, name: 'mark-gate-1717', rootLocalId: 1,
    entities: [
      { localId: 1, name: 'Root', traits: { Transform: { ...TF }, EntityAttributes: { name: 'Root', parentId: 0, layer: '3d' } } },
      { localId: 2, name: 'Child', traits: { Transform: { ...TF, x: 5 }, EntityAttributes: { name: 'Child', parentId: 1, layer: '3d' } } },
      { localId: 3, name: 'Other', traits: { Transform: { ...TF, y: 2 }, EntityAttributes: { name: 'Other', parentId: 1, layer: '3d' } } },
    ],
  };
}

const memberOf = (rootId: number, localId: number): number => {
  const piMeta = getTraitByName('PrefabInstance')!;
  let id = 0;
  getCurrentWorld().query(piMeta.trait).updateEach(([pi], entity) => {
    const d = pi as { rootInstanceId: number; localId: number };
    if (d.rootInstanceId === rootId && d.localId === localId) id = entity.id();
  });
  return id;
};
const setField = (id: number, trait: string, field: string, value: unknown) => {
  const meta = getTraitByName(trait)!;
  getCurrentWorld().query(meta.trait).updateEach(([t], entity) => { if (entity.id() === id) (t as Record<string, unknown>)[field] = value; });
};

/** `Trait.field` for member `localId`: in the Apply/Revert list, in the Inspector's highlight, and in the save. */
function surfaces(rootId: number, prefab: PrefabFile, localId: number) {
  const id = memberOf(rootId, localId);
  const tree = collectInstanceOverrideTree(rootId, prefab);
  // An added component is ONE row (#1663), listed with the fields it carries.
  const listed = new Set([
    ...tree.entities.filter((e) => e.localId === localId).flatMap((e) => e.traits.flatMap((t) => t.fields.map((f) => `${t.trait}.${f.field}`))),
    ...tree.addedTags.filter((t) => t.localId === localId).flatMap((t) => (t.fields ?? []).map((f) => `${t.tag}.${f}`)),
  ]);
  const highlighted = memberOverrideKeys(id, localId, collectComparableTraits(id, getAllTraitsList()), prefab, rootId);
  const saved = new Set(Object.entries(captureInstanceOverrides(rootId, prefab)[localId] ?? {})
    .flatMap(([t, fields]) => Object.keys(fields).map((f) => `${t}.${f}`)));
  return { listed, highlighted, saved };
}
function getAllTraitsList() {
  // The registry's traits, as the Inspector's read covers them (its own curated read is a subset; this is the full one).
  return ['Transform', 'EntityAttributes', 'Rotate3D'].map((n) => getTraitByName(n)!).filter(Boolean);
}

describe('the override list and the Inspector highlight show exactly what the save keeps (#1717)', () => {
  // Mutation: drop `gateOnMarks` from `collectInstanceOverrideTree` — `listed` gains Transform.x; from
  // `memberOverrideKeys` — `highlighted` does.
  it('a value that differs from its base with NO mark is not an override: not listed, not highlighted, not saved', () => {
    const prefab = makePrefab();
    const root = instantiatePrefab(prefab);
    setField(memberOf(root, 2), 'Transform', 'x', 99); // a divergence nobody recorded (a base moved under it)
    const s = surfaces(root, prefab, 2);
    expect(s.saved.has('Transform.x')).toBe(false);
    expect(s.listed.has('Transform.x')).toBe(false);
    expect(s.highlighted.has('Transform.x')).toBe(false);
  });

  // Accept side of the gate: a gate that dropped everything would pass the case above.
  it('a MARKED difference is listed, highlighted and saved', () => {
    const prefab = makePrefab();
    const root = instantiatePrefab(prefab);
    const child = memberOf(root, 2);
    setField(child, 'Transform', 'x', 99);
    markOverride(findEntityById(child)!, 'Transform', 'x');
    const s = surfaces(root, prefab, 2);
    expect([s.saved.has('Transform.x'), s.listed.has('Transform.x'), s.highlighted.has('Transform.x')]).toEqual([true, true, true]);
  });

  // Mutation: drop `foldMarkedEqual` from the list (or the highlight) — the recorded override the save keeps is listed
  // nowhere, so it can be neither applied nor reverted.
  it('a MARKED value equal to its base is a recorded override: listed and highlighted, as the save keeps it (#1709)', () => {
    const prefab = makePrefab();
    const root = instantiatePrefab(prefab);
    markOverride(findEntityById(memberOf(root, 2))!, 'Transform', 'x'); // x stays 5, the base's own value
    const s = surfaces(root, prefab, 2);
    expect(s.saved.has('Transform.x')).toBe(true);
    expect(s.listed.has('Transform.x')).toBe(true);
    expect(s.highlighted.has('Transform.x')).toBe(true);
  });

  // The save's first exemption. Mutation: gate added traits on marks too — the added component vanishes from the list.
  it('an ADDED component is listed with no mark, as the save captures it whole', () => {
    const prefab = makePrefab();
    const root = instantiatePrefab(prefab);
    const child = memberOf(root, 2);
    const rot = getTraitByName('Rotate3D')!;
    findEntityById(child)!.add(rot.trait({ axis: 'y', speed: 3 }));
    const s = surfaces(root, prefab, 2);
    expect([...s.saved].some((k) => k.startsWith('Rotate3D.'))).toBe(true);
    expect([...s.listed].some((k) => k.startsWith('Rotate3D.'))).toBe(true);
  });
});
