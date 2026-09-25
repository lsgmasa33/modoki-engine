/** #1573 — undo/redo of an Apply made INSIDE the prefab editor rebuilds that world, not only the prefab file.
 *
 *  The prefab-edit world has no scene path, so the Apply undo's scene snapshot had nowhere to be restored from: the
 *  file went back, the world stayed built from the applied document. The applied instance lost its override, every
 *  OTHER instance of the prefab in the world kept the applied state, and the next save wrote that as an override.
 *
 *  OUTER holds two instances of MID (rows A and B). Each case applies from A and compares the edit world, serialized
 *  as the document Save writes, against the same serialization on the matching side of the apply: that is the
 *  whole observable state of the world, B's inheritance included. Driven through the real Apply, the real undo
 *  manager, the real prefab-edit scene builder and the real scene loader; only the SceneManager swap is a stub that
 *  runs that loader and reports the synthetic path the editor's own `prefabEditWorldPath()` reads.
 *  Mutation: delete `restoreSnapshot`'s prefab-edit branch (applyPrefabUndo.ts) — every undo/redo case goes red.
 *
 *  The last describe pins what the first fix got wrong (its close-out review): it rebuilt the world from the edited
 *  prefab's DOCUMENT, which carries no live guid, so everything added in the session came back under a new one.
 *  Every other undo entry addresses its entity by guid and silently missed, and Save handed a deleted row's
 *  durable nodeGuid to the new entity that inherited its sentinel. The cases above cannot see that: they find
 *  entities by sentinel and compare guid-free documents. */

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
  // `duringWrite` runs inside the write's await — where an undo's file install waits, and an Exit can land.
  postWriteFile: async () => {
    const f = sm.duringWrite; sm.duringWrite = null; f?.();
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  },
}));

/** The live world's synthetic path, and the loader the stubbed swap runs. */
const sm = vi.hoisted(() => ({ path: '', load: null as null | ((data: unknown) => Promise<void>), duringWrite: null as null | (() => void) }));
vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    sceneManager: {
      getCurrent: () => (sm.path ? { path: sm.path } : null),
      getNext: () => null,
      getLoadedScenes: () => new Map(),
      getCurrentBaseScene: () => undefined,
      loadScene: async (path: string, opts: { preloaded?: unknown }) => {
        await sm.load!(opts.preloaded);
        sm.path = path;
        return { keptBaseGuids: new Set<string>() };
      },
    },
  };
});

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, loadSceneFile, instantiatePrefabIntoWorld,
  destroyEntity, spawnEntity, EntityAttributes, Transform, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction, deleteEntitiesWithUndo } from '@modoki/engine/editor';
import { setRunMode } from '../../packages/modoki/src/runtime/core/playState';
import { setPrefabCache, getCachedPrefabSync, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { loadPrefabEditWorld, serializePrefabEditWorld, PREFAB_EDIT_LOCAL_GUID_PREFIX, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { undo, redo, swapHistory, _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';
import { writeTraitFieldWithUndo, reparentEntity } from '../../packages/modoki/src/editor/undo/entityActions';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const MID = 'aaaaaaaa-0000-4000-8000-000000001573';
const OUTER = 'aaaaaaaa-0000-4000-8000-000000011573';
const G = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;

const row = (localId: number, nodeGuid: string, name: string, parentId: number, extra: Record<string, unknown> = {}, x = 0) => ({
  localId, nodeGuid, name, ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x, y: 0, z: 0 } },
});
const midDoc = () => ({ id: MID, version: 6, name: 'Mid', rootLocalId: 1, entities: [
  row(1, G(1), 'MidRoot', 0), row(2, G(2), 'Slot', 1), row(3, G(3), 'Box', 1),
] });
/** OUTER: two MID rows, A and B, so an apply from A has an instance that only INHERITS what it applied. */
const outerDoc = () => ({ id: OUTER, version: 6, name: 'Outer', rootLocalId: 1, entities: [
  row(1, G(11), 'OuterRoot', 0),
  row(2, G(12), 'A', 1, { prefab: MID }),
  row(3, G(13), 'B', 1, { prefab: MID }),
] }) as unknown as PrefabFile;
const KA = 'dddddddd-0000-4000-8000-000000001573';
/** OUTER whose row A adds `Authored` under MID's root in the FILE, keyed KA. */
const outerKeyedDoc = () => {
  const d = outerDoc() as unknown as { entities: Array<Record<string, unknown>> };
  d.entities[1].added = [{ parentLocalId: 1, key: KA, guid: '', name: 'Authored', traits: { EntityAttributes: { name: 'Authored' }, Transform: { x: 0, y: 0, z: 0 } }, children: [] }];
  return d as unknown as PrefabFile;
};
/** A template document without its added nodes' keys. */
const unkeyed = (p: PrefabFile) => JSON.parse(JSON.stringify(p), (k, v) => (k === 'key' ? undefined : v)) as PrefabFile;
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

const all = () => getAllEntities();
const parentOf = (id: number) => all().find((e) => e.id === id)?.parentId ?? 0;
const nameOf = (id: number) => all().find((e) => e.id === id)?.name;
/** The instance root of row A or B — named MID's root, found by the sentinel guid the edit world stamps on a row. */
const rootOf = (rowName: 'A' | 'B') => all().find((e) => e.guid === `${PREFAB_EDIT_LOCAL_GUID_PREFIX}${rowName === 'A' ? 2 : 3}`)!.id;
/** The entity called `name` inside instance `rowName`. */
const inRow = (rowName: 'A' | 'B', name: string) => {
  const root = rootOf(rowName);
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
const byGuid = (guid: string) => all().find((e) => e.guid === guid)?.id ?? 0;
/** The edit world as the document Save would write — the whole observable state. */
const saved = () => {
  const s = serializePrefabEditWorld(OUTER);
  if ('error' in s) throw new Error(s.error);
  return JSON.parse(JSON.stringify(s.prefab)) as PrefabFile;
};
const midOnDisk = () => getCachedPrefabSync(MID) as PrefabFile;

const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};

/** Apply every override instance A holds, of the kinds `pick` selects. */
async function applyFromA(pick: (keys: ReturnType<typeof collectInstanceOverrideKeys>) => string[]) {
  const keys = collectInstanceOverrideKeys(rootOf('A'), midOnDisk());
  const res = await quietly(() => applyToPrefabWithUndo(rootOf('A'), new Set(pick(keys))));
  expect(res.applied, JSON.stringify(keys)).toBe(true); // precondition
  return res;
}

beforeEach(async () => {
  setRunMode('stopped');
  _resetHistoryContexts();
  swapHistory('');
  prefabs.clear();
  sm.path = '';
  install(midDoc());
  install(outerDoc());
  await quietly(() => loadPrefabEditWorld(OUTER, outerDoc()));
  expect(sm.path).toContain(OUTER); // precondition: the editor's own test reads the prefab-edit world
});

describe('undoing an Apply made in the prefab editor rebuilds that world (#1573)', () => {
  it('a value: the applied instance gets its override back, and the other instance inherits the old base again', async () => {
    writeTraitFieldWithUndo(inRow('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    const before = saved();
    await applyFromA((k) => k.fields);
    expect(xOf(inRow('B', 'Box'))).toBe(5); // precondition: B inherits the applied value

    await quietly(() => undo());
    expect(midOnDisk().entities.find((e) => e.name === 'Box')!.traits.Transform).toMatchObject({ x: 0 });
    expect(xOf(inRow('A', 'Box'))).toBe(5);
    expect(xOf(inRow('B', 'Box'))).toBe(0);
    expect(saved()).toEqual(before);
  });

  it('a value, redone: both instances show it again, with no override', async () => {
    writeTraitFieldWithUndo(inRow('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);
    const after = saved();
    await quietly(() => undo());
    expect(xOf(inRow('B', 'Box'))).toBe(0); // precondition: the undo took

    await quietly(() => redo());
    expect(midOnDisk().entities.find((e) => e.name === 'Box')!.traits.Transform).toMatchObject({ x: 5 });
    expect(xOf(inRow('B', 'Box'))).toBe(5);
    expect(saved()).toEqual(after);
  });

  it('a promoted addition goes back to being the instance\'s own, and leaves the other instance', async () => {
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Extra', parentId: rootOf('A'), guid: G(99) }));
    const before = saved();
    await applyFromA((k) => k.added);
    expect(inRow('B', 'Extra')).not.toBe(0); // precondition: B gained the promoted member

    await quietly(() => undo());
    expect(midOnDisk().entities.some((e) => e.name === 'Extra')).toBe(false);
    expect(inRow('B', 'Extra')).toBe(0);
    expect(inRow('A', 'Extra')).not.toBe(0);
    // Keys aside: `before` minted Extra's key in memory, and no document holds it, so nothing can recover it after
    // the reload and the next save mints another. Nothing can be keyed by a key nothing wrote; a key a file DOES
    // hold survives (the case below).
    expect(unkeyed(saved())).toEqual(unkeyed(before));
  });

  it('a node the file adds under an instance keeps its key across the undo', async () => {
    install(outerKeyedDoc());
    await quietly(() => loadPrefabEditWorld(OUTER, outerKeyedDoc()));
    const keyOf = () => saved().entities.find((e) => e.localId === 2)!.added?.find((n) => n.name === 'Authored')?.key;
    expect(keyOf()).toBe(KA); // precondition
    writeTraitFieldWithUndo(inRow('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    const before = saved();
    await applyFromA((k) => k.fields);

    await quietly(() => undo());
    expect(keyOf()).toBe(KA);
    expect(saved()).toEqual(before);
  });

  it('a member move goes back to being the instance\'s own move, and leaves the other instance', async () => {
    reparentEntity(inRow('A', 'Box'), inRow('A', 'Slot'));
    const before = saved();
    await applyFromA((k) => k.moved);
    expect(nameOf(parentOf(inRow('B', 'Box')))).toBe('Slot'); // precondition: B inherits the applied move

    await quietly(() => undo());
    expect(parentOf(inRow('B', 'Box'))).toBe(rootOf('B'));
    expect(nameOf(parentOf(inRow('A', 'Box')))).toBe('Slot');
    expect(saved()).toEqual(before);
  });
});

describe('undoing an Apply in the prefab editor keeps what the session added addressable (#1573 close-out review)', () => {
  it('an entity added in the session keeps its guid, so the undo entries behind the Apply still reach it', async () => {
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Extra', parentId: all().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!.id, guid: G(99) }));
    writeTraitFieldWithUndo(byGuid(G(99)), getTraitByName('Transform')!, 'x', 7);
    writeTraitFieldWithUndo(inRow('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);

    await quietly(() => undo()); // the Apply
    expect(byGuid(G(99))).not.toBe(0);
    await quietly(() => undo()); // A's Box write
    await quietly(() => undo()); // Extra's write
    expect(xOf(byGuid(G(99)))).toBe(0);
  });

  it('a child added under an instance and not applied keeps its guid across the undo', async () => {
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Kid', parentId: rootOf('A'), guid: G(98) }));
    writeTraitFieldWithUndo(byGuid(G(98)), getTraitByName('Transform')!, 'x', 7);
    writeTraitFieldWithUndo(inRow('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);

    await quietly(() => undo());
    expect(byGuid(G(98))).not.toBe(0);
    expect(parentOf(byGuid(G(98)))).toBe(rootOf('A'));
    await quietly(() => undo());
    await quietly(() => undo());
    expect(xOf(byGuid(G(98)))).toBe(0);
  });

  it('a Save after the undo does not give a deleted row\'s identity to an entity added in its place', async () => {
    deleteEntitiesWithUndo([rootOf('B')]);
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Extra', parentId: all().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!.id, guid: G(99) }));
    writeTraitFieldWithUndo(inRow('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);

    await quietly(() => undo());
    expect(byGuid(G(99))).not.toBe(0);
    const extra = saved().entities.find((e) => e.name === 'Extra')!;
    expect(extra).toBeDefined();
    expect(extra.nodeGuid).not.toBe(G(13)); // B's
  });
});

describe('undoing an Apply in the prefab editor after the world has left it (#1573 close-out re-review)', () => {
  it('an Exit landing during the undo\'s file install is not overwritten by the edit world', async () => {
    writeTraitFieldWithUndo(inRow('A', 'Box'), getTraitByName('Transform')!, 'x', 5);
    await applyFromA((k) => k.fields);
    const REAL = '/scenes/Real.json';
    sm.duringWrite = () => { sm.path = REAL; }; // the Exit's reload swaps the real scene in

    await quietly(() => undo());
    expect(sm.duringWrite).toBeNull(); // precondition: the install really awaited a write
    expect(sm.path).toBe(REAL);
    expect(midOnDisk().entities.find((e) => e.name === 'Box')!.traits.Transform).toMatchObject({ x: 0 }); // the file still came back
  });
});

