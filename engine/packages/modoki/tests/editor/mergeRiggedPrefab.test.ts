/** mergeRiggedPrefab (P7b-2b) — a rigged model re-import refreshes the skeleton from
 *  source but must PRESERVE the user's prefab edits. Bones are matched by NAME so a
 *  bone keeps its localId across re-imports and a user child hung on it stays
 *  attached; user-added entities + user-added traits survive; a child whose parent
 *  bone was removed is re-anchored to the model root. Pure function — no world/backend. */

import { describe, it, expect } from 'vitest';
import { mergeRiggedPrefab } from '../../src/editor/scene/prefab';
import type { PrefabFile, PrefabEntity } from '../../src/editor/scene/prefab';

type Traits = PrefabEntity['traits'];
function ent(localId: number, name: string, parentId: number, traits: Traits = {}): PrefabEntity {
  return { localId, name, traits: { EntityAttributes: { name, parentId, guid: '' }, ...traits } };
}
function file(entities: PrefabEntity[], id = 'PREFAB-GUID'): PrefabFile {
  return { id, version: 1, name: 'Cylinder', rootLocalId: 1, entities };
}

// Existing on-disk prefab AFTER user edits: a 3-bone chain, plus a user BoneAttachment
// trait on bone1 and a user "Sword" child hung on bone1.
function existingPrefab(): PrefabFile {
  return file([
    ent(1, 'Cylinder', 0, { Transform: { y: 0 }, SkinnedModel: { model: 'm' }, SkeletalAnimator: { clip: 'bent' } }),
    ent(2, 'CylinderMesh', 1, { SkinnedMeshRenderer: { node: 'CylinderMesh', materials: {}, visible: true } }),
    ent(3, 'bone0', 1, { Transform: { y: 0 }, Bone: { name: 'bone0' } }),
    ent(4, 'bone1', 3, { Transform: { y: 1 }, Bone: { name: 'bone1' }, BoneAttachment: { target: 'x', bone: '' } }),
    ent(5, 'bone2', 4, { Transform: { y: 2 }, Bone: { name: 'bone2' } }),
    ent(99, 'Sword', 4, { Transform: { x: 0.5 }, Renderable3D: { mesh: 'sword' } }),
  ]);
}

// Fresh re-import: SAME bones (refreshed bind pose on bone1) but DIFFERENT positional
// localIds (shuffled) + a brand-new bone3 — to prove matching is by name, not position.
function freshPrefab(): PrefabFile {
  return file([
    ent(1, 'Cylinder', 0, { Transform: { y: 0 }, SkinnedModel: { model: 'm' }, SkeletalAnimator: { clip: 'bent' } }),
    ent(2, 'bone2', 5, { Transform: { y: 2 }, Bone: { name: 'bone2' } }),
    ent(3, 'bone0', 1, { Transform: { y: 0 }, Bone: { name: 'bone0' } }),
    ent(4, 'CylinderMesh', 1, { SkinnedMeshRenderer: { node: 'CylinderMesh', materials: {}, visible: true } }),
    ent(5, 'bone1', 3, { Transform: { y: 1.5 }, Bone: { name: 'bone1' } }),
    ent(6, 'bone3', 2, { Transform: { y: 3 }, Bone: { name: 'bone3' } }),
  ]);
}

const byName = (p: PrefabFile, n: string) => p.entities.find((e) => e.name === n)!;
const parentOf = (e: PrefabEntity) => (e.traits.EntityAttributes as Record<string, unknown>).parentId;

describe('mergeRiggedPrefab', () => {
  it('matches bones by name, keeping their existing localIds across a shuffled re-import', () => {
    const merged = mergeRiggedPrefab(freshPrefab(), existingPrefab());
    expect(byName(merged, 'Cylinder').localId).toBe(1);
    expect(byName(merged, 'CylinderMesh').localId).toBe(2);
    expect(byName(merged, 'bone0').localId).toBe(3);
    expect(byName(merged, 'bone1').localId).toBe(4);
    expect(byName(merged, 'bone2').localId).toBe(5);
  });

  it('keeps the user child attached to its bone by the stable localId', () => {
    const merged = mergeRiggedPrefab(freshPrefab(), existingPrefab());
    const sword = byName(merged, 'Sword');
    expect(sword).toBeTruthy();
    expect(sword.localId).toBe(99);              // preserved verbatim
    expect(parentOf(sword)).toBe(4);             // still parented to bone1 (lid 4)
    expect(byName(merged, 'bone1').localId).toBe(4);
  });

  it('refreshes the skeleton from source (fresh bind pose wins on shared traits)', () => {
    const merged = mergeRiggedPrefab(freshPrefab(), existingPrefab());
    expect((byName(merged, 'bone1').traits.Transform as Record<string, unknown>).y).toBe(1.5);
  });

  it('preserves a user-added trait the import does not emit (BoneAttachment on bone1)', () => {
    const merged = mergeRiggedPrefab(freshPrefab(), existingPrefab());
    expect(byName(merged, 'bone1').traits.BoneAttachment).toBeTruthy();
  });

  it('adds a brand-new bone with a non-colliding localId above every existing id', () => {
    const merged = mergeRiggedPrefab(freshPrefab(), existingPrefab());
    const bone3 = byName(merged, 'bone3');
    expect(bone3.localId).toBeGreaterThan(99);   // above the user Sword's id → no collision
    expect(parentOf(bone3)).toBe(5);             // child of bone2 (lid 5), remapped by name
    const ids = merged.entities.map((e) => e.localId);
    expect(new Set(ids).size).toBe(ids.length);  // all localIds unique
  });

  it('remaps fresh parentIds by identity, not by raw fresh localId', () => {
    const merged = mergeRiggedPrefab(freshPrefab(), existingPrefab());
    expect(parentOf(byName(merged, 'bone1'))).toBe(3);  // bone1 → bone0 (lid 3)
    expect(parentOf(byName(merged, 'bone2'))).toBe(4);  // bone2 → bone1 (lid 4)
    expect(parentOf(byName(merged, 'bone0'))).toBe(1);  // bone0 → root (lid 1)
  });

  it('re-anchors a user child to the root when its parent bone was removed by re-import', () => {
    // Existing has an "extra" bone with a user child; the fresh rig dropped that bone.
    const existing = file([
      ent(1, 'Cylinder', 0, { SkinnedModel: { model: 'm' } }),
      ent(2, 'bone0', 1, { Bone: { name: 'bone0' } }),
      ent(3, 'extra', 2, { Bone: { name: 'extra' } }),
      ent(77, 'Gem', 3, { Renderable3D: { mesh: 'gem' } }),  // child of the removed bone
    ]);
    const fresh = file([
      ent(1, 'Cylinder', 0, { SkinnedModel: { model: 'm' } }),
      ent(2, 'bone0', 1, { Bone: { name: 'bone0' } }),
    ]);
    const merged = mergeRiggedPrefab(fresh, existing);
    expect(merged.entities.find((e) => e.name === 'extra')).toBeUndefined();  // bone dropped
    const gem = byName(merged, 'Gem');
    expect(gem.localId).toBe(77);          // child preserved
    expect(parentOf(gem)).toBe(1);         // re-anchored to the model root
  });

  it('does not mutate the input prefab objects', () => {
    const existing = existingPrefab();
    const fresh = freshPrefab();
    const freshBone1ParentBefore = parentOf(byName(fresh, 'bone1'));
    mergeRiggedPrefab(fresh, existing);
    expect(parentOf(byName(fresh, 'bone1'))).toBe(freshBone1ParentBefore);  // fresh untouched
    expect(byName(existing, 'bone1').traits.BoneAttachment).toBeTruthy();    // existing untouched
  });
});
