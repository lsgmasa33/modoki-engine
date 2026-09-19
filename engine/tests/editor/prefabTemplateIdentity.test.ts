/** #1387: a prefab TEMPLATE carries no per-instance identity. An `added` node written into a template
 *  (a row's own `added`, a row's `nestedStructure[*].added`, a reference node's `added`) carries a
 *  template `key` and `guid: ''`. Each instance derives the node's guid from its own anchor, so two
 *  instances never share one. Before this, the node kept its durable guid verbatim and every instance
 *  spawned an entity with that one guid.
 *
 *  Driven through the real loader, the real editor capture, the real prefab-edit scene builder and
 *  Apply to Prefab. Each case names the mutation that must turn it red. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));
const writes: Array<{ path: string; content: string }> = [];
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string) => {
    writes.push({ path, content });
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  },
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, spawnEntity, Transform, EntityAttributes,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, Transient as TransientTrait, type SceneData,
} from '@modoki/engine/runtime';
import { clearHistory, setActionCallback, pushAction, serializeScene, deleteEntitiesWithUndo, undo, duplicateEntity } from '@modoki/engine/editor';
import {
  setPrefabCache, serializePrefab, applyToPrefabSelective, instantiatePrefabAsync, getOverrideValues, collectComparableTraits,
  baseTokenResolver, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { buildPrefabEditScene, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import type { AddedEntity } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { setTemplateKey, TemplateAddedKey } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { isRuntimeGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const INNER = 'aaaaaaaa-0000-4000-8000-0000000002c1';
const MID = 'aaaaaaaa-0000-4000-8000-0000000002c2';
const OUTER = 'aaaaaaaa-0000-4000-8000-0000000002c3';
const G1 = 'bbbbbbbb-0000-4000-8000-0000000002c1';
const G2 = 'bbbbbbbb-0000-4000-8000-0000000002c2';
const DURABLE = 'eeeeeeee-0000-4000-8000-0000000002e1';
const KEY = 'dddddddd-0000-4000-8000-0000000002d1';
const REF_KEY = 'dddddddd-0000-4000-8000-0000000002d2';

const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, name, ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const keyed = (name: string, parentLocalId: number, key = KEY): AddedEntity => ({
  parentLocalId, guid: '', key, name, traits: { EntityAttributes: { name }, Transform: { x: 1 } }, children: [],
});
const innerDoc = { id: INNER, version: 3, name: 'Inner', rootLocalId: 1, entities: [row(1, 'InnerRoot', 0), row(2, 'Leaf', 1)] };
/** MID's row 3 expands INNER under Slot; `rowExtra` extends that row. */
const midDoc = (rowExtra: Record<string, unknown> = {}) => ({ id: MID, version: 3, name: 'Mid', rootLocalId: 1, entities: [
  row(1, 'MidRoot', 0), row(2, 'Slot', 1), row(3, 'MidNested', 2, { prefab: INNER, ...rowExtra }),
] });
/** OUTER holds one MID row (localId 3); `midRow` extends it. */
const outerDoc = (midRow: Record<string, unknown> = {}) => ({ id: OUTER, version: 3, name: 'Outer', rootLocalId: 1, entities: [
  row(1, 'OuterRoot', 0), row(2, 'Panel', 1), row(3, 'MidRoot', 2, { prefab: MID, ...midRow }),
] });
const install = <T extends { id?: string }>(doc: T) => { prefabs.set(doc.id!, doc); setPrefabCache(doc.id!, doc as never); };

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
    onInstantiatePrefab: async (source, parentId, rootTf, _old, _extra, overrides, structure, nested, rootGuid, _folder, nestedStructure) => {
      const world = getCurrentWorld();
      const rootId = instantiatePrefabIntoWorld(world, prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
      if (!rootId) return undefined;
      for (const e of world.entities) {
        if (e.id() === rootId && rootGuid) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid: rootGuid });
      }
      return rootId;
    },
  });
}

/** Two top-level instances of `source`, anchored on G1 and G2. */
const twoInstances = (source: string, rootName: string): SceneData => ({
  id: 'two', version: 14, name: 'S', resources: [],
  entities: [
    { id: 1, prefab: source, guid: G1, traits: { EntityAttributes: { name: rootName, parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    { id: 2, prefab: source, guid: G2, traits: { EntityAttributes: { name: rootName, parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
  ],
} as unknown as SceneData);

const guidsNamed = (name: string): string[] => getAllEntities().filter((e) => e.name === name).map((e) => e.guid ?? "");
/** Both instances got the node, each under its own non-empty guid. */
const expectDistinct = (name: string): string[] => {
  const guids = guidsNamed(name);
  expect(guids).toHaveLength(2);
  expect(guids.every((g) => !!g)).toBe(true);
  expect(new Set(guids).size).toBe(2);
  return guids;
};

const openInEditor = async (doc: PrefabFile): Promise<number> => {
  install(doc);
  await load(buildPrefabEditScene(doc) as SceneData);
  return getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!.id;
};
const innerUnderMid = (): number => {
  const slot = getAllEntities().find((e) => e.name === 'Slot')!.id;
  return getAllEntities().find((e) => e.name === 'InnerRoot' && e.parentId === slot)!.id;
};
const midRowOf = (p: PrefabFile) => p.entities.find((e) => e.prefab === MID)!;

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  writes.length = 0;
  prefabs.clear();
  install(innerDoc);
  install(midDoc());
  install(outerDoc());
});
afterAll(() => { for (const id of [INNER, MID, OUTER]) setPrefabCache(id, null); getCurrentWorld()?.destroy(); });

describe('a keyed added node in a template gets a per-instance guid (#1387)', () => {
  // Mutation: in `deriveInstanceMemberGuids`, skip keyed rows (`!row.hasPI || row.origGuid`) — the
  // nodes come out guid-less. Stamping `node.key` as the guid in `spawnNode` makes them collide.
  it('through a row\'s own `added`, stable across a reload', async () => {
    install(midDoc({ added: [keyed('Extra', 1)] }));
    await load(twoInstances(MID, 'MidRoot'));
    const first = expectDistinct('Extra');
    await load(twoInstances(MID, 'MidRoot'));
    expect(guidsNamed('Extra')).toEqual(first);
  });

  it('through a row\'s `nestedStructure`', async () => {
    install(outerDoc({ nestedStructure: { '3': { added: [keyed('Extra', 1)], removed: [], removedTraits: {} } } }));
    await load(twoInstances(OUTER, 'OuterRoot'));
    expectDistinct('Extra');
  });

  // A reference node's root is a STORED root with no guid: it derives through its ancestors, and its
  // members derive from it. Two SIBLING reference nodes of one prefab share every localId, so only the
  // key tells them apart. Mutation: drop the `setTemplateKey` branch in the loader's
  // `spawnNestedInstance` — the siblings then both step by INNER's root localId and collide.
  it('through reference nodes in a row\'s `added`, root and members alike', async () => {
    const refNode = (key: string): AddedEntity => ({ parentLocalId: 1, guid: '', key, name: 'Dropped', prefab: INNER, traits: {}, children: [] });
    install(midDoc({ added: [refNode(REF_KEY), refNode(KEY)] }));
    await load(twoInstances(MID, 'MidRoot'));
    const inner = getAllEntities().filter((e) => e.name === 'InnerRoot');
    expect(inner).toHaveLength(6); // the row's own expansion and two dropped ones, per instance
    expect(new Set(inner.map((e) => e.guid)).size).toBe(6);
    const leaves = guidsNamed('Leaf');
    expect(leaves).toHaveLength(6);
    expect(new Set(leaves).size).toBe(6);
  });

  // A legacy SCENE-form node (a durable guid, no key) keeps it verbatim — the rule is carried by the
  // field, not by where the node sits.
  it('a node that carries a guid and no key keeps its guid', async () => {
    install(midDoc({ added: [{ ...keyed('Extra', 1), key: undefined, guid: DURABLE }] }));
    await load(twoInstances(MID, 'MidRoot'));
    expect(guidsNamed('Extra')).toEqual([DURABLE, DURABLE]);
  });
});

describe('a template write stores the key, never the live guid (#1387)', () => {
  // Mutation: capture the row's interior in scene form (drop `template: true` at `planPrefabRows`'
  // `captureNestedChannels` call) — the durable guid is written and the key is missing.
  it('a prefab-edit save writes a key for a durable-guid node, idempotently, and instances derive from it', async () => {
    const root = await openInEditor(outerDoc() as PrefabFile);
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Extra', parentId: innerUnderMid(), guid: DURABLE }));
    const saved = serializePrefab(root, OUTER)!;
    const node = (midRowOf(saved).nestedStructure as Record<string, { added: AddedEntity[] }>)['3']!.added[0]!;
    expect(node.guid).toBe('');
    expect(node.key).toMatch(/^[0-9a-f-]{36}$/);
    expect((node.traits.EntityAttributes as Record<string, unknown>).guid).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain(DURABLE);
    // Mutation: drop `setTemplateKey` in `addedNodeIdentity` — the second save mints a new key.
    expect(JSON.stringify(serializePrefab(root, OUTER))).toBe(JSON.stringify(saved));

    // The written file: two instances, two guids; and re-opening it re-saves the SAME key, read back
    // off the marker the loader stamped. Mutation: drop the `TemplateAddedKey` push in `spawnNode`.
    install(saved);
    await load(twoInstances(OUTER, 'OuterRoot'));
    expectDistinct('Extra');
    const reopened = await openInEditor(saved);
    expect(JSON.stringify(serializePrefab(reopened, OUTER))).toBe(JSON.stringify(saved));
  });

  // Promotion turns a SCENE capture into a prefab row. Mutation: pass `node.added` /
  // `node.nestedStructure` through verbatim in `insertAddedSubtree`.
  it('Apply to Prefab of a dropped instance writes its added nodes keyed', async () => {
    const DROPPED = 'bbbbbbbb-0000-4000-8000-0000000002c9';
    await load({
      id: 'apply', version: 14, name: 'S', resources: [],
      entities: [{ id: 1, prefab: OUTER, guid: G1, traits: { EntityAttributes: { name: 'OuterRoot', parentId: 0 } },
        added: [{ parentLocalId: 2, guid: DROPPED, name: 'Dropped', prefab: MID, traits: {}, children: [] }] }],
    } as unknown as SceneData);
    const dropped = getAllEntities().find((e) => e.guid === DROPPED)!.id;
    const slot = getAllEntities().find((e) => e.name === 'Slot' && e.parentId === dropped)!.id;
    const inner = getAllEntities().find((e) => e.name === 'InnerRoot' && e.parentId === slot)!.id;
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'OnSlot', parentId: slot, guid: DURABLE }));
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'OnInner', parentId: inner, guid: 'eeeeeeee-0000-4000-8000-0000000002e2' }));

    await applyToPrefabSelective(getAllEntities().find((e) => e.guid === G1)!.id, new Set([`+added.${DROPPED}`]));
    const written = writes.map((w) => JSON.parse(w.content) as PrefabFile).find((p) => p.id === OUTER)!;
    const promoted = written.entities.find((e) => e.prefab === MID && e.localId !== 3)!; // row 3 is OUTER's own
    expect(promoted.added!.map((n) => [n.name, n.guid, !!n.key])).toEqual([['OnSlot', '', true]]);
    const deep = (promoted.nestedStructure as Record<string, { added: AddedEntity[] }>)['3']!.added;
    expect(deep.map((n) => [n.name, n.guid, !!n.key])).toEqual([['OnInner', '', true]]);
    expect(JSON.stringify(written)).not.toMatch(/eeeeeeee-0000-4000-8000-0000000002e[12]/);
    // Apply refreshed the live instance from the written file: the keyed nodes re-expanded and were
    // derived by the rebuild. Mutation: drop `deriveInstanceMemberGuids` at the end of `rebuildInstance`.
    for (const name of ['OnSlot', 'OnInner']) {
      const guids = guidsNamed(name);
      expect(guids).toHaveLength(1);
      expect(guids[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(guids[0]).not.toMatch(/^eeeeeeee/);
      expect(isRuntimeGuid(guids[0])).toBe(false); // a spawn's runtime guid (#1210) is not a derivation
    }
  });
});

describe('the key survives a scene-form round trip of the edit world (#1387 review)', () => {
  const editRoot = () => getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!.id;
  const rowAddedKeys = (p: PrefabFile, rowLocalId: number) => p.entities.find((e) => e.localId === rowLocalId)!.added!.map((n) => n.key);

  // Play snapshots the edit world with `serializeScene` (scene form: guid, no key) and Stop reloads
  // it, so every marker is gone. Mutation: drop the `recoverTemplateKey` call in `addedNodeIdentity`
  // — MID's key is re-minted, and OUTER's no-op save pins MID's interior.
  it('after Play→Stop, a no-op save neither re-keys the row nor pins the inner interior', async () => {
    install(midDoc({ added: [keyed('Extra', 2)] }));
    await openInEditor(outerDoc() as PrefabFile);
    expect(midRowOf(serializePrefab(editRoot(), OUTER)!).nestedStructure).toBeUndefined();
    await load(await serializeScene() as unknown as SceneData);
    expect(midRowOf(serializePrefab(editRoot(), OUTER)!).nestedStructure).toBeUndefined();

    await openInEditor(midDoc({ added: [keyed('Extra', 2)] }) as PrefabFile);
    await load(await serializeScene() as unknown as SceneData);
    expect(rowAddedKeys(serializePrefab(editRoot(), MID)!, 3)).toEqual([KEY]);
  });

  // Delete→undo respawns from a registry-only snapshot. A keyed CHILD of a keyed node recovers
  // through its parent's recovered step.
  it('after delete→undo, the node and its keyed child keep their keys', async () => {
    const CHILD_KEY = 'dddddddd-0000-4000-8000-0000000002d3';
    const parent = { ...keyed('Extra', 2), children: [{ ...keyed('Kid', 0, CHILD_KEY) }] };
    await openInEditor(midDoc({ added: [parent] }) as PrefabFile);
    deleteEntitiesWithUndo([getAllEntities().find((e) => e.name === 'Extra')!.id]);
    expect(getAllEntities().some((e) => e.name === 'Kid')).toBe(false);
    await undo();
    const node = serializePrefab(editRoot(), MID)!.entities.find((e) => e.localId === 3)!.added![0]!;
    expect([node.key, node.children[0]!.key]).toEqual([KEY, CHILD_KEY]);
  });

  // The population #1387 is about: a row node carrying a durable guid and no key. It migrates when
  // its own prefab is saved, never by being pinned into the outer row. Mutation: compare `guid` in
  // `sameStructure` when one side is unkeyed.
  it('a legacy guid-bearing row node is not pinned by the outer prefab\'s no-op save', async () => {
    install(midDoc({ added: [{ ...keyed('Extra', 2), key: undefined, guid: DURABLE, traits: { EntityAttributes: { name: 'Extra', guid: DURABLE } } }] }));
    await openInEditor(outerDoc() as PrefabFile);
    expect(midRowOf(serializePrefab(editRoot(), OUTER)!).nestedStructure).toBeUndefined();
  });
});

// ── #1352: a ref between a prefab's own members ─────────────────────────────────────────────────────
const bind = (target: string) => ({ UIAction: { bindings: [{ event: 'click', kind: 'call', action: 'noop', target }] } });
const targetOf = (id: number): string => {
  const meta = getTraitByName('UIAction')!;
  const e = [...getCurrentWorld().entities].find((x) => x.id() === id)!;
  return (e.get(meta.trait) as { bindings: { target: string }[] }).bindings[0]!.target;
};
const entity = (name: string, parent: (typeof getAllEntities extends () => (infer E)[] ? E : never) | undefined) =>
  getAllEntities().find((e) => e.name === name && (!parent || e.parentId === parent.id))!;
const PANEL = 'bbbbbbbb-0000-4000-8000-0000000003c1';
const CHILD = 'bbbbbbbb-0000-4000-8000-0000000003c2';
const PANEL_PREFAB = 'aaaaaaaa-0000-4000-8000-0000000003c1';

/** A scene holding a Panel whose button binding targets the Panel's own Child. */
const panelScene = (): SceneData => ({
  id: 'panel', version: 14, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Panel', parentId: 0, guid: PANEL }, ...bind(CHILD) } },
    { id: 2, traits: { EntityAttributes: { name: 'Child', parentId: PANEL, guid: CHILD } } },
  ],
} as unknown as SceneData);

describe('a ref between a prefab\'s own members follows each instance (#1352)', () => {
  // Mutation: drop `tokens.value(traitData, 0)` in `serializePrefab` — the file keeps CHILD, and
  // every instance targets the source Child.
  it('Create Prefab writes the ref as a member token, and every instance targets its OWN child', async () => {
    await load(panelScene());
    const file = serializePrefab(entity('Panel', undefined).id, PANEL_PREFAB)!;
    expect((file.entities[0]!.traits.UIAction as { bindings: { target: string }[] }).bindings[0]!.target).toBe('@member:2');
    expect(JSON.stringify(file)).not.toContain(CHILD);

    install(file);
    await load(twoInstances(PANEL_PREFAB, 'Panel'));
    const panels = getAllEntities().filter((e) => e.name === 'Panel');
    expect(panels).toHaveLength(2);
    for (const p of panels) expect(targetOf(p.id)).toBe(entity('Child', p).guid);
    expect(new Set(panels.map((p) => targetOf(p.id))).size).toBe(2);

    // The editor's expansion (Hierarchy drop / Instantiate) resolves the same way. Mutation: drop the
    // `registerTemplateFrame` call at the end of the editor `instantiatePrefab`.
    await load({ id: 'e', version: 14, name: 'E', resources: [], entities: [] } as unknown as SceneData);
    const root = await instantiatePrefabAsync(file);
    expect(targetOf(root)).toBe(entity('Child', getAllEntities().find((e) => e.id === root)).guid);
  });

  // A scene save of an untouched instance stores no override, so the reload re-resolves the token.
  // Mutation: drop `resolveBase` in `captureInstanceOverrides`' diff — a marked-free diff is gated out
  // anyway, so this pins the round trip rather than the resolver.
  it('a scene save + reload keeps each instance on its own child', async () => {
    await load(panelScene());
    install(serializePrefab(entity('Panel', undefined).id, PANEL_PREFAB)!);
    await load(twoInstances(PANEL_PREFAB, 'Panel'));
    const saved = await serializeScene();
    expect(JSON.stringify(saved)).not.toMatch(/"target":"[0-9a-f]{8}-/);
    await load(saved as unknown as SceneData);
    for (const p of getAllEntities().filter((e) => e.name === 'Panel')) expect(targetOf(p.id)).toBe(entity('Child', p).guid);
  });

  // Mutation: drop `resolveBase` in `getOverrideValues` — the untouched binding reads as overridden.
  it('an untouched instance reports no override on the token-bearing field', async () => {
    await load(panelScene());
    const file = serializePrefab(entity('Panel', undefined).id, PANEL_PREFAB)!;
    install(file);
    await load(twoInstances(PANEL_PREFAB, 'Panel'));
    const root = getAllEntities().find((e) => e.guid === G1)!.id;
    const current = collectComparableTraits(root, (await import('@modoki/engine/runtime')).getAllTraits());
    expect(getOverrideValues(1, current, file, baseTokenResolver(root))).toEqual({});
    expect(getOverrideValues(1, current, file).UIAction).toBeDefined(); // the resolver is what makes it equal
  });

  // The prefab editor flattens the prefab's own rows into scene entities with sentinel guids, so a
  // token must become the edit Child's guid and come back as the same token. Mutation: drop
  // `editWorldRefs` on a flat row's traits in `buildPrefabEditScene`.
  it('the prefab editor shows the ref on the edit Child, and a no-op save writes the token back', async () => {
    await load(panelScene());
    const file = serializePrefab(entity('Panel', undefined).id, PANEL_PREFAB)!;
    const root = await openInEditor(file);
    expect(targetOf(root)).toBe(entity('Child', undefined).guid);
    expect(JSON.stringify(serializePrefab(root, PANEL_PREFAB))).toBe(JSON.stringify(file));
  });

  // Apply to Prefab of a retargeted binding writes the token, not the live guid. Mutation: drop
  // `tokenizeForInstance` in the value overlay.
  it('Apply to Prefab writes a member token for a ref into the instance', async () => {
    const doc = { id: PANEL_PREFAB, version: 3, name: 'Panel', rootLocalId: 1, entities: [
      { localId: 1, name: 'Panel', traits: { EntityAttributes: { name: 'Panel', parentId: 0, guid: '' }, ...bind('') } },
      { localId: 2, name: 'Child', traits: { EntityAttributes: { name: 'Child', parentId: 1, guid: '' } } },
    ] };
    install(doc);
    await load(twoInstances(PANEL_PREFAB, 'Panel'));
    const root = getAllEntities().find((e) => e.guid === G1)!;
    const meta = getTraitByName('UIAction')!;
    const handle = [...getCurrentWorld().entities].find((x) => x.id() === root.id)!;
    handle.set(meta.trait, { bindings: [{ event: 'click', kind: 'call', action: 'noop', target: entity('Child', root).guid }] });
    await applyToPrefabSelective(root.id, new Set(['1.UIAction.bindings']));
    const written = writes.map((w) => JSON.parse(w.content) as PrefabFile).find((p) => p.id === PANEL_PREFAB)!;
    expect((written.entities[0]!.traits.UIAction as { bindings: { target: string }[] }).bindings[0]!.target).toBe('@member:2');
  });
});

describe('a member token through nested prefabs (#1352)', () => {
  // INNER's own Leaf binding names INNER's root (`@member:`). MID's row overrides INNER's root binding to
  // name MID's Slot (`^.2`, climbing out of INNER). OUTER nests MID, which nests INNER, so INNER expands
  // two frames below the top call: the rebase has to compose.
  const inner = { id: INNER, version: 3, name: 'Inner', rootLocalId: 1, entities: [
    { localId: 1, name: 'InnerRoot', traits: { EntityAttributes: { name: 'InnerRoot', parentId: 0, guid: '' } } },
    { localId: 2, name: 'Leaf', traits: { EntityAttributes: { name: 'Leaf', parentId: 1, guid: '' }, ...bind('@member:') } },
  ] };
  const mid = { id: MID, version: 3, name: 'Mid', rootLocalId: 1, entities: [
    row(1, 'MidRoot', 0), row(2, 'Slot', 1),
    row(3, 'MidNested', 2, { prefab: INNER, overrides: { 1: { UIAction: { bindings: [{ event: 'click', kind: 'call', action: 'noop', target: '@member:^.2' }] } } } }),
  ] };
  const outer = { id: OUTER, version: 3, name: 'Outer', rootLocalId: 1, entities: [
    row(1, 'OuterRoot', 0), row(2, 'Panel', 1), row(3, 'MidRoot', 2, { prefab: MID }),
  ] };

  // Mutation: pass `segments` instead of `[...segments, rowPathInPrefab(...)]` into the nested call —
  // INNER's `@member:` then resolves to OUTER's root. Dropping the `^` handling leaves the row's
  // override unresolved.
  it.each([
    ['the scene loader', async () => { await load(twoInstances(OUTER, 'OuterRoot')); }],
    ['the editor instantiate', async () => {
      await load({ id: 'e', version: 14, name: 'E', resources: [], entities: [] } as unknown as SceneData);
      await instantiatePrefabAsync(outer as PrefabFile);
      await instantiatePrefabAsync(outer as PrefabFile);
    }],
  ])('%s resolves each token within its own instance', async (_label, run) => {
    install(inner); install(mid); install(outer);
    await run();
    const roots = getAllEntities().filter((e) => e.name === 'InnerRoot');
    expect(roots).toHaveLength(2);
    for (const innerRoot of roots) {
      const slot = getAllEntities().find((e) => e.id === innerRoot.parentId)!;
      expect(slot.name).toBe('Slot');
      expect(targetOf(innerRoot.id)).toBe(slot.guid); // MID's row: `^.2` → MID's own Slot
      expect(targetOf(entity('Leaf', innerRoot).id)).toBe(innerRoot.guid); // INNER's own `@member:`
    }
    expect(new Set(roots.map((r) => targetOf(r.id))).size).toBe(2);
  });

  // A keyed node MID's row adds, whose bindings name INNER's Leaf (its own frame: `@member:2`) and MID's
  // Slot (one frame out: `@member:^.2`). The writer takes the NEAREST frame that can name a target, so
  // MID's save and OUTER's save of the same interior spell it alike. Mutation: in
  // `templateTokenizer.value`, always climb to the written root (`frame = rootEcsId`-relative with the
  // full depth) — OUTER's no-op save then pins MID's interior.
  it('a token in a row-authored node is spelled the same by every writer, so no save pins it', async () => {
    const extra = { ...keyed('Extra', 1), traits: { EntityAttributes: { name: 'Extra' }, UIAction: { bindings: [
      { event: 'click', kind: 'call', action: 'noop', target: '@member:2' },
      { event: 'click', kind: 'call', action: 'noop', target: '@member:^.2' },
    ] } } };
    install(inner);
    const midWithNode = { ...mid, entities: [...mid.entities.slice(0, 2), { ...mid.entities[2]!, added: [extra] }] };
    install(midWithNode);
    install(outer);
    await load(twoInstances(OUTER, 'OuterRoot'));
    for (const node of getAllEntities().filter((e) => e.name === 'Extra')) {
      const innerRoot = getAllEntities().find((e) => e.id === node.parentId)!;
      const meta = getTraitByName('UIAction')!;
      const h = [...getCurrentWorld().entities].find((x) => x.id() === node.id)!;
      const targets = (h.get(meta.trait) as { bindings: { target: string }[] }).bindings.map((b) => b.target);
      expect(targets).toEqual([entity('Leaf', innerRoot).guid, getAllEntities().find((e) => e.id === innerRoot.parentId)!.guid]);
    }
    const outerRoot = await openInEditor(outer as PrefabFile);
    expect(midRowOf(serializePrefab(outerRoot, OUTER)!).nestedStructure).toBeUndefined();
    const midRoot = await openInEditor(midWithNode as PrefabFile);
    expect(serializePrefab(midRoot, MID)!.entities.find((e) => e.localId === 3)!.added).toEqual([extra]);
  });

  // The prefab editor flattens MID's own rows and expands its INNER row as a scene instance, so the
  // row's `^` token must become an edit-world guid and come back as the same token on save.
  // Mutation: drop `editWorldRefs` on the row's `overrides` in `buildPrefabEditScene`.
  it('the prefab editor resolves a row\'s `^` token and a no-op save writes it back byte-equal', async () => {
    install(inner);
    const root = await openInEditor(mid as PrefabFile);
    const innerRoot = getAllEntities().find((e) => e.name === 'InnerRoot')!;
    expect(targetOf(innerRoot.id)).toBe(entity('Slot', undefined).guid);
    const saved = serializePrefab(root, MID)!;
    expect(saved.entities.find((e) => e.localId === 3)!.overrides).toEqual((mid.entities[2] as { overrides?: unknown }).overrides);
  });
});

describe('close-out review findings (#1352)', () => {
  // A scene instance placed UNDER another instance is its own frame. The host's resolve pass named the
  // child instance's root as a target and also rewrote its bag, so its `@member:2` resolved to the
  // HOST's member 2. Mutation: drop the `ownFrame` filter in `resolveTemplateFrames`.
  it('an instance nested under another instance resolves its root token in its own frame', async () => {
    await load(panelScene());
    install(serializePrefab(entity('Panel', undefined).id, PANEL_PREFAB)!);
    const HOST = 'aaaaaaaa-0000-4000-8000-0000000003c9';
    install({ id: HOST, version: 3, name: 'Host', rootLocalId: 1, entities: [row(1, 'Host', 0), {
      localId: 2, name: 'HostChild', traits: { EntityAttributes: { name: 'HostChild', parentId: 1, guid: '' }, ...bind('@member:') },
    }] });
    await load({
      id: 'nest', version: 14, name: 'S', resources: [],
      entities: [
        { id: 1, prefab: HOST, guid: G1, traits: { EntityAttributes: { name: 'Host', parentId: 0 } } },
        { id: 2, prefab: PANEL_PREFAB, guid: G2, traits: { EntityAttributes: { name: 'Panel', parentId: G1 } } },
      ],
    } as unknown as SceneData);
    const panel = entity('Panel', undefined);
    expect(targetOf(panel.id)).toBe(entity('Child', panel).guid);
    expect(targetOf(entity('HostChild', undefined).id)).toBe(G1); // the host's own token still resolves
  });

  /** A chain of `depth` plain nodes, each with a durable guid, under MID's INNER in the OUTER edit
   *  world; `keyed` stamps each with a template key, so the capture never has to recover one. */
  const deepChain = async (depth: number, keyed: boolean): Promise<number> => {
    install(midDoc({ added: Array.from({ length: 20 }, (_, i) => keyedNode(i)) }));
    const root = await openInEditor(outerDoc() as PrefabFile);
    let parent = innerUnderMid();
    for (let i = 0; i < depth; i++) {
      const e = spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: `C${i}`, parentId: parent, guid: `eeeeeeee-0000-4000-8000-${String(100 + i).padStart(12, '0')}` }));
      if (keyed) setTemplateKey(e, `dddddddd-0000-4000-8000-${String(500 + i).padStart(12, '0')}`);
      parent = e.id();
    }
    return root;
  };
  const keyedNode = (i: number) => keyed(`K${i}`, 2, `dddddddd-0000-4000-8000-${String(900 + i).padStart(12, '0')}`);

  // Recovery used to recurse at every ancestor: 2^depth, measured at 1 s per node at depth 14. The
  // bound is loose on purpose. At depth 16 the old code takes seconds and the new code takes about
  // 100 ms, so machine load cannot flake it. Mutation: recover every ancestor recursively without
  // the memo.
  it('key recovery stays linear in depth', async () => {
    const root = await deepChain(16, false);
    const t0 = performance.now();
    serializePrefab(root, OUTER);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  // `sameStructure` nested each level's JSON inside its parent's, doubling the escaping per level:
  // 1.4 s at 22 deep, out of memory at 24. The nodes are pre-keyed, so this measures only the
  // comparison. Mutation: return `JSON.stringify` strings from `asSet`.
  it('comparing a deep interior stays linear in depth', async () => {
    const root = await deepChain(30, true);
    const t0 = performance.now();
    serializePrefab(root, OUTER);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  // A token that only a reference node's OWN payload carries (its child prefab holds none). The loader
  // hands that payload into the node's top call, which notes it; the editor applies it after its top
  // call closed, so it opens a scope around the whole node. Mutations: no-op the `values` half of
  // `noteTokens` (the loader stops resolving it); drop the editor's scope in `spawnNestedInstance`.
  it.each([
    ['the scene loader', async () => { await load(twoInstances(MID, 'MidRoot')); }],
    ['the editor instantiate', async () => {
      await load({ id: 'e', version: 14, name: 'E', resources: [], entities: [] } as unknown as SceneData);
      await instantiatePrefabAsync(prefabs.get(MID) as PrefabFile);
    }],
  ])('%s resolves a token in a reference node\'s own overrides', async (_label, run) => {
    const refNode: AddedEntity = { parentLocalId: 1, guid: '', key: REF_KEY, name: 'Dropped', prefab: INNER, traits: {}, children: [],
      overrides: { 1: { UIAction: { bindings: [{ event: 'click', kind: 'call', action: 'noop', target: '@member:2' }] } } } as never };
    install(midDoc({ added: [refNode] }));
    await run();
    const dropped = getAllEntities().filter((e) => e.name === 'InnerRoot' && getAllEntities().find((p) => p.id === e.parentId)?.name === 'InnerRoot');
    expect(dropped.length).toBeGreaterThan(0);
    for (const r of dropped) expect(targetOf(r.id)).toBe(entity('Leaf', r).guid);
  });

  // Same rule as the next case, through a ROW's `overrides`: OUTER's MID row overrides MID's Slot to name
  // the legacy node, which the file keeps keyless. Mutation: drop the loop over the row fields after
  // `pe.traits` in `serializePrefab`'s undeclared-key pass.
  it('a row override naming a legacy guid-bearing node keeps that guid', async () => {
    install(midDoc({ added: [{ ...keyed('Extra', 2), key: undefined, guid: DURABLE, traits: { EntityAttributes: { name: 'Extra', guid: DURABLE } } }] }));
    const root = await openInEditor(outerDoc({ overrides: { 2: { ...bind(DURABLE) } } }) as PrefabFile);
    const saved = serializePrefab(root, OUTER)!;
    expect(midRowOf(saved).overrides).toEqual({ 2: bind(DURABLE) });
  });

  // A pre-key row node carrying a durable guid is left in the file as it is (its interior still counts
  // as unchanged), so a ref to it must stay that guid: a token for the key minted in the capture would
  // name nothing on reload. Mutation: drop the `undeclaredKeys` pass in `serializePrefab`.
  it('a ref to a legacy guid-bearing row node stays its guid', async () => {
    install(midDoc({ added: [{ ...keyed('Extra', 2), key: undefined, guid: DURABLE, traits: { EntityAttributes: { name: 'Extra', guid: DURABLE } } }] }));
    const doc = outerDoc();
    (doc.entities[1] as { traits: Record<string, unknown> }).traits = { ...doc.entities[1]!.traits, ...bind(DURABLE) };
    const root = await openInEditor(doc as PrefabFile);
    const saved = serializePrefab(root, OUTER)!;
    expect(midRowOf(saved).nestedStructure).toBeUndefined();
    expect((saved.entities.find((e) => e.name === 'Panel')!.traits.UIAction as { bindings: { target: string }[] }).bindings[0]!.target).toBe(DURABLE);
  });
});

// ── #1426: a member token naming a template-ADDED node, across a scene save + reload ────────────────
describe('a member token naming a template-added node survives a scene save + reload (#1426)', () => {
  // OUTER's Panel binds to a node OUTER's MID row adds inside MID's nested INNER: Panel(2) → MidRoot(3)
  // → Slot(2) → InnerRoot (nested root, steps by its parentLocalId 3) → '+' + KEY.
  const TOKEN = `@member:2.3.2.3.+${KEY}`;
  const outerWithRef = () => {
    const doc = outerDoc({ nestedStructure: { '3': { added: [keyed('Extra', 1)] } } });
    Object.assign(doc.entities[1]!.traits, bind(TOKEN));
    return doc;
  };
  const rootGuidOf = (id: number): string => {
    let cur = getAllEntities().find((e) => e.id === id);
    while (cur && cur.parentId) cur = getAllEntities().find((e) => e.id === cur!.parentId);
    return cur?.guid ?? '';
  };
  /** Each Panel targets the Extra of its OWN instance, and every Extra carries KEY again. */
  const expectEachPanelOnItsOwnExtra = () => {
    const extras = getAllEntities().filter((e) => e.name === 'Extra');
    expect(extras).toHaveLength(2);
    const extraByRoot = new Map(extras.map((x) => [rootGuidOf(x.id), x]));
    for (const p of getAllEntities().filter((e) => e.name === 'Panel')) {
      expect(targetOf(p.id)).toBe(extraByRoot.get(rootGuidOf(p.id))!.guid);
    }
    const tk = [...getCurrentWorld().entities].filter((e) => extras.some((x) => x.id === e.id()));
    expect(tk.map((e) => (e.get(TemplateAddedKey) as { key: string } | undefined)?.key)).toEqual([KEY, KEY]);
  };

  // The save writes each Extra as scene form (its guid, no key), so the reload spawns it unkeyed and,
  // before the heal, left both Panels on the literal token. Mutation: skip the heal block in
  // `deriveInstanceMemberGuids`.
  it('each instance\'s Panel still targets its own Extra after the reload', async () => {
    install(outerWithRef());
    await load(twoInstances(OUTER, 'OuterRoot'));
    expectEachPanelOnItsOwnExtra();

    const saved = await serializeScene();
    expect(JSON.stringify(saved)).not.toContain(`"key":"${KEY}"`); // the premise: scene form drops the key
    await load(saved as unknown as SceneData);
    expectEachPanelOnItsOwnExtra();
  });

  // The Inspector compares an instance against its prefab through `baseTokenResolver`, which names
  // the node through its key. Unkeyed, the untouched binding read as an override.
  it('an untouched instance reports no override on the binding after the reload', async () => {
    const file = outerWithRef() as unknown as PrefabFile;
    install(file);
    await load(twoInstances(OUTER, 'OuterRoot'));
    await load(await serializeScene() as unknown as SceneData);
    const root = getAllEntities().find((e) => e.guid === G1)!.id;
    const panel = getAllEntities().find((e) => e.name === 'Panel' && rootGuidOf(e.id) === G1)!.id;
    const current = collectComparableTraits(panel, (await import('@modoki/engine/runtime')).getAllTraits());
    expect(getOverrideValues(2, current, file, baseTokenResolver(root)).UIAction).toBeUndefined();
    expect(getOverrideValues(2, current, file).UIAction).toBeDefined(); // the resolver is what makes it equal
  });

  // Accept side: the heal names only a node a key derives. A scene-added child under a member has a
  // random guid and stays unkeyed. Mutation: stamp the first candidate key without the derivation check.
  it('a scene-added plain child under a member is not keyed by the heal', async () => {
    install(outerWithRef());
    await load(twoInstances(OUTER, 'OuterRoot'));
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Plain', parentId: innerUnderMid(), guid: DURABLE }));
    await load(await serializeScene() as unknown as SceneData);
    const plain = getAllEntities().find((e) => e.name === 'Plain')!;
    expect(plain.guid).toBe(DURABLE);
    expect([...getCurrentWorld().entities].find((x) => x.id() === plain.id)!.has(TemplateAddedKey)).toBe(false);
    expectEachPanelOnItsOwnExtra(); // and the real keyed nodes beside it still heal
  });

  // A recorded miss must not outlive the tree it was computed on. Move Extra out of its frame, save
  // and reload (it comes back unkeyed and unrecoverable there — a miss is cached), then move it back:
  // the next derive must heal it. Mutation: drop the ancestor chain from the miss signature.
  it('a node moved back into its frame heals on the next derive, despite an earlier cached miss', async () => {
    const { deriveInstanceMemberGuids } = await import('../../packages/modoki/src/runtime/loaders/loadSceneFile');
    install(outerWithRef());
    await load(twoInstances(OUTER, 'OuterRoot'));
    const extraOf = () => getAllEntities().find((e) => e.name === 'Extra' && rootGuidOf(e.id) === G1)!;
    const inner = extraOf().parentId;
    const slot = getAllEntities().find((e) => e.name === 'Slot' && rootGuidOf(e.id) === G1)!.id;
    const eaMeta = getTraitByName('EntityAttributes')!;
    const setParent = (id: number, parentId: number) => {
      const e = [...getCurrentWorld().entities].find((x) => x.id() === id)!;
      e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), parentId });
    };
    setParent(extraOf().id, slot);
    await load(await serializeScene() as unknown as SceneData);
    const live = () => [...getCurrentWorld().entities].find((x) => x.id() === extraOf().id)!;
    expect(live().has(TemplateAddedKey)).toBe(false); // out of its frame, nothing derives its guid
    const innerNow = getAllEntities().find((e) => e.name === 'InnerRoot' && rootGuidOf(e.id) === G1
      && getAllEntities().find((s2) => s2.id === e.parentId)?.name === 'Slot')!.id;
    expect(inner).toBeTruthy();
    setParent(extraOf().id, innerNow);
    deriveInstanceMemberGuids(getCurrentWorld());
    expect((live().get(TemplateAddedKey) as { key: string } | undefined)?.key).toBe(KEY);
  });
});

// ── #1427: an undo respawn keeps the unregistered markers; a copy drops them ────────────────────────
describe('delete→undo carries unregistered markers, a duplicate does not (#1427)', () => {
  const liveOf = (name: string) => [...getCurrentWorld().entities].find((x) => getAllEntities().find((a) => a.id === x.id())?.name === name)!;

  // The undo snapshot walks the trait registry, which never sees `Transient`, so an undone delete
  // brought a runtime node back SAVABLE. Mutation: drop `restoreMarkers` in `respawnFromSnapshot`.
  it('an undone delete of a Transient node is still Transient', async () => {
    await load({ id: 'e', version: 14, name: 'E', resources: [], entities: [] } as unknown as SceneData);
    const id = spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Runtime', guid: DURABLE })).id();
    liveOf('Runtime').add(TransientTrait);
    deleteEntitiesWithUndo([id]);
    await undo();
    expect(liveOf('Runtime').has(TransientTrait)).toBe(true);
  });

  // A copy is a new identity: a duplicated template-added node keeping the key would give two
  // siblings one step, which names neither. Mutation: drop `markers: undefined` in
  // `regenerateSnapshotGuids`.
  it('a duplicate of a keyed node carries no key and no Transient', async () => {
    await load({ id: 'e', version: 14, name: 'E', resources: [], entities: [] } as unknown as SceneData);
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Src', guid: DURABLE }));
    const src = liveOf('Src');
    src.add(TransientTrait);
    setTemplateKey(src, KEY);
    const copyId = duplicateEntity(src.id(), () => {})!;
    const copy = [...getCurrentWorld().entities].find((x) => x.id() === copyId)!;
    expect(copy.has(TemplateAddedKey)).toBe(false);
    expect(copy.has(TransientTrait)).toBe(false);
  });
});

// ── #1426 close-out: the heal is paid on EVERY runtime prefab spawn, so it must not scale with the world ──
describe('the key heal is bounded to prefab instances (#1426 close-out)', () => {
  // The first cut walked every plain entity in the world to the scene root, trying every key at every
  // ancestor, on every spawn: measured 51 ms per spawn at 2000 entities × depth 8 × 5 keys. Here 5000
  // plain entities in 16-deep chains, outside any instance, with 20 keys declared — the old walk is
  // ~1.6M hashes (well over a second); the bounded heal touches none of them. The bound is loose on
  // purpose so machine load cannot flake it. Mutation: drop `!inside(id)` from the heal's filter.
  it('plain entities outside any instance cost the heal nothing', async () => {
    const { noteTemplateDoc } = await import('../../packages/modoki/src/runtime/loaders/templateKeyRecovery');
    const { deriveInstanceMemberGuids } = await import('../../packages/modoki/src/runtime/loaders/loadSceneFile');
    await load({ id: 'e', version: 14, name: 'E', resources: [], entities: [] } as unknown as SceneData);
    const world = getCurrentWorld();
    const keys = Array.from({ length: 20 }, (_, i) => `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`);
    noteTemplateDoc(world, { entities: [{ added: keys.map((key) => ({ key })) }] });
    for (let c = 0; c < 5000 / 16; c++) {
      let parent = 0;
      for (let d = 0; d < 16; d++) {
        const g = `cccccccc-${String(c).padStart(4, '0')}-4000-8000-${String(d).padStart(12, '0')}`;
        parent = spawnEntity(world, Transform(), EntityAttributes({ name: 'P', parentId: parent, guid: g })).id();
      }
    }
    const t0 = performance.now();
    deriveInstanceMemberGuids(world);
    expect(performance.now() - t0).toBeLessThan(400);
  });
});

describe('recoverTemplateKey stops at the top (#1426 close-out)', () => {
  // The loader passes `isTop` = a top-level stored instance root, so a node never climbs past its
  // instance trying keys at every level. Mutation: delete `if (isTop?.(cur)) break;`.
  it('reads no ancestor above the top', async () => {
    const { recoverTemplateKey } = await import('../../packages/modoki/src/runtime/loaders/templateKeyRecovery');
    const read = new Set<number>();
    // 1 = the node; 2 = its parent, the top; 3..52 = plain ancestors above the top.
    const nodeOf = (id: number) => {
      read.add(id);
      if (id > 52) return undefined;
      return { guid: `ffffffff-0000-4000-8000-${String(id).padStart(12, '0')}`, parentId: id + 1, key: '', pi: null };
    };
    expect(recoverTemplateKey(1, nodeOf, new Set([KEY]), new Map(), (id) => id === 2)).toBe('');
    expect([...read].some((id) => id > 2)).toBe(false);
  });
});

describe('the heal caches its misses (#1426 close-out)', () => {
  // Every runtime spawn re-runs the derive pass; an unrecoverable node inside an instance must be
  // tried once per (guid, key set, ancestor chain), not once per spawn. 6000 scene-added children
  // under an instance member with 40 keys: the first pass pays ~700k hashes, a cached second pass
  // none. Mutation: drop the `misses.get(id) === tried` skip.
  it('a second derive pass skips the nodes the first could not heal', async () => {
    const { noteTemplateDoc } = await import('../../packages/modoki/src/runtime/loaders/templateKeyRecovery');
    const { deriveInstanceMemberGuids } = await import('../../packages/modoki/src/runtime/loaders/loadSceneFile');
    install(outerDoc());
    await load(twoInstances(OUTER, 'OuterRoot'));
    const world = getCurrentWorld();
    const keys = Array.from({ length: 40 }, (_, i) => `dddddddd-1111-4000-8000-${String(i).padStart(12, '0')}`);
    noteTemplateDoc(world, { entities: [{ added: keys.map((key) => ({ key })) }] });
    const panel = getAllEntities().find((e) => e.name === 'Panel')!.id;
    for (let i = 0; i < 6000; i++) {
      spawnEntity(world, Transform(), EntityAttributes({ name: 'Kid', parentId: panel, guid: `cccccccc-1111-4000-8000-${String(i).padStart(12, '0')}` }));
    }
    deriveInstanceMemberGuids(world); // records the misses
    const t0 = performance.now();
    deriveInstanceMemberGuids(world);
    expect(performance.now() - t0).toBeLessThan(150);
  });
});
