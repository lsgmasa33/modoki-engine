/** #1880 F5 (owner-approved, the Unity way): an instance's ROTATION is one override. Unity records a rotation edit as one
 *  quaternion (`TransformRotationGUI` writes `m_Rotation.quaternionValue` whole even when one Euler field changed), so an
 *  instance that turned one axis pins its whole rotation against later template edits. Stated in the override view
 *  (`recordedKeys`, `ROTATION_MARKS`): a record of one axis reads as the rotation's, and the captures save what it reads. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState, getTraitByName, writeTraitField, findEntity, getAllEntities } from '@modoki/engine/runtime';
import { setPrefabCache, setPrefabSource } from '../../packages/modoki/src/editor/scene/prefabCache';
import { instantiatePrefab } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { captureInstanceOverrides } from '../../packages/modoki/src/editor/scene/prefabInstanceOverrides';
import { overrideKeysOf } from '../../packages/modoki/src/editor/instance/instanceOverrideView';
import { recordOverridesByDiff } from '../../packages/modoki/src/editor/undo/overrideMarkWrites';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { place, setFields } from '../../packages/modoki/src/editor/instance/instanceEdits';

registerAllTraits();

const P = 'dddddddd-0000-4000-8000-000000188050';
const G = (n: number) => `eeeeeeee-0000-4000-8000-0000001880${String(n).padStart(2, '0')}`;
const tf = { x: 0, y: 0, z: 0, rx: 0, ry: 0.25, rz: 0, sx: 1, sy: 1, sz: 1 };
/** P: R → A. A's template rotation is (0, 0.25, 0). */
const pDoc = { id: P, version: 6, name: 'P', rootLocalId: 1, entities: [
  { localId: 1, name: 'R', nodeGuid: G(1), traits: { EntityAttributes: { name: 'R', parentId: 0, guid: '' }, Transform: { ...tf, ry: 0 } } },
  { localId: 2, name: 'A', nodeGuid: G(2), traits: { EntityAttributes: { name: 'A', parentId: 1, guid: '' }, Transform: tf } },
] };

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  registerAsset(P, '/assets/prefabs/P.prefab.json', 'prefab');
  setPrefabCache(P, structuredClone(pDoc) as never);
});
afterEach(() => { game?.dispose(); game = undefined; setPrefabCache(P, null); });

const T = () => getTraitByName('Transform')!;
const byName = (name: string) => getAllEntities().find((e) => e.name === name)!.id;
const marksOf = (id: number) => [...(overrideKeysOf(findEntity(id)!) ?? [])].filter((k) => k.startsWith('Transform.')).sort();
function instance(): number {
  const root = instantiatePrefab(pDoc as never, 0);
  setPrefabSource(root, { id: P });
  place(root); // its record, as a drop mints one
  return root;
}

describe('rotation is ONE override (#1880 F5)', () => {
  // Mutation: the view reads one axis as one key (`recordedKeys` drops the `ROTATION_MARKS` group) — the capture holds rx
  // alone, and ry follows the template.
  it('an rx-only edit saves the WHOLE rotation, the template\'s ry included', () => {
    const root = instance();
    const a = byName('A');
    writeTraitField(a, T(), 'rx', 0.5);
    setFields(a, 'Transform', ['rx']);
    expect(marksOf(a)).toEqual(['Transform.rx', 'Transform.ry', 'Transform.rz']);
    expect(captureInstanceOverrides(root, pDoc as never)[2]!.Transform).toEqual({ rx: 0.5, ry: 0.25, rz: 0 });
  });

  it('a record of one axis reads as the rotation, and leaves position its own', () => {
    instance();
    const a = byName('A');
    writeTraitField(a, T(), 'x', 3);
    setFields(a, 'Transform', ['x']);
    expect(marksOf(a)).toEqual(['Transform.x']);
    writeTraitField(a, T(), 'rz', 0.7);
    setFields(a, 'Transform', ['rz']);
    expect(marksOf(a)).toEqual(['Transform.rx', 'Transform.ry', 'Transform.rz', 'Transform.x']);
  });

  // Mutation: decide each rotation axis on its own in `recordOverridesByDiff` AND record one key, not its group
  // (`instanceEdits.ts`' `isRotation`) — only rx is recorded, and the save writes rx without ry/rz. Either half alone
  // stays green: R2's recorder never takes a record off, so the group the record takes for rx is the whole rotation.
  it('the recorder: rx off its base and ry equal to it records the whole rotation', () => {
    const root = instance();
    const a = byName('A');
    writeTraitField(a, T(), 'rx', 0.5);
    recordOverridesByDiff(a, T(), ['rx', 'ry', 'rz']);
    expect(marksOf(a)).toEqual(['Transform.rx', 'Transform.ry', 'Transform.rz']);
    expect(captureInstanceOverrides(root, pDoc as never)[2]!.Transform).toEqual({ rx: 0.5, ry: 0.25, rz: 0 });
    // The rotation put back on its base keeps all three (#1914 F3: a write removes no record).
    writeTraitField(a, T(), 'rx', 0);
    recordOverridesByDiff(a, T(), ['rx', 'ry', 'rz']);
    expect(marksOf(a)).toEqual(['Transform.rx', 'Transform.ry', 'Transform.rz']);
  });

  it('(accept) a position-only change marks no rotation', () => {
    instance();
    const a = byName('A');
    writeTraitField(a, T(), 'x', 3);
    recordOverridesByDiff(a, T(), ['x', 'rx', 'ry', 'rz']);
    expect(marksOf(a)).toEqual(['Transform.x']);
  });
});
