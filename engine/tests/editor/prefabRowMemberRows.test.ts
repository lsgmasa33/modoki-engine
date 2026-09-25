/** #1533 — a prefab nested ROW states its nested frames' structure per member and per node (`members`, prefab v6),
 *  not whole (`nestedStructure`), so an outer prefab that changes ONE thing inside a nested frame no longer restates —
 *  and pins — what the inner prefabs put there.
 *
 *  OUTER holds a MID row; MID's own row 3 expands INNER. Every case: MID authors something in that INNER frame,
 *  OUTER edits something else there in the prefab editor and saves, then MID changes what it authored — and OUTER must
 *  follow. Before #1533 the save wrote the frame's whole lists and OUTER kept MID's old statement forever.
 *
 *  Driven through the real prefab-edit scene builder, the real save, and both loaders. Each case names the mutation
 *  that turns it red. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setRunMode as setRunModeForAuthoring } from '../../packages/modoki/src/runtime/core/playState';
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
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, loadSceneFile, instantiatePrefabIntoWorld,
  destroyEntity, collectResourceRefsFromEntities, spawnEntity, Transform, EntityAttributes, type SceneData,
} from '@modoki/engine/runtime';
import { serializeScene, deleteEntitiesWithUndo, writeTraitFieldWithUndo, setActionCallback, pushAction } from '@modoki/engine/editor';
import { setPrefabCache, instantiatePrefab, serializePrefab, applyToPrefabSelective, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { buildPrefabEditScene, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { removeTraitFromEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { templateKeysOf } from '../../packages/modoki/src/runtime/loaders/templateKeyRecovery';
import { derivedMemberPaths } from '../../packages/modoki/src/runtime/loaders/memberPaths';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const INNER = 'aaaaaaaa-0000-4000-8000-000000001533';
const MID = 'aaaaaaaa-0000-4000-8000-000000011533';
const OUTER = 'aaaaaaaa-0000-4000-8000-000000021533';
const HOLDER = 'bbbbbbbb-0000-4000-8000-000000001533';
const ROOT = 'bbbbbbbb-0000-4000-8000-000000011533';
// Minted row identities (prefab v5) — what makes a frame keyable at all.
const G = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const G_LEAF = G(2);
const G_MID_NESTED = G(13);
const G_OUTER_MID = G(25);
const K1 = 'dddddddd-0000-4000-8000-000000000001';
const K2 = 'dddddddd-0000-4000-8000-000000000002';

const row = (localId: number, nodeGuid: string, name: string, parentId: number, extra: Record<string, unknown> = {}, traits: Record<string, unknown> = {}) => ({
  localId, nodeGuid, name, ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 }, ...traits },
});
const innerDoc = { id: INNER, version: 5, name: 'Inner', rootLocalId: 1, entities: [
  row(1, G(1), 'InnerRoot', 0),
  row(2, G_LEAF, 'Leaf', 1, {}, { UIAction: {}, UIFocusable: {} }),
] };
/** MID, its row 3 expanding INNER and carrying `rowExtra` — what MID authors in that INNER frame. */
const midDoc = (rowExtra: Record<string, unknown> = {}) => ({ id: MID, version: 5, name: 'Mid', rootLocalId: 1, entities: [
  row(1, G(11), 'MidRoot', 0), row(2, G(12), 'Slot', 1), row(3, G_MID_NESTED, 'MidNested', 2, { prefab: INNER, ...rowExtra }),
] });
const outerDoc = (midRow: Record<string, unknown> = {}) => ({ id: OUTER, version: 5, name: 'Outer', rootLocalId: 1, entities: [
  row(1, G(21), 'OuterRoot', 0), row(2, G(22), 'Panel', 1), row(5, G_OUTER_MID, 'MidRoot', 2, { prefab: MID, ...midRow }),
] });
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

const openInEditor = async (doc: PrefabFile): Promise<number> => {
  install(doc);
  await load(buildPrefabEditScene(doc) as SceneData);
  const root = getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!;
  expect(root).toBeDefined();
  return root.id;
};
/** A scene holding one OUTER instance. */
const sceneWith = (entry: Record<string, unknown> = {}): SceneData => ({
  id: 's1533', version: 17, name: 'S', resources: [],
  entities: [
    { id: 1, name: 'Holder', traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER }, Transform: {} } },
    { id: 2, name: 'OuterRoot', prefab: OUTER, guid: ROOT, traits: { EntityAttributes: { name: 'OuterRoot', parentId: HOLDER, guid: ROOT } }, ...entry },
  ],
} as unknown as SceneData);

const innerRoot = (): number => getAllEntities().find((e) => e.name === 'InnerRoot')!.id;
const named = (name: string) => getAllEntities().filter((e) => e.name === name);
const midRowOf = (p: PrefabFile) => p.entities.find((e) => e.prefab === MID)!;
const traitOf = (id: number, t: string) => {
  const meta = getTraitByName(t)!;
  for (const e of getCurrentWorld().entities) if (e.id() === id) return e.has(meta.trait) ? e.get(meta.trait) as Record<string, unknown> : undefined;
  return undefined;
};
/** OUTER's edit: one plain node added under INNER's root — a change that says nothing about Leaf. */
const addExtra = () => spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Extra', parentId: innerRoot() }));

/** Every place OUTER is expanded — the edit world (scene loader), a scene holding OUTER (runtime loader), and the
 *  editor's fresh drop (`instantiatePrefab`) — so a case asserts the same thing through all three spawners. */
async function eachExpansion(outer: PrefabFile, check: (where: string) => void): Promise<void> {
  await openInEditor(outer);
  check('prefab edit world');
  install(outer);
  await load(sceneWith());
  check('scene');
  await load({ id: 'empty', version: 17, name: 'E', resources: [], entities: [] } as unknown as SceneData);
  instantiatePrefab(outer as never);
  check('editor instantiate');
}

beforeEach(() => {
  prefabs.clear();
  install(innerDoc);
  clearKeptMemberOrphans();
});

// The editor authors in 'stopped'; the runtime DEFAULT is 'playing' (a shipped game boots playing), and
// every writer of the live world refuses outside an authored world (#1548) — so the premise is stated.
beforeEach(() => { setRunModeForAuthoring('stopped'); });

describe('an outer prefab\'s edit in a nested frame does not pin what the inner prefab put there (#1533)', () => {
  // The case #1533 was observed with. Mutation: in `planPrefabRows`, skip `moveChannelsOntoRows` (keep the whole
  // slot) — the save restates `removed: [2]` and Leaf stays gone after MID restores it.
  it('removed: MID restoring a member it removed reaches OUTER', async () => {
    install(midDoc({ removed: [2] }));
    const root = await openInEditor(outerDoc() as PrefabFile);
    expect(named('Leaf')).toHaveLength(0); // precondition: MID removed Leaf
    addExtra();
    const saved = serializePrefab(root, OUTER)!;
    expect(midRowOf(saved).nestedStructure).toBeUndefined();
    expect(Object.values(midRowOf(saved).members ?? {}).some((r) => r.removed !== undefined)).toBe(false);
    install(midDoc());
    await eachExpansion(saved, (where) => {
      expect(named('Leaf'), where).toHaveLength(1);
      expect(named('Extra'), where).toHaveLength(1);
    });
  });

  // Mutation: in `diffFrameAdded`'s caller, restate the whole list (`nodes.whole` for every anchor) — n2's later
  // change never reaches OUTER.
  it('added: MID changing a node it added reaches OUTER, and so does a field of the node OUTER edited', async () => {
    const n = (key: string, name: string, x: number) => ({ parentLocalId: 1, guid: '', key, name, traits: { EntityAttributes: { name }, Transform: { x } }, children: [] });
    install(midDoc({ added: [n(K1, 'N1', 1), n(K2, 'N2', 2)] }));
    const root = await openInEditor(outerDoc() as PrefabFile);
    writeTraitFieldWithUndo(named('N1')[0]!.id, getTraitByName('Transform')!, 'y', 5);
    const saved = serializePrefab(root, OUTER)!;
    expect(midRowOf(saved).nestedStructure).toBeUndefined();
    expect(midRowOf(saved).members).toEqual({ [`/${G_MID_NESTED}/a+${K1}`]: { traits: { Transform: { y: 5 } } } });
    install(midDoc({ added: [n(K1, 'N1', 9), n(K2, 'N2', 7)] }));
    await eachExpansion(saved, (where) => {
      expect(traitOf(named('N2')[0]!.id, 'Transform'), where).toMatchObject({ x: 7 });
      expect(traitOf(named('N1')[0]!.id, 'Transform'), where).toMatchObject({ x: 9, y: 5 });
    });
  });

  // Mutation: in `moveChannelsOntoRows`, write `removedTraits` (the whole list) instead of `traitRemovals`.
  it('removedTraits: MID restoring a trait it removed reaches OUTER, and OUTER\'s own removal holds', async () => {
    install(midDoc({ removedTraits: { 2: ['UIAction'] } }));
    const root = await openInEditor(outerDoc() as PrefabFile);
    const leaf = named('Leaf')[0]!.id;
    expect(traitOf(leaf, 'UIAction')).toBeUndefined(); // precondition
    removeTraitFromEntitiesWithUndo([leaf], getTraitByName('UIFocusable')!);
    const saved = serializePrefab(root, OUTER)!;
    expect(midRowOf(saved).nestedStructure).toBeUndefined();
    expect(midRowOf(saved).members).toEqual({ [`/${G_MID_NESTED}/${G_LEAF}`]: { traitRemovals: { UIFocusable: true } } });
    install(midDoc());
    await eachExpansion(saved, (where) => {
      const l = named('Leaf')[0]!.id;
      expect(traitOf(l, 'UIAction'), where).toBeDefined();
      expect(traitOf(l, 'UIFocusable'), where).toBeUndefined();
    });
  });

  // Mutation: in `moveChannelsOntoRows`, drop the "only what differs" test for `removed` (touch every lid).
  it('an untouched save writes neither members nor a slot', async () => {
    install(midDoc({ removed: [2] }));
    const root = await openInEditor(outerDoc() as PrefabFile);
    const saved = midRowOf(serializePrefab(root, OUTER)!);
    expect(saved.members).toBeUndefined();
    expect(saved.nestedStructure).toBeUndefined();
  });

  // Mutation: drop the `members` forward in `buildPrefabEditScene` — the edit world shows Leaf again, and the re-save
  // loses the row.
  it('an OUTER deletion inside the frame round-trips as a row, and reads back in every spawner', async () => {
    install(midDoc());
    const root = await openInEditor(outerDoc() as PrefabFile);
    deleteEntitiesWithUndo([named('Leaf')[0]!.id]);
    const saved = serializePrefab(root, OUTER)!;
    expect(midRowOf(saved).members).toEqual({ [`/${G_MID_NESTED}/${G_LEAF}`]: { removed: true } });
    await eachExpansion(saved, (where) => expect(named('Leaf'), where).toHaveLength(0));
    // …and a re-save of the untouched result restates the row, nothing more.
    const again = serializePrefab(await openInEditor(saved), OUTER)!;
    expect(midRowOf(again).members).toEqual(midRowOf(saved).members);
  });
});

describe('a scene over a prefab row\'s rows (#1533)', () => {
  // Mutation: in `resolveEffectivePrefabStructure`, fold no row layer (`foldStructureLayers` → base) — the scene's
  // baseline misses OUTER's deletion, and an untouched scene restates it.
  it('an untouched scene instance states nothing of the row\'s rows', async () => {
    install(midDoc());
    install(outerDoc({ members: { [`/${G_MID_NESTED}/${G_LEAF}`]: { removed: true } } }));
    await load(sceneWith());
    expect(named('Leaf')).toHaveLength(0);
    const entry = (await serializeScene()).entities.find((e) => (e as { prefab?: string }).prefab === OUTER) as unknown as Record<string, unknown>;
    // A scene row always states its member's identity (`guid`, `name`, v16); nothing structural may ride with it.
    const rows = Object.values((entry.members ?? {}) as Record<string, Record<string, unknown>>);
    expect(rows.flatMap((r) => Object.keys(r).filter((k) => k !== 'guid' && k !== 'name'))).toEqual([]);
    expect(entry.nestedStructure).toBeUndefined();
  });

  // The scene's un-delete is a row in the OUTER layer, folded after the prefab row's. Mutation: fold the layers
  // outer-first in `foldStructureLayers`.
  it('a scene row un-deleting what the prefab row deleted wins', async () => {
    install(midDoc());
    install(outerDoc({ members: { [`/${G_MID_NESTED}/${G_LEAF}`]: { removed: true } } }));
    await load(sceneWith({ members: { [`/${G_OUTER_MID}/${G_MID_NESTED}/${G_LEAF}`]: { removed: false } } }));
    expect(named('Leaf')).toHaveLength(1);
  });

  // A legacy scene SLOT owns the frame whole, and it was captured from an interior that already showed the prefab
  // row's rows — so they must not fold again over it. Mutation: in `descendStructureLayers`, leave `foldFrom` at 0.
  it('a scene slot addressing the frame replaces the row\'s rows there', async () => {
    install(midDoc());
    install(outerDoc({ members: { [`/${G_MID_NESTED}/${G_LEAF}`]: { removed: true } } }));
    await load(sceneWith({ nestedStructure: { '5.3': { added: [], removed: [], removedTraits: {} } } }));
    expect(named('Leaf')).toHaveLength(1);
  });
});

describe('a prefab row\'s member rows carry refs to the resource walkers (#1533)', () => {
  // `SceneManager` collects a cached prefab's refs with this walker. Mutation: drop the `members` walk in
  // `collectResourceRefsFromEntities`.
  it('the runtime collector sees a ref held only by a row node', () => {
    const TEX = 'eeeeeeee-0000-4000-8000-000000001533';
    const doc = outerDoc({ members: { [`/${G_MID_NESTED}/${G_LEAF}`]: {
      own: [{ parentLocalId: 0, guid: '', key: K1, name: 'Pic', traits: { EntityAttributes: { name: 'Pic' }, Renderable3D: { mesh: TEX } }, children: [] }],
    } } });
    const refs = collectResourceRefsFromEntities(doc.entities as never) as Array<{ guid?: string; path?: string }>;
    expect(JSON.stringify(refs)).toContain(TEX);
  });
});

describe('the document walks read a prefab row\'s member rows (#1533)', () => {
  const ownNode = { parentLocalId: 0, guid: '', key: K1, name: 'Own', traits: { EntityAttributes: { name: 'Own' } }, children: [] };
  const withOwn = () => outerDoc({ members: { [`/${G_MID_NESTED}/${G_LEAF}`]: { own: [ownNode] } } });

  // The key heal's candidates: a node only a row adds must be recoverable too. Mutation: drop the `members` loop in
  // `templateKeysOf`.
  it('templateKeysOf declares a key only a row node carries', () => {
    expect(templateKeysOf(withOwn() as never)).toContain(K1);
  });

  // The file-level member-path walk (ref remaps follow a moved member through it). Mutation: in `memberPaths`' nested
  // row, descend the outer rows only (drop `unionRows`' inner side).
  it('derivedMemberPaths names a node only a row adds', () => {
    install(midDoc());
    install(withOwn());
    const paths = derivedMemberPaths({ prefab: OUTER, guid: ROOT }, (g) => prefabs.get(g));
    expect(paths.some((p) => p.includes(`+${K1}`))).toBe(true);
  });
});

describe('#1533 close-out review', () => {
  const extraNode = (key: string, name = 'Extra') => ({ parentLocalId: 0, guid: '', key, name, traits: { EntityAttributes: { name }, Transform: { x: 0 } }, children: [] });
  const SLOT_OVER_MID = { added: [], removed: [], removedTraits: {} };

  // F1. A slot owns ONE frame: a nested root's row inside it (`/<row>` with `own`) states that root's INTERIOR, the
  // frame below, which the slot does not own. Mutation: in `foldStructureLayers`, `continue` for `i < foldFrom`
  // without computing the layer's `forwardRoot`.
  it('a prefab row\'s nested-root row survives an outer slot over the frame above it (runtime loader)', async () => {
    install(midDoc());
    install(outerDoc({ members: { [`/${G_MID_NESTED}`]: { own: [extraNode(K1)] } } }));
    await load(sceneWith({ nestedStructure: { '5': SLOT_OVER_MID } }));
    expect(named('Extra')).toHaveLength(1);
  });

  it('…and through the editor spawner, under a row slot of an enclosing prefab', async () => {
    const OUTER2 = 'aaaaaaaa-0000-4000-8000-000000031533';
    install(midDoc());
    install(outerDoc({ members: { [`/${G_MID_NESTED}`]: { own: [extraNode(K1)] } } }));
    const outer2 = { id: OUTER2, version: 6, name: 'Outer2', rootLocalId: 1, entities: [
      row(1, G(31), 'O2Root', 0), row(2, G(32), 'OuterRow', 1, { prefab: OUTER, nestedStructure: { '5': SLOT_OVER_MID } }),
    ] };
    install(outer2);
    await load({ id: 'empty', version: 17, name: 'E', resources: [], entities: [] } as unknown as SceneData);
    instantiatePrefab(outer2 as never);
    expect(named('Extra')).toHaveLength(1);
  });

  // F3 — R2 for this carrier. Mutation: drop the kept-orphan merge in `captureRowChannels`.
  it('an orphan node row on a prefab row survives an untouched prefab-edit save, and comes back with its node', async () => {
    const n = (key: string, name: string, x: number) => ({ parentLocalId: 1, guid: '', key, name, traits: { EntityAttributes: { name }, Transform: { x } }, children: [] });
    install(midDoc({ added: [n(K2, 'N2', 2)] })); // MID dropped K1
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = serializePrefab(await openInEditor(outerDoc({ members: { [`/${G_MID_NESTED}/a+${K1}`]: { traits: { Transform: { y: 5 } } } } }) as PrefabFile), OUTER)!;
    warn.mockRestore();
    install(midDoc({ added: [n(K1, 'N1', 1), n(K2, 'N2', 2)] })); // MID brings K1 back
    install(saved);
    await load(sceneWith());
    expect(traitOf(named('N1')[0]!.id, 'Transform')).toMatchObject({ y: 5 });
  });

  // F2 — Apply's promotion is the second writer of a prefab row, and copied the reference node's whole scene-form
  // slot. Mutation: skip the `captureRowChannels` re-capture after `insertAddedSubtree` in `applyToPrefabSelective`.
  it('promoting a reference node does not pin what the inner prefab added in its nested frame', async () => {
    const MID_GUID = 'bbbbbbbb-0000-4000-8000-000000021533';
    const HOST = 'aaaaaaaa-0000-4000-8000-000000061533';
    const hostDoc = { id: HOST, version: 6, name: 'Host', rootLocalId: 1, entities: [row(1, G(51), 'HostRoot', 0), row(2, G(52), 'HPanel', 1)] };
    const nNode = (x: number) => ({ parentLocalId: 1, guid: '', key: K1, name: 'N1', traits: { EntityAttributes: { name: 'N1' }, Transform: { x } }, children: [] });
    const hostScene = (entry: Record<string, unknown> = {}): SceneData => ({
      id: 'sh', version: 17, name: 'S', resources: [],
      entities: [
        { id: 1, name: 'Holder', traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER }, Transform: {} } },
        { id: 2, name: 'HostRoot', prefab: HOST, guid: ROOT, traits: { EntityAttributes: { name: 'HostRoot', parentId: HOLDER, guid: ROOT } }, ...entry },
      ],
    } as unknown as SceneData);
    install(midDoc({ added: [nNode(1)] }));
    install(hostDoc);
    await load(hostScene({ added: [{ parentLocalId: 2, guid: MID_GUID, name: 'MidRoot', prefab: MID, traits: {}, children: [] }] }));
    deleteEntitiesWithUndo([named('Leaf')[0]!.id]);
    writes.length = 0;
    await applyToPrefabSelective(getAllEntities().find((e) => e.name === 'HostRoot')!.id, new Set([`+added.${MID_GUID}`]));
    const written = writes.map((w) => JSON.parse(w.content) as PrefabFile).find((p) => p.id === HOST)!;
    install(midDoc({ added: [nNode(9)] })); // MID moves its node
    install(written);
    await load(hostScene());
    expect(named('Leaf')).toHaveLength(0); // the scene's deletion was applied…
    expect(traitOf(named('N1')[0]!.id, 'Transform')).toMatchObject({ x: 9 }); // …and MID's node still follows MID
  });

  // Re-review: R2's re-emit is for a TEMPLATE's own kept rows only. Under a scene root the kept rows are scene rows —
  // member guids and scene-guid nodes — and in a template every instance would spawn them with one guid (#1293).
  // Mutation: drop the `isPrefabEditRowGuid` gate in `captureRowChannels`.
  const SCENE_G = 'ffffffff-0000-4000-8000-000000000001';
  const NODE_G = 'ffffffff-0000-4000-8000-000000000002';
  const GONE = G(99);
  it('Create Prefab over a scene instance does not carry the scene\'s kept orphan rows into the template', async () => {
    install(midDoc());
    install(outerDoc());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await load(sceneWith({ members: { [`/${GONE}`]: { guid: SCENE_G, name: 'Gone' } } }));
    warn.mockRestore();
    const created = serializePrefab(getAllEntities().find((e) => e.name === 'Holder')!.id)!;
    expect(JSON.stringify(created.entities.find((e) => e.prefab === OUTER)!.members ?? {})).not.toContain(SCENE_G);
  });

  it('Apply\'s promotion does not carry a reference node\'s kept orphan rows into the template', async () => {
    const MID_GUID = 'bbbbbbbb-0000-4000-8000-000000021533';
    const HOST = 'aaaaaaaa-0000-4000-8000-000000061533';
    install(midDoc());
    install({ id: HOST, version: 6, name: 'Host', rootLocalId: 1, entities: [row(1, G(51), 'HostRoot', 0), row(2, G(52), 'HPanel', 1)] } as never);
    const ownNode = { parentLocalId: 0, guid: NODE_G, name: 'SceneOwn', traits: { EntityAttributes: { name: 'SceneOwn', guid: NODE_G }, Transform: { x: 3 } }, children: [] };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await load({ id: 'sh', version: 17, name: 'S', resources: [], entities: [
      { id: 1, name: 'Holder', traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER }, Transform: {} } },
      { id: 2, name: 'HostRoot', prefab: HOST, guid: ROOT, traits: { EntityAttributes: { name: 'HostRoot', parentId: HOLDER, guid: ROOT } },
        added: [{ parentLocalId: 2, guid: MID_GUID, name: 'MidRoot', prefab: MID, traits: {}, children: [],
          members: { [`/${GONE}`]: { guid: SCENE_G, name: 'Gone', own: [ownNode] } } }] },
    ] } as unknown as SceneData);
    warn.mockRestore();
    writes.length = 0;
    await applyToPrefabSelective(getAllEntities().find((e) => e.name === 'HostRoot')!.id, new Set([`+added.${MID_GUID}`]));
    const written = writes.map((w) => JSON.parse(w.content) as PrefabFile).find((p) => p.id === HOST)!;
    const rows = JSON.stringify(written.entities.find((e) => e.prefab === MID)!.members ?? {});
    expect(rows).not.toContain(SCENE_G);
    expect(rows).not.toContain(NODE_G);
  });
});
