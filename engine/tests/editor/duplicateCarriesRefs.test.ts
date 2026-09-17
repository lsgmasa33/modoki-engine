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
import { duplicateEntity, writeTraitFieldWithUndo, setActionCallback, pushAction, clearHistory, serializeScene } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefab';
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
 *  node carries its OWN guid: a guid-less one has its derived guid stored by the first save, which
 *  re-anchors its members with or without a duplicate (#1349). */
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
    // Save once: #1349 stores the added root's derived guid. Reload that file.
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
