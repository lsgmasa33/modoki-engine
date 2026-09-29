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
} from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { detachPrefabInstanceWithUndo } from '../../packages/modoki/src/editor/undo/detachPrefabUndo';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { captureAuthoredSnapshot, restoreAuthoredSnapshot } from '../../packages/modoki/src/editor/scene/authoredSnapshot';
import { getOverrideMarkSet } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
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
const marksOf = (id: number) => [...(getOverrideMarkSet(findEntity(id)!) ?? [])].sort();

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
  // Mutation: drop `restoreMarks(entity.id(), entry.marks)` from `reattachPrefabInstance` — the reload shows x 0, speed 1.
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

describe("Remove Component's undo after a rebuild keeps a TEMPLATE-defined component's override (#1800)", () => {
  // The study marked this case INFERRED (the fuzzer's editField writes Transform only). Driven here.
  // Mutation: drop `restoreMarks(id, targets[i].marks)` from `removeTraitFromEntitiesWithUndo`'s revert — the reload
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

describe("a delete's undo after a rebuild relinks a member outside the tree with its marks (#1794's relink sibling)", () => {
  // A nested frame's member moved elsewhere inside its outer instance (a legacy `moved` member: #1869 stops new ones
  // being authored, and existing files keep loading) is outside its own root's subtree, so deleting that root unlinks it
  // where it stands, and the undo relinks it (`relinkDetachedMembers`). Mutation: in `relinkDetachedMembersMarked`, skip
  // the restore — the reload shows x 0.
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
  // its marks back, and the relink must not wipe them. Mutation: record `[]` for a member that no longer resolves in
  // `recordDetachedMarks` — A's marks are empty after the undo and the reload shows speed 1.
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

  // Mutation: in the delete's redo, drop `recordDetachedMarks` — the redo's frame-ending records nothing, so the undo
  // after the rebuild relinks A without its marks, and the reload shows speed 1.
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

  // #1450's route, which #1869 keeps (a stored root moves anywhere): OR dropped under a member of its own frame that a
  // legacy file moved outside it unpacks that member, and the undo re-links it. Mutation: drop `restoreMarks(id, t.marks)`
  // from reparent's `undoDetach` — the reload shows speed 1.
  it('OR dropped under its own moved member A, a save and reopen, the undo: A keeps its override', async () => {
    await load(movedScene(HOLDER));
    clearHistory();
    expect(reparentEntity(guidIdOf(INST), idOf('A'))).toBe(true);
    expect(readTraitData(idOf('A'), meta('PrefabInstance'))).toBeNull(); // unpacked
    await rebuild();
    expect((await undoStep('undo')).did).toBe(true);
    expect(readTraitData(idOf('A'), meta('PrefabInstance'))).not.toBeNull();
    await speedKept();
  });

  // The same with a nested root: a legacy file moved R (the nested P frame's root, owned by OR's frame) under Holder; OR
  // dropped under R unpacks R (#1450), and its member A with it (the move's plan strips both). Mutation: as above.
  // (The move's own `endFrames` finds nothing more here: the plan already names every link the move splits. No route
  // tried reaches that orphan list, so its `recordDetachedMarks` is held only by the relink guard.)
  it("OR dropped under its own moved nested root R: R's member A comes back with its override", async () => {
    await load(movedScene(undefined, HOLDER));
    clearHistory();
    expect(reparentEntity(guidIdOf(INST), idOf('R'))).toBe(true);
    expect(readTraitData(idOf('A'), meta('PrefabInstance'))).toBeNull(); // unpacked with R
    await rebuild();
    expect((await undoStep('undo')).did).toBe(true);
    expect(readTraitData(idOf('A'), meta('PrefabInstance'))).not.toBeNull();
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
