/** An undo that re-links or re-adds puts the override marks back with the values (#1794, #1800).
 *
 *  The save keeps a member's field only when it is override-marked, and the marks are a runtime side store that a world
 *  rebuild re-seeds from the FILE. So an undo that restored the values from its own snapshot but trusted the store for
 *  the marks held only while the world its forward step ran in was still there. After a rebuild in between (a reload,
 *  Play→Stop, a prefab-edit visit), the file had nothing to mark a detached tree or a removed component from, and the
 *  next save wrote the template's values under an instance that still showed its own. Each case below runs the forward
 *  step, a rebuild, the undo, and a save→reload, and asserts the override survives.
 *
 *  The prefab-edit route is the fuzzer's REGRESSIONS entry for #1794 (`prefabFuzz/knownOpen.ts`), which drives the
 *  real prefab-edit visit. Detach runs on an OUTERMOST root only (#1869 makes a nested root refuse, as Unity does). */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData, findEntity,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import {
  setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, deleteEntitiesWithUndo, removeTraitFromEntitiesWithUndo, reparentEntity,
  addTraitToEntitiesWithUndo, planReparent,
} from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { storedInstances } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { detachPrefabInstanceWithUndo } from '../../packages/modoki/src/editor/undo/detachPrefabUndo';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { captureAuthoredSnapshot, restoreAuthoredSnapshot } from '../../packages/modoki/src/editor/scene/authoredSnapshot';
import { overrideKeysOf } from '../../packages/modoki/src/editor/instance/instanceOverrideView';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000001794';
const INST = 'dddddddd-0000-4000-8000-000000001794';
const HOLDER = 'dddddddd-0000-4000-8000-000000001795';
const gR = 'eeeeeeee-0000-4000-8000-000000001791';
const gA = 'eeeeeeee-0000-4000-8000-000000001792';

/** P = R → A, where A carries a Rotate3D the TEMPLATE defines (speed 1). */
const pDoc = () => ({
  id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
    { localId: 1, name: 'R', nodeGuid: gR, traits: { EntityAttributes: { name: 'R', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
    { localId: 2, name: 'A', nodeGuid: gA, traits: { EntityAttributes: { name: 'A', parentId: 1, guid: '' }, Transform: { x: 0, y: 0, z: 0 }, Rotate3D: { axis: 'y', speed: 1 } } },
  ],
});
const O = 'cccccccc-0000-4000-8000-000000001796';
const gOR = 'eeeeeeee-0000-4000-8000-000000001793';
const gB = 'eeeeeeee-0000-4000-8000-000000001797';
const gPN = 'eeeeeeee-0000-4000-8000-000000001798';
/** O = OR → B, and OR → a nested P (R → A). */
const oDoc = () => ({
  id: O, version: 5, name: 'O', rootLocalId: 1, entities: [
    { localId: 1, name: 'OR', nodeGuid: gOR, traits: { EntityAttributes: { name: 'OR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
    { localId: 2, name: 'B', nodeGuid: gB, traits: { EntityAttributes: { name: 'B', parentId: 1, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
    { localId: 3, name: 'R', nodeGuid: gPN, prefab: P, traits: { EntityAttributes: { name: 'R', parentId: 1, guid: '' } } },
  ],
});
const install = () => { for (const d of [pDoc(), oDoc()]) { prefabs.set(d.id, d); setPrefabCache(d.id, d as never); } };

/** A fresh world loaded from `data`: the world swap a reload, Play→Stop or leaving prefab edit makes. The undo history
 *  stays. */
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

const meta = (t: string) => getTraitByName(t)!;
const named = (name: string) => getAllEntities().filter((e) => e.name === name);
const idOf = (name: string) => { const all = named(name); expect(all).toHaveLength(1); return all[0].id; };
const guidIdOf = (guid: string) => getAllEntities().find((e) => e.guid === guid)!.id;
const field = (id: number, trait: string, f: string) => (readTraitData(id, meta(trait)) as Record<string, unknown> | null)?.[f];
const save = async () => JSON.parse(JSON.stringify(await serializeScene())) as SceneData;
/** A save and a reopen: the rebuild that keeps the undo history. */
const rebuild = async () => load(await save());
const marksOf = (id: number) => [...(overrideKeysOf(findEntity(id)!) ?? [])].sort();

/** Holder, and a scene instance of P (guid INST) at the root. */
const scene = (): SceneData => ({
  id: 's1794', version: 16, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER }, Transform: { x: 0, y: 0, z: 0 } } },
    { id: 2, prefab: P, guid: INST, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } } },
  ],
} as unknown as SceneData);

/** A's `Transform.x = 7` and `Rotate3D.speed = 5`, edited as the Inspector does, then saved and reopened, so the marks
 *  come from the FILE, as they do for any scene opened from disk. The history starts after it. */
async function withOverrides(): Promise<void> {
  writeTraitFieldWithUndo(idOf('A'), meta('Transform'), 'x', 7);
  writeTraitFieldWithUndo(idOf('A'), meta('Rotate3D'), 'speed', 5);
  await rebuild();
  clearHistory();
  expect(marksOf(idOf('A'))).toEqual(['Rotate3D.speed', 'Transform.x']); // precondition: the file marked both
}

beforeEach(async () => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
  install();
  await load(scene());
});
afterAll(() => { setPrefabCache(P, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

describe("Detach's undo after a rebuild keeps the instance's overrides (#1794)", () => {
  // Mutation: drop `seat()` from `reattachDetachedInstanceSeating` (the records the Detach dropped) — red.
  it('Detach, a save and reopen, the undo: the next save→reload keeps both overrides', async () => {
    await withOverrides();
    detachPrefabInstanceWithUndo(guidIdOf(INST), 'Detach prefab', '[test]');
    expect(readTraitData(idOf('A'), meta('PrefabInstance'))).toBeNull();
    await rebuild(); // the detached tree reloads plain: nothing in the file marks it
    expect((await undoStep('undo')).did).toBe(true);
    expect(readTraitData(idOf('A'), meta('PrefabInstance'))).not.toBeNull();
    expect(marksOf(idOf('A'))).toEqual(['Rotate3D.speed', 'Transform.x']);
    await rebuild();
    expect(field(idOf('A'), 'Transform', 'x')).toBe(7);
    expect(field(idOf('A'), 'Rotate3D', 'speed')).toBe(5);
  });

  // Play→Stop: Stop reloads the scene from the snapshot Play took (`authoredSnapshot.ts`), and keeps the history.
  // Mutation: as above.
  it('Detach, Play→Stop, the undo: the next save→reload keeps both overrides', async () => {
    await withOverrides();
    detachPrefabInstanceWithUndo(guidIdOf(INST), 'Detach prefab', '[test]');
    const snap = await captureAuthoredSnapshot(); // Play
    setRunMode('playing');
    setRunMode('stopped');
    await restoreAuthoredSnapshot(snap); // Stop
    expect(readTraitData(idOf('A'), meta('PrefabInstance'))).toBeNull();
    expect(marksOf(idOf('A'))).toEqual([]); // the rebuild left the plain tree unmarked
    expect((await undoStep('undo')).did).toBe(true);
    expect(marksOf(idOf('A'))).toEqual(['Rotate3D.speed', 'Transform.x']);
    await rebuild();
    expect(field(idOf('A'), 'Transform', 'x')).toBe(7);
    expect(field(idOf('A'), 'Rotate3D', 'speed')).toBe(5);
  });

  // (accept) no rebuild in between: the undo was already exact, and restoring the capture keeps it so.
  it('(accept) Detach and its undo in one world: exact', async () => {
    await withOverrides();
    detachPrefabInstanceWithUndo(guidIdOf(INST), 'Detach prefab', '[test]');
    expect((await undoStep('undo')).did).toBe(true);
    expect(marksOf(idOf('A'))).toEqual(['Rotate3D.speed', 'Transform.x']);
    await rebuild();
    expect(field(idOf('A'), 'Transform', 'x')).toBe(7);
  });
});

// #1853: the override on a NESTED member's node (A, inside O's nested P) after Detach, a rebuild and the undo. The fuzzer's
// three #1853 entries could not see this any more (#1933 K1): an outside edit before each Detach keeps the undo stack since
// #1873 R1, so the walk's identity checks run tainted and are skipped. Mutation: drop `seat()` from
// `reattachDetachedInstanceSeating` — red, with the flat #1794 tests above (#2001 S8b: one record states both, so the
// nested-only mutation this case was written for, restoring the outer frame's marks alone, has no counterpart).
describe("Detach's undo after a rebuild keeps a NESTED member's overrides (#1853, #1933 K1)", () => {
  const OINST = 'dddddddd-0000-4000-8000-000000001853';
  const oScene = (): SceneData => ({
    id: 's1853', version: 16, name: 'S', resources: [],
    entities: [
      { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER }, Transform: { x: 0, y: 0, z: 0 } } },
      { id: 2, prefab: O, guid: OINST, traits: { EntityAttributes: { name: 'OInst', parentId: 0 } } },
    ],
  } as unknown as SceneData);

  it('Detach O, a save and reopen, the undo: the next save→reload keeps A\'s overrides', async () => {
    await load(oScene());
    writeTraitFieldWithUndo(idOf('A'), meta('Transform'), 'x', 7);
    writeTraitFieldWithUndo(idOf('A'), meta('Rotate3D'), 'speed', 5);
    await rebuild();
    clearHistory();
    expect(marksOf(idOf('A'))).toEqual(['Rotate3D.speed', 'Transform.x']); // precondition: the file marked both
    detachPrefabInstanceWithUndo(guidIdOf(OINST), 'Detach prefab', '[test]');
    expect(readTraitData(idOf('A'), meta('PrefabInstance'))).toBeNull();
    await rebuild();
    expect((await undoStep('undo')).did).toBe(true);
    expect(marksOf(idOf('A'))).toEqual(['Rotate3D.speed', 'Transform.x']);
    await rebuild();
    expect(field(idOf('A'), 'Transform', 'x')).toBe(7);
    expect(field(idOf('A'), 'Rotate3D', 'speed')).toBe(5);
  });
});

describe("Remove Component's undo after a rebuild keeps a TEMPLATE-defined component's override (#1800)", () => {
  // The study marked this case INFERRED (the fuzzer's editField writes Transform only). Driven here.
  // Mutation: drop `putComponentRows(ids, oldRows, meta)` from `removeTraitFromEntitiesWithUndo`'s undo — the reload
  // shows the template's speed 1.
  it('remove Rotate3D, a save and reopen, the undo: the next save→reload keeps speed 5', async () => {
    await withOverrides();
    expect(removeTraitFromEntitiesWithUndo([idOf('A')], meta('Rotate3D'))).toBeNull();
    await rebuild(); // the file records Rotate3D as removed: nothing marks its fields
    expect((await undoStep('undo')).did).toBe(true);
    expect(field(idOf('A'), 'Rotate3D', 'speed')).toBe(5);
    expect(marksOf(idOf('A'))).toEqual(['Rotate3D.speed', 'Transform.x']);
    await rebuild();
    expect(field(idOf('A'), 'Rotate3D', 'speed')).toBe(5);
    expect(field(idOf('A'), 'Transform', 'x')).toBe(7);
  });
});

describe("a delete's undo after a rebuild relinks a member outside the tree with its records (#1794's relink sibling)", () => {
  // A nested frame's member moved elsewhere inside its outer instance (a legacy `moved` member: #1869 stops new ones
  // being authored, and existing files keep loading) is outside its own root's subtree, so deleting that root unlinks it
  // where it stands, and the undo relinks it (`relinkDetachedMembers`). Its override is a row of the OUTER instance's
  // record, outside R's subtree, so the delete never touches it and no undo step has to carry it (#2001 S8b: before, the
  // relink put back marks the frame-ending had taken). Pinned by that shape, not by an undo step: dropping the undo's
  // relink, or its seat of the records the delete changed, stays green (measured). A regression would be a delete that
  // edits a row outside its subtree.
  it('delete the nested root, a save and reopen, the undo: the moved member keeps its override', async () => {
    await load(movedScene());
    expect(field(idOf('A'), 'Transform', 'x')).toBe(7);
    expect(marksOf(idOf('A'))).toContain('Transform.x'); // precondition: the file marked it
    deleteEntitiesWithUndo([idOf('R')]);
    expect(named('R')).toHaveLength(0);
    expect(readTraitData(idOf('A'), meta('PrefabInstance'))).toBeNull(); // unlinked where it stands
    await rebuild();
    expect((await undoStep('undo')).did).toBe(true);
    expect(readTraitData(idOf('A'), meta('PrefabInstance'))).not.toBeNull();
    expect(marksOf(idOf('A'))).toContain('Transform.x');
    await rebuild();
    expect(field(idOf('A'), 'Transform', 'x')).toBe(7);
  });
});

describe('the relink sibling, by route (#1794 close-out review)', () => {
  const speedKept = async () => { await rebuild(); expect(field(idOf('A'), 'Rotate3D', 'speed')).toBe(5); };

  // A member both detached (by R's frame-ending) and deleted (as its own target, after R): its snapshot's respawn puts
  // its records back, and the relink must not wipe them. Mutation: the undo skips seating the records the delete changed
  // (`seatAround(changed!, 'before', …)` → the snapshot alone) — A's record is gone after the undo.
  it('delete [R, A] in that order, the undo: A keeps its marks (and [A, R] does too)', async () => {
    for (const order of [['R', 'A'], ['A', 'R']]) {
      await load(movedScene());
      clearHistory();
      deleteEntitiesWithUndo(order.map(idOf));
      expect(named('A')).toHaveLength(0);
      expect((await undoStep('undo')).did).toBe(true);
      expect(marksOf(idOf('A'))).toContain('Rotate3D.speed');
      await speedKept();
    }
  });

  // Pinned by the record's shape, as the first case above: A's row lives in the outer record, which neither the delete
  // nor its redo touches. Dropping the redo's seat of the after-records, or the undo's relink, stays green (measured).
  it("the delete's redo records again: delete R, undo, redo, a save and reopen, undo: A keeps its override", async () => {
    await load(movedScene());
    clearHistory();
    deleteEntitiesWithUndo([idOf('R')]);
    expect((await undoStep('undo')).did).toBe(true);
    expect((await undoStep('redo')).did).toBe(true);
    await rebuild();
    expect((await undoStep('undo')).did).toBe(true);
    await speedKept();
  });
});

/** An instance of O (OR → B, OR → nested P's R → A) with A moved under B and `x = 7`, `speed = 5` on it, as a save wrote it
 *  (`parent` retargets the move). */
const movedScene = (parent: string | undefined = '60fab4f8-4635-5a21-fb1a-bf76708690d7', rParent?: string): SceneData => ({
  id: 's1794m', version: 17, name: 'S', resources: [{ type: 'prefab', path: O }],
  entities: [
    {
      name: 'OR', prefab: O, guid: INST,
      traits: { PrefabInstance: { source: O, localId: 1, nodeGuid: gOR, rootInstanceId: INST } },
      members: {
        [`/${gB}`]: { guid: '60fab4f8-4635-5a21-fb1a-bf76708690d7', name: 'B' },
        [`/${gPN}`]: { guid: '61fab68b-4535-588e-fc1a-c1096f868f44', name: 'R', ...(rParent ? { parent: rParent } : {}) },
        [`/${gPN}/${gA}`]: { guid: '64293cf7-325d-8396-6553-b8f5c75d6c84', name: 'A', ...(parent ? { parent } : {}), traits: { Transform: { x: 7 }, Rotate3D: { speed: 5 } } },
      },
    },
    { name: 'Holder', traits: { Transform: {}, EntityAttributes: { name: 'Holder', parentId: '', guid: HOLDER } } },
  ],
} as unknown as SceneData);

/** A SAVED prefab edit between a step and its undo: the template changes on disk and in the cache, and the scene is
 *  reopened from its save, as leaving prefab edit reopens it (`exitPrefabEditing`'s loadScene). The history stays. */
async function savedPrefabEdit(edit: (doc: ReturnType<typeof pDoc>) => void): Promise<void> {
  const data = await save();
  const doc = JSON.parse(JSON.stringify(prefabs.get(P))) as ReturnType<typeof pDoc>;
  edit(doc);
  prefabs.set(P, doc);
  setPrefabCache(P, doc as never);
  await load(data);
}
const tplA = (doc: ReturnType<typeof pDoc>) => doc.entities.find((e) => e.name === 'A')!.traits as Record<string, Record<string, unknown>>;

/** Each field's live value, then the same field after a save→reload: an undo must leave the world the reload gives. */
async function liveThenReloaded(fields: [trait: string, field: string][]): Promise<{ live: unknown[]; reloaded: unknown[] }> {
  const live = fields.map(([t, f]) => field(idOf('A'), t, f));
  await rebuild();
  return { live, reloaded: fields.map(([t, f]) => field(idOf('A'), t, f)) };
}

describe("an undo after a SAVED prefab edit takes UNMARKED fields from the CURRENT template (#1800 owner ruling)", () => {
  // y = 9 (the instance's own edit), then a saved prefab edit sets the template's A.y = 4, then undo: the instance no
  // longer overrides y, so it shows the template's 4, as the reload does, not the 0 the old template had.
  // Mutation: `putRows` skips writing an unlisted field from the fold — the undo shows y 0, the reload 4.
  it('field write: undo shows the current template value, as the reload does', async () => {
    writeTraitFieldWithUndo(idOf('A'), meta('Transform'), 'y', 9);
    await savedPrefabEdit((d) => { tplA(d).Transform.y = 4; });
    expect(field(idOf('A'), 'Transform', 'y')).toBe(9); // still the instance's own override
    expect((await undoStep('undo')).did).toBe(true);
    expect(marksOf(idOf('A'))).not.toContain('Transform.y');
    const { live, reloaded } = await liveThenReloaded([['Transform', 'y']]);
    expect(reloaded).toEqual([4]);
    expect(live).toEqual(reloaded);
  });

  // (accept) a MARKED override survives: x = 7 is the instance's own (from the file), edited to 9, the template's x moves
  // to 3, the undo gives back the instance's 7, not the template's 3. Mutation: resync MARKED fields too — the undo shows 3.
  it('(accept) field write: a marked override comes back as the instance had it', async () => {
    await withOverrides();
    writeTraitFieldWithUndo(idOf('A'), meta('Transform'), 'x', 9);
    await savedPrefabEdit((d) => { tplA(d).Transform.x = 3; });
    expect((await undoStep('undo')).did).toBe(true);
    const { live, reloaded } = await liveThenReloaded([['Transform', 'x']]);
    expect(reloaded).toEqual([7]);
    expect(live).toEqual(reloaded);
  });

  // Remove Rotate3D (speed 5 marked, axis the template's), a saved prefab edit moves the template's axis to 'x', undo:
  // axis follows the template, speed stays the instance's 5. Mutation: `putRows` skips writing an unlisted field from
  // the fold, or the undo drops `putComponentRows` — each red.
  it('Remove Component: undo re-adds with the current template for unmarked fields, the marked override kept', async () => {
    await withOverrides();
    expect(removeTraitFromEntitiesWithUndo([idOf('A')], meta('Rotate3D'))).toBeNull();
    await savedPrefabEdit((d) => { tplA(d).Rotate3D.axis = 'x'; });
    expect((await undoStep('undo')).did).toBe(true);
    const { live, reloaded } = await liveThenReloaded([['Rotate3D', 'axis'], ['Rotate3D', 'speed']]);
    expect(reloaded).toEqual(['x', 5]);
    expect(live).toEqual(reloaded);
  });

  // Delete A (a member, its frame survives), a saved prefab edit sets the template's A.y = 4, undo: A comes back with
  // y 4 and its own x 7 / speed 5. Held by `survivingFrameRows` + `rebaseRespawned` (#1820): the frame is re-recorded as
  // the old document and rebuilt onto the current one through the mark gate.
  it('delete a member: undo respawns it with the current template for unmarked fields, the marked overrides kept', async () => {
    await withOverrides();
    deleteEntitiesWithUndo([idOf('A')]);
    await savedPrefabEdit((d) => { tplA(d).Transform.y = 4; });
    expect((await undoStep('undo')).did).toBe(true);
    const { live, reloaded } = await liveThenReloaded([['Transform', 'y'], ['Transform', 'x'], ['Rotate3D', 'speed']]);
    expect(reloaded).toEqual([4, 7, 5]);
    expect(live).toEqual(reloaded);
  });

  // Detach, a saved prefab edit (the plain tree reloads with the values it had), undo: re-attached, A takes the
  // template's new y and keeps its own x 7 / speed 5. Held by `reattachDetachedInstance`, which brings the re-attached
  // instance onto the current template (#1665's sibling), not by `putRows`' fold write (dropping it leaves this green).
  it('Detach: undo re-attaches with the current template for unmarked fields, the marked overrides kept', async () => {
    await withOverrides();
    detachPrefabInstanceWithUndo(guidIdOf(INST), 'Detach prefab', '[test]');
    await savedPrefabEdit((d) => { tplA(d).Transform.y = 4; });
    expect((await undoStep('undo')).did).toBe(true);
    const { live, reloaded } = await liveThenReloaded([['Transform', 'y'], ['Transform', 'x'], ['Rotate3D', 'speed']]);
    expect(reloaded).toEqual([4, 7, 5]);
    expect(live).toEqual(reloaded);
  });

  // The whole instance deleted: its frame goes with it, so the respawn comes back from the OLD document. Held by
  // `rebaseRespawned` (#1820), which rebuilds the respawned frame onto the current document through the mark gate.
  it('delete the instance: undo respawns it with the current template for unmarked fields, the marked overrides kept', async () => {
    await withOverrides();
    deleteEntitiesWithUndo([guidIdOf(INST)]);
    await savedPrefabEdit((d) => { tplA(d).Transform.y = 4; });
    expect((await undoStep('undo')).did).toBe(true);
    const { live, reloaded } = await liveThenReloaded([['Transform', 'y'], ['Transform', 'x'], ['Rotate3D', 'speed']]);
    expect(reloaded).toEqual([4, 7, 5]);
    expect(live).toEqual(reloaded);
  });
});

describe("a relink after a SAVED prefab edit takes UNMARKED fields from the CURRENT template (#1800 owner ruling)", () => {
  // A here is a legacy member moved OUTSIDE its instance, so its whole Transform is part of the move (the save writes a
  // moved member's whole Transform diff, `recordedOverrides`) and a template Transform change does not reach it. `Rotate3D.axis` is an unmarked field
  // the template does reach, so it is the one each case moves.
  const edit = (d: ReturnType<typeof pDoc>) => { tplA(d).Rotate3D.axis = 'x'; tplA(d).Transform.y = 4; };
  const fields: [string, string][] = [['Rotate3D', 'axis'], ['Transform', 'y'], ['Transform', 'x'], ['Rotate3D', 'speed']];

  // R's delete unlinks A where it stands; the saved prefab edit reloads it as a plain entity with the values it had;
  // the undo relinks it. Held by #1820's frame rebase, which rebuilds R's respawned frame after the relink.
  it('delete the nested root, a saved prefab edit, the undo: the relinked member shows the current template', async () => {
    await load(movedScene());
    clearHistory();
    deleteEntitiesWithUndo([idOf('R')]);
    await savedPrefabEdit(edit);
    expect((await undoStep('undo')).did).toBe(true);
    expect(readTraitData(idOf('A'), meta('PrefabInstance'))).not.toBeNull();
    const { live, reloaded } = await liveThenReloaded(fields);
    expect(reloaded[0]).toBe('x');
    expect(live).toEqual(reloaded);
  });
});

describe("an undo after a SAVED edit of an ENCLOSING row leaves the nested instance as a load does (#1800 owner ruling)", () => {
  const OI = 'dddddddd-0000-4000-8000-000000001799';
  /** An instance of O (OR → B, OR → nested P's R → A) at the scene root. */
  const oScene = (): SceneData => ({
    id: 's1800o', version: 16, name: 'S', resources: [],
    entities: [{ id: 1, prefab: O, guid: OI, traits: { EntityAttributes: { name: 'OI', parentId: 0 } } }],
  } as unknown as SceneData);
  /** A saved edit of O: its row 3 (the nested P) states `overrides` on P's rows, as an Apply into O or a prefab-edit save
   *  of O writes them. */
  async function savedRowEdit(overrides: Record<number, Record<string, Record<string, unknown>>>): Promise<void> {
    const data = await save();
    const doc = JSON.parse(JSON.stringify(prefabs.get(O))) as { entities: { localId: number; overrides?: unknown }[] };
    doc.entities.find((e) => e.localId === 3)!.overrides = overrides;
    prefabs.set(O, doc);
    setPrefabCache(O, doc as never);
    await load(data);
  }
  const state = (name: string, t: string, f: string) => ({ value: field(idOf(name), t, f), marked: marksOf(idOf(name)).includes(`${t}.${f}`) });
  async function liveEqualsReload(name: string, t: string, f: string, reloaded: { value: unknown; marked: boolean }) {
    const live = state(name, t, f);
    await rebuild();
    expect(state(name, t, f)).toEqual(reloaded);
    expect(live).toEqual(reloaded);
  }

  // The nested A's y = 9 (its own), then O's row states A.y = 4, then undo: A shows the row's 4, UNRECORDED — a layer's
  // value is the instance's base, and a load records only the scene's own statements (#1914, docs/prefabs.md I2).
  // Mutation: drop the base-value write from `takeUnmarkedFromBase` — y stays 9.
  it("field write: the undo takes the enclosing row's value, unrecorded", async () => {
    await load(oScene());
    clearHistory();
    writeTraitFieldWithUndo(idOf('A'), meta('Transform'), 'y', 9);
    await savedRowEdit({ 2: { Transform: { y: 4 } } });
    expect(field(idOf('A'), 'Transform', 'y')).toBe(9);
    expect((await undoStep('undo')).did).toBe(true);
    await liveEqualsReload('A', 'Transform', 'y', { value: 4, marked: false });
  });

  // Delete the nested root R (its frame, O's instance, survives), then O's row states R.y = 4, then undo: R comes back
  // with the row's 4, unrecorded. Held by #1820's rebase: R's own frame (O) is the one whose document changed.
  it("delete the nested root: the undo's respawn takes the enclosing row's value, unrecorded", async () => {
    await load(oScene());
    clearHistory();
    deleteEntitiesWithUndo([idOf('R')]);
    await savedRowEdit({ 1: { Transform: { y: 4 } } });
    expect((await undoStep('undo')).did).toBe(true);
    await liveEqualsReload('R', 'Transform', 'y', { value: 4, marked: false });
  });

  // One level deeper (#1831 seed 6246's shape): X = XR → a nested O, whose row 3 is the nested P's root R. Delete R (its
  // frame, the nested O, survives), then X's row states R.y = 4 through O's row 3 (`nestedOverrides`), then undo. The document that changed
  // is X's, not that of R's frame, so #1820's rebase never sees a stale frame. Mutation: drop the resync loop from the
  // delete's undo (`deleteEntitiesWithUndo`) — y 0.
  it("delete a root two levels down: the undo's respawn takes the grand-outer row's value, unrecorded", async () => {
    const X = 'cccccccc-0000-4000-8000-000000001800';
    const xDoc = {
      id: X, version: 5, name: 'X', rootLocalId: 1, entities: [
        { localId: 1, name: 'XR', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001800', traits: { EntityAttributes: { name: 'XR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
        { localId: 2, name: 'OR', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001801', prefab: O, traits: { EntityAttributes: { name: 'OR', parentId: 1, guid: '' } } },
      ],
    };
    prefabs.set(X, xDoc);
    setPrefabCache(X, xDoc as never);
    await load({ id: 's1800x', version: 16, name: 'S', resources: [], entities: [{ id: 1, prefab: X, guid: OI, traits: { EntityAttributes: { name: 'XI', parentId: 0 } } }] } as unknown as SceneData);
    clearHistory();
    deleteEntitiesWithUndo([idOf('R')]);
    const data = await save();
    const doc = JSON.parse(JSON.stringify(xDoc)) as typeof xDoc & { entities: { nestedOverrides?: unknown }[] };
    doc.entities[1].nestedOverrides = { 3: { 1: { Transform: { y: 4 } } } }; // O's row 3 (the nested P), P's row 1 (R)
    prefabs.set(X, doc);
    setPrefabCache(X, doc as never);
    await load(data);
    expect((await undoStep('undo')).did).toBe(true);
    await liveEqualsReload('R', 'Transform', 'y', { value: 4, marked: false });
  });
});

describe("a component re-added where an ENCLOSING row states it is unrecorded, as a load leaves it (#1893, #1914)", () => {
  const OI = 'dddddddd-0000-4000-8000-000000001893';
  // O's row 3 (the nested P) states a Rotate3D on P's row 1 (R), which P's template does not define: what a Create
  // Prefab writes when it wraps an instance whose member had an added component (seed 1294's HR row for QR). The values
  // are the trait's defaults, so every field EQUALS the effective base, and the by-value rule alone unmarks them all.
  const statedDoc = () => {
    const d = oDoc() as ReturnType<typeof oDoc> & { entities: { overrides?: unknown }[] };
    // …plus a field Rotate3D no longer persists (a renamed one the row still names: the load skips it, #1893 review).
    d.entities[2].overrides = { 1: { Rotate3D: { axis: 'y', speed: 1, oldField: 5 } } };
    return d;
  };
  const rotMarks = () => marksOf(idOf('R')).filter((k) => k.startsWith('Rotate3D.'));
  beforeEach(async () => {
    const d = statedDoc(); prefabs.set(O, d); setPrefabCache(O, d as never);
    await load({ id: 's1893', version: 16, name: 'S', resources: [], entities: [{ id: 1, prefab: O, guid: OI, traits: { EntityAttributes: { name: 'OI', parentId: 0 } } }] } as unknown as SceneData);
    clearHistory();
    expect(rotMarks()).toEqual([]); // precondition: what the row states is base, not a record (#1914)
  });
  /** The marks now, then after a save + reopen: they must match. */
  async function marksAsReload(): Promise<string[]> {
    const live = rotMarks();
    await rebuild();
    expect(rotMarks()).toEqual([]);
    return live;
  }

  // Mutation: have Add Component's reconcile mark every field it adds (`recordOverridesByDiff` marking unconditionally)
  // — both are recorded live and not on a reload.
  it('Remove Component, then Add Component: the re-added fields are unrecorded', async () => {
    removeTraitFromEntitiesWithUndo([idOf('R')], meta('Rotate3D'));
    addTraitToEntitiesWithUndo([idOf('R')], meta('Rotate3D'));
    expect(await marksAsReload()).toEqual([]);
  });

  // The walk's shape (seed 1294): the add's REDO runs the same reconcile. Same mutation.
  it("Add Component's redo leaves them unrecorded too", async () => {
    removeTraitFromEntitiesWithUndo([idOf('R')], meta('Rotate3D'));
    addTraitToEntitiesWithUndo([idOf('R')], meta('Rotate3D'));
    expect((await undoStep('undo')).did).toBe(true);
    expect((await undoStep('redo')).did).toBe(true);
    expect(await marksAsReload()).toEqual([]);
  });
});

describe('a member-token field survives the restore (#1800 close-out review)', () => {
  // Q = QR → QA, QR's UIAction bound to its own member QA by the template token `@member:2` (#1352). Detach's undo
  // re-links the tree one entry at a time, root first, and restores each entry's marks as it goes: when the root's pass
  // ran, no member was linked yet, the token resolved to nothing, and the "differs, unmarked" branch wrote the RAW token
  // into the live binding. Mutation: drop the `hasMemberToken` skip from `takeUnmarkedFromBase` — both cases read
  // '@member:2'.
  const Q = 'cccccccc-0000-4000-8000-00000000aa01';
  const QI = 'dddddddd-0000-4000-8000-00000000aa01';
  const bind = (target: string) => ({ UIAction: { bindings: [{ event: 'click', kind: 'call', action: 'noop', target }] } });
  const qDoc = () => ({
    id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [
      { localId: 1, name: 'QR', nodeGuid: 'eeeeeeee-0000-4000-8000-00000000aa01', traits: { EntityAttributes: { name: 'QR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 }, ...bind('@member:2') } },
      { localId: 2, name: 'QA', nodeGuid: 'eeeeeeee-0000-4000-8000-00000000aa02', traits: { EntityAttributes: { name: 'QA', parentId: 1, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
    ],
  });
  const targetOf = (id: number) => (field(id, 'UIAction', 'bindings') as { target: string }[] | undefined)?.[0]?.target;
  const qaGuid = () => getAllEntities().find((e) => e.name === 'QA')!.guid;
  beforeEach(async () => {
    const d = qDoc(); prefabs.set(Q, d); setPrefabCache(Q, d as never);
    await load({ id: 'sq', version: 16, name: 'S', resources: [], entities: [{ id: 1, prefab: Q, guid: QI, traits: { EntityAttributes: { name: 'QI', parentId: 0 } } }] } as unknown as SceneData);
    clearHistory();
    expect(targetOf(guidIdOf(QI))).toBe(qaGuid()); // precondition: the load resolved the token
  });

  it('Detach, then undo: the root binding still names QA', async () => {
    const g = qaGuid();
    detachPrefabInstanceWithUndo(guidIdOf(QI), 'Detach prefab', '[test]');
    expect((await undoStep('undo')).did).toBe(true);
    expect(targetOf(guidIdOf(QI))).toBe(g);
  });

  it('Detach, a save and reopen, undo: the binding names QA, as the reload does', async () => {
    detachPrefabInstanceWithUndo(guidIdOf(QI), 'Detach prefab', '[test]');
    await rebuild();
    const g = qaGuid();
    expect((await undoStep('undo')).did).toBe(true);
    const live = targetOf(guidIdOf(QI));
    expect(live).toBe(g);
    await rebuild();
    expect(targetOf(guidIdOf(QI))).toBe(live);
  });
});

describe('a legacy member moved out of its frame, relinked two levels down (#1800 close-out review)', () => {
  // X = XR → OR (O), O = OR → B, R (nested P), P = R → A, with A a legacy member moved under B. Delete R: A is unlinked
  // where it stands. A saved edit of X states A's axis through O's row 3 (`nestedOverrides`); the undo relinks A. The
  // document that changed is X's, the one above A's frame, so no frame reads as stale and #1820's rebase never reaches A;
  // it is not respawned either. Mutation: drop the detached members from the delete undo's pass — axis 'y' live, the
  // reload 'x' (both unrecorded: a layer's value is base, #1914).
  it('delete R, a saved edit of X, undo: the relinked A matches the reload', async () => {
    const X = 'cccccccc-0000-4000-8000-000000001800';
    const gXO = 'eeeeeeee-0000-4000-8000-000000001801';
    const xDoc = () => ({ id: X, version: 5, name: 'X', rootLocalId: 1, entities: [
      { localId: 1, name: 'XR', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001800', traits: { EntityAttributes: { name: 'XR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
      { localId: 2, name: 'OR', nodeGuid: gXO, prefab: O, traits: { EntityAttributes: { name: 'OR', parentId: 1, guid: '' } } } as Record<string, unknown>,
    ] });
    const BG = '60fab4f8-4635-5a21-fb1a-bf76708690d7';
    const XI = 'dddddddd-0000-4000-8000-00000000cc01';
    const x0 = xDoc(); prefabs.set(X, x0); setPrefabCache(X, x0 as never);
    await load({
      id: 'sx', version: 17, name: 'S', resources: [],
      entities: [{
        name: 'XR', prefab: X, guid: XI,
        traits: { PrefabInstance: { source: X, localId: 1, rootInstanceId: XI } },
        members: {
          [`/${gXO}`]: { guid: '60fab4f8-4635-5a21-fb1a-bf76708690d1', name: 'OR' },
          [`/${gXO}/${gB}`]: { guid: BG, name: 'B' },
          [`/${gXO}/${gPN}`]: { guid: '61fab68b-4535-588e-fc1a-c1096f868f44', name: 'R' },
          [`/${gXO}/${gPN}/${gA}`]: { guid: '64293cf7-325d-8396-6553-b8f5c75d6c84', name: 'A', parent: BG },
        },
      }],
    } as unknown as SceneData);
    clearHistory();
    expect(getAllEntities().find((e) => e.name === 'A')!.parentId).toBe(idOf('B')); // precondition: A lives under B
    deleteEntitiesWithUndo([idOf('R')]);
    const data = await save();
    const doc = xDoc() as { entities: Record<string, unknown>[] };
    doc.entities[1]!.nestedOverrides = { 3: { 2: { Rotate3D: { axis: 'x' } } } };
    prefabs.set(X, doc); setPrefabCache(X, doc as never);
    await load(data);
    expect((await undoStep('undo')).did).toBe(true);
    const state = () => ({ axis: field(idOf('A'), 'Rotate3D', 'axis'), marked: marksOf(idOf('A')).includes('Rotate3D.axis') });
    const live = state();
    await rebuild();
    expect(state()).toEqual({ axis: 'x', marked: false });
    expect(live).toEqual(state());
  });
});

// #1914 close-out review: F7's root order is IMPLIED by a role (`recordsRootOrder`), read through the view, so
// a carrier that captured that view put it back as a STORED mark, and the mark outlived the role. A legacy file moved
// R (the nested frame's root, owned by OR's frame) under Holder: R records nothing. Deleting OR ends R's
// frame and makes R a scene root for the step, whose implied order the frame-ending captured; the undo relinked R with
// it stored, and the save pinned R's order against the template. Mutation (before #2001 S8b): capture the view instead of
// the stored set in the Detach carrier — both red: R's marks gain `EntityAttributes.sortOrder` and its row a
// `sortOrder: 0`. Since S8b no carrier holds marks; the cases pin the outcome.
describe("an undo's carried marks are the STORED set, never F7's implied root order (#1914 close-out review)", () => {
  const rRow = (data: SceneData) => (data.entities[0] as unknown as { members: Record<string, unknown> }).members[`/${gPN}`];
  // (Detach OR was the second route: since #2001 S8b a Detach that would orphan R is refused, below.)
  for (const [label, step] of [
    ['delete OR', () => deleteEntitiesWithUndo([guidIdOf(INST)])],
  ] as const) {
    it(`${label}, the undo: R's marks and its saved row are what they were`, async () => {
      await load(movedScene(undefined, HOLDER));
      clearHistory();
      const before = { marks: marksOf(idOf('R')), row: rRow(await save()) };
      expect(before.marks).toEqual([]); // precondition: a moved nested root records nothing
      step();
      expect((await undoStep('undo')).did).toBe(true);
      expect({ marks: marksOf(idOf('R')), row: rRow(await save()) }).toEqual(before);
    });

    // …and an order R DID record in its owned role (the file states it) survives: the relink's record is taken after the
    // frame-ending made R a scene root for the step, so a capture less the order that role records dropped it (re-review).
    // Mutation (before #2001 S8b): the carrier took the stored set less the order — R's marks lose it, its row the
    // `sortOrder: 3`.
    it(`${label}, the undo: an order R's file states stays recorded`, async () => {
      const s = movedScene(undefined, HOLDER) as unknown as { entities: Array<{ members: Record<string, Record<string, unknown>> }> };
      s.entities[0]!.members[`/${gPN}`] = { ...s.entities[0]!.members[`/${gPN}`], traits: { EntityAttributes: { sortOrder: 3 } } };
      await load(s as unknown as SceneData);
      clearHistory();
      const state = async () => ({ marks: marksOf(idOf('R')), row: rRow(await save()), order: field(idOf('R'), 'EntityAttributes', 'sortOrder') });
      const before = await state();
      expect(before.row).toMatchObject({ traits: { EntityAttributes: { sortOrder: 3 } } }); // precondition: its row records it
      expect(before.order).toBe(3);
      step();
      expect((await undoStep('undo')).did).toBe(true);
      expect(await state()).toEqual(before);
    });
  }
});

// #2001 S8b: a step off the record path (a delete of a frame a member moved out of) copies the
// store before its forward and seats what it changed around its undo and redo (`changedSince`, `seatAround`).
describe('a step off the record path seats the records it changed (#2001 S8b)', () => {
  const store = () => JSON.stringify([...storedInstances(getCurrentWorld())], (_k, v: unknown) => (v instanceof Map ? [...v] : v));

  // The snapshot undo's own refusal (R's parent OR is gone) comes after the records were seated for it to read: they go
  // back as the undo found them, as a refusal applies nothing (I19). Mutation: drop the put-back in `seatAround`'s catch —
  // the store keeps the pre-delete records.
  it('an undo the snapshot refuses puts back the records it seated', async () => {
    await load(movedScene());
    clearHistory();
    deleteEntitiesWithUndo([idOf('R')]);
    const at = store();
    destroyEntity(findEntity(guidIdOf(INST))!, getCurrentWorld());
    const step = await undoStep('undo');
    expect(step.failed?.refused, 'premise: the undo refused').toBe(true);
    expect(store()).toBe(at);
  });
});

// #2001 S8b, owner ruling 2026-10-04 (superseding #1450's 2026-09-19 "unpack, not refuse" for this state only): a legacy
// file moved a member out of its frame. A move that would unlink it (OR dropped under it) and a Detach that would orphan it
// (the frame ending under it) are refused before anything changes: the records cannot follow that unpack. Mutations: drop
// `planReparent`'s 'moved-member' answer — the plan reads same-scene; drop `reparentEntity`'s refusal — the move lands; drop
// `detachPrefabInstance`'s `hasOrphansOf` refusal — the unpack is taken back out by the door, refused for another reason.
describe('the legacy moved-member state refuses (#2001 S8b, owner ruling 2026-10-04)', () => {
  const state = async () => ({
    store: JSON.stringify([...storedInstances(getCurrentWorld())], (_k, v: unknown) => (v instanceof Map ? [...v] : v)),
    links: ['A', 'R', 'B'].map((n) => readTraitData(idOf(n), meta('PrefabInstance'))),
    parent: field(guidIdOf(INST), 'EntityAttributes', 'parentId'),
    // Less what every save stamps afresh (its time and id).
    file: (({ createdAt: _t, id: _i, ...rest }) => rest)(await save() as SceneData & { createdAt?: string }),
  });
  const scenes = [['A, moved under Holder', () => movedScene(HOLDER), 'A'], ['R, moved under Holder', () => movedScene(undefined, HOLDER), 'R']] as const;

  for (const [label, scene, member] of scenes) {
    it(`OR dropped under its own moved member ${label}: refused, nothing changed`, async () => {
      await load(scene());
      clearHistory();
      const before = await state();
      expect(planReparent(guidIdOf(INST), idOf(member))).toEqual({ kind: 'refused', reason: 'moved-member' });
      expect(reparentEntity(guidIdOf(INST), idOf(member))).toBe(false);
      expect(await state()).toEqual(before);
      expect((await undoStep('undo')).did, 'no undo entry').toBe(false);
    });

    it(`Detach OR, whose frame holds ${label}: refused, nothing changed`, async () => {
      await load(scene());
      clearHistory();
      const before = await state();
      expect(() => detachPrefabInstanceWithUndo(guidIdOf(INST), 'Detach prefab', '[test]')).toThrow(/an older version moved a member/);
      expect(await state()).toEqual(before);
      expect((await undoStep('undo')).did, 'no undo entry').toBe(false);
    });
  }
});
