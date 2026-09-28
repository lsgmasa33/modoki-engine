/** A reference to a prefab-instance entry names the instance ROOT after a load, not whatever reused the
 *  placeholder's id (#1353).
 *
 *  `loadSceneFile` resolves every entity reference while a prefab entry is still a placeholder, then
 *  destroys the placeholder and instantiates the prefab. koota hands the freed id to the first row the
 *  instantiation spawns, so a reference left pointing at the placeholder lands on the root only when the
 *  prefab lists its root row first. Every prefab here lists it LAST, so recycling cannot mask the bug.
 *
 *  Own file: each `loadScene` creates a koota World and koota caps them at 16 per module graph. Mocks
 *  mirror `sceneManagerPlaceholderGuid.test.ts` (see its header). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';
import { completeResponse } from '../stubs/assetResponse';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({
  name: '', isActive: true, sortOrder: 0, parentId: 0,
  layer: '' as '' | '3d' | '2d' | 'ui', guid: '', sourceScene: '',
});
const TimeLike = trait({ delta: 0, elapsed: 0, frame: 0, smoothedDelta: 0, smoothedElapsed: 0, timeScale: 1 });
const InputLike = trait({});
const PrefabInstanceLike = trait({ source: '', localId: 0, rootInstanceId: 0 });

vi.mock('../../src/runtime/core/traits/Time', () => ({ Time: TimeLike }));
vi.mock('../../src/runtime/traits/Input', () => ({ Input: InputLike }));
vi.mock('../../src/runtime/core/traits/EntityAttributes', () => ({ EntityAttributes }));
vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'string' }, guid: { type: 'string' }, sourceScene: { type: 'string', hidden: true, runtimeOnly: true } } },
    { name: 'Time', trait: TimeLike, category: 'resource', fields: { timeScale: { type: 'number' } } },
    { name: 'Input', trait: InputLike, category: 'resource', fields: {} },
    { name: 'PrefabInstance', trait: PrefabInstanceLike, category: 'component', fields: { source: { type: 'string' }, localId: { type: 'number' }, rootInstanceId: { type: 'number', entityId: { onMissing: 'stripTrait' } } } },
  ];
  return { getAllTraits: () => traits, getTraitByName: (name: string) => traits.find((t) => t.name === name) };
});

const fetchResponses: Record<string, unknown> = {};
// @ts-expect-error mocking global
global.fetch = vi.fn(async (url: string) => {
  for (const [key, body] of Object.entries(fetchResponses)) {
    if (url.endsWith(key) || url === key) return completeResponse({ ok: true, json: async () => body });
  }
  return completeResponse({ ok: false, status: 404, json: async () => ({}) });
});

const PREFAB_GUID = '50000000-0000-4000-8000-0000000000f1';
const INST_GUID = '50000000-0000-4000-8000-0000000000f2';
const OTHER_GUID = '50000000-0000-4000-8000-0000000000f5';
const KID_GUID = '50000000-0000-4000-8000-0000000000f4';

type Row = { id: number; prefab?: string; guid?: string; removed?: number[]; traits: Record<string, unknown> };
const BROKEN_PREFAB_GUID = '50000000-0000-4000-8000-0000000000f7';
const inst = (id: number, guid: string, parentId: number | string = 0): Row =>
  ({ id, prefab: PREFAB_GUID, guid, traits: { Transform: { x: id }, EntityAttributes: { name: `Inst${id}`, parentId, guid } } });
const kid = (parentId: number | string): Row =>
  ({ id: 20, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Kid', parentId, guid: KID_GUID } } });

beforeEach(async () => {
  vi.resetModules();
  for (const k of Object.keys(fetchResponses)) delete fetchResponses[k];
  fetchResponses['/p.prefab.json'] = {
    id: PREFAB_GUID,
    rootLocalId: 1,
    // Root row LAST: the member is spawned first and reclaims the placeholder's id. POrphan's parent
    // names no row, so the instantiation hands it the INSTANCE's parent, as it does the root (#1339).
    entities: [
      { localId: 2, traits: { Transform: { x: 1 }, EntityAttributes: { name: 'PMember', parentId: 1 } } },
      { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'PRoot', parentId: 0 } } },
      { localId: 3, traits: { Transform: { x: 2 }, EntityAttributes: { name: 'POrphan', parentId: 99 } } },
    ],
  };
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  manifest.registerAsset(PREFAB_GUID, '/p.prefab.json', 'prefab');
  // A prefab whose rootLocalId names no row: its rows spawn, but no root comes back.
  fetchResponses['/broken.prefab.json'] = {
    id: BROKEN_PREFAB_GUID,
    rootLocalId: 42,
    entities: [{ localId: 2, traits: { Transform: { x: 1 }, EntityAttributes: { name: 'BMember', parentId: 0 } } }],
  };
  manifest.registerAsset(BROKEN_PREFAB_GUID, '/broken.prefab.json', 'prefab');
});

async function load(entities: Row[]) {
  fetchResponses['/s.json'] = { id: '20000000-0000-4000-8000-0000000000f3', version: 10, resources: [], entities };
  const { sceneManager } = await import('../../src/runtime/scene/SceneManager');
  sceneManager.resetForTesting();
  const { getCurrentWorld, findEntityByGuid, findEntityById } = await import('../../src/runtime/core/ecs/world');
  await sceneManager.loadScene('/s.json');
  const world = getCurrentWorld();
  const ea = (e: { get(t: unknown): unknown } | undefined) => e?.get(EntityAttributes) as { name: string; guid: string; parentId: number } | undefined;
  /** The name and guid of the entity `guid`'s parentId names. */
  const parentOf = (guid: string) => {
    const self = findEntityByGuid(guid, world);
    expect(self, `premise: ${guid} was spawned`).toBeDefined();
    const parent = findEntityById(ea(self)!.parentId, world);
    return { name: ea(parent)?.name, guid: ea(parent)?.guid };
  };
  /** Where every POrphan with a parent landed (one per instance that has a parent). */
  const orphanParents = () => [...world.entities]
    .filter((e) => ea(e)?.name === 'POrphan' && ea(e)!.parentId > 0)
    .map((e) => { const p = findEntityById(ea(e)!.parentId, world); return { name: ea(p)?.name, guid: ea(p)?.guid }; });
  return { world, parentOf, orphanParents, findEntityByGuid, ea };
}

describe('loadSceneFile — a reference to a prefab instance names its root (#1353)', () => {
  // Mutation (each case below): drop `attachEntityIdRefs(...)` in loadSceneFile's prefab loop.
  it('a plain row with a legacy NUMERIC parentId lands under the instance root', async () => {
    const { parentOf } = await load([inst(7, INST_GUID), kid(7)]);
    expect(parentOf(KID_GUID)).toEqual({ name: 'PRoot', guid: INST_GUID });
  });

  it('a plain row with a GUID parentId lands under the instance root', async () => {
    const { parentOf } = await load([inst(7, INST_GUID), kid(INST_GUID)]);
    expect(parentOf(KID_GUID)).toEqual({ name: 'PRoot', guid: INST_GUID });
  });

  // An instance parented to one listed LATER: its parent resolves while that one is still a placeholder.
  it('an instance parented (by guid) to a later instance lands under that instance\'s root', async () => {
    const { parentOf, orphanParents } = await load([inst(7, INST_GUID, OTHER_GUID), inst(8, OTHER_GUID)]);
    expect(parentOf(INST_GUID)).toEqual({ name: 'PRoot', guid: OTHER_GUID });
    // Mutation: drop the `placeholderIds.has(ecsParent)` scan — the orphan lands on OTHER's PMember.
    expect(orphanParents()).toEqual([{ name: 'PRoot', guid: OTHER_GUID }]);
  });

  it('an instance parented (by number) to a later instance lands under that instance\'s root', async () => {
    const { parentOf, orphanParents } = await load([inst(7, INST_GUID, 8), inst(8, OTHER_GUID)]);
    expect(parentOf(INST_GUID)).toEqual({ name: 'PRoot', guid: OTHER_GUID });
    // Mutation: drop the `placeholderIds.has(ecsParent)` scan — the orphan lands on OTHER's PMember.
    expect(orphanParents()).toEqual([{ name: 'PRoot', guid: OTHER_GUID }]);
  });

  // Mutation: drop the `idMap.set(entry.id, rootEcsId)` line (the retarget alone cannot reach this one:
  // an EARLIER instance's placeholder is already gone when the later entry resolves its parent lazily).
  it('an instance parented (by number) to an EARLIER instance lands under that instance\'s root', async () => {
    const { parentOf } = await load([inst(8, OTHER_GUID), inst(7, INST_GUID, 8)]);
    expect(parentOf(INST_GUID)).toEqual({ name: 'PRoot', guid: OTHER_GUID });
  });

  // The other `entityId` field: a legacy trait-form member's rootInstanceId names the instance root, not
  // the member that reclaimed the placeholder's id. (The flat row then shares localId 2 with the freshly
  // expanded member — true before #1353 too, and not what this test is about.)
  it('a legacy trait-form rootInstanceId names the instance root', async () => {
    const MEMBER_GUID = '50000000-0000-4000-8000-0000000000f6';
    const { world, findEntityByGuid, ea } = await load([
      { id: 7, traits: { Transform: { x: 7 }, EntityAttributes: { name: 'Inst7', parentId: 0, guid: INST_GUID }, PrefabInstance: { source: PREFAB_GUID, localId: 1, rootInstanceId: 7 } } },
      { id: 9, traits: { Transform: { x: 9 }, EntityAttributes: { name: 'Stray', parentId: 0, guid: MEMBER_GUID }, PrefabInstance: { source: PREFAB_GUID, localId: 2, rootInstanceId: 7 } } },
    ]);
    const stray = findEntityByGuid(MEMBER_GUID, world)!;
    // A trait-form entry has no top-level guid, so the spawned root carries none: find it by name.
    const roots = [...world.entities].filter((e) => ea(e)?.name === 'PRoot');
    expect(roots, 'premise: the instance was expanded once').toHaveLength(1);
    expect((stray.get(PrefabInstanceLike) as { rootInstanceId: number }).rootInstanceId).toBe(roots[0].id());
  });

  // The member that reclaims the placeholder's id is structurally REMOVED, and the removal cascades by
  // parentId across the world. Mutation: drop `detachEntityIdRefs(...)` (zeroing before the destroy).
  it('a scene child survives its instance removing the member that reclaimed the placeholder id', async () => {
    const { parentOf } = await load([{ ...inst(7, INST_GUID), removed: [2] }, kid(INST_GUID)]);
    expect(parentOf(KID_GUID)).toEqual({ name: 'PRoot', guid: INST_GUID });
  });

  it('an instance parented to a later instance survives that instance removing the reclaiming member', async () => {
    const { parentOf, orphanParents } = await load([inst(7, INST_GUID, OTHER_GUID), { ...inst(8, OTHER_GUID), removed: [2] }]);
    expect(parentOf(INST_GUID)).toEqual({ name: 'PRoot', guid: OTHER_GUID });
    expect(orphanParents()).toEqual([{ name: 'PRoot', guid: OTHER_GUID }]);
  });

  // A prefab that loads but expands to no root is a reference the load cannot expand (#1768, I18): its entry keeps its
  // pass-1 placeholder, exactly as a MISSING prefab's does, so its children stay under it, on the production path
  // (SceneManager). Before, its rows spawned root-less and the children fell to the scene root. Mutation: drop
  // `fetchedExpandsToRoot` at the entry site — BMember spawns, and the children land at the root.
  it('a child of an instance whose prefab expands to no root stays under its placeholder, as a missing prefab\'s does', async () => {
    const broken = (id: number, guid: string): Row => ({ ...inst(id, guid), prefab: BROKEN_PREFAB_GUID });
    const { world, findEntityByGuid, ea, parentOf } = await load([broken(7, INST_GUID), kid(INST_GUID), inst(8, OTHER_GUID, 7)]);
    expect([...world.entities].some((e) => ea(e)?.name === 'BMember'), 'nothing of the root-less prefab spawns').toBe(false);
    const placeholder = findEntityByGuid(INST_GUID, world);
    expect(placeholder, 'the entry keeps its placeholder').toBeDefined();
    expect(parentOf(KID_GUID).guid, 'guid child').toBe(INST_GUID);
    expect(ea(findEntityByGuid(OTHER_GUID, world))?.parentId, 'numeric child instance').toBe(placeholder!.id());
  });

  // A trait-form member of an instance whose prefab expands to no root: the root entry keeps its placeholder (#1768), so
  // the member keeps a PrefabInstance naming it, exactly as a member of a MISSING prefab's instance does. Mutation: drop
  // `fetchedExpandsToRoot` at the entry site — the instantiation spawns nothing, and the member loses its PrefabInstance.
  it('a legacy trait-form member of an instance whose prefab expands to no root is kept as a missing prefab\'s is', async () => {
    const MEMBER_GUID = '50000000-0000-4000-8000-0000000000f8';
    const { world, findEntityByGuid } = await load([
      { id: 7, traits: { Transform: { x: 7 }, EntityAttributes: { name: 'Inst7', parentId: 0, guid: INST_GUID }, PrefabInstance: { source: BROKEN_PREFAB_GUID, localId: 1, rootInstanceId: 7 } } },
      { id: 9, traits: { Transform: { x: 9 }, EntityAttributes: { name: 'Stray', parentId: 0, guid: MEMBER_GUID }, PrefabInstance: { source: BROKEN_PREFAB_GUID, localId: 2, rootInstanceId: 7 } } },
    ]);
    const stray = findEntityByGuid(MEMBER_GUID, world);
    expect(stray, 'premise: the member row spawned').toBeDefined();
    expect(stray!.has(PrefabInstanceLike)).toBe(true);
    expect((stray!.get(PrefabInstanceLike) as { rootInstanceId: number }).rootInstanceId).toBe(findEntityByGuid(INST_GUID, world)!.id());
  });
});
