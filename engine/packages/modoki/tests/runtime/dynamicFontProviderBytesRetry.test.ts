/** A REJECTED `loadFontBytes()` must not poison the provider for the rest of the session (#541).
 *
 *  `DynamicFontProvider` seeded via {@link DynamicFontProvider.fromBaked} only touches
 *  `loadFontBytes` lazily, on the FIRST codepoint outside the baked charset — the generator
 *  (and its wasm) is otherwise never invoked. The trap this guards: memoising the promise
 *  returned by `loadFontBytes()` without clearing it on rejection turns one transient font
 *  fetch failure into "this font can never generate another glyph, for the life of the page".
 *  Same rule `threeLoaderModulesRetry.test.ts` states for `threeLoaderModules.ts`.
 *
 *  `bytes()` (the private memoising wrapper around `loadFontBytes`) is exercised directly in
 *  the two tests below — the same shape `threeLoaderModulesRetry.test.ts` uses for its
 *  module-scope accessors — rather than through `ensureGlyphs()`'s full generation pipeline.
 *
 *  The THIRD test, further down, closes a gap #541 left open: clearing the memo is
 *  necessary but not sufficient, because `ensureGlyphs`/`flush` had their own, separate
 *  "a failed codepoint is stuck in `requested` forever" bug that made the memo-level retry
 *  above unreachable from the real call path. That test exercises the full pipeline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the WASM MSDF generator for the pipeline-level regression test below (the two
// `bytes()`-level tests above never call `ensureGlyphs`, so they never touch this).
// Ascender/lineHeight are chosen to agree with EMPTY_BAKED's metrics (÷ fontSize 32:
// -0.8 / 1.2) so `checkSameFont` doesn't fire its own unrelated warning here.
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
    metrics: { emSize: 1, ascender: 25.6, descender: -6.4, lineHeight: 38.4 },
    kerning: [],
  })),
  disposeMsdfGenerator: vi.fn(async () => {}),
}));

import { DynamicFontProvider } from '../../src/runtime/rendering/text/dynamicFontProvider';
import type { GlyphAtlas } from '../../src/runtime/rendering/text/glyphAtlas';

// Minimal canvas stub for the pipeline-level test — only needed once a retried batch
// actually succeeds and blits a glyph (createImageData/putImageData/clearRect).
const fakeCtx = () => ({
  createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  putImageData: () => {},
  clearRect: () => {},
});
const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => fakeCtx() });
beforeEach(() => { vi.stubGlobal('document', { createElement: () => fakeCanvas() }); });
afterEach(() => { vi.unstubAllGlobals(); });

// A trivial baked atlas — `fromBaked` never touches the canvas/generator until a miss is
// generated, and these tests never call `ensureGlyphs`, so none of that needs stubbing.
const EMPTY_BAKED: GlyphAtlas = {
  atlas: { type: 'mtsdf', distanceRange: 4, width: 4, height: 4, size: 32, yOrigin: 'top' },
  metrics: { emSize: 1, ascender: -0.8, descender: 0.2, lineHeight: 1.2 },
  glyphs: new Map(),
  kerning: new Map(),
};

type WithBytes = { bytes(): Promise<Uint8Array>; fontBytesPromise: Promise<Uint8Array> | null };

describe('DynamicFontProvider — a rejected loadFontBytes() is not memoised (#541)', () => {
  it('drops the memo on failure so the next call retries, and a success stays memoised', async () => {
    let calls = 0;
    const loadFontBytes = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('transient font fetch failure');
      return new Uint8Array([1]);
    });

    const p = DynamicFontProvider.fromBaked('t', EMPTY_BAKED, 'atlas.png', loadFontBytes);
    const anyP = p as unknown as WithBytes;

    // First call: the fetch fails. With the old bare `??=` shape this rejection would be
    // cached forever, and this font would never generate another glyph for the session.
    await expect(anyP.bytes()).rejects.toThrow('transient font fetch failure');
    expect(calls).toBe(1);

    // The retry is the whole point: with the rejection memoised this call rejects too.
    await expect(anyP.bytes()).resolves.toEqual(new Uint8Array([1]));
    expect(calls).toBe(2);

    // ...and the successful result IS memoised — dropping the memo on failure must not cost
    // the single-flight property `bytes()` exists for (N glyph misses share one fetch).
    // `bytes()` is `async`, so its RETURN value is a fresh wrapper promise on every call
    // (never `=== ` across calls) — the memo lives in the private `fontBytesPromise` field,
    // so that is what identity is asserted on, same as the identity-guard test below.
    const memoized = anyP.fontBytesPromise;
    void anyP.bytes();
    expect(anyP.fontBytesPromise).toBe(memoized);
    await anyP.bytes();
    expect(calls).toBe(2);
  });

  it('the identity guard: a late rejection from an older attempt does not clear a newer in-flight memo', async () => {
    // Construct the exact race the `=== promise` guard exists for: an older attempt (A) is
    // abandoned (its memo entry force-cleared, as an external reset would) and a newer one
    // (B) takes the memo before A's rejection microtask runs. This is the REAL `.catch`
    // production code installs, not a re-implementation of the guard.
    let rejectA!: (e: unknown) => void;
    const promiseA = new Promise<Uint8Array>((_resolve, reject) => { rejectA = reject; });
    const promiseB = Promise.resolve(new Uint8Array([9]));
    let call = 0;
    const loadFontBytes = vi.fn(() => (++call === 1 ? promiseA : promiseB));

    const p = DynamicFontProvider.fromBaked('t', EMPTY_BAKED, 'atlas.png', loadFontBytes);
    const anyP = p as unknown as WithBytes;

    // `bytes()` returns a fresh async wrapper (see the note above) but sets the private
    // `fontBytesPromise` field to `loadFontBytes()`'s OWN return value — `promiseA` itself —
    // which is what its internal `.catch` is registered against. The wrapper adopts A's
    // eventual rejection too, so it needs its own swallowed `.catch` or vitest reports an
    // unhandled rejection.
    anyP.bytes().catch(() => {});
    expect(anyP.fontBytesPromise).toBe(promiseA);

    // No production code path resets `fontBytesPromise` from OUTSIDE `bytes()` today —
    // `bytes()`'s own `.catch` is the only writer, and `dispose()` does not null it either.
    // This line manufactures that precondition deliberately, to pin the `=== promise`
    // identity guard against a HYPOTHETICAL future writer (e.g. a caller that force-resets
    // the memo to force a re-fetch): if one is ever added, this guard is what stops its
    // late rejection from clobbering a newer in-flight attempt. It is defensive, not a
    // regression pin for anything currently live.
    anyP.fontBytesPromise = null;

    // A newer attempt (B) starts through the SAME real `bytes()` call — the memo now points at B.
    void anyP.bytes();
    expect(anyP.fontBytesPromise).toBe(promiseB);

    // A's late rejection fires. Without the identity guard this would null the memo out from
    // under B. Awaiting our OWN `.catch` on `promiseA` here runs strictly after the production
    // `.catch()` registered inside `bytes()` — handlers on one promise fire in registration order.
    rejectA(new Error('stale rejection from an abandoned attempt'));
    await promiseA.catch(() => {});

    expect(anyP.fontBytesPromise).toBe(promiseB); // NOT cleared by A's rejection
  });
});

describe('DynamicFontProvider — a codepoint stuck by a failed flush is reachable again (#541 follow-up)', () => {
  it('re-enters the pipeline through ensureGlyphs and actually produces the glyph once bytes() can succeed', async () => {
    let calls = 0;
    const loadFontBytes = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('transient font fetch failure');
      return new Uint8Array([1]);
    });

    const p = DynamicFontProvider.fromBaked('t', EMPTY_BAKED, 'atlas.png', loadFontBytes);
    // `requested`/`pending`/`generating` are private bookkeeping `ensureGlyphs`/`flush` use
    // to avoid re-generating a resident glyph and to coalesce a burst into one generation —
    // read here only to know when the fire-and-forget `flush()` triggered by `ensureGlyphs`
    // has settled, the same shape `dynamicFontProviderEviction.test.ts`'s `add()` helper uses.
    const anyP = p as unknown as { requested: Set<number>; pending: Set<number>; generating: boolean };

    const A = 0x3042; // あ — outside EMPTY_BAKED's charset, so this is a genuine miss.

    p.ensureGlyphs([A]);
    // Wait for the first (failing) flush to settle rather than asserting immediately —
    // `ensureGlyphs` triggers `flush()` fire-and-forget.
    await vi.waitFor(() => {
      if (anyP.generating || anyP.pending.size > 0) throw new Error('still generating');
    });
    expect(calls).toBe(1);
    expect(p.getGlyph(A)).toBeUndefined(); // the failed batch produced nothing

    // Re-request the SAME codepoint now that bytes() can succeed. Before the fix this is a
    // no-op: `A` was still sitting in `requested` from the failed attempt (flush's catch
    // never removed it), so `ensureGlyphs` sees "already requested" and skips it silently —
    // `flush`/`bytes()` are never retried and `A` renders as tofu for the rest of the session.
    p.ensureGlyphs([A]);
    await vi.waitFor(() => {
      if (p.getGlyph(A) === undefined) throw new Error('pending');
    });

    // Not just "the loader was called again" — the glyph must actually come out the other
    // end of the pipeline (real content from the mocked generator), which is the part the
    // stuck-`requested` bug prevented even once `bytes()` itself became retryable.
    expect(calls).toBe(2);
    const glyph = p.getGlyph(A);
    expect(glyph).toBeDefined();
    expect(glyph!.advance).toBeGreaterThan(0);
    expect(glyph!.plane).toBeDefined(); // real quad geometry from the mocked generator, not tofu
    expect(glyph!.atlas).toBeDefined(); // real UV source rect — i.e. it was actually blitted
  });

  // Regression for the storm this fix could have caused (found reviewing the #541 follow-up).
  // `ensureGlyphs` runs per FRAME for text whose layout hash changes every frame (a countdown,
  // a score). Un-sticking the batch UNCONDITIONALLY turns a permanently-failing font into
  // request -> fail -> delete -> re-request at fetch latency for the life of the page — the
  // same unbounded-retry shape the rapier loaders were just capped for, in another subsystem.
  it('stops re-requesting a PERMANENTLY failing font instead of storming every frame', async () => {
    let calls = 0;
    const loadFontBytes = vi.fn(async () => { calls++; throw new Error('permanent 404'); });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const p = DynamicFontProvider.fromBaked('t', EMPTY_BAKED, 'atlas.png', loadFontBytes);
    const anyP = p as unknown as { requested: Set<number>; pending: Set<number>; generating: boolean };
    const A = 0x3042;

    // Drive ensureGlyphs the way a per-frame relayout would — many more times than the budget.
    for (let frame = 0; frame < 10; frame += 1) {
      p.ensureGlyphs([A]);
      await vi.waitFor(() => {
        if (anyP.generating || anyP.pending.size > 0) throw new Error('still generating');
      });
    }

    // Bounded: the loader is tried MAX_FLUSH_RETRIES + 1 times, not once per frame. The exact
    // ceiling matters less than that it does not scale with the frame count.
    expect(calls).toBeLessThanOrEqual(3);
    expect(calls).toBeGreaterThan(1); // but it DID retry — this is a budget, not a giveup-at-one
    // And the codepoint has settled as stable tofu rather than cycling through `requested`.
    expect(anyP.requested.has(A)).toBe(true);
    expect(p.getGlyph(A)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1); // one warning, not one per frame
    warnSpy.mockRestore();
  });
});
