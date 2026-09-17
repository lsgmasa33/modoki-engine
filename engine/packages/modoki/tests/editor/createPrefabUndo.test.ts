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
/** The links the tree held BEFORE Create Prefab tagged over them — what undo must put back. */
const PRIOR_LINKS = [{ id: 7, data: { source: 'g-prior', localId: 1, rootInstanceId: 7, parentLocalId: 0 } }];
const detachSpy = vi.fn(() => PRIOR_LINKS);
const reattachSpy = vi.fn();
const calls: string[] = [];
const OLD_ID = 'g-old';
let runtimeExcludedFixture = 0;
vi.mock('../../src/editor/scene/prefab', () => ({
  // Reports whatever the current test asked for, so the propagation through
  // createPrefabFromEntity -> CreatePrefabResult.runtimeExcluded is asserted at the seam that
  // actually carries it (review F3: nothing downstream of the callback had a test).
  serializePrefab: (_id: number, _existing: unknown, opts?: { onRuntimeExcluded?: (n: number) => void }) => {
    if (runtimeExcludedFixture > 0) opts?.onRuntimeExcluded?.(runtimeExcludedFixture);
    return { id: 'g-new', root: {}, entities: [{ localId: 1, prefab: 'g-child' }] };
  },
  // createPrefabFromEntity awaits this before serializing (#1284). A no-op here is safe
  // precisely because this file asserts the undo/redo closures and mocks serializePrefab
  // anyway — and since #1295 the cache is populated by construction, so the warm is
  // belt-and-braces rather than the thing under test (prefabCacheWarm.test.ts covers that).
  preloadNestedPrefabsForSubtree: async () => {},
  // The real guard, reduced to its direct case: the child IS the parent.
  wouldCreateCycle: (parent: string, child: string) => parent === child,
  resolveExistingDocumentId: async () => OLD_ID,
  setPrefabCache: (...a: unknown[]) => setPrefabCacheSpy(...a),
  tagEntityTreeAsInstance: (...a: unknown[]) => { calls.push('tag'); return tagSpy(...a); },
  untagEntityTreeAsInstance: (...a: unknown[]) => { calls.push('untag'); return untagSpy(...a); },
  detachPrefabInstance: (...a: unknown[]) => { calls.push('detach'); return (detachSpy as (...x: unknown[]) => unknown)(...a); },
  reattachPrefabInstance: (...a: unknown[]) => { calls.push('reattach'); return reattachSpy(...a); },
  warnInertPrefabSizes: () => undefined,
}));

const registerAssetSpy = vi.fn();
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  registerAsset: (...a: unknown[]) => registerAssetSpy(...a),
  getGuidForPath: () => undefined,
  newGuid: () => 'g-minted',
}));

vi.mock('../../src/editor/undo/entityRef', () => ({
  entityRef: (id: number) => ({ resolve: () => id, rawId: id }),
}));

import { createPrefabFromEntity } from '../../src/editor/panels/assetOps';

// Which /api/* routes should fail this test. Everything else answers ok.
let failing = new Set<string>();
/** Files already on disk, path → text. `/api/write-file` honours `ifNoneMatch:'*'` against it the
 *  way the real route does (409, nothing written), and a plain GET of the asset serves the text. */
let onDisk = new Map<string, string>();
let written: Array<{ path: string; content: string; createOnly: boolean }> = [];
const mockFetch = vi.fn(async (url: string, init?: { body?: string }) => {
  const bad = Array.from(failing).some((r) => String(url).includes(r));
  if (!bad && String(url).includes('/api/write-file')) {
    const b = JSON.parse(init?.body ?? '{}') as { path: string; content: string; ifNoneMatch?: string };
    // Matched case-insensitively and answered with the stored spelling, as APFS and the real route do (#1273).
    const existing = [...onDisk.keys()].find((k) => k.toLowerCase() === b.path.toLowerCase());
    if (b.ifNoneMatch === '*' && existing) return { ok: false, status: 409, json: async () => ({ existingPath: existing }) } as any;
    written.push({ path: b.path, content: b.content, createOnly: b.ifNoneMatch === '*' });
    onDisk.set(existing ?? b.path, b.content);
  }
  const served = !String(url).includes('/api/') && [...onDisk.entries()].find(([p]) => String(url).endsWith(p));
  if (served) return { ok: true, status: 200, text: async () => served[1], json: async () => JSON.parse(served[1]) } as any;
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
  onDisk = new Map();
  written = [];
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockClear();
  setPrefabCacheSpy.mockClear(); tagSpy.mockClear(); untagSpy.mockClear(); registerAssetSpy.mockClear();
  detachSpy.mockClear(); reattachSpy.mockClear(); calls.length = 0;
  reattachSpy.mockReturnValue(0); // links restored cleanly unless a test says otherwise
  runtimeExcludedFixture = 0;
});
// Restored in afterEach, NOT inline: a failing assertion skips the rest of the body, so
// an inline restore never runs and the stub leaks into every later test.
afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; vi.unstubAllGlobals(); });

async function makeAction() {
  const res = await createPrefabFromEntity(7, '/p/thing.prefab.json', 'Create Prefab "Thing"', async () => true);
  if (!res || res === 'declined') throw new Error(`expected a created prefab, got ${res}`);
  return res.action;
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

  // #1272: the untag is scoped to the prefab being undone, so a held nested instance keeps its
  // link to its OWN child prefab instead of being stripped and restored from a guid that a
  // Play->Stop may have re-derived.
  it('untags only the prefab it is undoing, naming it', async () => {
    const action = await makeAction();
    await action.undo();
    expect(untagSpy).toHaveBeenCalledWith(7, '/p/thing.prefab.json');
  });

  // #1272: undo no longer DEPENDS on the guid-keyed reattach resolving, but a miss must not be
  // silent -- "restored nothing" and "restored everything" looking alike is what hid the bug.
  it('reports the links it could not put back, and says nothing when it restored them all', async () => {
    const quiet = await makeAction();
    const noErr = spyError();
    await quiet.undo();
    expect(noErr, 'a clean undo must not report').not.toHaveBeenCalled();

    const action = await makeAction();
    const err = spyError();
    reattachSpy.mockReturnValue(2);
    await action.undo();

    expect(err).toHaveBeenCalledTimes(1);
    const msg = String(err.mock.calls[0][0]);
    expect(msg).toContain('Undo');
    expect(msg).toContain('2 prefab links');
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

describe('createPrefabFromEntity over an EXISTING prefab (#1264)', () => {
  // Both callers derive the path from the entity's NAME, so a second entity called "Thing" lands on
  // the first Thing prefab. It used to replace it under a fresh guid — every placed instance
  // unlinked — and this function's undo then TRASHED the path, deleting the original too.
  const PATH = '/p/thing.prefab.json';
  const OLD_TEXT = `{"id":"${OLD_ID}","name":"old thing","entities":[]}\n`;

  it('asks, naming the path, and a NO writes nothing', async () => {
    onDisk.set(PATH, OLD_TEXT);
    const asked: string[] = [];
    const res = await createPrefabFromEntity(7, PATH, 'Create Prefab "Thing"', async (p) => { asked.push(p); return false; });
    expect(res).toBe('declined');
    expect(asked).toEqual([PATH]);
    expect(written).toEqual([]);
    expect(onDisk.get(PATH)).toBe(OLD_TEXT);
    expect(tagSpy).not.toHaveBeenCalled();
    expect(registerAssetSpy).not.toHaveBeenCalled();
  });

  it('a fresh path writes create-only and never asks', async () => {
    let asked = false;
    const res = await createPrefabFromEntity(7, PATH, 'Create Prefab "Thing"', async () => { asked = true; return true; });
    expect(res && res !== 'declined' && res.prefab.id).toBe('g-new');
    expect(asked).toBe(false);
    expect(written.map((w) => w.createOnly)).toEqual([true]);
  });

  it('a YES replaces KEEPING the replaced prefab\'s guid — in the file, the registration and the cache', async () => {
    onDisk.set(PATH, OLD_TEXT);
    const res = await createPrefabFromEntity(7, PATH, 'Create Prefab "Thing"', async () => true);
    if (!res || res === 'declined') throw new Error(String(res));
    expect(res.prefab.id).toBe(OLD_ID);
    expect(written).toHaveLength(1);
    expect(written[0].createOnly).toBe(false);
    expect((JSON.parse(written[0].content) as { id: string }).id).toBe(OLD_ID);
    expect(registerAssetSpy).toHaveBeenCalledWith(OLD_ID, PATH, 'prefab');
    expect(setPrefabCacheSpy).toHaveBeenCalledWith(OLD_ID, expect.objectContaining({ id: OLD_ID }));
  });

  it('a Replace over a CASE-VARIANT name registers, tags and undoes against the file that is really there (#1273)', async () => {
    const ON_DISK = '/p/Thing.prefab.json';
    onDisk.set(ON_DISK, OLD_TEXT);
    const res = await createPrefabFromEntity(7, PATH, 'Create Prefab "Thing"', async () => true);
    if (!res || res === 'declined') throw new Error(String(res));
    expect(res.savePath).toBe(ON_DISK);
    expect(registerAssetSpy).toHaveBeenCalledWith(OLD_ID, ON_DISK, 'prefab');
    // The written prefab is handed to tagging so it can check its freshly-computed plan against
    // the file that actually landed (#1278 close-out §2d) — the two are computed either side of
    // the write's await, which on a Replace includes the confirmReplace dialog.
    expect(tagSpy).toHaveBeenCalledWith(7, ON_DISK, expect.objectContaining({ id: OLD_ID }));
    // The snapshot is taken WITHOUT stripping (#1278): tagging overwrites the rows it owns, and
    // must leave a held nested instance's members carrying their own link rather than relying on
    // a strip-then-retag that no longer retags them.
    expect(detachSpy).toHaveBeenCalledWith(7, { strip: false });
    written = [];
    await res.action.undo();
    expect(written.map((w) => w.path)).toEqual([ON_DISK]);
    expect(onDisk.get(ON_DISK)).toBe(OLD_TEXT);
  });

  it('UNDO of a replace RESTORES the replaced bytes and never trashes the file', async () => {
    onDisk.set(PATH, OLD_TEXT);
    const res = await createPrefabFromEntity(7, PATH, 'Create Prefab "Thing"', async () => true);
    if (!res || res === 'declined') throw new Error(String(res));
    setPrefabCacheSpy.mockClear();
    await res.action.undo();
    expect(onDisk.get(PATH)).toBe(OLD_TEXT);
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes('/api/delete-asset'))).toBe(false);
    expect(setPrefabCacheSpy).toHaveBeenCalledWith(OLD_ID, expect.objectContaining({ name: 'old thing' }));
    expect(untagSpy).toHaveBeenCalledTimes(1);
  });

  it('a replace that would nest the prefab inside itself is refused, and the old file survives', async () => {
    // The draft carries a reference row to 'g-child'. Replacing the prefab whose id IS 'g-child'
    // with it would make that prefab contain itself.
    onDisk.set(PATH, OLD_TEXT);
    const err = spyError();
    const prefabMod = await import('../../src/editor/scene/prefab');
    const spy = vi.spyOn(prefabMod, 'resolveExistingDocumentId').mockResolvedValue('g-child');
    try {
      const res = await createPrefabFromEntity(7, PATH, 'Create Prefab "Thing"', async () => true);
      expect(res).toBeNull();
      expect(written).toEqual([]);
      expect(onDisk.get(PATH)).toBe(OLD_TEXT);
      expect(String(err.mock.calls[0]?.[0])).toMatch(/inside itself/);
    } finally { spy.mockRestore(); }
  });
});

describe('createPrefabFromEntity keeps the links the tree ALREADY had (#1264 close-out)', () => {
  // Tagging overwrites every PrefabInstance in the subtree. Create Prefab on an instance of the prefab
  // it replaces (same name → same path), or on a tree holding nested instances, used to come back from
  // undo with NO link at all — and the next save wrote plain entities.
  it('snapshots the prior links BEFORE tagging', async () => {
    await makeAction();
    expect(calls.slice(0, 2)).toEqual(['detach', 'tag']);
  });

  it('undo of a CREATE untags, then restores the prior links', async () => {
    const action = await makeAction();
    calls.length = 0;
    await action.undo();
    expect(calls).toEqual(['untag', 'reattach']);
    expect(reattachSpy).toHaveBeenCalledWith(PRIOR_LINKS, { rootEcsId: 7 });
  });

  it('undo of a REPLACE untags, then restores the prior links', async () => {
    onDisk.set('/p/thing.prefab.json', `{"id":"${OLD_ID}","entities":[]}\n`);
    const res = await createPrefabFromEntity(7, '/p/thing.prefab.json', 'Create Prefab "Thing"', async () => true);
    if (!res || res === 'declined') throw new Error(String(res));
    calls.length = 0;
    await res.action.undo();
    expect(calls).toEqual(['untag', 'reattach']);
    expect(reattachSpy).toHaveBeenCalledWith(PRIOR_LINKS, { rootEcsId: 7 });
  });

  it('redo after a successful undo of a REPLACE re-snapshots too', async () => {
    onDisk.set('/p/thing.prefab.json', `{"id":"${OLD_ID}","entities":[]}\n`);
    const res = await createPrefabFromEntity(7, '/p/thing.prefab.json', 'Create Prefab "Thing"', async () => true);
    if (!res || res === 'declined') throw new Error(String(res));
    await res.action.undo();
    calls.length = 0;
    await res.action.redo();
    expect(calls).toEqual(['detach', 'tag']);
  });

  it('redo re-snapshots before tagging again, so a second undo restores what redo overwrote', async () => {
    const action = await makeAction();
    await action.undo();
    calls.length = 0;
    await action.redo();
    expect(calls).toEqual(['detach', 'tag']);
  });
});

describe('a FAILED undo then redo does not overwrite the prior links with the new prefab\'s own (#1264 close-out)', () => {
  // reportUndoFailure RETURNS, so the undo manager moves the failed undo to the redo stack while the
  // tree is still tagged. A redo that re-snapshotted then would store THIS prefab's links as "prior",
  // and the next successful undo re-linked the tree to the file it had just trashed.
  it('redo after a failed undo tags without re-snapshotting; the next undo still restores the ORIGINAL links', async () => {
    const action = await makeAction();   // snapshot #1 → PRIOR_LINKS
    // Any LATER snapshot is of the tree carrying this prefab's own tags — a distinct value, so the
    // last assertion can tell which snapshot undo restored.
    const OWN_LINKS = [{ id: 7, data: { source: 'g-new', localId: 1, rootInstanceId: 7, parentLocalId: 0 } }];
    detachSpy.mockImplementation(() => OWN_LINKS as never);
    try {
      spyError();
      failing.add('/api/delete-asset');
      await action.undo();           // fails — tree stays tagged
      failing.clear();
      calls.length = 0;
      await action.redo();
      expect(calls, 'no snapshot of a tree that is still tagged').toEqual(['tag']);
      await action.undo();
      expect(reattachSpy).toHaveBeenLastCalledWith(PRIOR_LINKS, { rootEcsId: 7 });
    } finally { detachSpy.mockImplementation(() => PRIOR_LINKS); }
  });
});

describe('createPrefabFromEntity — the runtime-exclusion count reaches the caller', () => {
  it('carries what serializePrefab reported, so the panel can surface it', async () => {
    runtimeExcludedFixture = 3;
    const res = await createPrefabFromEntity(7, '/p/thing.prefab.json', 'Create Prefab "Thing"', async () => true);
    expect(res && res !== 'declined' ? res.runtimeExcluded : null).toBe(3);
  });

  it('reports 0 when the selection lost nothing', async () => {
    const res = await createPrefabFromEntity(7, '/p/thing.prefab.json', 'Create Prefab "Thing"', async () => true);
    expect(res && res !== 'declined' ? res.runtimeExcluded : null).toBe(0);
  });
});
