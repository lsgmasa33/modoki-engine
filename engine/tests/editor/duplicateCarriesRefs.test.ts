/** #1338 — an editor duplicate carries references INSIDE the copied subtree, including refs to
 *  prefab-instance MEMBERS, whose guids are never saved: a reload re-derives them from the nearest
 *  guid-carrying ancestor. So the only honest check is the whole loop — load a scene through the real
 *  loader, duplicate in the editor, serialize, load the result, and resolve each ref by tree path.
 *  (The plain-entity cases run without the loader in packages/modoki/tests/editor/entityActions.test.ts.) */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createWorld, trait as kootaTrait } from 'koota';

const prefabs = new Map<string, unknown>();
/** A saved scene / entry with its member rows unfolded into the pre-Phase-4 channels (#1468) — for the
 *  assertions below that are about WHAT an instance recorded, not which channel holds it. Every reload
 *  still reads the real file. See `memberRowView.ts`. */
const view = <T extends { entities: unknown[] }>(scene: T): T => legacySceneView(scene, (g) => prefabs.get(g));
const viewEntry = <T,>(entry: T): T => legacyView(entry, (g) => prefabs.get(g));
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, getOverrideMarkSet, registerTrait, type SceneData,
} from '@modoki/engine/runtime';
import {
  duplicateEntity, writeTraitFieldWithUndo, setActionCallback, pushAction, clearHistory, serializeScene,
  reparentEntity, deleteEntitiesWithUndo,
} from '@modoki/engine/editor';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import {
  setPrefabCache, wouldCreateCycle, getCachedPrefabSync,
} from '../../packages/modoki/src/editor/scene/prefabCache';
import { captureInstanceOverrides } from '../../packages/modoki/src/editor/scene/prefabInstanceOverrides';
import { captureInstanceStructure } from '../../packages/modoki/src/editor/scene/prefabCapture';
import { instantiatePrefab } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { refreshInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
/** Rebuild instance frame `root` (of `source`) onto `doc` unchanged: the load of its scene entry (#1880 F7d). */
const rebuild = (root: number, source: string, doc: unknown): number => refreshInstances(source, [root], doc as never, doc as never);
import { serializePrefab } from '../../packages/modoki/src/editor/scene/prefabSerialize';
import { applyToPrefabSelective } from '../../packages/modoki/src/editor/scene/prefabApply';
import { revertOverridesSelective } from '../../packages/modoki/src/editor/scene/prefabRevert';
import { applyOutcomeNotice } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { buildPrefabEditScene, applyEditWorldMoves } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { recoverTemplateKey as recoverTemplateKeyFrom, type KeyRecoveryNode } from '../../packages/modoki/src/runtime/loaders/templateKeyRecovery';
import { undo, redo } from '../../packages/modoki/src/editor/undo/undoManager';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { legacyView, legacySceneView } from './memberRowView';
import { deriveMemberGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { relinkDetachedMembers } from '../../packages/modoki/src/runtime/core/ecs/memberHome';
import { worldIdentityParents, openIdentityScope, closeIdentityScope } from '../../packages/modoki/src/runtime/core/ecs/identityParents';

/** What `PrefabInstance.homeParent` / `homeSteps` recorded until #1468 Phase 6, read now from the document
 *  (`identityParents.ts`): the guid of the TEMPLATE parent a moved member walks from, and the steps of the gone
 *  template rows between — both '' for a member that sits where its template puts it. The tests below pin the
 *  answer those fields gave; this is the one place that knows it is no longer a field. */
function homeView(id: number): { homeParent: string; homeSteps: string } {
  const parents = worldIdentityParents(getCurrentWorld());
  if (!parents.moved(id)) return { homeParent: '', homeSteps: '' };
  const at = parents.of(id);
  const holder = [...getCurrentWorld().entities].find((x) => x.id() === at.parentId);
  const guid = holder ? ((holder.get(getTraitByName('EntityAttributes')!.trait) as { guid?: string }).guid ?? '') : '';
  return { homeParent: guid, homeSteps: at.extra.join('.') };
}

registerAllTraits();
setActionCallback(pushAction);

const INNER = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const OUTER = 'aaaaaaaa-0000-4000-8000-0000000000c2';
const HOLDER = 'bbbbbbbb-0000-4000-8000-0000000000c1';
const ROOT = 'bbbbbbbb-0000-4000-8000-0000000000c2';
const ANCHORED = 'bbbbbbbb-0000-4000-8000-0000000000c3';

/** ⚠️ Every hand-written row here is PREFAB v5 — it mints a `nodeGuid` — because the suite is about
 *  the ROW path: without one the member has no scene row and its move goes to the legacy `moved`
 *  map instead (#1468 Phase 3). The pre-v5 path is covered by its own describes, which strip the
 *  guids on purpose. Minted from a counter rather than hashed from (doc, localId) so nothing here can
 *  come to depend on a derivable identity — the whole point of the field is that it is not one. */
let nextFixtureNodeGuid = 0;
const nodeGuid = () => `dddddddd-0000-4000-8000-${String(++nextFixtureNodeGuid).padStart(12, '0')}`;
const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, nodeGuid: nodeGuid(), ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});

/** Author a member row on a hand-written scene entry, addressed by the TEMPLATE row's identity —
 *  the only spelling of a row key there is. Replaces `entry.moved = { <localId>: guid }`. */
const authorRow = (
  entry: Record<string, unknown>, doc: { entities: Array<{ localId: number; nodeGuid?: string }> },
  localId: number, row: Record<string, unknown>,
): void => {
  const g = doc.entities.find((e) => e.localId === localId)!.nodeGuid!;
  ((entry.members ??= {}) as Record<string, unknown>)[`/${g}`] = { guid: '', ...row };
};

const innerDoc = { id: INNER, rootLocalId: 1, entities: [row(1, 'InnerRoot', 0), row(2, 'Leaf', 1)] };
const outerDoc = {
  id: OUTER, rootLocalId: 1, entities: [
    row(1, 'OuterRoot', 0), row(2, 'Panel', 1), row(3, 'Button', 2), row(4, 'Nested', 2, { prefab: INNER }),
  ],
};

async function load(scene: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(scene)), {
    loadModels: false,
    fetchPrefab: async (ref) => (prefabs.get(ref) as object) ?? null,
    // As SceneManager does: destroyEntity (no cascade), not deleteEntity.
    onDeletePlaceholder: (id) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    // Mirrors SceneManager's onInstantiatePrefab: structure + nested overrides + the root's extra
    // traits + the root guid.
    onInstantiatePrefab: async (source, parentId, rootTf, _old, extra, overrides, structure, nested, rootGuid, _folder, nestedStructure) => {
      const world = getCurrentWorld();
      const rootId = instantiatePrefabIntoWorld(world, prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
      if (!rootId) return undefined;
      for (const e of world.entities) {
        if (e.id() !== rootId) continue;
        for (const [name, data] of Object.entries(extra ?? {})) {
          const meta = getTraitByName(name);
          if (meta) e.add(meta.trait(data as never));
        }
        if (rootGuid) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid: rootGuid });
      }
      return rootId; // as SceneManager does, so the loader retargets placeholder refs (#1353)
    },
  });
}

/** guid → name chain from the scene root. */
function treePaths(): Map<string, string> {
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const out = new Map<string, string>();
  for (const e of all) {
    if (!e.guid) continue;
    const names: string[] = [];
    let cur: typeof e | undefined = e;
    const seen = new Set<number>();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); names.unshift(cur.name); cur = byId.get(cur.parentId); }
    const path = names.join('/');
    if ([...out.values()].includes(path)) throw new Error(`fixture: two entities at ${path}`);
    out.set(e.guid, path);
  }
  return out;
}
const idAt = (path: string): number => {
  const byPath = new Map([...treePaths()].map(([g, p]) => [p, g]));
  const e = getAllEntities().find((x) => x.guid === byPath.get(path));
  if (!e) throw new Error(`fixture: nothing at ${path} (have: ${[...byPath.keys()].join(', ')})`);
  return e.id;
};
const guidAt = (path: string): string => getAllEntities().find((e) => e.id === idAt(path))!.guid ?? '';
// Through the undoable path, which marks an instance-root rename as an override so it is saved.
const rename = (id: number, name: string) => writeTraitFieldWithUndo(id, getTraitByName('EntityAttributes')!, 'name', name);
const targetsOf = (id: number): string[] => {
  const e = [...getCurrentWorld().entities].find((x) => x.id() === id)!;
  return ((e.get(getTraitByName('UIAction')!.trait) as { bindings: { target: string }[] }).bindings).map((b) => b.target);
};
const withUi = (traits: Record<string, unknown>, refs: string[]) =>
  ({ ...traits, UIAction: { bindings: refs.map((target) => ({ event: 'click', action: 'noop', target })) } });

/** A legacy scene: Holder → a GUID-LESS top-level OUTER instance, whose root and members all derive
 *  from Holder; refs on Holder aim at members. */
const legacyScene = (holderRefs: string[], rootRefs: string[] = []): SceneData => ({
  id: 'dup-legacy', version: 8, name: 'L', resources: [],
  entities: [
    { id: 1, traits: withUi({ EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } }, holderRefs) },
    { id: 2, prefab: OUTER, traits: withUi({ EntityAttributes: { name: 'OuterRoot', parentId: HOLDER }, Transform: { x: 0, y: 0, z: 0 } }, rootRefs) },
  ],
} as unknown as SceneData);

/** The scene: Holder → an OUTER instance (own guid) carrying an added INNER under Button. The added
 *  node carries its OWN guid; the guid-less variant is covered by the #1349 block below. */
const scene = (holderRefs: string[], rootRefs: string[] = []): SceneData => ({
  id: 'dup-scene', version: 8, name: 'S', resources: [],
  entities: [
    { id: 1, traits: withUi({ EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } }, holderRefs) },
    {
      id: 2, prefab: OUTER, guid: ROOT,
      traits: withUi({ EntityAttributes: { name: 'OuterRoot', parentId: HOLDER }, Transform: { x: 0, y: 0, z: 0 } }, rootRefs),
      added: [{ parentLocalId: 3, guid: ANCHORED, name: 'AddedInner', prefab: INNER, traits: {}, children: [] }],
    },
  ],
} as unknown as SceneData);

const MEMBERS = ['OuterRoot/Panel/Button', 'OuterRoot/Panel/InnerRoot/Leaf', 'OuterRoot/Panel/Button/InnerRoot/Leaf'];

beforeEach(() => {
  clearKeptMemberOrphans(); // R2's kept rows are process state: a rebuild here keeps a dropped member's row (#1535), and it must not reach the next case
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  prefabs.set(INNER, innerDoc);
  prefabs.set(OUTER, outerDoc);
  setPrefabCache(INNER, innerDoc as never);
  setPrefabCache(OUTER, outerDoc as never);
});
afterAll(() => { setPrefabCache(INNER, null); setPrefabCache(OUTER, null); getCurrentWorld()?.destroy(); });

/** Load the scene with the Holder's refs aimed at each member, and return those refs. */
async function loaded(): Promise<string[]> {
  await load(scene([]));
  const refs = MEMBERS.map((m) => guidAt(`Holder/${m}`));
  await load(scene(refs));
  return refs;
}

describe('an editor duplicate carries refs to prefab members through save + reload (#1338)', () => {
  it('duplicating a plain parent of an instance: its refs follow the COPY\'s members', async () => {
    const refs = await loaded();
    const copyId = duplicateEntity(idAt('Holder'), () => {})!;
    rename(copyId, 'Copy');
    const live = targetsOf(copyId);
    expect(live).toEqual(MEMBERS.map((m) => guidAt(`Copy/${m}`)));
    expect(targetsOf(idAt('Holder'))).toEqual(refs); // the source keeps its own

    await load(await serializeScene() as unknown as SceneData);
    const copy = idAt('Copy');
    expect(targetsOf(copy)).toEqual(live);
    expect(targetsOf(copy).map((g) => treePaths().get(g))).toEqual(MEMBERS.map((m) => `Copy/${m}`));
    expect(targetsOf(idAt('Holder')).map((g) => treePaths().get(g))).toEqual(MEMBERS.map((m) => `Holder/${m}`));
  });

  it('duplicating the instance ROOT: a ref on the root to its own members follows the new instance', async () => {
    await load(scene([]));
    const refs = MEMBERS.slice(1).map((m) => guidAt(`Holder/${m}`));
    await load(scene([], refs));
    const copyId = duplicateEntity(idAt('Holder/OuterRoot'), () => {})!;
    rename(copyId, 'Twin');
    const twinMembers = MEMBERS.slice(1).map((m) => `Holder/${m.replace(/^OuterRoot/, 'Twin')}`);
    expect(targetsOf(copyId)).toEqual(twinMembers.map(guidAt));

    await load(await serializeScene() as unknown as SceneData);
    expect(targetsOf(idAt('Holder/Twin')).map((g) => treePaths().get(g))).toEqual(twinMembers);
    expect(targetsOf(idAt('Holder/OuterRoot')).map((g) => treePaths().get(g)))
      .toEqual(MEMBERS.slice(1).map((m) => `Holder/${m}`));
  });

  // #1338 review, finding 2. Mutation: classify by "live guid equals its derivation" again.
  it('duplicating a LEGACY (guid-less) instance root: its members reload under the copy\'s saved root guid', async () => {
    await load(legacyScene([]));
    const paths = ['Holder/OuterRoot/Panel/Button', 'Holder/OuterRoot/Panel/InnerRoot/Leaf'];
    await load(legacyScene(paths.map(guidAt), paths.map(guidAt)));
    const holder = idAt('Holder');
    const copyId = duplicateEntity(idAt('Holder/OuterRoot'), () => {})!;
    rename(copyId, 'Twin');
    // Aim the copy-holder's refs through a plain copy of Holder instead: duplicate Holder too.
    const hc = duplicateEntity(holder, () => {})!;
    rename(hc, 'HolderCopy');
    const twinPaths = paths.map((p) => p.replace('Holder/', 'HolderCopy/'));
    expect(targetsOf(hc).map((g) => treePaths().get(g))).toEqual(twinPaths);

    await load(await serializeScene() as unknown as SceneData);
    expect(targetsOf(idAt('HolderCopy')).map((g) => treePaths().get(g))).toEqual(twinPaths);
    // The copied ROOT is an anchor whose guid the save stores: its own refs reload under it.
    expect(targetsOf(idAt('Holder/Twin')).map((g) => treePaths().get(g)))
      .toEqual(paths.map((p) => p.replace('Holder/OuterRoot', 'Holder/Twin')));
  });

  // #1338 review, finding 1: a nested root whose DERIVED guid a save already stored (#1349's shape).
  it('a copy stays resolvable when the source nested root carries a stored guid that equals its derivation', async () => {
    const promoted = (refs: string[]): SceneData => {
      const sc = scene(refs) as unknown as { entities: Array<Record<string, unknown>> };
      (sc.entities[1]!.added as Array<Record<string, unknown>>)[0]!.guid = '';
      return sc as unknown as SceneData;
    };
    await load(promoted([]));
    // Save once: the save stores the added root's derived guid. Reload that file.
    const saved = await serializeScene() as unknown as SceneData;
    await load(saved);
    const leaf = 'Holder/OuterRoot/Panel/Button/InnerRoot/Leaf';
    const withRef = JSON.parse(JSON.stringify(saved)) as { entities: Array<{ traits: Record<string, unknown> }> };
    const holderEntry = withRef.entities.find((e) => (e.traits.EntityAttributes as { name?: string })?.name === 'Holder')!;
    holderEntry.traits.UIAction = { bindings: [{ event: 'click', action: 'noop', target: guidAt(leaf) }] };
    await load(withRef as unknown as SceneData);
    const copyId = duplicateEntity(idAt('Holder'), () => {})!;
    rename(copyId, 'Copy');
    await load(await serializeScene() as unknown as SceneData);
    expect(targetsOf(idAt('Copy')).map((g) => treePaths().get(g))).toEqual([leaf.replace('Holder/', 'Copy/')]);
  });
});

// #1349: a guid-less instance root that a save STORES must anchor its own members from the first
// load, or the first save re-anchors them and every ref to one dangles — no duplicate involved.
// Mutation: in deriveInstanceMemberGuids, drop the `storedRoot` anchor (walk through the root).
describe('a guid-less stored instance root keeps its members\' guids across a save (#1349)', () => {
  const roundTrip = async (build: (refs: string[]) => SceneData, path: string): Promise<void> => {
    await load(build([]));
    const firstLoad = guidAt(path);
    await load(build([firstLoad]));
    await load(await serializeScene() as unknown as SceneData);
    expect(guidAt(path)).toBe(firstLoad);
    expect(targetsOf(idAt('Holder')).map((g) => treePaths().get(g))).toEqual([path]);
  };

  it('a guid-less USER-ADDED nested instance: a ref to its member survives save + reload', async () => {
    const guidLessAdded = (refs: string[]): SceneData => {
      const sc = scene(refs) as unknown as { entities: Array<Record<string, unknown>> };
      (sc.entities[1]!.added as Array<Record<string, unknown>>)[0]!.guid = '';
      return sc as unknown as SceneData;
    };
    await roundTrip(guidLessAdded, 'Holder/OuterRoot/Panel/Button/InnerRoot/Leaf');
  });

  it('a guid-less TOP-LEVEL instance under a plain parent: a ref to its member survives save + reload', async () => {
    await roundTrip(legacyScene, 'Holder/OuterRoot/Panel/Button');
  });
});

// #1355: an OWNED nested instance (OUTER's row 4) that leaves its row must be saved as removed from
// OUTER, or the reload re-expands the row beside the moved/deleted copy. Mutation: skip nested rows
// in captureInstanceStructure's removal pass again (`if (pe.prefab) continue`).
describe('an owned nested instance that leaves its row stays gone after save + reload (#1355)', () => {
  const SHELF = 'bbbbbbbb-0000-4000-8000-0000000000c4';
  const withShelf = (): SceneData => {
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = undefined;
    sc.entities.push({ id: 3, traits: { EntityAttributes: { name: 'Shelf', parentId: 0, guid: SHELF } } });
    return sc as unknown as SceneData;
  };
  /** Every live guid is held by exactly one entity (treePaths also throws on two at one path). */
  const expectUniqueGuids = () => {
    const guids = getAllEntities().map((e) => e.guid).filter(Boolean);
    expect(guids.length).toBe(new Set(guids).size);
  };

  it('deleted: it stays deleted', async () => {
    await load(withShelf());
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel/InnerRoot')]);
    await load(await serializeScene() as unknown as SceneData);
    expect([...treePaths().values()].filter((p) => p.includes('InnerRoot'))).toEqual([]);
  });

  // #1355 review, finding 1. Mutation: drop the stored-root exemption in reparentEntity's detach.
  it('an instance ROOT moved onto a plain entity stays an instance, and a ref to its member survives', async () => {
    await load(withShelf());
    reparentEntity(idAt('Holder/OuterRoot'), idAt('Shelf'));
    const root = [...getCurrentWorld().entities].find((e) => e.id() === idAt('Shelf/OuterRoot'))!;
    expect(root.has(getTraitByName('PrefabInstance')!.trait)).toBe(true);
    const leaf = guidAt('Shelf/OuterRoot/Panel/InnerRoot/Leaf');
    const saved = await serializeScene() as unknown as { entities: Array<{ traits: Record<string, unknown> }> };
    const shelf = saved.entities.find((e) => (e.traits.EntityAttributes as { name?: string })?.name === 'Shelf')!;
    shelf.traits.UIAction = { bindings: [{ event: 'click', action: 'noop', target: leaf }] };
    await load(saved as unknown as SceneData);
    expectUniqueGuids();
    expect(targetsOf(idAt('Shelf')).map((g) => treePaths().get(g))).toEqual(['Shelf/OuterRoot/Panel/InnerRoot/Leaf']);
  });

  // #1436 (owner): a stored instance dropped INSIDE another instance keeps its link and becomes that
  // instance's user-added nested instance. #1355's review once made it unpack here, because the save
  // lost it; #1367/#1369 made the save represent it. Survival alone could not pin either rule, since a
  // linked and an unpacked instance reload at the same paths, so each case asserts the LINK and a
  // member override. Mutation: in reparentEntity's detach, unpack a stored root whose new parent sits
  // inside an instance (the pre-#1436 `keepLinked`).
  const linked = (id: number) => [...getCurrentWorld().entities].find((x) => x.id() === id)!.has(getTraitByName('PrefabInstance')!.trait as never);
  const leafX = (id: number) => ([...getCurrentWorld().entities].find((x) => x.id() === id)!.get(getTraitByName('Transform')!.trait) as { x: number }).x;
  const INTO = [
    ['under a member that owns a row of its prefab', 'Holder/OuterRoot/Panel', 'Holder/OuterRoot/Panel/'],
    ['under a member of an owned nested instance', 'Holder/OuterRoot/Panel/InnerRoot/Leaf', 'Holder/OuterRoot/Panel/InnerRoot/Leaf/'],
  ] as const;
  it.each(INTO)('a top-level instance moved %s stays linked through save + reload, under its exact parent', async (_label, target, at) => {
    const sc = withShelf() as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities.push({ id: 4, prefab: INNER, guid: 'bbbbbbbb-0000-4000-8000-0000000000c5', traits: { EntityAttributes: { name: 'InnerRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } });
    await load(sc as unknown as SceneData);
    const solo = idAt('InnerRoot');
    rename(solo, 'Solo'); // the prefab names the root; a rename is an override the save keeps
    writeTraitFieldWithUndo(idAt('Solo/Leaf'), getTraitByName('Transform')!, 'x', 7);
    reparentEntity(solo, idAt(target));
    expect(linked(idAt(`${at}Solo`))).toBe(true);
    await load(await serializeScene() as unknown as SceneData);
    expectUniqueGuids();
    expect([...treePaths().values()].filter((p) => p.includes('Solo'))).toEqual([`${at}Solo`, `${at}Solo/Leaf`]);
    expect(linked(idAt(`${at}Solo`))).toBe(true);
    expect(leafX(idAt(`${at}Solo/Leaf`))).toBe(7);
  });

  // #1436 review: the drop keeps the world pose by rewriting the root's local Transform, and on a LINKED root
  // those values are overrides the save keeps only when marked. Unmarked, the root reloaded at the prefab's
  // x, under a parent at x=10: it jumped by the parent's offset. y carries a file override (marked at load)
  // and must keep it. Mutations: drop the markCompensatedTransform call in reparentEntity's apply, its
  // `restoreMarks` on undo, or its re-mark on redo — each turns this red.
  it('a top-level instance dropped under a moved parent keeps its world pose through save + reload; undo drops the marks, redo restores them', async () => {
    const sc = withShelf() as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities.push({ id: 4, prefab: INNER, guid: 'bbbbbbbb-0000-4000-8000-0000000000c5', overrides: { 1: { Transform: { y: 4 } } }, traits: { EntityAttributes: { name: 'InnerRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } });
    await load(sc as unknown as SceneData);
    const solo = idAt('InnerRoot');
    rename(solo, 'Solo'); // Panel already holds an owned InnerRoot
    const panel = idAt('Holder/OuterRoot/Panel');
    const entityOf = (id: number) => [...getCurrentWorld().entities].find((x) => x.id() === id)!;
    const before = [...(getOverrideMarkSet(entityOf(solo)) ?? [])].sort();
    // Panel "moved" to x=10 in the LIVE world: the reparent reads the chains on demand, never the per-frame cache (#1848).
    const tfTrait = getTraitByName('Transform')!.trait;
    entityOf(panel).set(tfTrait, { ...(entityOf(panel).get(tfTrait) as object), x: 10 });
    reparentEntity(solo, panel);
    expect(getOverrideMarkSet(entityOf(solo))?.has('Transform.x')).toBe(true);
    await undo();
    expect([...(getOverrideMarkSet(entityOf(solo)) ?? [])].sort()).toEqual(before);
    await redo();
    expect(getOverrideMarkSet(entityOf(solo))?.has('Transform.x')).toBe(true);
    await load(await serializeScene() as unknown as SceneData);
    const tf = entityOf(idAt('Holder/OuterRoot/Panel/Solo')).get(getTraitByName('Transform')!.trait) as { x: number; y: number };
    expect(linked(idAt('Holder/OuterRoot/Panel/Solo'))).toBe(true);
    expect(tf.x).toBeCloseTo(-10);
    expect(tf.y).toBeCloseTo(4);
  });

  // #1433: the same drop with the instance one level down, under a plain entity. It never unpacked
  // (the old rule looked at the moved root only), and it needs no unpack: the plain entity is saved as
  // an added node whose child is the instance's prefab reference. Mutation: make captureChild skip a
  // user-added nested root.
  it.each(INTO)('a plain entity holding a top-level instance, moved %s: the instance stays linked through save + reload', async (_label, target, at) => {
    const CRATE = 'bbbbbbbb-0000-4000-8000-0000000000c6';
    const sc = withShelf() as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities.push({ id: 4, traits: { EntityAttributes: { name: 'Crate', parentId: 0, guid: CRATE }, Transform: { x: 0, y: 0, z: 0 } } });
    sc.entities.push({ id: 5, prefab: INNER, guid: 'bbbbbbbb-0000-4000-8000-0000000000c5', traits: { EntityAttributes: { name: 'InnerRoot', parentId: CRATE }, Transform: { x: 0, y: 0, z: 0 } } });
    await load(sc as unknown as SceneData);
    rename(idAt('Crate/InnerRoot'), 'Solo');
    writeTraitFieldWithUndo(idAt('Crate/Solo/Leaf'), getTraitByName('Transform')!, 'x', 7);
    reparentEntity(idAt('Crate'), idAt(target));
    await load(await serializeScene() as unknown as SceneData);
    expectUniqueGuids();
    expect([...treePaths().values()].filter((p) => p.includes('Crate'))).toEqual([`${at}Crate`, `${at}Crate/Solo`, `${at}Crate/Solo/Leaf`]);
    expect(linked(idAt(`${at}Crate/Solo`))).toBe(true);
    expect(leafX(idAt(`${at}Crate/Solo/Leaf`))).toBe(7);
  });

  // Mutation: let the presence check accept an instance of the row's prefab under ANY parent.
  it('deleted while a user-added instance of the same prefab sits under ANOTHER member: only the deleted one stays gone', async () => {
    await load(scene([]));
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel/InnerRoot')]);
    await load(await serializeScene() as unknown as SceneData);
    const inner = [...treePaths().values()].filter((p) => p.endsWith('InnerRoot'));
    expect(inner).toEqual(['Holder/OuterRoot/Panel/Button/InnerRoot']);
  });

  // The editor-side apply (refresh/revert rebuild). Mutation: drop the nested-row mapping in
  // applyStructureByRootInstance.
  it('deleted, then the outer instance is REBUILT: the rebuild does not bring it back', async () => {
    await load(withShelf());
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel/InnerRoot')]);
    const root = idAt('Holder/OuterRoot');
    const structure = captureInstanceStructure(root, outerDoc as never);
    expect(structure.removed).toEqual([4]);
    rebuild(root, OUTER, outerDoc as never);
    expect([...treePaths().values()].filter((p) => p.includes('InnerRoot'))).toEqual([]);
    expect([...treePaths().values()]).toContain('Holder/OuterRoot/Panel/Button');
  });

  // An UNSTAMPED instance at the row used to count as present too ("the legacy form"). #1367 made it
  // independent: it is written as a reference node and the row as removed, which reloads as the same
  // single instance — pinned in the #1367 block, not here.
  // Mutation: `nestedRowPresent` answers "absent" — the row is saved as removed. Read through `view`: since #1468 a
  // removal is written on the member ROW, and the raw top-level `removed` stayed undefined whatever it answered (#1670).
  it('left in place: it is NOT recorded as removed', async () => {
    await load(withShelf());
    const saved = await serializeScene() as unknown as { entities: Array<{ prefab?: string; removed?: number[] }> };
    expect(view(saved).entities.find((e) => e.prefab === OUTER)?.removed ?? []).toEqual([]);
    await load(saved as unknown as SceneData);
    expect([...treePaths().values()]).toContain('Holder/OuterRoot/Panel/InnerRoot/Leaf');
  });
});

// #1354: a nested prefab row expands to exactly ONE instance, but `nestedRootKind` tested each node
// against a Set of "<member>:<source>" keys that any number of nodes could match. So a SECOND
// instance at the row also read as 'owned' — `captureChild` dropped it and both filed into the one
// row's `nestedOverrides`, later one winning — and it was gone after a reload. Two reported ways in:
// a duplicate of the row's own expansion, and a user-added instance under a member that already owns
// a row of that prefab. Both are asserted by GUID rather than by tree path: the two instances share
// the prefab's own member names, and a reference node's `name` does not rename the instantiated root.
//
// Mutation for both: in captureInstanceStructure, drop the two claim passes and restore the per-node
// shape — `if (stamp > 0) return 'owned'`, then a `rowsByAnchor.has(key)` membership test.
//
// The unstamped half — an instance with no stamp claiming a free row — was removed outright by
// #1367; its tests are in the #1367 block below.
describe('a SECOND nested instance at a prefab row is independent, not the row itself (#1354)', () => {
  const TWIN = 'bbbbbbbb-0000-4000-8000-0000000000d1';
  /** The scene with its added node dropped: OUTER's row 4 is the only INNER instance under Panel. */
  const plain = (): SceneData => {
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = undefined;
    return sc as unknown as SceneData;
  };
  const expectUniqueGuids = () => {
    const guids = getAllEntities().map((e) => e.guid).filter(Boolean);
    expect(guids.length).toBe(new Set(guids).size);
  };
  const ownerEntry = (saved: unknown) => view(saved as {
    entities: Array<{ prefab?: string; added?: unknown[] }>;
  }).entities.find((e) => e.prefab === OUTER)!;
  const guidOf = (id: number) => getAllEntities().find((e) => e.id === id)!.guid ?? '';
  const xOf = (id: number) => ((([...getCurrentWorld().entities].find((z) => z.id() === id)!
    .get(getTraitByName('Transform')!.trait)) as { x: number }).x);
  /** Every INNER instance is back, each with its own Leaf — the count is what the bug reduced. */
  const expectTwoInnersWithLeaves = () => {
    const leaves = getAllEntities().filter((e) => e.name === 'Leaf');
    expect(leaves).toHaveLength(2);
    // Under DIFFERENT roots: the count alone would pass for one InnerRoot holding both.
    expect(new Set(leaves.map((l) => l.parentId)).size).toBe(2);
  };

  it('the duplicate of an owned nested root survives save + reload beside its source', async () => {
    await load(plain());
    const src = idAt('Holder/OuterRoot/Panel/InnerRoot');
    const srcGuid = guidOf(src);
    const copy = duplicateEntity(src, () => {})!;
    const copyGuid = guidOf(copy);
    expect(copyGuid).not.toBe(srcGuid); // precondition: the copy got its own guid
    // The copy is independent AT CREATION (owner ruling, 2026-09-18) — not merely classified that
    // way later because the source happened to claim the row first. Asserted separately because the
    // partition alone would carry the round trip below, leaving the remint unfalsified.
    const stampOf = (id: number) => ((([...getCurrentWorld().entities].find((e) => e.id() === id)!
      .get(getTraitByName('PrefabInstance')!.trait) as Record<string, unknown>).parentLocalId as number) || 0);
    expect(stampOf(src)).toBeGreaterThan(0);
    expect(stampOf(copy)).toBe(0);
    const saved = await serializeScene();
    // The copy rides as an added reference node; the row keeps its single own expansion.
    expect(ownerEntry(saved).added).toHaveLength(1);
    await load(saved as unknown as SceneData);
    expectUniqueGuids();
    expectTwoInnersWithLeaves();
    expect(getAllEntities().some((e) => e.guid === copyGuid)).toBe(true);
  });

  it('a user-added nested instance under the member that owns that row is saved, not swallowed', async () => {
    const sc = plain() as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = [{ parentLocalId: 2, guid: TWIN, name: 'AddedInner', prefab: INNER, traits: {}, children: [] }];
    await load(sc as unknown as SceneData);
    // Precondition: two INNER roots under Panel — the row's expansion and the user-added one.
    const panel = getAllEntities().find((e) => e.name === 'Panel')!;
    expect(getAllEntities().filter((e) => e.parentId === panel.id && e.name === 'InnerRoot')).toHaveLength(2);
    const saved = await serializeScene();
    expect(ownerEntry(saved).added).toHaveLength(1); // was `undefined` — the node was swallowed
    await load(saved as unknown as SceneData);
    expectUniqueGuids();
    expectTwoInnersWithLeaves();
    // Not `treePaths()`: both INNER roots reload under Panel with the prefab's own name, and it
    // throws on two entities at one path. Not `idOfGuid(TWIN) > 0` either — every live id is > 0, so
    // that asserted nothing but the lookup's own throw. The guid's survival IS the defect's absence.
    expect(getAllEntities().some((e) => e.guid === TWIN)).toBe(true);
  });

  // #1354 close-out review, F1 — the copy used to be written by NEITHER path once its source was
  // deleted (added/nestedOverrides/removed all undefined; it reloaded at x=0). #1367 settled which one
  // owns it: an unstamped copy is independent, never the row, so it is a reference node and the row it
  // replaced is `removed`. Mutation: restore a pass that lets an unstamped candidate claim a free row.
  it('the copy keeps its edits when the SOURCE is deleted — a reference node, and the row removed', async () => {
    await load(plain());
    const src = idAt('Holder/OuterRoot/Panel/InnerRoot');
    const copy = duplicateEntity(src, () => {})!;
    writeTraitFieldWithUndo(copy, getTraitByName('Transform')!, 'x', 99);
    deleteEntitiesWithUndo([src]);
    const saved = await serializeScene() as unknown as { entities: Array<Record<string, unknown>> };
    const entry = view(saved).entities.find((e) => e.prefab === OUTER)!;
    expect(entry.added).toHaveLength(1);
    expect(entry.removed).toEqual([4]);
    expect(entry.nestedOverrides).toBeUndefined();
    await load(saved as unknown as SceneData);
    expect(getAllEntities().filter((e) => e.name === 'InnerRoot').map((e) => xOf(e.id))).toEqual([99]);
  });

  // #1354 close-out review, F3's mirror — the other direction of the same disagreement. A stamped
  // candidate the partition did NOT give the row to used to be written TWICE (an added[] node AND
  // nestedOverrides for that row), and the nestedOverrides write clobbered the claimant's own
  // override. Latent today (both duplicate seams clear the stamp), so the stamp is forced here.
  // Mutation: same as above.
  it('a same-stamp pair is written once each, and the source override is not clobbered', async () => {
    await load(plain());
    const src = idAt('Holder/OuterRoot/Panel/InnerRoot');
    writeTraitFieldWithUndo(src, getTraitByName('Transform')!, 'x', 11);
    const copy = duplicateEntity(src, () => {})!;
    writeTraitFieldWithUndo(copy, getTraitByName('Transform')!, 'x', 77);
    // Force the pre-#1354 state: both instances stamped with row 4.
    const piMeta = getTraitByName('PrefabInstance')!;
    const live = [...getCurrentWorld().entities].find((e) => e.id() === copy)!;
    live.set(piMeta.trait, { ...(live.get(piMeta.trait) as object), parentLocalId: 4 });
    const saved = await serializeScene() as unknown as { entities: Array<Record<string, unknown>> };
    const entry = view(saved).entities.find((e) => e.prefab === OUTER)!;
    expect(entry.added).toHaveLength(1);
    // The row's overrides are the SOURCE's, not the copy's.
    expect(JSON.stringify(entry.nestedOverrides)).toContain('11');
    expect(JSON.stringify(entry.nestedOverrides)).not.toContain('77');
    await load(saved as unknown as SceneData);
    expect(getAllEntities().filter((e) => e.name === 'InnerRoot').map((e) => xOf(e.id)).sort((a, b) => a - b)).toEqual([11, 77]);
  });

  // #1354 close-out review, F4 — with TWO rows of one source under one member and one UNSTAMPED
  // instance, the old unstamped pass claimed the first row in prefab-file ORDER and wrote the OTHER
  // into `removed[]`, deleting it on reload. #1367 removed that pass: the unstamped instance is
  // independent (a reference node), BOTH rows are gone from the live tree and say so, and what reloads
  // is exactly what was live — one instance, its own guid.
  // Mutation: restore a pass that lets an unstamped candidate claim a free row.
  it('an unstamped instance beside two rows of its source reloads as itself, and no row dies by file order', async () => {
    const outerTwo = { id: OUTER, rootLocalId: 1, entities: [
      row(1, 'OuterRoot', 0), row(2, 'Panel', 1), row(4, 'N1', 2, { prefab: INNER }), row(5, 'N2', 2, { prefab: INNER }),
    ] };
    prefabs.set(OUTER, outerTwo); setPrefabCache(OUTER, outerTwo as never);
    await load(plain());
    const roots = getAllEntities().filter((e) => e.name === 'InnerRoot');
    expect(roots).toHaveLength(2); // precondition: both rows expanded
    const piMeta = getTraitByName('PrefabInstance')!;
    const first = [...getCurrentWorld().entities].find((e) => e.id() === roots[0]!.id)!;
    first.set(piMeta.trait, { ...(first.get(piMeta.trait) as object), parentLocalId: 0 });
    const keptGuid = guidOf(roots[0]!.id);
    deleteEntitiesWithUndo([roots[1]!.id]);
    const saved = await serializeScene() as unknown as { entities: Array<Record<string, unknown>> };
    const entry = view(saved).entities.find((e) => e.prefab === OUTER)!;
    expect(entry.removed).toEqual([4, 5]);
    expect(entry.added).toHaveLength(1);
    await load(saved as unknown as SceneData);
    expectUniqueGuids();
    expect(getAllEntities().filter((e) => e.name === 'InnerRoot').map((e) => e.guid)).toEqual([keptGuid]);
  });
});

// #1367: an UNSTAMPED nested instance could claim a free row (a second claim pass for "legacy" data),
// and presence stayed lenient wherever one sat at a row's anchor. Together: a user-added instance was
// taken to BE a deleted row's expansion, so a no-op save dropped the addition (no reference node) and
// the row's `removed` (lenient presence) — the row came back and the user's instance was gone. Both
// halves were removed together; the premise that makes that safe is pinned first.
describe('an unstamped nested instance is independent, never a row (#1367)', () => {
  const D9 = 'bbbbbbbb-0000-4000-8000-0000000000d9';
  type Saved = { entities: Array<Record<string, unknown>> };
  const entryOf = (saved: Saved) => view(saved).entities.find((e) => e.prefab === OUTER)!;
  const panelInners = () => {
    const panel = getAllEntities().find((e) => e.name === 'Panel')!;
    return getAllEntities().filter((e) => e.parentId === panel.id && e.name === 'InnerRoot');
  };
  const stampOf = (id: number) => ((([...getCurrentWorld().entities].find((e) => e.id() === id)!
    .get(getTraitByName('PrefabInstance')!.trait) as Record<string, unknown>).parentLocalId as number) || 0);
  const withAdded = (removed?: number[]): SceneData => {
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = [{ parentLocalId: 2, guid: D9, name: 'AddedInner', prefab: INNER, traits: {}, children: [] }];
    if (removed) sc.entities[1]!.removed = removed;
    return sc as unknown as SceneData;
  };

  // The premise: every path that EXPANDS a row stamps it, so an unstamped live instance cannot be one.
  // Mutation: drop the stamp write in the loader's row branch (`parentLocalId: rowLocalId`), then in
  // the editor's `instantiatePrefab` (`parentLocalId: pe.localId`) — each reddens its own assertion.
  it('every row expansion is stamped — the loader and the editor instantiate alike', async () => {
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = undefined;
    await load(sc as unknown as SceneData);
    expect(panelInners().map((e) => stampOf(e.id))).toEqual([4]);
    const loaded = new Set(getAllEntities().map((e) => e.id));
    expect(instantiatePrefab(outerDoc as never, 0)).toBeGreaterThan(0);
    const editorInner = getAllEntities().filter((e) => e.name === 'InnerRoot' && !loaded.has(e.id));
    expect(editorInner.map((e) => stampOf(e.id))).toEqual([4]);
  });

  it('the reported file: a no-op save keeps BOTH the removed row and the added instance', async () => {
    await load(withAdded([4]));
    expect(panelInners()).toHaveLength(1); // precondition: only the added one
    const saved = await serializeScene() as unknown as Saved;
    expect(entryOf(saved).removed).toEqual([4]);
    expect((entryOf(saved).added as Array<{ guid: string }>).map((n) => n.guid)).toEqual([D9]);
    await load(saved as unknown as SceneData);
    expect(panelInners().map((e) => e.guid)).toEqual([D9]);
  });

  it('through the UI: deleting the row\'s expansion beside a user-added sibling stays deleted', async () => {
    await load(withAdded());
    const inners = panelInners();
    expect(inners).toHaveLength(2); // precondition: the row's expansion + the added one
    deleteEntitiesWithUndo([inners.find((e) => e.guid !== D9)!.id]);
    const saved = await serializeScene() as unknown as Saved;
    expect(entryOf(saved).removed).toEqual([4]);
    await load(saved as unknown as SceneData);
    expect(panelInners().map((e) => e.guid)).toEqual([D9]);
  });

  // The regression dropping the unstamped pass alone would cause: a legacy unstamped expansion written
  // as a reference node while its row ALSO still expands — two instances. Strict presence is what
  // prevents it, so this is the test for that half. Mutation: make `nestedRowPresent` lenient again
  // (return true whenever an unstamped candidate sits at the row's anchor).
  it('an unstamped expansion of a row reloads as ONE instance, keeping its guid and its edits', async () => {
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = undefined;
    await load(sc as unknown as SceneData);
    const [inner] = panelInners();
    const guid = inner!.guid;
    const piMeta = getTraitByName('PrefabInstance')!;
    const live = [...getCurrentWorld().entities].find((e) => e.id() === inner!.id)!;
    live.set(piMeta.trait, { ...(live.get(piMeta.trait) as object), parentLocalId: 0 });
    deleteEntitiesWithUndo([getAllEntities().find((e) => e.name === 'Leaf' && e.parentId === inner!.id)!.id]);
    await load(await serializeScene() as unknown as SceneData);
    const guids = getAllEntities().map((e) => e.guid).filter(Boolean);
    expect(guids.length).toBe(new Set(guids).size);
    expect(panelInners().map((e) => e.guid)).toEqual([guid]);
    expect(getAllEntities().filter((e) => e.name === 'Leaf' && e.parentId === panelInners()[0]!.id)).toHaveLength(0);
  });
});

// #1358: a structural edit made INSIDE a row's own expansion (an owned nested instance) was captured
// by nothing — `serializeScene` ran `captureInstanceStructure` only for TOP-LEVEL instances, and an
// owned nested instance got a per-field VALUE delta and no structural channel at all. So a deleted
// member came back on reload and a member dragged out existed at BOTH places, two entities holding
// one guid. The scene now has a path-keyed `nestedStructure` beside `nestedOverrides`.
//
// Mutation for the whole block: drop the `captureInstanceStructure` half of serializeScene's
// nested-instance loop (everything from `const structure =` to the `nestedStructureByTop.set`).
describe("structural edits inside an owned nested instance round-trip (#1358)", () => {
  const SHELF = 'bbbbbbbb-0000-4000-8000-0000000000e1';
  const BOLT = 'bbbbbbbb-0000-4000-8000-0000000000e2';
  /** OUTER instance (row 4 expands INNER under Panel) plus a plain Shelf to drag things onto. */
  const withShelf = (): SceneData => {
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = undefined;
    sc.entities.push({ id: 3, traits: { EntityAttributes: { name: 'Shelf', parentId: 0, guid: SHELF } } });
    return sc as unknown as SceneData;
  };
  const expectUniqueGuids = () => {
    const guids = getAllEntities().map((e) => e.guid).filter(Boolean);
    expect(guids.length).toBe(new Set(guids).size);
  };
  const paths = () => [...treePaths().values()];

  it('a member DELETED inside the expansion stays deleted', async () => {
    await load(withShelf());
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf')]);
    const saved = await serializeScene() as unknown as { entities: Array<Record<string, unknown>> };
    // Recorded as the nested instance's own `removed`, under the row-4 path key.
    expect(JSON.stringify(view(saved).entities.find((e) => e.prefab === OUTER)!.nestedStructure))
      .toContain('"removed"');
    await load(saved as unknown as SceneData);
    expect(paths()).toContain('Holder/OuterRoot/Panel/InnerRoot');
    expect(paths()).not.toContain('Holder/OuterRoot/Panel/InnerRoot/Leaf');
  });

  it('a plain entity dragged INTO the expansion survives, under its exact parent', async () => {
    const sc = withShelf() as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities.push({ id: 4, traits: { EntityAttributes: { name: 'Bolt', parentId: 0, guid: BOLT } } });
    await load(sc as unknown as SceneData);
    reparentEntity(idAt('Bolt'), idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'));
    await load(await serializeScene() as unknown as SceneData);
    expectUniqueGuids();
    expect(paths()).toContain('Holder/OuterRoot/Panel/InnerRoot/Leaf/Bolt');
    expect(paths()).not.toContain('Bolt'); // not left at the scene root
  });

  // #1358 close-out review, F1 — PROVEN before the fix: the writer dropped empty lists and the
  // loader read absent as "not stated" and fell back to the ROW's list, so a scene could never say
  // "the row's own list no longer applies". Deleting the last member of a row-authored `added` wrote
  // `nestedStructure: {"4":{}}` and the member was back after reload (and the save was non-idempotent,
  // alternating between the two shapes forever). Once the scene addresses a path it owns all three
  // lists, empty included.
  // ⚠️ Mutation needs BOTH halves broken together — they are redundant, and I checked rather than
  // assuming: restoring `added: live.added.length ? live.added : undefined` in serialize.ts alone
  // leaves this GREEN (the loader's `?? []` covers the omission), and restoring the per-field
  // `structDirect?.added ?? entry.added` in loadSceneFile.ts alone leaves it green too (an empty
  // array is not nullish, so the fallback never fires). Break both and it reddens.
  it('deleting the last member of a ROW-authored added[] stays deleted, and the save is idempotent', async () => {
    const WIDGET = 'dddddddd-0000-4000-8000-000000000001';
    const outerRowAdded = { id: OUTER, rootLocalId: 1, entities: [
      row(1, 'OuterRoot', 0), row(2, 'Panel', 1), row(3, 'Button', 2),
      { localId: 4, prefab: INNER,
        added: [{ parentLocalId: 1, guid: WIDGET, name: 'Widget', children: [],
          traits: { EntityAttributes: { name: 'Widget', parentId: 0, guid: WIDGET } } }],
        traits: { EntityAttributes: { name: 'Nested', parentId: 2, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
    ] };
    prefabs.set(OUTER, outerRowAdded); setPrefabCache(OUTER, outerRowAdded as never);
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = undefined;
    await load(sc as unknown as SceneData);
    expect(paths()).toContain('Holder/OuterRoot/Panel/InnerRoot/Widget'); // precondition: the row added it
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel/InnerRoot/Widget')]);
    const first = await serializeScene() as unknown as SceneData;
    await load(first);
    expect(paths()).not.toContain('Holder/OuterRoot/Panel/InnerRoot/Widget');
    // Idempotent: saving the reloaded world writes the same slot, not the row's list again.
    const second = await serializeScene() as unknown as SceneData;
    expect(JSON.stringify((second as unknown as { entities: Array<Record<string, unknown>> }).entities.find((e) => e.prefab === OUTER)!.nestedStructure))
      .toBe(JSON.stringify((first as unknown as { entities: Array<Record<string, unknown>> }).entities.find((e) => e.prefab === OUTER)!.nestedStructure));
    await load(second);
    expect(paths()).not.toContain('Holder/OuterRoot/Panel/InnerRoot/Widget');
  });

  // Depth 2 — the structural twin of deepNestedOverrideSerialize.test.ts, which covers only values.
  // The path key here is "4.3": row 4 of OUTER expands MID, whose row 3 expands INNER.
  it('a delete TWO nested levels down round-trips under a dotted path key', async () => {
    const MID = 'aaaaaaaa-0000-4000-8000-0000000000d7';
    const midDoc = { id: MID, rootLocalId: 1, entities: [
      row(1, 'MidRoot', 0), row(2, 'Slot', 1), row(3, 'MidNested', 2, { prefab: INNER }),
    ] };
    const outerMid = { id: OUTER, rootLocalId: 1, entities: [
      row(1, 'OuterRoot', 0), row(2, 'Panel', 1), row(3, 'Button', 2), row(4, 'Nested', 2, { prefab: MID }),
    ] };
    prefabs.set(MID, midDoc); setPrefabCache(MID, midDoc as never);
    prefabs.set(OUTER, outerMid); setPrefabCache(OUTER, outerMid as never);
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = undefined;
    await load(sc as unknown as SceneData);
    const leaf = 'Holder/OuterRoot/Panel/MidRoot/Slot/InnerRoot/Leaf';
    expect(paths()).toContain(leaf); // precondition: both levels expanded
    deleteEntitiesWithUndo([idAt(leaf)]);
    const saved = await serializeScene() as unknown as { entities: Array<Record<string, unknown>> };
    expect(Object.keys(view(saved).entities.find((e) => e.prefab === OUTER)!.nestedStructure as object)).toContain('4.3');
    await load(saved as unknown as SceneData);
    expectUniqueGuids();
    expect(paths()).not.toContain(leaf);
    expect(paths()).toContain('Holder/OuterRoot/Panel/MidRoot/Slot/InnerRoot');
  });

  // The gate's OTHER side. It skips only when the live interior AND the prefab chain's own are both
  // empty; a row that authors structure is therefore always stated by the scene, because once the
  // scene addresses a path it owns all three lists (see the F1 test above — that is what makes an
  // empty list representable). Asserted so the asymmetry is pinned rather than assumed.
  it('the slot IS written for a row that authors structure, even with no scene edit', async () => {
    const WIDGET = 'dddddddd-0000-4000-8000-000000000002';
    const outerRowAdded = { id: OUTER, rootLocalId: 1, entities: [
      row(1, 'OuterRoot', 0), row(2, 'Panel', 1),
      { localId: 4, prefab: INNER,
        added: [{ parentLocalId: 1, guid: WIDGET, name: 'Widget', children: [],
          traits: { EntityAttributes: { name: 'Widget', parentId: 0, guid: WIDGET } } }],
        traits: { EntityAttributes: { name: 'Nested', parentId: 2, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
    ] };
    prefabs.set(OUTER, outerRowAdded); setPrefabCache(OUTER, outerRowAdded as never);
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = undefined;
    await load(sc as unknown as SceneData);
    const saved = await serializeScene() as unknown as { entities: Array<Record<string, unknown>> };
    expect(saved.entities.find((e) => e.prefab === OUTER)!.nestedStructure).toBeDefined();
    // And it round-trips: the row's Widget is still there, exactly once.
    await load(saved as unknown as SceneData);
    expect(paths().filter((x) => x.endsWith('Widget'))).toHaveLength(1);
  });

  it('the slot is NOT written for a row with NO authored structure, so a later prefab edit still lands', async () => {
    await load(withShelf());
    const saved = await serializeScene() as unknown as { entities: Array<Record<string, unknown>> };
    expect(saved.entities.find((e) => e.prefab === OUTER)!.nestedStructure).toBeUndefined();
    // A member added to the INNER prefab afterwards reaches this untouched instance.
    const grown = { id: INNER, rootLocalId: 1, entities: [row(1, 'InnerRoot', 0), row(2, 'Leaf', 1), row(3, 'Spur', 1)] };
    prefabs.set(INNER, grown); setPrefabCache(INNER, grown as never);
    await load(saved as unknown as SceneData);
    expect(paths()).toContain('Holder/OuterRoot/Panel/InnerRoot/Spur');
  });
});

// #1369: `nestedOverrides`/`nestedStructure` were captured only for instances owned by a TOP-LEVEL
// instance — `serializeScene`'s walk resolved each owned nested instance up to a top-level root and
// skipped anything whose chain passed through a USER-ADDED nested instance (a reference node in
// `added[]`), and `captureNestedRef` wrote neither channel for the node. So an edit inside the
// row expansion of a prefab the user had DRAGGED under a member came back on reload, value and
// structure alike. Both channels now come from one top-down walk, `captureNestedChannels`, for a
// top-level instance and a reference node alike.
//
// Mutation for the block: in `captureNestedRef`, drop the `captureNestedChannels` call (write the
// node without `nestedOverrides`/`nestedStructure`).
describe('edits inside a USER-ADDED nested instance\'s own nested rows round-trip (#1369)', () => {
  const MID = 'aaaaaaaa-0000-4000-8000-0000000000d8';
  const MID_GUID = 'bbbbbbbb-0000-4000-8000-0000000000f1';
  const LEAF = 'Holder/OuterRoot/Panel/Button/MidRoot/Slot/InnerRoot/Leaf';
  /** OUTER, with a MID dragged under Button; MID's own row 3 expands INNER. */
  const withAddedMid = (): SceneData => {
    const midDoc = { id: MID, rootLocalId: 1, entities: [
      row(1, 'MidRoot', 0), row(2, 'Slot', 1), row(3, 'MidNested', 2, { prefab: INNER }),
    ] };
    prefabs.set(MID, midDoc); setPrefabCache(MID, midDoc as never);
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = [{ parentLocalId: 3, guid: MID_GUID, name: 'MidRoot', prefab: MID, traits: {}, children: [] }];
    return sc as unknown as SceneData;
  };
  const paths = () => [...treePaths().values()];
  type Saved = { entities: Array<Record<string, unknown>> };
  const midNode = (saved: Saved) =>
    ((view(saved).entities.find((e) => e.prefab === OUTER)!.added as Array<Record<string, unknown>>)
      .find((n) => n.prefab === MID))!;

  it('a member DELETED inside the added instance\'s row expansion stays deleted', async () => {
    await load(withAddedMid());
    expect(paths()).toContain(LEAF); // precondition: the added MID expanded its own INNER row
    deleteEntitiesWithUndo([idAt(LEAF)]);
    const saved = await serializeScene() as unknown as Saved;
    expect(Object.keys(midNode(saved).nestedStructure as object)).toEqual(['3']);
    await load(saved as unknown as SceneData);
    expect(paths()).not.toContain(LEAF);
    expect(paths()).toContain('Holder/OuterRoot/Panel/Button/MidRoot/Slot/InnerRoot');
  });

  it('a VALUE edit there survives the round trip', async () => {
    await load(withAddedMid());
    rename(idAt(LEAF), 'Renamed');
    const saved = await serializeScene() as unknown as Saved;
    expect(Object.keys(midNode(saved).nestedOverrides as object)).toEqual(['3']);
    await load(saved as unknown as SceneData);
    expect(paths()).toContain('Holder/OuterRoot/Panel/Button/MidRoot/Slot/InnerRoot/Renamed');
    expect(paths()).not.toContain(LEAF);
  });

  // The editor half. A rebuild (Apply, Revert, a prefab file changing) re-spawns the added
  // MID from the captured reference node through `spawnReferenceNode` (the loader's own spawner since #1783), which must
  // carry the node's nested channels. Mutation: in `spawnReferenceNode`, call `instantiatePrefabIntoWorld` without the
  // two channels.
  it('a rebuild of the outer instance keeps the deletion inside the added instance', async () => {
    await load(withAddedMid());
    deleteEntitiesWithUndo([idAt(LEAF)]);
    const root = idAt('Holder/OuterRoot');
    rebuild(root, OUTER, outerDoc as never);
    expect(paths()).toContain('Holder/OuterRoot/Panel/Button/MidRoot/Slot/InnerRoot');
    expect(paths()).not.toContain(LEAF);
  });

  // Found while designing the above, pre-existing: the old rebuild's live re-apply visited a USER-ADDED instance too
  // and re-applied its structure on top of the reference spawn that had already applied it, so every subtree it had
  // added was spawned twice. That re-apply is gone (#1880 F7d): a rebuild loads the entry, which states the added
  // instance once, as the save does.
  it('a rebuild does not duplicate a subtree the added instance itself added', async () => {
    const BOLT = 'bbbbbbbb-0000-4000-8000-0000000000f9';
    const sc = scene([]) as unknown as { entities: Array<Record<string, any>> };
    sc.entities[1]!.added[0].added = [{ parentLocalId: 1, guid: BOLT, name: 'Bolt', children: [],
      traits: { EntityAttributes: { name: 'Bolt', parentId: 0, guid: BOLT } } }];
    await load(sc as unknown as SceneData);
    expect(getAllEntities().filter((e) => e.name === 'Bolt')).toHaveLength(1); // precondition
    const root = idAt('Holder/OuterRoot');
    rebuild(root, OUTER, outerDoc as never);
    expect(getAllEntities().filter((e) => e.name === 'Bolt')).toHaveLength(1);
  });

  it('an untouched added instance writes neither channel, and a re-save is idempotent', async () => {
    await load(withAddedMid());
    const first = await serializeScene() as unknown as Saved;
    expect(midNode(first).nestedOverrides).toBeUndefined();
    expect(midNode(first).nestedStructure).toBeUndefined();
    deleteEntitiesWithUndo([idAt(LEAF)]);
    rename(idAt('Holder/OuterRoot/Panel/Button/MidRoot/Slot/InnerRoot'), 'InnerRenamed');
    const edited = await serializeScene() as unknown as Saved;
    await load(edited as unknown as SceneData);
    const again = await serializeScene() as unknown as Saved;
    expect(JSON.stringify(midNode(again))).toBe(JSON.stringify(midNode(edited)));
  });
});

// #1437 P2a: the save records a member's new parent inside its own instance (`moved`: row localId → the
// new parent's guid), and the loader applies it after every guid is derived, so nothing's identity moves.
describe('a member moved inside its own instance is saved there (#1437)', () => {

  // Mutation: in moveMemberHome, drop the missing-target return, or the cycle walk.
  it('a stale move (its parent is gone) or a cyclic one leaves the member at its row, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const withMoved = (moved: Record<number, string>) => {
        const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
        for (const [lid, parent] of Object.entries(moved)) authorRow(sc.entities[1]!, outerDoc, Number(lid), { parent });
        return sc as unknown as SceneData;
      };
      await load(withMoved({ 3: 'cccccccc-0000-4000-8000-000000000404' }));
      expect(idAt('Holder/OuterRoot/Panel/Button')).toBeTruthy();
      await load(scene([]));
      const button = guidAt('Holder/OuterRoot/Panel/Button');
      await load(withMoved({ 2: button }));
      expect(idAt('Holder/OuterRoot/Panel/Button')).toBeTruthy();
      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('moved member'))).toHaveLength(2);
    } finally { warn.mockRestore(); }
  });
});

// #1437 P1–P2b review. Each case was reproduced failing before its fix.
describe('moved members: review findings (#1437)', () => {
  const paths = () => [...treePaths().values()].sort();

  // Mutation: drop the failed-move lift in drainAfterDerive.
  it('a move that fails under a removed row keeps the member: lifted to the nearest row that stays', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
      authorRow(sc.entities[1]!, outerDoc, 3, { parent: 'cccccccc-0000-4000-8000-000000000404' });
      sc.entities[1]!.removed = [2];
      await load(sc as unknown as SceneData);
      expect(paths()).toContain('Holder/OuterRoot/Button');
    } finally { warn.mockRestore(); }
  });
});

// #1437 P3-a: Apply of a move whose new parent is a row of the SAME frame re-parents the row. That changes
// the path the moved member (and everything below it) derives its guid from, in EVERY instance, so every ref
// to one follows: live refs across the refresh, the template's own member tokens, and — through the backend
// route, checked here by its request — every other file.
describe('Apply over a move from before #1869, and what the Apply dialog says (#1437, #1868)', () => {
  const ROOT2 = 'bbbbbbbb-0000-4000-8000-0000000000c9';
  const HOLDER2 = 'bbbbbbbb-0000-4000-8000-0000000000ca';
  const ea = (name: string, parentId: unknown, guid?: string) => ({ EntityAttributes: { name, parentId, ...(guid ? { guid } : {}) } });
  /** Holder → OUTER instance A (ROOT); Holder2 → OUTER instance B (ROOT2); refs on Holder. */
  const twoInstances = (refs: string[]): SceneData => ({
    id: 'p3', version: 15, name: 'P3', resources: [],
    entities: [
      { id: 1, traits: withUi(ea('Holder', 0, HOLDER), refs) },
      { id: 2, traits: ea('Holder2', 0, HOLDER2) },
      { id: 3, prefab: OUTER, guid: ROOT, traits: { ...ea('OuterRoot', HOLDER), Transform: { x: 0, y: 0, z: 0 } } },
      { id: 4, prefab: OUTER, guid: ROOT2, traits: { ...ea('OuterRoot', HOLDER2), Transform: { x: 0, y: 0, z: 0 } } },
    ],
  } as unknown as SceneData);
  /** Save, then reload with `doc` as the prefab on disk — what the next session sees. */
  const reloadWith = async (source: string, doc: PrefabFile): Promise<void> => {
    const saved = await serializeScene() as unknown as SceneData;
    prefabs.set(source, doc);
    setPrefabCache(source, doc);
    await load(saved);
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  // Review F6: what the Apply dialog tells the person. Mutation: drop the skipped branch of applyOutcomeNotice. (The
  // unrepaired-files branch went with the member-path repair, #1868: no Apply re-paths a member any more.)
  it('the dialog\'s notice names skipped moves, and is silent when nothing was left', () => {
    expect(applyOutcomeNotice({})).toBeNull();
    expect(applyOutcomeNotice({ skipped: [{ key: '~moved.3', reason: 'its new parent was added in this scene' }] }))
      .toBe('Apply to Prefab: 1 move was not applied: its new parent was added in this scene.');
  });

  // #1468 close-out review F4: a REFUSAL is not a partial outcome. `skipped` means "everything else
  // landed, these keys did not", and this function words it as a MOVE because a move is the only
  // thing that has ever populated it — so a refusal riding that channel told the human "1 move was
  // not applied: prefab format 6 is newer than 5", which is wrong about the count, the noun and the
  // outcome. Mutation: delete the `result.refused` early return and this goes red.
  it('a refusal says it was refused, and never calls itself a move', () => {
    const notice = applyOutcomeNotice({ refused: '"x.prefab.json" was written by a newer build (prefab format 6; this build writes 5)' })!;
    expect(notice).toBe('Apply to Prefab refused: "x.prefab.json" was written by a newer build (prefab format 6; this build writes 5).');
    expect(notice).not.toContain('move');
    // …and it wins over anything else the result happens to carry, because nothing else happened.
    expect(applyOutcomeNotice({ refused: 'r', skipped: [{ key: 'k', reason: 'why' }] }))
      .toBe('Apply to Prefab refused: r.');
  });

  // #1732 close-out review: a multi-file refusal can leave a file written that its rollback could not put back, and the
  // notice framed EVERY refusal as "nothing was applied" — contradicting the reason it carried. Mutation: put the
  // "nothing was applied — " frame back.
  it('a refusal that stranded a file is not framed as "nothing was applied", and ends in one period', () => {
    const notice = applyOutcomeNotice({ refused: 'the prefab O file could not be written (the disk is full), so the Apply did not land. P was written and could not be put back, so it holds the Apply on disk.' })!;
    expect(notice).not.toMatch(/nothing was applied/);
    expect(notice).toBe('Apply to Prefab refused: the prefab O file could not be written (the disk is full), so the Apply did not land. P was written and could not be put back, so it holds the Apply on disk.');
  });

  // #1482: a rebuild of the OUTER instance (Refresh / Apply / Revert) respawns a user-added reference node
  // inside it, and must put back the member guids that node's rows store — the loader pins them, and a
  // rebuild that let them re-derive left anything naming them by guid dangling: here, an outer member's
  // row `parent`. (The old rebuild's own restore is gone, #1880 F7d: a rebuild is the load, whose settle pins them.)
  describe('a rebuild keeps a reference node`s stored member guids (#1482)', () => {
    const REFP = 'aaaaaaaa-0000-4000-8000-0000000001b2';
    const KID = 'eeeeeeee-0000-4000-8000-000000000001';
    const refDoc = { id: REFP, rootLocalId: 1, entities: [row(1, 'RRoot', 0), row(2, 'Kid', 1), row(3, 'Kid2', 1)] };
    const refNode = (extra: Record<string, unknown> = {}) => ({
      guid: ANCHORED, name: 'RRoot', prefab: REFP, traits: {}, children: [],
      members: { [`/${refDoc.entities[1]!.nodeGuid}`]: { guid: KID, name: 'Kid' } }, ...extra,
    });
    const refresh = (path: string) => {
      const id = idAt(path);
      return rebuild(id, OUTER, outerDoc as never);
    };
    beforeEach(() => { prefabs.set(REFP, refDoc); setPrefabCache(REFP, refDoc as never); });
    afterEach(() => { prefabs.delete(REFP); setPrefabCache(REFP, null); });

    it('on a reference node inside an owned nested row`s expansion: the guid stands', async () => {
      const sc = JSON.parse(JSON.stringify(scene([]))) as { entities: Array<Record<string, unknown>> };
      sc.entities[1]!.added = [];
      sc.entities[1]!.nestedStructure = { 4: { added: [refNode({ parentLocalId: 1 })] } };
      await load(sc as unknown as SceneData);
      expect(guidAt('Holder/OuterRoot/Panel/InnerRoot/RRoot/Kid')).toBe(KID);   // precondition
      refresh('Holder/OuterRoot');
      expect(guidAt('Holder/OuterRoot/Panel/InnerRoot/RRoot/Kid')).toBe(KID);
    });

    // The production seam (close-out review): Apply to Prefab rebuilds every instance of the source, and
    // that rebuild is where the reference node's rows must be carried — not only a direct rebuild.
    it('Apply to Prefab on the outer instance keeps the reference node`s pinned guid, through a reload', async () => {
      const sc = JSON.parse(JSON.stringify(scene([]))) as { entities: Array<Record<string, unknown>> };
      (sc.entities[1]!.added as Array<Record<string, unknown>>)[0] = refNode({ parentLocalId: 3 });
      await load(sc as unknown as SceneData);
      writeTraitFieldWithUndo(idAt('Holder/OuterRoot/Panel'), getTraitByName('Transform')!, 'x', 5);
      const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set([`${outerDoc.entities[1]!.nodeGuid}.Transform.x`]));
      expect(result.applied).toBe(true);
      expect(guidAt('Holder/OuterRoot/Panel/Button/RRoot/Kid')).toBe(KID);
      await reloadWith(OUTER, result.prefabAfter!);
      expect(guidAt('Holder/OuterRoot/Panel/Button/RRoot/Kid')).toBe(KID);
    });

    // A reference node inside a reference node: the collector recurses through the node's own `added`,
    // so the inner node's rows are pinned too (close-out review probe P-A).
    it('a reference node INSIDE the reference node keeps its pinned guid as well', async () => {
      const REFQ = 'aaaaaaaa-0000-4000-8000-0000000001b5';
      const QKID = 'eeeeeeee-0000-4000-8000-000000000002';
      const qDoc = { id: REFQ, rootLocalId: 1, entities: [row(1, 'QRoot', 0), row(2, 'QKid', 1)] };
      prefabs.set(REFQ, qDoc); setPrefabCache(REFQ, qDoc as never);
      try {
        const inner = { parentLocalId: 2, guid: 'bbbbbbbb-0000-4000-8000-0000000000c9', name: 'QRoot', prefab: REFQ, traits: {}, children: [],
          members: { [`/${qDoc.entities[1]!.nodeGuid}`]: { guid: QKID, name: 'QKid' } } };
        const sc = JSON.parse(JSON.stringify(scene([]))) as { entities: Array<Record<string, unknown>> };
        (sc.entities[1]!.added as Array<Record<string, unknown>>)[0] = refNode({ parentLocalId: 3, added: [inner] });
        await load(sc as unknown as SceneData);
        expect(guidAt('Holder/OuterRoot/Panel/Button/RRoot/Kid/QRoot/QKid')).toBe(QKID);   // precondition
        refresh('Holder/OuterRoot');
        expect(guidAt('Holder/OuterRoot/Panel/Button/RRoot/Kid/QRoot/QKid')).toBe(QKID);
        expect(guidAt('Holder/OuterRoot/Panel/Button/RRoot/Kid')).toBe(KID);
      } finally { prefabs.delete(REFQ); setPrefabCache(REFQ, null); }
    });
  });

  // Review F1/F8, the prefab's own move (a file from before #1869): removing the row above the moved member would re-hang
  // it and re-path it everywhere, so that removal is SKIPPED, naming Revert (#1868, hub ruling B); removing the move's
  // TARGET drops the entry, which names nothing now. Mutations: drop the removal's skip (the row is removed with its moved
  // member left hanging from nothing) — the first half goes red; drop the stale-entry filter — the second.
  it('removing rows around a prefab\'s own move: a removal above the moved row is skipped, and a move to nothing is dropped', async () => {
    const OUTER_M = 'aaaaaaaa-0000-4000-8000-0000000000dc';
    const doc = { ...outerDoc, id: OUTER_M, moved: { '2.3': '@member:4.2' },
      entities: outerDoc.entities.map((r) => (r.localId === 4 ? row(4, 'Nested', 1, { prefab: INNER }) : r)) };
    prefabs.set(OUTER_M, doc);
    setPrefabCache(OUTER_M, doc as never);
    try {
      const sc = twoInstances([]);
      for (const e of sc.entities as { prefab?: string }[]) if (e.prefab) e.prefab = OUTER_M;
      await load(sc);
      const a = idAt('Holder/OuterRoot');
      expect(idAt('Holder/OuterRoot/InnerRoot/Leaf/Button')).toBeGreaterThan(0);
      deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel')]);
      const lifted = await applyToPrefabSelective(a, new Set(['-removed.2']));
      expect(lifted.applied).toBe(false);
      expect(lifted.skipped).toEqual([{ key: '-removed.2', reason: expect.stringMatching(/Revert that move first/) }]);
      expect(idAt('Holder2/OuterRoot/InnerRoot/Leaf/Button')).toBeGreaterThan(0); // the other instance is untouched
      deleteEntitiesWithUndo([idAt('Holder/OuterRoot/InnerRoot')]);
      const gone = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['-removed.4']));
      expect(gone.prefabAfter!.moved).toBeUndefined();
      expect(idAt('Holder2/OuterRoot/Panel/Button')).toBeGreaterThan(0);
    } finally { prefabs.delete(OUTER_M); setPrefabCache(OUTER_M, null); }
  });
});

// #1437 P3-c: Create Prefab from a tree holding moved members writes the moves into the NEW prefab's own
// `moved` (member path → member token, both in its frame). Each case loads the written file back through the
// real loader and checks where the member lands.
describe('a prefab written from a tree with moved members keeps the moves (#1437 P3-c)', () => {
  const GROUP = 'bbbbbbbb-0000-4000-8000-0000000000d1';
  const X_ROOT = 'bbbbbbbb-0000-4000-8000-0000000000d2';
  /** Group (plain) → an OUTER instance. */
  const grouped = (outer = OUTER): SceneData => ({
    id: 'p3c', version: 15, name: 'P3c', resources: [],
    entities: [
      { id: 1, traits: { EntityAttributes: { name: 'Group', parentId: 0, guid: GROUP }, Transform: { x: 0, y: 0, z: 0 } } },
      { id: 2, prefab: outer, guid: ROOT, traits: { EntityAttributes: { name: 'OuterRoot', parentId: GROUP }, Transform: { x: 0, y: 0, z: 0 } } },
    ],
  } as unknown as SceneData);

  // Review F3: flattening an instance whose ROW its prefab placed under a nested member. The row keeps its row
  // parent and the move goes into `moved`. Mutation: make rowParentsFor always answer the live parent (the row
  // is written orphaned, and the instance loads it outside itself).
  it('an instance flattened with a row under a nested member: the row keeps its parent, the move is kept', async () => {
    const OUTER_M = 'aaaaaaaa-0000-4000-8000-0000000000da';
    const outerMoved = { ...outerDoc, id: OUTER_M, moved: { '2.3': '@member:2.4.2' } };
    prefabs.set(OUTER_M, outerMoved);
    setPrefabCache(OUTER_M, outerMoved as never);
    try {
      await load(grouped(OUTER_M));
      const file = serializePrefab(idAt('Group/OuterRoot'))!;
      const local = (name: string) => file.entities.find((e) => e.name === name)!.localId;
      expect((file.entities.find((e) => e.name === 'Button')!.traits.EntityAttributes as { parentId: number }).parentId).toBe(local('Panel'));
      expect(file.moved).toEqual({ [`${local('Panel')}.${local('Button')}`]: `@member:${local('Panel')}.${local('InnerRoot')}.2` });
      prefabs.set(file.id!, file);
      setPrefabCache(file.id!, file);
      await load({ id: 'x', version: 15, name: 'X', resources: [], entities: [
        { id: 1, prefab: file.id, guid: X_ROOT, traits: { EntityAttributes: { name: 'OuterRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      ] } as unknown as SceneData);
      expect(idAt('OuterRoot/Panel/InnerRoot/Leaf/Button')).toBeGreaterThan(0);
    } finally { prefabs.delete(OUTER_M); setPrefabCache(OUTER_M, null); }
  });

  // Review F2: prefab-edit shows the prefab's own moves, and its save keeps them with the rows where they were.
  // Mutations: drop applyEditWorldMoves (Button shows at Panel, and the save writes no move); drop the
  // rowParents hint (the row is written under the nested row instead of Panel); drop the editRow skip in
  // captureInstanceStructure (the nested row swallows Button as its own added node); drop the nested row's
  // sentinel entry guid (the edit world cannot find Leaf by the guid editGuidAt gives it).
  it('prefab-edit shows the prefab\'s own moves, and a re-save keeps them', async () => {
    const OUTER_M = 'aaaaaaaa-0000-4000-8000-0000000000db';
    const outerMoved = { ...outerDoc, id: OUTER_M, moved: { '2.3': '@member:2.4.2' } } as unknown as PrefabFile;
    try {
      await load(buildPrefabEditScene(outerMoved));
      applyEditWorldMoves(outerMoved);
      expect(idAt('OuterRoot/Panel/InnerRoot/Leaf/Button')).toBeGreaterThan(0);
      // As the real save does: each row's localId from the sentinel guid the edit world stamped on it.
      const preserve = new Map(getAllEntities().filter((e) => e.guid?.startsWith('__prefab_edit_local__'))
        .map((e) => [e.id, Number(e.guid!.slice('__prefab_edit_local__'.length))] as [number, number]));
      preserve.set(idAt('OuterRoot'), outerMoved.rootLocalId);
      const rowParents = new Map(outerMoved.entities.map((e) => [e.localId, (e.traits.EntityAttributes as { parentId: number }).parentId]));
      const file = serializePrefab(idAt('OuterRoot'), OUTER_M, { preserveLocalIds: preserve, rowParents })!;
      expect((file.entities.find((e) => e.localId === 3)!.traits.EntityAttributes as { parentId: number }).parentId).toBe(2);
      expect(file.moved).toEqual({ '2.3': '@member:2.4.2' });
    } finally { prefabs.delete(OUTER_M); setPrefabCache(OUTER_M, null); }
  });

  // #1468 Phase 6: the prefab's own move of an OWNED nested root, shown in the edit world, must keep the root in the
  // frame whose row expanded it. MID's row 3 is an INNER instance; TOP nests MID at row 4 and moves that inner root
  // under its own Panel — a plain row in the edit world, so its live parent names no frame at all. Only the owner
  // link written at the move says the root is still MID's row 3, which is what lets the re-save find the move.
  // Mutation: drop `linkOwnerBeforeMove` from applyEditWorldMoves (the root reads as unmoved, and the move is lost).
  it("prefab-edit: the prefab's own move of an owned nested root keeps its frame, and a re-save keeps the move", async () => {
    const MID_E = 'aaaaaaaa-0000-4000-8000-0000000000e1';
    const TOP_E = 'aaaaaaaa-0000-4000-8000-0000000000e2';
    const midDoc = { id: MID_E, rootLocalId: 1, entities: [row(1, 'MidRoot', 0), row(3, 'InnerSeed', 1, { prefab: INNER })] };
    const topDoc = { id: TOP_E, rootLocalId: 1, entities: [row(1, 'TopRoot', 0), row(2, 'Panel', 1), row(4, 'MidSeed', 1, { prefab: MID_E })],
      moved: { '4.3': '@member:2' } } as unknown as PrefabFile;
    prefabs.set(MID_E, midDoc); setPrefabCache(MID_E, midDoc as never);
    try {
      await load(buildPrefabEditScene(topDoc));
      applyEditWorldMoves(topDoc);
      expect(idAt('TopRoot/Panel/InnerRoot')).toBeGreaterThan(0);
      const preserve = new Map(getAllEntities().filter((e) => e.guid?.startsWith('__prefab_edit_local__'))
        .map((e) => [e.id, Number(e.guid!.slice('__prefab_edit_local__'.length))] as [number, number]));
      preserve.set(idAt('TopRoot'), topDoc.rootLocalId);
      const rowParents = new Map(topDoc.entities.map((e) => [e.localId, (e.traits.EntityAttributes as { parentId: number }).parentId]));
      const file = serializePrefab(idAt('TopRoot'), TOP_E, { preserveLocalIds: preserve, rowParents })!;
      expect(file.moved).toEqual({ '4.3': '@member:2' });
    } finally { prefabs.delete(MID_E); setPrefabCache(MID_E, null); }
  });

  // The same recovery through a member whose home was deleted: it steps through the gone row (`extra`).
  // Mutation: drop `...(node.extra ?? [])` in templateKeyRecovery.
  it('key recovery steps through a deleted home (homeSteps)', () => {
    const G = 'bbbbbbbb-0000-4000-8000-0000000000de';
    const K = 'cccccccc-0000-4000-8000-0000000000de';
    // Node 1 is the instance ROOT the key derives from, so it carries a `PrefabInstance`: recovery anchors only at an
    // instance (#1874 — a plain ancestor with a guid is an unpacked one).
    const nodes = new Map<number, KeyRecoveryNode>([
      [1, { guid: G, parentId: 0, key: '', pi: { localId: 1 } }],
      [2, { guid: deriveMemberGuid(G, [4, 2]), parentId: 1, key: '', pi: { localId: 2 }, extra: [4] }],
      [3, { guid: deriveMemberGuid(G, [4, 2, `+${K}`]), parentId: 2, key: '', pi: null }],
    ]);
    expect(recoverTemplateKeyFrom(3, (id) => nodes.get(id), new Set([K]))).toBe(K);
  });

  it('nothing moved: no `moved` is written', async () => {
    await load(grouped());
    expect(serializePrefab(idAt('Group'))!.moved).toBeUndefined();
  });
});

// #1437, third review: what an OUTER prefab's move of a nested member must survive, and the two-level shapes.
describe('outer prefab moves of nested members, third review (#1437)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, rewritten: [], held: [] }) }) as unknown as Response));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  // F4. Mutations: drop the own-subtree hint check (a parent cycle is written); drop the nested-row skip in the
  // fallback (B is hung under the nested row).
  it('prefab-edit: a row dragged under the row its prefab moved is written without a cycle', async () => {
    const P4 = 'aaaaaaaa-0000-4000-8000-0000000000e3';
    const doc = { id: P4, version: 4, name: 'P4', rootLocalId: 1, moved: { '2.5': '@member:4.2' }, entities: [
      row(1, 'Root', 0), row(2, 'A', 1), row(5, 'B', 2), row(4, 'Nested', 1, { prefab: INNER }),
    ] } as unknown as PrefabFile;
    await load(buildPrefabEditScene(doc));
    applyEditWorldMoves(doc);
    reparentEntity(idAt('Root/A'), idAt('Root/InnerRoot/Leaf/B'));
    const preserve = new Map(getAllEntities().filter((e) => e.guid?.startsWith('__prefab_edit_local__'))
      .map((e) => [e.id, Number(e.guid!.slice('__prefab_edit_local__'.length))] as [number, number]));
    preserve.set(idAt('Root'), 1);
    const file = serializePrefab(idAt('Root'), P4, { preserveLocalIds: preserve, rowParents: new Map([[2, 1], [5, 2], [4, 1]]) })!;
    const parent = (lid: number) => (file.entities.find((e) => e.localId === lid)!.traits.EntityAttributes as { parentId: number }).parentId;
    expect([parent(2), parent(5)]).toEqual([5, 1]);
    expect(file.moved).toEqual({ 5: '@member:4.2' });
  });
});

describe('leaving the outermost instance cuts only the links the move splits (#1445, #1447)', () => {
  const SHELF = 'bbbbbbbb-0000-4000-8000-0000000000e1';
  const withShelf = (holderRefs: string[] = []): SceneData => {
    const sc = scene(holderRefs) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = undefined;
    sc.entities.push({ id: 3, traits: { EntityAttributes: { name: 'Shelf', parentId: 0, guid: SHELF } } });
    return sc as unknown as SceneData;
  };

  // Finding 5: several promotions in one multi-delete are reversed one at a time, last first — a guid two of them
  // renamed in turn (a → b → c) walks all the way back. Mutation: one merged inverse map (stops at b).
  it('relinkDetachedMembers reverses chained renames all the way back', async () => {
    await load(withShelf());
    const shelf = idAt('Shelf');
    const [A, B, C] = ['cccccccc-0000-4000-8000-0000000000a1', 'cccccccc-0000-4000-8000-0000000000a2', 'cccccccc-0000-4000-8000-0000000000a3'];
    const ea = getTraitByName('EntityAttributes')!;
    const e = [...getCurrentWorld().entities].find((x) => x.id() === shelf)!;
    e.set(ea.trait, { ...(e.get(ea.trait) as object), guid: C });
    relinkDetachedMembers([
      { guid: 'dddddddd-0000-4000-8000-000000000001', rootGuid: '', data: {}, renamed: [[A, B]] },
      { guid: 'dddddddd-0000-4000-8000-000000000002', rootGuid: '', data: {}, renamed: [[B, C]] },
    ]);
    expect(guidAt('Shelf')).toBe(A);
  });
});

describe('Apply will not write a prefab that contains itself (#1446)', () => {
  // A scene may hold an instance inside an instance of the same prefab — it expands fine there, and #1436 lets a
  // drop do it. Only the FILE cannot: Apply used to promote one into a row naming the prefab itself, which the
  // expansion refuses, so the refreshed instance came back empty and the user's instance was gone.
  // Mutation: drop the addedNestsPrefab skip in applyToPrefabSelective (OUTER gains a row naming OUTER).
  // Close-out review 4: the guard walked trait data, so a spawner naming its own prefab was refused as a cycle.
  // Mutation: walk every `prefab` key in the node again, traits included.
  it('Apply promotes a plain node whose TRAIT names the prefab — trait data is not nesting', async () => {
    registerTrait({ name: 'ProbeSpawner', trait: kootaTrait({ prefab: '' }), category: 'component', fields: { prefab: { type: 'string' } } });
    const SPAWNER = 'bbbbbbbb-0000-4000-8000-0000000000e6';
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = [{ parentLocalId: 3, guid: SPAWNER, name: 'Spawner', traits: { EntityAttributes: { name: 'Spawner' }, ProbeSpawner: { prefab: OUTER } }, children: [] }];
    await load(sc as unknown as SceneData);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, rewritten: [], held: [] }) }) as unknown as Response));
    try {
      const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set([`+added.${SPAWNER}`]));
      expect(result.skipped ?? []).toEqual([]);
      expect(result.applied).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  // Close-out review 2, finding 4: the prefab can also sit one level down — here in an INNER reference node's own
  // `added`, captured from the live tree as production does. Mutation: drop the `added` walk in expandedPrefabRefs.
  it('Apply refuses a self-nesting instance held inside an added reference node\'s own additions', async () => {
    const DEEP = 'bbbbbbbb-0000-4000-8000-0000000000e9';
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = [{ parentLocalId: 3, guid: ANCHORED, name: 'AddedInner', prefab: INNER, traits: {}, children: [],
      added: [{ parentLocalId: 2, guid: DEEP, name: 'Self', prefab: OUTER, traits: {}, children: [] }] }];
    await load(sc as unknown as SceneData);
    expect(treePaths().get(DEEP)).toBe('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf/OuterRoot'); // precondition
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, rewritten: [], held: [] }) }) as unknown as Response));
    try {
      const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set([`+added.${ANCHORED}`]));
      expect(result.skipped?.map((x) => x.key)).toEqual([`+added.${ANCHORED}`]);
    } finally { vi.unstubAllGlobals(); }
  });

  // …and the unverified one: a nested FILE that reaches the target only through a row's added reference node, or
  // a row's nestedStructure slot, was invisible to wouldCreateCycle. Mutations: drop the `added` walk, or the
  // `nestedStructure` walk, in expandedPrefabRefs.
  it.each([
    ['a row\'s added reference node', { added: [{ parentLocalId: 1, guid: '', name: 'Self', prefab: OUTER, traits: {}, children: [] }] }],
    ['a row\'s nestedStructure slot', { nestedStructure: { '2': { added: [{ parentLocalId: 1, guid: '', name: 'Self', prefab: OUTER, traits: {}, children: [] }] } } }],
  ])('wouldCreateCycle sees the target through %s of a nested file', (_label, slot) => {
    const HOST = 'aaaaaaaa-0000-4000-8000-0000000000ea';
    setPrefabCache(HOST, { id: HOST, rootLocalId: 1, entities: [row(1, 'HostRoot', 0), row(2, 'Nested', 1, { prefab: INNER, ...slot })] } as never);
    try {
      expect(wouldCreateCycle(OUTER, HOST)).toBe(true);
    } finally { setPrefabCache(HOST, null); }
  });

  it('Apply will not promote an added node holding an instance of the prefab itself', async () => {
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = [{ parentLocalId: 3, guid: ANCHORED, name: 'Self', prefab: OUTER, traits: {}, children: [] }];
    await load(sc as unknown as SceneData);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, rewritten: [], held: [] }) }) as unknown as Response));
    try {
      const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set([`+added.${ANCHORED}`]));
      expect(result.applied).toBe(false);
      expect(result.skipped).toEqual([{ key: `+added.${ANCHORED}`, reason: 'it holds an instance of this prefab, and a prefab cannot contain itself' }]);
      expect((getCachedPrefabSync(OUTER) as PrefabFile).entities.some((e) => (e as { prefab?: string }).prefab === OUTER)).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});

// #1468 Phase 6 close-out review: a nested row under a nested row (O: QRow(2, Q) > ZRow(3, Z)), the shape the
// editor's prefab-edit save writes when a nested root is dragged under another. Z's root hangs under Q's ROOT,
// and reading that root's `rootInstanceId` as Z's owner put it in Q's frame, where row 3 is QB — ZRoot then
// derived QB's guid and the save wrote a move nobody made. Mutation: have the owner fallback return the first
// candidate (the live parent's own frame) without asking the document.
describe('a nested row under a nested row (#1468 Phase 6 close-out)', () => {
  const O6 = 'aaaaaaaa-0000-4000-8000-0000000006a1';
  const Q6 = 'aaaaaaaa-0000-4000-8000-0000000006a2';
  const Z6 = 'aaaaaaaa-0000-4000-8000-0000000006a3';
  const docs = {
    [Q6]: { id: Q6, rootLocalId: 1, entities: [row(1, 'QRoot', 0), row(2, 'QA', 1), row(3, 'QB', 2)] },
    [Z6]: { id: Z6, rootLocalId: 1, entities: [row(1, 'ZRoot', 0), row(2, 'ZLeaf', 1)] },
    [O6]: { id: O6, rootLocalId: 1, entities: [row(1, 'ORoot', 0), row(2, 'QRow', 1, { prefab: Q6 }), row(3, 'ZRow', 2, { prefab: Z6 })] },
  };
  it('every member keeps a guid of its own, nothing reads as moved, and the save writes no move', async () => {
    for (const [k, d] of Object.entries(docs)) { prefabs.set(k, d); setPrefabCache(k, d as never); }
    try {
      await load({ id: 'n6', version: 16, name: 'N6', resources: [], entities: [
        { id: 1, prefab: O6, guid: ROOT, traits: { EntityAttributes: { name: 'ORoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      ] } as unknown as SceneData);
      const guids = getAllEntities().map((e) => e.guid).filter((g): g is string => !!g);
      expect(new Set(guids).size).toBe(guids.length);
      expect(guidAt('ORoot/QRoot/ZRoot')).not.toBe(guidAt('ORoot/QRoot/QA/QB'));
      expect(homeView(idAt('ORoot/QRoot/ZRoot'))).toEqual({ homeParent: '', homeSteps: '' });
      const saved = await serializeScene() as unknown as { entities: Array<{ members?: Record<string, { parent?: string }> }> };
      const parents = saved.entities.flatMap((e) => Object.values(e.members ?? {}).map((m) => m.parent).filter(Boolean));
      expect(parents).toEqual([]);
      // And the round trip holds the same tree: nothing written twice (an `added` beside the row, which Q's
      // capture wrote before the close-out), nothing lost — and an edit inside Z's frame is addressed through O's
      // row, not through Q's (chainOf climbed to Q before).
      writeTraitFieldWithUndo(idAt('ORoot/QRoot/ZRoot/ZLeaf'), getTraitByName('Transform')!, 'x', 7);
      const zx = () => ([...getCurrentWorld().entities].find((e) => e.id() === idAt('ORoot/QRoot/ZRoot/ZLeaf'))!
        .get(getTraitByName('Transform')!.trait) as { x: number }).x;
      // A rebuild of O carries the edit too: its nested capture climbs Z's root to its OWNER, and the re-apply
      // finds the fresh Z root by owner — both read "the live parent is O's member" before, which it is not.
      const oDoc = docs[O6] as never;
      rebuild(idAt('ORoot'), O6, oDoc);
      expect(zx()).toBe(7);
      const before = [...treePaths().values()].sort();
      await load(await serializeScene() as unknown as SceneData);
      expect([...treePaths().values()].sort()).toEqual(before);
      expect(getAllEntities().filter((e) => e.name === 'ZRoot')).toHaveLength(1);
      expect(zx()).toBe(7);
    } finally { for (const k of Object.keys(docs)) { prefabs.delete(k); setPrefabCache(k, null); } }
  });
});

// #1484 / #1481: a nested row under a nested row, SUPPORTED in every capture and rebuild path (owner ruling
// 2026-09-23). O: Root(1) > QRow(2, Q) > ZRow(3, Z), plus a plain row Plain(4) under QRow and Ctrl(5) under the root.
// `ownZ` gives Q its OWN nested Z at row 3 under its root — the same row number and the same identity parent.
describe('a nested row under a nested row is supported everywhere (#1484, #1481)', () => {
  const O7 = 'aaaaaaaa-0000-4000-8000-0000000007b1';
  const Q7 = 'aaaaaaaa-0000-4000-8000-0000000007b2';
  const Z7 = 'aaaaaaaa-0000-4000-8000-0000000007b3';
  const docsOf = (ownZ = false, zRowTf?: { x: number }) => ({
    [Q7]: { id: Q7, rootLocalId: 1, entities: [row(1, 'QRoot', 0), row(2, 'QA', 1), ownZ ? row(3, 'QZRow', 1, { prefab: Z7 }) : row(3, 'QB', 2)] },
    [Z7]: { id: Z7, rootLocalId: 1, entities: [row(1, 'ZRoot', 0), row(2, 'ZLeaf', 1)] },
    [O7]: { id: O7, rootLocalId: 1, entities: [row(1, 'ORoot', 0), row(2, 'QRow', 1, { prefab: Q7 }), row(3, 'ZRow', 2, { prefab: Z7, ...(zRowTf ? { overrides: { 1: { Transform: zRowTf } } } : {}) }),
      row(4, 'Plain', 2), row(5, 'Ctrl', 1)] },
  });
  let docs = docsOf();
  const use = (d: typeof docs) => { docs = d; for (const [k, v] of Object.entries(d)) { prefabs.set(k, v); setPrefabCache(k, v as never); } };
  const loadO = async () => load({ id: 'n7', version: 16, name: 'N7', resources: [], entities: [
    { id: 1, prefab: O7, guid: ROOT, traits: { EntityAttributes: { name: 'ORoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
  ] } as unknown as SceneData);
  const tfOf = (id: number) => [...getCurrentWorld().entities].find((e) => e.id() === id)!.get(getTraitByName('Transform')!.trait) as { x: number };
  type Entry = { prefab?: string; removed?: number[] };
  const oEntry = async () => viewEntry((await serializeScene() as unknown as { entities: Entry[] }).entities.find((e) => e.prefab === O7)!);
  beforeEach(() => use(docsOf()));
  afterEach(() => { for (const k of [O7, Q7, Z7]) { prefabs.delete(k); setPrefabCache(k, null); } });

  // #1484 (1). Mutation: have `nestedRowPresent` look its parent up in `localToEcs` alone (the pre-fix lookup).
  it('deleting the nested row under the nested row is saved, and stays deleted after a reload', async () => {
    await loadO();
    deleteEntitiesWithUndo([idAt('ORoot/QRoot/ZRoot')]);
    expect((await oEntry()).removed).toEqual([3]);
    await load(await serializeScene() as unknown as SceneData);
    expect(getAllEntities().filter((e) => e.name === 'ZRoot' || e.name === 'ZLeaf')).toHaveLength(0);
    expect(idAt('ORoot/QRoot/QA/QB')).toBeGreaterThan(0);
  });
  // #1765: a PLAIN row under the nested row under the nested row. Deleting QRow's instance stores ONE removal: the plain
  // row's own removal was written too, so once the template moved that row out from under QRow it stayed deleted.
  // Mutation: test the direct parent only in the top-most filter (`underRemoved`) — `removed` is [2, 6], and FP stays gone.
  it('deleting the outer nested instance stores only its own removal, and a row the template later moves out comes back', async () => {
    const withFP = (fpParent: number) => {
      const d = docsOf();
      d[O7].entities.push(row(6, 'FP', fpParent));
      return d;
    };
    use(withFP(3));
    await loadO();
    expect(idAt('ORoot/QRoot/ZRoot/FP')).toBeGreaterThan(0); // precondition: FP expands under ZRow's root
    deleteEntitiesWithUndo([idAt('ORoot/QRoot')]);
    expect((await oEntry()).removed).toEqual([2]);
    const saved = await serializeScene() as unknown as SceneData;
    use(withFP(1)); // the template author moves FP under the root
    await load(saved);
    expect(getAllEntities().filter((e) => e.name === 'FP')).toHaveLength(1);
  });
  // A plain row under the nested row is O's row, not something Q added. Mutation: have `foreignRow` answer false for
  // a member of another instance (Q's capture writes Plain as its own `added`, and a reload spawns it twice).
  it('left in place, nothing is written as removed or added, and a reload holds one of each', async () => {
    await loadO();
    const entry = await oEntry() as Entry & { members?: Record<string, { added?: unknown[] }> };
    expect(entry.removed).toBeUndefined();
    expect(Object.values(entry.members ?? {}).flatMap((r) => r.added ?? [])).toEqual([]);
    await load(await serializeScene() as unknown as SceneData);
    for (const name of ['Plain', 'ZRoot', 'ZLeaf']) expect(getAllEntities().filter((e) => e.name === name)).toHaveLength(1);
  });

  // #1484 (2): an Apply or Revert on source Q rebuilds the nested Q. It was rebuilt ALONE by the old per-frame rebuild,
  // whose teardown parked O's row under it (`foreign` in `rebuildTeardown`'s park). Since #1880 F7d the rebuild is the
  // load of O's whole entry, and dropping `foreign` from the park leaves this green (measured).
  it('rebuilding the inner instance keeps the outer frame\'s row under it, its guid and its edit', async () => {
    await loadO();
    const z = guidAt('ORoot/QRoot/ZRoot');
    const leaf = guidAt('ORoot/QRoot/ZRoot/ZLeaf');
    writeTraitFieldWithUndo(idAt('ORoot/QRoot/ZRoot/ZLeaf'), getTraitByName('Transform')!, 'x', 7);
    const q = idAt('ORoot/QRoot');
    const qDoc = docs[Q7] as never;
    rebuild(q, Q7, qDoc);
    expect(getAllEntities().filter((e) => e.name === 'ZRoot')).toHaveLength(1);
    expect(getAllEntities().filter((e) => e.name === 'Plain')).toHaveLength(1); // a plain row of O's under Q, too
    expect(guidAt('ORoot/QRoot/ZRoot')).toBe(z);
    expect(tfOf(idAt('ORoot/QRoot/ZRoot/ZLeaf')).x).toBe(7);
    await load(await serializeScene() as unknown as SceneData);
    expect(guidAt('ORoot/QRoot/ZRoot/ZLeaf')).toBe(leaf);
    expect(tfOf(idAt('ORoot/QRoot/ZRoot/ZLeaf')).x).toBe(7);
  });
  // …and a rebuild that tears the OWNER down too still destroys it, rather than parking a root whose frame is going.
  // (Returning 0 from `rebuildTeardown`'s `frameOf` for an unmoved owned root, the pre-fix answer, leaves this one green
  // on the entry route — measured at #1880 F7d; the next case and "a rebuild of the outer instance keeps the deletion
  // inside the added instance" go red.)
  it('rebuilding the outer instance respawns the row once', async () => {
    await loadO();
    const o = idAt('ORoot');
    const oDoc = docs[O7] as never;
    rebuild(o, O7, oDoc);
    expect(getAllEntities().filter((e) => e.name === 'ZRoot')).toHaveLength(1);
    expect(getAllEntities().filter((e) => e.name === 'ZLeaf')).toHaveLength(1);
  });

  // One level further out: P nests O, so O's QRoot is an owned root of ANOTHER frame hanging under a nested root of
  // P's — parked by P's rebuild, and destroyed with its owner O, which that rebuild respawns. Mutation: return 0 from
  // `rebuildTeardown`'s `frameOf` for an unmoved owned root (the pre-fix answer): QRoot then stays parked through the
  // teardown of its own frame and survives beside its respawn.
  it('rebuilding an instance that nests the outer one respawns everything once', async () => {
    const P7 = 'aaaaaaaa-0000-4000-8000-0000000007b5';
    const pDoc = { id: P7, rootLocalId: 1, entities: [row(1, 'PRoot', 0), row(2, 'ORow', 1, { prefab: O7 })] };
    prefabs.set(P7, pDoc); setPrefabCache(P7, pDoc as never);
    try {
      await load({ id: 'n7p', version: 16, name: 'N7P', resources: [], entities: [
        { id: 1, prefab: P7, guid: ROOT, traits: { EntityAttributes: { name: 'PRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      ] } as unknown as SceneData);
      const p = idAt('PRoot');
      rebuild(p, P7, pDoc as never);
      for (const name of ['ORoot', 'QRoot', 'QA', 'Plain', 'ZRoot', 'ZLeaf']) expect(getAllEntities().filter((e) => e.name === name)).toHaveLength(1);
    } finally { prefabs.delete(P7); setPrefabCache(P7, null); }
  });

  // Review finding 2: a Revert or Apply on O rebuilds it and re-applies its structure, whose row map was built from
  // "the nested root's live parent is a member" — so the removed row 3, whose root hangs under Q's ROOT, was never
  // mapped, and came back. Mutation: build `applyStructureByRootInstance`'s map from members only.
  it('a deleted nested row under the nested row stays deleted through a rebuild of the outer instance', async () => {
    await loadO();
    deleteEntitiesWithUndo([idAt('ORoot/QRoot/ZRoot')]);
    const o = idAt('ORoot');
    const oDoc = docs[O7] as never;
    rebuild(o, O7, oDoc);
    expect(getAllEntities().filter((e) => e.name === 'ZRoot')).toHaveLength(0);
    expect((await oEntry()).removed).toEqual([3]);
  });

  // Review finding 3: in PREFAB-EDIT, O's own rows under Q's root are the edited document's, not Q's; a Revert on Q
  // rebuilt Q and tore them down, and the edit save then wrote O without them. Mutation: drop the `editRow` park in
  // `rebuildTeardown`.
  it('prefab-edit: a Revert on the nested instance keeps the edited prefab\'s rows under it', async () => {
    await load(buildPrefabEditScene(docs[O7] as unknown as PrefabFile));
    writeTraitFieldWithUndo(idAt('ORoot/QRoot/QA'), getTraitByName('Transform')!, 'x', 3);
    await revertOverridesSelective(idAt('ORoot/QRoot'), new Set(['2.Transform.x']));
    expect(tfOf(idAt('ORoot/QRoot/QA')).x).toBe(0);
    for (const path of ['ORoot/QRoot/Plain', 'ORoot/QRoot/ZRoot', 'ORoot/QRoot/ZRoot/ZLeaf']) expect(idAt(path)).toBeGreaterThan(0);
  });

  // #1481, the body: a plain row under a nested row, and the prefab's base changes under an un-edited instance (a
  // re-import). Mutation: build `captureInstanceOverrides`' gate domain from members only (Plain then reads as moved
  // and freezes x=0).
  it('a member under a nested row is not read as moved: a base change freezes no override', async () => {
    await loadO();
    const changed = JSON.parse(JSON.stringify(docs[O7])) as PrefabFile;
    for (const e of changed.entities) if (e.localId === 4 || e.localId === 5) (e.traits.Transform as { x: number }).x = 5;
    expect(captureInstanceOverrides(idAt('ORoot'), changed)).toEqual({});
  });

  // The known limit, closed: Q ALSO nests Z at row 3 under its own root. Both roots hang under QRoot at row 3, and the
  // frame step is the only thing in the path that says whose row 3. Mutation: drop the FRAME_STEP unshift in
  // `identityParents.of` (both ZRoots, and both ZLeafs, derive one guid).
  it('two nested rows with one number under one nested root derive guids of their own, and keep them', async () => {
    use(docsOf(true));
    await loadO();
    const guids = getAllEntities().map((e) => e.guid).filter((g): g is string => !!g);
    expect(new Set(guids).size).toBe(guids.length);
    expect(getAllEntities().filter((e) => e.name === 'ZRoot')).toHaveLength(2);
    // Two entities share the path ORoot/QRoot/ZRoot here, so the tree is compared as guid → parent guid.
    const edges = () => {
      const guidOf = new Map(getAllEntities().map((e) => [e.id, e.guid ?? '']));
      return getAllEntities().map((e) => `${e.guid}<${guidOf.get(e.parentId) ?? ''}`).sort();
    };
    const before = edges();
    await load(await serializeScene() as unknown as SceneData);
    expect(edges()).toEqual(before);
    // …and a FIRST load re-derives the same answer (no stored rows to lean on).
    await loadO();
    expect(edges()).toEqual(before);
  });

  // …and with both there, deleting OURS is still saved: Q's own ZRoot shares our row's anchor, stamp and source, and
  // is the only candidate left to claim row 3. Mutation: drop the owner check on a candidate under a nested anchor in
  // `instanceRowDomain` (Q's root claims our row, and the delete is never written).
  it('deleting the outer frame\'s row beside the inner frame\'s own row of the same number is saved', async () => {
    use(docsOf(true));
    await loadO();
    const identity = worldIdentityParents(getCurrentWorld());
    // By name, not path: the two ZRoots share one (`idAt` refuses that).
    const oRoot = getAllEntities().find((e) => e.name === 'ORoot')!.id;
    const ours = getAllEntities().filter((e) => e.name === 'ZRoot').find((e) => identity.ownerOf(e.id) === oRoot)!;
    deleteEntitiesWithUndo([ours.id]);
    expect((await oEntry()).removed).toEqual([3]);
    await load(await serializeScene() as unknown as SceneData);
    expect(getAllEntities().filter((e) => e.name === 'ZRoot')).toHaveLength(1);
  });

  // …and the mirror: deleting the INNER frame's own row is saved too. O's root under QRoot shares Q's row's anchor,
  // stamp and source, and without the owner check under a MEMBER anchor it claimed Q's row, so the delete was never
  // written and a reload brought Q's Z back. Mutation: drop that owner check in `instanceRowDomain`.
  it('deleting the inner frame\'s own row beside the outer frame\'s row of the same number is saved', async () => {
    use(docsOf(true));
    await loadO();
    const identity = worldIdentityParents(getCurrentWorld());
    const qRoot = getAllEntities().find((e) => e.name === 'QRoot')!.id;
    const inner = getAllEntities().filter((e) => e.name === 'ZRoot').find((e) => identity.ownerOf(e.id) === qRoot)!;
    deleteEntitiesWithUndo([inner.id]);
    await load(await serializeScene() as unknown as SceneData);
    const zs = getAllEntities().filter((e) => e.name === 'ZRoot');
    expect(zs).toHaveLength(1);
    expect(worldIdentityParents(getCurrentWorld()).ownerOf(zs[0]!.id)).toBe(getAllEntities().find((e) => e.name === 'ORoot')!.id);
  });

  // The frame step in a WRITTEN prefab: a prefab-edit save tokenizes a ref into a row under a nested row, and an
  // instance of the result must resolve it to that row's member. Mutation: drop `crosses` in `templateTokenizer` (the
  // token names `2.3.2`, which no member answers to); and drop the `isFrameStep` exemption in `undeclaredKeys` (the
  // `@` step reads as an undeclared template key, and the token is turned back into the edit world's guid).
  it('prefab-edit: a ref to a row under a nested row round-trips through the written prefab', async () => {
    const O_E = 'aaaaaaaa-0000-4000-8000-0000000007b4';
    const oDoc = { ...docs[O7], id: O_E } as unknown as PrefabFile;
    prefabs.set(O_E, oDoc); setPrefabCache(O_E, oDoc);
    try {
      await load(buildPrefabEditScene(oDoc));
      // ZLeaf: a member of the nested row under the nested row, named by its live guid in the edit world (a ROW's
      // edit-world guid is a sentinel, which the save resolves on its own).
      const leaf = guidAt('ORoot/QRoot/ZRoot/ZLeaf');
      const root = [...getCurrentWorld().entities].find((x) => x.id() === idAt('ORoot'))!;
      root.add(getTraitByName('UIAction')!.trait({ bindings: [{ event: 'click', action: 'noop', target: leaf }] } as never));
      const preserve = new Map(getAllEntities().filter((e) => e.guid?.startsWith('__prefab_edit_local__'))
        .map((e) => [e.id, Number(e.guid!.slice('__prefab_edit_local__'.length))] as [number, number]));
      preserve.set(idAt('ORoot'), 1);
      const rowParents = new Map(oDoc.entities.map((e) => [e.localId, (e.traits.EntityAttributes as { parentId: number }).parentId]));
      const file = serializePrefab(idAt('ORoot'), O_E, { preserveLocalIds: preserve, rowParents })!;
      prefabs.set(O_E, file); setPrefabCache(O_E, file);
      await load({ id: 'n7e', version: 16, name: 'N7E', resources: [], entities: [
        { id: 1, prefab: O_E, guid: ROOT, traits: { EntityAttributes: { name: 'ORoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      ] } as unknown as SceneData);
      expect((file.entities.find((e) => e.localId === 1)!.traits.UIAction as { bindings: { target: string }[] }).bindings[0]!.target)
        .toBe('@member:2.@.3.2');
      expect(targetsOf(idAt('ORoot')).map((g) => treePaths().get(g))).toEqual(['ORoot/QRoot/ZRoot/ZLeaf']);
    } finally { prefabs.delete(O_E); setPrefabCache(O_E, null); }
  });
});

// #1468 Phase 6 close-out: a save builds the identity resolver once (`openIdentityScope`), and it must not serve a
// stale one when the structure moves under the save's awaits. Mutation: drop the structure-version check.
describe('the save-scoped identity resolver (#1468 Phase 6 close-out)', () => {
  it('is reused while nothing moves, and rebuilt after a reparent', async () => {
    await loaded();
    openIdentityScope();
    try {
      const first = worldIdentityParents(getCurrentWorld());
      expect(worldIdentityParents(getCurrentWorld())).toBe(first);
      // A stored root, which moves freely (a member no longer does, #1869).
      const root = idAt('Holder/OuterRoot');
      expect(first.parentOf(root)).toBe(idAt('Holder'));
      expect(reparentEntity(root, 0)).toBe(true);
      const after = worldIdentityParents(getCurrentWorld());
      expect(after).not.toBe(first);
      expect(after.parentOf(root)).toBe(0);
    } finally { closeIdentityScope(); }
  });
});

// The two NESTED homes of a pre-Phase-3 `moved` map, beside the entry's own (sceneMemberRowParent.test.ts):
// a user-added reference node's, and a nested row's `nestedStructure[path].moved`. Both still load, because
// a file from before Phase 3 has its moves nowhere else (#1468).
describe('a pre-Phase-3 nested `moved` map still applies (#1468)', () => {
  const legacy = (patch: (entry: Record<string, unknown>) => void): SceneData => {
    const sc = JSON.parse(JSON.stringify(scene([]))) as { version: number; entities: Array<Record<string, unknown>> };
    sc.version = 15;
    patch(sc.entities[1]!);
    return sc as unknown as SceneData;
  };

  // Mutation: stop passing `node.moved` in spawnReferenceNode.
  it('a reference node`s `moved`: its member lands under the named parent', async () => {
    await load(scene([]));
    const panel = guidAt('Holder/OuterRoot/Panel');
    await load(legacy((e) => { (e.added as Array<Record<string, unknown>>)[0]!.moved = { 2: panel }; }));
    expect(idAt('Holder/OuterRoot/Panel/Leaf')).toBeGreaterThan(0);
  });

  // Mutation: stop passing `structDirect.moved` at the owned-nested descend.
  it('a nested row`s `nestedStructure` `moved`: its member lands under the named parent', async () => {
    await load(scene([]));
    const button = guidAt('Holder/OuterRoot/Panel/Button');
    await load(legacy((e) => { e.nestedStructure = { 4: { moved: { 2: button } } }; }));
    expect(idAt('Holder/OuterRoot/Panel/Button/Leaf')).toBeGreaterThan(0);
  });
});
