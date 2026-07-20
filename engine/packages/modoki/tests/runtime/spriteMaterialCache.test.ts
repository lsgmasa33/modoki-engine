/** spriteMaterialCache unit tests (2D materials, Phase 2).
 *  The lazy compile-once cache: GUID → resolveRef → buildPixiShaderProgram, deduped,
 *  with a failed-marker (no per-frame retry) and clear-on-teardown. buildPixiShaderProgram
 *  + resolveRef are mocked (no Pixi / no manifest). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let build: ReturnType<typeof vi.fn>;
const paths = new Map<string, string>();

vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  resolveRef: (guid: string) => paths.get(guid),
}));
vi.mock('../../src/runtime/rendering/pixiShaderBuilder', () => ({
  buildPixiShaderProgram: (p: string) => build(p),
}));

let cache: typeof import('../../src/runtime/loaders/spriteMaterialCache');

beforeEach(async () => {
  vi.resetModules();
  paths.clear();
  build = vi.fn();
  cache = await import('../../src/runtime/loaders/spriteMaterialCache');
});
afterEach(() => { vi.restoreAllMocks(); });

const flush = () => new Promise((r) => setTimeout(r, 0));

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
});
