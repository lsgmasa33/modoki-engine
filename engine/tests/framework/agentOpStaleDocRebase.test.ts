/** `anim-add-key` / `timeline-add-clip` rebase onto a live cache populated mid-fetch (#521).
 *
 *  Both ops share one shape on a cache miss: read a decision/document (here: "is this clip/
 *  timeline already in the live cache?"), and when it's not, `await fetch(...)` the disk copy
 *  and apply an edit to it wholesale. That `await` opens a window — if the human opens the same
 *  asset in its editor panel, or a concurrent agent op for the same path lands, WHILE the fetch
 *  is in flight, the live cache gets populated with content newer than what's mid-flight from
 *  disk. Writing the fetched doc wholesale after the await silently reverts that concurrent
 *  edit — the write becomes `{disk contents at fetch start} + this op's own item`, and
 *  `persistOrMarkDirty` then parks the truncated document for `save-all`, carrying the loss to
 *  disk. Same family as #492 (a decision read before an await, staled by what happened during
 *  it) and #420 (a flag read on one side of an await, stale by the other).
 *
 *  The fix re-reads the live cache right after the fetch resolves and rebases onto it instead of
 *  the fetched copy when the cache is no longer a miss — since everything after that point is
 *  synchronous, no further window exists.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { runAgentOp } from '../../app/debug/agentBridge';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { useEditorStore } from '@modoki/engine/editor';
import { getAnimationClip, getTimeline, type AnimationClipDef, type TimelineDef } from '@modoki/engine/runtime';

registerAllTraits();
registerEditorAgentOps();

const CLIP_PATH = 'assets/probe-521.anim.json';
const TL_PATH = 'assets/probe-521.timeline.json';
// The animationClipCache / timelineCache Maps are module-global and vitest isolates per FILE, not
// per test — so a path reused across `it`s in this file carries a cache HIT into a later test.
// The "genuine cache miss" tests below need a path nothing else in this file ever touches,
// otherwise they silently re-measure the cache-hit path while claiming to cover the miss.
const CLIP_PATH_MISS_ONLY = 'assets/probe-521-miss-only.anim.json';
const TL_PATH_MISS_ONLY = 'assets/probe-521-miss-only.timeline.json';
// Dedicated paths for the "fetch fails, cache populated mid-flight" cover below — same isolation
// reasoning as the MISS_ONLY paths.
const CLIP_PATH_FETCH_FAIL = 'assets/probe-521-fetch-fail.anim.json';
const TL_PATH_FETCH_FAIL = 'assets/probe-521-fetch-fail.timeline.json';
// Dedicated paths for the "fetch REJECTS, cache populated mid-flight" cover (#521 fix A1) — same
// isolation reasoning as the MISS_ONLY paths.
const CLIP_PATH_FETCH_REJECT = 'assets/probe-521-fetch-reject.anim.json';
const TL_PATH_FETCH_REJECT = 'assets/probe-521-fetch-reject.timeline.json';

const BASE_CLIP: AnimationClipDef = { id: '', name: 'probe', duration: 2, frameRate: 60, loop: false, tracks: [] };
const BASE_TL: TimelineDef = { duration: 2, tracks: [] } as unknown as TimelineDef;

/** A fetch stub whose promise the test controls — resolving it only after the test has had a
 *  chance to populate the live cache mid-flight. A fetch that resolves immediately cannot open
 *  the window this bug lives in. */
function stubFetch(body: unknown) {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => { resolve = r; });
  const fetchMock = vi.fn(async () => {
    await gate;
    // `.text()` matters, not just `.json()` — `getAnimationClip`/`getTimeline`'s OWN cache-miss
    // path (triggered by this same op's initial peek, independent of the op's explicit `fetch`)
    // also reads the mocked global fetch and parses via `parseAssetJson`, which reads `.text()`.
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, releaseFetch: resolve };
}

/** A fetch stub whose promise the test controls, and which resolves NOT ok — modelling the op's
 *  own `fetch(p.clipPath)`/`fetch(p.timelinePath)` 404ing while the live cache gets populated from
 *  a concurrent source (the panel opening the asset, or a concurrent op). Same gated shape as
 *  `stubFetch` above so the test controls the race window. */
function stubFetchFail() {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => { resolve = r; });
  const fetchMock = vi.fn(async () => {
    await gate;
    return { ok: false, status: 404, json: async () => { throw new Error('no body'); }, text: async () => '' } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, releaseFetch: resolve };
}

/** A fetch stub whose promise the test controls, and which REJECTS (network error / dev server
 *  down) rather than resolving `{ok:false}` — the OTHER half of "the op's own fetch failed while
 *  a live cache entry exists" that `stubFetchFail` above never actually modelled despite its old
 *  docstring claiming it did (#521 fix A1: a rejecting fetch used to unwind at the `await`, past
 *  the live-cache peek, before the `!res.ok` check ever ran). Same gated shape so the test controls
 *  the race window. */
function stubFetchReject() {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => { resolve = r; });
  const fetchMock = vi.fn(async () => {
    await gate;
    throw new TypeError('Failed to fetch');
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, releaseFetch: resolve };
}

/** Like `stubFetch`, but the loader's OWN cache-miss fetch (kicked off synchronously inside
 *  `getAnimationClip`/`getTimeline` before the op ever checks `if (!clip)` — call #1) and the op's
 *  own explicit fetch (call #2) resolve to DIFFERENT documents. Without this, both fetches request
 *  the identical `assetUrl(path)` (#521 fix A2 routed the op's own fetch through `assetUrl` too),
 *  so the "genuine cache miss" tests below passed only because the loader's internal `.then` chain
 *  has one extra microtask hop: the op's post-fetch `live` peek lands one tick before the loader's
 *  own `cache.set` runs and sees `null`, so it composes onto its OWN fetch response by a timing
 *  coincidence nothing asserted. Returning a distinguishable marker per call turns that coincidence
 *  into an observation: the final doc must carry the SECOND call's marker, proving the op composed
 *  onto its own disk read and not onto whatever the internal loader would eventually have cached. */
function stubFetchDistinctCalls(firstCallBody: unknown, secondCallBody: unknown) {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => { resolve = r; });
  let calls = 0;
  const fetchMock = vi.fn(async () => {
    await gate;
    calls += 1;
    const body = calls === 1 ? firstCallBody : secondCallBody;
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, releaseFetch: resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('anim-add-key rebases onto a cache populated while its fetch was in flight (#521)', () => {
  it('regression: a concurrent edit written during the fetch survives, alongside this op\'s own key', async () => {
    const { releaseFetch } = stubFetch(BASE_CLIP);
    const opPromise = runAgentOp('anim-add-key', {
      clipPath: CLIP_PATH, path: '', trait: 'Transform', field: 'x', time: 0.5, value: 1,
    }) as Promise<{ ok: boolean; tracks: number }>;

    // While the op's fetch is in flight, a concurrent edit (panel open / another agent op)
    // populates the live cache with a DIFFERENT track this op never saw.
    const concurrent: AnimationClipDef = {
      ...BASE_CLIP,
      // Keyframe fields are `t`/`v` (see runtime/animation/types.ts), not `time`/`value`.
      tracks: [{ path: '', trait: 'Transform', field: 'y', type: 'number', keys: [{ t: 0, v: 5, inTangent: 0, outTangent: 0 }] }],
    };
    useEditorStore.getState().applyAnimationClip(CLIP_PATH, concurrent);

    releaseFetch();
    const r = await opPromise;
    expect(r.ok).toBe(true);

    const final = getAnimationClip(CLIP_PATH) as AnimationClipDef;
    const yTrack = final.tracks.find((t) => t.field === 'y');
    const xTrack = final.tracks.find((t) => t.field === 'x');
    expect(yTrack, 'the concurrent edit must survive').toBeTruthy();
    expect(xTrack, "this op's own key must land").toBeTruthy();
    expect(xTrack?.keys.some((k) => k.t === 0.5)).toBe(true);
  });

  it('cache-hit path: fetch is never called, op composes onto the already-cached clip', async () => {
    const preexisting: AnimationClipDef = {
      ...BASE_CLIP,
      tracks: [{ path: '', trait: 'Transform', field: 'z', type: 'number', keys: [{ t: 0, v: 9, inTangent: 0, outTangent: 0 }] }],
    };
    useEditorStore.getState().applyAnimationClip(CLIP_PATH, preexisting);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const r = await (runAgentOp('anim-add-key', {
      clipPath: CLIP_PATH, path: '', trait: 'Transform', field: 'x', time: 1, value: 2,
    }) as Promise<{ ok: boolean }>);

    expect(r.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const final = getAnimationClip(CLIP_PATH) as AnimationClipDef;
    expect(final.tracks.find((t) => t.field === 'z')).toBeTruthy();
    expect(final.tracks.find((t) => t.field === 'x')).toBeTruthy();
  });

  it('genuine cache miss, no concurrency: composes onto the fetched disk document', async () => {
    // Own path — see CLIP_PATH_MISS_ONLY's comment: CLIP_PATH is already cached by the earlier
    // tests in this file, so reusing it here would silently measure the cache-hit path instead.
    // Distinct bodies per call (#521 fix C) so the assertion below observes WHICH fetch the op
    // composed onto instead of relying on a microtask-ordering coincidence.
    const INTERNAL_LOADER_BODY: AnimationClipDef = { ...BASE_CLIP, name: 'internal-loader-body-should-not-be-used' };
    const DISK_ONLY_BODY: AnimationClipDef = { ...BASE_CLIP, name: 'disk-only-marker-clip' };
    const { releaseFetch } = stubFetchDistinctCalls(INTERNAL_LOADER_BODY, DISK_ONLY_BODY);
    const opPromise = runAgentOp('anim-add-key', {
      clipPath: CLIP_PATH_MISS_ONLY, path: '', trait: 'Transform', field: 'w', time: 0.25, value: 3,
    }) as Promise<{ ok: boolean }>;
    releaseFetch();
    const r = await opPromise;
    expect(r.ok).toBe(true);

    const final = getAnimationClip(CLIP_PATH_MISS_ONLY) as AnimationClipDef;
    // The disk-only marker surviving proves the op composed onto its OWN fetch (call #2), not onto
    // whatever the internal loader's cache-miss fetch (call #1) would eventually have cached.
    expect(final.name).toBe(DISK_ONLY_BODY.name);
    // Exact track count/set, not just "the new field is somewhere" — BASE_CLIP starts with NO
    // tracks, so if the `?? fetched` fallback broke and this instead rebased onto an empty/stale
    // document, a looser assertion (a `find` alone) couldn't tell the difference.
    expect(final.tracks.length).toBe(1);
    expect(final.tracks.map((t) => t.field)).toEqual(['w']);
    expect(final.tracks.find((t) => t.field === 'w')).toBeTruthy();
  });

  it('a live cache entry populated mid-flight wins over the op\'s own fetch failing (#521 fix 3)', async () => {
    const { releaseFetch } = stubFetchFail();
    const opPromise = runAgentOp('anim-add-key', {
      clipPath: CLIP_PATH_FETCH_FAIL, path: '', trait: 'Transform', field: 'x', time: 0.5, value: 1,
    }) as Promise<{ ok: boolean; tracks: number }>;

    // While the op's own fetch is in flight (and about to fail), the panel opens the same clip,
    // populating the live cache — that entry must win over the failed fetch (#521 fix A1).
    const seeded: AnimationClipDef = {
      ...BASE_CLIP,
      tracks: [{ path: '', trait: 'Transform', field: 'y', type: 'number', keys: [{ t: 0, v: 5, inTangent: 0, outTangent: 0 }] }],
    };
    useEditorStore.getState().applyAnimationClip(CLIP_PATH_FETCH_FAIL, seeded);

    releaseFetch();
    const r = await opPromise;
    expect(r.ok).toBe(true);

    const final = getAnimationClip(CLIP_PATH_FETCH_FAIL) as AnimationClipDef;
    expect(final.tracks.find((t) => t.field === 'y'), 'the seeded live entry must survive').toBeTruthy();
    const xTrack = final.tracks.find((t) => t.field === 'x');
    expect(xTrack, "this op's own key must land, using the cache instead of throwing on the failed fetch").toBeTruthy();
    expect(xTrack?.keys.some((k) => k.t === 0.5)).toBe(true);
  });

  it('a live cache entry populated mid-flight wins over the op\'s own fetch REJECTING (#521 fix A1)', async () => {
    const { releaseFetch } = stubFetchReject();
    const opPromise = runAgentOp('anim-add-key', {
      clipPath: CLIP_PATH_FETCH_REJECT, path: '', trait: 'Transform', field: 'x', time: 0.5, value: 1,
    }) as Promise<{ ok: boolean; tracks: number }>;

    // While the op's own fetch is in flight (and about to REJECT — network error / dev server
    // down, not a 404), the panel opens the same clip, populating the live cache. Before fix A1
    // this unwound at the `await` and threw past the live-cache peek entirely.
    const seeded: AnimationClipDef = {
      ...BASE_CLIP,
      tracks: [{ path: '', trait: 'Transform', field: 'y', type: 'number', keys: [{ t: 0, v: 5, inTangent: 0, outTangent: 0 }] }],
    };
    useEditorStore.getState().applyAnimationClip(CLIP_PATH_FETCH_REJECT, seeded);

    releaseFetch();
    const r = await opPromise;
    expect(r.ok).toBe(true);

    const final = getAnimationClip(CLIP_PATH_FETCH_REJECT) as AnimationClipDef;
    expect(final.tracks.find((t) => t.field === 'y'), 'the seeded live entry must survive').toBeTruthy();
    const xTrack = final.tracks.find((t) => t.field === 'x');
    expect(xTrack, "this op's own key must land, using the cache instead of throwing on the rejecting fetch").toBeTruthy();
    expect(xTrack?.keys.some((k) => k.t === 0.5)).toBe(true);
  });
});

describe('timeline-add-clip rebases onto a cache populated while its fetch was in flight (#521)', () => {
  it('regression: a concurrent edit written during the fetch survives, alongside this op\'s own item', async () => {
    const { releaseFetch } = stubFetch(BASE_TL);
    const opPromise = runAgentOp('timeline-add-clip', {
      timelinePath: TL_PATH, trackType: 'signal', target: '', item: { time: 0.5, action: 'own-item' },
    }) as Promise<{ ok: boolean }>;

    // Concurrent edit lands in the live cache mid-flight — a different track this op never saw.
    const concurrent: TimelineDef = {
      ...BASE_TL,
      tracks: [{ id: 'track-concurrent', name: 'audio', target: '', type: 'audio', cues: [{ time: 0, clip: 'GUID-CONCURRENT' }] } as unknown as TimelineDef['tracks'][number]],
    } as unknown as TimelineDef;
    useEditorStore.getState().applyTimelineDoc(TL_PATH, concurrent);

    releaseFetch();
    const r = await opPromise;
    expect(r.ok).toBe(true);

    const final = getTimeline(TL_PATH) as TimelineDef;
    const audioTrack = final.tracks.find((t: { type: string }) => t.type === 'audio');
    const signalTrack = final.tracks.find((t: { type: string }) => t.type === 'signal');
    expect(audioTrack, 'the concurrent edit must survive').toBeTruthy();
    expect(signalTrack, "this op's own item must land").toBeTruthy();
    expect((signalTrack as unknown as { markers: Array<{ action: string }> })?.markers.some((m) => m.action === 'own-item')).toBe(true);
  });

  it('cache-hit path: fetch is never called, op composes onto the already-cached timeline', async () => {
    const preexisting: TimelineDef = {
      ...BASE_TL,
      tracks: [{ id: 'track-0', name: 'signal', target: '', type: 'signal', markers: [{ time: 0, action: 'pre-existing' }] } as unknown as TimelineDef['tracks'][number]],
    } as unknown as TimelineDef;
    useEditorStore.getState().applyTimelineDoc(TL_PATH, preexisting);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const r = await (runAgentOp('timeline-add-clip', {
      timelinePath: TL_PATH, trackType: 'audio', target: '', item: { time: 1, clip: 'GUID-NEW' },
    }) as Promise<{ ok: boolean }>);

    expect(r.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const final = getTimeline(TL_PATH) as TimelineDef;
    expect(final.tracks.find((t: { type: string }) => t.type === 'signal')).toBeTruthy();
    expect(final.tracks.find((t: { type: string }) => t.type === 'audio')).toBeTruthy();
  });

  it('genuine cache miss, no concurrency: composes onto the fetched disk document', async () => {
    // Own path — see TL_PATH_MISS_ONLY's comment: TL_PATH is already cached by the earlier tests
    // in this file, so reusing it here would silently measure the cache-hit path instead.
    // Distinct bodies per call (#521 fix C): the first call is the internal loader's OWN cache-miss
    // fetch (kicked off inside `getTimeline` before the op ever checks `if (!def)`) and carries a
    // stray track that must NOT survive; the second call is the op's own explicit fetch and is the
    // real, empty-tracks base. If the op ever composed onto the internal loader's body instead of
    // its own fetch, the stray audio track below would leak into the final document.
    const INTERNAL_LOADER_BODY: TimelineDef = {
      ...BASE_TL,
      tracks: [{ id: 'track-internal-loader', name: 'audio', target: '', type: 'audio', cues: [{ time: 0, clip: 'GUID-INTERNAL-LOADER-SHOULD-NOT-SURVIVE' }] } as unknown as TimelineDef['tracks'][number]],
    } as unknown as TimelineDef;
    const { releaseFetch } = stubFetchDistinctCalls(INTERNAL_LOADER_BODY, BASE_TL);
    const opPromise = runAgentOp('timeline-add-clip', {
      timelinePath: TL_PATH_MISS_ONLY, trackType: 'signal', target: '', item: { time: 0.25, action: 'disk-only' },
    }) as Promise<{ ok: boolean }>;
    releaseFetch();
    const r = await opPromise;
    expect(r.ok).toBe(true);

    const final = getTimeline(TL_PATH_MISS_ONLY) as TimelineDef;
    // Exact track count, not just "a signal track exists somewhere" — the disk-only (second-call)
    // body starts with NO tracks, so if the op had instead composed onto the internal loader's
    // (first-call) body, the stray audio track would show up here and this assertion would catch it.
    expect(final.tracks.length).toBe(1);
    const signalTrack = final.tracks.find((t: { type: string }) => t.type === 'signal');
    expect(signalTrack).toBeTruthy();
    expect(final.tracks.find((t: { type: string }) => t.type === 'audio'), 'internal-loader stray track must not leak in').toBeFalsy();
    expect((signalTrack as unknown as { markers: Array<{ action: string }> })?.markers.some((m) => m.action === 'disk-only')).toBe(true);
  });

  it('a live cache entry populated mid-flight wins over the op\'s own fetch failing (#521 fix 3)', async () => {
    const { releaseFetch } = stubFetchFail();
    const opPromise = runAgentOp('timeline-add-clip', {
      timelinePath: TL_PATH_FETCH_FAIL, trackType: 'signal', target: '', item: { time: 0.5, action: 'own-item' },
    }) as Promise<{ ok: boolean }>;

    // While the op's own fetch is in flight (and about to fail), the panel opens the same
    // timeline, populating the live cache — that entry must win over the failed fetch.
    const seeded: TimelineDef = {
      ...BASE_TL,
      tracks: [{ id: 'track-seeded', name: 'audio', target: '', type: 'audio', cues: [{ time: 0, clip: 'GUID-SEEDED' }] } as unknown as TimelineDef['tracks'][number]],
    } as unknown as TimelineDef;
    useEditorStore.getState().applyTimelineDoc(TL_PATH_FETCH_FAIL, seeded);

    releaseFetch();
    const r = await opPromise;
    expect(r.ok).toBe(true);

    const final = getTimeline(TL_PATH_FETCH_FAIL) as TimelineDef;
    const audioTrack = final.tracks.find((t: { type: string }) => t.type === 'audio');
    const signalTrack = final.tracks.find((t: { type: string }) => t.type === 'signal');
    expect(audioTrack, 'the seeded live entry must survive').toBeTruthy();
    expect(signalTrack, "this op's own item must land, using the cache instead of throwing on the failed fetch").toBeTruthy();
    expect((signalTrack as unknown as { markers: Array<{ action: string }> })?.markers.some((m) => m.action === 'own-item')).toBe(true);
  });

  it('a live cache entry populated mid-flight wins over the op\'s own fetch REJECTING (#521 fix A1)', async () => {
    const { releaseFetch } = stubFetchReject();
    const opPromise = runAgentOp('timeline-add-clip', {
      timelinePath: TL_PATH_FETCH_REJECT, trackType: 'signal', target: '', item: { time: 0.5, action: 'own-item' },
    }) as Promise<{ ok: boolean }>;

    // While the op's own fetch is in flight (and about to REJECT — network error / dev server
    // down, not a 404), the panel opens the same timeline, populating the live cache. Before fix
    // A1 this unwound at the `await` and threw past the live-cache peek entirely.
    const seeded: TimelineDef = {
      ...BASE_TL,
      tracks: [{ id: 'track-seeded', name: 'audio', target: '', type: 'audio', cues: [{ time: 0, clip: 'GUID-SEEDED' }] } as unknown as TimelineDef['tracks'][number]],
    } as unknown as TimelineDef;
    useEditorStore.getState().applyTimelineDoc(TL_PATH_FETCH_REJECT, seeded);

    releaseFetch();
    const r = await opPromise;
    expect(r.ok).toBe(true);

    const final = getTimeline(TL_PATH_FETCH_REJECT) as TimelineDef;
    const audioTrack = final.tracks.find((t: { type: string }) => t.type === 'audio');
    const signalTrack = final.tracks.find((t: { type: string }) => t.type === 'signal');
    expect(audioTrack, 'the seeded live entry must survive').toBeTruthy();
    expect(signalTrack, "this op's own item must land, using the cache instead of throwing on the rejecting fetch").toBeTruthy();
    expect((signalTrack as unknown as { markers: Array<{ action: string }> })?.markers.some((m) => m.action === 'own-item')).toBe(true);
  });
});
