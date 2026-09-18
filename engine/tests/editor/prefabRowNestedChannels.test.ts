/** #1381 / #1382 — a prefab ROW carries both nested channels (`nestedOverrides`, `nestedStructure`)
 *  for the nested rows inside its own expansion, and every seam that writes or reads a row wires both:
 *
 *  - promotion (Apply to Prefab of a user-added nested instance) copies the reference node's slot;
 *  - both loaders expand a row's `nestedStructure` under the outer layer's (outer wins, whole);
 *  - the scene capture's baseline descends through it (`resolveEffectivePrefabStructure`);
 *  - the prefab editor forwards both, and its save CAPTURES both from the live expansion;
 *  - that save (and Create Prefab) skips every owned nested instance, which used to get a second row
 *    at the prefab root (#1382).
 *
 *  Driven through the real loader, the real editor capture and the real prefab-edit scene builder.
 *  Each case names the mutation that must turn it red. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));
// Apply writes the prefab through postWriteFile — capture it instead of hitting a dev server.
const writes: Array<{ path: string; content: string }> = [];
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string) => {
    writes.push({ path, content });
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  },
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { serializeScene, deleteEntitiesWithUndo, writeTraitFieldWithUndo, clearHistory, setActionCallback, pushAction } from '@modoki/engine/editor';
import {
  setPrefabCache, instantiatePrefab, serializePrefab, applyToPrefabSelective, tagEntityTreeAsInstance, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { buildPrefabEditScene, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const INNER = 'aaaaaaaa-0000-4000-8000-0000000001c1';
const MID = 'aaaaaaaa-0000-4000-8000-0000000001c2';
const OUTER = 'aaaaaaaa-0000-4000-8000-0000000001c3';
const HOLDER = 'bbbbbbbb-0000-4000-8000-0000000001c1';
const ROOT = 'bbbbbbbb-0000-4000-8000-0000000001c2';
const MID_GUID = 'bbbbbbbb-0000-4000-8000-0000000001c3';

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
/** The INNER expanded by MID's row 3 (under Slot), and its Leaf — OUTER's own row 4 holds another pair. */
const innerUnderMid = (): number => getAllEntities().find((e) => e.name === 'InnerRoot' && e.parentId === byName('Slot'))!.id;
const leafUnderMid = (): number => getAllEntities().find((e) => e.name === 'Leaf' && e.parentId === innerUnderMid())!.id;
const rename = (id: number, name: string) => writeTraitFieldWithUndo(id, getTraitByName('EntityAttributes')!, 'name', name);

/** Holder → an OUTER instance; `entry` extends the instance entry. */
const sceneWith = (entry: Record<string, unknown> = {}): SceneData => ({
  id: 'row-nested', version: 14, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
    { id: 2, prefab: OUTER, guid: ROOT, traits: { EntityAttributes: { name: 'OuterRoot', parentId: HOLDER }, Transform: { x: 0, y: 0, z: 0 } }, ...entry },
  ],
} as unknown as SceneData);

const LEAF_UNDER_MID = 'Holder/OuterRoot/Panel/Button/MidRoot/Slot/InnerRoot/Leaf';
const DELETE_LEAF = { '3': { added: [], removed: [2], removedTraits: {} } };

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  writes.length = 0;
  prefabs.clear();
  install(innerDoc);
  install(midDoc);
  install(outerDoc());
});
afterAll(() => { for (const id of [INNER, MID, OUTER]) setPrefabCache(id, null); getCurrentWorld()?.destroy(); });

describe('Apply to Prefab keeps a promoted reference node\'s nestedStructure (#1381)', () => {
  // Mutation: drop `nestedStructure: node.nestedStructure` in `insertAddedSubtree`.
  it('the row written into the prefab carries the node\'s structure, and every instance applies it', async () => {
    await load(sceneWith({ added: [{ parentLocalId: 3, guid: MID_GUID, name: 'MidRoot', prefab: MID, traits: {}, children: [] }] }));
    expect(namePaths()).toContain(LEAF_UNDER_MID); // precondition: the added MID expanded its own INNER row
    deleteEntitiesWithUndo([leafUnderMid()]);
    expect(namePaths()).not.toContain(LEAF_UNDER_MID);

    await applyToPrefabSelective(byName('OuterRoot'), new Set([`+added.${MID_GUID}`]));
    const written = writes.map((w) => JSON.parse(w.content) as PrefabFile).find((p) => p.id === OUTER);
    expect(written).toBeDefined();
    const midRow = written!.entities.find((e) => e.prefab === MID)!;
    expect(midRow.nestedStructure).toEqual(DELETE_LEAF);

    // A fresh instance of the promoted prefab — loader and editor alike — no longer shows the member.
    install(written!);
    await load(sceneWith());
    expect(namePaths()).toContain('Holder/OuterRoot/Panel/Button/MidRoot/Slot/InnerRoot');
    expect(namePaths()).not.toContain(LEAF_UNDER_MID);
  });
});

describe('a prefab row\'s own nestedStructure expands in both loaders (#1381)', () => {
  // Mutation: in `instantiatePrefabIntoWorld`, pass `outerStructForward` instead of the merge.
  it('the scene loader applies it', async () => {
    install(outerDoc({ nestedStructure: DELETE_LEAF }));
    await load(sceneWith());
    expect(namePaths()).toContain('Holder/OuterRoot/Panel/Button/MidRoot/Slot/InnerRoot');
    expect(namePaths()).not.toContain(LEAF_UNDER_MID);
  });

  // Mutation: in the editor `instantiatePrefab`, pass `outerStructForward` instead of the merge.
  it('the editor instantiate applies it', async () => {
    const doc = outerDoc({ nestedStructure: DELETE_LEAF });
    install(doc);
    await load({ id: 'empty', version: 14, name: 'E', resources: [], entities: [] } as unknown as SceneData);
    instantiatePrefab(doc as never);
    expect(namePaths()).toContain('OuterRoot/Panel/Button/MidRoot/Slot/InnerRoot');
    expect(namePaths()).not.toContain('OuterRoot/Panel/Button/MidRoot/Slot/InnerRoot/Leaf');
  });

  // Mutation: remove the path-keyed descend in `resolveEffectivePrefabStructure` (read the row's own
  // lists at every step). The scene's un-delete then equals the stale baseline, is not written, and
  // the member is deleted again on reload.
  it('a scene that UN-deletes the row-deleted member keeps it across save + reload', async () => {
    install(outerDoc({ nestedStructure: DELETE_LEAF }));
    await load(sceneWith({ nestedStructure: { '5.3': { added: [], removed: [], removedTraits: {} } } }));
    expect(namePaths()).toContain(LEAF_UNDER_MID); // outer layer owns the interior, whole
    const saved = await serializeScene() as unknown as { entities: Array<Record<string, unknown>> };
    const entry = saved.entities.find((e) => e.prefab === OUTER)!;
    expect(entry.nestedStructure).toEqual({ '5.3': { added: [], removed: [], removedTraits: {} } });
    await load(saved as unknown as SceneData);
    expect(namePaths()).toContain(LEAF_UNDER_MID);
  });

  // A non-empty baseline means the scene restates the interior it sees (`captureNestedChannels`'
  // documented rule — the same one a row's OWN `removed` list already gets). What must hold is that
  // the restatement is the row's value, so an untouched save + reload changes nothing.
  it('an untouched instance of such a prefab round-trips unchanged', async () => {
    install(outerDoc({ nestedStructure: DELETE_LEAF }));
    await load(sceneWith());
    const saved = await serializeScene() as unknown as { entities: Array<Record<string, unknown>> };
    expect(saved.entities.find((e) => e.prefab === OUTER)!.nestedStructure).toEqual({ '5.3': DELETE_LEAF['3'] });
    await load(saved as unknown as SceneData);
    expect(namePaths()).not.toContain(LEAF_UNDER_MID);
    const again = await serializeScene();
    expect(JSON.stringify(again.entities)).toBe(JSON.stringify(saved.entities));
  });
});

describe('the prefab editor shows and saves a row\'s nested channels (#1381, #1382)', () => {
  const RENAME_LEAF = { '3': { 2: { EntityAttributes: { name: 'Renamed' } } } };
  const openInEditor = async (doc: PrefabFile) => {
    install(doc);
    await load(buildPrefabEditScene(doc) as SceneData);
    const root = getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!;
    expect(root).toBeDefined();
    return root.id;
  };
  const midRowOf = (p: PrefabFile) => p.entities.find((e) => e.prefab === MID)!;

  // Mutation: drop the `nestedOverrides`/`nestedStructure` forward in `buildPrefabEditScene`.
  it('the edit world shows the row\'s nestedOverrides and nestedStructure', async () => {
    await openInEditor(outerDoc({ nestedOverrides: RENAME_LEAF }) as PrefabFile);
    expect(getAllEntities().some((e) => e.name === 'Renamed')).toBe(true);
    await openInEditor(outerDoc({ nestedStructure: DELETE_LEAF }) as PrefabFile);
    expect(getAllEntities().filter((e) => e.name === 'Leaf')).toHaveLength(1); // row 4's only
  });

  // Mutation: in `planPrefabRows`, drop the `captureNestedChannels` call (store no channels).
  it('an untouched save keeps both channels, byte-equal', async () => {
    const doc = outerDoc({ nestedOverrides: RENAME_LEAF, nestedStructure: { '3': { added: [], removed: [], removedTraits: { 1: ['Transform'] } } } }) as PrefabFile;
    const root = await openInEditor(doc);
    const saved = serializePrefab(root, OUTER)!;
    expect(midRowOf(saved).nestedOverrides).toEqual(RENAME_LEAF);
    expect(midRowOf(saved).nestedStructure).toEqual(doc.entities.find((e) => e.prefab === MID)!.nestedStructure);
  });

  // Mutation: replace the capture with a pass-through of the file's value — the edits below go red.
  it('an edit made INSIDE the row\'s nested row is captured, value and structure', async () => {
    const root = await openInEditor(outerDoc({}) as PrefabFile);
    const leaf = leafUnderMid();
    rename(innerUnderMid(), 'InnerRenamed');
    deleteEntitiesWithUndo([leaf]);
    const saved = serializePrefab(root, OUTER)!;
    expect(midRowOf(saved).nestedOverrides).toEqual({ '3': { 1: { EntityAttributes: { name: 'InnerRenamed' } } } });
    expect(midRowOf(saved).nestedStructure).toEqual(DELETE_LEAF);
  });

  // Review finding 1. When MID's own row 3 authors structure, a slot-less MID row in OUTER sees a
  // non-empty baseline. The scene rule ("restate when non-empty") would pin MID's structure into
  // OUTER on a no-op save, and a later MID edit would stop reaching OUTER. Mutation: pass
  // `omitUnchanged: false` (or drop it) at the `planPrefabRows` call.
  it('a no-op save does not pin the inner prefab\'s own structure into the row', async () => {
    install({ ...midDoc, entities: [...midDoc.entities.slice(0, 2), row(3, 'MidNested', 2, { prefab: INNER, removed: [2] })] } as PrefabFile);
    const root = await openInEditor(outerDoc({}) as PrefabFile);
    expect(getAllEntities().filter((e) => e.name === 'Leaf')).toHaveLength(1); // precondition: MID removed its own Leaf
    expect(midRowOf(serializePrefab(root, OUTER)!).nestedStructure).toBeUndefined();
    // …while a real edit against that baseline is still captured.
    const { spawnEntity, Transform, EntityAttributes } = await import('@modoki/engine/runtime');
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Extra', parentId: innerUnderMid() }));
    const edited = midRowOf(serializePrefab(root, OUTER)!).nestedStructure as Record<string, { added: Array<{ name: string }>; removed: number[] }>;
    expect(edited['3']!.removed).toEqual([2]);
    expect(edited['3']!.added.map((n) => n.name)).toEqual(['Extra']);
  });

  // Re-review findings 1 and 2: the row writer's equality is over CONTENT, not the shape a writer
  // happened to use — a hand-ordered `added` and a legacy full (pre-compaction) trait bag are both
  // an untouched interior. Mutations: in `sameStructure`, drop the sort in `asSet` (1); drop the
  // `compactAddedTraitData` pass over file bags (2).
  it.each([
    ['an `added` list authored out of capture order', [
      { parentLocalId: 2, guid: '', name: 'B', traits: { EntityAttributes: { name: 'B' }, Transform: { x: 2 } }, children: [] },
      { parentLocalId: 1, guid: '', name: 'A', traits: { EntityAttributes: { name: 'A' }, Transform: { x: 1 } }, children: [] },
    ]],
    ['a legacy FULL trait bag', [
      { parentLocalId: 1, guid: '', name: 'Extra', children: [],
        traits: { EntityAttributes: { name: 'Extra', parentId: 0, guid: '' }, Transform: { x: 1, y: 0, z: 0 } } },
    ]],
  ])('a no-op save does not pin the inner prefab\'s row-authored %s', async (_label, added) => {
    install({ ...midDoc, entities: [...midDoc.entities.slice(0, 2), row(3, 'MidNested', 2, { prefab: INNER, added })] } as PrefabFile);
    const root = await openInEditor(outerDoc({}) as PrefabFile);
    for (const n of added) expect(getAllEntities().some((e) => e.name === n.name)).toBe(true); // precondition: expanded
    expect(midRowOf(serializePrefab(root, OUTER)!).nestedStructure).toBeUndefined();
  });

  // Re-review finding 3. Mutation: count every non-root entity of the lost subtree as `extra`.
  it('an uncached inner prefab with nested rows of its own, and nothing added, warns about nothing', async () => {
    const DEEP = 'aaaaaaaa-0000-4000-8000-0000000001c4';
    install({ id: DEEP, version: 3, name: 'Deep', rootLocalId: 1, entities: [row(1, 'DeepRoot', 0), row(2, 'DeepLeaf', 1)] } as PrefabFile);
    install({ ...innerDoc, entities: [...innerDoc.entities, row(3, 'DeepRow', 1, { prefab: DEEP })] } as PrefabFile);
    const root = await openInEditor(outerDoc({}) as PrefabFile);
    setPrefabCache(INNER, null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serializePrefab(root, OUTER);
    expect(warn.mock.calls.filter(([m]) => /added inside it not captured/.test(String(m)))).toEqual([]);
    warn.mockRestore();
  });

  // Review finding 2. Uncached, the owned instance still re-expands from the MID row, so neither it
  // nor anything under it may become a row — the loss is reported instead. Mutation: in
  // `captureNestedChannels`' uncached branch, `continue` without adding the subtree.
  it('with the inner prefab uncached, nothing inside the owned instance falls out as a root row', async () => {
    const root = await openInEditor(outerDoc({}) as PrefabFile);
    const { spawnEntity, Transform, EntityAttributes } = await import('@modoki/engine/runtime');
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'X', parentId: leafUnderMid() }));
    setPrefabCache(INNER, null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = serializePrefab(root, OUTER)!;
    const parentOf = (e: PrefabFile['entities'][number]) => (e.traits.EntityAttributes as { parentId: number }).parentId;
    expect(saved.entities.filter((e) => parentOf(e) === 0).map((e) => e.name)).toEqual(['OuterRoot']);
    expect(saved.entities.map((e) => e.name)).not.toContain('X');
    expect(warn.mock.calls.some(([m]) => /1 entity added inside it not captured/.test(String(m)))).toBe(true);
    warn.mockRestore();
  });

  // #1382. Mutation: drop the `ownedMemberEcsIds` skip in `planPrefabRows`.
  it('an owned nested instance inside a row gets no row of its own', async () => {
    const root = await openInEditor(outerDoc({}) as PrefabFile);
    const saved = serializePrefab(root, OUTER)!;
    // OUTER's own row 4 is the one INNER row; MID's row-3 INNER re-expands from the MID row.
    expect(saved.entities.filter((e) => e.prefab === INNER)).toHaveLength(1);
    expect(saved.entities.map((e) => e.name)).not.toContain('Leaf');
  });
});

describe('Create Prefab over a held instance writes its owned nested instance once (#1382)', () => {
  // Mutation: drop the `ownedMemberEcsIds` skip in `planPrefabRows`.
  it('no second row for OUTER\'s owned INNER, and the tag leaves its row stamp alone', async () => {
    await load(sceneWith());
    const holder = byName('Holder');
    const created = serializePrefab(holder)!;
    expect(created.entities.filter((e) => e.prefab === OUTER)).toHaveLength(1);
    expect(created.entities.filter((e) => e.prefab === INNER)).toHaveLength(0);
    expect(created.entities.map((e) => e.name)).toEqual(['Holder', 'OuterRoot']);

    tagEntityTreeAsInstance(holder, 'cccccccc-0000-4000-8000-0000000001c1', created);
    const piMeta = getTraitByName('PrefabInstance')!;
    const innerRoot = [...getCurrentWorld().entities].find((e) => e.id() === getAllEntities().find((x) => x.name === 'InnerRoot')!.id)!;
    expect((innerRoot.get(piMeta.trait) as { parentLocalId: number }).parentLocalId).toBe(4);
  });
});
