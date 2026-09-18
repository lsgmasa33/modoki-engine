// @vitest-environment jsdom
/**
 * #1371 + #1374 — a load failure is classified before it is remembered.
 *
 * #1371: the six def caches remembered EVERY failure for the life of the process, so one dropped
 * request disabled the asset until restart. #1374: Scene2D's material-sprite textures remembered
 * nothing, so a 404 refetched on every dirty frame. One memo (`loadFailureMemo.ts`) now separates
 * a failure the same bytes reproduce (404, bad JSON — stays failed until invalidated) from one they
 * may not (no response, a 5xx — exponential backoff, capped at 10 min, never given up).
 *
 * Every case drives the REAL getter with only `fetch` stubbed and the clock manual, and counts
 * requests — the observable that separates "retries", "backs off" and "gave up".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Every engine import is a relative src path, never `@modoki/engine/runtime`: the OSS snapshot
// resolves the package specifier to a SECOND module instance, so the manual clock and current world
// set below would not be the ones the caches read (verify:publish went red on exactly that).
import { getSpriteAnim, clearSpriteAnimCache, invalidateSpriteAnim } from '../../packages/modoki/src/runtime/loaders/spriteAnimCache';
import { getRig2D, clearRig2DCache, invalidateRig2D } from '../../packages/modoki/src/runtime/loaders/rig2dCache';
import { getAnimSet, clearAnimSetCache, invalidateAnimSet } from '../../packages/modoki/src/runtime/loaders/animSetCache';
import { getParticleEffect, clearParticleCache, invalidateParticleEffect } from '../../packages/modoki/src/runtime/loaders/particleCache';
import { newGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import {
  getAnimationClip, clearAnimationClipCache, invalidateAnimationClip,
} from '../../packages/modoki/src/runtime/loaders/animationClipCache';
import {
  getTimeline, clearTimelineCache, invalidateTimeline,
} from '../../packages/modoki/src/runtime/loaders/timelineCache';
import {
  createLoadFailureMemo, classifyLoadFailure, retryDelayMs, AssetNetworkError,
  RETRY_BASE_MS, RETRY_CAP_MS,
} from '../../packages/modoki/src/runtime/core/loadFailureMemo';
import { MissingAssetError, parseAssetJson, checkAssetResponse, readAssetBytes } from '../../packages/modoki/src/runtime/loaders/assetFetch';
import { createWorld } from 'koota';
import { setCurrentWorld, getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/worldRegistry';
import { setManualNow, advanceManual, restoreRealClock } from '../../packages/modoki/src/runtime/core/clock';
import { journalEvents, clearJournal, setJournalEnabled, isJournalEnabled } from '../../packages/modoki/src/runtime/core/journal';
import { resolveMaterial, resolveMeshTemplate, disposeAllCachedResources, invalidateMaterial, invalidateMeshAsset, acquireMesh, releaseMesh } from '../../packages/modoki/src/runtime/loaders/meshTemplateCache';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** One row per def cache — its getter, invalidator, clear, and a body its normaliser accepts. */
const CACHES = [
  { name: 'spriteAnimCache', path: '/assets/anims/lf.spriteanim.json', get: getSpriteAnim, inv: invalidateSpriteAnim, clear: clearSpriteAnimCache,
    body: () => ({ id: newGuid(), clips: {} }) },
  { name: 'rig2dCache', path: '/assets/rigs/lf.rig2d.json', get: getRig2D, inv: invalidateRig2D, clear: clearRig2DCache,
    body: () => ({ id: newGuid(), bones: [{ name: 'root', parent: -1, x: 0, y: 0, rot: 0 }], sprite: newGuid(),
      mesh: { verts: [[0, 0], [10, 0], [0, 10]], uvs: [[0, 0], [1, 0], [0, 1]], tris: [0, 1, 2] }, skinIndices: [0, 0, 0], skinWeights: [1, 1, 1] }) },
  { name: 'animSetCache', path: '/assets/anims/lf.animset.json', get: getAnimSet, inv: invalidateAnimSet, clear: clearAnimSetCache,
    body: () => ({ id: newGuid(), clips: [] }) },
  { name: 'particleCache', path: '/assets/particles/lf.particle.json', get: getParticleEffect, inv: invalidateParticleEffect, clear: clearParticleCache,
    body: () => ({ id: newGuid() }) },
  { name: 'animationClipCache', path: '/assets/anims/lf.anim.json', get: getAnimationClip, inv: invalidateAnimationClip, clear: clearAnimationClipCache,
    body: () => ({ id: newGuid(), duration: 1, tracks: [] }) },
  { name: 'timelineCache', path: '/assets/timelines/lf.timeline.json', get: getTimeline, inv: invalidateTimeline, clear: clearTimelineCache,
    body: () => ({ id: newGuid(), duration: 1, tracks: [] }) },
] as const;

let fetchMock: ReturnType<typeof vi.fn>;
let journalWasOn: boolean;

beforeEach(() => {
  setManualNow(0);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  journalWasOn = isJournalEnabled();
  setJournalEnabled(true);
  clearJournal(getCurrentWorld());
});
afterEach(() => {
  for (const c of CACHES) c.clear();
  disposeAllCachedResources();
  setJournalEnabled(journalWasOn);
  restoreRealClock();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('classifyLoadFailure', () => {
  it('no response and a non-404 status are transient; 404/410 and the SPA fallback are permanent; anything else is unknown', () => {
    expect(classifyLoadFailure(new AssetNetworkError(new TypeError('Failed to fetch')))).toBe('transient');
    expect(classifyLoadFailure(new MissingAssetError('503', { status: 503, absent: false }))).toBe('transient');
    expect(classifyLoadFailure(new MissingAssetError('404', { status: 404, absent: true }))).toBe('permanent');
    expect(classifyLoadFailure(new MissingAssetError('spa', { status: 200, absent: true }))).toBe('permanent');
    // A bare TypeError is what a bug in a normaliser throws too — never read as "network".
    expect(classifyLoadFailure(new TypeError('Failed to fetch'))).toBe('unknown');
    expect(classifyLoadFailure(new Error('x is not valid JSON'))).toBe('unknown');
  });
});

describe('createLoadFailureMemo — backoff schedule', () => {
  it('doubles from 1 s and holds at the 10-minute cap (owner ruling 2026-09-18), never giving up', () => {
    expect(RETRY_CAP_MS).toBe(600_000);
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelayMs(11)).toBe(600_000);  // 1000·2^10 = 1 024 000 → capped
    expect(retryDelayMs(500)).toBe(600_000); // still retrying, still capped
  });

  it('blocks a transient key only until its backoff expires, and each failure extends it', () => {
    const m = createLoadFailureMemo({ label: 't', unknownIs: 'permanent' });
    const net = new AssetNetworkError(new TypeError('offline'));
    m.record('k', net);
    expect(m.blocked('k')).toBe(true);
    advanceManual(RETRY_BASE_MS - 1);
    expect(m.blocked('k')).toBe(true);
    advanceManual(1);
    expect(m.blocked('k')).toBe(false);
    m.record('k', net); // second consecutive failure → 2 s
    advanceManual(RETRY_BASE_MS);
    expect(m.blocked('k')).toBe(true);
    advanceManual(RETRY_BASE_MS);
    expect(m.blocked('k')).toBe(false);
  });

  it('`unknownIs` decides an unclassifiable error — the def caches stick, Scene2D backs off', () => {
    const stick = createLoadFailureMemo({ label: 's', unknownIs: 'permanent' });
    const back = createLoadFailureMemo({ label: 'b', unknownIs: 'transient' });
    stick.record('k', new Error('opaque'));
    back.record('k', new Error('opaque'));
    advanceManual(RETRY_CAP_MS);
    expect(stick.blocked('k')).toBe(true);
    expect(back.blocked('k')).toBe(false);
  });

  it('a superseded (not live) failure remembers nothing', () => {
    const m = createLoadFailureMemo({ label: 't', unknownIs: 'permanent' });
    m.record('k', new MissingAssetError('404', { status: 404, absent: true }), false);
    expect(m.blocked('k')).toBe(false);
  });
});

describe.each(CACHES)('#1371 — $name', (c) => {
  it('a network failure is retried after its backoff, and the def then loads (was: null for the session)', async () => {
    const body = c.body();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(jsonRes(body));
    expect(c.get(c.path)).toBeNull();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Inside the backoff window the per-frame getter does not refetch.
    expect(c.get(c.path)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    advanceManual(RETRY_BASE_MS);
    expect(c.get(c.path)).toBeNull(); // kicks the retry
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(c.get(c.path)).not.toBeNull();
  });

  it('a 503 is transient too', async () => {
    fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 })).mockResolvedValue(jsonRes(c.body()));
    c.get(c.path);
    await flush();
    advanceManual(RETRY_BASE_MS);
    c.get(c.path);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(c.get(c.path)).not.toBeNull();
  });

  it('a 404 stays failed however long the session runs — until the file is invalidated', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 })).mockResolvedValue(jsonRes(c.body()));
    c.get(c.path);
    await flush();
    advanceManual(RETRY_CAP_MS * 3);
    expect(c.get(c.path)).toBeNull();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Accept side: the file watcher's invalidate re-arms it.
    c.inv(c.path);
    c.get(c.path);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(c.get(c.path)).not.toBeNull();
  });

  it('announces a failure streak ONCE — one warning, one @asset-load-failed journal event', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    for (let i = 0; i < 4; i++) {
      c.get(c.path);
      await flush();
      advanceManual(RETRY_CAP_MS);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const events = journalEvents({ type: '@asset-load-failed' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('warn');
    expect(events[0].payload).toMatchObject({ cache: c.name, key: c.path, transient: true });
    const warns = vi.mocked(console.warn).mock.calls.filter((a) => String(a[0]).includes(c.path));
    expect(warns).toHaveLength(1);
  });
});

describe('#1371 — meshTemplateCache materials', () => {
  const MAT = '/assets/materials/lf.mat.json';
  // A literal asset path is refused by `resolveRef` (GUID-only refs) — address it by guid.
  const MAT_GUID = newGuid();
  beforeEach(() => { registerAsset(MAT_GUID, MAT, 'material'); });

  it('a 503 backs off and retries instead of stamping the permanent MATERIAL_FAILED', async () => {
    fetchMock.mockResolvedValue(new Response('busy', { status: 503 }));
    resolveMaterial(MAT_GUID);
    await flush();
    resolveMaterial(MAT_GUID);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // backing off
    advanceManual(RETRY_BASE_MS);
    resolveMaterial(MAT_GUID);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 404 is still permanent until invalidateMaterial', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    resolveMaterial(MAT_GUID);
    await flush();
    advanceManual(RETRY_CAP_MS * 2);
    resolveMaterial(MAT_GUID);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    invalidateMaterial(MAT);
    resolveMaterial(MAT_GUID);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('#1371 — meshTemplateCache mesh assets', () => {
  const MESH = '/assets/meshes/lf.mesh.json';
  const MESH_GUID = newGuid();
  beforeEach(() => { registerAsset(MESH_GUID, MESH, 'mesh'); });

  it('a network failure backs off and retries instead of stamping the permanent MESH_FAILED', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    resolveMeshTemplate(MESH_GUID);
    await flush();
    resolveMeshTemplate(MESH_GUID);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // backing off
    advanceManual(RETRY_BASE_MS);
    resolveMeshTemplate(MESH_GUID);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 404 is still permanent until invalidateMeshAsset', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    resolveMeshTemplate(MESH_GUID);
    await flush();
    advanceManual(RETRY_CAP_MS * 2);
    resolveMeshTemplate(MESH_GUID);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    invalidateMeshAsset(MESH);
    resolveMeshTemplate(MESH_GUID);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('#1371 close-out review findings', () => {
  it('a connection dropped while the BODY is read is transient, not a permanent parse failure', async () => {
    const body = { id: newGuid(), clips: {} };
    const dropped = new Response('x', { status: 200 });
    vi.spyOn(dropped, 'text').mockRejectedValue(new TypeError('Load failed'));
    fetchMock.mockResolvedValueOnce(dropped).mockResolvedValue(jsonRes(body));
    const path = '/assets/anims/lf-body.spriteanim.json';
    getSpriteAnim(path);
    await flush();
    advanceManual(RETRY_BASE_MS);
    getSpriteAnim(path);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getSpriteAnim(path)).not.toBeNull();
  });

  it('a failure during a scene load is re-announced into the world that becomes current', async () => {
    const outgoing = getCurrentWorld();
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    const path = '/assets/rigs/lf-swap.rig2d.json';
    getRig2D(path); // the acquire runs while the OUTGOING world is current
    await flush();
    expect(journalEvents({ type: '@asset-load-failed' }, outgoing)).toHaveLength(1);

    const incoming = createWorld();
    try {
      setCurrentWorld(incoming);
      getRig2D(path); // the new scene's per-frame consumer asks
      getRig2D(path);
      const evs = journalEvents({ type: '@asset-load-failed' }, incoming);
      expect(evs).toHaveLength(1); // once per world, not per frame
      expect(evs[0].payload).toMatchObject({ cache: 'rig2dCache', key: path, transient: false });
    } finally {
      setCurrentWorld(outgoing);
      incoming.destroy();
    }
  });

  it('a format refusal is journalled too (markPermanent)', async () => {
    const path = '/assets/particles/lf-future.particle.json';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(jsonRes({ id: newGuid(), version: 999999 }));
    getParticleEffect(path);
    await flush();
    const evs = journalEvents({ type: '@asset-load-failed' });
    expect(evs).toHaveLength(1);
    expect(evs[0].payload).toMatchObject({ cache: 'particleCache', key: path, transient: false });
  });

  it('meshTemplateCache forgets a recovered failure, so the next outage starts at the base delay and is announced', async () => {
    const MESH = '/assets/meshes/lf-recover.mesh.json';
    const guid = newGuid();
    registerAsset(guid, MESH, 'mesh');
    const ok = () => jsonRes({ id: guid, mesh: 'm' });
    fetchMock
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValue(ok());
    await acquireMesh(9101, guid);          // 503 — streak 1
    advanceManual(RETRY_BASE_MS);
    await acquireMesh(9101, guid);          // lands
    releaseMesh(9101, guid);                // evicted on release
    advanceManual(60 * 60 * 1000);
    clearJournal(getCurrentWorld());
    await acquireMesh(9101, guid);          // 503 — a NEW streak
    expect(journalEvents({ type: '@asset-load-failed' })).toHaveLength(1);
    advanceManual(RETRY_BASE_MS);                 // base delay, not 2 s
    await acquireMesh(9101, guid);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    releaseMesh(9101, guid);
  });
});

describe('#1371 close-out §2d findings', () => {
  it('a body read CANCELLED by the caller\'s signal stays an AbortError — never a network failure', async () => {
    const res = new Response('{"partial":', { status: 200 });
    vi.spyOn(res, 'text').mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));
    const err = await parseAssetJson(res, '/assets/scenes/x.scene.json').catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(classifyLoadFailure(err)).toBe('unknown');
  });

  async function reannouncedInNewWorld(kind: 'mesh' | 'material'): Promise<number> {
    const path = kind === 'mesh' ? '/assets/meshes/lf-perm.mesh.json' : '/assets/materials/lf-perm.mat.json';
    const guid = newGuid();
    registerAsset(guid, path, kind);
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    const outgoing = getCurrentWorld();
    if (kind === 'mesh') { await acquireMesh(9102, guid); } else { resolveMaterial(guid); await flush(); }
    expect(journalEvents({ type: '@asset-load-failed' }, outgoing)).toHaveLength(1);
    const incoming = createWorld();
    try {
      setCurrentWorld(incoming);
      if (kind === 'mesh') resolveMeshTemplate(guid); else resolveMaterial(guid);
      return journalEvents({ type: '@asset-load-failed' }, incoming).length;
    } finally {
      setCurrentWorld(outgoing);
      incoming.destroy();
      if (kind === 'mesh') releaseMesh(9102, guid);
    }
  }

  it('a PERMANENT mesh failure is re-announced into the new world (the MESH_FAILED sentinel answers first)', async () => {
    expect(await reannouncedInNewWorld('mesh')).toBe(1);
  });

  it('a PERMANENT material failure is re-announced into the new world (MATERIAL_FAILED answers first)', async () => {
    expect(await reannouncedInNewWorld('material')).toBe(1);
  });

  it('a permanent mesh failure is scene-scoped: the next scene\'s acquire refetches it', async () => {
    const MESH = '/assets/meshes/lf-scoped.mesh.json';
    const guid = newGuid();
    registerAsset(guid, MESH, 'mesh');
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 })).mockResolvedValue(jsonRes({ id: guid, mesh: 'm' }));
    await acquireMesh(9103, guid);
    releaseMesh(9103, guid);
    await acquireMesh(9104, guid);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    releaseMesh(9104, guid);
  });
});

// ── #1397: the helper extensions the remaining loaders need ─────────────────────────────────────

/** three's FileLoader `HttpError` — not exported, so the test builds the same shape. */
function threeHttpError(status: number): Error {
  return Object.assign(new Error(`fetch for "x" responded with ${status}`), { response: { status } });
}

describe('#1397 E3 — three.js HttpError is classified by its status', () => {
  it('404/410 are permanent, other statuses transient, and a bare TypeError from the same loader stays unknown', () => {
    expect(classifyLoadFailure(threeHttpError(404))).toBe('permanent');
    expect(classifyLoadFailure(threeHttpError(410))).toBe('permanent');
    expect(classifyLoadFailure(threeHttpError(503))).toBe('transient');
    expect(classifyLoadFailure(threeHttpError(403))).toBe('transient');
    // FileLoader routes a dropped connection AND a parse error through one onError — no status.
    expect(classifyLoadFailure(new TypeError('Failed to fetch'))).toBe('unknown');
    // A non-Error carrying a status is not three's HttpError.
    expect(classifyLoadFailure({ response: { status: 404 } })).toBe('unknown');
  });
});

describe('#1397 E2 — checkAssetResponse types a binary asset\'s response', () => {
  const res = (status: number, type: string) => new Response(status === 204 ? null : 'x', { status, headers: { 'content-type': type } });
  it('404 and 410 are absent; a 503 is not; the SPA fallback (200 text/html) is absent; a real body passes', () => {
    const thrown = (r: Response) => { try { checkAssetResponse(r, '/f.ttf'); return undefined; } catch (e) { return e; } };
    for (const s of [404, 410]) {
      const e = thrown(res(s, 'text/plain'));
      expect(e).toBeInstanceOf(MissingAssetError);
      expect(classifyLoadFailure(e)).toBe('permanent');
    }
    const e503 = thrown(res(503, 'text/plain'));
    expect(e503).toBeInstanceOf(MissingAssetError);
    expect(classifyLoadFailure(e503)).toBe('transient');
    const spa = thrown(res(200, 'text/html; charset=utf-8'));
    expect(spa).toBeInstanceOf(MissingAssetError);
    expect(classifyLoadFailure(spa)).toBe('permanent');
    const ok = res(200, 'font/ttf');
    expect(checkAssetResponse(ok, '/f.ttf')).toBe(ok);
  });

  it('readAssetBytes marks a body read that fails as a network error, but passes a cancel through', async () => {
    const drop = { arrayBuffer: () => Promise.reject(new TypeError('Load failed')) } as unknown as Response;
    await expect(readAssetBytes(drop)).rejects.toBeInstanceOf(AssetNetworkError);
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const cancelled = { arrayBuffer: () => Promise.reject(abort) } as unknown as Response;
    await expect(readAssetBytes(cancelled)).rejects.toBe(abort);
  });
});

describe('#1397 E1 — onRetryDue wakes a caller whose askers do not come back on their own', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires once when a transient backoff expires, and not before', () => {
    const due = vi.fn();
    const memo = createLoadFailureMemo({ label: 't', unknownIs: 'transient', onRetryDue: due });
    memo.record('k', new AssetNetworkError('x'));
    expect(memo.pendingWakes).toBe(1);
    vi.advanceTimersByTime(RETRY_BASE_MS - 1);
    expect(due).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(due).toHaveBeenCalledTimes(1);
    expect(due).toHaveBeenCalledWith('k');
    expect(memo.pendingWakes).toBe(0);
  });

  it('a repeat failure replaces the timer rather than stacking a second one', () => {
    const due = vi.fn();
    const memo = createLoadFailureMemo({ label: 't', unknownIs: 'transient', onRetryDue: due });
    memo.record('k', new AssetNetworkError('x'));
    memo.record('k', new AssetNetworkError('x'));
    expect(memo.pendingWakes).toBe(1);
    vi.advanceTimersByTime(RETRY_CAP_MS);
    expect(due).toHaveBeenCalledTimes(1);
  });

  it('a permanent failure arms nothing, and forget/clear cancel a pending wake', () => {
    const due = vi.fn();
    const memo = createLoadFailureMemo({ label: 't', unknownIs: 'transient', onRetryDue: due });
    memo.record('gone', new MissingAssetError('404', { status: 404, absent: true }));
    expect(memo.pendingWakes).toBe(0);
    memo.record('a', new AssetNetworkError('x'));
    memo.record('b', new AssetNetworkError('x'));
    memo.forget('a');
    expect(memo.pendingWakes).toBe(1);
    memo.clear();
    expect(memo.pendingWakes).toBe(0);
    vi.advanceTimersByTime(RETRY_CAP_MS);
    expect(due).not.toHaveBeenCalled();
  });
});
