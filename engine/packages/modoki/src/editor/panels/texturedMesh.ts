/** Canvas2D textured-mesh blit — draw a sprite ONTO a deformable mesh, triangle by triangle.
 *
 *  Why this exists (bug `BHZa4wP22gXZ85p6dpbH`, case QA-ASSET-0029). The Skin editor's
 *  Weights/Pose preview deforms the wireframe PER VERTEX — every vertex gets its own weighted
 *  blend of bone matrices, so a bone chain bends the mesh non-linearly. The texture, meanwhile,
 *  was one `drawImage` under ONE affine derived from the part's first non-degenerate triangle. A
 *  2x3 affine expresses translation, rotation, scale and shear — a transform that is the same
 *  everywhere — so it cannot represent a bend. The art tracked triangle #0's bone and drifted
 *  from the mesh everywhere else, which is exactly the preview's one job: weights are judged on
 *  the ART, not on the wireframe, so the panel could make correct weights look wrong.
 *
 *  Per triangle the map is EXACT rather than approximate: three point-pairs determine an affine
 *  uniquely, so each triangle's own UV→vertex affine reproduces its deformation with no residual.
 *  The classic Canvas2D technique — clip to the triangle, transform, blit the whole image, and
 *  let the clip select the part that belongs there.
 *
 *  Lives beside the panel as a plain module rather than inside it, per `docs/editor.md`: a
 *  panel's DECISIONS belong somewhere a unit test can reach without mounting it in jsdom. */

import { triUvToPosAffine } from './skinParts';

/** How far each triangle's clip is pushed out from its centroid, in CANVAS px.
 *
 *  Adjacent triangles share an edge, and a clip is antialiased: two abutting clipped blits each
 *  cover their side of that edge with partial alpha, so the background shows through as a visible
 *  hairline crack along every shared edge — on a 60-triangle part that reads as a wireframe drawn
 *  in background colour, which is worse than the bug being fixed. Overlapping the clips by a
 *  half-pixel makes the seam a double-cover instead of a gap. It is deliberately sub-pixel: the
 *  overlap draws each triangle's texture a hair outside its own region, and the error scales with
 *  this number. */
const SEAM_OVERLAP_PX = 0.5;

export interface SourceRect { sx: number; sy: number; sw: number; sh: number }

/** Blit `img` onto the mesh, one triangle at a time.
 *
 *  `verts` are the POSED (deformed) vertices in mesh space; `uvs` are 0..1 across the source rect
 *  and index-aligned with `verts`; `tris` is a flat triple-index list. `scale`/`ox`/`oy` are the
 *  view transform mesh-space → canvas.
 *
 *  Returns false without drawing when the mesh carries no usable UVs, so the caller can fall back
 *  to its axis-aligned blit — the same contract the single-affine version had when it returned
 *  null. A partial draw still returns true: a mesh with one degenerate triangle should lose that
 *  triangle, not the whole part. */
export function drawTexturedMesh(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  verts: number[][],
  uvs: number[][],
  tris: number[],
  { sx, sy, sw, sh }: SourceRect,
  scale: number,
  ox: number,
  oy: number,
): boolean {
  if (uvs.length !== verts.length || tris.length < 3 || sw <= 0 || sh <= 0) return false;
  let drew = false;
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const i0 = tris[t], i1 = tris[t + 1], i2 = tris[t + 2];
    const uv0 = uvs[i0], uv1 = uvs[i1], uv2 = uvs[i2];
    const p0 = verts[i0], p1 = verts[i1], p2 = verts[i2];
    if (!uv0 || !uv1 || !uv2 || !p0 || !p1 || !p2) continue;
    const aff = triUvToPosAffine(uv0, uv1, uv2, p0, p1, p2);
    if (!aff) continue; // collinear UVs — nothing invertible to map

    // The triangle's POSED outline in canvas space, nudged outward to overlap its neighbours.
    const x0 = p0[0] * scale + ox, y0 = p0[1] * scale + oy;
    const x1 = p1[0] * scale + ox, y1 = p1[1] * scale + oy;
    const x2 = p2[0] * scale + ox, y2 = p2[1] * scale + oy;
    const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3;
    const r0 = Math.hypot(x0 - cx, y0 - cy), r1 = Math.hypot(x1 - cx, y1 - cy), r2 = Math.hypot(x2 - cx, y2 - cy);
    // CLAMPED to a quarter of the triangle's own radius, not just the flat half-pixel.
    //
    // The overlap is an error budget (each triangle paints a hair outside its own region), and a
    // budget fixed in CANVAS px is unbounded relative to the TRIANGLE — the two diverge as you
    // zoom out. At scale 0.05 on a fine mesh, triangles are a fraction of a pixel across, so a
    // flat 0.5px push is several times a triangle's own size: each blit then covers its
    // neighbours entirely and later triangles overpaint earlier ones, which is corruption rather
    // than a hidden seam. Scaling the cap to the triangle keeps the overlap a seam-width fix at
    // any zoom, and at normal zoom (radius >> 2px) the clamp is inactive and this is exactly the
    // half-pixel it was.
    const push = Math.min(SEAM_OVERLAP_PX, Math.min(r0, r1, r2) / 4);
    const out = (x: number, y: number, r: number): [number, number] => {
      // A degenerate triangle can put a vertex ON the centroid (all three coincident, or a
      // zero-`scale` view collapsing them); normalising by r would be NaN, and ONE NaN in a clip
      // path silently drops the whole triangle.
      if (r < 1e-9) return [x, y];
      return [x + ((x - cx) / r) * push, y + ((y - cy) / r) * push];
    };
    const [ax, ay] = out(x0, y0, r0), [bx, by] = out(x1, y1, r1), [gx, gy] = out(x2, y2, r2);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(gx, gy);
    ctx.closePath();
    ctx.clip();
    // imgPx → canvas, composed over the base dpr transform: imgPx → UV (the source rect spans
    // UV 0..1) → mesh space (the triangle's affine) → canvas (scale + origin).
    const a = scale * aff.m00 / sw, c = scale * aff.m01 / sh;
    const b = scale * aff.m10 / sw, d = scale * aff.m11 / sh;
    const e = -a * sx - c * sy + scale * aff.tx + ox;
    const f = -b * sx - d * sy + scale * aff.ty + oy;
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(img, sx, sy, sw, sh, sx, sy, sw, sh);
    ctx.restore();
    drew = true;
  }
  return drew;
}
