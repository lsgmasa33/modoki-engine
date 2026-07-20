/** DynamicFontProvider (path B) — a {@link FontProvider} that GENERATES glyphs at
 *  runtime via the WASM MSDF generator, packing them into a growing in-memory canvas
 *  atlas. Used for fonts whose `.meta.json` `mode:'dynamic'` (arbitrary Unicode / CJK
 *  the baked charset can't cover). Baked fonts (`mode:'baked'`) use BakedFontProvider.
 *
 *  Multi-page canvas atlas, shelf-packed with LRU eviction (see atlasAllocator.ts). On
 *  construction we generate a seed charset (ASCII) to obtain metrics + the common
 *  glyphs synchronously-ish (awaited by the loader); the seed is PINNED (never evicted).
 *  A runtime miss (`ensureGlyphs`) batches the new codepoints, generates them, blits
 *  each into free shelf space with a synthesized **median-alpha** channel (the generator
 *  is MSDF-only — see dynamicGlyphMap/msdfGenerate), bumps {@link atlasVersion} and marks
 *  text dirty so laid-out text reflows and the renderers re-upload the atlas texture.
 *  Once all pages fill, the least-recently-used unpinned glyph is recycled to make room
 *  (it regenerates on next use); the working set is kept fresh via `ensureGlyphs`.
 *
 *  Renderer-agnostic: it exposes {@link atlasCanvasAt} per page; Scene3D/Scene2D each
 *  build one GPU texture per page from it, keyed on `${id}:${page}:${atlasVersion}`,
 *  and draw one mesh per page a text string touches.
 */

import type { FontProvider } from './fontProvider';
import type { Glyph, FontMetrics, AtlasInfo } from './glyphAtlas';
import { kerningKey } from './glyphAtlas';
import { generateMsdf } from './msdfGenerate';
import { metricsFromGen, glyphFromGen, applyMedianAlpha } from './dynamicGlyphMap';
import { AtlasAllocator } from './atlasAllocator';
import { markTextDirty } from './textDirty';

/** Generation calibration. `fontSize` (px/em) trades atlas density vs. corner detail
 *  (the size/fieldRange ratio is the corner-quality lever, same as the baked path):
 *  64 keeps decent density for CJK while resolving corners better than 48. The mtsdf
 *  clash-correction in the shader is a NO-OP here (dynamic alpha == median), so
 *  dynamic corner quality rides purely on this size — bump it for cleaner Latin at the
 *  cost of glyphs-per-page (CJK wants multi-page — a follow-up). `fieldRange` matches
 *  the baked default so dynamic + baked share one shader calibration + effect thickness. */
const GEN_FONT_SIZE = 64;
/** Distance-field range (px) — the runtime twin of the baked `pxRange`. It sets the
 *  em budget for the shader's soft effects: max glow/outline/shadow reach ≈
 *  `SPREAD × GEN_FIELD_RANGE / GEN_FONT_SIZE` em (e.g. glow = `0.45 × 16/64` ≈ 0.11em).
 *  16 (2× the old 8) so dynamic glow/outline/shadow aren't cramped vs. a wide-pxRange
 *  baked font. GEN_PADDING must stay ≥ GEN_FIELD_RANGE/2 or the field clips at the
 *  cell edge. Wider field ⇒ bigger cells ⇒ fewer glyphs per 2048² page (matters for
 *  the CJK multi-page follow-up); push higher only alongside a GEN_FONT_SIZE bump so
 *  the size/range ratio stays high enough for crisp corners. */
const GEN_FIELD_RANGE = 16;
const GEN_PADDING = 8;
/** Transparent gutter (px) between packed cells. Cells are otherwise flush, so an
 *  OFFSET atlas sample — the drop shadow's `vUv - shadowOffset`, or a wide glow/outline
 *  — reads straight into the neighbouring glyph and paints a stray sliver (the reported
 *  "vertical line" beside dynamic-font text; baked atlases don't hit this because
 *  msdf-atlas-gen leaves inter-glyph spacing). The untouched canvas is (0,0,0,0) =
 *  SDF "outside", so the gutter reads as empty. Combined with each cell's own
 *  GEN_PADDING this clears neighbour glyphs for shadow offsets up to
 *  ~(CELL_GAP+GEN_PADDING)/GEN_FONT_SIZE em (≈0.25em); larger offsets fade at the
 *  field edge rather than showing a neighbour. Textures are linear + no-mip
 *  (fontTexturePixi/Three), so a fixed-px gutter is sufficient. */
const CELL_GAP = 12;
/** Per-page atlas canvas size. ~92px padded cells (at GEN_FONT_SIZE 64 + field/pad/gap)
 *  ⇒ ~450 glyphs/page. Multi-page (below) spills past that. */
const ATLAS_SIZE = 2048;
/** Page cap. 8 × 2048² covers full JIS level 1+2 CJK (~6900 glyphs) with headroom.
 *  Once all pages are full the allocator recycles space via LRU eviction (see
 *  atlasAllocator.ts) instead of growing unbounded — the least-recently-used
 *  unpinned glyph is dropped (and regenerates on next use) to place a new one. */
const MAX_PAGES = 8;

/** Printable-ASCII seed: gives metrics + the common glyphs on first load. */
const SEED_CHARSET = (() => {
  let s = '';
  for (let cp = 0x20; cp <= 0x7e; cp++) s += String.fromCodePoint(cp);
  return s;
})();

/** Overrides for the atlas sizing/seed — defaults are the module constants above.
 *  Exists so the eviction path (which only triggers at extreme scale in production)
 *  can be exercised in an integration test at a tiny, deterministic atlas size. */
export interface DynamicFontConfig {
  atlasSize?: number;
  maxPages?: number;
  gap?: number;
  seed?: string;
}

export class DynamicFontProvider implements FontProvider {
  readonly id: string;
  atlasVersion = 0;

  // Atlas PAGES: each a full ATLAS_SIZE² canvas. Page 0 is created up-front; the
  // shelf packer opens a new page (up to MAX_PAGES) once the current one fills. Each
  // renderer builds one texture per page and draws one mesh per page a text touches.
  private readonly pages: HTMLCanvasElement[] = [];
  private readonly ctxs: CanvasRenderingContext2D[] = [];
  private readonly fontBytes: Uint8Array;
  private readonly glyphMap = new Map<number, Glyph>();
  private readonly kern = new Map<number, number>();
  private _metrics: FontMetrics | null = null;
  private disposables: Array<() => void> = [];

  // Atlas placement: forward shelf growth, then LRU eviction once all pages are full
  // (pure/testable — see atlasAllocator.ts). This provider only blits pixels + keeps
  // the public glyphMap in sync with what the allocator places/evicts.
  private readonly allocator: AtlasAllocator;
  private readonly atlasSize: number;
  private readonly maxPages: number;
  private warnedFull = false;

  // Async batching: every requested cp is tracked so we never regenerate; misses
  // queue into `pending`, drained by one generation at a time.
  private readonly requested = new Set<number>();
  private readonly pending = new Set<number>();
  private generating = false;

  private constructor(id: string, fontBytes: Uint8Array, cfg?: DynamicFontConfig) {
    this.id = id;
    this.fontBytes = fontBytes;
    this.atlasSize = cfg?.atlasSize ?? ATLAS_SIZE;
    this.maxPages = cfg?.maxPages ?? MAX_PAGES;
    this.allocator = new AtlasAllocator(this.atlasSize, cfg?.gap ?? CELL_GAP, this.maxPages);
    this.ensurePage(0);
  }

  /** Lazily allocate atlas pages up to (and including) `p`. Fresh pages are
   *  transparent (0,0,0,0) = SDF "outside", so gutters/unused space read as empty. */
  private ensurePage(p: number): void {
    while (this.pages.length <= p) {
      const canvas = document.createElement('canvas');
      canvas.width = this.atlasSize;
      canvas.height = this.atlasSize;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('[DynamicFontProvider] 2D context unavailable');
      this.pages.push(canvas);
      this.ctxs.push(ctx);
    }
  }

  get pageCount(): number { return this.pages.length; }
  atlasCanvasAt(page: number): HTMLCanvasElement | undefined { return this.pages[page]; }

  /** Create + seed a dynamic provider. Awaits the initial ASCII generation so the
   *  returned provider has metrics + common glyphs ready. Returns null on gen failure. */
  static async create(id: string, fontBytes: Uint8Array, cfg?: DynamicFontConfig): Promise<DynamicFontProvider | null> {
    const p = new DynamicFontProvider(id, fontBytes, cfg);
    for (const ch of cfg?.seed ?? SEED_CHARSET) p.requested.add(ch.codePointAt(0)!);
    try {
      await p.generateBatch([...p.requested], /* pin */ true);
    } catch (e) {
      console.warn(`[DynamicFontProvider] seed generation failed for ${id}:`, e);
      return null;
    }
    return p._metrics ? p : null;
  }

  get metrics(): FontMetrics {
    return this._metrics ?? { emSize: 1, lineHeight: 1.2, ascender: -0.8, descender: 0.2 };
  }

  get atlas(): AtlasInfo {
    return {
      type: 'mtsdf', // median-alpha synthesized ⇒ downstream treats it as mtsdf
      distanceRange: GEN_FIELD_RANGE,
      width: this.atlasSize, // every page is atlasSize² (UVs are page-relative)
      height: this.atlasSize,
      size: GEN_FONT_SIZE,
      yOrigin: 'top',
    };
  }

  getGlyph(cp: number): Glyph | undefined { return this.glyphMap.get(cp); }
  kerning(a: number, b: number): number { return this.kern.get(kerningKey(a, b)) ?? 0; }

  ensureGlyphs(cps: Iterable<number>): void {
    let added = false;
    for (const cp of cps) {
      // Touch residents so a long-visible string's glyphs stay "fresh" against LRU
      // eviction — the renderers re-request the whole working set on each relayout.
      this.allocator.touch(cp);
      if (this.glyphMap.has(cp) || this.requested.has(cp)) continue;
      this.requested.add(cp);
      this.pending.add(cp);
      added = true;
    }
    if (added) void this.flush();
  }

  /** Drain `pending` one generation at a time (coalesces a burst into few calls). */
  private async flush(): Promise<void> {
    if (this.generating || this.pending.size === 0) return;
    this.generating = true;
    try {
      const batch = [...this.pending];
      this.pending.clear();
      await this.generateBatch(batch, /* pin */ false);
    } catch (e) {
      console.warn(`[DynamicFontProvider] generation failed for ${this.id}:`, e);
    } finally {
      this.generating = false;
    }
    if (this.pending.size) void this.flush();
  }

  private async generateBatch(cps: number[], pin: boolean): Promise<void> {
    if (cps.length === 0) return;
    const charset = cps.map((cp) => String.fromCodePoint(cp)).join('');
    const result = await generateMsdf(this.fontBytes, charset, {
      fontSize: GEN_FONT_SIZE, fieldRange: GEN_FIELD_RANGE, padding: GEN_PADDING,
      textureSize: [this.atlasSize, this.atlasSize],
    });
    if (!this._metrics) this._metrics = metricsFromGen(result.metrics, GEN_FONT_SIZE);

    // Shield this batch's own codepoints from eviction while we place them — never
    // evict a glyph we're generating right now to make room for another in the batch.
    const protect = new Set(cps);
    const src = result.texture; // ImageData (top-origin)
    for (const gi of result.glyphs) {
      if (this.glyphMap.has(gi.unicode)) continue;
      const [w, h] = gi.atlasSize;
      if (w <= 0 || h <= 0) {
        this.glyphMap.set(gi.unicode, glyphFromGen(gi, GEN_FONT_SIZE, GEN_PADDING, 0, 0));
        continue;
      }
      // Grow forward, or (once full) recycle least-recently-used space via eviction.
      const res = this.allocator.alloc(gi.unicode, w, h, pin, protect);
      if (!res) { this.warnFull(); continue; } // full + nothing evictable fits → skip (tofu)
      const { cell } = res;
      this.ensurePage(cell.page); // spilled onto a new page ⇒ back it with a canvas
      // Evicted glyphs' pixels are now stale → drop them so they regenerate on next use.
      for (const ev of res.evicted) { this.glyphMap.delete(ev); this.requested.delete(ev); }
      // A recycled cell may still hold an evicted glyph's pixels (and be larger than the
      // new glyph) → clear its full capacity before blitting the replacement.
      if (res.reused) this.ctxs[cell.page].clearRect(cell.x, cell.y, cell.w, cell.h);
      this.blit(src, gi.atlasPosition[0], gi.atlasPosition[1], w, h, cell.page, cell.x, cell.y);
      const glyph = glyphFromGen(gi, GEN_FONT_SIZE, GEN_PADDING, cell.x, cell.y);
      if (cell.page > 0) glyph.page = cell.page; // page 0 stays implicit (undefined)
      this.glyphMap.set(gi.unicode, glyph);
    }

    for (const k of result.kerning ?? []) {
      const a = k.first.codePointAt(0), b = k.second.codePointAt(0);
      if (a == null || b == null || !k.amount) continue;
      this.kern.set(kerningKey(a, b), k.amount / GEN_FONT_SIZE);
    }

    this.atlasVersion++;
    markTextDirty();
  }

  /** Warn once when the atlas is so saturated a glyph can't be placed even after
   *  eviction (every page pinned/in-use). Normal eviction is silent. */
  private warnFull(): void {
    if (this.warnedFull) return;
    this.warnedFull = true;
    console.warn(`[DynamicFontProvider] atlas exhausted for ${this.id} — a glyph couldn't be placed even after evicting (all ${this.maxPages} pages pinned/in-use); skipped`);
  }

  /** Copy a `w×h` sub-rect of `src` into `page` at `(dx,dy)` with alpha←median(rgb). */
  private blit(src: ImageData, sx: number, sy: number, w: number, h: number, page: number, dx: number, dy: number): void {
    const ctx = this.ctxs[page];
    const cell = ctx.createImageData(w, h);
    const d = cell.data, s = src.data, sw = src.width;
    for (let y = 0; y < h; y++) {
      let si = ((sy + y) * sw + sx) * 4;
      let di = y * w * 4;
      for (let x = 0; x < w; x++) {
        d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = 255;
        si += 4; di += 4;
      }
    }
    applyMedianAlpha(d);
    ctx.putImageData(cell, dx, dy);
  }

  addDisposable(fn: () => void): void { this.disposables.push(fn); }

  dispose(): void {
    // Renderer-attached per-page GPU textures clean up via their addDisposable hooks.
    for (const fn of this.disposables) { try { fn(); } catch { /* ignore */ } }
    this.disposables = [];
    this.glyphMap.clear();
    this.kern.clear();
    this.pages.length = 0; // drop canvas refs (GC); textures already released above
    this.ctxs.length = 0;
  }
}
