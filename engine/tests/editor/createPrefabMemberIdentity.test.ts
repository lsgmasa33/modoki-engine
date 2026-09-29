/** #1461 — Create Prefab tags a live tree as an instance (`tagEntityTreeAsInstance`) but writes only
 *  `PrefabInstance`: every member keeps the random guid it had as a plain entity, while the prefab file
 *  it just wrote says `guid: ''` on every row. So the reload DERIVES each member's guid from the anchor
 *  and its path, and anything written in that window naming a member by guid names one that will never
 *  exist again — `moved`'s value is the reported case (a member moved inside the new instance is lost on
 *  reload), a ref into a member and an owned nested instance's members are the same defect unreported.
 *
 *  The load-time derive pass cannot repair this after the fact: it fills EMPTY guids only
 *  (`loadSceneFile.ts`, `if ((!row.hasPI && !row.keyed) || row.origGuid) continue;`).
 *
 *  Every assertion here is against what a REAL reload produces, never against a second call to
 *  `deriveMemberGuid` — an assertion that recomputes the fix's own arithmetic cannot fail when the fix
 *  is deleted (CLAUDE.md § falsifiable tests). */

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
import { setActionCallback, pushAction, clearHistory, serializeScene, reparentEntity, createEntityWithUndo, writeTraitFieldWithUndo } from '@modoki/engine/editor';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { serializePrefab } from '../../packages/modoki/src/editor/scene/prefabSerialize';
import {
  tagEntityTreeAsInstance, untagEntityTreeAsInstance, unstampMemberGuids,
} from '../../packages/modoki/src/editor/scene/prefabLink';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { keptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';

registerAllTraits();
setActionCallback(pushAction);

const HOLDER = 'dddddddd-0000-4000-8000-000000000001';
const ROOT = 'dddddddd-0000-4000-8000-000000000002';
const PANEL = 'dddddddd-0000-4000-8000-000000000003';
const BUTTON = 'dddddddd-0000-4000-8000-000000000004';
const LABEL = 'dddddddd-0000-4000-8000-000000000005';
const INNER = 'dddddddd-0000-4000-8000-0000000000c1';
const NESTED = 'dddddddd-0000-4000-8000-000000000006';
const PREFAB = 'dddddddd-0000-4000-8000-00000000000f';
const PREFAB2 = 'dddddddd-0000-4000-8000-00000000001f';
const LEAFP = 'dddddddd-0000-4000-8000-0000000000c2';
const REFNODE = 'dddddddd-0000-4000-8000-000000000007';
const PLAIN = 'dddddddd-0000-4000-8000-000000000008';

const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** The prefab the fixture's nested instance expands from — so the created tree holds an OWNED nested row. */
const innerDoc = { id: INNER, rootLocalId: 1, entities: [row(1, 'Nested', 0), row(2, 'Leaf', 1)] };
/** The prefab of a reference node dropped inside the nested instance: LRoot → LKid. v5 mints `nodeGuid`s, so the save
 *  writes LKid a member row; a pre-v5 document mints none, so LKid has no row and the reload derives it. */
const leafDoc = (v5: boolean) => ({ id: LEAFP, ...(v5 ? { version: 5 } : {}), rootLocalId: 1, entities: [
  row(1, 'LRoot', 0, v5 ? { nodeGuid: 'eeeeeeee-0000-4000-8000-0000000017a1' } : {}),
  row(2, 'LKid', 1, v5 ? { nodeGuid: 'eeeeeeee-0000-4000-8000-0000000017a2' } : {}),
] });

async function load(scene: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(scene)), {
    loadModels: false,
    fetchPrefab: async (ref) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
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
      return rootId;
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
const pathOf = (guid: string): string | undefined => treePaths().get(guid);
const targetsOf = (id: number): string[] => {
  const e = [...getCurrentWorld().entities].find((x) => x.id() === id)!;
  return ((e.get(getTraitByName('UIAction')!.trait) as { bindings: { target: string }[] }).bindings).map((b) => b.target);
};
const withUi = (traits: Record<string, unknown>, refs: string[]) =>
  ({ ...traits, UIAction: { bindings: refs.map((target) => ({ event: 'click', action: 'noop', target })) } });

/** The tree BEFORE Create Prefab: plain entities with their own durable guids, plus an already-linked
 *  instance of INNER under Panel (which Create Prefab turns into an OWNED nested row). Holder's refs aim
 *  at whatever is passed — used to point them at members that are about to be swallowed by the prefab. */
const baseScene = (holderRefs: string[] = []): SceneData => ({
  id: 'create-window', version: 8, name: 'C', resources: [],
  entities: [
    { id: 1, traits: withUi({ EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } }, holderRefs) },
    { id: 2, traits: { EntityAttributes: { name: 'Root', parentId: HOLDER, guid: ROOT }, Transform: { x: 0, y: 0, z: 0 } } },
    { id: 3, traits: { EntityAttributes: { name: 'Panel', parentId: ROOT, guid: PANEL }, Transform: { x: 0, y: 0, z: 0 } } },
    { id: 4, traits: { EntityAttributes: { name: 'Label', parentId: ROOT, guid: LABEL }, Transform: { x: 0, y: 0, z: 0 } } },
    { id: 5, traits: { EntityAttributes: { name: 'Button', parentId: PANEL, guid: BUTTON }, Transform: { x: 0, y: 0, z: 0 } } },
    { id: 6, prefab: INNER, guid: NESTED, traits: { EntityAttributes: { name: 'Nested', parentId: PANEL }, Transform: { x: 0, y: 0, z: 0 } } },
  ],
} as unknown as SceneData);

/** Create Prefab, exactly as both callers do it: serialize the live tree, then tag it
 *  (`assetOps.createPrefabFromEntity`, `agentEditorOps` `prefab {action:'create'}`). */
function createPrefabFrom(rootPath: string, target: string = PREFAB): PrefabFile {
  const rootId = idAt(rootPath);
  const file = serializePrefab(rootId, target)!;
  prefabs.set(target, file);
  setPrefabCache(target, file as never);
  tagEntityTreeAsInstance(rootId, target, file);
  return file;
}

type Entry = { prefab?: string; guid?: string; members?: Record<string, { name?: string; parent?: string }> };
const saved = async () => await serializeScene() as unknown as { entities: Entry[] };

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  prefabs.set(INNER, innerDoc);
  setPrefabCache(INNER, innerDoc as never);
});
afterAll(() => { setPrefabCache(INNER, null); setPrefabCache(LEAFP, null); setPrefabCache(PREFAB, null); setPrefabCache(PREFAB2, null); getCurrentWorld()?.destroy(); });

describe('a member moved inside an instance made by Create Prefab in the same session (#1461)', () => {

  /** The invariant behind every symptom: after Create Prefab the live members already hold the identity
   *  the reload will give them. Asserted as "the round trip does not move them", so it covers consumers
   *  nobody has thought of yet — and cannot pass by recomputing the fix's own derivation. */
  it('every member already carries the guid the reload derives for it', async () => {
    await load(baseScene());
    createPrefabFrom('Holder/Root');
    const members = ['Holder/Root/Panel', 'Holder/Root/Label', 'Holder/Root/Panel/Button'];
    const before = members.map((p) => [p, guidAt(p)] as const);

    await load(await saved() as unknown as SceneData);

    expect(before.map(([, g]) => pathOf(g))).toEqual(members);
  });

  /** Second symptom, unreported: a member of an OWNED nested instance inside the created tree. Its live
   *  guid was derived from the NESTED root when that instance was made; after the create the reload
   *  derives it through the OUTER anchor and the whole path instead. */
  it('a member of an owned nested instance keeps the identity the reload gives it', async () => {
    await load(baseScene());
    createPrefabFrom('Holder/Root');
    const leaf = guidAt('Holder/Root/Panel/Nested/Leaf');

    await load(await saved() as unknown as SceneData);

    expect(pathOf(leaf)).toBe('Holder/Root/Panel/Nested/Leaf');
  });

  /** The NEGATIVE control for the scope question the issue body left open: an `+added.<guid>` node is
   *  NOT affected. Its identity is its own durable live guid (`addedNodeIdentity`) and the loader spawns
   *  it verbatim, so it never re-derives and the stamp must leave it alone. Without this, "added nodes
   *  are fine" is an assertion about code I read rather than a property under test — and a stamp that
   *  wrongly renamed one would go unnoticed. */
  it('an added node under a member keeps its own guid — the stamp does not touch it', async () => {
    await load(baseScene());
    createPrefabFrom('Holder/Root');
    const added = createEntityWithUndo('add', idAt('Holder/Root/Panel'), [
      { name: 'EntityAttributes', data: { name: 'Added', parentId: idAt('Holder/Root/Panel') } },
      { name: 'Transform', data: { x: 0, y: 0, z: 0 } },
    ], () => {})!;
    const addedGuid = getAllEntities().find((e) => e.id === added)!.guid!;
    expect(addedGuid).toBeTruthy();

    await load(await saved() as unknown as SceneData);

    expect(pathOf(addedGuid)).toBe('Holder/Root/Panel/Added');
  });

  /** Third symptom, unreported: a live ref INTO a member, from outside the new prefab. */
  it('a ref into a member still resolves after the reload', async () => {
    await load(baseScene());
    await load(baseScene([BUTTON])); // Holder's UIAction aims at Button, before it is a member
    createPrefabFrom('Holder/Root');

    await load(await saved() as unknown as SceneData);

    expect(targetsOf(idAt('Holder')).map(pathOf)).toEqual(['Holder/Root/Panel/Button']);
  });
});

/** #1758: Create Prefab over a tree whose held instance has a REFERENCE node the scene added inside it. The prefab write
 *  turns that node into template content (the Nested row's `added`, keyed), and the reload DERIVES a template node's guid
 *  through its key; it pins the member rows the scene writes for it only once the node holds that derived guid. The stamp
 *  stopped at every stored root, so the node kept a guid no reload reproduces, its members' rows were never found, and
 *  every ref to the node or a member dangled after save + reopen, in this scene too. */
describe.each([
  ['a v5 child, whose member a row pins', true],
  ['a pre-v5 child, whose member the reload derives', false],
])('Create Prefab over a reference node added inside a held instance: %s (#1758)', (_label, v5) => {
  const REF_PATH = 'Holder/Root/Panel/Nested/Leaf/LRoot';
  const KID_PATH = `${REF_PATH}/LKid`;
  const PLAIN_PATH = 'Holder/Root/Panel/Nested/Leaf/Plain';
  const setup = async () => {
    prefabs.set(LEAFP, leafDoc(v5));
    setPrefabCache(LEAFP, leafDoc(v5) as never);
    await load({
      ...baseScene(),
      entities: [
        ...(baseScene().entities as unknown[]),
        { id: 7, prefab: LEAFP, guid: REFNODE, traits: { EntityAttributes: { name: 'Ref', parentId: HOLDER }, Transform: { x: 0, y: 0, z: 0 } } },
        { id: 8, traits: { EntityAttributes: { name: 'Plain', parentId: HOLDER, guid: PLAIN }, Transform: { x: 0, y: 0, z: 0 } } },
      ],
    } as unknown as SceneData);
    const leaf = idAt('Holder/Root/Panel/Nested/Leaf');
    expect(reparentEntity(getAllEntities().find((e) => e.guid === REFNODE)!.id, leaf)).toBe(true);
    expect(reparentEntity(getAllEntities().find((e) => e.guid === PLAIN)!.id, leaf)).toBe(true);
    // Holder aims at the reference node, a member of it, and the plain node: all three are swallowed by the prefab.
    writeTraitFieldWithUndo(idAt('Holder'), getTraitByName('UIAction')!, 'bindings',
      [REFNODE, guidAt(KID_PATH), PLAIN].map((target) => ({ event: 'click', action: 'noop', target })));
  };

  /** Mutations: let the walk stop at a keyed stored root (both shapes go red); stop it descending into one (the pre-v5
   *  shape goes red); drop the per-frame row exclusion (the v5 shape goes red, on the unchanged-guid line). */
  it('the reference node, its member and the plain node already hold the guids the reload gives them', async () => {
    await setup();
    const kidBefore = guidAt(KID_PATH);
    createPrefabFrom('Holder/Root');
    const paths = [REF_PATH, KID_PATH, PLAIN_PATH];
    const before = paths.map(guidAt);
    // Where a row states the guid, identity does not move: a ref to LKid in ANOTHER file keeps resolving.
    if (v5) expect(before[1]).toBe(kidBefore);
    else expect(before[1], 'fixture: with no row, LKid is re-derived under the renamed node').not.toBe(kidBefore);

    await load(await saved() as unknown as SceneData);

    expect(before.map(pathOf)).toEqual(paths);
  });

  it('a ref to each of them still resolves after save + reopen', async () => {
    await setup();
    createPrefabFrom('Holder/Root');

    await load(await saved() as unknown as SceneData);

    expect(targetsOf(idAt('Holder')).map(pathOf)).toEqual([REF_PATH, KID_PATH, PLAIN_PATH]);
  });
});

/** #1778: a reference node the scene added inside a held instance carries a kept ORPHAN member row (R2: a row naming a
 *  node LEAFP no longer declares, kept in case that template edit is undone). Create Prefab's stamp renames the node to
 *  its derived guid (#1758), and the kept-orphan store is keyed by the root's guid — left under the old one, the next
 *  save looked under the new one and dropped the row for good. The store now follows the rename (`applyGuidRemap`). */
describe('Create Prefab keeps a swallowed reference node\'s kept orphan row (#1778)', () => {
  const REF_PATH = 'Holder/Root/Panel/Nested/Leaf/LRoot';
  const ORPHAN = 'ffffffff-0000-4000-8000-0000000017f9';
  const setup = async () => {
    prefabs.set(LEAFP, leafDoc(true));
    setPrefabCache(LEAFP, leafDoc(true) as never);
    await load({
      ...baseScene(),
      entities: [
        ...(baseScene().entities as unknown[]),
        { id: 7, prefab: LEAFP, guid: REFNODE, members: { '/eeeeeeee-0000-4000-8000-0000000017f0': { guid: ORPHAN, name: 'Gone' } },
          traits: { EntityAttributes: { name: 'Ref', parentId: HOLDER }, Transform: { x: 0, y: 0, z: 0 } } },
      ],
    } as unknown as SceneData);
    expect(reparentEntity(getAllEntities().find((e) => e.guid === REFNODE)!.id, idAt('Holder/Root/Panel/Nested/Leaf'))).toBe(true);
    // Control: before Create Prefab, a plain save writes the orphan row.
    expect(JSON.stringify(await saved()), 'fixture: the orphan is written before Create Prefab').toContain(ORPHAN);
  };
  /** Create Prefab as both callers do it, keeping the rename for the undo (`assetOps`: unstamp, then untag). */
  const create = () => {
    const rootId = idAt('Holder/Root');
    const file = serializePrefab(rootId, PREFAB)!;
    prefabs.set(PREFAB, file);
    setPrefabCache(PREFAB, file as never);
    return { rootId, file, remap: tagEntityTreeAsInstance(rootId, PREFAB, file) };
  };

  /** Mutation: drop the re-key in `applyGuidRemap` — both assertions go red (the row stays under REFNODE). */
  it('the next save writes the orphan row, and it survives save + reopen + save', async () => {
    await setup();
    create();
    expect(guidAt(REF_PATH), 'fixture: the stamp renamed the node').not.toBe(REFNODE);

    expect(JSON.stringify(await saved())).toContain(ORPHAN);
    await load(await saved() as unknown as SceneData);
    expect(JSON.stringify(await saved())).toContain(ORPHAN);
  });

  /** Mutations: drop the re-key — the rows never left REFNODE, so the undo lines pass and the redo's save goes red;
   *  COPY the rows to the new guid instead of moving them — the undo's "nothing left under the new guid" line goes red. */
  it('undo puts the rows back under the node\'s old guid, and redo moves them to the new one again', async () => {
    await setup();
    const { rootId, file, remap } = create();
    const renamed = guidAt(REF_PATH);

    unstampMemberGuids(remap);
    untagEntityTreeAsInstance(rootId, PREFAB);
    expect(guidAt(REF_PATH)).toBe(REFNODE);
    expect(keptMemberOrphans(REFNODE)?.['/eeeeeeee-0000-4000-8000-0000000017f0']?.guid).toBe(ORPHAN);
    expect(keptMemberOrphans(renamed)).toBeUndefined();

    tagEntityTreeAsInstance(rootId, PREFAB, file);
    expect(guidAt(REF_PATH)).toBe(renamed);
    expect(JSON.stringify(await saved())).toContain(ORPHAN);
  });
});
