/** #2141 (S8b review L3): Stop (and an Apply's undo that reloads the scene) seats a kept base scene's records back as the
 *  snapshot took them (`seatBaseRecords`). A tree its seated records cannot rebuild exactly is REFUSED: its records go back,
 *  the console names it, and the world is unsavable until a load replaces it (S8b's rule).
 *
 *  Measured on main before the fix: the user adds "Mine" under member A; during the session an outside edit takes A out of
 *  the prefab, and the rebuild holds Mine on the record (`held.heldOwn`). The snapshot's record links Mine and holds
 *  nothing, so seated it failed `reprojectsExactly` with a warning only, the world read savable, and the base scene's save
 *  wrote the instance without Mine. Here the reload is stubbed (as in `stopKeepsRecords.test.ts`), so the world under
 *  test is the one a carry keeps, and its instance stands for a base scene's.
 *
 *  Same population, measured the same way: a preview that deleted the user's node. The snapshot's record links it and its
 *  anchor is still in the prefab, so `reprojectsExactly` passed (it asked only about unplaced links); the seated record
 *  linked a node nothing showed or held, the world read savable, and the save wrote the link with no content. */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
/** Set to make the next `reprojectFromStore` throw part-way (a rebuild that fails, review finding 4). */
const throwOnReproject = { on: false };
vi.mock('../../packages/modoki/src/editor/instance/instanceReproject', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../packages/modoki/src/editor/instance/instanceReproject')>();
  return { ...real, reprojectFromStore: (...a: Parameters<typeof real.reprojectFromStore>) => {
    if (throwOnReproject.on) { throwOnReproject.on = false; throw new Error('rebuild failed part-way'); }
    return real.reprojectFromStore(...a);
  } };
});
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
import { createEntityWithUndo, deleteEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { reprojectFromStore } from '../../packages/modoki/src/editor/instance/instanceReproject';
import { whyWorldNotAuthored } from '../../packages/modoki/src/editor/scene/authoredWorld';
import { unsavableMarkOf } from '../../packages/modoki/src/editor/instance/instanceRollback';
import { enterPlay } from '../../packages/modoki/src/editor/scene/playMode';
import { beginTimelinePreviewSession } from '../../packages/modoki/src/editor/scene/timelinePreview';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { fillInstanceStore } from '../../packages/modoki/src/runtime/prefab/instanceLoad';
import { storedRecord } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { captureAuthoredSnapshot, restoreAuthoredSnapshot, seatBaseRecords, NOT_RESTORED, type AuthoredSnapshot } from '../../packages/modoki/src/editor/scene/authoredSnapshot';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000002141';
const ROOT = 'dddddddd-0000-4000-8000-000000002141';
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
  id: 's2141', version: 14, name: 'S', resources: [],
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
    if (a?.guid === ROOT) e.set(ea.trait, { ...a, sourceScene: 'base-2141' });
  }
}

const tf = getTraitByName('Transform')!;
const byName = (name: string) => getAllEntities().find((e) => e.name === name)!.id;
const xOf = (name: string) => (readTraitData(byName(name), tf) as { x: number }).x;
/** The snapshot a Stop restores: the world's records, and one base (its entries state nothing, so the replay writes nothing). */
const snapshot = async (): Promise<AuthoredSnapshot> => ({
  ...(await captureAuthoredSnapshot({ bases: false })), key: '/s2141.json', bases: new Map([['base-2141', { entities: [] } as never]]),
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


const rootId = () => getAllEntities().find((e) => e.guid === ROOT)!.id;
/** P with member A gone, in the cache: an outside edit the session's rebuild took in. */
function dropA(): void {
  const d = pDoc(); d.entities = d.entities.filter((e) => e.name !== 'A');
  prefabs.set(P, d); setPrefabCache(P, d as never);
}
const heldNames = () => [...(storedRecord(getCurrentWorld(), ROOT)!.held.heldOwn?.values() ?? [])].flat().map((n) => n.name);
/** Run `fn` with console.error captured: the messages naming the instance's refused restore. */
async function refusals(fn: () => Promise<void>): Promise<string[]> {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { await fn(); return err.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(`restore of instance ${ROOT} refused`)); } finally { err.mockRestore(); }
}

describe('a restore refuses a record its tree cannot be rebuilt from (#2141)', () => {
  it('a node the session held is not dropped by seating a record that only links it', async () => {
    const a = byName('A');
    expect(createEntityWithUndo('Add Mine', a, [{ name: 'EntityAttributes', data: { name: 'Mine', parentId: a } }, { name: 'Transform', data: { x: 3 } }], () => {})).not.toBeNull();
    const snap = await snapshot();
    dropA();
    expect(reprojectFromStore(rootId())).not.toBeNull();
    expect(heldNames(), 'premise: the session\'s rebuild holds Mine').toEqual(['Mine']);
    expect(getAllEntities().some((e) => e.name === 'Mine'), 'premise: nothing shows it').toBe(false);
    const held = structuredClone(storedRecord(getCurrentWorld(), ROOT)!);
    expect(await refusals(() => restoreAuthoredSnapshot(snap))).toHaveLength(1);
    // MUTATION TARGET: drop the `reprojectsExactly` refusal in `seatBaseRecords` and the snapshot's record is seated:
    // Mine is held by nothing, the world reads savable, and the save writes the instance without it.
    expect(storedRecord(getCurrentWorld(), ROOT), 'the record the session left, Mine held').toEqual(held);
    expect(heldNames()).toEqual(['Mine']);
    expect(whyWorldNotAuthored()).toBe(NOT_RESTORED);
  });

  it('a node a preview deleted is not seated back as a link with no content', async () => {
    // Exit replays fields onto the base's carried entities and re-creates none (A5), so the snapshot's record links a node
    // that is not live, and no record holds: the rebuild spawns nothing for it and the save writes the link alone.
    const a = byName('A');
    expect(createEntityWithUndo('Add Mine', a, [{ name: 'EntityAttributes', data: { name: 'Mine', parentId: a } }, { name: 'Transform', data: { x: 3 } }], () => {})).not.toBeNull();
    const snap = await snapshot();
    deleteEntityWithUndo(byName('Mine'));
    const unlinked = structuredClone(storedRecord(getCurrentWorld(), ROOT)!);
    expect(await refusals(() => restoreAuthoredSnapshot(snap))).toHaveLength(1);
    // MUTATION TARGET: drop the placed-node half of `linksLostNode` (`instanceReproject.ts`) and the snapshot's record is
    // seated, linking Mine, with nothing live or held to write it from, and the world reads savable.
    expect(storedRecord(getCurrentWorld(), ROOT)).toEqual(unlinked);
    expect(whyWorldNotAuthored()).toBe(NOT_RESTORED);
  });

  it('a tree whose prefab cannot be read is refused the same way', async () => {
    const snap = await snapshot();
    writeTraitFieldWithUndo(byName('A'), tf, 'x', 7);                   // a preview edit: the record differs from the snapshot's
    const edited = structuredClone(storedRecord(getCurrentWorld(), ROOT)!);
    prefabs.delete(P); setPrefabCache(P, null);
    expect(await refusals(() => restoreAuthoredSnapshot(snap))).toHaveLength(1);
    // MUTATION TARGET: treat a null `reprojectFromStore` as done and the snapshot's record (x = 0) is seated over a tree
    // still showing 7: the save writes one, the screen shows the other.
    expect(storedRecord(getCurrentWorld(), ROOT)).toEqual(edited);
    expect(xOf('A')).toBe(7);
    expect(whyWorldNotAuthored()).toBe(NOT_RESTORED);
  });

  it('a tree its records rebuild is seated, and the world stays savable', async () => {
    const snap = await snapshot();
    const before = structuredClone(storedRecord(getCurrentWorld(), ROOT)!);
    writeTraitFieldWithUndo(byName('A'), tf, 'x', 7);
    expect(await refusals(() => restoreAuthoredSnapshot(snap))).toHaveLength(0);
    expect(storedRecord(getCurrentWorld(), ROOT)).toEqual(before);
    expect(xOf('A')).toBe(0);
    expect(whyWorldNotAuthored()).toBeNull();
  });

  it('a Missing Prefab placeholder is seated back as the snapshot took it (review finding 1)', async () => {
    prefabs.delete(P); setPrefabCache(P, null);
    await load(scene());
    expect(getAllEntities().find((e) => e.guid === ROOT)?.missingPrefab, 'premise: a placeholder').toBe(true);
    const snap = await snapshot();
    const before = structuredClone(storedRecord(getCurrentWorld(), ROOT)!);
    writeTraitFieldWithUndo(rootId(), getTraitByName('EntityAttributes')!, 'name', 'Renamed');   // a preview edit
    expect(storedRecord(getCurrentWorld(), ROOT)!.placement.name, 'premise: the record took it').toBe('Renamed');
    expect(await refusals(() => restoreAuthoredSnapshot(snap))).toHaveLength(0);
    // MUTATION TARGET: skip a root with no projection root (`if (!top) continue;`) and the record keeps "Renamed": the
    // base scene's save writes the preview edit the Exit dropped, and the world reads savable.
    expect(storedRecord(getCurrentWorld(), ROOT)).toEqual(before);
    expect(whyWorldNotAuthored()).toBeNull();
  });

  it('a rebuild that throws puts the tree\'s records back, marks the world, and rethrows (review finding 4)', async () => {
    const snap = await snapshot();
    writeTraitFieldWithUndo(byName('A'), tf, 'x', 7);
    const edited = structuredClone(storedRecord(getCurrentWorld(), ROOT)!);
    throwOnReproject.on = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Called directly, as an Apply's undo/redo reseat calls it: Stop's own `rollbackOnThrow` would put the store back
      // here only because this harness stubs the reload — in production the reload replaced the world, and that
      // rollback leaves a replaced world alone.
      expect(() => seatBaseRecords(snap.records)).toThrow('rebuild failed part-way');
    } finally { err.mockRestore(); throwOnReproject.on = false; }
    // MUTATION TARGET: drop the catch's put-back and the snapshot's record (x = 0) stays seated over a tree still showing 7.
    expect(storedRecord(getCurrentWorld(), ROOT)).toEqual(edited);
    // The mark, not only the restore's own failed flag (which the next world swap clears).
    expect(unsavableMarkOf()).toBe(NOT_RESTORED);
  });

  it('Play and a preview refuse to open on a world a refused restore left unsavable (review finding 3)', async () => {
    // Their exit restores a NEW world, which no mark holds, from a snapshot that took this one as authored: one Play → Stop
    // cleared the mark, and the save then wrote the preview's delete the refusal was guarding.
    const a = byName('A');
    expect(createEntityWithUndo('Add Mine', a, [{ name: 'EntityAttributes', data: { name: 'Mine', parentId: a } }], () => {})).not.toBeNull();
    const snap = await snapshot();
    deleteEntityWithUndo(byName('Mine'));
    expect(await refusals(() => restoreAuthoredSnapshot(snap))).toHaveLength(1);
    expect(whyWorldNotAuthored(), 'premise').toBe(NOT_RESTORED);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // MUTATION TARGET: drop the `unsavableMarkOf` gate in `enterPlay` / `beginTimelinePreviewSession` and each opens.
      const out = await enterPlay();
      expect(out.kind === 'refused' && out.reason).toBe('unsavable');
      expect(await beginTimelinePreviewSession()).toBe(false);
    } finally { warn.mockRestore(); }
  });

  it('Play pressed with the preview still open is refused when the preview\'s own restore marks the world (re-review finding 1)', async () => {
    // The entry gate reads the posed world, unmarked; Play's takedown of the preview then restores it, and that restore
    // refuses the base tree. Play must ask again of the world the takedown left, or it snapshots the marked world and
    // its Stop restores an unmarked one.
    const a = byName('A');
    expect(createEntityWithUndo('Add Mine', a, [{ name: 'EntityAttributes', data: { name: 'Mine', parentId: a } }], () => {})).not.toBeNull();
    expect(await beginTimelinePreviewSession(), 'premise: a preview session opened').toBe(true);
    deleteEntityWithUndo(byName('Mine'));                                // a preview edit the Exit cannot put back (A5)
    expect(unsavableMarkOf(), 'premise: nothing marked yet').toBeNull();
    const quiet = [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
    try {
      // MUTATION TARGET (measured): drop BOTH re-checks after the awaits (`whyNotPlayable` after `captureAdoption`, and the
      // one before `playing`) and Play starts. Either alone still refuses here: they are a redundant pair, the second for a
      // mark that lands during the snapshot.
      const out = await enterPlay();
      expect(out.kind === 'refused' && out.reason).toBe('unsavable');
    } finally { for (const q of quiet) q.mockRestore(); }
    expect(unsavableMarkOf()).toBe(NOT_RESTORED);
  });
});

