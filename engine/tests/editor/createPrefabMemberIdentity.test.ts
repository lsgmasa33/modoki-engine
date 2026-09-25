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
import { setActionCallback, pushAction, clearHistory, serializeScene, reparentEntity, createEntityWithUndo } from '@modoki/engine/editor';
import { setPrefabCache, serializePrefab, tagEntityTreeAsInstance, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { memberPathIndex } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';

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

const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** The prefab the fixture's nested instance expands from — so the created tree holds an OWNED nested row. */
const innerDoc = { id: INNER, rootLocalId: 1, entities: [row(1, 'Nested', 0), row(2, 'Leaf', 1)] };

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
  id: 'create-window', version: 1, name: 'C', resources: [],
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
const instanceEntry = (doc: { entities: Entry[] }) => doc.entities.find((e) => e.prefab === PREFAB)!;

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  prefabs.set(INNER, innerDoc);
  setPrefabCache(INNER, innerDoc as never);
});
afterAll(() => { setPrefabCache(INNER, null); setPrefabCache(PREFAB, null); setPrefabCache(PREFAB2, null); getCurrentWorld()?.destroy(); });

describe('a member moved inside an instance made by Create Prefab in the same session (#1461)', () => {
  /** The issue body's repro, step for step. Mutation: drop the stamp from tagEntityTreeAsInstance. */
  it('the move survives the reload', async () => {
    await load(baseScene());
    const file = createPrefabFrom('Holder/Root');
    reparentEntity(idAt('Holder/Root/Panel/Button'), idAt('Holder/Root/Label'));

    const doc = await saved();
    await load(doc as unknown as SceneData);

    expect([...treePaths().values()]).toContain('Holder/Root/Label/Button');
    // …and the value that was written names the parent the reload actually has. Stored on Button's
    // own member ROW since #1468 Phase 3, keyed by the template row's minted identity — the
    // localId-keyed `moved` map this used to read is gone from the format.
    const key = `/${file.entities.find((e) => e.name === 'Button')!.nodeGuid}`;
    expect(instanceEntry(doc).members?.[key]?.parent).toBe(guidAt('Holder/Root/Label'));
  });

  /** Close-out review F1. Re-tagging a member that had been MOVED under the PREVIOUS prefab must derive it
   *  from its row in the NEW one. It was a stale `homeParent` then (koota's setter is a partial merge, and
   *  `applyTag` did not name the field); since #1468 Phase 6 the row is read from the document, so what can
   *  go stale is WHICH document — the frame root's record still names the previous prefab's. A stale answer
   *  derives the member from a path the reload does not walk, and the stamp repoints refs to the wrong value.
   *  Mutations: drop the tag's `noteFrameDoc`; drop the source check on a root's own record (`frameDocReader`). */
  it('a member that was MOVED is re-stamped from its row, not from a stale home', async () => {
    await load(baseScene());
    createPrefabFrom('Holder/Root');
    reparentEntity(idAt('Holder/Root/Panel/Button'), idAt('Holder/Root/Label'));
    await load(await saved() as unknown as SceneData);
    expect([...treePaths().values()]).toContain('Holder/Root/Label/Button'); // #1461 proper, still good

    // Create Prefab AGAIN over the same tree: every member is retagged, the moved one included.
    createPrefabFrom('Holder/Root', PREFAB2);
    const button = guidAt('Holder/Root/Label/Button');

    await load(await saved() as unknown as SceneData);

    expect(pathOf(button)).toBe('Holder/Root/Label/Button');
  });

  /** #1468 Phase 6: a member's row parent is READ from the document its frame was expanded from, and a tagged
   *  tree was expanded from nothing — so the tag records the document it just wrote at the root, and the editor's
   *  prefab cache stands behind it. A member moved before any reload must still be named by its ROW path, which
   *  is where every template token and the reload's derive reach it. Right after the tag nothing has moved, so
   *  a walk with no document at all agrees — which is why only a move in that window can tell.
   *  Mutation: drop BOTH the tag's `noteFrameDoc` and `setFrameDocFallback` (either alone is covered by the other). */
  it('a member moved right after Create Prefab is still named by its row path', async () => {
    await load(baseScene());
    const file = createPrefabFrom('Holder/Root');
    const lid = (name: string) => file.entities.find((e) => e.name === name)!.localId;
    const button = idAt('Holder/Root/Panel/Button');
    reparentEntity(button, idAt('Holder/Root/Label'));
    const index = memberPathIndex(getCurrentWorld(), idAt('Holder/Root'));
    expect(index.get(`${lid('Panel')}.${lid('Button')}`)?.id()).toBe(button);
    expect(index.has(`${lid('Label')}.${lid('Button')}`)).toBe(false);
  });

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
