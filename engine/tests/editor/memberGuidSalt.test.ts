/** #1882 M2 (b): a member's derivation steps around a guid another entity already holds (`deriveMemberGuidAvoiding`),
 *  and every site that PREDICTS or RECOGNISES a member guid without the derive's own holders answers the same way:
 *  - the pure rule: plain when free, `#1`, `#2`, … past each holder; recognised by `isMemberDerivation`;
 *  - key recovery (`recoverTemplateKey`): a keyed node whose derivation was salted, stored by a save, gets its key back;
 *  - the live predictor (`reloadDerivedGuids`, under Create Prefab's stamp and the v17 upgrade): it predicts the salted
 *    guid a reload gives, not the plain one. Driven through the real loader. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { deriveMemberGuid, deriveMemberGuidAvoiding, isMemberDerivation, deriveGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { recoverTemplateKey, type KeyRecoveryNode } from '../../packages/modoki/src/runtime/loaders/templateKeyRecovery';
import { reloadDerivedGuids } from '../../packages/modoki/src/runtime/core/ecs/memberHome';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const A = 'aaaaaaaa-0000-4000-8000-000000188220';

describe('the salt rule (#1882)', () => {
  it('plain when nothing holds it; #1 past a holder; #2 past two; recognised either way', () => {
    const plain = deriveMemberGuid(A, [2, 3]);
    const s1 = deriveGuid(`${A}|2.3#1`);
    const s2 = deriveGuid(`${A}|2.3#2`);
    expect(deriveMemberGuidAvoiding(A, [2, 3], () => false)).toEqual({ guid: plain, salt: 0 });
    expect(deriveMemberGuidAvoiding(A, [2, 3], (g) => g === plain)).toEqual({ guid: s1, salt: 1 });
    expect(deriveMemberGuidAvoiding(A, [2, 3], (g) => g === plain || g === s1)).toEqual({ guid: s2, salt: 2 });
    for (const g of [plain, s1, s2]) expect(isMemberDerivation(g, A, [2, 3]), g).toBe(true);
    // (reject) another path's derivation, and another anchor's.
    expect(isMemberDerivation(deriveMemberGuid(A, [3, 2]), A, [2, 3])).toBe(false);
    expect(isMemberDerivation(deriveMemberGuid('aaaaaaaa-0000-4000-8000-000000188221', [2, 3]), A, [2, 3])).toBe(false);
  });

  // Mutation: compare against `deriveMemberGuid` alone in `recoverTemplateKey` — the salted node's key is not recovered.
  it('key recovery gives a SALTED keyed node its key back', () => {
    const K = 'cccccccc-0000-4000-8000-000000188222';
    const salted = deriveGuid(`${A}|+${K}#1`);
    const nodes = new Map<number, KeyRecoveryNode>([
      [1, { guid: A, parentId: 0, key: '', pi: { localId: 1 } }],
      [2, { guid: salted, parentId: 1, key: '', pi: null }],
    ]);
    expect(recoverTemplateKey(2, (id) => nodes.get(id), new Set([K]))).toBe(K);
    // (reject) a guid that is no derivation of the key keeps none.
    nodes.set(2, { guid: 'bbbbbbbb-0000-4000-8000-000000188222', parentId: 1, key: '', pi: null });
    expect(recoverTemplateKey(2, (id) => nodes.get(id), new Set([K]))).toBe('');
  });
});

describe('the live predictor salts as the reload does (#1882)', () => {
  const OLD = 'cccccccc-0000-4000-8000-000000188223';
  const INST = 'dddddddd-0000-4000-8000-000000188223';
  /** A pre-v5 template: no nodeGuids, so its members get no ROW and every reload DERIVES them — what the predictor is for. */
  const oldDoc = { id: OLD, version: 4, name: 'Old', rootLocalId: 1, entities: [
    { localId: 1, name: 'Old', traits: { EntityAttributes: { name: 'Old', parentId: 0, guid: '' } } },
    { localId: 2, name: 'Leaf', traits: { EntityAttributes: { name: 'Leaf', parentId: 1, guid: '' } } },
  ] };
  beforeEach(() => { setRunMode('stopped'); prefabs.clear(); prefabs.set(OLD, oldDoc); setPrefabCache(OLD, oldDoc as never); });
  afterAll(() => { setPrefabCache(OLD, null); getCurrentWorld()?.destroy(); });

  async function load(data: SceneData): Promise<void> {
    const prev = getCurrentWorld();
    setCurrentWorld(createWorld());
    prev?.destroy();
    const eaMeta = getTraitByName('EntityAttributes')!;
    await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
      loadModels: false,
      onDeletePlaceholder: (id: number) => { for (const e of getCurrentWorld().entities) if (e.id() === id) { destroyEntity(e, getCurrentWorld()); break; } },
      fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
      onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure) => {
        const id = instantiatePrefabIntoWorld(getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
        if (id && rootGuid) for (const e of getCurrentWorld().entities) if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), guid: rootGuid });
        return id ?? undefined;
      },
    });
  }

  // Mutation: derive plainly in `reloadDerivedGuids` (`deriveMemberGuid(from, …)`) — it predicts the plain guid, which
  // the plain entity holds, while the loaded Leaf holds the salted one.
  it('a rowless member whose plain derivation another entity holds: predicted salted, equal to what the load gave it', async () => {
    const plain = deriveMemberGuid(INST, [2]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await load({ id: 'salt', version: 18, name: 'S', resources: [], entities: [
        { id: 1, prefab: OLD, guid: INST, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } } },
        { id: 2, traits: { EntityAttributes: { name: 'Squatter', parentId: 0, guid: plain } } },
      ] } as unknown as SceneData);
    } finally { warn.mockRestore(); }
    const leaf = getAllEntities().find((e) => e.name === 'Leaf')!;
    expect(leaf.guid, 'premise: the load salted Leaf').not.toBe(plain);
    expect(isMemberDerivation(leaf.guid!, INST, [2])).toBe(true);
    const root = getAllEntities().find((e) => e.guid === INST)!.id;
    const predicted = [...reloadDerivedGuids(getCurrentWorld(), root, INST)].map(([e, g]) => [e.id(), g]);
    expect(predicted).toEqual([[leaf.id, leaf.guid]]);
  });
});
