/** #1386 / #1401 / #1383 — `rebuildInstance`'s nested re-apply (Refresh, Revert, Apply all rebuild).
 *
 *  Before the rebuild tears an instance down it captures each owned nested instance, and re-applies
 *  that capture over the fresh expansion. The capture is now the live instance MINUS what the prefab
 *  chain of the document the tree came from applies — so a row's `added` node is not spawned twice
 *  (#1386), a refreshed row value is not frozen at the old one (#1401), and the scene's own edits
 *  still survive. And a nested instance whose chain does not reach the outer root is not re-applied
 *  onto the row it merely shares a stamp with (#1383).
 *
 *  Harness copied from `prefabRowNestedChannels.test.ts`. Each case names the mutation that turns it red. */

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
import {
  setPrefabCache, instantiatePrefab, rebuildInstance, captureInstanceStructure,
} from '../../packages/modoki/src/editor/scene/prefab';
import { templateKeyOf, TemplateAddedKey } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const INNER = 'aaaaaaaa-0000-4000-8000-0000000001c1';
const MID = 'aaaaaaaa-0000-4000-8000-0000000001c2';
const OUTER = 'aaaaaaaa-0000-4000-8000-0000000001c3';
const HOLDER = 'bbbbbbbb-0000-4000-8000-0000000001c1';
const ROOT = 'bbbbbbbb-0000-4000-8000-0000000001c2';

const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, name, ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const innerDoc = { id: INNER, version: 3, name: 'Inner', rootLocalId: 1, entities: [row(1, 'InnerRoot', 0), row(2, 'Leaf', 1)] };
/** MID's own row 3 expands INNER — so a MID row in OUTER reaches Leaf at path `<row>.3`. */
const midDoc = { id: MID, version: 3, name: 'Mid', rootLocalId: 1, entities: [
  row(1, 'MidRoot', 0), row(2, 'Slot', 1), row(3, 'MidNested', 2, { prefab: INNER }),
] };
/** OUTER, optionally with a MID row (localId 5) under Button carrying `midRow` fields. */
const outerDoc = (midRow?: Record<string, unknown>) => ({
  id: OUTER, version: 3, name: 'Outer', rootLocalId: 1, entities: [
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
const EMPTY = { added: [], removed: [], removedTraits: {} };
const extra = (parentLocalId: number, key: string, name = 'Extra', x = 0) =>
  ({ parentLocalId, guid: '', key, name, traits: { EntityAttributes: { name }, Transform: { x, y: 0, z: 0 } }, children: [] });
const xOf = (id: number) => readTraitData(id, getTraitByName('Transform')!)?.x as number;
const traitsOf = (id: number) => getAllEntities().find((e) => e.id === id)!.traits;

describe('a row-authored added node is not spawned twice by a rebuild (#1386)', () => {
  // Mutation: in `subtractChainStructure`, `added.push(node)` for a node whose `base` is unchanged.
  it('the row\'s own `added`', async () => {
    const doc = outerDoc({ added: [extra(2, 'k-extra')] });
    install(doc);
    await load(sceneWith());
    expect(count('Extra')).toBe(1);
    rebuildInstance(byName('OuterRoot'), OUTER, doc as never, {}, EMPTY);
    expect(count('Extra')).toBe(1);
  });

  it('a path in the row\'s `nestedStructure`', async () => {
    const doc = outerDoc({ nestedStructure: { '3': { added: [extra(1, 'k-deep', 'Deep')], removed: [], removedTraits: {} } } });
    install(doc);
    await load(sceneWith());
    expect(count('Deep')).toBe(1);
    rebuildInstance(byName('OuterRoot'), OUTER, doc as never, {}, EMPTY);
    expect(count('Deep')).toBe(1);
  });

  // Mutation: drop the `recoverTemplateKey` fallback in `addedKeysOf` (the node lost its marker, as
  // Play→Stop and an undo respawn both do).
  it('a node that lost its key marker is still recognised', async () => {
    const doc = outerDoc({ added: [extra(2, 'k-extra')] });
    install(doc);
    await load(sceneWith());
    findEntity(byName('Extra'))!.remove(TemplateAddedKey);
    expect(templateKeyOf(findEntity(byName('Extra')))).toBe(''); // precondition: the marker is gone
    rebuildInstance(byName('OuterRoot'), OUTER, doc as never, {}, EMPTY);
    expect(count('Extra')).toBe(1);
  });

  // Mutation: skip the `deleteEntities(freshCopies(...))` line — the edited node then sits beside the
  // fresh one. And: skip the marker restore — the survivor then carries no key.
  it('a row-authored node the scene EDITED survives once, edit and key intact', async () => {
    const doc = outerDoc({ added: [extra(2, 'k-extra')] });
    install(doc);
    await load(sceneWith());
    writeTraitField(byName('Extra'), getTraitByName('Transform')!, 'x', 7);
    rebuildInstance(byName('OuterRoot'), OUTER, doc as never, {}, EMPTY);
    expect(count('Extra')).toBe(1);
    expect(xOf(byName('Extra'))).toBe(7);
    expect(templateKeyOf(findEntity(byName('Extra')))).toBe('k-extra');
  });

  // Mutation: in `subtractChainStructure`, treat every node as unmatched (`base` undefined) — no
  // regression there — or as matched (drop every node): the scene's own node is then lost.
  it('a SCENE-added node inside the nested instance still survives, once', async () => {
    const doc = outerDoc({});
    install(doc);
    await load(sceneWith({ nestedStructure: { '5': { added: [{ parentLocalId: 2, guid: 'cccccccc-0000-4000-8000-000000000002', name: 'Mine', traits: { EntityAttributes: { name: 'Mine' } }, children: [] }], removed: [], removedTraits: {} } } }));
    expect(count('Mine')).toBe(1);
    rebuildInstance(byName('OuterRoot'), OUTER, doc as never, {}, EMPTY);
    expect(count('Mine')).toBe(1);
  });
});

describe('a refresh reaches a row\'s nested values and structure (#1401)', () => {
  // Mutation: in `subtractChainOverrides`, never delete (restate every field, as before).
  it('a changed row override replaces the old one', async () => {
    const oldDoc = outerDoc({ overrides: { 2: { EntityAttributes: { name: 'SlotA' } } } });
    install(oldDoc);
    await load(sceneWith());
    expect(count('SlotA')).toBe(1);
    const newDoc = outerDoc({ overrides: { 2: { EntityAttributes: { name: 'SlotB' } } } });
    install(newDoc);
    rebuildInstance(byName('OuterRoot'), OUTER, newDoc as never, {}, EMPTY, oldDoc as never);
    expect(count('SlotA')).toBe(0);
    expect(count('SlotB')).toBe(1);
  });

  // Mutation: in `subtractChainOverrides`, delete on key presence alone (drop the `valuesEqual`).
  it('a scene that changed the row-set value keeps its change', async () => {
    const doc = outerDoc({ overrides: { 2: { EntityAttributes: { name: 'SlotA' } } } });
    install(doc);
    await load(sceneWith());
    writeTraitFieldWithUndo(byName('SlotA'), getTraitByName('EntityAttributes')!, 'name', 'Mine');
    rebuildInstance(byName('OuterRoot'), OUTER, doc as never, {}, EMPTY);
    expect(count('Mine')).toBe(1);
  });

  // Mutation: in `subtractChainStructure`, drop an unchanged match only when `base.key` is absent.
  it('an unchanged row-authored node takes the refreshed template', async () => {
    const oldDoc = outerDoc({ added: [extra(2, 'k-extra', 'Extra', 0)] });
    install(oldDoc);
    await load(sceneWith());
    const newDoc = outerDoc({ added: [extra(2, 'k-extra', 'Extra', 5)] });
    install(newDoc);
    rebuildInstance(byName('OuterRoot'), OUTER, newDoc as never, {}, EMPTY, oldDoc as never);
    expect(count('Extra')).toBe(1);
    expect(xOf(byName('Extra'))).toBe(5);
  });

  // Mutation: in `subtractChainStructure`, keep `full.removedTraits` whole.
  it('a component the old row removed comes back when the new row stops removing it', async () => {
    const oldDoc = outerDoc({ removedTraits: { 2: ['Transform'] } });
    install(oldDoc);
    await load(sceneWith());
    expect(traitsOf(byName('Slot'))).not.toContain('Transform');
    const newDoc = outerDoc({});
    install(newDoc);
    rebuildInstance(byName('OuterRoot'), OUTER, newDoc as never, {}, EMPTY, oldDoc as never);
    expect(traitsOf(byName('Slot'))).toContain('Transform');
  });
});

describe('the subtraction reads the chain the way the loader applies it (#1386 review)', () => {
  const guidOf = (id: number) => (readTraitData(id, getTraitByName('EntityAttributes')!)?.guid as string) || '';
  const bindingTarget = (id: number) =>
    ((findEntity(id)!.get(getTraitByName('UIAction')!.trait) as { bindings: { target: string }[] }).bindings[0]?.target);
  const innerRootUnderSlot = () => getAllEntities().find((e) => e.name === 'InnerRoot' && e.parentId === byName('Slot'))!.id;
  const midRoot = () => getAllEntities().find((e) => e.name === 'MidRoot')!.id;

  // Mutation: drop `resolve` on the override chain — the token never equals the live guid, so
  // the old target is restated over the refreshed one.
  it('a row override holding a member token takes the refreshed target', async () => {
    const oldDoc = outerDoc({ overrides: { 1: { UIAction: { bindings: [{ target: '@member:2' }] } } } });
    install(oldDoc);
    await load(sceneWith());
    expect(bindingTarget(midRoot())).toBe(guidOf(byName('Slot'))); // precondition: resolved in MID's frame
    const newDoc = outerDoc({ overrides: { 1: { UIAction: { bindings: [{ target: '@member:2.3' }] } } } });
    install(newDoc);
    rebuildInstance(byName('OuterRoot'), OUTER, newDoc as never, {}, EMPTY, oldDoc as never);
    expect(bindingTarget(midRoot())).toBe(guidOf(innerRootUnderSlot()));
  });

  // Mutation: resolve only `up=0` tokens (return a `^` token unchanged). The template writer falls back
  // to `^` for a ref out of the nested frame — the common shape of a row override.
  it('a row override holding a `^` token (a member of the NESTING prefab) takes the refreshed target', async () => {
    const oldDoc = outerDoc({ overrides: { 1: { UIAction: { bindings: [{ target: '@member:^.2' }] } } } });
    install(oldDoc);
    await load(sceneWith());
    expect(bindingTarget(midRoot())).toBe(guidOf(byName('Panel')));
    const newDoc = outerDoc({ overrides: { 1: { UIAction: { bindings: [{ target: '@member:^.2.3' }] } } } });
    install(newDoc);
    rebuildInstance(byName('OuterRoot'), OUTER, newDoc as never, {}, EMPTY, oldDoc as never);
    expect(bindingTarget(midRoot())).toBe(guidOf(byName('Button')));
  });

  // A value forwarded from TWO levels up still lands in its target instance's frame.
  // Mutation: replace `resolve` with the identity.
  it('a forwarded nestedOverrides token takes the refreshed target', async () => {
    const at = (target: string) => outerDoc({ nestedOverrides: { '3': { 1: { UIAction: { bindings: [{ target }] } } } } });
    const oldDoc = at('@member:2');
    install(oldDoc);
    await load(sceneWith());
    const leaf = () => getAllEntities().find((e) => e.name === 'Leaf' && e.parentId === innerRootUnderSlot())!.id;
    expect(bindingTarget(innerRootUnderSlot())).toBe(guidOf(leaf()));
    const newDoc = at('@member:');
    install(newDoc);
    rebuildInstance(byName('OuterRoot'), OUTER, newDoc as never, {}, EMPTY, oldDoc as never);
    expect(bindingTarget(innerRootUnderSlot())).toBe(guidOf(innerRootUnderSlot()));
  });

  // Mutation: drop `resolveNodes` on the structure chain — the token-bearing node reads as edited
  // and keeps the old template.
  it('an unchanged row-added node holding a member token takes the refreshed template', async () => {
    const node = (x: number) => ({ ...extra(2, 'k-tok', 'Tok', x), traits: { EntityAttributes: { name: 'Tok' }, Transform: { x, y: 0, z: 0 }, UIAction: { bindings: [{ target: '@member:2' }] } } });
    const oldDoc = outerDoc({ added: [node(0)] });
    install(oldDoc);
    await load(sceneWith());
    const newDoc = outerDoc({ added: [node(5)] });
    install(newDoc);
    rebuildInstance(byName('OuterRoot'), OUTER, newDoc as never, {}, EMPTY, oldDoc as never);
    expect(count('Tok')).toBe(1);
    expect(xOf(byName('Tok'))).toBe(5);
  });

  // Mutation: drop the schema-default branch in `subtractChainOverrides`.
  it('a component the old row ADDED goes when the new row stops adding it', async () => {
    const oldDoc = outerDoc({ overrides: { 1: { Text2D: { text: 'hi' } } } });
    install(oldDoc);
    await load(sceneWith());
    expect(traitsOf(midRoot())).toContain('Text2D');
    const newDoc = outerDoc({});
    install(newDoc);
    rebuildInstance(byName('OuterRoot'), OUTER, newDoc as never, {}, EMPTY, oldDoc as never);
    expect(traitsOf(midRoot())).not.toContain('Text2D');
  });

  // Mutation: in `freshCopies`, drop the `guids.has(...)` branch — the legacy node's fresh copy stays.
  it('an edited LEGACY row node (a durable guid, no key) survives once', async () => {
    const legacy = { ...extra(2, '', 'Old'), key: undefined, guid: 'dddddddd-0000-4000-8000-000000000001' };
    const doc = outerDoc({ added: [legacy] });
    install(doc);
    await load(sceneWith());
    expect(count('Old')).toBe(1);
    writeTraitField(byName('Old'), getTraitByName('Transform')!, 'x', 7);
    rebuildInstance(byName('OuterRoot'), OUTER, doc as never, {}, EMPTY);
    expect(count('Old')).toBe(1);
    expect(xOf(byName('Old'))).toBe(7);
  });

  // Mutation: in `subtractChainStructure`, keep `full.removed` whole.
  it('a member the old row removed comes back when the new row stops removing it', async () => {
    const oldDoc = outerDoc({ removed: [2] });
    install(oldDoc);
    await load(sceneWith());
    expect(count('Slot')).toBe(0);
    const newDoc = outerDoc({});
    install(newDoc);
    rebuildInstance(byName('OuterRoot'), OUTER, newDoc as never, {}, EMPTY, oldDoc as never);
    expect(count('Slot')).toBe(1);
  });
});

describe('a partial chain addresses nothing (#1383)', () => {
  // Mutation: `chainOf` returns `chain` unconditionally.
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
    rebuildInstance(root, OUTER, outerDoc() as never, {}, captureInstanceStructure(root, outerDoc() as never));
    expect(namePaths()).toContain('Holder/OuterRoot/Panel/InnerRoot/Leaf'); // row 4 untouched
    expect(namePaths()).toContain('Holder/OuterRoot/Panel/Plain/InnerRoot/Renamed'); // S carried whole
    expect(count('Renamed')).toBe(1);
  });
});
