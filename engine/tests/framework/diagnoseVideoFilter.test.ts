/** `diagnose`'s opt-in `video` filter (#288 Phase 6) — the only surface that can read the
 *  downloaded-video cache.
 *
 *  The `VideoCache` singleton is a local `const` inside the `__MODOKI_MODULE_VIDEO__`-gated block
 *  in `app/ecs/pipeline.ts`, so cache state could not be introspected at all: QA-VIDEO-0002 had to
 *  patch `window.fetch` and infer a refetch, which measures the NETWORK rather than the cache and
 *  cannot tell a cache MISS from a cache that was never wired.
 *
 *  An accessor alone would not have been enough. `modoki_eval` runs in the renderer and could
 *  import the pipeline through `/@fs` — but that yields a SECOND module instance whose slot is
 *  null, i.e. a confident "no cache" for a live one.
 *
 *  ⚠️ The two null cases are the point. "Video compiled out" and "no Cache API" want opposite next
 *  moves, and NEITHER is "the cache is empty" — reporting an empty index for either is §5's
 *  could-not-look-as-nothing-is-there.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { runAgentOp } from '../../app/debug/agentBridge';
import { setActiveVideoCache, type ActiveVideoCache } from '@modoki/engine/runtime';

type Reply = {
  video?: { available: boolean; reason?: string; usedBytes?: number; budgetBytes?: number; count?: number; entries?: unknown[] };
};
const diagnose = (params?: unknown) => runAgentOp('diagnose', params ?? {}) as Promise<Reply>;

afterEach(() => { setActiveVideoCache(null); });

describe('the video half is OPT-IN', () => {
  it('a bare diagnose carries no `video` key at all', async () => {
    // diagnose is a SWEPT read tool, so an unconditional per-clip index would grow every caller's
    // payload to answer a question almost none of them asked (§6, summary-first).
    setActiveVideoCache({ entries: () => [], usedBytes: () => 0, budgetBytes: () => 1 });
    const r = await diagnose();
    expect(r.video).toBeUndefined();
  });
});

describe('no cache wired reports WHY, not an empty index', () => {
  it('available:false with a reason naming both causes', async () => {
    setActiveVideoCache(null);
    const r = await diagnose({ video: true });
    expect(r.video?.available).toBe(false);
    // Both causes named, because they want opposite next moves: rebuild without the module flag
    // off, versus accept that clips stream on this surface.
    expect(String(r.video?.reason)).toMatch(/__MODOKI_MODULE_VIDEO__/);
    expect(String(r.video?.reason)).toMatch(/Cache API/);
    // And it says explicitly what it is NOT, because that is the misreading that costs an hour.
    expect(String(r.video?.reason)).toMatch(/NOT "the cache is empty"/);
    // No index fields to mistake for a real (empty) answer.
    expect(r.video?.entries).toBeUndefined();
    expect(r.video?.count).toBeUndefined();
  });
});

describe('a wired cache reports its index', () => {
  it('used/budget bytes plus the per-clip entries', async () => {
    const fake: ActiveVideoCache = {
      entries: () => [{ key: 'intro.mp4', bytes: 1024 }, { key: 'outro.mp4', bytes: 2048, pinned: true }],
      usedBytes: () => 3072,
      budgetBytes: () => 8192,
    };
    setActiveVideoCache(fake);
    const r = await diagnose({ video: true });
    expect(r.video?.available).toBe(true);
    expect(r.video?.usedBytes).toBe(3072);
    expect(r.video?.budgetBytes).toBe(8192);
    expect(r.video?.count).toBe(2);
    expect(r.video?.entries).toHaveLength(2);
  });

  it('an EMPTY wired cache is available:true with count 0 — the case null must not impersonate', async () => {
    setActiveVideoCache({ entries: () => [], usedBytes: () => 0, budgetBytes: () => 8192 });
    const r = await diagnose({ video: true });
    expect(r.video?.available).toBe(true);
    expect(r.video?.count).toBe(0);
  });
});
