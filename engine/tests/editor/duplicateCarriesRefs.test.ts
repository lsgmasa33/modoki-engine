/** #1338 — an editor duplicate carries references INSIDE the copied subtree, including refs to
 *  prefab-instance MEMBERS, whose guids are never saved: a reload re-derives them from the nearest
 *  guid-carrying ancestor. So the only honest check is the whole loop — load a scene through the real
 *  loader, duplicate in the editor, serialize, load the result, and resolve each ref by tree path.
 *  (The plain-entity cases run without the loader in packages/modoki/tests/editor/entityActions.test.ts.) */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { expectInOrder } from '@modoki/engine/testing/inOrder';
import { createWorld, trait as kootaTrait } from 'koota';

const prefabs = new Map<string, unknown>();
/** A saved scene / entry with its member rows unfolded into the pre-Phase-4 channels (#1468) — for the
 *  assertions below that are about WHAT an instance recorded, not which channel holds it. Every reload
 *  still reads the real file. See `memberRowView.ts`. */
const view = <T extends { entities: unknown[] }>(scene: T): T => legacySceneView(scene, (g) => prefabs.get(g));
const viewEntry = <T,>(entry: T): T => legacyView(entry, (g) => prefabs.get(g));
/** Listed override keys in their localId spelling against `doc` (#1468 Phase 4): a key names its member
 *  by `nodeGuid` now, and the assertions below are about WHICH member is offered, not how it is spelled. */
const inLocalIds = (keys: string[], doc: unknown): string[] => keys.map((k) => canonicalOverrideKey(k, doc as never));
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, worldTransforms, getOverrideMarkSet, registerTrait, type SceneData,
} from '@modoki/engine/runtime';
import {
  duplicateEntity, writeTraitFieldWithUndo, setActionCallback, pushAction, clearHistory, serializeScene,
  reparentEntity, deleteEntitiesWithUndo, removeTraitFromEntitiesWithUndo,
} from '@modoki/engine/editor';
import { setPrefabCache, detachPrefabInstance, reattachPrefabInstance, wouldCreateCycle, captureInstanceStructure, captureInstanceOverrides, rebuildInstance, instantiatePrefab, revertOverridesSelective, serializePrefab, applyToPrefabSelective, applyToPrefab, getCachedPrefabSync, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { collectInstanceOverrideKeys, applyOutcomeNotice, canonicalOverrideKey } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { buildPrefabEditScene, applyEditWorldMoves } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { TemplateAddedKey } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { recoverTemplateKey as recoverTemplateKeyFrom, type KeyRecoveryNode } from '../../packages/modoki/src/runtime/loaders/templateKeyRecovery';
import { undo, redo } from '../../packages/modoki/src/editor/undo/undoManager';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { legacyView, legacySceneView } from './memberRowView';
import { deriveMemberGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { memberPathIndex, deriveInstanceMemberGuids } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { detachOrphanedMembers, relinkDetachedMembers } from '../../packages/modoki/src/runtime/core/ecs/memberHome';
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
/** The moves an instance now records: `SceneMemberRow.parent`, keyed by the member's NAME (#1468
 *  Phase 3, where this was `entry.moved` keyed by localId). Names beat either spelling for a reader
 *  and the row already carries one — and a row key is a chain of minted guids, so the old
 *  `{ 3: ROOT }` has no readable equivalent. Nested frames land here too: the chained key gives a
 *  member two frames down an address on the OUTER entry, which is D2(b) collapsing
 *  `nestedStructure.moved` onto the rows. */
const movesOf = (e: { members?: Record<string, { name?: string; parent?: string }> } | undefined): Record<string, string> =>
  Object.fromEntries(Object.values(e?.members ?? {}).filter((r) => r.parent).map((r) => [r.name ?? '?', r.parent!]));

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
  id: 'dup-legacy', version: 1, name: 'L', resources: [],
  entities: [
    { id: 1, traits: withUi({ EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } }, holderRefs) },
    { id: 2, prefab: OUTER, traits: withUi({ EntityAttributes: { name: 'OuterRoot', parentId: HOLDER }, Transform: { x: 0, y: 0, z: 0 } }, rootRefs) },
  ],
} as unknown as SceneData);

/** The scene: Holder → an OUTER instance (own guid) carrying an added INNER under Button. The added
 *  node carries its OWN guid; the guid-less variant is covered by the #1349 block below. */
const scene = (holderRefs: string[], rootRefs: string[] = []): SceneData => ({
  id: 'dup-scene', version: 1, name: 'S', resources: [],
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

  it('reparented OUT onto a plain entity: one entity per guid, and a ref to its Leaf resolves under Shelf', async () => {
    await load(withShelf());
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Shelf'));
    const leaf = guidAt('Shelf/InnerRoot/Leaf');
    const saved = await serializeScene() as unknown as { entities: Array<{ traits: Record<string, unknown> }> };
    const shelf = saved.entities.find((e) => (e.traits.EntityAttributes as { name?: string })?.name === 'Shelf')!;
    shelf.traits.UIAction = { bindings: [{ event: 'click', action: 'noop', target: leaf }] };
    await load(saved as unknown as SceneData);
    expectUniqueGuids();
    expect(treePaths().get(leaf)).toBe('Shelf/InnerRoot/Leaf');
    expect([...treePaths().values()]).not.toContain('Holder/OuterRoot/Panel/InnerRoot');
    expect(targetsOf(idAt('Shelf')).map((g) => treePaths().get(g))).toEqual(['Shelf/InnerRoot/Leaf']);
    expect(linked(idAt('Shelf/InnerRoot'))).toBe(true); // a standalone instance of its own prefab (#1447)
  });

  it('reparented to ANOTHER member of the same instance: it is not duplicated at its old row', async () => {
    await load(withShelf());
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Holder/OuterRoot/Panel/Button'));
    await load(await serializeScene() as unknown as SceneData);
    expectUniqueGuids();
    const paths = [...treePaths().values()];
    expect(paths).toContain('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf');
    expect(paths).not.toContain('Holder/OuterRoot/Panel/InnerRoot');
  });

  it('deleted: it stays deleted', async () => {
    await load(withShelf());
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel/InnerRoot')]);
    await load(await serializeScene() as unknown as SceneData);
    expect([...treePaths().values()].filter((p) => p.includes('InnerRoot'))).toEqual([]);
  });

  // The member unpacks; the owned nested instance it holds becomes a standalone instance of its own prefab
  // (#1447, owner ruling 2026-09-19 — it used to unpack too). Mutation: drop the promoteOwnedRoots rename.
  it('a MEMBER holding an owned nested instance, moved out: the member unpacks, the nested instance stays linked, and a ref to its Leaf survives', async () => {
    await load(withShelf());
    reparentEntity(idAt('Holder/OuterRoot/Panel'), idAt('Shelf'));
    const leaf = guidAt('Shelf/Panel/InnerRoot/Leaf');
    const saved = await serializeScene() as unknown as { entities: Array<{ traits: Record<string, unknown> }> };
    const shelf = saved.entities.find((e) => (e.traits.EntityAttributes as { name?: string })?.name === 'Shelf')!;
    shelf.traits.UIAction = { bindings: [{ event: 'click', action: 'noop', target: leaf }] };
    await load(saved as unknown as SceneData);
    expectUniqueGuids();
    expect(targetsOf(idAt('Shelf')).map((g) => treePaths().get(g))).toEqual(['Shelf/Panel/InnerRoot/Leaf']);
    expect([...treePaths().values()].filter((p) => p.startsWith('Holder/OuterRoot/'))).toEqual([]);
    expect(linked(idAt('Shelf/Panel'))).toBe(false);
    expect(linked(idAt('Shelf/Panel/InnerRoot'))).toBe(true);
    expect(linked(idAt('Shelf/Panel/InnerRoot/Leaf'))).toBe(true);
  });

  // A user-added nested instance inside the moved member keeps its linkage (its root is stored).
  it('a MEMBER holding a USER-ADDED nested instance, moved out: that instance stays linked, and a ref to its Leaf survives', async () => {
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities.push({ id: 3, traits: { EntityAttributes: { name: 'Shelf', parentId: 0, guid: SHELF } } });
    await load(sc as unknown as SceneData);
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Shelf'));
    const addedRoot = idAt('Shelf/Button/InnerRoot');
    const pi = [...getCurrentWorld().entities].find((e) => e.id() === addedRoot)!.get(getTraitByName('PrefabInstance')!.trait) as { rootInstanceId?: number };
    expect(pi?.rootInstanceId).toBe(addedRoot);
    const leaf = guidAt('Shelf/Button/InnerRoot/Leaf');
    const saved = await serializeScene() as unknown as { entities: Array<{ traits: Record<string, unknown> }> };
    const shelf = saved.entities.find((e) => (e.traits.EntityAttributes as { name?: string })?.name === 'Shelf')!;
    shelf.traits.UIAction = { bindings: [{ event: 'click', action: 'noop', target: leaf }] };
    await load(saved as unknown as SceneData);
    expectUniqueGuids();
    expect(targetsOf(idAt('Shelf')).map((g) => treePaths().get(g))).toEqual(['Shelf/Button/InnerRoot/Leaf']);
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

  // #1355 review, finding 2: the user-added instance must itself own a nested row, or skipping its
  // subtree is unobservable. Mutation: drop the stored-root `continue` in the detach walk.
  it('a moved member holding a user-added instance that OWNS a nested row: that owned row stays linked', async () => {
    const TOP = 'aaaaaaaa-0000-4000-8000-0000000000c3';
    const topDoc = { id: TOP, rootLocalId: 1, entities: [row(1, 'TopRoot', 0), row(2, 'Slot2', 1)] };
    prefabs.set(TOP, topDoc);
    setPrefabCache(TOP, topDoc as never);
    try {
      await load({
        id: 'top', version: 1, name: 'T', resources: [],
        entities: [
          { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
          {
            id: 2, prefab: TOP, guid: ROOT,
            traits: { EntityAttributes: { name: 'TopRoot', parentId: HOLDER }, Transform: { x: 0, y: 0, z: 0 } },
            added: [{ parentLocalId: 2, guid: ANCHORED, name: 'U', prefab: OUTER, traits: {}, children: [] }],
          },
          { id: 3, traits: { EntityAttributes: { name: 'Shelf', parentId: 0, guid: SHELF } } },
        ],
      } as unknown as SceneData);
      reparentEntity(idAt('Holder/TopRoot/Slot2'), idAt('Shelf'));
      const inner = [...getCurrentWorld().entities].find((e) => e.id() === idAt('Shelf/Slot2/OuterRoot/Panel/InnerRoot'))!;
      expect(inner.has(getTraitByName('PrefabInstance')!.trait)).toBe(true);
    } finally {
      setPrefabCache(TOP, null);
    }
  });

  // #1355 review, finding 4. Mutation: drop the parentLocalId carry in rebuildInstance.
  it('an OWNED nested instance rebuilt, then moved out: it stays an instance, and a ref to its Leaf survives', async () => {
    await load(withShelf());
    const newId = rebuildInstance(idAt('Holder/OuterRoot/Panel/InnerRoot'), INNER, innerDoc as never, {}, { added: [], removed: [], removedTraits: {} });
    const e = [...getCurrentWorld().entities].find((x) => x.id() === newId)!;
    expect((e.get(getTraitByName('PrefabInstance')!.trait) as { parentLocalId?: number }).parentLocalId).toBe(4);
    reparentEntity(newId, idAt('Shelf'));
    const leaf = guidAt('Shelf/InnerRoot/Leaf');
    const saved = await serializeScene() as unknown as { entities: Array<{ traits: Record<string, unknown> }> };
    const shelf = saved.entities.find((x) => (x.traits.EntityAttributes as { name?: string })?.name === 'Shelf')!;
    shelf.traits.UIAction = { bindings: [{ event: 'click', action: 'noop', target: leaf }] };
    await load(saved as unknown as SceneData);
    expectUniqueGuids();
    expect(targetsOf(idAt('Shelf')).map((g) => treePaths().get(g))).toEqual(['Shelf/InnerRoot/Leaf']);
    expect(linked(idAt('Shelf/InnerRoot'))).toBe(true);
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
  // `putBackMarks` on undo, or its re-mark on redo — each turns this red.
  it('a top-level instance dropped under a moved parent keeps its world pose through save + reload; undo drops the marks, redo restores them', async () => {
    const sc = withShelf() as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities.push({ id: 4, prefab: INNER, guid: 'bbbbbbbb-0000-4000-8000-0000000000c5', overrides: { 1: { Transform: { y: 4 } } }, traits: { EntityAttributes: { name: 'InnerRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } });
    await load(sc as unknown as SceneData);
    const solo = idAt('InnerRoot');
    rename(solo, 'Solo'); // Panel already holds an owned InnerRoot
    const panel = idAt('Holder/OuterRoot/Panel');
    const entityOf = (id: number) => [...getCurrentWorld().entities].find((x) => x.id() === id)!;
    const before = [...(getOverrideMarkSet(entityOf(solo)) ?? [])].sort();
    worldTransforms.set(panel, { x: 10, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    worldTransforms.set(solo, { x: 0, y: 4, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    try {
      reparentEntity(solo, panel);
      expect(getOverrideMarkSet(entityOf(solo))?.has('Transform.x')).toBe(true);
      await undo();
      expect([...(getOverrideMarkSet(entityOf(solo)) ?? [])].sort()).toEqual(before);
      await redo();
      expect(getOverrideMarkSet(entityOf(solo))?.has('Transform.x')).toBe(true);
    } finally { worldTransforms.delete(panel); worldTransforms.delete(solo); }
    await load(await serializeScene() as unknown as SceneData);
    const tf = entityOf(idAt('Holder/OuterRoot/Panel/Solo')).get(getTraitByName('Transform')!.trait) as { x: number; y: number };
    expect(linked(idAt('Holder/OuterRoot/Panel/Solo'))).toBe(true);
    expect(tf.x).toBeCloseTo(-10);
    expect(tf.y).toBeCloseTo(4);
  });

  // #1436 second review, then #1437: a MEMBER moved to another parent inside its own instance stays linked,
  // and the save records its new parent and its compensated pose — WITHOUT a mark, which would outlive the
  // move and pin the pose once it moved back. Mutations: drop the stored-root check in
  // markCompensatedTransform (a mark appears); drop the moved-Transform exemption in
  // captureInstanceOverrides (the reloaded x is the base 0).
  it('a member moved inside its own instance keeps its world pose through save + reload, unmarked', async () => {
    await load(withShelf());
    const button = idAt('Holder/OuterRoot/Panel/Button');
    const panel = idAt('Holder/OuterRoot/Panel');
    const outer = idAt('Holder/OuterRoot');
    worldTransforms.set(panel, { x: 10, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    worldTransforms.set(button, { x: 10, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    worldTransforms.set(outer, { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    try { reparentEntity(button, outer); } finally { for (const id of [panel, button, outer]) worldTransforms.delete(id); }
    expect(linked(button)).toBe(true);
    expect(getOverrideMarkSet([...getCurrentWorld().entities].find((x) => x.id() === button)!)?.has('Transform.x') ?? false).toBe(false);
    await load(await serializeScene() as unknown as SceneData);
    expect(leafX(idAt('Holder/OuterRoot/Button'))).toBeCloseTo(10);
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

  /** Save, then reload with five plain entities spawned first, so every ecs id moves. */
  const rebuild = async (): Promise<void> => {
    const saved = await serializeScene() as unknown as { entities: unknown[] };
    const pad = [1, 2, 3, 4, 5].map((i) => ({ id: 100 + i, traits: { EntityAttributes: { name: `Pad${i}`, parentId: 0, guid: `cccccccc-0000-4000-8000-00000000000${i}` } } }));
    await load({ ...saved, entities: [...pad, ...saved.entities] } as unknown as SceneData);
  };

  // #1355 third review: the unpack's undo stored the numeric rootInstanceId, which a world rebuild
  // reassigns. The unpacked entity here is an instance ROOT (its own owner): an owned nested root moved
  // out of its instance. (This drove a stored root into a member until #1436 stopped that unpacking.)
  // Mutation: restore `t.data` as captured in reparentEntity's undoDetach.
  it('a nested instance moved out, then undone AFTER a world rebuild, rejoins its row, and the save keeps it', async () => {
    await load(withShelf());
    const inner = idAt('Holder/OuterRoot/Panel/InnerRoot');
    reparentEntity(inner, idAt('Shelf'));
    expect(linked(idAt('Shelf/InnerRoot'))).toBe(true); // precondition: it stayed an instance (#1447)
    await rebuild();
    expect(idAt('Shelf/InnerRoot')).not.toBe(inner); // precondition: the id moved
    await undo();
    const root = idAt('Holder/OuterRoot/Panel/InnerRoot');
    const pi = [...getCurrentWorld().entities].find((e) => e.id() === root)!.get(getTraitByName('PrefabInstance')!.trait) as { rootInstanceId?: number; parentLocalId?: number };
    expect(pi?.rootInstanceId).toBe(root);
    expect(pi?.parentLocalId).toBe(4); // an owned row again
    await load(await serializeScene() as unknown as SceneData);
    expectUniqueGuids();
    expect([...treePaths().values()].filter((p) => p.includes('InnerRoot'))).toEqual(['Holder/OuterRoot/Panel/InnerRoot', 'Holder/OuterRoot/Panel/InnerRoot/Leaf']);
  });

  // #1355 fourth review: a MEMBER's owner is outside the moved subtree. Same mutation as above.
  it('a MEMBER unpacked, then undone after a world rebuild, rejoins the live instance at its row', async () => {
    await load(withShelf());
    const outer = guidAt('Holder/OuterRoot');
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Shelf'));
    await rebuild();
    await undo();
    const pi = [...getCurrentWorld().entities].find((e) => e.id() === idAt('Holder/OuterRoot/Panel/Button'))!
      .get(getTraitByName('PrefabInstance')!.trait) as { rootInstanceId?: number };
    expect(pi?.rootInstanceId).toBe(idAt('Holder/OuterRoot'));
    expect(guidAt('Holder/OuterRoot')).toBe(outer);
    await load(await serializeScene() as unknown as SceneData);
    expectUniqueGuids();
    expect([...treePaths().values()].filter((p) => p.endsWith('Button'))).toEqual(['Holder/OuterRoot/Panel/Button']);
  });

  // #1355 fourth review, finding 1: under an UNANCHORED (guid-less, scene-root) instance the owner's
  // guid was minted at move time and RE-DERIVED DIFFERENTLY by the rebuild, so the ref missed; the
  // stale id then named an unrelated entity, and relinking to it made the save drop the moved
  // entity. Leaving it PLAIN was the safe outcome that finding settled on.
  //
  // ⚠️ #1468 removed the premise. The owner's guid is STORED now, so the rebuild gives it back
  // unchanged and the ref lands — the undo relinks the entity as a member, which is the outcome the
  // original wanted and could not have. What is still pinned is the part that mattered: ONE entity
  // under that guid, and the save keeps it. The guard against a stale id naming an unrelated entity
  // has not been deleted; it is simply no longer reachable this way. Mutation: fall back to
  // `t.data.rootInstanceId` when the owner does not resolve.
  it('an unpack undone after a rebuild relinks the entity to its owner, and the save keeps it', async () => {
    const sc = withShelf() as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1] = { id: 2, prefab: OUTER, traits: { EntityAttributes: { name: 'OuterRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } };
    await load(sc as unknown as SceneData);
    reparentEntity(idAt('OuterRoot/Panel/InnerRoot/Leaf'), idAt('Shelf'));
    await rebuild();
    const leaf = guidAt('Shelf/Leaf');
    expect(await undo()).toBe(true);
    // Read the WORLD, not the entity-info snapshot, which can lag a structural change.
    const eaTrait = getTraitByName('EntityAttributes')!.trait;
    const live = [...getCurrentWorld().entities].filter((x) => x.has(eaTrait) && (x.get(eaTrait) as { guid?: string }).guid === leaf);
    expect(live).toHaveLength(1);
    expect(live[0]!.has(getTraitByName('PrefabInstance')!.trait)).toBe(true);
    await load(await serializeScene() as unknown as SceneData);
    expect(treePaths().has(leaf)).toBe(true);
  });

  // Mutation: let the presence check accept an instance of the row's prefab under ANY parent.
  it('deleted while a user-added instance of the same prefab sits under ANOTHER member: only the deleted one stays gone', async () => {
    await load(scene([]));
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel/InnerRoot')]);
    await load(await serializeScene() as unknown as SceneData);
    const inner = [...treePaths().values()].filter((p) => p.endsWith('InnerRoot'));
    expect(inner).toEqual(['Holder/OuterRoot/Panel/Button/InnerRoot']);
  });

  // Mutation: drop the uncached-prefab guard in the presence check.
  it('a row whose prefab could not be loaded expanded to nothing, and is NOT saved as removed', async () => {
    prefabs.delete(INNER);
    setPrefabCache(INNER, null);
    await load(withShelf());
    expect([...treePaths().values()].filter((p) => p.includes('InnerRoot'))).toEqual([]);
    const saved = await serializeScene() as unknown as { entities: Array<{ prefab?: string; removed?: number[] }> };
    expect(saved.entities.find((e) => e.prefab === OUTER)?.removed).toBeUndefined();
  });

  // The editor-side apply (refresh/revert rebuild). Mutation: drop the nested-row mapping in
  // applyStructureByRootInstance.
  it('deleted, then the outer instance is REBUILT: the rebuild does not bring it back', async () => {
    await load(withShelf());
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel/InnerRoot')]);
    const root = idAt('Holder/OuterRoot');
    const structure = captureInstanceStructure(root, outerDoc as never);
    expect(structure.removed).toEqual([4]);
    rebuildInstance(root, OUTER, outerDoc as never, {}, structure);
    expect([...treePaths().values()].filter((p) => p.includes('InnerRoot'))).toEqual([]);
    expect([...treePaths().values()]).toContain('Holder/OuterRoot/Panel/Button');
  });

  // An UNSTAMPED instance at the row used to count as present too ("the legacy form"). #1367 made it
  // independent: it is written as a reference node and the row as removed, which reloads as the same
  // single instance — pinned in the #1367 block, not here.
  it('left in place: it is NOT recorded as removed', async () => {
    await load(withShelf());
    const saved = await serializeScene() as unknown as { entities: Array<{ prefab?: string; removed?: number[] }> };
    expect(saved.entities.find((e) => e.prefab === OUTER)?.removed).toBeUndefined();
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

  it('a member MOVED OUT of the expansion does not come back — one entity per guid', async () => {
    await load(withShelf());
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Shelf'));
    await load(await serializeScene() as unknown as SceneData);
    expectUniqueGuids();
    expect(paths()).toContain('Shelf/Leaf');
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

  // The editor half. `rebuildInstance` (Apply, Revert, a prefab file changing) re-spawns the added
  // MID from the captured reference node through the editor's own spawn, which must carry the node's
  // nested channels exactly as the loader does. Mutation: in the editor `spawnNestedInstance`, call
  // `instantiatePrefab(child, parentEcsId)` without the two channels.
  it('a rebuild of the outer instance keeps the deletion inside the added instance', async () => {
    await load(withAddedMid());
    deleteEntitiesWithUndo([idAt(LEAF)]);
    const root = idAt('Holder/OuterRoot');
    rebuildInstance(root, OUTER, outerDoc as never, captureInstanceOverrides(root, outerDoc as never), captureInstanceStructure(root, outerDoc as never));
    expect(paths()).toContain('Holder/OuterRoot/Panel/Button/MidRoot/Slot/InnerRoot');
    expect(paths()).not.toContain(LEAF);
  });

  // Found while designing the above, pre-existing: the rebuild's live re-apply
  // (`captureNestedInstanceOverrides`) visited a USER-ADDED instance too (chain [0]) and re-applied its
  // structure on top of the reference spawn that had already applied it, so every subtree it had added
  // was spawned twice. Mutation: drop `!chain.includes(0)` from that capture.
  it('a rebuild does not duplicate a subtree the added instance itself added', async () => {
    const BOLT = 'bbbbbbbb-0000-4000-8000-0000000000f9';
    const sc = scene([]) as unknown as { entities: Array<Record<string, any>> };
    sc.entities[1]!.added[0].added = [{ parentLocalId: 1, guid: BOLT, name: 'Bolt', children: [],
      traits: { EntityAttributes: { name: 'Bolt', parentId: 0, guid: BOLT } } }];
    await load(sc as unknown as SceneData);
    expect(getAllEntities().filter((e) => e.name === 'Bolt')).toHaveLength(1); // precondition
    const root = idAt('Holder/OuterRoot');
    rebuildInstance(root, OUTER, outerDoc as never, captureInstanceOverrides(root, outerDoc as never), captureInstanceStructure(root, outerDoc as never));
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

// #1437 P1: a member moved to another parent INSIDE its instance keeps its identity. Every walk that derives or
// names a member steps from the row parent it left — read from its document since #1468 Phase 6, recorded on it
// (`PrefabInstance.homeParent`) before — not from where the member sits now.
describe('a member moved inside its own instance keeps its identity (#1437)', () => {
  const homeOf = (id: number): string => homeView(id).homeParent;

  // Mutation: have the resolver (`identityParents.ts`) answer the live parent for a member.
  it('the move records the home parent, moving back clears it, and undo/redo follow', async () => {
    await loaded();
    const button = idAt('Holder/OuterRoot/Panel/Button');
    const panelGuid = guidAt('Holder/OuterRoot/Panel');
    reparentEntity(button, idAt('Holder/OuterRoot'));
    expect(homeOf(button)).toBe(panelGuid);
    reparentEntity(button, idAt('Holder/OuterRoot/Panel/InnerRoot'));
    expect(homeOf(button)).toBe(panelGuid); // a second move keeps the ROW parent, not the one it just left
    reparentEntity(button, idAt('Holder/OuterRoot/Panel'));
    expect(homeOf(button)).toBe('');
    await undo();
    expect(homeOf(button)).toBe(panelGuid);
    await redo();
    expect(homeOf(button)).toBe('');
  });

  // Mutation: walk live children in planCopyGuids (childrenOf instead of identityChildren).
  it('duplicating the instance\'s parent: a ref to the moved member follows the copy through save + reload', async () => {
    await loaded();
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot'));
    const copyId = duplicateEntity(idAt('Holder'), () => {})!;
    rename(copyId, 'Copy');
    const live = targetsOf(copyId);
    expect(live[0]).toBe(guidAt('Copy/OuterRoot/Button'));
    await load(await serializeScene() as unknown as SceneData);
    expect(treePaths().get(targetsOf(idAt('Copy'))[0]!)).toBe('Copy/OuterRoot/Button');
  });

  // Mutation: have identityTree (memberHome.ts) use the live parent.
  it('the member path a template token names it by is its row path', async () => {
    await loaded();
    const button = idAt('Holder/OuterRoot/Panel/Button');
    reparentEntity(button, idAt('Holder/OuterRoot'));
    const index = memberPathIndex(getCurrentWorld(), idAt('Holder/OuterRoot'));
    expect(index.get('2.3')?.id()).toBe(button);
    expect(index.has('3')).toBe(false);
  });

  // A guid-less member derives along its HOME chain, through members (whose guids are derived, not anchors)
  // to the instance's anchor — so it gets back exactly the guid it loaded with. Mutations: drop the identity
  // re-parenting of rows in deriveInstanceMemberGuids; let a member's guid anchor the walk again.
  it('re-deriving a moved member gives it the guid it would derive at home', async () => {
    await loaded();
    const button = idAt('Holder/OuterRoot/Panel/Button');
    const before = guidAt('Holder/OuterRoot/Panel/Button');
    expect(before).toBe(deriveMemberGuid(ROOT, [2, 3]));
    reparentEntity(button, idAt('Holder/OuterRoot'));
    const e = [...getCurrentWorld().entities].find((x) => x.id() === button)!;
    const ea = getTraitByName('EntityAttributes')!;
    e.set(ea.trait, { ...(e.get(ea.trait) as object), guid: '' });
    deriveInstanceMemberGuids(getCurrentWorld());
    expect((e.get(ea.trait) as { guid: string }).guid).toBe(before);
  });
});

// #1437 P2a: the save records a member's new parent inside its own instance (`moved`: row localId → the
// new parent's guid), and the loader applies it after every guid is derived, so nothing's identity moves.
describe('a member moved inside its own instance is saved there (#1437)', () => {
  type Entry = { prefab?: string; members?: Record<string, { name?: string; parent?: string }>; removed?: number[]; added?: unknown[]; overrides?: Record<string, unknown> };
  const saved = async () => await serializeScene() as unknown as { entities: Entry[] };
  const outerEntry = (doc: { entities: Entry[] }) => viewEntry(doc.entities.find((e) => e.prefab === OUTER)!);
  const homeOf = (id: number): string => homeView(id).homeParent;

  // Mutation: make noteMove in captureInstanceStructure record nothing.
  it('round trip: the member reloads under its new parent, linked, with its guid, and a ref to it resolves', async () => {
    const refs = await loaded();
    const button = guidAt('Holder/OuterRoot/Panel/Button');
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot'));
    const doc = await saved();
    expect(movesOf(outerEntry(doc))).toEqual({ Button: ROOT });
    await load(doc as unknown as SceneData);
    expect(guidAt('Holder/OuterRoot/Button')).toBe(button);
    expect(homeOf(idAt('Holder/OuterRoot/Button'))).toBe(guidAt('Holder/OuterRoot/Panel'));
    // Every Holder ref still lands, the one to Button and the one below it (the added InnerRoot's Leaf).
    expect(targetsOf(idAt('Holder'))).toEqual(refs);
    expect(targetsOf(idAt('Holder')).map((g) => treePaths().get(g))).toEqual([
      'Holder/OuterRoot/Button', 'Holder/OuterRoot/Panel/InnerRoot/Leaf', 'Holder/OuterRoot/Button/InnerRoot/Leaf',
    ]);
    expect(movesOf(outerEntry(await saved()))).toEqual({ Button: ROOT }); // and a no-op save writes the same
  });

  // Mutation: have noteMove ignore `parentGuid !== home` (a round trip then writes a move to its own row).
  it('moved and moved back: nothing is written — no move, no pinned pose', async () => {
    await loaded();
    const button = idAt('Holder/OuterRoot/Panel/Button');
    reparentEntity(button, idAt('Holder/OuterRoot'));
    reparentEntity(button, idAt('Holder/OuterRoot/Panel'));
    const entry = outerEntry(await saved());
    expect(movesOf(entry)).toEqual({});
    expect(entry.overrides?.[3]).toBeUndefined();
  });

  // The owned nested root case from the issue body. Mutation: build nestedCandidates from live children
  // (childrenOf) instead of identityChildrenOf — the root is then read as user-added: captured as an
  // `added` reference with its row `removed`.
  it('an OWNED nested root moved to another member stays that row\'s expansion: a move, not a remove + add', async () => {
    await loaded();
    const leaf = guidAt('Holder/OuterRoot/Panel/InnerRoot/Leaf');
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Holder/OuterRoot'));
    const entry = outerEntry(await saved());
    expect(movesOf(entry)).toEqual({ InnerRoot: ROOT });
    expect(entry.removed).toBeUndefined();
    expect((entry.added ?? []).length).toBe(1); // only the scene's own AddedInner
    await load(await saved() as unknown as SceneData);
    expect(guidAt('Holder/OuterRoot/InnerRoot/Leaf')).toBe(leaf);
  });

  // Mutation: drop `moved` from captureNestedChannels' `live`.
  it('a member of an OWNED nested instance: the move is saved in that row\'s nestedStructure slot', async () => {
    const DEEP = 'aaaaaaaa-0000-4000-8000-0000000000d1';
    const CASE = 'aaaaaaaa-0000-4000-8000-0000000000d2';
    const CASE_ROOT = 'bbbbbbbb-0000-4000-8000-0000000000d2';
    const deepDoc = { id: DEEP, rootLocalId: 1, entities: [row(1, 'DeepRoot', 0), row(2, 'A', 1), row(3, 'B', 2)] };
    const caseDoc = { id: CASE, rootLocalId: 1, entities: [row(1, 'CaseRoot', 0), row(2, 'Slot', 1), row(3, 'Deep', 2, { prefab: DEEP })] };
    for (const [id, doc] of [[DEEP, deepDoc], [CASE, caseDoc]] as const) { prefabs.set(id, doc); setPrefabCache(id, doc as never); }
    try {
      await load({ id: 's', version: 1, name: 'S', resources: [], entities: [
        { id: 1, prefab: CASE, guid: CASE_ROOT, traits: { EntityAttributes: { name: 'CaseRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      ] } as unknown as SceneData);
      const b = guidAt('CaseRoot/Slot/DeepRoot/A/B');
      const deepRoot = guidAt('CaseRoot/Slot/DeepRoot');
      reparentEntity(idAt('CaseRoot/Slot/DeepRoot/A/B'), idAt('CaseRoot/Slot/DeepRoot'));
      const doc = await saved();
      expect(movesOf(doc.entities[0])).toEqual({ B: deepRoot });
      await load(doc as unknown as SceneData);
      expect(guidAt('CaseRoot/Slot/DeepRoot/B')).toBe(b);
    } finally { for (const id of [DEEP, CASE]) { prefabs.delete(id); setPrefabCache(id, null); } }
  });

  // Mutation: in subtractRevertedStructure, keep every move.
  it('Revert of the move puts the member back at its row, under the same guid', async () => {
    await loaded();
    const button = guidAt('Holder/OuterRoot/Panel/Button');
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot'));
    await revertOverridesSelective(idAt('Holder/OuterRoot'), new Set(['~moved.3']));
    expect(guidAt('Holder/OuterRoot/Panel/Button')).toBe(button);
    expect(movesOf(outerEntry(await saved()))).toEqual({});
  });

  // Its row parent removed, the moved member stays where it was put. Mutation: drop the `survivors` skip in
  // applyStructureCore (the removal takes Button with it), or delete the deferred rows immediately.
  it('the member\'s ROW parent deleted: the member survives the reload under its new parent, with its guid', async () => {
    await loaded();
    const button = guidAt('Holder/OuterRoot/Panel/Button');
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot'));
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel')]);
    const doc = await saved();
    expect(outerEntry(doc).removed).toEqual([2]);
    await load(doc as unknown as SceneData);
    expect(guidAt('Holder/OuterRoot/Button')).toBe(button);
    expect([...treePaths().values()].some((p) => p.includes('Panel'))).toBe(false);
  });

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

// #1437 P2b: a move that crosses frames stays linked and is saved by the MOVER's own instance — under a
// scene-added node, into a nested instance's members, out of one into its outer instance, into and out of
// a user-added instance. Only a move out of the OUTERMOST instance unpacks.
describe('a member moved across frames inside its outermost instance is saved (#1437)', () => {
  const SIGN = 'bbbbbbbb-0000-4000-8000-0000000000e1';
  type Node = { guid?: string; name?: string; prefab?: string; children?: Node[]; members?: Record<string, { name?: string; parent?: string }> };
  type Entry = { prefab?: string; members?: Record<string, { name?: string; parent?: string }>; added?: Node[]; nestedStructure?: Record<string, { added?: unknown[] }> };
  const saved = async () => await serializeScene() as unknown as { entities: Entry[] };
  const outerEntry = (doc: { entities: Entry[] }) => viewEntry(doc.entities.find((e) => e.prefab === OUTER)!);
  const isLinked = (id: number) => [...getCurrentWorld().entities].find((x) => x.id() === id)!.has(getTraitByName('PrefabInstance')!.trait as never);
  /** The scene, plus a scene-added plain `Sign` under Panel. */
  const withSign = (): SceneData => {
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    (sc.entities[1]!.added as unknown[]).push({ parentLocalId: 2, guid: SIGN, name: 'Sign', traits: { EntityAttributes: { name: 'Sign', parentId: 0 } }, children: [] });
    return sc as unknown as SceneData;
  };
  const roundTrip = async (): Promise<{ entities: Entry[] }> => {
    const doc = await saved();
    await load(doc as unknown as SceneData);
    return doc;
  };

  // Sign's own capture already skips Button (a member of the SAME instance); the movedIn skip is for a
  // member of ANOTHER instance, pinned by the next four. Mutation: make noteMove record nothing.
  it('under a scene-added node: recorded by its instance, not as the node\'s child', async () => {
    await load(withSign());
    const button = guidAt('Holder/OuterRoot/Panel/Button');
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot/Panel/Sign'));
    const doc = await roundTrip();
    expect(movesOf(outerEntry(doc))).toEqual({ Button: SIGN });
    expect(outerEntry(doc).added!.find((n) => n.guid === SIGN)!.children).toEqual([]);
    expect(guidAt('Holder/OuterRoot/Panel/Sign/Button')).toBe(button);
  });

  // This and the next three: drop the movedIn skip in captureInstanceStructure and the mover is ALSO
  // captured as an added child where it landed, so it reloads twice.
  it('into an owned nested instance\'s member: recorded by the outer instance', async () => {
    await load(scene([]));
    const button = guidAt('Holder/OuterRoot/Panel/Button');
    const leaf = guidAt('Holder/OuterRoot/Panel/InnerRoot/Leaf');
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'));
    const doc = await roundTrip();
    expect(movesOf(outerEntry(doc))).toEqual({ Button: leaf });
    expect(outerEntry(doc).nestedStructure).toBeUndefined();
    expect(guidAt('Holder/OuterRoot/Panel/InnerRoot/Leaf/Button')).toBe(button);
  });

  // Mutation: in reparentEntity, test containment against the mover's own instance (rootId) — the Leaf
  // then unpacks.
  it('out of an owned nested instance into its outer instance: stays linked, recorded in the row\'s slot', async () => {
    await load(scene([]));
    const leaf = guidAt('Holder/OuterRoot/Panel/InnerRoot/Leaf');
    const button = guidAt('Holder/OuterRoot/Panel/Button');
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel/Button'));
    expect(isLinked(idAt('Holder/OuterRoot/Panel/Button/Leaf'))).toBe(true);
    const doc = await roundTrip();
    expect(movesOf(outerEntry(doc))).toEqual({ Leaf: button }); // the chained key reaches the nested frame (D2(b))
    expect(guidAt('Holder/OuterRoot/Panel/Button/Leaf')).toBe(leaf);
    expect(isLinked(idAt('Holder/OuterRoot/Panel/Button/Leaf'))).toBe(true);
  });

  it('out of a USER-ADDED instance into its outer instance: recorded on the reference node', async () => {
    await load(scene([]));
    const leaf = guidAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf');
    const panel = guidAt('Holder/OuterRoot/Panel');
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
    const doc = await roundTrip();
    expect(movesOf(outerEntry(doc).added!.find((n) => n.guid === ANCHORED))).toEqual({ Leaf: panel });
    expect(guidAt('Holder/OuterRoot/Panel/Leaf')).toBe(leaf);
  });

  it('an owned nested root into a USER-ADDED instance\'s member: recorded by the outer instance', async () => {
    await load(scene([]));
    const leaf = guidAt('Holder/OuterRoot/Panel/InnerRoot/Leaf');
    const target = guidAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf');
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf'));
    const doc = await roundTrip();
    expect(movesOf(outerEntry(doc))).toEqual({ InnerRoot: target });
    expect(guidAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf/InnerRoot/Leaf')).toBe(leaf);
  });
});

// #1437 P1–P2b review. Each case was reproduced failing before its fix.
describe('moved members: review findings (#1437)', () => {
  type Entry = { prefab?: string; members?: Record<string, { name?: string; parent?: string }>; removed?: number[] };
  const saved = async () => await serializeScene() as unknown as { entities: Entry[] };
  const paths = () => [...treePaths().values()].sort();
  const withPrefab = async (id: string, doc: object, body: () => Promise<void>) => {
    prefabs.set(id, doc); setPrefabCache(id, doc as never);
    try { await body(); } finally { prefabs.delete(id); setPrefabCache(id, null); }
  };

  // F1. Mutation: shield the moved member's whole prefab subtree from removal (the old flat `survivors`).
  // (Letting the cascade run THROUGH a moved member is pinned by the row-parent-deleted cases instead.)
  it('a descendant of a moved member, deleted, stays deleted after reload', async () => {
    const P = 'aaaaaaaa-0000-4000-8000-0000000000f1';
    await withPrefab(P, { id: P, rootLocalId: 1, entities: [row(1, 'R', 0), row(2, 'A', 1), row(3, 'B', 2), row(4, 'C', 3), row(5, 'D', 1)] }, async () => {
      await load({ id: 's', version: 1, name: 'S', resources: [], entities: [
        { id: 1, prefab: P, guid: 'bbbbbbbb-0000-4000-8000-0000000000f1', traits: { EntityAttributes: { name: 'R', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      ] } as unknown as SceneData);
      reparentEntity(idAt('R/A/B'), idAt('R/D'));
      deleteEntitiesWithUndo([idAt('R/D/B/C')]);
      const before = paths();
      await load(await saved() as unknown as SceneData);
      expect(paths()).toEqual(before);
    });
  });

  // F2. Mutation: drop `moved: node.moved` from the editor's spawnNestedInstance.
  it('rebuilding the OUTER instance keeps a move inside its user-added nested instance', async () => {
    await load(scene([]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
    const before = paths();
    const root = idAt('Holder/OuterRoot');
    rebuildInstance(root, OUTER, outerDoc as never, captureInstanceOverrides(root, outerDoc as never), captureInstanceStructure(root, outerDoc as never));
    expect(paths()).toEqual(before);
  });

  // F3. Mutation: destroy parked entities with the rest (drop the park branch in rebuildInstance).
  it('rebuilding a user-added nested instance keeps an OUTER member moved into it', async () => {
    await load(scene([]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf'));
    const before = paths();
    const u = idAt('Holder/OuterRoot/Panel/Button/InnerRoot');
    rebuildInstance(u, INNER, innerDoc as never, captureInstanceOverrides(u, innerDoc as never), captureInstanceStructure(u, innerDoc as never));
    expect(paths()).toEqual(before);
    expect((await saved()).entities.find((e) => e.prefab === OUTER)!.removed).toBeUndefined();
  });

  // F4. Mutations: drop the gone-row steps from the resolver (`extra`); drop them from planCopyGuids' path.
  it('a duplicate made after the moved member\'s home was deleted: its ref survives save + reload', async () => {
    await loaded();
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot'));
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel')]);
    const copyId = duplicateEntity(idAt('Holder'), () => {})!;
    rename(copyId, 'Copy');
    const live = targetsOf(copyId)[0]!;
    expect(treePaths().get(live)).toBe('Copy/OuterRoot/Button');
    await load(await serializeScene() as unknown as SceneData);
    expect(targetsOf(idAt('Copy'))[0]).toBe(live);
    expect(treePaths().get(live)).toBe('Copy/OuterRoot/Button');
  });

  // The same, for a home UNPACKED (dragged out of the instance): an unpacked row is no longer in its frame, so the
  // resolver steps past it. Mutation: index a frame's rows by localId alone, member or not.
  it('a duplicate made after the moved member\'s home was UNPACKED: its ref survives save + reload', async () => {
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities.push({ id: 3, traits: { EntityAttributes: { name: 'Shelf', parentId: 0, guid: 'bbbbbbbb-0000-4000-8000-0000000000f4' } } });
    await load(sc as unknown as SceneData);
    const refs = [guidAt('Holder/OuterRoot/Panel/Button')];
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot'));
    reparentEntity(idAt('Holder/OuterRoot/Panel'), idAt('Shelf'));
    expect(treePaths().get(refs[0]!)).toBe('Holder/OuterRoot/Button');
    const copyId = duplicateEntity(idAt('Holder/OuterRoot'), () => {})!;
    rename(copyId, 'Copy');
    const copyButton = guidAt('Holder/Copy/Button');
    await load(await serializeScene() as unknown as SceneData);
    expect(treePaths().get(copyButton)).toBe('Holder/Copy/Button');
    expect(treePaths().get(refs[0]!)).toBe('Holder/OuterRoot/Button');
  });

  // F5/F6: until Apply learns to translate a move (P3), a TEMPLATE capture writes none — never a live scene
  // guid. Mutation: drop the `opts.template` return in noteMove.
  it('a prefab written from a tree holding moves carries no scene guid in a `moved`', async () => {
    await load(scene([]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
    const out = JSON.stringify(serializePrefab(idAt('Holder'), undefined));
    expect(out).not.toContain(guidAt('Holder/OuterRoot/Panel'));
  });

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

// #1437, second review of the fix commit. Each reproduced failing first (the reviewer's probes T1–T5).
describe('moved members: second review (#1437)', () => {
  const paths = () => [...treePaths().values()].sort();
  const piOf = (id: number) => [...getCurrentWorld().entities].find((x) => x.id() === id)!.get(getTraitByName('PrefabInstance')!.trait) as Record<string, unknown>;

  // (Written against a recorded home that an undo could restore half of; with nothing recorded it pins that the
  // undone state reads as unmoved.)
  it('undoing the move after undoing a home delete leaves no stale homeSteps, and a duplicate then keeps its refs', async () => {
    await loaded();
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot'));
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel')]);
    await undo(); await undo();
    const home = homeView(idAt('Holder/OuterRoot/Panel/Button'));
    expect({ hp: home.homeParent, hs: home.homeSteps }).toEqual({ hp: '', hs: '' });
    const copyId = duplicateEntity(idAt('Holder'), () => {})!;
    rename(copyId, 'Copy');
    const before = targetsOf(copyId).map((g) => treePaths().get(g));
    await load(await serializeScene() as unknown as SceneData);
    expect(targetsOf(idAt('Copy')).map((g) => treePaths().get(g))).toEqual(before);
  });

  // (Written against `isHomePosition` with steps present; it pins the same outcome against the document.)
  it('moved back to its row parent after a home delete + undo, it writes no `moved`', async () => {
    await loaded();
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot'));
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel')]);
    await undo(); // Panel back; Button (still moved) walks home through it by steps now
    reparentEntity(idAt('Holder/OuterRoot/Button'), idAt('Holder/OuterRoot/Panel'));
    expect(captureInstanceStructure(idAt('Holder/OuterRoot'), outerDoc as never).moved).toEqual({});
  });

  // Mutations: drop detachOrphanedMembers from deleteEntities; drop relinkDetachedMembers from the undo.
  it.each([
    ['a user-added nested instance', 'Holder/OuterRoot/Panel/Button/InnerRoot/Leaf', 'Holder/OuterRoot/Panel/Button/InnerRoot'],
    ['an owned nested instance', 'Holder/OuterRoot/Panel/InnerRoot/Leaf', 'Holder/OuterRoot/Panel/InnerRoot'],
  ])('deleting %s whose member moved out: the member survives the reload, and undo relinks it', async (_label, member, instance) => {
    await load(scene([]));
    reparentEntity(idAt(member), idAt('Holder/OuterRoot/Panel'));
    const leaf = guidAt('Holder/OuterRoot/Panel/Leaf');
    deleteEntitiesWithUndo([idAt(instance)]);
    const before = paths();
    await undo();
    expect(piOf(idAt('Holder/OuterRoot/Panel/Leaf')).rootInstanceId).toBe(idAt(instance));
    await redo();
    await load(await serializeScene() as unknown as SceneData);
    expect(paths()).toEqual(before);
    expect(treePaths().get(leaf)).toBe('Holder/OuterRoot/Panel/Leaf');
  });

  // Mutation: drop the home fallback in rebuildInstance's put-back (it then stays at the scene root).
  it('a rebuild that drops a parked member\'s parent row sends it home, inside its own instance', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await load(scene([]));
      reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf'));
      const n = guidAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf/InnerRoot');
      const u = idAt('Holder/OuterRoot/Panel/Button/InnerRoot');
      const inner2 = { id: INNER, rootLocalId: 1, entities: [row(1, 'InnerRoot', 0)] };
      rebuildInstance(u, INNER, inner2 as never, captureInstanceOverrides(u, innerDoc as never), captureInstanceStructure(u, innerDoc as never), innerDoc as never);
      expect(treePaths().get(n)).toBe('Holder/OuterRoot/Panel/InnerRoot');
      await load(await serializeScene() as unknown as SceneData);
      expect(treePaths().get(n)).toBe('Holder/OuterRoot/Panel/InnerRoot');
    } finally { warn.mockRestore(); }
  });
});

// #1437, third review. Each reproduced failing first (the reviewer's probes P1, P2, P4b).
describe('moved members: third review (#1437)', () => {
  const paths = () => [...treePaths().values()].sort();
  const piOf = (id: number) => [...getCurrentWorld().entities].find((x) => x.id() === id)!.get(getTraitByName('PrefabInstance')!.trait) as Record<string, unknown> | undefined;

  // Mutation: restore the `else` on the "is gone" warning in rebuildInstance's put-back.
  it('a normal put-back of a parked member warns about nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await load(scene([]));
      reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf'));
      const u = idAt('Holder/OuterRoot/Panel/Button/InnerRoot');
      rebuildInstance(u, INNER, innerDoc as never, captureInstanceOverrides(u, innerDoc as never), captureInstanceStructure(u, innerDoc as never));
      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('is gone'))).toEqual([]);
    } finally { warn.mockRestore(); }
  });

  // Mutation: drop the out-of-subtree pass in rebuildInstance's teardown — the moved-out owned root survives
  // beside its respawned replacement.
  it('rebuilding a nested instance whose OWNED nested root was moved out of it: one copy, still linked', async () => {
    const MID = 'aaaaaaaa-0000-4000-8000-0000000000c3';
    const OUT3 = 'aaaaaaaa-0000-4000-8000-0000000000c4';
    const midDoc = { id: MID, rootLocalId: 1, entities: [row(1, 'MidRoot', 0), row(2, 'Slot', 1), row(5, 'Nested', 1, { prefab: INNER })] };
    const out3Doc = { id: OUT3, rootLocalId: 1, entities: [row(1, 'OuterRoot', 0), row(2, 'Panel', 1), row(3, 'Nested', 2, { prefab: MID })] };
    for (const [id, doc] of [[MID, midDoc], [OUT3, out3Doc]] as const) { prefabs.set(id, doc); setPrefabCache(id, doc as never); }
    try {
      await load({ id: 'dup3', version: 1, name: 'S3', resources: [], entities: [
        { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
        { id: 2, prefab: OUT3, guid: ROOT, traits: { EntityAttributes: { name: 'OuterRoot', parentId: HOLDER }, Transform: { x: 0, y: 0, z: 0 } } },
      ] } as unknown as SceneData);
      reparentEntity(idAt('Holder/OuterRoot/Panel/MidRoot/InnerRoot'), idAt('Holder/OuterRoot/Panel'));
      const before = paths();
      const identities = treePaths();
      const m = idAt('Holder/OuterRoot/Panel/MidRoot');
      rebuildInstance(m, MID, midDoc as never, captureInstanceOverrides(m, midDoc as never), captureInstanceStructure(m, midDoc as never));
      // One InnerRoot at Panel (treePaths throws on two at one path), and every guid as it was — rebuilding an
      // owned nested instance used to re-anchor its members on the respawned root (the outer members' derived
      // guids read as anchors), Slot included, moved or not. Mutation: let a member's guid anchor
      // deriveInstanceMemberGuids' walk again.
      expect(paths()).toEqual(before);
      expect(treePaths()).toEqual(identities);
      expect(piOf(idAt('Holder/OuterRoot/Panel/InnerRoot'))?.parentLocalId).toBe(5);
      await load(await serializeScene() as unknown as SceneData);
      expect(paths()).toEqual(before);
      expect(treePaths()).toEqual(identities);
    } finally { for (const id of [MID, OUT3]) { prefabs.delete(id); setPrefabCache(id, null); } }
  });

  // Mutation: drop restoreRootLinks from deleteEntitiesWithUndo's undo.
  it.each([['root first', false], ['member first', true]])('multi-delete of an owned nested root and its moved-out member (%s), undone, round-trips', async (_l, memberFirst) => {
    await load(scene([]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
    const before = paths();
    const leaf = guidAt('Holder/OuterRoot/Panel/Leaf');
    const ids = [idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Holder/OuterRoot/Panel/Leaf')];
    deleteEntitiesWithUndo(memberFirst ? ids.reverse() : ids);
    await undo();
    expect(piOf(idAt('Holder/OuterRoot/Panel/Leaf'))?.rootInstanceId).toBe(idAt('Holder/OuterRoot/Panel/InnerRoot'));
    await load(await serializeScene() as unknown as SceneData);
    expect(paths()).toEqual(before);
    expect(treePaths().get(leaf)).toBe('Holder/OuterRoot/Panel/Leaf');
  });
});

// #1437 P3-a: Apply of a move whose new parent is a row of the SAME frame re-parents the row. That changes
// the path the moved member (and everything below it) derives its guid from, in EVERY instance, so every ref
// to one follows: live refs across the refresh, the template's own member tokens, and — through the backend
// route, checked here by its request — every other file.
describe('applying a move inside the instance re-parents the row and every ref follows (#1437 P3-a)', () => {
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
  const TARGETS = ['Holder/OuterRoot/Panel/Button', 'Holder2/OuterRoot/Panel/Button', 'Holder/OuterRoot/Panel/InnerRoot/Leaf', 'Holder2/OuterRoot/Panel/InnerRoot/Leaf'];
  const loadedTwo = async (): Promise<void> => {
    await load(twoInstances([]));
    await load(twoInstances(TARGETS.map(guidAt)));
  };
  const refPaths = () => targetsOf(idAt('Holder')).map((g) => treePaths().get(g));
  const repairs: { prefab: string; before: PrefabFile }[] = [];
  let repairReply: { status: number; body: Record<string, unknown> } = { status: 200, body: { ok: true, rewritten: [], held: [] } };
  /** Save, then reload with `doc` as the prefab on disk — what the next session sees. */
  const reloadWith = async (source: string, doc: PrefabFile): Promise<void> => {
    const saved = await serializeScene() as unknown as SceneData;
    prefabs.set(source, doc);
    setPrefabCache(source, doc);
    await load(saved);
  };

  beforeEach(() => {
    repairs.length = 0;
    repairReply = { status: 200, body: { ok: true, rewritten: [], held: [] } };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/prefab-member-paths')) {
        repairs.push(JSON.parse(String(init?.body)));
        const reply = repairReply;
        return { ok: reply.status < 400, status: reply.status, json: async () => reply.body } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  // Mutations: drop remapWorldGuidRefs (the Holder refs dangle); drop the Transform take (x stays 0); drop the
  // remap of the rebuild's structure (B's own move lands back at its row).
  it('a member moved to another row: every instance gets it, refs to it follow, and it reloads so', async () => {
    await loadedTwo();
    const a = idAt('Holder/OuterRoot');
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), a);
    writeTraitFieldWithUndo(idAt('Holder/OuterRoot/Button'), getTraitByName('Transform')!, 'x', 5);
    // B's own move targets the member whose guid the apply changes.
    reparentEntity(idAt('Holder2/OuterRoot/Panel/InnerRoot'), idAt('Holder2/OuterRoot/Panel/Button'));
    const result = await applyToPrefabSelective(a, new Set(['~moved.3']));
    expect(result.applied).toBe(true);
    expect(result.memberPathsChanged).toBe(true);
    const written = result.prefabAfter!;
    const row3 = written.entities.find((e) => e.localId === 3)!.traits as { EntityAttributes: { parentId: number }; Transform: { x: number } };
    expect(row3.EntityAttributes.parentId).toBe(1);
    expect(row3.Transform.x).toBe(5);
    const expected = ['Holder/OuterRoot/Button', 'Holder2/OuterRoot/Button', 'Holder/OuterRoot/Panel/InnerRoot/Leaf', 'Holder2/OuterRoot/Button/InnerRoot/Leaf'];
    expect(refPaths()).toEqual(expected);
    expect(homeView(idAt('Holder/OuterRoot/Button')).homeParent).toBe(''); // home now: the prefab says so
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.prefab).toBe(OUTER);
    expect((repairs[0]!.before.entities.find((e) => e.localId === 3)!.traits.EntityAttributes as { parentId: number }).parentId).toBe(2);
    await reloadWith(OUTER, written);
    expect(refPaths()).toEqual(expected);
  });

  // Mutation: have liveMemberGuidRemap pair by path instead of identity (memberPathRecords' id → path).
  it('a nested row moved: the members of its instance follow, in every instance', async () => {
    await loadedTwo();
    const a = idAt('Holder/OuterRoot');
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), a);
    const result = await applyToPrefabSelective(a, new Set(['~moved.4']));
    const expected = ['Holder/OuterRoot/Panel/Button', 'Holder2/OuterRoot/Panel/Button', 'Holder/OuterRoot/InnerRoot/Leaf', 'Holder2/OuterRoot/InnerRoot/Leaf'];
    expect(refPaths()).toEqual(expected);
    await reloadWith(OUTER, result.prefabAfter!);
    expect(refPaths()).toEqual(expected);
  });

  // Mutation: drop the rewritePrefabMemberTokens call in applyToPrefabSelective.
  it("the prefab's own member tokens follow the row, so every instance's template ref still lands", async () => {
    const tokened = { ...outerDoc, entities: outerDoc.entities.map((r) => (r.localId === 1 ? { ...r, traits: withUi(r.traits, ['@member:2.3']) } : r)) };
    prefabs.set(OUTER, tokened);
    setPrefabCache(OUTER, tokened as never);
    await loadedTwo();
    const a = idAt('Holder/OuterRoot');
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), a);
    const result = await applyToPrefabSelective(a, new Set(['~moved.3']));
    const rootBag = result.prefabAfter!.entities.find((e) => e.localId === 1)!.traits as { UIAction: { bindings: { target: string }[] } };
    expect(rootBag.UIAction.bindings.map((b) => b.target)).toEqual(['@member:3']);
    const check = () => {
      expect(targetsOf(idAt('Holder/OuterRoot')).map((g) => treePaths().get(g))).toEqual(['Holder/OuterRoot/Button']);
      expect(targetsOf(idAt('Holder2/OuterRoot')).map((g) => treePaths().get(g))).toEqual(['Holder2/OuterRoot/Button']);
    };
    check();
    await reloadWith(OUTER, result.prefabAfter!);
    check();
  });

  // The anchor of an OWNED nested instance is recovered by walking up (liveMemberGuidRemap's anchorOf).
  // Mutation: make anchorOf treat every root as its own anchor.
  it('applied on an owned nested instance: its members in every outer instance follow', async () => {
    const inner3 = { id: INNER, rootLocalId: 1, entities: [row(1, 'InnerRoot', 0), row(2, 'Leaf', 1), row(3, 'Stem', 2)] };
    prefabs.set(INNER, inner3);
    setPrefabCache(INNER, inner3 as never);
    const stems = ['Holder/OuterRoot/Panel/InnerRoot/Leaf/Stem', 'Holder2/OuterRoot/Panel/InnerRoot/Leaf/Stem'];
    await load(twoInstances([]));
    await load(twoInstances(stems.map(guidAt)));
    const nested = idAt('Holder/OuterRoot/Panel/InnerRoot');
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf/Stem'), nested);
    const result = await applyToPrefabSelective(nested, new Set(['~moved.3']));
    expect(result.applied).toBe(true);
    const expected = ['Holder/OuterRoot/Panel/InnerRoot/Stem', 'Holder2/OuterRoot/Panel/InnerRoot/Stem'];
    expect(refPaths()).toEqual(expected);
    await reloadWith(INNER, result.prefabAfter!);
    expect(refPaths()).toEqual(expected);
  });

  // P3-b, owner ruling (i): a move under a member of a NESTED instance writes the outer prefab only — its
  // prefab-level `moved` names the target by member token — and the member keeps its identity.
  // Mutations: drop the queuePrefabMoves call in instantiatePrefabIntoWorld (B's Button stays at Panel on
  // reload); resolve no token in drainAfterDerive (same); drop the doc-level branch in Apply (skipped instead of
  // written).
  it('under a member of a nested instance: every instance gets it, the nested prefab is untouched, no guid moves', async () => {
    await loadedTwo();
    const a = idAt('Holder/OuterRoot');
    const innerBefore = JSON.stringify(innerDoc);
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'));
    writeTraitFieldWithUndo(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf/Button'), getTraitByName('Transform')!, 'x', 7);
    const buttons = [guidAt('Holder/OuterRoot/Panel/InnerRoot/Leaf/Button'), guidAt('Holder2/OuterRoot/Panel/Button')];
    const result = await applyToPrefabSelective(a, new Set(['~moved.3']));
    expect(result.applied).toBe(true);
    expect(result.memberPathsChanged).toBeUndefined();
    expect(repairs).toHaveLength(0);
    const written = result.prefabAfter!;
    expect(written.moved).toEqual({ '2.3': '@member:2.4.2' }); // Button's path → Panel (2), the nested row (4), Leaf (2)
    const row3 = written.entities.find((e) => e.localId === 3)!.traits as { EntityAttributes: { parentId: number }; Transform: { x: number } };
    expect(row3.EntityAttributes.parentId).toBe(2);
    expect(row3.Transform.x).toBe(7);
    expect(JSON.stringify(innerDoc)).toBe(innerBefore);
    const expected = ['Holder/OuterRoot/Panel/InnerRoot/Leaf/Button', 'Holder2/OuterRoot/Panel/InnerRoot/Leaf/Button', 'Holder/OuterRoot/Panel/InnerRoot/Leaf', 'Holder2/OuterRoot/Panel/InnerRoot/Leaf'];
    expect(refPaths()).toEqual(expected);
    expect([guidAt('Holder/OuterRoot/Panel/InnerRoot/Leaf/Button'), guidAt('Holder2/OuterRoot/Panel/InnerRoot/Leaf/Button')]).toEqual(buttons);
    await reloadWith(OUTER, written);
    expect(refPaths()).toEqual(expected);
  });

  // Mutations: noteMove ignoring the prefab's move as the base (A writes a redundant move); the Transform
  // exemption ignoring it (A pins a Transform override); drainAfterDerive keeping the FIRST move per member
  // (B's own move back loses to the prefab's).
  it('after that apply: an instance at the prefab\'s target records nothing, and one moved back records the move', async () => {
    await loadedTwo();
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'));
    const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['~moved.3']));
    await reloadWith(OUTER, result.prefabAfter!);
    type Entry = { prefab?: string; guid?: string; members?: Record<string, { name?: string; parent?: string }>; overrides?: Record<string, unknown> };
    const entries = async () => (await serializeScene() as unknown as { entities: Entry[] }).entities;
    const a = (await entries()).find((e) => e.guid === ROOT)!;
    expect(movesOf(a)).toEqual({});
    expect(a.overrides?.[3]).toBeUndefined();
    reparentEntity(idAt('Holder2/OuterRoot/Panel/InnerRoot/Leaf/Button'), idAt('Holder2/OuterRoot/Panel'));
    const b = (await entries()).find((e) => e.guid === ROOT2)!;
    expect(movesOf(b)).toEqual({ Button: guidAt('Holder2/OuterRoot/Panel') });
    // The editor's own rebuild expands the prefab's move, then the instance's: the instance's wins.
    const bRoot = idAt('Holder2/OuterRoot');
    rebuildInstance(bRoot, OUTER, result.prefabAfter!, captureInstanceOverrides(bRoot, result.prefabAfter!), captureInstanceStructure(bRoot, result.prefabAfter!));
    expect(idAt('Holder2/OuterRoot/Panel/Button')).toBeGreaterThan(0);
    await load(await serializeScene() as unknown as SceneData);
    expect(treePaths().get(guidAt('Holder2/OuterRoot/Panel/Button'))).toBe('Holder2/OuterRoot/Panel/Button');
    expect(treePaths().get(guidAt('Holder/OuterRoot/Panel/InnerRoot/Leaf/Button'))).toBe('Holder/OuterRoot/Panel/InnerRoot/Leaf/Button');
    // At the prefab's target the member is at its base, so an unmarked pose is not pinned: a later prefab
    // edit of that row's Transform still reaches it.
    const edited = { ...result.prefabAfter!, entities: result.prefabAfter!.entities.map((r) => (r.localId === 3
      ? { ...r, traits: { ...r.traits, Transform: { ...(r.traits.Transform as object), x: 9 } } } : r)) } as PrefabFile;
    expect(captureInstanceOverrides(idAt('Holder/OuterRoot'), edited)[3]?.Transform).toBeUndefined();
  });

  // Mutations: stop passing `promotedRows` to insertAddedSubtree (the move is then skipped as added-in-scene);
  // drop the `!addedGuids.has` check (the move is written as a token naming a node only this scene has); record
  // a promoted REFERENCE node in promotedRows (the row is hung under a nested instance's root).
  it('under a node the same apply promotes: a plain one takes the row; a nested instance, or no promotion, is skipped', async () => {
    const PLAIN = 'bbbbbbbb-0000-4000-8000-0000000000cb';
    const withPlain = scene([]);
    (withPlain.entities[1] as { added: unknown[] }).added.push({ parentLocalId: 1, guid: PLAIN, name: 'Plain', traits: { EntityAttributes: { name: 'Plain' }, Transform: { x: 0, y: 0, z: 0 } }, children: [] });
    await load(withPlain);
    const a = idAt('Holder/OuterRoot');
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot/Plain'));
    expect((await applyToPrefabSelective(a, new Set(['~moved.3']))).skipped)
      .toEqual([{ key: '~moved.3', reason: 'its new parent was added in this scene — apply that addition too' }]);
    const both = await applyToPrefabSelective(a, new Set([`+added.${PLAIN}`, '~moved.3']));
    expect(both.applied).toBe(true);
    const plainRow = both.prefabAfter!.entities.find((e) => e.name === 'Plain')!;
    expect((both.prefabAfter!.entities.find((e) => e.localId === 3)!.traits.EntityAttributes as { parentId: number }).parentId).toBe(plainRow.localId);

    // The apply above left its written prefab in the editor cache while this file's loader reads the
    // `prefabs` map: without the reset the reload expands the OLD document under a cache holding the new one —
    // a split production never makes, and the stale frame the #1483 guard rightly refuses.
    setPrefabCache(OUTER, outerDoc as never);
    await load(scene([]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Holder/OuterRoot/Panel/Button/InnerRoot'));
    const ref = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set([`+added.${ANCHORED}`, '~moved.4']));
    expect(ref.skipped?.map((x) => x.key)).toEqual(['~moved.4']);
    expect((ref.prefabAfter!.entities.find((e) => e.localId === 4)!.traits.EntityAttributes as { parentId: number }).parentId).toBe(2);
  });

  // F3 (P3-a review): what the disk repair did reaches the caller, and a file left unrepaired is named.
  // Mutations: drop `fileRepair` from the result; drop the held warning in repairPrefabMemberPaths.
  it('the file repair\'s outcome is reported: rewritten, held (named in a warning), or failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await loadedTwo();
      reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot'));
      repairReply = { status: 200, body: { ok: true, rewritten: ['/s.scene.json'], held: ['/p.prefab.json'] } };
      const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['~moved.3']));
      expect(result.fileRepair).toEqual({ rewritten: ['/s.scene.json'], held: ['/p.prefab.json'] });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('NOT repaired in /p.prefab.json'))).toBe(true);
      setPrefabCache(OUTER, outerDoc as never); // the apply above left its written prefab there
      await load(twoInstances([]));
      reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot'));
      repairReply = { status: 503, body: { ok: false, error: 'no renderer' } };
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['~moved.3']))).fileRepair).toBeNull();
    } finally { vi.restoreAllMocks(); }
  });

  // F4 (P3-a review): undo repairs the files back to the prefab it restores, and redo forward again — each
  // from the document the files were last repaired for. Mutation: swap the two `repairFrom` arguments.
  it('undo and redo of an applied move repair the files in the matching direction', async () => {
    await loadedTwo();
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot'));
    const parentOf3 = (doc: PrefabFile) => (doc.entities.find((e) => e.localId === 3)!.traits.EntityAttributes as { parentId: number }).parentId;
    await applyToPrefabWithUndo(idAt('Holder/OuterRoot'), new Set(['~moved.3']));
    await undo();
    await redo();
    expect(repairs.map((r) => [r.prefab, parentOf3(r.before)])).toEqual([[OUTER, 2], [OUTER, 1], [OUTER, 2]]);
  });

  // Review F6: what the Apply dialog tells the person. Mutations: drop either branch of applyOutcomeNotice.
  it('the dialog\'s notice names skipped moves and unrepaired files, and is silent when nothing was left', () => {
    expect(applyOutcomeNotice({})).toBeNull();
    expect(applyOutcomeNotice({ memberPathsChanged: true, fileRepair: { rewritten: ['/a'], held: [] } })).toBeNull();
    expect(applyOutcomeNotice({ skipped: [{ key: '~moved.3', reason: 'its new parent was added in this scene' }] }))
      .toBe('Apply to Prefab: 1 move was not applied: its new parent was added in this scene.');
    expect(applyOutcomeNotice({ memberPathsChanged: true, fileRepair: { rewritten: [], held: ['/p.prefab.json'] } }))
      .toContain('/p.prefab.json were not repaired');
    expect(applyOutcomeNotice({ memberPathsChanged: true, fileRepair: null })).toContain('could NOT be repaired');
  });

  // #1468 close-out review F4: a REFUSAL is not a partial outcome. `skipped` means "everything else
  // landed, these keys did not", and this function words it as a MOVE because a move is the only
  // thing that has ever populated it — so a refusal riding that channel told the human "1 move was
  // not applied: prefab format 6 is newer than 5", which is wrong about the count, the noun and the
  // outcome. Mutation: delete the `result.refused` early return and this goes red.
  it('a refusal says nothing was applied, and never calls itself a move', () => {
    const notice = applyOutcomeNotice({ refused: '"x.prefab.json" was written by a newer build (prefab format 6; this build writes 5)' })!;
    expect(notice).toBe('Apply to Prefab: nothing was applied — "x.prefab.json" was written by a newer build (prefab format 6; this build writes 5).');
    expect(notice).not.toContain('move');
    // …and it wins over anything else the result happens to carry, because nothing else happened.
    expect(applyOutcomeNotice({ refused: 'r', skipped: [{ key: 'k', reason: 'why' }], memberPathsChanged: true, fileRepair: null }))
      .toBe('Apply to Prefab: nothing was applied — r.');
  });

  // F2 (P3-a review): an ORPHAN row (parentId 0) hangs off the instance's parent and derives from ITS anchor, so
  // moving it into the instance changes its anchor as well as its path. Mutation: walk memberPathRecords with
  // orphans 'skip' in liveMemberGuidRemap (both refs dangle).
  it('an orphan row moved into the instance: refs to it and below it follow', async () => {
    const orphaned = { ...outerDoc, entities: [...outerDoc.entities.map((r) => (r.localId === 3 ? row(3, 'Button', 0) : r)), row(5, 'Knob', 3)] };
    prefabs.set(OUTER, orphaned);
    setPrefabCache(OUTER, orphaned as never);
    await load(twoInstances([]));
    await load(twoInstances(['Holder/Button', 'Holder/Button/Knob'].map(guidAt)));
    reparentEntity(idAt('Holder/Button'), idAt('Holder/OuterRoot/Panel'));
    const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['~moved.3']));
    expect(result.memberPathsChanged).toBe(true);
    const expected = ['Holder/OuterRoot/Panel/Button', 'Holder/OuterRoot/Panel/Button/Knob'];
    expect(refPaths()).toEqual(expected);
    await reloadWith(OUTER, result.prefabAfter!);
    expect(refPaths()).toEqual(expected);
  });

  // F1 (P3-a review): a nested instance's ROOT as the new parent. A row hung there would share a path — and
  // so a guid — with the nested prefab's own row of the same localId. Mutation: drop the ownedNested exclusion.
  it('under a nested instance\'s root: written as the prefab\'s own move, and no two members share a guid', async () => {
    const inner3 = { id: INNER, rootLocalId: 1, entities: [row(1, 'InnerRoot', 0), row(2, 'Leaf', 1), row(3, 'Twig', 1)] };
    prefabs.set(INNER, inner3);
    setPrefabCache(INNER, inner3 as never);
    await loadedTwo();
    const a = idAt('Holder/OuterRoot');
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot/Panel/InnerRoot'));
    const result = await applyToPrefabSelective(a, new Set(['~moved.3']));
    expect(result.prefabAfter!.moved).toEqual({ '2.3': '@member:2.4' });
    expect((result.prefabAfter!.entities.find((e) => e.localId === 3)!.traits.EntityAttributes as { parentId: number }).parentId).toBe(2);
    await reloadWith(OUTER, result.prefabAfter!);
    const guids = getAllEntities().map((e) => e.guid).filter(Boolean);
    expect(new Set(guids).size).toBe(guids.length);
    expect(idAt('Holder2/OuterRoot/Panel/InnerRoot/Button')).toBeGreaterThan(0);
  });

  // P3-c: promoting a user-added nested instance carries its own moves into the prefab's `moved`, the member
  // addressed through the new row. Mutation: drop the promoteReferenceMoves call (Leaf reloads at its row).
  it('promoting a user-added instance keeps the moves made inside it', async () => {
    await load(scene([]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
    const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set([`+added.${ANCHORED}`]));
    const promoted = result.prefabAfter!.entities.find((e) => e.prefab === INNER && e.localId !== 4)!;
    expect(result.prefabAfter!.moved).toEqual({ [`2.3.${promoted.localId}.2`]: '@member:2' });
    await reloadWith(OUTER, result.prefabAfter!);
    expect(idAt('Holder/OuterRoot/Panel/Leaf')).toBeGreaterThan(0);
    expect(idAt('Holder/OuterRoot/Panel/Button/InnerRoot')).toBeGreaterThan(0);
  });

  // The same through the LEGACY map (#1468 Phase 3 close-out): a pre-v5 INNER has no rows, so the reference
  // node carries Leaf's move in `moved`, and the promotion must read it there too. Mutation: drop the
  // `node.moved` loop in promoteReferenceMoves (Leaf reloads at its row).
  it('promoting a user-added instance of a PRE-v5 prefab keeps the moves made inside it', async () => {
    const v4 = { id: INNER, version: 4, rootLocalId: 1, entities: innerDoc.entities.map(({ nodeGuid: _n, ...r }) => r) };
    prefabs.set(INNER, v4);
    setPrefabCache(INNER, v4 as never);
    await load(scene([]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
    const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set([`+added.${ANCHORED}`]));
    const promoted = result.prefabAfter!.entities.find((e) => e.prefab === INNER && e.localId !== 4)!;
    expect(result.prefabAfter!.moved).toEqual({ [`2.3.${promoted.localId}.2`]: '@member:2' });
    await reloadWith(OUTER, result.prefabAfter!);
    expect(idAt('Holder/OuterRoot/Panel/Leaf')).toBeGreaterThan(0);
  });

  // Second close-out review, F3: a promoted reference node's own NESTED rows travel as `nestedStructure`,
  // and a pre-v5 member's move there is a legacy `moved` whose value is a LIVE scene guid. A template
  // must never carry one (#1293's rule); `toTemplateStructure` copied it through. Mutation: keep
  // `moved` in toTemplateStructure.
  it('promoting a reference node writes no live guid from a nested row`s legacy `moved`', async () => {
    const REFP = 'aaaaaaaa-0000-4000-8000-0000000001b1';
    const v4Inner = { id: INNER, version: 4, rootLocalId: 1, entities: innerDoc.entities.map(({ nodeGuid: _n, ...r }) => r) };
    const refDoc = { id: REFP, rootLocalId: 1, entities: [row(1, 'RRoot', 0), row(2, 'Nested', 1, { prefab: INNER })] };
    prefabs.set(INNER, v4Inner); setPrefabCache(INNER, v4Inner as never);
    prefabs.set(REFP, refDoc); setPrefabCache(REFP, refDoc as never);
    try {
      const sc = JSON.parse(JSON.stringify(scene([]))) as { entities: Array<Record<string, unknown>> };
      (sc.entities[1]!.added as Array<Record<string, unknown>>)[0] = { parentLocalId: 3, guid: ANCHORED, name: 'RRoot', prefab: REFP, traits: {}, children: [] };
      await load(sc as unknown as SceneData);
      reparentEntity(idAt('Holder/OuterRoot/Panel/Button/RRoot/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel/Button/RRoot'));
      const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set([`+added.${ANCHORED}`]));
      expect(JSON.stringify(result.prefabAfter)).not.toContain(ANCHORED);
    } finally { prefabs.delete(REFP); setPrefabCache(REFP, null); }
  });

  // #1480 part 1: a pre-v5 member's move inside a reference node's NESTED row is a legacy `moved` on that
  // row's `nestedStructure`, and the promotion never read it — Leaf reloaded back under its row. Mutation:
  // drop the `nestedStructure` loop in promoteReferenceMoves (Leaf reloads at …/RRoot/InnerRoot/Leaf).
  it('promoting a reference node keeps a pre-v5 move made inside its nested row (#1480)', async () => {
    const REFP = 'aaaaaaaa-0000-4000-8000-0000000001b1';
    const v4Inner = { id: INNER, version: 4, rootLocalId: 1, entities: innerDoc.entities.map(({ nodeGuid: _n, ...r }) => r) };
    const refDoc = { id: REFP, rootLocalId: 1, entities: [row(1, 'RRoot', 0), row(2, 'Nested', 1, { prefab: INNER })] };
    prefabs.set(INNER, v4Inner); setPrefabCache(INNER, v4Inner as never);
    prefabs.set(REFP, refDoc); setPrefabCache(REFP, refDoc as never);
    try {
      const sc = JSON.parse(JSON.stringify(scene([]))) as { entities: Array<Record<string, unknown>> };
      (sc.entities[1]!.added as Array<Record<string, unknown>>)[0] = { parentLocalId: 3, guid: ANCHORED, name: 'RRoot', prefab: REFP, traits: {}, children: [] };
      await load(sc as unknown as SceneData);
      reparentEntity(idAt('Holder/OuterRoot/Panel/Button/RRoot/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel/Button/RRoot'));
      const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set([`+added.${ANCHORED}`]));
      const promoted = result.prefabAfter!.entities.find((e) => e.prefab === REFP)!;
      // Leaf is row 2 of INNER, reached through REFP's row 2, reached through the new row; its new parent is
      // the promoted row's own root.
      expect(result.prefabAfter!.moved).toEqual({ [`2.3.${promoted.localId}.2.2`]: `@member:2.3.${promoted.localId}` });
      await reloadWith(OUTER, result.prefabAfter!);
      expect(idAt('Holder/OuterRoot/Panel/Button/RRoot/Leaf')).toBeGreaterThan(0);
      expect(() => idAt('Holder/OuterRoot/Panel/Button/RRoot/InnerRoot/Leaf')).toThrow();
    } finally { prefabs.delete(REFP); setPrefabCache(REFP, null); }
  });

  // #1480 part 2: a legacy `moved` localId names a row of the reference node's OWN frame. The old lookup
  // matched an owned nested root by `parentLocalId` at ANY depth, so a deeper frame's root at the same number
  // could take the move. ⚠️ The old `find()` PASSES this fixture — its spawn order finds Kid first, as the reviewer's
  // fixture did, so the defect is still untriggered — and what this pins is the new lookup's frame scoping.
  // Mutation: drop the frame from the lookup (match `rowLocalId` alone) and InnerRoot takes the move.
  it('promoting a reference node resolves a pre-v5 move in the node`s own frame, not a deeper one (#1480)', async () => {
    const REFP = 'aaaaaaaa-0000-4000-8000-0000000001b3';
    const MID = 'aaaaaaaa-0000-4000-8000-0000000001b4';
    const strip = <T extends { nodeGuid?: string }>(r: T) => { const { nodeGuid: _n, ...rest } = r; return rest; };
    // MID's row 3 is a nested INNER, so INNER's root is an owned root with parentLocalId 3 — the same number
    // as REFP's own plain row 3 (Kid), which is the member actually moved. MID's row is listed FIRST in the
    // reference prefab so its expansion is spawned (and indexed) before Kid.
    const midDoc = { id: MID, version: 4, rootLocalId: 1, entities: [row(1, 'MidRoot', 0), row(3, 'InnerSlot', 1, { prefab: INNER })].map(strip) };
    const refDoc = { id: REFP, version: 4, rootLocalId: 1, entities: [row(1, 'RRoot', 0), row(2, 'MidNested', 1, { prefab: MID }), row(3, 'Kid', 1)].map(strip) };
    prefabs.set(MID, midDoc); setPrefabCache(MID, midDoc as never);
    prefabs.set(REFP, refDoc); setPrefabCache(REFP, refDoc as never);
    try {
      const sc = JSON.parse(JSON.stringify(scene([]))) as { entities: Array<Record<string, unknown>> };
      (sc.entities[1]!.added as Array<Record<string, unknown>>)[0] = { parentLocalId: 3, guid: ANCHORED, name: 'RRoot', prefab: REFP, traits: {}, children: [] };
      await load(sc as unknown as SceneData);
      reparentEntity(idAt('Holder/OuterRoot/Panel/Button/RRoot/Kid'), idAt('Holder/OuterRoot/Panel'));
      const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set([`+added.${ANCHORED}`]));
      const promoted = result.prefabAfter!.entities.find((e) => e.prefab === REFP)!;
      expect(result.prefabAfter!.moved).toEqual({ [`2.3.${promoted.localId}.3`]: '@member:2' });
      await reloadWith(OUTER, result.prefabAfter!);
      expect(idAt('Holder/OuterRoot/Panel/Kid')).toBeGreaterThan(0);
      expect(idAt('Holder/OuterRoot/Panel/Button/RRoot/MidRoot/InnerRoot')).toBeGreaterThan(0);
    } finally { prefabs.delete(REFP); setPrefabCache(REFP, null); prefabs.delete(MID); setPrefabCache(MID, null); }
  });

  // #1482: a rebuild of the OUTER instance (Refresh / Apply / Revert) respawns a user-added reference node
  // inside it, and must put back the member guids that node's rows store — the loader pins them, and a
  // rebuild that let them re-derive left anything naming them by guid dangling: here, an outer member's
  // row `parent`. Mutation: drop the reference-node restore in rebuildInstance (Kid re-derives, InnerRoot
  // falls back to its row).
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
      return rebuildInstance(id, OUTER, outerDoc as never, captureInstanceOverrides(id, outerDoc as never), captureInstanceStructure(id, outerDoc as never));
    };
    beforeEach(() => { prefabs.set(REFP, refDoc); setPrefabCache(REFP, refDoc as never); });
    afterEach(() => { prefabs.delete(REFP); setPrefabCache(REFP, null); });

    it('on a reference node under an outer member: the guid stands, and an outer move onto it survives', async () => {
      const sc = JSON.parse(JSON.stringify(scene([]))) as { entities: Array<Record<string, unknown>> };
      (sc.entities[1]!.added as Array<Record<string, unknown>>)[0] = refNode({ parentLocalId: 3 });
      await load(sc as unknown as SceneData);
      expect(guidAt('Holder/OuterRoot/Panel/Button/RRoot/Kid')).toBe(KID);   // precondition: the loader pinned it
      reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Holder/OuterRoot/Panel/Button/RRoot/Kid'));
      await load(await serializeScene() as unknown as SceneData);
      refresh('Holder/OuterRoot');
      expect(guidAt('Holder/OuterRoot/Panel/Button/RRoot/Kid')).toBe(KID);
      expect(idAt('Holder/OuterRoot/Panel/Button/RRoot/Kid/InnerRoot/Leaf')).toBeGreaterThan(0);
      await load(await serializeScene() as unknown as SceneData);
      expect(guidAt('Holder/OuterRoot/Panel/Button/RRoot/Kid')).toBe(KID);
      expect(idAt('Holder/OuterRoot/Panel/Button/RRoot/Kid/InnerRoot/Leaf')).toBeGreaterThan(0);
    });

    it('on a reference node inside an owned nested row`s expansion: the guid stands', async () => {
      const sc = JSON.parse(JSON.stringify(scene([]))) as { entities: Array<Record<string, unknown>> };
      sc.entities[1]!.added = [];
      sc.entities[1]!.nestedStructure = { 4: { added: [refNode({ parentLocalId: 1 })] } };
      await load(sc as unknown as SceneData);
      expect(guidAt('Holder/OuterRoot/Panel/InnerRoot/RRoot/Kid')).toBe(KID);   // precondition
      refresh('Holder/OuterRoot');
      expect(guidAt('Holder/OuterRoot/Panel/InnerRoot/RRoot/Kid')).toBe(KID);
    });

    it('a move made INSIDE the reference node survives the outer rebuild', async () => {
      const sc = JSON.parse(JSON.stringify(scene([]))) as { entities: Array<Record<string, unknown>> };
      (sc.entities[1]!.added as Array<Record<string, unknown>>)[0] = refNode({ parentLocalId: 3 });
      await load(sc as unknown as SceneData);
      reparentEntity(idAt('Holder/OuterRoot/Panel/Button/RRoot/Kid2'), idAt('Holder/OuterRoot/Panel/Button/RRoot/Kid'));
      refresh('Holder/OuterRoot');
      expect(idAt('Holder/OuterRoot/Panel/Button/RRoot/Kid/Kid2')).toBeGreaterThan(0);
      expect(guidAt('Holder/OuterRoot/Panel/Button/RRoot/Kid')).toBe(KID);
    });

    // The production seam (close-out review): Apply to Prefab rebuilds every instance of the source, and
    // that rebuild is where the reference node's rows must be carried — not only a direct rebuildInstance.
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

  // Review F1: applying the removal of a row that held a moved member. The cascade stops at the member, whose
  // row goes up to the nearest row that stays. Mutation: cascade through moved rows (movedRowsOf → empty).
  it('removing the row a member was moved out of keeps the member, in every instance', async () => {
    await loadedTwo();
    const a = idAt('Holder/OuterRoot');
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), a);
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), a);
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel')]);
    const result = await applyToPrefabSelective(a, new Set(['-removed.2']));
    expect(result.prefabAfter!.entities.map((e) => e.localId).sort()).toEqual([1, 3, 4]);
    expect(refPaths()).toEqual(['Holder/OuterRoot/Button', 'Holder2/OuterRoot/Button', 'Holder/OuterRoot/InnerRoot/Leaf', 'Holder2/OuterRoot/InnerRoot/Leaf']);
    await reloadWith(OUTER, result.prefabAfter!);
    expect(refPaths()).toEqual(['Holder/OuterRoot/Button', 'Holder2/OuterRoot/Button', 'Holder/OuterRoot/InnerRoot/Leaf', 'Holder2/OuterRoot/InnerRoot/Leaf']);
  });

  // Found under review F1: an owned nested root moved out of a row that was then deleted re-homes past it
  // (`homeSteps`), and the capture must still see it as its row's expansion — a move, not a user-added instance.
  // Mutation: key nestedCandidates by the home member only.
  it('an owned nested root moved out of a row that was then deleted: saved as a move, and reloads linked', async () => {
    await load(scene([]));
    const leaf = guidAt('Holder/OuterRoot/Panel/InnerRoot/Leaf');
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Holder/OuterRoot'));
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel')]);
    const doc = await serializeScene() as unknown as { entities: { prefab?: string; members?: Record<string, { name?: string; parent?: string }>; added?: { prefab?: string }[] }[] };
    const entry = doc.entities.find((e) => e.prefab === OUTER)!;
    expect(movesOf(entry)).toEqual({ InnerRoot: ROOT });
    expect((entry.added ?? []).filter((n) => n.prefab === INNER)).toHaveLength(0);
    await load(doc as unknown as SceneData);
    expect(guidAt('Holder/OuterRoot/InnerRoot/Leaf')).toBe(leaf);
  });

  // Review F1/F8, the prefab's own move: the member's row goes up and its key follows; removing the move's
  // TARGET drops the entry, which names nothing now. Mutation: drop the stale-entry filter.
  it('removing rows around a prefab\'s own move: the key follows a lifted row, and a move to nothing is dropped', async () => {
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
      expect(lifted.prefabAfter!.moved).toEqual({ 3: '@member:4.2' });
      expect(idAt('Holder2/OuterRoot/InnerRoot/Leaf/Button')).toBeGreaterThan(0);
      deleteEntitiesWithUndo([idAt('Holder/OuterRoot/InnerRoot')]);
      const gone = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['-removed.4']));
      expect(gone.prefabAfter!.moved).toBeUndefined();
      expect(idAt('Holder2/OuterRoot/Button')).toBeGreaterThan(0);
    } finally { prefabs.delete(OUTER_M); setPrefabCache(OUTER_M, null); }
  });

  // Owner's B: a NESTED instance's member moved out of it is applied from the OUTER instance, into the outer
  // prefab's own `moved`, with its pose on the nested row; the nested prefab is untouched and no guid moves.
  // Mutations: drop the nested keys from collectInstanceOverrideKeys; drop the `key.includes(':')` branch in
  // Apply (the key is then read as a row and nothing is written); drop the pose write.
  it('a nested member moved out of its instance: offered to the outer instance, and applied there', async () => {
    await loadedTwo();
    const a = idAt('Holder/OuterRoot');
    const innerBefore = JSON.stringify(innerDoc);
    const leaves = TARGETS.slice(2).map(guidAt);
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
    writeTraitFieldWithUndo(idAt('Holder/OuterRoot/Panel/Leaf'), getTraitByName('Transform')!, 'x', 3);
    expect(inLocalIds(collectInstanceOverrideKeys(a, outerDoc as never).moved, outerDoc)).toContain('~moved.4:2');
    const result = await applyToPrefabSelective(a, new Set(['~moved.4:2']));
    expect(result.applied).toBe(true);
    expect(result.prefabAfter!.moved).toEqual({ '2.4.2': '@member:2' });
    const row4 = result.prefabAfter!.entities.find((e) => e.localId === 4)!;
    expect((row4.overrides as Record<number, { Transform: { x: number } }>)[2].Transform.x).toBe(3);
    expect(JSON.stringify(innerDoc)).toBe(innerBefore);
    const expected = ['Holder/OuterRoot/Panel/Button', 'Holder2/OuterRoot/Panel/Button', 'Holder/OuterRoot/Panel/Leaf', 'Holder2/OuterRoot/Panel/Leaf'];
    expect(refPaths()).toEqual(expected);
    expect([guidAt('Holder/OuterRoot/Panel/Leaf'), guidAt('Holder2/OuterRoot/Panel/Leaf')]).toEqual(leaves);
    type Entry = { guid?: string; members?: Record<string, { name?: string; parent?: string }>; };
    const entryA = (await serializeScene() as unknown as { entities: Entry[] }).entities.find((e) => e.guid === ROOT)!;
    expect(movesOf(entryA)).toEqual({});
    await reloadWith(OUTER, result.prefabAfter!);
    expect(refPaths()).toEqual(expected);
  });

  // Mutations: drop the `drop` pass in rebuildInstance (the revert leaves Leaf moved); drop the `set` pass (the
  // undo does not bring it back).
  it('reverting that move from the outer instance puts it back, and undoing the revert moves it again', async () => {
    await load(scene([]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
    const reverted = (await revertOverridesSelective(idAt('Holder/OuterRoot'), new Set(['~moved.4:2'])))!;
    expect(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf')).toBeGreaterThan(0);
    rebuildInstance(reverted.newRootId, reverted.source, reverted.prefab, reverted.fullOverrides, reverted.fullStructure);
    expect(idAt('Holder/OuterRoot/Panel/Leaf')).toBeGreaterThan(0);
  });

  // A move INSIDE the nested instance is its own prefab's to record, applied from there. Mutation: drop the
  // inFrame filter in nestedFrameMoves.
  it('a move inside the nested instance is not offered to the outer one', async () => {
    const inner3 = { id: INNER, rootLocalId: 1, entities: [row(1, 'InnerRoot', 0), row(2, 'Leaf', 1), row(3, 'Twig', 1)] };
    prefabs.set(INNER, inner3);
    setPrefabCache(INNER, inner3 as never);
    await loadedTwo();
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Twig'), idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'));
    expect(collectInstanceOverrideKeys(idAt('Holder/OuterRoot'), outerDoc as never).moved).toEqual([]);
    expect(inLocalIds(collectInstanceOverrideKeys(idAt('Holder/OuterRoot/Panel/InnerRoot'), inner3 as never).moved, inner3)).toEqual(['~moved.3']);
  });

  // P3-d: the key surfaces offer a move for Apply, not only for Revert. Mutations: push the moved keys back into
  // applyExcluded; drop the `~moved` line from applyToPrefab's key set.
  it('a move is an applyable key, and "apply everything" applies it', async () => {
    await loadedTwo();
    const a = idAt('Holder/OuterRoot');
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), a);
    const keys = collectInstanceOverrideKeys(a, outerDoc as never);
    expect(inLocalIds(keys.moved, outerDoc)).toEqual(['~moved.3']);
    expect(inLocalIds(keys.all, outerDoc)).toContain('~moved.3');
    expect(inLocalIds(keys.applyExcluded, outerDoc)).not.toContain('~moved.3');
    await applyToPrefab(a);
    const row3 = (getCachedPrefabSync(OUTER) as PrefabFile).entities.find((e) => e.localId === 3)!;
    expect((row3.traits.EntityAttributes as { parentId: number }).parentId).toBe(1);
  });

  // A member of a NESTED instance moved out into the outer one: the nested prefab cannot say it, and the reason
  // says why. Mutation: drop the nested-instance branch of the reason.
  it('applied on a nested instance whose member moved out of it: skipped, with the reason', async () => {
    await load(scene([]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
    const result = await applyToPrefabSelective(idAt('Holder/OuterRoot/Panel/InnerRoot'), new Set(['~moved.2']));
    expect(result.skipped).toEqual([{ key: '~moved.2', reason: 'its new parent is outside this nested instance — apply it from the instance that contains both' }]);
  });

  // Mutation: drop the `parentRow === undefined` skip (the row is then written with an undefined parent).
  it('a move to a parent the prefab cannot name by row is skipped with a reason, and nothing is written', async () => {
    await load(scene([]));
    const a = idAt('Holder/OuterRoot');
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Holder/OuterRoot/Panel/Button/InnerRoot'));
    const result = await applyToPrefabSelective(a, new Set(['~moved.4']));
    expect(result.applied).toBe(false);
    expect(result.skipped?.map((x) => x.key)).toEqual(['~moved.4']);
    expect(repairs).toHaveLength(0);
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
  /** Write the Group as a prefab, then load one instance of it. */
  const writeAndLoad = async (): Promise<PrefabFile> => {
    const file = serializePrefab(idAt('Group'))!;
    prefabs.set(file.id!, file);
    setPrefabCache(file.id!, file);
    await load({ id: 'x', version: 15, name: 'X', resources: [], entities: [
      { id: 1, prefab: file.id, guid: X_ROOT, traits: { EntityAttributes: { name: 'Group', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    ] } as unknown as SceneData);
    return file;
  };

  // A node the scene added inside the instance becomes a keyed node of the row's template, so the move names
  // it by its key. Mutation: return undefined from templateMoves.
  it('a nested member moved under a node the scene added inside the instance', async () => {
    const shelf = grouped();
    (shelf.entities[1] as { added?: unknown[] }).added = [{ parentLocalId: 1, guid: 'bbbbbbbb-0000-4000-8000-0000000000d3', name: 'Shelf', traits: { EntityAttributes: { name: 'Shelf' }, Transform: { x: 0, y: 0, z: 0 } }, children: [] }];
    await load(shelf);
    reparentEntity(idAt('Group/OuterRoot/Panel/Button'), idAt('Group/OuterRoot/Shelf'));
    const file = await writeAndLoad();
    const [[key, target]] = Object.entries(file.moved ?? {});
    expect(key).toBe('2.2.3');
    expect(target).toMatch(/^@member:2\.\+/);
    expect(idAt('Group/OuterRoot/Shelf/Button')).toBeGreaterThan(0);
  });

  // Mutation: walk nested members by their LIVE parent in templateTokenizer (the key is then '2.3').
  it('a nested member moved inside its own instance', async () => {
    await load(grouped());
    reparentEntity(idAt('Group/OuterRoot/Panel/Button'), idAt('Group/OuterRoot'));
    const file = await writeAndLoad();
    expect(file.moved).toEqual({ '2.2.3': '@member:2' });
    expect(idAt('Group/OuterRoot/Button')).toBeGreaterThan(0);
    // Review F4: an untouched instance of the new prefab is at its base — it saves no move of its own, and no
    // pose. Mutation: resolve the base from the nested instance's own document only (prefabMoveTargets).
    type Entry = { prefab?: string; members?: Record<string, { name?: string; parent?: string }>; nestedOverrides?: Record<string, unknown> };
    const entry = (await serializeScene() as unknown as { entities: Entry[] }).entities.find((e) => e.prefab === file.id)!;
    expect(movesOf(entry)).toEqual({});
    expect(entry.nestedOverrides?.['2']).toBeUndefined();
  });

  // The inner prefab moves Button under Leaf; the tree has it back at Panel. The new prefab must say so, and its
  // move must beat the inner one on load. Mutations: drop the inner-doc base in templateMoves (nothing is
  // written, and Button lands under Leaf); keep the FIRST base move in drainAfterDerive (inner wins).
  it('moved back against a nested prefab\'s own move: written, and it overrides that move', async () => {
    const OUTER_M = 'aaaaaaaa-0000-4000-8000-0000000000d9';
    const outerMoved = { ...outerDoc, id: OUTER_M, moved: { '2.3': '@member:2.4.2' } };
    prefabs.set(OUTER_M, outerMoved);
    setPrefabCache(OUTER_M, outerMoved as never);
    try {
      await load(grouped(OUTER_M));
      expect(idAt('Group/OuterRoot/Panel/InnerRoot/Leaf/Button')).toBeGreaterThan(0); // the inner prefab's move
      reparentEntity(idAt('Group/OuterRoot/Panel/InnerRoot/Leaf/Button'), idAt('Group/OuterRoot/Panel'));
      const file = await writeAndLoad();
      expect(file.moved).toEqual({ '2.2.3': '@member:2.2' });
      expect(idAt('Group/OuterRoot/Panel/Button')).toBeGreaterThan(0);
    } finally { prefabs.delete(OUTER_M); setPrefabCache(OUTER_M, null); }
  });

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

  // Close-out sweep (#1438's key recovery, #1437's pattern): a template-keyed node under a moved member that
  // lost its key marker recovers it along the member's HOME chain, so the written prefab carries no spurious
  // copy of it. Mutation: walk recoverTemplateKey's nodes by live parent in prefab.ts.
  it('a keyed node under a moved nested member recovers its key, and is not written as a new node', async () => {
    const OUTER_K = 'aaaaaaaa-0000-4000-8000-0000000000dd';
    const keyed = { ...outerDoc, id: OUTER_K, entities: outerDoc.entities.map((r) => (r.localId === 4
      ? { ...r, added: [{ parentLocalId: 2, guid: '', key: 'cccccccc-0000-4000-8000-0000000000dd', name: 'Tag', traits: { EntityAttributes: { name: 'Tag' } }, children: [] }] } : r)) };
    prefabs.set(OUTER_K, keyed);
    setPrefabCache(OUTER_K, keyed as never);
    try {
      await load(grouped(OUTER_K));
      reparentEntity(idAt('Group/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Group/OuterRoot/Panel'));
      const tag = [...getCurrentWorld().entities].find((e) => e.id() === idAt('Group/OuterRoot/Panel/Leaf/Tag'))!;
      tag.remove(TemplateAddedKey);
      const file = serializePrefab(idAt('Group'))!;
      expect(JSON.stringify(file)).not.toContain('"Tag"');
    } finally { prefabs.delete(OUTER_K); setPrefabCache(OUTER_K, null); }
  });

  // The same recovery through a member whose home was deleted: it steps through the gone row (`extra`).
  // Mutation: drop `...(node.extra ?? [])` in templateKeyRecovery.
  it('key recovery steps through a deleted home (homeSteps)', () => {
    const G = 'bbbbbbbb-0000-4000-8000-0000000000de';
    const K = 'cccccccc-0000-4000-8000-0000000000de';
    const nodes = new Map<number, KeyRecoveryNode>([
      [1, { guid: G, parentId: 0, key: '', pi: null }],
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
  const ROOT2 = 'bbbbbbbb-0000-4000-8000-0000000000e9';
  const HOLDER2 = 'bbbbbbbb-0000-4000-8000-0000000000ea';
  const ea = (name: string, parentId: unknown, guid?: string) => ({ EntityAttributes: { name, parentId, ...(guid ? { guid } : {}) } });
  const twoOf = (source: string): SceneData => ({
    id: 'r3', version: 15, name: 'R3', resources: [],
    entities: [
      { id: 1, traits: ea('Holder', 0, HOLDER) },
      { id: 2, traits: ea('Holder2', 0, HOLDER2) },
      { id: 3, prefab: source, guid: ROOT, traits: { ...ea('OuterRoot', HOLDER), Transform: { x: 0, y: 0, z: 0 } } },
      { id: 4, prefab: source, guid: ROOT2, traits: { ...ea('OuterRoot', HOLDER2), Transform: { x: 0, y: 0, z: 0 } } },
    ],
  } as unknown as SceneData);
  const reloadWith = async (source: string, doc: PrefabFile): Promise<void> => {
    const saved = await serializeScene() as unknown as SceneData;
    prefabs.set(source, doc);
    setPrefabCache(source, doc);
    await load(saved);
  };
  const tfX = (id: number) => (([...getCurrentWorld().entities].find((e) => e.id() === id)!.get(getTraitByName('Transform')!.trait)) as { x: number }).x;
  type Entry = { guid?: string; members?: Record<string, { name?: string; parent?: string }>; };
  const entries = async () => (await serializeScene() as unknown as { entities: Entry[] }).entities;
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, rewritten: [], held: [] }) }) as unknown as Response));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** Apply Leaf → Panel from the outer instance, then reload: both instances have Leaf under Panel. */
  const appliedLeafOut = async (): Promise<PrefabFile> => {
    await load(twoOf(OUTER));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
    const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['~moved.4:2']));
    await reloadWith(OUTER, result.prefabAfter!);
    return result.prefabAfter!;
  };

  // F1. Mutation: drop the enclosingFrames re-queue in rebuildInstance.
  it('an unrelated apply on the nested instance keeps the outer prefab\'s move, and saves nothing new', async () => {
    await appliedLeafOut();
    const inner = idAt('Holder/OuterRoot/Panel/InnerRoot');
    writeTraitFieldWithUndo(inner, getTraitByName('Transform')!, 'x', 2);
    await applyToPrefabSelective(inner, new Set(['1.Transform.x']));
    expect(idAt('Holder/OuterRoot/Panel/Leaf')).toBeGreaterThan(0);
    expect(idAt('Holder2/OuterRoot/Panel/Leaf')).toBeGreaterThan(0);
    for (const e of (await entries()).filter((x) => x.guid === ROOT || x.guid === ROOT2)) expect(movesOf(e)).toEqual({});
  });

  // F2. Mutations: keep the inFrame filter unconditional (the move back is not offered outward); write the token
  // instead of removing the entry when the target is home.
  it('moved back home: offered to the outer instance, and applying it removes the outer prefab\'s move', async () => {
    await appliedLeafOut();
    reparentEntity(idAt('Holder/OuterRoot/Panel/Leaf'), idAt('Holder/OuterRoot/Panel/InnerRoot'));
    expect((await applyToPrefabSelective(idAt('Holder/OuterRoot/Panel/InnerRoot'), new Set(['~moved.2']))).skipped)
      .toEqual([{ key: '~moved.2', reason: 'a prefab containing this instance places it — apply the move from that instance' }]);
    expect(inLocalIds(collectInstanceOverrideKeys(idAt('Holder/OuterRoot'), getCachedPrefabSync(OUTER)!).moved, getCachedPrefabSync(OUTER))).toEqual(['~moved.4:2']);
    const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['~moved.4:2']));
    expect(result.prefabAfter!.moved).toBeUndefined();
    expect(idAt('Holder2/OuterRoot/Panel/InnerRoot/Leaf')).toBeGreaterThan(0);
  });

  const MIDX = 'aaaaaaaa-0000-4000-8000-0000000000e1';
  const OUTD = 'aaaaaaaa-0000-4000-8000-0000000000e2';
  const midDoc = { id: MIDX, rootLocalId: 1, entities: [row(1, 'MidRoot', 0), row(2, 'Slot', 1), row(3, 'Inner', 1, { prefab: INNER })] };
  const outDoc = { id: OUTD, rootLocalId: 1, entities: [row(1, 'OuterRoot', 0), row(2, 'Panel', 1), row(4, 'Mid', 1, { prefab: MIDX })] };
  const twoLevel = () => { for (const [g, d] of [[MIDX, midDoc], [OUTD, outDoc]] as const) { prefabs.set(g, d); setPrefabCache(g, d as never); } };

  // F3. Mutation: gate the pose write on a plain member again (the root's pose is lost on apply).
  it('two levels down, an owned nested ROOT moved out: applied with its pose', async () => {
    twoLevel();
    await load(twoOf(OUTD));
    reparentEntity(idAt('Holder/OuterRoot/MidRoot/InnerRoot'), idAt('Holder/OuterRoot/Panel'));
    writeTraitFieldWithUndo(idAt('Holder/OuterRoot/Panel/InnerRoot'), getTraitByName('Transform')!, 'x', 3);
    expect(inLocalIds(collectInstanceOverrideKeys(idAt('Holder/OuterRoot'), outDoc as never).moved, outDoc)).toEqual(['~moved.4:3']);
    const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['~moved.4:3']));
    expect(result.prefabAfter!.moved).toEqual({ '4.3': '@member:2' });
    await reloadWith(OUTD, result.prefabAfter!);
    expect(tfX(idAt('Holder/OuterRoot/Panel/InnerRoot'))).toBe(3);
    expect(tfX(idAt('Holder2/OuterRoot/Panel/InnerRoot'))).toBe(3);
  });

  // F3, the chain. Mutation: climb chainOf by the live parent again (the unrelated revert drops Leaf's pose).
  it('an unrelated revert keeps what a nested root moved out of its frame carries', async () => {
    twoLevel();
    await load(twoOf(OUTD));
    reparentEntity(idAt('Holder/OuterRoot/MidRoot/InnerRoot'), idAt('Holder/OuterRoot/Panel'));
    writeTraitFieldWithUndo(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), getTraitByName('Transform')!, 'x', 7);
    writeTraitFieldWithUndo(idAt('Holder/OuterRoot/Panel'), getTraitByName('Transform')!, 'x', 5);
    await revertOverridesSelective(idAt('Holder/OuterRoot'), new Set(['2.Transform.x']));
    expect(tfX(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'))).toBe(7);
  });

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

  // Close-out review 1. Mutation: re-queue every enclosing move in rebuildInstance (drop the `respawned` filter).
  it('a nested rebuild leaves an outer member the scene moved elsewhere where it is', async () => {
    await load(twoOf(OUTER));
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'));
    const applied = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['~moved.3']));
    await reloadWith(OUTER, applied.prefabAfter!);
    const panel = guidAt('Holder/OuterRoot/Panel');
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf/Button'), idAt('Holder/OuterRoot'));
    const inner = idAt('Holder/OuterRoot/Panel/InnerRoot');
    writeTraitFieldWithUndo(inner, getTraitByName('Transform')!, 'x', 2);
    await applyToPrefabSelective(inner, new Set(['1.Transform.x']));
    const button = idAt('Holder/OuterRoot/Button');
    expect(homeView(button).homeParent).toBe(panel);
    expect(idAt('Holder2/OuterRoot/Panel/InnerRoot/Leaf/Button')).toBeGreaterThan(0);
  });

  // Close-out review 2. Mutation: compose every kept row's pose (drop the `placedByPrefab` checks).
  it('a row the prefab itself places keeps its pose when the row it derives from is removed', async () => {
    const P2 = 'aaaaaaaa-0000-4000-8000-0000000000e5';
    const doc = { ...outerDoc, id: P2, entities: outerDoc.entities.map((r) => (r.localId === 2
      ? { ...r, traits: { ...r.traits, Transform: { x: 10, y: 0, z: 0 } } } : r.localId === 4 ? row(4, 'Nested', 1, { prefab: INNER }) : r)) };
    prefabs.set(P2, doc);
    setPrefabCache(P2, doc as never);
    try {
      await load(twoOf(P2));
      reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot/InnerRoot/Leaf'));
      writeTraitFieldWithUndo(idAt('Holder/OuterRoot/InnerRoot/Leaf/Button'), getTraitByName('Transform')!, 'x', 3);
      const applied = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['~moved.3']));
      await reloadWith(P2, applied.prefabAfter!);
      deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel')]);
      const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['-removed.2']));
      expect((result.prefabAfter!.entities.find((e) => e.localId === 3)!.traits.Transform as { x: number }).x).toBeCloseTo(3);
      expect(tfX(idAt('Holder2/OuterRoot/InnerRoot/Leaf/Button'))).toBeCloseTo(3);
    } finally { prefabs.delete(P2); setPrefabCache(P2, null); }
  });

  // Close-out review 3. Mutation: drop the `!tpl.extra.length` condition (the move is taken for "home").
  it('past a deleted home row, a move to the re-pointed home is a move, not a move back', async () => {
    const innerMid = { id: INNER, rootLocalId: 1, entities: [row(1, 'InnerRoot', 0), row(2, 'Mid', 1), row(3, 'Leaf', 2)] };
    prefabs.set(INNER, innerMid);
    setPrefabCache(INNER, innerMid as never);
    await load(twoOf(OUTER));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Mid/Leaf'), idAt('Holder/OuterRoot/Panel'));
    const applied = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['~moved.4:3']));
    await reloadWith(OUTER, applied.prefabAfter!);
    deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel/InnerRoot/Mid')]);
    reparentEntity(idAt('Holder/OuterRoot/Panel/Leaf'), idAt('Holder/OuterRoot/Panel/InnerRoot'));
    const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['~moved.4:3']));
    expect(result.prefabAfter!.moved).toEqual({ '2.4.2.3': '@member:2.4' });
    expect(idAt('Holder2/OuterRoot/Panel/InnerRoot/Leaf')).toBeGreaterThan(0);
  });

  // Close-out review 4. Mutation: take the identity parent without the own-subtree check in rowParentsFor.
  it('Create Prefab from an instance whose moved row now holds its own row parent writes no cycle', async () => {
    const P4 = 'aaaaaaaa-0000-4000-8000-0000000000e6';
    const doc = { id: P4, version: 4, name: 'P4', rootLocalId: 1, moved: { '2.5': '@member:4.2' }, entities: [
      row(1, 'Root', 0), row(2, 'A', 1), row(5, 'B', 2), row(4, 'Nested', 1, { prefab: INNER }),
    ] };
    prefabs.set(P4, doc);
    setPrefabCache(P4, doc as never);
    try {
      await load({ id: 'c4', version: 15, name: 'C4', resources: [], entities: [
        { id: 1, prefab: P4, guid: ROOT, traits: { EntityAttributes: { name: 'Root', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      ] } as unknown as SceneData);
      reparentEntity(idAt('Root/A'), idAt('Root/InnerRoot/Leaf/B'));
      const file = serializePrefab(idAt('Root'))!;
      const local = (name: string) => file.entities.find((e) => e.name === name)!.localId;
      const parent = (name: string) => (file.entities.find((e) => e.name === name)!.traits.EntityAttributes as { parentId: number }).parentId;
      expect(parent('A')).toBe(local('B'));
      expect(parent('B')).toBe(local('Root'));
      expect(Object.keys(file.moved ?? {})).toContain(String(local('B')));
    } finally { prefabs.delete(P4); setPrefabCache(P4, null); }
  });

  // Close-out review 5. Mutation: stamp only the live subtree in rebuildInstance.
  it('a base-scene instance\'s member moved out of the rebuilt subtree keeps its scene stamp', async () => {
    await load(twoOf(OUTER));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
    const applied = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['~moved.4:2']));
    await reloadWith(OUTER, applied.prefabAfter!);
    const eaT = getTraitByName('EntityAttributes')!.trait;
    const under = new Set([idAt('Holder'), ...getAllEntities().filter((e) => treePaths().get(e.guid ?? '')?.startsWith('Holder/')).map((e) => e.id)]);
    for (const e of getCurrentWorld().entities) if (under.has(e.id())) e.set(eaT, { ...(e.get(eaT) as object), sourceScene: 'base-scene-guid' });
    const inner = idAt('Holder/OuterRoot/Panel/InnerRoot');
    writeTraitFieldWithUndo(inner, getTraitByName('Transform')!, 'x', 2);
    await applyToPrefabSelective(inner, new Set(['1.Transform.x']));
    const leaf = [...getCurrentWorld().entities].find((e) => e.id() === idAt('Holder/OuterRoot/Panel/Leaf'))!;
    expect((leaf.get(eaT) as { sourceScene: string }).sourceScene).toBe('base-scene-guid');
  });

  // Final review 1: when the removal also takes the TARGET of the prefab's move, that move is dropped, and the
  // row keeps its world pose like any other. Mutation: skip the target-survival check (every such row "placed").
  it('a row whose prefab move loses its target in the same removal keeps its world pose', async () => {
    const P7 = 'aaaaaaaa-0000-4000-8000-0000000000e7';
    const doc = { ...outerDoc, id: P7, entities: outerDoc.entities.map((r) => (r.localId === 2
      ? { ...r, traits: { ...r.traits, Transform: { x: 10, y: 0, z: 0 } } } : r)) };
    prefabs.set(P7, doc);
    setPrefabCache(P7, doc as never);
    try {
      await load(twoOf(P7));
      reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'));
      writeTraitFieldWithUndo(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf/Button'), getTraitByName('Transform')!, 'x', 3);
      const applied = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['~moved.3']));
      await reloadWith(P7, applied.prefabAfter!);
      deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel')]);
      const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['-removed.2']));
      expect(result.prefabAfter!.moved).toBeUndefined();
      expect((result.prefabAfter!.entities.find((e) => e.localId === 3)!.traits.Transform as { x: number }).x).toBeCloseTo(13);
    } finally { prefabs.delete(P7); setPrefabCache(P7, null); }
  });

  // Final review 2: three moved rows whose chosen parents close a loop. Mutation: drop the loop pass in
  // rowParentsFor.
  it('Create Prefab never writes a parent loop across several moved rows', async () => {
    const P8 = 'aaaaaaaa-0000-4000-8000-0000000000e8';
    const doc = { id: P8, version: 4, name: 'P8', rootLocalId: 1, entities: [
      row(1, 'Root', 0), row(2, 'X', 1), row(3, 'Z', 2), row(5, 'Y', 3), row(4, 'Nested', 1, { prefab: INNER }),
    ] };
    prefabs.set(P8, doc);
    setPrefabCache(P8, doc as never);
    try {
      await load({ id: 'c8', version: 15, name: 'C8', resources: [], entities: [
        { id: 1, prefab: P8, guid: ROOT, traits: { EntityAttributes: { name: 'Root', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      ] } as unknown as SceneData);
      reparentEntity(idAt('Root/X/Z'), idAt('Root/InnerRoot/Leaf'));
      reparentEntity(idAt('Root/InnerRoot/Leaf/Z/Y'), idAt('Root/InnerRoot/Leaf'));
      reparentEntity(idAt('Root/X'), idAt('Root/InnerRoot/Leaf/Y'));
      const file = serializePrefab(idAt('Root'))!;
      const parentOf = new Map(file.entities.map((e) => [e.localId, (e.traits.EntityAttributes as { parentId: number }).parentId]));
      for (const e of file.entities) {
        const seen = new Set<number>();
        for (let p: number | undefined = e.localId; p; p = parentOf.get(p)) {
          expect(seen.has(p)).toBe(false);
          seen.add(p);
        }
      }
    } finally { prefabs.delete(P8); setPrefabCache(P8, null); }
  });

  // F6. Mutation: lift without carrying the pose through the removed rows.
  it('a row lifted past a removed row keeps its world pose', async () => {
    const P6 = 'aaaaaaaa-0000-4000-8000-0000000000e4';
    const doc = { ...outerDoc, id: P6, entities: outerDoc.entities.map((r) => (r.localId === 2
      ? { ...r, traits: { ...r.traits, Transform: { x: 10, y: 0, z: 0 } } } : r.localId === 3
        ? { ...r, traits: { ...r.traits, Transform: { x: 1, y: 0, z: 0 } } } : r)) };
    prefabs.set(P6, doc);
    setPrefabCache(P6, doc as never);
    try {
      await load(twoOf(P6));
      reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot'));
      deleteEntitiesWithUndo([idAt('Holder/OuterRoot/Panel')]);
      const result = await applyToPrefabSelective(idAt('Holder/OuterRoot'), new Set(['-removed.2']));
      const tf = result.prefabAfter!.entities.find((e) => e.localId === 3)!.traits.Transform as { x: number };
      expect(tf.x).toBeCloseTo(11);
      expect(tfX(idAt('Holder2/OuterRoot/Button'))).toBeCloseTo(11);
    } finally { prefabs.delete(P6); setPrefabCache(P6, null); }
  });
});

describe('leaving the outermost instance cuts only the links the move splits (#1445, #1447)', () => {
  const SHELF = 'bbbbbbbb-0000-4000-8000-0000000000e1';
  const ROOT_B = 'bbbbbbbb-0000-4000-8000-0000000000e2';
  const piOf = (id: number) => ([...getCurrentWorld().entities].find((x) => x.id() === id)!
    .get(getTraitByName('PrefabInstance')!.trait)) as { rootInstanceId?: number; parentLocalId?: number } | undefined;
  const xOf = (id: number) => ([...getCurrentWorld().entities].find((x) => x.id() === id)!.get(getTraitByName('Transform')!.trait) as { x: number }).x;
  const withShelf = (holderRefs: string[] = []): SceneData => {
    const sc = scene(holderRefs) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = undefined;
    sc.entities.push({ id: 3, traits: { EntityAttributes: { name: 'Shelf', parentId: 0, guid: SHELF } } });
    return sc as unknown as SceneData;
  };

  // #1445. The unpack test ran after the parent write, so a member dropped into ANOTHER instance read as still
  // inside its own: it stayed A's member inside B, and A's save recorded a move no Apply could take.
  // Mutation: take planMoveUnlinks after the parentId write.
  it('a member dropped into ANOTHER instance is unpacked: A records it removed, B saves it as an addition', async () => {
    const sc = withShelf() as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities.push({ id: 4, prefab: OUTER, guid: ROOT_B, traits: { EntityAttributes: { name: 'OuterRoot', parentId: SHELF }, Transform: { x: 0, y: 0, z: 0 } } });
    await load(sc as unknown as SceneData);
    const button = idAt('Holder/OuterRoot/Panel/Button');
    rename(button, 'Moved'); // B's own Button sits at the same path
    reparentEntity(button, idAt('Shelf/OuterRoot/Panel'));
    expect(piOf(idAt('Shelf/OuterRoot/Panel/Moved'))).toBeUndefined();
    const guid = guidAt('Shelf/OuterRoot/Panel/Moved');
    await load(await serializeScene() as unknown as SceneData);
    expect(treePaths().get(guid)).toBe('Shelf/OuterRoot/Panel/Moved');
    expect(piOf(idAt('Shelf/OuterRoot/Panel/Moved'))).toBeUndefined();
    expect([...treePaths().values()].filter((p) => p.endsWith('/Button'))).toEqual(['Shelf/OuterRoot/Panel/Button']);
  });

  // #1447: a ref taken BEFORE the move names the member by its outer-derived guid, which a standalone instance
  // does not reproduce on reload. Mutation: skip remapWorldGuidRefs in applyGuidRemap (or the rename in
  // promoteOwnedRoots).
  it('a ref held before the move follows the moved-out nested instance through save + reload; undo restores it', async () => {
    await load(withShelf());
    const before = guidAt('Holder/OuterRoot/Panel/InnerRoot/Leaf');
    await load(withShelf([before]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Shelf'));
    expect(piOf(idAt('Shelf/InnerRoot'))).toMatchObject({ rootInstanceId: idAt('Shelf/InnerRoot'), parentLocalId: 0 });
    expect(targetsOf(idAt('Holder')).map((g) => treePaths().get(g))).toEqual(['Shelf/InnerRoot/Leaf']);
    await load(await serializeScene() as unknown as SceneData);
    expectUniqueGuidsHere();
    expect(targetsOf(idAt('Holder')).map((g) => treePaths().get(g))).toEqual(['Shelf/InnerRoot/Leaf']);
    // Undo in a fresh session of the same edit: the member takes its outer-derived guid back, and so does the ref.
    await load(withShelf([before]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Shelf'));
    await undo();
    expect(guidAt('Holder/OuterRoot/Panel/InnerRoot/Leaf')).toBe(before);
    expect(targetsOf(idAt('Holder'))).toEqual([before]);
  });

  // #1447: a standalone instance saves only MARKED fields, so a value the OUTER prefab's row set on the nested
  // instance must be marked, or it reloads at the inner prefab's base. Every expansion marks the row overrides it
  // applies (applyOverridesByLocalToEcs), which is what this pins. Mutation: drop that seeding markOverride.
  it('a value the outer row set on the nested instance survives the move-out through save + reload', async () => {
    const withRowOverride = { ...outerDoc, entities: outerDoc.entities.map((r) => (r.localId === 4 ? { ...r, overrides: { 2: { Transform: { x: 3 } } } } : r)) };
    prefabs.set(OUTER, withRowOverride);
    setPrefabCache(OUTER, withRowOverride as never);
    await load(withShelf());
    expect(xOf(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'))).toBe(3); // precondition: the row applies
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Shelf'));
    await load(await serializeScene() as unknown as SceneData);
    expect(xOf(idAt('Shelf/InnerRoot/Leaf'))).toBe(3);
  });

  // #1447's sibling on the DELETE path: detachOrphanedMembers promotes an owned nested root whose owner goes, and
  // did not rename its members, so a ref to one dangled on reload. This drives the function's own contract; the
  // editor delete reaching it is the #1451 tests. Mutation: drop the promoteOwnedRoots call in
  // detachOrphanedMembers (promote without the rename).
  it('detachOrphanedMembers: a promoted nested root keeps a ref to its member, and the undo takes the rename back', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot'), idAt('Outer3Root/Panel'));
      await reloadWithShelfRef(guidAt('Outer3Root/Panel/InnerRoot/Leaf'));
      const leaf = guidAt('Outer3Root/Panel/InnerRoot/Leaf');
      const mid = idAt('Outer3Root/Panel/MidRoot');
      const detached = detachOrphanedMembers(new Set([mid]));
      expect(piOf(idAt('Outer3Root/Panel/InnerRoot'))?.parentLocalId).toBe(0); // precondition: promoted
      expect(targetsOf(idAt('Shelf')).map((g) => treePaths().get(g))).toEqual(['Outer3Root/Panel/InnerRoot/Leaf']);
      // ⚠️ #1468 R7: a promoted root's members KEEP their guids. The rename this file was written around
      // (#1447) renamed them to what a reload would re-derive under the new root; with the rows stored,
      // the reload pins the guid it had and both stampers skip a keyed member, so the rename is inert
      // here. A deliberate divergence from the QA-measured contract — `qa/knowledge.md`'s prefab-instance
      // gesture table, the "promote a nested root" row ("its members' guids are re-derived") — and the
      // plan records it as such.
      expect(guidAt('Outer3Root/Panel/InnerRoot/Leaf')).toBe(leaf);
      relinkDetachedMembers(detached);
      expect(guidAt('Outer3Root/Panel/InnerRoot/Leaf')).toBe(leaf);
      expect(targetsOf(idAt('Shelf'))).toEqual([leaf]);
      detachOrphanedMembers(new Set([mid]));
      expect(guidAt('Outer3Root/Panel/InnerRoot/Leaf')).toBe(leaf);
    });
  });

  // Close-out review 1: a member of the instance being promoted that sits ABOVE its root — moved there while the
  // instance was owned — was kept linked, and a standalone instance is saved from its root down, so the save wrote
  // neither and both vanished on reload. Mutation: drop the not-under-its-root strip loop in planMoveUnlinks.
  it('a member holding its own nested root, dragged out: the member unpacks, the instance stays linked, both reload', async () => {
    await load(withShelf());
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel/Button'));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Holder/OuterRoot/Panel/Button/Leaf'));
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button/Leaf'), idAt('Shelf'));
    expect(piOf(idAt('Shelf/Leaf'))).toBeUndefined();
    expect(piOf(idAt('Shelf/Leaf/InnerRoot'))?.parentLocalId).toBe(0);
    await load(await serializeScene() as unknown as SceneData);
    expectUniqueGuidsHere();
    expect(piOf(idAt('Shelf/Leaf'))).toBeUndefined();
    expect(piOf(idAt('Shelf/Leaf/InnerRoot'))?.rootInstanceId).toBe(idAt('Shelf/Leaf/InnerRoot'));
    expect(treePaths().size).toBe([...treePaths().values()].length); // (treePaths throws on a duplicate path)
  });

  // Close-out review 2/3: the undo refs were taken AFTER the promotion renamed guids; when the old parent was one
  // of the renamed (a member of an instance left behind), undo put the mover at the scene root. Three levels:
  // OUTER3 → Mid(MID) → Nested(INNER). Mutation: take the ref/oldParentRef/newParentRef after applyDetach.
  it('undo puts a mover back under an old parent the promotion renamed, and redo moves it out again', async () => {
    const MID = 'aaaaaaaa-0000-4000-8000-0000000000e4';
    const OUTER3 = 'aaaaaaaa-0000-4000-8000-0000000000e5';
    const midDoc = { id: MID, rootLocalId: 1, entities: [row(1, 'MidRoot', 0), row(2, 'Nested', 1, { prefab: INNER })] };
    const outer3 = { id: OUTER3, rootLocalId: 1, entities: [row(1, 'Outer3Root', 0), row(2, 'Panel', 1), row(3, 'Mid', 2, { prefab: MID })] };
    for (const [k, d] of [[MID, midDoc], [OUTER3, outer3]] as const) { prefabs.set(k, d); setPrefabCache(k, d as never); }
    try {
      await load({
        id: 'o3', version: 1, name: 'O3', resources: [],
        entities: [
          { id: 1, prefab: OUTER3, guid: ROOT_B, traits: { EntityAttributes: { name: 'Outer3Root', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
          { id: 2, traits: { EntityAttributes: { name: 'Shelf', parentId: 0, guid: SHELF } } },
        ],
      } as unknown as SceneData);
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot'), idAt('Outer3Root/Panel'));
      reparentEntity(idAt('Outer3Root/Panel/MidRoot'), idAt('Outer3Root/Panel/InnerRoot/Leaf'));
      const leaf = guidAt('Outer3Root/Panel/InnerRoot/Leaf');
      reparentEntity(idAt('Outer3Root/Panel/InnerRoot/Leaf/MidRoot'), idAt('Shelf'));
      // ⚠️ #1468 R7: a promoted root's members KEEP their guids. The rename this file was written around
      // (#1447) renamed them to what a reload would re-derive under the new root; with the rows stored,
      // the reload pins the guid it had and both stampers skip a keyed member, so the rename is inert
      // here. A deliberate divergence from the QA-measured contract — `qa/knowledge.md`'s prefab-instance
      // gesture table, the "promote a nested root" row ("its members' guids are re-derived") — and the
      // plan records it as such.
      expect(guidAt('Outer3Root/Panel/InnerRoot/Leaf')).toBe(leaf);
      await undo();
      expect(guidAt('Outer3Root/Panel/InnerRoot/Leaf')).toBe(leaf);
      expect(treePaths().has(guidAt('Outer3Root/Panel/InnerRoot/Leaf/MidRoot'))).toBe(true);
      await redo();
      expect(piOf(idAt('Shelf/MidRoot'))?.parentLocalId).toBe(0);
    } finally {
      for (const k of [MID, OUTER3]) { prefabs.delete(k); setPrefabCache(k, null); }
    }
  });

  /** OUTER3 → Panel → Mid(MID) → Nested(INNER), plus a Shelf; the prefab docs are dropped by `finally`. */
  const MID3 = 'aaaaaaaa-0000-4000-8000-0000000000e7';
  const OUTER3B = 'aaaaaaaa-0000-4000-8000-0000000000e8';
  const withOuter3 = async (body: () => Promise<void>, midRows = [row(1, 'MidRoot', 0), row(2, 'Nested', 1, { prefab: INNER })]) => {
    const midDoc = { id: MID3, rootLocalId: 1, entities: midRows };
    const outer3 = { id: OUTER3B, rootLocalId: 1, entities: [row(1, 'Outer3Root', 0), row(2, 'Panel', 1), row(3, 'Mid', 2, { prefab: MID3 })] };
    for (const [k, d] of [[MID3, midDoc], [OUTER3B, outer3]] as const) { prefabs.set(k, d); setPrefabCache(k, d as never); }
    try {
      await load({
        id: 'o3b', version: 1, name: 'O3', resources: [],
        entities: [
          { id: 1, prefab: OUTER3B, guid: ROOT_B, traits: { EntityAttributes: { name: 'Outer3Root', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
          { id: 2, traits: { EntityAttributes: { name: 'Shelf', parentId: 0, guid: SHELF } } },
        ],
      } as unknown as SceneData);
      await body();
    } finally {
      for (const k of [MID3, OUTER3B]) { prefabs.delete(k); setPrefabCache(k, null); }
    }
  };

  // Close-out review 2, finding 1: the owner leaves and the nested root is promoted IN PLACE; a member of it left
  // above it, outside the moved subtree, stayed linked, and both vanished on reload. Mutation: skip members
  // outside the moved subtree in planMoveUnlinks's under-the-frame loop.
  it('a member above a nested root promoted in place (its owner left) unpacks, and both reload', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot/Leaf'), idAt('Outer3Root/Panel'));
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot'), idAt('Outer3Root/Panel/Leaf'));
      reparentEntity(idAt('Outer3Root/Panel/MidRoot'), idAt('Shelf'));
      expect(piOf(idAt('Outer3Root/Panel/Leaf'))).toBeUndefined();
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect(piOf(idAt('Outer3Root/Panel/Leaf'))).toBeUndefined();
      expect(piOf(idAt('Outer3Root/Panel/Leaf/InnerRoot'))?.parentLocalId).toBe(0);
      expect(piOf(idAt('Shelf/MidRoot'))?.parentLocalId).toBe(0);
    });
  });

  // Close-out review 3: the ACCEPT side. A member merely BESIDE its promoted frame inside the same outermost
  // instance is a #1437 move the save records, so it stays linked. Mutation: strip every member not under its
  // frame (the round-2 rule).
  it('a member beside a nested root promoted in place stays linked, and reloads so', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot'), idAt('Outer3Root/Panel'));
      reparentEntity(idAt('Outer3Root/Panel/InnerRoot/Leaf'), idAt('Outer3Root/Panel'));
      reparentEntity(idAt('Outer3Root/Panel/MidRoot'), idAt('Shelf'));
      expect(piOf(idAt('Outer3Root/Panel/Leaf'))?.rootInstanceId).toBe(idAt('Outer3Root/Panel/InnerRoot'));
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect(piOf(idAt('Outer3Root/Panel/Leaf'))?.rootInstanceId).toBe(idAt('Outer3Root/Panel/InnerRoot'));
    });
  });

  // …and beside it OUTSIDE any instance that records it: a member carried out beside its promoted frame, under
  // parents the same move unpacks, is written nowhere. Mutation: count a stripped ancestor's link in topAbove.
  it('a member carried out BESIDE its promoted frame, under unpacked parents, unpacks, and both reload', async () => {
    await load(withShelf());
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel/Button'));
    reparentEntity(idAt('Holder/OuterRoot/Panel'), idAt('Shelf'));
    expect(piOf(idAt('Shelf/Panel/Button/Leaf'))).toBeUndefined();
    await load(await serializeScene() as unknown as SceneData);
    expectUniqueGuidsHere();
    expect(treePaths().has(guidAt('Shelf/Panel/Button/Leaf'))).toBe(true);
    expect(piOf(idAt('Shelf/Panel/InnerRoot'))?.parentLocalId).toBe(0);
  });

  // Finding 2: the member's own root is NOT promoted (its owner moves with it), but the root above that is; the
  // member sat above that promoted root and stayed linked. Mutation: check only the member's own root.
  it('a member above a promoted root further up its chain unpacks, and the whole instance reloads', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot/Leaf'), idAt('Outer3Root/Panel'));
      reparentEntity(idAt('Outer3Root/Panel/MidRoot'), idAt('Outer3Root/Panel/Leaf'));
      reparentEntity(idAt('Outer3Root/Panel/Leaf'), idAt('Shelf'));
      expect(piOf(idAt('Shelf/Leaf'))).toBeUndefined();
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect(piOf(idAt('Shelf/Leaf'))).toBeUndefined();
      expect(piOf(idAt('Shelf/Leaf/MidRoot'))?.parentLocalId).toBe(0);
      expect(piOf(idAt('Shelf/Leaf/MidRoot/InnerRoot'))?.parentLocalId).toBeGreaterThan(0); // still MID's own row
    });
  });

  /** Save, give Shelf a UIAction ref to `target`, and load it back — a ref as a scene file would hold it. */
  const reloadWithShelfRef = async (target: string) => {
    const sc = await serializeScene() as unknown as { entities: Array<{ traits: Record<string, unknown> }> };
    sc.entities.find((e) => (e.traits.EntityAttributes as { name?: string })?.name === 'Shelf')!
      .traits.UIAction = { bindings: [{ event: 'click', action: 'noop', target }] };
    await load(sc as unknown as SceneData);
  };

  // #1451: a nested root moved beside its owner inside the outer instance, then the owner deleted. The rehome walk
  // stepped through the dying OWNED root into the grandparent frame, which records no move for it, so the save wrote
  // only `removed` and InnerRoot + Leaf vanished on reload. (`rehomeDependents` is gone since #1468 Phase 6: the climb
  // never passes the frame root.) Mutation: let the moved root's owner fall back to its live parent (drop its link).
  it('#1451: deleting the owner of a moved nested root promotes it, and it reloads with a ref to its member', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot'), idAt('Outer3Root/Panel'));
      await reloadWithShelfRef(guidAt('Outer3Root/Panel/InnerRoot/Leaf'));
      const inner = guidAt('Outer3Root/Panel/InnerRoot');
      deleteEntitiesWithUndo([idAt('Outer3Root/Panel/MidRoot')]);
      expect(piOf(idAt('Outer3Root/Panel/InnerRoot'))?.parentLocalId).toBe(0); // promoted to a stored root
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect(guidAt('Outer3Root/Panel/InnerRoot')).toBe(inner);
      expect(piOf(idAt('Outer3Root/Panel/InnerRoot'))?.parentLocalId).toBe(0);
      expect(targetsOf(idAt('Shelf')).map((g) => treePaths().get(g))).toEqual(['Outer3Root/Panel/InnerRoot/Leaf']);
    });
  });

  // …and the undo takes the promotion back: the nested root is Mid's again, homed at MidRoot, with its member's
  // old guid and the ref on it — and it still reloads there as a recorded move.
  it('#1451: undoing that delete relinks the nested root to its owner, and it reloads as a move', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot'), idAt('Outer3Root/Panel'));
      await reloadWithShelfRef(guidAt('Outer3Root/Panel/InnerRoot/Leaf'));
      const leaf = guidAt('Outer3Root/Panel/InnerRoot/Leaf');
      const pinned = () => { const id = idAt('Outer3Root/Panel/InnerRoot'); return [(piOf(id) as { parentLocalId?: number } | undefined)?.parentLocalId, homeView(id)]; };
      const before = pinned();
      deleteEntitiesWithUndo([idAt('Outer3Root/Panel/MidRoot')]);
      // ⚠️ #1468 R7: a promoted root's members KEEP their guids. The rename this file was written around
      // (#1447) renamed them to what a reload would re-derive under the new root; with the rows stored,
      // the reload pins the guid it had and both stampers skip a keyed member, so the rename is inert
      // here. A deliberate divergence from the QA-measured contract — `qa/knowledge.md`'s prefab-instance
      // gesture table, the "promote a nested root" row ("its members' guids are re-derived") — and the
      // plan records it as such.
      expect(guidAt('Outer3Root/Panel/InnerRoot/Leaf')).toBe(leaf);
      expect(await undo()).toBe(true);
      expect(pinned()).toEqual(before);
      expect(guidAt('Outer3Root/Panel/InnerRoot/Leaf')).toBe(leaf);
      expect(targetsOf(idAt('Shelf'))).toEqual([leaf]);
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect(guidAt('Outer3Root/Panel/InnerRoot/Leaf')).toBe(leaf);
      expect(treePaths().has(guidAt('Outer3Root/Panel/MidRoot'))).toBe(true);
    });
  });

  // The owner going as PART of a deleted subtree (its parent Panel), with the nested root moved out of it to the
  // outer root: the same promotion. Mutation: as above.
  it('#1451: the owner deleted inside a larger subtree promotes the moved nested root the same way', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot'), idAt('Outer3Root'));
      const inner = guidAt('Outer3Root/InnerRoot');
      deleteEntitiesWithUndo([idAt('Outer3Root/Panel')]);
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect(guidAt('Outer3Root/InnerRoot')).toBe(inner);
      expect(piOf(idAt('Outer3Root/InnerRoot'))?.parentLocalId).toBe(0);
      expect(treePaths().has(guidAt('Outer3Root/InnerRoot/Leaf'))).toBe(true);
    });
  });

  // #1451 close-out, finding 2: the nested root is NOT moved itself. It rides out inside a moved member of its owner
  // (Holder2), so it has no home, and the promotion keyed on "its home dies" never fired. It was saved as an added
  // instance, and its members' guids changed on reload, dangling a ref. Mutation: key the promotion on the home.
  it('#1451: a nested root carried out inside a moved member is promoted when its owner is deleted', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/Holder2'), idAt('Outer3Root/Panel'));
      await reloadWithShelfRef(guidAt('Outer3Root/Panel/Holder2/InnerRoot/Leaf'));
      const leaf = guidAt('Outer3Root/Panel/Holder2/InnerRoot/Leaf');
      deleteEntitiesWithUndo([idAt('Outer3Root/Panel/MidRoot')]);
      expect(piOf(idAt('Outer3Root/Panel/Holder2'))).toBeUndefined(); // its frame died: unlinked
      expect(piOf(idAt('Outer3Root/Panel/Holder2/InnerRoot'))?.parentLocalId).toBe(0); // promoted
      // Undo relinks both and takes the rename back; redo repeats the promotion.
      expect(await undo()).toBe(true);
      expect(piOf(idAt('Outer3Root/Panel/Holder2/InnerRoot'))?.parentLocalId).toBeGreaterThan(0);
      expect(guidAt('Outer3Root/Panel/Holder2/InnerRoot/Leaf')).toBe(leaf);
      expect(targetsOf(idAt('Shelf'))).toEqual([leaf]);
      expect(await redo()).toBe(true);
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect(piOf(idAt('Outer3Root/Panel/Holder2/InnerRoot'))?.parentLocalId).toBe(0);
      expect(targetsOf(idAt('Shelf')).map((g) => treePaths().get(g))).toEqual(['Outer3Root/Panel/Holder2/InnerRoot/Leaf']);
    },[row(1, 'MidRoot', 0), row(2, 'Holder2', 1), row(3, 'Nested', 2, { prefab: INNER })]);
  });

  // #1451 close-out review 2: the nested root moved out of the carried member, so its home is Holder2, which LIVES,
  // and only its owner dies. Mutation: key the promotion on the home alone.
  it('#1451: a nested root homed at a live moved member is promoted when its owner is deleted', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/Holder2'), idAt('Outer3Root/Panel'));
      reparentEntity(idAt('Outer3Root/Panel/Holder2/InnerRoot'), idAt('Outer3Root/Panel'));
      await reloadWithShelfRef(guidAt('Outer3Root/Panel/InnerRoot/Leaf'));
      deleteEntitiesWithUndo([idAt('Outer3Root/Panel/MidRoot')]);
      expect(piOf(idAt('Outer3Root/Panel/InnerRoot'))?.parentLocalId).toBe(0);
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect(targetsOf(idAt('Shelf')).map((g) => treePaths().get(g))).toEqual(['Outer3Root/Panel/InnerRoot/Leaf']);
    }, [row(1, 'MidRoot', 0), row(2, 'Holder2', 1), row(3, 'Nested', 2, { prefab: INNER })]);
  });

  // …and the converse: a Detach Prefab on the owner, then a delete of it. Since #1453 the detach itself promotes the
  // nested root (the delete then has nothing left to rescue), so this pins the end state of the pair, not the delete.
  it('#1451: deleting a detached owner still promotes the nested root moved out of it', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot'), idAt('Outer3Root/Panel'));
      await reloadWithShelfRef(guidAt('Outer3Root/Panel/InnerRoot/Leaf'));
      detachPrefabInstance(idAt('Outer3Root/Panel/MidRoot'));
      deleteEntitiesWithUndo([idAt('Outer3Root/Panel/MidRoot')]);
      expect(piOf(idAt('Outer3Root/Panel/InnerRoot'))?.parentLocalId).toBe(0);
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect(targetsOf(idAt('Shelf')).map((g) => treePaths().get(g))).toEqual(['Outer3Root/Panel/InnerRoot/Leaf']);
    });
  });

  // #1453: Detach Prefab ends the instance's frame just as a delete does. A nested root moved out of it (still
  // inside the outer instance) stayed owned by a plain entity and a plain member moved out stayed linked to one,
  // so the save wrote neither and both vanished on reload. Mutation: detachPrefabInstance without endFrames.
  it('#1453: detaching the owner of a moved-out nested root promotes it, and it reloads with a ref to its member', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot'), idAt('Outer3Root/Panel'));
      await reloadWithShelfRef(guidAt('Outer3Root/Panel/InnerRoot/Leaf'));
      const inner = guidAt('Outer3Root/Panel/InnerRoot');
      detachPrefabInstance(idAt('Outer3Root/Panel/MidRoot'));
      expect(piOf(idAt('Outer3Root/Panel/InnerRoot'))?.parentLocalId).toBe(0); // a standalone instance now
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect(guidAt('Outer3Root/Panel/InnerRoot')).toBe(inner);
      expect(piOf(idAt('Outer3Root/Panel/InnerRoot'))?.parentLocalId).toBe(0);
      expect(targetsOf(idAt('Shelf')).map((g) => treePaths().get(g))).toEqual(['Outer3Root/Panel/InnerRoot/Leaf']);
    });
  });

  const withKnob = [row(1, 'MidRoot', 0), row(2, 'Nested', 1, { prefab: INNER }), row(3, 'Knob', 1)];
  it('#1453: detaching an instance unlinks a plain member moved out of it, and it reloads plain', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/Knob'), idAt('Outer3Root/Panel'));
      const knob = guidAt('Outer3Root/Panel/Knob');
      detachPrefabInstance(idAt('Outer3Root/Panel/MidRoot'));
      expect(piOf(idAt('Outer3Root/Panel/Knob'))).toBeUndefined();
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect(guidAt('Outer3Root/Panel/Knob')).toBe(knob);
      expect(piOf(idAt('Outer3Root/Panel/Knob'))).toBeUndefined();
    }, withKnob);
  });

  // The undo (Hierarchy and the agent op both hand the result back to reattachPrefabInstance) takes it all back:
  // the nested root is Mid's again with its member's old guid, and the member is linked again. Both reload as
  // recorded moves. Mutation: reattachPrefabInstance without relinkDetachedMembers.
  it('#1453: undoing the detach relinks a moved-out nested root and plain member, and both reload as moves', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot'), idAt('Outer3Root/Panel'));
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/Knob'), idAt('Outer3Root/Panel'));
      await reloadWithShelfRef(guidAt('Outer3Root/Panel/InnerRoot/Leaf'));
      const leaf = guidAt('Outer3Root/Panel/InnerRoot/Leaf');
      const pinned = () => { const id = idAt('Outer3Root/Panel/InnerRoot'); return [(piOf(id) as { parentLocalId?: number } | undefined)?.parentLocalId, homeView(id).homeParent]; };
      const before = pinned();
      const snapshot = detachPrefabInstance(idAt('Outer3Root/Panel/MidRoot'));
      // ⚠️ #1468 R7: a promoted root's members KEEP their guids. The rename this file was written around
      // (#1447) renamed them to what a reload would re-derive under the new root; with the rows stored,
      // the reload pins the guid it had and both stampers skip a keyed member, so the rename is inert
      // here. A deliberate divergence from the QA-measured contract — `qa/knowledge.md`'s prefab-instance
      // gesture table, the "promote a nested root" row ("its members' guids are re-derived") — and the
      // plan records it as such.
      expect(guidAt('Outer3Root/Panel/InnerRoot/Leaf')).toBe(leaf);
      expect(reattachPrefabInstance(snapshot)).toBe(0);
      expect(pinned()).toEqual(before);
      expect(piOf(idAt('Outer3Root/Panel/Knob'))?.rootInstanceId).toBe(idAt('Outer3Root/Panel/MidRoot'));
      expect(guidAt('Outer3Root/Panel/InnerRoot/Leaf')).toBe(leaf);
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect(guidAt('Outer3Root/Panel/InnerRoot/Leaf')).toBe(leaf);
      expect(targetsOf(idAt('Shelf'))).toEqual([leaf]);
      expect(piOf(idAt('Outer3Root/Panel/Knob'))?.rootInstanceId).toBe(idAt('Outer3Root/Panel/MidRoot'));
    }, withKnob);
  });

  // The unpack on leave (applyDetach) runs `endFrames` too, so every frame-ending path has one shape. Before #1450 the
  // plan could strip an owned ROOT (InnerRoot, above the MidRoot the move promotes) while a member of it stayed
  // linked under that frame, written nowhere. Since #1450's `planMoveUnlinks` no root reaches `strip` (it promotes
  // InnerRoot instead), so that orphan step has nothing to catch here today; this pins the shape's outcome.
  it('#1453: the leave shape that once stripped an owned root keeps its member linked, and both reload', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot/Leaf'), idAt('Outer3Root/Panel/MidRoot'));
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot'), idAt('Outer3Root/Panel'));
      reparentEntity(idAt('Outer3Root/Panel/MidRoot'), idAt('Outer3Root/Panel/InnerRoot'));
      reparentEntity(idAt('Outer3Root/Panel/InnerRoot'), idAt('Shelf'));
      expect(piOf(idAt('Shelf/InnerRoot'))?.parentLocalId).toBe(0);
      expect(piOf(idAt('Shelf/InnerRoot/MidRoot'))?.parentLocalId).toBe(0);
      expect(piOf(idAt('Shelf/InnerRoot/MidRoot/Leaf'))?.rootInstanceId).toBe(idAt('Shelf/InnerRoot'));
      const leaf = guidAt('Shelf/InnerRoot/MidRoot/Leaf');
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect(guidAt('Shelf/InnerRoot/MidRoot/Leaf')).toBe(leaf);
      expect(piOf(idAt('Shelf/InnerRoot/MidRoot/Leaf'))?.rootInstanceId).toBe(idAt('Shelf/InnerRoot'));
    });
  });

  // …and undoing that move puts the member back on the owned root it belonged to.
  it('#1453: undoing that leave leaves the member linked to its owned root', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot/Leaf'), idAt('Outer3Root/Panel/MidRoot'));
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot'), idAt('Outer3Root/Panel'));
      reparentEntity(idAt('Outer3Root/Panel/MidRoot'), idAt('Outer3Root/Panel/InnerRoot'));
      const leaf = guidAt('Outer3Root/Panel/InnerRoot/MidRoot/Leaf');
      reparentEntity(idAt('Outer3Root/Panel/InnerRoot'), idAt('Shelf'));
      expect(await undo()).toBe(true);
      expect(guidAt('Outer3Root/Panel/InnerRoot/MidRoot/Leaf')).toBe(leaf);
      expect(piOf(idAt('Outer3Root/Panel/InnerRoot/MidRoot/Leaf'))?.rootInstanceId).toBe(idAt('Outer3Root/Panel/InnerRoot'));
    });
  });

  // #1454: removing the PrefabInstance component off MidRoot (the Inspector's remove button) cut the link without
  // ending the frame, and InnerRoot, Leaf and Knob, all moved out of MidRoot, vanished on reload. It is refused now;
  // Detach Prefab cuts a link. Mutation: drop the refusal in removeTraitFromEntitiesWithUndo.
  it('#1454: removing the PrefabInstance component is refused, and the moved-out members survive a reload', async () => {
    await withOuter3(async () => {
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot'), idAt('Outer3Root/Panel'));
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/Knob'), idAt('Outer3Root/Panel'));
      removeTraitFromEntitiesWithUndo([idAt('Outer3Root/Panel/MidRoot')], getTraitByName('PrefabInstance')!);
      expect(piOf(idAt('Outer3Root/Panel/MidRoot'))).toBeDefined();
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect([...treePaths().values()]).toEqual(expect.arrayContaining(['Outer3Root/Panel/InnerRoot/Leaf', 'Outer3Root/Panel/Knob']));
    }, withKnob);
  });

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

  const expectUniqueGuidsHere = () => {
    const guids = getAllEntities().map((e) => e.guid).filter(Boolean);
    expect(guids.length).toBe(new Set(guids).size);
  };
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

describe('a move inside the instance that leaves a member ABOVE its frame unpacks it (#1450)', () => {
  const piOf = (id: number) => ([...getCurrentWorld().entities].find((x) => x.id() === id)!
    .get(getTraitByName('PrefabInstance')!.trait)) as { rootInstanceId?: number; parentLocalId?: number } | undefined;
  const expectUniqueGuidsHere = () => {
    const guids = getAllEntities().map((e) => e.guid).filter(Boolean);
    expect(guids.length).toBe(new Set(guids).size);
  };
  /** The body's repro: the user-added INNER's Leaf moved beside its root, then the root dropped under it. */
  const rootUnderItsOwnMember = () => {
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel/Button'));
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button/InnerRoot'), idAt('Holder/OuterRoot/Panel/Button/Leaf'));
  };

  // The save writes a member from its frame's root down, so a member above that root was written nowhere, and the
  // instance vanished with it. Mutation: skip the above-its-frame loop when the move stays inside the instance
  // (restore the early `return null`).
  it('an added instance root dropped under its own member: the member unpacks, and both reload', async () => {
    await load(scene([]));
    rootUnderItsOwnMember();
    const leaf = guidAt('Holder/OuterRoot/Panel/Button/Leaf');
    const inner = guidAt('Holder/OuterRoot/Panel/Button/Leaf/InnerRoot');
    expect(piOf(idAt('Holder/OuterRoot/Panel/Button/Leaf'))).toBeUndefined();
    await load(await serializeScene() as unknown as SceneData);
    expectUniqueGuidsHere();
    expect(treePaths().get(leaf)).toBe('Holder/OuterRoot/Panel/Button/Leaf');
    expect(treePaths().get(inner)).toBe('Holder/OuterRoot/Panel/Button/Leaf/InnerRoot');
    expect(piOf(idAt('Holder/OuterRoot/Panel/Button/Leaf'))).toBeUndefined();
    const root = idAt('Holder/OuterRoot/Panel/Button/Leaf/InnerRoot');
    expect(piOf(root)).toMatchObject({ rootInstanceId: root, parentLocalId: 0 });
  });

  it('undo relinks the unpacked member and puts the root back; redo unpacks it again', async () => {
    await load(scene([]));
    rootUnderItsOwnMember();
    await undo();
    const root = idAt('Holder/OuterRoot/Panel/Button/InnerRoot');
    expect(piOf(idAt('Holder/OuterRoot/Panel/Button/Leaf'))?.rootInstanceId).toBe(root);
    await redo();
    expect(piOf(idAt('Holder/OuterRoot/Panel/Button/Leaf'))).toBeUndefined();
  });

  // The ACCEPT side: an OWNED nested root is not a frame — its members are saved by the stored root above it —
  // so one dropped under its own member keeps that member linked. Mutation: take the member's own root as its
  // frame in frameOf.
  it('an OWNED nested root dropped under its own member keeps it linked, and reloads so', async () => {
    await load(scene([]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot'), idAt('Holder/OuterRoot/Panel/Leaf'));
    const root = () => idAt('Holder/OuterRoot/Panel/Leaf/InnerRoot');
    expect(piOf(idAt('Holder/OuterRoot/Panel/Leaf'))?.rootInstanceId).toBe(root());
    await load(await serializeScene() as unknown as SceneData);
    expectUniqueGuidsHere();
    expect(piOf(idAt('Holder/OuterRoot/Panel/Leaf'))?.rootInstanceId).toBe(root());
    expect(piOf(root())?.parentLocalId).toBeGreaterThan(0);
  });

  // …and two owned levels deep: MID dropped under a member of the INNER its own row expanded.
  it('an owned root dropped under a member of the instance IT owns keeps everything linked, and reloads so', async () => {
    const MID = 'aaaaaaaa-0000-4000-8000-0000000000f7';
    const OUTER3 = 'aaaaaaaa-0000-4000-8000-0000000000f8';
    const midDoc = { id: MID, rootLocalId: 1, entities: [row(1, 'MidRoot', 0), row(2, 'Nested', 1, { prefab: INNER })] };
    const outer3 = { id: OUTER3, rootLocalId: 1, entities: [row(1, 'Outer3Root', 0), row(2, 'Panel', 1), row(3, 'Mid', 2, { prefab: MID })] };
    for (const [k, d] of [[MID, midDoc], [OUTER3, outer3]] as const) { prefabs.set(k, d); setPrefabCache(k, d as never); }
    try {
      await load({
        id: 'o3c', version: 1, name: 'O3', resources: [],
        entities: [{ id: 1, prefab: OUTER3, guid: ROOT, traits: { EntityAttributes: { name: 'Outer3Root', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } }],
      } as unknown as SceneData);
      reparentEntity(idAt('Outer3Root/Panel/MidRoot/InnerRoot/Leaf'), idAt('Outer3Root/Panel'));
      reparentEntity(idAt('Outer3Root/Panel/MidRoot'), idAt('Outer3Root/Panel/Leaf'));
      const linkedHere = () => {
        expect(piOf(idAt('Outer3Root/Panel/Leaf'))?.rootInstanceId).toBe(idAt('Outer3Root/Panel/Leaf/MidRoot/InnerRoot'));
        expect(piOf(idAt('Outer3Root/Panel/Leaf/MidRoot'))?.parentLocalId).toBeGreaterThan(0);
      };
      linkedHere();
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      linkedHere();
    } finally {
      for (const k of [MID, OUTER3]) { prefabs.delete(k); setPrefabCache(k, null); }
    }
  });
  // Close-out review: a stored MID dropped under the INNER its own row expanded. The frame loop stripped that owned
  // root instead of promoting it (#1447's rule), so its Leaf, moved beside it, named a plain entity and the save
  // dropped it. Mutation: push an owned root the save cannot write to `strip` instead of `promote`.
  it('a stored root dropped under its OWN owned nested root promotes that root; its members stay linked and reload', async () => {
    const MID = 'aaaaaaaa-0000-4000-8000-0000000000f9';
    const midDoc = { id: MID, rootLocalId: 1, entities: [row(1, 'MidRoot', 0), row(2, 'Nested', 1, { prefab: INNER })] };
    prefabs.set(MID, midDoc);
    setPrefabCache(MID, midDoc as never);
    try {
      const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
      sc.entities[1]!.added = [{ parentLocalId: 3, guid: ANCHORED, name: 'MidRoot', prefab: MID, traits: {}, children: [] }];
      await load(sc as unknown as SceneData);
      const at = (p: string) => idAt(`Holder/OuterRoot/Panel/Button/${p}`);
      const button = idAt('Holder/OuterRoot/Panel/Button');
      reparentEntity(at('MidRoot/InnerRoot'), button); // K beside U: a #1437 move
      reparentEntity(at('InnerRoot/Leaf'), button); // K's member beside K
      reparentEntity(at('MidRoot'), at('InnerRoot'));
      const inner = at('InnerRoot');
      expect(piOf(inner)).toMatchObject({ rootInstanceId: inner, parentLocalId: 0 });
      expect(piOf(at('Leaf'))?.rootInstanceId).toBe(inner);
      const before = [...treePaths().values()].sort();
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect([...treePaths().values()].sort()).toEqual(before);
      expect(piOf(at('Leaf'))?.rootInstanceId).toBe(at('InnerRoot'));
    } finally {
      prefabs.delete(MID);
      setPrefabCache(MID, null);
    }
  });
  // Close-out review 2: the verdicts are settled one at a time, because each can flip another. TDOC is a user-added
  // instance at Button; its A was moved beside its root, then Button dragged out of OUTER.
  const TDOC = 'aaaaaaaa-0000-4000-8000-0000000000fa';
  const M2 = 'aaaaaaaa-0000-4000-8000-0000000000fb';
  const MID2 = 'aaaaaaaa-0000-4000-8000-0000000000fc';
  const B = 'Holder/OuterRoot/Panel/Button';
  const withDocs = async (docs: Record<string, unknown>, body: () => Promise<void>) => {
    for (const [k, d] of Object.entries(docs)) { prefabs.set(k, d); setPrefabCache(k, d as never); }
    try { await body(); } finally { for (const k of Object.keys(docs)) { prefabs.delete(k); setPrefabCache(k, null); } }
  };
  const addedAtButton = (prefab: string, name: string, pre: Array<Record<string, unknown>> = []): SceneData => {
    const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = [{ parentLocalId: 3, guid: ANCHORED, name, prefab, traits: {}, children: [] }];
    sc.entities = [...pre, ...sc.entities];
    return sc as unknown as SceneData;
  };

  // A member under a member the same move unpacks is outside every instance too. Judged against the pre-strip
  // tree it stayed linked, and the save dropped it. Mutation: stop re-judging after a strip (judge every member
  // once, against the stripped set the pass started with).
  it('a member below one the move unpacks is unpacked too, and reloads', async () => {
    await withDocs({ [TDOC]: { id: TDOC, rootLocalId: 1, entities: [row(1, 'TRoot', 0), row(2, 'A', 1), row(3, 'B', 2)] } }, async () => {
      await load(addedAtButton(TDOC, 'TRoot'));
      reparentEntity(idAt(`${B}/TRoot/A`), idAt(B));
      reparentEntity(idAt(B), 0);
      expect(piOf(idAt('Button/A/B'))).toBeUndefined();
      const before = [...treePaths()].sort();
      await load(await serializeScene() as unknown as SceneData);
      expect([...treePaths()].sort()).toEqual(before);
    });
  });

  // An owned root under a member the move unpacks is split from its owner: promoted, so its members keep their
  // guids. Judged before that member was unpacked, it stayed owned and reloaded as a stored root under new guids.
  // Mutation: as above.
  it('an owned root below one the move unpacks is promoted, and its members keep their guids through reload', async () => {
    await withDocs({ [TDOC]: { id: TDOC, rootLocalId: 1, entities: [row(1, 'TRoot', 0), row(2, 'A', 1), row(3, 'Nested', 2, { prefab: INNER })] } }, async () => {
      await load(addedAtButton(TDOC, 'TRoot'));
      reparentEntity(idAt(`${B}/TRoot/A`), idAt(B));
      reparentEntity(idAt(B), 0);
      expect(piOf(idAt('Button/A/InnerRoot'))?.parentLocalId).toBe(0);
      const before = [...treePaths()].sort();
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect([...treePaths()].sort()).toEqual(before);
    });
  });

  // The order of the entity list decided which owned roots were promoted: with the INNER ahead of the MID that owns
  // it, both were, and the INNER was cut off from MID's row for good. Only the owner is. The pads, deleted, put the
  // INNER first (koota's swap-remove). Mutation: pick the first unwritable entity in list order.
  it('an owner is promoted before the roots it owns, whatever the entity order: its INNER stays its row', async () => {
    const midDoc = { id: MID2, rootLocalId: 1, entities: [row(1, 'MidRoot', 0), row(2, 'Nested', 1, { prefab: INNER })] };
    const m2Doc = { id: M2, rootLocalId: 1, entities: [row(1, 'M2Root', 0), row(2, 'Nested', 1, { prefab: MID2 })] };
    await withDocs({ [MID2]: midDoc, [M2]: m2Doc }, async () => {
      const pads = [1, 2].map((i) => ({ id: 200 + i, traits: { EntityAttributes: { name: `Pad${i}`, parentId: 0, guid: `cccccccc-0000-4000-8000-00000000001${i}` } } }));
      await load(addedAtButton(M2, 'M2Root', pads));
      deleteEntitiesWithUndo([idAt('Pad2')]);
      deleteEntitiesWithUndo([idAt('Pad1')]);
      // Precondition: M2's INNER comes ahead of the MID that owns it.
      expectInOrder(getAllEntities().map((e) => e.id), [idAt(`${B}/M2Root/MidRoot/InnerRoot`), idAt(`${B}/M2Root/MidRoot`)], 'entity order');
      reparentEntity(idAt(`${B}/M2Root/MidRoot`), idAt(B));
      reparentEntity(idAt(`${B}/M2Root`), idAt(`${B}/MidRoot/InnerRoot`));
      expect(piOf(idAt(`${B}/MidRoot`))?.parentLocalId).toBe(0);
      expect(piOf(idAt(`${B}/MidRoot/InnerRoot`))?.parentLocalId).toBeGreaterThan(0);
      const before = [...treePaths()].sort();
      await load(await serializeScene() as unknown as SceneData);
      expect([...treePaths()].sort()).toEqual(before);
      expect(piOf(idAt(`${B}/MidRoot/InnerRoot`))?.parentLocalId).toBeGreaterThan(0);
    });
  });
  // Close-out review 3: a LIVE child of an unpacked member that never moved (it sits at its row; "no recorded home"
  // before #1468 Phase 6). Inside the instance the unpack changes no outermost, so it used to be judged writable:
  // the owned root reloaded stored under new guids, the member reloaded plain while the editor showed it linked.
  // Mutation: drop the unpacked-identity-parent check in unwritable.
  it('an owned root and a member below a member unpacked INSIDE the instance: promoted / unpacked, and reload so', async () => {
    const doc = { id: TDOC, rootLocalId: 1, entities: [row(1, 'TRoot', 0), row(2, 'A', 1), row(3, 'Nested', 2, { prefab: INNER }), row(4, 'B', 2)] };
    await withDocs({ [TDOC]: doc }, async () => {
      await load(addedAtButton(TDOC, 'TRoot'));
      reparentEntity(idAt(`${B}/TRoot/A`), idAt(B));
      reparentEntity(idAt(`${B}/TRoot`), idAt(`${B}/A`));
      expect(piOf(idAt(`${B}/A`))).toBeUndefined(); // precondition: A sits above its frame
      expect(piOf(idAt(`${B}/A/InnerRoot`))?.parentLocalId).toBe(0);
      expect(piOf(idAt(`${B}/A/B`))).toBeUndefined();
      const before = [...treePaths()].sort();
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect([...treePaths()].sort()).toEqual(before);
      expect(piOf(idAt(`${B}/A/B`))).toBeUndefined();
    });
  });

  // Close-out review 3: with nothing free, the fallback took the shallowest — an INNER ahead of the MID that owns
  // it — and cut the INNER off MID's row. Mutation: fall back to the shallowest of all the unwritable.
  it('with nothing free, an owner is still promoted before the roots it owns', async () => {
    const MID3 = 'aaaaaaaa-0000-4000-8000-0000000000fd';
    const T2 = 'aaaaaaaa-0000-4000-8000-0000000000fe';
    const mid3 = { id: MID3, rootLocalId: 1, entities: [row(1, 'MidRoot', 0), row(2, 'Wm', 1), row(3, 'Nested', 2, { prefab: INNER })] };
    const m2 = { id: M2, rootLocalId: 1, entities: [row(1, 'M2Root', 0), row(2, 'Nested', 1, { prefab: MID3 })] };
    const t2 = { id: T2, rootLocalId: 1, entities: [row(1, 'TRoot', 0), row(2, 'A', 1)] };
    await withDocs({ [MID3]: mid3, [M2]: m2, [T2]: t2 }, async () => {
      const sc = scene([]) as unknown as { entities: Array<Record<string, unknown>> };
      sc.entities[1]!.added = [
        { parentLocalId: 3, guid: ANCHORED, name: 'M2Root', prefab: M2, traits: {}, children: [] },
        { parentLocalId: 3, guid: 'bbbbbbbb-0000-4000-8000-0000000000c4', name: 'TRoot', prefab: T2, traits: {}, children: [] },
      ];
      await load(sc as unknown as SceneData);
      reparentEntity(idAt(`${B}/M2Root/MidRoot/Wm/InnerRoot`), idAt(`${B}/TRoot`));
      reparentEntity(idAt(`${B}/M2Root/MidRoot/Wm`), idAt(`${B}/TRoot/A`));
      reparentEntity(idAt(`${B}/M2Root/MidRoot`), idAt(`${B}/TRoot/A/Wm`));
      reparentEntity(idAt(B), 0);
      expect(piOf(idAt('Button/TRoot/A/Wm/MidRoot'))?.parentLocalId).toBe(0);
      expect(piOf(idAt('Button/TRoot/InnerRoot'))?.parentLocalId).toBeGreaterThan(0);
      const before = [...treePaths()].sort();
      await load(await serializeScene() as unknown as SceneData);
      expectUniqueGuidsHere();
      expect([...treePaths()].sort()).toEqual(before);
      expect(piOf(idAt('Button/TRoot/InnerRoot'))?.parentLocalId).toBeGreaterThan(0);
    });
  });
});

describe('the loader applies moves against the tree they describe, not the half-moved one (#1452)', () => {
  // The save writes Panel → Button and Button → the root; applied in that order, Button still sat under Panel, so
  // Panel's move was refused as a cycle and reloaded at its row. Mutation: apply the chosen moves in one pass, in
  // order (drop the waiting loop in drainAfterDerive).
  it('a member moved under a member that was its row descendant keeps its move through save + reload', async () => {
    await load(scene([]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button'), idAt('Holder/OuterRoot'));
    reparentEntity(idAt('Holder/OuterRoot/Panel'), idAt('Holder/OuterRoot/Button'));
    const before = [...treePaths()].sort();
    await load(await serializeScene() as unknown as SceneData);
    expect([...treePaths()].sort()).toEqual(before);
    expect(treePaths().get(guidAt('Holder/OuterRoot/Button/Panel/InnerRoot/Leaf'))).toBe('Holder/OuterRoot/Button/Panel/InnerRoot/Leaf');
  });

  // Close-out review: the same shape split across the two kinds of move the drain mixes — the PREFAB's own move
  // (Button up, written by serializePrefab) and the instance's (Panel under Button). Mutation: as above.
  it('a prefab move and an instance move that pass through a halfway cycle both land through save + reload', async () => {
    const GROUP = 'bbbbbbbb-0000-4000-8000-0000000000d1';
    const X_ROOT = 'bbbbbbbb-0000-4000-8000-0000000000d2';
    await load({
      id: 'grp', version: 15, name: 'G', resources: [],
      entities: [
        { id: 1, traits: { EntityAttributes: { name: 'Group', parentId: 0, guid: GROUP }, Transform: { x: 0, y: 0, z: 0 } } },
        { id: 2, prefab: OUTER, guid: ROOT, traits: { EntityAttributes: { name: 'OuterRoot', parentId: GROUP }, Transform: { x: 0, y: 0, z: 0 } } },
      ],
    } as unknown as SceneData);
    reparentEntity(idAt('Group/OuterRoot/Panel/Button'), idAt('Group/OuterRoot'));
    const file = serializePrefab(idAt('Group'))!;
    prefabs.set(file.id!, file);
    setPrefabCache(file.id!, file);
    try {
      await load({ id: 'x', version: 15, name: 'X', resources: [], entities: [
        { id: 1, prefab: file.id, guid: X_ROOT, traits: { EntityAttributes: { name: 'Group', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      ] } as unknown as SceneData);
      expect(treePaths().has(guidAt('Group/OuterRoot/Button'))).toBe(true); // precondition: the prefab's move applies
      reparentEntity(idAt('Group/OuterRoot/Panel'), idAt('Group/OuterRoot/Button'));
      const before = [...treePaths()].sort();
      await load(await serializeScene() as unknown as SceneData);
      expect([...treePaths()].sort()).toEqual(before);
    } finally {
      prefabs.delete(file.id!);
      setPrefabCache(file.id!, null);
    }
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
      rebuildInstance(idAt('ORoot'), O6, oDoc, captureInstanceOverrides(idAt('ORoot'), oDoc), captureInstanceStructure(idAt('ORoot'), oDoc));
      expect(zx()).toBe(7);
      const before = [...treePaths().values()].sort();
      await load(await serializeScene() as unknown as SceneData);
      expect([...treePaths().values()].sort()).toEqual(before);
      expect(getAllEntities().filter((e) => e.name === 'ZRoot')).toHaveLength(1);
      expect(zx()).toBe(7);
    } finally { for (const k of Object.keys(docs)) { prefabs.delete(k); setPrefabCache(k, null); } }
  });

  // …and when that root IS moved, the owner link it takes is the OUTER frame's, not Q's — the document rejects a
  // Q link, which would leave it with no owner at all. Mutation: have linkOwnerBeforeMove take the live parent's
  // `rootInstanceId` instead of the resolver's owner.
  it('moved, it links to the outer instance and reloads there with its guid', async () => {
    for (const [k, d] of Object.entries(docs)) { prefabs.set(k, d); setPrefabCache(k, d as never); }
    try {
      await load({ id: 'n6', version: 16, name: 'N6', resources: [], entities: [
        { id: 1, prefab: O6, guid: ROOT, traits: { EntityAttributes: { name: 'ORoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      ] } as unknown as SceneData);
      const z = guidAt('ORoot/QRoot/ZRoot');
      const leaf = guidAt('ORoot/QRoot/ZRoot/ZLeaf');
      reparentEntity(idAt('ORoot/QRoot/ZRoot'), idAt('ORoot'));
      const pi = [...getCurrentWorld().entities].find((e) => e.id() === idAt('ORoot/ZRoot'))!
        .get(getTraitByName('PrefabInstance')!.trait) as { ownerGuid?: string };
      expect(pi.ownerGuid).toBe(ROOT);
      await load(await serializeScene() as unknown as SceneData);
      expect(guidAt('ORoot/ZRoot')).toBe(z);
      expect(guidAt('ORoot/ZRoot/ZLeaf')).toBe(leaf);
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

  // #1484 (2): an Apply or Revert on source Q rebuilds the nested Q alone. Mutation: drop `foreignOwned` from the
  // park predicate in `rebuildInstance` (Z is torn down with Q's subtree and nothing respawns it).
  it('rebuilding the inner instance keeps the outer frame\'s row under it, its guid and its edit', async () => {
    await loadO();
    const z = guidAt('ORoot/QRoot/ZRoot');
    const leaf = guidAt('ORoot/QRoot/ZRoot/ZLeaf');
    writeTraitFieldWithUndo(idAt('ORoot/QRoot/ZRoot/ZLeaf'), getTraitByName('Transform')!, 'x', 7);
    const q = idAt('ORoot/QRoot');
    const qDoc = docs[Q7] as never;
    rebuildInstance(q, Q7, qDoc, captureInstanceOverrides(q, qDoc), captureInstanceStructure(q, qDoc));
    expect(getAllEntities().filter((e) => e.name === 'ZRoot')).toHaveLength(1);
    expect(getAllEntities().filter((e) => e.name === 'Plain')).toHaveLength(1); // a plain row of O's under Q, too
    expect(guidAt('ORoot/QRoot/ZRoot')).toBe(z);
    expect(tfOf(idAt('ORoot/QRoot/ZRoot/ZLeaf')).x).toBe(7);
    await load(await serializeScene() as unknown as SceneData);
    expect(guidAt('ORoot/QRoot/ZRoot/ZLeaf')).toBe(leaf);
    expect(tfOf(idAt('ORoot/QRoot/ZRoot/ZLeaf')).x).toBe(7);
  });
  // …and a rebuild that tears the OWNER down too still destroys it, rather than parking a root whose frame is going.
  // Mutation: return 0 from rebuildInstance's `frameOf` for an unmoved owned root (the pre-fix answer) — ZRoot is
  // then parked through O's rebuild and survives beside its own respawn.
  it('rebuilding the outer instance respawns the row once', async () => {
    await loadO();
    const o = idAt('ORoot');
    const oDoc = docs[O7] as never;
    rebuildInstance(o, O7, oDoc, captureInstanceOverrides(o, oDoc), captureInstanceStructure(o, oDoc));
    expect(getAllEntities().filter((e) => e.name === 'ZRoot')).toHaveLength(1);
    expect(getAllEntities().filter((e) => e.name === 'ZLeaf')).toHaveLength(1);
  });

  // One level further out: P nests O, so O's QRoot is an owned root of ANOTHER frame hanging under a nested root of
  // P's — parked by P's rebuild, and destroyed with its owner O, which that rebuild respawns. Mutation: return 0 from
  // rebuildInstance's `frameOf` for an unmoved owned root (the pre-fix answer): QRoot then stays parked through the
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
      rebuildInstance(p, P7, pDoc as never, captureInstanceOverrides(p, pDoc as never), captureInstanceStructure(p, pDoc as never));
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
    rebuildInstance(o, O7, oDoc, captureInstanceOverrides(o, oDoc), captureInstanceStructure(o, oDoc));
    expect(getAllEntities().filter((e) => e.name === 'ZRoot')).toHaveLength(0);
    expect((await oEntry()).removed).toEqual([3]);
  });

  // Review finding 1: the FILE-side path walk (`memberPathRecords`) must agree with the live derive on the frame step,
  // or an Apply that names a member by path finds nothing. P nests O; ZLeaf (O's Z's member) is moved under P's own
  // row, and the Apply's `~moved` key must survive the "names nothing now" filter. Mutation: drop the FRAME_STEP
  // unshift in `memberPaths.ts`' `baseOf` (the Apply reports applied and writes no move).
  it('an Apply of a move of a member inside the nested row under the nested row writes the move', async () => {
    const P7 = 'aaaaaaaa-0000-4000-8000-0000000007b6';
    const pDoc = { id: P7, rootLocalId: 1, entities: [row(1, 'PRoot', 0), row(2, 'ORow', 1, { prefab: O7 }), row(3, 'PCtrl', 1)] };
    prefabs.set(P7, pDoc); setPrefabCache(P7, pDoc as never);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, rewritten: [], held: [] }) }) as unknown as Response));
    try {
      await load({ id: 'n7a', version: 16, name: 'N7A', resources: [], entities: [
        { id: 1, prefab: P7, guid: ROOT, traits: { EntityAttributes: { name: 'PRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      ] } as unknown as SceneData);
      reparentEntity(idAt('PRoot/ORoot/QRoot/ZRoot/ZLeaf'), idAt('PRoot/PCtrl'));
      const moveKeys = collectInstanceOverrideKeys(idAt('PRoot'), pDoc as never).moved;
      expect(moveKeys).toHaveLength(1);
      const result = await applyToPrefabSelective(idAt('PRoot'), new Set(moveKeys));
      expect(result.applied).toBe(true);
      expect(Object.keys(result.prefabAfter!.moved ?? {})).toEqual(['2.2.@.3.2']);
      expect(idAt('PRoot/PCtrl/ZLeaf')).toBeGreaterThan(0);
    } finally { vi.unstubAllGlobals(); prefabs.delete(P7); setPrefabCache(P7, null); }
  });

  // Review finding 3: in PREFAB-EDIT, O's own rows under Q's root are the edited document's, not Q's; a Revert on Q
  // rebuilt Q and tore them down, and the edit save then wrote O without them. Mutation: drop the `editRow` park in
  // `rebuildInstance`.
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

  // #1481, the comment: an OWNED nested root moved inside its instance gets a compensated pose that is written
  // unmarked. Its row is its owner's, so the gate must ask the owner's frame whether it moved. Mutation: return false
  // from `ownedRootMoved` (the pose is dropped and the root reloads at its base, x=0).
  it('an owned nested root moved with a compensated pose keeps it through save + reload; moved back, nothing is pinned', async () => {
    await loadO();
    const zRoot = idAt('ORoot/QRoot/ZRoot');
    reparentEntity(zRoot, idAt('ORoot/Ctrl'));
    const e = [...getCurrentWorld().entities].find((x) => x.id() === idAt('ORoot/Ctrl/ZRoot'))!;
    e.set(getTraitByName('Transform')!.trait, { ...tfOf(e.id()), x: 7 }); // as the compensation writes it: unmarked
    const moved = await serializeScene();
    // Moved back before any reload (a reload re-seeds marks from what was saved): the gate applies again, and the
    // unmarked compensation is not pinned.
    reparentEntity(idAt('ORoot/Ctrl/ZRoot'), idAt('ORoot/QRoot'));
    await load(await serializeScene() as unknown as SceneData);
    expect(tfOf(idAt('ORoot/QRoot/ZRoot')).x).toBe(0);
    await load(moved as unknown as SceneData);
    expect(tfOf(idAt('ORoot/Ctrl/ZRoot')).x).toBe(7);
  });

  // …and when the ROW authors the root's position too (the spaceship's mirrored flames, where #1481's live loss was
  // seen): the nested delta dropped a field the row sets by KEY, so the compensated position went and the root
  // reloaded at the row's value under its new parent. Since #1498 every field the row sets comes off by value, so
  // this is no longer a special case. Mutation: compare by KEY in `subtractChainOverrides` (drop its value test).
  it('a moved owned root keeps its compensated pose when its row authors the same fields', async () => {
    use(docsOf(false, { x: 2 }));
    await loadO();
    expect(tfOf(idAt('ORoot/QRoot/ZRoot')).x).toBe(2);
    reparentEntity(idAt('ORoot/QRoot/ZRoot'), idAt('ORoot/Ctrl'));
    const e = [...getCurrentWorld().entities].find((x) => x.id() === idAt('ORoot/Ctrl/ZRoot'))!;
    e.set(getTraitByName('Transform')!.trait, { ...tfOf(e.id()), x: 7 });
    const moved = await serializeScene();
    reparentEntity(idAt('ORoot/Ctrl/ZRoot'), idAt('ORoot/QRoot'));
    // The raw `x: 7` above stands in for the move's compensation, so moving back takes it off again — as the real
    // compensation would. (Left on, the root really sits at 7, and 7 is what a save now keeps.)
    const back = [...getCurrentWorld().entities].find((x) => x.id() === idAt('ORoot/QRoot/ZRoot'))!;
    back.set(getTraitByName('Transform')!.trait, { ...tfOf(back.id()), x: 2 });
    await load(await serializeScene() as unknown as SceneData);
    expect(tfOf(idAt('ORoot/QRoot/ZRoot')).x).toBe(2); // moved back: the row's value, nothing pinned
    await load(moved as unknown as SceneData);
    expect(tfOf(idAt('ORoot/Ctrl/ZRoot')).x).toBe(7);
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
      const button = idAt('Holder/OuterRoot/Panel/Button');
      expect(first.moved(button)).toBe(false);
      reparentEntity(button, idAt('Holder/OuterRoot'));
      const after = worldIdentityParents(getCurrentWorld());
      expect(after).not.toBe(first);
      expect(after.moved(button)).toBe(true);
    } finally { closeIdentityScope(); }
  });
});

// #1468 Phase 1's close-out found the home walks stepping a node by `memberStepId` alone, where the derive
// walk takes the template key first — and named a keyed REFERENCE root as the node that tells them apart.
// `rehomeDependents` could not reach one: it stopped at every instance root (#1451), and a keyed reference root is
// one. `isHomePosition` had no such stop, so it read ANY root as a step — its `localId` — and a root whose
// localId equals the home's recorded step passed for the position the member started at. Both are gone since
// #1468 Phase 6 (the path is read from the document, which never steps through a live entity); the test stays as
// a pin on the outcome.
describe('the home test does not step through an instance root (#1468 Phase 1 close-out)', () => {
  const P = 'aaaaaaaa-0000-4000-8000-0000000001a1';
  const Q = 'aaaaaaaa-0000-4000-8000-0000000001a2';
  // Q's root has localId 3 — the same number as P's `Mid`, the row the member's home is re-pointed past.
  const qDoc = { id: Q, rootLocalId: 3, entities: [row(3, 'QRoot', 0)] };
  const pDoc = { id: P, rootLocalId: 1, entities: [row(1, 'PRoot', 0), row(2, 'Panel', 1), row(3, 'Mid', 2), row(5, 'Leaf', 3)] };
  const homeOf = (id: number) => {
    return homeView(id);
  };

  // (Written against `isHomePosition`, which stepped through a live root by its localId. Nothing steps through
  // live entities now — the path is the document's — so this pins the outcome: still moved, same steps.)
  it('a member dragged under a scene-added instance root whose localId matches its home step keeps its home', async () => {
    prefabs.set(P, pDoc); prefabs.set(Q, qDoc);
    setPrefabCache(P, pDoc as never); setPrefabCache(Q, qDoc as never);
    try {
      await load({
        id: 'home-root', version: 15, name: 'H', resources: [], entities: [
          { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
          { id: 2, prefab: P, guid: ROOT, traits: { EntityAttributes: { name: 'PRoot', parentId: HOLDER }, Transform: { x: 0, y: 0, z: 0 } },
            added: [{ parentLocalId: 2, guid: ANCHORED, name: 'QRoot', prefab: Q, traits: {}, children: [] }] },
        ],
      } as unknown as SceneData);
      reparentEntity(idAt('Holder/PRoot/Panel/Mid/Leaf'), idAt('Holder/PRoot/Panel'));
      deleteEntitiesWithUndo([idAt('Holder/PRoot/Panel/Mid')]);
      const leaf = idAt('Holder/PRoot/Panel/Leaf');
      const home = { homeParent: guidAt('Holder/PRoot/Panel'), homeSteps: '3' };
      expect(homeOf(leaf)).toEqual(home); // the precondition: re-pointed past the deleted row, one step
      reparentEntity(leaf, idAt('Holder/PRoot/Panel/QRoot'));
      expect(homeOf(leaf)).toEqual(home);
    } finally { prefabs.delete(P); prefabs.delete(Q); setPrefabCache(P, null); setPrefabCache(Q, null); }
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

  // Mutation: stop passing `node.moved` in spawnNestedInstance.
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

// Close-out review finding 1, in the two NESTED writers: a member of a pre-v5 nested template has no row,
// so its move must go to the legacy map of the node or path it sits in, or it is lost on reload (#1468).
describe('a move of a pre-v5 NESTED member survives save + reload (#1468)', () => {
  const INNER_V4 = { id: INNER, version: 4, rootLocalId: 1, entities: innerDoc.entities.map(({ nodeGuid: _n, ...r }) => r) };
  beforeEach(() => { prefabs.set(INNER, INNER_V4); setPrefabCache(INNER, INNER_V4 as never); });

  // Mutation: drop `moved: ref.moved` from the reference node the capture writes.
  it('inside a user-added reference node: written on the node, and reloads there', async () => {
    await load(scene([]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel/Button'));
    const saved = await serializeScene() as unknown as SceneData;
    const node = (view(saved).entities as unknown as Array<{ added?: Array<{ moved?: unknown }> }>)[1]!.added![0]!;
    expect(node.moved).toEqual({ 2: guidAt('Holder/OuterRoot/Panel/Button') });
    await load(saved);
    expect(idAt('Holder/OuterRoot/Panel/Button/Leaf')).toBeGreaterThan(0);
  });

  // Mutation: drop the `moved` spread from captureNestedChannels' `live`.
  it('inside an owned nested row: written under its `nestedStructure` path, and reloads there', async () => {
    await load(scene([]));
    reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
    const saved = await serializeScene() as unknown as SceneData;
    const entry = (saved.entities as unknown as Array<{ nestedStructure?: Record<string, { moved?: unknown }> }>)[1]!;
    expect(entry.nestedStructure?.['4']?.moved).toEqual({ 2: guidAt('Holder/OuterRoot/Panel') });
    await load(saved);
    expect(idAt('Holder/OuterRoot/Panel/Leaf')).toBeGreaterThan(0);
  });
});


// Second close-out review, F1 and F2: "will a row carry this move" must be asked of the key space the SAVE
// writes in — the stored root's — and a nested root with no identity in its outer frame has none. Both
// shapes are the ordinary upgrade path: an old (pre-v5) outer prefab around a re-saved inner one (#1468).
describe('a move under a nested root with no outer identity survives save + reload (#1468)', () => {
  const X = 'aaaaaaaa-0000-4000-8000-0000000001c1';
  const MID = 'aaaaaaaa-0000-4000-8000-0000000001c2';
  const strip = <T extends { entities: Array<{ nodeGuid?: string }> }>(d: T) => ({ ...d, version: 4, entities: d.entities.map(({ nodeGuid: _n, ...r }) => r) });
  const place = (source: string): SceneData => ({
    id: 'nested-v4', version: 1, name: 'N', resources: [], entities: [
      { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
      { id: 2, prefab: source, guid: ROOT, traits: { EntityAttributes: { name: 'OuterRoot', parentId: HOLDER }, Transform: { x: 0, y: 0, z: 0 } } },
    ],
  } as unknown as SceneData);
  const install = (id: string, doc: unknown) => { prefabs.set(id, doc); setPrefabCache(id, doc as never); };
  afterEach(() => { for (const id of [X, MID]) { prefabs.delete(id); setPrefabCache(id, null); } });

  // F1. Mutation: ask `memberRowsToWrite(rootInstanceId)` in captureInstanceStructure (the capture root).
  it('v4 outer → v4 middle → v5 inner: the inner member`s move is kept', async () => {
    install(MID, strip({ id: MID, rootLocalId: 1, entities: [row(1, 'MidRoot', 0), row(2, 'Nested', 1, { prefab: INNER })] }));
    install(X, strip({ id: X, rootLocalId: 1, entities: [row(1, 'OuterRoot', 0), row(2, 'Panel', 1), row(3, 'Mid', 2, { prefab: MID })] }));
    await load(place(X));
    reparentEntity(idAt('Holder/OuterRoot/Panel/MidRoot/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel/MidRoot'));
    await load(await serializeScene() as unknown as SceneData);
    expect(idAt('Holder/OuterRoot/Panel/MidRoot/Leaf')).toBeGreaterThan(0);
  });

  // Third review's T1: the gap in the MIDDLE of a v5 chain. Mutation: as F1.
  it('v5 outer → v4 middle → v5 inner: the move is kept, and the member keeps its guid', async () => {
    install(MID, strip({ id: MID, rootLocalId: 1, entities: [row(1, 'MidRoot', 0), row(2, 'Nested', 1, { prefab: INNER })] }));
    install(X, { id: X, rootLocalId: 1, entities: [row(1, 'OuterRoot', 0), row(2, 'Panel', 1), row(3, 'Mid', 2, { prefab: MID })] });
    await load(place(X));
    const leaf = guidAt('Holder/OuterRoot/Panel/MidRoot/InnerRoot/Leaf');
    reparentEntity(idAt('Holder/OuterRoot/Panel/MidRoot/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel/MidRoot'));
    await load(await serializeScene() as unknown as SceneData);
    expect(guidAt('Holder/OuterRoot/Panel/MidRoot/Leaf')).toBe(leaf);
  });

  // Third review's T3: the writer is a user-added REFERENCE node (`rowWritingRoot` stops there, not at the
  // scene entry). Mutation: as F1.
  it('a reference node of a v4 prefab around a v5 inner: the move is kept, and the member keeps its guid', async () => {
    install(MID, strip({ id: MID, rootLocalId: 1, entities: [row(1, 'MidRoot', 0), row(2, 'Nested', 1, { prefab: INNER })] }));
    install(X, { id: X, rootLocalId: 1, entities: [row(1, 'OuterRoot', 0), row(2, 'Panel', 1)] });
    const sc = place(X) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.added = [{ parentLocalId: 2, guid: ANCHORED, name: 'MidRoot', prefab: MID, traits: {}, children: [] }];
    await load(sc as unknown as SceneData);
    const leaf = guidAt('Holder/OuterRoot/Panel/MidRoot/InnerRoot/Leaf');
    reparentEntity(idAt('Holder/OuterRoot/Panel/MidRoot/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel/MidRoot'));
    await load(await serializeScene() as unknown as SceneData);
    expect(guidAt('Holder/OuterRoot/Panel/MidRoot/Leaf')).toBe(leaf);
  });

  // F2. Mutation: let memberNodeId fall back to `nodeGuid` for a nested root.
  it('v4 outer with two rows of one v5 inner: the moved member keeps its move, and no pin is dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      install(X, strip({ id: X, rootLocalId: 1, entities: [
        row(1, 'OuterRoot', 0), row(2, 'Panel', 1), row(3, 'Button', 2), row(4, 'Nested', 2, { prefab: INNER }), row(5, 'Nested2', 3, { prefab: INNER }),
      ] }));
      await load(place(X));
      reparentEntity(idAt('Holder/OuterRoot/Panel/InnerRoot/Leaf'), idAt('Holder/OuterRoot/Panel'));
      await load(await serializeScene() as unknown as SceneData);
      expect(idAt('Holder/OuterRoot/Panel/Leaf')).toBeGreaterThan(0);
      expect(idAt('Holder/OuterRoot/Panel/Button/InnerRoot/Leaf')).toBeGreaterThan(0);
      expect(warn.mock.calls.filter((c) => /pin|collid/i.test(String(c[0])))).toEqual([]);
    } finally { warn.mockRestore(); }
  });
});
