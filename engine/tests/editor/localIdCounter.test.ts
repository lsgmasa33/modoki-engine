/** #1774 (owner ruling B): a prefab keeps a persisted high-water mark, `nextLocalId`, that never goes down, and every
 *  writer that mints a localId numbers above it. A derived member guid is a hash of the localId path, so a number freed
 *  at the TOP of a document's numbering and handed out again by a LATER write gave the new node the deleted member's
 *  guid, and every ref still naming the deleted member landed on it. Nothing warned.
 *
 *  Driven through the real loader, the real prefab-edit save and the reload (`identityOwner.test.ts`'s harness). */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));
/** Files on disk, path → text: a create-only write over one answers 409 as the real route does, and a GET serves it. */
const onDisk = new Map<string, string>();
/** Run once, inside the next file write — an edit landing while a save awaits its write. */
const duringWrite: { fn: null | (() => void) } = { fn: null };
/** A path whose next write fails, as a full disk would. */
const failWrite = new Set<string>();
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string, _x?: unknown, opts?: { createOnly?: boolean }) => {
    if (opts?.createOnly && onDisk.has(path)) return { ok: false, status: 409, json: async () => ({ existingPath: path }), text: async () => '' } as Response;
    if (failWrite.delete(path)) return { ok: false, status: 500, json: async () => ({ error: 'disk full' }), text: async () => '' } as Response;
    // The route's mark rule (#1774, `classifyPrefabMarkWrite`, which reads the real disk), so a write that would lower
    // the mark is refused here too.
    const { storedLocalIdCounter } = await import('../../packages/modoki/src/runtime/core/localIdCounter');
    const was = onDisk.get(path);
    const parse = (t: string) => JSON.parse(t.replace(/^\uFEFF/, '')) as object; // the route reads a BOM as the parser does
    if (was && path.endsWith('.prefab.json') && storedLocalIdCounter(parse(content)) < storedLocalIdCounter(parse(was))) {
      return { ok: false, status: 409, json: async () => ({ reason: 'prefab-mark-lowered', error: 'mark lowered' }), text: async () => '' } as Response;
    }
    onDisk.set(path, content);
    if (duringWrite.fn) { const f = duringWrite.fn; duringWrite.fn = null; f(); }
    const doc = parse(content) as { id?: string };
    if (doc.id && prefabs.has(doc.id)) prefabs.set(doc.id, doc);
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  },
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction, clearHistory, createEntityWithUndo } from '@modoki/engine/editor';
import { PREFAB_FORMAT_VERSION, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
// What a mark raise stamps: the version the mark ARRIVED in, not today's format (`contentFor`, #1797) — equal to
// PREFAB_FORMAT_VERSION until v9 (#1809), which is when these expectations had to say which they meant.
import { LOCAL_ID_MARK_VERSION, reserveLocalId, clearReservedLocalIds } from '../../packages/modoki/src/runtime/core/localIdCounter';
import { setPrefabCache, getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { mergeRiggedPrefab } from '../../packages/modoki/src/editor/scene/prefabSerialize';
import { applyToPrefabSelective } from '../../packages/modoki/src/editor/scene/prefabApply';
import { commitPrefabWrite, commitPrefabWrites, resetPrefabMarkRecord } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { jsonFileBody } from '../../packages/modoki/src/editor/backend/editorBackend';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { buildPrefabEditScene, savePrefabEditReport, PREFAB_EDIT_ROOT_GUID, _resetPrefabEditSessionRows } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { deleteEntitiesWithUndo } from '@modoki/engine/editor';
import { undo } from '../../packages/modoki/src/editor/undo/undoManager';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { registerAsset, resolveRef } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { peekDirtyAsset, flushDirtyAssets, clearDirtyAssets } from '../../packages/modoki/src/editor/scene/dirtyAssets';

registerAllTraits();
setActionCallback(pushAction);

const O = 'cccccccc-0000-4000-8000-000000169101';
const P = 'cccccccc-0000-4000-8000-000000169102';
const INST = 'dddddddd-0000-4000-8000-000000169101';

const row = (localId: number, name: string, parentId: number, nodeGuid: string, prefab?: string) => ({
  localId, name, nodeGuid, ...(prefab ? { prefab } : {}),
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** A prefab the project holds: both caches, and its FILE — a write is conditional on what the file holds, read first
 *  (#1880 W: every write reads it). At the path its guid resolves to. */
const install = (...docs: Array<{ id?: string }>) => {
  for (const d of docs) { prefabs.set(d.id!, d); setPrefabCache(d.id!, d as never); onDisk.set(resolveRef(d.id!) || d.id!, jsonFileBody(d)); }
};

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

const byName = (name: string) => getAllEntities().filter((e) => e.name === name);
const one = (name: string) => {
  const hits = byName(name);
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} entities named ${name}`);
  return hits[0]!.id;
};
const add = (label: string, parent: number, name: string) =>
  createEntityWithUndo(label, parent, [{ name: 'Transform', data: {} }, { name: 'EntityAttributes', data: { name, parentId: parent } }], () => {})!;

beforeEach(() => {
  clearDirtyAssets(); // a document an undo parked (#1868) belongs to its own case
  resetPrefabMarkRecord(); // the session's mark record (#1880) belongs to its own case too
  clearReservedLocalIds(); // a number a loaded record reserved (#1933 S5) belongs to its own case
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  _resetPrefabEditSessionRows();
  onDisk.clear();
  failWrite.clear();
  vi.stubGlobal('fetch', async (url: string) => {
    // Create Prefab asks the route what is at the path before it asks the human (#1692).
    if (String(url).includes('/api/exists')) {
      const asked = decodeURIComponent(String(url).split('path=')[1] ?? '');
      return { ok: true, status: 200, json: async () => (onDisk.has(asked) ? { exists: true, path: asked } : { exists: false }) };
    }
    const hit = [...onDisk].find(([p]) => String(url).endsWith(p));
    // A real Response: the prior-bytes read takes `arrayBuffer()` (#1692, a BOM is kept for the verbatim undo).
    if (hit) return new Response(hit[1], { status: 200 });
    return { ok: true, json: async () => ({ files: [] }), text: async () => '' };
  });
});
afterAll(() => { for (const id of [O, P]) setPrefabCache(id, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });


/** P3: R(1) → A(2), B(3) — B holds the TOP number. */
const p3Doc = () => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
  row(1, 'R', 0, 'eeeeeeee-0000-4000-8000-000000177411'), row(2, 'A', 1, 'eeeeeeee-0000-4000-8000-000000177412'),
  row(3, 'B', 1, 'eeeeeeee-0000-4000-8000-000000177413'),
] });
const sceneOfP = (): SceneData => ({ id: 's1774', version: 8, name: 'S', resources: [], entities: [
  { id: 1, prefab: P, guid: INST, traits: { EntityAttributes: { name: 'I', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
] } as unknown as SceneData);
const guidOf = (name: string) => getAllEntities().find((e) => e.id === one(name))!.guid!;
const doc = () => prefabs.get(P) as PrefabFile & { nextLocalId?: number };
/** Open the prefab in a prefab-edit world, as a NEW session would (`_resetPrefabEditSessionRows`: the editor restarted). */
const openSession = async () => {
  _resetPrefabEditSessionRows();
  useEditorStore.setState({ editingPrefab: { guid: P, name: 'P', path: '/prefabs/P.prefab.json' } });
  await load(buildPrefabEditScene(doc() as never));
  return getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!.id;
};

describe('#1774: a number freed at the top of the numbering is never handed out again', () => {
  afterAll(() => { useEditorStore.setState({ editingPrefab: null }); });

  /** The #1774 repro. Red before the counter: C takes 3, derives B's guid, and the reopened scene's B-guid names C. */
  it('delete the top row and save; a LATER session adds a row — it does not take the freed number, and B\'s guid names nothing', async () => {
    install(p3Doc());
    await load(sceneOfP());
    const bGuid = guidOf('B');

    await openSession();
    deleteEntitiesWithUndo([one('B')]);
    expect((await savePrefabEditReport()).saved).toBe(true);
    expect(doc().entities.map((e) => [e.name, e.localId])).toEqual([['R', 1], ['A', 2]]);

    const root = await openSession();
    add('Add C', root, 'C');
    expect((await savePrefabEditReport()).saved).toBe(true);
    const c = doc().entities.find((e) => e.name === 'C')!;
    expect(c.localId).toBe(4);
    expect(doc().nextLocalId).toBe(5);

    await load(sceneOfP());
    expect(getAllEntities().filter((e) => e.guid === bGuid).map((e) => e.name)).toEqual([]);
  });
});

/** The guard (#1774): every writer that MINTS a localId numbers at or above the document's high-water mark. Each case
 *  hands its writer a document whose mark (9) sits above its rows (R 1, A 2, B 3) — numbers 4..8 were used and freed by
 *  earlier writes — and adds one node. A writer that seeds from the rows it can see (its old code) writes the node at 4:
 *  red. Each case names the mutation that turned it red. */
describe('#1774 guard: every minting writer numbers above the mark, and states it', () => {
  const PPATH = '/prefabs/P.prefab.json';
  const marked = () => ({ ...p3Doc(), nextLocalId: 9 });
  const onDiskDoc = () => JSON.parse(onDisk.get(PPATH)!) as PrefabFile;
  const lids = (d: PrefabFile) => Object.fromEntries(d.entities.map((e) => [e.name, e.localId]));
  const seat = () => { install(marked()); onDisk.set(PPATH, JSON.stringify(marked())); registerAsset(P, PPATH, 'prefab'); };
  afterAll(() => { useEditorStore.setState({ editingPrefab: null }); });

  it('prefab-edit save (the session floor) — mutation: seed `usedUpTo` from the highest row', async () => {
    seat();
    const root = await openSession();
    add('Add C', root, 'C');
    expect((await savePrefabEditReport()).saved).toBe(true);
    expect(lids(doc())).toEqual({ R: 1, A: 2, B: 3, C: 9 });
    expect(doc().nextLocalId).toBe(10);
  });

  it('Create Prefab → Replace (`replaceNumbering`) — mutation: seed `next` from the replaced rows', async () => {
    seat();
    await load(sceneOfP());
    const inst = getAllEntities().find((e) => e.guid === INST)!.id;
    add('Add X', inst, 'X');
    const res = await createPrefabFromEntity(inst, PPATH, 'Create Prefab "P"', async () => true);
    if (!res || res === 'declined' || 'refused' in res) throw new Error(`fixture: ${JSON.stringify(res)}`);
    expect(lids(onDiskDoc())).toEqual({ R: 1, A: 2, B: 3, X: 9 });
    expect(onDiskDoc().nextLocalId).toBe(10);
  });

  it('the agent `prefab create` over an existing path (the same `replacing`) — mutation: `parsedPrefabRows` drops the mark', async () => {
    const { registerEditorAgentOps } = await import('../../app/editor/agentEditorOps');
    const { runAgentOp } = await import('../../app/debug/agentBridge');
    registerEditorAgentOps();
    seat();
    setPrefabCache(P, null);
    await load({ id: 'a', version: 16, name: 'S', resources: [], entities: [] } as unknown as SceneData);
    const root = add('Add R', 0, 'R');
    for (const n of ['A', 'B', 'New']) add(`Add ${n}`, root, n);
    await runAgentOp('prefab', { action: 'create', entityGuid: getAllEntities().find((e) => e.id === root)!.guid, path: PPATH, replace: true });
    expect(lids(onDiskDoc())).toEqual({ R: 1, A: 2, B: 3, New: 9 });
    expect(onDiskDoc().nextLocalId).toBe(10);
  });

  it('Apply\'s promotion of an added node (`planApply`) — mutation: seed `nextLocalId.v` from the rows', async () => {
    seat();
    await load(sceneOfP());
    const inst = getAllEntities().find((e) => e.guid === INST)!.id;
    add('Add Extra', inst, 'Extra');
    const keys = collectInstanceOverrideKeys(inst, getCachedPrefabSync(P) as PrefabFile);
    const res = await applyToPrefabSelective(inst, new Set(keys.added));
    expect(res.promotedAdditions).toBe(1);
    expect(lids(onDiskDoc())).toEqual({ R: 1, A: 2, B: 3, Extra: 9 });
    expect(onDiskDoc().nextLocalId).toBe(10);
  });

  it('a rigged re-import (`mergeRiggedPrefab`) — mutation: seed `nextId` from both sides\' rows', () => {
    const bone = (localId: number, name: string, parentId: number) =>
      ({ localId, name, traits: { EntityAttributes: { name, parentId, guid: '' }, Bone: { name } } });
    const existing = { id: P, version: 7, name: 'Rig', rootLocalId: 1, nextLocalId: 9, entities: [
      { localId: 1, name: 'Rig', traits: { EntityAttributes: { name: 'Rig', parentId: 0, guid: '' } } }, bone(2, 'Hip', 1), bone(3, 'Spine', 2),
    ] } as unknown as PrefabFile;
    const fresh = { id: P, version: PREFAB_FORMAT_VERSION, name: 'Rig', rootLocalId: 1, nextLocalId: 5, entities: [
      { localId: 1, name: 'Rig', traits: { EntityAttributes: { name: 'Rig', parentId: 0, guid: '' } } }, bone(2, 'Hip', 1), bone(3, 'Spine', 2), bone(4, 'Tail', 2),
    ] } as unknown as PrefabFile;
    const merged = mergeRiggedPrefab(fresh, existing);
    expect(lids(merged)).toEqual({ Rig: 1, Hip: 2, Spine: 3, Tail: 9 });
    expect(merged.nextLocalId).toBe(10);
  });

  it('accept side: a file with no mark (before v8) derives it from its highest row', async () => {
    install(p3Doc());
    const root = await openSession();
    add('Add C', root, 'C');
    expect((await savePrefabEditReport()).saved).toBe(true);
    expect(lids(doc())).toEqual({ R: 1, A: 2, B: 3, C: 4 });
    expect(doc().nextLocalId).toBe(5);
  });
});

/** The chokepoint (#1774): `commitPrefabWrites` never lets a write LOWER the mark of the document it lands over — the
 *  line under every writer, including an undo. */
describe('#1774: commitPrefabWrite keeps the mark from going down', () => {
  const PPATH = '/prefabs/P.prefab.json';
  /** P3 as the serializer writes it since v8: the mark right after `rootLocalId`. */
  const v8 = (mark: number) => {
    const { id, name, rootLocalId, entities } = p3Doc();
    return { id, version: PREFAB_FORMAT_VERSION, name, rootLocalId, nextLocalId: mark, entities } as PrefabFile;
  };
  const seatAt = (d: PrefabFile) => { install(d); onDisk.set(PPATH, jsonFileBody(d)); registerAsset(P, PPATH, 'prefab'); };

  it('a document written with a lower mark, or none, lands at the mark it replaces — mutation: `contentFor` returns the bytes as built', async () => {
    seatAt(v8(9));
    const { nextLocalId: _drop, ...none } = v8(9);
    expect((await commitPrefabWrite(P, none as PrefabFile, { expected: v8(9) })).ok).toBe(true);
    expect((JSON.parse(onDisk.get(PPATH)!) as PrefabFile).nextLocalId).toBe(9);
    expect((await commitPrefabWrite(P, v8(4), { expected: v8(9) })).ok).toBe(true);
    expect((JSON.parse(onDisk.get(PPATH)!) as PrefabFile).nextLocalId).toBe(9);
    expect(getCachedPrefabSync(P)?.nextLocalId, 'the cache holds the mark written').toBe(9);
  });

  it('an undo putting back bytes that would lower the mark writes them re-serialized, equal to the verbatim bytes except the mark', async () => {
    // Mutation: keep `bytes` whatever they lower (`if (bytes !== undefined) return bytes`) — the mark goes back to 4: red.
    seatAt(v8(9));
    const verbatim = jsonFileBody(v8(4)); // what an undo recorded before the write that raised the mark
    expect((await commitPrefabWrite(P, v8(4), { expected: jsonFileBody(v8(9)), bytes: verbatim })).ok).toBe(true);
    const written = onDisk.get(PPATH)!;
    expect(written).not.toBe(verbatim);
    const lines = (t: string) => t.split('\n');
    const differ = lines(written).map((l, i) => [l, lines(verbatim)[i]]).filter(([a, b]) => a !== b);
    expect(differ).toEqual([['  "nextLocalId": 9,', '  "nextLocalId": 4,']]);
  });

  it('a raise into hand-formatted bytes (one line, a BOM, an older version, no mark) changes only the mark and the version', async () => {
    // Mutation: re-serialize instead of splicing (`withTopLevelNumbers` returns null) — the whole file is reformatted: red.
    seatAt(v8(9));
    const old = { ...p3Doc(), version: 5 };
    const compact = `\uFEFF${JSON.stringify(old)}\n`;
    expect((await commitPrefabWrite(P, JSON.parse(JSON.stringify(old)) as PrefabFile, { expected: jsonFileBody(v8(9)), bytes: compact })).ok).toBe(true);
    expect(onDisk.get(PPATH)).toBe(compact.replace('{"id"', '{"nextLocalId":9,"id"').replace('"version":5', `"version":${LOCAL_ID_MARK_VERSION}`));
  });

  it('bytes the splice cannot address exactly (a key spelled twice) are re-serialized with the raised mark instead', async () => {
    seatAt(v8(9));
    const old = { ...p3Doc(), version: 5, entities: [{ ...p3Doc().entities[0]!, traits: { ...p3Doc().entities[0]!.traits, Tag: { version: 1 } } }, ...p3Doc().entities.slice(1)] };
    const compact = `${JSON.stringify(old)}\n`;
    const doc = JSON.parse(JSON.stringify(old)) as PrefabFile;
    expect((await commitPrefabWrite(P, doc, { expected: jsonFileBody(v8(9)), bytes: compact })).ok).toBe(true);
    expect(onDisk.get(PPATH)).toBe(jsonFileBody(doc));
    expect(JSON.parse(onDisk.get(PPATH)!)).toMatchObject({ nextLocalId: 9, version: LOCAL_ID_MARK_VERSION });
  });

  it('a write the route refuses for a LOWER mark re-reads the file and lands raised to it, when the file is the document read', async () => {
    // Review finding 1. Mutation: count `prefab-mark-lowered` as an ordinary error in `post()` — the write is refused.
    const doc4 = { ...v8(4) };
    const after = { ...v8(5), entities: [...p3Doc().entities, row(4, 'E1', 1, 'eeeeeeee-0000-4000-8000-0000001774e1')] } as PrefabFile;
    seatAt({ ...after, nextLocalId: 6 } as PrefabFile); // a later write's undo already raised the mark past what `after` says
    expect((await commitPrefabWrite(P, doc4, { expected: after })).ok).toBe(true);
    expect(JSON.parse(onDisk.get(PPATH)!)).toMatchObject({ nextLocalId: 6, entities: p3Doc().entities.map((e) => ({ localId: e.localId })) });
  });

  // #1880, seed 1099: an outside edit added row 5 and left the stated mark at 5; the next editor write restates it above
  // every row. Mutation: drop `stale` from `contentFor`'s early return — the file keeps `nextLocalId: 5`.
  it('a write of a document whose stated mark is not above its highest row states the mark above it', async () => {
    const outside = { ...v8(5), entities: [...p3Doc().entities, row(5, 'E5', 1, 'eeeeeeee-0000-4000-8000-000000001099')] } as PrefabFile;
    seatAt(outside);
    expect((await commitPrefabWrite(P, JSON.parse(JSON.stringify(outside)) as PrefabFile, { expected: outside })).ok).toBe(true);
    expect((JSON.parse(onDisk.get(PPATH)!) as PrefabFile).nextLocalId).toBe(6);
  });

  it('a mark raised into a document from before v8 claims v8, and sits where the serializer writes it', async () => {
    // Review finding 4. Mutations: drop the version claim — `version` stays 5 (an older build could save over it and drop
    // the mark); drop `placeMarkAfterRoot` — the key lands after `entities`.
    seatAt(v8(9));
    const old = { ...p3Doc(), version: 5 } as PrefabFile;
    expect((await commitPrefabWrite(P, old, { expected: v8(9) })).ok).toBe(true);
    const { id, name, rootLocalId, entities } = p3Doc();
    expect(onDisk.get(PPATH)).toBe(jsonFileBody({ id, version: LOCAL_ID_MARK_VERSION, name, rootLocalId, nextLocalId: 9, entities } as never));
  });

  it('a redo handed the SAME document and recorded bytes lands every time, however often an earlier call raised it', async () => {
    // Close-out re-review finding 1. Mutation: judge the raise on `doc` instead of the bytes written — the second redo
    // sends the recorded bytes' lower mark, is refused, and the fallback sends them again: a false "changed on disk".
    const prev = v8(4);
    const prevBytes = jsonFileBody(prev);
    seatAt(prev);
    const prefab = { ...v8(5), entities: [...p3Doc().entities, row(4, 'C', 1, 'eeeeeeee-0000-4000-8000-0000001774c1')] } as PrefabFile;
    const content = jsonFileBody(prefab);
    expect((await commitPrefabWrite(P, prefab, { expected: prev, bytes: content })).ok).toBe(true);
    const undoOnce = async () => expect((await commitPrefabWrite(P, JSON.parse(prevBytes) as PrefabFile, { expected: onDisk.get(PPATH)!, bytes: prevBytes })).ok).toBe(true);
    await undoOnce();
    onDisk.set(PPATH, jsonFileBody({ ...JSON.parse(onDisk.get(PPATH)!), nextLocalId: 7 })); // a later minting write, undone
    for (let i = 0; i < 2; i++) {
      expect((await commitPrefabWrite(P, prefab, { expected: prevBytes, bytes: content })).ok, `redo ${i + 1}`).toBe(true);
      expect((JSON.parse(onDisk.get(PPATH)!) as PrefabFile).nextLocalId).toBe(7);
      await undoOnce();
    }
  });

  it('a raise the fallback has to make a SECOND time still claims v8 in the bytes', async () => {
    // Close-out re-review finding 2. Mutation: read the claim off `doc` (already raised to v8 by the first attempt) — the
    // retry writes the mark into bytes that still say version 5.
    const e = { ...v8(5), entities: [...p3Doc().entities, row(4, 'E', 1, 'eeeeeeee-0000-4000-8000-0000001774e9')] } as PrefabFile;
    seatAt({ ...e, nextLocalId: 7 } as PrefabFile);
    const b = `${JSON.stringify({ ...p3Doc(), version: 5 })}\n`;
    expect((await commitPrefabWrite(P, JSON.parse(b) as PrefabFile, { expected: jsonFileBody(e), bytes: b })).ok).toBe(true);
    expect(JSON.parse(onDisk.get(PPATH)!)).toMatchObject({ nextLocalId: 7, version: LOCAL_ID_MARK_VERSION });
  });

  // #1933 S5: a number a loaded record names is reserved in memory, and in no file yet. The commit judges "the file
  // already holds the mark" by what the WRITTEN document states, so the reservation is persisted by any write — here an
  // undo putting back a pre-v8 file verbatim. Mutation: judge by `localIdCounter(written)` in `contentFor` (it counts the
  // reservation) — the bytes go down with no mark, and a later session that never loads the scene hands 4 out again.
  it('a reserved number is stated by the next write, an undo\'s verbatim bytes of a pre-v8 file included', async () => {
    const pre = p3Doc() as unknown as PrefabFile; // rows 1..3, v5, no mark
    seatAt(pre);
    reserveLocalId(P, 4);
    const verbatim = jsonFileBody(pre);
    expect((await commitPrefabWrite(P, p3Doc() as unknown as PrefabFile, { expected: verbatim, bytes: verbatim })).ok).toBe(true);
    expect((JSON.parse(onDisk.get(PPATH)!) as PrefabFile).nextLocalId).toBe(5);
  });

  // …and when nothing else knows a mark: a trashed prefab put back by its undo is a create (no file, no editor, no park,
  // no expected document), so the reservation is the only source of the number. Mutation: drop the written document's
  // own counter from `contentFor`'s need — the bytes go down with no mark.
  it('a reserved number is stated by a create that restores a pre-v8 file, where no file or editor holds a mark', async () => {
    install(p3Doc() as unknown as PrefabFile);
    registerAsset(P, PPATH, 'prefab');
    onDisk.delete(PPATH); setPrefabCache(P, null); // trashed: the file and the editor's copy are gone
    reserveLocalId(P, 4);
    const verbatim = jsonFileBody(p3Doc() as unknown as PrefabFile);
    expect((await commitPrefabWrite(P, p3Doc() as unknown as PrefabFile, { expected: null, bytes: verbatim })).ok).toBe(true);
    expect((JSON.parse(onDisk.get(PPATH)!) as PrefabFile).nextLocalId).toBe(5);
  });

  it('accept side: bytes that lower nothing are written verbatim, formatting and all', async () => {
    seatAt(v8(4));
    const handFormatted = `${JSON.stringify(v8(9))}\n`; // one line, as no editor writes it
    expect((await commitPrefabWrite(P, v8(9), { expected: jsonFileBody(v8(4)), bytes: handFormatted })).ok).toBe(true);
    expect(onDisk.get(PPATH)).toBe(handFormatted);
  });
});

/** A multi-file commit that fails part-way puts the files it already wrote back (#1692's rollback). The first file's
 *  write raised its mark, so its prior bytes would LOWER it, which the route refuses (#1774) — the rollback keeps the
 *  mark instead. Mutation: roll back with the prior bytes verbatim — the put-back is refused and the file is stranded. */
describe('#1774: a failed multi-file commit rolls back without lowering the mark', () => {
  it('the first file is put back with the mark its write raised, and nothing is stranded', async () => {
    const Q = 'cccccccc-0000-4000-8000-000000177499';
    const PP = '/prefabs/P.prefab.json';
    const QP = '/prefabs/Q.prefab.json';
    const p0 = { ...p3Doc(), nextLocalId: 4 } as PrefabFile;
    const q0 = { id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000177491')] } as PrefabFile;
    install(p0, q0);
    onDisk.set(PP, jsonFileBody(p0)); registerAsset(P, PP, 'prefab');
    onDisk.set(QP, jsonFileBody(q0)); registerAsset(Q, QP, 'prefab');
    const p1 = JSON.parse(JSON.stringify(p0)) as PrefabFile;
    p1.entities.push(row(4, 'New', 1, 'eeeeeeee-0000-4000-8000-000000177414') as never);
    p1.nextLocalId = 5;
    failWrite.add(QP);
    const res = await commitPrefabWrites([
      { source: P, doc: p1, expected: p0 },
      { source: Q, doc: { ...q0, name: 'Q2' }, expected: q0 },
    ]);
    expect(res.ok).toBe(false);
    expect(res.stranded ?? []).toEqual([]);
    const back = JSON.parse(onDisk.get(PP)!) as PrefabFile;
    expect(back.entities.map((e) => e.name)).toEqual(['R', 'A', 'B']);
    expect(back.nextLocalId).toBe(5);
  });
});

/** Review finding 1, driven the way it was found: two Applies that each promote a node, then undo both. Since #1868 the
 *  undos restore the prefab in memory and park it, so the mark question moved to Save: the parked document predates both
 *  Applies, and its write must not LOWER the mark they raised the file to (the flush's commit raises it from the file). */
describe('#1774: undoing two minting Applies in a row lands both, and Save keeps the mark', () => {
  const PPATH = '/prefabs/P.prefab.json';
  it('Apply E1, Apply E2, undo, undo — every step lands, and the mark never goes down', async () => {
    install(p3Doc());
    onDisk.set(PPATH, JSON.stringify(p3Doc()));
    registerAsset(P, PPATH, 'prefab');
    await load(sceneOfP());
    const inst = () => getAllEntities().find((e) => e.guid === INST)!.id;
    const applyNew = async (name: string) => {
      add(`Add ${name}`, inst(), name);
      const keys = collectInstanceOverrideKeys(inst(), getCachedPrefabSync(P) as PrefabFile);
      expect((await applyToPrefabWithUndo(inst(), new Set(keys.added))).promotedAdditions).toBe(1);
    };
    await applyNew('E1');
    await applyNew('E2');
    const mark = (JSON.parse(onDisk.get(PPATH)!) as PrefabFile).nextLocalId!;
    const error = vi.spyOn(console, 'error');
    try {
      for (let i = 0; i < 4; i++) await undo();
      expect(error.mock.calls.map((c) => String(c[0])).filter((m) => /REFUSED|could not be written/.test(m))).toEqual([]);
    } finally { error.mockRestore(); }
    expect((peekDirtyAsset(PPATH)?.data as PrefabFile | undefined)?.entities.map((e) => e.name)).toEqual(['R', 'A', 'B']);
    // Save writes the parked document over the file the two Applies left, with their mark kept.
    expect((await flushDirtyAssets()).failed).toEqual([]);
    const saved = JSON.parse(onDisk.get(PPATH)!) as PrefabFile;
    expect(saved.entities.map((e) => e.name)).toEqual(['R', 'A', 'B']);
    expect(saved.nextLocalId).toBe(mark);
  });

  // #1877 S1: a Save BETWEEN the two undos wrote the first undo's raised mark to the file; the second undo stated the
  // mark its step recorded — lower — and the next Apply handed E2's number to a new row. Mutation (re-run #1933): the park
  // landing's mark is `counterOf(p.from)` alone (prefabCommit.ts). Dropping one term is not enough: the editor's copy,
  // the file and the session record (`recordedMark`) each carry the raised mark.
  it('Apply E1, Apply E2, undo, Save, undo, undo, Apply E3 — E3 does not take the number E2 had', async () => {
    install(p3Doc());
    onDisk.set(PPATH, JSON.stringify(p3Doc()));
    registerAsset(P, PPATH, 'prefab');
    await load(sceneOfP());
    const inst = () => getAllEntities().find((e) => e.guid === INST)!.id;
    // Every added node the instance holds: after the undos E1 is one again, so E3's Apply promotes both.
    const applyNew = async (name: string, promoted = 1) => {
      add(`Add ${name}`, inst(), name);
      const keys = collectInstanceOverrideKeys(inst(), getCachedPrefabSync(P) as PrefabFile);
      expect((await applyToPrefabWithUndo(inst(), new Set(keys.added))).promotedAdditions).toBe(promoted);
    };
    const file = () => JSON.parse(onDisk.get(PPATH)!) as PrefabFile;
    await applyNew('E1');
    await applyNew('E2');
    const e2 = file().entities.find((e) => e.name === 'E2')!.localId;
    await undo(); // Apply E2
    expect((await flushDirtyAssets()).failed).toEqual([]); // Cmd+S
    const savedMark = file().nextLocalId!;
    expect(savedMark).toBeGreaterThan(e2);
    await undo(); // Add E2
    await undo(); // Apply E1
    expect((peekDirtyAsset(PPATH)?.data as PrefabFile | undefined)?.nextLocalId).toBe(savedMark);
    await applyNew('E3', 2);
    expect(file().entities.filter((e) => e.localId === e2).map((e) => e.name)).toEqual([]);
    expect(file().nextLocalId).toBeGreaterThanOrEqual(savedMark);
  });
});
