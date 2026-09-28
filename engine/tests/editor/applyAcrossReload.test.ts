/** #1750 H1: an Apply carries its instance's `rootInstanceId` across awaits, and that id is a bare entity index. A
 *  reloaded world numbers its entities from zero in FILE order, so after a hot reload the id names whatever holds that
 *  index — here ANOTHER instance of the same prefab. Measured before the fix: an Apply from IA, whose reload listed IB
 *  first, wrote IB's value (9) into the prefab and reported `applied: true`.
 *
 *  The fix: the Apply captures the ADOPTED world (`captureAdoption`) before its first await and refuses, after its last
 *  await before it plans, when that world is gone — "the scene reloaded, open Apply again" (owner, 2026-09-28: never
 *  re-found by guid, the write would no longer be the preview the user confirmed). Two windows, both measured:
 *  1. the Apply waited in `adoptionsSettled()` for a reload already pending when it was clicked;
 *  2. nothing was pending at the click, and the reload landed while the Apply's `sceneBefore` serialize fetched a cold
 *     prefab (`applyPrefabUndo.ts`).
 *  A file listing IA first again aliases the id back to IA, so the old code wrote the right value there by luck; the
 *  refusal does not depend on the alias, and both orders are asserted.
 *
 *  Driven through the real `applyToPrefabWithUndo`, prefab planner and commit, over a fake write route that honours
 *  if-match as the real one does. Mutations: drop the check before the plan (`if (!adopted()) …` above
 *  `applyToPrefabSelective`) → both windows go red, in both file orders; no capture at all (`adopted = () => true`) →
 *  the same four, which is main before this fix. The accept side stays green under both. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

/** The fake route's disk, and every write it was asked for. */
const fs = vi.hoisted(() => ({
  disk: new Map<string, string>(), posts: [] as { path: string; content: string }[],
  /** When set, the next write to a path containing `holdPath` waits for it — a write held in flight. */
  hold: null as null | { holdPath: string; gate: Promise<void>; reached: () => void },
}));
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string, _enc?: string, opts?: { ifMatch?: string }) => {
    const h = fs.hold;
    if (h && path.includes(h.holdPath)) { fs.hold = null; h.reached(); await h.gate; }
    fs.posts.push({ path, content });
    const answer = (status: number, body: object) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
    if (opts?.ifMatch !== undefined) {
      const cur = fs.disk.get(path);
      const hash = cur === undefined ? null : createHash('sha256').update(cur).digest('hex');
      if (hash !== opts.ifMatch) return answer(409, { ok: false, conflict: true, reason: 'if-match' });
    }
    fs.disk.set(path, content);
    return answer(200, { ok: true });
  },
}));

const smLoad = vi.hoisted(() => ({ load: null as null | ((data: unknown) => Promise<void>) }));
vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sceneManager: {
    getCurrent: () => ({ path: 'scenes/Level.json' }),
    getNext: () => null,
    getLoadedScenes: () => new Map(),
    getCurrentBaseScene: () => undefined,
    // The Apply undo's world restore (restoreSnapshot) reloads the snapshot through here.
    loadScene: async (_path: string, opts?: { preloaded?: unknown }) => {
      await smLoad.load!(opts!.preloaded);
      return { world: (await import('../../packages/modoki/src/runtime/core/ecs/world')).getCurrentWorld(), keptBaseGuids: new Set<string>() };
    },
  },
}));
vi.mock('../../packages/modoki/src/editor/scene/serialize', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveScene: async () => ({ saved: true, reason: 'ok' }),
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, loadSceneFile, instantiatePrefabIntoWorld,
  destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction } from '@modoki/engine/editor';
import { setRunMode } from '../../packages/modoki/src/runtime/core/playState';
import { setPrefabCache, getCachedPrefabSync, seatEditorPrefabCache, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { jsonFileBody } from '../../packages/modoki/src/editor/backend/editorBackend';
import { setCurrentScenePath } from '../../packages/modoki/src/editor/scene/serialize';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { swapHistory, undo, canRedo, _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { withAdoption, _resetSceneAdoptionForTests } from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { runAgentOp } from '../../app/debug/agentBridge';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';

registerAllTraits();
setActionCallback(pushAction);
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const serveDisk = async (url: string) => {
  const path = [...fs.disk.keys()].find((p) => String(url).includes(p));
  return path ? new Response(fs.disk.get(path)!, { status: 200 }) : new Response('', { status: 404 });
};

const P = 'aaaaaaaa-0000-4000-8000-000000001750';
const G = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROOT_A = G(901);
const ROOT_B = G(902);
const SCENE = 'scenes/Level.json';
const row = (localId: number, nodeGuid: string, name: string, parentId: number) => ({
  localId, nodeGuid, name,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** P: R -> A. */
const pDoc = () => ({ id: P, version: 6, name: 'P', rootLocalId: 1, entities: [row(1, G(1), 'R', 0), row(2, G(2), 'A', 1)] });
const install = (doc: { id: string }) => { prefabs.set(doc.id, doc); setPrefabCache(doc.id, doc as never); };
const inst = (id: number, guid: string, name: string, x: number) =>
  ({ id, prefab: P, guid, traits: { EntityAttributes: { name, parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } }, overrides: { 2: { Transform: { x } } } });
/** IA sets A.x = 5, IB sets A.x = 9; `order` is the order the FILE lists them. */
const scene = (order: 'AB' | 'BA'): SceneData => ({
  id: 'h1750', version: SCENE_FORMAT_VERSION, name: 'S', resources: [],
  entities: order === 'AB' ? [inst(1, ROOT_A, 'IA', 5), inst(2, ROOT_B, 'IB', 9)] : [inst(1, ROOT_B, 'IB', 9), inst(2, ROOT_A, 'IA', 5)],
} as unknown as SceneData);

/** A fresh world built from `data`, as a load does: entities numbered from zero in file order. */
async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)), {
    loadModels: false,
    fetchPrefab: async (ref) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _old, _extra, overrides, structure, nested, rootGuid, _folder, nestedStructure) => {
      const world = getCurrentWorld();
      const rootId = instantiatePrefabIntoWorld(world, (getCachedPrefabSync(source) ?? prefabs.get(source)) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
      if (!rootId) return undefined;
      if (rootGuid) for (const e of world.entities) if (e.id() === rootId) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid: rootGuid });
      return rootId;
    },
  });
}
smLoad.load = (data) => load(data as SceneData);

/** A load the editor ADOPTS, as a scene open or a hot reload does. */
const loadAdopted = (data: SceneData, beforeLoad?: Promise<void>) => withAdoption('hot-reload', async (t) => {
  if (beforeLoad) await beforeLoad;
  await load(data);
  t.offer({ world: getCurrentWorld(), path: SCENE, baseScene: 'loaded', history: { key: SCENE, keptBaseGuids: new Set() } });
});

const all = () => getAllEntities();
const rootIdOf = (guid: string) => all().find((e) => e.guid === guid)!.id;
const guidOfId = (id: number) => all().find((e) => e.id === id)?.guid;
const diskAx = () => ((JSON.parse(fs.disk.get(P)!) as PrefabFile).entities.find((e) => e.name === 'A')!.traits.Transform as { x: number }).x;
const postsTo = (guid: string) => fs.posts.filter((p) => p.path.includes(guid));
const keyOf = (rootId: number) => collectInstanceOverrideKeys(rootId, getCachedPrefabSync(P) as PrefabFile).fields.find((k) => k.endsWith('.Transform.x'))!;
const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};

beforeEach(async () => {
  setRunMode('stopped');
  _resetHistoryContexts();
  _resetSceneAdoptionForTests();
  swapHistory(SCENE);
  prefabs.clear();
  install(pDoc());
  fs.disk.clear();
  fs.disk.set(P, jsonFileBody(pDoc()));
  fs.posts.length = 0;
  vi.stubGlobal('fetch', serveDisk);
  useEditorStore.setState({ showToast: vi.fn() } as never);
  setCurrentScenePath(SCENE);
  await loadAdopted(scene('AB'));
});

describe('#1750 H1, window 1: an Apply that waited for a pending reload', () => {
  it.each(['BA', 'AB'] as const)('the reload (file order %s) lands while it waits: the Apply refuses and writes nothing', async (order) => {
    const rootA = rootIdOf(ROOT_A);
    const key = keyOf(rootA);
    let open!: () => void;
    const held = new Promise<void>((r) => { open = r; });
    const reload = loadAdopted(scene(order), held); // pending before the click, as a reload preloading is
    const apply = quietly(() => applyToPrefabWithUndo(rootA, new Set([key])));
    await new Promise((r) => setTimeout(r, 0));
    open();
    await reload;
    const res = await apply;
    expect(guidOfId(rootA), 'premise: the id now names this instance').toBe(order === 'BA' ? ROOT_B : ROOT_A);
    expect(res).toMatchObject({ applied: false, refused: 'the scene reloaded — open Apply again.' });
    expect(postsTo(P)).toEqual([]);
    expect(diskAx()).toBe(0);
  });

  it('an Apply clicked in a reload`s tail (its world on screen, not adopted yet) refuses at once', async () => {
    const rootA = rootIdOf(ROOT_A);
    const key = keyOf(rootA);
    let open!: () => void;
    const held = new Promise<void>((r) => { open = r; });
    let swapped = false;
    const reload = withAdoption('hot-reload', async (t) => {
      await load(scene('AB'));
      swapped = true;
      await held; // the post-swap tail
      t.offer({ world: getCurrentWorld(), path: SCENE, baseScene: 'loaded', history: { key: SCENE, keptBaseGuids: new Set() } });
    });
    while (!swapped) await new Promise((r) => setTimeout(r, 0));
    const res = await quietly(() => applyToPrefabWithUndo(rootA, new Set([key])));
    open();
    await reload;
    expect(res).toMatchObject({ applied: false, refused: 'a scene is still loading — apply again once it is open.' });
    expect(postsTo(P)).toEqual([]);
  });

  it('ACCEPT SIDE: with no reload, the Apply writes IA`s value', async () => {
    const rootA = rootIdOf(ROOT_A);
    const res = await quietly(() => applyToPrefabWithUndo(rootA, new Set([keyOf(rootA)])));
    expect(res.applied).toBe(true);
    expect(diskAx()).toBe(5);
  });
});

// ── Window 2: Q is fetched by the Apply's sceneBefore serialize, BEFORE the plan ──
const Q = 'aaaaaaaa-0000-4000-8000-000000011750';
const qDoc = () => ({ id: Q, version: 6, name: 'Q', rootLocalId: 1, entities: [row(1, G(21), 'QR', 0)] });
const KQ = 'dddddddd-0000-4000-8000-000000001750';
/** IB carries an added nested Q instance that IA does not, so the plan's own preload (IA's subtree) never fetches Q. */
const sceneQ = (order: 'AB' | 'BA'): SceneData => {
  const ib = { ...inst(0, ROOT_B, 'IB', 9), added: [{ parentLocalId: 1, key: KQ, guid: G(950), name: 'QRef', prefab: Q, traits: { EntityAttributes: { name: 'QRef' }, Transform: { x: 0, y: 0, z: 0 } }, children: [] }] };
  const ia = inst(0, ROOT_A, 'IA', 5);
  const list = order === 'AB' ? [ia, ib] : [ib, ia];
  return { id: 'f5', version: SCENE_FORMAT_VERSION, name: 'S', resources: [], entities: list.map((e, i) => ({ ...e, id: i + 1 })) } as unknown as SceneData;
};

describe('#1750 H1, window 2: nothing pending at the click; the reload lands while `sceneBefore` fetches a cold prefab', () => {
  it.each(['BA', 'AB'] as const)('the reload (file order %s): the Apply refuses and writes nothing', async (order) => {
    prefabs.set(Q, qDoc()); // the runtime cache has Q (the scene loads it); the EDITOR cache does not
    for (const k of [Q, `/prefabs/${Q}.prefab.json`]) seatEditorPrefabCache(k, null); // cold on every run
    fs.disk.set(Q, jsonFileBody(qDoc()));
    registerAsset(Q, `/prefabs/${Q}.prefab.json`, 'prefab' as never);
    await loadAdopted(sceneQ('AB'));
    const rootA = rootIdOf(ROOT_A);
    const key = keyOf(rootA);
    let releaseQ!: () => void;
    const qGate = new Promise<void>((r) => { releaseQ = r; });
    let qAsked!: () => void;
    const qRequested = new Promise<void>((r) => { qAsked = r; });
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes(Q)) { qAsked(); await qGate; }
      return serveDisk(url);
    });
    const apply = quietly(() => applyToPrefabWithUndo(rootA, new Set([key])));
    await Promise.race([qRequested, apply.then((r) => { throw new Error('the Apply ended without fetching Q: ' + JSON.stringify(r)); })]);
    await loadAdopted(sceneQ(order));
    releaseQ();
    const res = await apply;
    expect(res).toMatchObject({ applied: false, refused: 'the scene reloaded — open Apply again.' });
    expect(postsTo(P)).toEqual([]);
    expect(diskAx()).toBe(0);
  });
});

// ── The siblings the close-out reviews found: the agent `prefab create`, and a rebuild in place under a waiting Apply ──
describe('#1750 close-out: the same capture discipline for the agent `prefab create` op', () => {
  it.each(['BA', 'AB'] as const)('a reload (file order %s) landing in its first fetch: refused, nothing written', async (order) => {
    registerEditorAgentOps();
    const NEWP = 'prefabs/NewFromIA.prefab.json';
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let asked!: () => void;
    const reached = new Promise<void>((r) => { asked = r; });
    let first = true;
    vi.stubGlobal('fetch', async (url: string) => {
      if (first) { first = false; asked(); await held; }
      return serveDisk(url);
    });
    const create = quietly(() => runAgentOp('prefab', { prefabAction: 'create', entityGuid: ROOT_A, path: NEWP }).catch((e: Error) => ({ ok: false, error: e.message })));
    await reached;
    await loadAdopted(scene(order));
    release();
    const r = await create as { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/the scene was reloaded while the prefab was being prepared/);
    expect(fs.posts.filter((p) => p.path.includes('NewFromIA'))).toEqual([]);
  });
});

describe('#1750 close-out: the agent `prefab create` of an instance another Apply re-mints meanwhile', () => {
  it('refused, naming the in-place rebuild; nothing written', async () => {
    registerEditorAgentOps();
    const rootA = rootIdOf(ROOT_A);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let asked!: () => void;
    const reached = new Promise<void>((r) => { asked = r; });
    let first = true;
    vi.stubGlobal('fetch', async (url: string) => {
      if (first && String(url).includes('FromIB')) { first = false; asked(); await held; }
      return serveDisk(url);
    });
    const create = quietly(() => runAgentOp('prefab', { prefabAction: 'create', entityGuid: ROOT_B, path: 'prefabs/FromIB.prefab.json' }).catch((e: Error) => ({ ok: false, error: e.message })));
    await reached;
    expect((await quietly(() => applyToPrefabWithUndo(rootA, new Set([keyOf(rootA)])))).applied, 'premise: the fan-out re-minted IB').toBe(true);
    release();
    const r = await create as { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rebuilt in place/);
    expect(fs.posts.filter((p) => p.path.includes('FromIB'))).toEqual([]);
  });
});

describe('#1750 fourth review: the agent `prefab create` whose tree is rebuilt DURING its write', () => {
  it('the file lands, the tree is NOT tagged (its id names a re-minted entity), and the reply says so', async () => {
    registerEditorAgentOps();
    const rootA = rootIdOf(ROOT_A);
    const rootB = rootIdOf(ROOT_B);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const atWrite = new Promise<void>((r) => { reached = r; });
    fs.hold = { holdPath: 'FromIB2', gate, reached };
    const create = quietly(() => runAgentOp('prefab', { prefabAction: 'create', entityGuid: ROOT_B, path: 'prefabs/FromIB2.prefab.json' }).catch((e: Error) => ({ ok: false, error: e.message })));
    await atWrite; // past every check of its own, inside the commit's write
    expect((await quietly(() => applyToPrefabWithUndo(rootA, new Set([keyOf(rootA)])))).applied, 'premise: the fan-out re-minted IB').toBe(true);
    release();
    const r = await create as { ok?: boolean; warnings?: string[] };
    expect(r.ok, 'the file landed').toBe(true);
    expect(r.warnings?.join(' ')).toMatch(/rebuilt in place while the prefab was written/);
    const tagged = all().filter((e) => (getCurrentWorld().entities.find((x) => x.id() === e.id)?.get(getTraitByName('PrefabInstance')!.trait) as { source?: string } | undefined)?.source?.includes('FromIB2'));
    expect(tagged, 'whatever now holds the old id was tagged as the new prefab').toEqual([]);
    void rootB;
  });
});

describe('#1750 close-out: an instance rebuilt in place under a waiting Apply (another Apply`s fan-out)', () => {
  it('an Apply planned on an instance a concurrent Apply re-minted refuses, naming the rebuild', async () => {
    prefabs.set(Q, qDoc());
    fs.disk.set(Q, jsonFileBody(qDoc()));
    registerAsset(Q, `/prefabs/${Q}.prefab.json`, 'prefab' as never);
    for (const k of [Q, `/prefabs/${Q}.prefab.json`]) seatEditorPrefabCache(k, null);
    await loadAdopted(sceneQ('AB'));
    const rootA = rootIdOf(ROOT_A);
    const rootB = rootIdOf(ROOT_B);
    const keyB = collectInstanceOverrideKeys(rootB, getCachedPrefabSync(P) as PrefabFile).fields.find((k) => k.endsWith('.Transform.x'))!;
    let releaseQ!: () => void;
    const qGate = new Promise<void>((r) => { releaseQ = r; });
    let qAsked!: () => void;
    const qRequested = new Promise<void>((r) => { qAsked = r; });
    let firstQ = true;
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes(Q) && firstQ) { firstQ = false; qAsked(); await qGate; }
      return serveDisk(url);
    });
    const applyB = quietly(() => applyToPrefabWithUndo(rootB, new Set([keyB])));
    await qRequested; // B is in its sceneBefore fetch
    const resA = await quietly(() => applyToPrefabWithUndo(rootA, new Set([keyOf(rootA)])));
    expect(resA.applied, 'premise: A applied, and its fan-out re-minted IB').toBe(true);
    releaseQ();
    expect(await applyB).toMatchObject({ applied: false, refused: 'the instance was rebuilt meanwhile — open Apply again.' });
    expect(diskAx(), 'IA`s value, and only that').toBe(5);
  });
});

describe('#1750 close-out re-review: an unrelated Apply during an Apply undo`s write does not drop the undo', () => {
  // A global "frames rebuilt" invalidation made this undo restore the file only, throw, and vanish from both stacks.
  it('the undo lands whole: the file back, the instance back, redo available', async () => {
    const P2 = 'aaaaaaaa-0000-4000-8000-000000021750';
    const p2Doc = () => ({ id: P2, version: 6, name: 'P2', rootLocalId: 1, entities: [row(1, G(31), 'S', 0), row(2, G(32), 'T', 1)] });
    install(p2Doc());
    fs.disk.set(P2, jsonFileBody(p2Doc()));
    const ROOT_C = G(903);
    await loadAdopted({
      id: 'u1750', version: SCENE_FORMAT_VERSION, name: 'S', resources: [],
      entities: [inst(1, ROOT_A, 'IA', 5), { id: 2, prefab: P2, guid: ROOT_C, traits: { EntityAttributes: { name: 'IC', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } }, overrides: { 2: { Transform: { x: 7 } } } }],
    } as unknown as SceneData);
    const rootA = rootIdOf(ROOT_A);
    expect((await quietly(() => applyToPrefabWithUndo(rootA, new Set([keyOf(rootA)])))).applied, 'premise').toBe(true);
    expect(diskAx()).toBe(5);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const atWrite = new Promise<void>((r) => { reached = r; });
    fs.hold = { holdPath: P, gate, reached };
    const undoing = quietly(() => undo());
    await atWrite; // the undo's P write is in flight
    const rootC = rootIdOf(ROOT_C);
    const keyC = collectInstanceOverrideKeys(rootC, getCachedPrefabSync(P2) as PrefabFile).fields.find((k) => k.endsWith('.Transform.x'))!;
    expect((await quietly(() => applyToPrefabWithUndo(rootC, new Set([keyC])))).applied, 'premise: the unrelated Apply landed').toBe(true);
    release();
    await undoing;
    expect(diskAx(), 'the file went back').toBe(0);
    expect(canRedo(), 'the undo entry survived as a redo').toBe(true);
  });
});
