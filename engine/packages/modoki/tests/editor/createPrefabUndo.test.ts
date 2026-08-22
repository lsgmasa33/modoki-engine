/** createPrefabFromEntity's undo/redo closures (#308).
 *
 *  Both directions used to discard `deleteAssetFile`/`writeAssetFile`'s boolean and
 *  then run `setPrefabCache` + the instance tag/untag UNCONDITIONALLY. The sharp
 *  half is `redo`: caching a prefab whose file was never written leaves the editor
 *  reading it correctly from cache for the rest of the session, and finding it gone
 *  on the next scene load / editor relaunch — which read the FILE. The failure
 *  surfaces far from its cause, which is why the fix GATES rather than merely logs.
 *
 *  The issue filed this site as "unsure — partial skip only (the restore always
 *  runs)". It is not: it is the same confirmed cache-vs-disk desync as skinPrefab's.
 *
 *  Both directions are all-or-nothing. That differs from `makeDeleteUndo` (which
 *  restores what it can and reports the shortfall) because the unit of work differs:
 *  there it is N independent files, here it is ONE coupled operation — the
 *  .prefab.json plus the entities linked to it.
 *
 *  `writeAssetFile`/`deleteAssetFile` live in the module under test, so they cannot
 *  be `vi.mock`ed out — we fail them at the seam they actually use, the global
 *  `fetch` behind `backendFetch`, exactly as assetUndo.test.ts does. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const setPrefabCacheSpy = vi.fn();
const tagSpy = vi.fn();
const untagSpy = vi.fn();
vi.mock('../../src/editor/scene/prefab', () => ({
  serializePrefab: () => ({ id: 'g-new', root: {} }),
  setPrefabCache: (...a: unknown[]) => setPrefabCacheSpy(...a),
  tagEntityTreeAsInstance: (...a: unknown[]) => tagSpy(...a),
  untagEntityTreeAsInstance: (...a: unknown[]) => untagSpy(...a),
  warnInertPrefabSizes: () => undefined,
}));

const registerAssetSpy = vi.fn();
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  registerAsset: (...a: unknown[]) => registerAssetSpy(...a),
  getGuidForPath: () => undefined,
}));

vi.mock('../../src/editor/undo/entityRef', () => ({
  entityRef: (id: number) => ({ resolve: () => id, rawId: id }),
}));

import { createPrefabFromEntity } from '../../src/editor/panels/assetOps';

// Which /api/* routes should fail this test. Everything else answers ok.
let failing = new Set<string>();
const mockFetch = vi.fn(async (url: string) => {
  const bad = Array.from(failing).some((r) => String(url).includes(r));
  return { ok: !bad, status: bad ? 500 : 200, json: async () => ({}) } as any;
});

let spies: Array<{ mockRestore: () => void }> = [];
const spyError = () => {
  const s = vi.spyOn(console, 'error').mockImplementation(() => {});
  spies.push(s);
  return s;
};

beforeEach(() => {
  failing = new Set();
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockClear();
  setPrefabCacheSpy.mockClear(); tagSpy.mockClear(); untagSpy.mockClear(); registerAssetSpy.mockClear();
});
// Restored in afterEach, NOT inline: a failing assertion skips the rest of the body, so
// an inline restore never runs and the stub leaks into every later test.
afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; vi.unstubAllGlobals(); });

async function makeAction() {
  const res = await createPrefabFromEntity(7, '/p/thing.prefab.json', 'Create Prefab "Thing"');
  expect(res).not.toBeNull();
  return res!.action;
}

describe('createPrefabFromEntity — undo', () => {
  it('does not untag the live tree or clear the cache when the trash fails, and reports', async () => {
    const action = await makeAction();
    const err = spyError();
    setPrefabCacheSpy.mockClear();

    failing.add('/api/delete-asset');
    await action.undo();

    expect(err).toHaveBeenCalledTimes(1);
    const msg = String(err.mock.calls[0][0]);
    expect(msg).toContain('Undo');
    expect(msg).toContain('/p/thing.prefab.json');
    // All-or-nothing: the file is still on disk, so the entities stay linked to it
    // rather than being half-undone.
    expect(untagSpy).not.toHaveBeenCalled();
    expect(setPrefabCacheSpy).not.toHaveBeenCalled();
  });

  it('untags and clears the cache when the trash succeeds', async () => {
    const action = await makeAction();
    setPrefabCacheSpy.mockClear();

    await action.undo();

    expect(untagSpy).toHaveBeenCalledTimes(1);
    expect(setPrefabCacheSpy).toHaveBeenCalledWith('g-new', null);
  });
});

describe('createPrefabFromEntity — redo', () => {
  it('does not cache, register or tag when the write fails, and reports', async () => {
    const action = await makeAction();
    const err = spyError();
    setPrefabCacheSpy.mockClear(); registerAssetSpy.mockClear(); tagSpy.mockClear();

    failing.add('/api/write-file');
    await action.redo();

    expect(err).toHaveBeenCalledTimes(1);
    const msg = String(err.mock.calls[0][0]);
    expect(msg).toContain('Redo');
    expect(msg).toContain('/p/thing.prefab.json');
    // The desync this whole fix exists for: a cached prefab with no file behind it.
    expect(setPrefabCacheSpy).not.toHaveBeenCalled();
    expect(registerAssetSpy).not.toHaveBeenCalled();
    expect(tagSpy).not.toHaveBeenCalled();
  });

  it('caches, registers and tags when the write succeeds', async () => {
    const action = await makeAction();
    setPrefabCacheSpy.mockClear(); registerAssetSpy.mockClear(); tagSpy.mockClear();

    await action.redo();

    expect(setPrefabCacheSpy).toHaveBeenCalledTimes(1);
    expect(registerAssetSpy).toHaveBeenCalledTimes(1);
    expect(tagSpy).toHaveBeenCalledTimes(1);
  });
});
