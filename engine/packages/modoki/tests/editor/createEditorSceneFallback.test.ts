/** createEditor scene-load fallback helpers (Missing Tests #2).
 *
 *  The editor's scene boot tries: stored last-scene → config.scenePath → initWorld
 *  → empty-camera. These pure helpers underpin that chain — the per-project
 *  last-scene key scoping, the de-duplicated candidate list, and the
 *  rendererReady timeout that must always clear its setTimeout. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  lastSceneKey,
  resolveSceneCandidates,
  canonicalBootScenePath,
  loadFirstScene,
  awaitRendererReady,
  RENDERER_READY_TIMEOUT_MS,
  RENDERER_READY_SOFT_TIMEOUT_MS,
} from '../../src/editor/createEditor';
import { registerAsset, clearManifest } from '../../src/runtime/loaders/assetManifest';

describe('lastSceneKey (per-project scoping)', () => {
  it('scopes by config.name so one project never leaks into another', () => {
    expect(lastSceneKey('3d-test')).toBe('modoki-last-scene:3d-test');
    expect(lastSceneKey('alien-animal')).toBe('modoki-last-scene:alien-animal');
    expect(lastSceneKey('3d-test')).not.toBe(lastSceneKey('alien-animal'));
  });
  it('falls back to "default" for an unnamed project', () => {
    expect(lastSceneKey(undefined)).toBe('modoki-last-scene:default');
    expect(lastSceneKey('')).toBe('modoki-last-scene:default');
  });
});

describe('resolveSceneCandidates (fallback order)', () => {
  it('orders last-scene first, then config default', () => {
    expect(resolveSceneCandidates('/a/last.json', '/a/default.json'))
      .toEqual(['/a/last.json', '/a/default.json']);
  });
  it('drops falsy entries (no stored last-scene → just the default)', () => {
    expect(resolveSceneCandidates(null, '/a/default.json')).toEqual(['/a/default.json']);
    expect(resolveSceneCandidates(undefined, '/a/default.json')).toEqual(['/a/default.json']);
    expect(resolveSceneCandidates('', '/a/default.json')).toEqual(['/a/default.json']);
  });
  it('collapses a last-scene that equals the default to a single candidate', () => {
    expect(resolveSceneCandidates('/a/x.json', '/a/x.json')).toEqual(['/a/x.json']);
  });
  it('returns an empty list when neither is set (→ initWorld/empty-camera path)', () => {
    expect(resolveSceneCandidates(null, undefined)).toEqual([]);
  });
});

describe('canonicalBootScenePath (gap #2 — boot the working-copy scene, not a bundle copy)', () => {
  const SCENE_GUID = '4bc54ae4-c5e5-4832-9c44-d45dcaa7412c';
  const CANON = '/assets/scenes/tropical-island.json';
  const BUNDLE = '/assets/tropical-island-DC3lOki3.json';

  const jsonResponse = (body: unknown, ok = true, status = 200): Response =>
    ({ ok, status, json: async () => body } as unknown as Response);

  beforeEach(() => clearManifest());

  it('maps a hashed bundle path to the canonical working-copy path via the scene GUID', async () => {
    registerAsset(SCENE_GUID, CANON, 'scene');
    const doFetch = vi.fn(async () => jsonResponse({ id: SCENE_GUID }));
    expect(await canonicalBootScenePath(BUNDLE, doFetch as never)).toBe(CANON);
    expect(doFetch).toHaveBeenCalledWith(BUNDLE, { cache: 'no-store' });
  });

  it('returns a candidate ALREADY registered in the manifest without fetching', async () => {
    registerAsset(SCENE_GUID, CANON, 'scene');
    const doFetch = vi.fn();
    expect(await canonicalBootScenePath(CANON, doFetch as never)).toBe(CANON);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('falls back to the raw candidate when the scene GUID is not in the manifest', async () => {
    const doFetch = vi.fn(async () => jsonResponse({ id: SCENE_GUID })); // empty manifest
    expect(await canonicalBootScenePath(BUNDLE, doFetch as never)).toBe(BUNDLE);
  });

  it('falls back to the raw candidate on a non-OK fetch (e.g. stale hash 404)', async () => {
    registerAsset(SCENE_GUID, CANON, 'scene');
    const doFetch = vi.fn(async () => jsonResponse(null, false, 404));
    expect(await canonicalBootScenePath(BUNDLE, doFetch as never)).toBe(BUNDLE);
  });

  it('falls back to the raw candidate when the fetch throws', async () => {
    registerAsset(SCENE_GUID, CANON, 'scene');
    const doFetch = vi.fn(async () => { throw new Error('network'); });
    expect(await canonicalBootScenePath(BUNDLE, doFetch as never)).toBe(BUNDLE);
  });

  it('falls back to the raw candidate when the scene file id is missing or not a GUID', async () => {
    registerAsset(SCENE_GUID, CANON, 'scene');
    expect(await canonicalBootScenePath(BUNDLE, (async () => jsonResponse({ id: 'nope' })) as never)).toBe(BUNDLE);
    expect(await canonicalBootScenePath(BUNDLE, (async () => jsonResponse({})) as never)).toBe(BUNDLE);
  });
});

describe('loadFirstScene (boot loop: canonicalize → load, raw fallback)', () => {
  const BUNDLE = '/assets/tropical-island-DC3lOki3.json';
  const CANON = '/assets/scenes/tropical-island.json';

  it('canonicalizes a candidate and loads the canonical path', async () => {
    const canonicalize = vi.fn(async () => CANON);
    const load = vi.fn(async () => true);
    expect(await loadFirstScene([BUNDLE], { canonicalize, load })).toBe(CANON);
    expect(canonicalize).toHaveBeenCalledWith(BUNDLE);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(CANON);
  });

  it('falls back to the RAW candidate when the canonical path fails to load', async () => {
    const canonicalize = vi.fn(async () => CANON);
    const load = vi.fn(async (p: string) => p === BUNDLE); // canonical fails, raw loads
    expect(await loadFirstScene([BUNDLE], { canonicalize, load })).toBe(BUNDLE);
    expect(load).toHaveBeenNthCalledWith(1, CANON);
    expect(load).toHaveBeenNthCalledWith(2, BUNDLE);
  });

  /** Regression: a THROWING candidate used to abort the whole fallback chain.
   *  loadScene rejects (rather than returning false) when the host serves the dev
   *  server's SPA index.html instead of the scene JSON — `JSON.parse` throws
   *  `Unexpected token '<'`. That escaped the loop, so the next candidate was never
   *  tried and editor boot died. Real case: a stale `/@fs/<abs>` last-scene for a
   *  project on a different Windows drive (vitejs/vite#12816). */
  const HTML_ERR = new SyntaxError(`Unexpected token '<', "<!doctype "... is not valid JSON`);

  it('advances to the next candidate when a candidate THROWS (SPA html fallback)', async () => {
    const STALE = '/@fs/C:/Users/x/Desktop/test/runtime/assets/scenes/main.json';
    const canonicalize = vi.fn(async (p: string) => p);
    const load = vi.fn(async (p: string) => {
      if (p === STALE) throw HTML_ERR; // dev server served index.html
      return true;
    });
    expect(await loadFirstScene([STALE, CANON], { canonicalize, load })).toBe(CANON);
    expect(load).toHaveBeenNthCalledWith(1, STALE);
    expect(load).toHaveBeenNthCalledWith(2, CANON);
  });

  it('returns null (does not reject) when EVERY candidate throws', async () => {
    const canonicalize = vi.fn(async (p: string) => p);
    const load = vi.fn(async () => { throw HTML_ERR; });
    await expect(loadFirstScene([BUNDLE, CANON], { canonicalize, load })).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('falls back to the RAW candidate when the CANONICAL one throws', async () => {
    const canonicalize = vi.fn(async () => CANON);
    const load = vi.fn(async (p: string) => {
      if (p === CANON) throw HTML_ERR;
      return true;
    });
    expect(await loadFirstScene([BUNDLE], { canonicalize, load })).toBe(BUNDLE);
  });

  it('survives a THROWING canonicalize by using the raw candidate', async () => {
    const canonicalize = vi.fn(async () => { throw new Error('network down'); });
    const load = vi.fn(async () => true);
    expect(await loadFirstScene([BUNDLE], { canonicalize, load })).toBe(BUNDLE);
    expect(load).toHaveBeenCalledWith(BUNDLE);
  });

  it('does NOT double-load when the candidate is already canonical', async () => {
    const canonicalize = vi.fn(async (p: string) => p); // already canonical
    const load = vi.fn(async () => false);
    expect(await loadFirstScene([CANON], { canonicalize, load })).toBeNull();
    expect(load).toHaveBeenCalledTimes(1); // no raw-fallback retry (canonical === candidate)
  });

  it('advances to the next candidate when both canonical and raw fail', async () => {
    const canonicalize = vi.fn(async (p: string) => `${p}#canon`);
    const order: string[] = [];
    const load = vi.fn(async (p: string) => { order.push(p); return p === '/b.json#canon'; });
    expect(await loadFirstScene(['/a.json', '/b.json'], { canonicalize, load })).toBe('/b.json#canon');
    // a canonical, a raw, then b canonical (succeeds → stops before b raw).
    expect(order).toEqual(['/a.json#canon', '/a.json', '/b.json#canon']);
  });

  it('stops at the first success without touching later candidates', async () => {
    const canonicalize = vi.fn(async (p: string) => p);
    const load = vi.fn(async () => true);
    expect(await loadFirstScene([CANON, '/other.json'], { canonicalize, load })).toBe(CANON);
    expect(canonicalize).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('returns null when no candidate loads (→ initWorld/empty-camera path)', async () => {
    const canonicalize = vi.fn(async (p: string) => p);
    const load = vi.fn(async () => false);
    expect(await loadFirstScene(['/a.json', '/b.json'], { canonicalize, load })).toBeNull();
    expect(await loadFirstScene([], { canonicalize, load })).toBeNull();
  });
});

describe('awaitRendererReady', () => {
  it('resolves when ready settles first and clears BOTH pending timers (soft + hard)', async () => {
    let n = 0;
    const setT = vi.fn(() => (++n) as unknown as ReturnType<typeof setTimeout>);
    const clearT = vi.fn();
    await awaitRendererReady(Promise.resolve(), 120_000, { setTimeout: setT as never, clearTimeout: clearT as never });
    // Two timers are armed (hard cap + soft warning) and BOTH are cleared on success.
    expect(setT).toHaveBeenCalledTimes(2);
    expect(clearT).toHaveBeenCalledTimes(2);
    expect(clearT.mock.calls.map((c) => c[0]).sort()).toEqual([1, 2]);
  });

  it('rejects when the HARD timeout fires — the soft warning does NOT settle the race', async () => {
    const cbs = new Map<number, () => void>(); // delay → cb (handle == delay)
    const setT = vi.fn((cb: () => void, delay: number) => { cbs.set(delay, cb); return delay as unknown as ReturnType<typeof setTimeout>; });
    const clearT = vi.fn();
    const onSoftTimeout = vi.fn();
    const p = awaitRendererReady(new Promise(() => {}), 120_000, { setTimeout: setT as never, clearTimeout: clearT as never }, { softTimeoutMs: 15_000, onSoftTimeout });
    cbs.get(15_000)!();  // soft deadline elapses first — a warning, NOT a rejection
    expect(onSoftTimeout).toHaveBeenCalledTimes(1);
    cbs.get(120_000)!(); // hard deadline elapses — THIS rejects
    await expect(p).rejects.toThrow(/rendererReady did not resolve within 120000ms/);
    expect(clearT).toHaveBeenCalledTimes(2); // both handles cleared, no dangling timer
  });

  it('the SOFT warning fires but a slow cold start still RECOVERS (does not abort the scene load)', async () => {
    const cbs = new Map<number, () => void>();
    const setT = vi.fn((cb: () => void, delay: number) => { cbs.set(delay, cb); return delay as unknown as ReturnType<typeof setTimeout>; });
    const clearT = vi.fn();
    const onSoftTimeout = vi.fn();
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((r) => { resolveReady = r; });
    const p = awaitRendererReady(ready, 120_000, { setTimeout: setT as never, clearTimeout: clearT as never }, { softTimeoutMs: 15_000, onSoftTimeout });
    cbs.get(15_000)!();  // soft deadline elapses — renderer still warming up (cold dep-optimize)
    expect(onSoftTimeout).toHaveBeenCalledTimes(1);
    resolveReady();      // …then the renderer finally readies before the hard cap
    await expect(p).resolves.toBeUndefined(); // recovered — NOT rejected
  });

  it('still clears BOTH timers when ready settles AFTER being slow (no dangling timer)', async () => {
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((r) => { resolveReady = r; });
    let n = 0;
    const setT = vi.fn(() => (++n) as unknown as ReturnType<typeof setTimeout>);
    const clearT = vi.fn();
    const p = awaitRendererReady(ready, 120_000, { setTimeout: setT as never, clearTimeout: clearT as never });
    resolveReady(); // late but before the (mocked, never-fired) deadline
    await p;
    expect(clearT.mock.calls.map((c) => c[0]).sort()).toEqual([1, 2]);
  });

  it('defaults to a generous 120s HARD deadline with a 15s SOFT warning', () => {
    expect(RENDERER_READY_TIMEOUT_MS).toBe(120_000);
    expect(RENDERER_READY_SOFT_TIMEOUT_MS).toBe(15_000);
  });

  // Regression: the DEFAULT timers must be globalThis-bound. Calling the real default
  // path (no injected timers) on a ready promise once threw "Illegal invocation" in the
  // browser because `timers.setTimeout(...)` ran with `this === timers`. The injected-timer
  // tests above can't catch this — they never use the default. This one does.
  it('works with the real default timers (no injected timers) — no Illegal invocation', async () => {
    await expect(awaitRendererReady(Promise.resolve())).resolves.toBeUndefined();
  });
});
