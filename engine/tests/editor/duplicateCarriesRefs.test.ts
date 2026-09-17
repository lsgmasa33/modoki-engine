/** #1338 — an editor duplicate carries references INSIDE the copied subtree, including refs to
 *  prefab-instance MEMBERS, whose guids are never saved: a reload re-derives them from the nearest
 *  guid-carrying ancestor. So the only honest check is the whole loop — load a scene through the real
 *  loader, duplicate in the editor, serialize, load the result, and resolve each ref by tree path.
 *  (The plain-entity cases run without the loader in packages/modoki/tests/editor/entityActions.test.ts.) */

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
import {
  duplicateEntity, writeTraitFieldWithUndo, setActionCallback, pushAction, clearHistory, serializeScene,
  reparentEntity, deleteEntitiesWithUndo,
} from '@modoki/engine/editor';
import { setPrefabCache, captureInstanceStructure, rebuildInstance } from '../../packages/modoki/src/editor/scene/prefab';
import { undo } from '../../packages/modoki/src/editor/undo/undoManager';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const INNER = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const OUTER = 'aaaaaaaa-0000-4000-8000-0000000000c2';
const HOLDER = 'bbbbbbbb-0000-4000-8000-0000000000c1';
const ROOT = 'bbbbbbbb-0000-4000-8000-0000000000c2';
const ANCHORED = 'bbbbbbbb-0000-4000-8000-0000000000c3';

const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
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
    onInstantiatePrefab: async (source, parentId, rootTf, _old, extra, overrides, structure, nested, rootGuid) => {
      const world = getCurrentWorld();
      const rootId = instantiatePrefabIntoWorld(world, prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested);
      if (!rootId) return;
      for (const e of world.entities) {
        if (e.id() !== rootId) continue;
        for (const [name, data] of Object.entries(extra ?? {})) {
          const meta = getTraitByName(name);
          if (meta) e.add(meta.trait(data as never));
        }
        if (rootGuid) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid: rootGuid });
      }
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

  // Mutation: in reparentEntity's detach walk, stop unpacking owned nested roots.
  it('a MEMBER holding an owned nested instance, moved out: the nested instance unpacks too, and a ref to its Leaf survives', async () => {
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
  it('an OWNED nested instance rebuilt, then moved out: it still unpacks, and a ref to its Leaf survives', async () => {
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
  });

  // #1355 re-review, findings 1 and 3: a stored root dropped INSIDE an instance still unpacks, or the
  // save loses it. Mutation: drop `!hasInstanceAncestorOrSelf(...)` from reparentEntity's keepLinked.
  // Under a member of an owned nested instance it survives but reloads at the scene root: nothing
  // saves structure inside an owned nested instance (#1358), so only survival is pinned there.
  it.each([
    ['under a member that owns a row of its prefab', 'Holder/OuterRoot/Panel', 'Holder/OuterRoot/Panel/'],
    ['under a member of an owned nested instance', 'Holder/OuterRoot/Panel/InnerRoot/Leaf', ''],
  ])('a top-level instance moved %s survives save + reload', async (_label, target, reloadedAt) => {
    const sc = withShelf() as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities.push({ id: 4, prefab: INNER, guid: 'bbbbbbbb-0000-4000-8000-0000000000c5', traits: { EntityAttributes: { name: 'InnerRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } });
    await load(sc as unknown as SceneData);
    const solo = idAt('InnerRoot');
    rename(solo, 'Solo'); // the prefab names the root; a rename is an override the save keeps
    reparentEntity(solo, idAt(target));
    await load(await serializeScene() as unknown as SceneData);
    expectUniqueGuids();
    expect([...treePaths().values()].filter((p) => p.includes('Solo'))).toEqual([`${reloadedAt}Solo`, `${reloadedAt}Solo/Leaf`]);
  });

  // #1355 third review: the unpack's undo stored the numeric rootInstanceId, which a world rebuild
  // reassigns. Mutation: restore `t.data` as captured in reparentEntity's undoDetach.
  it('an unpack undone AFTER a world rebuild relinks the instance to its live root, and the save keeps it', async () => {
    const sc = withShelf() as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities.push({ id: 4, prefab: INNER, guid: 'bbbbbbbb-0000-4000-8000-0000000000c5', traits: { EntityAttributes: { name: 'InnerRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } });
    await load(sc as unknown as SceneData);
    const solo = idAt('InnerRoot');
    rename(solo, 'Solo');
    reparentEntity(solo, idAt('Holder/OuterRoot/Panel/Button'));
    // Rebuild the world with extra entities spawned first, so the ecs ids move (as a Play→Stop revert can).
    const saved = await serializeScene() as unknown as { entities: unknown[] };
    const pad = [1, 2, 3, 4, 5].map((i) => ({ id: 100 + i, traits: { EntityAttributes: { name: `Pad${i}`, parentId: 0, guid: `cccccccc-0000-4000-8000-00000000000${i}` } } }));
    await load({ ...saved, entities: [...pad, ...saved.entities] } as unknown as SceneData);
    expect(idAt('Holder/OuterRoot/Panel/Button/Solo')).not.toBe(solo); // precondition: the id moved
    await undo();
    const root = idAt('Solo');
    const pi = [...getCurrentWorld().entities].find((e) => e.id() === root)!.get(getTraitByName('PrefabInstance')!.trait) as { rootInstanceId?: number };
    expect(pi?.rootInstanceId).toBe(root);
    await load(await serializeScene() as unknown as SceneData);
    // By guid, not name: the rename's override mark does not survive the unpacked round trip.
    const soloPath = treePaths().get('bbbbbbbb-0000-4000-8000-0000000000c5');
    expect(soloPath).toBeDefined();
    expect([...treePaths().values()].filter((p) => p.startsWith(`${soloPath}`))).toEqual([soloPath, `${soloPath}/Leaf`]);
  });

  /** Save, then reload with five plain entities spawned first, so every ecs id moves. */
  const rebuild = async (): Promise<void> => {
    const saved = await serializeScene() as unknown as { entities: unknown[] };
    const pad = [1, 2, 3, 4, 5].map((i) => ({ id: 100 + i, traits: { EntityAttributes: { name: `Pad${i}`, parentId: 0, guid: `cccccccc-0000-4000-8000-00000000000${i}` } } }));
    await load({ ...saved, entities: [...pad, ...saved.entities] } as unknown as SceneData);
  };

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
  // guid is minted at move time and re-derived differently by the rebuild, so the ref misses. The
  // stale id then names an unrelated entity; relinking to it made the save drop the moved entity.
  // Mutation: fall back to `t.data.rootInstanceId` when the owner does not resolve.
  it('an unpack undone after a rebuild whose owner no longer resolves leaves the entity plain, and the save keeps it', async () => {
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
    expect(live[0]!.has(getTraitByName('PrefabInstance')!.trait)).toBe(false);
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

  it('left in place: it is NOT recorded as removed (stamped parentLocalId, and the legacy unstamped form)', async () => {
    await load(withShelf());
    const piMeta = getTraitByName('PrefabInstance')!;
    const inner = [...getCurrentWorld().entities].find((e) => e.id() === idAt('Holder/OuterRoot/Panel/InnerRoot'))!;
    for (const stamp of [4, 0]) {
      inner.set(piMeta.trait, { ...(inner.get(piMeta.trait) as object), parentLocalId: stamp });
      const saved = await serializeScene() as unknown as { entities: Array<{ prefab?: string; removed?: number[] }> };
      expect(saved.entities.find((e) => e.prefab === OUTER)?.removed).toBeUndefined();
    }
    await load(await serializeScene() as unknown as SceneData);
    expect([...treePaths().values()]).toContain('Holder/OuterRoot/Panel/InnerRoot/Leaf');
  });
});
