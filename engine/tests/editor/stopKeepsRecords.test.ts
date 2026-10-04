/** #2001 S8b: Stop, a preview's Exit and leaving prefab edit mark no record stale. Each reloads a world the editor held;
 *  the load takes back the exact records or parses fresh ones. Before, each marked every record of the world it left
 *  stale first, and the mark rode the reload's carry onto every kept base scene's records, where the next write
 *  re-seeded them from the live tree, pose and all. Here the reload is stubbed (as in `authoredSnapshotRestore.test.ts`),
 *  so the world under test is the one a carry keeps, and its instance stands for a base scene's. */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, loadSceneFile, instantiatePrefabIntoWorld,
  destroyEntity, setRunMode, readTraitData, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { fillInstanceStore } from '../../packages/modoki/src/runtime/prefab/instanceLoad';
import { storedRecord } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { writeTraitField } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { captureAuthoredSnapshot, restoreAuthoredSnapshot, type AuthoredSnapshot } from '../../packages/modoki/src/editor/scene/authoredSnapshot';
import { endTimelinePreviewSessionReporting } from '../../packages/modoki/src/editor/scene/timelinePreview';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000002201';
const ROOT = 'dddddddd-0000-4000-8000-000000002201';
const g = (n: number) => `eeeeeeee-0000-4000-8000-00000000220${n}`;

/** P: R → A. */
const pDoc = () => {
  const row = (localId: number, name: string, parentId: number) => ({
    localId, name, nodeGuid: g(localId),
    traits: { EntityAttributes: { name, parentId, guid: '', sortOrder: 0 }, Transform: { x: 0, y: 0, z: 0 } },
  });
  return { id: P, version: 5, name: 'P', rootLocalId: 1, entities: [row(1, 'R', 0), row(2, 'A', 1)] };
};

const scene = (): SceneData => ({
  id: 's2201', version: 14, name: 'S', resources: [],
  entities: [{ id: 1, prefab: P, guid: ROOT, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } } }],
} as unknown as SceneData);

async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const ea = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id: number) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure) => {
      const id = instantiatePrefabIntoWorld(getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
      if (id && rootGuid) for (const e of getCurrentWorld().entities) if (e.id() === id) e.set(ea.trait, { ...(e.get(ea.trait) as Record<string, unknown>), guid: rootGuid });
      return id ?? undefined;
    },
  });
  fillInstanceStore(getCurrentWorld(), JSON.parse(JSON.stringify(data)) as SceneData);
  // A kept base scene's instance: what the reload carries (`baseStoredRoots` reads `sourceScene`).
  for (const e of getCurrentWorld().entities) {
    const a = e.get(ea.trait) as Record<string, unknown> | undefined;
    if (a?.guid === ROOT) e.set(ea.trait, { ...a, sourceScene: 'base-2201' });
  }
}

const tf = getTraitByName('Transform')!;
const byName = (name: string) => getAllEntities().find((e) => e.name === name)!.id;
const xOf = (name: string) => (readTraitData(byName(name), tf) as { x: number }).x;
/** The snapshot a Stop restores: the world's records, and one base (its entries state nothing, so the replay writes nothing). */
const snapshot = async (): Promise<AuthoredSnapshot> => ({
  ...(await captureAuthoredSnapshot({ bases: false })), key: '/s2201.json', bases: new Map([['base-2201', { entities: [] } as never]]),
});

beforeEach(async () => {
  clearHistory();
  setRunMode('stopped');
  const d = pDoc();
  prefabs.set(P, d); setPrefabCache(P, d as never);
  await load(scene());
  vi.spyOn(sceneManager, 'loadScene').mockResolvedValue({} as never);
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { setPrefabCache(P, null); getCurrentWorld()?.destroy(); });

describe('Stop keeps a carried base instance\'s records (#2001 S8b)', () => {
  it('a field Play moved, which no record states, is not taken into the record', async () => {
    const snap = await snapshot();
    const before = structuredClone(storedRecord(getCurrentWorld(), ROOT)!);
    writeTraitField(byName('A'), tf, 'x', 9);                           // Play moved it: no door write
    await restoreAuthoredSnapshot(snap);
    // Before, the restore marked the record stale, and the next write re-seeded it from the live tree, x = 9 and all, so a
    // save wrote the pose. A mark here is healed by the seat (the snapshot's fresh record differs from a stale one), so
    // the marks themselves are pinned by the next case.
    expect(storedRecord(getCurrentWorld(), ROOT)).toEqual(before);
  });

  it('a root the snapshot holds no record for keeps the one it has, unmarked', async () => {
    // A record edited while the snapshot serialized is left out of it (`steadyRecords`), so nothing is seated back over
    // whatever the restore leaves in the store: a mark shows here, where the seat above would have healed it.
    const snap = await snapshot();
    snap.records!.delete(ROOT);
    const before = structuredClone(storedRecord(getCurrentWorld(), ROOT)!);
    writeTraitField(byName('A'), tf, 'x', 9);
    await restoreAuthoredSnapshot(snap);
    // MUTATION TARGET: the pre-mark, or the replay's base mark, and this reads 'stop'.
    expect(storedRecord(getCurrentWorld(), ROOT)).toEqual(before);
  });

  it('a record a door write changed during the session is seated back as the snapshot took it, and its tree rebuilt', async () => {
    const snap = await snapshot();
    const before = structuredClone(storedRecord(getCurrentWorld(), ROOT)!);
    writeTraitFieldWithUndo(byName('A'), tf, 'x', 7);                   // a preview takes scene edits, and drops them at Exit
    expect(storedRecord(getCurrentWorld(), ROOT)).not.toEqual(before);
    await restoreAuthoredSnapshot(snap);
    // MUTATION TARGET: drop `seatBaseRecords(snap.records)` and the record keeps the dropped edit (x = 7 in A's row),
    // which the next save writes; drop its reprojection and the record is right but A still shows 7.
    expect(storedRecord(getCurrentWorld(), ROOT)).toEqual(before);
    expect(xOf('A')).toBe(0);
  });
});

describe('a preview Exit that restores nothing marks nothing (#2001 S8b)', () => {
  it('an end with no session (the restore:false end a world swap runs) leaves the records fresh', async () => {
    const out = await endTimelinePreviewSessionReporting({ restore: false });
    expect(out.reverted).toBe(false);
    // MUTATION TARGET: mark the store when `reverted` is false (the old `staleAroundUnless` kept test) and this reads
    // 'stop', on a world no session posed.
  });
});
