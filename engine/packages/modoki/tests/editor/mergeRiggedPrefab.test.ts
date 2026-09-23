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

  // ── Top-level fields the merge does not itself compute (#1468) ───────────────────────────
  //
  // The merge used to return a five-field object literal — `id`, `version`, `name`,
  // `rootLocalId`, `entities` — so EVERY other top-level field of the on-disk document was
  // discarded on a rigged re-import. `moved` is what v4 added, so this was live data loss at the
  // version the repo already ships. It is also Phase 2A's own mechanism: a writer that drops a
  // top-level field it does not recognise is the writer that would drop node identity.

  it('carries the existing prefab\'s `moved` map through a re-import', () => {
    const existing = existingPrefab();
    existing.moved = { '4.7': '@member:7' };
    const merged = mergeRiggedPrefab(freshPrefab(), existing);
    expect(merged.moved).toEqual({ '4.7': '@member:7' });
  });

  it('does not invent a `moved` map when the existing prefab has none', () => {
    // The accept side: carrying the field must not turn an absent one into `{}`, which would
    // change every ordinary rigged prefab's bytes and make the field meaningless as a signal.
    const merged = mergeRiggedPrefab(freshPrefab(), existingPrefab());
    expect('moved' in merged).toBe(false);
  });

  it('carries a top-level field this build does not know about', () => {
    // The additive rule (runtime/core/formatVersion.ts): an older build meeting a document a
    // newer one wrote reads the fields it understands and leaves the rest alone. `existing` is
    // the on-disk document and is the only side that can carry one — `fresh` is this importer's
    // own output.
    const existing = existingPrefab() as PrefabFile & { futureField?: unknown };
    existing.futureField = { some: 'v6 thing' };
    const merged = mergeRiggedPrefab(freshPrefab(), existing) as PrefabFile & { futureField?: unknown };
    expect(merged.futureField).toEqual({ some: 'v6 thing' });
  });

  // ── Node identity across a regeneration (#1468 design record: the node guid, part 2) ─────────────────────────────
  //
  // A minted id cannot survive a document rebuilt from a GLB that has never heard of it, so the
  // merge's CONTENT match — already here to keep a bone's localId — is what carries it.

  it('carries a matched bone\'s node identity across the re-import, not the fresh one', () => {
    const existing = existingPrefab();
    byName(existing, 'bone1').nodeGuid = 'NODE-BONE1';
    byName(existing, 'Cylinder').nodeGuid = 'NODE-ROOT';
    const fresh = freshPrefab();
    byName(fresh, 'bone1').nodeGuid = 'FRESHLY-MINTED';
    const merged = mergeRiggedPrefab(fresh, existing);
    expect(byName(merged, 'bone1').nodeGuid).toBe('NODE-BONE1');
    expect(byName(merged, 'Cylinder').nodeGuid).toBe('NODE-ROOT');
  });

  it('keeps the freshly minted identity for a bone the re-import ADDED', () => {
    // bone3 is in `fresh` and not in `existing` — there is no prior identity to carry, and the
    // guid `serializePrefab` minted for it when the importer built the fresh document stands.
    const fresh = freshPrefab();
    byName(fresh, 'bone3').nodeGuid = 'FRESH-BONE3';
    const merged = mergeRiggedPrefab(fresh, existingPrefab());
    expect(byName(merged, 'bone3').nodeGuid).toBe('FRESH-BONE3');
  });

  it('preserves a user-added entity\'s identity untouched', () => {
    const existing = existingPrefab();
    byName(existing, 'Sword').nodeGuid = 'NODE-SWORD';
    expect(byName(mergeRiggedPrefab(freshPrefab(), existing), 'Sword').nodeGuid).toBe('NODE-SWORD');
  });

  it('does not add a node guid where neither side has one', () => {
    // The accept side. A pre-v5 document merged by a pre-v5 fresh import stays without identity
    // until something SAVES it; the merge is not a writer and must not mint.
    const merged = mergeRiggedPrefab(freshPrefab(), existingPrefab());
    for (const e of merged.entities) expect('nodeGuid' in e).toBe(false);
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
