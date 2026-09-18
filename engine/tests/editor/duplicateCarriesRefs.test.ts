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
import { setPrefabCache, captureInstanceStructure, captureInstanceOverrides, rebuildInstance, instantiatePrefab } from '../../packages/modoki/src/editor/scene/prefab';
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
  // The second case reloaded at the SCENE ROOT until #1358 gave the scene a structural channel for a
  // row's own expansion; only survival was pinned then. Now that it round-trips in place, the
  // expectation is the real path — this is the pin #1358 existed to tighten.
  it.each([
    ['under a member that owns a row of its prefab', 'Holder/OuterRoot/Panel', 'Holder/OuterRoot/Panel/'],
    ['under a member of an owned nested instance', 'Holder/OuterRoot/Panel/InnerRoot/Leaf', 'Holder/OuterRoot/Panel/InnerRoot/Leaf/'],
  ])('a top-level instance moved %s survives save + reload, under its exact parent', async (_label, target, reloadedAt) => {
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
  const ownerEntry = (saved: unknown) => (saved as {
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
    const entry = saved.entities.find((e) => e.prefab === OUTER)!;
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
    const entry = saved.entities.find((e) => e.prefab === OUTER)!;
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
    const entry = saved.entities.find((e) => e.prefab === OUTER)!;
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
  const entryOf = (saved: Saved) => saved.entities.find((e) => e.prefab === OUTER)!;
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
    expect(JSON.stringify(saved.entities.find((e) => e.prefab === OUTER)!.nestedStructure))
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
    expect(Object.keys(saved.entities.find((e) => e.prefab === OUTER)!.nestedStructure as object)).toContain('4.3');
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
    ((saved.entities.find((e) => e.prefab === OUTER)!.added as Array<Record<string, unknown>>)
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
