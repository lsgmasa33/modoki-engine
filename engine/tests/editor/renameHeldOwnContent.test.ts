/** #2142 (S8b review L4): a guid rename reaches what an instance's record HOLDS of a user's node, not only its links.
 *
 *  The user's "Mine" hangs under member B, and B is gone from P, so the load holds Mine on the record (`held.heldOwn`,
 *  `holdUnspawnedOwn`) — its only home, which the save writes it from. Mine's Joint2D names member A by guid.
 *  - A rename the LOAD applied (the v18 keyed-guid upgrade, a pin a derivation collided with) reaches the parse through
 *    `renamed`: each record's links followed it (`renameInRecord`), but the parsed own content kept the file's guids —
 *    keyed by them, so a renamed node's content was missed by the hold (lost), and naming them, so a held node's refs
 *    dangled once saved.
 *  - A rename in the session (`applyGuidRemap`: Create Prefab's stamp, a promotion) re-keys the store and renames each
 *    record's rows; `held.heldOwn` was skipped, so the held node's ref to A stayed on A's old guid, and the save wrote it.
 *  Measured red on main before the fix: both cases. */

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, loadSceneFile, instantiatePrefabIntoWorld,
  destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { fillInstanceStoreReporting } from '../../packages/modoki/src/runtime/prefab/instanceLoad';
import { storedRecord } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { applyGuidRemap } from '../../packages/modoki/src/runtime/core/ecs/memberHome';
import { INSTANCE_MODEL_SCENE_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000002142';
const ROOT = 'dddddddd-0000-4000-8000-000000002142';
const MINE = 'ffffffff-0000-4000-8000-000000002142';
const g = (n: number) => `eeeeeeee-0000-4000-8000-00000000214${n}`;

/** P: R → A, and B when `withB`. */
const pDoc = (withB: boolean) => {
  const row = (localId: number, name: string, parentId: number) => ({
    localId, name, nodeGuid: g(localId),
    traits: { EntityAttributes: { name, parentId, guid: '', sortOrder: 0 }, Transform: { x: 0, y: 0, z: 0 } },
  });
  return { id: P, version: 5, name: 'P', rootLocalId: 1, entities: [row(1, 'R', 0), row(2, 'A', 1), ...(withB ? [row(3, 'B', 1)] : [])] };
};

/** The scene: one instance of P, with the user's "Mine" under B; Mine's joint names A (`a`: A's live guid). */
const scene = (a: string): SceneData => ({
  id: 's2142', version: INSTANCE_MODEL_SCENE_VERSION, name: 'S', resources: [],
  entities: [{
    id: 1, prefab: P, guid: ROOT, traits: {},
    members: {
      '/': { traits: { EntityAttributes: { name: 'Inst' } } },
      [`/${g(3)}`]: { own: [{ guid: MINE, name: 'Mine', traits: { EntityAttributes: { name: 'Mine', guid: MINE }, Joint2D: { entityA: a } } }] },
    },
  }],
} as unknown as SceneData);

/** Load `data` into a fresh world with B gone from P, filling the store as SceneManager does, with `renamed`. */
async function load(data: SceneData, renamed: ReadonlyMap<string, string> = new Map()): Promise<void> {
  const d = pDoc(false);
  prefabs.set(P, d); setPrefabCache(P, d as never);
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
  fillInstanceStoreReporting(getCurrentWorld(), JSON.parse(JSON.stringify(data)) as SceneData, undefined, renamed);
}

type Held = { guid?: string; traits?: { Joint2D?: { entityA?: string } } };
/** What the record holds of Mine, at B's row. */
const heldMine = (): Held[] => [...(storedRecord(getCurrentWorld(), ROOT)?.held.heldOwn?.values() ?? [])].flat() as Held[];
const ownLinks = () => [...storedRecord(getCurrentWorld(), ROOT)!.list.rows.values()].flatMap((r) => (r.own ?? []).map((n) => n.guid));

/** A's live guid (derived from the root and its path), from a load of the scene. */
async function aGuid(): Promise<string> {
  await load(scene(''));
  return getAllEntities().find((e) => e.name === 'A')!.guid!;
}

afterEach(() => { prefabs.clear(); });
afterAll(() => { setPrefabCache(P, null); getCurrentWorld()?.destroy(); });

describe('a guid rename reaches the user content a record holds (#2142)', () => {
  it('premise: B gone, Mine is held on the record, its joint naming A', async () => {
    const a = await aGuid();
    await load(scene(a));
    expect(getAllEntities().some((e) => e.name === 'Mine')).toBe(false);
    expect(heldMine().map((n) => [n.guid, n.traits?.Joint2D?.entityA])).toEqual([[MINE, a]]);
  });

  it('a rename the load applied reaches the parsed own content: its key and the refs inside it', async () => {
    const A2 = 'eeeeeeee-0000-4000-8000-0000000021a2', MINE2 = 'ffffffff-0000-4000-8000-0000000021a2';
    const a = await aGuid();
    await load(scene(a), new Map([[a, A2], [MINE, MINE2]]));
    expect(ownLinks(), 'the link follows (it always did)').toEqual([MINE2]);
    // MUTATION TARGET: drop the ownContent rename at `fillInstanceStoreReporting`'s rename and Mine's content stays keyed
    // by MINE: the hold finds none for the renamed link, and the record holds nothing — the save writes a link alone.
    expect(heldMine().map((n) => [n.guid, n.traits?.Joint2D?.entityA])).toEqual([[MINE2, A2]]);
  });

  it('a rename in the session reaches what the record holds', async () => {
    const a = await aGuid();
    await load(scene(a));
    const A2 = 'eeeeeeee-0000-4000-8000-0000000021b2';
    applyGuidRemap(new Map([[a, A2]]));
    expect(getAllEntities().some((e) => e.guid === A2), 'premise: A took the new guid').toBe(true);
    // MUTATION TARGET: drop the `held.heldOwn` rename in `renameInRecord` and the held joint still names A's old guid.
    expect(heldMine().map((n) => n.traits?.Joint2D?.entityA)).toEqual([A2]);
  });
});
