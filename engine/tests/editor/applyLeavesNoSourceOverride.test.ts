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
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { setActionCallback, pushAction, writeTraitFieldWithUndo, reparentEntity } from '@modoki/engine/editor';
import { setPrefabCache, applyToPrefabSelective, getCachedPrefabSync, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAllTraits } from '../../app/ecs/registerTraits';

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
  setRunMode('stopped'); prefabs.clear(); clearKeptMemberOrphans();
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

  it('an applied MOVE does not pin the moved member`s Transform', async () => {
    install(template());
    await load(scene([{ guid: ROOT1, name: 'Root1' }, { guid: ROOT2, name: 'Root2' }]));
    reparentEntity(member('Root1', 'B').id, member('Root1', 'A').id);
    // A pose that differs from B's base, so a pinned Transform would show. (Left at x=0 it equals the base,
    // and this case stayed green with the fix deleted.)
    writeTraitFieldWithUndo(member('Root1', 'B').id, getTraitByName('Transform')!, 'x', 4);
    const result = await applyToPrefabSelective(rootId('Root1'), new Set([`~moved.${gB}`]));
    expect(result.applied).toBe(true);
    expect(result.skipped).toBeUndefined();

    expect(tf('Root2', 'B').x).toBe(4);  // the template carries the move's pose now
    await saveRetuneReload(retuned(getCachedPrefabSync(P)!, 'B', 'x', 9));
    expect(tf('Root2', 'B').x).toBe(9);  // control
    expect(tf('Root1', 'B').x).toBe(9);
  });
});
