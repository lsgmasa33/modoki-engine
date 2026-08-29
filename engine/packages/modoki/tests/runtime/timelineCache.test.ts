/** timelineCache loader paths (review test-gap #3) — the async fetch/generation/failed machinery had
 *  NO test (every other timeline test seeds via `setTimeline`, bypassing the loader). Covers:
 *   - the generation guard: a fetch resolving AFTER `clearTimelineCache` bumped the generation must
 *     NOT populate the cache (a scene swapped out mid-flight);
 *   - the failed-set memo: a failed fetch is remembered so `getTimeline` returns null without
 *     re-fetching, and `invalidateTimeline` / `setTimeline` clears it to allow a retry;
 *   - `loadTimelineNow` returns null on a stale generation. */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { getTimeline, loadTimelineNow, invalidateTimeline, setTimeline, clearTimelineCache } from '../../src/runtime/loaders/timelineCache';
import { normalizeTimeline } from '../../src/runtime/timeline/types';
import { clearManifest, newGuid } from '../../src/runtime/loaders/assetManifest';

const flush = () => new Promise((r) => setTimeout(r, 0));
// text() as well as json(): the loaders read the body as TEXT so they can spot Vite's index.html
// SPA fallback and report a MISSING asset instead of a JSON syntax error.
const okResponse = (body: unknown) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(text), json: () => Promise.resolve(body) };
};
const httpError = (status: number) => ({ ok: false, status, statusText: 'err', json: () => Promise.reject(new Error('no body')) });
const DEF = { id: 'plain-id', name: 'A', duration: 2, frameRate: 30, tracks: [] };

let fetchMock: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  clearManifest();
});
afterEach(() => {
  clearTimelineCache();
  warnSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('timelineCache — async loader paths', () => {
  it('drops a fetch that resolves after clearTimelineCache bumped the generation', async () => {
    let resolve1: (v: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolve1 = r; }));

    expect(getTimeline('gen.tl')).toBeNull(); // kicks fetch #1 (pending), null until loaded
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearTimelineCache();                       // scene swap mid-flight → generation++
    resolve1(okResponse(DEF));                  // the stale fetch now resolves
    await flush();

    // The generation guard dropped the stale result: the cache is empty, so the next getTimeline
    // starts a FRESH fetch (#2) instead of hitting a populated entry.
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    getTimeline('gen.tl');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('remembers a failed fetch (no re-fetch) until invalidateTimeline / setTimeline clears it', async () => {
    fetchMock.mockResolvedValueOnce(httpError(404));
    expect(getTimeline('fail.tl')).toBeNull();
    await flush();
    expect(getTimeline('fail.tl')).toBeNull();       // still null — from the failed memo
    expect(fetchMock).toHaveBeenCalledTimes(1);       // NOT re-fetched

    invalidateTimeline('fail.tl');                    // clears the failed memo
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    getTimeline('fail.tl');
    expect(fetchMock).toHaveBeenCalledTimes(2);        // retry allowed

    // setTimeline also clears failed AND seeds the def synchronously.
    clearTimelineCache();
    fetchMock.mockResolvedValueOnce(httpError(500));
    getTimeline('seed.tl'); await flush();             // fail it
    setTimeline('seed.tl', normalizeTimeline({ ...DEF, id: 'seeded' }));
    expect(getTimeline('seed.tl')?.id).toBe('seeded'); // served from the seed, no fetch
  });

  it('caches a successful fetch — a second getTimeline hits the cache, no re-fetch', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(DEF));
    expect(getTimeline('ok.tl')).toBeNull(); // null until the fetch resolves
    await flush();
    const hit = getTimeline('ok.tl');
    expect(hit?.duration).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second read served from cache
  });

  it('loadTimelineNow returns null on a stale generation (scene swapped during the await)', async () => {
    let resolve2: (v: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolve2 = r; }));
    const p = loadTimelineNow('now.tl');
    clearTimelineCache();          // generation++ before the fetch resolves
    resolve2(okResponse(DEF));
    expect(await p).toBeNull();     // stale generation → discarded
  });

  it('loadTimelineNow resolves the def on a clean fetch', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(DEF));
    const def = await loadTimelineNow('clean.tl');
    expect(def?.duration).toBe(2);
  });
});

describe('timelineCache — a GUID-loaded timeline is invalidated BY PATH', () => {
  /** THE CRUX of the live-edit fix, and the one thing the plugin-side classification test cannot
   *  reach. A Director references its timeline by GUID, so `getTimeline` caches it under
   *  `resolveRef(guid)` — the manifest PATH. The dev-server watcher, meanwhile, only knows the
   *  file that changed and calls `invalidateTimeline(urlPath)`. If those two key forms did not
   *  agree, invalidation would silently no-op and the whole fix would do nothing while every
   *  other test stayed green — exactly how `invalidateAnimationClip` sat dead for so long. */
  const PATH = '/assets/timelines/tour.timeline.json';
  const GUID = '11111111-2222-4333-8444-555555555555';

  beforeEach(async () => {
    const { registerAsset } = await import('../../src/runtime/loaders/assetManifest');
    registerAsset(GUID, PATH, 'timeline');
  });

  it('resolves a GUID ref, then drops it when the watcher invalidates the resolved path', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ...DEF, id: GUID, name: 'BEFORE' }));

    expect(getTimeline(GUID)).toBeNull();       // kicks off the async load
    await flush();
    expect(getTimeline(GUID)?.name).toBe('BEFORE');
    expect(fetchMock).toHaveBeenCalledTimes(1); // now cached — no second fetch

    // What the dev server does on a .timeline.json write: it knows the PATH, not the GUID.
    invalidateTimeline(PATH);

    fetchMock.mockResolvedValueOnce(okResponse({ ...DEF, id: GUID, name: 'AFTER' }));
    expect(getTimeline(GUID)).toBeNull();       // cache miss ⇒ re-fetch, proving the keys agree
    await flush();
    expect(getTimeline(GUID)?.name).toBe('AFTER');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidating an UNRELATED path leaves the cached timeline alone', async () => {
    // Non-vacuity: the test above would also pass if invalidateTimeline nuked everything.
    fetchMock.mockResolvedValueOnce(okResponse({ ...DEF, id: GUID, name: 'BEFORE' }));
    getTimeline(GUID);
    await flush();

    invalidateTimeline('/assets/timelines/some-other.timeline.json');

    expect(getTimeline(GUID)?.name).toBe('BEFORE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// Close-out sweep of QA-ANIM-0018 (animationClipCache's fix): every sibling `*Cache` module
// shared the same `isGuid(ref) ? resolveRef(ref) : ref` cache-key helper, silently returning
// undefined for a guid absent from the manifest with no warning at all.
describe('timelineCache — unresolved guid warns once (parity with animationClipCache)', () => {
  it('warns once for a guid absent from the manifest', () => {
    const guid = newGuid();
    expect(getTimeline(guid)).toBeNull();
    expect(getTimeline(guid)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain(guid);
  });
});
