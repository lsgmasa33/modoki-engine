/** Pure atlas placement policy for the dynamic font atlas: forward shelf growth PLUS
 *  LRU eviction once every page is full. Separated from {@link DynamicFontProvider}
 *  (which owns the canvases + WASM gen) so the placement logic — free-list reuse,
 *  least-recently-used victim choice, pinning/protection — is headless-testable with
 *  no DOM or WASM.
 *
 *  Growth path: {@link shelfAlloc} packs cells left→right, top→bottom, across pages.
 *  Once the shelf can't grow (all `maxPages` exhausted), the atlas is "full" and new
 *  glyphs recycle space: the least-recently-used resident cell that is neither
 *  {@link Slot.pinned} nor in the caller's `protect` set is evicted to a free-list and
 *  its capacity reused. Uniform-ish glyph cells (one font at one gen size) make
 *  best-fit reuse near-exact, so fragmentation stays bounded.
 *
 *  Recency is a monotonic COUNTER (not wall-clock) so the module is determinism-safe.
 */

import { newShelfState, shelfAlloc, type ShelfState } from './shelfPacker';

/** A placed rectangle: page + top-left px + its capacity (w×h). For a recycled cell
 *  w/h are the ORIGINAL cell's capacity (≥ the new glyph), so re-eviction returns the
 *  whole cell rather than a progressively-shrunk one. */
export interface AtlasCell {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AllocResult {
  /** Where to place the glyph. `x,y` = origin; `w,h` = the cell's CAPACITY (== the
   *  requested size for a forward alloc; ≥ it for a recycled cell). */
  cell: AtlasCell;
  /** Codepoints whose slots were evicted to make room — their atlas pixels are now
   *  stale, so the caller MUST drop them from its glyph map (they regenerate on next
   *  use). Empty unless the atlas was full and eviction ran. */
  evicted: number[];
  /** True when `cell` recycles freed space: it may still hold an evicted glyph's
   *  pixels and be larger than the new glyph, so the caller must CLEAR `cell` (its
   *  full w×h) before blitting. Forward allocs are false (fresh transparent space). */
  reused: boolean;
}

interface Slot {
  cell: AtlasCell;
  lastUsed: number;
  /** Never evicted (the ASCII seed — common glyphs + metrics stay resident). */
  pinned: boolean;
}

export class AtlasAllocator {
  private readonly shelf: ShelfState = newShelfState();
  private readonly slots = new Map<number, Slot>();
  private readonly free: AtlasCell[] = [];
  /** Monotonic recency counter (determinism-safe — no wall-clock). */
  private clock = 0;

  private readonly atlasSize: number;
  private readonly gap: number;
  private readonly maxPages: number;

  constructor(atlasSize: number, gap: number, maxPages: number) {
    this.atlasSize = atlasSize;
    this.gap = gap;
    this.maxPages = maxPages;
  }

  get slotCount(): number { return this.slots.size; }
  get freeCount(): number { return this.free.length; }
  has(cp: number): boolean { return this.slots.has(cp); }

  /** Mark a resident glyph as used NOW (bumps LRU recency). No-op if absent. Called
   *  per laid-out codepoint so the working set stays "fresh" against eviction. */
  touch(cp: number): void {
    const s = this.slots.get(cp);
    if (s) s.lastUsed = ++this.clock;
  }

  /** Best-fit free-cell index for a w×h glyph (smallest cell that still fits), or -1. */
  private bestFitFree(w: number, h: number): number {
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < this.free.length; i++) {
      const c = this.free[i];
      if (c.w >= w && c.h >= h && c.w * c.h < bestArea) { bestArea = c.w * c.h; best = i; }
    }
    return best;
  }

  /** Least-recently-used resident codepoint that may be evicted (not pinned, not in
   *  `protect`), or null if nothing is evictable. */
  private lruVictim(protect: Set<number>): number | null {
    let victim: number | null = null;
    let oldest = Infinity;
    for (const [cp, s] of this.slots) {
      if (s.pinned || protect.has(cp)) continue;
      if (s.lastUsed < oldest) { oldest = s.lastUsed; victim = cp; }
    }
    return victim;
  }

  /** Claim free-cell `idx` for `cp`, keeping the cell's full capacity as the slot. */
  private take(cp: number, idx: number, pinned: boolean, evicted: number[]): AllocResult {
    const cap = this.free.splice(idx, 1)[0];
    const cell: AtlasCell = { page: cap.page, x: cap.x, y: cap.y, w: cap.w, h: cap.h };
    this.slots.set(cp, { cell, lastUsed: ++this.clock, pinned });
    return { cell, evicted, reused: true };
  }

  /** Allocate a `w×h` cell for `cp`. Grows via the shelf; once full, evicts LRU
   *  unpinned/unprotected slots until a freed cell fits. Returns null ONLY when the
   *  atlas is full and nothing evictable can satisfy `w×h` (caller skips the glyph).
   *  `pinned` slots survive all eviction; `protect` shields the caller's current batch. */
  alloc(cp: number, w: number, h: number, pinned: boolean, protect: Set<number>): AllocResult | null {
    // 1. Recycle a freed cell (best fit) if one is waiting.
    let fi = this.bestFitFree(w, h);
    if (fi >= 0) return this.take(cp, fi, pinned, []);

    // 2. Grow the shelf forward.
    const grown = shelfAlloc(this.shelf, w, h, this.atlasSize, this.gap, this.maxPages);
    if (grown) {
      const cell: AtlasCell = { page: grown.page, x: grown.x, y: grown.y, w, h };
      this.slots.set(cp, { cell, lastUsed: ++this.clock, pinned });
      return { cell, evicted: [], reused: false };
    }

    // 3. Full → evict least-recently-used until a freed cell fits `w×h`.
    const evicted: number[] = [];
    while ((fi = this.bestFitFree(w, h)) < 0) {
      const victim = this.lruVictim(protect);
      if (victim == null) return null; // everything left is pinned/protected → give up
      const vs = this.slots.get(victim)!;
      this.slots.delete(victim);
      this.free.push(vs.cell);
      evicted.push(victim);
    }
    return this.take(cp, fi, pinned, evicted);
  }
}
