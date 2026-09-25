/** Apply to Prefab, two things it wrote nowhere useful.
 *
 *  #1491 — an added TAG had no key. The field walk dropped it for having no fields, so neither the dialog
 *  nor the agent op listed it, and Apply skipped a tag key without naming it. It is `+trait.<member>.<tag>`
 *  now, listed, applied, reverted.
 *
 *  #1490 — a reference row's POSE lives in `overrides[<child root>].Transform`: both loaders place a nested
 *  root from there and never read the row's own traits. Apply wrote a moved nested root's pose into
 *  `row.traits.Transform`, and the removal branch carried a kept reference row's pose through nothing.
 *
 *  Driven through the real loader, the real capture and the real Apply; the written prefab is captured.
 *  Each case names the mutation that turns it red. */

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
import {
  setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, deleteEntitiesWithUndo, reparentEntity,
} from '@modoki/engine/editor';
import {
  setPrefabCache, applyToPrefab, applyToPrefabSelective, revertOverridesSelective, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import {
  collectInstanceOverrideKeys, collectInstanceOverrideTree, applyOutcomeNotice,
} from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
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
const T = 'cccccccc-0000-4000-8000-000000001489';
const gTR = 'eeeeeeee-0000-4000-8000-000000001407';
const gTSlot = 'eeeeeeee-0000-4000-8000-000000001408';
const gM = 'eeeeeeee-0000-4000-8000-000000001409';

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
const hasTag = (id: number, tag: string) => !!readTraitData(id, meta(tag));
const x = (id: number) => (readTraitData(id, meta('Transform')) as { x: number }).x;
const parentName = (id: number) => {
  const all = getAllEntities();
  const self = all.find((e) => e.id === id)!;
  return all.find((e) => e.id === self.parentId)?.name;
};
const tfOf = (id: number) => readTraitData(id, meta('Transform')) as Record<string, number>;
const written = (id: string) => writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((p) => p.id === id).pop();
const addTag = (id: number, tag: string) => writeTraitFieldWithUndo(id, meta(tag), '', true);

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  writes.length = 0;
  prefabs.clear();
  // Apply repairs refs in other files after a re-parent; nothing else is on disk here.
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ files: [] }), text: async () => '' }));
});
afterAll(() => { for (const id of [P, O]) setPrefabCache(id, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

describe('an added TAG is an override with a key (#1491)', () => {
  it('is listed — by the one tree walk both the dialog and the agent op read', async () => {
    // Mutation: drop the tag branch in `collectInstanceOverrideTree` (a tag falls back to a trait with no fields).
    install(pDoc());
    await load(scene(P));
    addTag(inInstance(ROOT1, 'A'), 'Paused');
    const keys = collectInstanceOverrideKeys(rootOf(ROOT1), prefabs.get(P) as PrefabFile);
    expect(keys.addedTags).toEqual([`+trait.${gA}.Paused`]);
    expect(keys.all).toContain(`+trait.${gA}.Paused`);
    expect(keys.fields).toEqual([]);
    const tree = collectInstanceOverrideTree(rootOf(ROOT1), prefabs.get(P) as PrefabFile);
    expect(tree.addedTags.map((t) => [t.tag, t.entityName])).toEqual([['Paused', 'A']]);
    // The other instance has no such override.
    expect(collectInstanceOverrideKeys(rootOf(ROOT2), prefabs.get(P) as PrefabFile).all).toEqual([]);
  });

  it('Apply writes it into the row, and the OTHER instance gains it', async () => {
    // Mutation: drop the `+trait.` branch in `applyToPrefabSelective` (the key then falls to the field branch).
    install(pDoc());
    await load(scene(P));
    addTag(inInstance(ROOT1, 'A'), 'Paused');
    const result = await applyToPrefabSelective(rootOf(ROOT1), new Set([`+trait.${gA}.Paused`]));
    expect(result.applied).toBe(true);
    expect(result.skipped ?? []).toEqual([]);
    expect(written(P)!.entities.find((e) => e.localId === 2)!.traits.Paused).toBe(true);
    expect(hasTag(inInstance(ROOT2, 'A'), 'Paused')).toBe(true);
  });

  it('the legacy apply-everything lists and writes it too', async () => {
    // Mutation: drop the tag line in `applyToPrefab`'s key loop.
    install(pDoc());
    await load(scene(P));
    addTag(inInstance(ROOT1, 'A'), 'Paused');
    await applyToPrefab(rootOf(ROOT1));
    expect(written(P)?.entities.find((e) => e.localId === 2)!.traits.Paused).toBe(true);
  });

  it('Revert takes it off the instance, and leaves the other one alone', async () => {
    // Mutation: drop the `+trait.` branch in `subtractRevertedOverrides`.
    install(pDoc());
    await load(scene(P));
    addTag(inInstance(ROOT1, 'A'), 'Paused');
    addTag(inInstance(ROOT2, 'A'), 'Paused');
    await revertOverridesSelective(rootOf(ROOT1), new Set([`+trait.${gA}.Paused`]));
    expect(hasTag(inInstance(ROOT1, 'A'), 'Paused')).toBe(false);
    expect(hasTag(inInstance(ROOT2, 'A'), 'Paused')).toBe(true);
    expect(writes).toEqual([]); // a revert never touches the prefab
  });

  it('a tag key Apply cannot write is NAMED in `skipped` — never a bare no-op', async () => {
    // Mutation: restore `if (!meta || meta.category === 'tag') continue;` in the field branch.
    install(pDoc());
    await load(scene(P));
    addTag(inInstance(ROOT1, 'A'), 'Paused');
    const asField = await applyToPrefabSelective(rootOf(ROOT1), new Set([`${gA}.Paused.`]));
    expect(asField.applied).toBe(false);
    expect(asField.skipped?.map((s) => s.key)).toEqual([`${gA}.Paused.`]);
    expect(asField.skipped?.[0]?.reason).toContain('+trait.');
    // A key listed before the tag came off again.
    const stale = await applyToPrefabSelective(rootOf(ROOT1), new Set([`+trait.${gA}.Persistent`]));
    expect(stale.applied).toBe(false);
    expect(stale.skipped?.[0]?.reason).toContain('no longer has Persistent');
    expect(writes).toEqual([]);
  });

  it('the Apply notice calls a non-move a "change"', () => {
    // Mutation: hardcode the noun back to "move".
    expect(applyOutcomeNotice({ skipped: [{ key: `+trait.${gA}.Paused`, reason: 'r' }] }))
      .toBe('Apply to Prefab: 1 change was not applied: r.');
    expect(applyOutcomeNotice({ skipped: [{ key: '~moved.3', reason: 'r' }] }))
      .toBe('Apply to Prefab: 1 move was not applied: r.');
  });
});

describe('an added TAG on a NESTED instance\'s member is kept (#1491 sibling)', () => {
  // `captureNestedSceneDelta` dropped every trait left with no fields — and an added tag has none to begin
  // with. The same tag on an outer-frame member or a flat instance survived; this one did not. An Apply
  // refresh's rebuild kept it either way (a case for it stayed green with the fix deleted, so it is not here).
  const saved = async () => {
    const s = await serializeScene() as unknown as SceneData;
    return { scene: s, entry: (s.entities as unknown as Array<Record<string, unknown>>).find((e) => e.prefab === O)! };
  };

  it('survives a save and reload', async () => {
    // Mutation: drop the tag line in `captureNestedSceneDelta`.
    install(pDoc(), oDoc());
    await load(scene(O, [ROOT1]));
    addTag(inInstance(ROOT1, 'A'), 'Paused');
    const { scene: s } = await saved();
    await load(s);
    expect(hasTag(inInstance(ROOT1, 'A'), 'Paused')).toBe(true);
  });

  it('is NOT restated when the nested row adds the same tag itself', async () => {
    // Mutation: keep a tag the row also adds (drop the `if (rowFields)` delete).
    const doc = oDoc();
    (doc.entities[3] as Record<string, unknown>).overrides = { 2: { Paused: {} } };
    install(pDoc(), doc);
    await load(scene(O, [ROOT1]));
    expect(hasTag(inInstance(ROOT1, 'A'), 'Paused')).toBe(true); // precondition: the row adds it
    const { entry } = await saved();
    expect(JSON.stringify(entry)).not.toContain('Paused');
  });
});

describe('a reference row\'s pose goes where the expansion reads it (#1490)', () => {
  it('Apply of a MOVED nested root writes its pose into the row\'s overrides, and every instance is posed by it', async () => {
    // Mutation: make `rowPoseWrite` write `row.traits.Transform` for a reference row too.
    install(pDoc(), oDoc());
    await load(scene(O));
    const nested = inInstance(ROOT1, 'R');
    reparentEntity(nested, inInstance(ROOT1, 'Slot2'));
    writeTraitFieldWithUndo(nested, meta('Transform'), 'x', 4);
    const keys = collectInstanceOverrideKeys(rootOf(ROOT1), prefabs.get(O) as PrefabFile);
    expect(keys.moved).toEqual([`~moved.${gN}`]);

    const result = await applyToPrefabSelective(rootOf(ROOT1), new Set(keys.moved));
    expect(result.applied).toBe(true);
    const n = written(O)!.entities.find((e) => e.localId === 4)!;
    expect((n.traits.EntityAttributes as { parentId: number }).parentId).toBe(3);
    // Only what differs from the child root's pose — not all of TRS (review F2).
    expect(n.overrides?.[1]?.Transform).toEqual({ x: 4 });
    expect(n.traits.Transform).toBeUndefined();

    // The other instance, refreshed by the Apply, is placed AND posed.
    const other = inInstance(ROOT2, 'R');
    expect([parentName(other), x(other)]).toEqual(['Slot2', 4]);
    // …and so is a fresh load of the written template.
    install(pDoc(), written(O)!);
    await load(scene(O, [ROOT2]));
    const fresh = inInstance(ROOT2, 'R');
    expect([parentName(fresh), x(fresh)]).toEqual(['Slot2', 4]);
  });

  it('a plain row\'s moved pose still lands on its own traits', async () => {
    // Guards the other side of `rowPoseWrite`: mutation — route a plain row to `overrides` too.
    install(pDoc(), oDoc());
    await load(scene(O));
    const slot2 = inInstance(ROOT1, 'Slot2');
    reparentEntity(slot2, inInstance(ROOT1, 'Slot'));
    writeTraitFieldWithUndo(slot2, meta('Transform'), 'x', 5);
    await applyToPrefabSelective(rootOf(ROOT1), new Set([`~moved.${gSlot2}`]));
    const s2 = written(O)!.entities.find((e) => e.localId === 3)!;
    expect((s2.traits.Transform as { x: number }).x).toBe(5);
    expect(s2.overrides).toBeUndefined();
  });

  it('removing the row a nested root was moved out of carries the nested root\'s pose through it', async () => {
    // The sibling in the `-removed.` branch. Mutation: make `rowPoseRead` return the row's own traits for a
    // reference row (undefined here) — the pose through Slot (x = 2) is then carried by nothing, and N lands
    // at x = 0 under OR.
    install(pDoc(), oDoc(2));
    await load(scene(O));
    const nested = inInstance(ROOT1, 'R');
    reparentEntity(nested, inInstance(ROOT1, 'OR'));
    deleteEntitiesWithUndo([inInstance(ROOT1, 'Slot')]);
    const result = await applyToPrefabSelective(rootOf(ROOT1), new Set([`-removed.${gSlot}`]));
    expect(result.applied).toBe(true);
    const n = written(O)!.entities.find((e) => e.localId === 4)!;
    expect((n.traits.EntityAttributes as { parentId: number }).parentId).toBe(1);
    expect(n.overrides?.[1]?.Transform?.x).toBe(2);
    expect(n.traits.Transform).toBeUndefined();
    const other = inInstance(ROOT2, 'R');
    expect([parentName(other), x(other)]).toEqual(['OR', 2]);
  });

  it('writes only the fields that differ from the child root — so a later scene edit of another one saves', async () => {
    // Review F2. Mutation: in `rowPoseWrite`, write every pose field for a reference row. The override then
    // holds all of TRS, `captureNestedSceneDelta` subtracts the scene's `sx` edit by key, and it reloads as 1.
    install(pDoc(), oDoc(2));
    await load(scene(O));
    reparentEntity(inInstance(ROOT1, 'R'), inInstance(ROOT1, 'OR'));
    deleteEntitiesWithUndo([inInstance(ROOT1, 'Slot')]);
    await applyToPrefabSelective(rootOf(ROOT1), new Set([`-removed.${gSlot}`]));
    expect(written(O)!.entities.find((e) => e.localId === 4)!.overrides?.[1]?.Transform).toEqual({ x: 2 });

    const other = inInstance(ROOT2, 'R');
    writeTraitFieldWithUndo(other, meta('Transform'), 'sx', 2);
    const s = await serializeScene() as unknown as SceneData;
    install(pDoc(), written(O)!);
    await load(s);
    expect((readTraitData(inInstance(ROOT2, 'R'), meta('Transform')) as { sx: number }).sx).toBe(2);
  });

  it('gives a nested root with no Transform anywhere none — a UI root stays one', async () => {
    // Review F1. Mutation: make `rowPoseRead` return `{}` rather than undefined when neither side has a
    // Transform — the removal branch then carries an identity pose through Slot (x = 2), writes `{x: 2}` into
    // the row, and every instance's UI root grows a Transform.
    const uiP = { id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
      { localId: 1, name: 'R', nodeGuid: gR, traits: { EntityAttributes: { name: 'R', parentId: 0, guid: '' } } },
    ] };
    install(uiP, oDoc(2));
    await load(scene(O));
    reparentEntity(inInstance(ROOT1, 'R'), inInstance(ROOT1, 'OR'));
    deleteEntitiesWithUndo([inInstance(ROOT1, 'Slot')]);
    await applyToPrefabSelective(rootOf(ROOT1), new Set([`-removed.${gSlot}`]));
    const n = written(O)!.entities.find((e) => e.localId === 4)!;
    expect((n.traits.EntityAttributes as { parentId: number }).parentId).toBe(1);
    expect(n.overrides).toBeUndefined();
    install(uiP, written(O)!);
    await load(scene(O, [ROOT2]));
    expect(!!readTraitData(inInstance(ROOT2, 'R'), meta('Transform'))).toBe(false);
  });
});

describe('every pose Apply writes into another document is a LAYER over it (#1490 second review)', () => {
  const rowN = () => written(O)!.entities.find((e) => e.localId === 4)!;
  /** Save the open scene, reload it over the WRITTEN template (P as `p`), and read ROOT2's `name`. */
  const saveReload = async (p: { id: string }, name: string) => {
    const s = await serializeScene() as unknown as SceneData;
    install(p, written(O)!);
    await load(s);
    return tfOf(inInstance(ROOT2, name));
  };

  it('a NESTED member moved out of its instance: the row holds only what differs, so a scene edit of another field saves', async () => {
    // Mutation: in the nested-move branch, write the whole live bag into `nestedRow.overrides[poseLid]` (the
    // pre-review shape). The override then holds all of TRS and the scene's `sx` edit on ROOT2's A is lost.
    install(pDoc(), oDoc());
    await load(scene(O));
    const a = inInstance(ROOT1, 'A');
    reparentEntity(a, inInstance(ROOT1, 'Slot2'));
    writeTraitFieldWithUndo(a, meta('Transform'), 'x', 4);
    const keys = collectInstanceOverrideKeys(rootOf(ROOT1), prefabs.get(O) as PrefabFile);
    expect(keys.moved).toEqual([`~moved.${gN}:${gA}`]);
    await applyToPrefabSelective(rootOf(ROOT1), new Set(keys.moved));
    expect(rowN().overrides?.[2]?.Transform).toEqual({ x: 4 });
    writeTraitFieldWithUndo(inInstance(ROOT2, 'A'), meta('Transform'), 'sx', 2);
    expect((await saveReload(pDoc(), 'A')).sx).toBe(2);
  });

  it('ROTATION is compared as one orientation: a re-spelled equal rotation writes nothing, and a scene edit of it saves', async () => {
    // The live rotation can be another spelling of the child's own — `ry: π` held as `(-π, 0, -π)`.
    // Mutation: compare rx/ry/rz per field in `layerPose` — all three differ from the base's spelling, get
    // pinned, and the scene's `rz` edit on ROOT2 is subtracted on save.
    install(pDoc({ ry: Math.PI }), oDoc());
    await load(scene(O));
    const r = inInstance(ROOT1, 'R');
    reparentEntity(r, inInstance(ROOT1, 'Slot2'));
    for (const [k, v] of [['x', 4], ['rx', -Math.PI], ['ry', 0], ['rz', -Math.PI]] as const) writeTraitFieldWithUndo(r, meta('Transform'), k, v);
    await applyToPrefabSelective(rootOf(ROOT1), new Set([`~moved.${gN}`]));
    expect(rowN().overrides?.[1]?.Transform).toEqual({ x: 4 });
    writeTraitFieldWithUndo(inInstance(ROOT2, 'R'), meta('Transform'), 'rz', 0.5);
    expect((await saveReload(pDoc({ ry: Math.PI }), 'R')).rz).toBeCloseTo(0.5, 6);
  });

  it('a rotation the ROW holds stays whole, in its own spelling, and a later child edit does not leak into it', async () => {
    // The row turns its instance around (`ry: π` over a base of 0). Mutations: (a) drop the `sameOrientation`
    // spelling restore in the removal branch — the row then holds `(-π, ~0, -π)`; (b) compare rotation per
    // field — `ry` ≈ 0 equals the base and is DROPPED, so a later child `ry` edit turns the instance.
    const doc = oDoc(2);
    (doc.entities[3] as Record<string, unknown>).overrides = { 1: { Transform: { ry: Math.PI } } };
    install(pDoc(), doc);
    await load(scene(O));
    reparentEntity(inInstance(ROOT1, 'R'), inInstance(ROOT1, 'OR'));
    deleteEntitiesWithUndo([inInstance(ROOT1, 'Slot')]);
    await applyToPrefabSelective(rootOf(ROOT1), new Set([`-removed.${gSlot}`]));
    const t = rowN().overrides?.[1]?.Transform as Record<string, number>;
    expect(Object.keys(t).sort()).toEqual(['rx', 'ry', 'rz', 'x']);
    expect([t.x, t.rx, t.ry, t.rz].map((v) => +v.toFixed(6))).toEqual([2, 0, +Math.PI.toFixed(6), 0]);
    // The child author turns P's root a little; this instance's row still says "facing back".
    install(pDoc({ ry: 0.3 }), written(O)!);
    await load(scene(O, [ROOT2]));
    const r = tfOf(inInstance(ROOT2, 'R'));
    expect(r.ry).toBeCloseTo(Math.PI, 6);
  });

  it('a field the row held that now EQUALS the base is dropped, not left pinned', async () => {
    // Mutation: keep `next[k]` when it equals the base in `layerPose` — the row keeps its stale `x: 4`,
    // and every other instance loads at 4 instead of the base's 0.
    const doc = oDoc();
    (doc.entities[3] as Record<string, unknown>).overrides = { 1: { Transform: { x: 4 } } };
    install(pDoc(), doc);
    await load(scene(O));
    const r = inInstance(ROOT1, 'R');
    reparentEntity(r, inInstance(ROOT1, 'Slot2'));
    writeTraitFieldWithUndo(r, meta('Transform'), 'x', 0);
    await applyToPrefabSelective(rootOf(ROOT1), new Set([`~moved.${gN}`]));
    expect(rowN().overrides).toBeUndefined();
    expect(x(inInstance(ROOT2, 'R'))).toBe(0);
  });
});

describe('a member moved out of a DEEPER nested instance is layered over every row between (#1490 third review)', () => {
  // T → TSlot → M (expands O); O's N expands P and sets A's x = 7. A is moved out to TSlot, T's own frame, so
  // T records it as `nestedOverrides["<N>"][<A>]` on M, and the base under that layer is P's row A UNDER N's
  // override. Mutation: drop `between` from the nested branch's base — the layer then pins x = 7 too.
  it('writes only what differs from the pose the rows below give it', async () => {
    const tDoc = { id: T, version: 5, name: 'T', rootLocalId: 1, entities: [
      row(1, 'TR', 0, gTR), row(2, 'TSlot', 1, gTSlot),
      { localId: 3, name: 'M', nodeGuid: gM, prefab: O, traits: { EntityAttributes: { name: 'M', parentId: 1, guid: '' } } },
    ] };
    const oWithN = oDoc();
    (oWithN.entities[3] as Record<string, unknown>).overrides = { 2: { Transform: { x: 7 } } };
    install(pDoc(), oWithN, tDoc);
    await load(scene(T));
    const a = inInstance(ROOT1, 'A');
    expect(x(a)).toBe(7); // precondition: N's override reaches A
    reparentEntity(a, inInstance(ROOT1, 'TSlot'));
    for (const [k, v] of [['x', 7], ['y', 3], ['z', 0]] as const) writeTraitFieldWithUndo(a, meta('Transform'), k, v);
    const keys = collectInstanceOverrideKeys(rootOf(ROOT1), prefabs.get(T) as PrefabFile);
    expect(keys.moved).toEqual([`~moved.${gM}.${gN}:${gA}`]);
    await applyToPrefabSelective(rootOf(ROOT1), new Set(keys.moved));
    const m = written(T)!.entities.find((e) => e.localId === 3)!;
    expect(m.nestedOverrides).toEqual({ 4: { 2: { Transform: { y: 3 } } } });
    expect(m.overrides).toBeUndefined();
    const other = tfOf(inInstance(ROOT2, 'A'));
    expect([parentName(inInstance(ROOT2, 'A')), other.x, other.y]).toEqual(['TSlot', 7, 3]);
  });
});
