/** Sprite-sheet slicing — the data model shared by the Sprite Editor, the asset
 *  scanner, the runtime sprite resolver, and (later) the atlas packer.
 *
 *  A texture set to "multiple" mode carries a `sprites: SpriteSlice[]` block in its
 *  `.meta.json` sidecar (Unity-style — no separate file). Each slice carves a named
 *  sub-rect out of the source image and gets its own stable GUID, so it can be
 *  referenced from `Renderable2D.sprite` (and, later, particle frame lists) exactly
 *  like a whole texture. The runtime resolves a slice to `(textureUrl, frameRect,
 *  pivot)`; packing (Phase 2) only changes which page+rect a slice resolves to.
 *
 *  Pure — zero THREE/DOM/Vite imports — so it runs in Node tooling and headless tests. */

import { newGuid } from './assetRefRules';

/** A sub-rect of a source texture, in SOURCE pixels (top-left origin). */
export interface SpriteRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pivot point, normalized 0..1 WITHIN the slice rect (0,0 = top-left, 0.5,0.5 =
 *  center, 1,1 = bottom-right). Drives the default `Renderable2D` pivot. */
export interface SpritePivot {
  x: number;
  y: number;
}

/** 9-slice borders in source pixels (left/right/top/bottom inset). Reserved — the
 *  schema carries it so slice data is forward-compatible; renderer support is later. */
export interface SpriteBorder {
  l: number;
  r: number;
  t: number;
  b: number;
  /** Render scale for the 9-slice edges (Unity "pixels per unit"-style): CSS px
   *  drawn per source pixel of border. 1 = 1:1. e.g. a 2×-authored button uses 0.5
   *  so its corners render at their intended on-screen size. Slice stays source-px;
   *  only the drawn border-width scales. Absent ⇒ 1. */
  scale?: number;
}

/** One named sprite carved out of a source texture. Persisted in the texture's
 *  `.meta.json` `sprites[]` block; registered in the asset manifest as a `'sprite'`
 *  entry pointing at the parent texture GUID. */
export interface SpriteSlice {
  /** Stable GUID — the referenceable identity (minted once, then persisted). */
  guid: string;
  /** Human name, unique within the texture. Defaults derived from a base + index. */
  name: string;
  rect: SpriteRect;
  pivot: SpritePivot;
  border?: SpriteBorder;
}

/** Source-sheet dimensions a `sprites[]` block was authored against. Stored once
 *  per texture (`meta.spriteSheet`) so the runtime can scale source-px rects to a
 *  possibly-downscaled 2D variant. */
export interface SpriteSheetInfo {
  width: number;
  height: number;
}

/** A sliced sprite's manifest block: which texture it carves from + its rect/pivot.
 *  Stored on the `'sprite'` AssetEntry; the runtime resolves its URL through the
 *  parent `texture` GUID (and, once Phase-2 packing lands, redirects to an atlas page).
 *  Defined here (pure module) so Node tooling can reference it without dragging the
 *  DOM-touching assetManifest into a Node tsconfig. */
export interface SpriteAssetRef {
  /** GUID of the parent (source) texture this sprite is carved from. */
  texture: string;
  /** The slice's display name (its identity within the texture). */
  name?: string;
  /** Frame rect in SOURCE-image pixels (what the Sprite Editor manipulates). */
  rect: SpriteRect;
  pivot: SpritePivot;
  border?: SpriteBorder;
  /** Source-sheet dimensions the rect was authored against. The 2D variant the
   *  runtime actually loads may be downscaled (texture `maxSize`), so the render
   *  path scales the frame by `loadedTexW / sheetW`. Absent ⇒ assume no scaling. */
  sheetW?: number;
  sheetH?: number;
}

export const DEFAULT_PIVOT: SpritePivot = { x: 0.5, y: 0.5 };

/** Mint a slice with a fresh GUID. Pivot defaults to center. */
export function makeSlice(name: string, rect: SpriteRect, pivot: SpritePivot = DEFAULT_PIVOT): SpriteSlice {
  return { guid: newGuid(), name, rect: { ...rect }, pivot: { ...pivot } };
}

/** Clamp a rect to the image bounds, returning null if it has no area inside. */
export function clampRect(rect: SpriteRect, imgW: number, imgH: number): SpriteRect | null {
  const x = Math.max(0, Math.min(Math.round(rect.x), imgW));
  const y = Math.max(0, Math.min(Math.round(rect.y), imgH));
  const w = Math.max(0, Math.min(Math.round(rect.w), imgW - x));
  const h = Math.max(0, Math.min(Math.round(rect.h), imgH - y));
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/** True if a rect is fully inside the image and has positive area. */
export function isValidRect(rect: SpriteRect, imgW: number, imgH: number): boolean {
  return (
    rect.w > 0 && rect.h > 0 &&
    rect.x >= 0 && rect.y >= 0 &&
    rect.x + rect.w <= imgW &&
    rect.y + rect.h <= imgH
  );
}

export interface GridSliceOptions {
  imgW: number;
  imgH: number;
  /** Grid by count: number of columns/rows. Mutually exclusive with cell size. */
  cols?: number;
  rows?: number;
  /** Grid by cell size (px). Mutually exclusive with cols/rows. */
  cellW?: number;
  cellH?: number;
  /** Outer offset (px) before the first cell. */
  offsetX?: number;
  offsetY?: number;
  /** Gap (px) between cells. */
  paddingX?: number;
  paddingY?: number;
  /** Skip cells whose rect would be entirely empty per this predicate (optional —
   *  the alpha-aware caller passes a sampler; pure grid math leaves it undefined). */
  keep?: (rect: SpriteRect) => boolean;
}

/** Compute grid-cell rects (top-left to bottom-right, row-major). Supports either
 *  a column/row count OR a fixed cell size. Cells that fall partly outside the image
 *  are clamped; zero-area cells are dropped. Returns plain rects — the caller mints
 *  GUIDs/names (so re-slicing can preserve existing GUIDs by position). */
export function gridSliceRects(opts: GridSliceOptions): SpriteRect[] {
  const { imgW, imgH } = opts;
  const offX = opts.offsetX ?? 0;
  const offY = opts.offsetY ?? 0;
  const padX = opts.paddingX ?? 0;
  const padY = opts.paddingY ?? 0;

  let cellW: number;
  let cellH: number;
  let cols: number;
  let rows: number;

  if (opts.cellW && opts.cellH) {
    cellW = opts.cellW;
    cellH = opts.cellH;
    cols = Math.max(0, Math.floor((imgW - offX + padX) / (cellW + padX)));
    rows = Math.max(0, Math.floor((imgH - offY + padY) / (cellH + padY)));
  } else {
    cols = Math.max(1, Math.floor(opts.cols ?? 1));
    rows = Math.max(1, Math.floor(opts.rows ?? 1));
    cellW = Math.floor((imgW - offX - padX * (cols - 1)) / cols);
    cellH = Math.floor((imgH - offY - padY * (rows - 1)) / rows);
  }

  const rects: SpriteRect[] = [];
  if (cellW <= 0 || cellH <= 0) return rects;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const raw: SpriteRect = {
        x: offX + c * (cellW + padX),
        y: offY + r * (cellH + padY),
        w: cellW,
        h: cellH,
      };
      const clamped = clampRect(raw, imgW, imgH);
      if (!clamped) continue;
      // Drop partial edge cells (Unity full-cell grid behavior). When a large
      // offset/padding pushes the last column/row partly past the texture edge,
      // clampRect would otherwise keep a thin sliver — a "weird" malformed cell.
      // Only keep cells that fit fully inside the image.
      if (clamped.w !== raw.w || clamped.h !== raw.h) continue;
      if (opts.keep && !opts.keep(clamped)) continue;
      rects.push(clamped);
    }
  }
  return rects;
}

/** Axis-aligned overlap area of two rects (0 if disjoint). */
function rectOverlapArea(a: SpriteRect, b: SpriteRect): number {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? w * h : 0;
}

/** Build named, GUID'd slices from grid rects, reusing each `prior` slice's
 *  GUID/name/pivot for the NEW cell it most overlaps (each prior consumed once).
 *  Matching by overlap — not array index — so a re-slice that changes the column/row
 *  count keeps a GUID attached to roughly the same image region instead of silently
 *  reassigning it to a different cell (which would repoint live references). A cell
 *  with no overlapping prior gets a fresh GUID. */
export function gridSlices(opts: GridSliceOptions, baseName = 'sprite', prior: SpriteSlice[] = []): SpriteSlice[] {
  const rects = gridSliceRects(opts);
  const used = new Set<number>();
  return rects.map((rect, i) => {
    let bestIdx = -1, bestArea = 0;
    for (let j = 0; j < prior.length; j++) {
      if (used.has(j)) continue;
      const area = rectOverlapArea(rect, prior[j].rect);
      if (area > bestArea) { bestArea = area; bestIdx = j; }
    }
    const reuse = bestIdx >= 0 ? prior[bestIdx] : undefined;
    if (bestIdx >= 0) used.add(bestIdx);
    return {
      guid: reuse?.guid ?? newGuid(),
      name: reuse?.name ?? `${baseName}_${i}`,
      rect,
      pivot: reuse?.pivot ? { ...reuse.pivot } : { ...DEFAULT_PIVOT },
      ...(reuse?.border ? { border: { ...reuse.border } } : {}),
    };
  });
}

/** Look up a slice by GUID within a sprites block. */
export function findSlice(sprites: SpriteSlice[] | undefined, guid: string): SpriteSlice | undefined {
  return sprites?.find((s) => s.guid === guid);
}

export interface InferredGrid {
  cols: number; rows: number;
  cellW: number; cellH: number;
  offsetX: number; offsetY: number;
  paddingX: number; paddingY: number;
}

// Most-frequent value (for the common cell size across an even grid).
function mostCommon(nums: number[]): number {
  const counts = new Map<number, number>();
  let best = nums[0], bestC = 0;
  for (const n of nums) {
    const c = (counts.get(n) ?? 0) + 1;
    counts.set(n, c);
    if (c > bestC) { bestC = c; best = n; }
  }
  return best;
}

// Cluster near-equal start coordinates (within `tol`) into one column/row start,
// keeping each cluster's minimum as its representative. Tolerant of a few px of
// jitter from hand-drawn / auto-alpha slices so column/row counts stay sane.
function clusterStarts(vals: number[], tol: number): number[] {
  const sorted = [...vals].sort((a, b) => a - b);
  const reps: number[] = [];
  for (const v of sorted) {
    if (!reps.length || v - reps[reps.length - 1] > tol) reps.push(v);
  }
  return reps;
}

function medianStep(reps: number[]): number | null {
  if (reps.length < 2) return null;
  const diffs: number[] = [];
  for (let i = 1; i < reps.length; i++) diffs.push(reps[i] - reps[i - 1]);
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

/** Reverse-engineer grid parameters from an existing set of slice rects — so the
 *  Sprite Editor's grid fields can be populated FROM the current slicing (e.g. after
 *  auto-alpha or hand-drawing a regular grid). Infers the common cell size, the outer
 *  offset (min start), the column/row count (clustered starts), and the inter-cell
 *  padding (median start-step − cell size). Returns null for an empty input. */
export function inferGridFromRects(rects: SpriteRect[]): InferredGrid | null {
  const valid = rects.filter((r) => r.w > 0 && r.h > 0);
  if (valid.length === 0) return null;
  const cellW = mostCommon(valid.map((r) => r.w));
  const cellH = mostCommon(valid.map((r) => r.h));
  const colStarts = clusterStarts(valid.map((r) => r.x), Math.max(1, cellW / 2));
  const rowStarts = clusterStarts(valid.map((r) => r.y), Math.max(1, cellH / 2));
  const stepX = medianStep(colStarts);
  const stepY = medianStep(rowStarts);
  return {
    cols: colStarts.length,
    rows: rowStarts.length,
    cellW, cellH,
    offsetX: colStarts[0],
    offsetY: rowStarts[0],
    paddingX: Math.max(0, Math.round((stepX ?? cellW) - cellW)),
    paddingY: Math.max(0, Math.round((stepY ?? cellH) - cellH)),
  };
}
