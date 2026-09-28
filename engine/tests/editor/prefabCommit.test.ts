/** #1692 — a prefab write is ONE step (`commitPrefabWrite`, prefabCommit.ts): a conditional write, both caches under
 *  every key, and every live frame of the source rebuilt. Each absorbed bug has its case here, driven through the real
 *  loader, capture, save, Create Prefab and cache; only the route is a fake, holding exactly the bytes it received and
 *  applying `/api/write-file`'s and `/api/delete-asset`'s own preconditions (`ifMatch` over the BOM-stripped bytes,
 *  `ifNoneMatch:'*'`), and serving what it holds to a GET.
 *
 *  - #1685: Create Prefab → Replace left every OTHER live instance expanded from the old document, and the next save
 *    recorded the template's new members as removed from it — for good. Mutation: skip the rebase in
 *    `commitPrefabWrite` — the Replace case and its undo case go red.
 *  - The agent `create` sibling (#1685's comment): the writer seated the runtime cache alone, so the editor cache kept
 *    the old document under the guid. Mutation: seat only the ref the caller used — the every-key case goes red.
 *  - #1669: a cold `getPrefabSource` read that began before a write put the older bytes back. Mutation: drop the
 *    revision-token check — the trash case goes red; drop it AND the filled-key check — the write case goes red.
 *  - A write that does not land changes nothing. Mutation: seat the caches before the write — that case goes red.
 *  - A write of the prefab OPEN in prefab edit (close-out review): the commit skipped that key's cache entry, and its
 *    rebase then rebuilt the instances an Apply had just refreshed back onto the OLD document. Mutation: skip the editing
 *    key in `seatCaches` again — that case goes red.
 *  - Serialized against the adoption owner (#1698, #1667): a write does not start while an editor route is between its
 *    world call and its adopt, and rebuilds nothing when one began during it. Mutations: drop the `adoptionsSettled` wait
 *    — the first case goes red; judge "world left" by identity alone — the second.
 *  - Several files as ONE step (#1693's Apply writes an inner prefab and its enclosing one): every precondition before
 *    any write, one rebuild, and a mid-way miss put back. Mutations: drop the pre-check — the refused case goes red (it
 *    writes the first file); drop the rollback — the race case goes red.
 *  - The hold cannot deadlock (#1667, the hub's condition): nothing a write's rebuild reaches — Apply's refresh, Create
 *    Prefab's tag, the rebase, an undo's rebuild — starts a world switch, which would wait for the hold that waits for
 *    it. Mutation: start one from `commitPrefabWrite`'s rebuild step — that case goes red (and, un-counted, hangs). */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

/** The fake route's disk: path → the exact text it holds. */
const route = vi.hoisted(() => ({ disk: new Map<string, string>(), failWrites: false, gate: null as Promise<void> | null, waiting: 0, posts: [] as string[], beforeWrite: null as null | ((path: string) => void) }));
const sha = (t: string) => createHash('sha256').update(t.replace(/^\uFEFF/, '')).digest('hex');
const answer = (status: number, body: object) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string, _enc?: string, opts?: { ifMatch?: string; createOnly?: boolean }) => {
    if (route.gate) { route.waiting++; await route.gate; route.waiting--; }
    route.posts.push(path);
    if (route.beforeWrite) route.beforeWrite(path);
    if (route.failWrites) return answer(500, { error: 'the disk is full' });
    const cur = route.disk.get(path);
    if (opts?.ifMatch !== undefined && (cur === undefined || sha(cur) !== opts.ifMatch)) return answer(409, { reason: 'if-match' });
    if (opts?.createOnly && cur !== undefined) return answer(409, { reason: 'if-none-match', existingPath: path });
    route.disk.set(path, content);
    return answer(200, { ok: true, path });
  },
}));

/** World switches begun while a prefab write held the world (#1667): each would wait for the hold, which waits for it. */
const holds = vi.hoisted(() => ({ switchesWhileHeld: 0 }));
vi.mock('../../packages/modoki/src/editor/undo/undoManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../packages/modoki/src/editor/undo/undoManager')>();
  return {
    ...real,
    beginWorldSwitch: () => {
      if (real.worldBoundOperationsHeld() > 0) holds.switchesWhileHeld++;
      return real.beginWorldSwitch();
    },
  };
});

/** A GET the test holds open: resolved by `release`, with whatever the file held when it was asked. */
let heldRead: { url: string; release: () => void } | null = null;
let holdNextReadOf: string | null = null;
async function serve(url: string, init?: { body?: string; method?: string }): Promise<Response> {
  if (url.includes('/api/exists')) {
    const asked = decodeURIComponent(url.split('path=')[1] ?? '');
    return answer(200, route.disk.has(asked) ? { exists: true, path: asked } : { exists: false });
  }
  if (url.includes('/api/delete-asset')) {
    const b = JSON.parse(init?.body ?? '{}') as { paths: string[]; ifMatch?: Record<string, string> };
    const conflicts = Object.entries(b.ifMatch ?? {}).filter(([p, h]) => !route.disk.has(p) || sha(route.disk.get(p)!) !== h).map(([p]) => p);
    if (conflicts.length) return answer(409, { ok: false, reason: 'if-match', conflicts });
    for (const p of b.paths) route.disk.delete(p);
    return answer(200, { ok: true, trashed: b.paths.length, missing: [], failed: [] });
  }
  const hit = [...route.disk.keys()].find((p) => url.endsWith(p));
  if (!hit) return url.includes('/api/') ? answer(200, { files: [] }) : answer(404, {});
  const text = route.disk.get(hit)!;
  if (holdNextReadOf && url.endsWith(holdNextReadOf)) {
    holdNextReadOf = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    heldRead = { url, release };
    await gate;
  }
  return new Response(text, { status: 200 });
}

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, registerAsset, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction, clearHistory, deleteEntityWithUndo, createEntityWithUndo } from '@modoki/engine/editor';
import { setPrefabCache, getCachedPrefabSync, getPrefabSource, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { commitPrefabWrite, commitPrefabWrites } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { withAdoption, _resetSceneAdoptionForTests } from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { jsonFileBody } from '../../packages/modoki/src/editor/backend/editorBackend';
import { undo, worldBoundOperationsHeld } from '../../packages/modoki/src/editor/undo/undoManager';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { writeTraitFieldWithUndo } from '@modoki/engine/editor';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { readTraitData } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const X = 'cccccccc-0000-4000-8000-000000001692';
const X_PATH = '/assets/prefabs/X.prefab.json';
const HOLDER = 'dddddddd-0000-4000-8000-000000001690';
const I1 = 'dddddddd-0000-4000-8000-000000001691';
const I2 = 'dddddddd-0000-4000-8000-000000001692';
const g = (n: number) => `eeeeeeee-0000-4000-8000-00000000169${n}`;

const row = (localId: number, name: string, parentId: number, nodeGuid: string) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** X = XR → XA, XB, XC. */
const xDoc = (): PrefabFile => ({ id: X, version: 6, name: 'X', rootLocalId: 1, entities: [
  row(1, 'XR', 0, g(1)), row(2, 'XA', 1, g(2)), row(3, 'XB', 1, g(3)), row(4, 'XC', 1, g(4)),
] } as unknown as PrefabFile);
/** Holder → I1, I2: two instances of X. */
const twoInstances = (): SceneData => ({
  id: 's1692', version: 16, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
    { id: 2, prefab: X, guid: I1, traits: { EntityAttributes: { name: 'I1', parentId: HOLDER } } },
    { id: 3, prefab: X, guid: I2, traits: { EntityAttributes: { name: 'I2', parentId: HOLDER } } },
  ],
} as unknown as SceneData);

/** X on disk, in both caches and in the manifest — the state after an ordinary scene load. */
function install(doc: PrefabFile): void {
  route.disk.set(X_PATH, jsonFileBody(doc));
  prefabs.set(X, doc);
  setPrefabCache(X, JSON.parse(JSON.stringify(doc)) as PrefabFile);
}

async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id: number) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure) => {
      const id = instantiatePrefabIntoWorld(
        getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure,
      );
      if (id && rootGuid) {
        for (const e of getCurrentWorld().entities) {
          if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), guid: rootGuid });
        }
      }
      return id ?? undefined;
    },
  });
}

const rootOf = (guid: string) => getAllEntities().find((e) => e.guid === guid)!.id;
/** The names of the entities under the instance rooted at `guid`, in no particular order. */
const namesIn = (guid: string): string[] => {
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const root = rootOf(guid);
  return all.filter((e) => {
    for (let cur = byId.get(e.parentId); cur; cur = byId.get(cur.parentId)) if (cur.id === root) return true;
    return false;
  }).map((e) => e.name).sort();
};
const inInstance = (guid: string, name: string) => {
  const hits = getAllEntities().filter((e) => e.name === name && namesIn(guid).includes(name));
  const root = rootOf(guid);
  const byId = new Map(getAllEntities().map((e) => [e.id, e]));
  const mine = hits.filter((e) => { for (let c = byId.get(e.parentId); c; c = byId.get(c.parentId)) if (c.id === root) return true; return false; });
  if (mine.length !== 1) throw new Error(`fixture: ${mine.length} entities named ${name} in ${guid}`);
  return mine[0]!.id;
};
const entryOf = (scene: SceneData, guid: string) => (scene.entities as unknown as Array<Record<string, unknown>>).find((e) => e.guid === guid)!;
const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};

beforeEach(async () => {
  setRunMode('stopped');
  clearHistory();
  route.disk.clear();
  route.failWrites = false;
  route.gate = null;
  route.waiting = 0;
  route.posts = [];
  route.beforeWrite = null;
  _resetSceneAdoptionForTests(); // a route a failed case left pending must not hold the next case's write
  heldRead = null;
  holdNextReadOf = null;
  holds.switchesWhileHeld = 0;
  prefabs.clear();
  setPrefabCache(X_PATH, null);
  vi.stubGlobal('fetch', serve);
  registerAsset(X, X_PATH, 'prefab');
  install(xDoc());
  await quietly(() => load(twoInstances()));
});
afterAll(() => { setPrefabCache(X, null); setPrefabCache(X_PATH, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

/** On I2: delete XA, add New, New2 and New3 — a tree with MORE rows than X, which is what makes the stale capture of
 *  I1 read the gained rows as removals (#1685). Then Create Prefab on I2 → Replace X, keeping X's guid. */
async function replaceXFromI2(): Promise<void> {
  deleteEntityWithUndo(inInstance(I2, 'XA'));
  for (const name of ['New', 'New2', 'New3']) {
    // The parent is the spawned `EntityAttributes.parentId`; the argument only records it for redo.
    createEntityWithUndo('Add', rootOf(I2), [{ name: 'Transform', data: {} }, { name: 'EntityAttributes', data: { name, parentId: rootOf(I2) } }], () => {});
  }
  const res = await quietly(() => createPrefabFromEntity(rootOf(I2), X_PATH, 'Create Prefab "X"', async () => true));
  if (!res || res === 'declined' || 'refused' in res) throw new Error(`precondition: the Replace landed, got ${JSON.stringify(res)}`);
  pushAction(res.action);
  expect((JSON.parse(route.disk.get(X_PATH)!) as PrefabFile).id).toBe(X); // precondition: a Replace, the guid kept
}

describe('Create Prefab → Replace rebuilds every OTHER live instance (#1685)', () => {
  it('the other instance gains the new members, and its save records none of them as removed', async () => {
    await replaceXFromI2();
    expect(namesIn(I1)).toEqual(['New', 'New2', 'New3', 'XB', 'XC']);
    const saved = await quietly(() => serializeScene()) as unknown as SceneData;
    expect(JSON.stringify(entryOf(saved, I1))).not.toContain('"removed":true');
    // …and a reload from what is on disk keeps them, which the stored removals made permanent.
    prefabs.set(X, JSON.parse(route.disk.get(X_PATH)!));
    await quietly(() => load(saved));
    expect(namesIn(I1)).toEqual(['New', 'New2', 'New3', 'XB', 'XC']);
  });

  it("the Replace's undo brings the other instance back onto the restored document too", async () => {
    await replaceXFromI2();
    await quietly(() => undo()); // the Create Prefab entry (the edits above are their own entries)
    expect(route.disk.get(X_PATH)).toBe(jsonFileBody(xDoc())); // precondition: the replaced bytes are back
    expect(namesIn(I1)).toEqual(['XA', 'XB', 'XC']);
    const saved = await quietly(() => serializeScene()) as unknown as SceneData;
    expect(JSON.stringify(entryOf(saved, I1))).not.toContain('"removed":true');
  });
});

describe('one write, both caches, every key (#1692; the agent `create` sibling of #1685)', () => {
  it('the editor cache holds the written document under the guid AND the path, and the other instance is rebuilt', async () => {
    const next = xDoc();
    next.entities.push(row(5, 'XD', 1, g(5)) as never);
    // The agent `create` hands the PATH: before, only the runtime cache was seated, and only under that.
    const res = await quietly(() => commitPrefabWrite(X_PATH, next, { expected: xDoc() }));
    expect(res.ok).toBe(true);
    expect(getCachedPrefabSync(X)?.entities.some((e) => e.name === 'XD')).toBe(true);
    expect(getCachedPrefabSync(X_PATH)?.entities.some((e) => e.name === 'XD')).toBe(true);
    expect(namesIn(I1)).toEqual(['XA', 'XB', 'XC', 'XD']);
    expect(res.rebased).toBe(2);
  });

  it('a write that does not land changes nothing: no cache, no frame', async () => {
    const next = xDoc();
    next.entities.push(row(5, 'XD', 1, g(5)) as never);
    route.failWrites = true;
    const res = await quietly(() => commitPrefabWrite(X, next, { expected: xDoc() }));
    expect(res.ok).toBe(false);
    expect(getCachedPrefabSync(X)?.entities.some((e) => e.name === 'XD')).toBe(false);
    expect(namesIn(I1)).toEqual(['XA', 'XB', 'XC']);
  });

  it('a file changed since it was read is refused, and nothing moves', async () => {
    const other = xDoc();
    other.name = 'changed elsewhere';
    route.disk.set(X_PATH, jsonFileBody(other));
    const next = xDoc();
    next.entities.push(row(5, 'XD', 1, g(5)) as never);
    const res = await quietly(() => commitPrefabWrite(X, next, { expected: xDoc() }));
    expect(res).toMatchObject({ ok: false, conflict: true });
    expect(route.disk.get(X_PATH)).toBe(jsonFileBody(other));
    expect(namesIn(I1)).toEqual(['XA', 'XB', 'XC']);
  });

  it('the same document in other bytes (hand-formatted, a BOM) is not a conflict', async () => {
    route.disk.set(X_PATH, `\uFEFF${JSON.stringify(xDoc())}`); // one line, and a BOM: not what jsonFileBody writes
    const next = xDoc();
    next.entities.push(row(5, 'XD', 1, g(5)) as never);
    const res = await quietly(() => commitPrefabWrite(X, next, { expected: xDoc() }));
    expect(res.ok).toBe(true);
    expect(route.disk.get(X_PATH)).toBe(jsonFileBody(next));
  });
});

describe('a cold read cannot put older bytes back (#1669)', () => {
  /** The editor cache cold for X, and a `getPrefabSource(X)` held open with the bytes X had when it was asked. */
  const coldReadHeld = async () => {
    setPrefabCache(X, null);
    setPrefabCache(X_PATH, null);
    // The runtime cache is not read here; `setPrefabCache(null)` above bumped the token, so take it from now on.
    holdNextReadOf = X_PATH;
    const read = getPrefabSource(X);
    await vi.waitFor(() => expect(heldRead).not.toBeNull());
    return { read }; // boxed: an async function returning the promise itself would wait for the held read
  };

  it('a write landing during the read: the cache keeps the written document', async () => {
    const { read } = await coldReadHeld();
    const next = xDoc();
    next.entities.push(row(5, 'XD', 1, g(5)) as never);
    expect((await quietly(() => commitPrefabWrite(X, next, { expected: xDoc() }))).ok).toBe(true);
    heldRead!.release(); // …and the read answers with the bytes from before the write
    const got = await read;
    expect(got?.entities.some((e) => e.name === 'XD')).toBe(true);
    expect(getCachedPrefabSync(X)?.entities.some((e) => e.name === 'XD')).toBe(true);
  });

  it('a trash landing during the read: the old document is not seated again', async () => {
    const { read } = await coldReadHeld();
    expect((await quietly(() => commitPrefabWrite(X, null, { expected: jsonFileBody(xDoc()) }))).ok).toBe(true);
    heldRead!.release();
    await read;
    expect(getCachedPrefabSync(X)).toBeNull();
  });
});

describe('holding the world cannot deadlock (#1667)', () => {
  it('no rebuild a prefab write runs starts a world switch, and each run lands and lets go', async () => {
    // Create Prefab → Replace: the tag, then the rebase of the other instance.
    await replaceXFromI2();
    expect(worldBoundOperationsHeld()).toBe(0);
    // Apply: its refresh, the rebase, then the undo entry — all under the hold.
    writeTraitFieldWithUndo(inInstance(I1, 'XB'), getTraitByName('Transform')!, 'x', 4);
    const keys = collectInstanceOverrideKeys(rootOf(I1), getCachedPrefabSync(X)!);
    const applied = await quietly(() => applyToPrefabWithUndo(rootOf(I1), new Set(keys.fields)));
    expect(applied.applied, JSON.stringify(applied)).toBe(true); // precondition: the Apply wrote and refreshed
    expect(worldBoundOperationsHeld()).toBe(0);
    // …and an undo's rebuild: the Apply's world restore, the field edit, then the Replace's untag and rebase.
    for (let i = 0; i < 3; i++) await quietly(() => undo());
    expect(route.disk.get(X_PATH)).toBe(jsonFileBody(xDoc())); // precondition: the Replace's undo ran
    expect(worldBoundOperationsHeld()).toBe(0);
    expect(holds.switchesWhileHeld).toBe(0);
  });
});

describe('a write of the prefab open in prefab edit (#1692 close-out review)', () => {
  afterAll(() => { useEditorStore.setState({ editingPrefab: null } as never); });
  it('an Apply lands in the live instances too, not only in the file', async () => {
    useEditorStore.setState({ editingPrefab: { guid: X, path: X_PATH, name: 'X' } } as never);
    try {
      writeTraitFieldWithUndo(inInstance(I1, 'XB'), getTraitByName('Transform')!, 'x', 4);
      const keys = collectInstanceOverrideKeys(rootOf(I1), getCachedPrefabSync(X)!);
      const applied = await quietly(() => applyToPrefabWithUndo(rootOf(I1), new Set(keys.fields)));
      expect(applied.applied, JSON.stringify(applied)).toBe(true);
      const x = (guid: string) => (readTraitData(inInstance(guid, 'XB'), getTraitByName('Transform')!) as { x: number }).x;
      expect((JSON.parse(route.disk.get(X_PATH)!) as PrefabFile).entities.find((e) => e.name === 'XB')!.traits.Transform).toMatchObject({ x: 4 });
      expect(x(I1)).toBe(4);
      expect(x(I2)).toBe(4);
    } finally { useEditorStore.setState({ editingPrefab: null } as never); }
  });
});

describe('a prefab write is serialized against scene adoption (#1698, #1667)', () => {
  const next = () => { const d = xDoc(); d.entities.push(row(5, 'XD', 1, g(5)) as never); return d; };

  it('does not start while a route is adopting a world: it writes once that route has landed', async () => {
    let land!: () => void;
    const adopting = withAdoption('hot-reload', () => new Promise<void>((r) => { land = r; }));
    const committing = quietly(() => commitPrefabWrite(X, next(), { expected: xDoc() }));
    await new Promise((r) => setTimeout(r, 20));
    expect(route.disk.get(X_PATH)).toBe(jsonFileBody(xDoc())); // not yet
    land();
    await adopting;
    expect((await committing).ok).toBe(true);
    expect(namesIn(I1)).toEqual(['XA', 'XB', 'XC', 'XD']);
  });

  // Close-out review: the world was taken AFTER the wait, so a route that replaced it made the commit adopt the NEW world as
  // its own and run the caller's rebuild there, with ids from the old one. Mutation: take the world after the wait.
  it('a route that REPLACES the world while the write waits: refused, nothing written', async () => {
    let land!: () => void;
    const adopting = withAdoption('hot-reload', async () => {
      await new Promise<void>((r) => { land = r; });
      await quietly(() => load(twoInstances()));
    });
    let rebuilt = false;
    const committing = quietly(() => commitPrefabWrite(X, next(), { expected: xDoc(), rebuild: () => { rebuilt = true; } }));
    await new Promise((r) => setTimeout(r, 20));
    land();
    await adopting;
    const res = await committing;
    expect(res).toMatchObject({ ok: false, worldLeft: true });
    expect(route.posts).toEqual([]);
    expect(route.disk.get(X_PATH)).toBe(jsonFileBody(xDoc()));
    expect(rebuilt).toBe(false);
  });

  it('a route that starts adopting during the write: the caches take the document, the frames are left to it', async () => {
    let open!: () => void;
    route.gate = new Promise<void>((r) => { open = r; });
    const committing = quietly(() => commitPrefabWrite(X, next(), { expected: xDoc() }));
    await vi.waitFor(() => expect(route.waiting).toBe(1));
    let land!: () => void;
    const adopting = withAdoption('scene-load', () => new Promise<void>((r) => { land = r; }));
    route.gate = null;
    open();
    const res = await committing;
    land();
    await adopting;
    expect(res).toMatchObject({ ok: true, worldLeft: true });
    expect(getCachedPrefabSync(X)?.entities.some((e) => e.name === 'XD')).toBe(true);
    expect(namesIn(I1)).toEqual(['XA', 'XB', 'XC']); // not rebuilt in a world being replaced
  });
});

describe('several prefab files as ONE step (#1692, for #1693)', () => {
  const Y = 'cccccccc-0000-4000-8000-000000001693';
  const Y_PATH = '/assets/prefabs/Y.prefab.json';
  const yDoc = (name = 'Y'): PrefabFile => ({ id: Y, version: 6, name, rootLocalId: 1, entities: [row(1, 'YR', 0, g(9))] } as unknown as PrefabFile);
  const xNext = () => { const d = xDoc(); d.entities.push(row(5, 'XD', 1, g(5)) as never); return d; };
  beforeEach(() => {
    registerAsset(Y, Y_PATH, 'prefab');
    route.disk.set(Y_PATH, jsonFileBody(yDoc()));
    prefabs.set(Y, yDoc());
    setPrefabCache(Y, yDoc());
  });

  it('both land: both caches, ONE rebuild seeing both paths, and the rebase of the instances', async () => {
    const rebuilds: string[][] = [];
    const res = await quietly(() => commitPrefabWrites([
      { source: X, doc: xNext(), expected: xDoc() },
      { source: Y, doc: yDoc('Y2'), expected: yDoc() },
    ], { rebuild: ({ paths }) => { rebuilds.push(paths); } }));
    expect(res.ok).toBe(true);
    expect(rebuilds).toEqual([[X_PATH, Y_PATH]]);
    expect(getCachedPrefabSync(Y)?.name).toBe('Y2');
    expect(namesIn(I1)).toEqual(['XA', 'XB', 'XC', 'XD']);
  });

  it("the SECOND file's precondition fails: nothing is written — not even the first", async () => {
    route.disk.set(Y_PATH, jsonFileBody(yDoc('changed elsewhere')));
    const res = await quietly(() => commitPrefabWrites([
      { source: X, doc: xNext(), expected: xDoc() },
      { source: Y, doc: yDoc('Y2'), expected: yDoc() },
    ]));
    expect(res).toMatchObject({ ok: false, conflict: true });
    expect(route.posts).toEqual([]);
    expect(route.disk.get(X_PATH)).toBe(jsonFileBody(xDoc()));
    expect(getCachedPrefabSync(X)?.entities.some((e) => e.name === 'XD')).toBe(false);
    expect(namesIn(I1)).toEqual(['XA', 'XB', 'XC']);
  });

  // Close-out review: an overwrite checks nothing, so a rollback had only the caller's stale `expected` to put back — and
  // could trash a file that was there. Mutation: drop the one-file rule for `overwrite`.
  it('an overwrite of several files is refused, and writes nothing', async () => {
    route.disk.set(Y_PATH, jsonFileBody(yDoc('changed elsewhere')));
    const res = await quietly(() => commitPrefabWrites([
      { source: X, doc: xNext(), expected: null },
      { source: Y, doc: yDoc('Y2'), expected: null },
    ], { overwrite: true }));
    expect(res.ok).toBe(false);
    expect(route.posts).toEqual([]);
  });

  it('a race after the checks: the second write is refused, and the first is put back', async () => {
    route.beforeWrite = (path) => { if (path === Y_PATH) route.disk.set(Y_PATH, jsonFileBody(yDoc('raced in'))); };
    const res = await quietly(() => commitPrefabWrites([
      { source: X, doc: xNext(), expected: xDoc() },
      { source: Y, doc: yDoc('Y2'), expected: yDoc() },
    ]));
    route.beforeWrite = null;
    expect(res).toMatchObject({ ok: false, conflict: true });
    expect(res.stranded).toBeUndefined();
    expect(route.disk.get(X_PATH)).toBe(jsonFileBody(xDoc()));
    expect(route.disk.get(Y_PATH)).toBe(jsonFileBody(yDoc('raced in')));
    expect(getCachedPrefabSync(X)?.entities.some((e) => e.name === 'XD')).toBe(false);
  });
});
