/** Sprite-atlas packing — the data model + bin-packer shared by the Atlas editor,
 *  the build-time reimport handler, and the runtime resolver.
 *
 *  An `.atlas.json` lists an explicit set of member sprite GUIDs (carved from one or
 *  more source textures in Phase 1). Packing relocates each member's pixels onto one
 *  or a few generated **pages** so they share a single base texture — the prerequisite
 *  for PixiJS `ParticleContainer` batching (Phase 3) and a draw-call win for 2D scenes.
 *
 *  This module is the PURE layer: the MaxRects bin-packer + the schema types. It has
 *  ZERO THREE/DOM/sharp/Vite imports (sibling to `spriteSheet.ts`) so it runs in Node
 *  tooling and headless tests. The actual pixel compositing (sharp) lives in the build
 *  plugin (`reimport-atlas.ts`); this file only decides WHERE each sprite goes.
 *
 *  Determinism: the pack order is a stable sort (area desc, then GUID asc) — NO
 *  `Math.random` — so the same members + options always produce the same layout (the
 *  content hash that gates re-encoding depends on it). */

import type { SpriteRect } from './spriteSheet';
import type { TextureImportSettings } from './textureSettings';

/** Authored `.atlas.json` contents (committed; edited via the Atlas inspector). The
 *  derived bookkeeping (pages, frame map, hash) lives in the sidecar, NOT here. */
export interface AtlasSource {
  /** Stable GUID — the atlas's referenceable identity. */
  id: string;
  version: 1;
  /** Explicit member sprite GUIDs (Phase-1 slices). */
  members: string[];
  /** Square page edge length in px (also caps a page). Must be a multiple of 4. */
  pageSize: number;
  /** Gap in px between adjacent packed sprites. */
  padding: number;
  /** Edge-extrusion bleed in px replicated outward from each sprite (anti-bleed at
   *  non-integer UVs / mip sampling). Adds to the reserved footprint. */
  extrude: number;
  /** Cap on generated pages; members that don't fit are reported as overflow. */
  maxPages?: number;
  /** Optional per-atlas page encoding override. Defaults to WebP (the 2D variant the
   *  PixiJS path can decode — KTX2 produces no 2D variant). */
  texture?: TextureImportSettings;
}

/** One packed member's placement: which page + the INNER content rect (excludes the
 *  extrude border, which the compositor draws into the surrounding gutter). */
export interface PackedFrame {
  spriteGuid: string;
  page: number;
  rect: SpriteRect;
}

export interface PackPage {
  /** Final page dimensions (snapped up to a multiple of 4, ≤ pageSize). */
  w: number;
  h: number;
}

export interface PackResult {
  pages: PackPage[];
  frames: PackedFrame[];
  /** Member GUIDs that didn't fit within `maxPages` (or are larger than a page) —
   *  surfaced, never silently dropped. */
  overflow: string[];
}

/** A member to pack: its GUID + source-pixel dimensions. */
export interface PackInput {
  guid: string;
  w: number;
  h: number;
}

/** One packed sprite's location within a BUILT atlas page. Stored in
 *  `AtlasCacheBlock.frames` and indexed by the runtime manifest for `resolveSprite`.
 *  `pivot` is copied from the member's slice so the resolver needn't re-read the
 *  source texture's meta. (Defined here — the pure module — so the Node build pipeline
 *  can reference it without importing the DOM-touching `assetManifest`.) */
export interface AtlasPackedFrame {
  page: number;
  rect: SpriteRect;
  pivot: { x: number; y: number };
}

/** Derived bookkeeping for a built atlas (regenerated on every re-pack). Lives in the
 *  atlas's `.meta.json` sidecar (read into the `'atlas'` AssetEntry at scan time) — NOT
 *  in the committed `.atlas.json` source. */
export interface AtlasCacheBlock {
  /** Atlas-level content hash (members' bytes + slice rects + pack options + encoder
   *  version). Gates re-packing — NOT used for serving (each page carries its own). */
  hash: string;
  /** One entry per generated page. `hash` is the page's own content hash (from the
   *  texture converter) — it forms the page URL cache-bust + the serving cache key.
   *  `variants` lists the derived files (webp/uastc/…); `w`/`h` are page dims. */
  pages: { hash: string; variants: string[]; w: number; h: number }[];
  /** Page-encoding settings (so the resolver picks the right variant per usage). */
  texture: TextureImportSettings;
  /** Member sprite GUID → its placement on a page. */
  frames: Record<string, AtlasPackedFrame>;
}

export interface PackOptions {
  pageSize: number;
  padding: number;
  extrude: number;
  maxPages?: number;
}

/** Round up to the nearest multiple of 4 (block-compression friendliness + so the
 *  texture converter's mult-of-4 snap is a no-op that can't shift frame coords). */
function ceil4(n: number): number {
  return Math.max(4, Math.ceil(n / 4) * 4);
}

interface FreeRect { x: number; y: number; w: number; h: number; }

/** One MaxRects bin (page). Tracks the maximal free rectangles + the running extent
 *  of placed content so the page can be trimmed afterwards. */
class MaxRectsBin {
  size: number;
  free: FreeRect[];
  usedW = 0;
  usedH = 0;
  constructor(size: number) {
    this.size = size;
    this.free = [{ x: 0, y: 0, w: size, h: size }];
  }

  /** Best Short Side Fit: among free rects that fit (w,h), pick the one whose
   *  shorter leftover side is smallest (tie-break: longer leftover side). Returns the
   *  placement position, or null when nothing fits. */
  private findBSSF(w: number, h: number): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestShort = Infinity;
    let bestLong = Infinity;
    for (const fr of this.free) {
      if (fr.w < w || fr.h < h) continue;
      const leftoverH = fr.w - w;
      const leftoverV = fr.h - h;
      const shortSide = Math.min(leftoverH, leftoverV);
      const longSide = Math.max(leftoverH, leftoverV);
      if (shortSide < bestShort || (shortSide === bestShort && longSide < bestLong)) {
        best = { x: fr.x, y: fr.y };
        bestShort = shortSide;
        bestLong = longSide;
      }
    }
    return best;
  }

  /** Place a (w,h) box; returns its top-left, or null if it doesn't fit. Splits every
   *  free rect the placement overlaps, then prunes contained rects. */
  place(w: number, h: number): { x: number; y: number } | null {
    const pos = this.findBSSF(w, h);
    if (!pos) return null;
    const placed: FreeRect = { x: pos.x, y: pos.y, w, h };
    const next: FreeRect[] = [];
    for (const fr of this.free) {
      next.push(...splitFree(fr, placed));
    }
    this.free = pruneContained(next);
    this.usedW = Math.max(this.usedW, pos.x + w);
    this.usedH = Math.max(this.usedH, pos.y + h);
    return pos;
  }
}

/** Guillotine-free MaxRects split: return the parts of `fr` left uncovered by
 *  `used`. If they don't intersect, `fr` survives unchanged. */
function splitFree(fr: FreeRect, used: FreeRect): FreeRect[] {
  // No overlap → unchanged.
  if (used.x >= fr.x + fr.w || used.x + used.w <= fr.x ||
      used.y >= fr.y + fr.h || used.y + used.h <= fr.y) {
    return [fr];
  }
  const out: FreeRect[] = [];
  // Top slab.
  if (used.y > fr.y) out.push({ x: fr.x, y: fr.y, w: fr.w, h: used.y - fr.y });
  // Bottom slab.
  if (used.y + used.h < fr.y + fr.h) {
    out.push({ x: fr.x, y: used.y + used.h, w: fr.w, h: fr.y + fr.h - (used.y + used.h) });
  }
  // Left slab.
  if (used.x > fr.x) out.push({ x: fr.x, y: fr.y, w: used.x - fr.x, h: fr.h });
  // Right slab.
  if (used.x + used.w < fr.x + fr.w) {
    out.push({ x: used.x + used.w, y: fr.y, w: fr.x + fr.w - (used.x + used.w), h: fr.h });
  }
  return out;
}

/** Drop free rects fully contained in another (the splits above generate overlaps). */
function pruneContained(rects: FreeRect[]): FreeRect[] {
  const keep: FreeRect[] = [];
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i];
    if (a.w <= 0 || a.h <= 0) continue;
    let contained = false;
    for (let j = 0; j < rects.length; j++) {
      if (i === j) continue;
      const b = rects[j];
      if (a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h) {
        // Equal rects: keep only the first (lower index) to avoid dropping both.
        if (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && j > i) continue;
        contained = true;
        break;
      }
    }
    if (!contained) keep.push(a);
  }
  return keep;
}

/** Pack member sprites into atlas pages.
 *
 *  Each member reserves a footprint of `w + 2*extrude + padding` × `h + 2*extrude +
 *  padding`; the returned `rect` is the INNER content rect (offset by `extrude` inside
 *  the footprint), so adjacent content rects are separated by at least
 *  `padding + 2*extrude` and every sprite has `extrude` px of its own gutter for the
 *  compositor's bleed. Members larger than a page (even before spacing) and any that
 *  exceed `maxPages` are returned in `overflow`. */
export function packAtlas(inputs: PackInput[], opts: PackOptions): PackResult {
  const pageSize = Math.max(4, Math.floor(opts.pageSize));
  const padding = Math.max(0, Math.floor(opts.padding));
  const extrude = Math.max(0, Math.floor(opts.extrude));
  const maxPages = opts.maxPages != null ? Math.max(1, Math.floor(opts.maxPages)) : Infinity;
  const spacing = padding + 2 * extrude;

  // Deterministic order: largest area first (better packing), GUID asc to break ties.
  const sorted = [...inputs].sort((a, b) => (b.w * b.h - a.w * a.h) || (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));

  const bins: MaxRectsBin[] = [];
  const frames: PackedFrame[] = [];
  const overflow: string[] = [];

  for (const item of sorted) {
    const boxW = item.w + spacing;
    const boxH = item.h + spacing;
    // Larger than a whole page → can never be placed.
    if (boxW > pageSize || boxH > pageSize) {
      overflow.push(item.guid);
      continue;
    }
    let placed = false;
    for (let p = 0; p < bins.length; p++) {
      const pos = bins[p].place(boxW, boxH);
      if (pos) {
        frames.push({ spriteGuid: item.guid, page: p, rect: { x: pos.x + extrude, y: pos.y + extrude, w: item.w, h: item.h } });
        placed = true;
        break;
      }
    }
    if (placed) continue;
    // Need a new page.
    if (bins.length >= maxPages) {
      overflow.push(item.guid);
      continue;
    }
    const bin = new MaxRectsBin(pageSize);
    bins.push(bin);
    const pos = bin.place(boxW, boxH);
    // A fresh page is empty and the box fits within pageSize (checked above), so this
    // never fails — but guard rather than assert.
    if (!pos) { overflow.push(item.guid); bins.pop(); continue; }
    frames.push({ spriteGuid: item.guid, page: bins.length - 1, rect: { x: pos.x + extrude, y: pos.y + extrude, w: item.w, h: item.h } });
  }

  // Trim each page to the extent actually used, snapped up to a multiple of 4. The
  // placed box already includes the trailing `spacing` (padding + 2*extrude) gutter,
  // so `usedW/usedH` covers the right/bottom-most sprite's bleed — no extra margin.
  const pages: PackPage[] = bins.map((b) => ({
    w: Math.min(pageSize, ceil4(b.usedW)),
    h: Math.min(pageSize, ceil4(b.usedH)),
  }));

  return { pages, frames, overflow };
}
