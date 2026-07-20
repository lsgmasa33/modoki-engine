/** Deform (per-vertex mesh) timelines — headless gate. Covers the pure interpolation
 *  (evalDeformTrack) and the skin2DSystem integration: a deform offset is added to the
 *  BIND vertices before linear-blend skinning, participates in the idle-skip decision
 *  (mesh flutter re-skins even with a static bone pose), and auto-expires when a frame
 *  doesn't re-write it (epoch). No renderer, no wall-clock. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { Transform, SkinnedSprite2D, Bone2D, EntityAttributes } from '../../src/runtime/traits';
import { skin2DSystem } from '../../src/runtime/systems/skin2DSystem';
import { getSkin2DBuffer, clearSkin2DBuffers } from '../../src/runtime/systems/skin2DBuffers';
import {
  beginDeform2DFrame, setDeform2D, clearDeform2DBuffers, getDeform2D, getDeform2DVersion,
} from '../../src/runtime/systems/deform2DBuffers';
import { evalDeformTrack } from '../../src/runtime/animation/deformEval';
import type { DeformTrack } from '../../src/runtime/animation/types';
import { setRig2D, clearRig2DCache } from '../../src/runtime/loaders/rig2dCache';

const RIG = 'deform.rig2d.json';
// A single 'root' bone owns all 4 verts (weight 1) — so at bind the skinMatrix is
// identity and any deform offset shows through 1:1 (isolates the deform math).
const rigDef = {
  id: '', sprite: '',
  bones: [{ name: 'root', parent: -1, x: 0, y: 0, rot: 0 }],
  mesh: { verts: [[0, 0], [10, 0], [20, 0], [20, 10]], uvs: [[0, 0], [0, 0], [0, 0], [0, 0]], tris: [0, 1, 2, 0, 2, 3] },
  skinIndices: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  skinWeights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
};

let world: ReturnType<typeof createWorld> | undefined;
afterEach(() => { world?.destroy(); world = undefined; clearSkin2DBuffers(); clearRig2DCache(); clearDeform2DBuffers(); });

function setup() {
  clearRig2DCache(); clearSkin2DBuffers(); clearDeform2DBuffers();
  setRig2D(RIG, rigDef);
  world = createWorld();
  const root = world.spawn(Transform(), SkinnedSprite2D({ rig: RIG }));
  world.spawn(Transform({ x: 0, y: 0 }), Bone2D({ name: 'root' }), EntityAttributes({ guid: 'rb', parentId: root.id() }));
  return { root };
}
const posOf = (id: number) => Array.from(getSkin2DBuffer(id)!.parts[0].positions);

describe('evalDeformTrack — pure interpolation', () => {
  const track: DeformTrack = {
    path: '', part: 'main',
    keys: [
      { t: 0, offsets: [0, 0, 0, 0] },
      { t: 1, offsets: [10, -4, 2, 6] },
    ],
  };

  it('holds the first/last key outside the range', () => {
    expect(Array.from(evalDeformTrack(track, -5)!)).toEqual([0, 0, 0, 0]);
    expect(Array.from(evalDeformTrack(track, 9)!)).toEqual([10, -4, 2, 6]);
  });

  it('linearly interpolates componentwise at the midpoint', () => {
    expect(Array.from(evalDeformTrack(track, 0.5)!)).toEqual([5, -2, 1, 3]);
  });

  it('returns null for an empty track, and the sole key for a 1-key track', () => {
    expect(evalDeformTrack({ path: '', part: 'x', keys: [] }, 0)).toBeNull();
    expect(Array.from(evalDeformTrack({ path: '', part: 'x', keys: [{ t: 2, offsets: [7, 8] }] }, 0)!)).toEqual([7, 8]);
  });
});

describe('deform2DBuffers — epoch expiry + version', () => {
  it('an entry read is valid only within its write epoch', () => {
    clearDeform2DBuffers();
    beginDeform2DFrame();
    setDeform2D(42, 'main', new Float32Array([1, 2]));
    expect(getDeform2D(42, 'main')).toEqual(new Float32Array([1, 2]));
    beginDeform2DFrame();                       // next frame, not re-written
    expect(getDeform2D(42, 'main')).toBeUndefined();
    expect(getDeform2DVersion(42)).toBe(0);     // stale epoch → no version
  });

  it('version strictly increases across re-writes (change detection)', () => {
    clearDeform2DBuffers();
    beginDeform2DFrame(); setDeform2D(7, 'a', new Float32Array([0]));
    const v1 = getDeform2DVersion(7);
    beginDeform2DFrame(); setDeform2D(7, 'a', new Float32Array([1]));
    expect(getDeform2DVersion(7)).toBeGreaterThan(v1);
  });
});

describe('skin2DSystem — deform integration', () => {
  it('adds the deform offset to the bind verts before skinning (identity pose)', () => {
    const { root } = setup();
    skin2DSystem(world!);                        // build at bind
    near0(posOf(root.id()), [0, 0, 10, 0, 20, 0, 20, 10]);

    beginDeform2DFrame();
    // push v2 (offset 4) by (+5,+5) and v3 (offset 6) by (-2,0)
    setDeform2D(root.id(), 'main', new Float32Array([0, 0, 0, 0, 5, 5, -2, 0]));
    skin2DSystem(world!);
    near0(posOf(root.id()), [0, 0, 10, 0, 25, 5, 18, 10]);
  });

  it('re-skins on a deform change even when the bone pose is unchanged (mesh flutter)', () => {
    const { root } = setup();
    skin2DSystem(world!);
    const vBind = getSkin2DBuffer(root.id())!.version;

    beginDeform2DFrame();
    setDeform2D(root.id(), 'main', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
    skin2DSystem(world!);
    const vDeform = getSkin2DBuffer(root.id())!.version;
    expect(vDeform).toBeGreaterThan(vBind);      // deform bumped the version despite static bones
    expect(posOf(root.id())[0]).toBeCloseTo(1, 5);
  });

  it('reverts to bind when a later frame drops the deform (epoch expiry)', () => {
    const { root } = setup();
    skin2DSystem(world!);
    beginDeform2DFrame();
    setDeform2D(root.id(), 'main', new Float32Array([9, 9, 0, 0, 0, 0, 0, 0]));
    skin2DSystem(world!);
    expect(posOf(root.id())[0]).toBeCloseTo(9, 5);

    beginDeform2DFrame();                         // new epoch, no deform written
    skin2DSystem(world!);
    near0(posOf(root.id()), [0, 0, 10, 0, 20, 0, 20, 10]);
  });
});

function near0(got: number[], want: number[]) {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) expect(got[i]).toBeCloseTo(want[i], 5);
}
