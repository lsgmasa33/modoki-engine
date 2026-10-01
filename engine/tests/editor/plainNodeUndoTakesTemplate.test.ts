/** An undo after a SAVED prefab edit brings a template's PLAIN added node to the CURRENT template too (#1932, hunt seed
 *  1224: "a no-op rebuild is not the identity", minimized to `apply ; delete ; prefabEdit[editField]`).
 *
 *  #1800's owner ruling (Unity: a field the instance does not override shows the current asset's value) is held for
 *  MEMBERS by `takeUnmarkedFromBase`. A node a template adds with no prefab of its own (here O's "Extra", added under the
 *  nested P's member A) carries no `PrefabInstance`, so it is not a member, and the function returned at once: an undo
 *  restored it from a snapshot taken before the prefab edit, showing the OLD template's value, while the save, which writes
 *  only a node's RECORDED fields (`nodeRowDiff`'s `recordedOf`), wrote nothing, and the reload showed the new one. */
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
import { setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, deleteEntitiesWithUndo } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { getOverrideMarkSet } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000001224';
const O = 'cccccccc-0000-4000-8000-000000001225';
const INST = 'dddddddd-0000-4000-8000-000000001224';

/** P = R → A. */
const pDoc = () => ({
  id: P, version: 16, name: 'P', rootLocalId: 1, entities: [
    { localId: 1, name: 'R', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001221', traits: { EntityAttributes: { name: 'R', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
    { localId: 2, name: 'A', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001222', traits: { EntityAttributes: { name: 'A', parentId: 1, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
  ],
});
/** O = OR → a nested P, whose row adds the PLAIN node Extra (key k-extra) under P's A: seed 1224's shape. */
const oDoc = () => ({
  id: O, version: 16, name: 'O', rootLocalId: 1, entities: [
    { localId: 1, name: 'OR', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001223', traits: { EntityAttributes: { name: 'OR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
    {
      localId: 2, name: 'R', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001224', prefab: P, traits: { EntityAttributes: { name: 'R', parentId: 1, guid: '' } },
      added: [{ parentLocalId: 2, guid: '', key: 'k-extra', name: 'Extra', traits: { Transform: { x: 6, z: 0 }, EntityAttributes: { name: 'Extra' } }, children: [] }],
    },
  ],
});
type Doc = ReturnType<typeof oDoc>;
const install = () => { for (const d of [pDoc(), oDoc()]) { prefabs.set(d.id, d); setPrefabCache(d.id, d as never); } };

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
const idOf = (name: string) => { const all = getAllEntities().filter((e) => e.name === name); expect(all).toHaveLength(1); return all[0].id; };
const field = (id: number, trait: string, f: string) => (readTraitData(id, meta(trait)) as Record<string, unknown> | null)?.[f];
const save = async () => JSON.parse(JSON.stringify(await serializeScene())) as SceneData;
const rebuild = async () => load(await save());
const marksOf = (id: number) => [...(getOverrideMarkSet(findEntity(id)!) ?? [])].sort();
const extra = (doc: Doc) => doc.entities[1].added![0].traits as Record<string, Record<string, unknown>>;

/** Save the scene, change O, reopen: what leaving a saved prefab edit does. The history stays. */
async function savedEditOfO(edit: (doc: Doc) => void): Promise<void> {
  const data = await save();
  const doc = JSON.parse(JSON.stringify(prefabs.get(O))) as Doc;
  edit(doc);
  prefabs.set(O, doc);
  setPrefabCache(O, doc as never);
  await load(data);
}
async function liveThenReloaded(fields: [trait: string, field: string][]): Promise<{ live: unknown[]; reloaded: unknown[] }> {
  const live = fields.map(([t, f]) => field(idOf('Extra'), t, f));
  await rebuild();
  return { live, reloaded: fields.map(([t, f]) => field(idOf('Extra'), t, f)) };
}

beforeEach(async () => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
  install();
  await load({ id: 's1224', version: 16, name: 'S', resources: [], entities: [{ id: 1, prefab: O, guid: INST, traits: { EntityAttributes: { name: 'OI', parentId: 0 } } }] } as unknown as SceneData);
  expect(field(idOf('Extra'), 'Transform', 'x')).toBe(6); // premise: the row's node is live
  expect(marksOf(idOf('Extra'))).toEqual([]);
});
afterAll(() => { vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

describe("an undo after a SAVED prefab edit takes a PLAIN template node's unrecorded fields from the CURRENT template (#1932, seed 1224)", () => {
  // Mutation: drop the `takeUnmarkedNodeFromBase` branch in `takeUnmarkedFromBase` — live z 0, reloaded -7.
  it("delete A (Extra's parent), a saved edit of Extra's z in O, undo: Extra shows the current z, as the reload does", async () => {
    deleteEntitiesWithUndo([idOf('A')]);
    await savedEditOfO((d) => { extra(d).Transform.z = -7; });
    expect((await undoStep('undo')).did).toBe(true);
    const { live, reloaded } = await liveThenReloaded([['Transform', 'z'], ['Transform', 'x']]);
    expect(reloaded).toEqual([-7, 6]);
    expect(live).toEqual(reloaded);
  });

  // The field-edit undo (`putMarkState`) reaches the same branch. Mutation as above: live 0, reloaded -7.
  it("a field edit on Extra, a saved edit of the same field in O, undo: Extra shows the current value", async () => {
    expect(writeTraitFieldWithUndo(idOf('Extra'), meta('Transform'), 'z', 9)).toBeNull();
    expect(marksOf(idOf('Extra'))).toEqual(['Transform.z']);
    await savedEditOfO((d) => { extra(d).Transform.z = -7; });
    expect(field(idOf('Extra'), 'Transform', 'z')).toBe(9); // still the scene's own record
    expect((await undoStep('undo')).did).toBe(true);
    expect(marksOf(idOf('Extra'))).toEqual([]);
    const { live, reloaded } = await liveThenReloaded([['Transform', 'z']]);
    expect(reloaded).toEqual([-7]);
    expect(live).toEqual(reloaded);
  });

  // (accept) A RECORDED field keeps the scene's value through the same sequence. Mutation: skip the mark test in
  // `takeUnmarkedNodeFromBase` — the undo shows the template's x 1, the reload the recorded 3.
  it('(accept) a recorded field on Extra stays the scene\'s own through delete, a saved edit and undo', async () => {
    expect(writeTraitFieldWithUndo(idOf('Extra'), meta('Transform'), 'x', 3)).toBeNull();
    await rebuild();
    clearHistory();
    expect(marksOf(idOf('Extra'))).toEqual(['Transform.x']); // precondition: the file recorded it
    deleteEntitiesWithUndo([idOf('A')]);
    await savedEditOfO((d) => { extra(d).Transform.z = -7; extra(d).Transform.x = 1; });
    expect((await undoStep('undo')).did).toBe(true);
    const { live, reloaded } = await liveThenReloaded([['Transform', 'z'], ['Transform', 'x']]);
    expect(reloaded).toEqual([-7, 3]);
    expect(live).toEqual(reloaded);
  });
});
