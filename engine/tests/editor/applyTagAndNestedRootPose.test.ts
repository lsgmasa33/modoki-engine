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
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, getOverrideMarkSet, findEntityById, type SceneData,
} from '@modoki/engine/runtime';
import {
  setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, addTraitToEntitiesWithUndo,
} from '@modoki/engine/editor';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { applyToPrefabSelective } from '../../packages/modoki/src/editor/scene/prefabApply';
import { revertOverridesSelective } from '../../packages/modoki/src/editor/scene/prefabRevert';
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
    expect(keys.fields).toEqual(keys.defaultOverrides); // only the root's sibling order, which F7 always records
    const tree = collectInstanceOverrideTree(rootOf(ROOT1), prefabs.get(P) as PrefabFile);
    expect(tree.addedTags.map((t) => [t.tag, t.entityName])).toEqual([['Paused', 'A']]);
    // The other instance has no such override: only F7's root order.
    const other = collectInstanceOverrideKeys(rootOf(ROOT2), prefabs.get(P) as PrefabFile);
    expect(other.all).toEqual(other.defaultOverrides);
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

  // Both spellings a row can hold for a tag: `{}` is what every writer produces, `true` only a hand- or agent-written
  // row (the spawner adds the tag for either). Only `true` can fail under the mutation: for `{}` the chain subtraction's
  // empty-trait drop takes the tag anyway, so the delete is load-bearing for `true` alone (#1673's T1).
  it.each([['true', true], ['{}', {}]])('is NOT restated when the nested row adds the same tag itself (row spells it %s)', async (_s, spelling) => {
    // Mutation: keep a tag the row also adds (drop the `if (rowFields)` delete).
    const doc = oDoc();
    (doc.entities[3] as Record<string, unknown>).overrides = { 2: { Paused: spelling } };
    install(pDoc(), doc);
    await load(scene(O, [ROOT1]));
    expect(hasTag(inInstance(ROOT1, 'A'), 'Paused')).toBe(true); // precondition: the row adds it
    const { entry } = await saved();
    expect(JSON.stringify(entry)).not.toContain('Paused');
  });
  // #1914 R1: a tag the SCENE records is its own statement, written whatever the row adds (a record is taken off only by
  // Revert, Apply or Remove Unused). Since R3c the row's tag is base (the capture folds the chain in), so only the tag's
  // record writes it. Mutation: drop the tag record in `recordedOverrides` (`if (!field) continue;`) — the row's tag
  // takes the scene's record with it.
  it('IS kept when the scene records it, though the row adds the same tag', async () => {
    const doc = oDoc();
    (doc.entities[3] as Record<string, unknown>).overrides = { 2: { Paused: {} } };
    install(pDoc(), doc);
    const sc = scene(O, [ROOT1]);
    (sc.entities[1] as unknown as Record<string, unknown>).members = { [`/${gN}/${gA}`]: { traits: { Paused: {} } } };
    await load(sc);
    expect(hasTag(inInstance(ROOT1, 'A'), 'Paused')).toBe(true);
    const { scene: s1, entry } = await saved();
    expect(JSON.stringify(entry)).toContain('Paused');
    await load(s1);
    expect(JSON.stringify((await saved()).entry)).toContain('Paused');
  });
});

/** #1663 — an ADDED component was listed as field overrides whose base is ∅, and a field's Revert reset it to the schema
 *  default and left the component listed (and its marks out of step with what the save writes). It is ONE row now,
 *  `+trait.<member>.<Component>`, as Unity lists an added component: Revert removes the component, and Apply writes it
 *  whole, as applying its fields did. */
describe('an ADDED component is one row (#1663)', () => {
  const addFocusable = (id: number) => addTraitToEntitiesWithUndo([id], meta('UIFocusable'), { focusOrder: 2 });
  const row = `+trait.${gA}.UIFocusable`;

  it('the listing names it ONCE, as a row, with no field keys for it', async () => {
    // Mutation: drop the added-component branch in `collectInstanceOverrideTree` — it is listed as eight field keys again.
    install(pDoc());
    await load(scene(P));
    addFocusable(inInstance(ROOT1, 'A'));
    const keys = collectInstanceOverrideKeys(rootOf(ROOT1), prefabs.get(P) as PrefabFile);
    expect(keys.addedTags).toEqual([row]);
    expect(keys.fields.filter((k) => k.includes('.UIFocusable.'))).toEqual([]);
    const tree = collectInstanceOverrideTree(rootOf(ROOT1), prefabs.get(P) as PrefabFile);
    expect(tree.addedTags.map((t) => [t.tag, t.entityName])).toEqual([['UIFocusable', 'A']]);
    expect(tree.addedTags[0]!.fields).toContain('focusOrder');
  });

  it('Revert of the row REMOVES the component, its marks with it, and it is listed no more', async () => {
    // Mutation: drop the `+trait.` branch in `subtractFieldOverrides` — the component stays, with its value.
    install(pDoc());
    await load(scene(P));
    addFocusable(inInstance(ROOT1, 'A'));
    addFocusable(inInstance(ROOT2, 'A'));
    await revertOverridesSelective(rootOf(ROOT1), new Set([row]));
    const a1 = inInstance(ROOT1, 'A');
    expect(hasTag(a1, 'UIFocusable')).toBe(false);
    expect([...(getOverrideMarkSet(findEntityById(a1)! as never) ?? [])].filter((m) => m.startsWith('UIFocusable.'))).toEqual([]);
    const after = collectInstanceOverrideKeys(rootOf(ROOT1), prefabs.get(P) as PrefabFile);
    expect(after.all).toEqual(after.defaultOverrides); // only F7's root order
    expect(hasTag(inInstance(ROOT2, 'A'), 'UIFocusable')).toBe(true); // the other instance is untouched
    expect(writes).toEqual([]); // a revert never touches the prefab
  });

  it('Apply of the row writes the WHOLE component into the prefab, and reports the row once', async () => {
    // Mutation: drop the expansion in `planApply` — the key falls to the tag branch and is skipped.
    install(pDoc());
    await load(scene(P));
    addFocusable(inInstance(ROOT1, 'A'));
    const result = await applyToPrefabSelective(rootOf(ROOT1), new Set([row]));
    expect(result.applied).toBe(true);
    expect(result.skipped ?? []).toEqual([]);
    const bag = written(P)!.entities.find((e) => e.localId === 2)!.traits.UIFocusable as Record<string, unknown>;
    expect(bag.focusOrder).toBe(2);
    expect(Object.keys(bag).length).toBeGreaterThan(1); // every field, not the one that differs
    expect(hasTag(inInstance(ROOT2, 'A'), 'UIFocusable')).toBe(true);
    expect(result.effects?.filter((e) => e.key === row).length).toBe(1);
    expect(result.effects?.find((e) => e.key === row)?.effect.op).toBe('addComponent');
    expect(result.targets?.filter((t) => t.key === row).length).toBe(1);
  });
});
