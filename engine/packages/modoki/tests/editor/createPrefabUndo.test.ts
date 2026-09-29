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
 *  Both directions are all-or-nothing: the unit of work is ONE coupled operation —
 *  the .prefab.json plus the entities linked to it.
 *
 *  `writeAssetFile`/`deleteAssetFile` live in the module under test, so they cannot
 *  be `vi.mock`ed out — we fail them at the seam they actually use, the global
 *  `fetch` behind `backendFetch`.
 *
 *  #1868: a REPLACE's undo and redo no longer write — they restore the document in memory (`restorePrefabsInMemory`,
 *  recorded here, run unmocked in the engine suites) and Save writes it. The failed-write and file-precondition cases
 *  below survive only for a CREATE's redo, which still writes a file deleted since (a new asset, over nothing). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setRunMode as setRunModeForAuthoring } from '../../src/runtime/core/playState';

const setPrefabCacheSpy = vi.fn();
const tagSpy = vi.fn();
const untagSpy = vi.fn();
const unstampSpy = vi.fn();
/** The links the tree held BEFORE Create Prefab tagged over them — what undo must put back. */
const PRIOR_LINKS = { links: [{ id: 7, data: { source: 'g-prior', localId: 1, rootInstanceId: 7, parentLocalId: 0 } }], orphans: [] };
const detachSpy = vi.fn(() => PRIOR_LINKS);
const reattachSpy = vi.fn();
const calls: string[] = [];
const preload = vi.hoisted(() => ({ during: null as null | (() => Promise<void> | void) }));
const OLD_ID = 'g-old';
let runtimeExcludedFixture = 0;
/** A Replace's undo and redo restore in memory (#1868): recorded here, and the caller's rebuild run as the real one runs
 *  it — the real restore (caches, park, refusal) is driven unmocked in the engine suites (prefabCommit.test.ts). */
const restoreSpy = vi.fn();
vi.mock('../../src/editor/scene/prefabMemoryRestore', () => ({
  restorePrefabsInMemory: async (restores: unknown, opts?: { rebuild?: () => void | Promise<void> }) => { restoreSpy(restores); await opts?.rebuild?.(); },
}));
vi.mock('../../src/editor/scene/prefab', () => ({
  // Nothing is parked in these trees (#1868): a Replace reads the file.
  parkedPrefabRead: () => null,
  // No placeholder for a missing prefab in these trees (#1699): Create Prefab's refusal asks this first.
  missingPrefabPlaceholders: () => [],
  // The commit's I16 check reads nested documents through these (#1817, #1866); these trees nest nothing it can read.
  getCachedPrefabSync: () => null,
  prefabNestingReader: () => () => null,
  // The no-write redo seats a cold key (I9); these trees read nothing back from it.
  primeEditorPrefabCache: () => {},
  // Reports whatever the current test asked for, so the propagation through
  // createPrefabFromEntity -> CreatePrefabResult.runtimeExcluded is asserted at the seam that
  // actually carries it (review F3: nothing downstream of the callback had a test).
  serializePrefab: (_id: number, existing: unknown, opts?: { onRuntimeExcluded?: (n: number) => void }) => {
    if (runtimeExcludedFixture > 0) opts?.onRuntimeExcluded?.(runtimeExcludedFixture);
    // The real serializer's cycle guard (`planPrefabRows`), reduced to its direct case: serialized FOR the prefab a row
    // nests, it refuses — logged, and null.
    if (existing === 'g-child') { console.error('[Prefab] refusing: it would nest "g-child" inside itself'); return null; }
    return { id: 'g-new', root: {}, entities: [{ localId: 1, prefab: 'g-child' }] };
  },
  // createPrefabFromEntity awaits this before serializing (#1284). A no-op here is safe
  // precisely because this file asserts the undo/redo closures and mocks serializePrefab
  // anyway — and since #1295 the cache is populated by construction, so the warm is
  // belt-and-braces rather than the thing under test (prefabCacheWarm.test.ts covers that).
  // #1750: `duringPreload` runs inside it — a cold warm is a real fetch, where a hot reload can renumber the world.
  preloadNestedPrefabsForSubtree: async () => { const f = preload.during; preload.during = null; await f?.(); },
  // The real guard, reduced to its direct case: the child IS the parent.
  wouldCreateCycle: (parent: string, child: string) => parent === child,
  // A Replace hands the replaced bytes to the matcher (#1686); what they parse to does not matter to this mocked serialize.
  parsedPrefabRows: () => undefined,
  classifyExistingDocumentId: async () => ({ kind: 'known', id: OLD_ID }),
  // The editor-cache half of `commitPrefabWrite` (#1692), which every write here now goes through.
  seatEditorPrefabCache: (...a: unknown[]) => setPrefabCacheSpy(...a),
  preloadNestedPrefabs: async () => {},
  rebaseStaleInstances: async () => 0,
  tagEntityTreeAsInstance: (...a: unknown[]) => { calls.push('tag'); tagSpy(...a); return new Map([['g-old', 'g-derived']]); },
  // Create Prefab's refusal of an unexpandable nested frame and its tag (#1790): nothing to refuse in these trees, and the
  // tag is the one above (its kept-state settle has nothing to settle here).
  unexpandedNestedRefusal: () => null,
  staleFramesInTreeRefusal: () => null,
  tagCreatedPrefab: (...a: unknown[]) => { calls.push('tag'); tagSpy(...a); return { guidRemap: new Map([['g-old', 'g-derived']]), undoKept: () => {} }; },
  // #1461: the tag stamps the members with the guid the reload derives, and undo reverses it. Recorded
  // here because this file is the only place the undo's call ORDER is asserted — see the sequences below.
  unstampMemberGuids: (...a: unknown[]) => { calls.push('unstamp'); return unstampSpy(...a); },
  untagEntityTreeAsInstance: (...a: unknown[]) => { calls.push('untag'); return untagSpy(...a); },
  detachPrefabInstance: (...a: unknown[]) => { calls.push('detach'); return (detachSpy as (...x: unknown[]) => unknown)(...a); },
  reattachPrefabInstance: (...a: unknown[]) => { calls.push('reattach'); return reattachSpy(...a); },
  // #1820: the re-link's rebase (nothing stale here) — not what this file tests (the file and cache half).
  rebaseStaleInstancesSoon: () => false,
  warnInertPrefabSizes: () => undefined,
}));

const registerAssetSpy = vi.fn();
// The real module under the spies: the write step's imports (the adoption owner, #1698) reach exports this file never
// names, and an explicit-list mock breaks on each new one.
vi.mock('../../src/runtime/loaders/assetManifest', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerAsset: (...a: unknown[]) => registerAssetSpy(...a),
  getGuidForPath: () => undefined,
  newGuid: () => 'g-minted',
  isGuid: (s: string) => s.startsWith('g-'),
  resolveRef: () => undefined,
}));
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ replaceCachedPrefab: vi.fn(), invalidatePrefab: vi.fn(), getPrefabRevision: () => 0 }));

/** Set to make the tree unresolvable, for the #1679 flag case. `gone` is a world swap that lands DURING the step's write,
 *  after `require` has passed (the in-rebuild miss, a #1823 shortfall); `refused` is one that landed before it, which
 *  `require` refuses (#1795's second route — its real-world case is in engine/tests/editor/prefabCommit.test.ts). */
// `Refused` is the real UndoRefusedError, set once the file has imported it: the factory cannot import it itself, since
// undoFailure's import graph reaches this very mock and the factory would wait on its own result.
const refState = vi.hoisted(() => ({ gone: false, refused: false, Refused: Error as new (m: string, t: string) => Error }));
vi.mock('../../src/editor/undo/entityRef', () => ({
  entityRef: (id: number) => ({
    resolve: () => (refState.gone ? null : id), rawId: id,
    require: () => { if (refState.refused) throw new refState.Refused('gone', 'gone'); return id; },
  }),
  isInstanceRootCheck: () => null,
}));

import { createPrefabFromEntity } from '../../src/editor/panels/assetOps';
import { UndoRefusedError } from '../../src/editor/undo/undoFailure';
refState.Refused = UndoRefusedError;
import { createHash } from 'node:crypto';

// Which /api/* routes should fail this test. Everything else answers ok.
let failing = new Set<string>();
/** Files already on disk, path → text. `/api/write-file` honours `ifNoneMatch:'*'` against it the
 *  way the real route does (409, nothing written), and a plain GET of the asset serves the text. */
let onDisk = new Map<string, string>();
// Over the bytes with a leading BOM stripped, as the route's `ifMatchRefusal` hashes them.
const sha = (t: string) => createHash('sha256').update(t.replace(/^\uFEFF/, '')).digest('hex');
let written: Array<{ path: string; content: string; createOnly: boolean }> = [];
const mockFetch = vi.fn(async (url: string, init?: { body?: string }) => {
  const bad = Array.from(failing).some((r) => String(url).includes(r));
  if (!bad && String(url).includes('/api/write-file')) {
    const b = JSON.parse(init?.body ?? '{}') as { path: string; content: string; ifNoneMatch?: string; ifMatch?: string };
    // Matched case-insensitively and answered with the stored spelling, as APFS and the real route do (#1273).
    const existing = [...onDisk.keys()].find((k) => k.toLowerCase() === b.path.toLowerCase());
    // The route's `ifMatch` rule (#1679), over the bytes this fake STORED — not a recomputation of them.
    if (b.ifMatch !== undefined && (!existing || sha(onDisk.get(existing)!) !== b.ifMatch)) return { ok: false, status: 409, json: async () => ({ reason: 'if-match' }) } as any;
    if (b.ifNoneMatch === '*' && existing) return { ok: false, status: 409, json: async () => ({ reason: 'if-none-match', existingPath: existing }) } as any;
    written.push({ path: b.path, content: b.content, createOnly: b.ifNoneMatch === '*' });
    onDisk.set(existing ?? b.path, b.content);
  }
  if (!bad && String(url).includes('/api/exists')) {
    // Case-insensitive, answered with the stored spelling, as the real route does (#1273).
    const asked = decodeURIComponent(String(url).split('path=')[1] ?? '');
    const existing = [...onDisk.keys()].find((k) => k.toLowerCase() === asked.toLowerCase());
    return { ok: true, status: 200, json: async () => ({ exists: !!existing, ...(existing ? { path: existing } : {}) }) } as any;
  }
  if (!bad && String(url).includes('/api/delete-asset')) {
    const b = JSON.parse(init?.body ?? '{}') as { paths: string[]; ifMatch?: Record<string, string> };
    const conflicts = Object.entries(b.ifMatch ?? {}).filter(([p, h]) => !onDisk.has(p) || sha(onDisk.get(p)!) !== h).map(([p]) => p);
    if (conflicts.length) return { ok: false, status: 409, json: async () => ({ ok: false, reason: 'if-match', conflicts }) } as any;
    for (const p of b.paths) onDisk.delete(p);
    return { ok: true, status: 200, json: async () => ({ ok: true, trashed: b.paths.length, missing: [], failed: [] }) } as any;
  }
  const served = !String(url).includes('/api/') && [...onDisk.entries()].find(([p]) => String(url).endsWith(p));
  // A REAL Response over the stored bytes: its `text()` strips a leading BOM, as a browser's does — which is the #1684
  // note's whole point, and a fake `text()` that kept it would hide the defect.
  if (served) return new Response(new TextEncoder().encode(served[1]), { status: 200 });
  // An asset that is not there is a 404, as the host serves it: a create's redo reads the path and writes back only a
  // file that is absent (#1795).
  if (!bad && !String(url).includes('/api/')) return new Response('', { status: 404 });
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
  refState.gone = false;
  refState.refused = false;
});
// Restored in afterEach, NOT inline: a failing assertion skips the rest of the body, so
// an inline restore never runs and the stub leaks into every later test.
afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; vi.unstubAllGlobals(); });

async function makeAction() {
  const res = await createPrefabFromEntity(7, '/p/thing.prefab.json', 'Create Prefab "Thing"', async () => true);
  if (!res || res === 'declined' || 'refused' in res) throw new Error(`expected a created prefab, got ${res}`);
  return res.action;
}

// The editor authors in 'stopped'; the runtime DEFAULT is 'playing' (a shipped game boots playing), and
// every writer of the live world refuses outside an authored world (#1548) — so the premise is stated.
beforeEach(() => { setRunModeForAuthoring('stopped'); });

describe('createPrefabFromEntity — undo', () => {
  // #1795 (hub ruling (i), Unity): a CREATE's undo unlinks the tree and leaves the prefab — no trash, no write, and the
  // caches keep the document the file still holds. Mutation: put the trash back in the create branch of the undo.
  it('a CREATE\'s undo untags and asks the route for nothing: the file and the cache stay', async () => {
    const action = await makeAction();
    const bytes = onDisk.get('/p/thing.prefab.json');
    setPrefabCacheSpy.mockClear();
    mockFetch.mockClear();

    await action.undo();

    expect(untagSpy).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(onDisk.get('/p/thing.prefab.json')).toBe(bytes);
    expect(setPrefabCacheSpy).not.toHaveBeenCalled();
  });

  // #1272: the untag is scoped to the prefab being undone, so a held nested instance keeps its
  // link to its OWN child prefab instead of being stripped and restored from a guid that a
  // Play->Stop may have re-derived.
  it('untags only the prefab it is undoing, naming it', async () => {
    const action = await makeAction();
    await action.undo();
    // …by the prefab DOCUMENT it wrote (#1807): its own id resolves the link, not the manifest's view of the path.
    expect(untagSpy).toHaveBeenCalledWith(7, '/p/thing.prefab.json', expect.objectContaining({ id: expect.any(String) }));
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
  // The undo left the file (#1795), so the redo re-links to it and writes nothing while it holds the document.
  // Mutation: drop the create branch of the redo — it writes over the file it expects to be absent, and is refused.
  it('re-links to the file the undo left, writing and caching nothing', async () => {
    const action = await makeAction();
    await action.undo();
    setPrefabCacheSpy.mockClear(); registerAssetSpy.mockClear(); tagSpy.mockClear();
    written = [];

    await action.redo();

    expect(written).toEqual([]);
    expect(setPrefabCacheSpy).not.toHaveBeenCalled();
    expect(tagSpy).toHaveBeenCalledTimes(1);
  });

  // A file deleted after the undo (the unused asset cleaned up) is written back — and that write is gated (#308).
  it('does not cache, register or tag when the write of a deleted file fails, and reports', async () => {
    const action = await makeAction();
    await action.undo();
    onDisk.delete('/p/thing.prefab.json');
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

  it('caches, registers and tags when the write of a deleted file succeeds', async () => {
    const action = await makeAction();
    await action.undo();
    onDisk.delete('/p/thing.prefab.json');
    setPrefabCacheSpy.mockClear(); registerAssetSpy.mockClear(); tagSpy.mockClear();

    await action.redo();

    // Under every key it is read by (#1692) — the guid among them.
    expect(setPrefabCacheSpy).toHaveBeenCalledWith('g-new', expect.objectContaining({ id: 'g-new' }));
    expect(registerAssetSpy).toHaveBeenCalledTimes(1);
    expect(tagSpy).toHaveBeenCalledTimes(1);
  });
});

describe('createPrefabFromEntity over an EXISTING prefab (#1264)', () => {
  // Both callers derive the path from the entity's NAME, so a second entity called "Thing" lands on
  // the first Thing prefab. It used to replace it under a fresh guid — every placed instance
  // unlinked — and this function's undo then TRASHED the path, deleting the original too.
  const PATH = '/p/thing.prefab.json';
  // With its root row, as every prefab has: a replaced document with NO rows would hold a lower localId high-water mark
  // than the one-row tree the mocked serialize writes, and the undo would then raise it into the bytes (#1774) — pinned
  // in `tests/editor/localIdCounter.test.ts`. These cases are about the verbatim restore.
  const OLD_TEXT = `{"id":"${OLD_ID}","name":"old thing","entities":[{"localId":1}]}\n`;

  // Close-out review of #1692: the tree is serialized AFTER the Replace question now, by the id it was asked for. A world
  // rebuilt while the question was up (a watcher reload, an agent's scene load) can hand that id to another entity.
  // Mutation: drop the world check after the question in `createPrefabFromEntity`.
  it('a world rebuilt while the Replace question was up refuses, and writes nothing', async () => {
    onDisk.set(PATH, OLD_TEXT);
    const { createWorld } = await import('koota');
    const { getCurrentWorld, setCurrentWorld } = await import('../../src/runtime/core/ecs/world');
    const before = getCurrentWorld();
    try {
      const res = await createPrefabFromEntity(7, PATH, 'Create Prefab "Thing"', async () => { setCurrentWorld(createWorld()); return true; });
      expect(res).toMatchObject({ refused: expect.stringMatching(/reloaded while the question was open/) });
      expect(onDisk.get(PATH)).toBe(OLD_TEXT);
      expect(written).toHaveLength(0);
    } finally { setCurrentWorld(before); }
  });

  it('a world rebuilt while the nested prefabs were warmed refuses, and writes nothing (#1750: H1`s class)', async () => {
    const { createWorld } = await import('koota');
    const { getCurrentWorld, setCurrentWorld } = await import('../../src/runtime/core/ecs/world');
    const before = getCurrentWorld();
    preload.during = () => { setCurrentWorld(createWorld()); };
    try {
      const res = await createPrefabFromEntity(7, PATH, 'Create Prefab "Thing"', async () => true);
      expect(res).toMatchObject({ refused: expect.stringMatching(/reloaded while the prefab was being prepared/) });
      expect(written).toHaveLength(0);
      expect(tagSpy).not.toHaveBeenCalled();
    } finally { setCurrentWorld(before); preload.during = null; }
  });

  it('the entity rebuilt IN PLACE while the nested prefabs were warmed (same world, its index recycled) refuses, and writes nothing (#1750)', async () => {
    const { getCurrentWorld } = await import('../../src/runtime/core/ecs/world');
    const world = getCurrentWorld();
    const e = world.spawn();
    const id = e.id();
    // Destroyed and re-minted into the SAME index, as a frame rebuilt in place is: koota hands the freed index back with a
    // bumped generation, so the id is equal and the entity is not.
    preload.during = () => { e.destroy(); const again = world.spawn(); expect(again.id(), 'premise: the index was recycled').toBe(id); };
    try {
      const res = await createPrefabFromEntity(id, PATH, 'Create Prefab "Thing"', async () => true);
      expect(res).toMatchObject({ refused: expect.stringMatching(/was rebuilt while the prefab was being prepared/) });
      expect(written).toHaveLength(0);
      expect(tagSpy).not.toHaveBeenCalled();
    } finally { preload.during = null; for (const x of [...world.entities]) if (x.id() === id) x.destroy(); }
  });

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
    expect(res && res !== 'declined' && !('refused' in res) && res.prefab.id).toBe('g-new');
    expect(asked).toBe(false);
    expect(written.map((w) => w.createOnly)).toEqual([true]);
  });

  it('a YES replaces KEEPING the replaced prefab\'s guid — in the file, the registration and the cache', async () => {
    onDisk.set(PATH, OLD_TEXT);
    const res = await createPrefabFromEntity(7, PATH, 'Create Prefab "Thing"', async () => true);
    if (!res || res === 'declined' || 'refused' in res) throw new Error(String(res));
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
    if (!res || res === 'declined' || 'refused' in res) throw new Error(String(res));
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
    // #1868: restored in memory by the prefab's guid — which the manifest maps to the file really there — and nothing
    // written; the untag names that file.
    expect(written).toEqual([]);
    expect(restoreSpy).toHaveBeenLastCalledWith([expect.objectContaining({ source: OLD_ID, doc: expect.objectContaining({ name: 'old thing' }) })]);
    expect(untagSpy).toHaveBeenLastCalledWith(7, ON_DISK, expect.objectContaining({ id: OLD_ID }));
  });

  // #1684's note on #1692: a Windows tool's leading BOM used to be dropped from the prior bytes, because they were read
  // with `Response.text()`, which strips it — and a BOM the READ keeps must still parse. Since #1868 the undo restores the
  // DOCUMENT in memory, and Save re-serializes it (a BOM or hand formatting is Save's serializer's, as for every parked
  // document). Mutation: parse the prior bytes without dropping the BOM — the restore gets no document.
  it('UNDO of a replace over a BOM-prefixed file restores its document', async () => {
    onDisk.set(PATH, `\uFEFF${OLD_TEXT}`);
    const res = await createPrefabFromEntity(7, PATH, 'Create Prefab "Thing"', async () => true);
    if (!res || res === 'declined' || 'refused' in res) throw new Error(String(res));
    await res.action.undo();
    expect(restoreSpy).toHaveBeenLastCalledWith([expect.objectContaining({ doc: expect.objectContaining({ id: OLD_ID, name: 'old thing' }) })]);
  });

  it('UNDO of a replace restores the replaced document in memory, and never writes or trashes the file', async () => {
    onDisk.set(PATH, OLD_TEXT);
    const res = await createPrefabFromEntity(7, PATH, 'Create Prefab "Thing"', async () => true);
    if (!res || res === 'declined' || 'refused' in res) throw new Error(String(res));
    const content = onDisk.get(PATH);
    mockFetch.mockClear();
    await res.action.undo();
    expect(onDisk.get(PATH)).toBe(content);
    expect(mockFetch.mock.calls.some(([u]) => /\/api\/(delete-asset|write-file)/.test(String(u)))).toBe(false);
    expect(restoreSpy).toHaveBeenLastCalledWith([{ source: OLD_ID, doc: expect.objectContaining({ name: 'old thing' }), from: expect.objectContaining({ id: OLD_ID }) }]);
    expect(untagSpy).toHaveBeenCalledTimes(1);
  });

  it('a replace that would nest the prefab inside itself is refused, and the old file survives', async () => {
    // The draft carries a reference row to 'g-child'. Replacing the prefab whose id IS 'g-child'
    // with it would make that prefab contain itself. A Replace serializes WITH the kept id (#1686), so the serializer's
    // own guard refuses it — the id taken from the replaced bytes themselves.
    const childText = `{"id":"g-child","name":"child","entities":[]}\n`;
    onDisk.set(PATH, childText);
    const err = spyError();
    const res = await createPrefabFromEntity(7, PATH, 'Create Prefab "Thing"', async () => true);
    // Said, not a bare null (#1776 close-out review): both panels only logged a null, so the human saw nothing happen.
    expect(res).toMatchObject({ refused: expect.stringMatching(/cannot contain itself/) });
    expect(written).toEqual([]);
    expect(onDisk.get(PATH)).toBe(childText);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/inside itself/);
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
    // #1461: the members' original guids go back BEFORE the links do — the snapshot addresses them by
    // the guids they held before the tag. Mutation: move `unstamp()` after the reattach in assetOps.
    expect(calls).toEqual(['unstamp', 'untag', 'reattach']);
    expect(unstampSpy).toHaveBeenCalledWith(new Map([['g-old', 'g-derived']]));
    expect(reattachSpy).toHaveBeenCalledWith(PRIOR_LINKS, { rootEcsId: 7 });
  });

  it('undo of a REPLACE untags, then restores the prior links', async () => {
    onDisk.set('/p/thing.prefab.json', `{"id":"${OLD_ID}","entities":[]}\n`);
    const res = await createPrefabFromEntity(7, '/p/thing.prefab.json', 'Create Prefab "Thing"', async () => true);
    if (!res || res === 'declined' || 'refused' in res) throw new Error(String(res));
    calls.length = 0;
    await res.action.undo();
    expect(calls).toEqual(['unstamp', 'untag', 'reattach']);
    expect(reattachSpy).toHaveBeenCalledWith(PRIOR_LINKS, { rootEcsId: 7 });
  });

  it('redo after a successful undo of a REPLACE re-snapshots too', async () => {
    // The replaced document has no rows, so the undo has to RAISE its localId high-water mark into the restored bytes
    // (#1774) — and the redo, conditional on the bytes it recorded before that, must still land. Mutation: compare
    // `version` in `sameDocument` — the redo is refused as "changed on disk since".
    onDisk.set('/p/thing.prefab.json', `{"id":"${OLD_ID}","entities":[]}\n`);
    const res = await createPrefabFromEntity(7, '/p/thing.prefab.json', 'Create Prefab "Thing"', async () => true);
    if (!res || res === 'declined' || 'refused' in res) throw new Error(String(res));
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

// #1264 close-out's "a FAILED undo then redo" case went with #1868: a Replace's undo restores in memory and cannot fail
// after its refusal (which throws before the tree is touched), so the undo manager never moves a half-run undo to redo.

describe('createPrefabFromEntity — the runtime-exclusion count reaches the caller', () => {
  it('carries what serializePrefab reported, so the panel can surface it', async () => {
    runtimeExcludedFixture = 3;
    const res = await createPrefabFromEntity(7, '/p/thing.prefab.json', 'Create Prefab "Thing"', async () => true);
    expect(res && res !== 'declined' && !('refused' in res) ? res.runtimeExcluded : null).toBe(3);
  });

  it('reports 0 when the selection lost nothing', async () => {
    const res = await createPrefabFromEntity(7, '/p/thing.prefab.json', 'Create Prefab "Thing"', async () => true);
    expect(res && res !== 'declined' && !('refused' in res) ? res.runtimeExcluded : null).toBe(0);
  });
});

/** #1679 — the .prefab.json is global and this entry outlives a later save of it (double-click the new prefab, edit,
 *  Cmd+S, Back, Cmd+Z), so every half changes the file only while it holds what the other half left there, over the
 *  bytes the fake stored. Mutations, each checked red on its own case: in `replaceFileIfMatch`, drop the trash's
 *  `ifMatch` (create case), the overwrite's `ifMatch` (replace case) and the create's `createOnly` (redo case); at the
 *  site, expect an empty path in the replace redo (accept case) and ignore an undo that did NOT apply (failed-undo case). */
describe('createPrefabFromEntity — undo/redo preconditions (#1679)', () => {
  const P = '/p/thing.prefab.json';

  // #1795: a create's undo no longer touches the file, so a save since is simply kept — the undo unlinks the tree, and
  // it is the REDO that refuses to re-link to a document the file no longer holds (below).
  it('undo of a CREATE leaves a prefab saved since as it is, and unlinks', async () => {
    const action = await makeAction();
    onDisk.set(P, '{"id":"g-new","edited":true}\n');
    untagSpy.mockClear();
    await action.undo();
    expect(onDisk.get(P)).toContain('edited');
    expect(untagSpy).toHaveBeenCalledTimes(1);
    await expect(action.redo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(onDisk.get(P)).toContain('edited');
  });

  // A Replace's undo refusing over a prefab saved since is the in-memory restore's own refusal (#1868,
  // `prefabRestoreRefusal`), driven unmocked in tests/editor/prefabCommit.test.ts.

  it('redo of a CREATE refuses a prefab made at the path since', async () => {
    const action = await makeAction();
    await action.undo();
    onDisk.set(P, '{"id":"someone-else"}\n');
    await expect(action.redo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(onDisk.get(P)).toBe('{"id":"someone-else"}\n');
  });

  it('accept side: create and replace both round-trip undo → redo → undo over the bytes really there', async () => {
    const created = await makeAction();
    const after = onDisk.get(P);
    await created.undo(); expect(onDisk.get(P)).toBe(after); // #1795: the file stays
    await created.redo(); expect(onDisk.get(P)).toBe(after);
    await created.undo(); expect(onDisk.get(P)).toBe(after);
    onDisk.delete(P);

    onDisk.set(P, '{"id":"g-old","before":true,"entities":[{"localId":1}]}\n');
    const replaced = await makeAction();
    const applied = onDisk.get(P);
    const old = expect.objectContaining({ id: 'g-old', before: true });
    const made = expect.not.objectContaining({ before: true });
    // #1868: a Replace's halves restore in memory — each from the side the other left — and the file never moves.
    await replaced.undo(); expect(restoreSpy).toHaveBeenLastCalledWith([{ source: 'g-old', doc: old, from: made }]);
    await replaced.redo(); expect(restoreSpy).toHaveBeenLastCalledWith([{ source: 'g-old', doc: made, from: old }]);
    await replaced.undo(); expect(restoreSpy).toHaveBeenLastCalledWith([{ source: 'g-old', doc: old, from: made }]);
    expect(onDisk.get(P)).toBe(applied);
  });

  // #1795's second route (I19): the tagged tree is asked for BEFORE anything changes. Mutation: drop the
  // `ref.require(tagCheck)` from the create branch of the undo — it untags a tree `require` refuses.
  it('an undo whose tree `require` refuses leaves the file on disk and asks the route for nothing; the redo refuses before it writes', async () => {
    const action = await makeAction();
    const bytes = onDisk.get(P);
    mockFetch.mockClear();
    refState.refused = true;
    await expect(action.undo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(onDisk.get(P)).toBe(bytes);
    expect(mockFetch).not.toHaveBeenCalled();
    await expect(action.redo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // The Replace's "which bytes the FILE holds" flag and its failed-undo redo case went with #1868: a Replace's undo and
  // redo write nothing, so there is no file state for a half-run step to leave behind.
});
