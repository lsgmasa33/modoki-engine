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
  setPrefabCache, instantiatePrefab, serializePrefab, applyToPrefabSelective, ownInstanceStructure, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { buildPrefabEditScene, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { templateKeysOf } from '../../packages/modoki/src/runtime/loaders/templateKeyRecovery';
import { clearKeptMemberOrphans, deriveInstanceMemberGuids } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
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
