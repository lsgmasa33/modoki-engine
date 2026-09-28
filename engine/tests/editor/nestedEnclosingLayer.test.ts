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
  addTraitToEntitiesWithUndo, createEntityWithUndo, writeTraitFieldWithUndo,
} from '@modoki/engine/editor';
import {
  setPrefabCache, rebaseStaleInstances, serializePrefab, applyToPrefabSelective, revertOverridesSelective, getCachedPrefabSync, instantiatePrefab, setPrefabSource,
  type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { buildPrefabEditScene, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyTargetOptions } from '../../packages/modoki/src/editor/scene/prefabApplyOptions';
import { isMemberToken } from '../../packages/modoki/src/runtime/core/templateRefs';
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
    // Mutation: in `applyTargetOptions`' describe, test `adds` at the inner level against the WHOLE chain
    // (`traitInside(…, 0, …, true)`) — O's row gives A Rotate3D, so the P label reads as a one-field edit.
    await editSpeed();
    const t = applyTargetOptions(nestedRoot(), getCachedPrefabSync(P) as PrefabFile, [speedKey]).get(speedKey)!;
    expect(t.defaultTarget).toBe(O);
    const [atO, atP] = [t.options.find((o) => o.target === O)!, t.options.find((o) => o.target === P)!];
    expect(atP.label).toBe('add component Rotate3D (axis "x", speed 7) to A in Prefab \'P\' — every P gains it');
    expect(atP.alsoReverts.map((r) => r.name)).toEqual(['O']);
    expect(atO.label).toBe('A · Rotate3D.speed → 7 as an override in Prefab \'O\'');
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
    // Mutation: \`reverted()\` returns [] for a \`-trait.\` key — the P option names no O, though Apply writes O too.
    const p = pDoc();
    (p.entities[1]!.traits as Record<string, unknown>).Rotate3D = { axis: 'x', speed: 1 };
    install(p, oWith({ 2: { Rotate3D: { speed: 5 } } }));
    await load(scene(O, [ROOT1]));
    removeTraitFromEntitiesWithUndo([inInstance(ROOT1, 'A')], meta('Rotate3D'));
    const key = `-trait.${gA}`.concat('.Rotate3D');
    const t = applyTargetOptions(inInstance(ROOT1, 'R'), getCachedPrefabSync(P) as PrefabFile, [key]).get(key)!;
    expect(t.options.find((o) => o.target === P)!.alsoReverts.map((r) => r.name)).toEqual(['O']);
    expect(t.options.find((o) => o.target === O)!.label).toMatch(/^remove Rotate3D from A/);
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
