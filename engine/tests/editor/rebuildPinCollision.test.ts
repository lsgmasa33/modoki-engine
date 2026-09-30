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
import { refreshInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
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

/** #1777: a rebuild pins the member guids it carried across its teardown, then derives the rest, as the load does. Here
 *  M's stored row pins it to the guid the EDITED template's derivation hands the new member N (M once derived at that
 *  path: a renumber made it reachable). Before #1777 two entities held one guid after the Refresh and nothing reported it.
 *  Since #1882 the DERIVATION yields: N takes a salted guid, M keeps its pin (the identity the scene's refs hold), and X's
 *  `@member:2` token names M. Mutation: restore the carried members AFTER the derive in `rebuildInstance` — N derives the
 *  pinned guid first, and M's restore lands on it: two holders. */
describe('a rebuild never lets a new derivation take a restored pin (#1777, #1882)', () => {
  it('no two entities share a guid, M keeps its pin, N salts and it is reported, and a token names M', async () => {
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
      refreshInstances(P, [getAllEntities().find((e) => e.guid === INST)!.id], before() as unknown as PrefabFile, after() as unknown as PrefabFile);
      expect(warn.mock.calls.some((c) => String(c[0]).includes(`derives guid ${collide}, which "M" already holds`))).toBe(true);
    } finally { warn.mockRestore(); }

    expect(sharedGuids()).toEqual([]);
    expect(guidOf('M')).toBe(collide);
    expect(guidOf('N')).toBeTruthy();
    expect(guidOf('N')).not.toBe(collide);
    expect(targetOf('X')).toBe(guidOf('M'));
  });
});

/** The rebuild's two OTHER pin sites (#1777 close-out review: deleting either left every test green). Each pins a guid the
 *  edited template derives for a new member N at localId 3; since #1882 the pin stays and N salts, as with the carried
 *  member. What each site must do is land its pin BEFORE the derive:
 *  - A user-added REFERENCE node inside the instance stores its members' rows on the node (#1482); the rebuild respawns
 *    the node and restores those rows. Mutation: restore the reference-node rows after the derive.
 *  - A row the load KEPT as an orphan (its node was gone from the template) is replayed live when the edited template
 *    brings the node back (#1535). ⚠️ This case pins the OUTCOME, not `settleKeptOrphans`: for a top-level instance the
 *    carried members (`captureInstanceMembers` writes kept orphans back) land the same pin before the derive, so moving
 *    `settleKeptOrphans` after the derive stays green (measured, #1882). Its own reach is a nested frame's OUTER orphan
 *    rows (`rowWritingRoot`), not built here. */
describe('a rebuild lands every pin it restores before the derive, so a new derivation salts around it (#1777 close-out, #1882)', () => {
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
      refreshInstances(P, [root], old, next as unknown as PrefabFile);
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

    expect(warned.some((w) => w.includes(`derives guid ${collide}, which "LK" already holds`))).toBe(true);
    expect(sharedGuids()).toEqual([]);
    expect(guidOf('LK')).toBe(collide);
    expect(guidOf('N')).not.toBe(collide);
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

    expect(warned.some((w) => w.includes(`derives guid ${collide}, which "O" already holds`))).toBe(true);
    expect(sharedGuids()).toEqual([]);
    expect(guidOf('O'), 'the replayed pin keeps its guid').toBe(collide);
    expect(guidOf('N')).not.toBe(collide);
  });
});

/** #1882, hunt seed 1044's shape: a NESTED frame is rebuilt (an Apply to Q refreshes every Q frame) while a pin of the
 *  OUTER frame holds the guid a new member of the nested one derives. R was made by Create Prefab from a P instance before
 *  #1882 M2 (a), so R numbers its rows by position (QR=2, A=3, B=4) while B keeps the guid it derived under P's numbering,
 *  INST|2.3 — exactly what Q's new row 3 derives under R's nested Q at step 2. The nested rebuild's own pins were the only
 *  ones its collision pass saw, so two entities shared B's guid (I7); a save then pinned both, the load dropped both, and
 *  every ref to B retargeted onto N. Since #1882 the derivation yields in every derive (load and rebuild alike), so:
 *  B keeps its guid and its refs, and N takes ONE salted guid — live after the rebuild, after a reload of the scene as it
 *  was, and after a save → reload that pins it. Mutation: return the plain derivation from `deriveMemberGuidAvoiding` —
 *  B and N share a guid after the rebuild. */
describe('a nested frame\'s new member never takes an OUTER frame\'s pin (#1882)', () => {
  const Q = 'cccccccc-0000-4000-8000-000000188211';
  const R = 'cccccccc-0000-4000-8000-000000188212';
  const INST_R = 'dddddddd-0000-4000-8000-000000188212';
  const HOLDER = 'dddddddd-0000-4000-8000-000000188213';
  const n = (k: number) => `eeeeeeee-0000-4000-8000-0000001882${String(k).padStart(2, '0')}`;
  const qV1 = () => ({ id: Q, version: 6, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0, n(11)), row(2, 'M', 1, n(12))] });
  const qV2 = () => ({ id: Q, version: 6, name: 'Q', rootLocalId: 1, nextLocalId: 4, entities: [row(1, 'QR', 0, n(11)), row(2, 'M', 1, n(12)), row(3, 'N956', 1, n(13))] });
  const rDoc = () => ({ id: R, version: 6, name: 'R', rootLocalId: 1, nextLocalId: 5, entities: [
    row(1, 'R', 0, n(1)), { ...row(2, 'QR', 1, n(2)), prefab: Q }, row(3, 'A', 1, n(3)), row(4, 'B', 3, n(4)),
  ] });
  /** The scene: R's instance with B pinned at its P-era guid, and a plain entity whose action targets B. */
  const scene = (bGuid: string) => ({ id: 's1882', version: 18, name: 'S', resources: [], entities: [
    { id: 1, prefab: R, guid: INST_R, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } }, members: { [`/${n(4)}`]: { guid: bGuid, name: 'B' } } },
    { id: 2, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER }, UIAction: { bindings: [{ event: 'click', kind: 'call', action: 'noop', target: bGuid }] } } },
  ] } as unknown as SceneData);

  it('B keeps its guid and its refs; N takes one salted guid, live, after a reload, and after save → reload', async () => {
    const pinB = deriveMemberGuid(INST_R, [2, 3]); // B's P-era guid = what N956 derives under R's nested Q
    install(qV1()); install(rDoc());
    await load(scene(pinB));
    expect(guidOf('B'), 'fixture: the row pins B').toBe(pinB);
    expect(named('N956'), 'fixture: Q has no N956 yet').toHaveLength(0);

    // The Apply's refresh of every Q frame: R's nested QR, rebuilt onto Q with row 3.
    install(qV2());
    const nested = getAllEntities().find((e) => e.name === 'QR' && e.parentId === getAllEntities().find((x) => x.guid === INST_R)!.id)!.id;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      refreshInstances(Q, [nested], qV1() as unknown as PrefabFile, qV2() as unknown as PrefabFile);
      expect(warn.mock.calls.some((c) => String(c[0]).includes(`derives guid ${pinB}, which "B" already holds`))).toBe(true);
    } finally { warn.mockRestore(); }
    expect(sharedGuids()).toEqual([]);
    expect(guidOf('B')).toBe(pinB);
    expect(targetOf('Holder')).toBe(pinB);
    const salted = guidOf('N956');
    expect(salted).not.toBe(pinB);

    // A reload of the scene as it was saved BEFORE the Apply: the load salts the same way.
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await load(scene(pinB));
      expect([guidOf('B'), guidOf('N956'), targetOf('Holder')]).toEqual([pinB, salted, pinB]);
      // …and a save → reload, which pins N956's salted guid as a row.
      const saved = await serializeScene();
      await load(saved as unknown as SceneData);
    } finally { quiet.mockRestore(); }
    expect(sharedGuids()).toEqual([]);
    expect([guidOf('B'), guidOf('N956'), targetOf('Holder')]).toEqual([pinB, salted, pinB]);
  });
});
