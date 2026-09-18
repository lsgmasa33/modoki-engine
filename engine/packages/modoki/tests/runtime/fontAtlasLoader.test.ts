/** fontAtlasLoader lifecycle tests — scene-scoped refcount (acquire/release/dispose)
 *  + the generation guard that prevents a fetch resolving AFTER its scene was
 *  released from re-inserting an owner-less provider (the leak the spine review
 *  flagged). manifest + assetUrl + fetch are mocked so it's pure. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { completeResponse } from '../stubs/assetResponse';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';
import { RETRY_BASE_MS } from '../../src/runtime/core/loadFailureMemo';

/** Guids the manifest pretends NOT to know — lets a test flip a ref from unresolvable to
 *  resolvable and back, which is what the warn-once "forget" behaviour is about. */
const missingGuids = new Set<string>();
/** #1397: a test can make a guid's manifest entry a DYNAMIC font. */
const fontBlocks = new Map<string, unknown>();
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  resolveRef: (g: string) => (g.startsWith('font-') && !missingGuids.has(g) ? `/fonts/${g}.ttf` : undefined),
  getAssetEntry: (g: string) => ({ hash: 'h1', font: fontBlocks.get(g) }),
  isGuid: (g: unknown) => typeof g === 'string' && g.startsWith('font-'),
  onFontInvalidated: () => () => {},
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({
  assetUrl: (p: string) => p,
  withCacheBust: (u: string, h?: string) => (h ? `${u}?v=${h}` : u),
}));

import {
  acquireFont, releaseFontsForScene, getLoadedFont, getFontOwnerCounts, disposeAllFonts, invalidateFont,
} from '../../src/runtime/loaders/fontAtlasLoader';

const METRICS = {
  atlas: { type: 'mtsdf', distanceRange: 4, width: 64, height: 64, size: 48, yOrigin: 'top' },
  metrics: { emSize: 1, lineHeight: 1.2, ascender: -0.8, descender: 0.2 },
  glyphs: [{ unicode: 65, advance: 0.5 }],
  kerning: [],
};

function mockFetchOnce(json: unknown, deferred?: { resolve: () => void }) {
  const gate = deferred ? new Promise<void>((r) => { deferred.resolve = r; }) : Promise.resolve();
  vi.stubGlobal('fetch', vi.fn(async () => {
    await gate;
    // completeResponse fills in text() — parseAssetJson reads the body as text so it can spot
    // Vite's index.html SPA fallback (see tests/stubs/assetResponse.ts).
    return completeResponse({ ok: true, json: async () => json });
  }));
}

beforeEach(() => {
  disposeAllFonts();
  vi.unstubAllGlobals();
  fontBlocks.clear();
});

describe('fontAtlasLoader refcount', () => {
  it('acquires once, shares across scenes, disposes at last release', async () => {
    mockFetchOnce(METRICS);
    const p1 = await acquireFont(1, 'font-a');
    expect(p1).not.toBeNull();
    expect(getLoadedFont('font-a')).toBe(p1);
    expect(getFontOwnerCounts()['font-a']).toBe(1);

    const p2 = await acquireFont(2, 'font-a');
    expect(p2).toBe(p1); // same cached provider
    expect(getFontOwnerCounts()['font-a']).toBe(2);

    releaseFontsForScene(1);
    expect(getLoadedFont('font-a')).toBe(p1); // scene 2 still holds it

    releaseFontsForScene(2);
    expect(getLoadedFont('font-a')).toBeUndefined(); // last owner gone → disposed
  });

  it('returns null for an unresolvable / non-guid ref', async () => {
    mockFetchOnce(METRICS);
    expect(await acquireFont(1, 'not-a-font')).toBeNull();
  });
});

describe('fontAtlasLoader generation guard (scene-swap race)', () => {
  it('does NOT re-insert a provider whose scene was released mid-fetch', async () => {
    const deferred = {} as { resolve: () => void };
    mockFetchOnce(METRICS, deferred);

    const pending = acquireFont(1, 'font-b'); // fetch is gated (in flight)
    expect(getFontOwnerCounts()['font-b']).toBe(1);

    releaseFontsForScene(1);                    // scene released before fetch resolves
    deferred.resolve();                         // now let the fetch complete
    const result = await pending;

    expect(result).toBeNull();                  // guard refused to cache
    expect(getLoadedFont('font-b')).toBeUndefined(); // no orphaned provider
    expect(getFontOwnerCounts()['font-b']).toBeUndefined();
  });
});

/** A `mode:'dynamic'` font is SEEDED BY ITS BAKE, and touches nothing else at boot.
 *
 *  This is what `dynamic` has always meant in the docs — "the baked atlas seeds a runtime
 *  generator that fills in unseen glyphs on demand" — and what the loader did not do. It
 *  skipped the bake entirely and regenerated the seed charset through the WASM worker on
 *  every load: a 1.5 MB wasm fetch plus ~640 ms of rasterization (desktop) to reproduce
 *  glyphs the shipped `~atlas.png` already held. Fonts are awaited scene resources, so all
 *  of it was boot latency — Court's iOS build visibly stalled on it.
 *
 *  The assertions are about what is NOT done: no `.ttf` fetch, no generator, at boot. */
describe('a dynamic font seeds from its bake', () => {
  const dynamicEntry = { hash: 'h1', font: { mode: 'dynamic' as const, size: 48, distanceRange: 4 } };

  /** Records every URL fetched so the test can assert on what was NOT requested. */
  function trackingFetch(json: unknown): string[] {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      seen.push(String(u));
      return completeResponse({ ok: true, json: async () => json });
    }));
    return seen;
  }

  beforeEach(async () => {
    const mod = await import('../../src/runtime/loaders/assetManifest');
    vi.spyOn(mod, 'getAssetEntry').mockReturnValue(dynamicEntry as never);
  });

  it('fetches the metrics, NOT the .ttf — the generator is never started', async () => {
    const seen = trackingFetch(METRICS);
    const p = await acquireFont(1, 'font-dyn');
    expect(p, 'a dynamic font must load from its bake').not.toBeNull();

    expect(seen.some((u) => u.includes('~metrics.json')), 'must read the baked metrics').toBe(true);
    // The .ttf is the generator's input. Fetching it at boot is the regression.
    expect(seen.some((u) => /\.ttf(\?|$)/.test(u) && !u.includes('~')), 'must NOT fetch the raw .ttf at boot').toBe(false);
    expect(seen.some((u) => u.includes('~instance.ttf')), 'must NOT fetch the instance at boot').toBe(false);
  });

  it('serves baked glyphs immediately and reports the bake’s own atlas geometry', async () => {
    trackingFetch(METRICS);
    const p = (await acquireFont(1, 'font-dyn'))!;
    expect(p.getGlyph(65)?.advance).toBe(0.5);          // straight from the bake
    expect(p.atlas.width).toBe(64);                      // the bake's dims, not atlasMax
    expect(p.atlas.size).toBe(48);
    expect(p.atlas.distanceRange).toBe(4);
    expect(p.metrics.lineHeight).toBe(1.2);
  });

  it('serves page 0 as the baked IMAGE, not a canvas', async () => {
    trackingFetch(METRICS);
    const p = (await acquireFont(1, 'font-dyn'))!;
    expect(p.atlasImageUrl, 'page 0 must be the baked atlas image').toContain('~atlas.png');
    // Routing the bake through a 2D canvas would premultiply-round-trip its true-SDF alpha.
    expect(p.atlasCanvasAt?.(0)).toBeUndefined();
    expect(p.pageCount).toBe(1);                         // nothing generated yet
  });
});

describe('the unresolvable-font warning forgets a guid that later resolves (QA-ASSET-0005 class)', () => {
  // `unknownSeen` is module-level and only cleared on a full dispose, so ONE miss in the window
  // before the manifest reaches the client silenced that guid for the rest of the session — and
  // the deletion that actually broke the font then produced no console line at all. Same gap
  // `resolveRefWarnOnce` had; found by sweeping for its siblings.
  it('warns once, goes quiet once it resolves, then warns AGAIN when it genuinely breaks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockFetchOnce(METRICS);
      missingGuids.add('font-late');

      expect(await acquireFont(1, 'font-late')).toBeNull();     // transient miss
      expect(warn).toHaveBeenCalledTimes(1);
      expect(await acquireFont(1, 'font-late')).toBeNull();     // deduped
      expect(warn).toHaveBeenCalledTimes(1);

      // The second half of the same defect: the unresolvable result was MEMOIZED in
      // `loadPromises` and nothing ever cleared it, so the font stayed dead for the session
      // even after the manifest arrived. This line fails on the old code.
      missingGuids.delete('font-late');                          // manifest arrives
      expect(await acquireFont(1, 'font-late')).not.toBeNull();

      releaseFontsForScene(1);                                   // drop the cached provider
      missingGuids.add('font-late');                             // now genuinely deleted
      expect(await acquireFont(1, 'font-late')).toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);                     // warns AGAIN, not silently
    } finally { warn.mockRestore(); missingGuids.clear(); }
  });
});

/** #856 — `acquireFont`'s liveness capture/`invalidateFont`/`releaseFontsForScene`'s per-guid
 *  drop used a SHARED, module-wide generation (`liveness.capture()` / `liveness.invalidateAll()`),
 *  not one keyed by guid. So invalidating/releasing font A superseded every OTHER font's in-flight
 *  acquire in the same module — this matters because `ensureFontLoaded` is called per frame from
 *  `Scene2D.tsx`/`scene3DSync.ts`, so a live unrelated acquire genuinely can be in flight at the
 *  same time. Per-key now: `invalidateFont(guid)` invalidates only that guid's own key. Mirrors
 *  the reference fix in `spriteMaterialCache.invalidateShader` (#852). */
describe('fontAtlasLoader liveness generation (#856 per-key)', () => {
  /** Fetch, gated PER URL (not the single shared gate `mockFetchOnce` uses) so two concurrent
   *  `acquireFont` calls can be resolved independently and in a chosen order. "get-or-create" on
   *  both `resolveMatching` and the fetch handler, so it doesn't matter which runs first. */
  function mockFetchGatedByUrl() {
    const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
    function gateFor(url: string) {
      let g = gates.get(url);
      if (!g) {
        let resolve!: () => void;
        const promise = new Promise<void>(r => { resolve = r; });
        g = { promise, resolve };
        gates.set(url, g);
      }
      return g;
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      await gateFor(url).promise;
      return completeResponse({ ok: true, json: async () => METRICS });
    }));
    return {
      resolveMatching(substr: string) {
        const matches = [...gates.keys()].filter(u => u.includes(substr));
        if (matches.length === 0) throw new Error(`no in-flight fetch matching "${substr}" — call acquireFont first`);
        for (const u of matches) gateFor(u).resolve();
      },
    };
  }

  it('invalidating font A does not discard font B\'s unrelated in-flight acquire', async () => {
    const gated = mockFetchGatedByUrl();

    const pA = acquireFont(1, 'font-a'); // in flight
    const pB = acquireFont(1, 'font-b'); // in flight, concurrently

    invalidateFont('font-a'); // must supersede ONLY font-a's in-flight acquire

    gated.resolveMatching('font-b');
    const resultB = await pB;

    // font-b was never invalidated — its own acquire lands normally.
    expect(resultB).not.toBeNull();
    expect(getLoadedFont('font-b')).toBe(resultB);

    // Let font-a settle too so nothing is left hanging.
    gated.resolveMatching('font-a');
    await pA;
  });

  it('invalidating font A still discards its OWN in-flight acquire', async () => {
    const gated = mockFetchGatedByUrl();

    const pA = acquireFont(1, 'font-a'); // in flight

    invalidateFont('font-a'); // same key — must supersede this in-flight acquire

    gated.resolveMatching('font-a');
    const result = await pA;

    expect(result).toBeNull();
    expect(getLoadedFont('font-a')).toBeUndefined();
  });

  it('full teardown (disposeAllFonts) still supersedes every outstanding acquire', async () => {
    const gated = mockFetchGatedByUrl();

    const pB = acquireFont(1, 'font-b'); // in flight

    disposeAllFonts();

    gated.resolveMatching('font-b');
    const result = await pB;

    expect(result).toBeNull();
    expect(getLoadedFont('font-b')).toBeUndefined();
  });
});

/** #1397 — `ensureFontLoaded` runs every frame from both renderers, and a failed acquire used to
 *  remember nothing, so a font whose metrics were missing was fetched again every frame. */
describe('fontAtlasLoader — a failed load is classified before it is remembered (#1397)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const frames = async (n: number) => { for (let i = 0; i < n; i++) await acquireFont(1, 'font-a'); };
  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

  beforeEach(() => {
    // 'a dynamic font seeds from its bake' leaves its getAssetEntry spy installed.
    vi.restoreAllMocks();
    setManualNow(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { restoreRealClock(); vi.restoreAllMocks(); });

  it('a 404 on the metrics is fetched ONCE across many frames, until invalidateFont', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 404 }));
    await frames(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advanceManual(60 * 60 * 1000);
    await frames(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => completeResponse({ ok: true, status: 200, json: async () => METRICS }));
    invalidateFont('font-a');
    expect(await acquireFont(1, 'font-a')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a dropped connection backs off, then retries and loads', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    await frames(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advanceManual(RETRY_BASE_MS);
    fetchMock.mockImplementation(async () => completeResponse({ ok: true, status: 200, json: async () => METRICS }));
    expect(await acquireFont(1, 'font-a')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a DYNAMIC font whose bake answers 503 backs off — it does not pay the slow WASM seed path for a blip', async () => {
    fontBlocks.set('font-a', { mode: 'dynamic' });
    fetchMock.mockImplementation(async () => new Response('busy', { status: 503 }));
    await frames(3);
    // Only the metrics were asked for: the seed path's `.ttf` fetch never ran.
    expect(urls()).toEqual(['/fonts/font-a.ttf~metrics.json?v=h1']);
    advanceManual(RETRY_BASE_MS);
    await frames(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a stale load settling does not evict its replacement\'s in-flight entry', async () => {
    const gates: Array<() => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => {
      gates.push(() => resolve(new Response('nope', { status: 404 })));
    }));
    const stale = acquireFont(1, 'font-a');
    await Promise.resolve();
    invalidateFont('font-a');                  // supersedes it
    const replacement = acquireFont(1, 'font-a'); // the next frame's load
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    gates[0]();                                // the stale load settles first
    await stale;
    void acquireFont(1, 'font-a');             // a frame while the replacement is still in flight
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2); // was 3: the stale finally deleted the replacement
    gates[1]();
    await replacement;
  });

  it('a DYNAMIC font whose bake is ABSENT (the SPA fallback) still falls through to the seed path', async () => {
    fontBlocks.set('font-a', { mode: 'dynamic' });
    fetchMock.mockImplementation(async (u: string) => (String(u).includes('~metrics')
      ? new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      : new Response('nope', { status: 404 })));
    await frames(1);
    expect(urls()).toEqual(['/fonts/font-a.ttf~metrics.json?v=h1', '/fonts/font-a.ttf?v=h1']);
  });

  it('a transient failure repaints dirty-gated text when its retry is due', async () => {
    const { onTextDirty } = await import('../../src/runtime/rendering/text/textDirty');
    fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await frames(1);
      const fired = vi.fn();
      const off = onTextDirty(fired);
      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 10);
      expect(fired).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(fired).toHaveBeenCalled();
      off();
    } finally {
      vi.useRealTimers();
    }
  });

  it('failure memory is scene-scoped: the last owner letting go forgets it', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 404 }));
    await frames(1);
    releaseFontsForScene(1);
    await frames(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
