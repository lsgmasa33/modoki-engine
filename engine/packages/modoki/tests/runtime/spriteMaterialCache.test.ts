/** spriteMaterialCache unit tests (2D materials, Phase 2).
 *  The lazy compile-once cache: GUID → resolveRef → buildPixiShaderProgram, deduped,
 *  with a failed-marker (no per-frame retry) and clear-on-teardown. buildPixiShaderProgram
 *  + resolveRef are mocked (no Pixi / no manifest). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let build: ReturnType<typeof vi.fn<(p: string) => unknown>>;
const paths = new Map<string, string>();

vi.mock('../../src/runtime/loaders/assetManifest', async (importOriginal) => {
  // Keep the REAL isGuid/getAssetEntry — resolveRefWarnOnce (modelGlbUrl.ts) needs both, and
  // this suite's fake ids ('g1', 'missing') aren't UUID-shaped, so the real isGuid treats them
  // as non-guid paths and resolveRefWarnOnce falls through to a plain resolveRef lookup —
  // preserving every existing test's behavior unchanged. Only resolveRef itself is stubbed.
  const actual = await importOriginal<typeof import('../../src/runtime/loaders/assetManifest')>();
  return { ...actual, resolveRef: (guid: string) => paths.get(guid) };
});
vi.mock('../../src/runtime/rendering/pixiShaderBuilder', () => ({
  buildPixiShaderProgram: (p: string) => build(p),
}));

let cache: typeof import('../../src/runtime/loaders/spriteMaterialCache');

beforeEach(async () => {
  vi.resetModules();
  paths.clear();
  build = vi.fn<(p: string) => unknown>();
  cache = await import('../../src/runtime/loaders/spriteMaterialCache');
});
afterEach(() => { vi.restoreAllMocks(); });

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A promise the test controls resolve/reject on, so a compile can be left in flight across a
 *  `clearSpriteMaterialCache()` call and then settled on demand — needed to reproduce #523's
 *  race (a clear landing mid-compile). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('ensureSpriteMaterial', () => {
  it('resolves a GUID, compiles once, then returns the program synchronously', async () => {
    paths.set('g1', 'mat.shader.json');
    const program = { params: [], manifest: {} } as any;
    build.mockResolvedValue(program);

    expect(cache.ensureSpriteMaterial('g1')).toBeUndefined(); // kicks off the async build
    await flush();
    expect(cache.ensureSpriteMaterial('g1')).toBe(program);   // ready
    expect(cache.getSpriteMaterialProgram('g1')).toBe(program);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('dedups concurrent requests — one compile while loading', async () => {
    paths.set('g1', 'mat.shader.json');
    build.mockReturnValue(new Promise(() => {})); // never resolves
    cache.ensureSpriteMaterial('g1');
    cache.ensureSpriteMaterial('g1');
    cache.ensureSpriteMaterial('g1');
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('invokes onReady once when the async compile resolves (idle-gate wake)', async () => {
    paths.set('g1', 'mat.shader.json');
    const program = { params: [] } as any;
    build.mockResolvedValue(program);
    const onReady = vi.fn();

    expect(cache.ensureSpriteMaterial('g1', onReady)).toBeUndefined();
    expect(onReady).not.toHaveBeenCalled();  // not yet — still loading
    await flush();
    expect(onReady).toHaveBeenCalledTimes(1); // fired when the program landed
  });

  it('invokes EVERY waiting caller onReady, not just the first (two live viewports both wake)', async () => {
    paths.set('g1', 'mat.shader.json');
    const program = { params: [] } as any;
    build.mockResolvedValue(program);
    const wakeA = vi.fn(); // GameView renderer's markDirty
    const wakeB = vi.fn(); // SceneView renderer's markDirty — registered while the compile is in flight

    cache.ensureSpriteMaterial('g1', wakeA); // kicks the compile, registers wake A
    cache.ensureSpriteMaterial('g1', wakeB); // dedups the compile but must still register wake B
    await flush();

    expect(wakeA).toHaveBeenCalledTimes(1);
    expect(wakeB).toHaveBeenCalledTimes(1); // BOTH viewports wake → both swap to the material Mesh
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onReady when the build fails', async () => {
    paths.set('g1', 'mat.shader.json');
    build.mockResolvedValue(null);
    const onReady = vi.fn();
    cache.ensureSpriteMaterial('g1', onReady);
    await flush();
    expect(onReady).not.toHaveBeenCalled();
  });

  it('marks a failed build and does not retry it every frame', async () => {
    paths.set('g1', 'mat.shader.json');
    build.mockResolvedValue(null); // buildPixiShaderProgram fell back
    cache.ensureSpriteMaterial('g1');
    await flush();
    expect(cache.ensureSpriteMaterial('g1')).toBeUndefined();
    cache.ensureSpriteMaterial('g1');
    expect(build).toHaveBeenCalledTimes(1); // not retried
  });

  it('a REJECTED compile clears loading/waiters, marks failed, warns, and never re-invokes onReady or build', async () => {
    paths.set('g1', 'mat.shader.json');
    build.mockRejectedValue(new Error('boom')); // buildPixiShaderProgram's promise rejects → .catch
    const onReady = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(cache.ensureSpriteMaterial('g1', onReady)).toBeUndefined(); // kicks off the compile
    await flush();

    expect(onReady).not.toHaveBeenCalled();                 // waiters dropped, no wake on failure
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[spriteMaterialCache] failed to build 2D material g1'),
    );
    expect(cache.getSpriteMaterialProgram('g1')).toBeUndefined(); // nothing cached

    // failed-marker holds: subsequent ensures return undefined without recompiling.
    expect(cache.ensureSpriteMaterial('g1')).toBeUndefined();
    expect(cache.ensureSpriteMaterial('g1', onReady)).toBeUndefined();
    expect(build).toHaveBeenCalledTimes(1); // not retried after the rejection
    expect(onReady).not.toHaveBeenCalled();
  });

  it('marks an unresolved GUID as failed without calling build', () => {
    // no path seeded → resolveRef returns undefined
    expect(cache.ensureSpriteMaterial('missing')).toBeUndefined();
    cache.ensureSpriteMaterial('missing');
    expect(build).not.toHaveBeenCalled();
  });

  // Close-out sweep of QA-ANIM-0018 (animationClipCache's fix): this file's OWN comment used to
  // claim "resolveRef already warned" for an unresolved guid — false, `resolveRef` is silent for
  // a valid-shaped guid simply absent from the manifest. Needs a REAL UUID shape: `isGuid` is not
  // mocked here (see the vi.mock comment above), and every other test's short fake id ('g1',
  // 'missing') is deliberately non-guid-shaped so it bypasses this warning path entirely.
  it('warns once for a real-shaped guid absent from the manifest (parity with animationClipCache)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guid = '11111111-2222-4333-8444-555555555555'; // not seeded in `paths`
    expect(cache.ensureSpriteMaterial(guid)).toBeUndefined();
    expect(cache.ensureSpriteMaterial(guid)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(guid);
    warn.mockRestore();
  });

  it('returns undefined for an empty guid', () => {
    expect(cache.ensureSpriteMaterial('')).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
  });

  it('clearSpriteMaterialCache drops resolved + failed so a re-ensure recompiles', async () => {
    paths.set('g1', 'mat.shader.json');
    const program = { params: [] } as any;
    build.mockResolvedValue(program);
    cache.ensureSpriteMaterial('g1');
    await flush();
    expect(cache.getSpriteMaterialProgram('g1')).toBe(program);

    cache.clearSpriteMaterialCache();
    expect(cache.getSpriteMaterialProgram('g1')).toBeUndefined();
    cache.ensureSpriteMaterial('g1'); // recompiles
    await flush();
    expect(build).toHaveBeenCalledTimes(2);
  });

  // #523 regression: a compile in flight when `clearSpriteMaterialCache()` fires must not write
  // its (now-stale) program back into the cache once it resolves.
  it('#523: a compile superseded by a clear does not re-seat its stale program on resolve', async () => {
    paths.set('g1', 'mat.shader.json');
    const staleProgram = { params: [], id: 'stale' } as any;
    const { promise, resolve } = deferred<unknown>();
    build.mockReturnValue(promise);

    expect(cache.ensureSpriteMaterial('g1')).toBeUndefined(); // kicks off the compile
    cache.clearSpriteMaterialCache();                          // supersedes it before it lands
    resolve(staleProgram);
    await flush();

    expect(cache.getSpriteMaterialProgram('g1')).toBeUndefined(); // stale program must NOT land
  });

  // #523 clobber hazard: this is the case that fails if the generation guard runs AFTER
  // loading.delete/waiters.delete instead of before — a superseded compile's cleanup would
  // delete the NEW compile's in-flight entry and orphan its waiter.
  it('#523: a second compile started after a clear survives the first (superseded) compile resolving', async () => {
    paths.set('g1', 'mat.shader.json');
    const staleProgram = { params: [], id: 'stale' } as any;
    const freshProgram = { params: [], id: 'fresh' } as any;
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    build.mockReturnValueOnce(first.promise);
    const onReady = vi.fn();

    expect(cache.ensureSpriteMaterial('g1')).toBeUndefined(); // first compile in flight
    cache.clearSpriteMaterialCache();                          // supersedes the first

    build.mockReturnValueOnce(second.promise);
    expect(cache.ensureSpriteMaterial('g1', onReady)).toBeUndefined(); // second compile + waiter registered
    expect(build).toHaveBeenCalledTimes(2);

    first.resolve(staleProgram); // superseded resolve must not touch the second compile's state
    await flush();

    // The second compile's in-flight/waiter bookkeeping must have survived the first's cleanup.
    expect(cache.getSpriteMaterialProgram('g1')).toBeUndefined(); // fresh compile hasn't landed yet
    expect(onReady).not.toHaveBeenCalled();

    second.resolve(freshProgram);
    await flush();

    expect(onReady).toHaveBeenCalledTimes(1); // the fresh compile's own waiter fires
    expect(cache.getSpriteMaterialProgram('g1')).toBe(freshProgram);
  });

  // #523: the .catch guard needs the same superseded-bail treatment as .then — a REJECTED
  // superseded compile must still warn (a real failure is worth logging) but must not mark the
  // NEW compile's guid as failed or touch its in-flight/waiter entries.
  it('#523: a REJECTED compile superseded by a clear still warns but does not clobber the new compile', async () => {
    paths.set('g1', 'mat.shader.json');
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    build.mockReturnValueOnce(first.promise);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onReady = vi.fn();

    expect(cache.ensureSpriteMaterial('g1')).toBeUndefined(); // first compile in flight
    cache.clearSpriteMaterialCache();                          // supersedes it

    build.mockReturnValueOnce(second.promise);
    expect(cache.ensureSpriteMaterial('g1', onReady)).toBeUndefined(); // second compile in flight

    first.reject(new Error('boom'));
    await flush();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[spriteMaterialCache] failed to build 2D material g1'),
    );
    expect(cache.ensureSpriteMaterial('g1')).toBeUndefined(); // NOT marked failed by the stale rejection

    second.resolve({ params: [], id: 'fresh' } as any);
    await flush();

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(cache.getSpriteMaterialProgram('g1')).toEqual({ params: [], id: 'fresh' });
    warn.mockRestore();
  });

  // #523 regression fix: a clear must WAKE the waiters whose compile it just superseded, not just
  // avoid clobbering them. Without this, a renderer still live after a sibling's clear (e.g.
  // Scene2D.stop() on one viewport while another keeps drawing) never learns its material landed
  // and is stuck on the fallback sprite until some unrelated dirty.
  it('clearSpriteMaterialCache wakes waiters whose compile it superseded', async () => {
    paths.set('g1', 'mat.shader.json');
    const staleProgram = { params: [], id: 'stale' } as any;
    const { promise, resolve } = deferred<unknown>();
    build.mockReturnValue(promise); // never settles before the clear
    const onReady = vi.fn();
    const onReady2 = vi.fn();

    expect(cache.ensureSpriteMaterial('g1', onReady)).toBeUndefined();   // kicks off the compile
    expect(cache.ensureSpriteMaterial('g1', onReady2)).toBeUndefined();  // dedups, takes the loading.has branch

    cache.clearSpriteMaterialCache();

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady2).toHaveBeenCalledTimes(1);

    // The superseded compile eventually resolving must not cache anything or wake anyone again.
    resolve(staleProgram);
    await flush();
    expect(cache.getSpriteMaterialProgram('g1')).toBeUndefined();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady2).toHaveBeenCalledTimes(1);
  });
});
