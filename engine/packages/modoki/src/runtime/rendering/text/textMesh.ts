/** Backend-agnostic text geometry — turns laid-out {@link TextQuad}s into flat
 *  vertex buffers (2D positions + UVs + indices) that BOTH the Three.js mesh (3D)
 *  and the PixiJS mesh (2D) build from. Pure + headless-testable.
 *
 *  Positions are 2 floats/vertex in the layout's px space. `yUp` negates Y for the
 *  Y-up 3D world (Scene3D); Scene2D leaves it Y-down. Winding is CCW in Y-down; the
 *  Three material is double-sided so the Y-flip doesn't cull. UVs are top-origin
 *  (see {@link glyphAtlas}); `flipV` is offered for a bottom-origin texture but both
 *  our backends are top-origin so it defaults off.
 */

import type { TextQuad } from './layoutText';

export interface TextGeometryData {
  /** 2 floats per vertex (x, y) in layout px space. */
  positions: Float32Array;
  /** 2 floats per vertex (u, v). */
  uvs: Float32Array;
  /** 4 floats per vertex (r,g,b,a) — per-glyph colour MULTIPLIER, white by default
   *  (no tint). Animated by colour effects (rainbow/fade); the shader multiplies it
   *  onto the resolved glyph colour. */
  colors: Float32Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
}

export interface BuildGeometryOptions {
  /** Negate Y so the mesh is Y-up (3D world). Default false (Y-down, 2D screen). */
  yUp?: boolean;
  /** Flip V (1 - v) for a bottom-origin texture. Default false (top-origin). */
  flipV?: boolean;
}

/** Build interleaved-free flat buffers from text quads. Each quad → 4 vertices
 *  (TL, TR, BR, BL) + 6 indices (two triangles, CCW in Y-down). */
export function buildTextGeometry(quads: TextQuad[], opts: BuildGeometryOptions = {}): TextGeometryData {
  const yUp = !!opts.yUp;
  const flipV = !!opts.flipV;
  const n = quads.length;
  const positions = new Float32Array(n * 4 * 2);
  const uvs = new Float32Array(n * 4 * 2);
  const colors = new Float32Array(n * 4 * 4);
  // 4 verts/quad — Uint16 overflows past 16383 quads, promote to Uint32.
  const indices = n * 4 > 65535 ? new Uint32Array(n * 6) : new Uint16Array(n * 6);

  for (let i = 0; i < n; i++) {
    const q = quads[i];
    const y0 = yUp ? -q.y0 : q.y0;
    const y1 = yUp ? -q.y1 : q.y1;
    const v0 = flipV ? 1 - q.v0 : q.v0;
    const v1 = flipV ? 1 - q.v1 : q.v1;

    const vp = i * 8;
    // TL, TR, BR, BL
    positions[vp + 0] = q.x0; positions[vp + 1] = y0;
    positions[vp + 2] = q.x1; positions[vp + 3] = y0;
    positions[vp + 4] = q.x1; positions[vp + 5] = y1;
    positions[vp + 6] = q.x0; positions[vp + 7] = y1;

    uvs[vp + 0] = q.u0; uvs[vp + 1] = v0;
    uvs[vp + 2] = q.u1; uvs[vp + 3] = v0;
    uvs[vp + 4] = q.u1; uvs[vp + 5] = v1;
    uvs[vp + 6] = q.u0; uvs[vp + 7] = v1;

    const c = q.color;
    const cr = c ? c[0] : 1, cg = c ? c[1] : 1, cb = c ? c[2] : 1, ca = c ? c[3] : 1;
    for (let k = 0; k < 4; k++) {
      const cp = i * 16 + k * 4;
      colors[cp + 0] = cr; colors[cp + 1] = cg; colors[cp + 2] = cb; colors[cp + 3] = ca;
    }

    const base = i * 4;
    const ip = i * 6;
    // TL, BL, BR / TL, BR, TR
    indices[ip + 0] = base + 0; indices[ip + 1] = base + 3; indices[ip + 2] = base + 2;
    indices[ip + 3] = base + 0; indices[ip + 4] = base + 2; indices[ip + 5] = base + 1;
  }

  return { positions, uvs, colors, indices, vertexCount: n * 4 };
}

/** Per-glyph colour buffer (4 floats/vertex) for one page — the colour twin of
 *  {@link buildTextPositionsByPage} for the animation hot path (colour effects change
 *  only vertex colours). Same page grouping/order. */
export function buildTextColorsByPage(quads: TextQuad[]): { page: number; colors: Float32Array }[] {
  if (quads.length === 0) return [];
  const byPage = new Map<number, TextQuad[]>();
  for (const q of quads) {
    let arr = byPage.get(q.page);
    if (!arr) { arr = []; byPage.set(q.page, arr); }
    arr.push(q);
  }
  return [...byPage.keys()].sort((a, b) => a - b).map((page) => {
    const pq = byPage.get(page)!;
    const colors = new Float32Array(pq.length * 4 * 4);
    for (let i = 0; i < pq.length; i++) {
      const c = pq[i].color;
      const cr = c ? c[0] : 1, cg = c ? c[1] : 1, cb = c ? c[2] : 1, ca = c ? c[3] : 1;
      for (let k = 0; k < 4; k++) {
        const cp = i * 16 + k * 4;
        colors[cp + 0] = cr; colors[cp + 1] = cg; colors[cp + 2] = cb; colors[cp + 3] = ca;
      }
    }
    return { page, colors };
  });
}

/** One atlas page's geometry, tagged with the page index the renderer binds its
 *  texture from. */
export interface PageGeometry {
  page: number;
  geo: TextGeometryData;
}

/** Group quads by their atlas {@link TextQuad.page} and build one geometry per page,
 *  ascending. Baked / single-page text (every quad `page:0`) yields exactly one
 *  entry, so the common path is unchanged; dynamic text that spilled onto further
 *  pages yields one geometry per page and the renderer draws a mesh per page (each
 *  bound to that page's atlas texture). Empty input ⇒ empty array. */
export function buildTextGeometryByPage(quads: TextQuad[], opts: BuildGeometryOptions = {}): PageGeometry[] {
  if (quads.length === 0) return [];
  const byPage = new Map<number, TextQuad[]>();
  for (const q of quads) {
    let arr = byPage.get(q.page);
    if (!arr) { arr = []; byPage.set(q.page, arr); }
    arr.push(q);
  }
  return [...byPage.keys()]
    .sort((a, b) => a - b)
    .map((page) => ({ page, geo: buildTextGeometry(byPage.get(page)!, opts) }));
}

/** One atlas page's animated POSITIONS (no UVs/indices), tagged with its page index. */
export interface PagePositions {
  page: number;
  positions: Float32Array;
}

/** Positions-ONLY twin of {@link buildTextGeometryByPage} for the per-frame animation
 *  hot path. Per-glyph animation changes only vertex POSITIONS — UVs and indices are
 *  invariant (already baked into the live mesh), so recomputing them every frame is
 *  pure waste. Same page grouping + ascending order + Y-flip as the full builder, so a
 *  renderer matches each page's positions into that page's existing mesh by page index. */
export function buildTextPositionsByPage(quads: TextQuad[], opts: BuildGeometryOptions = {}): PagePositions[] {
  if (quads.length === 0) return [];
  const yUp = !!opts.yUp;
  const byPage = new Map<number, TextQuad[]>();
  for (const q of quads) {
    let arr = byPage.get(q.page);
    if (!arr) { arr = []; byPage.set(q.page, arr); }
    arr.push(q);
  }
  return [...byPage.keys()].sort((a, b) => a - b).map((page) => {
    const pq = byPage.get(page)!;
    const positions = new Float32Array(pq.length * 4 * 2);
    for (let i = 0; i < pq.length; i++) {
      const q = pq[i];
      const y0 = yUp ? -q.y0 : q.y0;
      const y1 = yUp ? -q.y1 : q.y1;
      const vp = i * 8;
      positions[vp + 0] = q.x0; positions[vp + 1] = y0; // TL
      positions[vp + 2] = q.x1; positions[vp + 3] = y0; // TR
      positions[vp + 4] = q.x1; positions[vp + 5] = y1; // BR
      positions[vp + 6] = q.x0; positions[vp + 7] = y1; // BL
    }
    return { page, positions };
  });
}
