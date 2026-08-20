/** The Skin editor's Pose preview paints the texture ONTO the deformed mesh (QA-ASSET-0029).
 *
 *  Bug `BHZa4wP22gXZ85p6dpbH`: the wireframe deformed per vertex while the texture was blitted
 *  with ONE affine taken from the part's first triangle, so under a skinned bend the art drifted
 *  away from the mesh it is painted on. These tests pin the property that makes the fix correct —
 *  per triangle, the UV→vertex map is exact — and the regression that would undo it. */

import { describe, it, expect } from 'vitest';
import { drawTexturedMesh } from '../../src/editor/panels/texturedMesh';
import { triUvToPosAffine, uvToPosAffine } from '../../src/editor/panels/skinParts';

/** Records the transform + clip of every triangle blit, so a test can ask where the texture
 *  actually went without a real canvas. */
function fakeCtx() {
  const calls: { path: number[][]; xf: number[] }[] = [];
  let path: number[][] = [];
  let pending: number[][] = [];
  return {
    calls,
    ctx: {
      save() {}, restore() {},
      beginPath() { path = []; },
      moveTo(x: number, y: number) { path.push([x, y]); },
      lineTo(x: number, y: number) { path.push([x, y]); },
      closePath() {},
      clip() { pending = path; },
      transform(a: number, b: number, c: number, d: number, e: number, f: number) {
        calls.push({ path: pending, xf: [a, b, c, d, e, f] });
      },
      drawImage() {},
    } as unknown as CanvasRenderingContext2D,
  };
}

const IMG = {} as CanvasImageSource;
const SRC = { sx: 0, sy: 0, sw: 100, sh: 100 };

/** Map a UV through a recorded blit transform → canvas px. This is where the TEXTURE puts that
 *  point; the mesh vertex mapped to canvas is where it SHOULD be. The gap between them is the
 *  bug, measured. */
function texAt(xf: number[], uv: number[], src = SRC): [number, number] {
  const [a, b, c, d, e, f] = xf;
  const px = src.sx + uv[0] * src.sw, py = src.sy + uv[1] * src.sh;
  return [a * px + c * py + e, b * px + d * py + f];
}

describe('drawTexturedMesh — the texture follows a skinned bend', () => {
  // Two triangles sharing an edge. The BEND: the right-hand pair of vertices is displaced,
  // as a bone rotation would displace them, while the left-hand pair stays put.
  const uvs = [[0, 0], [0.5, 0], [0, 1], [0.5, 1]];
  const tris = [0, 1, 2, 1, 3, 2];
  const bind = [[0, 0], [50, 0], [0, 100], [50, 100]];
  const bent = [[0, 0], [50, 0], [0, 100], [90, 140]]; // vertex 3 swung out

  it('places every vertex exactly where the mesh puts it, under a bend', () => {
    const { ctx, calls } = fakeCtx();
    expect(drawTexturedMesh(ctx, IMG, bent, uvs, tris, SRC, 1, 0, 0)).toBe(true);
    expect(calls).toHaveLength(2);
    for (const [ti, tri] of [[0, 1, 2], [1, 3, 2]].entries()) {
      for (const vi of tri) {
        const [tx, ty] = texAt(calls[ti].xf, uvs[vi]);
        expect(tx).toBeCloseTo(bent[vi][0], 6);
        expect(ty).toBeCloseTo(bent[vi][1], 6);
      }
    }
  });

  /** The regression guard with teeth: this is the OLD behaviour, and it must stay wrong, or the
   *  test above is passing for a reason unrelated to the fix. */
  it('a SINGLE part-wide affine cannot do that — the old path is measurably off', () => {
    const one = uvToPosAffine(bent, uvs, tris)!;
    const at = (uv: number[]) => [
      one.m00 * uv[0] + one.m01 * uv[1] + one.tx,
      one.m10 * uv[0] + one.m11 * uv[1] + one.ty,
    ];
    const [px, py] = at(uvs[3]);           // the swung-out vertex
    const err = Math.hypot(px - bent[3][0], py - bent[3][1]);
    expect(err).toBeGreaterThan(10);        // measured ~28 units — visible, not a rounding wobble
  });

  it('is exact for a RIGID part too, so nothing regresses outside Pose mode', () => {
    const { ctx, calls } = fakeCtx();
    const moved = bind.map(([x, y]) => [x + 17, y - 4]);
    drawTexturedMesh(ctx, IMG, moved, uvs, tris, SRC, 1, 0, 0);
    for (const [ti, tri] of [[0, 1, 2], [1, 3, 2]].entries()) {
      for (const vi of tri) {
        const [tx, ty] = texAt(calls[ti].xf, uvs[vi]);
        expect(tx).toBeCloseTo(moved[vi][0], 6);
        expect(ty).toBeCloseTo(moved[vi][1], 6);
      }
    }
  });

  it('honours the view transform (scale + origin)', () => {
    const { ctx, calls } = fakeCtx();
    drawTexturedMesh(ctx, IMG, bent, uvs, tris, SRC, 2, 30, -5);
    const [tx, ty] = texAt(calls[0].xf, uvs[0]);
    expect(tx).toBeCloseTo(bent[0][0] * 2 + 30, 6);
    expect(ty).toBeCloseTo(bent[0][1] * 2 - 5, 6);
  });

  it('clips each triangle to its own posed outline, overlapping to hide the seam', () => {
    const { ctx, calls } = fakeCtx();
    drawTexturedMesh(ctx, IMG, bent, uvs, tris, SRC, 1, 0, 0);
    expect(calls[0].path).toHaveLength(3);
    // Every clip vertex sits just OUTSIDE its triangle: adjacent clips are antialiased, so
    // abutting them exactly leaves a background-coloured hairline along every shared edge.
    const cx = (bent[0][0] + bent[1][0] + bent[2][0]) / 3;
    const cy = (bent[0][1] + bent[1][1] + bent[2][1]) / 3;
    for (const [i, v] of [0, 1, 2].entries()) {
      const before = Math.hypot(bent[v][0] - cx, bent[v][1] - cy);
      const after = Math.hypot(calls[0].path[i][0] - cx, calls[0].path[i][1] - cy);
      expect(after).toBeGreaterThan(before);
      expect(after - before).toBeCloseTo(0.5, 6); // sub-pixel: the overlap IS the error budget
    }
  });

  it('drops only the degenerate triangle, not the whole part', () => {
    const { ctx, calls } = fakeCtx();
    const collinear = [[0, 0], [0.5, 0], [1, 0], [0, 1]]; // tri 0,1,2 has collinear UVs
    const ok = drawTexturedMesh(ctx, IMG, [[0, 0], [50, 0], [100, 0], [0, 100]], collinear, [0, 1, 2, 0, 1, 3], SRC, 1, 0, 0);
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('refuses (so the caller falls back) when UVs are missing or unusable', () => {
    const { ctx } = fakeCtx();
    expect(drawTexturedMesh(ctx, IMG, bind, [], tris, SRC, 1, 0, 0)).toBe(false);
    expect(drawTexturedMesh(ctx, IMG, bind, uvs, [0, 1], SRC, 1, 0, 0)).toBe(false);
    expect(drawTexturedMesh(ctx, IMG, bind, uvs, tris, { ...SRC, sw: 0 }, 1, 0, 0)).toBe(false);
  });

  /** A vertex sitting ON the centroid makes the outward push divide by zero, and ONE NaN in a
   *  clip path silently drops the triangle.
   *
   *  ⚠️ It takes all THREE vertices coincident to reach that. An earlier version of this test used
   *  two coincident vertices and a third apart — zero-AREA, but its centroid is not on any vertex,
   *  so every radius was ~35 and the guard never ran. That test passed with the guard deleted,
   *  i.e. it pinned nothing. Keep all three the same point. */
  it('survives an all-coincident triangle without emitting NaN', () => {
    const { ctx, calls } = fakeCtx();
    // UVs stay non-collinear so triUvToPosAffine returns a map and the loop REACHES the push.
    const ok = drawTexturedMesh(ctx, IMG, [[5, 5], [5, 5], [5, 5]], [[0, 0], [1, 0], [0, 1]], [0, 1, 2], SRC, 1, 0, 0);
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    for (const p of calls[0].path) {
      expect(Number.isFinite(p[0])).toBe(true);
      expect(Number.isFinite(p[1])).toBe(true);
    }
  });

  /** A zero `scale` collapses all three canvas vertices onto the centroid — the same divide-by-zero
   *  from the view side rather than the mesh side. */
  it('survives a zero-scale view without emitting NaN', () => {
    const { ctx, calls } = fakeCtx();
    drawTexturedMesh(ctx, IMG, bent, uvs, tris, SRC, 0, 0, 0);
    for (const c of calls) for (const p of c.path) {
      expect(Number.isFinite(p[0])).toBe(true);
      expect(Number.isFinite(p[1])).toBe(true);
    }
  });

  /** The overlap is an ERROR BUDGET, and one fixed in canvas px is unbounded relative to the
   *  TRIANGLE. Zoomed far out, a flat 0.5px push exceeds a triangle's own size, so each blit
   *  covers its neighbours and later triangles overpaint earlier ones — corruption, not a hidden
   *  seam. The push is clamped to a quarter of the triangle's own radius. */
  it('clamps the seam push to the triangle when zoomed far out', () => {
    const { ctx, calls } = fakeCtx();
    const scale = 0.02;                       // triangles well under a pixel across
    drawTexturedMesh(ctx, IMG, bind, uvs, tris, SRC, scale, 0, 0);
    const tri = [0, 1, 2];
    const cx = tri.reduce((a, v) => a + bind[v][0] * scale, 0) / 3;
    const cy = tri.reduce((a, v) => a + bind[v][1] * scale, 0) / 3;
    let maxPush = 0, minR = Infinity;
    for (const [i, v] of tri.entries()) {
      const r = Math.hypot(bind[v][0] * scale - cx, bind[v][1] * scale - cy);
      minR = Math.min(minR, r);
      maxPush = Math.max(maxPush, Math.hypot(calls[0].path[i][0] - cx, calls[0].path[i][1] - cy) - r);
    }
    expect(maxPush).toBeLessThan(0.5);        // the flat half-pixel would have been used before
    expect(maxPush).toBeCloseTo(minR / 4, 6); // and it is the triangle-relative cap instead
  });
});

describe('triUvToPosAffine', () => {
  it('reproduces all three point-pairs exactly (three pairs determine an affine)', () => {
    const uv0 = [0.1, 0.2], uv1 = [0.7, 0.1], uv2 = [0.3, 0.9];
    const p0 = [4, 9], p1 = [61, -3], p2 = [20, 77];
    const m = triUvToPosAffine(uv0, uv1, uv2, p0, p1, p2)!;
    for (const [uv, p] of [[uv0, p0], [uv1, p1], [uv2, p2]] as const) {
      expect(m.m00 * uv[0] + m.m01 * uv[1] + m.tx).toBeCloseTo(p[0], 9);
      expect(m.m10 * uv[0] + m.m11 * uv[1] + m.ty).toBeCloseTo(p[1], 9);
    }
  });

  it('is null for collinear UVs rather than returning a garbage map', () => {
    expect(triUvToPosAffine([0, 0], [0.5, 0], [1, 0], [0, 0], [1, 1], [2, 5])).toBeNull();
  });
});
