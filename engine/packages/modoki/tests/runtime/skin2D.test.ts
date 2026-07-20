/** 2D sprite skinning — headless determinism gate. Drives skin2DSystem against a
 *  real koota world + a hand-built 2-bone rig deforming a quad, and asserts the
 *  CPU-skinned vertex buffer (skin2DBuffers) matches hand-computed linear-blend
 *  skinning — no renderer, no wall-clock. Also unit-tests the pure rig2dMath core. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { Transform, SkinnedSprite2D, Bone2D, EntityAttributes } from '../../src/runtime/traits';
import { skin2DSystem } from '../../src/runtime/systems/skin2DSystem';
import { getSkin2DBuffer, clearSkin2DBuffers } from '../../src/runtime/systems/skin2DBuffers';
import { setRig2D, clearRig2DCache, normalizeRig2D } from '../../src/runtime/loaders/rig2dCache';
import {
  identity2D, compose2D, mul2D, invert2D, apply2D, skinVertex2D, deriveBindMatrices, removeScale2D,
} from '../../src/runtime/skinning/rig2dMath';

// A 2-bone rig: 'root' at origin, 'arm' at (10,0) under root. Quad verts run down the
// arm; bone 0 owns v0, bone 1 (arm) owns v1/v2/v3. Bind pose = the authored verts.
const RIG = 'test.rig2d.json';
const rigDef = {
  id: '',
  sprite: '',
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

function setup() {
  clearRig2DCache(); clearSkin2DBuffers();
  setRig2D(RIG, rigDef);
  world = createWorld();
  const root = world.spawn(Transform(), SkinnedSprite2D({ rig: RIG }));
  // Entity hierarchy mirrors the rig: rootBone under the SkinnedSprite2D, arm under rootBone.
  const rootBone = world.spawn(Transform({ x: 0, y: 0 }), Bone2D({ name: 'root' }), EntityAttributes({ guid: 'rb', parentId: root.id() }));
  const arm = world.spawn(Transform({ x: 10, y: 0 }), Bone2D({ name: 'arm' }), EntityAttributes({ guid: 'arm', parentId: rootBone.id() }));
  return { root, rootBone, arm };
}

const posOf = (id: number) => Array.from(getSkin2DBuffer(id)!.parts[0].positions);
const near = (got: number[], want: number[]) => {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) expect(got[i]).toBeCloseTo(want[i], 5);
};

describe('skin2DSystem — CPU linear-blend skinning', () => {
  it('at bind pose the deformed positions equal the bind verts (skinMatrix = identity)', () => {
    const { root } = setup();
    skin2DSystem(world!);
    near(posOf(root.id()), [0, 0, 10, 0, 20, 0, 20, 10]);
  });

  it('rotating the arm bone 90° bends its verts about the arm base, leaving root verts put', () => {
    const { root, arm } = setup();
    skin2DSystem(world!); // build + bind

    arm.set(Transform, { ...arm.get(Transform)!, rz: Math.PI / 2 });
    skin2DSystem(world!);

    // arm pivot = (10,0). v0 (root-owned) stays; v1 is the pivot; v2 (20,0)→(10,10); v3 (20,10)→(0,10).
    near(posOf(root.id()), [0, 0, 10, 0, 10, 10, 0, 10]);
  });

  it('an unchanged pose does not bump the deform version (idle rigs cost nothing)', () => {
    const { root } = setup();
    skin2DSystem(world!);
    const v1 = getSkin2DBuffer(root.id())!.version;
    skin2DSystem(world!); // same pose
    skin2DSystem(world!);
    expect(getSkin2DBuffer(root.id())!.version).toBe(v1);
  });

  it('drops the buffer when the SkinnedSprite2D entity is removed', () => {
    const { root } = setup();
    skin2DSystem(world!);
    expect(getSkin2DBuffer(root.id())).toBeDefined();
    root.destroy();
    skin2DSystem(world!);
    expect(getSkin2DBuffer(root.id())).toBeUndefined();
  });
});

describe('rig2dMath — pure affine + LBS core', () => {
  it('compose ∘ invert = identity', () => {
    const m = compose2D(3, -4, 0.7, 2, 0.5);
    const r = mul2D(m, invert2D(m));
    expect(r.a).toBeCloseTo(1, 6); expect(r.d).toBeCloseTo(1, 6);
    expect(r.b).toBeCloseTo(0, 6); expect(r.c).toBeCloseTo(0, 6);
    expect(r.e).toBeCloseTo(0, 6); expect(r.f).toBeCloseTo(0, 6);
  });

  it('removeScale2D keeps rotation + translation but normalizes scale to 1 (noScale)', () => {
    const m = compose2D(7, -3, Math.PI / 6, 4, 4); // scale 4, rotate 30°, translate (7,-3)
    const r = removeScale2D(m);
    expect(Math.hypot(r.a, r.b)).toBeCloseTo(1, 6); // unit-length basis columns
    expect(Math.hypot(r.c, r.d)).toBeCloseTo(1, 6);
    expect(r.e).toBe(7); expect(r.f).toBe(-3);      // translation untouched
    // Rotation preserved: matches a pure rotation of the same angle.
    const rot = compose2D(7, -3, Math.PI / 6, 1, 1);
    expect(r.a).toBeCloseTo(rot.a, 6); expect(r.b).toBeCloseTo(rot.b, 6);
  });

  it('invert of a singular (zero-scale) matrix falls back to identity, not NaN', () => {
    const inv = invert2D(compose2D(5, 5, 0, 0, 0));
    expect(inv).toEqual(identity2D());
  });

  it('apply2D transforms a point through the affine', () => {
    const out = new Float32Array(2);
    apply2D(compose2D(1, 2, Math.PI / 2, 1, 1), 3, 0, out, 0);
    expect(out[0]).toBeCloseTo(1, 6); // rotate (3,0) 90° → (0,3), + translate (1,2)
    expect(out[1]).toBeCloseTo(5, 6);
  });

  it('deriveBindMatrices gives identity skinning at bind (rootLocal · invBind = I)', () => {
    const { rootLocal, invBind } = deriveBindMatrices(rigDef.bones);
    for (let i = 0; i < rigDef.bones.length; i++) {
      const s = mul2D(rootLocal[i], invBind[i]);
      expect(s.a).toBeCloseTo(1, 6); expect(s.d).toBeCloseTo(1, 6);
      expect(s.e).toBeCloseTo(0, 6); expect(s.f).toBeCloseTo(0, 6);
    }
  });

  it('skinVertex2D blends two bone matrices by weight', () => {
    const mats = [identity2D(), compose2D(0, 10, 0, 1, 1)]; // bone1 shifts +10 in y
    const out = new Float32Array(2);
    // 50/50 blend of identity and (+10 y) on point (4,0) → (4, 5)
    skinVertex2D(4, 0, [0, 1, 0, 0], [0.5, 0.5, 0, 0], 0, mats, out, 0);
    expect(out[0]).toBeCloseTo(4, 6);
    expect(out[1]).toBeCloseTo(5, 6);
  });
});

describe('normalizeRig2D — weight hygiene', () => {
  it('renormalizes per-vertex weights to sum 1 and clamps out-of-range bone indices', () => {
    const r = normalizeRig2D({
      bones: [{ name: 'a', parent: -1, x: 0, y: 0, rot: 0 }],
      mesh: { verts: [[0, 0]], uvs: [[0, 0]], tris: [] },
      skinIndices: [0, 9, 0, 0], // 9 is out of range → clamped to 0
      skinWeights: [2, 2, 0, 0], // sum 4 → each 0.5
    });
    expect(r.skinWeights[0]).toBeCloseTo(0.5, 6);
    expect(r.skinWeights[1]).toBeCloseTo(0.5, 6);
    expect(r.skinIndices[1]).toBe(0);
  });
});

describe('skin2DSystem — grouping / robustness', () => {
  function spawnRig(rig: string) {
    const root = world!.spawn(Transform(), SkinnedSprite2D({ rig }));
    const rootBone = world!.spawn(Transform({ x: 0, y: 0 }), Bone2D({ name: 'root' }), EntityAttributes({ parentId: root.id() }));
    const arm = world!.spawn(Transform({ x: 10, y: 0 }), Bone2D({ name: 'arm' }), EntityAttributes({ parentId: rootBone.id() }));
    return { root, rootBone, arm };
  }

  it('a rig bone with no matching Bone2D entity falls back to identity (verts at bind)', () => {
    clearRig2DCache(); clearSkin2DBuffers();
    setRig2D(RIG, rigDef);
    world = createWorld();
    const root = world.spawn(Transform(), SkinnedSprite2D({ rig: RIG }));
    // Only the 'root' bone exists; 'arm' (which owns v1/v2/v3) is absent.
    world.spawn(Transform({ x: 0, y: 0 }), Bone2D({ name: 'root' }), EntityAttributes({ parentId: root.id() }));
    skin2DSystem(world!);
    near(posOf(root.id()), [0, 0, 10, 0, 20, 0, 20, 10]); // arm verts stay at bind
  });

  it('two roots keep independent buffers — posing one does not touch the other', () => {
    clearRig2DCache(); clearSkin2DBuffers();
    setRig2D(RIG, rigDef);
    world = createWorld();
    const a = spawnRig(RIG);
    const b = spawnRig(RIG);
    skin2DSystem(world!);

    a.arm.set(Transform, { ...a.arm.get(Transform)!, rz: Math.PI / 2 });
    skin2DSystem(world!);

    near(posOf(b.root.id()), [0, 0, 10, 0, 20, 0, 20, 10]); // B untouched at bind
    expect(posOf(a.root.id())[4]).toBeCloseTo(10, 4);        // A's v2 x: 20 → 10 (bent)
  });

  it('an orphan Bone2D (no SkinnedSprite2D ancestor) is ignored without error', () => {
    clearRig2DCache(); clearSkin2DBuffers();
    setRig2D(RIG, rigDef);
    world = createWorld();
    world.spawn(Transform({ x: 5, y: 5 }), Bone2D({ name: 'orphan' }), EntityAttributes({ parentId: 0 }));
    const root = world.spawn(Transform(), SkinnedSprite2D({ rig: RIG }));
    world.spawn(Transform({ x: 0, y: 0 }), Bone2D({ name: 'root' }), EntityAttributes({ parentId: root.id() }));
    expect(() => skin2DSystem(world!)).not.toThrow();
    expect(getSkin2DBuffer(root.id())).toBeDefined();
  });

  it('re-weighting the rig live (setRig2D) re-skins even at an unchanged pose', () => {
    clearRig2DCache(); clearSkin2DBuffers();
    setRig2D(RIG, rigDef);
    world = createWorld();
    const { root, arm } = spawnRig(RIG);
    arm.set(Transform, { ...arm.get(Transform)!, rz: Math.PI / 2 });
    skin2DSystem(world!);
    const before = posOf(root.id());
    expect(before[4]).toBeCloseTo(10, 4); expect(before[5]).toBeCloseTo(10, 4); // v2 is arm-weighted → bent

    // Re-weight v2 (vertex 2 → offset 8) from arm to root. Pose is UNCHANGED.
    const reweighted = { ...rigDef, skinIndices: [...rigDef.skinIndices], skinWeights: [...rigDef.skinWeights] };
    reweighted.skinIndices[8] = 0; // arm(1) → root(0)
    setRig2D(RIG, reweighted);
    skin2DSystem(world!);
    const after = posOf(root.id());
    expect(after[4]).toBeCloseTo(20, 4); expect(after[5]).toBeCloseTo(0, 4); // v2 now follows root (bind)
  });
});
