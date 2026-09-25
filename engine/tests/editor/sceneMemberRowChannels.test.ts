/** #1468 Phase 4 — a scene member row carries the member's EDITS (`traits`, `removedTraits`,
 *  `removed`, `added`), and the loader applies them to the member the row NAMES, by minted identity.
 *
 *  The point of the whole phase is the renumber case, so most cases here load a scene against a
 *  template whose localIds were SWAPPED after the scene was written (`renumbered`): the same two
 *  members, the same `nodeGuid`s, each one's localId now the other's. A row must still reach its own
 *  member; the legacy localId channel reaches the wrong one, and one case pins that contrast so the
 *  fixture is shown to distinguish the two.
 *
 *  Driven through the real `loadSceneFile` → `instantiatePrefabIntoWorld`. */

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
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const P = 'cccccccc-0000-4000-8000-000000000a01';
const O = 'cccccccc-0000-4000-8000-000000000a02';
const HOLDER = 'dddddddd-0000-4000-8000-000000000a01';
const ROOT = 'dddddddd-0000-4000-8000-000000000a02';
// Node identities, minted in the TEMPLATE (prefab v5).
const gR = 'eeeeeeee-0000-4000-8000-000000000a01';
const gA = 'eeeeeeee-0000-4000-8000-000000000a02';
const gB = 'eeeeeeee-0000-4000-8000-000000000a03';
const gOR = 'eeeeeeee-0000-4000-8000-000000000a04';
const gSlot = 'eeeeeeee-0000-4000-8000-000000000a05';
const gN = 'eeeeeeee-0000-4000-8000-000000000a06';
// Member guids a scene stored.
const A_GUID = 'ffffffff-0000-4000-8000-000000000a02';
const N_GUID = 'ffffffff-0000-4000-8000-000000000a06';

const row = (localId: number, name: string, parentId: number, nodeGuid: string, extra: Record<string, unknown> = {}) => ({
  localId, name, nodeGuid, ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** R with two flat children A and B, as the scene was saved against. */
const template = () => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
  row(1, 'R', 0, gR), row(2, 'A', 1, gA), row(3, 'B', 1, gB),
] });
/** The same template after a re-save RENUMBERED it: A and B swapped localIds, kept their identity. */
const renumbered = () => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
  row(1, 'R', 0, gR), row(2, 'B', 1, gB), row(3, 'A', 1, gA),
] });
/** OR → Slot → N, where N is a nested row expanding P. `nRow` extends N's row (its prefab layer). */
const outer = (nRow: Record<string, unknown> = {}) => ({ id: O, version: 5, name: 'O', rootLocalId: 1, entities: [
  row(1, 'OR', 0, gOR), row(2, 'Slot', 1, gSlot), row(3, 'N', 2, gN, { prefab: P, ...nRow }),
] });
const install = (...docs: { id: string }[]) => { for (const d of docs) prefabs.set(d.id, d); };

const scene = (source: string, entry: Record<string, unknown> = {}): SceneData => ({
  id: 'row-channels', version: SCENE_FORMAT_VERSION, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
    { id: 2, prefab: source, guid: ROOT, traits: { EntityAttributes: { name: 'Root', parentId: HOLDER } }, ...entry },
  ],
} as unknown as SceneData);

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

const named = (name: string) => getAllEntities().filter((e) => e.name === name);
const one = (name: string) => {
  const hits = named(name);
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} entities named ${name}`);
  return hits[0]!;
};
const tf = (name: string) => readTraitData(one(name).id, getTraitByName('Transform')!) as { x: number; y: number } | null;
const parentName = (name: string) => getAllEntities().find((e) => e.id === one(name).parentId)?.name;

beforeEach(() => { setRunMode('stopped'); prefabs.clear(); clearKeptMemberOrphans(); });
afterAll(() => { getCurrentWorld()?.destroy(); });

describe('member row channels reach the member they NAME, across a template renumber (#1468 Phase 4)', () => {
  it('the contrast: a legacy localId override lands on whichever member holds that number now', async () => {
    // Written when A was localId 2. Loaded against the renumbered template, localId 2 is B.
    install(renumbered());
    await load(scene(P, { overrides: { 2: { Transform: { x: 5 } } } }));
    expect(tf('B')?.x).toBe(5);
    expect(tf('A')?.x).toBe(0);
  });

  it('`traits` on A`s row lands on A', async () => {
    install(renumbered());
    await load(scene(P, { members: { [`/${gA}`]: { guid: A_GUID, name: 'A', traits: { Transform: { x: 5 } } } } }));
    expect(tf('A')?.x).toBe(5);
    expect(tf('B')?.x).toBe(0);
  });

  it('`removed: true` deletes A and only A — and a removed row carries no guid and is no orphan', async () => {
    install(renumbered());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await load(scene(P, { members: { [`/${gA}`]: { removed: true } } }));
    expect(named('A')).toHaveLength(0);
    expect(named('B')).toHaveLength(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('member row'))).toEqual([]);
    warn.mockRestore();
  });

  it('`removedTraits` strips the trait from A', async () => {
    install(renumbered());
    await load(scene(P, { members: { [`/${gA}`]: { guid: A_GUID, removedTraits: ['Transform'] } } }));
    expect(tf('A')).toBeNull();
    expect(tf('B')).not.toBeNull();
  });

  it('`added` spawns under A', async () => {
    install(renumbered());
    const extra = { parentLocalId: 0, guid: 'ffffffff-0000-4000-8000-00000000ad01', name: 'Extra', traits: { EntityAttributes: { name: 'Extra' } }, children: [] };
    await load(scene(P, { members: { [`/${gA}`]: { guid: A_GUID, added: [extra] } } }));
    expect(parentName('Extra')).toBe('A');
  });

  it('a row beats the legacy channel for the same member — field by field for traits, whole for a list', async () => {
    install(template());
    await load(scene(P, {
      overrides: { 2: { Transform: { x: 1, y: 1 } } },
      removedTraits: { 3: ['Transform'] },
      members: {
        [`/${gA}`]: { guid: A_GUID, traits: { Transform: { x: 5 } } },
        [`/${gB}`]: { guid: 'ffffffff-0000-4000-8000-000000000a03', removedTraits: [] },
      },
    }));
    expect(tf('A')).toMatchObject({ x: 5, y: 1 });
    // `[]` states "none removed" over the legacy list, so B keeps its Transform.
    expect(tf('B')).not.toBeNull();
  });
});

describe('member row channels inside a NESTED frame (#1468 Phase 4)', () => {
  it('`removed: false` un-deletes a member the outer PREFAB layer deleted', async () => {
    install(template(), outer({ removed: [2] }));
    await load(scene(O));
    expect(named('A')).toHaveLength(0);                     // the prefab layer alone deletes it
    await load(scene(O, { members: { [`/${gN}/${gA}`]: { guid: A_GUID, removed: false } } }));
    expect(named('A')).toHaveLength(1);
  });

  it('a nested member`s `traits` merge over the outer prefab row`s own overrides', async () => {
    install(template(), outer({ overrides: { 2: { Transform: { x: 3 } } } }));
    await load(scene(O, { members: { [`/${gN}/${gA}`]: { guid: A_GUID, traits: { Transform: { y: 4 } } } } }));
    expect(tf('A')).toMatchObject({ x: 3, y: 4 });
  });

  it('the nested ROOT`s row reaches the nested root — its traits, and an addition under it', async () => {
    install(template(), outer());
    const extra = { parentLocalId: 0, guid: 'ffffffff-0000-4000-8000-00000000ad02', name: 'Extra', traits: { EntityAttributes: { name: 'Extra' } }, children: [] };
    await load(scene(O, { members: { [`/${gN}`]: { guid: N_GUID, traits: { Transform: { x: 7 } }, added: [extra] } } }));
    expect(tf('R')?.x).toBe(7);
    expect(parentName('Extra')).toBe('R');
  });

  it('`added: []` on the nested root`s row withdraws the addition its outer prefab row made', async () => {
    const fromPrefab = { parentLocalId: 1, guid: '', key: 'k-extra', name: 'PrefabExtra', traits: { EntityAttributes: { name: 'PrefabExtra' } }, children: [] };
    install(template(), outer({ added: [fromPrefab] }));
    await load(scene(O));
    expect(named('PrefabExtra')).toHaveLength(1);
    await load(scene(O, { members: { [`/${gN}`]: { guid: N_GUID, added: [] } } }));
    expect(named('PrefabExtra')).toHaveLength(0);
  });

  it('`removed: true` on the nested root`s row deletes the whole nested instance', async () => {
    install(template(), outer());
    await load(scene(O, { members: { [`/${gN}`]: { removed: true } } }));
    expect(named('R')).toHaveLength(0);
    expect(named('A')).toHaveLength(0);
    expect(named('Slot')).toHaveLength(1);
  });
});
