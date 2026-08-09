/** Integration test for DynamicFontProvider's LRU eviction — the wiring the pure
 *  atlasAllocator unit test can't reach: glyphMap sync on evict, seed pinning, and the
 *  regenerate-on-re-request loop. The WASM generator is mocked (uniform synthetic
 *  glyphs) and the canvas is stubbed, so no DOM/WASM is needed; the atlas is injected
 *  tiny (capacity 4) so eviction — a dead-code safety valve at production scale —
 *  triggers deterministically. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the WASM MSDF generator: return one uniform 40×40 glyph per requested char.
vi.mock('../../src/runtime/rendering/text/msdfGenerate', () => ({
  generateMsdf: vi.fn(async (_font: Uint8Array, charset: string) => ({
    texture: { data: new Uint8ClampedArray(100 * 100 * 4), width: 100, height: 100 },
    glyphs: [...charset].map((ch) => ({
      unicode: ch.codePointAt(0)!,
      atlasPosition: [0, 0] as [number, number],
      atlasSize: [40, 40] as [number, number],
      bounds: { left: 0, bottom: 0, right: 32, top: 32 },
      advance: 40,
    })),
    metrics: { emSize: 1, ascender: 46, descender: -13, lineHeight: 60 },
    kerning: [],
  })),
  disposeMsdfGenerator: vi.fn(async () => {}),
}));

import { DynamicFontProvider } from '../../src/runtime/rendering/text/dynamicFontProvider';

// Minimal canvas stub — the provider only needs createImageData/putImageData/clearRect.
const fakeCtx = () => ({
  createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  putImageData: () => {},
  clearRect: () => {},
});
const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => fakeCtx() });

beforeEach(() => { vi.stubGlobal('document', { createElement: () => fakeCanvas() }); });
afterEach(() => { vi.unstubAllGlobals(); });

// 100×100 page, no gap, 40×40 cells ⇒ exactly 4 slots; pin seed 'A' ⇒ 3 evictable.
const CFG = { atlasSize: 100, gap: 0, maxPages: 1, seed: 'A' };
const cp = (s: string) => s.codePointAt(0)!;

/** Request `s` and wait until every glyph is resident (generation is fire-and-forget). */
async function add(p: DynamicFontProvider, s: string) {
  p.ensureGlyphs([...s].map(cp));
  await vi.waitFor(() => {
    for (const ch of s) if (p.getGlyph(cp(ch)) === undefined) throw new Error('pending');
  });
}

describe('DynamicFontProvider eviction', () => {
  it('evicts the LRU non-pinned glyph when full; the pinned seed survives', async () => {
    const prov = await DynamicFontProvider.create('t', new Uint8Array([1]), CFG);
    expect(prov).not.toBeNull();
    const p = prov!;
    expect(p.getGlyph(cp('A'))).toBeDefined();  // pinned seed

    await add(p, 'BCD');                         // fill to capacity (A + B,C,D)
    expect(p.getGlyph(cp('B'))).toBeDefined();

    await add(p, 'E');                           // overflow → evict LRU (B, added first)
    expect(p.getGlyph(cp('E'))).toBeDefined();
    expect(p.getGlyph(cp('B'))).toBeUndefined(); // evicted
    expect(p.getGlyph(cp('A'))).toBeDefined();   // pinned seed never evicted
    expect(p.getGlyph(cp('C'))).toBeDefined();
    expect(p.getGlyph(cp('D'))).toBeDefined();
    expect(p.pageCount).toBe(1);                 // recycled in place, no new page
  });

  it('touch() (relayout) keeps a glyph resident against eviction', async () => {
    const p = (await DynamicFontProvider.create('t', new Uint8Array([1]), CFG))!;
    await add(p, 'BCD');
    p.ensureGlyphs([cp('B')]);                   // re-request B (already resident) → touches it
    await add(p, 'E');                           // now C is the LRU, not B
    expect(p.getGlyph(cp('B'))).toBeDefined();
    expect(p.getGlyph(cp('C'))).toBeUndefined();
  });

  it('regenerates an evicted glyph when it is requested again', async () => {
    const p = (await DynamicFontProvider.create('t', new Uint8Array([1]), CFG))!;
    await add(p, 'BCD');
    await add(p, 'E');                           // evicts B
    expect(p.getGlyph(cp('B'))).toBeUndefined();
    await add(p, 'B');                           // re-request → regenerates (evicts next LRU)
    expect(p.getGlyph(cp('B'))).toBeDefined();
  });
});

/** Chunking must not change PLACEMENT semantics.
 *
 *  A generation is split into chunks only because the generator's scratch atlas is finite
 *  (see SCRATCH_SIZE). The eviction shield must therefore cover the whole BATCH: if it
 *  covered only the current chunk, a later chunk could evict glyphs an earlier one had just
 *  placed — and eviction drops them from `requested`, so the same relayout re-requests them
 *  next frame and the batch oscillates instead of settling.
 *
 *  With the whole batch shielded, an over-large request degrades the way it always has: the
 *  glyphs that fit stay, and the surplus is skipped (tofu) because nothing is evictable.
 *  That is the STABLE outcome, and it is what these assertions pin. */
describe('a chunked batch is protected as ONE batch', () => {
  // fontSize 700 ⇒ pessimistic cell ~1068px ⇒ floor(2048/1068) = 1 per axis ⇒ ONE glyph per
  // chunk, so a 4-glyph request is guaranteed to span four separate generator passes.
  const CHUNKED = { atlasSize: 100, gap: 0, maxPages: 1, seed: 'A', fontSize: 700 };

  it('lets an over-large batch skip its surplus rather than evict its own earlier chunks', async () => {
    const p = (await DynamicFontProvider.create('t', new Uint8Array([1]), CHUNKED))!;
    // Capacity is A(pinned) + 3 slots. Ask for FOUR in one call: B,C,D fill it and E has
    // nowhere to go. Every chunk bumps atlasVersion (seed = 1, then one per glyph), so
    // version 5 means all four passes have run.
    p.ensureGlyphs([...'BCDE'].map(cp));
    await vi.waitFor(() => { if (p.atlasVersion < 5) throw new Error('generating'); });

    // Per-CHUNK protect would evict B to place E — flipping both of these.
    for (const ch of 'BCD') expect(p.getGlyph(cp(ch)), `${ch} was evicted by a later chunk`).toBeDefined();
    expect(p.getGlyph(cp('E')), 'E should be skipped, not placed by evicting a batch-mate').toBeUndefined();
    expect(p.getGlyph(cp('A'))).toBeDefined();
  });
});
