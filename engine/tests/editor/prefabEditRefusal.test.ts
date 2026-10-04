/** #1817, #1836 — the ONE prefab-edit refusal (`prefabEditRefusal.ts`), asked inside each forward choke point, and the
 *  two guards behind it: the save's whole-document I16 check and the expansion's cycle stack through reference nodes.
 *
 *  Each gesture is driven through the REAL choke point (`deleteEntitiesWithUndo`, `planReparent`/`reparentEntity`,
 *  `createEntityWithUndo`, `duplicateEntity`, `pasteEntityCopy`, `instantiatePrefabInstance`) and the agent ops that
 *  reach them, refused AND accepted. The world is a prefab-edit world because the loaded scene says so (the ground truth
 *  `prefabEditWorldPath` reads), with the root on its sentinel guid, as `openPrefabForEditing` builds it.
 *
 *  Mutations, each checked (results in the close-out report):
 *  - `prefabEditRefusal` returns null for `delete` → the root / stage delete cases go red;
 *  - drop the `reparent` branch → the root-move and move-out cases go red;
 *  - drop the `outside-root` check in `add` → the top-level create / duplicate-the-root / paste / drop cases go red;
 *  - drop the `self-nesting` check → the self-drop, transitive-drop and self-paste cases go red;
 *  - drop the ask in one choke point → that choke point's case goes red;
 *  - drop the whole-document check in `serializePrefab` → both save cases go red;
 *  - drop the `members` walk in `expandedPrefabRefs` → the two-frames-down save case (a member row's `own`) and the load
 *    cases go red;
 *  - pass `undefined` for the stack in `spawnReferenceNode` (the one spawner, #1783) → the two-file loop case goes red;
 *  - carry every ancestor across a reference node (not only self-containing ones) → the legal-nesting case goes red. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';

const prefabs = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));
/** The loaded scene's path — a prefab-edit world's synthetic `/__prefab-edit__/<guid>`, or a real scene's. */
const loaded = vi.hoisted(() => ({ path: '' }));
vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', async (importOriginal) => {
  const mod = await importOriginal<{ sceneManager: object }>();
  const real = mod.sceneManager as Record<string | symbol, unknown>;
  return {
    ...mod,
    sceneManager: new Proxy(real, {
      get(target, key) {
        if (key === 'getCurrent') return () => (loaded.path ? { path: loaded.path } : null);
        const v = Reflect.get(target, key);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }),
  };
});

import { getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, spawnEntity, instantiatePrefabIntoWorld } from '@modoki/engine/runtime';
import {
  deleteEntitiesWithUndo, duplicateEntity, reparentEntity, planReparent, createEntityWithUndo, clearHistory, canUndo,
} from '@modoki/engine/editor';
import { pasteEntityCopy, clipEntity } from '../../packages/modoki/src/editor/undo/entityActions';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache, setPrefabSource } from '../../packages/modoki/src/editor/scene/prefabCache';
import { instantiatePrefab, instantiatePrefabInstance } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { serializePrefab } from '../../packages/modoki/src/editor/scene/prefabSerialize';
import { PrefabEditRefusalError, PREFAB_EDIT_REFUSAL_TEXT, prefabEditRefusal } from '../../packages/modoki/src/editor/scene/prefabEditRefusal';
import { PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEditGuids';
import { commitPrefabWrite, commitPrefabWrites } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { makePrefabInstantiateAction } from '../../packages/modoki/src/editor/undo/prefabInstantiateUndo';
import { UndoRefusedError } from '../../packages/modoki/src/editor/undo/undoFailure';
import { emptySpecs } from '../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { opReplyFor } from '../../app/debug/opRefusal';

registerAllTraits();
registerEditorAgentOps();

const EDITED = 'aaaaaaaa-0000-4000-8000-000000001817';
const INNER = 'aaaaaaaa-0000-4000-8000-000000001818';
const HOLDS_EDITED = 'aaaaaaaa-0000-4000-8000-000000001819';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000001820';
const LIGHT_GUID = 'eeeeeeee-0000-4000-8000-000000001836';
const CHILD_GUID = 'eeeeeeee-0000-4000-8000-000000001837';

let nextNode = 0;
const nodeGuid = () => `dddddddd-0000-4000-8000-${String(++nextNode).padStart(12, '0')}`;
const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, nodeGuid: nodeGuid(), ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const doc = (id: string, name: string, entities: unknown[]): PrefabFile => ({ id, name, version: 8, rootLocalId: 1, entities } as unknown as PrefabFile);

const innerDoc = doc(INNER, 'Inner', [row(1, 'InnerRoot', 0), row(2, 'InnerLeaf', 1)]);
const editedDoc = doc(EDITED, 'Edited', [row(1, 'EditedRoot', 0), row(2, 'Nested', 1, { prefab: INNER })]);
const holdsEditedDoc = doc(HOLDS_EDITED, 'HoldsEdited', [row(1, 'HolderRoot', 0), row(2, 'HeldEdited', 1, { prefab: EDITED })]);
const otherDoc = doc(OTHER, 'Other', [row(1, 'OtherRoot', 0)]);

function install(...docs: PrefabFile[]): void {
  for (const d of docs) { prefabs.set(d.id!, d); setPrefabCache(d.id!, d); }
}

const ea = () => getTraitByName('EntityAttributes')!;
const tf = () => getTraitByName('Transform')!;
function spawn(name: string, parentId: number, guid = ''): number {
  return spawnEntity(getCurrentWorld(), ea().trait({ name, parentId, guid }), tf().trait({})).id();
}
const byName = (name: string) => getAllEntities().filter((e) => e.name === name);
const idOf = (name: string) => byName(name)[0]!.id;
const noSelect = () => {};

/** A prefab-edit world of EDITED, as `openPrefabForEditing` builds it: scaffolds at the top level, the root on its
 *  sentinel guid, a child and a grandchild. `stage` puts the root under a 2D stage scaffold, as a 2D template's is. */
function editWorld(opts: { stage?: boolean } = {}): { root: number; child: number; grandchild: number; light: number; stage?: number } {
  loaded.path = `/__prefab-edit__/${EDITED}`;
  const light = spawn('__PrefabEditLight', 0, LIGHT_GUID);
  const stage = opts.stage ? spawn('__PrefabEditStage', 0) : undefined;
  const root = spawn('EditedRoot', stage ?? 0, PREFAB_EDIT_ROOT_GUID);
  const child = spawn('Child', root, CHILD_GUID);
  const grandchild = spawn('Grandchild', child);
  return { root, child, grandchild, light, stage };
}

function refusalOf(gesture: () => unknown): string | null {
  try { gesture(); return null; } catch (e) { if (e instanceof PrefabEditRefusalError) return e.reason; throw e; }
}

beforeEach(() => {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  clearHistory();
  prefabs.clear();
  loaded.path = '';
  install(innerDoc, editedDoc, holdsEditedDoc, otherDoc);
});
afterEach(() => { loaded.path = ''; vi.restoreAllMocks(); });

describe('prefab edit: the root is never deleted (#1836)', () => {
  it('refuses a delete of the root, and deletes nothing', () => {
    const w = editWorld();
    expect(refusalOf(() => deleteEntitiesWithUndo([w.root]))).toBe('root-removed');
    expect(byName('EditedRoot')).toHaveLength(1);
    expect(byName('Grandchild')).toHaveLength(1);
    expect(canUndo()).toBe(false);
  });

  it('refuses a delete of the 2D stage above the root, which would take the root with it', () => {
    const w = editWorld({ stage: true });
    expect(refusalOf(() => deleteEntitiesWithUndo([w.stage!]))).toBe('root-removed');
    expect(byName('EditedRoot')).toHaveLength(1);
  });

  it('refuses the root inside a multi-selection too', () => {
    const w = editWorld();
    expect(refusalOf(() => deleteEntitiesWithUndo([w.grandchild, w.root]))).toBe('root-removed');
    expect(byName('Grandchild')).toHaveLength(1);
  });

  it('accepts a delete of a child of the root, and of a scaffold', () => {
    const w = editWorld();
    expect(refusalOf(() => deleteEntitiesWithUndo([w.child]))).toBeNull();
    expect(byName('Child')).toHaveLength(0);
    expect(refusalOf(() => deleteEntitiesWithUndo([w.light]))).toBeNull();
    expect(byName('__PrefabEditLight')).toHaveLength(0);
  });

  it('allows the root delete in a real scene: the rule is prefab edit only', () => {
    const w = editWorld();
    loaded.path = '/games/x/scenes/Main.scene.json';
    expect(refusalOf(() => deleteEntitiesWithUndo([w.root]))).toBeNull();
  });
});

describe('prefab edit: the root does not move, and nothing leaves it (#1836)', () => {
  it('refuses a move of the root under another top-level entity', () => {
    const w = editWorld();
    expect(planReparent(w.root, w.light)).toEqual({ kind: 'refused', reason: 'root-moved' });
    expect(reparentEntity(w.root, w.light)).toBe(false);
    expect(getAllEntities().find((e) => e.id === w.root)!.parentId).toBe(0);
  });

  it('accepts the root staying where it is (a reorder among its siblings)', () => {
    const w = editWorld();
    expect(planReparent(w.root, 0).kind).not.toBe('refused');
  });

  it('refuses a move of one of the root\'s entities to the top level, or under a scaffold', () => {
    const w = editWorld();
    expect(planReparent(w.child, 0)).toEqual({ kind: 'refused', reason: 'outside-root' });
    expect(planReparent(w.grandchild, w.light)).toEqual({ kind: 'refused', reason: 'outside-root' });
    expect(reparentEntity(w.grandchild, 0)).toBe(false);
    expect(getAllEntities().find((e) => e.id === w.grandchild)!.parentId).toBe(w.child);
  });

  it('accepts a move within the root', () => {
    const w = editWorld();
    expect(planReparent(w.grandchild, w.root)).toEqual({ kind: 'same-scene' });
    expect(reparentEntity(w.grandchild, w.root)).toBe(true);
    expect(getAllEntities().find((e) => e.id === w.grandchild)!.parentId).toBe(w.root);
  });
});

describe('prefab edit: exactly one top-level entity, the root (#1836 widening)', () => {
  it('refuses a create at the top level, and accepts one under the root', () => {
    const w = editWorld();
    expect(refusalOf(() => createEntityWithUndo('Create', 0, emptySpecs(0).specs, noSelect))).toBe('outside-root');
    expect(refusalOf(() => createEntityWithUndo('Create', w.light, emptySpecs(w.light).specs, noSelect))).toBe('outside-root');
    expect(canUndo()).toBe(false);
    const before = getAllEntities().length;
    expect(refusalOf(() => createEntityWithUndo('Create', w.root, emptySpecs(w.root).specs, noSelect))).toBeNull();
    expect(getAllEntities().length).toBe(before + 1);
  });

  it('refuses a duplicate of the root (it would land beside it), and accepts one of a child', () => {
    const w = editWorld();
    const before = getAllEntities().length;
    expect(refusalOf(() => duplicateEntity(w.root, noSelect))).toBe('outside-root');
    expect(getAllEntities().length).toBe(before);
    expect(refusalOf(() => duplicateEntity(w.child, noSelect))).toBeNull();
    expect(byName('Child')).toHaveLength(2);
  });

  it('refuses a paste at the top level, and accepts one under the root', () => {
    const w = editWorld();
    const clip = clipEntity(w.grandchild, 'copy')!;
    expect(refusalOf(() => pasteEntityCopy(clip, 0, noSelect))).toBe('outside-root');
    expect(byName('Grandchild')).toHaveLength(1);
    expect(refusalOf(() => pasteEntityCopy(clip, w.root, noSelect))).toBeNull();
    expect(byName('Grandchild')).toHaveLength(2);
  });

  it('refuses a prefab placed at the top level, and places it under the root', async () => {
    const w = editWorld();
    await expect(instantiatePrefabInstance(otherDoc, OTHER, 0)).rejects.toBeInstanceOf(PrefabEditRefusalError);
    expect(byName('OtherRoot')).toHaveLength(0);
    const id = await instantiatePrefabInstance(otherDoc, OTHER, w.root);
    expect(id).toBeGreaterThan(0);
    expect(byName('OtherRoot')).toHaveLength(1);
  });
});

describe('prefab edit: the scaffolding stays out of the root (close-out review)', () => {
  it('refuses a scaffold moved into the root, where the save would write it into the prefab', () => {
    const w = editWorld();
    expect(planReparent(w.light, w.root)).toEqual({ kind: 'refused', reason: 'scaffold' });
    expect(planReparent(w.light, w.grandchild)).toEqual({ kind: 'refused', reason: 'scaffold' });
    expect(reparentEntity(w.light, w.child)).toBe(false);
    expect(getAllEntities().find((e) => e.id === w.light)!.parentId).toBe(0);
  });

  it('refuses a paste of a copied scaffold under the root', () => {
    const w = editWorld();
    const clip = clipEntity(w.light, 'copy')!;
    expect(refusalOf(() => pasteEntityCopy(clip, w.root, noSelect))).toBe('scaffold');
    expect(byName('__PrefabEditLight')).toHaveLength(1);
  });

  it('accepts an authored entity stranded outside the root being moved in — its rescue, not scaffolding', () => {
    const w = editWorld();
    const stray = spawn('Stray', 0);
    expect(planReparent(stray, w.root)).toEqual({ kind: 'same-scene' });
  });

  it('the agent is told the scaffold reason, in the editor\'s words', async () => {
    editWorld();
    await expect(runAgentOp('reparent-entity', { guid: LIGHT_GUID, parentGuid: PREFAB_EDIT_ROOT_GUID })).rejects.toThrow(PREFAB_EDIT_REFUSAL_TEXT.scaffold);
  });

  it('accepts a scaffold moved among the scaffolds', () => {
    const w = editWorld({ stage: true });
    expect(planReparent(w.light, w.stage!).kind).not.toBe('refused');
  });
});

describe('prefab edit: nothing nests the edited prefab in itself (#1817)', () => {
  it('refuses a duplicate of a node holding an instance of the edited prefab (a legacy self-containing file shows one)', () => {
    const w = editWorld();
    // Placed with the gesture bypassed, as a self-containing file's load leaves one level of it in the edit world.
    const held = instantiatePrefab(holdsEditedDoc, w.child);
    setPrefabSource(held, holdsEditedDoc);
    const before = getAllEntities().length;
    expect(refusalOf(() => duplicateEntity(held, noSelect))).toBe('self-nesting');
    expect(getAllEntities().length).toBe(before);
  });

  it('refuses a drop of the edited prefab — under a nested member, as the fuzzer found it — and spawns nothing', async () => {
    const w = editWorld();
    const nestedLeaf = await instantiatePrefabInstance(innerDoc, INNER, w.child).then(() => idOf('InnerLeaf'));
    const err = await instantiatePrefabInstance(editedDoc, EDITED, nestedLeaf).catch((e) => e);
    expect(err).toBeInstanceOf(PrefabEditRefusalError);
    expect((err as PrefabEditRefusalError).reason).toBe('self-nesting');
    expect(byName('EditedRoot')).toHaveLength(1); // the edit root only
  });

  it('refuses a drop of a prefab that contains the edited one', async () => {
    const w = editWorld();
    const err = await instantiatePrefabInstance(holdsEditedDoc, HOLDS_EDITED, w.child).catch((e) => e);
    expect((err as PrefabEditRefusalError).reason).toBe('self-nesting');
    expect(byName('HolderRoot')).toHaveLength(0);
  });

  it('refuses a paste of a copy holding an instance of the edited prefab (a clipboard from a scene)', () => {
    // Copied in a real scene, pasted in the edit world: the clipboard outlives the world.
    const src = instantiatePrefab(editedDoc, 0);
    setPrefabSource(src, editedDoc);
    const clip = clipEntity(src, 'copy')!;
    const w = editWorld();
    expect(refusalOf(() => pasteEntityCopy(clip, w.child, noSelect))).toBe('self-nesting');
  });

  it('accepts a drop of an unrelated prefab under a nested member', async () => {
    const w = editWorld();
    await instantiatePrefabInstance(innerDoc, INNER, w.child);
    expect(await instantiatePrefabInstance(otherDoc, OTHER, idOf('InnerLeaf'))).toBeGreaterThan(0);
  });
});

describe('the agent ops answer the refusal as REFUSED_BY_OP, in the editor\'s words', () => {
  const reply = async (op: string, params: unknown) => (await opReplyFor(() => runAgentOp(op, params))) as { result?: { ok?: boolean; code?: string; error?: string } };

  it('delete-entities of the root', async () => {
    editWorld();
    const r = await reply('delete-entities', { guids: [PREFAB_EDIT_ROOT_GUID] });
    expect(r.result).toMatchObject({ ok: false, code: 'REFUSED_BY_OP' });
    expect(r.result!.error).toContain(PREFAB_EDIT_REFUSAL_TEXT['root-removed']);
    expect(byName('EditedRoot')).toHaveLength(1);
  });

  it('apply-scene-ops removeEntity of the root names nothing as deleted, and mints nothing (close-out review)', async () => {
    const w = editWorld();
    const guidBefore = getAllEntities().find((e) => e.id === w.grandchild)!.guid;
    const r = await reply('apply-scene-ops', { ops: [{ op: 'removeEntity', entity: { guid: PREFAB_EDIT_ROOT_GUID } }] }) as { result?: { alsoDeleted?: string[]; errors?: string[] } };
    expect(r.result?.errors?.[0]).toContain(PREFAB_EDIT_REFUSAL_TEXT['root-removed']);
    expect(r.result?.alsoDeleted ?? []).toEqual([]);
    expect(getAllEntities().find((e) => e.id === w.grandchild)!.guid).toBe(guidBefore); // no durable guid minted
  });

  it('delete-entities of the root mints no guid on what it refused to delete', async () => {
    const w = editWorld();
    // The grandchild holds only a runtime guid: the reply's descendant naming would mint it a durable one.
    const guidBefore = getAllEntities().find((e) => e.id === w.grandchild)!.guid;
    await reply('delete-entities', { guids: [PREFAB_EDIT_ROOT_GUID] });
    expect(getAllEntities().find((e) => e.id === w.grandchild)!.guid).toBe(guidBefore);
  });

  it('create-entity with no parent, and under the root', async () => {
    editWorld();
    const r = await reply('create-entity', { spec: { kind: 'empty' } });
    expect(r.result).toMatchObject({ ok: false, code: 'REFUSED_BY_OP' });
    expect(r.result!.error).toContain(PREFAB_EDIT_REFUSAL_TEXT['outside-root']);
    const ok = await reply('create-entity', { spec: { kind: 'empty' }, parentGuid: PREFAB_EDIT_ROOT_GUID });
    expect(ok.result?.ok).not.toBe(false);
  });

  it('reparent-entity of the root, and of a child to the top level', async () => {
    editWorld();
    await expect(runAgentOp('reparent-entity', { guid: PREFAB_EDIT_ROOT_GUID, parentGuid: LIGHT_GUID })).rejects.toThrow(PREFAB_EDIT_REFUSAL_TEXT['root-moved']);
    await expect(runAgentOp('reparent-entity', { guid: CHILD_GUID, parentId: 0 })).rejects.toThrow(PREFAB_EDIT_REFUSAL_TEXT['outside-root']);
  });

  // #1816: set-traits' parent write reaches the same refusal through `planReparent`, with no check of its own.
  // Two layers ask it (the writer's pre-check, and `writeTraitAsEditor` per trait), so the mutation is both: null
  // `editorTraitWriter.refusal` AND write the parent as a plain field in `writeTraitAsEditor` — the root moves.
  it('set-traits of the root\'s parent, and of a child to the top level', async () => {
    const w = editWorld();
    const root = await runAgentOp('set-traits', { guid: PREFAB_EDIT_ROOT_GUID, set: { 'EntityAttributes.parentId': w.light } }) as { ok: boolean; error?: string };
    expect(root.ok).toBe(false);
    expect(root.error).toContain(PREFAB_EDIT_REFUSAL_TEXT['root-moved']);
    const child = await runAgentOp('set-traits', { guid: CHILD_GUID, set: { 'EntityAttributes.parentId': 0 } }) as { ok: boolean; error?: string };
    expect(child.ok).toBe(false);
    expect(child.error).toContain(PREFAB_EDIT_REFUSAL_TEXT['outside-root']);
    expect(getAllEntities().find((e) => e.id === w.root)!.parentId).toBe(0);
    expect(getAllEntities().find((e) => e.id === w.child)!.parentId).toBe(w.root);
    // Accept side: a field write inside the root lands.
    const ok = await runAgentOp('set-traits', { guid: CHILD_GUID, set: { 'Transform.x': 2 } }) as { ok: boolean };
    expect(ok.ok).toBe(true);
  });
});

describe('a placement\'s redo that meets the refusal is dropped as refused, not reported as a throw (close-out review)', () => {
  it('maps PrefabEditRefusalError from the respawn to UndoRefusedError', async () => {
    const w = editWorld();
    const act = makePrefabInstantiateAction({
      label: 'Instantiate', initialId: w.child,
      respawn: async () => { throw new PrefabEditRefusalError({ reason: 'self-nesting', text: PREFAB_EDIT_REFUSAL_TEXT['self-nesting'] }); },
      remove: () => {},
    });
    await expect(Promise.resolve(act.redo())).rejects.toBeInstanceOf(UndoRefusedError);
  });
});

describe('the save checks the WHOLE document for I16 (#1817)', () => {
  it('refuses to write a prefab whose nested row\'s member holds an instance of it (captured into the row\'s `added`)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Outside prefab edit, so no gesture refuses the setup: an instance of EDITED under InnerLeaf, a member of its
    // nested row — the capture folds it into that row's member statements.
    const root = instantiatePrefab(editedDoc, 0);
    setPrefabSource(root, editedDoc);
    const self = instantiatePrefab(editedDoc, idOf('InnerLeaf'));
    setPrefabSource(self, editedDoc);
    expect(serializePrefab(root, EDITED)).toBeNull();
    expect(errors.mock.calls.some((c) => /refusing to save — nesting .* creates a cycle/.test(String(c[0])))).toBe(true);
  });

  it('refuses the same two frames down, where the capture writes it into a member row\'s `own` (the fuzzer\'s QR shape)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const MID = 'aaaaaaaa-0000-4000-8000-00000000181d';
    const OUTER = 'aaaaaaaa-0000-4000-8000-00000000181e';
    install(doc(MID, 'Mid', [row(1, 'MidRoot', 0), row(2, 'MidInner', 1, { prefab: INNER })]),
      doc(OUTER, 'Outer', [row(1, 'OuterRoot', 0), row(2, 'OuterMid', 1, { prefab: MID })]));
    const root = instantiatePrefab(prefabs.get(OUTER) as PrefabFile, 0);
    setPrefabSource(root, prefabs.get(OUTER) as PrefabFile);
    const self = instantiatePrefab(prefabs.get(OUTER) as PrefabFile, idOf('InnerLeaf'));
    setPrefabSource(self, prefabs.get(OUTER) as PrefabFile);
    // Precondition: with the I16 check skipped, this is written into a member row's `own` — the slot only the members
    // walk reaches. Asked of a copy saved as ANOTHER prefab, where no cycle is in play.
    const asOther = serializePrefab(root, 'aaaaaaaa-0000-4000-8000-00000000181f');
    const rows = (asOther!.entities as Array<{ members?: Record<string, { own?: Array<{ prefab?: string }> }> }>);
    expect(rows.some((r) => Object.values(r.members ?? {}).some((m) => m.own?.some((n) => n.prefab === OUTER)))).toBe(true);
    expect(serializePrefab(root, OUTER)).toBeNull();
    expect(errors.mock.calls.some((c) => /refusing to save — nesting .* creates a cycle/.test(String(c[0])))).toBe(true);
  });

  it('writes the same tree holding an unrelated prefab', () => {
    const root = instantiatePrefab(editedDoc, 0);
    setPrefabSource(root, editedDoc);
    const other = instantiatePrefab(otherDoc, idOf('InnerLeaf'));
    setPrefabSource(other, otherDoc);
    const saved = serializePrefab(root, EDITED);
    expect(saved).not.toBeNull();
    expect(JSON.stringify(saved)).toContain(OTHER);
  });

  // The one door every editor prefab write passes (`commitPrefabWrites`): whoever built the document — Apply's plan
  // checks only the nodes it promotes — a self-containing one is not written. Mutation: drop the check there.
  describe('commitPrefabWrites refuses a document that contains itself, before any write', () => {
    const writes = () => (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('/api/write-file'));
    beforeEach(() => {
      // Writes succeed; reads find nothing, so every `expected: null` (absent) precondition holds and the I16 check is the
      // only thing that can refuse (a 200 on a read would refuse the batch as a conflict instead, testing nothing).
      vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { method?: string }) => (init?.method === 'POST'
        ? { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{"ok":true}' }
        : { ok: false, status: 404, json: async () => ({}), text: async () => '' }) as unknown as Response));
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.unstubAllGlobals());

    it('one file holding itself', async () => {
      const self = doc(OTHER, 'Other', [row(1, 'OtherRoot', 0), row(2, 'Again', 1, { prefab: OTHER })]);
      const r = await commitPrefabWrite(OTHER, self, { expected: null });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('would contain itself');
      expect(writes()).toHaveLength(0);
    });

    it('two files of one batch holding each other — neither cached copy shows it, the batch does', async () => {
      const A = 'aaaaaaaa-0000-4000-8000-0000000018a1';
      const B = 'aaaaaaaa-0000-4000-8000-0000000018b1';
      install(doc(A, 'A', [row(1, 'ARoot', 0)]), doc(B, 'B', [row(1, 'BRoot', 0)]));
      const r = await commitPrefabWrites([
        { source: A, doc: doc(A, 'A', [row(1, 'ARoot', 0), row(2, 'HoldsB', 1, { prefab: B })]), expected: null },
        { source: B, doc: doc(B, 'B', [row(1, 'BRoot', 0), row(2, 'HoldsA', 1, { prefab: A })]), expected: null },
      ]);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('would contain itself');
      expect(writes()).toHaveLength(0);
    });

    it('a prefab no cache holds any more (trashed mid-session) is read from what its live frame was expanded from (#1866)', async () => {
      // Hunt seed 6031's shape: P nests Q; P is trashed (both caches evicted) while an instance of it is live, and an Apply
      // promotes that instance into Q. Read through the caches alone, P nested nothing, so Q → P → Q was written, and it
      // showed as "P nests itself" once P was restored. Mutation: read only the cache in `commitPrefabWrites`' I16 reader
      // (`batch.get(g) ?? getCachedPrefabSync(g)`) — the document is written.
      const P = 'aaaaaaaa-0000-4000-8000-0000000018c1';
      const Q = 'aaaaaaaa-0000-4000-8000-0000000018c2';
      const pDoc = doc(P, 'P', [row(1, 'PRoot', 0), row(2, 'HoldsQ', 1, { prefab: Q })]);
      install(doc(Q, 'Q', [row(1, 'QRoot', 0)]), pDoc);
      const live = instantiatePrefab(pDoc, 0); // records the frame's document, as every expansion does
      setPrefabSource(live, pDoc);
      prefabs.delete(P);
      setPrefabCache(P, null); // the trash
      const r = await commitPrefabWrite(Q, doc(Q, 'Q', [row(1, 'QRoot', 0), row(3, 'R', 1, { prefab: P })]), { expected: null });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('would contain itself');
      expect(writes()).toHaveLength(0);
    });

    it('writes a document holding an unrelated prefab', async () => {
      await commitPrefabWrite(EDITED, doc(EDITED, 'Edited', [row(1, 'EditedRoot', 0), row(2, 'Held', 1, { prefab: OTHER })]), { expected: null });
      expect(writes().length).toBeGreaterThan(0);
    });
  });

  it('prefabEditRefusal is inert outside a prefab-edit world', () => {
    spawn('Anything', 0);
    expect(prefabEditRefusal({ kind: 'add', parentId: 0 })).toBeNull();
  });
});

describe('a self-containing file on disk loads with the cyclic node refused, not a stack overflow (#1817)', () => {
  // EDITED's nested row states, under its member InnerLeaf, a reference node to EDITED itself: the file the fuzzer's
  // prefab-edit save wrote before the fix. Every load of it overflowed the stack, in the editor and the shipped loader.
  const selfContaining = (): PrefabFile => {
    const nested = row(2, 'Nested', 1, { prefab: INNER }) as Record<string, unknown>;
    const leaf = (innerDoc.entities as Array<{ nodeGuid: string; localId: number }>).find((e) => e.localId === 2)!;
    nested.members = { [`/${leaf.nodeGuid}`]: { guid: '', own: [{ parentLocalId: 0, key: nodeGuid(), name: 'SelfRef', prefab: EDITED, traits: {}, children: [] }] } };
    return doc(EDITED, 'Edited', [row(1, 'EditedRoot', 0), nested]);
  };

  it('the loader: bounded, one EditedRoot, and the refusal names the prefab and the chain', () => {
    install(selfContaining());
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => instantiatePrefabIntoWorld(getCurrentWorld(), prefabs.get(EDITED) as never, 0, undefined, EDITED)).not.toThrow();
    expect(byName('EditedRoot')).toHaveLength(1);
    const line = errors.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith('[loadSceneFile] cycle: prefab "Edited" contains itself'));
    expect(line).toBeDefined();
    expect(line).toContain('"Edited"');
  });

  it('the editor: bounded, one EditedRoot', () => {
    install(selfContaining());
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => instantiatePrefab(prefabs.get(EDITED) as PrefabFile, 0)).not.toThrow();
    expect(byName('EditedRoot')).toHaveLength(1);
    // One walk since #1783, so one prefix: the refusal is the loader's, whichever side called it.
    expect(errors.mock.calls.some((c) => String(c[0]).startsWith('[loadSceneFile] cycle: prefab "Edited" contains itself'))).toBe(true);
  });

  it('a loop through two files (A holds a B node, B holds an A node) is bounded too', () => {
    const A = 'aaaaaaaa-0000-4000-8000-00000000181a';
    const B = 'aaaaaaaa-0000-4000-8000-00000000181b';
    const leaf = (innerDoc.entities as Array<{ nodeGuid: string; localId: number }>).find((e) => e.localId === 2)!;
    const holding = (id: string, name: string, other: string) => {
      const nested = row(2, 'Nested', 1, { prefab: INNER }) as Record<string, unknown>;
      nested.members = { [`/${leaf.nodeGuid}`]: { guid: '', own: [{ parentLocalId: 0, key: nodeGuid(), name: `${name}Ref`, prefab: other, traits: {}, children: [] }] } };
      return doc(id, name, [row(1, `${name}Root`, 0), nested]);
    };
    install(holding(A, 'A', B), holding(B, 'B', A));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => instantiatePrefabIntoWorld(getCurrentWorld(), prefabs.get(A) as never, 0, undefined, A)).not.toThrow();
    expect(byName('ARoot')).toHaveLength(1);
    expect(byName('BRoot')).toHaveLength(1);
  });

  it('a scene nesting a prefab inside its own instance is legal, and expands (#1446)', () => {
    // A scene-stated node to OTHER inside an OTHER instance: the file does not contain itself, so it is not a cycle.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    instantiatePrefabIntoWorld(getCurrentWorld(), otherDoc as never, 0, undefined, OTHER, undefined,
      { added: [{ parentLocalId: 1, guid: '', name: 'Again', prefab: OTHER, traits: {}, children: [] }] } as never);
    expect(byName('OtherRoot')).toHaveLength(2);
    expect(errors.mock.calls.some((c) => /cycle/.test(String(c[0])))).toBe(false);
  });

  it('a template reference node to a prefab that shares an ancestor is not a cycle (the #1506 shape)', () => {
    // EDITED ⊃ INNER (row); EDITED's row states a HOLDS node… no: a node to a prefab whose own rows hold INNER, under
    // INNER's member — INNER is on the stack there, and the node's prefab expands it again, legally.
    const HOST = 'aaaaaaaa-0000-4000-8000-00000000181c';
    install(doc(HOST, 'Host', [row(1, 'HostRoot', 0), row(2, 'HostInner', 1, { prefab: INNER })]));
    const leaf = (innerDoc.entities as Array<{ nodeGuid: string; localId: number }>).find((e) => e.localId === 2)!;
    const nested = row(2, 'Nested', 1, { prefab: INNER }) as Record<string, unknown>;
    nested.members = { [`/${leaf.nodeGuid}`]: { guid: '', own: [{ parentLocalId: 0, key: nodeGuid(), name: 'HostRef', prefab: HOST, traits: {}, children: [] }] } };
    install(doc(EDITED, 'Edited', [row(1, 'EditedRoot', 0), nested]));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    instantiatePrefabIntoWorld(getCurrentWorld(), prefabs.get(EDITED) as never, 0, undefined, EDITED);
    expect(byName('HostRoot')).toHaveLength(1);
    expect(byName('InnerRoot')).toHaveLength(2); // EDITED's own, and HOST's inside the node
    expect(errors.mock.calls.some((c) => /cycle/.test(String(c[0])))).toBe(false);
  });
});
