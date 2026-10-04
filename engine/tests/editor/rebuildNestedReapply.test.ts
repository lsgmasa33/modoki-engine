/** #1386 / #1401 / #1383 — a rebuild carries an instance's NESTED frames across (Refresh, Revert, Apply all rebuild):
 *  a row's `added` node is not spawned twice (#1386), a refreshed row value is not frozen at the old one (#1401), the
 *  scene's own edits still survive, and a nested instance whose chain does not reach the outer root is not written onto
 *  the row it merely shares a stamp with (#1383).
 *
 *  These were written against the old per-frame rebuild's nested capture and re-apply, and each case named the mutation
 *  in that machinery that turned it red. #1880 F7d deleted it: a rebuild is now the LOAD of the instance's scene entry,
 *  so each case is the same shape driven through `refreshInstances` — a rebuild that must equal the reload of what the
 *  save writes. Measured on the entry route: `rebuildTargetsByEntry` expanding the outer entry from the document its
 *  capture was taken against instead of the refresh's `to` reddens all nine refresh cases. The eight same-template cases
 *  are the shape a reload of the save must give back, and are held by the loader a reload runs; the old-route mutations
 *  each named are gone with the code they named. (Capturing without `againstRecords`, or against the cache rather than
 *  the outer's record, stays green here: every row is keyed by `nodeGuid`, and neither nested document changes.)
 *
 *  Harness copied from `prefabRowNestedChannels.test.ts`. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));
import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData, writeTraitField, findEntity,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { writeTraitFieldWithUndo, clearHistory, setActionCallback, pushAction } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { instantiatePrefab } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { refreshInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { templateKeyOf, TemplateAddedKey } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const INNER = 'aaaaaaaa-0000-4000-8000-0000000001c1';
const MID = 'aaaaaaaa-0000-4000-8000-0000000001c2';
const OUTER = 'aaaaaaaa-0000-4000-8000-0000000001c3';
const HOLDER = 'bbbbbbbb-0000-4000-8000-0000000001c1';
const ROOT = 'bbbbbbbb-0000-4000-8000-0000000001c2';

/** v6 rows, each with its `nodeGuid` — the form the prefab writer has written since v5, and every source prefab with a
 *  nested row in the repo's corpus is in (measured at #1880 F7d). On pre-v5 documents the SAVE states a nested row's own
 *  `added`/`removed`/`removedTraits` as the scene's, so a reload — and a rebuild, which is one — keeps the old template's
 *  there: four of the refresh cases below go red on `version: 3` rows. */
const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, name, nodeGuid: `eeeeeeee-0000-4000-8000-${String(localId).padStart(12, '0')}`, ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const innerDoc = { id: INNER, version: 6, name: 'Inner', rootLocalId: 1, entities: [row(1, 'InnerRoot', 0), row(2, 'Leaf', 1)] };
/** MID's own row 3 expands INNER — so a MID row in OUTER reaches Leaf at path `<row>.3`. */
const midDoc = { id: MID, version: 6, name: 'Mid', rootLocalId: 1, entities: [
  row(1, 'MidRoot', 0), row(2, 'Slot', 1), row(3, 'MidNested', 2, { prefab: INNER }),
] };
/** OUTER, optionally with a MID row (localId 5) under Button carrying `midRow` fields. */
const outerDoc = (midRow?: Record<string, unknown>) => ({
  id: OUTER, version: 6, name: 'Outer', rootLocalId: 1, entities: [
    row(1, 'OuterRoot', 0), row(2, 'Panel', 1), row(3, 'Button', 2), row(4, 'Nested', 2, { prefab: INNER }),
    ...(midRow ? [row(5, 'MidRoot', 3, { prefab: MID, ...midRow })] : []),
  ],
});
const install = (doc: { id?: string }) => { prefabs.set(doc.id!, doc); setPrefabCache(doc.id!, doc as never); };

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

/** Name chain from the scene root, for every entity (ambiguity is fine — callers test membership). */
function namePaths(): string[] {
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  return all.map((e) => {
    const names: string[] = [];
    let cur: typeof e | undefined = e;
    const seen = new Set<number>();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); names.unshift(cur.name); cur = byId.get(cur.parentId); }
    return names.join('/');
  });
}
const byName = (name: string): number => {
  const hits = getAllEntities().filter((e) => e.name === name);
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} entities named ${name}`);
  return hits[0]!.id;
};

/** Holder → an OUTER instance; `entry` extends the instance entry. */
const sceneWith = (entry: Record<string, unknown> = {}): SceneData => ({
  id: 'row-nested', version: 14, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
    { id: 2, prefab: OUTER, guid: ROOT, traits: { EntityAttributes: { name: 'OuterRoot', parentId: HOLDER }, Transform: { x: 0, y: 0, z: 0 } }, ...entry },
  ],
} as unknown as SceneData);


beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  install(innerDoc);
  install(midDoc);
  install(outerDoc());
});
afterAll(() => { for (const id of [INNER, MID, OUTER]) setPrefabCache(id, null); getCurrentWorld()?.destroy(); });

const count = (name: string) => getAllEntities().filter((e) => e.name === name).length;
/** Rebuild the OUTER instance at `root` from `from` onto `to` — the refresh a prefab write gives it, which loads its scene
 *  entry (#1880 F6-U). `from === to` is a rebuild onto the unchanged template. */
const refresh = (root: number, from: unknown, to: unknown) => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try { expect(refreshInstances(OUTER, [root], from as never, to as never)).toBe(1); } finally { spy.mockRestore(); }
};
const extra = (parentLocalId: number, key: string, name = 'Extra', x = 0) =>
  ({ parentLocalId, guid: '', key, name, traits: { EntityAttributes: { name }, Transform: { x, y: 0, z: 0 } }, children: [] });
const xOf = (id: number) => readTraitData(id, getTraitByName('Transform')!)?.x as number;
const traitsOf = (id: number) => getAllEntities().find((e) => e.id === id)!.traits;

describe('a row-authored added node is not spawned twice by a rebuild (#1386)', () => {
  it('the row\'s own `added`', async () => {
    const doc = outerDoc({ added: [extra(2, 'k-extra')] });
    install(doc);
    await load(sceneWith());
    expect(count('Extra')).toBe(1);
    refresh(byName('OuterRoot'), doc, doc);
    expect(count('Extra')).toBe(1);
  });

  it('a path in the row\'s `nestedStructure`', async () => {
    const doc = outerDoc({ nestedStructure: { '3': { added: [extra(1, 'k-deep', 'Deep')], removed: [], removedTraits: {} } } });
    install(doc);
    await load(sceneWith());
    expect(count('Deep')).toBe(1);
    refresh(byName('OuterRoot'), doc, doc);
    expect(count('Deep')).toBe(1);
  });

  it('a node that lost its key marker is still recognised', async () => {
    const doc = outerDoc({ added: [extra(2, 'k-extra')] });
    install(doc);
    await load(sceneWith());
    findEntity(byName('Extra'))!.remove(TemplateAddedKey);
    expect(templateKeyOf(findEntity(byName('Extra')))).toBe(''); // precondition: the marker is gone
    refresh(byName('OuterRoot'), doc, doc);
    expect(count('Extra')).toBe(1);
  });

  it('a row-authored node the scene EDITED survives once, edit and key intact', async () => {
    const doc = outerDoc({ added: [extra(2, 'k-extra')] });
    install(doc);
    await load(sceneWith());
    // An editor write, so it is recorded (#1914 R3a): a raw write is no edit, and the refresh shows the template's x.
    writeTraitFieldWithUndo(byName('Extra'), getTraitByName('Transform')!, 'x', 7);
    refresh(byName('OuterRoot'), doc, doc);
    expect(count('Extra')).toBe(1);
    expect(xOf(byName('Extra'))).toBe(7);
    expect(templateKeyOf(findEntity(byName('Extra')))).toBe('k-extra');
  });

  it('a SCENE-added node inside the nested instance still survives, once', async () => {
    const doc = outerDoc({});
    install(doc);
    await load(sceneWith({ nestedStructure: { '5': { added: [{ parentLocalId: 2, guid: 'cccccccc-0000-4000-8000-000000000002', name: 'Mine', traits: { EntityAttributes: { name: 'Mine' } }, children: [] }], removed: [], removedTraits: {} } } }));
    expect(count('Mine')).toBe(1);
    refresh(byName('OuterRoot'), doc, doc);
    expect(count('Mine')).toBe(1);
  });
});

describe('a refresh reaches a row\'s nested values and structure (#1401)', () => {
  it('a changed row override replaces the old one', async () => {
    const oldDoc = outerDoc({ overrides: { 2: { EntityAttributes: { name: 'SlotA' } } } });
    install(oldDoc);
    await load(sceneWith());
    expect(count('SlotA')).toBe(1);
    const newDoc = outerDoc({ overrides: { 2: { EntityAttributes: { name: 'SlotB' } } } });
    install(newDoc);
    refresh(byName('OuterRoot'), oldDoc, newDoc);
    expect(count('SlotA')).toBe(0);
    expect(count('SlotB')).toBe(1);
  });

  it('a scene that changed the row-set value keeps its change', async () => {
    const doc = outerDoc({ overrides: { 2: { EntityAttributes: { name: 'SlotA' } } } });
    install(doc);
    await load(sceneWith());
    writeTraitFieldWithUndo(byName('SlotA'), getTraitByName('EntityAttributes')!, 'name', 'Mine');
    refresh(byName('OuterRoot'), doc, doc);
    expect(count('Mine')).toBe(1);
  });

  it('an unchanged row-authored node takes the refreshed template', async () => {
    const oldDoc = outerDoc({ added: [extra(2, 'k-extra', 'Extra', 0)] });
    install(oldDoc);
    await load(sceneWith());
    const newDoc = outerDoc({ added: [extra(2, 'k-extra', 'Extra', 5)] });
    install(newDoc);
    refresh(byName('OuterRoot'), oldDoc, newDoc);
    expect(count('Extra')).toBe(1);
    expect(xOf(byName('Extra'))).toBe(5);
  });

  it('a component the old row removed comes back when the new row stops removing it', async () => {
    const oldDoc = outerDoc({ removedTraits: { 2: ['Transform'] } });
    install(oldDoc);
    await load(sceneWith());
    expect(traitsOf(byName('Slot'))).not.toContain('Transform');
    const newDoc = outerDoc({});
    install(newDoc);
    refresh(byName('OuterRoot'), oldDoc, newDoc);
    expect(traitsOf(byName('Slot'))).toContain('Transform');
  });
});

describe('the subtraction reads the chain the way the loader applies it (#1386 review)', () => {
  const guidOf = (id: number) => (readTraitData(id, getTraitByName('EntityAttributes')!)?.guid as string) || '';
  const bindingTarget = (id: number) =>
    ((findEntity(id)!.get(getTraitByName('UIAction')!.trait) as { bindings: { target: string }[] }).bindings[0]?.target);
  const innerRootUnderSlot = () => getAllEntities().find((e) => e.name === 'InnerRoot' && e.parentId === byName('Slot'))!.id;
  const midRoot = () => getAllEntities().find((e) => e.name === 'MidRoot')!.id;

  it('a row override holding a member token takes the refreshed target', async () => {
    const oldDoc = outerDoc({ overrides: { 1: { UIAction: { bindings: [{ target: '@member:2' }] } } } });
    install(oldDoc);
    await load(sceneWith());
    expect(bindingTarget(midRoot())).toBe(guidOf(byName('Slot'))); // precondition: resolved in MID's frame
    const newDoc = outerDoc({ overrides: { 1: { UIAction: { bindings: [{ target: '@member:2.3' }] } } } });
    install(newDoc);
    refresh(byName('OuterRoot'), oldDoc, newDoc);
    expect(bindingTarget(midRoot())).toBe(guidOf(innerRootUnderSlot()));
  });

  it('a row override holding a `^` token (a member of the NESTING prefab) takes the refreshed target', async () => {
    const oldDoc = outerDoc({ overrides: { 1: { UIAction: { bindings: [{ target: '@member:^.2' }] } } } });
    install(oldDoc);
    await load(sceneWith());
    expect(bindingTarget(midRoot())).toBe(guidOf(byName('Panel')));
    const newDoc = outerDoc({ overrides: { 1: { UIAction: { bindings: [{ target: '@member:^.2.3' }] } } } });
    install(newDoc);
    refresh(byName('OuterRoot'), oldDoc, newDoc);
    expect(bindingTarget(midRoot())).toBe(guidOf(byName('Button')));
  });

  // A value forwarded from TWO levels up still lands in its target instance's frame.
  it('a forwarded nestedOverrides token takes the refreshed target', async () => {
    const at = (target: string) => outerDoc({ nestedOverrides: { '3': { 1: { UIAction: { bindings: [{ target }] } } } } });
    const oldDoc = at('@member:2');
    install(oldDoc);
    await load(sceneWith());
    const leaf = () => getAllEntities().find((e) => e.name === 'Leaf' && e.parentId === innerRootUnderSlot())!.id;
    expect(bindingTarget(innerRootUnderSlot())).toBe(guidOf(leaf()));
    const newDoc = at('@member:');
    install(newDoc);
    refresh(byName('OuterRoot'), oldDoc, newDoc);
    expect(bindingTarget(innerRootUnderSlot())).toBe(guidOf(innerRootUnderSlot()));
  });

  it('an unchanged row-added node holding a member token takes the refreshed template', async () => {
    const node = (x: number) => ({ ...extra(2, 'k-tok', 'Tok', x), traits: { EntityAttributes: { name: 'Tok' }, Transform: { x, y: 0, z: 0 }, UIAction: { bindings: [{ target: '@member:2' }] } } });
    const oldDoc = outerDoc({ added: [node(0)] });
    install(oldDoc);
    await load(sceneWith());
    const newDoc = outerDoc({ added: [node(5)] });
    install(newDoc);
    refresh(byName('OuterRoot'), oldDoc, newDoc);
    expect(count('Tok')).toBe(1);
    expect(xOf(byName('Tok'))).toBe(5);
  });

  it('a component the old row ADDED goes when the new row stops adding it', async () => {
    const oldDoc = outerDoc({ overrides: { 1: { Text2D: { text: 'hi' } } } });
    install(oldDoc);
    await load(sceneWith());
    expect(traitsOf(midRoot())).toContain('Text2D');
    const newDoc = outerDoc({});
    install(newDoc);
    refresh(byName('OuterRoot'), oldDoc, newDoc);
    expect(traitsOf(midRoot())).not.toContain('Text2D');
  });

  it('an edited LEGACY row node (a durable guid, no key) survives once', async () => {
    const legacy = { ...extra(2, '', 'Old'), key: undefined, guid: 'dddddddd-0000-4000-8000-000000000001' };
    const doc = outerDoc({ added: [legacy] });
    install(doc);
    await load(sceneWith());
    expect(count('Old')).toBe(1);
    writeTraitField(byName('Old'), getTraitByName('Transform')!, 'x', 7);
    refresh(byName('OuterRoot'), doc, doc);
    expect(count('Old')).toBe(1);
    expect(xOf(byName('Old'))).toBe(7);
  });

  it('a member the old row removed comes back when the new row stops removing it', async () => {
    const oldDoc = outerDoc({ removed: [2] });
    install(oldDoc);
    await load(sceneWith());
    expect(count('Slot')).toBe(0);
    const newDoc = outerDoc({});
    install(newDoc);
    refresh(byName('OuterRoot'), oldDoc, newDoc);
    expect(count('Slot')).toBe(1);
  });
});

describe('a partial chain addresses nothing (#1383)', () => {
  it('a stamped instance under a plain added node does not write onto the real row', async () => {
    await load(sceneWith({ added: [{ parentLocalId: 2, guid: 'cccccccc-0000-4000-8000-000000000001', name: 'Plain', traits: { EntityAttributes: { name: 'Plain' }, Transform: { x: 0, y: 0, z: 0 } }, children: [] }] }));
    const piMeta = getTraitByName('PrefabInstance')!;
    // Latent from the editor (reparent unpacks, duplicate clears the stamp), so the stamp is forced,
    // as the #1354 F3 test forces one.
    const s = instantiatePrefab(innerDoc as never, byName('Plain'));
    findEntity(s)!.set(piMeta.trait, { ...(findEntity(s)!.get(piMeta.trait) as object), parentLocalId: 4, source: INNER });
    const sLeaf = getAllEntities().find((e) => e.name === 'Leaf' && e.parentId === s)!.id;
    writeTraitFieldWithUndo(sLeaf, getTraitByName('EntityAttributes')!, 'name', 'Renamed');
    const root = byName('OuterRoot');
    refresh(root, outerDoc(), outerDoc());
    expect(namePaths()).toContain('Holder/OuterRoot/Panel/InnerRoot/Leaf'); // row 4 untouched
    // The forced stamp makes S a member, never the plain node's content: the record links no S, and the rebuild projects
    // the record as a save + reload does (#2001 S8b; the old capture carried S whole). The rename lands nowhere.
    expect(namePaths().some((p) => p.includes('Renamed'))).toBe(false);
  });
});

describe('a refresh expands its prefab from the document it was handed (#1880 F7d)', () => {
  // A refresh of INNER's frame nested in OUTER is the load of OUTER's entry, which expands a nested frame through the
  // cache. It must read INNER as the document the caller handed, not as whatever the cache holds (production callers
  // write the cache first, so the two agree there; F7b compared them by content and fell back to the old per-frame
  // rebuild where they did not). Mutation: the refresh's reader ignores `refresh.to` — Leaf2 never arrives.
  it('a nested frame of the refreshed prefab takes the handed document, the cache holding the old one', async () => {
    await load(sceneWith());
    const next = { ...innerDoc, entities: [...innerDoc.entities, row(3, 'Leaf2', 1)] };
    const nested = getAllEntities().find((e) => e.name === 'InnerRoot' && e.parentId === byName('Panel'))!.id;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { expect(refreshInstances(INNER, [nested], innerDoc as never, next as never)).toBe(1); } finally { spy.mockRestore(); }
    expect(count('Leaf2')).toBe(1);
    expect(count('OuterRoot')).toBe(1);
  });
});
