/** Regression for #635: a flush failure "un-sticks" its batch from `requested` so a LATER
 *  `ensureGlyphs` call can re-queue it — but for STATIC text (a label whose string never
 *  changes, e.g. "TAP TO START") no later `ensureGlyphs` call ever arrives. Both production
 *  call sites gate on a layout hash whose only provider-controlled inputs (`atlasVersion`,
 *  `markTextDirty()`) move ONLY on the success path, so a failed flush never nudges it and
 *  the label renders tofu for the page's whole lifetime, even after the network recovers.
 *  Text whose hash moves every frame (a countdown, a score) recovers by accident, which is
 *  why this survived. `scheduleFlushRetry` closes the gap by self-scheduling the retry
 *  instead of waiting on a caller that never comes.
 *
 *  Reuses the mock/stub setup from `dynamicFontProviderBytesRetry.test.ts` verbatim (see
 *  that file's header for why the same preconditions apply here). This file is SEPARATE
 *  because it needs `vi.useFakeTimers()` to drive the backoff deterministically — the
 *  sibling file uses real timers + `vi.waitFor`, and mixing the two styles in one file is
 *  exactly the kind of thing that makes timing-sensitive tests flaky. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the WASM MSDF generator — same shape as dynamicFontProviderBytesRetry.test.ts.
// Ascender/lineHeight agree with EMPTY_BAKED's metrics (÷ fontSize 32: -0.8/1.2) so
// `checkSameFont` doesn't fire its own unrelated warning here.
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

// Minimal canvas stub — the provider only needs createImageData/putImageData/clearRect.
const fakeCtx = () => ({
  createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  putImageData: () => {},
  clearRect: () => {},
});
const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => fakeCtx() });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { createElement: () => fakeCanvas() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// A trivial baked atlas — `fromBaked` never touches the canvas/generator until a miss is
// generated.
const EMPTY_BAKED: GlyphAtlas = {
  atlas: { type: 'mtsdf', distanceRange: 4, width: 4, height: 4, size: 32, yOrigin: 'top' },
  metrics: { emSize: 1, ascender: -0.8, descender: 0.2, lineHeight: 1.2 },
  glyphs: new Map(),
  kerning: new Map(),
};

const A = 0x3042; // あ — outside EMPTY_BAKED's charset, so this is a genuine miss.

// Comfortably past the module's real first backoff step (FLUSH_RETRY_BASE_MS = 500) without
// pinning the private constant itself — these tests assert the OBSERVABLE retry, not the
// exact delay.
const FIRST_BACKOFF_MS = 600;

describe('DynamicFontProvider — a static label recovers from a flush failure on its own (#635)', () => {
  it('recovers without any further ensureGlyphs call', async () => {
    let calls = 0;
    const loadFontBytes = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('transient font fetch failure');
      return new Uint8Array([1]);
    });
    const p = DynamicFontProvider.fromBaked('t', EMPTY_BAKED, 'atlas.png', loadFontBytes);

    // ONE call, ever — this is the whole point. A second `ensureGlyphs` call would re-queue
    // the codepoint (via the un-stuck `requested` entry) and recover under the OLD, buggy
    // code too, proving nothing about the self-scheduled retry.
    p.ensureGlyphs([A]);

    // Let the failing flush settle (bytes() rejects -> generateChunk/generateBatch/flush's
    // catch all run as chained microtasks) WITHOUT yet firing the retry timer.
    // `advanceTimersByTimeAsync` schedules its own check via a REAL macrotask, and a real
    // macrotask only runs once the microtask queue is fully drained — so by the time this
    // resolves the whole failing chain has settled, and 0ms of virtual clock can't reach a
    // timer armed 500ms out.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(p.getGlyph(A)).toBeUndefined();

    // Advance past the backoff — the self-scheduled retry (NOT another `ensureGlyphs` call)
    // must re-request A on its own and land it in the atlas.
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MS);
    expect(calls).toBe(2);
    const glyph = p.getGlyph(A);
    expect(glyph).toBeDefined();
    expect(glyph!.plane).toBeDefined(); // real quad geometry from the mocked generator, not tofu
    expect(glyph!.atlas).toBeDefined(); // real UV source rect — i.e. it was actually blitted
    expect(glyph!.advance).toBeGreaterThan(0);
  });
});

describe('DynamicFontProvider — the self-scheduled retry stays bounded (#635)', () => {
  it('stops after MAX_FLUSH_RETRIES + 1 attempts and settles as stable tofu', async () => {
    let calls = 0;
    const loadFontBytes = vi.fn(async () => { calls++; throw new Error('permanent 404'); });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const p = DynamicFontProvider.fromBaked('t', EMPTY_BAKED, 'atlas.png', loadFontBytes);
    const anyP = p as unknown as { requested: Set<number> };

    p.ensureGlyphs([A]);
    // One big advance covers every backoff step (500ms, then 1000ms — MAX_FLUSH_RETRIES=2
    // retries after the initial attempt) with room to spare. Each fired timer's resulting
    // flush() chain settles before the next due timer is checked — same macrotask-boundary
    // guarantee the first test relies on.
    await vi.advanceTimersByTimeAsync(60_000);

    // Bounded: the loader is tried MAX_FLUSH_RETRIES + 1 times, not once per backoff step
    // forever.
    expect(calls).toBeLessThanOrEqual(3);
    expect(calls).toBeGreaterThan(1); // but it DID retry — a budget, not a giveup-at-one
    // And the codepoint has settled as stable tofu rather than cycling through `requested`.
    expect(p.getGlyph(A)).toBeUndefined();
    expect(anyP.requested.has(A)).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1); // one warning, not one per attempt
    warnSpy.mockRestore();
  });
});

describe('DynamicFontProvider — dispose() cancels an armed retry (#635)', () => {
  it('does not call loadFontBytes again after dispose()', async () => {
    let calls = 0;
    const loadFontBytes = vi.fn(async () => { calls++; throw new Error('transient font fetch failure'); });
    const p = DynamicFontProvider.fromBaked('t', EMPTY_BAKED, 'atlas.png', loadFontBytes);

    p.ensureGlyphs([A]);
    await vi.advanceTimersByTimeAsync(0); // let the first failure settle and arm the retry timer
    expect(calls).toBe(1);

    p.dispose();

    // Advance past where the retry would have fired had dispose() not cancelled it.
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MS);
    expect(calls).toBe(1); // no further call
  });
});

// Regression for the #635 FOLLOW-UP: `flush()` drains ALL of `pending` into ONE batch and sets
// `generating = true` before its first `await` — so the first text entity gets batch 1 and every
// OTHER entity that mounts during that same await gets a batch of its own. `scheduleFlushRetry`
// used to capture one `batch` and early-return whenever `retryTimer !== null`, silently dropping
// every batch after the first: it had already been un-stuck from `requested` by flush()'s catch
// and never got re-added to anything. For static text (a label whose string never changes)
// nothing else ever calls `ensureGlyphs` again, so that codepoint rendered tofu forever, even
// after the transient failure that caused it fully recovered for every OTHER label.
describe('DynamicFontProvider — a SECOND failing batch merges into the pending retry instead of being dropped (#635 follow-up)', () => {
  it('recovers a codepoint from a later batch, not just the one that armed the retry timer', async () => {
    const B = 0x3044; // い — a second codepoint outside EMPTY_BAKED's charset, distinct from A.
    let calls = 0;
    // A genuinely transient failure: both batches hit the two failing calls, and the merged
    // retry's ONE re-generation call succeeds.
    const loadFontBytes = vi.fn(async () => {
      calls++;
      if (calls <= 2) throw new Error('transient font fetch failure');
      return new Uint8Array([1]);
    });
    const p = DynamicFontProvider.fromBaked('t', EMPTY_BAKED, 'atlas.png', loadFontBytes);
    const anyP = p as unknown as { requested: Set<number>; pending: Set<number> };

    // `ensureGlyphs([A])` synchronously runs `flush()` up to its first real `await` (inside
    // `bytes()` → `loadFontBytes()`, which itself throws synchronously and is only wrapped as a
    // rejected promise at the `await` boundary) — so `generating` is still `true`, and `pending`
    // still empty, when this second call runs. `B` therefore queues into `pending` rather than
    // joining batch A, reproducing the "second entity mounts during the first batch's await"
    // scenario exactly.
    p.ensureGlyphs([A]);
    p.ensureGlyphs([B]);

    // Let both failing flushes settle — batch A's catch re-triggers flush() for whatever landed
    // in `pending` while it awaited (batch B), before either retry timer fires.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    expect(p.getGlyph(A)).toBeUndefined();
    expect(p.getGlyph(B)).toBeUndefined();
    // Neither codepoint is stuck in `requested` (un-stuck by the catch) NOR queued in `pending`
    // (no caller will ever re-request static text) — exactly the limbo state the bug produces.
    expect(anyP.requested.has(A)).toBe(false);
    expect(anyP.requested.has(B)).toBe(false);
    expect(anyP.pending.has(A)).toBe(false);
    expect(anyP.pending.has(B)).toBe(false);

    // Advance past the single armed timer's backoff — the merged retry must recover BOTH
    // codepoints in ONE re-generation call, not just A (whose batch happened to arm the timer).
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MS);
    expect(calls).toBe(3);
    expect(p.getGlyph(A)).toBeDefined();
    expect(p.getGlyph(B)).toBeDefined();
  });

  // `cancelFlushRetry`'s OWN half of the fix: a budget-exhausting failure must not strand
  // whatever is STILL accumulated in `retryBatch` at that moment. This is a DIFFERENT scenario
  // from the "stops after MAX_FLUSH_RETRIES + 1 attempts" test in the sibling describe above —
  // there, `retryBatch` is always EMPTY by the time the budget-exhausting failure runs (the prior
  // timer already drained and cleared it), so that test cannot exercise this re-add at all. Here,
  // a THIRD, unrelated codepoint exhausts the budget WHILE the merged A/B retry is still pending
  // (its timer armed, not yet fired) — `cancelFlushRetry` must re-add A and B to `requested`
  // before clearing the timer, or they are un-stuck (by their own failures' un-stick) and never
  // re-added to anything: stranded in limbo forever, invisible to any later `ensureGlyphs` call.
  it('a budget-exhausting failure re-adds an already-armed retryBatch to requested instead of stranding it', async () => {
    const B = 0x3044; // い
    const C = 0x3046; // う — a third codepoint, unrelated to A/B's own retry.
    let calls = 0;
    const loadFontBytes = vi.fn(async () => { calls++; throw new Error('permanent 404'); });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = DynamicFontProvider.fromBaked('t', EMPTY_BAKED, 'atlas.png', loadFontBytes);
    const anyP = p as unknown as { requested: Set<number>; retryBatch: Set<number> };

    // A and B fail together (same shape as the test above) and merge into ONE armed retry —
    // still within budget (flushFailures reaches 2, MAX_FLUSH_RETRIES).
    p.ensureGlyphs([A]);
    p.ensureGlyphs([B]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    expect(anyP.retryBatch.has(A)).toBe(true);
    expect(anyP.retryBatch.has(B)).toBe(true);

    // C fails on its OWN, separate flush — the budget is already used up by A/B's two failures,
    // so this THIRD failure exceeds MAX_FLUSH_RETRIES and takes the `cancelFlushRetry()` branch,
    // with A/B's retry timer still armed and their codepoints still sitting in `retryBatch`.
    p.ensureGlyphs([C]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(3);

    // A and B are re-added to `requested` (stable, diagnosable tofu) rather than stranded —
    // `retryBatch` is drained by the cancel.
    expect(anyP.retryBatch.size).toBe(0);
    expect(anyP.requested.has(A)).toBe(true);
    expect(anyP.requested.has(B)).toBe(true);
    expect(anyP.requested.has(C)).toBe(true); // C settles as tofu too, same as any budget-exhausted cp

    // And the cancelled timer never fires — advancing well past where it would have re-queued
    // A/B must not produce a fourth loadFontBytes call.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(3);
    expect(p.getGlyph(A)).toBeUndefined();
    expect(p.getGlyph(B)).toBeUndefined();
    warnSpy.mockRestore();
  });
});
