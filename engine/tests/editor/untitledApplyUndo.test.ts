/** #1575 — undo/redo of an Apply made in an UNTITLED scene rebuilds that world, not only the prefab file.
 *
 *  An untitled world (Create Scene with no file) has no scene path, so the Apply undo's scene snapshot had nowhere
 *  to be restored to: the file went back, the world stayed built from the applied document. The applied instance
 *  lost its override, every OTHER instance of the prefab kept the applied state, and a later Save As wrote that as
 *  an override on each. The undo now reloads the snapshot under the key of the world it belongs to when it runs —
 *  '' for an untitled world, as Stop reloads one.
 *
 *  The untitled world holds two instances of MID, A and B. Each case applies from A and compares the world,
 *  serialized as Save As would write it, against the same serialization on the matching side of the apply. Driven
 *  through the real Apply, the real undo manager, the real serializer and the real scene loader; only the
 *  SceneManager swap is a stub that runs that loader and reports the path it was given, and `saveScene` is a
 *  recorder (a real save of an untitled world would open a dialog).
 *  Mutations: delete `restoreSnapshot`'s untitled branch — the undo/redo cases go red; read the reload target from
 *  the Apply's own path instead of the live key — the Save As case goes red; drop the world comparison — the Create
 *  Scene case goes red; let `runStep` push a step that spanned a history swap — the Create Scene and scene-load
 *  cases go red; compare the world only for the untitled key — the half-swapped load case goes red; drop either
 *  in-flight signal — its in-flight case goes red; rederive after a skipped restore — the scene-load cases go red;
 *  resolve instead of throwing on a skipped restore — the half-swapped and in-flight cases go red. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

// Apply writes the prefab through postWriteFile — captured instead of hitting a dev server.
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // `duringWrite` runs inside the write's await — where an undo's file install waits, and a Create Scene can land.
  postWriteFile: async () => {
    sm.writing = true; // before `duringWrite`: a switch started there reads the server mid-write
    const f = sm.duringWrite; sm.duringWrite = null; f?.();
    // `hold` keeps the write open for a while (#1579), so a world switch started inside it that does not wait for the
    // undo has swapped the world before the undo resumes — deterministically, not by microtask order.
    const h = sm.hold; sm.hold = null;
    sm.writing = true;
    try { if (h) await h; } finally { sm.writing = false; }
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  },
}));

/** The live world's path (`null`: no loaded scene, as `replaceWorldContent` leaves an untitled world), the loader
 *  the stubbed swap runs, and the saves the restore asked for. */
const sm = vi.hoisted(() => ({
  path: null as string | null,
  load: null as null | ((data: unknown) => Promise<void>),
  duringWrite: null as null | (() => void),
  hold: null as null | Promise<void>,
  /** A write is still open: the dev server still serves the file as it was before it. */
  writing: false,
  /** A load by PATH (no preloaded data): a fresh empty world, or a missing file. */
  loadPath: null as null | ((path: string) => void),
  /** `replaceWorldContent`, as Create Scene uses it. */
  replace: null as null | ((populate: (world: unknown) => void) => void),
  saves: 0,
  /** A load still pre-swap, as `sceneManager.getNext()` reports one. */
  next: null as null | object,
  /** A load through the editor's `loadScene` wrapper past its undo wait, as `isSceneLoadSwapping()` reports one. */
  loading: false,
}));
vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    sceneManager: {
      getCurrent: () => (sm.path === null ? null : { path: sm.path }),
      getNext: () => sm.next,
      getLoadedScenes: () => new Map(),
      getCurrentBaseScene: () => undefined,
      loadScene: async (path: string, opts?: { preloaded?: unknown }) => {
        if (opts?.preloaded) await sm.load!(opts.preloaded);
        else sm.loadPath!(path);
        sm.path = path;
        return { keptBaseGuids: new Set<string>() };
      },
      replaceWorldContent: async (populate: (world: unknown) => void) => {
        sm.replace!(populate);
        sm.path = null;
      },
    },
  };
});
/** The rederive after the restore rebuilds every base instance of the prefab in the live world — counted, so a
 *  skipped restore can be seen to skip it too. */
const refreshes = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../packages/modoki/src/editor/scene/prefab', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, refreshBaseInstances: (...a: unknown[]) => { refreshes.n++; return (real.refreshBaseInstances as (...x: unknown[]) => unknown)(...a); } };
});
// Play's own awaits, which have nothing to do with the undo (#1579's Play case).
vi.mock('../../packages/modoki/src/runtime/physics/physicsReady', () => ({ ensurePhysicsReady: async () => {} }));
vi.mock('../../packages/modoki/src/editor/panels/aiSettingsModel', () => ({
  getCachedAiSettings: () => ({ captureContactOnLaunch: false }),
  fetchAiSettings: async () => ({ captureContactOnLaunch: false }),
}));
vi.mock('../../packages/modoki/src/editor/scene/serialize', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveScene: async () => { sm.saves++; return { saved: true, reason: 'ok' }; },
  isSceneLoadSwapping: () => sm.loading,
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, loadSceneFile, instantiatePrefabIntoWorld,
  destroyEntity, spawnEntity, EntityAttributes, Transform, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction } from '@modoki/engine/editor';
import { setRunMode } from '../../packages/modoki/src/runtime/core/playState';
import { setPrefabCache, getCachedPrefabSync, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import {
  serializeScene, getCurrentScenePath, setCurrentScenePath, loadScene, newScene, NewSceneRefusedError, markSceneSaved,
  unsavedChangeCauses, worldHasUnsavedEdits,
} from '../../packages/modoki/src/editor/scene/serialize';
import { enterPlay, stopPlay } from '../../packages/modoki/src/editor/scene/playMode';
import { openPrefabForEditing, isEditingPrefab } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { confirmDiscardUnsaved } from '../../packages/modoki/src/editor/scene/unsavedGate';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { undo, redo, canRedo, swapHistory, _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';
import { writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);
// `setCurrentScenePath` remembers a real path in localStorage, which the node environment lacks.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const MID = 'aaaaaaaa-0000-4000-8000-000000001575';
const G = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** The instance roots' guids — what the scene snapshot carries them by. */
const ROOT = { A: G(21), B: G(22) } as const;

const row = (localId: number, nodeGuid: string, name: string, parentId: number) => ({
  localId, nodeGuid, name,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const midDoc = () => ({ id: MID, version: 6, name: 'Mid', rootLocalId: 1, entities: [
  row(1, G(1), 'MidRoot', 0), row(2, G(2), 'Slot', 1), row(3, G(3), 'Box', 1),
] });
const install = (doc: object) => { const id = (doc as { id: string }).id; prefabs.set(id, doc); setPrefabCache(id, doc as never); };

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
    onInstantiatePrefab: async (source, parentId, rootTf, _old, extra, overrides, structure, nested, rootGuid, _folder, nestedStructure) => {
      const world = getCurrentWorld();
      const rootId = instantiatePrefabIntoWorld(world, prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
      if (!rootId) return undefined;
      for (const e of world.entities) {
        if (e.id() !== rootId) continue;
        for (const [name, data] of Object.entries(extra ?? {})) {
          const meta = getTraitByName(name);
          if (meta) e.add(meta.trait(data as never));
        }
        if (rootGuid) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid: rootGuid });
      }
      return rootId;
    },
  });
}
sm.load = (data) => load(data as SceneData);
sm.loadPath = (path) => {
  if (path.includes('Missing')) throw new Error(`no asset at ${path}`);
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
};
sm.replace = (populate) => {
  const prev = getCurrentWorld();
  const world = createWorld();
  setCurrentWorld(world);
  populate(world);
  prev?.destroy();
};

const all = () => getAllEntities();
const parentOf = (id: number) => all().find((e) => e.id === id)?.parentId ?? 0;
const rootOf = (inst: 'A' | 'B') => all().find((e) => e.guid === ROOT[inst])!.id;
/** The entity called `name` inside instance `inst`. */
const inInst = (inst: 'A' | 'B', name: string) => {
  const root = rootOf(inst);
  return all().find((e) => {
    if (e.name !== name) return false;
    for (let p = parentOf(e.id); p; p = parentOf(p)) if (p === root) return true;
    return false;
  })?.id ?? 0;
};
const xOf = (id: number) => {
  for (const e of getCurrentWorld().entities) if (e.id() === id) return (e.get(Transform) as { x: number }).x;
  return NaN;
};
/** The world as the document Save As would write — the whole observable state. Its `id` is minted per call for a
 *  world with no loaded primary, and `createdAt` is a timestamp, so both are left out. */
const saved = async () => {
  const { id: _id, createdAt: _at, ...doc } = (await serializeScene({ assignGuids: true })) as unknown as Record<string, unknown>;
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
};
const midOnDisk = () => getCachedPrefabSync(MID) as PrefabFile;
const boxOnDisk = () => midOnDisk().entities.find((e) => e.name === 'Box')!.traits.Transform;

const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};

/** Apply every override instance A holds, of the kinds `pick` selects. */
async function applyFromA(pick: (keys: ReturnType<typeof collectInstanceOverrideKeys>) => string[]) {
  const keys = collectInstanceOverrideKeys(rootOf('A'), midOnDisk());
  const res = await quietly(() => applyToPrefabWithUndo(rootOf('A'), new Set(pick(keys))));
  expect(res.applied, JSON.stringify(keys)).toBe(true); // precondition
  return res;
}

beforeEach(() => {
  setRunMode('stopped');
  _resetHistoryContexts();
  swapHistory('');
  prefabs.clear();
  install(midDoc());
  // The untitled world Create Scene leaves: no loaded scene, no editor path, two instances of MID.
  sm.path = null;
  sm.saves = 0;
  sm.duringWrite = null;
  sm.hold = null;
  sm.writing = false;
  sm.next = null;
  sm.loading = false;
  refreshes.n = 0;
  setCurrentScenePath(null);
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  for (const inst of ['A', 'B'] as const) {
    const id = instantiatePrefabIntoWorld(getCurrentWorld(), midDoc() as never, 0, undefined, MID);
    for (const e of getCurrentWorld().entities) if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid: ROOT[inst] });
  }
  expect(getCurrentScenePath()).toBeNull(); // precondition: an untitled world
});

describe('undoing an Apply made in an untitled scene rebuilds that world (#1575)', () => {
  it('a value: the applied instance gets its override back, and the other instance inherits the old base again', async () => {
    writeTraitFieldWithUndo(inInst('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    const before = await saved();
    await applyFromA((k) => k.fields);
    expect(xOf(inInst('B', 'Box'))).toBe(5); // precondition: B inherits the applied value

    await quietly(() => undo());
    expect(boxOnDisk()).toMatchObject({ x: 0 });
    expect(xOf(inInst('A', 'Box'))).toBe(5);
    expect(xOf(inInst('B', 'Box'))).toBe(0);
    expect(await saved()).toEqual(before);
    // Still untitled: reloaded under '', no scene path, nothing saved.
    expect(sm.path).toBe('');
    expect(getCurrentScenePath()).toBeNull();
    expect(sm.saves).toBe(0);
    expect(refreshes.n).toBe(1); // the rederive ran after the restore
  });

  it('a value, redone: both instances show it again, with no override', async () => {
    writeTraitFieldWithUndo(inInst('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);
    const after = await saved();
    await quietly(() => undo());
    expect(xOf(inInst('B', 'Box'))).toBe(0); // precondition: the undo took

    await quietly(() => redo());
    expect(boxOnDisk()).toMatchObject({ x: 5 });
    expect(xOf(inInst('A', 'Box'))).toBe(5);
    expect(xOf(inInst('B', 'Box'))).toBe(5);
    expect(await saved()).toEqual(after);
  });

  it('a promoted addition goes back to being the instance\'s own, and leaves the other instance', async () => {
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Extra', parentId: rootOf('A'), guid: G(99) }));
    const before = await saved();
    await applyFromA((k) => k.added);
    expect(inInst('B', 'Extra')).not.toBe(0); // precondition: B gained the promoted member

    await quietly(() => undo());
    expect(midOnDisk().entities.some((e) => e.name === 'Extra')).toBe(false);
    expect(inInst('B', 'Extra')).toBe(0);
    expect(inInst('A', 'Extra')).not.toBe(0);
    expect(await saved()).toEqual(before);
  });
});

describe('undoing an untitled scene\'s Apply after the world changed under it (#1575)', () => {
  it('after a Save As, the undo restores the scene at its new path and saves it there', async () => {
    writeTraitFieldWithUndo(inInst('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    const before = await saved();
    await applyFromA((k) => k.fields);
    // An untitled Save As sets the editor's path and keeps the undo history (`saveScene`, serialize.ts).
    const SAVED = '/scenes/Saved.json';
    setCurrentScenePath(SAVED);

    await quietly(() => undo());
    expect(xOf(inInst('B', 'Box'))).toBe(0);
    expect(await saved()).toEqual(before);
    expect(sm.path).toBe(SAVED);
    expect(getCurrentScenePath()).toBe(SAVED);
    expect(sm.saves).toBe(1);
  });

  it('a Create Scene landing during the undo\'s file install is not overwritten by the untitled snapshot', async () => {
    writeTraitFieldWithUndo(inInst('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);
    const blank = createWorld();
    // Another untitled world, so the key is still null. Create Scene swaps the world, then the history.
    sm.duringWrite = () => { setCurrentWorld(blank); swapHistory('', { freshIncoming: true }); };

    await quietly(() => undo());
    expect(sm.duringWrite).toBeNull(); // precondition: the install really awaited a write
    expect(getCurrentWorld() === blank).toBe(true); // a boolean: a failing `toBe` diffs two whole worlds, out of memory
    expect(all().some((e) => e.guid === ROOT.A)).toBe(false);
    expect(boxOnDisk()).toMatchObject({ x: 0 }); // the file still came back
    expect(canRedo()).toBe(false); // the new scene's history does not inherit the Apply
  });

  // The review of this fix: the entry of a skipped undo was pushed onto the INCOMING world's redo stack, and its redo
  // reloads under the key live when it runs — so it loaded the old world's snapshot under the new scene and saved it
  // into that scene's file. `runStep` now drops a step that spanned a history swap.
  it('a scene loaded during the undo\'s file install keeps its own history, and nothing is saved into it', async () => {
    const A = '/scenes/A.json';
    const Y = '/scenes/Y.json';
    setCurrentScenePath(A);
    swapHistory(A);
    writeTraitFieldWithUndo(inInst('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);
    const other = createWorld();
    sm.duringWrite = () => { setCurrentWorld(other); sm.path = Y; setCurrentScenePath(Y); swapHistory(Y); };

    await quietly(() => undo());
    expect(sm.duringWrite).toBeNull(); // precondition: the install really awaited a write
    expect(getCurrentWorld() === other).toBe(true);
    expect(canRedo()).toBe(false);
    expect(refreshes.n).toBe(0); // …and the rederive did not rebuild the incoming world's instances
    await quietly(() => redo());
    expect(getCurrentWorld() === other).toBe(true);
    expect(sm.path).toBe(Y);
    expect(sm.saves).toBe(0);
  });

  // The re-review: a scene load swaps the WORLD first and sets its path and history only in its tail, after awaiting
  // the scene managers. Resumed in that window, the key still read as this scene's, so the undo loaded this snapshot
  // over the incoming world and saved it — and the tail then set the other scene's path over it.
  it('a scene load that has swapped the world but not yet its path is not overwritten', async () => {
    const A = '/scenes/A.json';
    setCurrentScenePath(A);
    swapHistory(A);
    writeTraitFieldWithUndo(inInst('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);
    const other = createWorld();
    sm.duringWrite = () => { setCurrentWorld(other); }; // the swap; the tail has not run yet

    await quietly(() => undo());
    expect(sm.duringWrite).toBeNull(); // precondition: the install really awaited a write
    expect(getCurrentWorld() === other).toBe(true);
    expect(sm.saves).toBe(0);
    expect(refreshes.n).toBe(0);
    expect(boxOnDisk()).toMatchObject({ x: 0 }); // the file still came back
    // Applied half — the file, not the world — so it is dropped, not left on the redo stack as though undone.
    expect(canRedo()).toBe(false);
  });

  it.each([
    ['pre-swap in SceneManager', () => { sm.next = {}; }],
    ['through the editor\'s loadScene, past its undo wait', () => { sm.loading = true; }],
  ])('a scene load still in flight when the file is back is not raced (%s)', async (_how, begin) => {
    writeTraitFieldWithUndo(inInst('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);
    sm.duringWrite = begin;

    await quietly(() => undo());
    expect(sm.duringWrite).toBeNull(); // precondition
    expect(sm.path).toBeNull(); // nothing loaded over it
    expect(xOf(inInst('B', 'Box'))).toBe(5); // the world was left for the load to replace
    expect(refreshes.n).toBe(0);
    expect(canRedo()).toBe(false); // dropped, not marked undone
  });
});

/** Run `op` — a user world switch — from inside the undo's prefab file write, hold that write open long enough for a
 *  switch that does NOT wait to land, then let the undo finish. */
async function undoDuring<T>(op: () => Promise<T>): Promise<{ did: boolean; result: T }> {
  let started: Promise<T> | undefined;
  let open!: () => void;
  sm.hold = new Promise<void>((r) => { open = r; });
  sm.duringWrite = () => { started = op(); started.catch(() => {}); };
  return quietly(async () => {
    const undone = undo();
    await vi.waitFor(() => expect(started).toBeDefined());
    await new Promise((r) => setTimeout(r, 20)); // a switch that does not wait for the undo lands inside this
    open();
    const did = await undone;
    return { did, result: await started! };
  });
}

/** #1579 — a user world switch started while an Apply undo installs the prefab file WAITS for the undo, which then
 *  applies whole (file AND world) before the switch lands. #1575 guarded the step itself; these drive the real entry
 *  points — `loadScene`, `newScene`, `openPrefabForEditing`, `enterPlay` — and the unsaved-work gate.
 *  Mutations: drop the wait in `loadScene` — the load case goes red; in `newScene` — the Create Scene case; in
 *  `openPrefabForEditing` — the prefab-edit case; in `enterPlay` — the Play case; have `restoreSnapshot` read
 *  `isSceneLoadInFlight` again — the failed-load case (member 4); drop the gate's undo wait — the gate case (member 3);
 *  move Create Scene's latch below its wait — the latch case. */
describe('a world switch during an Apply undo waits for it (#1579)', () => {
  const A = '/scenes/A.json';
  const titled = () => { setCurrentScenePath(A); swapHistory(A); sm.path = A; };

  // Members 2 and 3's door: the load swapped the world under the step, which skipped its reload and its rederive of
  // the base instances (member 2's lost override) and dirtied the outgoing scene after the load read it (member 3).
  it('a scene load: the undo restores the world, rederives and saves the scene, and only then does the load land', async () => {
    titled();
    writeTraitFieldWithUndo(inInst('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);

    const { did, result } = await undoDuring(() => loadScene('/scenes/B.json'));
    expect(did).toBe(true);
    expect(result).toBe('loaded');
    expect(refreshes.n).toBe(1); // the rederive ran — over A's world, before the swap
    expect(sm.saves).toBe(1); // the restored A was saved before it was left
    expect(boxOnDisk()).toMatchObject({ x: 0 });
    expect(getCurrentScenePath()).toBe('/scenes/B.json');
  });

  // Member 4: the load that the undo WAITS behind must not read as one swapping — the undo skipped on it, and the
  // load then failed without ever replacing the half-restored world.
  it('a load that fails after waiting: the undo still restored the world whole', async () => {
    titled();
    writeTraitFieldWithUndo(inInst('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);

    const { did, result } = await undoDuring(() => loadScene('/scenes/Missing.json'));
    expect(result).toBe('failed');
    expect(did).toBe(true);
    expect(xOf(inInst('A', 'Box'))).toBe(5);
    expect(xOf(inInst('B', 'Box'))).toBe(0); // the instances follow the restored file
    expect(canRedo()).toBe(true);
  });

  it('Create Scene: the undo applies whole, then the new scene replaces the world', async () => {
    writeTraitFieldWithUndo(inInst('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);

    const { did } = await undoDuring(() => newScene());
    expect(did).toBe(true);
    expect(refreshes.n).toBe(1);
    expect(all().some((e) => e.guid === ROOT.A)).toBe(false); // the new scene landed after it
  });

  it('a second Create Scene while the first waits for the undo is still refused (#887)', async () => {
    writeTraitFieldWithUndo(inInst('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);
    let second: Promise<void> | undefined;

    await undoDuring(() => { const first = newScene(); second = newScene(); second.catch(() => {}); return first; });
    await expect(second).rejects.toBeInstanceOf(NewSceneRefusedError);
  });

  // The close-out review: the open FETCHED the prefab before it waited, so during the undo's write it read the applied
  // file and overwrote the undo's restored copy in the editor cache — the edit world came up applied, and saving it
  // would have put the Apply back on disk. The stub serves what a dev server does: the old bytes while a write is open.
  it('entering prefab edit: the undo applies whole, and the edit world is built from the restored prefab', async () => {
    writeTraitFieldWithUndo(inInst('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);
    const applied = JSON.stringify(midOnDisk());
    vi.stubGlobal('fetch', async () => new Response(sm.writing ? applied : JSON.stringify(midOnDisk())));
    try {
      const { did } = await undoDuring(() => openPrefabForEditing({ path: '/assets/prefabs/mid.prefab.json', name: 'Mid' }));
      expect(did).toBe(true);
      expect(refreshes.n).toBe(1);
      expect(isEditingPrefab()).toBe(true);
      expect(boxOnDisk()).toMatchObject({ x: 0 }); // the editor cache still holds the restored document
      expect(xOf(all().find((e) => e.name === 'Box')!.id)).toBe(0); // and the edit world was built from it
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
      useEditorStore.getState().closePrefabEditor();
    }
  });

  // Member 1: Play snapshotted the applied world, the undo's reload landed inside Play, and Stop put the applied
  // world back over a prefab file already at "before".
  it('Play: it starts once the undo has landed, and Stop returns the undone world', async () => {
    writeTraitFieldWithUndo(inInst('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    const before = await saved();
    await applyFromA((k) => k.fields);

    const { did, result } = await undoDuring(() => enterPlay());
    expect(did).toBe(true);
    expect(result.kind).toBe('started');
    await quietly(() => stopPlay());
    expect(boxOnDisk()).toMatchObject({ x: 0 });
    expect(xOf(inInst('B', 'Box'))).toBe(0);
    expect(await saved()).toEqual(before);
  });

  // Member 3's prompt: the undo's conservative dirty mark lands at its end. Read during the step, the gate saw a clean
  // world and let the swap discard the history the step then dirtied.
  it('the unsaved-work gate asks once the undo has landed, and sees the world it dirtied', async () => {
    titled();
    writeTraitFieldWithUndo(inInst('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);
    markSceneSaved(); // Save All after the Apply
    clearAllSceneDirty();
    expect(worldHasUnsavedEdits()).toBe(false); // precondition: clean before the undo
    const asked: string[][] = [];
    const deps = {
      causes: unsavedChangeCauses,
      ask: async (_a: string, lost: string[]) => { asked.push(lost); return 'cancel' as const; },
      save: async () => {},
      warn: () => {},
    };

    const { did, result } = await undoDuring(() => confirmDiscardUnsaved('open scene B', 'world-swap', deps));
    expect(did).toBe(true);
    expect(result).toBe(false); // asked, and cancelled
    expect(asked).toHaveLength(1);
  });
});
