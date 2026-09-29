/** #1693: one effective base for a nested frame (`prefabBase.ts`), and what reads and writes through it.
 *
 *  #1676: a component an ENCLOSING prefab row adds to a nested member, removed in the scene, was never captured as
 *  removed. The capture's removed-components pass read the bare child document's traits, so the scene save, a Refresh
 *  and a prefab-edit save all brought it back. The pass now also measures against the traits the layer adds
 *  (`FrameBase.addedTraits` → `StructureCaptureOpts.layerTraits`).
 *
 *  Driven through the real loader, capture, save and rebuild. Each case names the mutation that turns it red. */


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
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import {
  setActionCallback, pushAction, clearHistory, removeTraitFromEntitiesWithUndo, deleteEntitiesWithUndo,
  addTraitToEntitiesWithUndo, createEntityWithUndo, writeTraitFieldWithUndo, duplicateEntity,
} from '@modoki/engine/editor';
import { reparentEntity } from '../../packages/modoki/src/editor/undo/entityActions';
import {
  setPrefabCache, rebaseStaleInstances, serializePrefab, applyToPrefabSelective, revertOverridesSelective, getCachedPrefabSync, instantiatePrefab, setPrefabSource,
  previewApply, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { describeEffect } from '../../packages/modoki/src/editor/scene/prefabApplyEffects';
import { getOverrideMarkSet } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
import { buildPrefabEditScene, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyTargetOptions } from '../../packages/modoki/src/editor/scene/prefabApplyOptions';
import { isMemberToken } from '../../packages/modoki/src/runtime/core/templateRefs';
import { revertOverridesWithUndo } from '../../packages/modoki/src/editor/undo/revertPrefabUndo';
import { undo, redo } from '../../packages/modoki/src/editor/undo/undoManager';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000001491';
const O = 'cccccccc-0000-4000-8000-000000001490';
const HOLDER = 'dddddddd-0000-4000-8000-000000001490';
const ROOT1 = 'dddddddd-0000-4000-8000-000000001491';
const ROOT2 = 'dddddddd-0000-4000-8000-000000001492';
const gR = 'eeeeeeee-0000-4000-8000-000000001401';
const gA = 'eeeeeeee-0000-4000-8000-000000001402';
const gOR = 'eeeeeeee-0000-4000-8000-000000001403';
const gSlot = 'eeeeeeee-0000-4000-8000-000000001404';
const gSlot2 = 'eeeeeeee-0000-4000-8000-000000001405';
const gN = 'eeeeeeee-0000-4000-8000-000000001406';

const row = (localId: number, name: string, parentId: number, nodeGuid: string, x = 0) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x, y: 0, z: 0 } },
});
/** R → A; `rootTf` overlays R's authored Transform. */
const pDoc = (rootTf: Record<string, number> = {}) => {
  const r = row(1, 'R', 0, gR);
  r.traits.Transform = { ...r.traits.Transform, ...rootTf };
  return { id: P, version: 5, name: 'P', rootLocalId: 1, entities: [r, row(2, 'A', 1, gA)] };
};
/** OR → Slot (x = `slotX`) → N (a reference row expanding P, which — like every real writer's — carries no
 *  Transform of its own); OR → Slot2. */
const oDoc = (slotX = 0) => ({ id: O, version: 5, name: 'O', rootLocalId: 1, entities: [
  row(1, 'OR', 0, gOR), row(2, 'Slot', 1, gSlot, slotX), row(3, 'Slot2', 1, gSlot2),
  { localId: 4, name: 'N', nodeGuid: gN, prefab: P, traits: { EntityAttributes: { name: 'N', parentId: 2, guid: '' } } },
] });
const install = (...docs: Array<{ id?: string }>) => { for (const d of docs) { prefabs.set(d.id!, d); setPrefabCache(d.id!, d as never); } };

/** Holder → two instances of `source`. */
const scene = (source: string, roots = [ROOT1, ROOT2]): SceneData => ({
  id: 'tag-pose', version: 14, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
    ...roots.map((guid, i) => ({ id: 2 + i, prefab: source, guid, traits: { EntityAttributes: { name: `Inst${i + 1}`, parentId: HOLDER } } })),
  ],
} as unknown as SceneData);

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

const rootOf = (guid: string) => getAllEntities().find((e) => e.guid === guid)!.id;
/** The entity named `name` in the instance rooted at `guid` (the root itself included). */
const inInstance = (guid: string, name: string): number => {
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const root = rootOf(guid);
  const hits = all.filter((e) => {
    if (e.name !== name) return false;
    for (let cur: typeof e | undefined = e; cur; cur = byId.get(cur.parentId)) if (cur.id === root) return true;
    return false;
  });
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} entities named ${name} in ${guid}`);
  return hits[0]!.id;
};
const meta = (t: string) => getTraitByName(t)!;
const x = (id: number) => (readTraitData(id, meta('Transform')) as { x: number }).x;

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  writes.length = 0;
  prefabs.clear();
  clearKeptMemberOrphans();
  // The prefab "disk" for a multi-file Apply's pre-read (#1692 `commitPrefabWrites`, #1693 U13): a prefab's last written
  // bytes, else the document installed for it — as a real Response, whose bytes the precondition hashes.
  vi.stubGlobal('fetch', async (url: string) => {
    const id = [...prefabs.keys()].find((k) => String(url).includes(k));
    if (id) {
      const last = writes.filter((w) => (JSON.parse(w.content) as { id?: string }).id === id).pop();
      return new Response(last ? last.content : JSON.stringify(prefabs.get(id)), { status: 200 });
    }
    return { ok: true, json: async () => ({ files: [] }), text: async () => '' };
  });
});
afterAll(() => { for (const id of [P, O, O2]) setPrefabCache(id, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

const O2 = 'cccccccc-0000-4000-8000-000000001693';
const gO2R = 'eeeeeeee-0000-4000-8000-000000001693';
const gM = 'eeeeeeee-0000-4000-8000-000000001694';
/** O whose row N adds Rotate3D to P's member A (P has none): the enclosing layer's component. */
const ROW_ROTATE = { 2: { Rotate3D: { axis: 'x', speed: 3 } } };
const oWith = (ov: Record<number, unknown>, slotX = 0) => { const d = oDoc(slotX); (d.entities[3] as Record<string, unknown>).overrides = ov; return d; };
/** O2R → M, a reference row expanding O. */
const o2Doc = () => ({ id: O2, version: 5, name: 'O2', rootLocalId: 1, entities: [
  row(1, 'O2R', 0, gO2R),
  { localId: 2, name: 'M', nodeGuid: gM, prefab: O, traits: { EntityAttributes: { name: 'M', parentId: 1, guid: '' } } },
] });
const hasRotate = (id: number) => !!readTraitData(id, meta('Rotate3D'));
/** The row M of an O2 whose prefab-edit save removed the row-added Rotate3D from A: `traitRemovals` on member A. */
const o2Removing = () => {
  const d = o2Doc() as ReturnType<typeof o2Doc> & { entities: Array<Record<string, unknown>> };
  (d.entities[1] as Record<string, unknown>).members = { [`/${gN}/${gA}`]: { traitRemovals: { Rotate3D: true } } };
  return d;
};
const saved = async () => {
  const s = await serializeScene() as unknown as SceneData;
  return { scene: s, entry: (s.entities as unknown as Array<Record<string, unknown>>).find((e) => e.prefab === O)! };
};
const editRoot = () => getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!.id;
const onlyNamed = (name: string) => {
  const hits = getAllEntities().filter((e) => e.name === name);
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} entities named ${name}`);
  return hits[0]!.id;
};

describe('#1676: removing a component the enclosing ROW added to a nested member is kept', () => {
  it('by the scene save: the member row states the removal, and a reload leaves A without it', async () => {
    // Mutation: drop `layerTraits` from `captureNestedChannels`' capture — the member row stays `{guid, name}` and the
    // reload brings Rotate3D back.
    install(pDoc(), oWith(ROW_ROTATE));
    await load(scene(O, [ROOT1]));
    expect(hasRotate(inInstance(ROOT1, 'A'))).toBe(true); // precondition: the row adds it
    removeTraitFromEntitiesWithUndo([inInstance(ROOT1, 'A')], meta('Rotate3D'));
    const { entry, scene: s } = await saved();
    const members = entry.members as Record<string, { traitRemovals?: Record<string, boolean> }>;
    expect(members[`/${gN}/${gA}`]?.traitRemovals).toEqual({ Rotate3D: true });
    await load(s);
    expect(hasRotate(inInstance(ROOT1, 'A'))).toBe(false);
  });

  it('by a Refresh after an unrelated template change', async () => {
    // Mutation: drop `layerTraits` from `captureNestedInstanceOverrides`' capture — the rebuild re-expands N's
    // Rotate3D and nothing removes it.
    install(pDoc(), oWith(ROW_ROTATE));
    await load(scene(O, [ROOT1]));
    removeTraitFromEntitiesWithUndo([inInstance(ROOT1, 'A')], meta('Rotate3D'));
    install(oWith(ROW_ROTATE, 9));
    await rebaseStaleInstances();
    expect(x(inInstance(ROOT1, 'Slot'))).toBe(9); // the Refresh did rebuild from the new O
    expect(hasRotate(inInstance(ROOT1, 'A'))).toBe(false);
  });

  it('by a prefab-edit save two layers down: O2 → M (O) → N (P) → A', async () => {
    // Mutation: as the save's — `captureRowChannels` reaches the same `captureNestedChannels`; row M is saved `{}` and
    // re-opening O2 shows Rotate3D on A.
    install(pDoc(), oWith(ROW_ROTATE), o2Doc());
    await load(buildPrefabEditScene(o2Doc() as never));
    expect(hasRotate(onlyNamed('A'))).toBe(true); // precondition
    removeTraitFromEntitiesWithUndo([onlyNamed('A')], meta('Rotate3D'));
    const savedO2 = serializePrefab(editRoot(), O2) as PrefabFile;
    install(savedO2);
    await load(buildPrefabEditScene(savedO2 as never));
    expect(hasRotate(onlyNamed('A'))).toBe(false);
  });
});

describe('#1676 close-out: a trait one layer adds and a layer further out removes', () => {
  it('an untouched scene save of an O2 instance keeps the removal O2 states', async () => {
    // Mutation: filter out of `layerAddedTraits` the traits the layer also removes — the capture lists no removal where
    // the chain states one, the writer reads it as the scene putting Rotate3D BACK (`{Rotate3D: false}`), and the
    // reload shows it on A.
    install(pDoc(), oWith(ROW_ROTATE), o2Removing());
    await load(scene(O2, [ROOT1]));
    expect(hasRotate(inInstance(ROOT1, 'A'))).toBe(false); // precondition: O2's member row removes what N adds
    const s = await serializeScene() as unknown as SceneData;
    const entry = (s.entities as unknown as Array<Record<string, unknown>>).find((e) => e.prefab === O2)!;
    expect(JSON.stringify(entry.members ?? {})).not.toContain('Rotate3D');
    await load(s);
    expect(hasRotate(inInstance(ROOT1, 'A'))).toBe(false);
  });
});

describe('#1685 (the save half): a save measures an instance against the document it was EXPANDED from', () => {
  const gNew2 = 'eeeeeeee-0000-4000-8000-000000001685';
  const gNew3 = 'eeeeeeee-0000-4000-8000-000000001686';
  /** P with two more members, New2 and New3, under R. */
  const pGrown = () => { const d = pDoc(); d.entities.push(row(3, 'New2', 1, gNew2), row(4, 'New3', 1, gNew3)); return d; };

  it('rows the cache has and the instance was never built with are not saved as removed', async () => {
    // Mutation: `savedFrameDoc` answers `current` (measure against the cache) — the save records New2 and
    // New3 as removed by the scene, and the reload lacks them for good.
    install(pDoc());
    await load(scene(P, [ROOT1]));
    install(pGrown()); // the cache moves on; this instance is still the old document's expansion (no rebase)
    const s = await serializeScene() as unknown as SceneData;
    const entry = (s.entities as unknown as Array<Record<string, unknown>>).find((e) => e.prefab === P)!;
    const members = (entry.members ?? {}) as Record<string, { removed?: boolean }>;
    expect(entry.removed).toBeUndefined();
    expect([members[`/${gNew2}`]?.removed, members[`/${gNew3}`]?.removed]).toEqual([undefined, undefined]);
    await load(s);
    expect([inInstance(ROOT1, 'New2'), inInstance(ROOT1, 'New3')].every((id) => id > 0)).toBe(true);
  });
});

describe('#1685 at depth: a nested frame\'s removal is keyed against the document it was captured against', () => {
  const gB = 'eeeeeeee-0000-4000-8000-000000001687';
  /** R → A (2), B (3); `swap` renumbers them: B is 2, A is 3. */
  const pAB = (swap = false) => {
    const d = pDoc();
    d.entities = swap
      ? [d.entities[0]!, row(3, 'A', 1, gA), row(2, 'B', 1, gB)]
      : [d.entities[0]!, row(2, 'A', 1, gA), row(3, 'B', 1, gB)];
    return d;
  };

  it('a nested member the scene deleted is saved as ITS removal after the cache renumbered the nested prefab', async () => {
    // Mutation: `moveChannelsOntoRows`' `frameOf` reads the frame's document from the cache — the removal captured
    // against the record's numbering (B = 3) is keyed to the cache's row 3, A: the reload deletes A and keeps B.
    install(pAB(), oDoc());
    await load(scene(O, [ROOT1]));
    deleteEntitiesWithUndo([inInstance(ROOT1, 'B')]);
    install(pAB(true)); // no rebase: the nested frame is still the old document's expansion
    const { entry, scene: s } = await saved();
    const members = (entry.members ?? {}) as Record<string, { removed?: boolean }>;
    expect([members[`/${gN}/${gB}`]?.removed, members[`/${gN}/${gA}`]?.removed]).toEqual([true, undefined]);
    await load(s);
    const names = getAllEntities().map((e) => e.name);
    expect([names.includes('A'), names.includes('B')]).toEqual([true, false]);
  });
});

describe('#1659: every value Apply writes into a template goes through ONE writer, which tokenizes member refs', () => {
  const Q = 'cccccccc-0000-4000-8000-000000001659';
  const gQR = 'eeeeeeee-0000-4000-8000-000000001659';
  const gQA = 'eeeeeeee-0000-4000-8000-000000001660';
  const qDoc = () => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0, gQR), row(2, 'QA', 1, gQA)] });
  const written = (id: string) => writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((d) => d.id === id).pop();
  const guidOf = (id: number) => getAllEntities().find((e) => e.id === id)!.guid!;
  const focus = (id: number) => readTraitData(id, meta('UIFocusable')) as { navDown?: string; navUp?: string; focusOrder?: number } | null;
  const addChild = (parent: number, name: string, focusData: Record<string, unknown>) => createEntityWithUndo(`Add ${name}`, parent, [
    { name: 'EntityAttributes', data: { name, parentId: parent } }, { name: 'Transform', data: {} },
    { name: 'UIFocusable', data: focusData },
  ], () => {})!;
  const applyKeys = async (root: number, pick: (k: string) => boolean) => {
    const keys = collectInstanceOverrideKeys(root, getCachedPrefabSync(P) as PrefabFile).all.filter(pick);
    const res = await applyToPrefabSelective(root, new Set(keys));
    expect(res.applied).toBe(true);
    return res;
  };

  it('case 1: a promoted node\'s ref to a member is a token, and another instance\'s copy names ITS member', async () => {
    // Mutation: the plain promoted rows skip the tokenizing pass (`promotion.promoted` left out of it) — the template
    // holds instance 1's A guid, and instance 2's Extra points at instance 1's A.
    install(pDoc());
    await load(scene(P, [ROOT1, ROOT2]));
    addChild(rootOf(ROOT1), 'Extra', { navDown: guidOf(inInstance(ROOT1, 'A')) });
    await applyKeys(rootOf(ROOT1), (k) => k.startsWith('+added.'));
    const extraRow = written(P)!.entities.find((e) => e.name === 'Extra')!;
    expect(isMemberToken((extraRow.traits.UIFocusable as { navDown: string }).navDown)).toBe(true);
    expect(focus(inInstance(ROOT2, 'Extra'))?.navDown).toBe(guidOf(inInstance(ROOT2, 'A')));
  });

  it('case 1b: a ref between two nodes promoted in the same Apply names the row the other became', async () => {
    // Mutation: drop `writer.promote` in `insertAddedSubtree` — the promoted nodes' own guids name nothing the template
    // has, and instance 2's Extra points at instance 1's Extra2.
    install(pDoc());
    await load(scene(P, [ROOT1, ROOT2]));
    const e1 = addChild(rootOf(ROOT1), 'Extra', {});
    const e2 = addChild(rootOf(ROOT1), 'Extra2', { navUp: guidOf(e1) });
    expect(guidOf(e2)).toBeTruthy(); // precondition: a ref to it can be made
    writeTraitFieldWithUndo(e1, meta('UIFocusable'), 'navDown', guidOf(e2));
    await applyKeys(rootOf(ROOT1), (k) => k.startsWith('+added.'));
    expect(focus(inInstance(ROOT2, 'Extra'))?.navDown).toBe(guidOf(inInstance(ROOT2, 'Extra2')));
    expect(focus(inInstance(ROOT2, 'Extra2'))?.navUp).toBe(guidOf(inInstance(ROOT2, 'Extra')));
  });

  it('case 2: applying ONE field of an added component writes its other fields through the writer too', async () => {
    // Mutation: seed the component from the raw live bag (the pre-#1659 loop) — `navDown` names instance 1's A.
    install(pDoc());
    await load(scene(P, [ROOT1, ROOT2]));
    addTraitToEntitiesWithUndo([rootOf(ROOT1)], meta('UIFocusable'), { navDown: guidOf(inInstance(ROOT1, 'A')), focusOrder: 2 });
    await applyKeys(rootOf(ROOT1), (k) => k.endsWith('.UIFocusable.focusOrder'));
    const rootRow = written(P)!.entities.find((e) => e.localId === 1)!;
    expect(isMemberToken((rootRow.traits.UIFocusable as { navDown: string }).navDown)).toBe(true);
    expect(focus(rootOf(ROOT2))?.navDown).toBe(guidOf(inInstance(ROOT2, 'A')));
  });

  it('R1: a promoted REFERENCE node\'s override holding a ref into its own instance is a token in that frame', async () => {
    // Mutation: the reference rows skip the tokenizing pass — the row's override names instance 1's QA, and instance
    // 2's nested Q root points at it.
    install(pDoc(), qDoc());
    await load(scene(P, [ROOT1, ROOT2]));
    const qRoot = instantiatePrefab(getCachedPrefabSync(Q) as PrefabFile, rootOf(ROOT1))!;
    setPrefabSource(qRoot, Q);
    const ea = meta('EntityAttributes');
    const qa = getAllEntities().find((e) => e.name === 'QA' && e.parentId === qRoot)!.id;
    for (const [id, guid] of [[qRoot, 'dddddddd-0000-4000-8000-000000001659'], [qa, 'dddddddd-0000-4000-8000-000000001660']] as const) {
      for (const e of getCurrentWorld().entities) if (e.id() === id) e.set(ea.trait, { ...(e.get(ea.trait) as object), guid });
    }
    addTraitToEntitiesWithUndo([qRoot], meta('UIFocusable'), { navDown: 'dddddddd-0000-4000-8000-000000001660' });
    await applyKeys(rootOf(ROOT1), (k) => k.startsWith('+added.'));
    const qRow = written(P)!.entities.find((e) => e.prefab === Q)!;
    const nav = (qRow.overrides?.[1]?.UIFocusable as { navDown?: string } | undefined)?.navDown;
    expect(nav && isMemberToken(nav)).toBe(true);
    const q2 = getAllEntities().find((e) => e.name === 'QR' && e.id !== qRoot && getAllEntities().some((a) => a.name === 'QA' && a.parentId === e.id))!;
    const q2a = getAllEntities().find((e) => e.name === 'QA' && e.parentId === q2.id)!;
    expect(focus(q2.id)?.navDown).toBe(q2a.guid);
  });
});

describe('#1658 / owner ruling C: an edit on a nested instance can be applied to either prefab on its chain', () => {
  const nestedRoot = () => inInstance(ROOT1, 'R');
  const written = (id: string) => writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((d) => d.id === id).pop();
  const listed = () => collectInstanceOverrideKeys(nestedRoot(), getCachedPrefabSync(P) as PrefabFile).all;
  const speedKey = `${gA}.Rotate3D.speed`;
  const rotate = (id: number) => readTraitData(id, meta('Rotate3D')) as { axis?: string; speed?: number } | null;
  /** O's row N adds Rotate3D (speed 3) to P's A; the nested A in ROOT1 turns it to 7. */
  const editSpeed = async () => {
    install(pDoc(), oWith(ROW_ROTATE));
    await load(scene(O, [ROOT1, ROOT2]));
    writeTraitFieldWithUndo(inInstance(ROOT1, 'A'), meta('Rotate3D'), 'speed', 7);
    expect(listed()).toContain(speedKey); // precondition
  };

  it('by default (owner ruling (a)) it goes back where the component came from: an override on O\'s row, P untouched', async () => {
    // Mutation: `defaultKeyLevel` answers the frame's own level for everything — P gains Rotate3D, every P instance with it.
    await editSpeed();
    const res = await applyToPrefabSelective(nestedRoot(), new Set([speedKey]));
    expect(res.targets).toEqual([{ key: speedKey, target: O }]);
    expect(written(P)).toBeUndefined();
    expect(written(O)!.entities.find((e) => e.localId === 4)!.overrides?.[2]?.Rotate3D).toEqual({ axis: 'x', speed: 7 });
    expect([rotate(inInstance(ROOT1, 'A'))?.speed, rotate(inInstance(ROOT2, 'A'))?.speed]).toEqual([7, 7]); // every O
    expect(listed()).not.toContain(speedKey); // the source keeps no override of it (U15)
  });

  it('"Apply to Prefab \'P\'" is the truthful component ADD: P\'s A gains the whole Rotate3D, and O\'s row stops adding it (U13)', async () => {
    // Mutation: in `planApply`'s U13 pass, drop only the KEYED field (`[f]`, not every written one) — O's row keeps
    // `axis`, a partial Rotate3D the reload would still add over P's.
    await editSpeed();
    const res = await applyToPrefabSelective(nestedRoot(), new Set([speedKey]), { default: 'frame' });
    expect(res.targets).toEqual([{ key: speedKey, target: P }]);
    expect(written(P)!.entities.find((e) => e.localId === 2)!.traits.Rotate3D).toMatchObject({ axis: 'x', speed: 7 });
    expect(written(O)!.entities.find((e) => e.localId === 4)!.overrides?.[2]?.Rotate3D).toBeUndefined();
    expect(res.alsoReverted?.map((r) => r.source)).toEqual([O]);
    expect([rotate(inInstance(ROOT1, 'A'))?.speed, rotate(inInstance(ROOT2, 'A'))?.speed]).toEqual([7, 7]);
  });

  it('#1676\'s removal is listed, and applies as "O\'s row stops adding it"; P is not a target for it', async () => {
    // Mutation: `ownInstanceStructure`'s default capture without `layerTraits` (`captureInstanceStructure` for
    // `captureWithLayer`) — the removal is not listed.
    install(pDoc(), oWith(ROW_ROTATE));
    await load(scene(O, [ROOT1, ROOT2]));
    removeTraitFromEntitiesWithUndo([inInstance(ROOT1, 'A')], meta('Rotate3D'));
    const key = `-trait.${gA}.Rotate3D`;
    expect(listed()).toContain(key);
    const refused = await applyToPrefabSelective(nestedRoot(), new Set([key]), { default: 'frame' });
    expect(refused.applied).toBe(false);
    expect(refused.skipped?.[0]?.reason).toMatch(/has no Rotate3D/);
    const res = await applyToPrefabSelective(nestedRoot(), new Set([key]));
    expect(res.targets).toEqual([{ key, target: O }]);
    expect(written(P)).toBeUndefined();
    expect(written(O)!.entities.find((e) => e.localId === 4)!.overrides?.[2]?.Rotate3D).toBeUndefined();
    expect([rotate(inInstance(ROOT1, 'A')), rotate(inInstance(ROOT2, 'A'))]).toEqual([null, null]);
  });

  it('Revert of that removal gives the component back, as the row adds it', async () => {
    // Mutation: drop Revert's put-back of the row's component for a reverted `-trait` key — A stays without Rotate3D.
    install(pDoc(), oWith(ROW_ROTATE));
    await load(scene(O, [ROOT1]));
    removeTraitFromEntitiesWithUndo([inInstance(ROOT1, 'A')], meta('Rotate3D'));
    await revertOverridesSelective(nestedRoot(), new Set([`-trait.${gA}.Rotate3D`]));
    expect(rotate(inInstance(ROOT1, 'A'))).toMatchObject({ axis: 'x', speed: 3 });
    expect(listed()).toEqual([]);
  });

  it('the dialog and the agent op SAY it truthfully: at P it is a component ADD every P gains, and it reverts O\'s override', async () => {
    // Mutation: in `planApply`'s own-frame field branch, decide `adds` against the WHOLE chain (`traitInside(…, 0, …,
    // true)`) — O's row gives A Rotate3D, so the P effect reads as a one-field `setField`. The words are the PLAN's
    // effect (#1736), which the dialog and the agent op both render.
    await editSpeed();
    const t = applyTargetOptions(nestedRoot(), getCachedPrefabSync(P) as PrefabFile, [speedKey]).get(speedKey)!;
    expect(t.defaultTarget).toBe(O);
    expect(t.options.map((o) => o.target).sort()).toEqual([O, P].sort());
    const atP = (await previewApply(nestedRoot(), new Set([speedKey]), { default: 'frame' })).effects[0]!;
    expect(describeEffect(atP)).toBe('add component Rotate3D (axis "x", speed 7) to A in Prefab \'P\' — every P gains it');
    expect(atP.alsoReverts.map((r) => r.name)).toEqual(['O']);
    const atO = (await previewApply(nestedRoot(), new Set([speedKey]))).effects[0]!;
    expect(describeEffect(atO)).toBe('A · Rotate3D.speed → 7 as an override in Prefab \'O\'');
    expect(atO.alsoReverts).toEqual([]);
  });

  it('a target that is not on the chain is refused by name, and nothing is written', async () => {
    // Mutation: fall back to the default level for an unknown target in `resolveKeyLevel` — the key is applied to O.
    await editSpeed();
    const res = await applyToPrefabSelective(nestedRoot(), new Set([speedKey]), { perKey: { [speedKey]: 'cccccccc-0000-4000-8000-00000000dead' } });
    expect(res.applied).toBe(false);
    expect(res.skipped?.[0]?.reason).toMatch(/not a prefab this instance is part of/);
    expect(writes).toHaveLength(0);
  });
});

describe('#1693 P5–P6 close-out review: the cases the second review drove', () => {
  const nestedRoot = () => inInstance(ROOT1, 'R');
  const written = (id: string) => writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((d) => d.id === id).pop();
  const listed = () => collectInstanceOverrideKeys(nestedRoot(), getCachedPrefabSync(P) as PrefabFile).all;
  const guidOf = (id: number) => getAllEntities().find((e) => e.id === id)!.guid!;
  const rotate = (id: number) => readTraitData(id, meta('Rotate3D')) as { axis?: string; speed?: number } | null;
  const focus = (id: number) => readTraitData(id, meta('UIFocusable')) as { navDown?: string } | null;

  it('a removal takes part in U13: an enclosing row that sets a FIELD of the removed component stops setting it', async () => {
    // Mutation: drop the removals from `written` (\`innerRemovals\`) — O's row keeps speed 5, and ROOT2's A gets a
    // Rotate3D back with the schema's axis.
    const p = pDoc();
    (p.entities[1]!.traits as Record<string, unknown>).Rotate3D = { axis: 'x', speed: 1 };
    install(p, oWith({ 2: { Rotate3D: { speed: 5 } } }));
    await load(scene(O, [ROOT1, ROOT2]));
    removeTraitFromEntitiesWithUndo([inInstance(ROOT1, 'A')], meta('Rotate3D'));
    const key = `-trait.${gA}.Rotate3D`;
    const res = await applyToPrefabSelective(nestedRoot(), new Set([key]));
    expect(res.targets).toEqual([{ key, target: P }]);
    expect(written(O)!.entities.find((e) => e.localId === 4)!.overrides?.[2]?.Rotate3D).toBeUndefined();
    expect([rotate(inInstance(ROOT1, 'A')), rotate(inInstance(ROOT2, 'A'))]).toEqual([null, null]);
    expect(listed()).toEqual([]);
  });

  it('a promoted node\'s PROMOTED child has a path: a ref to it is a token, and instance 2\'s copy names its own', async () => {
    // Mutation: drop \`rowPaths.set\` in \`insertAddedSubtree\` — Kid gets no path, and instance 2's Extra points at
    // instance 1's Kid.
    install(pDoc());
    await load(scene(P, [ROOT1, ROOT2]));
    const extra = createEntityWithUndo('Add Extra', rootOf(ROOT1), [
      { name: 'EntityAttributes', data: { name: 'Extra', parentId: rootOf(ROOT1) } }, { name: 'Transform', data: {} },
    ], () => {})!;
    const kid = createEntityWithUndo('Add Kid', extra, [
      { name: 'EntityAttributes', data: { name: 'Kid', parentId: extra } }, { name: 'Transform', data: {} },
    ], () => {})!;
    addTraitToEntitiesWithUndo([extra], meta('UIFocusable'), { navDown: guidOf(kid) });
    const keys = collectInstanceOverrideKeys(rootOf(ROOT1), getCachedPrefabSync(P) as PrefabFile).added;
    expect((await applyToPrefabSelective(rootOf(ROOT1), new Set(keys))).applied).toBe(true);
    expect(focus(inInstance(ROOT2, 'Extra'))?.navDown).toBe(guidOf(inInstance(ROOT2, 'Kid')));
  });

  it('a promoted REFERENCE node\'s override pointing OUT to the written frame is a ^ token: instance 2 names its own member', async () => {
    // Mutation: tokenize the reference row's overrides with \`writer.value(…, at)\` (the climber, which cannot link a
    // scene-added node) — instance 2's nested QR points at instance 1's A.
    const Q = 'cccccccc-0000-4000-8000-000000001761';
    const qDoc = { id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000001761')] };
    install(pDoc(), qDoc);
    await load(scene(P, [ROOT1, ROOT2]));
    const qRoot = instantiatePrefab(getCachedPrefabSync(Q) as PrefabFile, rootOf(ROOT1))!;
    setPrefabSource(qRoot, Q);
    const ea = meta('EntityAttributes');
    for (const e of getCurrentWorld().entities) if (e.id() === qRoot) e.set(ea.trait, { ...(e.get(ea.trait) as object), guid: 'dddddddd-0000-4000-8000-000000001761' });
    addTraitToEntitiesWithUndo([qRoot], meta('UIFocusable'), { navDown: guidOf(inInstance(ROOT1, 'A')) });
    const keys = collectInstanceOverrideKeys(rootOf(ROOT1), getCachedPrefabSync(P) as PrefabFile).added;
    expect((await applyToPrefabSelective(rootOf(ROOT1), new Set(keys))).applied).toBe(true);
    const q2 = getAllEntities().find((e) => e.name === 'QR' && e.id !== qRoot)!;
    expect(focus(q2.id)?.navDown).toBe(guidOf(inInstance(ROOT2, 'A')));
  });

  it('applying one field of an added component leaves NO override of a blank asset ref behind on the source', async () => {
    // Mutation: build the seed's applied fields from the WRITTEN bag (\`Object.keys(traitBag)\`) — the blank \`font\`,
    // left out of the template, stays a pinned override in the saved scene.
    install(pDoc());
    await load(scene(P, [ROOT1]));
    addTraitToEntitiesWithUndo([inInstance(ROOT1, 'A')], meta('Text2D'), { text: 'hi' });
    const key = `${gA}.Text2D.text`;
    expect((await applyToPrefabSelective(rootOf(ROOT1), new Set([key]))).applied).toBe(true);
    const s = await serializeScene() as unknown as SceneData;
    const entry = (s.entities as unknown as Array<Record<string, unknown>>).find((e) => e.prefab === P)!;
    expect(JSON.stringify(entry.members ?? {})).not.toContain('Text2D');
  });

  it('one component\'s fields split across two targets: the outer half is written and stays', async () => {
    // Mutation: drop the \`mine\` filter from the U13 pass — O's speed is dropped again by the P half, and O is not written.
    install(pDoc(), oWith(ROW_ROTATE));
    await load(scene(O, [ROOT1, ROOT2]));
    writeTraitFieldWithUndo(inInstance(ROOT1, 'A'), meta('Rotate3D'), 'speed', 7);
    writeTraitFieldWithUndo(inInstance(ROOT1, 'A'), meta('Rotate3D'), 'axis', 'z');
    const speed = `${gA}.Rotate3D.speed`;
    const axis = `${gA}.Rotate3D.axis`;
    const res = await applyToPrefabSelective(nestedRoot(), new Set([speed, axis]), { perKey: { [speed]: O, [axis]: 'frame' } });
    expect(written(O)!.entities.find((e) => e.localId === 4)!.overrides?.[2]?.Rotate3D?.speed).toBe(7);
    expect((res.alsoReverted ?? []).flatMap((r) => r.keys)).not.toContain(`${gA}.Rotate3D.speed`);
    expect(rotate(inInstance(ROOT2, 'A'))).toMatchObject({ axis: 'z', speed: 7 });
  });
});

describe('U14 (owner, 2026-09-28): Apply on the OUTER instance offers its nested instances\' own edits, into the outer prefab by default', () => {
  const written = (id: string) => writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((d) => d.id === id).pop();
  const outerKeys = () => collectInstanceOverrideKeys(rootOf(ROOT1), getCachedPrefabSync(O) as PrefabFile);
  const nestedKey = `${gN}:${gA}.Transform.x`;
  const tfx = (id: number) => (readTraitData(id, meta('Transform')) as { x: number }).x;
  /** A nested member edited on the outer instance ROOT1: A.x = 5 (P and O's row say nothing about it). */
  const editNested = async () => {
    install(pDoc(), oDoc());
    await load(scene(O, [ROOT1, ROOT2]));
    writeTraitFieldWithUndo(inInstance(ROOT1, 'A'), meta('Transform'), 'x', 5);
  };

  it('the outer instance lists the nested instance\'s edit, keyed through the row that holds it — and not in `all`', async () => {
    // Mutation: drop the nested pass from \`collectInstanceOverrideKeys\` — nothing is listed on the outer instance.
    await editNested();
    const keys = outerKeys();
    expect(keys.nested).toEqual([nestedKey]);
    expect(keys.all).not.toContain(nestedKey);
  });

  it('Apply All writes it into O, as an override on row N; P is untouched; every O shows it; nothing is left listed', async () => {
    // Mutation: default a nested key to its frame's OWN prefab (\`idx\` → the frame's level) — P is written instead.
    await editNested();
    const keys = outerKeys();
    const res = await applyToPrefabSelective(rootOf(ROOT1), new Set([...keys.all, ...keys.nested]));
    expect(res.targets).toEqual([{ key: nestedKey, target: O }]);
    expect(written(P)).toBeUndefined();
    expect(written(O)!.entities.find((e) => e.localId === 4)!.overrides?.[2]?.Transform).toEqual({ x: 5 });
    expect([tfx(inInstance(ROOT1, 'A')), tfx(inInstance(ROOT2, 'A'))]).toEqual([5, 5]);
    expect(outerKeys().nested).toEqual([]);
  });

  it('picked explicitly, "Apply to Prefab \'P\'" writes P\'s template instead', async () => {
    // Mutation: ignore the asked target for a nested key (always the outer) — O is written, P is not.
    await editNested();
    const res = await applyToPrefabSelective(rootOf(ROOT1), new Set([nestedKey]), { perKey: { [nestedKey]: P } });
    expect(res.targets).toEqual([{ key: nestedKey, target: P }]);
    expect((written(P)!.entities.find((e) => e.localId === 2)!.traits.Transform as { x: number }).x).toBe(5);
    expect(written(O)).toBeUndefined();
  });

  it('its targets are the chain from the outer instance inward, the outer one the default', async () => {
    // Mutation: default a nested key's options to the frame's own \`defaultTarget\` — P.
    await editNested();
    const t = applyTargetOptions(rootOf(ROOT1), getCachedPrefabSync(O) as PrefabFile, [nestedKey]).get(nestedKey)!;
    expect(t.defaultTarget).toBe(O);
    expect(t.options.map((o) => o.target).sort()).toEqual([O, P].sort());
  });
});

describe('U12 for a removed NODE: a member the scene deleted inside a nested instance can be removed by the enclosing prefab', () => {
  const written = (id: string) => writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((d) => d.id === id).pop();
  const names = () => getAllEntities().map((e) => e.name);
  const deleteNestedA = async () => {
    install(pDoc(), oDoc());
    await load(scene(O, [ROOT1, ROOT2]));
    deleteEntitiesWithUndo([inInstance(ROOT1, 'A')]);
  };

  it('from the nested instance, target O: row N removes A; P keeps it; every O instance loses it', async () => {
    // Mutation: drop the \`-removed.\` branch of \`writeOuter\` — nothing is written to O, and ROOT2 keeps its A.
    await deleteNestedA();
    const key = `-removed.${gA}`;
    const res = await applyToPrefabSelective(inInstance(ROOT1, 'R'), new Set([key]), { perKey: { [key]: O } });
    expect(res.targets).toEqual([{ key, target: O }]);
    expect(written(P)).toBeUndefined();
    expect(written(O)!.entities.find((e) => e.localId === 4)!.removed).toEqual([2]);
    expect(names().filter((n) => n === 'A')).toEqual([]);
  });

  it('from the OUTER instance (U14), it is listed and goes to O by default', async () => {
    // Mutation: leave member removals out of the nested listing — the key is not offered on the outer instance.
    await deleteNestedA();
    const keys = collectInstanceOverrideKeys(rootOf(ROOT1), getCachedPrefabSync(O) as PrefabFile);
    const key = `-removed.${gN}:${gA}`;
    expect(keys.nested).toContain(key);
    const res = await applyToPrefabSelective(rootOf(ROOT1), new Set([key]));
    expect(res.targets).toEqual([{ key, target: O }]);
    expect(written(O)!.entities.find((e) => e.localId === 4)!.removed).toEqual([2]);
    expect(names().filter((n) => n === 'A')).toEqual([]);
  });
});

describe('#1693 final close-out review: the cases it drove', () => {
  const written = (id: string) => writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((d) => d.id === id).pop();
  const tfx = (id: number) => (readTraitData(id, meta('Transform')) as { x: number }).x;

  it('U14 into the nested frame\'s OWN prefab leaves no pinned override: a later change to P reaches the source', async () => {
    // Mutation: drop \`at.took\` for a U14 template write — the source's A.x stays marked, the save pins it, and a reload
    // over a P with A.x = 9 still shows 5 on ROOT1.
    install(pDoc(), oDoc());
    await load(scene(O, [ROOT1, ROOT2]));
    writeTraitFieldWithUndo(inInstance(ROOT1, 'A'), meta('Transform'), 'x', 5);
    const key = `${gN}:${gA}.Transform.x`;
    expect((await applyToPrefabSelective(rootOf(ROOT1), new Set([key]), { perKey: { [key]: P } })).applied).toBe(true);
    const { scene: s } = await saved();
    const p9 = written(P)!;
    (p9.entities.find((e) => e.localId === 2)!.traits.Transform as { x: number }).x = 9;
    install(p9);
    await load(s);
    expect([tfx(inInstance(ROOT1, 'A')), tfx(inInstance(ROOT2, 'A'))]).toEqual([9, 9]);
  });

  it('the subtraction reaches only the SOURCE frame: another O instance keeps its own edit of the same field', async () => {
    // Mutation: match any root in \`refreshInstances\`' \`appliedFrom\` (\`.find(() => true)\`) — ROOT2's own 7 is taken
    // out too, and it reloads at P's 9.
    install(pDoc(), oDoc());
    await load(scene(O, [ROOT1, ROOT2]));
    writeTraitFieldWithUndo(inInstance(ROOT1, 'A'), meta('Transform'), 'x', 5);
    writeTraitFieldWithUndo(inInstance(ROOT2, 'A'), meta('Transform'), 'x', 7);
    const key = `${gN}:${gA}.Transform.x`;
    expect((await applyToPrefabSelective(rootOf(ROOT1), new Set([key]), { perKey: { [key]: P } })).applied).toBe(true);
    const { scene: s } = await saved();
    const p9 = written(P)!;
    (p9.entities.find((e) => e.localId === 2)!.traits.Transform as { x: number }).x = 9;
    install(p9);
    await load(s);
    expect([tfx(inInstance(ROOT1, 'A')), tfx(inInstance(ROOT2, 'A'))]).toEqual([9, 7]);
  });

  it('a whole component written into P leaves the source frame: a later change to another field of it reaches the source', async () => {
    // Mutation: have \`writeTemplate\` take only the keyed field — the component's \`axis\` stays pinned on the source.
    install(pDoc(), oDoc());
    await load(scene(O, [ROOT1]));
    addTraitToEntitiesWithUndo([inInstance(ROOT1, 'A')], meta('Rotate3D'), { axis: 'x', speed: 2 });
    const key = `${gN}:${gA}.Rotate3D.speed`;
    expect((await applyToPrefabSelective(rootOf(ROOT1), new Set([key]), { perKey: { [key]: P } })).applied).toBe(true);
    const { scene: s } = await saved();
    const pz = written(P)!;
    (pz.entities.find((e) => e.localId === 2)!.traits.Rotate3D as { axis: string }).axis = 'z';
    install(pz);
    await load(s);
    expect((readTraitData(inInstance(ROOT1, 'A'), meta('Rotate3D')) as { axis: string }).axis).toBe('z');
  });

  it('the files are written innermost first: a U14 write into P, then U13\'s into O', async () => {
    // Mutation: put the frame's own file first whatever its level — \`writes\` reads [O, P].
    install(pDoc(), oWith({ 2: { Transform: { x: 3 } } }));
    await load(scene(O, [ROOT1]));
    writeTraitFieldWithUndo(inInstance(ROOT1, 'A'), meta('Transform'), 'x', 5);
    const key = `${gN}:${gA}.Transform.x`;
    const res = await applyToPrefabSelective(rootOf(ROOT1), new Set([key]), { perKey: { [key]: P } });
    expect(res.writes?.map((w) => w.source)).toEqual([P, O]);
    expect(res.alsoReverted).toEqual([{ source: O, keys: [key] }]); // spelled as the outer listing spells it
  });

  it('a removal says what U13 does: at P it also reverts O\'s field override; at O it is a removal, not "stops adding"', async () => {
    // Mutation: leave the frame's own removals out of U13 (\`innerRemovals\` not pushed into \`written\`) — the P effect
    // names no O, and O's row keeps setting a field of the removed component.
    //   And: in \`writeOuter\`, word every removal as \`stopAddingComponent\` — the O effect reads "stops adding".
    const p = pDoc();
    (p.entities[1]!.traits as Record<string, unknown>).Rotate3D = { axis: 'x', speed: 1 };
    install(p, oWith({ 2: { Rotate3D: { speed: 5 } } }));
    await load(scene(O, [ROOT1]));
    removeTraitFromEntitiesWithUndo([inInstance(ROOT1, 'A')], meta('Rotate3D'));
    const key = `-trait.${gA}`.concat('.Rotate3D');
    const atP = (await previewApply(inInstance(ROOT1, 'R'), new Set([key]), { default: 'frame' })).effects[0]!;
    expect(atP.alsoReverts.map((r) => r.name)).toEqual(['O']);
    const atO = (await previewApply(inInstance(ROOT1, 'R'), new Set([key]), { perKey: { [key]: O } })).effects[0]!;
    expect(describeEffect(atO)).toMatch(/^remove Rotate3D from A/);
  });

  it('Revert refuses a U14 nested key instead of rebuilding for nothing', async () => {
    // Mutation: drop the nested-key filter in \`revertOverridesSelective\` — it rebuilds and answers a new root.
    install(pDoc(), oDoc());
    await load(scene(O, [ROOT1]));
    writeTraitFieldWithUndo(inInstance(ROOT1, 'A'), meta('Transform'), 'x', 5);
    expect(await revertOverridesSelective(rootOf(ROOT1), new Set([`${gN}:${gA}.Transform.x`]))).toBeNull();
  });

  it('three prefabs deep, a removed member applied to the outermost is a MEMBER ROW removal on its row', async () => {
    // Mutation: \`writeMemberRemoval\` refuses a non-empty path — nothing is written to O2.
    install(pDoc(), oDoc(), o2Doc());
    await load(scene(O2, [ROOT1]));
    deleteEntitiesWithUndo([inInstance(ROOT1, 'A')]);
    const key = `-removed.${gA}`;
    const res = await applyToPrefabSelective(inInstance(ROOT1, 'R'), new Set([key]), { perKey: { [key]: O2 } });
    expect(res.targets).toEqual([{ key, target: O2 }]);
    expect((written(O2)!.entities.find((e) => e.localId === 2)!.members as Record<string, { removed?: boolean }>)[`/${gN}/${gA}`]?.removed).toBe(true);
  });

  it('a nested ROOT\'s field an outer member row states is written into that member row, where it shows', async () => {
    // Mutation: \`memberKeyAt\` answers null for the frame root — the value goes to \`nestedOverrides\`, under the member
    // row's 7, and the rebuilt R shows 7.
    const o2 = o2Doc() as ReturnType<typeof o2Doc> & { entities: Array<Record<string, unknown>> };
    (o2.entities[1] as Record<string, unknown>).members = { [`/${gN}`]: { traits: { Transform: { x: 7 } } } };
    install(pDoc(), oDoc(), o2);
    await load(scene(O2, [ROOT1]));
    const r = () => inInstance(ROOT1, 'R');
    expect(tfx(r())).toBe(7); // precondition: the member row states it
    writeTraitFieldWithUndo(r(), meta('Transform'), 'x', 3);
    const key = `${gR}.Transform.x`;
    const res = await applyToPrefabSelective(r(), new Set([key]), { perKey: { [key]: O2 } });
    expect(res.targets).toEqual([{ key, target: O2 }]);
    const row = written(O2)!.entities.find((e) => e.localId === 2)!;
    expect((row.members as Record<string, { traits?: { Transform?: { x: number } } }>)[`/${gN}`]?.traits?.Transform?.x).toBe(3);
    expect(tfx(r())).toBe(3);
  });
});

describe('#1730: Revert of a member the scene REMOVED inside a nested instance brings it back WITH the enclosing layer', () => {
  const nestedRoot = () => inInstance(ROOT1, 'R');
  const listed = () => collectInstanceOverrideKeys(nestedRoot(), getCachedPrefabSync(P) as PrefabFile).all;
  const rotate = (id: number) => readTraitData(id, meta('Rotate3D')) as { axis?: string; speed?: number } | null;
  const gB = 'eeeeeeee-0000-4000-8000-000000001730';
  /** P: R → A → {B, D}, B carrying Rotate3D in the template. */
  const pDeep = () => {
    const d = pDoc();
    const b = row(3, 'B', 2, gB) as ReturnType<typeof row> & { traits: Record<string, unknown> };
    b.traits.Rotate3D = { axis: 'y', speed: 1 };
    return { ...d, entities: [...d.entities, b, row(4, 'D', 2, 'eeeeeeee-0000-4000-8000-000000001735')] };
  };
  /** O whose row N says, of A's subtree: A.x = 3 and A gains Rotate3D; B.x = 4 and B loses Rotate3D; D is removed; a
   *  node is added under A. */
  const oDeep = () => {
    const d = oWith({ 2: { Transform: { x: 3 }, Rotate3D: { axis: 'x', speed: 3 } }, 3: { Transform: { x: 4 } } });
    Object.assign(d.entities[3] as Record<string, unknown>, {
      removedTraits: { 3: ['Rotate3D'] },
      removed: [4],
      added: [{ parentLocalId: 2, guid: '', key: 'k1730', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 9, y: 0, z: 0 } }, children: [] }],
    });
    return d;
  };
  async function revertRemovedA(): Promise<void> {
    deleteEntitiesWithUndo([inInstance(ROOT1, 'A')]);
    const key = listed().find((k) => k.startsWith('-removed.'));
    expect(key).toBeDefined(); // precondition: the deletion is the instance's own
    await revertOverridesSelective(nestedRoot(), new Set([key!]));
  }

  it('the row\'s field and its added component come back, nothing phantom is listed, and a save + reload keeps both', async () => {
    // Mutation: drop the put-back of the layer for a reverted `-removed.` (`layerForRestoredMembers` in
    // `revertOverridesSelective`) — A comes back as P's bare member: x = 0, no Rotate3D, and the listing shows
    // `A.Transform.x` and `-trait.A.Rotate3D`, which the save then writes as `traitRemovals`.
    install(pDoc(), oWith({ 2: { Transform: { x: 3 }, Rotate3D: { axis: 'x', speed: 3 } } }));
    await load(scene(O, [ROOT1]));
    expect([x(inInstance(ROOT1, 'A')), rotate(inInstance(ROOT1, 'A'))?.speed]).toEqual([3, 3]); // precondition
    await revertRemovedA();
    expect(x(inInstance(ROOT1, 'A'))).toBe(3);
    expect(rotate(inInstance(ROOT1, 'A'))).toMatchObject({ axis: 'x', speed: 3 });
    expect(listed()).toEqual([]);
    const { scene: s, entry } = await saved();
    expect(JSON.stringify(entry)).not.toContain('traitRemovals');
    await load(s);
    expect(x(inInstance(ROOT1, 'A'))).toBe(3);
    expect(rotate(inInstance(ROOT1, 'A'))).toMatchObject({ axis: 'x', speed: 3 });
  });

  it('what the row says of the restored member\'s DESCENDANTS comes back too: a field, a removed component, an added node', async () => {
    // Mutation: seed only the reverted member's own localId, not its template subtree — B comes back at x = 0 with
    // P's Rotate3D, and D comes back.
    //   And: drop the layer's `removed` from the seed — D, which the row removes, comes back.
    //   And: drop the layer's `removedTraits` from the seed — B keeps P's Rotate3D, listed as the instance's own add.
    //   And: drop the layer's `added` nodes from the seed — Extra is gone after the Revert.
    install(pDeep(), oDeep());
    await load(scene(O, [ROOT1]));
    const state = () => ({
      bx: x(inInstance(ROOT1, 'B')), bRotate: !!rotate(inInstance(ROOT1, 'B')),
      extra: getAllEntities().filter((e) => e.name === 'Extra').map((e) => x(e.id)),
      d: getAllEntities().filter((e) => e.name === 'D').length,
    });
    expect(state()).toEqual({ bx: 4, bRotate: false, extra: [9], d: 0 }); // precondition: the row's statements hold
    await revertRemovedA();
    expect(state()).toEqual({ bx: 4, bRotate: false, extra: [9], d: 0 });
    expect(x(inInstance(ROOT1, 'A'))).toBe(3);
    expect(listed()).toEqual([]);
    const { scene: s } = await saved();
    await load(s);
    expect(state()).toEqual({ bx: 4, bRotate: false, extra: [9], d: 0 });
  });

  it('a subtree member still LIVE (moved out before the delete) is not seeded again: the layer\'s node under it stays single', async () => {
    // Close-out review: the seed covered the whole template subtree, and a live member's capture already carries the
    // layer. Mutation: drop the `live` exclusion in `layerForRestoredMembers` — Extra comes back twice, and the save
    // writes the copy as the scene's own added node.
    const d = pDoc();
    const pD = { ...d, entities: [...d.entities, row(3, 'D', 2, gB)] };
    install(pD, (() => {
      const o = oWith({ 3: { Transform: { x: 7 } } });
      Object.assign(o.entities[3] as Record<string, unknown>, {
        added: [{ parentLocalId: 3, guid: '', key: 'k1730b', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 9, y: 0, z: 0 } }, children: [] }],
      });
      return o;
    })());
    await load(scene(O, [ROOT1]));
    const extras = () => getAllEntities().filter((e) => e.name === 'Extra').length;
    expect(extras()).toBe(1);
    reparentEntity(inInstance(ROOT1, 'D'), nestedRoot());
    await revertRemovedA();
    expect(extras()).toBe(1);
    expect(x(inInstance(ROOT1, 'D'))).toBe(7);
    const { scene: s } = await saved();
    await load(s);
    expect(extras()).toBe(1);
  });

  it('a moved-out REFERENCE row (an owned nested root) under the restored member is live too: the layer\'s node under it stays single', async () => {
    // Second close-out review: an owned nested root is its own `rootInstanceId`, so the live set missed it. Mutation:
    // drop the owned-root branch of the `live` set in `layerForRestoredMembers` — Extra comes back twice and is saved so.
    const Q = 'cccccccc-0000-4000-8000-000000001797';
    const qDoc = { id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000001797')] };
    const d = pDoc();
    const pWithNQ = { ...d, entities: [...d.entities, { localId: 3, name: 'NQ', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001798', prefab: Q, traits: { EntityAttributes: { name: 'NQ', parentId: 2, guid: '' } } }] };
    const o = oWith({});
    Object.assign(o.entities[3] as Record<string, unknown>, {
      added: [{ parentLocalId: 3, guid: '', key: 'k1797', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 9, y: 0, z: 0 } }, children: [] }],
    });
    install(qDoc, pWithNQ, o);
    await load(scene(O, [ROOT1]));
    const extras = () => getAllEntities().filter((e) => e.name === 'Extra').length;
    expect(extras()).toBe(1); // precondition
    reparentEntity(inInstance(ROOT1, 'QR'), nestedRoot());
    await revertRemovedA();
    expect(extras()).toBe(1);
    const { scene: s } = await saved();
    await load(s);
    expect(extras()).toBe(1);
  });

  it('a descendant removed on its OWN key (moved out, then deleted) stays removed, and so does the layer\'s node under it', async () => {
    // The seed does reach it (it is in the reverted member's template subtree and not live), and that is harmless only
    // because the structure pass skips an addition anchored on a member it removes. Mutation: drop that skip in
    // `applyStructureCore` (`loadSceneFile.ts`, `removedLocals`) — Extra comes back hanging off nothing.
    const d = pDoc();
    const pDE = { ...d, entities: [...d.entities, row(3, 'D', 2, gB), row(4, 'E', 3, 'eeeeeeee-0000-4000-8000-000000001799')] };
    const o = oWith({ 4: { Transform: { x: 4 } } });
    Object.assign(o.entities[3] as Record<string, unknown>, {
      added: [{ parentLocalId: 4, guid: '', key: 'k1799', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 9, y: 0, z: 0 } }, children: [] }],
    });
    install(pDE, o);
    await load(scene(O, [ROOT1]));
    const count = (name: string) => getAllEntities().filter((e) => e.name === name).length;
    expect(count('Extra')).toBe(1); // precondition
    reparentEntity(inInstance(ROOT1, 'D'), nestedRoot());
    deleteEntitiesWithUndo([inInstance(ROOT1, 'E')]);
    deleteEntitiesWithUndo([inInstance(ROOT1, 'A')]);
    expect(listed().filter((k) => k.startsWith('-removed.'))).toHaveLength(2); // precondition: E is its own key
    await revertOverridesSelective(nestedRoot(), new Set([`-removed.${gA}`]));
    expect([count('A'), count('D'), count('E'), count('Extra')]).toEqual([1, 1, 0, 0]);
    const { scene: s } = await saved();
    await load(s);
    expect([count('A'), count('D'), count('E'), count('Extra')]).toEqual([1, 1, 0, 0]);
  });

  /** #1737: a frame the rebuild spawns with nothing live to capture gets its WHOLE enclosing layer, as a load builds it.
   *  The rebuild expands its root under the state the layers enclosing it FORWARD (`frameForward`), and the nested
   *  capture subtracts that same state, so every frame the expansion brings in gets the layer whether a capture reaches
   *  it or not. Before, the layer reached a nested frame only through its live capture. The two seeding attempts this
   *  replaced, and why they were backed out, are on #1737. */
  describe('#1737: a frame the rebuild spawns with nothing live to capture gets its WHOLE enclosing layer', () => {
    const Q = 'cccccccc-0000-4000-8000-000000001737';
    const Q2 = 'cccccccc-0000-4000-8000-000000001738';
    const S = 'cccccccc-0000-4000-8000-000000001739';
    const gC = 'eeeeeeee-0000-4000-8000-000000001739';
    const gB = 'eeeeeeee-0000-4000-8000-000000001740';
    /** Q: QR → L. */
    const qDoc = () => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [
      row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000001737'), row(2, 'L', 1, 'eeeeeeee-0000-4000-8000-000000001738'),
    ] });
    /** S: SR → K. */
    const sDoc = () => ({ id: S, version: 5, name: 'S', rootLocalId: 1, entities: [
      row(1, 'SR', 0, 'eeeeeeee-0000-4000-8000-000000001741'), row(2, 'K', 1, 'eeeeeeee-0000-4000-8000-000000001742'),
    ] });
    const ref = (localId: number, name: string, parentId: number, nodeGuid: string, prefab: string) =>
      ({ localId, name, nodeGuid, prefab, traits: { EntityAttributes: { name, parentId, guid: '' } } });
    /** Q2: Q2R → D, a reference row expanding S. */
    const q2Doc = () => ({ id: Q2, version: 5, name: 'Q2', rootLocalId: 1, entities: [
      row(1, 'Q2R', 0, 'eeeeeeee-0000-4000-8000-000000001743'), ref(2, 'D', 1, 'eeeeeeee-0000-4000-8000-000000001744', S),
    ] });
    /** Q: QR → M → D, a reference row expanding S. */
    const qDeepDoc = () => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [
      row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000001737'), row(2, 'M', 1, 'eeeeeeee-0000-4000-8000-000000001745'),
      ref(3, 'D', 2, 'eeeeeeee-0000-4000-8000-000000001744', S),
    ] });
    /** P: R → A → C, a reference row expanding `child`; R → B. */
    const pWithC = (child = Q) => {
      const d = pDoc();
      return { ...d, entities: [...d.entities, ref(3, 'C', 2, gC, child), row(4, 'B', 1, gB)] };
    };
    /** O whose row N reaches into the frames under row 3 of P (C): `nestedOverrides`, path-keyed (`"3.3"` is row 3 of C). */
    const oDeepRow = (nested: Record<string, unknown> = { 3: { 2: { Transform: { x: 6 } } } }) => {
      const o = oWith({});
      Object.assign(o.entities[3] as Record<string, unknown>, { nestedOverrides: nested });
      return o;
    };
    const named = (name: string) => getAllEntities().filter((e) => e.name === name);
    const xsOf = (name: string) => named(name).map((e) => x(e.id));
    const guidsOf = (name: string) => named(name).map((e) => e.guid);
    /** C's frame root QR, and its own listed keys against Q. */
    const cListed = () => collectInstanceOverrideKeys(named('QR')[0]!.id, getCachedPrefabSync(Q) as PrefabFile).all;

    it('#1737: the Revert brings L back at the row\'s 6, listed nowhere, with the guids a load derives; save + reload keep it', async () => {
      // Mutation: expand without the forward state (`forward` in `rebuildInstance`) — L comes back at Q's bare 0.
      install(qDoc(), pWithC(), oDeepRow());
      await load(scene(O, [ROOT1]));
      expect(xsOf('L')).toEqual([6]); // precondition: the row's deep statement holds
      const loaded = [...guidsOf('QR'), ...guidsOf('L')];
      await revertRemovedA();
      expect(xsOf('L')).toEqual([6]);
      expect(listed()).toEqual([]);
      expect(cListed()).toEqual([]);
      // I7: the seeded frame's members take the guids a load derives, never minted ones.
      expect([...guidsOf('QR'), ...guidsOf('L')]).toEqual(loaded);
      const { scene: s, entry } = await saved();
      expect(JSON.stringify(entry)).not.toContain('"x":6');
      expect(JSON.stringify(entry)).not.toContain('"x":0');
      await load(s);
      expect(xsOf('L')).toEqual([6]);
      expect([...guidsOf('QR'), ...guidsOf('L')]).toEqual(loaded);
    });

    it('#1737: the Revert\'s undo takes the frame away again, and its redo brings it back with the row\'s 6', async () => {
      // The redo is a rebuild from the captured reduced state (`rebuildInstanceFromCapture`), which holds nothing of C, so
      // the fix has to live inside the rebuild. Mutation: as above — L is 0 after the Revert and after the redo.
      install(qDoc(), pWithC(), oDeepRow());
      await load(scene(O, [ROOT1]));
      deleteEntitiesWithUndo([inInstance(ROOT1, 'A')]);
      await revertOverridesWithUndo(nestedRoot(), new Set([listed().find((k) => k.startsWith('-removed.'))!]));
      expect(xsOf('L')).toEqual([6]);
      await undo();
      expect(xsOf('L')).toEqual([]);
      await redo();
      expect(xsOf('L')).toEqual([6]);
    });

    it('#1737 depth 2: a reference row inside the restored frame gets the layer too — its K takes the row\'s 8', async () => {
      // Mutation: as above — K comes back at S's 0.
      install(sDoc(), qDeepDoc(), pWithC(), oDeepRow({ '3.3': { 2: { Transform: { x: 8 } } } }));
      await load(scene(O, [ROOT1]));
      expect(xsOf('K')).toEqual([8]); // precondition
      const loaded = guidsOf('K');
      await revertRemovedA();
      expect(xsOf('K')).toEqual([8]);
      expect(guidsOf('K')).toEqual(loaded);
      const { scene: s } = await saved();
      await load(s);
      expect(xsOf('K')).toEqual([8]);
    });

    it('#1737 under a CAPTURED frame: a row C now expands another prefab (#1767), and the new D inside it gets the layer', async () => {
      // The frame C is live and captured; the Refresh re-points its row at Q2, whose row D no capture names. Mutation: as above — K is 0.
      install(qDoc(), sDoc(), q2Doc(), pWithC(), oDeepRow({ '3.2': { 2: { Transform: { x: 8 } } } }));
      await load(scene(O, [ROOT1]));
      expect(xsOf('K')).toEqual([]); // precondition: C expands Q, which has no D
      install(pWithC(Q2));
      await rebaseStaleInstances();
      expect(named('Q2R')).toHaveLength(1); // the Refresh did re-point C
      expect(xsOf('K')).toEqual([8]);
      const { scene: s } = await saved();
      await load(s);
      expect(xsOf('K')).toEqual([8]);
    });

    it('#1737: a Refresh whose template GAINS the reference row the row already reaches into gives it the layer', async () => {
      // Mutation: as above — L comes in at Q's bare 0.
      install(qDoc(), pDoc(), oDeepRow());
      await load(scene(O, [ROOT1]));
      expect(xsOf('L')).toEqual([]); // precondition
      install(pWithC());
      await rebaseStaleInstances();
      expect(xsOf('L')).toEqual([6]);
    });

    /** A scene entry of O whose LEGACY path-keyed channel reaches L through a frame P does not have yet: row N (4) → C (3). */
    const legacyScene = () => {
      const sc = scene(O, [ROOT1]);
      Object.assign((sc.entities as unknown as Array<Record<string, unknown>>)[1]!, { nestedOverrides: { '4.3': { 2: { Transform: { x: 7 } } } } });
      return sc;
    };

    it('#1780: a scene\'s legacy channel into a frame the template does not have yet is written back by a no-edit save', async () => {
      // The kept store holds it while no live frame reaches it (R2's legacy half). Mutation: skip the kept-channel merge
      // in `serializeScene` — the channel is dropped, and a load onto P-with-C shows L at Q's bare 0.
      install(qDoc(), pDoc(), oWith({}));
      await load(legacyScene());
      const { scene: s, entry } = await saved();
      expect(entry.nestedOverrides).toEqual({ '4.3': { 2: { Transform: { x: 7 } } } });
      install(pWithC());
      await load(s);
      expect(xsOf('L')).toEqual([7]);
    });

    it('#1780 with a ROOT-LESS child: a legacy channel through a row whose prefab loads but has no root is kept too', async () => {
      // P has row C, but C's Q names no root row, so the frame '4.3' expands to nothing (#1768). Mutation: drop
      // `expandsToRoot` from `legacyPathReached` — the channel is judged reached, is not kept, and the save drops it.
      const rootless = { ...qDoc(), rootLocalId: 9 };
      install(rootless, pWithC(), oWith({}));
      await load(legacyScene());
      expect(named('L')).toEqual([]); // precondition: nothing expanded for C
      const { scene: s, entry } = await saved();
      expect(entry.nestedOverrides).toEqual({ '4.3': { 2: { Transform: { x: 7 } } } });
      install(qDoc());
      await load(s);
      expect(xsOf('L')).toEqual([7]);
    });

    it('#1780: a Refresh whose template GAINS that frame gives it the scene\'s value, and the save keeps it', async () => {
      // Mutations: skip the kept channels in `rebuildInstance`'s expansion — L comes in at Q's bare 0, and the save drops
      // it; skip `settleKeptLegacy` — the save states L twice, on its member row AND in the legacy channel.
      install(qDoc(), pDoc(), oWith({}));
      await load(legacyScene());
      install(pWithC());
      await rebaseStaleInstances();
      expect(xsOf('L')).toEqual([7]);
      const { scene: s, entry } = await saved();
      // The first save after the frame is live migrates the legacy statement onto L's member row.
      expect(entry.nestedOverrides).toBeUndefined();
      expect(JSON.stringify(entry.members)).toContain('"x":7');
      await load(s);
      expect(xsOf('L')).toEqual([7]);
    });

    it('#1780 close-out F2: a legacy nestedStructure removal into a frame the Refresh gains applies there too, as a load does', async () => {
      // Mutations: forward no kept `nestedStructure` in `rebuildInstance` — L is live after the Refresh, where a load of
      // the same scene removes it; settle no `nestedStructure` in `settleKeptLegacy` — the save states the removal twice
      // over, the kept slot on top of what the capture now writes.
      const legacyRemoval = () => {
        const sc = scene(O, [ROOT1]);
        Object.assign((sc.entities as unknown as Array<Record<string, unknown>>)[1]!, { nestedStructure: { '4.3': { removed: [2] } } });
        return sc;
      };
      install(qDoc(), pWithC(), oWith({}));
      await load(legacyRemoval());
      expect(named('L')).toEqual([]); // the control: a load onto P-with-C applies the removal
      install(qDoc(), pDoc(), oWith({}));
      await load(legacyRemoval());
      install(pWithC());
      await rebaseStaleInstances();
      expect(named('QR')).toHaveLength(1); // precondition: the Refresh brought C in
      expect(named('L')).toEqual([]);
      const { scene: s, entry } = await saved();
      expect((entry.nestedStructure as Record<string, unknown> | undefined)?.['4.3']).toBeUndefined();
      await load(s);
      expect(named('QR')).toHaveLength(1);
      expect(named('L')).toEqual([]);
    });

    it('the accept side: a CAPTURED frame keeps its own edit — nothing restates the layer over it', async () => {
      // A guard for #1737's fix: whatever gives an uncaptured frame its layer must leave a captured frame's own edit.
      install(qDoc(), pWithC(), oDeepRow());
      await load(scene(O, [ROOT1]));
      writeTraitFieldWithUndo(named('L')[0]!.id, meta('Transform'), 'x', 9);
      deleteEntitiesWithUndo([inInstance(ROOT1, 'B')]);
      await revertOverridesSelective(nestedRoot(), new Set([listed().find((k) => k.startsWith('-removed.'))!]));
      expect(named('B')).toHaveLength(1); // precondition: the Revert rebuilt N
      expect(xsOf('L')).toEqual([9]);
    });

    it('a Refresh from ANOTHER version of P applies the layer once: its value, its node, nothing listed or saved', async () => {
      // The expansion folds the forward state against the NEW P and the capture against the OLD one (the baseline), and
      // the row reaches into C in both. Mutation: drop the forward seed from the nested capture (`enclosing` in
      // `captureNestedInstanceOverrides`) — the layer's Extra is captured as the scene's own and comes back twice.
      //   And: expand without the forward state (`forward` in `rebuildInstance`) — the capture still subtracts the layer,
      //   so nothing brings it back: L is 0 and Extra is gone. The two halves hold only together.
      const withExtra = () => {
        const o = oDeepRow();
        Object.assign(o.entities[3] as Record<string, unknown>, { nestedStructure: { 3: { added: [
          { parentLocalId: 2, guid: '', key: 'k1737r', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 5, y: 0, z: 0 } }, children: [] },
        ] } } });
        return o;
      };
      /** P v2: C hangs under a new B instead of A. */
      const pMovedC = () => {
        const d = pDoc();
        return { ...d, entities: [...d.entities, row(4, 'B', 1, gB), ref(3, 'C', 4, gC, Q)] };
      };
      install(qDoc(), pWithC(), withExtra());
      await load(scene(O, [ROOT1]));
      expect([xsOf('L'), xsOf('Extra')]).toEqual([[6], [5]]); // precondition: the row's deep statements hold
      install(pMovedC());
      await rebaseStaleInstances();
      expect(named('QR')).toHaveLength(1); // the Refresh did rebuild N from P v2
      expect([xsOf('L'), xsOf('Extra')]).toEqual([[6], [5]]);
      expect(cListed()).toEqual([]);
      const { scene: s, entry } = await saved();
      expect(JSON.stringify(entry)).not.toContain('Extra');
      expect(JSON.stringify(entry)).not.toContain('"x":6');
      await load(s);
      expect([xsOf('L'), xsOf('Extra')]).toEqual([[6], [5]]);
    });

    it('a member TOKEN the layer forwards resolves in the rebuild\'s own scope: the restored node names the restored L', async () => {
      // The token sits only in a `nestedStructure` slot, which reaches the rebuild's top call as `_layers` alone.
      // Mutation: the top call stops noting `_layers` (`noteTokens` in `instantiatePrefab`) — no scope registers the
      // frame, and Extra keeps the literal token.
      const o = oWith({});
      Object.assign(o.entities[3] as Record<string, unknown>, { nestedStructure: { 3: { added: [
        { parentLocalId: 2, guid: '', key: 'k1737t', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 }, UIFocusable: { navDown: '@member:2' } }, children: [] },
      ] } } });
      install(qDoc(), pWithC(), o);
      await load(scene(O, [ROOT1]));
      const nav = () => named('Extra').map((e) => (readTraitData(e.id, meta('UIFocusable')) as { navDown?: string }).navDown);
      expect(nav()).toEqual(guidsOf('L')); // precondition: a load resolves it to L's guid
      const loaded = nav();
      await revertRemovedA();
      expect(nav()).toEqual(loaded);
      expect(guidsOf('L')).toEqual(loaded);
      expect(listed()).toEqual([]);
      expect(cListed()).toEqual([]);
      const { scene: s, entry } = await saved();
      expect(JSON.stringify(entry)).not.toContain('Extra');
      await load(s);
      expect(nav()).toEqual(loaded);
    });

    it('a STORED root rebuilds as the plain top call it always was: an edit and its Revert leave the saved entities byte-identical', async () => {
      // A stored root nothing encloses gets no forward state, so its expansion is unchanged by #1737's fix. Pinned by
      // the saved entities' bytes, with nested frames carrying a layer and a scene edit of their own. Mutation: hand a
      // stored root a forward state whose stack holds its OWN document (`frameForward`) — the rebuild expands nothing.
      install(qDoc(), pWithC(), oDeepRow());
      await load(scene(O, [ROOT1]));
      writeTraitFieldWithUndo(named('L')[0]!.id, meta('Transform'), 'x', 9);
      const snapshot = () => getAllEntities().map((e) => [e.name, e.guid, (readTraitData(e.id, meta('Transform')) as { x?: number } | null)?.x ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      // The entities' bytes: the save's own `id` and `createdAt` are minted per save.
      const bytes = async () => JSON.stringify((await saved()).scene.entities);
      const before = { bytes: await bytes(), world: snapshot() };
      writeTraitFieldWithUndo(inInstance(ROOT1, 'Slot'), meta('Transform'), 'x', 5);
      const root = rootOf(ROOT1);
      // The packed entity, generation and all: the respawned root can reuse the old index.
      const handle = () => Number(getCurrentWorld().entities.find((e) => e.id() === rootOf(ROOT1)));
      const oldHandle = handle();
      const keys = collectInstanceOverrideKeys(root, getCachedPrefabSync(O) as PrefabFile).all;
      expect(keys).toEqual([`${gSlot}.Transform.x`]); // precondition: Slot's x is the stored root's only own edit
      await revertOverridesSelective(root, new Set(keys));
      expect(handle()).not.toBe(oldHandle); // the Revert did rebuild the stored root
      expect(snapshot()).toEqual(before.world);
      expect(await bytes()).toBe(before.bytes);
    });

    it('a cycle THROUGH the stored root (Q nests O) does not grow a level across two Reverts', async () => {
      // The rebuild's expansion runs under the cycle stack a load had there (close-out review). Mutation: expand under a
      // FRESH stack (`new Set(forward.stack)` in `rebuildInstance`) — each Revert grows O's instance by one more level.
      const qCyc = () => ({ ...qDoc(), entities: [...qDoc().entities, ref(3, 'Back', 1, 'eeeeeeee-0000-4000-8000-000000009999', O)] });
      install(qCyc(), pWithC(), oDeepRow());
      await load(scene(O, [ROOT1]));
      const count = () => [named('OR').length, named('R').length, named('QR').length];
      const before = count();
      await revertRemovedA();
      expect(count()).toEqual(before);
      await revertRemovedA();
      expect(count()).toEqual(before);
    });

    describe('a TEMPLATE reference node\'s frame gets the node\'s channels as its forward state', () => {
      // O's row N adds template node T (a Q: QR → M → D, D expanding S) under P's A. Close-out review: no other #1737 case
      // builds a template node.
      const withT = (node: Record<string, unknown>) => {
        const o = oWith({});
        (o.entities[3] as Record<string, unknown>).added = [{
          parentLocalId: 2, guid: '', key: 'kT1737', name: 'T', prefab: Q, traits: { EntityAttributes: { name: 'T', parentId: 0 } }, children: [], ...node,
        }];
        return o;
      };
      const tRoot = () => named('QR')[0]!.id;
      const tListed = () => collectInstanceOverrideKeys(tRoot(), getCachedPrefabSync(Q) as PrefabFile).all;

      it('a Revert inside T brings D\'s frame back with the node\'s deep value', async () => {
        // Mutation: give a template node's frame no forward state (the node branch of `frameForward`) — K comes back at 0.
        install(sDoc(), qDeepDoc(), pDoc(), withT({ nestedOverrides: { 3: { 2: { Transform: { x: 8 } } } } }));
        await load(scene(O, [ROOT1]));
        expect([xsOf('K'), tListed()]).toEqual([[8], []]); // precondition
        deleteEntitiesWithUndo([named('M')[0]!.id]);
        await revertOverridesSelective(tRoot(), new Set([tListed().find((k) => k.startsWith('-removed.'))!]));
        expect([xsOf('K'), tListed()]).toEqual([[8], []]);
        const { scene: s } = await saved();
        expect(JSON.stringify(s)).not.toContain('"x":8');
        await load(s);
        expect(xsOf('K')).toEqual([8]);
      });

      it('a Refresh whose Q GAINS the row the node reaches into gives it the node\'s value', async () => {
        // Mutation: as above — K comes in at S's 0.
        const qNoD = { ...qDeepDoc(), entities: qDeepDoc().entities.slice(0, 2) };
        install(sDoc(), qNoD, pDoc(), withT({ nestedOverrides: { 3: { 2: { Transform: { x: 8 } } } } }));
        await load(scene(O, [ROOT1]));
        expect(xsOf('K')).toEqual([]); // precondition
        install(qDeepDoc());
        await rebaseStaleInstances();
        expect([xsOf('K'), tListed()]).toEqual([[8], []]);
        const { scene: s } = await saved();
        expect(JSON.stringify(s)).not.toContain('"x":8');
      });

      it('a Refresh of Q applies the node\'s deep ADDED node once', async () => {
        // Mutation: drop the forward seed from the nested capture (`enclosing` in `captureNestedInstanceOverrides`) — Extra
        // is captured as the scene's own and comes back twice.
        install(sDoc(), qDeepDoc(), pDoc(), withT({ nestedStructure: { 3: { added: [
          { parentLocalId: 2, guid: '', key: 'k1737n', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 5, y: 0, z: 0 } }, children: [] },
        ] } } }));
        await load(scene(O, [ROOT1]));
        expect(xsOf('Extra')).toEqual([5]); // precondition
        const q2 = qDeepDoc();
        ((q2.entities[1]!.traits as { Transform: { x: number } }).Transform).x = 3; // Q v2 moves M
        install(q2);
        await rebaseStaleInstances();
        expect(xsOf('M')).toEqual([3]); // the Refresh did rebuild T
        expect([xsOf('Extra'), tListed()]).toEqual([[5], []]);
      });
    });

    describe('guards for #1737\'s fix: a rebuild that brings in a new frame keeps the scene\'s moves and kept rows', () => {
      // Each passes today and FAILED under #1737's first seed, a nested `rebuildInstance` whose world-wide tail (the
      // kept-orphan settle, the guid derive that drains the move queue) ran inside the outer rebuild's (close-out review).
      const gX = 'eeeeeeee-0000-4000-8000-000000009001';
      const STORED_B = 'ffffffff-0000-4000-8000-000000009002';
      /** P: R → A (→ C, a reference row expanding Q, when `withC`); R → B; R → X. */
      const pBX = (withC: boolean, bx = 0) => {
        const d = pDoc();
        return { ...d, entities: [...d.entities, ...(withC ? [ref(3, 'C', 2, gC, Q)] : []), row(4, 'B', 1, gB, bx), row(5, 'X', 1, gX)] };
      };
      /** The scene's rows on N: B keeps a STORED guid that is not its derived one, and X is moved under it. */
      const sceneWithRows = (): SceneData => {
        const sc = scene(O, [ROOT1]) as unknown as { entities: Array<Record<string, unknown>> };
        sc.entities[1]!.members = { [`/${gN}/${gB}`]: { guid: STORED_B, name: 'B' }, [`/${gN}/${gX}`]: { parent: STORED_B, name: 'X' } };
        return sc as unknown as SceneData;
      };
      const parentName = (name: string) => {
        const all = getAllEntities();
        const e = all.find((n) => n.name === name)!;
        return all.find((n) => n.id === e.parentId)?.name;
      };

      it('a Revert keeps a scene move under a STORED-guid member: the move drains after the outer restores the guid', async () => {
        install(qDoc(), pBX(true), oDeepRow());
        await load(sceneWithRows());
        expect([named('B')[0]!.guid, parentName('X')]).toEqual([STORED_B, 'B']); // precondition
        await revertRemovedA();
        expect([named('B')[0]!.guid, parentName('X')]).toEqual([STORED_B, 'B']);
      });

      it('a Refresh that GAINS the reference row keeps the same move', async () => {
        install(qDoc(), pBX(false), oWith({}));
        await load(sceneWithRows());
        expect(parentName('X')).toBe('B'); // precondition
        install(pBX(true));
        await rebaseStaleInstances();
        expect(named('QR')).toHaveLength(1); // the Refresh did bring C in
        expect(parentName('X')).toBe('B');
      });

      it('the scene\'s OWN move still beats the enclosing prefab\'s move across a Revert', async () => {
        const o = oWith({}) as Record<string, unknown>;
        o.moved = { '2.4.5': '@member:3' }; // O moves N's X under Slot2
        install(qDoc(), pBX(true), o);
        await load(scene(O, [ROOT1]));
        expect(parentName('X')).toBe('Slot2'); // precondition: O's move holds
        reparentEntity(inInstance(ROOT1, 'X'), inInstance(ROOT1, 'B'));
        await revertRemovedA();
        expect(parentName('X')).toBe('B');
      });

      it('a kept orphan row reaches its frame when a SIBLING frame is seeded in the same rebuild', async () => {
        const gC1 = 'eeeeeeee-0000-4000-8000-000000009101';
        const gC2 = 'eeeeeeee-0000-4000-8000-000000009102';
        const gL = 'eeeeeeee-0000-4000-8000-000000001738';
        const pWith = (both: boolean) => {
          const d = pDoc();
          return { ...d, entities: [...d.entities, ...(both ? [ref(3, 'C1', 1, gC1, Q), ref(6, 'C2', 1, gC2, Q)] : [])] };
        };
        const sc = scene(O, [ROOT1]) as unknown as { entities: Array<Record<string, unknown>> };
        sc.entities[1]!.members = { [`/${gN}/${gC2}/${gL}`]: { name: 'L', traits: { Transform: { x: 9 } } } };
        install(qDoc(), pWith(false), oWith({}));
        await load(sc as unknown as SceneData);
        install(pWith(true));
        await rebaseStaleInstances();
        expect(xsOf('L').sort()).toEqual([0, 9]);
        const { scene: saved1 } = await saved();
        expect(JSON.stringify(saved1)).toContain('"x":9');
      });
    });

    it('a MISSING prefab: the Revert expands nothing, and the row\'s statement is there once Q resolves (I18)', async () => {
      // A guard for #1737's fix: a row whose child does not resolve must stay unexpanded, its enclosing row's statement kept.
      setPrefabCache(Q, null);
      install(pWithC(), oDeepRow());
      await load(scene(O, [ROOT1]));
      expect(named('QR')).toHaveLength(0); // precondition: Q does not resolve
      await revertRemovedA();
      expect(named('A')).toHaveLength(1);
      expect(named('QR')).toHaveLength(0);
      const { scene: s } = await saved();
      install(qDoc());
      await load(s);
      expect(xsOf('L')).toEqual([6]);
    });
  });

  it('the Revert\'s undo takes the member away again, and its redo brings it back with the layer', async () => {
    // Mutation: seed the layer into a copy the undo entry does not hold (after `RevertResult` is built from
    // `reducedOverrides`/`reducedStructure`) — the redo rebuilds A as the bare template's: x = 0, no Rotate3D.
    install(pDoc(), oWith({ 2: { Transform: { x: 3 }, Rotate3D: { axis: 'x', speed: 3 } } }));
    await load(scene(O, [ROOT1]));
    deleteEntitiesWithUndo([inInstance(ROOT1, 'A')]);
    const key = listed().find((k) => k.startsWith('-removed.'))!;
    await revertOverridesWithUndo(nestedRoot(), new Set([key]));
    const a = () => getAllEntities().filter((e) => e.name === 'A').map((e) => [x(e.id), rotate(e.id)?.speed ?? null]);
    expect(a()).toEqual([[3, 3]]);
    await undo();
    expect(a()).toEqual([]);
    await redo();
    expect(a()).toEqual([[3, 3]]);
    expect(listed()).toEqual([]);
  });
});

describe('#1736: an Apply is ONE plan of per-key effects, keyed by SLOT — the surfaces render it', () => {
  const written = (id: string) => writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((d) => d.id === id).pop();
  const Q = 'cccccccc-0000-4000-8000-000000001736';
  const gN2 = 'eeeeeeee-0000-4000-8000-000000001736';
  const gQR = 'eeeeeeee-0000-4000-8000-000000001737';
  const gQA = 'eeeeeeee-0000-4000-8000-000000001738';
  const gQP = 'eeeeeeee-0000-4000-8000-000000001739';
  const gNQ = 'eeeeeeee-0000-4000-8000-00000000173a';
  const KQ = 'ffffffff-0000-4000-8000-000000001736';
  const tfx = (id: number) => (readTraitData(id, meta('Transform')) as { x: number }).x;
  const ref = (localId: number, name: string, parentId: number, nodeGuid: string, prefab: string, extra: Record<string, unknown> = {}) => ({
    localId, name, nodeGuid, prefab, traits: { EntityAttributes: { name, parentId, guid: '' } }, ...extra,
  });
  /** O: OR → Slot → N (P), OR → Slot2 → `second` — a second reference row. */
  const oWithSecond = (second: Record<string, unknown>, nExtra: Record<string, unknown> = {}) => {
    const d = oDoc() as unknown as { entities: Array<Record<string, unknown>> } & ReturnType<typeof oDoc>;
    Object.assign(d.entities[3]!, nExtra);
    d.entities.push(second);
    return d;
  };
  /** Q: QR → QA, and (with `withP`) QR → QP, a row expanding P. */
  const qDoc = (withP = false) => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [
    row(1, 'QR', 0, gQR), row(2, 'QA', 1, gQA),
    ...(withP ? [ref(3, 'QP', 1, gQP, P)] : []),
  ] });
  /** The entity `name` inside ROOT1 whose ancestors include one named `under` (the row's parent slot). */
  const under = (parent: string, name: string): number => {
    const all = getAllEntities();
    const byId = new Map(all.map((e) => [e.id, e]));
    const root = rootOf(ROOT1);
    const hits = all.filter((e) => {
      if (e.name !== name) return false;
      let inRoot = false;
      let inParent = false;
      for (let c: typeof e | undefined = byId.get(e.parentId); c; c = byId.get(c.parentId)) {
        if (c.name === parent) inParent = true;
        if (c.id === root) inRoot = true;
      }
      return inRoot && inParent;
    });
    if (hits.length !== 1) throw new Error(`fixture: ${hits.length} ${name} under ${parent}`);
    return hits[0]!.id;
  };
  const nestedKeys = () => collectInstanceOverrideKeys(rootOf(ROOT1), getCachedPrefabSync(O) as PrefabFile).nested;
  const k1 = `${gN}:${gA}.Transform.x`;
  const k2 = `${gN2}:${gA}.Transform.x`;
  const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const spies = (['log', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
  };

  describe('#1727: two frames of ONE nested prefab written into that prefab', () => {
    const twoFrames = async (x1: number, x2: number) => {
      install(pDoc(), oWithSecond(ref(5, 'N2', 3, gN2, P)));
      await load(scene(O, [ROOT1, ROOT2]));
      writeTraitFieldWithUndo(under('Slot', 'A'), meta('Transform'), 'x', x1);
      writeTraitFieldWithUndo(under('Slot2', 'A'), meta('Transform'), 'x', x2);
      expect(nestedKeys().sort()).toEqual([k1, k2].sort()); // precondition
    };

    it('with different values is a CONFLICT: refused whole, both keys named, nothing written, both edits kept', async () => {
      // Mutation: drop `clash(had)` in `planApply`'s `claim` — the Apply lands, P's A.x = 9, and N's 5 is gone.
      await twoFrames(5, 9);
      const preview = await previewApply(rootOf(ROOT1), new Set([k1, k2]), { default: 'frame' });
      expect(preview.conflicts).toHaveLength(1);
      expect(preview.conflicts[0]!.keys.map((k) => [k.key, k.value]).sort()).toEqual([[k1, 5], [k2, 9]]);
      expect(preview.effects.map((e) => e.effect.op)).toEqual(['conflict', 'conflict']);
      // Named for a reader (the member and its row), not by key — the keys are in `conflicts` and the refusal.
      expect(describeEffect(preview.effects.find((e) => e.key === k1)!)).toBe(
        `conflict: A · Transform.x in Prefab 'P' is also written by the change to A under row 'N2' (9), not 5 as here — uncheck one, or apply one of them as an override in an enclosing prefab`,
      );
      // …and nothing is named as written: a conflicting plan writes no file.
      expect(preview.files).toEqual([]);
      const res = await quietly(() => applyToPrefabSelective(rootOf(ROOT1), new Set([k1, k2]), { default: 'frame' }));
      expect(res.applied).toBe(false);
      expect(res.refused).toMatch(/^changes write one field or component with different values, so nothing was applied: A · Transform.x in Prefab 'P'/);
      expect(writes).toHaveLength(0);
      expect([tfx(under('Slot', 'A')), tfx(under('Slot2', 'A'))]).toEqual([5, 9]);
    });

    it('a conflict names EVERY key on the slot: 5, 5 and 9 — all three red, each against the OTHER value only', async () => {
      // Mutation: keep only a slot's FIRST claimant in \`claim\` (\`if (!list.length)\`) — N2 (5, equal to N) is never
      // compared, its row is not red, and unchecking N surfaces a new conflict on the next preview.
      const gN3 = 'eeeeeeee-0000-4000-8000-00000000173b';
      const o = oWithSecond(ref(5, 'N2', 3, gN2, P));
      o.entities.push(row(6, 'Slot3', 1, 'eeeeeeee-0000-4000-8000-00000000173c'), ref(7, 'N3', 6, gN3, P));
      install(pDoc(), o);
      await load(scene(O, [ROOT1]));
      writeTraitFieldWithUndo(under('Slot', 'A'), meta('Transform'), 'x', 5);
      writeTraitFieldWithUndo(under('Slot2', 'A'), meta('Transform'), 'x', 5);
      writeTraitFieldWithUndo(under('Slot3', 'A'), meta('Transform'), 'x', 9);
      const k3 = `${gN3}:${gA}.Transform.x`;
      const preview = await previewApply(rootOf(ROOT1), new Set([k1, k2, k3]), { default: 'frame' });
      expect(preview.conflicts).toHaveLength(1);
      expect(preview.conflicts[0]!.keys.map((k) => k.key).sort()).toEqual([k1, k2, k3].sort());
      expect(preview.effects.map((e) => e.effect.op)).toEqual(['conflict', 'conflict', 'conflict']);
      const withOf = (k: string) => { const e = preview.effects.find((x) => x.key === k)!.effect; return e.op === 'conflict' ? e.with.map((w) => w.key).sort() : []; };
      expect(withOf(k2)).toEqual([k3]);
      expect(withOf(k3)).toEqual([k1, k2].sort());
    });

    it('a field against another key\'s whole-component REMOVAL conflicts too, and a key in two conflicts names both', async () => {
      // Mutation: skip \`findConflicts\`' removal pass (\`if (true) continue\`) — N's removal of Rotate3D is not in any
      // conflict, and N2's row says nothing of it.
      //   And: let a key's FIRST conflict set its effect (\`if (e.effect.op === 'conflict') continue\`) — N2 names N3 only,
      // and unchecking N3 surfaces the removal on the next preview.
      const p = pDoc();
      (p.entities[1]!.traits as Record<string, unknown>).Rotate3D = { axis: 'x', speed: 1 };
      const o = oWithSecond(ref(5, 'N2', 3, gN2, P));
      o.entities.push(row(6, 'Slot3', 1, 'eeeeeeee-0000-4000-8000-00000000173c'), ref(7, 'N3', 6, 'eeeeeeee-0000-4000-8000-00000000173b', P));
      install(p, o);
      await load(scene(O, [ROOT1]));
      removeTraitFromEntitiesWithUndo([under('Slot', 'A')], meta('Rotate3D'));
      writeTraitFieldWithUndo(under('Slot2', 'A'), meta('Rotate3D'), 'speed', 5);
      writeTraitFieldWithUndo(under('Slot3', 'A'), meta('Rotate3D'), 'speed', 9);
      const keys = nestedKeys();
      const kRm = keys.find((k) => k.startsWith('-trait.'))!;
      const k2s = keys.find((k) => k.startsWith(`${gN2}:`))!;
      expect(keys).toHaveLength(3); // precondition
      const preview = await previewApply(rootOf(ROOT1), new Set(keys), { default: 'frame' });
      expect(preview.conflicts.map((c) => c.slot).sort()).toEqual(['A · Rotate3D', 'A · Rotate3D.speed']);
      expect(preview.effects.map((e) => e.effect.op)).toEqual(['conflict', 'conflict', 'conflict']);
      const e2 = preview.effects.find((e) => e.key === k2s)!.effect;
      expect(e2.op === 'conflict' ? e2.with.map((w) => w.key).sort() : []).toEqual(keys.filter((k) => k !== k2s).sort());
      expect(e2.op === 'conflict' ? e2.with.find((w) => w.key === kRm)!.value : null).toBe('(removed)');
    });

    it('with EQUAL values writes once: P takes it, both frames and the other O instance show it, nothing stays listed', async () => {
      // Mutation: compare claims by identity (`had.value !== value`) instead of `valuesEqual` — still equal here for a
      // number, so this case guards the ACCEPT side of the conflict rule: refusing equal writes fails it.
      await twoFrames(5, 5);
      const res = await quietly(() => applyToPrefabSelective(rootOf(ROOT1), new Set([k1, k2]), { default: 'frame' }));
      expect(res.applied).toBe(true);
      expect(res.conflicts).toBeUndefined();
      expect((written(P)!.entities.find((e) => e.localId === 2)!.traits.Transform as { x: number }).x).toBe(5);
      expect(res.effects?.map((e) => e.effect.op)).toEqual(['setField', 'setField']);
      expect(nestedKeys()).toEqual([]);
    });

    it('an added component from two frames is said as an ADD on both keys, and differing fields conflict', async () => {
      // Mutation: decide the add in `writeTemplate` against the DOCUMENT BEING WRITTEN (`cur`) instead of the one read —
      // the second key finds the first one's bag and is labelled a one-field `setField` of a component it adds.
      install(pDoc(), oWithSecond(ref(5, 'N2', 3, gN2, P)));
      await load(scene(O, [ROOT1]));
      addTraitToEntitiesWithUndo([under('Slot', 'A')], meta('Rotate3D'), { axis: 'y', speed: 9 });
      addTraitToEntitiesWithUndo([under('Slot2', 'A')], meta('Rotate3D'), { axis: 'y', speed: 9 });
      const s1 = `${gN}:${gA}.Rotate3D.speed`;
      const s2 = `${gN2}:${gA}.Rotate3D.speed`;
      const same = await previewApply(rootOf(ROOT1), new Set([s1, s2]), { default: 'frame' });
      expect(same.conflicts).toEqual([]);
      expect(same.effects.map((e) => e.effect.op)).toEqual(['addComponent', 'addComponent']);
      writeTraitFieldWithUndo(under('Slot2', 'A'), meta('Rotate3D'), 'speed', 2);
      const differ = await previewApply(rootOf(ROOT1), new Set([s1, s2]), { default: 'frame' });
      expect(differ.conflicts.map((c) => c.slot)).toEqual(['A · Rotate3D.speed']);
    });
  });

  describe('#1728: U13\'s "this Apply wrote it here itself" is per SLOT (row, path), not per document', () => {
    it('two prefabs: N → O and NQ → Q — O\'s NQ override is dropped, QA shows 7, and so does a reload', async () => {
      // Mutation: key `wroteAt`/`mine` by `source|lid|trait|field` again (drop `rowLid` and `path` from `slotOf`'s use
      // there) — N's write at O marks NQ's slot "mine", the drop is skipped, O's NQ keeps x = 3, and QA shows 3.
      const x3 = { overrides: { 2: { Transform: { x: 3 } } } };
      install(pDoc(), qDoc(), oWithSecond(ref(5, 'NQ', 3, gNQ, Q, x3), x3));
      await load(scene(O, [ROOT1]));
      writeTraitFieldWithUndo(under('Slot', 'A'), meta('Transform'), 'x', 5);
      writeTraitFieldWithUndo(under('Slot2', 'QA'), meta('Transform'), 'x', 7);
      const kq = `${gNQ}:${gQA}.Transform.x`;
      const res = await quietly(() => applyToPrefabSelective(rootOf(ROOT1), new Set([k1, kq]), { perKey: { [kq]: Q } }));
      expect(res.applied).toBe(true);
      const o = written(O)!;
      expect(o.entities.find((e) => e.localId === 4)!.overrides?.[2]?.Transform).toEqual({ x: 5 });
      expect(o.entities.find((e) => e.localId === 5)!.overrides?.[2]?.Transform).toBeUndefined();
      expect(res.alsoReverted).toEqual([{ source: O, keys: [kq] }]);
      expect(res.effects?.find((e) => e.key === kq)!.alsoReverts).toEqual([{ source: O, name: 'O', keys: [kq], what: ['its override of Transform.x on QA'] }]);
      expect(tfx(under('Slot2', 'QA'))).toBe(7);
      const { scene: s } = await saved();
      install(written(Q)!, o);
      await load(s);
      expect([tfx(under('Slot', 'A')), tfx(under('Slot2', 'QA'))]).toEqual([5, 7]);
    });

    it('one prefab: N → O and N2 → P — O\'s N2 override is dropped', async () => {
      // Mutation: as above — O's N2 keeps x = 3 and A under Slot2 shows 3.
      const x3 = { overrides: { 2: { Transform: { x: 3 } } } };
      install(pDoc(), oWithSecond(ref(5, 'N2', 3, gN2, P, x3), x3));
      await load(scene(O, [ROOT1]));
      writeTraitFieldWithUndo(under('Slot', 'A'), meta('Transform'), 'x', 5);
      writeTraitFieldWithUndo(under('Slot2', 'A'), meta('Transform'), 'x', 7);
      const res = await quietly(() => applyToPrefabSelective(rootOf(ROOT1), new Set([k1, k2]), { perKey: { [k2]: P } }));
      expect(res.applied).toBe(true);
      expect(written(O)!.entities.find((e) => e.localId === 5)!.overrides?.[2]?.Transform).toBeUndefined();
      expect([tfx(under('Slot', 'A')), tfx(under('Slot2', 'A'))]).toEqual([5, 7]);
    });
  });

  it('a conflict two nesting levels down names the WHOLE row path of the other change', async () => {
    // Mutation: name only the chain's LAST row in \`whoOf\` — both instances hang from row 'N', and each row names the
    // other exactly as itself: "the change to A under row 'N'".
    const gS1 = 'eeeeeeee-0000-4000-8000-00000000173d';
    const gS2 = 'eeeeeeee-0000-4000-8000-00000000173e';
    const gM2 = 'eeeeeeee-0000-4000-8000-00000000173f';
    const o2 = { id: O2, version: 5, name: 'O2', rootLocalId: 1, entities: [
      row(1, 'O2R', 0, gO2R), row(2, 'S1', 1, gS1), row(3, 'S2', 1, gS2),
      ref(4, 'M1', 2, gM, O), ref(5, 'M2', 3, gM2, O),
    ] };
    install(pDoc(), oDoc(), o2);
    await load(scene(O2, [ROOT1]));
    writeTraitFieldWithUndo(under('S1', 'A'), meta('Transform'), 'x', 5);
    writeTraitFieldWithUndo(under('S2', 'A'), meta('Transform'), 'x', 9);
    const keys = collectInstanceOverrideKeys(rootOf(ROOT1), getCachedPrefabSync(O2) as PrefabFile).nested;
    expect(keys).toHaveLength(2); // precondition
    const preview = await previewApply(rootOf(ROOT1), new Set(keys), { default: 'frame' });
    const first = preview.effects.find((e) => e.key.startsWith(gM))!.effect;
    expect(first.op === 'conflict' ? first.with[0]!.who : '').toBe("A under row 'M2 › N'");
  });

  it('#1715 (pool half): P reached at two depths refreshes BEFORE Q, which contains it — the deep frame follows a later P edit', async () => {
    // Mutation (BOTH, since each alone orders this case right — a redundant property): record the pool level at first
    // use (`levels[0]`) AND drop the containment test in `innermostFirst` — writes run [Q, P], the deep frame's applied
    // 7 stays marked, the save pins it, and P's later 9 reaches the direct frame only (9, 7).
    install(pDoc(), qDoc(true), oWithSecond(ref(5, 'NQ', 3, gNQ, Q)));
    await load(scene(O, [ROOT1]));
    writeTraitFieldWithUndo(under('Slot2', 'QA'), meta('Transform'), 'x', 4);
    writeTraitFieldWithUndo(under('Slot', 'A'), meta('Transform'), 'x', 7);
    writeTraitFieldWithUndo(under('QR', 'A'), meta('Transform'), 'x', 7);
    const keys = nestedKeys();
    const kq = keys.find((k) => k.includes(gQA))!;
    const direct = keys.find((k) => k.startsWith(`${gN}:`))!;
    const deep = keys.find((k) => k !== kq && k !== direct)!;
    expect([kq, direct, deep].every(Boolean)).toBe(true); // precondition
    // The caller's order, Q first — the agent op passes keys as given.
    const res = await quietly(() => applyToPrefabSelective(rootOf(ROOT1), new Set([kq, direct, deep]), { perKey: { [kq]: Q, [direct]: P, [deep]: P } }));
    expect(res.writes?.map((w) => w.source)).toEqual([P, Q]);
    const { scene: s } = await saved();
    const p9 = written(P)!;
    (p9.entities.find((e) => e.localId === 2)!.traits.Transform as { x: number }).x = 9;
    install(p9, written(Q)!);
    await load(s);
    expect([tfx(under('Slot', 'A')), tfx(under('QR', 'A')), tfx(under('Slot2', 'QA'))]).toEqual([9, 9, 4]);
  });

  describe('#1731: a template reference node that states the applied field', () => {
    /** O's row N adds a keyed Q node under R, which states `stated` about QA; the scene sets QA.x = 7 on it. */
    const nodeCase = async (stated: Record<string, unknown>) => {
      const node = { parentLocalId: 1, key: KQ, guid: '', name: 'QN', prefab: Q, traits: {}, children: [], ...stated };
      install(pDoc(), qDoc(), oWith({}) as never);
      const o = oDoc() as unknown as { entities: Array<Record<string, unknown>> };
      o.entities[3]!.added = [node];
      install(o as never);
      await load(scene(O, [ROOT1]));
      const qa = under('QR', 'QA');
      expect(tfx(qa)).toBe(3); // precondition: the node states it
      writeTraitFieldWithUndo(qa, meta('Transform'), 'x', 7);
      return { qa, nodeRoot: under('R', 'QR') };
    };
    const entityOf = (id: number) => getCurrentWorld().entities.find((e) => e.id() === id)!;

    it('writes Q, says so truthfully (no "not applied"), and the instance keeps 7 as its own, marked edit', async () => {
      // Mutation: drop the `w.keep?.(…)` call — the refresh subtracts the applied field, QA's 7 loses its override mark,
      // and the listing (by value) and the mark disagree.
      //   And: drop the note — the key's effect says nothing of the node that still states 3.
      const { qa, nodeRoot } = await nodeCase({ overrides: { 2: { Transform: { x: 3 } } } });
      const key = `${gQA}.Transform.x`;
      const res = await quietly(() => applyToPrefabSelective(nodeRoot, new Set([key])));
      expect(res.applied).toBe(true);
      expect(res.skipped).toBeUndefined();
      expect((written(Q)!.entities.find((e) => e.localId === 2)!.traits.Transform as { x: number }).x).toBe(7);
      const e = res.effects!.find((x) => x.key === key)!;
      expect(e.effect).toMatchObject({ op: 'setField', to: 7 });
      expect(e.note).toMatch(/^the template node holding this instance sets Transform.x = 3 on it/);
      expect(tfx(under('QR', 'QA'))).toBe(7);
      expect(getOverrideMarkSet(entityOf(under('QR', 'QA')))?.has('Transform.x')).toBe(true);
      expect(qa).toBeTruthy();
      expect(collectInstanceOverrideKeys(under('R', 'QR'), getCachedPrefabSync(Q) as PrefabFile).fields).toContain(key);
    });

    it('a node stating it on a MEMBER ROW is seen too', async () => {
      // Mutation: pass `null` as the member key to `statedFields(node, …)` (the pre-fix call) — no note.
      const { nodeRoot } = await nodeCase({ members: { [`/${gQA}`]: { traits: { Transform: { x: 3 } } } } });
      const key = `${gQA}.Transform.x`;
      const res = await quietly(() => applyToPrefabSelective(nodeRoot, new Set([key])));
      expect(res.effects!.find((x) => x.key === key)!.note).toMatch(/template node/);
    });
  });

  describe('the preview IS the plan the commit runs (hub ask: never apply a stale preview)', () => {
    it('a dry run writes nothing; its fingerprint applies; a changed world since the preview is refused, not written', async () => {
      // Mutation: drop the `opts.expect` check in `applyToPrefabSelective` — the stale Apply writes P's A.x = 6.
      install(pDoc(), oDoc());
      await load(scene(O, [ROOT1]));
      writeTraitFieldWithUndo(under('Slot', 'A'), meta('Transform'), 'x', 5);
      const shown = await previewApply(rootOf(ROOT1), new Set([k1]), { default: 'frame' });
      expect(writes).toHaveLength(0);
      expect(shown.files.map((f) => f.file)).toEqual([`${P}`]);
      writeTraitFieldWithUndo(under('Slot', 'A'), meta('Transform'), 'x', 6); // the world moves after the preview
      const stale = await quietly(() => applyToPrefabSelective(rootOf(ROOT1), new Set([k1]), { default: 'frame' }, { expect: shown.fingerprint }));
      expect(stale.refused).toMatch(/changed since it was shown/);
      expect(writes).toHaveLength(0);
      const fresh = await previewApply(rootOf(ROOT1), new Set([k1]), { default: 'frame' });
      const ok = await quietly(() => applyToPrefabSelective(rootOf(ROOT1), new Set([k1]), { default: 'frame' }, { expect: fresh.fingerprint }));
      expect(ok.applied).toBe(true);
      expect((written(P)!.entities.find((e) => e.localId === 2)!.traits.Transform as { x: number }).x).toBe(6);
    });
  });
});

// #1781: a TEMPLATE reference node T (O's row N adds it under P's A; T is a Q: QR → M → D, D a reference row expanding
// S: SR → K) whose own statement ADDS a component to a member. The live capture measured T's frames against the bare
// documents, so the added component came out whole with every schema default, never equalled the sparse statement, and
// `sameAddedNode` read T as edited: an untouched save pinned it into the scene, and a Refresh respawned it from the live
// capture, so a template change to T never reached the instance. Values are now compared by subtraction over the base
// SEEDED with the chain node's statement (`sameNodeValues`).
describe('#1781: a template reference node whose statement adds a component is not pinned', () => {
  const Q = 'cccccccc-0000-4000-8000-000000001781';
  const S = 'cccccccc-0000-4000-8000-000000001782';
  const ref = (localId: number, name: string, parentId: number, nodeGuid: string, prefab: string) =>
    ({ localId, name, nodeGuid, prefab, traits: { EntityAttributes: { name, parentId, guid: '' } } as Record<string, unknown> } as Record<string, unknown>);
  const sDoc = () => ({ id: S, version: 5, name: 'S', rootLocalId: 1, entities: [
    row(1, 'SR', 0, 'eeeeeeee-0000-4000-8000-000000001781'), row(2, 'K', 1, 'eeeeeeee-0000-4000-8000-000000001782'),
  ] });
  /** Q: QR → M → D (expanding S). `dOverrides` is what Q's own row D states about S's members. */
  const qDoc = (dOverrides?: Record<number, unknown>) => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [
    row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000001783'), row(2, 'M', 1, 'eeeeeeee-0000-4000-8000-000000001784'),
    { ...ref(3, 'D', 2, 'eeeeeeee-0000-4000-8000-000000001785', S), ...(dOverrides ? { overrides: dOverrides } : {}) },
  ] });
  const withT = (node: Record<string, unknown>) => {
    const o = oWith({});
    (o.entities[3] as Record<string, unknown>).added = [{
      parentLocalId: 2, guid: '', key: 'kT1781', name: 'T', prefab: Q, traits: { EntityAttributes: { name: 'T', parentId: 0 } }, children: [], ...node,
    }];
    return o;
  };
  const named = (name: string) => getAllEntities().filter((e) => e.name === name);
  const focus = (name: string) => readTraitData(named(name)[0]!.id, meta('UIFocusable')) as { focusable?: boolean; focusOrder?: number } | null;
  const entryText = async () => JSON.stringify((await saved()).entry);

  for (const [label, stmt] of [['UIFocusable', { UIFocusable: { focusOrder: 3 } }], ['Rotate3D', { Rotate3D: { axis: 'x' } }]] as const) {
    it(`an untouched load saves nothing for T when its deep statement adds ${label}`, async () => {
      // Mutation: drop the seed (`opts.seed` in `captureNestedChannels`' chainLayer) — the save writes T whole, the
      // component with every schema default. Mutation: keep `nestedOverrides` in `withoutNodeValues` — the same.
      install(sDoc(), qDoc(), pDoc(), withT({ nestedOverrides: { 3: { 2: stmt } } }));
      await load(scene(O, [ROOT1]));
      expect(readTraitData(named('K')[0]!.id, meta(label))).toBeTruthy(); // precondition: the statement applied
      const text = await entryText();
      expect(text).not.toContain(label);
      expect(text).not.toContain('"added"');
    });
  }

  it('the root-frame twin: T\'s own `overrides` adding a component to M saves nothing either', async () => {
    // Mutation: measure T's root frame against the seed's fold alone (drop `chain.overrides` from `rootChain`) — T is
    // pinned with M's UIFocusable written whole.
    install(sDoc(), qDoc(), pDoc(), withT({ overrides: { 2: { UIFocusable: { focusOrder: 3 } } } }));
    await load(scene(O, [ROOT1]));
    expect(focus('M')?.focusOrder).toBe(3); // precondition
    expect(await entryText()).not.toContain('UIFocusable');
  });

  it('a Refresh after O changes T\'s statement brings the new value to the instance', async () => {
    // Mutation: drop the seed — the Refresh respawns T from the live capture, and K keeps focusOrder 3.
    install(sDoc(), qDoc(), pDoc(), withT({ nestedOverrides: { 3: { 2: { UIFocusable: { focusOrder: 3 } } } } }));
    await load(scene(O, [ROOT1]));
    install(withT({ nestedOverrides: { 3: { 2: { UIFocusable: { focusOrder: 5 } } } } }));
    await rebaseStaleInstances();
    expect(focus('K')?.focusOrder).toBe(5);
    expect(await entryText()).not.toContain('UIFocusable');
  });

  it('E13: a real scene edit on top of the statement is still saved, and a reload keeps it', async () => {
    // Q's row D sets focusable false, T states focusOrder 3, and the scene sets focusable back to TRUE — the schema
    // default, but not the value below it. Mutation: make `sameNodeValues` answer true — the edit is dropped on save and
    // the reload shows Q's false. (Subtracting T's statement alone, the variant the design rejected, loses it the same way.)
    install(sDoc(), qDoc({ 2: { UIFocusable: { focusable: false } } }), pDoc(), withT({ nestedOverrides: { 3: { 2: { UIFocusable: { focusOrder: 3 } } } } }));
    await load(scene(O, [ROOT1]));
    expect(focus('K')).toMatchObject({ focusable: false, focusOrder: 3 }); // precondition
    writeTraitFieldWithUndo(named('K')[0]!.id, meta('UIFocusable'), 'focusable', true);
    const { scene: s } = await saved();
    expect(JSON.stringify(s)).toContain('"focusable":true');
    await load(s);
    expect(focus('K')).toMatchObject({ focusable: true, focusOrder: 3 });
  });

  it('a scene REMOVAL of a component T\'s statement adds is saved, in the root frame and a nested one (close-out review F2)', async () => {
    // No live field shows a removal, so the value subtraction alone read T as unchanged and the save dropped it. Mutation:
    // drop the removal checks in `sameNodeValues` (`moreRemovals`) — the reload brings UIFocusable back.
    for (const [where, stmt] of [['M', { overrides: { 2: { UIFocusable: { focusOrder: 3 } } } }], ['K', { nestedOverrides: { 3: { 2: { UIFocusable: { focusOrder: 3 } } } } }]] as const) {
      install(sDoc(), qDoc(), pDoc(), withT(stmt));
      await load(scene(O, [ROOT1]));
      expect(focus(where), where).toBeTruthy(); // precondition
      removeTraitFromEntitiesWithUndo([named(where)[0]!.id], meta('UIFocusable'));
      const { scene: s } = await saved();
      await load(s);
      expect(focus(where), where).toBeNull();
    }
  });

  // #1804, the WRITER twin: a prefab-edit save of O measured T's frames against the bare documents too, so a no-edit save
  // rewrote T's statement with every schema default, and its name as the child root's (QR).
  const nodeT = (o: PrefabFile) => (o.entities.flatMap((e) => (e as { added?: Array<Record<string, unknown>> }).added ?? []))
    .find((n) => n.key === 'kT1781')!;
  for (const [where, stmt] of [['a nested frame', { nestedOverrides: { 3: { 2: { UIFocusable: { focusOrder: 3 } } } } }], ['its root frame', { overrides: { 2: { UIFocusable: { focusOrder: 3 } } } }]] as const) {
    it(`#1804: an untouched prefab-edit save of O rewrites T's statement into ${where} as it was, and its name`, async () => {
      // Mutation: drop the chain node's seed in `finishTemplateReferenceNode` — the component is written whole.
      const o = withT(stmt);
      install(sDoc(), qDoc(), pDoc(), o);
      await load(buildPrefabEditScene(o as never));
      const first = serializePrefab(editRoot(), O) as PrefabFile;
      const t = nodeT(first);
      const want = nodeT(o as unknown as PrefabFile);
      expect(t.name).toBe('T');
      expect(t.nestedOverrides ?? {}).toEqual(want.nestedOverrides ?? {});
      expect(t.overrides ?? {}).toEqual(want.overrides ?? {});
      // …and a file the writer wrote rewrites byte for byte (the fixture above is hand-written, so its bytes are not the
      // writer's: an empty `overrides`, no `traits` bag).
      install(first);
      await load(buildPrefabEditScene(first as never));
      expect(JSON.stringify(nodeT(serializePrefab(editRoot(), O) as PrefabFile))).toBe(JSON.stringify(t));
    });
  }

  for (const [where, stmt, who] of [['a nested frame', { nestedOverrides: { 3: { 2: { UIFocusable: {} } } } }, 'K'], ['its root frame', { overrides: { 2: { UIFocusable: {} } } }, 'M']] as const) {
    it(`#1804: a statement adding a component at its DEFAULTS (\`{}\`) into ${where} survives a no-edit save and reopens`, async () => {
      // Close-out review: a capture holding only defaults kept no field of the component, so the whole component went.
      // Mutation: keep an added component only when the capture has no fields (the tag clause alone) — it is dropped.
      const o = withT(stmt);
      install(sDoc(), qDoc(), pDoc(), o);
      await load(buildPrefabEditScene(o as never));
      const first = serializePrefab(editRoot(), O) as PrefabFile;
      expect({ overrides: nodeT(first).overrides ?? {}, nestedOverrides: nodeT(first).nestedOverrides ?? {} })
        .toEqual({ overrides: nodeT(o as unknown as PrefabFile).overrides ?? {}, nestedOverrides: nodeT(o as unknown as PrefabFile).nestedOverrides ?? {} });
      install(first);
      await load(buildPrefabEditScene(first as never));
      expect(focus(who)).toBeTruthy();
    });
  }

  it('#1804: an edit to a field the statement set writes only that field', async () => {
    const o = withT({ nestedOverrides: { 3: { 2: { UIFocusable: { focusOrder: 3 } } } } });
    install(sDoc(), qDoc(), pDoc(), o);
    await load(buildPrefabEditScene(o as never));
    writeTraitFieldWithUndo(named('K')[0]!.id, meta('UIFocusable'), 'focusOrder', 6);
    const t = nodeT(serializePrefab(editRoot(), O) as PrefabFile);
    expect(t.nestedOverrides).toEqual({ 3: { 2: { UIFocusable: { focusOrder: 6 } } } });
  });

  it('#1804: an edit to a field the statement does NOT set is written beside the statement, and reopens', async () => {
    // Mutation: keep only the fields the node's layer states in `keepNodeStated` (drop the `changed` half) — the edit is lost.
    const o = withT({ nestedOverrides: { 3: { 2: { UIFocusable: { focusOrder: 3 } } } } });
    install(sDoc(), qDoc(), pDoc(), o);
    await load(buildPrefabEditScene(o as never));
    writeTraitFieldWithUndo(named('K')[0]!.id, meta('UIFocusable'), 'focusable', false);
    const first = serializePrefab(editRoot(), O) as PrefabFile;
    expect(nodeT(first).nestedOverrides).toEqual({ 3: { 2: { UIFocusable: { focusOrder: 3, focusable: false } } } });
    install(first);
    await load(buildPrefabEditScene(first as never));
    expect(focus('K')).toMatchObject({ focusable: false, focusOrder: 3 });
  });

  it('E9: a component a lower ROW adds, restated by T, saves nothing from an untouched load', async () => {
    // The case #1386's rule already covered (the row is in the chain): kept as a regression beside the new one.
    install(sDoc(), qDoc({ 2: { UIFocusable: { focusOrder: 1 } } }), pDoc(), withT({ nestedOverrides: { 3: { 2: { UIFocusable: { focusOrder: 3 } } } } }));
    await load(scene(O, [ROOT1]));
    expect(focus('K')?.focusOrder).toBe(3); // precondition
    expect(await entryText()).not.toContain('UIFocusable');
  });
});

// #1779: a template-added node with NO key and NO durable guid (no editor writer emits one; a hand- or agent-written file
// can) matched nothing in the rebuild's subtraction, so every rebuild spawned it twice. It is now paired with the one live
// node without a template key under the same parent with the same name, when that name is unique on both sides — and
// nothing derived from the pairing is persisted, so a scene statement cannot be keyed on it and re-target.
describe('#1779: an unkeyed, guid-less template node is spawned once by a rebuild, and nothing re-targets', () => {
  const Q = 'cccccccc-0000-4000-8000-000000001779';
  const gC = 'eeeeeeee-0000-4000-8000-000000001779';
  const gB = 'eeeeeeee-0000-4000-8000-000000001780';
  const qDoc = () => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [
    row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000001781'), row(2, 'L', 1, 'eeeeeeee-0000-4000-8000-000000001782'),
  ] });
  /** P: R → A → C (a reference row expanding Q, carrying `cExtra`); R → B (x = `bx`). */
  const pWithC = (cExtra: Record<string, unknown> = {}, bx = 0) => {
    const d = pDoc();
    const c = { localId: 3, name: 'C', nodeGuid: gC, prefab: Q, traits: { EntityAttributes: { name: 'C', parentId: 2, guid: '' } }, ...cExtra };
    return { ...d, entities: [...d.entities, c, row(4, 'B', 1, gB, bx)] };
  };
  const node = (name: string, x: number) => ({ parentLocalId: 2, guid: '', name, traits: { EntityAttributes: { name, parentId: 0 }, Transform: { x, y: 0, z: 0 } }, children: [] });
  const xsOf = (name: string) => getAllEntities().filter((e) => e.name === name).map((e) => x(e.id));
  /** Refresh P after an unrelated change (B.x = 1), keeping C's own list as given. */
  const refreshP = async (cExtra: Record<string, unknown> = {}) => { install(pWithC(cExtra, 1)); await rebaseStaleInstances(); };

  it('(a) on P\'s own row: a Refresh spawns it once', async () => {
    // Mutation: drop the pairing (`?? paired` in `subtractChainStructure`) — Extra comes back [5, 5].
    const own = { added: [node('Extra', 5)] };
    install(qDoc(), pWithC(own), oWith({}));
    await load(scene(O, [ROOT1]));
    await refreshP(own);
    expect(xsOf('B')).toEqual([1]); // the Refresh did rebuild
    expect(xsOf('Extra')).toEqual([5]);
  });

  it('(b) in an enclosing layer\'s slot: a Refresh spawns it once', async () => {
    // Mutation: as above.
    const o = oWith({});
    Object.assign(o.entities[3] as Record<string, unknown>, { nestedStructure: { 3: { added: [node('Extra', 5)] } } });
    install(qDoc(), pWithC(), o);
    await load(scene(O, [ROOT1]));
    await refreshP();
    expect(xsOf('B')).toEqual([1]);
    expect(xsOf('Extra')).toEqual([5]);
  });

  it('an EDITED one keeps its edit through a Refresh (its fresh copy stays beside it: #1810)', async () => {
    // Not paired: an edited unkeyed node has no identity to find its fresh copy by. Pins that the edit is not LOST, which
    // a pairing that dropped the live copy as "the template's" would do. Mutation: pair on the name alone (drop
    // `sameAddedNode` from `sameUnkeyed`) — the live 9 is dropped as the template's, and only 5 comes back.
    const own = { added: [node('Extra', 5)] };
    install(qDoc(), pWithC(own), oWith({}));
    await load(scene(O, [ROOT1]));
    writeTraitFieldWithUndo(getAllEntities().find((e) => e.name === 'Extra')!.id, meta('Transform'), 'x', 9);
    await refreshP(own);
    expect(xsOf('Extra')).toContain(9);
  });

  it('no re-target: a scene edit to it stays on it after the template puts another unkeyed node before it', async () => {
    // The hub's question (#1779): a key derived from a node's POSITION would name the inserted node after the shift, and
    // a scene statement keyed on it would move there. Nothing is keyed on the pairing, so the edit stays on Extra.
    for (const inserted of ['Other', 'Extra']) {
      const own = { added: [node('Extra', 5)] };
      install(qDoc(), pWithC(own), oWith({}));
      await load(scene(O, [ROOT1]));
      writeTraitFieldWithUndo(getAllEntities().find((e) => e.name === 'Extra')!.id, meta('Transform'), 'x', 9);
      const { scene: s } = await saved();
      install(pWithC({ added: [node(inserted, 7), node('Extra', 5)] }));
      await load(s);
      const named = (n: string) => getAllEntities().filter((e) => e.name === n);
      expect(xsOf('Extra'), `inserted ${inserted}`).toContain(9);
      if (inserted === 'Other') expect(named('Other').map((e) => x(e.id))).not.toContain(9);
    }
  });

  it('a scene DUPLICATE of it, identical in content, is kept', async () => {
    // The duplicate holds a durable guid, so it equals no chain node. Mutation: pair on the name alone (drop
    // `sameAddedNode` from `sameUnkeyed`) — the duplicate is dropped as the template's, and is gone.
    const own = { added: [node('Extra', 5)] };
    install(qDoc(), pWithC(own), oWith({}));
    await load(scene(O, [ROOT1]));
    duplicateEntity(getAllEntities().find((e) => e.name === 'Extra')!.id, () => {});
    expect(xsOf('Extra')).toEqual([5, 5]); // precondition
    await refreshP(own);
    expect(xsOf('Extra')).toEqual([5, 5]);
  });

  it('a SCENE node written guid-less and equal to it stays beside it: each chain node absorbs one live copy', async () => {
    // Mutation: let one chain node absorb every equal live copy (drop `usedUnkeyed`) — both are dropped, the fresh
    // expansion spawns one, and the scene's node is gone ([5]), for good after a save.
    const own = { added: [node('Extra', 5)] };
    install(qDoc(), pWithC(own), oWith({}));
    const sc = scene(O, [ROOT1]) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[1]!.members = { [`/${gN}/${gC}/eeeeeeee-0000-4000-8000-000000001782`]: { own: [{ ...node('Extra', 5), parentLocalId: 0 }] } };
    await load(sc as unknown as SceneData);
    expect(xsOf('Extra')).toEqual([5, 5]); // precondition: the template's and the scene's
    await refreshP(own);
    expect(xsOf('Extra')).toEqual([5, 5]);
    const { scene: s } = await saved();
    await load(s);
    expect(xsOf('Extra')).toEqual([5, 5]);
  });

  it('repeated names: each untouched one once, across Refreshes, and children tell same-named nodes apart', async () => {
    // Mutation: drop the pairing (`sameUnkeyed`) — every untouched one comes back twice.
    const kid = (name: string) => ({ parentLocalId: 0, guid: '', name, traits: { EntityAttributes: { name, parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } }, children: [] });
    const withKid = (k: string) => ({ ...node('Extra', 5), children: [kid(k)] });
    for (const own of [{ added: [node('Extra', 5), node('Extra', 6), node('Extra', 7)] }, { added: [withKid('Kid1'), withKid('Kid2')] }]) {
      install(qDoc(), pWithC(own), oWith({}));
      await load(scene(O, [ROOT1]));
      const before = [xsOf('Extra').sort(), getAllEntities().filter((e) => e.name.startsWith('Kid')).map((e) => e.name).sort()];
      for (const bx of [1, 2]) {
        install(pWithC(own, bx));
        await rebaseStaleInstances();
        expect(xsOf('B')).toEqual([bx]);
        expect([xsOf('Extra').sort(), getAllEntities().filter((e) => e.name.startsWith('Kid')).map((e) => e.name).sort()]).toEqual(before);
      }
    }
  });
});
