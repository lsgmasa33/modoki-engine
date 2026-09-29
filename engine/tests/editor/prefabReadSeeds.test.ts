/** #1752 — a read-side seed of the prefab caches must not put the pre-write document back over a commit — and #1753 F4,
 *  the agent `prefab create` tagging by the path the file LANDED on.
 *
 *  Driven through the real placement flow (`placePrefabFromPath`, the one every human instantiate gesture goes through),
 *  the real undo manager, the real agent ops, `openPrefabForEditing` and `commitPrefabWrite`. Only the write route is a
 *  fake: it honours `ifMatch`/`createOnly` as `/api/write-file` does and, like the route on a case-insensitive disk, a
 *  write asked in another case lands on the file that is there and answers with ITS spelling.
 *
 *  W is a prefab that nests X, so placing W awaits X's cold read — the window #1752 observed. Mutations, each checked:
 *  - `instantiatePrefabAsync` no longer asks the token (`if (readAt && !readAt())` removed) → every refusal case below
 *    goes red: the instance is spawned from W v1 and the editor cache holds v1 over the commit's v2.
 *  - `placePrefabFromPath` captures the token AFTER its fetch → the "write during the placement's own fetch" case.
 *  - the redo's `StalePrefabRead` → `UndoRefusedError` mapping removed → the redo case (a plain throw is still dropped,
 *    but reported as a failure that may have half-applied, and the world is marked dirty).
 *  - the edit-open's first token check removed → its first case; the check at the swap removed → its second; its
 *    `stillNewest()` before the seed removed → the superseded case.
 *  - the agent create tags by the request path again → the #1753 F4 case.
 *  Added by the close-out review, each with its own mutation:
 *  - the redo's token captured after its fetch → the redo own-fetch case;
 *  - the token re-resolving its guid at every check (keyed `getGuidForPath(source) ?? source` again) → the trash-and-prune
 *    case: the prune drops the guid, its revision reads 0, and 0 was what was captured;
 *  - the agent `instantiate` keyed by the typed spelling again (no `existingAssetPath`) → its two case-variant cases;
 *    the agent `create` → the typed-spelling cache-key case.
 *  And by its re-review:
 *  - an await put back between the check and the prime (`spawnPrefabInstance` → `await instantiatePrefabAsync`) → the
 *    queued-seat case;
 *  - `getPrefabSource` no longer asking its token, or a guid re-resolved at every check (`readKey` returning it as it is)
 *    → the cold `getPrefabSource(guid)` case — the second only since a read stopped registering its guid before the check;
 *  - the watcher's refresh no longer noting the file change → the watcher case; noting it AFTER the refresh → the
 *    held-refresh case; the plain refresh noting it too (the leave-edit repair) → the no-false-refusal case;
 *  - `fetchPrefabSource` registering every read again → the cold-guid case's manifest assertion; no read registering at
 *    all (both `registerRead` calls gone) → the two accept-side registration cases;
 *  - the watcher installed with the plain refresh (`setPrefabSourceRefresher(refreshPrefabSourceForPath)`) → the wiring case;
 *  - the agent `edit-open` keyed by the typed spelling → its case-variant case. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

/** The fake route's disk: path → the exact text it holds. Looked up ignoring case, as on a case-insensitive disk. */
const route = vi.hoisted(() => ({ disk: new Map<string, string>() }));
const sha = (t: string) => createHash('sha256').update(t.replace(/^\uFEFF/, '')).digest('hex');
const answer = (status: number, body: object) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
const onDisk = (path: string) => [...route.disk.keys()].find((k) => k.toLowerCase() === path.toLowerCase());
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (asked: string, content: string, _enc?: string, opts?: { ifMatch?: string; createOnly?: boolean }) => {
    const path = onDisk(asked) ?? asked;
    const cur = route.disk.get(path);
    if (opts?.ifMatch !== undefined && (cur === undefined || sha(cur) !== opts.ifMatch)) return answer(409, { reason: 'if-match' });
    if (opts?.createOnly && cur !== undefined) return answer(409, { reason: 'if-none-match', existingPath: path });
    route.disk.set(path, content);
    return answer(200, { ok: true, path });
  },
}));

/** What `registerEditorAgentOps` installs as the watcher's prefab refresher — the production wiring of the note. */
const installed = vi.hoisted(() => ({ refresher: null as unknown }));
vi.mock('../../app/debug/agentBridge', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../app/debug/agentBridge')>();
  return {
    ...real,
    setPrefabSourceRefresher: (fn: Parameters<typeof real.setPrefabSourceRefresher>[0]) => { installed.refresher = fn; real.setPrefabSourceRefresher(fn); },
  };
});

/** A GET the test holds open, resolved by `release` with whatever the file held when it was asked. */
let heldRead: { release: () => void } | null = null;
let holdNextReadOf: string | null = null;
async function serve(url: string, init?: { body?: string }): Promise<Response> {
  if (url.includes('/api/delete-asset')) { // `/api/delete-asset`'s own precondition, as the route applies it
    const b = JSON.parse(init?.body ?? '{}') as { paths: string[]; ifMatch?: Record<string, string> };
    const conflicts = Object.entries(b.ifMatch ?? {}).filter(([p, h]) => !route.disk.has(p) || sha(route.disk.get(p)!) !== h).map(([p]) => p);
    if (conflicts.length) return answer(409, { ok: false, reason: 'if-match', conflicts });
    for (const p of b.paths) route.disk.delete(p);
    return answer(200, { ok: true, trashed: b.paths.length, missing: [], failed: [] });
  }
  if (url.includes('/api/exists')) {
    const asked = onDisk(decodeURIComponent(url.split('path=')[1] ?? ''));
    return answer(200, asked ? { exists: true, path: asked } : { exists: false });
  }
  const hit = [...route.disk.keys()].find((p) => url.toLowerCase().endsWith(p.toLowerCase()));
  if (!hit) return url.includes('/api/') ? answer(200, { files: [] }) : answer(404, {});
  const text = route.disk.get(hit)!;
  if (holdNextReadOf && url.endsWith(holdNextReadOf)) {
    holdNextReadOf = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    heldRead = { release };
    await gate;
  }
  return new Response(text, { status: 200 });
}

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, registerAsset, unregisterAsset, resolveRef, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction, clearHistory, createEntityWithUndo } from '@modoki/engine/editor';
import {
  setPrefabCache, getCachedPrefabSync, getPrefabSource, instantiatePrefabInstance, refreshPrefabSourceForPath,
  refreshPrefabSourceAfterDiskChange, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { openPrefabForEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { commitPrefabWrite, seatCaches } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { _resetSceneAdoptionForTests, beginWorldRequest } from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { getPrefabRevision, invalidatePrefab } from '../../packages/modoki/src/runtime/loaders/meshTemplateCache';
import { getGuidForPath } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { jsonFileBody } from '../../packages/modoki/src/editor/backend/editorBackend';
import { undo, redo, canUndo, canRedo, undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { runAgentOp } from '../../app/debug/agentBridge';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';

registerAllTraits();
setActionCallback(pushAction);
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
registerEditorAgentOps();

const X = 'cccccccc-0000-4000-8000-000000001752';
const X_PATH = '/assets/prefabs/X.prefab.json';
const W = 'cccccccc-0000-4000-8000-000000001753';
const W_PATH = '/assets/prefabs/W.prefab.json';
const SRC = 'dddddddd-0000-4000-8000-000000001752';
const g = (n: number) => `eeeeeeee-0000-4000-8000-00000000175${n}`;

const row = (localId: number, name: string, parentId: number, nodeGuid: string, extra: object = {}) => ({
  localId, name, nodeGuid, ...extra, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** X = XR → XA. */
const xDoc = (): PrefabFile => ({ id: X, version: 6, name: 'X', rootLocalId: 1, entities: [row(1, 'XR', 0, g(1)), row(2, 'XA', 1, g(2))] } as unknown as PrefabFile);
/** W = WR → N, an instance of X. */
const wDoc = (): PrefabFile => ({ id: W, version: 6, name: 'W', rootLocalId: 1, entities: [
  row(1, 'WR', 0, g(3)), row(2, 'N', 1, g(4), { prefab: X }),
] } as unknown as PrefabFile);
/** W with one more member, WD — the write that lands during a read. */
const wNext = (): PrefabFile => { const d = wDoc(); d.entities.push(row(3, 'WD', 1, g(5)) as never); return d; };
/** One plain entity, SRC — what the agent `create` makes a prefab from. */
const plainScene = (): SceneData => ({
  id: 's1752', version: 16, name: 'S', resources: [],
  entities: [{ id: 1, traits: { EntityAttributes: { name: 'Src', parentId: 0, guid: SRC }, Transform: { x: 1, y: 0, z: 0 } } }],
} as unknown as SceneData);

async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id: number) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, _g, _f, nestedStructure) =>
      instantiatePrefabIntoWorld(getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure) ?? undefined,
  });
}

const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};
const named = (name: string) => getAllEntities().filter((e) => e.name === name);
const cachedHasWD = () => getCachedPrefabSync(W)?.entities.some((e) => e.name === 'WD') ?? false;
/** Hold the next read of `path`, and resolve once something has asked for it. */
const holdReadOf = async (path: string, start: () => unknown) => {
  holdNextReadOf = path;
  const pending = start();
  await vi.waitFor(() => expect(heldRead, `precondition: ${path} was read`).not.toBeNull());
  return { pending }; // boxed: returned bare, an async function would wait for the held read
};
/** Commit W v2 over v1 — the write that lands inside a read. */
const writeW = async () => expect((await quietly(() => commitPrefabWrite(W, wNext(), { expected: wDoc() }))).ok, 'precondition: the write landed').toBe(true);

beforeEach(async () => {
  setRunMode('stopped');
  clearHistory();
  _resetSceneAdoptionForTests();
  route.disk.clear();
  heldRead = null;
  holdNextReadOf = null;
  prefabs.clear();
  vi.stubGlobal('fetch', serve);
  for (const [id, path, doc] of [[X, X_PATH, xDoc()], [W, W_PATH, wDoc()]] as const) {
    registerAsset(id, path, 'prefab');
    route.disk.set(path, jsonFileBody(doc));
    prefabs.set(id, doc);
    for (const key of [id, path]) setPrefabCache(key, null);
  }
  useEditorStore.setState({ toast: null } as never);
  await quietly(() => load(plainScene()));
});
afterAll(() => { for (const k of [X, X_PATH, W, W_PATH]) setPrefabCache(k, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

describe('a placement whose prefab is written while it is read is refused (#1752)', () => {
  it('accept side: nothing written meanwhile — placed, undoable, and the cache holds what was placed', async () => {
    const id = await quietly(() => placePrefabFromPath(W_PATH, { tag: 'T' }));
    expect(id).toBeTruthy();
    expect(named('WR')).toHaveLength(1);
    expect(canUndo()).toBe(true);
    expect(getCachedPrefabSync(W)?.entities.map((e) => e.name)).toEqual(['WR', 'N']);
  });

  it('a write landing during the nested preload: nothing spawned, the cache keeps the written document, a toast says why', async () => {
    const { pending } = await holdReadOf(X_PATH, () => quietly(() => placePrefabFromPath(W_PATH, { tag: 'T' })));
    await writeW();
    heldRead!.release();
    expect(await pending).toBeNull();
    expect(named('WR')).toEqual([]);
    expect(cachedHasWD(), 'the pre-write document was not put back').toBe(true);
    expect(canUndo(), 'no step for a placement that did not happen').toBe(false);
    expect(useEditorStore.getState().toast?.message).toMatch(/"W" was changed on disk while it was being placed/);
  });

  it("a write landing during the placement's OWN fetch is inside the read too", async () => {
    const { pending } = await holdReadOf(W_PATH, () => quietly(() => placePrefabFromPath(W_PATH, { tag: 'T' })));
    await writeW();
    heldRead!.release(); // …answering with the bytes from before the write
    expect(await pending).toBeNull();
    expect(named('WR')).toEqual([]);
    expect(cachedHasWD()).toBe(true);
  });

  it('a refused REDO drops its step with a notice, and the next undo undoes the step before it', async () => {
    createEntityWithUndo('Add', 0, [{ name: 'Transform', data: {} }, { name: 'EntityAttributes', data: { name: 'Before', parentId: 0 } }], () => {});
    expect(await quietly(() => placePrefabFromPath(W_PATH, { tag: 'T' }))).toBeTruthy();
    await quietly(() => undo()); // the placement
    expect(named('WR')).toEqual([]);
    setPrefabCache(X, null); // cold again, so the redo's placement awaits X's read
    const { pending } = await holdReadOf(X_PATH, () => quietly(() => redo()));
    await writeW();
    heldRead!.release();
    await pending;
    expect(named('WR'), 'the redo spawned nothing').toEqual([]);
    expect(canRedo(), 'the refused step is dropped, not left to replay').toBe(false);
    expect(useEditorStore.getState().toast?.message).toMatch(/^Redo of "Instantiate "W"" refused: "W" was changed on disk/);
    expect(cachedHasWD()).toBe(true);
    expect(named('Before')).toHaveLength(1);
    expect(await quietly(() => undo()), 'the step below is still there').toBe(true);
    expect(named('Before'), 'and it is the one undone').toEqual([]);
  });

  it("a refused redo's OWN fetch is inside the read too", async () => {
    expect(await quietly(() => placePrefabFromPath(W_PATH, { tag: 'T' }))).toBeTruthy();
    await quietly(() => undo());
    const { pending } = await holdReadOf(W_PATH, () => quietly(() => redo()));
    await writeW();
    heldRead!.release(); // …with the bytes from before the write
    await pending;
    expect(named('WR')).toEqual([]);
    expect(canRedo()).toBe(false);
    expect(cachedHasWD()).toBe(true);
  });

  it('a TRASH whose manifest prune lands before the check is seen too — the capture resolved its key once', async () => {
    // A prefab nothing has written or evicted this session, so its revision is 0 when the capture takes it — the case
    // the flip needs (every other prefab here is evicted by `beforeEach`, which bumps it).
    const V = 'cccccccc-0000-4000-8000-00000000e752';
    const V_PATH = '/assets/prefabs/V.prefab.json';
    const vDoc = { ...wDoc(), id: V, name: 'V' } as PrefabFile;
    registerAsset(V, V_PATH, 'prefab');
    route.disk.set(V_PATH, jsonFileBody(vDoc));
    prefabs.set(V, vDoc);
    expect(getPrefabRevision(V), 'precondition: never bumped').toBe(0);
    const { pending } = await holdReadOf(X_PATH, () => quietly(() => placePrefabFromPath(V_PATH, { tag: 'T' })));
    expect((await quietly(() => commitPrefabWrite(V, null, { expected: jsonFileBody(vDoc) }))).ok, 'precondition: the trash landed').toBe(true);
    unregisterAsset(V); // the manifest broadcast's prune (`assetManifest.ts`): the guid resolves to nothing now
    heldRead!.release();
    expect(await pending).toBeNull();
    expect(named('WR'), 'the trashed prefab is not placed').toEqual([]);
    expect(canUndo()).toBe(false);
  });

  it('the agent `prefab instantiate` by a path typed in another case: the write is seen, and nothing is spawned', async () => {
    const { pending } = await holdReadOf(X_PATH, () => quietly(() =>
      runAgentOp('prefab', { prefabAction: 'instantiate', path: W_PATH.toLowerCase() }).catch((e: Error) => ({ ok: false, error: e.message }))));
    await writeW();
    heldRead!.release();
    const r = await pending as { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/"W" was changed on disk/);
    expect(named('WR')).toEqual([]);
  });

  it('the agent `prefab instantiate` by a path typed in another case, nothing written: tagged by the guid, not the typed path', async () => {
    const r = await quietly(() => runAgentOp('prefab', { prefabAction: 'instantiate', path: W_PATH.toLowerCase() })) as { ok?: boolean; rootId?: number };
    expect(r.ok).toBe(true);
    const pi = getTraitByName('PrefabInstance')!;
    expect((readTraitData(r.rootId!, pi) as { source?: string } | null)?.source).toBe(W);
  });

  it('the agent `prefab instantiate`: REFUSED_BY_OP with the reason, nothing spawned', async () => {
    const { pending } = await holdReadOf(X_PATH, () => quietly(() =>
      runAgentOp('prefab', { prefabAction: 'instantiate', path: W_PATH }).catch((e: Error & { code?: string }) => ({ ok: false, error: e.message, code: e.code }))));
    await writeW();
    heldRead!.release();
    const r = await pending as { ok?: boolean; error?: string; code?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/prefab instantiate refused: "W" was changed on disk/);
    expect(named('WR')).toEqual([]);
    expect(cachedHasWD()).toBe(true);
  });

  it('the agent `prefab instantiate`, accept side: placed', async () => {
    const r = await quietly(() => runAgentOp('prefab', { prefabAction: 'instantiate', path: W_PATH })) as { ok?: boolean };
    expect(r.ok).toBe(true);
    expect(named('WR')).toHaveLength(1);
  });
});

describe('what the token must see besides a write (#1752 close-out re-review)', () => {
  it('a commit whose cache seat is already queued at the check cannot be put back: check → spawn → prime is synchronous', async () => {
    setPrefabCache(X, xDoc()); // warm, so the preload has nothing to hold
    const id = await quietly(() => instantiatePrefabInstance(wDoc(), W_PATH, 0, () => {
      // The check passes, and a commit's seat is queued behind it — the gap an await after the check would open.
      queueMicrotask(() => seatCaches(W_PATH, W, W, wNext()));
      return true;
    }));
    expect(id).toBeTruthy();
    await Promise.resolve();
    expect(cachedHasWD(), "the placement's prime ran before the queued seat, not over it").toBe(true);
  });

  it('a cold getPrefabSource(guid) over a trash and its prune: the trashed document is not seated', async () => {
    const U = 'cccccccc-0000-4000-8000-00000000d752';
    const U_PATH = '/assets/prefabs/U.prefab.json';
    const uDoc = { ...xDoc(), id: U, name: 'U' } as PrefabFile;
    registerAsset(U, U_PATH, 'prefab');
    route.disk.set(U_PATH, jsonFileBody(uDoc));
    expect(getPrefabRevision(U), 'precondition: never bumped').toBe(0);
    const { pending } = await holdReadOf(U_PATH, () => getPrefabSource(U));
    expect((await quietly(() => commitPrefabWrite(U, null, { expected: jsonFileBody(uDoc) }))).ok, 'precondition: the trash landed').toBe(true);
    unregisterAsset(U);
    heldRead!.release();
    await pending;
    expect(getCachedPrefabSync(U)).toBeNull();
    expect(resolveRef(U), 'the stale read did not put the trashed guid back in the manifest').toBeUndefined();
  });

  it('the watcher reseats the editor cache before its late runtime eviction: a placement in between is refused', async () => {
    setPrefabCache(W, wDoc()); // the editor holds W, so the watcher's refresh re-reads it
    const { pending } = await holdReadOf(X_PATH, () => quietly(() => placePrefabFromPath(W_PATH, { tag: 'T' })));
    route.disk.set(W_PATH, jsonFileBody(wNext())); // an outside write
    await quietly(() => refreshPrefabSourceAfterDiskChange(W_PATH)); // the reload branch's refresh…
    expect(cachedHasWD(), 'precondition: the refresh seated the new bytes').toBe(true);
    heldRead!.release(); // …a placement resumes before…
    const placed = await pending;
    invalidatePrefab(W_PATH); // …the runtime eviction, which the reload runs last
    expect(placed).toBeNull();
    expect(cachedHasWD(), 'the new bytes were not overwritten').toBe(true);
  });

  it("the note comes BEFORE the refresh's own fetch: a placement resuming inside it is refused, and the refresh lands", async () => {
    setPrefabCache(W, wDoc());
    const { pending: placing } = await holdReadOf(X_PATH, () => quietly(() => placePrefabFromPath(W_PATH, { tag: 'T' })));
    const placement = heldRead!;
    heldRead = null;
    route.disk.set(W_PATH, jsonFileBody(wNext())); // an outside write
    const { pending: refreshing } = await holdReadOf(W_PATH, () => quietly(() => refreshPrefabSourceAfterDiskChange(W_PATH)));
    placement.release(); // the placement resumes while the refresh fetches
    expect(await placing).toBeNull();
    heldRead!.release();
    await refreshing;
    expect(cachedHasWD(), 'the refresh seated the new bytes — nothing primed the old ones over its key').toBe(true);
  });

  it("the watcher's refresher, as the editor installs it, is the one that raises the note", () => {
    expect(installed.refresher).toBe(refreshPrefabSourceAfterDiskChange);
  });

  it('an ACCEPTED path read names its file in the manifest — a prefab the manifest does not know yet gets its guid', async () => {
    const K = 'cccccccc-0000-4000-8000-00000000c752';
    const K_PATH = '/assets/prefabs/K.prefab.json';
    route.disk.set(K_PATH, jsonFileBody({ ...xDoc(), id: K, name: 'K' } as PrefabFile));
    expect(getGuidForPath(K_PATH), 'precondition: unregistered').toBeUndefined();
    expect(await quietly(() => getPrefabSource(K_PATH))).not.toBeNull();
    expect(getGuidForPath(K_PATH)).toBe(K);
  });

  it("the refresh's seat names its file in the manifest too", async () => {
    const J = 'cccccccc-0000-4000-8000-00000000b752';
    const J_PATH = '/assets/prefabs/J.prefab.json';
    setPrefabCache(J_PATH, { ...xDoc(), id: J, name: 'J' } as PrefabFile); // cached by path, the manifest unaware
    unregisterAsset(J);
    route.disk.set(J_PATH, jsonFileBody({ ...xDoc(), id: J, name: 'J' } as PrefabFile));
    await quietly(() => refreshPrefabSourceForPath(J_PATH));
    expect(getGuidForPath(J_PATH)).toBe(J);
  });

  it('a refresh of an UNCHANGED file (the leave-edit repair) refuses nothing', async () => {
    setPrefabCache(W, wDoc());
    const { pending } = await holdReadOf(X_PATH, () => quietly(() => placePrefabFromPath(W_PATH, { tag: 'T' })));
    await quietly(() => refreshPrefabSourceForPath(W_PATH)); // `settleLeaveDebts`: the file did not change
    heldRead!.release();
    expect(await pending, 'placed').toBeTruthy();
  });

  it('the agent `prefab edit-open` by a path typed in another case: a write during its fetch refuses it', async () => {
    const { pending } = await holdReadOf(W_PATH, () => quietly(() =>
      // `discardUnsaved`: the cases before this one leave the world dirty, and the op would refuse before it fetched.
      runAgentOp('prefab', { prefabAction: 'edit-open', path: W_PATH.toLowerCase(), discardUnsaved: true }).catch((e: Error) => ({ ok: false, error: e.message }))));
    await writeW();
    heldRead!.release();
    const r = await pending as { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/"W" was saved while it was opening/);
    expect(cachedHasWD()).toBe(true);
  });
});

describe("the prefab edit-open's seed (#1752)", () => {
  it('a write landing during its fetch: refused, and the cache keeps the written document', async () => {
    const { pending } = await holdReadOf(W_PATH, () => quietly(() => openPrefabForEditing({ path: W_PATH, name: 'W' })));
    await writeW();
    heldRead!.release();
    expect(await pending).toEqual({ refused: expect.stringMatching(/"W" was saved while it was opening/) });
    expect(cachedHasWD()).toBe(true);
    expect(named('Src'), 'the world was not swapped').toHaveLength(1);
  });

  it('a request superseded during its fetch seeds nothing — no cache entry, no runtime revision bump', async () => {
    const before = getPrefabRevision(W);
    const { pending } = await holdReadOf(W_PATH, () => quietly(() => openPrefabForEditing({ path: W_PATH, name: 'W' })));
    beginWorldRequest(); // a newer scene request, made while this one fetched
    heldRead!.release();
    expect(await pending).toBeUndefined();
    expect(getCachedPrefabSync(W), 'nothing seeded').toBeNull();
    expect(getPrefabRevision(W), 'no pool re-spawned for an open that never happened').toBe(before);
    expect(named('Src')).toHaveLength(1);
  });

  it("a write landing after its seed, while the human's discard dialog is open: refused at the swap", async () => {
    // Unsaved work in a world with no file, so the open asks before discarding it — and the write lands while it asks.
    createEntityWithUndo('Add', 0, [{ name: 'Transform', data: {} }, { name: 'EntityAttributes', data: { name: 'Dirt', parentId: 0 } }], () => {});
    let asked = false;
    const res = await quietly(() => openPrefabForEditing({ path: W_PATH, name: 'W' }, {
      confirmDiscard: async () => { asked = true; await writeW(); return true; },
    }));
    expect(asked, 'precondition: the dialog was reached, past the seed').toBe(true);
    expect(res).toEqual({ refused: expect.stringMatching(/"W" was saved while it was opening/) });
    expect(cachedHasWD()).toBe(true);
    expect(named('Src')).toHaveLength(1);
  });
});

describe('the agent `prefab create` tags by the path the file LANDED on (#1753 F4)', () => {
  it('a Replace asked in another case: the tag carries the guid, and the reply names the file that is there', async () => {
    const asked = X_PATH.toLowerCase();
    expect(asked, 'precondition: a different spelling').not.toBe(X_PATH);
    const r = await quietly(() => runAgentOp('prefab', { prefabAction: 'create', entityGuid: SRC, path: asked })) as { ok?: boolean; source?: string };
    expect(r.ok).toBe(true);
    expect(route.disk.has(asked), 'precondition: it landed on the existing file').toBe(false);
    expect(r.source, 'the spelling the route reported').toBe(X_PATH);
    const pi = getTraitByName('PrefabInstance')!;
    const src = getAllEntities().find((e) => e.name === 'Src')!;
    expect((readTraitData(src.id, pi) as { source?: string } | null)?.source, 'GUID-only: not a raw path the next load rejects').toBe(X);
  });

  it('a later write of the file is what an instantiate by the typed spelling places — no second cache entry holds the old one', async () => {
    const asked = X_PATH.toLowerCase();
    expect((await quietly(() => runAgentOp('prefab', { prefabAction: 'create', entityGuid: SRC, path: asked })) as { ok?: boolean }).ok).toBe(true);
    expect(getCachedPrefabSync(asked), 'no editor-cache entry under the typed spelling, which no later write would update').toBeNull();
    const written = route.disk.get(X_PATH)!;
    const doc = JSON.parse(written) as PrefabFile;
    const next = Math.max(...doc.entities.map((e) => e.localId)) + 1;
    doc.entities.push(row(next, 'XV2', doc.rootLocalId, g(9)) as never);
    expect((await quietly(() => commitPrefabWrite(X, doc, { expected: written }))).ok, 'precondition: v2 landed').toBe(true);
    const r = await quietly(() => runAgentOp('prefab', { prefabAction: 'instantiate', path: asked })) as { ok?: boolean; rootId?: number };
    expect(r.ok).toBe(true);
    const under = getAllEntities().filter((e) => e.parentId === r.rootId).map((e) => e.name);
    expect(under, 'the new instance is v2').toContain('XV2');
  });
});

/** #1868: an Assets Rename or delete is not undoable, so an Instantiate's redo can run after the file moved or went. */
describe('an Instantiate\'s redo after an Assets Rename or delete (#1868)', () => {
  const X2_PATH = '/assets/prefabs/X renamed.prefab.json';
  it('after a Rename it finds the prefab by its guid and places it again', async () => {
    // Mutation: `placedPrefabPath` returns the recorded path — the redo reads nothing there and places nothing.
    expect(await quietly(() => placePrefabFromPath(X_PATH, { tag: 'T' }))).toBeTruthy();
    expect(await quietly(() => undo())).toBe(true);
    route.disk.set(X2_PATH, route.disk.get(X_PATH)!); route.disk.delete(X_PATH);
    registerAsset(X, X2_PATH, 'prefab');
    expect(await quietly(() => redo())).toBe(true);
    expect(named('XR')).toHaveLength(1);
  });

  it('refuses when the name now holds ANOTHER prefab (the placed one deleted, another renamed onto it)', async () => {
    // Mutation: drop `if (other) throw other;` from the respawn — an instance of the OTHER prefab is placed.
    expect(await quietly(() => placePrefabFromPath(X_PATH, { tag: 'T' }))).toBeTruthy();
    expect(await quietly(() => undo())).toBe(true);
    const other = { ...xDoc(), id: 'cccccccc-0000-4000-8000-00000000f868', name: 'Other' } as PrefabFile;
    (other.entities as Array<{ name: string }>)[0].name = 'OR';
    route.disk.set(X_PATH, jsonFileBody(other));
    unregisterAsset(X); // the delete's pruned manifest: X's guid names nothing now
    const r = await quietly(() => undoStep('redo'));
    expect(r.refused ?? r.failed?.error ?? '').toMatch(/holds another prefab now|was deleted/);
    expect(named('OR')).toHaveLength(0);
    expect(named('XR')).toHaveLength(0);
  });
});
