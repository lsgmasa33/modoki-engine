/** Mesh tessellation for 2D skinning rigs — turns a sprite's rectangle into a
 *  deformable triangle grid (the geometry half of "auto-rig from a sprite"). Pure +
 *  deterministic (no wall-clock/RNG, no DOM): the editor supplies sprite dimensions
 *  and an optional alpha `isInside` predicate; this returns texture-space verts, UVs,
 *  and a triangle index buffer ready for a `.rig2d.json` mesh block.
 *
 *  Grid tessellation (this module) is the robust default. Alpha-outline tracing +
 *  earcut triangulation (tighter silhouettes) is a planned follow-up; a grid with
 *  fully-transparent cells culled already gives a usable, artifact-free rig. */

export interface GridMesh {
  verts: number[][]; // texture-space [x,y] (origin = pivot; +y down, sprite pixels)
  uvs: number[][];   // [u,v] in 0..1 into the sprite
  tris: number[];    // triangle index buffer
}

export interface GridOptions {
  width: number;   // sprite width in px
  height: number;  // sprite height in px
  cols: number;    // horizontal quad divisions (>=1)
  rows: number;    // vertical quad divisions (>=1)
  pivotX?: number; // 0..1 (default 0.5) — where the texture origin sits
  pivotY?: number; // 0..1 (default 0.5)
  /** Optional coverage test in UV space (0..1). A cell is kept only if it has any
   *  covered sample; a vertex is emitted only if it borders a kept cell. Omit to
   *  keep the full rectangle. Used to cull fully-transparent regions from the grid. */
  isInside?: (u: number, v: number) => boolean;
}

/** Build a triangulated grid mesh over the sprite rectangle. With `isInside`,
 *  fully-uncovered cells are dropped and only vertices touching a kept cell are
 *  emitted (re-indexed compactly), so the mesh hugs the opaque region. */
export function generateGridMesh(opts: GridOptions): GridMesh {
  const cols = Math.max(1, Math.floor(opts.cols));
  const rows = Math.max(1, Math.floor(opts.rows));
  const w = opts.width, h = opts.height;
  const pvx = opts.pivotX ?? 0.5, pvy = opts.pivotY ?? 0.5;

  // Decide which cells to keep. A cell (c,r) is kept if any of its 4 corner samples
  // (or its center) is inside — a cheap, stable coverage test.
  const keepCell = (c: number, r: number): boolean => {
    if (!opts.isInside) return true;
    const us = [c / cols, (c + 1) / cols, (c + 0.5) / cols];
    const vs = [r / rows, (r + 1) / rows, (r + 0.5) / rows];
    for (const u of us) for (const v of vs) if (opts.isInside(u, v)) return true;
    return false;
  };

  // Which grid vertices are used by a kept cell → compact re-indexing.
  const vertUsed = new Set<number>();
  const cellKept: boolean[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const kept = keepCell(c, r);
      cellKept[r * cols + c] = kept;
      if (kept) {
        vertUsed.add(r * (cols + 1) + c);
        vertUsed.add(r * (cols + 1) + c + 1);
        vertUsed.add((r + 1) * (cols + 1) + c);
        vertUsed.add((r + 1) * (cols + 1) + c + 1);
      }
    }
  }

  const verts: number[][] = [];
  const uvs: number[][] = [];
  const remap = new Map<number, number>(); // grid-vertex index → compact index
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const gi = r * (cols + 1) + c;
      if (opts.isInside && !vertUsed.has(gi)) continue;
      const u = c / cols, v = r / rows;
      remap.set(gi, verts.length);
      verts.push([(u - pvx) * w, (v - pvy) * h]);
      uvs.push([u, v]);
    }
  }

  const tris: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (opts.isInside && !cellKept[r * cols + c]) continue;
      const a = remap.get(r * (cols + 1) + c)!;
      const b = remap.get(r * (cols + 1) + c + 1)!;
      const d = remap.get((r + 1) * (cols + 1) + c)!;
      const e = remap.get((r + 1) * (cols + 1) + c + 1)!;
      // Two triangles per quad (CCW in a +y-down frame): a,d,b and b,d,e.
      tris.push(a, d, b, b, d, e);
    }
  }

  return { verts, uvs, tris };
}
