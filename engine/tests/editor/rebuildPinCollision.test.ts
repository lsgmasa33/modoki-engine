/** A rebuild (Refresh, Revert, every `rebuildInstance` caller) runs the load's pin → derive → drop → settle sequence
 *  (#1777, `deriveMemberGuidsAfterPins`). Driven through the real loader and the real `rebuildInstance`. */

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
import { setActionCallback, pushAction, clearHistory } from '@modoki/engine/editor';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { captureInstanceOverrides } from '../../packages/modoki/src/editor/scene/prefabInstanceOverrides';
import { captureInstanceStructure } from '../../packages/modoki/src/editor/scene/prefabCapture';
import { rebuildInstance } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { deriveMemberGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000001777';
const INST = 'dddddddd-0000-4000-8000-000000001777';
const gR = 'eeeeeeee-0000-4000-8000-000000001771';
const gM = 'eeeeeeee-0000-4000-8000-000000001772';
const gN = 'eeeeeeee-0000-4000-8000-000000001773';
const gX = 'eeeeeeee-0000-4000-8000-000000001774';
const row = (localId: number, name: string, parentId: number, nodeGuid: string, traits: Record<string, unknown> = {}) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 }, ...traits },
});
/** The template as the scene last saw it: R → M. */
const before = () => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [row(1, 'R', 0, gR), row(2, 'M', 1, gM)] });
/** The template after an edit: a new member N at localId 3, and X aiming a member token at M. */
const after = () => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
  row(1, 'R', 0, gR), row(2, 'M', 1, gM), row(3, 'N', 1, gN),
  row(4, 'X', 1, gX, { UIAction: { bindings: [{ event: 'click', kind: 'call', action: 'noop', target: '@member:2' }] } }),
] });
const install = (doc: { id: string }) => { prefabs.set(doc.id, doc); setPrefabCache(doc.id, doc as never); };

async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    onDeletePlaceholder: (id: number) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
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


const named = (name: string) => getAllEntities().filter((e) => e.name === name);
const guidOf = (name: string) => named(name)[0]!.guid;
const sharedGuids = () => {
  const seen = new Map<string, number>();
  for (const e of getAllEntities()) if (e.guid) seen.set(e.guid, (seen.get(e.guid) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([g]) => g);
};
const targetOf = (name: string) => ((readTraitData(named(name)[0]!.id, getTraitByName('UIAction')!) as { bindings: { target: string }[] }).bindings)[0]!.target;

beforeEach(() => { setRunMode('stopped'); clearHistory(); prefabs.clear(); clearKeptMemberOrphans(); });
afterAll(() => { setPrefabCache(P, null); getCurrentWorld()?.destroy(); });

/** #1777: a rebuild pins the member guids it carried across its teardown, then derives the rest — with no collision guard,
 *  where the load has `dropCollidingPins`. Here M's stored row pins it to the guid the EDITED template's derivation hands
 *  the new member N (M once derived at that path: a renumber made it reachable). Before the fix two entities held one guid
 *  after the Refresh and nothing reported it. X's `@member:2` token must name M by the guid M ends up with: settled before
 *  the drop, it kept the dropped pin, which N holds (#1761's shape through the rebuild). Now the rebuild runs the load's sequence, so the pin yields exactly as a reload's
 *  would. Mutations: derive with an empty pinned set in `rebuildInstance` (the guard never sees the pin); settle before the
 *  drop in `deriveMemberGuidsAfterPins` (the token keeps N's guid) — each goes red. */
describe('a rebuild drops a restored pin that collides with a new derivation (#1777)', () => {
  it('no two entities share a guid, the drop is reported, and a token names the member by its final guid', async () => {
    const collide = deriveMemberGuid(INST, [3]); // what N derives under the edited template
    install(before());
    await load({
      id: 's1777', version: 16, name: 'S', resources: [],
      entities: [{ id: 1, prefab: P, guid: INST, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } }, members: { [`/${gM}`]: { guid: collide, name: 'M' } } }],
    } as unknown as SceneData);
    expect(guidOf('M'), 'fixture: the row pins M').toBe(collide);

    install(after());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      rebuildInstance(getAllEntities().find((e) => e.guid === INST)!.id, P, after() as unknown as PrefabFile, {}, {}, before() as unknown as PrefabFile);
      expect(warn.mock.calls.some((c) => String(c[0]).includes(`stored member row pins guid ${collide}`))).toBe(true);
    } finally { warn.mockRestore(); }

    expect(sharedGuids()).toEqual([]);
    expect(guidOf('N')).toBe(collide);
    expect(guidOf('M')).toBeTruthy();
    expect(targetOf('X')).toBe(guidOf('M'));
  });
});

/** The rebuild's two OTHER pin sites (#1777 close-out review: deleting either left every test green). Each pins a guid the
 *  edited template derives for a new member N at localId 3, so the pin must yield exactly as the carried member's does.
 *  - A user-added REFERENCE node inside the instance stores its members' rows on the node (#1482); the rebuild respawns
 *    the node and restores those rows. Mutation: drop `pinned` from that `restoreInstanceMembers` call.
 *  - A row the load KEPT as an orphan (its node was gone from the template) is replayed live when the edited template
 *    brings the node back (#1535). Mutation: drop `pinned` from `settleKeptOrphans`. */
describe('a rebuild drops a colliding pin from every site it pins (#1777 close-out)', () => {
  const P2 = 'cccccccc-0000-4000-8000-000000001778';
  const gLR = 'eeeeeeee-0000-4000-8000-000000001775';
  const gLK = 'eeeeeeee-0000-4000-8000-000000001776';
  const gOrphan = 'eeeeeeee-0000-4000-8000-000000001779';
  const REF = 'dddddddd-0000-4000-8000-000000001778';
  /** The edited template: N is new at localId 3, and derives `deriveMemberGuid(INST, [3])`. */
  const withN = (extra: unknown[] = []) => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
    row(1, 'R', 0, gR), row(2, 'M', 1, gM), row(3, 'N', 1, gN), ...extra,
  ] });
  const rebuildOnto = (next: { id: string }) => {
    const root = getAllEntities().find((e) => e.guid === INST)!.id;
    const old = before() as unknown as PrefabFile;
    install(next);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      rebuildInstance(root, P, next as unknown as PrefabFile, captureInstanceOverrides(root, old), captureInstanceStructure(root, old), old);
      return warn.mock.calls.map((c) => String(c[0]));
    } finally { warn.mockRestore(); }
  };

  it('a member of a user-added reference node', async () => {
    const collide = deriveMemberGuid(INST, [3]);
    const p2 = { id: P2, version: 5, name: 'P2', rootLocalId: 1, entities: [row(1, 'LR', 0, gLR), row(2, 'LK', 1, gLK)] };
    install(p2);
    install(before());
    await load({
      id: 's1777b', version: 16, name: 'S', resources: [],
      entities: [{ id: 1, prefab: P, guid: INST, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } },
        added: [{ parentLocalId: 1, guid: REF, name: 'LR', prefab: P2, traits: {}, children: [], members: { [`/${gLK}`]: { guid: collide, name: 'LK' } } }] }],
    } as unknown as SceneData);
    expect(guidOf('LK'), 'fixture: the node\'s row pins LK').toBe(collide);

    const warned = rebuildOnto(withN());

    expect(warned.some((w) => w.includes(`stored member row pins guid ${collide}`))).toBe(true);
    expect(sharedGuids()).toEqual([]);
    expect(guidOf('N')).toBe(collide);
  });

  it('a kept orphan row the edited template backs again', async () => {
    const collide = deriveMemberGuid(INST, [3]);
    install(before());
    // O is not in the template the scene loads against, so the load keeps its row as an orphan.
    await load({
      id: 's1777c', version: 16, name: 'S', resources: [],
      entities: [{ id: 1, prefab: P, guid: INST, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } }, members: { [`/${gOrphan}`]: { guid: collide, name: 'O' } } }],
    } as unknown as SceneData);
    expect(named('O'), 'fixture: nothing holds the orphan row yet').toHaveLength(0);

    const warned = rebuildOnto(withN([row(4, 'O', 1, gOrphan)]));

    expect(guidOf('O') === collide || guidOf('N') === collide, 'fixture: the replay pinned O to what N derives').toBe(true);
    expect(warned.some((w) => w.includes(`stored member row pins guid ${collide}`))).toBe(true);
    expect(sharedGuids()).toEqual([]);
    expect(guidOf('N')).toBe(collide);
  });
});
