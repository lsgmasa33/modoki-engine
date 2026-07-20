/** Auto-rig generation — tessellation, auto-weights, and end-to-end build→skin.
 *  Pure/deterministic units plus one integration test that builds a rig from a
 *  sprite + bones and drives it through skin2DSystem. Headless, no renderer. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { generateGridMesh } from '../../src/runtime/skinning/rig2dTessellate';
import { computeAutoWeights } from '../../src/runtime/skinning/rig2dAutoWeights';
import { suggestBones } from '../../src/runtime/skinning/rig2dAutoBones';
import { buildRig2D, autoRig2D } from '../../src/runtime/skinning/rig2dBuild';
import { deriveBindMatrices } from '../../src/runtime/skinning/rig2dMath';
import { Transform, SkinnedSprite2D, Bone2D, EntityAttributes } from '../../src/runtime/traits';
import { skin2DSystem } from '../../src/runtime/systems/skin2DSystem';
import { getSkin2DBuffer, clearSkin2DBuffers } from '../../src/runtime/systems/skin2DBuffers';
import { setRig2D, clearRig2DCache, normalizeRig2D } from '../../src/runtime/loaders/rig2dCache';

describe('generateGridMesh', () => {
  it('builds a full quad grid with 0..1 UVs and pivot-centered texture-space verts', () => {
    const m = generateGridMesh({ width: 64, height: 64, cols: 2, rows: 2 });
    expect(m.verts.length).toBe(9);   // (cols+1)(rows+1)
    expect(m.uvs.length).toBe(9);
    expect(m.tris.length).toBe(2 * 2 * 6); // 2 tris * 6 idx per cell
    // Corners at ±half-size (pivot 0.5), UVs at the unit-square corners.
    expect(m.verts[0]).toEqual([-32, -32]);
    expect(m.uvs[0]).toEqual([0, 0]);
    expect(m.verts[8]).toEqual([32, 32]);
    expect(m.uvs[8]).toEqual([1, 1]);
    // Every triangle index is in range.
    for (const i of m.tris) { expect(i).toBeGreaterThanOrEqual(0); expect(i).toBeLessThan(9); }
  });

  it('culls fully-uncovered cells and re-indexes compactly (left-half coverage)', () => {
    const full = generateGridMesh({ width: 40, height: 40, cols: 4, rows: 4 });
    const left = generateGridMesh({ width: 40, height: 40, cols: 4, rows: 4, isInside: (u) => u < 0.5 });
    expect(left.verts.length).toBeLessThan(full.verts.length); // right half dropped
    expect(left.tris.length).toBeLessThan(full.tris.length);
    for (const i of left.tris) { expect(i).toBeGreaterThanOrEqual(0); expect(i).toBeLessThan(left.verts.length); }
  });
});

describe('computeAutoWeights', () => {
  const bones = [
    { name: 'base', parent: -1, x: 0, y: 40, rot: 0 }, // origin (0,40) — bottom
    { name: 'tip', parent: 0, x: 0, y: -80, rot: 0 },  // origin (0,-40) — top
  ];

  it('normalizes each vertex to sum 1 with ≤ maxInfluences non-zero weights', () => {
    const verts = [[0, -40], [0, 0], [0, 40], [16, -40]];
    const w = computeAutoWeights(verts, bones, { maxInfluences: 2 });
    for (let v = 0; v < verts.length; v++) {
      const s = w.skinWeights[v * 4] + w.skinWeights[v * 4 + 1] + w.skinWeights[v * 4 + 2] + w.skinWeights[v * 4 + 3];
      expect(s).toBeCloseTo(1, 6);
      // slots 2,3 stay 0 with maxInfluences=2
      expect(w.skinWeights[v * 4 + 2]).toBe(0);
      expect(w.skinWeights[v * 4 + 3]).toBe(0);
    }
  });

  it('weights a vertex nearest the tip bone toward tip, not base', () => {
    const verts = [[0, -40]]; // sits on the tip origin
    const w = computeAutoWeights(verts, bones);
    // Find the weight assigned to bone index 1 (tip) vs 0 (base).
    const wByBone = new Map<number, number>();
    for (let i = 0; i < 4; i++) wByBone.set(w.skinIndices[i], (wByBone.get(w.skinIndices[i]) ?? 0) + w.skinWeights[i]);
    expect((wByBone.get(1) ?? 0)).toBeGreaterThan(wByBone.get(0) ?? 0);
  });

  const wOf = (w: { skinIndices: number[]; skinWeights: number[] }, v: number, bone: number) => {
    let s = 0; for (let i = 0; i < 4; i++) if (w.skinIndices[v * 4 + i] === bone) s += w.skinWeights[v * 4 + i]; return s;
  };

  it('bounded radius: a bone contributes 0 past its radius', () => {
    // base origin (0,40), tip origin (0,-40), radius 50.
    // vert0 sits on base (dist 0, in) but 80 from tip (out); vert1 sits on tip.
    const w = computeAutoWeights([[0, 40], [0, -40]], bones, { radius: 50 });
    expect(wOf(w, 0, 0)).toBeCloseTo(1, 5); expect(wOf(w, 0, 1)).toBeCloseTo(0, 5); // vert0 → base only
    expect(wOf(w, 1, 1)).toBeCloseTo(1, 5); expect(wOf(w, 1, 0)).toBeCloseTo(0, 5); // vert1 → tip only
  });

  it('a vertex beyond every bone radius falls back to the nearest bone', () => {
    // (0,200): 160 from base, 240 from tip — both past radius 50 → nearest = base.
    const w = computeAutoWeights([[0, 200]], bones, { radius: 50 });
    expect(wOf(w, 0, 0)).toBeCloseTo(1, 5);
  });
});

let world: ReturnType<typeof createWorld> | undefined;
afterEach(() => { world?.destroy(); world = undefined; clearSkin2DBuffers(); clearRig2DCache(); });

describe('buildRig2D → skin2DSystem (end-to-end)', () => {
  const RIG = 'gen.rig2d.json';
  const bones = [
    { name: 'base', parent: -1, x: 0, y: 40, rot: 0 },
    { name: 'tip', parent: 0, x: 0, y: -80, rot: 0 },
  ];

  function buildAndLoad() {
    const rig = buildRig2D({ sprite: '', bones, width: 32, height: 96, cols: 1, rows: 3 });
    // 1 col × 3 rows → (1+1)(3+1) = 8 verts.
    expect(normalizeRig2D(rig).vertCount).toBe(8);
    clearRig2DCache(); clearSkin2DBuffers();
    setRig2D(RIG, rig);
    world = createWorld();
    const root = world.spawn(Transform(), SkinnedSprite2D({ rig: RIG }));
    const base = world.spawn(Transform({ x: 0, y: 40 }), Bone2D({ name: 'base' }), EntityAttributes({ guid: 'b', parentId: root.id() }));
    const tip = world.spawn(Transform({ x: 0, y: -80 }), Bone2D({ name: 'tip' }), EntityAttributes({ guid: 't', parentId: base.id() }));
    return { root, base, tip, rig };
  }

  it('deforms to bind pose (positions == generated verts) at rest', () => {
    const { root, rig } = buildAndLoad();
    skin2DSystem(world!);
    const pos = Array.from(getSkin2DBuffer(root.id())!.parts[0].positions);
    const flatVerts = rig.mesh!.verts!.flat();
    expect(pos.length).toBe(flatVerts.length);
    for (let i = 0; i < flatVerts.length; i++) expect(pos[i]).toBeCloseTo(flatVerts[i], 4);
  });

  it('rotating the tip bone moves top verts more than bottom verts', () => {
    const { root, tip, rig } = buildAndLoad();
    skin2DSystem(world!);
    const bind = Array.from(getSkin2DBuffer(root.id())!.parts[0].positions);

    tip.set(Transform, { ...tip.get(Transform)!, rz: Math.PI / 2 });
    skin2DSystem(world!);
    const posed = Array.from(getSkin2DBuffer(root.id())!.parts[0].positions);

    // Vertex rows run top (y=-48) → bottom (y=48). Find the top-most and bottom-most
    // vertex indices from the generated bind verts, compare their displacement.
    const verts = rig.mesh!.verts!;
    let topI = 0, botI = 0;
    for (let i = 0; i < verts.length; i++) {
      if (verts[i][1] < verts[topI][1]) topI = i;
      if (verts[i][1] > verts[botI][1]) botI = i;
    }
    const disp = (i: number) => Math.hypot(posed[i * 2] - bind[i * 2], posed[i * 2 + 1] - bind[i * 2 + 1]);
    expect(disp(topI)).toBeGreaterThan(disp(botI));
    expect(disp(topI)).toBeGreaterThan(1); // top actually moved
  });
});

describe('suggestBones', () => {
  it('a tall sprite yields a vertical parent chain spanning the height', () => {
    const bones = suggestBones({ width: 32, height: 192 });
    expect(bones.length).toBeGreaterThanOrEqual(2);
    bones.forEach((b, i) => { expect(b.parent).toBe(i - 1); expect(b.x).toBe(0); });
    const { rootLocal } = deriveBindMatrices(bones);
    const ys = rootLocal.map((m) => m.f);
    expect(Math.min(...ys)).toBeCloseTo(-96, 3); // pivot-centered top
    expect(Math.max(...ys)).toBeCloseTo(96, 3);  // bottom
  });

  it('a wide sprite yields a horizontal chain (y all 0, x varies)', () => {
    const bones = suggestBones({ width: 192, height: 32 });
    bones.forEach((b) => expect(b.y).toBe(0));
    const { rootLocal } = deriveBindMatrices(bones);
    const xs = rootLocal.map((m) => m.e);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(192, 3);
  });

  it('coverage predicate confines joints to the covered band', () => {
    // Covered only in the vertical middle third (v ∈ [0.33, 0.66]).
    const bones = suggestBones({ width: 32, height: 300, isInside: (_u, v) => v >= 0.33 && v <= 0.66 });
    const { rootLocal } = deriveBindMatrices(bones);
    const ys = rootLocal.map((m) => m.f);
    // Extent stays well inside the full ±150 rect.
    expect(Math.min(...ys)).toBeGreaterThan(-90);
    expect(Math.max(...ys)).toBeLessThan(90);
  });
});

describe('autoRig2D (one-call from a sprite)', () => {
  it('produces a chained, fully-weighted rig from just sprite dimensions', () => {
    const rig = autoRig2D({ sprite: 'tex-guid', width: 64, height: 160, cols: 2, rows: 5 });
    expect(rig.sprite).toBe('tex-guid');
    expect(rig.bones!.length).toBeGreaterThanOrEqual(2);
    rig.bones!.forEach((b, i) => expect(b.parent).toBe(i - 1));
    const parsed = normalizeRig2D(rig);
    expect(parsed.vertCount).toBe(3 * 6); // (cols+1)(rows+1)
    for (let v = 0; v < parsed.vertCount; v++) {
      const s = parsed.skinWeights[v * 4] + parsed.skinWeights[v * 4 + 1] + parsed.skinWeights[v * 4 + 2] + parsed.skinWeights[v * 4 + 3];
      expect(s).toBeCloseTo(1, 5);
    }
  });
});
