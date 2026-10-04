/** #2046 S7.3 (hub ruling 2026-10-03, hunt seed 7529's Inspector form): an Apply's record-path undo and redo restore EVERY
 *  other tree its fan-out reached from that side's records, as the snapshot path's reload of the pre-Apply file does — and
 *  only those. The set is fixed at Apply time: the instances of a document the Apply wrote, in the applying scene. An
 *  instance placed after the Apply, or one of another scene, keeps whatever its records became.
 *
 *  Each case puts a marker into a record after the Apply (a pin's `name`, as a load re-parsing a file the Apply wrote puts
 *  a member's pin there), then undoes the Apply and asks which records still hold it.
 *
 *  Mutation, checked: `fannedTrees` returning [] — the fanned instance keeps its marker, and the LIFO case's record
 *  differs from its pre-Apply one. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

/** The fake route's disk and switches. */
const fs = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  /** Every write the route was asked for, refused or not. */
  posts: [] as Array<{ path: string; content: string; ifMatch?: string }>,
  /** The next write fails as a backend error would (#1668). */
  fail: false,
  /** The next write is refused by the #1468 format gate, which runs BEFORE the if-match check. */
  tooNew: false,
  /** When set, every write waits for it — a write held in flight (#1667). */
  gate: null as Promise<void> | null,
  /** Writes waiting on `gate`. */
  waiting: 0,
}));
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string, _enc?: string, opts?: { ifMatch?: string }) => {
    if (fs.gate) { fs.waiting++; await fs.gate; fs.waiting--; }
    fs.posts.push({ path, content, ifMatch: opts?.ifMatch });
    const answer = (status: number, body: object) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
    if (fs.fail) { fs.fail = false; return answer(500, { error: 'the disk is full' }); }
    if (fs.tooNew) { fs.tooNew = false; return answer(409, { ok: false, conflict: true, reason: 'prefab-format-too-new', error: 'a newer build wrote this prefab' }); }
    if (opts?.ifMatch !== undefined) {
      const cur = fs.disk.get(path);
      const hash = cur === undefined ? null : createHash('sha256').update(cur).digest('hex');
      if (hash !== opts.ifMatch) return answer(409, { ok: false, conflict: true, reason: 'if-match' });
    }
    fs.disk.set(path, content);
    return answer(200, { ok: true });
  },
}));

/** A titled scene: the restore reloads it under its path and saves it. Loads and saves are counted. */
const sm = vi.hoisted(() => ({
  path: 'scenes/Level.json' as string | null,
  load: null as null | ((data: unknown) => Promise<void>),
  loads: 0,
  saves: 0,
}));
vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    sceneManager: {
      // A swap's copy carry (#1939): this fake world holds no scene copies.
      captureSceneCopies: () => new Map(),
      getCurrent: () => (sm.path === null ? null : { path: sm.path }),
      getNext: () => null,
      getLoadedScenes: () => new Map(),
      getCurrentBaseScene: () => undefined,
      loadScene: async (path: string, opts?: { preloaded?: unknown }) => {
        sm.loads++;
        await sm.load!(opts!.preloaded);
        sm.path = path;
        return { world: (await import('../../packages/modoki/src/runtime/core/ecs/world')).getCurrentWorld(), keptBaseGuids: new Set<string>() };
      },
    },
  };
});
vi.mock('../../packages/modoki/src/editor/scene/serialize', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveScene: async () => { sm.saves++; return { saved: true, reason: 'ok' }; },
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, readTraitData, loadSceneFile, instantiatePrefabIntoWorld,
  destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction } from '@modoki/engine/editor';
import { setRunMode } from '../../packages/modoki/src/runtime/core/playState';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache, getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { jsonFileBody } from '../../packages/modoki/src/editor/backend/editorBackend';
import { setCurrentScenePath } from '../../packages/modoki/src/editor/scene/serialize';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { undo, redo, swapHistory, _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';
import { writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { storedRecord, setInstanceRecord } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { recordForWrite } from '../../packages/modoki/src/editor/instance/instanceSync';
import { clearDirtyAssets } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { place as seatInstance } from '../../packages/modoki/src/editor/instance/instanceEdits';
import { deriveInstanceMemberGuids } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';

registerAllTraits();
setActionCallback(pushAction);
// `setCurrentScenePath` remembers a real path in localStorage, which the node environment lacks.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const P = 'aaaaaaaa-0000-4000-8000-000000007529';
const G = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROOT = G(21);
/** Reached by the fan-out; placed after the Apply; of another scene. */
const ROOT2 = G(22), ROOT3 = G(23), ROOT4 = G(24);

const row = (localId: number, nodeGuid: string, name: string, parentId: number) => ({
  localId, nodeGuid, name,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const pDoc = () => ({ id: P, version: 6, name: 'P', rootLocalId: 1, entities: [row(1, G(1), 'PRoot', 0), row(2, G(2), 'Box', 1)] });
const install = (doc: object) => { prefabs.set(P, doc); setPrefabCache(P, doc as never); };

async function load(scene: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(scene)), {
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
sm.load = (data) => load(data as SceneData);

const all = () => getAllEntities();
const parentOf = (id: number) => all().find((e) => e.id === id)?.parentId ?? 0;
const rootId = () => all().find((e) => e.guid === ROOT)!.id;
const box = () => {
  const root = rootId();
  return all().find((e) => e.name === 'Box' && parentOf(e.id) === root)!.id;
};
const toast = vi.fn();

const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};

/** Set Box's `field` on the instance to `v`, and Apply exactly that field. */
async function applyBox(field: 'x' | 'y', v: number) {
  writeTraitFieldWithUndo(box(), getTraitByName('Transform')!, field, v);
  const keys = collectInstanceOverrideKeys(rootId(), getCachedPrefabSync(P) as PrefabFile);
  const res = await quietly(() => applyToPrefabWithUndo(rootId(), new Set(keys.fields.filter((k) => k.endsWith(`.Transform.${field}`)))));
  expect(res.applied, JSON.stringify(keys)).toBe(true); // precondition
}

beforeEach(() => {
  clearDirtyAssets(); // a document an undo parked (#1868) belongs to its own case
  setRunMode('stopped');
  _resetHistoryContexts();
  swapHistory('scenes/Level.json');
  prefabs.clear();
  install(pDoc());
  fs.disk.clear();
  // The prefab is ON DISK before anything runs, as it is in the editor: the forward Apply is conditional on the document
  // it read (#1692, I10), and a file that is not there is not what it read.
  fs.disk.set(P, jsonFileBody(pDoc()));
  fs.posts.length = 0;
  fs.fail = false;
  fs.tooNew = false;
  fs.gate = null;
  fs.waiting = 0;
  sm.path = 'scenes/Level.json';
  sm.loads = 0;
  sm.saves = 0;
  toast.mockReset();
  useEditorStore.setState({ showToast: toast } as never);
  setCurrentScenePath('scenes/Level.json');
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  const id = instantiatePrefabIntoWorld(getCurrentWorld(), pDoc() as never, 0, undefined, P);
  for (const e of getCurrentWorld().entities) if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid: ROOT });
  deriveInstanceMemberGuids(getCurrentWorld()); seatInstance(id!); // placed as a drop places it (#2001 S8b)
});


/** Place another instance of P, its root carrying `guid` (and `scene` as its `sourceScene`). */
function place(guid: string, scene = ''): void {
  const eaMeta = getTraitByName('EntityAttributes')!;
  const id = instantiatePrefabIntoWorld(getCurrentWorld(), getCachedPrefabSync(P) as never, 0, undefined, P);
  for (const e of getCurrentWorld().entities) if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid, sourceScene: scene });
  deriveInstanceMemberGuids(getCurrentWorld()); seatInstance(id!); // placed as a drop places it (#2001 S8b)
}
const rootOf = (guid: string) => all().find((e) => e.guid === guid)!.id;
const boxOf = (guid: string) => { const r = rootOf(guid); return all().find((e) => e.name === 'Box' && parentOf(e.id) === r)!.id; };
const tfOf = (guid: string) => readTraitData(boxOf(guid), getTraitByName('Transform')!) as { x: number; y: number };
/** `guid`'s record, re-seeded where stale (fresh), as a step that reads it would find it. */
const recordOf = (guid: string) => structuredClone(recordForWrite(rootOf(guid), guid, getCurrentWorld()));
/** Put a marker into `guid`'s record: Box's pin carries a name, as a load re-parsing a file the Apply wrote puts it there. */
function mark(guid: string): void {
  const rec = recordForWrite(rootOf(guid), guid, getCurrentWorld())!;
  const rows = new Map(rec.list.rows);
  rows.set(`/${G(2)}` as never, { ...(rows.get(`/${G(2)}` as never) ?? {}), name: 'Marker' });
  setInstanceRecord(getCurrentWorld(), { ...rec, list: { ...rec.list, rows } });
}
const marked = (guid: string) => (storedRecord(getCurrentWorld(), guid)?.list.rows.get(`/${G(2)}` as never) as { name?: string } | undefined)?.name === 'Marker';

describe('an Apply undo restores the trees its fan-out reached, and only those (#2046 S7.3)', () => {
  it('the fanned instance takes its pre-Apply record; one placed after the Apply, and one of another scene, keep theirs', async () => {
    place(ROOT2);
    place(ROOT4, 'dddddddd-0000-4000-8000-0000000another');
    const before2 = recordOf(ROOT2);
    await applyBox('x', 5);
    expect(tfOf(ROOT2).x, 'premise: the fan-out reached ROOT2').toBe(5);
    place(ROOT3);
    for (const g of [ROOT2, ROOT3, ROOT4]) mark(g);
    expect([ROOT2, ROOT3, ROOT4].every(marked), 'premise: every record holds the marker').toBe(true);

    await quietly(() => undo());
    expect(sm.loads, 'the record path, not the snapshot reload').toBe(0);
    expect(storedRecord(getCurrentWorld(), ROOT2)).toEqual(before2);
    expect(tfOf(ROOT2).x).toBe(0);
    expect(marked(ROOT3), 'placed after the Apply: not in its set').toBe(true);
    expect(marked(ROOT4), 'another scene: not in its set').toBe(true);
    expect(tfOf(ROOT3).x, 'still rebased onto the restored template').toBe(0);
  });

  it('a stack edit to the fanned instance after the Apply is undone first, and redone last: it is kept', async () => {
    place(ROOT2);
    const before2 = recordOf(ROOT2);
    await applyBox('x', 5);
    writeTraitFieldWithUndo(boxOf(ROOT2), getTraitByName('Transform')!, 'y', 7);
    const after2 = recordOf(ROOT2);

    await quietly(() => undo()); // the y edit
    await quietly(() => undo()); // the Apply
    expect(tfOf(ROOT2)).toMatchObject({ x: 0, y: 0 });
    expect(storedRecord(getCurrentWorld(), ROOT2)).toEqual(before2);

    await quietly(() => redo()); // the Apply
    await quietly(() => redo()); // the y edit
    expect(tfOf(ROOT2)).toMatchObject({ x: 5, y: 7 });
    expect(storedRecord(getCurrentWorld(), ROOT2)).toEqual(after2);
  });
});
