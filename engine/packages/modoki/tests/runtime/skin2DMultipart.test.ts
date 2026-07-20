/** Phase 8a — multi-part (v2) rigs + `noScale` bone inherit. A rig can carry many parts
 *  sharing one skeleton; each part skins into its own buffer. `noScale` bones ignore an
 *  ancestor's animated scale (Spine transform mode). v1 rigs normalize to a single part.
 *  Headless — asserts the buffers + the parsed rig, no renderer. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { Transform, SkinnedSprite2D, Bone2D, EntityAttributes } from '../../src/runtime/traits';
import { skin2DSystem } from '../../src/runtime/systems/skin2DSystem';
import { getSkin2DBuffer, clearSkin2DBuffers } from '../../src/runtime/systems/skin2DBuffers';
import { setRig2D, clearRig2DCache, normalizeRig2D } from '../../src/runtime/loaders/rig2dCache';

let world: ReturnType<typeof createWorld> | undefined;
afterEach(() => { world?.destroy(); world = undefined; clearSkin2DBuffers(); clearRig2DCache(); });

describe('normalizeRig2D — v1 → one part', () => {
  it('synthesizes a single part from top-level sprite/mesh/skinIndices/skinWeights', () => {
    const parsed = normalizeRig2D({
      sprite: 'tex', bones: [{ name: 'root', parent: -1 }],
      mesh: { verts: [[0, 0], [4, 0]], uvs: [[0, 0], [1, 0]], tris: [0, 1, 1] },
      skinIndices: [0, 0, 0, 0, 0, 0, 0, 0], skinWeights: [1, 0, 0, 0, 1, 0, 0, 0],
    });
    expect(parsed.parts).toHaveLength(1);
    expect(parsed.parts[0].sprite).toBe('tex');
    expect(parsed.parts[0].vertCount).toBe(2);
    // Back-compat aliases point at parts[0].
    expect(parsed.verts).toBe(parsed.parts[0].verts);
    expect(parsed.vertCount).toBe(2);
  });

  it('parses a v2 parts[] and sorts by draw order', () => {
    const parsed = normalizeRig2D({
      bones: [{ name: 'root', parent: -1 }],
      parts: [
        { name: 'front', sprite: 'b', order: 5, mesh: { verts: [[0, 0]], uvs: [[0, 0]], tris: [] }, skinIndices: [0, 0, 0, 0], skinWeights: [1, 0, 0, 0] },
        { name: 'back', sprite: 'a', order: 1, mesh: { verts: [[0, 0]], uvs: [[0, 0]], tris: [] }, skinIndices: [0, 0, 0, 0], skinWeights: [1, 0, 0, 0] },
      ],
    });
    expect(parsed.parts.map((p) => p.name)).toEqual(['back', 'front']); // order 1 before 5
  });
});

describe('skin2DSystem — multi-part rig', () => {
  // Two bones (root, arm@(10,0)); two parts, each a single vert bound to one bone.
  const RIG = 'mp.rig2d.json';
  function setup() {
    clearRig2DCache(); clearSkin2DBuffers();
    setRig2D(RIG, {
      bones: [{ name: 'root', parent: -1, x: 0, y: 0 }, { name: 'arm', parent: 0, x: 10, y: 0 }],
      parts: [
        { name: 'partRoot', sprite: 'a', order: 0, mesh: { verts: [[0, 0]], uvs: [[0, 0]], tris: [] }, skinIndices: [0, 0, 0, 0], skinWeights: [1, 0, 0, 0] },
        { name: 'partArm', sprite: 'b', order: 1, mesh: { verts: [[10, 0]], uvs: [[0, 0]], tris: [] }, skinIndices: [1, 0, 0, 0], skinWeights: [1, 0, 0, 0] },
      ],
    });
    world = createWorld();
    const root = world.spawn(Transform(), SkinnedSprite2D({ rig: RIG }));
    const rootBone = world.spawn(Transform({ x: 0, y: 0 }), Bone2D({ name: 'root' }), EntityAttributes({ guid: 'rb', parentId: root.id() }));
    const arm = world.spawn(Transform({ x: 10, y: 0 }), Bone2D({ name: 'arm' }), EntityAttributes({ guid: 'arm', parentId: rootBone.id() }));
    return { root, arm };
  }

  it('builds one buffer part per rig part, in draw order', () => {
    const { root } = setup();
    skin2DSystem(world!);
    const buf = getSkin2DBuffer(root.id())!;
    expect(buf.parts).toHaveLength(2);
    expect(buf.parts.map((p) => p.name)).toEqual(['partRoot', 'partArm']);
    expect(buf.parts.map((p) => p.order)).toEqual([0, 1]);
  });

  it('deforms each part by its own bone — posing the arm moves only the arm part', () => {
    const { root, arm } = setup();
    skin2DSystem(world!);
    // Rotate the arm bone 90° CCW; its part's vert swings about the arm base (10,0).
    arm.set(Transform, { x: 10, y: 0, rz: Math.PI / 2, sx: 1, sy: 1 });
    skin2DSystem(world!);
    const buf = getSkin2DBuffer(root.id())!;
    // partRoot vert (bound to root) stays at the origin.
    expect(Array.from(buf.parts[0].positions)).toEqual([0, 0]);
    // partArm vert was AT the arm base (10,0), so rotating about the base leaves it put.
    expect(buf.parts[1].positions[0]).toBeCloseTo(10, 5);
    expect(buf.parts[1].positions[1]).toBeCloseTo(0, 5);
  });
});

describe('skin2DSystem — noScale bone inherit', () => {
  // root bone 'p' (live-scaled ×2), child 'c' at (10,0); one vert AT (10,0) bound to 'c'.
  function run(noScale: boolean): number[] {
    clearRig2DCache(); clearSkin2DBuffers();
    setRig2D('ns.rig2d.json', {
      bones: [{ name: 'p', parent: -1, x: 0, y: 0 }, { name: 'c', parent: 0, x: 10, y: 0, noScale }],
      mesh: { verts: [[10, 0]], uvs: [[0, 0]], tris: [] }, skinIndices: [1, 0, 0, 0], skinWeights: [1, 0, 0, 0],
    });
    world = createWorld();
    const root = world.spawn(Transform(), SkinnedSprite2D({ rig: 'ns.rig2d.json' }));
    const p = world.spawn(Transform({ x: 0, y: 0, sx: 2, sy: 2 }), Bone2D({ name: 'p' }), EntityAttributes({ guid: 'p', parentId: root.id() }));
    world.spawn(Transform({ x: 10, y: 0 }), Bone2D({ name: 'c' }), EntityAttributes({ guid: 'c', parentId: p.id() }));
    skin2DSystem(world!);
    return Array.from(getSkin2DBuffer(root.id())!.parts[0].positions);
  }

  it('a normal child INHERITS the parent scale (vert pushed out ×2)', () => {
    const [x, y] = run(false);
    expect(x).toBeCloseTo(20, 5); // 10 × parent-scale 2
    expect(y).toBeCloseTo(0, 5);
  });

  it('a noScale child IGNORES the parent scale (vert stays put)', () => {
    const [x, y] = run(true);
    expect(x).toBeCloseTo(10, 5); // parent scale stripped
    expect(y).toBeCloseTo(0, 5);
  });
});
