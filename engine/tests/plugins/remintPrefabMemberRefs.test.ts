/** #1324 — duplicating a scene carries in-file refs to prefab-instance MEMBERS along with the
 *  reminted anchor. A member's guid is never stored (`deriveInstanceMemberGuids` derives it on
 *  load from the nearest guid-carrying ancestor), so these tests never hand-compute one: they load
 *  the ORIGINAL through the real loader, read the member guids it derived, store refs to them,
 *  duplicate, load the COPY, and require each ref in the copy to resolve to the member at the same
 *  place in the tree. That pins `derivedMemberPaths` to the loader's step rule instead of to a
 *  second copy of it. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName,
  loadSceneFile, instantiatePrefabIntoWorld, deleteEntity, type SceneData,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { remintSceneEntityGuids, derivedMemberPaths } from '../../plugins/asset-fs-ops';

registerAllTraits();

const INNER = 'aaaaaaaa-0000-4000-8000-000000000001';
const OUTER = 'aaaaaaaa-0000-4000-8000-000000000002';
const ROOT = 'bbbbbbbb-0000-4000-8000-000000000001';      // the scene instance root
const ANCHORED = 'bbbbbbbb-0000-4000-8000-000000000002';  // an added nested instance with its own guid
const UI = 'bbbbbbbb-0000-4000-8000-000000000003';

const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
// Inner: Leaf sits one below the root. Outer: Panel → Button (two deep) and Panel → a nested Inner.
const innerDoc = { id: INNER, rootLocalId: 1, entities: [row(1, 'InnerRoot', 0), row(2, 'Leaf', 1)] };
const outerDoc = {
  id: OUTER, rootLocalId: 1, entities: [
    row(1, 'OuterRoot', 0), row(2, 'Panel', 1), row(3, 'Button', 2), row(4, 'Nested', 2, { prefab: INNER }),
  ],
};

/** The scene: one Outer instance carrying two user-added nested Inner instances — one with no
 *  guid of its own (its members derive from ROOT) and one with its own guid (they derive from it). */
function baseScene(refs: string[]): SceneData {
  return {
    id: 'scene-asset', version: 1, name: 'S', resources: [],
    entities: [
      {
        id: 1, prefab: OUTER, guid: ROOT,
        traits: { EntityAttributes: { name: 'OuterRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } },
        added: [
          { parentLocalId: 3, guid: '', name: 'AddedLoose', prefab: INNER, traits: {}, children: [] },
          { parentLocalId: 1, guid: ANCHORED, name: 'AddedAnchored', prefab: INNER, traits: {}, children: [] },
        ],
      },
      {
        id: 2,
        traits: {
          EntityAttributes: { name: 'Ui', parentId: 0, guid: UI },
          UIAction: { bindings: refs.map((target) => ({ event: 'click', action: 'noop', target })) },
        },
      },
    ],
  } as unknown as SceneData;
}

async function load(scene: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  // Mirrors SceneManager's onInstantiatePrefab: structure + nested overrides + the root guid.
  await loadSceneFile(JSON.parse(JSON.stringify(scene)), {
    loadModels: false,
    fetchPrefab: async (ref) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id) => deleteEntity(id),
    onInstantiatePrefab: async (source, parentId, rootTf, _old, _extra, overrides, structure, nested, rootGuid) => {
      const world = getCurrentWorld();
      const rootId = instantiatePrefabIntoWorld(world, prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested);
      if (!rootId || !rootGuid) return;
      for (const e of world.entities) {
        if (e.id() !== rootId) continue;
        e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid: rootGuid });
      }
    },
  });
}

/** guid → the entity's name chain from the scene root ("OuterRoot/Panel/Button"). Two entities on
 *  one chain would make a target ambiguous, so that is a fixture error, not a silent pick. */
function guidToTreePath(): Map<string, string> {
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const out = new Map<string, string>();
  for (const e of all) {
    const guid = e.guid;
    if (!guid) continue;
    const names: string[] = [];
    let cur: typeof e | undefined = e;
    const seen = new Set<number>();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); names.unshift(cur.name); cur = byId.get(cur.parentId); }
    const path = names.join('/');
    if ([...out.values()].includes(path)) throw new Error(`fixture: two entities at ${path}`);
    out.set(guid, path);
  }
  return out;
}

/** Member tree paths the refs point at — every depth and anchor the issue names. */
const TARGETS = [
  'OuterRoot/Panel/Button',                 // (d) a member two levels below the instance root
  // A nested instance's root takes its prefab's root name, so each InnerRoot below sits under a
  // different parent to keep the tree paths unique.
  'OuterRoot/Panel/InnerRoot/Leaf',         // (c) a member of a nested instance (nested prefab row)
  'OuterRoot/Panel/Button/InnerRoot/Leaf',  // (a) a guid-less added nested instance: anchored on ROOT
  'OuterRoot/InnerRoot/Leaf',               // (b) an added nested instance with its own guid
];

// Further prefabs for the one-case-per-scene round-trips below.
const LEAFY = 'aaaaaaaa-0000-4000-8000-000000000003';
const MID = 'aaaaaaaa-0000-4000-8000-000000000004';
const TOP = 'aaaaaaaa-0000-4000-8000-000000000005';
const HOLDER = 'bbbbbbbb-0000-4000-8000-000000000004';
const leafyDoc = { id: LEAFY, rootLocalId: 1, entities: [row(1, 'LeafyRoot', 0), row(2, 'Tip', 1)] };
// MID's nested INNER row carries its own user-added reference to LEAFY.
const midDoc = {
  id: MID, rootLocalId: 1, entities: [
    row(1, 'MidRoot', 0),
    row(2, 'MidSlot', 1, { prefab: INNER, added: [{ parentLocalId: 2, guid: '', name: 'L', prefab: LEAFY, traits: {}, children: [] }] }),
  ],
};
// BACK's nested INNER row adds, from the FILE, a reference to OUTER — finite unless OUTER leads back.
const BACK = 'aaaaaaaa-0000-4000-8000-000000000006';
const backDoc = {
  id: BACK, rootLocalId: 1, entities: [
    row(1, 'BackRoot', 0),
    row(2, 'BackSlot', 1, { prefab: INNER, added: [{ parentLocalId: 2, guid: '', name: 'O', prefab: OUTER, traits: {}, children: [] }] }),
  ],
};
const FA = 'aaaaaaaa-0000-4000-8000-000000000007';
const FV = 'aaaaaaaa-0000-4000-8000-000000000008';
const WB = 'aaaaaaaa-0000-4000-8000-000000000009';
const faDoc = { id: FA, rootLocalId: 1, entities: [row(1, 'FaRoot', 0), row(2, 'FaSlot', 1, { prefab: INNER, added: [{ parentLocalId: 2, guid: '', name: 'X', prefab: INNER, traits: {}, children: [] }] })] };
const fvDoc = { id: FV, rootLocalId: 1, entities: [row(1, 'FvRoot', 0), row(2, 'FvSlot', 1, { prefab: LEAFY, added: [{ parentLocalId: 2, guid: '', name: 'X', prefab: WB, traits: {}, children: [] }] })] };
const wbDoc = { id: WB, rootLocalId: 1, entities: [row(1, 'WbRoot', 0), row(2, 'WbSlot', 1, { prefab: INNER, added: [{ parentLocalId: 2, guid: '', name: 'X', prefab: LEAFY, traits: {}, children: [] }] })] };
const topDoc = { id: TOP, rootLocalId: 1, entities: [row(1, 'TopRoot', 0), row(2, 'TopSlot', 1, { prefab: MID })] };

let n = 0;
const gen = () => `cccccccc-0000-4000-8000-${String(++n).padStart(12, '0')}`;

beforeEach(() => {
  n = 0;
  prefabs.clear();
  prefabs.set(INNER, innerDoc);
  prefabs.set(OUTER, outerDoc);
  prefabs.set(LEAFY, leafyDoc);
  prefabs.set(MID, midDoc);
  prefabs.set(TOP, topDoc);
  prefabs.set(BACK, backDoc);
  prefabs.set(FA, faDoc);
  prefabs.set(FV, fvDoc);
  prefabs.set(WB, wbDoc);
});
afterAll(() => { getCurrentWorld()?.destroy(); });

/** Load the original, point one ref at each target, and return that scene + the refs. */
async function sceneWithRefs(): Promise<{ scene: SceneData; refs: string[] }> {
  await load(baseScene([]));
  const byPath = new Map([...guidToTreePath()].map(([g, p]) => [p, g]));
  const refs = TARGETS.map((p) => {
    const g = byPath.get(p);
    if (!g) throw new Error(`fixture: no loaded entity at ${p} (have: ${[...byPath.keys()].join(', ')})`);
    return g;
  });
  return { scene: baseScene(refs), refs };
}

const refsIn = (scene: SceneData): string[] =>
  ((scene.entities[1].traits as { UIAction: { bindings: { target: string }[] } }).UIAction.bindings).map((b) => b.target);

describe('remintSceneEntityGuids — refs to prefab members follow the reminted anchor (#1324)', () => {
  it.each(TARGETS.map((t, i) => [t, i] as const))('a ref to %s resolves in the copy to the same member', async (target, i) => {
    const { scene, refs } = await sceneWithRefs();
    const copy = remintSceneEntityGuids(scene as never, gen, (g) => prefabs.get(g)) as unknown as SceneData;
    const moved = refsIn(copy)[i];
    // Equality with the copy's member alone would pass if nothing moved AND the anchor did not
    // either — pin that the ref left the original value.
    expect(moved).not.toBe(refs[i]);
    await load(copy);
    expect(guidToTreePath().get(moved)).toBe(target);
  });

  it('the anchors themselves were reminted, so the copy loads under new identities', async () => {
    const { scene } = await sceneWithRefs();
    const copy = remintSceneEntityGuids(scene as never, gen, (g) => prefabs.get(g)) as unknown as SceneData;
    await load(copy);
    const guids = new Set(guidToTreePath().keys());
    for (const g of [ROOT, ANCHORED, UI]) expect(guids.has(g)).toBe(false);
  });

  it('without a prefab reader the member refs are left as they were (the pre-#1324 behaviour)', async () => {
    const { scene, refs } = await sceneWithRefs();
    const copy = remintSceneEntityGuids(scene as never, gen) as unknown as SceneData;
    expect(refsIn(copy)).toEqual(refs);
  });

  it('an unreadable prefab adds nothing and does not throw', async () => {
    const { scene, refs } = await sceneWithRefs();
    const copy = remintSceneEntityGuids(scene as never, gen, () => null) as unknown as SceneData;
    expect(refsIn(copy)).toEqual(refs);
  });

  it('a prefab that nests itself terminates', () => {
    const LOOP = 'dddddddd-0000-4000-8000-000000000001';
    prefabs.set(LOOP, { rootLocalId: 1, entities: [row(1, 'R', 0), row(2, 'Self', 1, { prefab: LOOP })] });
    expect(derivedMemberPaths({ prefab: LOOP }, (g) => prefabs.get(g))).toEqual(['2']);
  });
});

/** One scene per shape: a single instance row, plus the Ui row holding one ref to `target`. */
function sceneOf(instance: Record<string, unknown>, refs: string[]): SceneData {
  const base = baseScene(refs) as unknown as { entities: unknown[] };
  return { ...base, entities: [{ id: 1, guid: ROOT, traits: { EntityAttributes: { name: 'I', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } }, ...instance }, base.entities[1]] } as unknown as SceneData;
}

const refNode = (parentLocalId: number, prefab: string, extra: Record<string, unknown> = {}) =>
  ({ parentLocalId, guid: '', name: 'R', prefab, traits: {}, children: [], ...extra });
const plainNode = (parentLocalId: number, guid: string, name: string, children: unknown[]) =>
  ({ parentLocalId, guid, name, traits: { EntityAttributes: { name }, Transform: { x: 0, y: 0, z: 0 } }, children });

/** Each shape the step rule mirrors, round-tripped on its own (#1324 close-out review: these branches
 *  survived mutation while the combined fixture above stayed green). */
const SHAPES: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
  ['a guid-less reference child of a plain added node that carries a guid',
    { prefab: OUTER, added: [plainNode(2, HOLDER, 'Holder', [refNode(0, INNER)])] },
    'OuterRoot/Panel/Holder/InnerRoot/Leaf'],
  ['a guid-less reference child of a guid-less plain added node (it steps by 0)',
    { prefab: OUTER, added: [plainNode(2, '', 'Loose', [refNode(0, INNER)])] },
    'OuterRoot/Panel/Loose/InnerRoot/Leaf'],
  ['a reference node carrying its own added reference',
    { prefab: OUTER, added: [refNode(3, INNER, { added: [refNode(2, LEAFY)] })] },
    'OuterRoot/Panel/Button/InnerRoot/Leaf/LeafyRoot/Tip'],
  ["a nested row inside a nested row, whose prefab adds a reference",
    { prefab: TOP },
    'TopRoot/MidRoot/InnerRoot/Leaf/LeafyRoot/Tip'],
  // 70 plain levels: past MAX_INSTANCE_DEPTH (64), so this is red if plain levels spend it.
  ['a reference at the bottom of a 70-level chain of plain added nodes (plain levels are not capped)',
    { prefab: INNER, added: [Array.from({ length: 70 }, (_, i) => i).reduceRight<Record<string, unknown>>(
      (child, i) => plainNode(i === 0 ? 2 : 0, '', `P${i}`, [child]), refNode(0, LEAFY))] },
    `InnerRoot/Leaf/${Array.from({ length: 70 }, (_, i) => `P${i}`).join('/')}/LeafyRoot/Tip`],
  ["a scene-added prefab whose FILE adds the outer instance's own prefab (loadable: the chain restarts)",
    { prefab: OUTER, added: [refNode(3, BACK)] },
    'OuterRoot/Panel/Button/BackRoot/InnerRoot/Leaf/OuterRoot/Panel/Button'],
  // Two loadable shapes a structural cycle rule refused (#1324 close-out, third review): the second
  // expansion of a prefab uses the reference node's own `added`, so the loader stops.
  ["a file whose nested INNER row adds INNER under INNER's own member",
    { prefab: FA },
    'FaRoot/InnerRoot/Leaf/InnerRoot/Leaf'],
  ['a file-borne reference whose file adds back the prefab of the row that added it',
    { prefab: FV },
    'FvRoot/LeafyRoot/Tip/WbRoot/InnerRoot/Leaf/LeafyRoot/Tip'],
  ['an instance of the prefab being walked, added under one of its own members',
    { prefab: OUTER, added: [refNode(3, OUTER)] },
    'OuterRoot/Panel/Button/OuterRoot/Panel/Button'],
];

describe('each mirrored step-rule shape follows on its own (#1324 close-out)', () => {
  it.each(SHAPES)('%s', async (_name, instance, target) => {
    await load(sceneOf(instance, []));
    const byPath = new Map([...guidToTreePath()].map(([g, p]) => [p, g]));
    const ref = byPath.get(target);
    if (!ref) throw new Error(`fixture: no loaded entity at ${target} (have: ${[...byPath.keys()].join(', ')})`);
    const copy = remintSceneEntityGuids(sceneOf(instance, [ref]) as never, gen, (g) => prefabs.get(g)) as unknown as SceneData;
    const moved = refsIn(copy)[0];
    expect(moved).not.toBe(ref);
    await load(copy);
    expect(guidToTreePath().get(moved)).toBe(target);
  });

  // Shapes the LOADER recurses on forever. The walk mirrors it, so it stops on size and maps nothing.
  const ringOf = (n: number, fanout: number): string => {
    const ids = Array.from({ length: n }, (_, i) => `eeeeeeee-0000-4000-8000-${String(i).padStart(12, '0')}`);
    ids.forEach((id, i) => prefabs.set(id, {
      rootLocalId: 1,
      entities: [row(1, 'R', 0), ...Array.from({ length: fanout }, (_, k) =>
        row(k + 2, `S${k}`, 1, { prefab: ids[(i + 1) % n], added: [refNode(1, ids[(i + 2) % n]!)] }))],
    }));
    return ids[0]!;
  };
  it.each([
    ['a prefab whose five nested rows each add a reference back to it', () => {
      const P = 'dddddddd-0000-4000-8000-000000000002';
      prefabs.set(P, { rootLocalId: 1, entities: [row(1, 'R', 0), ...[2, 3, 4, 5, 6].map((id) => row(id, `S${id}`, 1, { prefab: INNER, added: [refNode(2, P)] }))] });
      return P;
    }],
    ['a ring of seven prefabs, three rows each, whose rows add references two steps on', () => ringOf(7, 3)],
    ['a two-prefab cycle carried in a file-borne reference\'s own added', () => {
      const P = 'dddddddd-0000-4000-8000-000000000003';
      const Q = 'dddddddd-0000-4000-8000-000000000004';
      prefabs.set(Q, { rootLocalId: 1, entities: [row(1, 'Q', 0)] });
      prefabs.set(P, { rootLocalId: 1, entities: [row(1, 'R', 0), ...[2, 3, 4].map((id) => row(id, `S${id}`, 1, { prefab: INNER, added: [refNode(2, Q, { added: [refNode(1, P)] })] }))] });
      return P;
    }],
    // Finite and shallow, so the depth backstop never fires — only the path budget stops it (10^6 members).
    ['a finite but enormous tree: six prefabs deep, ten nested rows each', () => {
      const ids = Array.from({ length: 6 }, (_, i) => `ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`);
      ids.forEach((id, i) => prefabs.set(id, {
        rootLocalId: 1,
        entities: [row(1, 'R', 0), ...(i + 1 < ids.length
          ? Array.from({ length: 10 }, (_, k) => row(k + 2, `S${k}`, 1, { prefab: ids[i + 1] }))
          : Array.from({ length: 10 }, (_, k) => row(k + 2, `L${k}`, 1)))],
      }));
      return ids[0]!;
    }],
  ])('%s: the walk stops on size, fast, and maps nothing', (_name, make) => {
    const top = make();
    const t0 = performance.now();
    expect(derivedMemberPaths({ prefab: top }, (g) => prefabs.get(g))).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
