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
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, isRuntimeGuid,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { remintSceneEntityGuids, derivedMemberPaths, derivedMemberPathsByAnchor, planMemberPathRepair } from '../../plugins/asset-fs-ops';
import { deriveMemberGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { memberGuidRemap, rewritePrefabMemberTokens } from '../../packages/modoki/src/runtime/loaders/memberPaths';
import { TemplateAddedKey } from '../../packages/modoki/src/runtime/core/templateIdentity';

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
    // As SceneManager does: destroyEntity (no cascade), not deleteEntity.
    onDeletePlaceholder: (id) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    // `nestedStructure` too — without it every scene-level slot in this file was silently not loaded
    // (#1430 review), so a test of a slot compared against an unedited load it never checked.
    onInstantiatePrefab: async (source, parentId, rootTf, _old, _extra, overrides, structure, nested, rootGuid, _folder, nestedStructure) => {
      const world = getCurrentWorld();
      const rootId = instantiatePrefabIntoWorld(world, prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
      if (!rootId || !rootGuid) return rootId || undefined;
      for (const e of world.entities) {
        if (e.id() !== rootId) continue;
        e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid: rootGuid });
      }
      return rootId; // as SceneManager does, so the loader retargets placeholder refs (#1353)
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
// KY's nested INNER row adds TEMPLATE-keyed nodes (#1387): a plain one (with a plain keyed child) under
// Leaf, and a reference to LEAFY under InnerRoot. Each derives, stepping by its key.
const KY = 'aaaaaaaa-0000-4000-8000-00000000000a';
const kyDoc = { id: KY, rootLocalId: 1, entities: [row(1, 'KyRoot', 0), row(2, 'KySlot', 1, { prefab: INNER, added: [
  { parentLocalId: 2, guid: '', key: 'dddddddd-0000-4000-8000-000000000001', name: 'Kp', traits: { EntityAttributes: { name: 'Kp' } }, children: [
    { parentLocalId: 0, guid: '', key: 'dddddddd-0000-4000-8000-000000000002', name: 'Kc', traits: { EntityAttributes: { name: 'Kc' } }, children: [] }] },
  { parentLocalId: 1, guid: '', key: 'dddddddd-0000-4000-8000-000000000003', name: 'Kr', prefab: LEAFY, traits: {}, children: [] },
] })] };
// #1430: keyed nodes a prefab row writes into a NESTED expansion's `nestedStructure` — NS's row nests
// OUTER and adds Kn under OUTER's nested INNER (path '4', OUTER's row 4); NS2 reaches the same node one
// level further down (path '2.4', forwarded through NSX's row 2).
const NS = 'aaaaaaaa-0000-4000-8000-00000000000b';
const NS2 = 'aaaaaaaa-0000-4000-8000-00000000000c';
const NSX = 'aaaaaaaa-0000-4000-8000-00000000000d';
const kn = { parentLocalId: 2, guid: '', key: 'dddddddd-0000-4000-8000-000000000004', name: 'Kn', traits: { EntityAttributes: { name: 'Kn' } }, children: [] };
const nsDoc = { id: NS, rootLocalId: 1, entities: [row(1, 'NsRoot', 0), row(2, 'NsSlot', 1, { prefab: OUTER, nestedStructure: { 4: { added: [kn] } } })] };
const nsxDoc = { id: NSX, rootLocalId: 1, entities: [row(1, 'NsxRoot', 0), row(2, 'NsxSlot', 1, { prefab: OUTER })] };
const ns2Doc = { id: NS2, rootLocalId: 1, entities: [row(1, 'Ns2Root', 0), row(2, 'Ns2Slot', 1, { prefab: NSX, nestedStructure: { '2.4': { added: [kn] } } })] };
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
  prefabs.set(KY, kyDoc);
  prefabs.set(NS, nsDoc);
  prefabs.set(NS2, ns2Doc);
  prefabs.set(NSX, nsxDoc);
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
    // Terminates, and with nothing at '2': the loader's cycle guard makes that row expand to no
    // entity (`instantiatePrefabIntoWorld` returns 0, so the row is never mapped) — #1339 mirrors that.
    expect(derivedMemberPaths({ prefab: LOOP }, (g) => prefabs.get(g))).toEqual([]);
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
  // #1387: a template-keyed node derives by `'+key'`, and so does everything under it.
  ['a template-keyed plain node in a row\'s added', { prefab: KY }, 'KyRoot/InnerRoot/Leaf/Kp'],
  ['a template-keyed plain child of a keyed plain node', { prefab: KY }, 'KyRoot/InnerRoot/Leaf/Kp/Kc'],
  ['a member of a template-keyed reference node', { prefab: KY }, 'KyRoot/InnerRoot/LeafyRoot/Tip'],
  // #1430: the walk descends a row's `nestedStructure` as the loader does. Mutation: drop the
  // `nested` argument where `expand` recurses into a nested row — both go red.
  ['a template-keyed node in a row\'s nestedStructure', { prefab: NS }, 'NsRoot/OuterRoot/Panel/InnerRoot/Leaf/Kn'],
  ['a template-keyed node forwarded two rows down a nestedStructure', { prefab: NS2 }, 'Ns2Root/NsxRoot/OuterRoot/Panel/InnerRoot/Leaf/Kn'],
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

/** #1339 — the loader does not always anchor a member on its instance root. A prefab row whose
 *  `parentId` is 0 or names no row is parented to the instance's SCENE parent and derives from that
 *  parent's guid; a guid-less (pre-#1248) instance root derives from its nearest guid-carrying scene
 *  ancestor, and so do its members. Same round-trip as above: nothing here hand-computes a guid. */
describe('members the loader anchors above the instance root follow too (#1339)', () => {
  const ORPH = 'aaaaaaaa-0000-4000-8000-0000000000a1';
  const HELD = 'bbbbbbbb-0000-4000-8000-0000000000a1';
  // Stray: parent 0. Kid: under Stray. Lost: parent 99, which is no row. Good: an ordinary member.
  const orphDoc = {
    id: ORPH, rootLocalId: 1, entities: [
      row(1, 'OrphRoot', 0), row(2, 'Stray', 0), row(3, 'Kid', 2), row(4, 'Lost', 99), row(5, 'Good', 1),
    ],
  };
  const holder = (parentId: unknown = 0) =>
    ({ id: 10, traits: { EntityAttributes: { name: 'Holder', parentId, guid: HOLDER } } });
  const ui = (refs: string[]) => ({
    id: 30,
    traits: {
      EntityAttributes: { name: 'Ui', parentId: 0, guid: UI },
      UIAction: { bindings: refs.map((target) => ({ event: 'click', action: 'noop', target })) },
    },
  });
  const inst = (extra: Record<string, unknown>) =>
    ({ id: 20, traits: { EntityAttributes: { name: 'I', parentId: 10 }, Transform: { x: 0, y: 0, z: 0 } }, ...extra });
  const sceneWith = (entities: unknown[], refs: string[]): SceneData =>
    ({ id: 's', version: 1, name: 'S', resources: [], entities: [...entities, ui(refs)] }) as unknown as SceneData;
  const uiRefs = (scene: SceneData): string[] =>
    ((scene.entities.at(-1)!.traits as { UIAction: { bindings: { target: string }[] } }).UIAction.bindings).map((b) => b.target);

  const CASES: ReadonlyArray<readonly [string, unknown[], string]> = [
    ['an orphan row (parentId 0) of an instance with its own guid', [holder(), inst({ prefab: ORPH, guid: HELD })], 'Holder/Stray'],
    ["a row under an orphan row", [holder(), inst({ prefab: ORPH, guid: HELD })], 'Holder/Stray/Kid'],
    ['a row whose parentId names no row', [holder(), inst({ prefab: ORPH, guid: HELD })], 'Holder/Lost'],
    ['an orphan row, with the instance parented by the holder\'s GUID', [holder(), { ...inst({ prefab: ORPH, guid: HELD }), traits: { EntityAttributes: { name: 'I', parentId: HOLDER } } }], 'Holder/Stray'],
    ['the root of a guid-less (legacy) instance', [holder(), inst({ prefab: ORPH })], 'Holder/OrphRoot'],
    ['a member of a guid-less (legacy) instance', [holder(), inst({ prefab: ORPH })], 'Holder/OrphRoot/Good'],
    ['an orphan row of a guid-less (legacy) instance', [holder(), inst({ prefab: ORPH })], 'Holder/Stray/Kid'],
    // `spawnNestedInstance` parents an added instance's orphans to the anchor MEMBER, not the scene.
    ['an orphan row of a guid-less added nested instance', [inst({ prefab: OUTER, guid: HELD, added: [refNode(3, ORPH)] })], 'OuterRoot/Panel/Button/Stray'],
    ['an orphan row of an added nested instance that carries its own guid (it hangs off the OUTER anchor)',
      [inst({ prefab: OUTER, guid: HELD, added: [refNode(3, ORPH, { guid: ANCHORED })] })], 'OuterRoot/Panel/Button/Stray'],
  ];

  beforeEach(() => { prefabs.set(ORPH, orphDoc); });

  it.each(CASES)('%s', async (_name, entities, target) => {
    await load(sceneWith(entities, []));
    const byPath = new Map([...guidToTreePath()].map(([g, p]) => [p, g]));
    const ref = byPath.get(target);
    if (!ref) throw new Error(`fixture: no loaded entity at ${target} (have: ${[...byPath.keys()].join(', ')})`);
    const copy = remintSceneEntityGuids(sceneWith(entities, [ref]) as never, gen, (g) => prefabs.get(g)) as unknown as SceneData;
    const moved = uiRefs(copy)[0];
    expect(moved).not.toBe(ref);
    await load(copy);
    expect(guidToTreePath().get(moved)).toBe(target);
  });

  it('an instance at the scene root leaves its orphan rows unaddressable, and maps nothing for them', async () => {
    const entities = [{ ...inst({ prefab: ORPH, guid: HELD }), traits: { EntityAttributes: { name: 'I', parentId: 0 } } }];
    await load(sceneWith(entities, []));
    // It still gets a guid, but only a RUNTIME one (#1210) — nothing durable can point at it.
    const stray = [...guidToTreePath()].find(([, p]) => p === 'Stray')?.[0];
    expect(stray && isRuntimeGuid(stray)).toBe(true);
    const byAnchor = derivedMemberPathsByAnchor(entities[0] as never, (g) => prefabs.get(g), { orphans: 'parent' });
    expect(byAnchor.parent.sort()).toEqual(['2', '2.3', '4']);
    // …and the copy still loads with the ordinary member's ref carried.
    const good = new Map([...guidToTreePath()].map(([g, p]) => [p, g])).get('OrphRoot/Good')!;
    const copy = remintSceneEntityGuids(sceneWith(entities, [good]) as never, gen, (g) => prefabs.get(g)) as unknown as SceneData;
    await load(copy);
    expect(guidToTreePath().get(uiRefs(copy)[0])).toBe('OrphRoot/Good');
  });

  it("a nested prefab ROW's orphans are unaddressable (the row expands under parent 0), so they are not pathed", () => {
    const NEST = 'aaaaaaaa-0000-4000-8000-0000000000a2';
    prefabs.set(NEST, { id: NEST, rootLocalId: 1, entities: [row(1, 'NestRoot', 0), row(2, 'Slot', 1, { prefab: ORPH })] });
    const byAnchor = derivedMemberPathsByAnchor({ prefab: NEST }, (g) => prefabs.get(g), { orphans: 'parent' });
    expect(byAnchor.self.sort()).toEqual(['2', '2.5']);
    expect(byAnchor.parent).toEqual([]);
  });

  // #1338 review: a guid-less INSTANCE parent can only be named by number. Since #1353 the child lands
  // under the re-instantiated root (whose guid derives from its own scene parent), but the walk
  // conservatively does not follow through it (see `sceneAnchorOf`). Mutation: let `sceneAnchorOf` step through a guid-less instance parent.
  it('an instance whose scene parent is a guid-less instance maps nothing for its orphan rows', () => {
    const ORPH2 = 'aaaaaaaa-0000-4000-8000-0000000000a3';
    prefabs.set(ORPH2, { id: ORPH2, rootLocalId: 1, entities: [row(1, 'Orph2Root', 0), row(7, 'Stray2', 0)] });
    const entities = [holder(), inst({ prefab: ORPH }),
      { id: 21, prefab: ORPH2, guid: HELD, traits: { EntityAttributes: { name: 'In', parentId: 20 } } }];
    // What a step-through would carry for Stray2, with and without the guid-less root's step (7 is
    // no localId of ORPH, so neither collides with the legacy instance's own members).
    const guesses = [deriveMemberGuid(HOLDER, [1, 7]), deriveMemberGuid(HOLDER, [7])];
    const copy = remintSceneEntityGuids(sceneWith(entities, guesses) as never, gen, (g) => prefabs.get(g)) as unknown as SceneData;
    expect(uiRefs(copy)).toEqual(guesses);
  });
});

// #1369 close-out sweep: `remintSceneEntityGuids`' own-guid walk descended `children` and `added`
// only, so a node inside a `nestedStructure` slot — #1358's on an entry, #1369's on a reference node —
// kept its guid in the copy: two scene files holding one entity guid (#1293's class), and a ref to it
// in the copy still aiming at the original. Mutation: drop the `nestedStructure` visit in `visit`.
describe('nodes inside a nestedStructure slot are reminted too (#1358/#1369 slots)', () => {
  const G_ENTRY = 'cccccccc-0000-4000-8000-000000000001';
  const G_NODE = 'cccccccc-0000-4000-8000-000000000002';
  const node = (guid: string) => ({ parentLocalId: 1, guid, name: 'Bolt', children: [],
    traits: { EntityAttributes: { name: 'Bolt', parentId: 0, guid } } });
  it('an added node in an entry slot and in a reference node\'s slot both get new guids', () => {
    const scene = { id: 's', version: 14, entities: [
      { id: 1, traits: { EntityAttributes: { name: 'H', parentId: 0, guid: 'cccccccc-0000-4000-8000-0000000000ff' },
        UIAction: { bindings: [{ event: 'click', action: 'noop', target: G_ENTRY }, { event: 'click', action: 'noop', target: G_NODE }] } } },
      { id: 2, prefab: OUTER, guid: ROOT, traits: { EntityAttributes: { name: 'OuterRoot', parentId: 0 } },
        nestedStructure: { 4: { added: [node(G_ENTRY)] } },
        added: [{ parentLocalId: 3, guid: ANCHORED, name: 'AddedInner', prefab: INNER, traits: {}, children: [],
          nestedStructure: { 2: { added: [node(G_NODE)] } } }] },
    ] };
    let n = 0;
    const copy = JSON.stringify(remintSceneEntityGuids(scene as never, () => `dddddddd-0000-4000-8000-${String(++n).padStart(12, '0')}`));
    expect(copy).not.toContain(G_ENTRY);
    expect(copy).not.toContain(G_NODE);
  });
});

/** #1437 P3-a: applying a move re-parents a prefab row, which changes the PATH its members derive their
 *  guids from. `memberGuidRemap` predicts old → new from the two documents; every case is checked against
 *  what the LOADER derives under each (names are unique in these fixtures, so a name is an identity). */
describe('memberGuidRemap follows a re-parented row to its new derived guids (#1437 P3-a)', () => {
  const DOOR = 'aaaaaaaa-0000-4000-8000-0000000000d1';
  const LOCK = 'aaaaaaaa-0000-4000-8000-0000000000d2';
  const HOUSE = 'aaaaaaaa-0000-4000-8000-0000000000d3';
  const D_GUID = 'bbbbbbbb-0000-4000-8000-0000000000d1';
  const lockDoc = { id: LOCK, rootLocalId: 1, entities: [row(1, 'LockRoot', 0), row(2, 'Bolt', 1)] };
  /** Handle (3) under `handleParent`, Knob (4) under Handle, a nested Lock row (5) under `lockParent`. */
  const doorDoc = (handleParent: number, lockParent = 1) => ({
    id: DOOR, rootLocalId: 1, entities: [
      row(1, 'DoorRoot', 0), row(2, 'Frame', 1), row(3, 'Handle', handleParent), row(4, 'Knob', 3),
      row(5, 'Lock', lockParent, { prefab: LOCK }),
    ],
  });
  const houseDoc = { id: HOUSE, rootLocalId: 1, entities: [row(1, 'HouseRoot', 0), row(2, 'Door', 1, { prefab: DOOR })] };
  const holder = { id: 10, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } };
  const inst = (extra: Record<string, unknown>) =>
    ({ id: 20, traits: { EntityAttributes: { name: 'I', parentId: 10 }, Transform: { x: 0, y: 0, z: 0 } }, ...extra });
  const scene = (entities: unknown[]): SceneData => ({ id: 's', version: 1, name: 'S', resources: [], entities: [holder, ...entities] }) as unknown as SceneData;
  const guidsByName = (): Map<string, string> => new Map(getAllEntities().filter((e) => e.guid).map((e) => [e.name, e.guid!]));

  /** The loader's own answer: every name whose guid differs between the two documents. */
  async function loaderRemap(s: SceneData, before: unknown, after: unknown, docGuid = DOOR): Promise<Map<string, string>> {
    prefabs.set(docGuid, before);
    await load(s);
    const a = guidsByName();
    prefabs.set(docGuid, after);
    await load(s);
    const b = guidsByName();
    const out = new Map<string, string>();
    for (const [name, g] of a) if (b.get(name) && b.get(name) !== g) out.set(g, b.get(name)!);
    return out;
  }
  const reader = (doc: unknown) => (g: string) => (g === DOOR ? doc : prefabs.get(g));

  beforeEach(() => { prefabs.set(LOCK, lockDoc); prefabs.set(HOUSE, houseDoc); });

  const CASES: ReadonlyArray<readonly [string, SceneData, unknown, unknown, number]> = [
    ['a member moved to another row parent, and its child', scene([inst({ prefab: DOOR, guid: D_GUID })]), doorDoc(2), doorDoc(1), 2],
    ['a member moved to parentId 0, which hangs it off the scene parent', scene([inst({ prefab: DOOR, guid: D_GUID })]), doorDoc(2), doorDoc(0), 2],
    ['a nested row moved, and the members of its instance', scene([inst({ prefab: DOOR, guid: D_GUID })]), doorDoc(2, 1), doorDoc(2, 2), 2],
    ['the prefab nested in another prefab', scene([inst({ prefab: HOUSE, guid: D_GUID })]), doorDoc(2), doorDoc(1), 2],
    ['a guid-less user-added instance of it, anchored on the outer root',
      scene([inst({ prefab: LOCK, guid: D_GUID, added: [{ parentLocalId: 2, guid: '', name: 'Added', prefab: DOOR, traits: {}, children: [] }] })]),
      doorDoc(2), doorDoc(1), 2],
    ['a user-added instance of it with its own guid',
      scene([inst({ prefab: LOCK, guid: D_GUID, added: [{ parentLocalId: 2, guid: ANCHORED, name: 'Added', prefab: DOOR, traits: {}, children: [] }] })]),
      doorDoc(2), doorDoc(1), 2],
  ];

  it.each(CASES)('%s', async (_name, s, before, after, count) => {
    const expected = await loaderRemap(s, before, after);
    expect(expected.size).toBe(count);
    expect(memberGuidRemap(s as never, reader(before), reader(after))).toEqual(expected);
  });

  it('maps nothing when no path changed', () => {
    const s = scene([inst({ prefab: DOOR, guid: D_GUID })]);
    expect(memberGuidRemap(s as never, reader(doorDoc(2)), reader(doorDoc(2))).size).toBe(0);
  });
});

/** #1437 P3-a: a template names its own members by PATH (`@member:`), so a re-parented row re-points the
 *  tokens that name it or anything below it — in the prefab itself and in every prefab nesting it. Checked
 *  by loading the rewritten documents and reading which entity each token resolved to. */
describe('rewritePrefabMemberTokens re-points member tokens at a re-parented row (#1437 P3-a)', () => {
  const DOOR = 'aaaaaaaa-0000-4000-8000-0000000000e1';
  const HOUSE = 'aaaaaaaa-0000-4000-8000-0000000000e2';
  const H_GUID = 'bbbbbbbb-0000-4000-8000-0000000000e1';
  const bind = (...targets: string[]) => ({ UIAction: { bindings: targets.map((target) => ({ event: 'click', action: 'noop', target })) } });
  const withTraits = (r: ReturnType<typeof row>, extra: Record<string, unknown>) => ({ ...r, traits: { ...r.traits, ...extra } });
  const doorDoc = (handleParent: number, rootTargets: string[]) => ({
    id: DOOR, rootLocalId: 1, entities: [
      withTraits(row(1, 'DoorRoot', 0), bind(...rootTargets)), row(2, 'Frame', 1), row(3, 'Handle', handleParent), row(4, 'Knob', 3),
    ],
  });
  const houseDoc = (door: string, climb: string) => ({
    id: HOUSE, rootLocalId: 1, entities: [
      withTraits(row(1, 'HouseRoot', 0), bind(door)),
      row(2, 'Door', 1, { prefab: DOOR, overrides: { 2: bind(climb) } }),
    ],
  });
  const readUi = (id: number): string[] => {
    for (const ent of getCurrentWorld().entities) {
      if (ent.id() !== id) continue;
      return ((ent.get(getTraitByName('UIAction')!.trait) as { bindings: { target: string }[] }).bindings).map((b) => b.target);
    }
    return [];
  };
  const guidOf = (name: string): string => getAllEntities().find((e) => e.name === name)!.guid!;

  it('in the prefab itself, and in a prefab that nests it (both frames, and a ^ climb)', async () => {
    const oldDoor = doorDoc(2, ['@member:2.3', '@member:2.3.4', '@member:2']);
    const newDoorRows = doorDoc(1, ['@member:2.3', '@member:2.3.4', '@member:2']);
    const oldHouse = houseDoc('@member:2.2.3.4', '@member:^.2.2.3');
    const readOld = (g: string) => (g === DOOR ? oldDoor : g === HOUSE ? oldHouse : prefabs.get(g));
    const readNew = (g: string) => (g === DOOR ? newDoorRows : g === HOUSE ? oldHouse : prefabs.get(g));
    const newDoor = rewritePrefabMemberTokens(newDoorRows as never, DOOR, readOld, readNew)!;
    const newHouse = rewritePrefabMemberTokens(oldHouse as never, HOUSE, readOld, readNew)!;
    expect(newDoor).not.toBeNull();
    expect(newHouse).not.toBeNull();
    // Frame (2) did not move, so its token is left alone.
    expect((newDoor.entities as { traits: ReturnType<typeof bind> }[])[0]!.traits.UIAction.bindings.map((b) => b.target))
      .toEqual(['@member:3', '@member:3.4', '@member:2']);

    prefabs.set(DOOR, newDoor);
    prefabs.set(HOUSE, newHouse);
    await load({ id: 's', version: 1, name: 'S', resources: [], entities: [
      { id: 20, prefab: HOUSE, guid: H_GUID, traits: { EntityAttributes: { name: 'HouseRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    ] } as unknown as SceneData);
    expect(readUi(getAllEntities().find((e) => e.name === 'DoorRoot')!.id)).toEqual([guidOf('Handle'), guidOf('Knob'), guidOf('Frame')]);
    expect(readUi(getAllEntities().find((e) => e.name === 'HouseRoot')!.id)).toEqual([guidOf('Knob')]);
    // The row override on Frame (2) of the nested Door, climbing to the House frame.
    expect(readUi(getAllEntities().find((e) => e.name === 'Frame')!.id)).toEqual([guidOf('Handle')]);
  });

  // #1437 P3-b: a prefab's own `moved` names its member (the KEY) and the new parent (the value) by path.
  // Mutation: stop rewriting the key.
  it("the prefab's own moves follow too: member keys and target tokens", () => {
    const withMove = (handleParent: number, key: string, target: string) => ({ ...doorDoc(handleParent, []), moved: { [key]: target } });
    const readOld = (g: string) => (g === DOOR ? withMove(2, '2.3.4', '@member:2.3') : undefined);
    const readNew = (g: string) => (g === DOOR ? withMove(1, '2.3.4', '@member:2.3') : undefined);
    const out = rewritePrefabMemberTokens(withMove(1, '2.3.4', '@member:2.3') as never, DOOR, readOld, readNew)!;
    expect(out.moved).toEqual({ '3.4': '@member:3' });
  });

  it('returns null when no token names a moved member', () => {
    const d = doorDoc(2, ['@member:2']);
    expect(rewritePrefabMemberTokens(doorDoc(1, ['@member:2']) as never, DOOR, (g) => (g === DOOR ? d : undefined), (g) => (g === DOOR ? doorDoc(1, []) : undefined))).toBeNull();
  });
});

/** #1437 P3-a: the file-level repair the backend route runs after an applied move. */
describe('planMemberPathRepair rewrites exactly the files that use the changed prefab (#1437 P3-a)', () => {
  const DOOR = 'aaaaaaaa-0000-4000-8000-0000000000f1';
  const HOUSE = 'aaaaaaaa-0000-4000-8000-0000000000f2';
  const OTHER = 'aaaaaaaa-0000-4000-8000-0000000000f3';
  const H_GUID = 'bbbbbbbb-0000-4000-8000-0000000000f1';
  const bind = (...targets: string[]) => ({ UIAction: { bindings: targets.map((target) => ({ event: 'click', action: 'noop', target })) } });
  const doorDoc = (handleParent: number) => ({
    id: DOOR, rootLocalId: 1, entities: [row(1, 'DoorRoot', 0), row(2, 'Frame', 1), row(3, 'Handle', handleParent)],
  });
  const houseDoc = { id: HOUSE, rootLocalId: 1, entities: [{ ...row(1, 'HouseRoot', 0), traits: { ...row(1, 'HouseRoot', 0).traits, ...bind('@member:2.2.3') } }, row(2, 'Door', 1, { prefab: DOOR })] };
  const otherDoc = { id: OTHER, rootLocalId: 1, entities: [{ ...row(1, 'O', 0), traits: { ...row(1, 'O', 0).traits, ...bind('@member:2.3') } }, row(2, 'A', 1), row(3, 'B', 2)] };
  const sceneUsing = (ref: string) => ({ id: 's', version: 15, name: 'S', resources: [], entities: [
    { id: 20, prefab: HOUSE, guid: H_GUID, traits: { EntityAttributes: { name: 'HouseRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    { id: 30, traits: { EntityAttributes: { name: 'Ui', parentId: 0, guid: UI }, ...bind(ref) } },
  ] });

  it('re-points a scene that reaches the prefab only through another prefab, and that prefab\'s tokens', async () => {
    prefabs.set(HOUSE, houseDoc);
    prefabs.set(DOOR, doorDoc(2));
    await load(sceneUsing('') as unknown as SceneData);
    const oldHandle = getAllEntities().find((e) => e.name === 'Handle')!.guid!;
    prefabs.set(DOOR, doorDoc(1));
    await load(sceneUsing('') as unknown as SceneData);
    const newHandle = getAllEntities().find((e) => e.name === 'Handle')!.guid!;
    expect(newHandle).not.toBe(oldHandle);

    const files = [
      { key: 'door', type: 'prefab' as const, guid: DOOR, text: JSON.stringify(doorDoc(1)) },
      { key: 'house', type: 'prefab' as const, guid: HOUSE, text: JSON.stringify(houseDoc) },
      { key: 'other', type: 'prefab' as const, guid: OTHER, text: JSON.stringify(otherDoc) },
      { key: 'scene', type: 'scene' as const, text: JSON.stringify(sceneUsing(oldHandle)) },
      { key: 'unrelated', type: 'scene' as const, text: JSON.stringify({ ...sceneUsing(oldHandle), entities: [sceneUsing(oldHandle).entities[1]] }) },
    ];
    const plan = planMemberPathRepair(files, DOOR, doorDoc(2), (g) => (g === DOOR ? doorDoc(1) : prefabs.get(g)));
    expect(plan.map((p) => p.key).sort()).toEqual(['house', 'scene']);
    const byKey = new Map(plan.map((p) => [p.key, p.doc]));
    expect(JSON.stringify(byKey.get('house'))).toContain('"@member:2.3"');
    expect(JSON.stringify(byKey.get('scene'))).toContain(newHandle);
    expect(JSON.stringify(byKey.get('scene'))).not.toContain(oldHandle);
  });
});

// ── #1430: a template-keyed node the scene EDITED ────────────────────────────────────────────────────
// The save writes it in scene form inside a `nestedStructure` slot: its derived guid STORED, its key
// dropped. The load heal re-keys it only while that guid still matches its derivation, so a random
// remint left the copy's node unkeyed for good — it must remint to the guid its template path
// derives from the copy's anchor. Such a node can be an ANCHOR (a keyed reference node, or a keyed
// plain node with a reference child), and then its members must follow its FINAL guid.
//
// Each case: load the unedited instance to learn the node's derived guid; write the scene-form edit;
// load THAT and take refs to `targets`; duplicate; load the copy — every ref must land on the same
// path, and the stored node must come back keyed exactly as the edited original does (the load heal
// re-keys a keyed plain node since #1426, and a keyed reference node since #1438).
const K_P = 'dddddddd-0000-4000-8000-000000000001';
const K_R = 'dddddddd-0000-4000-8000-000000000003';
async function editedRoundTrip(
  unedited: Record<string, unknown>,
  edit: (guidAt: (path: string) => string) => Record<string, unknown>,
  targets: string[],
  keyedAt: string,
): Promise<string> {
  const pathMap = () => new Map([...guidToTreePath()].map(([g, p]) => [p, g]));
  await load(sceneOf(unedited, []));
  const before = pathMap();
  const instance = edit((path) => {
    const g = before.get(path);
    if (!g) throw new Error(`fixture: nothing at ${path} (have: ${[...before.keys()].join(', ')})`);
    return g;
  });
  const keyAt = (): string => {
    const node = [...getCurrentWorld().entities].find((e) => (e.get(getTraitByName('EntityAttributes')!.trait) as { guid?: string } | undefined)?.guid === pathMap().get(keyedAt))!;
    return (node.get(TemplateAddedKey) as { key: string } | undefined)?.key ?? '';
  };
  await load(sceneOf(instance, []));
  const edited = pathMap();
  const originalKey = keyAt();
  const refs = targets.map((t) => edited.get(t)!);
  expect(refs.every(Boolean)).toBe(true); // the edited file loads every target
  const copy = remintSceneEntityGuids(sceneOf(instance, refs) as never, gen, (g) => prefabs.get(g)) as unknown as SceneData;
  const moved = refsIn(copy);
  for (let i = 0; i < refs.length; i++) expect(moved[i]).not.toBe(refs[i]);
  await load(copy);
  const after = guidToTreePath();
  expect(moved.map((g) => after.get(g))).toEqual(targets);
  expect(keyAt()).toBe(originalKey);
  return originalKey;
}
const sceneForm = (guid: string, name: string, parentLocalId: number, extra: Record<string, unknown> = {}) =>
  ({ parentLocalId, guid, name, children: [], traits: { EntityAttributes: { name, parentId: 0, guid } }, ...extra });
const slot = (added: unknown[]) => ({ added, removed: [], removedTraits: {} });

describe('an edited template-keyed node follows a scene duplicate (#1430)', () => {
  // Mutation: let a defined guid win over the derived one again (`!remap.has(k)` for the carry's
  // `remap.get(k) !== v` in `remintSceneEntityGuids`) — every case below but the accept side goes red.
  it('a keyed plain node', async () => expect(await editedRoundTrip({ prefab: KY },
    (at) => ({ prefab: KY, nestedStructure: { 2: slot([sceneForm(at('KyRoot/InnerRoot/Leaf/Kp'), 'Kp', 2)]) } }),
    ['KyRoot/InnerRoot/Leaf/Kp'], 'KyRoot/InnerRoot/Leaf/Kp')).toBe(K_P));

  it('a keyed reference node, and its member', async () => expect(await editedRoundTrip({ prefab: KY },
    (at) => ({ prefab: KY, nestedStructure: { 2: slot([sceneForm(at('KyRoot/InnerRoot/LeafyRoot'), 'Kr', 1, { prefab: LEAFY, traits: {} })]) } }),
    ['KyRoot/InnerRoot/LeafyRoot', 'KyRoot/InnerRoot/LeafyRoot/Tip'], 'KyRoot/InnerRoot/LeafyRoot')).toBe(K_R));

  // #1430 review, (a): the keyed anchor sits inside a user-added reference node that carries its own
  // guid, so the entry's walk stops there (SKIP) and nothing re-carries the anchor's members after the
  // anchor is re-pointed. Mutation: carry one pass only in `remintSceneEntityGuids` — the Tip ref dangles.
  it('a keyed reference node inside a user-added reference node', () => {
    const outer = (extra: Record<string, unknown>) => ({ prefab: INNER, added: [{ parentLocalId: 1, guid: ANCHORED, name: 'Ky', prefab: KY, traits: {}, children: [], ...extra }] });
    return editedRoundTrip(outer({}),
      (at) => outer({ nestedStructure: { 2: slot([sceneForm(at('InnerRoot/KyRoot/InnerRoot/LeafyRoot'), 'Kr', 1, { prefab: LEAFY, traits: {} })]) } }),
      ['InnerRoot/KyRoot/InnerRoot/LeafyRoot', 'InnerRoot/KyRoot/InnerRoot/LeafyRoot/Tip'], 'InnerRoot/KyRoot/InnerRoot/LeafyRoot');
  });

  // #1430 review, (b): a guid-less reference child the SCENE added under the keyed plain node — no
  // template path reaches it, so only the keyed node's own carry, run against its FINAL guid, can.
  // Mutation: carry one pass only — the Tip ref dangles.
  it('a keyed plain node with a scene-added reference child', async () => expect(await editedRoundTrip({ prefab: KY },
    (at) => ({ prefab: KY, nestedStructure: { 2: slot([sceneForm(at('KyRoot/InnerRoot/Leaf/Kp'), 'Kp', 2, { children: [refNode(0, LEAFY)] })]) } }),
    ['KyRoot/InnerRoot/Leaf/Kp', 'KyRoot/InnerRoot/Leaf/Kp/LeafyRoot/Tip'], 'KyRoot/InnerRoot/Leaf/Kp')).toBe(K_P));

  // Accept side: a scene-added node in the same slot is no derivation, and gets a random guid as before.
  it('a scene-added plain node in the slot still gets a fresh random guid', () => {
    const plain = 'cccccccc-0000-4000-8000-0000000014a0';
    const copy = remintSceneEntityGuids(sceneOf({ prefab: KY, nestedStructure: { 2: slot([sceneForm(plain, 'Plain', 2)]) } }, [plain]) as never, gen, (g) => prefabs.get(g)) as unknown as SceneData;
    expect(refsIn(copy)[0]).toMatch(/^cccccccc-0000-4000-8000-0000000000/); // from `gen`
  });
});

// ── #1438: the load heal re-keys a keyed REFERENCE node the scene edited ─────────────────────────────
// A scene-form save writes Kr (KY's template reference to LEAFY) with its derived guid stored and its
// key dropped. Its root carries `PrefabInstance`, and the #1426 heal once took plain nodes only, so Kr
// reloaded unkeyed and a member token naming it by `'+' + key` stayed dead. (A token cannot reach PAST Kr:
// a reference node is a stored root, its own frame.) KYT is KY plus a row whose binding names Kr by
// token: KySlot's nested root steps 2, then Kr's key.
const KYT = 'aaaaaaaa-0000-4000-8000-00000000000c';
const KR_TOKEN = `@member:2.+${K_R}`;
describe('the load heal re-keys an edited template-keyed reference node (#1438)', () => {
  beforeEach(() => {
    prefabs.set(KYT, { ...kyDoc, id: KYT, entities: [...kyDoc.entities, { localId: 3, traits: {
      EntityAttributes: { name: 'Btn', parentId: 1, guid: '' }, Transform: { x: 0, y: 0, z: 0 },
      UIAction: { bindings: [{ event: 'click', action: 'noop', target: KR_TOKEN }] },
    } }] });
  });
  const pathMap = () => new Map([...guidToTreePath()].map(([g, p]) => [p, g]));
  const liveAt = (path: string) => [...getCurrentWorld().entities].find((e) => (e.get(getTraitByName('EntityAttributes')!.trait) as { guid?: string } | undefined)?.guid === pathMap().get(path))!;
  const keyAt = (path: string) => (liveAt(path).get(TemplateAddedKey) as { key: string } | undefined)?.key ?? '';
  const btnTarget = () => (liveAt('KyRoot/Btn').get(getTraitByName('UIAction')!.trait) as { bindings: { target: string }[] }).bindings[0]!.target;
  const editedKr = async () => {
    await load(sceneOf({ prefab: KYT }, []));
    const unedited = { kr: pathMap().get('KyRoot/InnerRoot/LeafyRoot')! };
    expect(keyAt('KyRoot/InnerRoot/LeafyRoot')).toBe(K_R); // the premise: an unedited load keys Kr
    expect(btnTarget()).toBe(unedited.kr);                  // and the token lands on Kr
    await load(sceneOf({ prefab: KYT, nestedStructure: { 2: slot([sceneForm(unedited.kr, 'Kr', 1, { prefab: LEAFY, traits: {} })]) } }, []));
    return unedited;
  };

  // Mutation: restore the heal's `row.hasPI` skip in `deriveInstanceMemberGuids` — Kr loads unkeyed and
  // Btn keeps the literal token.
  it('Kr keeps its guid, gets its key back, and the token through it resolves', async () => {
    const unedited = await editedKr();
    expect(pathMap().get('KyRoot/InnerRoot/LeafyRoot')).toBe(unedited.kr);
    expect(keyAt('KyRoot/InnerRoot/LeafyRoot')).toBe(K_R);
    expect(btnTarget()).toBe(unedited.kr);
  });

  // Accept side: a reference node the SCENE added (a random stored guid) derives from no key, and a
  // prefab member inside Kr is never a candidate. A member has no guid on the first derive, so a SECOND
  // one (any runtime spawn) is what makes it one. Mutations: stamp the first key without the derivation
  // check; with it, also let the heal take a non-root member (`row.hasPI && !row.storedRoot`).
  it('a scene-added reference node and Kr\'s own member stay unkeyed', async () => {
    const added = 'cccccccc-0000-4000-8000-0000000014b0';
    await load(sceneOf({ prefab: KYT, added: [{ parentLocalId: 1, guid: added, name: 'Mine', prefab: LEAFY, traits: {}, children: [] }] }, []));
    expect(pathMap().get('KyRoot/LeafyRoot')).toBe(added);
    expect(keyAt('KyRoot/LeafyRoot')).toBe('');
    const { deriveInstanceMemberGuids } = await import('../../packages/modoki/src/runtime/loaders/loadSceneFile');
    deriveInstanceMemberGuids(getCurrentWorld());
    expect(keyAt('KyRoot/InnerRoot/LeafyRoot/Tip')).toBe('');
  });
});
