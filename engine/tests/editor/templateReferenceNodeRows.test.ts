/** #1538 — a REFERENCE node a prefab TEMPLATE authors (an `added` node carrying `prefab`) is written by the row
 *  writer: its nested frames per member and omitted when unchanged, its payload tokenized in its own frame. It used to
 *  keep the scene's rule, so an untouched save restated — and pinned — what the inner prefab put there, and a member
 *  ref inside it kept the edit world's live guid.
 *
 *  OUTER2 holds an INNER row whose `added` has a reference node → MID; MID's own row 3 expands INNER. Driven through
 *  the real prefab-edit scene builder, the real saves and both loaders. Each case names the mutation that turns it red. */

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
  destroyEntity, spawnEntity, Transform, EntityAttributes, type SceneData,
} from '@modoki/engine/runtime';
import { serializeScene, deleteEntitiesWithUndo, writeTraitFieldWithUndo, setActionCallback, pushAction } from '@modoki/engine/editor';
import {
  setPrefabCache, instantiatePrefab, instantiatePrefabAsync, setPrefabSource, serializePrefab, applyToPrefabSelective, ownInstanceStructure,
  rebaseStaleInstances, revertOverridesSelective, rebuildInstance, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { buildPrefabEditScene, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { collectInstanceOverrideFields, collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { rewritePrefabMemberTokens } from '../../packages/modoki/src/runtime/loaders/memberPaths';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { undo } from '../../packages/modoki/src/editor/undo/undoManager';
import { templateKeysOf } from '../../packages/modoki/src/runtime/loaders/templateKeyRecovery';
import { clearKeptMemberOrphans, deriveInstanceMemberGuids, keptMemberOrphans, setKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { templateKeyOf, TemplateAddedKey } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { reparentEntity } from '../../packages/modoki/src/editor/undo/entityActions';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const INNER = 'aaaaaaaa-0000-4000-8000-000000001538';
const MID = 'aaaaaaaa-0000-4000-8000-000000011538';
const OUTER2 = 'aaaaaaaa-0000-4000-8000-000000021538';
const HOST = 'aaaaaaaa-0000-4000-8000-000000031538';
const HOLDER = 'bbbbbbbb-0000-4000-8000-000000001538';
const ROOT = 'bbbbbbbb-0000-4000-8000-000000011538';
const G = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const G_LEAF = G(2);
const G_MID_NESTED = G(13);
const K1 = 'dddddddd-0000-4000-8000-000000001538';
const KREF = 'dddddddd-0000-4000-8000-000000011538';

const row = (localId: number, nodeGuid: string, name: string, parentId: number, extra: Record<string, unknown> = {}, traits: Record<string, unknown> = {}) => ({
  localId, nodeGuid, name, ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 }, ...traits },
});
const innerDoc = { id: INNER, version: 5, name: 'Inner', rootLocalId: 1, entities: [
  row(1, G(1), 'InnerRoot', 0),
  row(2, G_LEAF, 'Leaf', 1, {}, { UIAction: {}, UIFocusable: {} }),
] };
/** MID, its row 3 expanding INNER and carrying `rowExtra` — what MID authors in that INNER frame. */
const midDoc = (rowExtra: Record<string, unknown> = {}) => ({ id: MID, version: 6, name: 'Mid', rootLocalId: 1, entities: [
  row(1, G(11), 'MidRoot', 0), row(2, G(12), 'Slot', 1), row(3, G_MID_NESTED, 'MidNested', 2, { prefab: INNER, ...rowExtra }),
] });
/** The reference node → MID that OUTER2's INNER row adds under INNER's root. */
const refNode = (extra: Record<string, unknown> = {}) => ({ parentLocalId: 1, key: KREF, guid: '', name: 'MidRoot', prefab: MID, traits: {}, children: [], ...extra });
const outer2 = (nodeExtra: Record<string, unknown> = {}) => ({ id: OUTER2, version: 6, name: 'Outer2', rootLocalId: 1, entities: [
  row(1, G(21), 'OuterRoot', 0), row(2, G(22), 'Panel', 1), row(5, G(25), 'InnerRow', 2, { prefab: INNER, added: [refNode(nodeExtra)] }),
] }) as unknown as PrefabFile;
const install = (doc: object) => { const id = (doc as { id: string }).id; prefabs.set(id, doc); setPrefabCache(id, doc as never); };

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
/** A scene holding one instance of `prefab`. */
const sceneWith = (prefab: string, rootName: string, entry: Record<string, unknown> = {}): SceneData => ({
  id: 's1538', version: 17, name: 'S', resources: [],
  entities: [
    { id: 1, name: 'Holder', traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER }, Transform: {} } },
    { id: 2, name: rootName, prefab, guid: ROOT, traits: { EntityAttributes: { name: rootName, parentId: HOLDER, guid: ROOT } }, ...entry },
  ],
} as unknown as SceneData);
const emptyScene = { id: 'empty', version: 17, name: 'E', resources: [], entities: [] } as unknown as SceneData;

const all = () => getAllEntities();
const parentOf = (id: number) => all().find((e) => e.id === id)?.parentId ?? 0;
const nameOf = (id: number) => all().find((e) => e.id === id)?.name;
/** Is `id` somewhere below an entity called `name`? */
const under = (id: number, name: string): boolean => { for (let p = parentOf(id); p; p = parentOf(p)) if (nameOf(p) === name) return true; return false; };
/** The entities called `name` inside the MID reference node — not the INNER row's own. */
const inMid = (name: string) => all().filter((e) => e.name === name && under(e.id, 'MidRoot'));
const traitOf = (id: number, t: string) => {
  const meta = getTraitByName(t)!;
  for (const e of getCurrentWorld().entities) if (e.id() === id) return e.has(meta.trait) ? e.get(meta.trait) as Record<string, unknown> : undefined;
  return undefined;
};
const entityOf = (id: number) => { for (const e of getCurrentWorld().entities) if (e.id() === id) return e; return undefined; };
/** The reference node OUTER2's INNER row carries in a saved file. */
const refNodeOf = (p: PrefabFile) => (p.entities.find((e) => e.prefab === INNER)!.added ?? []).find((n) => n.prefab === MID)!;

/** Every place OUTER2 is expanded — the edit world (scene loader), a scene holding OUTER2 (runtime loader), and the
 *  editor's fresh drop (`instantiatePrefab`, the editor's own reference-node spawn). */
async function eachExpansion(outer: PrefabFile, check: (where: string) => void): Promise<void> {
  await openInEditor(outer);
  check('prefab edit world');
  install(outer);
  await load(sceneWith(OUTER2, 'OuterRoot'));
  check('scene');
  await load(emptyScene);
  instantiatePrefab(outer as never);
  deriveInstanceMemberGuids(getCurrentWorld());
  check('editor instantiate');
}

beforeEach(() => {
  prefabs.clear();
  writes.length = 0;
  install(innerDoc);
  clearKeptMemberOrphans();
});

// The editor authors in 'stopped'; the runtime DEFAULT is 'playing' (a shipped game boots playing), and
// every writer of the live world refuses outside an authored world (#1548) — so the premise is stated.
beforeEach(() => { setRunModeForAuthoring('stopped'); });

describe('a template reference node does not pin what its inner prefab put there (#1538)', () => {
  // The case #1538 was observed with. Mutation: in `captureNestedRef`, skip the template branch (the scene rule).
  it('an untouched save writes neither a slot nor rows, and MID restoring Leaf reaches OUTER2', async () => {
    install(midDoc({ removed: [2] }));
    const root = await openInEditor(outer2());
    expect(inMid('Leaf')).toHaveLength(0); // precondition: MID removed it
    const saved = serializePrefab(root, OUTER2)!;
    expect(refNodeOf(saved).nestedStructure).toBeUndefined();
    expect(refNodeOf(saved).members).toBeUndefined();
    install(midDoc());
    await eachExpansion(saved, (where) => expect(inMid('Leaf'), where).toHaveLength(1));
  });

  // Mutation: in `finishTemplateReferenceNode`, write `rc.channels.nestedStructure` (the whole frame) and no members.
  it('an OUTER2 edit inside the frame is a row, and does not restate MID\'s removal', async () => {
    install(midDoc({ removed: [2] }));
    const root = await openInEditor(outer2());
    const innerRoot = inMid('InnerRoot')[0]!.id;
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Extra', parentId: innerRoot }));
    const saved = serializePrefab(root, OUTER2)!;
    const node = refNodeOf(saved);
    expect(node.nestedStructure).toBeUndefined();
    const rows = Object.values(node.members ?? {});
    expect(rows.some((r) => (r.own ?? []).some((n) => n.name === 'Extra'))).toBe(true);
    expect(rows.some((r) => r.removed !== undefined)).toBe(false);
    install(midDoc());
    await eachExpansion(saved, (where) => {
      expect(inMid('Leaf'), where).toHaveLength(1);
      expect(inMid('Extra'), where).toHaveLength(1);
    });
  });

  // The no-op compare runs over TOKENIZED content: MID's node holds a member token, the live one a guid. It decides only
  // a frame that stays WHOLE in the slot — one through a pre-v5 inner prefab, whose members no row can key; a keyable
  // frame is stated per member, whose diff resolves the chain's tokens itself. So MID and INNER are both pre-v5 here. Mutation: in
  // `finishTemplateReferenceNode`, hand `captureRowChannels` `deferCompare = false` (compare before tokenizing).
  it('a whole frame holding a member ref does not pin either', async () => {
    install({ ...innerDoc, version: 4, entities: innerDoc.entities.map(({ nodeGuid: _n, ...e }) => e) });
    const n1 = { parentLocalId: 1, guid: '', key: K1, name: 'N1', traits: { EntityAttributes: { name: 'N1' }, Transform: { x: 1 }, UIFocusable: { navUp: '@member:^.2' } }, children: [] };
    const mid = midDoc({ added: [n1] });
    install({ ...mid, version: 4, entities: mid.entities.map(({ nodeGuid: _n, ...e }) => e) });
    const root = await openInEditor(outer2());
    expect(traitOf(inMid('N1')[0]!.id, 'UIFocusable')?.navUp).toBe(inMid('Slot')[0]!.guid); // precondition: resolved
    const node = refNodeOf(serializePrefab(root, OUTER2)!);
    expect(node.nestedStructure).toBeUndefined();
    expect(node.members).toBeUndefined();
  });

  // Mutation: in `finishTemplateReferenceNode`, write `rc.channels.nestedOverrides` untokenized.
  it('a member ref saved inside the node is a token, and names that instance\'s own member', async () => {
    install(midDoc());
    const root = await openInEditor(outer2());
    const leaf = inMid('Leaf')[0]!.id;
    writeTraitFieldWithUndo(leaf, getTraitByName('UIFocusable')!, 'navUp', inMid('Slot')[0]!.guid);
    const saved = serializePrefab(root, OUTER2)!;
    expect(refNodeOf(saved).nestedOverrides).toEqual({ 3: { 2: { UIFocusable: { navUp: '@member:^.2' } } } });
    install(saved);
    await eachExpansion(saved, (where) => {
      const slot = inMid('Slot')[0]!.guid;
      expect(slot, where).toBeTruthy();
      expect(traitOf(inMid('Leaf')[0]!.id, 'UIFocusable')?.navUp, where).toBe(slot);
    });
  });
});

describe('every reader takes a template reference node\'s rows (#1538)', () => {
  const deletesLeaf = () => outer2({ members: { [`/${G_MID_NESTED}/${G_LEAF}`]: { removed: true } } });

  // The runtime loader already folded a node's rows; the editor's own spawn passed them as re-parent statements only.
  // Mutation: in `editorStructureOps().spawnNestedInstance`, build the layer without `rows: node.members`.
  it('each spawner folds the node\'s rows', async () => {
    install(midDoc());
    await eachExpansion(deletesLeaf(), (where) => expect(inMid('Leaf'), where).toHaveLength(0));
  });

  // A scene over OUTER2 whose MID interior the node's row already states. Mutation: in `enclosingLayer`, drop the
  // `node?.members` seed — the INNER instance lists the node's deletion as its own.
  it('an INNER instance inside the node does not list the node\'s row as its own', async () => {
    install(midDoc());
    install(deletesLeaf());
    await load(sceneWith(OUTER2, 'OuterRoot'));
    expect(inMid('Leaf')).toHaveLength(0);
    const inner = inMid('InnerRoot')[0]!.id;
    expect(ownInstanceStructure(inner, innerDoc as unknown as PrefabFile).removed).toEqual([]);
  });

  // Mutation: in `sameAddedNode`, return the scene-form compare alone.
  it('an untouched scene instance of OUTER2 states nothing about the node', async () => {
    install(midDoc({ removed: [2] }));
    const saved = serializePrefab(await openInEditor(outer2()), OUTER2)!;
    install(saved);
    await load(sceneWith(OUTER2, 'OuterRoot'));
    const entry = (await serializeScene()).entities.find((e) => (e as { prefab?: string }).prefab === OUTER2) as unknown as Record<string, unknown>;
    const rows = Object.values((entry.members ?? {}) as Record<string, Record<string, unknown>>);
    expect(rows.flatMap((r) => Object.keys(r).filter((k) => k !== 'guid' && k !== 'name'))).toEqual([]);
    expect(entry.nestedStructure).toBeUndefined();
    expect(entry.added).toBeUndefined();
  });

  // The comparison's capture READS keys. Mutation: in `addedNodeIdentity`, drop the `readOnly` early return — the
  // scene's own node is stamped with a template key, which the derive pass would then treat as template-added.
  it('the scene save\'s template comparison stamps no key on a scene-authored node', async () => {
    install(midDoc());
    install(outer2());
    await load(sceneWith(OUTER2, 'OuterRoot'));
    const extra = spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Extra', parentId: inMid('InnerRoot')[0]!.id }));
    await serializeScene();
    expect(templateKeyOf(entityOf(extra.id()))).toBe('');
  });

  // Mutation: in `editWorldRefs`, drop the `isReferenceNode` keep — the `^` inside the node is read as one reaching
  // OUTER2's root, and rewritten to OUTER2's Panel.
  it('the prefab-edit world leaves a token inside the node for the node\'s frame', async () => {
    install(midDoc());
    const doc = outer2({ nestedOverrides: { 3: { 2: { UIFocusable: { navUp: '@member:^.2' } } } } });
    const scene = buildPrefabEditScene(doc);
    const entry = scene.entities.find((e) => (e as { prefab?: string }).prefab === INNER) as unknown as { added: Array<{ nestedOverrides: unknown }> };
    expect(entry.added[0]!.nestedOverrides).toEqual({ 3: { 2: { UIFocusable: { navUp: '@member:^.2' } } } });
    await openInEditor(doc);
    expect(traitOf(inMid('Leaf')[0]!.id, 'UIFocusable')?.navUp).toBe(inMid('Slot')[0]!.guid);
  });

  // Mutation: in `templateKeysOf`, drop `rows(n.members)`.
  it('templateKeysOf declares a key only a node\'s row carries', () => {
    const own = { parentLocalId: 0, guid: '', key: K1, name: 'N', traits: {}, children: [] };
    expect(templateKeysOf(outer2({ members: { [`/${G_MID_NESTED}/${G(1)}`]: { own: [own] } } }) as never)).toContain(K1);
  });

  // Apply over a scene whose added PLAIN node holds a MID reference node: the node reaches `insertAddedSubtree`
  // through the recursion. Mutation: skip the re-capture there (`recaptured` left undefined) — the row takes the
  // scene-form slot, whole, and pins MID's node.
  it('Apply promotes a reference node under a plain node with rows, not a whole slot', async () => {
    const MID_GUID = 'bbbbbbbb-0000-4000-8000-000000021538';
    const P_GUID = 'bbbbbbbb-0000-4000-8000-000000031538';
    const hostDoc = { id: HOST, version: 6, name: 'Host', rootLocalId: 1, entities: [row(1, G(51), 'HostRoot', 0), row(2, G(52), 'HPanel', 1)] };
    const nNode = (x: number) => ({ parentLocalId: 1, guid: '', key: K1, name: 'N1', traits: { EntityAttributes: { name: 'N1' }, Transform: { x } }, children: [] });
    const plain = {
      parentLocalId: 2, guid: P_GUID, name: 'P', traits: { EntityAttributes: { name: 'P', guid: P_GUID }, Transform: {} },
      children: [{ parentLocalId: 0, guid: MID_GUID, name: 'MidRoot', prefab: MID, traits: {}, children: [] }],
    };
    install(midDoc({ added: [nNode(1)] }));
    install(hostDoc);
    await load(sceneWith(HOST, 'HostRoot', { added: [plain] }));
    deleteEntitiesWithUndo([inMid('Leaf')[0]!.id]);
    await applyToPrefabSelective(all().find((e) => e.name === 'HostRoot')!.id, new Set([`+added.${P_GUID}`]));
    const written = writes.map((w) => JSON.parse(w.content) as PrefabFile).find((p) => p.id === HOST)!;
    const midRow = written.entities.find((e) => e.prefab === MID)!;
    expect(midRow.nestedStructure).toBeUndefined();
    expect(midRow.members).toEqual({ [`/${G_MID_NESTED}/${G_LEAF}`]: { removed: true } });
    install(midDoc({ added: [nNode(9)] })); // MID moves its node
    install(written);
    await load(sceneWith(HOST, 'HostRoot'));
    expect(inMid('Leaf')).toHaveLength(0); // the scene's deletion was applied…
    expect(traitOf(inMid('N1')[0]!.id, 'Transform')).toMatchObject({ x: 9 }); // …and MID's node still follows MID
  });
});

describe('#1538 close-out review', () => {
  /** `doc` as a pre-v5 file: no row carries a `nodeGuid`, so no member row can key its members. */
  const preV5 = (doc: { entities: Array<Record<string, unknown>> }) => ({ ...doc, version: 4, entities: doc.entities.map(({ nodeGuid: _n, ...e }) => e) });

  // A move no member row can carry (a pre-v5 member) rides the scene-form slot's `moved`, which the template form has
  // no place for. Mutation: in `sameAddedNode`, drop the nested-slot `moved` check from `holdsInstanceIdentity`.
  it('a scene move inside a pre-v5 frame of the node survives a save', async () => {
    install(preV5(innerDoc));
    install(midDoc());
    install(outer2());
    await load(sceneWith(OUTER2, 'OuterRoot'));
    reparentEntity(inMid('Leaf')[0]!.id, inMid('Slot')[0]!.id);
    const scene = await serializeScene();
    await load(scene as unknown as SceneData);
    expect(nameOf(parentOf(inMid('Leaf')[0]!.id))).toBe('Slot');
  });

  // A legacy key-less node in a whole pre-v5 slot is minted a key by the capture; the slot is then dropped as unchanged,
  // so no file declares that key. Mutation: build `declared` in `finishTemplateReferenceNode` from `rc.*` (the capture).
  it('a ref to a legacy node in a dropped slot is kept as its guid, and resolves', async () => {
    const LEG = 'eeeeeeee-0000-4000-8000-000000001538';
    install(preV5(innerDoc));
    install(preV5(midDoc({ added: [{ parentLocalId: 1, guid: LEG, name: 'N1', traits: { EntityAttributes: { name: 'N1' }, Transform: {} }, children: [] }] })));
    const root = await openInEditor(outer2());
    writeTraitFieldWithUndo(inMid('Leaf')[0]!.id, getTraitByName('UIFocusable')!, 'navUp', inMid('N1')[0]!.guid);
    const saved = serializePrefab(root, OUTER2)!;
    expect(refNodeOf(saved).nestedStructure).toBeUndefined();
    await eachExpansion(saved, (where) => expect(traitOf(inMid('Leaf')[0]!.id, 'UIFocusable')?.navUp, where).toBe(inMid('N1')[0]!.guid));
  });

  // The comparison's read-only capture recovers a lost key without stamping it. Mutation: in `templateFormOf`, read
  // the marker alone.
  it('a node row\'s node whose key marker was lost still compares unchanged', async () => {
    install(midDoc());
    const root = await openInEditor(outer2());
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Extra', parentId: inMid('InnerRoot')[0]!.id }));
    const saved = serializePrefab(root, OUTER2)!;
    install(saved);
    await load(sceneWith(OUTER2, 'OuterRoot'));
    entityOf(inMid('Extra')[0]!.id)!.remove(TemplateAddedKey);
    const entry = (await serializeScene()).entities.find((e) => (e as { prefab?: string }).prefab === OUTER2) as unknown as Record<string, unknown>;
    const rows = Object.values((entry.members ?? {}) as Record<string, Record<string, unknown>>);
    expect(rows.flatMap((r) => Object.keys(r).filter((k) => k !== 'guid' && k !== 'name'))).toEqual([]);
    expect(entry.added).toBeUndefined();
  });
});

describe('#1538 close-out re-review', () => {
  const preV5 = (doc: { entities: Array<Record<string, unknown>> }) => ({ ...doc, version: 4, entities: doc.entities.map(({ nodeGuid: _n, ...e }) => e) });

  // MID's own INNER, inside the node, is the node's to re-expand. Mutation: in `finishTemplateReferenceNode`, return
  // `rc.channels.consumedEcsIds` alone — the save writes it again as a row at OUTER2's root, and every instance spawns
  // a duplicate InnerRoot.
  it('a save writes the node\'s own nested instances nowhere else', async () => {
    install(midDoc());
    const saved = serializePrefab(await openInEditor(outer2()), OUTER2)!;
    expect(saved.entities.filter((e) => e.prefab === INNER)).toHaveLength(1);
    await eachExpansion(saved, (where) => expect(all().filter((e) => e.name === 'InnerRoot'), where).toHaveLength(2));
  });

  // The file being saved is still cached in its OLD form while it saves. Mutation: in `declaredTemplateKeys`, also add
  // every cached document's keys — the old OUTER2's slot declares KN, and the token through it survives the drop.
  // ⚠️ Proves the token goes, NOT that the ref resolves: the edit world's N1 derived its guid through KN, and a reload
  // spawns MID's legacy N1 as LEG, so the guid written instead names nothing either (the doc's "Not covered").
  it('a key only the OLD copy of the file declared does not keep a token', async () => {
    const LEG = 'eeeeeeee-0000-4000-8000-000000011538';
    const KN = 'dddddddd-0000-4000-8000-000000021538';
    const n1 = (extra: Record<string, unknown>) => ({ parentLocalId: 1, name: 'N1', traits: { EntityAttributes: { name: 'N1' }, Transform: {} }, children: [], ...extra });
    install(preV5(innerDoc));
    install(preV5(midDoc({ added: [n1({ guid: LEG })] })));
    const root = await openInEditor(outer2({ nestedStructure: { 3: { added: [n1({ guid: '', key: KN })], removed: [], removedTraits: {} } } }));
    writeTraitFieldWithUndo(inMid('Leaf')[0]!.id, getTraitByName('UIFocusable')!, 'navUp', inMid('N1')[0]!.guid);
    const saved = serializePrefab(root, OUTER2)!;
    expect(refNodeOf(saved).nestedStructure).toBeUndefined();
    expect(JSON.stringify(refNodeOf(saved).nestedOverrides)).not.toContain(KN);
  });

  // A move no row can carry, inside a reference node MID authors in a whole pre-v5 slot of the node. Mutation: in
  // `holdsInstanceIdentity`, drop the recursion into a slot's `added`.
  it('a scene move inside a reference node in a pre-v5 slot of the node survives a save', async () => {
    const X = 'aaaaaaaa-0000-4000-8000-000000041538';
    install(preV5(innerDoc));
    install({ id: X, version: 4, name: 'X', rootLocalId: 1, entities: [row(1, '', 'XRoot', 0), row(2, '', 'XKid', 1)].map(({ nodeGuid: _n, ...e }) => e) });
    install(midDoc({ added: [{ parentLocalId: 2, guid: '', key: K1, name: 'XRoot', prefab: X, traits: {}, children: [] }] }));
    install(outer2());
    await load(sceneWith(OUTER2, 'OuterRoot'));
    reparentEntity(inMid('XKid')[0]!.id, inMid('Leaf')[0]!.id);
    const scene = await serializeScene();
    await load(scene as unknown as SceneData);
    expect(nameOf(parentOf(inMid('XKid')[0]!.id))).toBe('Leaf');
  });
});

describe('#1538 close-out: declared keys, both sides', () => {
  const preV5 = (doc: { entities: Array<Record<string, unknown>> }) => ({ ...doc, version: 4, entities: doc.entities.map(({ nodeGuid: _n, ...e }) => e) });
  const OUTER3 = 'aaaaaaaa-0000-4000-8000-000000051538';
  /** OUTER3: a MID ROW (5) under Panel, which holds a focus trait to point at something inside it. */
  const outer3 = (midRow: Record<string, unknown> = {}) => ({ id: OUTER3, version: 6, name: 'Outer3', rootLocalId: 1, entities: [
    row(1, G(61), 'OuterRoot', 0), row(2, G(62), 'Panel', 1, {}, { UIFocusable: {} }), row(5, G(65), 'MidRoot', 2, { prefab: MID, ...midRow }),
  ] }) as unknown as PrefabFile;
  const n1 = (extra: Record<string, unknown>) => ({ parentLocalId: 1, name: 'N1', traits: { EntityAttributes: { name: 'N1' }, Transform: {} }, children: [], ...extra });
  const panelNavUp = () => traitOf(all().find((e) => e.name === 'Panel')!.id, 'UIFocusable')?.navUp;

  // The ACCEPT side for a reference node: K1 is declared by MID alone, the node's own prefab. Mutation: in
  // `declaredTemplateKeys`, drop the `sources` walk — the token is reverted to the edit world's guid.
  it('a node\'s token through a key its prefab declares survives, and resolves', async () => {
    install(midDoc({ added: [n1({ guid: '', key: K1 })] }));
    const root = await openInEditor(outer2());
    writeTraitFieldWithUndo(inMid('Leaf')[0]!.id, getTraitByName('UIFocusable')!, 'navUp', inMid('N1')[0]!.guid);
    const saved = serializePrefab(root, OUTER2)!;
    expect(JSON.stringify(refNodeOf(saved).nestedOverrides)).toContain(K1);
    await eachExpansion(saved, (where) => expect(traitOf(inMid('Leaf')[0]!.id, 'UIFocusable')?.navUp, where).toBe(inMid('N1')[0]!.guid));
  });

  // The ACCEPT side for a prefab ROW: K1 is declared by MID, which OUTER3 nests through a row. Mutation: in
  // `declaredTemplateKeys`, drop `visit(written.entities)`.
  it('a row writer\'s token through a key a nested prefab declares survives, and resolves', async () => {
    install(midDoc({ added: [n1({ guid: '', key: K1 })] }));
    const root = await openInEditor(outer3());
    writeTraitFieldWithUndo(all().find((e) => e.name === 'Panel')!.id, getTraitByName('UIFocusable')!, 'navUp', inMid('N1')[0]!.guid);
    const saved = serializePrefab(root, OUTER3)!;
    expect(JSON.stringify(saved.entities.find((e) => e.name === 'Panel')!.traits)).toContain(K1);
    install(saved);
    await openInEditor(saved);
    expect(panelNavUp(), 'prefab edit world').toBe(inMid('N1')[0]!.guid);
    await load(emptyScene);
    instantiatePrefab(saved as never);
    deriveInstanceMemberGuids(getCurrentWorld());
    expect(panelNavUp(), 'editor instantiate').toBe(inMid('N1')[0]!.guid);
  });

  // The REJECT side for a prefab ROW: the old OUTER3's slot declares KN, the save drops the slot. Mutation: in
  // `serializePrefab`, add every cached document's keys to `declared` again.
  it('a row writer\'s token through a key only the OLD copy declared is not kept', async () => {
    const LEG = 'eeeeeeee-0000-4000-8000-000000021538';
    const KN = 'dddddddd-0000-4000-8000-000000031538';
    install(preV5(innerDoc));
    install(preV5(midDoc({ added: [n1({ guid: LEG })] })));
    const root = await openInEditor(outer3({ nestedStructure: { 3: { added: [n1({ guid: '', key: KN })], removed: [], removedTraits: {} } } }));
    writeTraitFieldWithUndo(all().find((e) => e.name === 'Panel')!.id, getTraitByName('UIFocusable')!, 'navUp', inMid('N1')[0]!.guid);
    const saved = serializePrefab(root, OUTER3)!;
    expect(saved.entities.find((e) => e.prefab === MID)!.nestedStructure).toBeUndefined();
    expect(JSON.stringify(saved.entities.find((e) => e.name === 'Panel')!.traits)).not.toContain(KN);
  });
});

describe('#1542: a template reference node keeps the rows its inner prefab no longer backs (R2)', () => {
  /** INNER while it has the member G(99), which OUTER2's node edits through MID's row 3. */
  const innerWithGone = () => ({ ...innerDoc, entities: [...innerDoc.entities, row(3, G(99), 'Gone', 1)] });
  const orphan = { [`/${G_MID_NESTED}/${G(99)}`]: { traits: { Transform: { x: 3 } } } };
  const quiet = <T,>(f: () => Promise<T>): Promise<T> => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    return f().finally(() => warn.mockRestore());
  };

  // The case #1542 was observed with. Mutations: skip `keepTemplateNodeOrphans` after the derive; in
  // `keepsTemplateRows`, drop the template-node branch (a row sentinel alone).
  it('an untouched save keeps the node\'s orphan row, and INNER restoring the member brings the edit back', async () => {
    install(midDoc());
    const root = await quiet(() => openInEditor(outer2({ members: orphan })));
    const saved = serializePrefab(root, OUTER2)!;
    expect(refNodeOf(saved).members).toEqual(orphan);
    install(innerWithGone());
    await eachExpansion(saved, (where) => expect(traitOf(inMid('Gone')[0]!.id, 'Transform'), where).toMatchObject({ x: 3 }));
  });

  // A Refresh is the other route INNER's change reaches the open prefab by, and it must leave the store as a reload
  // would (#1535): the row INNER backs again is replayed live, and the save states it as a live edit (a field edit is a
  // `nestedOverrides` path, not a row).
  // Mutation: skip `keepTemplateNodeOrphans` after the derive — nothing is kept, so the settle has nothing to replay.
  it('a Refresh that restores the member replays the kept row, live and on save', async () => {
    install(midDoc());
    const root = await quiet(() => openInEditor(outer2({ members: orphan })));
    install(innerWithGone());
    await rebaseStaleInstances();
    expect(traitOf(inMid('Gone')[0]!.id, 'Transform')).toMatchObject({ x: 3 });
    const saved = serializePrefab(root, OUTER2)!;
    await eachExpansion(saved, (where) => expect(traitOf(inMid('Gone')[0]!.id, 'Transform'), where).toMatchObject({ x: 3 }));
  });

  // The REJECT side (#1293): outside the prefab-edit world a template node's kept rows are not the template's, so a
  // template written from a scene instance does not take them. The store is seeded directly — what a rebuild's settle
  // keeps for that root in a scene. Mutation: in `keepsTemplateRows`, drop the sentinel-ancestor walk.
  it('a template written from a scene instance does not carry rows kept for the node there', async () => {
    const SCENE_G = 'ffffffff-0000-4000-8000-000000001542';
    install(midDoc());
    install(outer2());
    await load(sceneWith(OUTER2, 'OuterRoot'));
    const nodeGuid = all().find((e) => e.name === 'MidRoot')!.guid!;
    expect(nodeGuid).toBeTruthy();
    setKeptMemberOrphans(nodeGuid, { [`/${G_MID_NESTED}/${G(99)}`]: { guid: SCENE_G, name: 'Gone' } });
    const created = serializePrefab(all().find((e) => e.name === 'OuterRoot')!.id)!;
    expect(JSON.stringify(created)).not.toContain(SCENE_G);
  });

  // A load resets the store for the node — every node, rows or not — so a set the file no longer states is not written
  // back. Mutation: in `keepTemplateNodeOrphans`, skip a node whose file states no rows.
  it('reopening the prefab without the row drops what an earlier open kept', async () => {
    install(midDoc());
    await quiet(() => openInEditor(outer2({ members: orphan })));
    const root = await openInEditor(outer2());
    expect(refNodeOf(serializePrefab(root, OUTER2)!).members).toBeUndefined();
    expect(keptMemberOrphans(all().find((e) => e.name === 'MidRoot')!.guid!)).toBeUndefined();
  });
});

describe('#1541: a ref from inside a template reference node climbs out of it', () => {
  /** OUTER2's own Panel, and the INNER row's own Leaf — neither is inside the MID node. */
  const panel = () => all().find((e) => e.name === 'Panel')!;
  const rowLeaf = () => all().find((e) => e.name === 'Leaf' && !under(e.id, 'MidRoot'))!;
  const saveWithNavUp = async (target: () => { guid?: string }) => {
    install(midDoc());
    const root = await openInEditor(outer2());
    writeTraitFieldWithUndo(inMid('Leaf')[0]!.id, getTraitByName('UIFocusable')!, 'navUp', target().guid!);
    return serializePrefab(root, OUTER2)!;
  };

  // The case #1541 was observed with: Leaf (in MID's INNER) → MID → the INNER row → OUTER2, three climbs.
  // Mutations: in `templateTokenizer`, drop the climb out of the node's root; skip the exit marker (the edit world
  // stops at the row entry); in `rebaseMemberTokens`, leave a token that climbs past the top as it is; in
  // `resolveTemplateFrames`, return a `^` token unresolved; in `templateFrameClimber`, drop the reference-node step;
  // in `editWorldRefs`, keep a reference node whole.
  it('a ref to a member of the prefab around the node is saved as a token, and names that instance\'s own', async () => {
    const saved = await saveWithNavUp(panel);
    expect(refNodeOf(saved).nestedOverrides).toEqual({ 3: { 2: { UIFocusable: { navUp: '@member:^.^.^.2' } } } });
    install(saved);
    await eachExpansion(saved, (where) => {
      expect(panel().guid, where).toBeTruthy();
      expect(traitOf(inMid('Leaf')[0]!.id, 'UIFocusable')?.navUp, where).toBe(panel().guid);
    });
  });

  // One level out: the frame holding the node. Nothing above the row entry is needed, so no marker is involved.
  // Mutations: in `templateTokenizer`, drop the climb out of the node's root; in `templateFrameClimber`, drop the
  // reference-node step.
  it('a ref to a member of the instance holding the node resolves in that instance', async () => {
    const saved = await saveWithNavUp(rowLeaf);
    expect(refNodeOf(saved).nestedOverrides).toEqual({ 3: { 2: { UIFocusable: { navUp: '@member:^.^.2' } } } });
    install(saved);
    await eachExpansion(saved, (where) => expect(traitOf(inMid('Leaf')[0]!.id, 'UIFocusable')?.navUp, where).toBe(rowLeaf().guid));
  });

  // The override list reads each member's base with the enclosing rows' tokens resolved (`baseTokenResolver`), and
  // that climb must cross the node's root as the loader's does, or the value OUTER2's node states lists as the
  // instance's own. Mutation: in `baseTokenResolver`, climb only an owned root's owner (its pre-#1541 rule).
  it('the override list of an instance inside the node does not list the node\'s climbing ref as its own', async () => {
    install(midDoc());
    install(outer2({ nestedOverrides: { 3: { 2: { UIFocusable: { navUp: '@member:^.^.^.2' } } } } }));
    await load(sceneWith(OUTER2, 'OuterRoot'));
    expect(traitOf(inMid('Leaf')[0]!.id, 'UIFocusable')?.navUp).toBe(panel().guid); // precondition: resolved
    const nodes = collectInstanceOverrideFields(inMid('InnerRoot')[0]!.id, innerDoc as unknown as PrefabFile);
    expect(nodes.filter((n) => n.name === 'Leaf')).toEqual([]);
  });

  // The scene save compares the node with its template form, which holds the climbing token: the live node, written as
  // a template would write it, must climb the same way, or every untouched instance restates (pins) the node. The file
  // is authored by hand, so the side under test is the comparison alone. Mutations: in `templateTokenizer`, drop the
  // climb out of the node's root; in `resolveTemplateFrames`, return a `^` token unresolved.
  it('an untouched scene instance of OUTER2 whose node climbs out states nothing about the node', async () => {
    install(midDoc());
    install(outer2({ nestedOverrides: { 3: { 2: { UIFocusable: { navUp: '@member:^.^.^.2' } } } } }));
    await load(sceneWith(OUTER2, 'OuterRoot'));
    expect(traitOf(inMid('Leaf')[0]!.id, 'UIFocusable')?.navUp).toBe(panel().guid); // precondition: resolved
    const entry = (await serializeScene()).entities.find((e) => (e as { prefab?: string }).prefab === OUTER2) as unknown as Record<string, unknown>;
    const rows = Object.values((entry.members ?? {}) as Record<string, Record<string, unknown>>);
    expect(rows.flatMap((r) => Object.keys(r).filter((k) => k !== 'guid' && k !== 'name'))).toEqual([]);
    expect(entry.nestedStructure).toBeUndefined();
    expect(entry.nestedOverrides).toBeUndefined();
    expect(entry.added).toBeUndefined();
  });
});

describe('#1541/#1542 close-out review', () => {
  const climbing = () => outer2({ nestedOverrides: { 3: { 2: { UIFocusable: { navUp: '@member:^.^.^.2' } } } } });
  const innerPlus = () => ({ ...innerDoc, entities: [...innerDoc.entities, row(4, G(98), 'Extra4', 1)] });
  const innerNoLeaf = () => ({ ...innerDoc, entities: innerDoc.entities.slice(0, 1) });
  const quietly = async <T,>(f: () => Promise<T>): Promise<T> => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { return await f(); } finally { warn.mockRestore(); }
  };

  // A Refresh respawns the node from a scene-form capture, which carries no key, and the climb reads the key.
  // Mutation: drop the `addedNodeIdentity` call at the top of `finishTemplateReferenceNode`.
  it('a Refresh in the prefab editor does not turn the node\'s climbing ref back into a placeholder', async () => {
    install(midDoc());
    const root = await openInEditor(climbing());
    install(innerPlus());
    await rebaseStaleInstances();
    expect(refNodeOf(serializePrefab(root, OUTER2)!).nestedOverrides).toEqual({ 3: { 2: { UIFocusable: { navUp: '@member:^.^.^.2' } } } });
  });

  // …and `keepsTemplateRows` reads the key too: INNER dropping Leaf keeps the node's edit to it, in template form.
  // Mutations: drop the `addedNodeIdentity` call (the row is not re-emitted); in `captureRowChannels`, re-emit a kept row
  // without `templateRowOf` (it carries the edit world's guid and the member's name).
  it('a Refresh that drops a member the node edits keeps the edit as a template row', async () => {
    install(midDoc());
    const root = await openInEditor(outer2({ members: { [`/${G_MID_NESTED}/${G_LEAF}`]: { traits: { Transform: { x: 5 } } } } }));
    install(innerNoLeaf());
    await quietly(() => rebaseStaleInstances());
    expect(refNodeOf(serializePrefab(root, OUTER2)!).members).toEqual({ [`/${G_MID_NESTED}/${G_LEAF}`]: { traits: { Transform: { x: 5 } } } });
  });

  // The same settle on a prefab ROW, older than #1542: the settle keeps what a SCENE save writes, and the row
  // re-emitted it with the member's edit-world guid (#1293). Mutation: in `captureRowChannels`, re-emit a kept row
  // without `templateRowOf`.
  it('a Refresh that drops a member a prefab row edits keeps the edit without the member\'s guid', async () => {
    install(midDoc());
    const root = await openInEditor(outer2());
    writeTraitFieldWithUndo(all().find((e) => e.name === 'Leaf' && !under(e.id, 'MidRoot'))!.id, getTraitByName('Transform')!, 'x', 5);
    install(innerNoLeaf());
    await quietly(() => rebaseStaleInstances());
    const saved = serializePrefab(root, OUTER2)!;
    expect(saved.entities.find((e) => e.prefab === INNER)!.members).toEqual({ [`/${G_LEAF}`]: { traits: { Transform: { x: 5 } } } });
  });

  /** OUTER2 numbered sparsely: Create Prefab renumbers Panel 7 → 2. */
  const sparse = () => ({ ...outer2(), entities: [
    row(1, G(21), 'OuterRoot', 0), row(7, G(22), 'Panel', 1), row(5, G(25), 'InnerRow', 7, { prefab: INNER, added: [refNode()] }),
  ] }) as unknown as PrefabFile;

  // Create Prefab over a scene instance: the root's frame is named by the NEW file's localIds. Mutation: in
  // `templateTokenizer`, climb without `belowWrittenRoot` (the token names Panel by the old localId 7).
  it('Create Prefab from a scene instance names the root\'s member by the new file\'s localId', async () => {
    install(midDoc());
    install(sparse());
    await load(sceneWith(OUTER2, 'OuterRoot'));
    writeTraitFieldWithUndo(inMid('Leaf')[0]!.id, getTraitByName('UIFocusable')!, 'navUp', panel().guid!);
    const created = serializePrefab(all().find((e) => e.name === 'OuterRoot')!.id)!;
    const panelLid = created.entities.find((e) => e.name === 'Panel')!.localId;
    expect(JSON.stringify(refNodeOf(created).nestedOverrides)).toContain(`@member:^.^.^.${panelLid}`);
    install(created);
    await load(emptyScene);
    instantiatePrefab(created as never);
    deriveInstanceMemberGuids(getCurrentWorld());
    expect(traitOf(inMid('Leaf')[0]!.id, 'UIFocusable')?.navUp).toBe(panel().guid);
  });

  // A ref out of the written tree stays the guid it was, as every other ref out of it does. Mutation: in
  // `templateTokenizer`, climb without `belowWrittenRoot` (it names OUTER2's root, which the reload reads as Panel).
  it('Create Prefab on a member leaves a ref out of the written tree as its guid', async () => {
    install(midDoc());
    install(outer2());
    await load(sceneWith(OUTER2, 'OuterRoot'));
    writeTraitFieldWithUndo(inMid('Leaf')[0]!.id, getTraitByName('UIFocusable')!, 'navUp', ROOT);
    const created = serializePrefab(panel().id)!;
    expect(refNodeOf(created).nestedOverrides).toEqual({ 3: { 2: { UIFocusable: { navUp: ROOT } } } });
  });

  // A template row carries no member identity; one holding a guid anyway (a hand-edited file) is kept, never pinned —
  // the fold that applies the row in a scene ignores it too, and this runs past the collision guard.
  // Mutation: in `keepTemplateNodeOrphans`, call `applyStoredMemberRows` without `keepOnly`.
  it('a guid on a node\'s template row is not stamped on the member in the prefab editor', async () => {
    const STRAY = 'eeeeeeee-0000-4000-8000-000000001542';
    install(midDoc());
    await openInEditor(outer2({ members: { [`/${G_MID_NESTED}/${G_LEAF}`]: { guid: STRAY, traits: { Transform: { x: 5 } } } } }));
    expect(inMid('Leaf')[0]!.guid).toBeTruthy();
    expect(inMid('Leaf')[0]!.guid).not.toBe(STRAY);
  });

  // A kept row the LOAD read is a template row already, and goes back out verbatim — a reference node in its `own` keeps
  // its own rows. Mutation: in `templateRowOf`, convert every node, not only a scene one (`toTemplateNodes` drops a
  // node's `members`).
  it('an untouched save keeps a kept template row\'s reference node with its own rows', async () => {
    const KX = 'dddddddd-0000-4000-8000-000000041538';
    const own = { parentLocalId: 0, key: KX, guid: '', name: 'MidRoot', prefab: MID, traits: {}, children: [],
      members: { [`/${G_MID_NESTED}/${G_LEAF}`]: { traits: { Transform: { x: 7 } } } } };
    const rowMembers = { [`/${G_LEAF}`]: { own: [own] } };
    install(midDoc());
    install(innerNoLeaf());
    const doc = outer2();
    (doc.entities.find((e) => e.prefab === INNER) as unknown as Record<string, unknown>).members = rowMembers;
    const root = await quietly(() => openInEditor(doc));
    expect(serializePrefab(root, OUTER2)!.entities.find((e) => e.prefab === INNER)!.members).toEqual(rowMembers);
  });

  // A node a Refresh drops keeps the key it was authored with, save after save. Mutation: in `captureRowsForSettle`,
  // skip `keySceneNodes` (the node is gone by the save, and `toTemplateNodes` mints a key each time).
  it('a node a Refresh drops keeps its authored key across saves', async () => {
    const KK = 'dddddddd-0000-4000-8000-000000051538';
    const n1 = { parentLocalId: 2, guid: '', key: K1, name: 'N1', traits: { EntityAttributes: { name: 'N1' }, Transform: {} }, children: [] };
    const kid = { parentLocalId: 0, guid: '', key: KK, name: 'Kid', traits: { EntityAttributes: { name: 'Kid' }, Transform: { x: 4 } }, children: [] };
    install(midDoc({ added: [n1] }));
    const root = await openInEditor(outer2({ members: { [`/${G_MID_NESTED}/a+${K1}`]: { own: [kid] } } }));
    expect(inMid('Kid')).toHaveLength(1); // precondition: the node row spawned its node
    install(midDoc());
    await quietly(() => rebaseStaleInstances());
    const first = JSON.stringify(refNodeOf(serializePrefab(root, OUTER2)!).members ?? {});
    expect(first).toContain(KK);
    expect(JSON.stringify(refNodeOf(serializePrefab(root, OUTER2)!).members ?? {})).toBe(first); // a second save: same bytes
  });

  const innerWith = (...extra: ReturnType<typeof row>[]) => ({ ...innerDoc, entities: [innerDoc.entities[0]!, ...extra] });
  const leafRow = () => row(2, G_LEAF, 'Leaf', 1, {}, { UIAction: {}, UIFocusable: {} });
  const extraRow = () => row(4, G(98), 'Extra4', 1);

  // A rebuild respawns the node without its key marker, and a SECOND Refresh before any save must still keep both edits
  // in template form. Mutation: in `captureRowChannels`, re-emit a kept row without `templateRowOf`. (Reading the marker
  // alone in `keepsTemplateRows` does not turn this one red — rows with no node convert the same either way — the next
  // case covers that.)
  it('two Refreshes in a row keep both dropped edits as template rows', async () => {
    install(midDoc());
    install(innerWith(leafRow(), extraRow()));
    const root = await openInEditor(outer2({ members: {
      [`/${G_MID_NESTED}/${G_LEAF}`]: { traits: { Transform: { x: 5 } } },
      [`/${G_MID_NESTED}/${G(98)}`]: { traits: { Transform: { x: 6 } } },
    } }));
    install(innerWith(extraRow()));
    await quietly(() => rebaseStaleInstances());
    install(innerWith());
    await quietly(() => rebaseStaleInstances());
    expect(refNodeOf(serializePrefab(root, OUTER2)!).members).toEqual({
      [`/${G_MID_NESTED}/${G_LEAF}`]: { traits: { Transform: { x: 5 } } },
      [`/${G_MID_NESTED}/${G(98)}`]: { traits: { Transform: { x: 6 } } },
    });
  });

  // The same after an innocuous Refresh: a dropped node row's own node goes back as a template node, its key kept.
  // Mutations: in `keepsTemplateRows`, read the marker alone; in `templateRowOf`, keep scene nodes as they are.
  it('a node row dropped after an earlier Refresh keeps its node as a template node', async () => {
    const KK = 'dddddddd-0000-4000-8000-000000051538';
    const n1 = { parentLocalId: 2, guid: '', key: K1, name: 'N1', traits: { EntityAttributes: { name: 'N1' }, Transform: {} }, children: [] };
    const kid = { parentLocalId: 0, guid: '', key: KK, name: 'Kid', traits: { EntityAttributes: { name: 'Kid' }, Transform: { x: 4 } }, children: [] };
    install(midDoc({ added: [n1] }));
    install(innerWith(leafRow()));
    const root = await openInEditor(outer2({ members: { [`/${G_MID_NESTED}/a+${K1}`]: { own: [kid] } } }));
    install(innerWith(leafRow(), extraRow()));
    await quietly(() => rebaseStaleInstances());
    install(midDoc());
    await quietly(() => rebaseStaleInstances());
    const out = refNodeOf(serializePrefab(root, OUTER2)!).members![`/${G_MID_NESTED}/a+${K1}`]!.own![0]!;
    expect(out.guid).toBe('');
    expect(out.key).toBe(KK);
    expect(JSON.stringify(out)).not.toMatch(/"guid":"[0-9a-f]/);
  });

  // The settle keeps SCENE form, so its own live replay puts a node's guid back: a ref to a node the user added (never
  // saved, so it has no template key to derive from) survives the drop and the restore. Mutation: in
  // `captureRowsForSettle`, keep the rows as `templateRowOf` writes them (the guid is gone before the replay).
  it('a Refresh that drops and restores a node keeps the guid of an unsaved node added under it', async () => {
    const n1 = { parentLocalId: 2, guid: '', key: K1, name: 'N1', traits: { EntityAttributes: { name: 'N1' }, Transform: {} }, children: [] };
    const ADDED = 'eeeeeeee-0000-4000-8000-00000000abcd';
    install(midDoc({ added: [n1] }));
    install(innerWith(leafRow()));
    await openInEditor(outer2());
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Added', parentId: inMid('N1')[0]!.id, guid: ADDED }));
    install(midDoc());
    await quietly(() => rebaseStaleInstances());
    install(midDoc({ added: [n1] }));
    await quietly(() => rebaseStaleInstances());
    expect(inMid('Added').map((e) => e.guid)).toEqual([ADDED]);
  });

  // A node whose own guid is a runtime one is captured `guid: ''`, and its durable child must not pass through whole.
  // Mutation: in `templateRowOf`, test only the node's own guid (not `holdsGuid` over its subtree).
  it('a dropped member\'s node with a runtime guid does not carry its child\'s guid into the template', async () => {
    const CG = 'eeeeeeee-0000-4000-8000-0000000000c1';
    install(midDoc());
    install(innerWith(leafRow()));
    const root = await openInEditor(outer2());
    const p = spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'P', parentId: inMid('Leaf')[0]!.id }));
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'C', parentId: p.id(), guid: CG }));
    install(innerWith());
    await quietly(() => rebaseStaleInstances());
    const saved = serializePrefab(root, OUTER2)!;
    expect(JSON.stringify(refNodeOf(saved).members ?? {})).toContain('"C"'); // the node is kept…
    expect(JSON.stringify(saved)).not.toContain(CG); // …without its live guid
  });

  // A scene reference node added under a node the Refresh drops keeps its own member edit, as template rows.
  // Mutations: in `templateRowOf`, leave a scene reference node's `members` to `toTemplateNodes` (which drops them); in
  // `keySceneNodes`, skip a node's `members` (XNode then gets a new key on every save).
  it('a reference node added under a dropped node keeps its member edit', async () => {
    const X = 'aaaaaaaa-0000-4000-8000-000000091538';
    const xDoc = { id: X, version: 6, name: 'X', rootLocalId: 1, entities: [row(1, G(71), 'XRoot', 0), row(2, G(72), 'XKid', 1)] };
    const n1 = { parentLocalId: 2, guid: '', key: K1, name: 'N1', traits: { EntityAttributes: { name: 'N1' }, Transform: {} }, children: [] };
    install(xDoc);
    install(midDoc({ added: [n1] }));
    install(innerWith(leafRow()));
    const root = await openInEditor(outer2());
    const xr = await instantiatePrefabAsync(xDoc as never, inMid('N1')[0]!.id);
    setPrefabSource(xr, X);
    writeTraitFieldWithUndo(all().find((e) => e.name === 'XKid')!.id, getTraitByName('Transform')!, 'x', 9);
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'XNode', parentId: all().find((e) => e.name === 'XKid')!.id, guid: 'eeeeeeee-0000-4000-8000-0000000000d1' }));
    install(midDoc());
    await quietly(() => rebaseStaleInstances());
    const members = JSON.stringify(refNodeOf(serializePrefab(root, OUTER2)!).members ?? {});
    expect(members).toContain('"x":9');
    expect(members).toContain('"XNode"');
    expect(members).not.toMatch(/"guid":"[0-9a-f]/);
    // XNode's key was read while it was live: a second save writes the same bytes.
    expect(JSON.stringify(refNodeOf(serializePrefab(root, OUTER2)!).members ?? {})).toBe(members);
  });

  function panel() { return all().find((e) => e.name === 'Panel')!; }
});

describe('#1567: a rebuild keeps a template-keyed node\'s key', () => {
  const innerPlus = () => ({ ...innerDoc, entities: [...innerDoc.entities, row(4, G(98), 'Extra4', 1)] });
  const innerNoLeaf = () => ({ ...innerDoc, entities: innerDoc.entities.slice(0, 1) });
  const quietly = async <T,>(f: () => Promise<T>): Promise<T> => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { return await f(); } finally { warn.mockRestore(); }
  };
  /** OUTER2 whose INNER row adds nothing: the MID reference node is dropped by the user in the edit world. */
  const bare = () => ({ ...outer2(), entities: [
    row(1, G(21), 'OuterRoot', 0), row(2, G(22), 'Panel', 1), row(5, G(25), 'InnerRow', 2, { prefab: INNER }),
  ] }) as unknown as PrefabFile;
  const innerRoot = () => all().find((e) => e.name === 'InnerRoot' && !under(e.id, 'MidRoot'))!;
  const dropMid = async () => { const r = await instantiatePrefabAsync(midDoc() as never, innerRoot().id); setPrefabSource(r, MID); return r; };
  const midKey = (p: PrefabFile) => (p.entities.find((e) => e.prefab === INNER)!.added ?? []).find((n) => n.prefab === MID)?.key;

  // A5: a reference node the user dropped has a random guid, so nothing can recover its key from it once a rebuild has
  // respawned it without its marker. Mutation: skip the key carry in `rebuildInstance`.
  it('a dropped reference node keeps its key across a Refresh', async () => {
    install(midDoc());
    const root = await openInEditor(bare());
    await dropMid();
    const first = midKey(serializePrefab(root, OUTER2)!);
    expect(first).toBeTruthy();
    install(innerPlus());
    await quietly(() => rebaseStaleInstances());
    expect(midKey(serializePrefab(root, OUTER2)!)).toBe(first);
  });

  // A2: the second Refresh's settle asks `keepsTemplateRows` of the respawned node; unkeyed, it keeps the rows without
  // keys and every save mints a new one for the node inside. Mutation: skip the key carry in `rebuildInstance`.
  it('rows a second Refresh keeps for a dropped node write one key, save after save', async () => {
    const n1 = { parentLocalId: 2, guid: '', key: K1, name: 'N1', traits: { EntityAttributes: { name: 'N1' }, Transform: {} }, children: [] };
    install(midDoc({ added: [n1] }));
    const root = await openInEditor(bare());
    const r = await instantiatePrefabAsync(midDoc({ added: [n1] }) as never, innerRoot().id);
    setPrefabSource(r, MID);
    deriveInstanceMemberGuids(getCurrentWorld());
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Mine', parentId: inMid('N1')[0]!.id, guid: 'eeeeeeee-0000-4000-8000-000000001567' }));
    serializePrefab(root, OUTER2);
    install(innerPlus());
    await quietly(() => rebaseStaleInstances());
    install(midDoc());
    await quietly(() => rebaseStaleInstances());
    expect(inMid('Mine')).toHaveLength(0); // N1 is gone, and its row is kept: unkeyed, N1 read as a scene node and stayed
    const node = () => (serializePrefab(root, OUTER2)!.entities.find((e) => e.prefab === INNER)!.added ?? []).find((n) => n.prefab === MID)!;
    const first = JSON.stringify(node().members ?? {});
    expect(first).toContain('"Mine"');
    expect(first).not.toMatch(/"guid":"[0-9a-f]/);
    expect(JSON.stringify(node().members ?? {})).toBe(first);
  });

  // P4: a node a member row adds, re-homed to the instance root when the template drops that member, keeps its authored
  // key. Its derived guid no longer derives from where it hangs. Mutation: skip the key carry in `rebuildInstance`.
  it('a node re-homed by the re-apply keeps its authored key', async () => {
    const KK = 'dddddddd-0000-4000-8000-000000061567';
    const kid = { parentLocalId: 0, guid: '', key: KK, name: 'Kid', traits: { EntityAttributes: { name: 'Kid' }, Transform: { x: 4 } }, children: [] };
    install(midDoc());
    const root = await openInEditor(outer2({ members: { [`/${G_MID_NESTED}/${G_LEAF}`]: { added: [kid] } } }));
    expect(inMid('Kid')).toHaveLength(1); // precondition
    install(innerNoLeaf());
    await quietly(() => rebaseStaleInstances());
    expect(inMid('Kid')).toHaveLength(1);
    expect(templateKeyOf(entityOf(inMid('Kid')[0]!.id))).toBe(KK);
    const saved = JSON.stringify(serializePrefab(root, OUTER2));
    expect(saved).toContain(KK);
  });

  // The spawn core stamps a key only on a node with no guid; a kept row's node carries both (`keySceneNodes`), and its
  // replay dropped the key, so a user-added node (random guid) minted a new one on the next save.
  // Mutation: in `applyStructureCore`'s spawn, stamp the key only when the node has no guid.
  it('a kept row replayed by a Refresh keeps its node\'s key', async () => {
    const n1 = { parentLocalId: 2, guid: '', key: K1, name: 'N1', traits: { EntityAttributes: { name: 'N1' }, Transform: {} }, children: [] };
    const ADDED = 'eeeeeeee-0000-4000-8000-00000000a567';
    install(midDoc({ added: [n1] }));
    install(innerDoc);
    const root = await openInEditor(outer2());
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Added', parentId: inMid('N1')[0]!.id, guid: ADDED }));
    const keyOfAdded = (p: PrefabFile) => JSON.stringify(refNodeOf(p)).match(/"key":"([^"]+)","name":"Added"|"name":"Added"[^}]*?"key":"([^"]+)"/)?.slice(1).find(Boolean);
    const first = keyOfAdded(serializePrefab(root, OUTER2)!);
    expect(first).toBeTruthy();
    install(midDoc());
    await quietly(() => rebaseStaleInstances());
    install(midDoc({ added: [n1] }));
    await quietly(() => rebaseStaleInstances());
    expect(inMid('Added').map((e) => e.guid)).toEqual([ADDED]);
    expect(templateKeyOf(entityOf(inMid('Added')[0]!.id))).toBe(first);
    expect(keyOfAdded(serializePrefab(root, OUTER2)!)).toBe(first);
  });
});

describe('#1543: a move inside a template reference node is saved', () => {
  /** MID with a second member of its own, so a move of one of the node's DIRECT members has somewhere to go. */
  const midOther = () => ({ ...midDoc(), entities: [...midDoc().entities, row(4, G(14), 'Other', 1)] });
  const reopen = async (saved: PrefabFile) => { install(saved); await openInEditor(saved); };

  // The case #1543 was observed with: Leaf, in MID's own INNER row, moved under MID's Slot.
  // Mutation: in `finishTemplateReferenceNode`, write no `templateMoved`.
  it('a member of a nested frame moved in the prefab editor reloads where it was moved', async () => {
    install(midDoc());
    const root = await openInEditor(outer2());
    reparentEntity(inMid('Leaf')[0]!.id, inMid('Slot')[0]!.id);
    const saved = serializePrefab(root, OUTER2)!;
    expect(refNodeOf(saved).templateMoved).toBeTruthy();
    await reopen(saved);
    expect(nameOf(parentOf(inMid('Leaf')[0]!.id))).toBe('Slot');
  });

  // A move of one of the node's own members, in MID's frame. Mutation: in `finishTemplateReferenceNode`, write no
  // `templateMoved`.
  it('a direct member of the node moved in the prefab editor reloads where it was moved', async () => {
    install(midOther());
    const root = await openInEditor(outer2());
    reparentEntity(inMid('Slot')[0]!.id, inMid('Other')[0]!.id);
    await reopen(serializePrefab(root, OUTER2)!);
    expect(nameOf(parentOf(inMid('Slot')[0]!.id))).toBe('Other');
  });

  // Every expansion of OUTER2 applies the node's move. Mutation: drop the `templateMoved` queue in the runtime
  // spawner (the scene case goes red), or in the editor's (the editor-instantiate case).
  it('each spawner applies the node\'s move', async () => {
    install(midDoc());
    const root = await openInEditor(outer2());
    reparentEntity(inMid('Leaf')[0]!.id, inMid('Slot')[0]!.id);
    const saved = serializePrefab(root, OUTER2)!;
    await eachExpansion(saved, (where) => expect(nameOf(parentOf(inMid('Leaf')[0]!.id)), where).toBe('Slot'));
  });

  // A scene instance of OUTER2 whose node moves Leaf is where the template puts it: its save states no move.
  // Mutation: leave the node's moves out of `prefabMoveTargets`' frames.
  it('an untouched scene instance of OUTER2 states nothing about the node\'s move', async () => {
    install(midDoc());
    const root = await openInEditor(outer2());
    reparentEntity(inMid('Leaf')[0]!.id, inMid('Slot')[0]!.id);
    const saved = serializePrefab(root, OUTER2)!;
    install(saved);
    await load(sceneWith(OUTER2, 'OuterRoot'));
    expect(nameOf(parentOf(inMid('Leaf')[0]!.id))).toBe('Slot'); // precondition
    const scene = await serializeScene();
    const entry = (scene.entities as unknown as Array<Record<string, unknown>>).find((e) => e.prefab === OUTER2)!;
    expect(JSON.stringify(entry)).not.toContain('"parent"');
    expect(entry.nestedStructure).toBeUndefined();
  });

  // A Refresh in the prefab editor respawns the node from the INNER row instance's scene-form capture, whose own moves
  // are measured against the node's: they ride it, or Leaf went back to InnerRoot and the next save dropped the move.
  // Mutation: in `captureNestedRef`, leave `templateMoved` out of the scene-form node.
  it('a Refresh in the prefab editor keeps the node\'s move', async () => {
    install(midDoc());
    const root = await openInEditor(outer2());
    reparentEntity(inMid('Leaf')[0]!.id, inMid('Slot')[0]!.id);
    const saved = serializePrefab(root, OUTER2)!;
    install(saved);
    const again = await openInEditor(saved);
    install({ ...innerDoc, entities: [...innerDoc.entities, row(4, G(98), 'Extra4', 1)] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { await rebaseStaleInstances(); } finally { warn.mockRestore(); }
    expect(inMid('Extra4')).toHaveLength(1); // precondition: the node was rebuilt
    expect(nameOf(parentOf(inMid('Leaf')[0]!.id))).toBe('Slot');
    expect(refNodeOf(serializePrefab(again, OUTER2)!).templateMoved).toEqual(refNodeOf(saved).templateMoved);
  });

  // A Refresh of a scene instance re-expands the node through the EDITOR's spawner, which records its moves too, so the
  // next scene save still states nothing about them. Mutation: in the editor's `spawnNestedInstance`, skip
  // `noteNodeMoves`.
  it('a scene instance refreshed in the editor states nothing about the node\'s move', async () => {
    install(midDoc());
    const root = await openInEditor(outer2());
    reparentEntity(inMid('Leaf')[0]!.id, inMid('Slot')[0]!.id);
    const saved = serializePrefab(root, OUTER2)!;
    install(saved);
    await load(sceneWith(OUTER2, 'OuterRoot'));
    install({ ...saved, entities: [...saved.entities, row(9, G(29), 'Extra', 1)] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { await rebaseStaleInstances(); } finally { warn.mockRestore(); }
    expect(all().filter((e) => e.name === 'Extra')).toHaveLength(1); // precondition: the instance was rebuilt
    expect(nameOf(parentOf(inMid('Leaf')[0]!.id))).toBe('Slot');
    const scene = await serializeScene();
    const entry = (scene.entities as unknown as Array<Record<string, unknown>>).find((e) => e.prefab === OUTER2)!;
    expect(JSON.stringify(entry)).not.toContain('"parent"');
    expect(entry.nestedStructure).toBeUndefined();
  });

  // An untouched save of a file that moves Leaf writes the same move again, not a second one and not none.
  // Mutation: base the node's own moves on its record (`templateMoved`) too — nothing reads as moved, and it is dropped.
  it('an untouched re-save keeps the node\'s move', async () => {
    install(midDoc());
    const root = await openInEditor(outer2());
    reparentEntity(inMid('Leaf')[0]!.id, inMid('Slot')[0]!.id);
    const saved = serializePrefab(root, OUTER2)!;
    install(saved);
    const again = await openInEditor(saved);
    expect(refNodeOf(serializePrefab(again, OUTER2)!).templateMoved).toEqual(refNodeOf(saved).templateMoved);
  });
});

describe('#1543/#1567 close-out review', () => {
  const midOther = () => ({ ...midDoc(), entities: [...midDoc().entities, row(4, G(14), 'Other', 1)] });
  const quietly = async <T,>(f: () => Promise<T>): Promise<T> => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { return await f(); } finally { warn.mockRestore(); }
  };
  const movedOuter2 = async (): Promise<PrefabFile> => {
    install(midDoc());
    const root = await openInEditor(outer2());
    reparentEntity(inMid('Leaf')[0]!.id, inMid('Slot')[0]!.id);
    const saved = serializePrefab(root, OUTER2)!;
    install(saved);
    return saved;
  };

  // The node's OWN frame rebuilt (its prefab MID changed): `instantiatePrefab` records a fresh frame with no node
  // moves, and no spawner runs for the root. Mutation: in `rebuildInstance`, skip carrying the root's `nodeMoved`.
  it('a Refresh of the node\'s own prefab keeps the node\'s move, in the prefab editor', async () => {
    const saved = await movedOuter2();
    const again = await openInEditor(saved);
    install(midOther());
    await quietly(() => rebaseStaleInstances());
    expect(inMid('Other')).toHaveLength(1); // precondition: the node was rebuilt
    expect(nameOf(parentOf(inMid('Leaf')[0]!.id))).toBe('Slot');
    expect(refNodeOf(serializePrefab(again, OUTER2)!).templateMoved).toEqual(refNodeOf(saved).templateMoved);
  });

  // …and in a scene, where losing the record made the next save restate the whole node without the move.
  // Mutation: in `rebuildInstance`, skip carrying the root's `nodeMoved`.
  it('a Refresh of the node\'s own prefab keeps the node\'s move, in a scene', async () => {
    await movedOuter2();
    await load(sceneWith(OUTER2, 'OuterRoot'));
    install(midOther());
    await quietly(() => rebaseStaleInstances());
    expect(inMid('Other')).toHaveLength(1); // precondition
    expect(nameOf(parentOf(inMid('Leaf')[0]!.id))).toBe('Slot');
    const scene = await serializeScene();
    const entry = (scene.entities as unknown as Array<Record<string, unknown>>).find((e) => e.prefab === OUTER2)!;
    expect(JSON.stringify(entry)).not.toContain('"parent"');
    expect(entry.nestedStructure).toBeUndefined();
  });

  // The undo of a Revert rebuilds from the capture taken before it, and the node it brings back was not in that
  // teardown: its key has to travel with the capture. Mutation: in `rebuildInstance`, skip `structure.templateKeys`.
  it('Revert then its undo keeps a dropped reference node\'s key', async () => {
    const bare = { ...outer2(), entities: [
      row(1, G(21), 'OuterRoot', 0), row(2, G(22), 'Panel', 1), row(5, G(25), 'InnerRow', 2, { prefab: INNER }),
    ] } as unknown as PrefabFile;
    const innerRoot = () => all().find((e) => e.name === 'InnerRoot' && !under(e.id, 'MidRoot'))!;
    const midKey = (p: PrefabFile) => (p.entities.find((e) => e.prefab === INNER)!.added ?? []).find((n) => n.prefab === MID)?.key;
    install(midDoc());
    const root = await openInEditor(bare);
    const r = await instantiatePrefabAsync(midDoc() as never, innerRoot().id);
    setPrefabSource(r, MID);
    const first = midKey(serializePrefab(root, OUTER2)!);
    expect(first).toBeTruthy();
    const res = await revertOverridesSelective(innerRoot().id, new Set([`+added.${all().find((e) => e.name === 'MidRoot')!.guid}`]));
    expect(all().filter((e) => e.name === 'MidRoot')).toHaveLength(0); // precondition: reverted
    rebuildInstance(res!.newRootId, res!.source, res!.prefab, res!.fullOverrides, res!.fullStructure);
    expect(all().filter((e) => e.name === 'MidRoot')).toHaveLength(1); // precondition: undone
    expect(midKey(serializePrefab(root, OUTER2)!)).toBe(first);
  });

  // …and of a node the user added INSIDE that reference node: a scene-form reference node keeps its interior in its
  // own `added`, not in `children`. Mutation: in `liveTemplateKeys`, skip `intoReferences`.
  it('Revert then its undo keeps the key of a node added inside a dropped reference node', async () => {
    const bare = { ...outer2(), entities: [
      row(1, G(21), 'OuterRoot', 0), row(2, G(22), 'Panel', 1), row(5, G(25), 'InnerRow', 2, { prefab: INNER }),
    ] } as unknown as PrefabFile;
    const innerRoot = () => all().find((e) => e.name === 'InnerRoot' && !under(e.id, 'MidRoot'))!;
    const kKey = (p: PrefabFile) => JSON.stringify(p).match(/"key":"([^"]+)","name":"K"/)?.[1];
    install(midDoc());
    const root = await openInEditor(bare);
    const r = await instantiatePrefabAsync(midDoc() as never, innerRoot().id);
    setPrefabSource(r, MID);
    deriveInstanceMemberGuids(getCurrentWorld());
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'K', parentId: inMid('Slot')[0]!.id, guid: 'eeeeeeee-0000-4000-8000-00000000c567' }));
    const first = kKey(serializePrefab(root, OUTER2)!);
    expect(first).toBeTruthy();
    const res = await revertOverridesSelective(innerRoot().id, new Set([`+added.${all().find((e) => e.name === 'MidRoot')!.guid}`]));
    rebuildInstance(res!.newRootId, res!.source, res!.prefab, res!.fullOverrides, res!.fullStructure);
    expect(inMid('K')).toHaveLength(1); // precondition: undone
    expect(kKey(serializePrefab(root, OUTER2)!)).toBe(first);
  });
});

describe('#1568: prefab-edit Refresh R2 gaps', () => {
  const quietly = async <T,>(f: () => Promise<T>): Promise<T> => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { return await f(); } finally { warn.mockRestore(); }
  };
  const n1 = { parentLocalId: 2, guid: '', key: K1, name: 'N1', traits: { EntityAttributes: { name: 'N1' }, Transform: {} }, children: [] };
  const innerWith = (...extra: ReturnType<typeof row>[]) => ({ ...innerDoc, entities: [innerDoc.entities[0]!, ...extra] });
  const leafRow = () => row(2, G_LEAF, 'Leaf', 1, {}, { UIAction: {}, UIFocusable: {} });
  /** OUTER2 whose INNER row adds nothing: no MID anywhere until the user drops one in. */
  const bare = () => ({ ...outer2(), entities: [
    row(1, G(21), 'OuterRoot', 0), row(2, G(22), 'Panel', 1), row(5, G(25), 'InnerRow', 2, { prefab: INNER }),
  ] }) as unknown as PrefabFile;

  // A3: a row dropped in this session has no row sentinel, and the re-emit gate read the sentinel alone, so the orphan
  // row a Refresh kept for it never reached the save. Mutation: in `isPrefabEditRow`, test the sentinel guid only.
  it('a row added in this session keeps the edit to a node its template drops', async () => {
    install(midDoc({ added: [n1] }));
    const root = await openInEditor(bare());
    const r = await instantiatePrefabAsync(midDoc({ added: [n1] }) as never, all().find((e) => e.name === 'OuterRoot')!.id);
    setPrefabSource(r, MID);
    deriveInstanceMemberGuids(getCurrentWorld());
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Kid', parentId: all().find((e) => e.name === 'N1')!.id, guid: 'eeeeeeee-0000-4000-8000-000000001568' }));
    install(midDoc());
    await quietly(() => rebaseStaleInstances());
    expect(all().filter((e) => e.name === 'Kid')).toHaveLength(0); // precondition: N1 is gone, and Kid with it
    const midRow = serializePrefab(root, OUTER2)!.entities.find((e) => e.prefab === MID)!;
    const rows = JSON.stringify(midRow.members ?? {});
    expect(rows).toContain('"Kid"');
    expect(rows).not.toMatch(/"guid":"[0-9a-f]/); // template form: no live guid
    // …and it comes back with N1.
    install(midDoc({ added: [n1] }));
    await quietly(() => rebaseStaleInstances());
    expect(all().filter((e) => e.name === 'Kid')).toHaveLength(1);
  });

  // C2: a node with a runtime guid is captured with none, so the settle could not see that the re-apply had re-homed it,
  // kept it in the orphan row too, and the restore spawned it — and its durable child — a second time.
  // Mutation: in `captureRowsForSettle`'s `unhomed`, drop the guid-less clause.
  it('a runtime-guid node the re-apply re-homed is not spawned again when its member comes back', async () => {
    const CG = 'eeeeeeee-0000-4000-8000-0000000000c2';
    install(midDoc());
    install(innerWith(leafRow()));
    await openInEditor(outer2());
    const p = spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'P', parentId: inMid('Leaf')[0]!.id }));
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'C', parentId: p.id(), guid: CG }));
    install(innerWith());
    await quietly(() => rebaseStaleInstances());
    expect(inMid('P')).toHaveLength(1); // precondition: re-homed, not lost
    install(innerWith(leafRow()));
    await quietly(() => rebaseStaleInstances());
    expect(inMid('P')).toHaveLength(1);
    expect(all().filter((e) => e.guid === CG)).toHaveLength(1);
  });
  // …but a node under a nested ROOT is not re-homed when the template drops that nested row: it dies with the instance,
  // and only its kept row brings it back. Its frame key is the outer frame's (always live), so the rule has to know the
  // row names a frame root. Mutation: in `captureRowsForSettle`'s `unhomed`, drop the `frameRootKeys` test.
  it('a runtime-guid node under a nested root the template drops comes back with it, in a scene and in the prefab editor', async () => {
    const midNoNested = () => ({ ...midDoc(), entities: midDoc().entities.slice(0, 2) });
    const dropAndRestore = async (innerRoot: () => { id: number }) => {
      spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'P', parentId: innerRoot().id }));
      install(midNoNested());
      await quietly(() => rebaseStaleInstances());
      expect(all().filter((e) => e.name === 'P')).toHaveLength(0); // precondition: gone with the nested instance
      install(midDoc());
      await quietly(() => rebaseStaleInstances());
      expect(all().filter((e) => e.name === 'P')).toHaveLength(1);
    };
    install(midDoc());
    await load(sceneWith(MID, 'MidRoot'));
    await dropAndRestore(() => all().find((e) => e.name === 'InnerRoot')!);
    clearKeptMemberOrphans();
    install(midDoc());
    await openInEditor(outer2());
    await dropAndRestore(() => inMid('InnerRoot')[0]!);
  });
});

describe('#1564: an Apply that renumbers member paths re-points every carrier', () => {
  const quietly = async <T,>(f: () => Promise<T>): Promise<T> => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { return await f(); } finally { warn.mockRestore(); error.mockRestore(); }
  };
  /** OUTER2 with a second row, Other, that Panel can be moved under: Panel's path goes 2 → 3.2. */
  const withOther = () => ({ ...outer2(), entities: [...outer2().entities, row(3, G(23), 'Other', 1)] }) as unknown as PrefabFile;
  const byName = (name: string) => all().find((e) => e.name === name)!;
  /** Save `edit`'s result, load it in a scene, move Panel under Other and apply that move: the OUTER2 it writes. */
  const applyPanelMove = async (edit: () => void): Promise<PrefabFile> => {
    install(midDoc());
    const root = await openInEditor(withOther());
    edit();
    install(serializePrefab(root, OUTER2)!);
    await load(sceneWith(OUTER2, 'OuterRoot'));
    reparentEntity(byName('Panel').id, byName('Other').id);
    const { moved } = collectInstanceOverrideKeys(byName('OuterRoot').id, prefabs.get(OUTER2) as PrefabFile);
    expect(moved).toHaveLength(1); // precondition: the one move, Panel's
    const res = await quietly(() => applyToPrefabSelective(byName('OuterRoot').id, new Set(moved)));
    expect(res.memberPathsChanged).toBe(true);
    return JSON.parse(writes.filter((w) => w.content.includes(OUTER2)).pop()!.content) as PrefabFile;
  };

  // A token inside a template reference node that climbs out of it to the prefab around it. Mutation: in
  // `rewritePrefabMemberTokens`' `addedIn`, return a reference node as it is.
  it('a reference node\'s climbing token follows the member it names', async () => {
    const written = await applyPanelMove(() => writeTraitFieldWithUndo(inMid('Leaf')[0]!.id, getTraitByName('UIFocusable')!, 'navUp', byName('Panel').guid!));
    expect(refNodeOf(written).nestedOverrides).toEqual({ 3: { 2: { UIFocusable: { navUp: '@member:^.^.^.3.2' } } } });
  });

  // A nested row's member row (prefab v6, #1533) holds tokens like any payload: a node the MID row adds under Leaf in
  // MID's own INNER frame, keyed `/<MidNested>/<Leaf>` and read in that frame. Mutation: in `framePayload`, skip
  // `members`.
  it('a member row\'s token follows the member it names', async () => {
    const midRow = () => row(6, G(26), 'MidRow', 1, { prefab: MID });
    const withMidRow = () => ({ ...withOther(), entities: [...withOther().entities, midRow()] }) as unknown as PrefabFile;
    /** The Leaf in the MID row: not under Panel, which holds the INNER row and its node. */
    const midRowLeaf = () => all().find((e) => e.name === 'Leaf' && !under(e.id, 'Panel'))!;
    install(midDoc());
    const root = await openInEditor(withMidRow());
    spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'Tag', parentId: midRowLeaf().id }), getTraitByName('UIFocusable')!.trait({ navUp: byName('Panel').guid! } as never));
    const saved = serializePrefab(root, OUTER2)!;
    const rowOf = (p: PrefabFile) => p.entities.find((e) => e.prefab === MID)!;
    expect(JSON.stringify(rowOf(saved).members ?? {})).toContain('"navUp":"@member:^.^.2"'); // precondition
    install(saved);
    await load(sceneWith(OUTER2, 'OuterRoot'));
    reparentEntity(byName('Panel').id, byName('Other').id);
    const { moved } = collectInstanceOverrideKeys(byName('OuterRoot').id, prefabs.get(OUTER2) as PrefabFile);
    await quietly(() => applyToPrefabSelective(byName('OuterRoot').id, new Set(moved)));
    const written = JSON.parse(writes.filter((w) => w.content.includes(OUTER2)).pop()!.content) as PrefabFile;
    expect(JSON.stringify(rowOf(written).members ?? {})).toContain('"navUp":"@member:^.^.3.2"');
  });

  // The repair of the OTHER files: MID renumbers MidNested (2.3 → 3), and OUTER2's node states a move by path in MID's
  // frame. Mutation: in `framePayload`, skip `templateMoved`.
  it('a reference node\'s templateMoved follows a renumbered prefab on disk', () => {
    const outer = { ...outer2({ templateMoved: { '2.3.2': '@member:2' } }) } as unknown as Record<string, unknown>;
    const midNew = { ...midDoc(), entities: [...midDoc().entities.slice(0, 2), row(3, G_MID_NESTED, 'MidNested', 1, { prefab: INNER })] };
    const read = (mid: object) => (g: string) => (g === MID ? mid : g === OUTER2 ? outer : prefabs.get(g));
    const out = rewritePrefabMemberTokens(outer, OUTER2, read(midDoc()), read(midNew)) as unknown as PrefabFile;
    expect(refNodeOf(out).templateMoved).toEqual({ '3.2': '@member:2' });
  });

  // A member row keyed by the frame ROOT's own nodeGuid hangs its nodes at the frame itself, as `memberPathRecords`
  // does; named one level below, a reference node in it matched nothing and kept a stale path. No writer emits this
  // shape today (a frame root's nodes go in legacy `added`), but the loader reads it. Mutation: in `membersIn`, drop
  // the root case of `at`.
  it('a reference node in a member row keyed by the frame root follows a renumbered prefab', () => {
    const node = { key: KREF, guid: '', name: 'MidRoot', prefab: MID, traits: {}, children: [], templateMoved: { '2.3.2': '@member:2' } };
    const outer = { ...outer2(), entities: [
      row(1, G(21), 'OuterRoot', 0), row(2, G(22), 'Panel', 1), row(5, G(25), 'InnerRow', 2, { prefab: INNER, members: { [`/${G(1)}`]: { own: [node] } } }),
    ] } as unknown as Record<string, unknown>;
    const midNew = { ...midDoc(), entities: [...midDoc().entities.slice(0, 2), row(3, G_MID_NESTED, 'MidNested', 1, { prefab: INNER })] };
    const read = (mid: object) => (g: string) => (g === MID ? mid : g === OUTER2 ? outer : prefabs.get(g));
    const out = rewritePrefabMemberTokens(outer, OUTER2, read(midDoc()), read(midNew)) as unknown as PrefabFile;
    const rows = out.entities.find((e) => e.prefab === INNER)!.members as Record<string, { own: Array<{ templateMoved: unknown }> }>;
    expect(rows[`/${G(1)}`]!.own[0]!.templateMoved).toEqual({ '3.2': '@member:2' });
  });

  // The live record of the node's moves: an Apply to MID rebuilds the node's root, whose carry re-queued the stale path.
  // Mutation: in `applyToPrefabSelective`, skip `rewriteNodeMoves`.
  it('a reference node\'s move survives an Apply that renumbers its prefab, live and on save', async () => {
    install(midDoc());
    const first = await openInEditor(outer2());
    reparentEntity(inMid('Leaf')[0]!.id, inMid('Slot')[0]!.id);
    const saved = serializePrefab(first, OUTER2)!;
    expect(refNodeOf(saved).templateMoved).toEqual({ '2.3.2': '@member:2' }); // precondition
    const root = await openInEditor(saved);
    reparentEntity(all().find((e) => e.name === 'InnerRoot' && under(e.id, 'MidRoot'))!.id, byName('MidRoot').id);
    const { moved } = collectInstanceOverrideKeys(byName('MidRoot').id, prefabs.get(MID) as PrefabFile);
    const res = await quietly(() => applyToPrefabSelective(byName('MidRoot').id, new Set(moved)));
    expect(res.memberPathsChanged).toBe(true); // precondition: MidNested moved from 2.3 to 3
    expect(nameOf(parentOf(inMid('Leaf')[0]!.id))).toBe('Slot');
    expect(refNodeOf(serializePrefab(root, OUTER2)!).templateMoved).toEqual({ '3.2': '@member:2' });
  });

  // …and its undo puts the record back: a Persistent or base root is CARRIED across the undo's world swap with its
  // record whole, then rebased onto the restored MID. Modelled without the swap — the carry copies the record verbatim
  // (`SceneManager`'s `carriedFrameDocs`) — and with the rebase the swap is followed by.
  // Mutation: in `restoreSnapshot`, skip `rewriteNodeMoves`.
  it('its undo puts the live move record back on the restored paths', async () => {
    install(midDoc());
    const first = await openInEditor(outer2());
    reparentEntity(inMid('Leaf')[0]!.id, inMid('Slot')[0]!.id);
    const saved = serializePrefab(first, OUTER2)!;
    const root = await openInEditor(saved);
    reparentEntity(all().find((e) => e.name === 'InnerRoot' && under(e.id, 'MidRoot'))!.id, byName('MidRoot').id);
    const { moved } = collectInstanceOverrideKeys(byName('MidRoot').id, prefabs.get(MID) as PrefabFile);
    const res = await quietly(() => applyToPrefabWithUndo(byName('MidRoot').id, new Set(moved)));
    expect(res.memberPathsChanged).toBe(true); // precondition
    await quietly(() => undo());
    expect(prefabs.get(MID) ?? null).not.toBeNull();
    await quietly(() => rebaseStaleInstances());
    expect(nameOf(parentOf(all().find((e) => e.name === 'InnerRoot' && under(e.id, 'MidRoot'))!.id))).toBe('Slot'); // precondition: MID restored
    expect(nameOf(parentOf(inMid('Leaf')[0]!.id))).toBe('Slot');
    expect(refNodeOf(serializePrefab(root, OUTER2)!).templateMoved).toEqual({ '2.3.2': '@member:2' });
  });
});
