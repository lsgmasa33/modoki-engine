/** #1664 + #1668 — Apply's undo and redo write the prefab file only over the other side of the Apply, and a write that
 *  does not land changes nothing.
 *
 *  The prefab file is global, and an Apply's undo entry outlives edits made elsewhere: a prefab-edit save, another
 *  scene's Apply, a `git pull`. Undo used to write the pre-Apply document over whatever the file had become (#1664),
 *  and redo then brought back only the Apply, so the later edit was unrecoverable. It also seeded the editor cache
 *  before the write and ignored the result (#1668), so a failed write rebuilt the world against a document the disk
 *  did not hold.
 *
 *  Driven through the real Apply, undo manager and `commitPrefabWrite` (#1692). Only the route is
 *  a fake: a disk keyed by the path `postWriteFile` received, holding exactly the bytes it received, with
 *  `/api/write-file`'s own if-match rule (`ifMatchRefusal`, editorBackendRouter.ts): refuse with 409
 *  `reason:'if-match'` unless the sha256 of the stored bytes equals `ifMatch`. The accept side therefore compares the
 *  hash the undo sent against the bytes the Apply really wrote, not against a recomputation of them.
 *
 *  Mutations, each checked:
 *  - drop the `ifMatch` from `commitPrefabWrite`'s write: the #1664 case goes red.
 *  - ignore the write result (do not throw) there: the #1668 case goes red.
 *  - serialize the Apply's write differently from the undo's hash (one path only): the accept cases go red.
 *  - treat every 409 as the if-match refusal: the format-gate case goes red.
 *  - let a hash failure throw as it comes: the hash case goes red.
 *  - let a refused step mark the world edited (`runStep`): the refusal and hash cases go red.
 *  - mint an id-less file's id on `newPrefab` alone: the id-less case goes red.
 *  - let a refused step mark its affected scenes dirty: the base-scene case goes red. */

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
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, loadSceneFile, instantiatePrefabIntoWorld,
  destroyEntity, Transform, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction } from '@modoki/engine/editor';
import { setRunMode } from '../../packages/modoki/src/runtime/core/playState';
import { setPrefabCache, getCachedPrefabSync, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { commitPrefabWrite } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { jsonFileBody } from '../../packages/modoki/src/editor/backend/editorBackend';
import { setCurrentScenePath } from '../../packages/modoki/src/editor/scene/serialize';
import { dirtySceneGuidsSnapshot, clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { undo, redo, peekUndo, canRedo, swapHistory, _resetHistoryContexts, getEditVersion, beginWorldSwitch } from '../../packages/modoki/src/editor/undo/undoManager';
import { writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);
// `setCurrentScenePath` remembers a real path in localStorage, which the node environment lacks.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const P = 'aaaaaaaa-0000-4000-8000-000000001664';
const G = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROOT = G(21);
/** A base scene's guid, for an instance that came from one (#1431). */
const BASE = 'bbbbbbbb-0000-4000-8000-000000001664';

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
const boxInCache = () => (getCachedPrefabSync(P) as PrefabFile).entities.find((e) => e.name === 'Box')!.traits.Transform as { x: number; y: number };
/** The ONE path the fake disk holds for P — whatever `commitPrefabWrite` resolved the guid to (P itself: it is not in
 *  the manifest). */
const onDisk = () => {
  const paths = [...new Set(fs.posts.map((p) => p.path))];
  expect(paths).toHaveLength(1); // precondition: every write went to one file
  return fs.disk.get(paths[0]!)!;
};
const boxOnDisk = () => (JSON.parse(onDisk()) as PrefabFile).entities.find((e) => e.name === 'Box')!.traits.Transform as { x: number; y: number };
const toast = vi.fn();
/** A later write of the template from somewhere else — a prefab-edit save goes through the same step. */
const laterSave = (doc: PrefabFile) => commitPrefabWrite(P, doc, { expected: getCachedPrefabSync(P) as PrefabFile, rebase: false });

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
});

describe('Apply undo/redo writes the prefab only over the other side of the Apply (#1664)', () => {
  it('accept side: undo and redo round-trip the file when nothing else wrote it', async () => {
    await applyBox('x', 5);
    const applied = onDisk();
    expect(boxOnDisk().x).toBe(5); // precondition: the Apply wrote

    await quietly(() => undo());
    // The undo's precondition was the hash of the bytes the Apply's write carried, so it wrote.
    expect(fs.posts.at(-1)!.ifMatch).toBe(createHash('sha256').update(applied).digest('hex'));
    expect(boxOnDisk().x).toBe(0);
    expect(boxInCache().x).toBe(0);
    expect(canRedo()).toBe(true);
    expect(toast).not.toHaveBeenCalled();

    await quietly(() => redo());
    expect(boxOnDisk().x).toBe(5);
    expect(boxInCache().x).toBe(5);
    expect(xOf(box())).toBe(5);
    expect(toast).not.toHaveBeenCalled();
  });

  it('accept side: two Applies undo in order, each over the one after it', async () => {
    await applyBox('x', 5);
    await applyBox('y', 3);
    expect(boxOnDisk()).toMatchObject({ x: 5, y: 3 }); // precondition

    // The history is [edit x, Apply x, edit y, Apply y]: the second Apply, its field edit, then the first Apply.
    await quietly(() => undo());
    expect(boxOnDisk()).toMatchObject({ x: 5, y: 0 });
    await quietly(() => undo());
    await quietly(() => undo());
    expect(boxOnDisk()).toMatchObject({ x: 0, y: 0 });
    for (let i = 0; i < 3; i++) await quietly(() => redo());
    expect(boxOnDisk()).toMatchObject({ x: 5, y: 3 });
    expect(toast).not.toHaveBeenCalled();
  });

  it('a template save made since the Apply is kept: the undo refuses, changes nothing, and says why', async () => {
    await applyBox('x', 5);
    // A prefab-edit save lands after the Apply, through the writer prefab edit mode uses (prefabEdit.ts
    // `savePrefabEdit`), then seeds the cache as that save does.
    const later = JSON.parse(JSON.stringify(getCachedPrefabSync(P))) as PrefabFile;
    later.entities.push({ ...row(3, G(3), 'Extra', 1) } as never);
    expect((await quietly(() => laterSave(later))).ok).toBe(true); // precondition
    setPrefabCache(P, later);
    const laterBytes = onDisk();
    const loads = sm.loads;
    const edits = getEditVersion();

    await quietly(() => undo());

    // The file still holds the later save — `Extra` included — and the cache agrees.
    expect(onDisk()).toBe(laterBytes);
    expect((getCachedPrefabSync(P) as PrefabFile).entities.some((e) => e.name === 'Extra')).toBe(true);
    // Nothing else ran: the world was not reloaded against the pre-Apply document.
    expect(sm.loads).toBe(loads);
    expect(xOf(box())).toBe(5);
    // Nothing moved, so nothing reads as unsaved (close-out review): a dirty mark here made an agent's next load
    // refuse on "unsaved work" over a change that never happened.
    expect(getEditVersion()).toBe(edits);
    // The entry is dropped (#310), and the toast names the reason rather than a bare failure.
    expect(canRedo()).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]![0]).toMatch(/changed on disk since the Apply/);
  });

  it('redo refuses the same way when the file changed after the undo', async () => {
    await applyBox('x', 5);
    await quietly(() => undo());
    expect(boxOnDisk().x).toBe(0); // precondition
    const later = JSON.parse(JSON.stringify(getCachedPrefabSync(P))) as PrefabFile;
    later.name = 'Renamed by a later save';
    await quietly(() => laterSave(later));
    setPrefabCache(P, later);
    const laterBytes = onDisk();

    await quietly(() => redo());

    expect(onDisk()).toBe(laterBytes);
    expect(boxInCache().x).toBe(0);
    expect(toast.mock.calls[0]![0]).toMatch(/changed on disk since the Apply/);
  });
});

describe('a failed write on Apply undo changes nothing (#1668)', () => {
  it('the cache and the world stay on the applied side, and the step is reported, not passed as done', async () => {
    await applyBox('x', 5);
    const applied = onDisk();
    const loads = sm.loads;
    const saves = sm.saves;
    fs.fail = true;

    await quietly(() => undo());

    expect(onDisk()).toBe(applied);
    // Before #1668 the cache was seeded with the pre-Apply document first, and the world rebuilt and saved against it.
    expect(boxInCache().x).toBe(5);
    expect(sm.loads).toBe(loads);
    expect(sm.saves).toBe(saves);
    expect(xOf(box())).toBe(5);
    expect(canRedo()).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]![0]).toMatch(/could not be written/);
  });
});

describe('the refusals that are not a changed file (close-out review)', () => {
  it('a format-gate 409 is reported as a failed write, not as "changed on disk"', async () => {
    await applyBox('x', 5);
    const applied = onDisk();
    fs.tooNew = true;
    await quietly(() => undo());
    expect(onDisk()).toBe(applied);
    expect(boxInCache().x).toBe(5);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]![0]).toMatch(/could not be written/);
  });

  it('a hash that cannot be computed writes nothing and is reported as a refusal', async () => {
    await applyBox('x', 5);
    const edits = getEditVersion();
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new TypeError('crypto.subtle is unavailable'));
    try {
      await quietly(() => undo());
    } finally { digest.mockRestore(); }
    expect(getEditVersion()).toBe(edits);
    expect(toast.mock.calls[0]![0]).toMatch(/refused: the prefab file could not be written/);
  });
});

describe('a refusal on a BASE scene\'s instance dirties no scene (close-out re-review)', () => {
  it('the scene the instance came from is not marked for Save All', async () => {
    const eaMeta = getTraitByName('EntityAttributes')!;
    for (const e of getCurrentWorld().entities) if (e.id() === rootId()) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), sourceScene: BASE });
    await applyBox('x', 5);
    expect(dirtySceneGuidsSnapshot().has(BASE)).toBe(true); // precondition: the Apply's entry names the base scene
    clearAllSceneDirty();
    const later = JSON.parse(JSON.stringify(getCachedPrefabSync(P))) as PrefabFile;
    later.name = 'Saved in prefab edit';
    await quietly(() => laterSave(later));
    setPrefabCache(P, later);

    await quietly(() => undo());

    expect(toast.mock.calls[0]![0]).toMatch(/changed on disk since the Apply/); // precondition: it was refused
    expect(dirtySceneGuidsSnapshot().has(BASE)).toBe(false);
  });
});

describe('a prefab file with no id (close-out review)', () => {
  // The id-less document stays keyed by P in the caches (as a GUID source is), so the Apply's write is what mints its id.
  const idless = () => { const { id: _id, ...rest } = pDoc(); return rest; };
  const install2 = () => { prefabs.set(P, idless()); setPrefabCache(P, idless() as never); fs.disk.set(P, jsonFileBody(idless())); };

  it('undo and redo both land, and the file keeps the one id the Apply gave it', async () => {
    install2();
    await applyBox('x', 5);
    const minted = (JSON.parse(onDisk()) as PrefabFile).id;
    expect(minted).toBeTruthy(); // precondition: the Apply's write stamped one…
    expect(minted).not.toBe(P); // …a fresh one, so the document really had none

    await quietly(() => undo());
    expect(boxOnDisk().x).toBe(0);
    expect((JSON.parse(onDisk()) as PrefabFile).id).toBe(minted);
    await quietly(() => redo());
    expect(boxOnDisk().x).toBe(5);
    expect((JSON.parse(onDisk()) as PrefabFile).id).toBe(minted);
    expect(toast).not.toHaveBeenCalled();
  });
});

function xOf(id: number): number {
  for (const e of getCurrentWorld().entities) if (e.id() === id) return (e.get(Transform) as { x: number }).x;
  return NaN;
}

/** #1692 (I10): the FORWARD Apply writes only over the document it read. The editor's copy can be behind the file — a
 *  save from elsewhere, an outside edit the watcher has not refreshed yet — and the Apply rewrites the whole document
 *  from that copy, so an unconditional write silently threw the other change away.
 *  Mutation: write with no precondition in `commitPrefabWrite` (`overwrite: true` for the Apply) — this goes red. */
describe('a forward Apply writes only over the document it read (#1692)', () => {
  it('a file changed since the editor read it refuses the Apply, and nothing moves', async () => {
    const elsewhere = { ...pDoc(), name: 'saved elsewhere' };
    fs.disk.set(P, jsonFileBody(elsewhere));
    writeTraitFieldWithUndo(box(), getTraitByName('Transform')!, 'x', 5);
    const keys = collectInstanceOverrideKeys(rootId(), getCachedPrefabSync(P) as PrefabFile);
    const edits = getEditVersion();
    const res = await quietly(() => applyToPrefabWithUndo(rootId(), new Set(keys.fields)));
    expect(res.applied).toBe(false);
    expect(res.refused).toMatch(/changed on disk/);
    expect(fs.disk.get(P)).toBe(jsonFileBody(elsewhere));
    expect(xOf(box())).toBe(5); // the instance keeps its edit…
    expect(boxInCache().x).toBe(0); // …and the template was not moved
    expect(getEditVersion()).toBe(edits); // no undo entry
  });
});

/** #1667 (I11): a forward Apply lands WHOLE in the world it began in. Its write, refresh, scene save and undo entry are
 *  separated by awaits; a Play, a scene open or entering prefab edit in one of them ran the rest in the incoming world.
 *  Every world switch now waits for it, as for an undo step (#1579), and an Apply does not start during a switch.
 *  Mutation: drop the hold in `applyToPrefabWithUndo` — the first case goes red (the switch lands after the write but
 *  BEFORE the undo entry, since the commit's own hold ends with the write step); drop the refusal — the second. */
describe('a forward Apply is serialized against world switches (#1667)', () => {
  it('a switch begun while the Apply writes waits until the Apply has landed, undo entry included', async () => {
    let open!: () => void;
    fs.gate = new Promise<void>((r) => { open = r; });
    writeTraitFieldWithUndo(box(), getTraitByName('Transform')!, 'x', 5);
    const keys = collectInstanceOverrideKeys(rootId(), getCachedPrefabSync(P) as PrefabFile);
    const applying = quietly(() => applyToPrefabWithUndo(rootId(), new Set(keys.fields)));
    await vi.waitFor(() => expect(fs.waiting).toBe(1)); // the Apply's write is in flight
    const sw = beginWorldSwitch();
    expect(sw.idle).not.toBeNull();
    // What the top of THIS scene's undo stack says when the switch is let through (the field edit is under it).
    let landedWith: string | null = null;
    void sw.idle!.then(() => { landedWith = peekUndo()?.label ?? ''; });
    await new Promise((r) => setTimeout(r, 10));
    expect(landedWith).toBeNull(); // still waiting on the write
    fs.gate = null;
    open();
    expect((await applying).applied).toBe(true);
    await sw.idle;
    sw.release();
    // The switch was let through only once the Apply had finished — its undo entry already on this scene's stack.
    expect(landedWith).toBe('Apply to Prefab');
  });

  it('an Apply does not start while a world switch is under way', async () => {
    writeTraitFieldWithUndo(box(), getTraitByName('Transform')!, 'x', 5);
    const keys = collectInstanceOverrideKeys(rootId(), getCachedPrefabSync(P) as PrefabFile);
    const sw = beginWorldSwitch();
    try {
      const res = await quietly(() => applyToPrefabWithUndo(rootId(), new Set(keys.fields)));
      expect(res.applied).toBe(false);
      expect(res.refused).toMatch(/scene switch is in progress/);
      expect(fs.posts).toHaveLength(0);
    } finally { sw.release(); }
  });
});
