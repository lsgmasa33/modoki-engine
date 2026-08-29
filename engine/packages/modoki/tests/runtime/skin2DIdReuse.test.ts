/** #336 — `skin2DSystem`'s cross-frame state and koota's recycled entity index.
 *
 *  `skin2DSystem` holds `lastRigKeyByEntity`/`lastSkinMatsByEntity`/`lastRigObjByEntity`/
 *  `lastDeformVerByEntity`/`lastBuildUnresolvedByEntity` plus the `skin2DBuffers` registry ACROSS
 *  frames, all keyed by `entity.id()` — the masked index, generation stripped — and its
 *  `trackedRootIds` sweep runs at the END of a pass. Structurally that is the same shape as the
 *  fixed zone bug (QA-ZONE-0003) and the `videoSystem` one fixed alongside this file: a despawn
 *  immediately followed by a same-shape respawn reclaims the exact freed index, so the reused id
 *  reads the dead entity's cache entries as its own.
 *
 *  These tests pin the INVARIANT that makes the collision harmless here, because it is a property
 *  of the code rather than of the keying, and nothing else states it: every skin2D cache entry is
 *  revalidated against a value RECOMPUTED this frame — the rig key, the parsed-rig object
 *  identity, the part topology, the skin matrices and the deform version — so an inherited entry
 *  is either re-derived or found stale and rebuilt. It is never TRUSTED as "this is still my
 *  entity" the way `videoSystem`'s live decoder handle was. Break that (add a cache entry whose
 *  freshness check is not recomputed per frame) and these tests are what notices. */

import { describe, it, expect, afterEach } from 'vitest';
import '../../src/runtime/loaders/registerProviders';
import { createWorld } from 'koota';
import { Transform, SkinnedSprite2D, Bone2D, EntityAttributes } from '../../src/runtime/traits';
import { skin2DSystem } from '../../src/runtime/skinning/skin2DSystem';
import { getSkin2DBuffer, clearSkin2DBuffers } from '../../src/runtime/skinning/skin2DBuffers';
import { setRig2D, clearRig2DCache } from '../../src/runtime/loaders/rig2dCache';

// Two bones, 'root' at the origin and 'arm' at (10,0) under it; the quad's verts run down the arm
// so a rotation of 'arm' visibly moves v1..v3 and leaves v0 alone.
const RIG = 'reuse.rig2d.json';
const rigDef = {
  id: '', sprite: '',
  bones: [
    { name: 'root', parent: -1, x: 0, y: 0, rot: 0 },
    { name: 'arm', parent: 0, x: 10, y: 0, rot: 0 },
  ],
  mesh: {
    verts: [[0, 0], [10, 0], [20, 0], [20, 10]],
    uvs: [[0, 0], [0.5, 0], [1, 0], [1, 0.5]],
    tris: [0, 1, 2, 0, 2, 3],
  },
  skinIndices: [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  skinWeights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
};

let world: ReturnType<typeof createWorld> | undefined;
afterEach(() => { world?.destroy(); world = undefined; clearSkin2DBuffers(); clearRig2DCache(); });

/** A skinned root plus its two bone entities, with `arm` rotated by `armRot` radians. */
function spawnRig(armRot: number) {
  const root = world!.spawn(Transform(), SkinnedSprite2D({ rig: RIG }));
  const rootBone = world!.spawn(
    Transform({ x: 0, y: 0 }), Bone2D({ name: 'root' }),
    EntityAttributes({ guid: 'rb', parentId: root.id() }),
  );
  world!.spawn(
    Transform({ x: 10, y: 0, rz: armRot }), Bone2D({ name: 'arm' }),
    EntityAttributes({ guid: 'arm', parentId: rootBone.id() }),
  );
  return root;
}

const posOf = (id: number) => Array.from(getSkin2DBuffer(id)!.parts[0].positions);

describe('skin2DSystem — recycled entity index', () => {
  it('a same-index respawn is skinned to its OWN pose, not the dead root\'s', () => {
    clearRig2DCache(); clearSkin2DBuffers();
    setRig2D(RIG, rigDef);
    world = createWorld();

    // `a` is posed with the arm rotated a quarter turn, so its buffer is well away from bind.
    const a = spawnRig(Math.PI / 2);
    skin2DSystem(world);
    const posedA = posOf(a.id());
    expect(posedA[2]).toBeCloseTo(10, 5);   // v1 sits at the arm's pivot either way…
    expect(posedA[4]).not.toBeCloseTo(20, 5); // …but v2 has swung off the x-axis.

    // Destroy the whole rig and immediately rebuild it AT BIND. koota's free list is LIFO, so the
    // ROOT is destroyed LAST — that leaves its index on top of the list for `spawnRig`'s first
    // spawn to reclaim. Asserted below, so this fails loudly rather than passing vacuously if
    // that ever changes.
    for (const e of [...world.query(Bone2D)]) e.destroy();
    a.destroy();
    const b = spawnRig(0);
    expect(b.id()).toBe(a.id());
    expect(b.valueOf()).not.toBe(a.valueOf());

    skin2DSystem(world);

    // `b` is at bind, so its verts are the authored ones. Inheriting `a`'s cached skin matrices
    // through the idle fast-path would have left the rotated pose on screen.
    const posedB = posOf(b.id());
    expect(posedB[0]).toBeCloseTo(0, 5);
    expect(posedB[2]).toBeCloseTo(10, 5);
    expect(posedB[4]).toBeCloseTo(20, 5);
    expect(posedB[6]).toBeCloseTo(20, 5);
  });

  it('a same-index respawn onto a DIFFERENT rig rebuilds the buffer for the new topology', () => {
    // The build cache keys on the rig REF and the parsed-rig object, both recomputed per frame,
    // so a reused index carrying the previous rig's key forces a rebuild rather than serving the
    // dead root's geometry.
    const RIG2 = 'reuse2.rig2d.json';
    clearRig2DCache(); clearSkin2DBuffers();
    setRig2D(RIG, rigDef);
    setRig2D(RIG2, {
      ...rigDef,
      mesh: { verts: [[0, 0], [5, 0], [5, 5]], uvs: [[0, 0], [1, 0], [1, 1]], tris: [0, 1, 2] },
      skinIndices: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      skinWeights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    });
    world = createWorld();

    const a = world.spawn(Transform(), SkinnedSprite2D({ rig: RIG }));
    skin2DSystem(world);
    expect(getSkin2DBuffer(a.id())!.parts[0].positions).toHaveLength(8); // 4 verts

    a.destroy();
    const b = world.spawn(Transform(), SkinnedSprite2D({ rig: RIG2 }));
    expect(b.id()).toBe(a.id());
    skin2DSystem(world);

    expect(getSkin2DBuffer(b.id())!.parts[0].positions).toHaveLength(6); // 3 verts — rebuilt
    expect(posOf(b.id())).toEqual([0, 0, 5, 0, 5, 5]);
  });
});
