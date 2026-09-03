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
import type { Glyph, FontMetrics, AtlasInfo, GlyphAtlas } from './glyphAtlas';
import { kerningKey } from './glyphAtlas';
import { generateMsdf } from './msdfGenerate';
import { metricsFromGen, glyphFromGen, applyMedianAlpha } from './dynamicGlyphMap';
import { AtlasAllocator } from './atlasAllocator';
import { markTextDirty } from './textDirty';
import { expandCharset, type FontManifestBlock } from '../../core/fontSettings';

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
 *  baked font. The cell padding follows it automatically ({@link cellPadding}), so the
 *  field can never clip at the cell edge. Wider field ⇒ bigger cells ⇒ fewer glyphs per
 *  2048² page (matters for the CJK multi-page follow-up); push higher only alongside a
 *  GEN_FONT_SIZE bump so the size/range ratio stays high enough for crisp corners. */
const GEN_FIELD_RANGE = 16;

/** The per-glyph cell padding the generator ACTUALLY applies, in px — derived, never
 *  a constant, and never the `padding` OPTION.
 *
 *  ⚠️ `@zappar/msdf-generator` pads each glyph cell by `Math.floor(fieldRange / 2)` and
 *  spends the `padding` option ONLY on the gap BETWEEN cells in its scratch atlas
 *  (`generator.ts`: `const pad = Math.floor(fieldRange/2)` … `glyphWidth = boundsW +
 *  pad*2` … `atlasX += glyphWidth + padding`). Measured on Geologica @ size 128 with the
 *  option pinned at 8 — fieldRange 8/16/24 ⇒ cell pad 4/8/12.
 *
 *  It is load-bearing because {@link glyphFromGen} derives the QUAD from the padding it
 *  is told, and that quad must match the cell its UVs address. The old code passed a
 *  constant 8 and was right only by coincidence — `floor(16/2) === 8`, an accidental
 *  coupling that survived two edits of the constants. The instant `fieldRange` became
 *  AUTHORED (#187 phase 3), a font authoring `pxRange: 8` got cell pad 4 against a quad
 *  built for 8: every glyph rendered ~8% oversized, shifted, and overlapping its
 *  neighbours — non-uniformly, since the error is `(bw+2·8)/(bw+2·4)` and so much worse
 *  for a narrow glyph (`l` ≈ +35% wide) than a wide one (`H` ≈ +8%).
 *
 *  So: ONE derived value, used for the quad and for every budget that reasons about the
 *  cell. Do not reintroduce a padding constant. */
function cellPadding(fieldRange: number): number {
  return Math.floor(fieldRange / 2);
}

/** Gap (px) between cells in the GENERATOR's scratch atlas. We re-pack every glyph into
 *  our own pages by exact sub-rect, so this only trades scratch density — it is not the
 *  glyph padding (see {@link cellPadding}). */
const SCRATCH_GAP = 2;

/** The generator's scratch-atlas dimension (px). Deliberately NOT `atlasMax`, which sizes
 *  OUR pages: the two were conflated, and the generator shelf-packs into whatever texture
 *  it is handed WITHOUT bounds-checking the bottom edge — a cell past it is written out of
 *  range, silently dropped by the typed array, and the glyph then blits fully transparent
 *  and simply never appears. Measured: 95 ASCII glyphs at size 128 into a 512² scratch lost
 *  70 of them, no error and no warning — which is what `atlasMax: 512` + `size: 128` did to
 *  a dynamic font's own seed charset. {@link DynamicFontProvider.batchCapacity} chunks each
 *  generation to fit this, so the page size is now the only thing atlasMax controls. */
const SCRATCH_SIZE = 2048;

/** How many consecutive failed generations still un-stick their batch for a retry. Structural,
 *  not a feel knob: past this the font is treated as genuinely broken rather than transiently
 *  failing, and its glyphs settle into stable tofu instead of being re-requested every frame.
 *  Same reasoning as the first-overflow-only retry in `generateBatch`. */
const MAX_FLUSH_RETRIES = 2;

/** First backoff step (ms) for the self-scheduled flush retry (#635). The delay doubles per
 *  consecutive failure (`FLUSH_RETRY_BASE_MS * 2 ** (flushFailures - 1)`), and the number of
 *  steps is bounded by {@link MAX_FLUSH_RETRIES} — same budget, just spread over wall-clock
 *  time instead of re-entering `flush()` immediately. See {@link scheduleFlushRetry}. */
const FLUSH_RETRY_BASE_MS = 500;

/** Transparent gutter (px) between packed cells. Cells are otherwise flush, so an
 *  OFFSET atlas sample — the drop shadow's `vUv - shadowOffset`, or a wide glow/outline
 *  — reads straight into the neighbouring glyph and paints a stray sliver (the reported
 *  "vertical line" beside dynamic-font text; baked atlases don't hit this because
 *  msdf-atlas-gen leaves inter-glyph spacing). The untouched canvas is (0,0,0,0) =
 *  SDF "outside", so the gutter reads as empty.
 *
 *  It is also what keeps the SHADOW budget honest. `clampShadowOffset` allows
 *  `distanceRange / size` em, sized for the BAKED bake (whose `-pxpadding` equals the
 *  full pxRange); a generated cell carries only `cellPadding` = HALF that, so the gutter
 *  must make up the difference — hence the `fieldRange/2` floor rather than a flat 12,
 *  which fell short from pxRange 24 up. Textures are linear + no-mip
 *  (fontTexturePixi/Three), so a fixed-px gutter is sufficient. */
const CELL_GAP = 12;
function cellGap(fieldRange: number): number {
  return Math.max(CELL_GAP, Math.ceil(fieldRange / 2));
}
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
  /** OUR page dimension (the font's authored `atlasMax`). It does NOT size the
   *  generator's scratch atlas — see {@link SCRATCH_SIZE} for why those are separate. */
  atlasSize?: number;
  maxPages?: number;
  gap?: number;
  seed?: string;
  /** px/em the field is generated at — the runtime twin of the baked `size`. */
  fontSize?: number;
  /** Distance range in px — the runtime twin of the baked `pxRange`. MUST match the
   *  baked atlas's or AA/outline thickness drifts between baked and generated glyphs. */
  fieldRange?: number;
}

/** Map a font's `.meta.json` import settings onto this provider's knobs, so a dynamic
 *  font honours the SAME authored fields a baked one does.
 *
 *  Until this existed the provider took no settings at all and hardcoded every value —
 *  a font could author `size: 128, pxRange: 8` in the Inspector, see it listed there,
 *  and get 64/16 at runtime. `distanceRange` in particular is not cosmetic: the manifest
 *  block's own doc says it MUST match between the baked atlas and the dynamic pages.
 *
 *  `fieldType` is deliberately NOT mapped — it cannot be: the WASM generator emits MSDF
 *  only and the alpha channel is synthesized as `median(RGB)`. It is hidden from the
 *  Inspector for dynamic fonts rather than accepted and ignored. */
export function dynamicConfigFromSettings(font: FontManifestBlock | undefined): DynamicFontConfig {
  return {
    ...(font?.size != null ? { fontSize: font.size } : {}),
    ...(font?.distanceRange != null ? { fieldRange: font.distanceRange } : {}),
    ...(font?.atlasMax != null ? { atlasSize: font.atlasMax } : {}),
    // The authored charset seeds the atlas synchronously. Anything beyond it is still
    // generated on demand — that is what `dynamic` means — so this is a warm-start hint,
    // not a limit. It also gives a dynamic font's `charset` a purpose again: it used to
    // shape only the baked atlas, which the dynamic path never loads.
    ...(font?.charset ? { seed: expandCharset({ charset: font.charset, customChars: font.customChars }) } : {}),
  };
}

export class DynamicFontProvider implements FontProvider {
  readonly id: string;
  atlasVersion = 0;
  /** The baked `~atlas.png` when seeded — page 0, served as an IMAGE rather than a canvas.
   *  Deliberately NOT drawn into a canvas: a 2D canvas stores premultiplied alpha, and the
   *  baked atlas carries a true SDF in alpha, so the round trip would destroy RGB precision
   *  exactly where alpha is low — the outside region, which is where outline and glow live. */
  readonly atlasImageUrl?: string;

  // Atlas PAGES: each a full ATLAS_SIZE² canvas. Page 0 is created up-front; the
  // shelf packer opens a new page (up to MAX_PAGES) once the current one fills. Each
  // renderer builds one texture per page and draws one mesh per page a text touches.
  private readonly pages: HTMLCanvasElement[] = [];
  private readonly ctxs: CanvasRenderingContext2D[] = [];
  /** The BAKED atlas, when this font was seeded from one — the normal case.
   *
   *  A `mode:'dynamic'` font is documented as "the baked atlas SEEDS a runtime generator
   *  that fills in unseen glyphs on demand", and for a long time the code did not do that:
   *  it ignored the bake entirely and REGENERATED the seed charset at every boot. Court
   *  therefore shipped a 346 KB `~atlas.png` it never fetched, downloaded a 1.5 MB wasm,
   *  spun up a worker, and rebuilt the same 95 ASCII glyphs the atlas already held —
   *  measured at ~640 ms on a desktop, before any of it reaches the screen, and fonts are
   *  awaited scene resources so it was all boot latency.
   *
   *  Seeded from the bake, construction is SYNCHRONOUS and a dynamic font boots exactly as
   *  fast as a baked one. The generator (and its wasm) is touched only on a genuine miss —
   *  which for a Latin-only game is never. */
  private readonly baked: GlyphAtlas | null;
  /** Raw outlines, fetched lazily on the FIRST miss — never at boot. */
  private readonly loadFontBytes: () => Promise<Uint8Array>;
  private fontBytesPromise: Promise<Uint8Array> | null = null;
  private readonly glyphMap = new Map<number, Glyph>();
  private readonly kern = new Map<number, number>();
  private _metrics: FontMetrics | null = null;
  private disposables: Array<() => void> = [];
  private disposed = false;

  // Atlas placement: forward shelf growth, then LRU eviction once all pages are full
  // (pure/testable — see atlasAllocator.ts). This provider only blits pixels + keeps
  // the public glyphMap in sync with what the allocator places/evicts.
  private readonly allocator: AtlasAllocator;
  private readonly atlasSize: number;
  private readonly maxPages: number;
  // Generation calibration, from the font's authored import settings (module constants
  // are the fallback for a font with no sidecar). `atlas` reports these downstream, so
  // the shader is calibrated to what was actually generated.
  private readonly fontSize: number;
  private readonly fieldRange: number;
  private warnedFull = false;
  private warnedScratch = false;
  private warnedMixed = false;

  // Async batching: every requested cp is tracked so we never regenerate; misses
  // queue into `pending`, drained by one generation at a time.
  private readonly requested = new Set<number>();
  private readonly pending = new Set<number>();
  private generating = false;
  // Bounds the flush-failure re-queue below. See `flush()`'s catch for why an UNBOUNDED
  // re-queue is a per-frame storm rather than a retry.
  private flushFailures = 0;
  private warnedFlushFail = false;
  // Arms the self-scheduled retry a failed flush promises (#635) — see `scheduleFlushRetry`.
  // Never touched outside flush()'s catch/scheduleFlushRetry/cancelFlushRetry/dispose().
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  // The codepoints an armed `retryTimer` will re-queue, ACCUMULATED across every failing batch
  // while the timer is pending — not just the one that first armed it. `flush()` drains ALL of
  // `pending` into ONE batch and sets `generating` before its first `await`, so a SECOND entity
  // that mounts during that await lands in a batch of its own; if that batch also fails,
  // `scheduleFlushRetry` used to find `retryTimer` already armed and early-return, silently
  // dropping the second batch — it was deleted from `requested` by the un-stick in flush()'s
  // catch and never re-added to anything, so it never regenerated. Merging into one Set instead
  // means a second (or third...) failing batch rides the already-armed timer instead of being
  // lost. See `scheduleFlushRetry`/`cancelFlushRetry`.
  private readonly retryBatch = new Set<number>();

  private constructor(
    id: string,
    loadFontBytes: () => Promise<Uint8Array>,
    cfg?: DynamicFontConfig,
    baked?: { atlas: GlyphAtlas; imageUrl: string },
  ) {
    this.id = id;
    this.loadFontBytes = loadFontBytes;
    this.baked = baked?.atlas ?? null;
    this.atlasImageUrl = baked?.imageUrl;
    this.maxPages = cfg?.maxPages ?? MAX_PAGES;
    // Seeded from a bake, the generated pages MUST match the baked atlas exactly:
    // `layoutText` normalizes every quad's UVs by ONE width/height for the whole provider,
    // and the shader is calibrated to one size/distanceRange. Taking all four from the bake
    // makes that agreement structural instead of a coincidence of two config reads.
    this.atlasSize = baked ? baked.atlas.atlas.width : (cfg?.atlasSize ?? ATLAS_SIZE);
    this.fontSize = baked ? baked.atlas.atlas.size : (cfg?.fontSize ?? GEN_FONT_SIZE);
    this.fieldRange = baked ? baked.atlas.atlas.distanceRange : (cfg?.fieldRange ?? GEN_FIELD_RANGE);
    this.allocator = new AtlasAllocator(this.atlasSize, cfg?.gap ?? cellGap(this.fieldRange), this.maxPages);
    // Un-seeded, page 0 is ours. Seeded, page 0 is the baked IMAGE and generated pages
    // start at 1 — so nothing is allocated until something actually misses.
    if (!baked) this.ensurePage(0);
  }

  /** Seed from the font's BAKED atlas. Synchronous, no worker, no wasm — see {@link baked}.
   *  `loadFontBytes` is called only if a codepoint outside the baked charset shows up. */
  static fromBaked(
    id: string,
    baked: GlyphAtlas,
    atlasImageUrl: string,
    loadFontBytes: () => Promise<Uint8Array>,
    cfg?: DynamicFontConfig,
  ): DynamicFontProvider {
    return new DynamicFontProvider(id, loadFontBytes, cfg, { atlas: baked, imageUrl: atlasImageUrl });
  }

  /** Generated pages sit AFTER the baked image, which owns page 0 when seeded. */
  private get pageOffset(): number { return this.baked ? 1 : 0; }

  private async bytes(): Promise<Uint8Array> {
    if (!this.fontBytesPromise) {
      const promise = this.loadFontBytes();
      this.fontBytesPromise = promise;
      // Clear the memo on failure, so a transient font fetch failure doesn't leave this
      // font permanently unable to generate another glyph for the session (#541). The
      // `=== promise` guard is registered after assignment so a late rejection from an
      // older attempt can never clear a newer in-flight one.
      promise.catch(() => { if (this.fontBytesPromise === promise) this.fontBytesPromise = null; });
    }
    return this.fontBytesPromise;
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

  get pageCount(): number { return this.pages.length + this.pageOffset; }
  /** Page 0 is the baked IMAGE when seeded (undefined here — the renderer falls through to
   *  {@link atlasImageUrl}); generated pages follow it. */
  atlasCanvasAt(page: number): HTMLCanvasElement | undefined {
    const i = page - this.pageOffset;
    return i >= 0 ? this.pages[i] : undefined;
  }

  /** Create + seed a dynamic provider BY GENERATING the seed charset — the fallback for a
   *  font with no usable bake (a failed conversion). Awaits that generation, so it pays the
   *  worker + wasm + rasterization cost at boot; {@link fromBaked} is the normal path and
   *  pays none of it. Returns null on gen failure. */
  static async create(id: string, fontBytes: Uint8Array, cfg?: DynamicFontConfig): Promise<DynamicFontProvider | null> {
    const p = new DynamicFontProvider(id, () => Promise.resolve(fontBytes), cfg);
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
    return this.baked?.metrics ?? this._metrics ?? { emSize: 1, lineHeight: 1.2, ascender: -0.8, descender: 0.2 };
  }

  get atlas(): AtlasInfo {
    // Seeded: the bake's own geometry, verbatim. Generated pages were sized to match it.
    if (this.baked) return this.baked.atlas;
    return {
      type: 'mtsdf', // median-alpha synthesized ⇒ downstream treats it as mtsdf
      distanceRange: this.fieldRange,
      width: this.atlasSize, // every page is atlasSize² (UVs are page-relative)
      height: this.atlasSize,
      size: this.fontSize,
      yOrigin: 'top',
    };
  }

  getGlyph(cp: number): Glyph | undefined { return this.baked?.glyphs.get(cp) ?? this.glyphMap.get(cp); }
  kerning(a: number, b: number): number {
    const k = this.baked?.kerning.get(kerningKey(a, b));
    return k ?? this.kern.get(kerningKey(a, b)) ?? 0;
  }

  ensureGlyphs(cps: Iterable<number>): void {
    let added = false;
    for (const cp of cps) {
      // Touch residents so a long-visible string's glyphs stay "fresh" against LRU
      // eviction — the renderers re-request the whole working set on each relayout.
      this.allocator.touch(cp);
      if (this.baked?.glyphs.has(cp) || this.glyphMap.has(cp) || this.requested.has(cp)) continue;
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
    const batch = [...this.pending];
    this.pending.clear();
    try {
      await this.generateBatch(batch, /* pin */ false);
      this.flushFailures = 0; // a working generation clears the budget
      this.warnedFlushFail = false;
    } catch (e) {
      // Un-stick THIS batch's codepoints from `requested` so a later `ensureGlyphs` call
      // re-queues them instead of seeing "already requested" and skipping silently forever.
      // Without this, a transient failure here (most commonly `bytes()` rejecting) defeats
      // #541's retry: the memo clears, but nothing ever calls `bytes()` again for these
      // codepoints because they never leave `requested`. Scoped to `batch` (captured before
      // the await) rather than the whole `requested` set, so an unrelated batch that already
      // succeeded stays resolved.
      //
      // ⚠️ BOUNDED, and the bound is the point — same rule as the scratch-overflow path below
      // (~:424), whose comment already rejects the unbounded shape. `ensureGlyphs` runs per
      // FRAME for any text whose layout hash changes every frame (a countdown, a score, a
      // typewriter reveal), so an unconditional un-stick turns a PERMANENTLY failing font
      // (a .ttf 404 after an OTA swap) into request → fail → delete → re-request at fetch
      // latency for the life of the page — and #541's cleared `bytes()` memo re-fetches on
      // every lap. Past the budget the codepoints stay in `requested` and render as tofu,
      // which is stable and diagnosable, instead of storming behind one warning.
      this.flushFailures += 1;
      if (!this.warnedFlushFail) {
        this.warnedFlushFail = true;
        console.warn(`[DynamicFontProvider] generation failed for ${this.id}:`, e);
      }
      if (this.flushFailures <= MAX_FLUSH_RETRIES) {
        for (const cp of batch) this.requested.delete(cp);
        // #635: the un-stick above is a promise this batch gets ANOTHER lap, but for STATIC
        // text (a label whose string never changes — "TAP TO START") no lap ever arrives on
        // its own. Both production `ensureGlyphs` call sites are gated on a layout hash whose
        // only provider-controlled inputs (`atlasVersion`, `markTextDirty()`) move ONLY on the
        // success path below (~:496-497) — a failed flush never touches either, so a static
        // label's hash never changes and `ensureGlyphs` is never called again for it. Text
        // whose hash moves every frame (a countdown, a score) recovers by accident, which is
        // why this survived: the un-stick alone is sufficient there, but not here. Arm a timer
        // to re-queue the batch ourselves instead of waiting on a caller that will never come.
        //
        // Deliberately NOT re-added to `pending` here — this catch runs inside `flush()`,
        // whose tail (~:394, now further down) is `if (this.pending.size) void this.flush()`;
        // re-queueing into `pending` from here would re-enter `flush()` immediately and turn
        // the bounded retry `MAX_FLUSH_RETRIES` exists for into a per-frame storm. The re-queue
        // happens only inside the TIMER callback, on its own backoff schedule.
        this.scheduleFlushRetry(batch);
      } else {
        // Budget exhausted this lap — an armed retry from an earlier, still-within-budget
        // failure must not outlive the budget that authorised it.
        this.cancelFlushRetry();
      }
    } finally {
      this.generating = false;
    }
    if (this.pending.size) void this.flush();
  }

  /** Arm the retry the un-stick in `flush()`'s catch is paying for (#635). A static label
   *  never calls `ensureGlyphs` again on its own — see the comment at the call site — so
   *  this provider has to re-queue the batch itself instead of waiting for a caller that
   *  never comes. Backoff doubles per consecutive failure and is bounded by the same
   *  `MAX_FLUSH_RETRIES` budget the un-stick itself is gated on.
   *
   *  Every call MERGES its `batch` into {@link retryBatch} first, unconditionally — only
   *  whether a NEW timer gets armed is gated on `retryTimer === null`. A second (or third)
   *  failing batch while one retry is already pending therefore rides the same timer instead
   *  of being silently dropped (see {@link retryBatch}'s own comment for the #635 follow-up
   *  this closes).
   *
   *  Self-guarding on purpose: this can fire long after the state that armed it changed
   *  (a scene swap disposed the provider, the budget got exhausted by an unrelated batch,
   *  or a codepoint landed some other way — e.g. a manual `ensureGlyphs` lap during the
   *  backoff window, the SECOND independent recovery route the un-stick still provides). */
  private scheduleFlushRetry(batch: number[]): void {
    for (const cp of batch) this.retryBatch.add(cp);
    if (this.disposed || this.retryTimer !== null) return;
    const delay = FLUSH_RETRY_BASE_MS * 2 ** (this.flushFailures - 1);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.disposed || this.flushFailures > MAX_FLUSH_RETRIES) return;
      let queued = false;
      for (const cp of this.retryBatch) {
        if (this.baked?.glyphs.has(cp) || this.glyphMap.has(cp)) continue; // landed some other way
        this.requested.add(cp);
        this.pending.add(cp);
        queued = true;
      }
      this.retryBatch.clear();
      if (queued) void this.flush();
    }, delay);
  }

  /** Disarm a pending retry — dispose(), or a later failure that exhausts the budget.
   *
   *  Clearing the timer must not strand {@link retryBatch}'s codepoints in limbo: they were
   *  already un-stuck from `requested` by the failure(s) that armed this retry, and if the
   *  timer that would have re-queued them is being killed, nothing else ever will. Re-add
   *  every one of them to `requested` FIRST, so they settle as stable, diagnosable tofu —
   *  exactly what `flush()`'s catch comment already promises for the budget-exhausted case.
   *
   *  Deliberately unconditional on `this.disposed`: `dispose()` sets that flag BEFORE calling
   *  this (see its own comment), and the re-add must still run — touching `requested` on a
   *  disposed provider is harmless (nothing reads it again), but SKIPPING the re-add here would
   *  silently reintroduce the exact limbo this method exists to close, just gated on dispose
   *  instead of on the budget. */
  private cancelFlushRetry(): void {
    for (const cp of this.retryBatch) this.requested.add(cp);
    this.retryBatch.clear();
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** How many glyphs one generation may ask for without overflowing the scratch atlas
   *  (see {@link SCRATCH_SIZE} — the generator does not bounds-check its own packing).
   *  Sized on a deliberately pessimistic cell: a tight glyph bbox stays well under 1.5 em
   *  on either axis even with accents and descenders, so a square of that fits whatever
   *  the packer does with the real, smaller cells. */
  private batchCapacity(): number {
    const cell = Math.ceil(this.fontSize * 1.5) + 2 * cellPadding(this.fieldRange) + SCRATCH_GAP;
    const perAxis = Math.max(1, Math.floor(SCRATCH_SIZE / cell));
    return Math.max(1, perAxis * perAxis);
  }

  /** Generate + place a set of codepoints, in as many generator passes as it takes to
   *  keep every pass inside the scratch atlas. */
  private async generateBatch(cps: number[], pin: boolean): Promise<void> {
    const cap = this.batchCapacity();
    // The WHOLE batch is shielded from eviction, not each chunk: chunking is an artefact of
    // the scratch atlas's size, and must not change placement semantics. Without this, chunk
    // 2 can evict glyphs chunk 1 just placed — and eviction drops them from `requested`, so
    // the same relayout re-requests them next frame and the batch oscillates instead of
    // settling into stable tofu the way a single over-large batch always did.
    const protect = new Set(cps);
    for (let i = 0; i < cps.length; i += cap) {
      // A dispose() between chunks (e.g. a scene swap tearing down this font mid-batch) must
      // stop the batch here rather than keep paying generator passes for a provider nothing
      // will ever read again — see the `disposed` re-check inside generateChunk for the write
      // side of the same guard.
      if (this.disposed) return;
      await this.generateChunk(cps.slice(i, i + cap), pin, protect);
    }
  }

  private async generateChunk(cps: number[], pin: boolean, protect: Set<number>): Promise<void> {
    if (cps.length === 0) return;
    const pad = cellPadding(this.fieldRange);
    const charset = cps.map((cp) => String.fromCodePoint(cp)).join('');
    const result = await generateMsdf(await this.bytes(), charset, {
      fontSize: this.fontSize, fieldRange: this.fieldRange,
      // The packer's inter-cell gap in ITS scratch atlas, NOT the glyph padding — that is
      // `pad`, which the generator derives from fieldRange and we must mirror exactly.
      padding: SCRATCH_GAP,
      textureSize: [SCRATCH_SIZE, SCRATCH_SIZE],
    });
    // `dispose()` can land while `generateMsdf` is in flight (this provider's font/atlas is
    // being torn down — a scene swap, a hot-reload). `dispose()` already cleared glyphMap/
    // kern/pages/ctxs; writing into them here would resurrect state into a disposed provider
    // nothing owns any more (glyphMap.set/kern.set below, `this.ctxs[cell.page]`, `this.blit`
    // touching a canvas array that dispose() just emptied). Bail before any of that.
    if (this.disposed) return;
    // Seeded from a bake, EVERY batch is checked (the baseline is the bake). Un-seeded, the
    // first batch establishes the baseline and later ones are checked against it.
    if (this.baked) this.checkSameFont(result.metrics);
    else if (!this._metrics) this._metrics = metricsFromGen(result.metrics, this.fontSize);
    else this.checkSameFont(result.metrics);

    const src = result.texture; // ImageData (top-origin)
    for (const gi of result.glyphs) {
      if (this.glyphMap.has(gi.unicode)) continue;
      const [w, h] = gi.atlasSize;
      if (w <= 0 || h <= 0) {
        this.glyphMap.set(gi.unicode, glyphFromGen(gi, this.fontSize, pad, 0, 0));
        continue;
      }
      // A cell the packer put past the scratch page holds no pixels (the writes fell
      // outside the typed array). Drop the request rather than blitting a transparent
      // glyph: `ensureGlyphs` re-queues it on the next relayout, by then in a smaller
      // batch. batchCapacity() should make this unreachable — warn if it isn't.
      if (gi.atlasPosition[0] + w > SCRATCH_SIZE || gi.atlasPosition[1] + h > SCRATCH_SIZE) {
        // Re-queue only on the FIRST overflow (and only from a multi-glyph batch, which a
        // smaller retry might fit). If it happens again the estimate is genuinely wrong for
        // this font, so leave the glyph out of `requested`: it renders as tofu, which is
        // stable, instead of being regenerated on every relayout forever behind one warning.
        const retry = !this.warnedScratch && cps.length > 1;
        this.warnScratchOverflow(cps.length);
        if (retry) this.requested.delete(gi.unicode);
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
      const glyph = glyphFromGen(gi, this.fontSize, pad, cell.x, cell.y);
      const page = cell.page + this.pageOffset;
      if (page > 0) glyph.page = page; // page 0 stays implicit (undefined)
      this.glyphMap.set(gi.unicode, glyph);
    }

    for (const k of result.kerning ?? []) {
      const a = k.first.codePointAt(0), b = k.second.codePointAt(0);
      if (a == null || b == null || !k.amount) continue;
      this.kern.set(kerningKey(a, b), k.amount / this.fontSize);
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

  /** Tripwire: every batch must come back from the SAME typeface as the seed.
   *
   *  The generator is a shared, single-font worker (see msdfGenerate's `genQueue`); when
   *  two dynamic fonts generated concurrently, one provider's atlas came back drawn from
   *  the OTHER font's outlines. Nothing errored — real glyphs, real advances, wrong
   *  typeface — so it read as "this font renders at the wrong weight" and survived a whole
   *  session of investigation. Vertical metrics are the cheapest fingerprint that separates
   *  two faces (Geologica 0.975/1.25 vs NotoSansJP 1.16/1.448) and they do NOT vary with a
   *  variation axis, so this cannot false-positive on a legitimate re-instance. */
  private checkSameFont(m: { ascender: number; descender: number; lineHeight: number }): void {
    // Baseline on `this.metrics`, which prefers the BAKE — not on `_metrics`, which is set by
    // the FIRST generation. Baselining on the first generation left the tripwire blind to
    // exactly the batch most likely to be wrong: the one that races at scene load.
    //
    // Tolerance 1e-2, not 1e-3: msdf-atlas-gen and msdfgen read the same hhea/OS2 tables, so
    // baked and generated metrics agree structurally (measured on Geologica: -0.975 / 1.25
    // from both, identical), but a hard 1e-3 would be at the mercy of their rounding. The
    // typefaces this must separate differ by ~0.19 em (Geologica 0.975 vs NotoSansJP 1.16),
    // so 1e-2 still catches a swap with ~19x margin.
    const seen = this.metrics;
    if (this.warnedMixed) return;
    const asc = -m.ascender / this.fontSize, lh = m.lineHeight / this.fontSize;
    if (Math.abs(asc - seen.ascender) < 1e-2 && Math.abs(lh - seen.lineHeight) < 1e-2) return;
    this.warnedMixed = true;
    console.error(`[DynamicFontProvider] ${this.id}: a glyph batch came back from a DIFFERENT typeface than the seed (ascender ${asc.toFixed(3)} vs ${seen.ascender.toFixed(3)}, lineHeight ${lh.toFixed(3)} vs ${seen.lineHeight.toFixed(3)}). The shared MSDF worker holds one font — generations must be serialized (msdfGenerate genQueue).`);
  }

  /** Warn once when a generated cell landed outside the scratch atlas — i.e.
   *  {@link DynamicFontProvider.batchCapacity} under-estimated the cell size. The glyph is
   *  dropped and retried; this exists so the condition is never silent again, which is
   *  exactly how it went unnoticed while `atlasMax` sized the scratch page. */
  private warnScratchOverflow(batch: number): void {
    if (this.warnedScratch) return;
    this.warnedScratch = true;
    console.warn(`[DynamicFontProvider] ${this.id}: a glyph cell overflowed the ${SCRATCH_SIZE}px generator scratch atlas at size ${this.fontSize} (batch of ${batch}) — dropped + requeued. Lower the font's Glyph size, or raise SCRATCH_SIZE.`);
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

  // A late registration (an atlas load that landed after this provider was disposed) runs NOW —
  // see FontProvider.addDisposable; queueing it would strand the cleanup forever.
  addDisposable(fn: () => void): void {
    if (this.disposed) { try { fn(); } catch { /* ignore */ } return; }
    this.disposables.push(fn);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelFlushRetry(); // #635: an armed retry must not fire into a disposed provider.
    // Renderer-attached per-page GPU textures clean up via their addDisposable hooks.
    for (const fn of this.disposables) { try { fn(); } catch { /* ignore */ } }
    this.disposables = [];
    this.glyphMap.clear();
    this.kern.clear();
    this.pages.length = 0; // drop canvas refs (GC); textures already released above
    this.ctxs.length = 0;
  }
}
