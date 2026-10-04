/** #1469 — Apply to Prefab must not leave what it applied as an override on the instance it was
 *  applied FROM.
 *
 *  The refresh after Apply captures every instance against the OLD document, and the applied field is
 *  still override-MARKED there, so the capture kept it and the rebuild re-seeded the mark. The value
 *  equalled the new base, so the override list (a value diff) showed nothing, while the save wrote it
 *  and it pinned the instance: a later template edit to that field moved every instance but this one.
 *
 *  Each case therefore asserts the pin itself, not the listing: apply, save, change the TEMPLATE's value
 *  for the applied field, reload, and read the field. An instance still carrying the override reads the
 *  applied value instead of the template's new one. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { whyWorldNotAuthored } from '../../packages/modoki/src/editor/scene/authoredWorld';
import { NO_RECORD_TO_WRITE } from '../../packages/modoki/src/editor/instance/instanceRollback';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData, type SceneEntityEntry,
} from '@modoki/engine/runtime';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { setActionCallback, pushAction, writeTraitFieldWithUndo } from '@modoki/engine/editor';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache, getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { applyToPrefabSelective } from '../../packages/modoki/src/editor/scene/prefabApply';
import { rebaseStaleInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { dropInstanceRecord, storedRecord } from '../../packages/modoki/src/runtime/prefab/instanceStore';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000001469';
const HOLDER = 'dddddddd-0000-4000-8000-000000001469';
const ROOT1 = 'dddddddd-0000-4000-8000-000000011469';
const ROOT2 = 'dddddddd-0000-4000-8000-000000021469';
const gR = 'eeeeeeee-0000-4000-8000-000000001469';
const gA = 'eeeeeeee-0000-4000-8000-000000011469';
const gB = 'eeeeeeee-0000-4000-8000-000000021469';

const row = (localId: number, name: string, parentId: number, nodeGuid: string) => ({
  localId, name, nodeGuid,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 }, Renderable3DPrimitive: {} },
});
const template = () => ({
  id: P, version: 5, name: 'P', rootLocalId: 1,
  entities: [row(1, 'R', 0, gR), row(2, 'A', 1, gA), row(3, 'B', 1, gB)],
});
/** What the owner does after the apply: edits the template's value of `name`'s `field` (#1469 step 5). */
const retuned = (doc: PrefabFile, name: string, field: 'x' | 'y', value: number) => {
  const out = JSON.parse(JSON.stringify(doc)) as PrefabFile;
  const tf = out.entities.find((e) => e.name === name)!.traits.Transform as Record<string, number>;
  tf[field] = value;
  return out;
};
const install = (d: { id: string }) => { prefabs.set(d.id, d); setPrefabCache(d.id, d as never); };

const scene = (roots: { guid: string; name: string; entry?: Record<string, unknown> }[]): SceneData => ({
  id: 'apply-source', version: SCENE_FORMAT_VERSION, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
    ...roots.map((r, i) => ({ id: i + 2, prefab: P, guid: r.guid, traits: { EntityAttributes: { name: r.name, parentId: HOLDER } }, ...r.entry })),
  ],
} as unknown as SceneData);

async function load(data: unknown): Promise<void> {
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
        getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source,
        overrides, structure, undefined, nested, nestedStructure,
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

const ROOT_GUID: Record<string, string> = { Root1: ROOT1, Root2: ROOT2 };
/** The instance root `root` names, found by its scene guid (both roots carry the template's name). */
const rootId = (root: string) => getAllEntities().find((e) =>
  (readTraitData(e.id, getTraitByName('EntityAttributes')!) as { guid?: string } | null)?.guid === ROOT_GUID[root])!.id;
/** Member `name` of the instance `root` — two instances hold one of each name. */
const member = (root: string, name: string) => {
  const all = getAllEntities();
  const rootEcs = rootId(root);
  const under = (id: number): boolean => {
    const e = all.find((x) => x.id === id);
    return !!e && (e.parentId === rootEcs || under(e.parentId));
  };
  const hits = all.filter((e) => e.name === name && under(e.id));
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} ${name} under ${root}`);
  return hits[0]!;
};
const tf = (root: string, name: string) => readTraitData(member(root, name).id, getTraitByName('Transform')!) as { x: number; y: number };
const entries = async () => {
  const saved = await serializeScene() as unknown as { entities: SceneEntityEntry[] };
  return Object.fromEntries(saved.entities.filter((e) => !!e.prefab).map((e) => [(e as { guid: string }).guid, e])) as unknown as Record<string, Record<string, unknown>>;
};
/** Save, swap the template for `next`, reload from the save — the owner's step 5 of #1469. */
const saveRetuneReload = async (next: PrefabFile) => {
  const saved = await entries();
  install(next as { id: string });
  await load(scene([{ guid: ROOT1, name: 'Root1', entry: saved[ROOT1] }, { guid: ROOT2, name: 'Root2', entry: saved[ROOT2] }]));
};

beforeEach(() => {
  setRunMode('stopped'); prefabs.clear();
  // The apply writes the prefab file through the dev-server API.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response));
});
afterAll(() => { getCurrentWorld()?.destroy(); vi.unstubAllGlobals(); });

describe('Apply leaves no override behind on the instance it applied from (#1469)', () => {
  it('an applied FIELD tracks a later template edit on the source instance', async () => {
    install(template());
    await load(scene([{ guid: ROOT1, name: 'Root1' }, { guid: ROOT2, name: 'Root2' }]));
    writeTraitFieldWithUndo(member('Root1', 'A').id, getTraitByName('Transform')!, 'x', 5);
    const result = await applyToPrefabSelective(rootId('Root1'), new Set([`${gA}.Transform.x`]));
    expect(result.applied).toBe(true);
    expect(tf('Root1', 'A').x).toBe(5);
    expect(tf('Root2', 'A').x).toBe(5);  // the template carries it now

    await saveRetuneReload(retuned(getCachedPrefabSync(P)!, 'A', 'x', 9));
    expect(tf('Root2', 'A').x).toBe(9);  // control: an instance that never overrode the field follows
    expect(tf('Root1', 'A').x).toBe(9);  // the source instance follows too — it was pinned at 5
  });

  it('ANOTHER instance`s own override of the same field survives the apply', async () => {
    install(template());
    await load(scene([{ guid: ROOT1, name: 'Root1' }, { guid: ROOT2, name: 'Root2' }]));
    writeTraitFieldWithUndo(member('Root1', 'A').id, getTraitByName('Transform')!, 'x', 5);
    writeTraitFieldWithUndo(member('Root2', 'A').id, getTraitByName('Transform')!, 'x', 7);
    await applyToPrefabSelective(rootId('Root1'), new Set([`${gA}.Transform.x`]));

    await saveRetuneReload(retuned(getCachedPrefabSync(P)!, 'A', 'x', 9));
    expect(tf('Root1', 'A').x).toBe(9);
    expect(tf('Root2', 'A').x).toBe(7);  // subtracted only from the instance applied FROM
  });

  it('a field edited but NOT selected stays an override on the source instance', async () => {
    install(template());
    await load(scene([{ guid: ROOT1, name: 'Root1' }, { guid: ROOT2, name: 'Root2' }]));
    writeTraitFieldWithUndo(member('Root1', 'A').id, getTraitByName('Transform')!, 'x', 5);
    writeTraitFieldWithUndo(member('Root1', 'A').id, getTraitByName('Transform')!, 'y', 3);
    await applyToPrefabSelective(rootId('Root1'), new Set([`${gA}.Transform.x`]));

    await saveRetuneReload(retuned(retuned(getCachedPrefabSync(P)!, 'A', 'x', 9), 'A', 'y', 8));
    expect(tf('Root1', 'A')).toMatchObject({ x: 9, y: 3 });
  });
});

// #2046 S7.3 (rule 7, § 3.2's fan-out row): an Apply changes only the applying instance's list. Every OTHER instance of
// the prefab is reprojected from its own record onto the new template — its list kept exactly, fresh — not rebuilt from
// a capture of its live tree. The applying instance's applied statement leaves its record (U15, `subtractApplied`,
// #2001 S8b): it is reprojected from that record too, fresh, and shows the value as the prefab's.
describe('Apply reprojects the other instances from their records (#2046 S7.3)', () => {
  it('another instance keeps its exact record, fresh, and shows the applied value under its own override', async () => {
    install(template());
    await load(scene([{ guid: ROOT1, name: 'Root1' }, { guid: ROOT2, name: 'Root2' }]));
    writeTraitFieldWithUndo(member('Root2', 'B').id, getTraitByName('Transform')!, 'y', 3);
    // The scene as this editor saves it, reloaded: its records hold the identity pins a save writes for every present
    // member (rule 5), which the Apply's fan-out pins too. The fixture's hand-written file states none.
    await saveRetuneReload(getCachedPrefabSync(P)!);
    writeTraitFieldWithUndo(member('Root1', 'A').id, getTraitByName('Transform')!, 'x', 5);
    const before = structuredClone(storedRecord(getCurrentWorld(), ROOT2));
    expect(before?.list.rows.size).toBeGreaterThan(0); // precondition: Root2 holds a record of its own

    const result = await applyToPrefabSelective(rootId('Root1'), new Set([`${gA}.Transform.x`]));
    expect(result.applied).toBe(true);
    expect(storedRecord(getCurrentWorld(), ROOT2)).toEqual(before);
    expect(tf('Root2', 'A').x).toBe(5); // the new template's value
    expect(tf('Root2', 'B').y).toBe(3); // its own override
    // The applying tree: on records, fresh, with no statement of the applied field left, and the value now the prefab's.
    const applying = storedRecord(getCurrentWorld(), ROOT1);
    expect(applying, 'the applying tree keeps a fresh record').toBeTruthy();
    expect([...applying!.list.rows.values()].some((r) => (r.traits?.Transform as { x?: number } | undefined)?.x !== undefined), 'the applied statement left it').toBe(false);
    expect(tf('Root1', 'A').x).toBe(5);
  });
});

// #2001 S8b: a stored root's order is its placement, which no row states. An Apply of it changes the template's, and the
// applying tree's records stay on records with that placement untouched, beside the applied field that leaves them.
describe('an Apply of the root\'s order keeps the applying tree on records (#2001 S8b)', () => {
  it('the record stays fresh, its placement as it was, and the applied field leaves it', async () => {
    install(template());
    await load(scene([{ guid: ROOT1, name: 'Root1' }, { guid: ROOT2, name: 'Root2' }]));
    writeTraitFieldWithUndo(rootId('Root1'), getTraitByName('EntityAttributes')!, 'sortOrder', 4);
    writeTraitFieldWithUndo(member('Root1', 'A').id, getTraitByName('Transform')!, 'x', 5);
    const placement = structuredClone(storedRecord(getCurrentWorld(), ROOT1)!.placement);

    const result = await applyToPrefabSelective(rootId('Root1'), new Set([`${gR}.EntityAttributes.sortOrder`, `${gA}.Transform.x`]));
    expect(result.applied).toBe(true);
    const rec = storedRecord(getCurrentWorld(), ROOT1);
    expect(rec, 'the applying tree keeps a fresh record').toBeTruthy();
    expect(rec!.placement).toEqual(placement);
    expect([...rec!.list.rows.values()].some((r) => (r.traits?.Transform as { x?: number } | undefined)?.x !== undefined)).toBe(false);
  });
});

// #2046 S7.3: a tree a rebase reprojected from its own record keeps it, exactly as it was; #2001 S8b: a tree with no record
// is not rebuilt from the capture any more — left as it was, and the world marked unsavable (`leftRecordless`).
// Mutation: drop `leftRecordless` from `rebuildTargetsByEntry` — Root1 is rebuilt from its capture (x 9, counted 2).
describe('a rebase reprojects a tree from its record and leaves one with none (#2046 S7.3, #2001 S8b)', () => {
  it('a fresh tree is reprojected and keeps its record; a tree with none is left as it was and blocks the save', async () => {
    install(template());
    await load(scene([{ guid: ROOT1, name: 'Root1' }, { guid: ROOT2, name: 'Root2' }]));
    writeTraitFieldWithUndo(member('Root2', 'B').id, getTraitByName('Transform')!, 'y', 3);
    const before = structuredClone(storedRecord(getCurrentWorld(), ROOT2));
    expect(before, 'premise: Root2 holds a fresh record').toBeTruthy();
    // A load records every tree (#2001 S8b): Root1's record dropped is a state no gesture makes. A rebuild never rebuilds
    // it from its live tree (hub ruling): it is left as it was, said, and the world marked unsavable.
    dropInstanceRecord(getCurrentWorld(), ROOT1);
    expect(storedRecord(getCurrentWorld(), ROOT1), 'premise: Root1 holds none').toBeUndefined();

    install(retuned(getCachedPrefabSync(P)!, 'A', 'x', 9) as { id: string });
    const x1 = tf('Root1', 'A').x;
    expect(x1, 'premise: the retune changes it').not.toBe(9);
    expect(await rebaseStaleInstances()).toBe(1);
    expect(tf('Root1', 'A').x).toBe(x1);
    expect(whyWorldNotAuthored()).toBe(NO_RECORD_TO_WRITE);
    expect(tf('Root2', 'A').x).toBe(9);
    expect(tf('Root2', 'B').y).toBe(3);
    expect(storedRecord(getCurrentWorld(), ROOT2)).toEqual(before);
  });
});
