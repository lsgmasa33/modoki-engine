/** spriteMaterialCache unit tests (2D materials, Phase 2).
 *  The lazy compile-once cache: GUID → resolveRef → buildPixiShaderProgram, deduped,
 *  with a failed-marker (no per-frame retry) and clear-on-teardown. buildPixiShaderProgram
 *  + resolveRef are mocked (no Pixi / no manifest). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let build: ReturnType<typeof vi.fn<(p: string) => unknown>>;
// #852: invalidateShader's unconditional `invalidatePixiShaderProgram(manifestPath)` call needs a
// stub here too — the mock below used to omit it entirely, which was invisible while nothing in
// this file called invalidateShader. It's a bare spy (not exercised for content), same shape as
// `build` above: declared here so the factory (hoisted, evaluated once per module-graph reset)
// closes over a binding that has a real vi.fn() by the time it's actually called.
let invalidateProgram: ReturnType<typeof vi.fn<(p?: string) => void>>;
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
  invalidatePixiShaderProgram: (p?: string) => invalidateProgram(p),
}));

let cache: typeof import('../../src/runtime/loaders/spriteMaterialCache');

beforeEach(async () => {
  vi.resetModules();
  paths.clear();
  build = vi.fn<(p: string) => unknown>();
  invalidateProgram = vi.fn<(p?: string) => void>();
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

  // #1055. A JavaScriptCore stack (iOS) is frames only, so `stack || message` warned with a frame and
  // no message. Fabricated in the shape an iPad produced, since these run on V8.
  it('a rejection whose stack is frames only (JavaScriptCore) still warns with its MESSAGE (#1055)', async () => {
    paths.set('g1', 'mat.shader.json');
    const err = new Error('shader parse failed');
    Object.defineProperty(err, 'stack', { value: 'buildPixiShaderProgram@capacitor://localhost/assets/index.js:3:7' });
    build.mockRejectedValue(err);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    cache.ensureSpriteMaterial('g1');
    await flush();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Error: shader parse failed'));
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

// #852: `invalidateShader` used to be a thin wrapper around the wholesale `clearSpriteMaterialCache`
// (#842's fix for the watcher path never reaching this cache at all) — correct but far too coarse:
// ONE `.shader.json` edit dropped EVERY compiled 2D material program in the scene, flashing every
// material entity's fallback sprite for a frame and re-minting its Mesh+Shader slot. These tests
// drive it per-key: only the edited guid's own program is disturbed.
describe('invalidateShader (#852 per-key)', () => {
  const GUID_A = '11111111-1111-4111-8111-111111111111';
  const GUID_B = '22222222-2222-4222-8222-222222222222';
  const PATH_A = 'matA.shader.json';
  const PATH_B = 'matB.shader.json';

  it('evicts only the edited guid — a sibling material never flashes (the reported symptom)', async () => {
    const { registerAsset } = await import('../../src/runtime/loaders/assetManifest');
    paths.set(GUID_A, PATH_A);
    paths.set(GUID_B, PATH_B);
    // registerAsset seeds the REAL assetManifest pathToGuid index — invalidateShader resolves
    // its path argument through THIS, not through the `paths` map above (that one only backs the
    // mocked `resolveRef`, i.e. guid→path, the opposite direction).
    registerAsset(GUID_A, PATH_A, 'shader');
    registerAsset(GUID_B, PATH_B, 'shader');

    const programA = { params: [], id: 'A' } as any;
    const programB = { params: [], id: 'B' } as any;
    build.mockImplementation((p: string) => Promise.resolve(p === PATH_A ? programA : programB));

    cache.ensureSpriteMaterial(GUID_A);
    cache.ensureSpriteMaterial(GUID_B);
    await flush();
    expect(cache.getSpriteMaterialProgram(GUID_A)).toBe(programA);
    expect(cache.getSpriteMaterialProgram(GUID_B)).toBe(programB);

    cache.invalidateShader(PATH_A);

    // B must still be there SYNCHRONOUSLY — it never falls back to the default sprite.
    expect(cache.ensureSpriteMaterial(GUID_B)).toBe(programB);
    // A is gone and recompiles from scratch.
    expect(cache.getSpriteMaterialProgram(GUID_A)).toBeUndefined();
    expect(cache.ensureSpriteMaterial(GUID_A)).toBeUndefined(); // kicks a fresh compile
    await flush();
    expect(cache.getSpriteMaterialProgram(GUID_A)).toBe(programA);
    expect(build).toHaveBeenCalledTimes(3); // A, B, A again
    expect(invalidateProgram).toHaveBeenCalledWith(PATH_A); // the pixiShaderBuilder optimisation still runs
  });

  it('resolves a WATCHER-shaped path (a leading-slash asset URL, not a bare relative path invented by a test)', async () => {
    const { registerAsset } = await import('../../src/runtime/loaders/assetManifest');
    // Shape produced by absToAssetUrl (engine/plugins/vite-asset-scanner.ts) — what
    // ASSET_CACHE_INVALIDATORS.shader is actually called with by the file watcher.
    const WATCHER_PATH = '/games/fixture/assets/materials/toon.shader.json';
    paths.set(GUID_A, WATCHER_PATH);
    registerAsset(GUID_A, WATCHER_PATH, 'shader');
    const program = { params: [] } as any;
    build.mockResolvedValue(program);

    cache.ensureSpriteMaterial(GUID_A);
    await flush();
    expect(cache.getSpriteMaterialProgram(GUID_A)).toBe(program);

    cache.invalidateShader(WATCHER_PATH);
    expect(cache.getSpriteMaterialProgram(GUID_A)).toBeUndefined();
  });

  it('an unresolvable path (not yet in the manifest) falls back to a wholesale clear, not a silent no-op', async () => {
    const { registerAsset } = await import('../../src/runtime/loaders/assetManifest');
    paths.set(GUID_A, PATH_A);
    paths.set(GUID_B, PATH_B);
    registerAsset(GUID_A, PATH_A, 'shader');
    // GUID_B's path is deliberately left UNREGISTERED — it stands in for a brand-new
    // `.shader.json` the manifest scan hasn't indexed yet.
    const programA = { params: [], id: 'A' } as any;
    const programB = { params: [], id: 'B' } as any;
    build.mockImplementation((p: string) => Promise.resolve(p === PATH_A ? programA : programB));

    cache.ensureSpriteMaterial(GUID_A);
    cache.ensureSpriteMaterial(GUID_B);
    await flush();
    expect(cache.getSpriteMaterialProgram(GUID_A)).toBe(programA);
    expect(cache.getSpriteMaterialProgram(GUID_B)).toBe(programB);

    cache.invalidateShader('brand-new-not-yet-in-manifest.shader.json');

    // Unresolved must fail SAFE (wholesale), not silently no-op — a no-op would leave the
    // just-edited shader's own stale program in place, which is #523's symptom all over again.
    expect(cache.getSpriteMaterialProgram(GUID_A)).toBeUndefined();
    expect(cache.getSpriteMaterialProgram(GUID_B)).toBeUndefined();
  });

  it('invalidating one guid does not supersede a DIFFERENT guid\'s in-flight compile — and still supersedes its OWN', async () => {
    const { registerAsset } = await import('../../src/runtime/loaders/assetManifest');
    paths.set(GUID_A, PATH_A);
    paths.set(GUID_B, PATH_B);
    registerAsset(GUID_A, PATH_A, 'shader');
    registerAsset(GUID_B, PATH_B, 'shader');

    const aInFlight = deferred<unknown>(); // will resolve AFTER invalidateShader(A) supersedes it
    const bInFlight = deferred<unknown>(); // must be unaffected by invalidating A
    build.mockImplementation((p: string) => (p === PATH_A ? aInFlight.promise : bInFlight.promise));

    expect(cache.ensureSpriteMaterial(GUID_A)).toBeUndefined(); // A's compile in flight
    expect(cache.ensureSpriteMaterial(GUID_B)).toBeUndefined(); // B's compile in flight, concurrently

    cache.invalidateShader(PATH_A); // supersedes ONLY A's in-flight compile

    const staleProgramA = { params: [], id: 'stale-A' } as any;
    const freshProgramB = { params: [], id: 'fresh-B' } as any;
    aInFlight.resolve(staleProgramA);
    bInFlight.resolve(freshProgramB);
    await flush();

    // A's now-superseded compile must not re-seat a stale program once it resolves.
    expect(cache.getSpriteMaterialProgram(GUID_A)).toBeUndefined();
    // B was never invalidated — its own compile lands normally, unaffected by A's invalidation.
    expect(cache.getSpriteMaterialProgram(GUID_B)).toBe(freshProgramB);
  });

  it('wakes the invalidated guid\'s waiters, and does NOT wake an unrelated guid\'s', async () => {
    // The per-key mirror of `clearSpriteMaterialCache wakes waiters whose compile it superseded`.
    // A superseded compile fires no `onReady`, so evicting the set without firing it leaves a
    // still-live renderer with no signal to re-`ensure` — its entities stay on the fallback
    // sprite until an unrelated dirty. That is this issue's flash, made permanent for the one
    // shader actually edited.
    // ⚠️ `registerAsset` is NOT optional here, and omitting it does not fail loudly — it makes
    // `getGuidForPath` return undefined, so `invalidateShader` takes its unresolved-path FALLBACK
    // and this test silently asserts against the wholesale clear, i.e. the exact behaviour #852
    // removed. It passed anyway in a whole-file run because `assetManifest`'s module-level
    // `pathToGuid` is NOT reset by `vi.resetModules()` and still held the earlier tests'
    // registrations; run alone, it failed. Every test in this block needs its own.
    const { registerAsset } = await import('../../src/runtime/loaders/assetManifest');
    paths.set(GUID_A, PATH_A);
    paths.set(GUID_B, PATH_B);
    registerAsset(GUID_A, PATH_A, 'shader');
    registerAsset(GUID_B, PATH_B, 'shader');
    const { promise: pA } = deferred<unknown>();
    const { promise: pB } = deferred<unknown>();
    const onReadyA = vi.fn();
    const onReadyA2 = vi.fn();
    const onReadyB = vi.fn();

    build.mockReturnValueOnce(pA);
    expect(cache.ensureSpriteMaterial(GUID_A, onReadyA)).toBeUndefined();
    expect(cache.ensureSpriteMaterial(GUID_A, onReadyA2)).toBeUndefined(); // dedups onto the same compile
    build.mockReturnValueOnce(pB);
    expect(cache.ensureSpriteMaterial(GUID_B, onReadyB)).toBeUndefined();

    cache.invalidateShader(PATH_A);

    // EVERY waiter on A wakes — not just the first (two live viewports each register their own).
    expect(onReadyA).toHaveBeenCalledTimes(1);
    expect(onReadyA2).toHaveBeenCalledTimes(1);
    // B's compile is untouched and still in flight, so its waiter must NOT have been woken.
    expect(onReadyB).not.toHaveBeenCalled();
  });
});
