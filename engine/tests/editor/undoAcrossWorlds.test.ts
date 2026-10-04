/** An undo replayed in a later world (#1819, #1827, #1793) and an edit on a Missing Prefab placeholder (#1818).
 *
 *  Owner ruling R (2026-09-29): an undo or redo whose target no longer resolves, or has become a Missing Prefab
 *  placeholder, REFUSES before any change (`UndoRefusedError`), and its entry is dropped. The owner is `require` on the
 *  entity ref (`editor/undo/entityRef.ts`); the write side is the placeholder gate (`editor/undo/placeholderGate.ts`).
 *  I19–I21 in docs/prefabs.md.
 *
 *  Every refusal case has its accept twin: the same step, with the world swap that should not refuse it, applies. Each
 *  case names the mutation that turns it red. Driven through the real loader and the real `serializeScene`; the world
 *  swap is a fresh world loaded from a save, which is what a reload and leaving prefab edit do. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData, spawnEntity, findEntity,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import {
  setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, deleteEntitiesWithUndo,
  duplicateEntity, createEntityWithUndo, addTraitToEntitiesWithUndo, removeTraitFromEntitiesWithUndo, reparentEntity,
} from '@modoki/engine/editor';
import { planReparent } from '../../packages/modoki/src/editor/undo/entityActions';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { writeTraitFieldMultiWithUndo, placeholderGestureRefusal, siblingDropRefusal } from '../../packages/modoki/src/editor/undo/entityActions';
import { commitUIHandleDrag } from '../../packages/modoki/src/editor/scene/uiHandleCommit';
import { revertOverridesWithUndo } from '../../packages/modoki/src/editor/undo/revertPrefabUndo';
import { detachPrefabInstanceWithUndo } from '../../packages/modoki/src/editor/undo/detachPrefabUndo';
import { makeSortOrderRenumberAction } from '../../packages/modoki/src/editor/undo/overrideMarkWrites';
import { undoStep, undoDepth } from '../../packages/modoki/src/editor/undo/undoManager';
import { entityRef, requireWith, buildGuidIndex } from '../../packages/modoki/src/editor/undo/entityRef';
import { UndoRefusedError } from '../../packages/modoki/src/editor/undo/undoFailure';
import { placeholderWriteRefusal, isMissingPrefabPlaceholder } from '../../packages/modoki/src/editor/undo/placeholderGate';
import { renumberAround, planCollidingDrop } from '../../packages/modoki/src/editor/undo/reorderSiblingsUndo';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);
registerEditorAgentOps();

const P = 'cccccccc-0000-4000-8000-000000001819';
const P_PATH = '/prefabs/P1819.prefab.json';
const INST = 'dddddddd-0000-4000-8000-000000001819';
const HOLDER = 'dddddddd-0000-4000-8000-000000001800';
const gR = 'eeeeeeee-0000-4000-8000-000000001811';
const gA = 'eeeeeeee-0000-4000-8000-000000001812';

const row = (localId: number, name: string, parentId: number, nodeGuid: string) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** P = R → A. */
const pDoc = () => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [row(1, 'R', 0, gR), row(2, 'A', 1, gA)] });
const install = () => { const d = pDoc(); prefabs.set(P, d); setPrefabCache(P, d as never); };
const uninstall = () => { prefabs.delete(P); setPrefabCache(P, null); };

/** A fresh world loaded from `data`: the world swap a reload or leaving prefab edit makes. The undo history stays. */
async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id: number) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure) => {
      const id = instantiatePrefabIntoWorld(
        getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure,
      );
      if (id && rootGuid) {
        for (const e of getCurrentWorld().entities) {
          if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), guid: rootGuid });
        }
      }
      return id ?? undefined;
    },
  });
}

const meta = (t: string) => getTraitByName(t)!;
const byGuid = (guid: string) => getAllEntities().find((e) => e.guid === guid);
const idOf = (guid: string) => byGuid(guid)!.id;
const named = (name: string) => getAllEntities().filter((e) => e.name === name);
const x = (id: number) => (readTraitData(id, meta('Transform')) as { x: number }).x;
const save = async () => JSON.parse(JSON.stringify(await serializeScene())) as SceneData;
/** The entry's ROOT override of EntityAttributes (`overrides[<its PrefabInstance.localId>]`), where F7 states the order. */
/** What the entry records for its root's `EntityAttributes` (scene v20, #2001 S6: the `"/"` row). */
const rootRowEa = (entry: Record<string, unknown>): Record<string, unknown> | undefined =>
  (entry.members as Record<string, { traits?: Record<string, Record<string, unknown>> }> | undefined)?.['/']?.traits?.EntityAttributes;
const entryOf = (s: SceneData, guid: string) => (s.entities as unknown as Array<Record<string, unknown>>).find((e) => e.guid === guid);

/** Holder, and a scene instance of P (guid INST) at the root. */
const scene = (): SceneData => ({
  id: 's1819', version: 16, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER }, Transform: { x: 0, y: 0, z: 0 } } },
    { id: 2, prefab: P, guid: INST, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } } },
  ],
} as unknown as SceneData);

/** The save of the current world, reloaded with P missing (`missing: true`) or present: the swap that turns the
 *  instance into a placeholder, or the one that does not. */
async function swap(missing: boolean): Promise<void> {
  const saved = await save();
  if (missing) uninstall(); else install();
  await load(saved);
}

beforeEach(async () => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
  install();
  await load(scene());
});
afterAll(() => { setPrefabCache(P, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

describe('require: a refusing resolve on the entity ref (I19, I20)', () => {
  // Mutation: make `require` return `ref.resolve()` unchecked (the old `?? rawId` / skip) — every refuse case goes red.
  it('refuses a ref whose entity is gone, naming it, and resolves one that is there', () => {
    const e = spawnEntity(getCurrentWorld(), meta('EntityAttributes').trait({ name: 'Gone', guid: 'ffffffff-0000-4000-8000-000000001819' }));
    const ref = entityRef(e.id());
    expect(ref.require()).toBe(e.id()); // accept
    destroyEntity(e, getCurrentWorld());
    expect(() => ref.require()).toThrow(UndoRefusedError);
    expect(() => ref.require()).toThrow(/"Gone" .*is no longer in the scene/);
  });

  // Mutation: drop the World check in `rawIdIn` — the guid-less ref resolves in the new world to whatever holds its id.
  it('a guid-less ref is found by its raw id only in the World it was taken in', async () => {
    // Spawned raw: `spawnEntity` gives every entity EntityAttributes, and with it a guid.
    const bare = getCurrentWorld().spawn(meta('Transform').trait());
    const ref = entityRef(bare.id());
    expect(ref.guid).toBe('');
    expect(ref.resolve()).toBe(bare.id()); // accept: same world
    const held = bare.id();
    await load(scene());
    // Something holds that id in the new world (ids restart), and the ref must not name it.
    while (!getAllEntities().some((e) => e.id === held)) spawnEntity(getCurrentWorld(), meta('EntityAttributes').trait({ name: 'Bystander' }));
    expect(ref.resolve()).toBeNull();
  });
});

describe('an undo against an instance a world swap made a Missing Prefab placeholder refuses (#1819, ruling R)', () => {
  // Mutation: in `requireResolved`, skip the kind check — the undo writes onto the placeholder and reports success.
  it('a field edit on the instance root: refused, dropped, the placeholder untouched; with the prefab present it applies', async () => {
    writeTraitFieldWithUndo(idOf(INST), meta('Transform'), 'x', 3);
    await swap(true);
    expect(isMissingPrefabPlaceholder(idOf(INST))).toBe(true);
    const before = JSON.stringify(entryOf(await save(), INST));
    const r = await undoStep('undo');
    expect(r.failed?.refused).toBe(true);
    expect(r.failed?.error).toMatch(/is a Missing Prefab now/);
    expect(undoDepth()).toBe(0); // dropped, not left on the stack (R, not R′)
    expect(JSON.stringify(entryOf(await save(), INST))).toBe(before);
  });

  it('(accept) the same undo after a swap that keeps the prefab applies', async () => {
    writeTraitFieldWithUndo(idOf(INST), meta('Transform'), 'x', 3);
    await swap(false);
    const r = await undoStep('undo');
    expect(r.did).toBe(true);
    expect(x(idOf(INST))).toBe(0);
  });

  // Mutation: in writeTraitFieldWithUndo's undo, go back to `ref.resolve(); if (id == null) return;` — the undo reports
  // `did: true` over a member the placeholder folded into its record.
  it('a member\'s field edit, folded into the kept record by the swap: refused as "no longer in the scene"', async () => {
    const a = named('A')[0]!.id;
    writeTraitFieldWithUndo(a, meta('Transform'), 'x', 5);
    await swap(true);
    const r = await undoStep('undo');
    expect(r.did).toBe(false);
    expect(r.failed?.error).toMatch(/"A" is no longer in the scene/);
  });

  // Mutation: remove the `requireRootLinks` call from deleteEntitiesWithUndo's undo — A respawns linked to the
  // placeholder, which carries no PrefabInstance (I6).
  it('Delete\'s undo of a member whose root became a placeholder refuses and respawns nothing', async () => {
    const a = named('A')[0]!.id;
    deleteEntitiesWithUndo([a]);
    await swap(true);
    const r = await undoStep('undo');
    expect(r.failed?.refused).toBe(true);
    expect(named('A')).toHaveLength(0);
  });

  // Mutation: remove the `requireRootLinks` call from deleteEntitiesWithUndo's undo — A respawns with a PrefabInstance
  // naming a root that is no instance (I6). (The placeholder case above refuses on A's parent first: it IS the root.)
  it('Delete\'s undo of a member whose root came back PLAIN under the same guid refuses on the root link', async () => {
    const a = named('A')[0]!.id;
    deleteEntitiesWithUndo([a]);
    const saved = await save();
    const entries = saved.entities as unknown as Array<Record<string, unknown>>;
    const i = entries.findIndex((e) => e.guid === INST);
    entries[i] = { guid: INST, traits: { EntityAttributes: { name: 'Inst', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } };
    await load(saved);
    expect(readTraitData(idOf(INST), meta('PrefabInstance'))).toBeNull(); // precondition: plain, and live
    const r = await undoStep('undo');
    expect(r.failed?.refused).toBe(true);
    expect(r.failed?.error).toMatch(/is no longer a prefab instance/);
    expect(named('A')).toHaveLength(0);
  });

  it('(accept) Delete\'s undo of a member after a swap that keeps the prefab brings it back linked to its root', async () => {
    const a = named('A')[0]!.id;
    deleteEntitiesWithUndo([a]);
    await swap(false);
    const r = await undoStep('undo');
    expect(r.did).toBe(true);
    const back = named('A');
    expect(back).toHaveLength(1);
    expect((readTraitData(back[0]!.id, meta('PrefabInstance')) as { rootInstanceId: number }).rootInstanceId).toBe(idOf(INST));
  });
});

describe('Revert\'s and Detach\'s undo check the kind their forward step left (#1819, I20)', () => {
  // Mutation: drop `expect` from revertPrefabUndo's `ref.require(expect)` calls — the rebuild expands a second
  // instance on the placeholder's guid (I7).
  it('Revert\'s undo after the instance became a placeholder refuses and builds nothing; with the prefab it applies', async () => {
    writeTraitFieldWithUndo(named('A')[0]!.id, meta('Transform'), 'x', 5);
    expect(await revertOverridesWithUndo(idOf(INST), new Set(['2.Transform.x']))).not.toBeNull();
    expect(x(named('A')[0]!.id)).toBe(0);
    await swap(true);
    const r = await undoStep('undo');
    expect(r.failed?.refused).toBe(true);
    expect(getAllEntities().filter((e) => e.guid === INST)).toHaveLength(1);
    expect(named('A')).toHaveLength(0);
  });

  // Mutation: drop `expect` from revertPrefabUndo's `ref.require(expect)` calls — the placeholder case above still refuses
  // on the kind, but a root that came back plain is rebuilt as an instance of a prefab it no longer is.
  it('Revert\'s undo refuses when the root came back plain under the same guid', async () => {
    writeTraitFieldWithUndo(named('A')[0]!.id, meta('Transform'), 'x', 5);
    await revertOverridesWithUndo(idOf(INST), new Set(['2.Transform.x']));
    const saved = await save();
    const entries = saved.entities as unknown as Array<Record<string, unknown>>;
    entries[entries.findIndex((e) => e.guid === INST)] = { guid: INST, traits: { EntityAttributes: { name: 'Inst', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } };
    await load(saved);
    const r = await undoStep('undo');
    expect(r.failed?.refused).toBe(true);
    expect(r.failed?.error).toMatch(/is no longer an instance of/);
    expect(readTraitData(idOf(INST), meta('PrefabInstance'))).toBeNull();
  });

  it('(accept) Revert\'s undo after a swap that keeps the prefab puts the override back', async () => {
    writeTraitFieldWithUndo(named('A')[0]!.id, meta('Transform'), 'x', 5);
    await revertOverridesWithUndo(idOf(INST), new Set(['2.Transform.x']));
    await swap(false);
    expect((await undoStep('undo')).did).toBe(true);
    expect(x(named('A')[0]!.id)).toBe(5);
  });

  // Mutation: remove `requireDetachedLinks(snapshot)` from Detach's undo — it puts PrefabInstance back onto a tree that is
  // an instance again, over its own links.
  it('Detach\'s undo refuses once the root is an instance again; after a plain swap it relinks', async () => {
    detachPrefabInstanceWithUndo(idOf(INST), 'Detach prefab', '[test]');
    expect(readTraitData(idOf(INST), meta('PrefabInstance'))).toBeNull();
    await swap(false);
    // (accept) the detached tree reloads plain, and the undo relinks it.
    expect((await undoStep('undo')).did).toBe(true);
    expect(readTraitData(idOf(INST), meta('PrefabInstance'))).not.toBeNull();
    // Refuse: detach again, then a later world holds an instance under the root's guid.
    detachPrefabInstanceWithUndo(idOf(INST), 'Detach prefab', '[test]');
    await load(scene());
    const r = await undoStep('undo');
    expect(r.failed?.refused).toBe(true);
    expect(r.failed?.error).toMatch(/is a prefab instance again/);
  });
});

describe('the Hierarchy sibling renumber holds each sibling by guid (#1827)', () => {
  // Mutation: in makeSortOrderRenumberAction, write through `id` instead of `at(id)` (and drop `pin`) — the redo in the
  // new world writes sortOrder onto whatever entities hold the old ids.
  it('its redo refuses when a sibling is gone, and renumbers the live siblings when they are there', async () => {
    const a = spawnEntity(getCurrentWorld(), meta('EntityAttributes').trait({ name: 'S1', guid: 'ffffffff-0000-4000-8000-000000001001' }));
    const b = spawnEntity(getCurrentWorld(), meta('EntityAttributes').trait({ name: 'S2', guid: 'ffffffff-0000-4000-8000-000000001002' }));
    const action = makeSortOrderRenumberAction([{ id: a.id(), oldSort: 0, newSort: 10 }, { id: b.id(), oldSort: 0, newSort: 20 }])!;
    action.redo(); pushAction(action);
    await undoStep('undo');
    // (accept) a reload keeps both, at new ids: the redo finds them by guid.
    const saved = await save();
    const first = () => ({ traits: { EntityAttributes: { name: 'First', parentId: 0 } } });
    (saved.entities as unknown as Array<Record<string, unknown>>).unshift(first(), first());
    await load(saved);
    expect(named('S2')[0]!.id).not.toBe(b.id()); // precondition: the reload moved the ids
    expect((await undoStep('redo')).did).toBe(true);
    expect(named('S2')[0]!.sortOrder).toBe(20);
    expect(named('First').map((e) => e.sortOrder)).toEqual([0, 0]);
    expect(named('S1')[0]!.sortOrder).toBe(10);
    await undoStep('undo');
    // Refuse: S2 is gone in the next world.
    const again = await save();
    await load({ ...again, entities: (again.entities as unknown as Array<Record<string, unknown>>).filter((e) => (e.name ?? (e.traits as { EntityAttributes?: { name?: string } }).EntityAttributes?.name) !== 'S2') } as unknown as SceneData);
    const r = await undoStep('redo');
    expect(r.failed?.refused).toBe(true);
    expect(named('S1')[0]!.sortOrder).toBe(0); // nothing written
  });
});

describe('an undo never falls back to a raw ECS id or the scene root (#1827, #1793)', () => {
  // Mutation: restore `?? (findEntity(currentId) ? currentId : null)` in duplicateEntity's undo — it deletes whatever
  // entity holds the copy's old id in the new world.
  it('Duplicate\'s undo after a swap that lost the copy refuses, and deletes nothing', async () => {
    const copyId = duplicateEntity(idOf(HOLDER), () => {})!;
    // The swap loads a world without the copy (a save taken before it), whose ids restart: another entity holds copyId.
    uninstall(); install();
    await load(scene());
    while (!getAllEntities().some((e) => e.id === copyId)) spawnEntity(getCurrentWorld(), meta('EntityAttributes').trait({ name: 'Bystander' }));
    const count = getAllEntities().length;
    const r = await undoStep('undo');
    expect(r.failed?.refused).toBe(true);
    expect(getAllEntities().length).toBe(count);
  });

  it('(accept) Duplicate\'s undo in the same world deletes the copy', async () => {
    duplicateEntity(idOf(HOLDER), () => {});
    expect(named('Holder')).toHaveLength(2);
    expect((await undoStep('undo')).did).toBe(true);
    expect(named('Holder')).toHaveLength(1);
  });

  // Mutation: restore `parentRef?.resolve() ?? 0` in createEntityWithUndo's redo — Kid respawns at the scene root.
  it('Create\'s redo: refused when the parent is gone, applied under it when it is there', async () => {
    const holder = idOf(HOLDER);
    createEntityWithUndo('Create Kid', holder, [{ name: 'EntityAttributes', data: { name: 'Kid' } }], () => {});
    await undoStep('undo');
    // (accept) the redo lands under Holder.
    expect((await undoStep('redo')).did).toBe(true);
    expect(named('Kid')[0]!.parentId).toBe(holder);
    await undoStep('undo');
    // Holder gone in a later world; the redo must not put Kid at the root.
    const saved = await save();
    (saved.entities as unknown as Array<Record<string, unknown>>).splice(0, 1);
    await load(saved);
    const r = await undoStep('redo');
    expect(r.failed?.refused).toBe(true);
    expect(r.failed?.error).toMatch(/"Holder" is no longer in the scene/);
    expect(named('Kid')).toHaveLength(0);
  });

  // Mutation: in placePrefabFromPath's respawn, pass the raw `parentId` again — the redo parents the instance under
  // whatever entity holds Holder's old id.
  it('the Hierarchy drop\'s redo holds its parent by guid: refused when it is gone, under it when it is there', async () => {
    registerAsset(P, P_PATH, 'prefab');
    vi.stubGlobal('fetch', async (p: string) => (p === P_PATH
      ? { ok: true, status: 200, json: async () => pDoc(), text: async () => JSON.stringify(pDoc()) }
      : { ok: false, status: 404, json: async () => ({}), text: async () => '' }));
    const holder = idOf(HOLDER);
    const dropped = await placePrefabFromPath(P_PATH, { tag: 'test', parentId: holder });
    expect(dropped).toBeTruthy();
    await undoStep('undo');
    expect((await undoStep('redo')).did).toBe(true); // accept
    expect(named('R').some((e) => e.parentId === holder)).toBe(true);
    await undoStep('undo');
    const saved = await save();
    (saved.entities as unknown as Array<Record<string, unknown>>).splice(0, 1); // Holder gone
    await load(saved);
    while (!getAllEntities().some((e) => e.id === holder)) spawnEntity(getCurrentWorld(), meta('EntityAttributes').trait({ name: 'Bystander' }));
    const r = await undoStep('redo');
    expect(r.failed?.refused).toBe(true);
    expect(named('R').filter((e) => e.parentId === holder)).toHaveLength(0);
  });
});

describe('the placeholder gate: an edit the save would drop is refused where it is made (#1818, I21)', () => {
  beforeEach(async () => { await swap(true); clearHistory(); });

  // Mutation: return null at the top of `placeholderWriteRefusal` — the write lands live and the save drops it.
  it('a Transform write on the placeholder is refused with a reason, writes nothing and pushes no entry', () => {
    const id = idOf(INST);
    const reason = writeTraitFieldWithUndo(id, meta('Transform'), 'x', 9);
    expect(reason).toMatch(/is a Missing Prefab now/);
    expect(undoDepth()).toBe(0);
  });

  it('Add and Remove Component on the placeholder are refused', () => {
    const id = idOf(INST);
    expect(addTraitToEntitiesWithUndo([id], meta('Rotate3D'))).toMatch(/Missing Prefab/);
    expect(getAllEntities().find((e) => e.id === id)).toBeTruthy();
    expect(undoDepth()).toBe(0);
    if (readTraitData(id, meta('Transform'))) expect(removeTraitFromEntitiesWithUndo([id], meta('Transform'))).toMatch(/Missing Prefab/);
  });

  // Mutation: make the multi writer skip the placeholder and write the rest — Holder moves under a one-entity entry.
  it('a multi-selection holding the placeholder is refused as a whole', () => {
    const r = writeTraitFieldMultiWithUndo([idOf(HOLDER), idOf(INST)], meta('Transform'), 'x', 4);
    expect(r).toMatch(/Missing Prefab/);
    expect(x(idOf(HOLDER))).toBe(0);
  });

  // Mutation: drop 'isActive' from PLACEHOLDER_PLACEMENT_FIELDS — the gate refuses Activate; or drop the `order` loop in
  // asSceneEntry — Activate and the reorder show live and the save writes the record's values.
  it('(accept) the Hierarchy\'s rename, Activate and reorder pass, and the save keeps them', async () => {
    const id = idOf(INST);
    expect(writeTraitFieldWithUndo(id, meta('EntityAttributes'), 'name', 'Renamed')).toBeNull();
    expect(writeTraitFieldWithUndo(id, meta('EntityAttributes'), 'isActive', false)).toBeNull();
    expect(reparentEntity(id, 0, 7)).toBe(true);
    const entry = entryOf(await save(), INST)!;
    const ea = (entry.traits as Record<string, Record<string, unknown>>).EntityAttributes;
    // Scene v20 (#2001 S6): the sibling order is PLACEMENT, on the entry's own traits; the name and the active flag are
    // records of the root, on its `"/"` row, where the prefab's return reads them (#1850).
    expect(ea).toEqual({ sortOrder: 7 });
    expect(rootRowEa(entry)).toEqual({ name: 'Renamed', isActive: false });
  });

  // Mutation: write `order` unconditionally in asSceneEntry — the untouched save gains sortOrder 0 / isActive true.
  it('an untouched placeholder saves byte-identically', async () => {
    const first = JSON.stringify(entryOf(await save(), INST));
    await load(await save());
    expect(JSON.stringify(entryOf(await save(), INST))).toBe(first);
    // Nothing beyond what the record holds: the entry's traits state its placement (v20 states `sortOrder` always) and
    // no active flag, and the `"/"` row states the name alone.
    const entry = JSON.parse(first) as Record<string, unknown>;
    expect(entry.traits).toEqual({ EntityAttributes: { sortOrder: 0 } });
    expect(rootRowEa(entry)).toEqual({ name: 'R' });
  });

  // Mutation: remove the placeholder ask from BOTH layers of the editor's trait writer (`editorTraitWriter.refusal` and
  // `writeTraitAsEditor`, #1816's one writer) — the shared helpers' own gate then throws mid-call instead of refusing.
  it('the agent surface refuses with the reason: apply-scene-ops and set-traits', async () => {
    const r1 = await runAgentOp('apply-scene-ops', { ops: [{ op: 'setTrait', entity: { guid: INST }, trait: 'Transform', fields: { x: 2 } }] }) as { errors: string[] };
    expect(r1.errors.join('\n')).toMatch(/Missing Prefab now/);
    const r2 = await runAgentOp('set-traits', { guid: INST, set: { 'Transform.x': 2 } }) as { ok: boolean; error?: string };
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/Missing Prefab now/);
    expect(readTraitData(idOf(INST), meta('Transform'))).toBeNull(); // neither added the component
    // (accept) a rename goes through.
    const r3 = await runAgentOp('set-traits', { guid: INST, set: { 'EntityAttributes.name': 'ByAgent' } }) as { ok: boolean };
    expect(r3.ok).toBe(true);
  });

  // #1901 (owner ruling, shape 2): the node shape keeps both, in the node's own traits, so the gate lets them through.
  // Mutation: restore the gate's node-shape refusal of the order fields — both are refused.
  it('sortOrder and isActive are let through on a placeholder saved as an added node (inside an instance)', async () => {
    install();
    await load(await save()); // P back: INST is a live instance again
    const holderUnderInst = idOf(INST);
    const node = spawnEntity(getCurrentWorld(), meta('EntityAttributes').trait({ name: 'Node', parentId: holderUnderInst, guid: 'ffffffff-0000-4000-8000-000000001818' }));
    const { markUnresolved } = await import('../../packages/modoki/src/runtime/core/unresolvedPrefabRef');
    markUnresolved(node as never, 'cccccccc-0000-4000-8000-00000000dead', 'node', { prefab: 'cccccccc-0000-4000-8000-00000000dead' });
    expect(placeholderWriteRefusal(node.id(), 'EntityAttributes', 'sortOrder')).toBeNull();
    expect(placeholderWriteRefusal(node.id(), 'EntityAttributes', 'isActive')).toBeNull();
    expect(placeholderWriteRefusal(node.id(), 'EntityAttributes', 'name')).toBeNull();
    expect(placeholderWriteRefusal(node.id(), 'Transform', 'x')).toMatch(/Missing Prefab/); // the rest is still refused
  });

  // #1901: the node save keeps the placeholder's live order, so a move into an instance places it where it was dropped,
  // as it does any entity. Mutation: seat a placeholder landing inside an instance at 0 in `reparentEntity` (#1897's
  // premise) — it shows at 0, not 3.
  it('a placeholder moved into an instance takes the drop\'s order, as a plain entity does', async () => {
    install();
    await load(await save());
    const ph = spawnEntity(getCurrentWorld(), meta('EntityAttributes').trait({ name: 'Loose', parentId: 0, sortOrder: 7, guid: 'ffffffff-0000-4000-8000-000000001834' }));
    const { markUnresolved } = await import('../../packages/modoki/src/runtime/core/unresolvedPrefabRef');
    markUnresolved(ph as never, 'cccccccc-0000-4000-8000-00000000dead', 'entry', { prefab: 'cccccccc-0000-4000-8000-00000000dead' });
    expect(reparentEntity(ph.id(), idOf(INST), 3)).toBe(true);
    expect(getAllEntities().find((e) => e.id === ph.id())!.sortOrder).toBe(3);
    const plain = spawnEntity(getCurrentWorld(), meta('EntityAttributes').trait({ name: 'PlainOne', parentId: 0, sortOrder: 7 }));
    expect(reparentEntity(plain.id(), idOf(INST), 3)).toBe(true); // accept
    expect(getAllEntities().find((e) => e.id === plain.id())!.sortOrder).toBe(3);
  });

  // #1901: the node save keeps the copy's order, so a copy of a node placeholder is placed last like any copy (fuzzer hunt
  // seed 3233 was the old shape: a fresh order its save could not keep). Mutation: return early from `assignFreshSortOrder`
  // for every placeholder (`isMissingPrefabPlaceholder`) — the copy keeps the copied 0 and collides with its source.
  it('a duplicate of a node-shape placeholder gets a fresh sortOrder, as a plain duplicate does', async () => {
    install();
    await load(await save());
    const inst = idOf(INST);
    const node = spawnEntity(getCurrentWorld(), meta('EntityAttributes').trait({ name: 'Node', parentId: inst, sortOrder: 0, guid: 'ffffffff-0000-4000-8000-000000001833' }));
    const { markUnresolved } = await import('../../packages/modoki/src/runtime/core/unresolvedPrefabRef');
    markUnresolved(node as never, 'cccccccc-0000-4000-8000-00000000dead', 'node', { prefab: 'cccccccc-0000-4000-8000-00000000dead' });
    // Held as a load holds one (#2001 S8b): its own record, read from what it carries, and its link on INST's row.
    const { capturedRecordsOf } = await import('../../packages/modoki/src/editor/instance/instanceSync');
    const { setInstanceRecord } = await import('../../packages/modoki/src/runtime/prefab/instanceStore');
    const { addChild } = await import('../../packages/modoki/src/editor/instance/instanceEdits');
    for (const r of capturedRecordsOf(node.id()) ?? []) setInstanceRecord(getCurrentWorld(), r);
    addChild(node.id());
    const copy = duplicateEntity(node.id(), () => {})!;
    expect(getAllEntities().find((e) => e.id === copy)!.sortOrder).toBeGreaterThan(0);
    const plainCopy = duplicateEntity(idOf(HOLDER), () => {})!; // accept: a plain copy is placed last
    expect(getAllEntities().find((e) => e.id === plainCopy)!.sortOrder).toBeGreaterThan(0);
  });
});

describe('a live-writing gesture on a placeholder is refused at its commit (#1818, I21)', () => {
  /** P missing, INST's entry carrying root traits the placeholder keeps: a Transform and a UIElement. */
  const loadWithRootTraits = async () => {
    uninstall();
    await load({ id: 's', version: 16, name: 'S', resources: [], entities: [
      { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER }, Transform: { x: 0, y: 0, z: 0 } } },
      { id: 2, prefab: P, guid: INST, traits: { EntityAttributes: { name: 'Inst', parentId: 0 }, Transform: { x: 3, y: 0, z: 0 }, UIElement: { width: 50 } } },
    ] } as unknown as SceneData);
  };

  // Mutation: return null from `placeholderGestureRefusal` — a gizmo drag of the placeholder commits an entry whose
  // values the save drops.
  it('the gizmo commit asks it: refused on the placeholder (whose kept root traits include a Transform), not on a plain entity', async () => {
    await loadWithRootTraits();
    expect(readTraitData(idOf(INST), meta('Transform'))).not.toBeNull(); // precondition: the gizmo can grab it
    expect(placeholderGestureRefusal([idOf(INST)], 'Transform')).toMatch(/Missing Prefab now/);
    expect(placeholderGestureRefusal([idOf(HOLDER), idOf(INST)], 'Transform')).toMatch(/Missing Prefab now/);
    expect(placeholderGestureRefusal([idOf(HOLDER)], 'Transform')).toBeNull(); // accept
  });

  // Mutation: remove the refusal line from commitUIHandleDrag — the dragged width stays live and an entry is pushed.
  it('a UI-handle drag on the placeholder is put back and pushes nothing', async () => {
    await loadWithRootTraits();
    clearHistory();
    const id = idOf(INST);
    const ui = meta('UIElement');
    if (!readTraitData(id, ui)) return expect.fail('fixture: the placeholder should keep its UIElement');
    findEntity(id)!.set(ui.trait, { ...(findEntity(id)!.get(ui.trait) as object), width: 80 }); // the live drag
    commitUIHandleDrag(id, 'UIElement', { width: 50 }, { width: 80 }, 'Resize');
    expect((readTraitData(id, ui) as { width: number }).width).toBe(50);
    expect(undoDepth()).toBe(0);
  });
});

describe('renumberAround: the Hierarchy renumber leaves a fixed sibling\'s sortOrder alone (#1818)', () => {
  // Mutation: ignore `fixed` in renumberAround — the fixed sibling is renumbered to 10.
  it('numbers the rest around it, in display order', () => {
    const r = renumberAround([{ id: 1, sortOrder: 0 }, { id: 2, sortOrder: 0, fixed: true }, { id: 3, sortOrder: 0 }]);
    expect(Array.isArray(r)).toBe(true);
    const next = new Map([[2, 0], ...(r as Array<{ id: number; newSort: number }>).map((c) => [c.id, c.newSort] as [number, number])]);
    expect(next.has(2) && !(r as Array<{ id: number }>).some((c) => c.id === 2)).toBe(true);
    expect(next.get(1)!).toBeLessThan(next.get(2)!);
    expect(next.get(3)!).toBeGreaterThan(next.get(2)!);
  });
  it('(accept) with nothing fixed it is the plain i*10 renumber', () => {
    expect(renumberAround([{ id: 1, sortOrder: 0 }, { id: 2, sortOrder: 0 }])).toEqual([{ id: 2, oldSort: 0, newSort: 10 }]);
  });
  // Close-out re-review: renumberAround used to return `stuck` for the whole group here, so a drop by A/B far from the
  // span was refused. Mutation: return `{ stuck }` from planCollidingDrop whenever a tie exists anywhere in the group.
  it('keeps the plain siblings inside a tied span of fixed ones, and renumbers the rest; a drop far from the span plans', () => {
    const sibs = [{ id: 1, sortOrder: 0, fixed: true }, { id: 2, sortOrder: 0 }, { id: 3, sortOrder: 0, fixed: true }, { id: 4, sortOrder: 50 }, { id: 5, sortOrder: 50 }];
    const changes = renumberAround(sibs);
    expect(changes.some((c) => c.id === 2)).toBe(false);
    const plan = planCollidingDrop(sibs, 4, 'after');
    expect('newSort' in plan).toBe(true);
    // A drop INTO the span is refused, naming a real kept sibling (3), never the plain sibling (2).
    expect(planCollidingDrop(sibs, 2, 'after')).toEqual({ stuck: 3 });
  });
});

describe('planCollidingDrop: the Hierarchy drop decided before anything is written (#1818 close-out re-review)', () => {
  // Mutation: return `target + 5` instead of the midpoint — the drop lands past the neighbour spaced under 10 apart.
  it('lands at the midpoint with the renumbered neighbour, inside a gap the kept placeholders narrowed', () => {
    const plan = planCollidingDrop([{ id: 1, sortOrder: 0, fixed: true }, { id: 2, sortOrder: 0 }, { id: 3, sortOrder: 4, fixed: true }], 2, 'after');
    if ('stuck' in plan) throw new Error('fixture: expected a plan');
    expect(plan.newSort).toBeGreaterThan(2);
    expect(plan.newSort).toBeLessThan(4);
  });
  // Mutation: drop the `other === target` branch — the drop takes the tied value and the guid tiebreak places it.
  it('is stuck between two kept placeholders at one value, naming the kept one; beside a plain sibling it plans', () => {
    expect(planCollidingDrop([{ id: 1, sortOrder: 0, fixed: true }, { id: 2, sortOrder: 0, fixed: true }], 1, 'after')).toEqual({ stuck: 2 }); // the neighbour
    const ok = planCollidingDrop([{ id: 1, sortOrder: 0 }, { id: 2, sortOrder: 0 }], 1, 'after'); // accept
    expect('newSort' in ok && ok.newSort).toBe(5);
  });
});

describe('requireWith follows a guid rename (#1819 close-out review)', () => {
  // Mutation: in requireWith, ignore `renamed` — the ref taken before the rename refuses.
  it('a ref taken under guid a finds its entity renamed a → b → c, and refuses without the map', () => {
    const ea = meta('EntityAttributes');
    const e = spawnEntity(getCurrentWorld(), ea.trait({ name: 'Renamed', guid: 'ffffffff-0000-4000-8000-00000000000a' }));
    const ref = entityRef(e.id());
    e.set(ea.trait, { ...(e.get(ea.trait) as object), guid: 'ffffffff-0000-4000-8000-00000000000c' });
    const idx = buildGuidIndex();
    const chain = new Map([['ffffffff-0000-4000-8000-00000000000a', 'ffffffff-0000-4000-8000-00000000000b'], ['ffffffff-0000-4000-8000-00000000000b', 'ffffffff-0000-4000-8000-00000000000c']]);
    expect(requireWith(ref, idx, undefined, chain)).toBe(e.id());
    expect(() => requireWith(ref, idx)).toThrow(UndoRefusedError);
  });
});

describe('siblingDropRefusal: the Hierarchy drop refused before its renumber writes (#1818 close-out re-review)', () => {
  // Mutation: drop the planReparent line — a drop beside a child of the mover renumbers first and leaves a stray entry.
  it('names a reparent refusal (a drop under itself); a plain drop and a placeholder reordered in its own instance pass (#1901)', async () => {
    expect(siblingDropRefusal(idOf(HOLDER), idOf(HOLDER))).toEqual({ kind: 'reparent' });
    expect(siblingDropRefusal(idOf(HOLDER), 0)).toBeNull(); // accept
    const inst = idOf(INST);
    const node = spawnEntity(getCurrentWorld(), meta('EntityAttributes').trait({ name: 'Node', parentId: inst, guid: 'ffffffff-0000-4000-8000-000000001835' }));
    const { markUnresolved } = await import('../../packages/modoki/src/runtime/core/unresolvedPrefabRef');
    markUnresolved(node as never, 'cccccccc-0000-4000-8000-00000000dead', 'node', { prefab: 'cccccccc-0000-4000-8000-00000000dead' });
    expect(siblingDropRefusal(node.id(), inst)).toBeNull(); // the node shape keeps its order since #1901
  });
});

describe('nothing new goes under a Missing Prefab placeholder (#1831, the G1 study\'s M2)', () => {
  beforeEach(async () => { await swap(true); clearHistory(); });
  const UNDER = /Nothing can be put under a Missing Prefab/;

  // Mutation: drop the `under-missing-prefab` check at the top of `prefabEditRefusal` — each gesture lands a new child
  // under the placeholder, which its save writes nowhere it belongs (seed 315's orphan).
  // (A paste, a duplicate and a placement ask the same `add` gesture as the create: the fuzzer's verify seed 8 pastes
  // under a placeholder and is refused.)
  it('a create and a reparent under the placeholder are refused with the reason, and push nothing', () => {
    const inst = idOf(INST);
    expect(() => createEntityWithUndo('Create', inst, [{ name: 'EntityAttributes', data: { name: 'Kid', parentId: inst } }], () => {})).toThrow(UNDER);
    expect(named('Kid')).toHaveLength(0);
    const plan = planReparent(idOf(HOLDER), inst);
    expect(plan.kind).toBe('refused');
    expect(plan.kind === 'refused' && plan.reason).toBe('under-missing-prefab');
    expect(reparentEntity(idOf(HOLDER), inst)).toBe(false);
    expect(byGuid(HOLDER)!.parentId).toBe(0);
    expect(undoDepth()).toBe(0);
  });

  it('a prefab dropped on it is refused, and nothing spawns', async () => {
    install(); // P present again for the drop's own read; the placeholder stays a placeholder until a reload
    registerAsset(P, P_PATH, 'prefab');
    vi.stubGlobal('fetch', async (p: string) => (p === P_PATH
      ? { ok: true, status: 200, json: async () => pDoc(), text: async () => JSON.stringify(pDoc()) }
      : { ok: false, status: 404, json: async () => ({}), text: async () => '' }));
    const before = getAllEntities().length;
    const dropped = await placePrefabFromPath(P_PATH, { tag: 'test', parentId: idOf(INST) });
    expect(dropped).toBeFalsy();
    expect(getAllEntities().length).toBe(before);
    expect(undoDepth()).toBe(0);
  });

  it('the agent create-entity and reparent-entity say why', async () => {
    await expect(runAgentOp('create-entity', { spec: { kind: 'empty' }, name: 'Kid', parentGuid: INST })).rejects.toThrow(UNDER);
    await expect(runAgentOp('reparent-entity', { guid: HOLDER, parentGuid: INST })).rejects.toThrow(UNDER);
    expect(named('Kid')).toHaveLength(0);
  });

  // (accept) a child the placeholder already has (loaded with it) is not a new link: re-planned under its own parent (a
  // sibling reorder) it passes. Mutation: drop the reorder exemption in `prefabEditRefusal` — refused.
  it('(accept) a child already under the placeholder may be reordered there', () => {
    const inst = idOf(INST);
    const kid = spawnEntity(getCurrentWorld(), meta('EntityAttributes').trait({ name: 'Loaded', parentId: inst })).id();
    expect(planReparent(kid, inst).kind).not.toBe('refused');
    expect(planReparent(kid, 0).kind).not.toBe('refused'); // and moved out
  });

  // (accept) the refusal is about a NEW link under it: the placeholder itself still moves and reorders (I21), and a
  // create beside it lands.
  it('(accept) the placeholder itself still moves, and a create beside it lands', () => {
    expect(reparentEntity(idOf(INST), idOf(HOLDER))).toBe(true);
    expect(createEntityWithUndo('Create', 0, [{ name: 'EntityAttributes', data: { name: 'Beside', parentId: 0 } }], () => {})).toBeTruthy();
  });
});
