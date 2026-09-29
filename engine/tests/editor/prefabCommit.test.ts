/** #1692 — a prefab write is ONE step (`commitPrefabWrite`, prefabCommit.ts): a conditional write, both caches under
 *  every key, and every live frame of the source rebuilt. Each absorbed bug has its case here, driven through the real
 *  loader, capture, save, Create Prefab and cache; only the route is a fake, holding exactly the bytes it received and
 *  applying `/api/write-file`'s and `/api/delete-asset`'s own preconditions (`ifMatch` over the BOM-stripped bytes,
 *  `ifNoneMatch:'*'`), and serving what it holds to a GET.
 *
 *  - #1685: Create Prefab → Replace left every OTHER live instance expanded from the old document, and the next save
 *    recorded the template's new members as removed from it — for good. Mutation: skip the rebase in
 *    `commitPrefabWrite` — the Replace case goes red; skip it in `restorePrefabsInMemory` — its undo case (#1868: the undo
 *    restores in memory and parks, and Save writes it).
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
 *    it. Mutation: start one from `commitPrefabWrite`'s rebuild step — that case goes red (and, un-counted, hangs).
 *  - #1797: a writer stamped v8 on a clone of a file that had no `nextLocalId`, and nothing stated the mark. The commit
 *    owns "a document that claims v8 states its mark" for every writer. Mutation: drop `markUnstated` from `contentFor`'s
 *    early return — the document case and the recorded-bytes case go red, the accept cases stay green. */

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
const route = vi.hoisted(() => ({ disk: new Map<string, string>(), failRead: null as string | null, failWrites: false, gate: null as Promise<void> | null, waiting: 0, posts: [] as string[], beforeWrite: null as null | ((path: string) => void) }));
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
  if (route.failRead && url.endsWith(route.failRead)) return new Response('', { status: 500 });
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
import { setPrefabCache, getCachedPrefabSync, getPrefabSource, evictDeletedEditorPrefabs, PREFAB_FORMAT_VERSION, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { commitPrefabWrite, commitPrefabWrites } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { localIdCounter, markUnstated } from '../../packages/modoki/src/runtime/core/localIdCounter';
import { withAdoption, _resetSceneAdoptionForTests } from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { jsonFileBody } from '../../packages/modoki/src/editor/backend/editorBackend';
import { undo, redo, undoStep, worldBoundOperationsHeld } from '../../packages/modoki/src/editor/undo/undoManager';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { writeTraitFieldWithUndo } from '@modoki/engine/editor';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { readTraitData } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { clearDirtyAssets, peekDirtyAsset, flushDirtyAssets, parkPrefab } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { applyAssetPathMoves } from '../../packages/modoki/src/editor/panels/assetEditorBindings';

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
  clearDirtyAssets(); // a document an undo parked (#1868) belongs to its own case
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

/** X's bytes as an undo or a rollback puts them back over a write that raised X's localId high-water mark to `mark`: the
 *  replaced bytes with that mark and the format version that claims it spliced in, every other byte kept (#1774). */
const restoredOverMark = (mark: number | undefined) => {
  expect(mark, 'precondition: the write minted rows above X\'s own').toBeGreaterThan(Math.max(...xDoc().entities.map((e) => e.localId)) + 1);
  return jsonFileBody({ nextLocalId: mark, ...xDoc(), version: PREFAB_FORMAT_VERSION } as never);
};

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
    const written = route.disk.get(X_PATH)!;
    const mark = (JSON.parse(written) as PrefabFile).nextLocalId;
    await quietly(() => undo()); // the Create Prefab entry (the edits above are their own entries)
    // #1868: the replaced document is back IN MEMORY and parked; the file keeps the Replace until Save.
    expect(route.disk.get(X_PATH)).toBe(written);
    expect((peekDirtyAsset(X_PATH)?.data as PrefabFile | undefined)?.name).toBe('X');
    expect(namesIn(I1)).toEqual(['XA', 'XB', 'XC']);
    const saved = await quietly(() => serializeScene()) as unknown as SceneData;
    expect(JSON.stringify(entryOf(saved, I1))).not.toContain('"removed":true');
    // …and Save writes it, with the Replace's localId high-water mark kept (#1774).
    await quietly(() => flushDirtyAssets());
    expect(JSON.parse(route.disk.get(X_PATH)!)).toEqual(JSON.parse(restoredOverMark(mark)));
  });
});

describe('#1868: a Replace\'s undo and redo write nothing', () => {
  /** The undo parks the replaced document; the redo puts back the Replace's, which is what the file holds, so the park goes
   *  and nothing is left for Save. Mutation: park the redo's document instead of dropping it → the last line goes red. */
  it('Create Prefab → Replace, undo, redo: the file never moves, and the redo leaves nothing unsaved', async () => {
    await replaceXFromI2();
    const written = route.disk.get(X_PATH)!;
    await quietly(() => undo());
    expect(peekDirtyAsset(X_PATH)).not.toBeNull(); // precondition: the undo ran
    await quietly(() => redo());
    expect(route.disk.get(X_PATH)).toBe(written);
    expect(getCachedPrefabSync(X)?.name).toBe((JSON.parse(written) as PrefabFile).name);
    expect(peekDirtyAsset(X_PATH)).toBeNull();
  });
});

/** #1868 — a Replace's undo restores in memory, so its two file-era guarantees are asked of memory and of the manifest.
 *  - Hub call (e): after a Rename the undo finds the prefab by its GUID, where it is now — never by the path the Replace
 *    wrote, which may be empty or hold another prefab. Mutation: restore by `savePath` in the undo — the park lands at the
 *    old path, and Save writes a second file there.
 *  - #1679, asked of memory: a save of the prefab since the Replace is kept — the undo refuses and changes nothing.
 *    Mutation: drop `prefabRestoreRefusal` from `restorePrefabsInMemory` — the later save is undone in memory. */
describe('#1868: a Replace\'s undo, in memory', () => {
  it('after a Rename, restores the replaced document where the prefab is NOW, and Save writes it there', async () => {
    await replaceXFromI2();
    const MOVED = '/assets/prefabs/Moved1868.prefab.json';
    route.disk.set(MOVED, route.disk.get(X_PATH)!);
    route.disk.delete(X_PATH);
    registerAsset(X, MOVED, 'prefab');
    applyAssetPathMoves([{ from: X_PATH, to: MOVED }]);
    await quietly(() => undo());
    expect(peekDirtyAsset(X_PATH)).toBeNull();
    expect((peekDirtyAsset(MOVED)?.data as PrefabFile | undefined)?.name).toBe('X');
    expect(namesIn(I1)).toEqual(['XA', 'XB', 'XC']);
    expect((await quietly(() => flushDirtyAssets())).failed).toEqual([]);
    expect(route.disk.has(X_PATH)).toBe(false);
    expect((JSON.parse(route.disk.get(MOVED)!) as PrefabFile).name).toBe('X');
  });

  // D-i. Mutation: read the replaced document from the FILE when X is parked (`parkedPrefabRead` dropped in
  // createPrefabFromEntity) — the park outlives the Replace, and the undo brings back the file instead of it.
  it('a Replace over a PARKED prefab replaces the park: it retires, and the undo brings it back', async () => {
    const parkedX = xDoc();
    parkedX.name = 'parked X';
    parkPrefab(X_PATH, parkedX, xDoc());
    setPrefabCache(X, JSON.parse(JSON.stringify(parkedX)) as PrefabFile);
    await replaceXFromI2();
    expect(peekDirtyAsset(X_PATH)).toBeNull();
    await quietly(() => undo());
    expect((peekDirtyAsset(X_PATH)?.data as PrefabFile | undefined)?.name).toBe('parked X');
  });

  // Mutation: drop the manifest id a restore keeps (`doc.id = r.source` in restorePrefabsInMemory) — the park is id-less,
  // and Save mints the prefab a fresh id, unlinking every instance of it.
  it('a Replace over an id-less file: its undo keeps the id the manifest gave the prefab, and Save writes that one', async () => {
    const { id: _id, ...idless } = xDoc();
    route.disk.set(X_PATH, jsonFileBody(idless as PrefabFile));
    await replaceXFromI2();
    await quietly(() => undo());
    expect((peekDirtyAsset(X_PATH)?.data as PrefabFile | undefined)?.id).toBe(X);
    expect((await quietly(() => flushDirtyAssets())).failed).toEqual([]);
    expect((JSON.parse(route.disk.get(X_PATH)!) as PrefabFile).id).toBe(X);
  });

  it('a save of the prefab since the Replace is kept: the undo refuses and changes nothing', async () => {
    await replaceXFromI2();
    const later = JSON.parse(JSON.stringify(getCachedPrefabSync(X))) as PrefabFile;
    later.name = 'saved later';
    expect((await quietly(() => commitPrefabWrite(X, later, { expected: getCachedPrefabSync(X)! }))).ok).toBe(true);
    const bytes = route.disk.get(X_PATH);
    await quietly(() => undo());
    expect(peekDirtyAsset(X_PATH)).toBeNull();
    expect(getCachedPrefabSync(X)?.name).toBe('saved later');
    expect(route.disk.get(X_PATH)).toBe(bytes);
    expect(namesIn(I1)).toEqual(['New', 'New2', 'New3', 'XB', 'XC']);
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

describe('a write that claims v8 states its mark, whichever writer stamped the version (#1797)', () => {
  // X on disk is v6 with no mark, rows 1–4: the mark its rows give is 5, and no prior raises it — the case #1797's
  // enclosing Apply document hit, where the "raise to the prior" line had nothing to do.
  const stampedV8 = (): PrefabFile => ({ ...xDoc(), version: PREFAB_FORMAT_VERSION });

  it('a document stamped v8 with no mark is written with the one its rows give, after rootLocalId', async () => {
    const res = await quietly(() => commitPrefabWrite(X, stampedV8(), { expected: xDoc() }));
    expect(res.ok).toBe(true);
    const onDisk = JSON.parse(route.disk.get(X_PATH)!) as PrefabFile;
    expect(onDisk).toMatchObject({ version: PREFAB_FORMAT_VERSION, nextLocalId: 5 });
    const keys = Object.keys(onDisk);
    expect(keys.indexOf('nextLocalId')).toBe(keys.indexOf('rootLocalId') + 1);
  });

  it('recorded bytes that claim v8 with no mark: the mark is spliced in and every other byte kept', async () => {
    const bytes = jsonFileBody(stampedV8());
    const res = await quietly(() => commitPrefabWrite(X, stampedV8(), { expected: xDoc(), bytes }));
    expect(res.ok).toBe(true);
    expect(route.disk.get(X_PATH)).toBe(jsonFileBody({ nextLocalId: 5, ...stampedV8() } as never));
  });

  it('(accept) a document that does not claim v8 goes down exactly as built, with no mark', async () => {
    const next = xDoc();
    next.entities.push(row(5, 'XD', 1, g(5)) as never);
    const res = await quietly(() => commitPrefabWrite(X, next, { expected: xDoc() }));
    expect(res.ok).toBe(true);
    expect(route.disk.get(X_PATH)).toBe(jsonFileBody(next));
  });

  // Pins "a stated mark is never lowered" — a mark ABOVE the rows (9 over rows 1–4, #1774's freed top number) must not be
  // re-derived from the rows (the hub's check; killed by making contentFor re-derive a stated mark). It does NOT guard
  // `markUnstated`'s false branch: an over-trigger writes the same bytes here. The `markUnstated` table below does.
  it('(accept) a v8 document that states its mark keeps it, byte for byte', async () => {
    const next = { ...stampedV8(), nextLocalId: 9 } as PrefabFile;
    const res = await quietly(() => commitPrefabWrite(X, next, { expected: xDoc() }));
    expect(res.ok).toBe(true);
    expect(route.disk.get(X_PATH)).toBe(jsonFileBody({ ...stampedV8(), nextLocalId: 9 } as never));
  });

  it('markUnstated: v8 or later without a positive-integer mark, and nothing else', () => {
    expect(markUnstated({ version: 8 })).toBe(true);
    expect(markUnstated({ version: 9 })).toBe(true); // a later format still carries the field
    expect(markUnstated({ version: 8, nextLocalId: 0 })).toBe(true);
    expect(markUnstated({ version: 8, nextLocalId: 'five' })).toBe(true);
    expect(markUnstated({ version: 8, nextLocalId: 5 })).toBe(false);
    expect(markUnstated({ version: 7 })).toBe(false); // before the mark: derived from the rows, legitimately absent
    expect(markUnstated({})).toBe(false);
    expect(markUnstated(null)).toBe(false);
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
    const mark = (JSON.parse(route.disk.get(X_PATH)!) as PrefabFile).nextLocalId;
    expect(worldBoundOperationsHeld()).toBe(0);
    // Apply: its refresh, the rebase, then the undo entry — all under the hold.
    writeTraitFieldWithUndo(inInstance(I1, 'XB'), getTraitByName('Transform')!, 'x', 4);
    const keys = collectInstanceOverrideKeys(rootOf(I1), getCachedPrefabSync(X)!);
    const applied = await quietly(() => applyToPrefabWithUndo(rootOf(I1), new Set(keys.fields)));
    expect(applied.applied, JSON.stringify(applied)).toBe(true); // precondition: the Apply wrote and refreshed
    expect(worldBoundOperationsHeld()).toBe(0);
    // …and an undo's rebuild: the Apply's world restore, the field edit, then the Replace's untag and rebase.
    for (let i = 0; i < 3; i++) await quietly(() => undo());
    expect((peekDirtyAsset(X_PATH)?.data as PrefabFile | undefined)?.name).toBe('X'); // precondition: the Replace's undo ran
    expect(mark).toBeDefined();
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
    // X is put back — keeping the mark its write raised, which the route would refuse to lower (#1774).
    expect(route.disk.get(X_PATH)).toBe(restoredOverMark(localIdCounter(xNext())));
    expect(route.disk.get(Y_PATH)).toBe(jsonFileBody(yDoc('raced in')));
    expect(getCachedPrefabSync(X)?.entities.some((e) => e.name === 'XD')).toBe(false);
  });
});

describe('Create Prefab\'s undo asks require before it unlinks (#1795\'s second route, ruling R), and leaves the file (#1795, ruling (i))', () => {
  const N_PATH = '/assets/prefabs/N.prefab.json';
  /** A plain entity P at the root, made into prefab N through the real Create Prefab, its undo entry pushed. */
  const createN = async () => {
    const p = createEntityWithUndo('Add P', 0, [{ name: 'Transform', data: {} }, { name: 'EntityAttributes', data: { name: 'P' } }], () => {})!;
    const res = await quietly(() => createPrefabFromEntity(p, N_PATH, 'Create Prefab "N"', async () => true));
    if (!res || res === 'declined' || 'refused' in res) throw new Error(`precondition: Create Prefab landed, got ${JSON.stringify(res)}`);
    pushAction(res.action);
    expect(route.disk.has(N_PATH)).toBe(true);
    return res.prefab;
  };

  // Mutation: remove the `ref.require(tagCheck)` from the create branch of the undo — it untags and relinks a placeholder
  // the scene's entry still names, and reports success.
  it('refused, with the file left on disk, once a world swap made the tree a Missing Prefab placeholder', async () => {
    await createN();
    const saved = JSON.parse(JSON.stringify(await serializeScene())) as SceneData;
    await quietly(() => load(saved)); // N is on disk but in no cache the loader reads: P reloads as a placeholder
    const r = await quietly(() => undoStep('undo'));
    expect(r.failed?.refused).toBe(true);
    expect(r.failed?.error).toMatch(/is a Missing Prefab now/);
    expect(route.disk.has(N_PATH)).toBe(true);
  });

  const pOf = () => getAllEntities().find((e) => e.name === 'P')!;
  const linked = () => readTraitData(pOf().id, getTraitByName('PrefabInstance')!) != null;

  // Mutation: put the trash back (the create branch of the undo returning to `commitPrefabWrite(savePath, null, …)`) —
  // the file is gone after the undo.
  it('(accept) in the same world the undo unlinks P and LEAVES the file, byte for byte (#1795 route 1)', async () => {
    await createN();
    const bytes = route.disk.get(N_PATH);
    route.posts.length = 0;
    expect((await quietly(() => undoStep('undo'))).did).toBe(true);
    expect(route.disk.get(N_PATH)).toBe(bytes);
    expect(route.posts).toEqual([]);
    expect(linked()).toBe(false);
  });

  // Mutation: drop the create branch of the redo (every redo goes through `commitPrefabWrite` over nothing) — the redo
  // over the file the undo left is refused as a conflict.
  it('the redo re-links P to the file the undo left, writing nothing', async () => {
    await createN();
    const bytes = route.disk.get(N_PATH);
    await quietly(() => undoStep('undo'));
    route.posts.length = 0;
    expect((await quietly(() => undoStep('redo'))).did).toBe(true);
    expect(route.posts).toEqual([]);
    expect(route.disk.get(N_PATH)).toBe(bytes);
    expect(linked()).toBe(true);
    // …and undoes again, to the same plain P.
    expect((await quietly(() => undoStep('undo'))).did).toBe(true);
    expect(linked()).toBe(false);
  });

  // #1821's shape: the file holds the same document under a RAISED mark (#1774: an Apply's undo keeps it). Mutation:
  // compare the bytes only (`onDisk === content`) in the redo — it refuses.
  it('#1821: the undo is not refused by a raised mark, and the redo re-links through it', async () => {
    const prefab = await createN();
    const raised = jsonFileBody({ ...prefab, nextLocalId: 99 } as PrefabFile);
    route.disk.set(N_PATH, raised);
    expect((await quietly(() => undoStep('undo'))).did).toBe(true);
    expect(route.disk.get(N_PATH)).toBe(raised);
    route.posts.length = 0;
    expect((await quietly(() => undoStep('redo'))).did).toBe(true);
    expect(route.posts).toEqual([]);
    expect(linked()).toBe(true);
  });

  // Mutation: refuse an absent file in the redo instead of writing it — P stays plain.
  it('a file deleted after the undo is written back by the redo, over nothing', async () => {
    const prefab = await createN();
    const bytes = route.disk.get(N_PATH);
    await quietly(() => undoStep('undo'));
    route.disk.delete(N_PATH);
    expect((await quietly(() => undoStep('redo'))).did).toBe(true);
    expect(route.disk.get(N_PATH)).toBe(bytes);
    expect(linked()).toBe(true);
    expect(prefab.id).toBeTruthy();
  });

  // #1795 review: the file moved (the manifest says where) and is gone from THERE — the redo refuses rather than write a
  // second file under the guid at the old path. Mutation: drop the `at !== savePath` refusal — N is written back.
  it('a document moved and then gone refuses the redo, and writes nothing at the old path', async () => {
    const prefab = await createN();
    await quietly(() => undoStep('undo'));
    const MOVED = '/assets/prefabs/Moved.prefab.json';
    route.disk.delete(N_PATH);
    registerAsset(prefab.id!, MOVED, 'prefab');
    route.posts.length = 0;
    const r = await quietly(() => undoStep('redo'));
    expect(r.failed?.refused).toBe(true);
    expect(route.posts).toEqual([]);
    expect(route.disk.has(N_PATH)).toBe(false);
    expect(linked()).toBe(false);
  });

  // I9: the no-write redo seats the document every sync reader reads (the commit it no longer runs used to). Mutation:
  // drop the redo's `primeEditorPrefabCache` — the key stays cold after an eviction between the undo and the redo.
  it('the no-write redo re-seats an editor cache evicted since the undo', async () => {
    const prefab = await createN();
    await quietly(() => undoStep('undo'));
    evictDeletedEditorPrefabs(N_PATH);
    expect(getCachedPrefabSync(prefab.id!), 'premise: evicted').toBeNull();
    expect((await quietly(() => undoStep('redo'))).did).toBe(true);
    expect(getCachedPrefabSync(prefab.id!)?.id).toBe(prefab.id);
  });

  // A read that fails is said and left, not refused as "changed" (which drops the entry for good). Mutation: treat
  // `null` as changed again — the redo is refused.
  it('an unreadable file reports the redo instead of refusing it', async () => {
    await createN();
    await quietly(() => undoStep('undo'));
    route.failRead = N_PATH;
    try {
      const r = await quietly(() => undoStep('redo'));
      expect(r.failed?.refused).not.toBe(true);
      expect(linked()).toBe(false);
    } finally { route.failRead = null; }
  });

  // #1795 review: the undo writes no file, so it has no file precondition — a prefab-edit save (or an outside edit) of the
  // new prefab rebases the instance onto the file's new document, and unlinking THAT would keep the change as plain
  // entities, neither before the create nor after it. Mutation: drop `createdFrameRebuiltRefusal` from the undo's check —
  // P, and the child the save added, are left plain.
  it('refuses once the instance was rebuilt from a changed prefab, and changes nothing', async () => {
    const prefab = await createN();
    const root = prefab.entities.find((e) => e.localId === prefab.rootLocalId)!;
    const changed = { ...prefab, entities: [...prefab.entities, { localId: 2, name: 'D', nodeGuid: 'eeeeeeee-0000-4000-8000-00000017950d', traits: { EntityAttributes: { name: 'D', parentId: root.localId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } }] } as unknown as PrefabFile;
    const saved = await quietly(() => commitPrefabWrite(N_PATH, changed, { expected: prefab }));
    expect(saved.ok, 'premise: the save landed').toBe(true);
    expect(getAllEntities().some((e) => e.name === 'D'), 'premise: the instance was rebased onto it').toBe(true);
    const r = await quietly(() => undoStep('undo'));
    expect(r.failed?.refused).toBe(true);
    expect(r.failed?.error).toMatch(/was rebuilt from a changed .*N\.prefab\.json since/);
    expect(linked()).toBe(true);
  });

  // The accept side (close-out review 2): a reload that keeps the history (Play→Stop, a prefab-edit exit) re-expands the
  // tree from the LOADER's copy of the document — another object, the same content — and the undo must still apply.
  // Mutation: accept only `rec.doc === doc` in `createdFrameRebuiltRefusal` — this undo is refused and dropped.
  it('(accept) after a reload re-expanded the tree from a copy of the same document, the undo still unlinks it', async () => {
    const prefab = await createN();
    prefabs.set(prefab.id!, JSON.parse(JSON.stringify(prefab))); // what this test's loader reads: a copy, as `fetchPrefab` returns
    const saved = JSON.parse(JSON.stringify(await serializeScene())) as SceneData;
    await quietly(() => load(saved));
    expect(linked(), 'premise: the reload re-expanded P as an instance').toBe(true);
    const r = await quietly(() => undoStep('undo'));
    expect(r.failed, r.failed ? String(r.failed.error) : '').toBeFalsy();
    expect(r.did).toBe(true);
    expect(linked()).toBe(false);
    expect(route.disk.has(N_PATH)).toBe(true);
  });

  // Hunt seed 6029: the new prefab renamed, then ANOTHER prefab created at the name the rename freed. The redo reads its
  // document where its guid lives now, not at the path it first wrote. Mutation: read `savePath` again in the redo — it
  // reads the other prefab there and refuses.
  it('the redo re-links to its document where a Rename moved it, though another prefab now holds the old path', async () => {
    const prefab = await createN();
    const MOVED = '/assets/prefabs/N2.prefab.json';
    const bytes = route.disk.get(N_PATH)!;
    route.disk.delete(N_PATH);
    route.disk.set(MOVED, bytes);
    registerAsset(prefab.id!, MOVED, 'prefab');
    expect((await quietly(() => undoStep('undo'))).did).toBe(true);
    const other = jsonFileBody({ ...prefab, id: 'cccccccc-0000-4000-8000-000000006029', entities: prefab.entities.map((e) => ({ ...e, name: 'Other' })) } as PrefabFile);
    route.disk.set(N_PATH, other);
    route.posts.length = 0;
    expect((await quietly(() => undoStep('redo'))).did).toBe(true);
    expect(route.posts).toEqual([]);
    expect(route.disk.get(N_PATH)).toBe(other);
    expect(linked()).toBe(true);
  });

  // Mutation: drop the `prefabTextIsDocument` refusal — the redo tags P against rows the file no longer holds.
  it('a file somebody changed after the undo refuses the redo, before any change', async () => {
    const prefab = await createN();
    await quietly(() => undoStep('undo'));
    const edited = jsonFileBody({ ...prefab, entities: prefab.entities.map((e) => ({ ...e, name: 'Edited' })) } as PrefabFile);
    route.disk.set(N_PATH, edited);
    const r = await quietly(() => undoStep('redo'));
    expect(r.failed?.refused).toBe(true);
    expect(r.failed?.error).toMatch(/N\.prefab\.json/);
    expect(route.disk.get(N_PATH)).toBe(edited);
    expect(linked()).toBe(false);
  });
});
