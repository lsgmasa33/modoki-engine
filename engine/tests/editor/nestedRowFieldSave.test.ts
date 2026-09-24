/** A nested instance's fields, where the enclosing prefab's ROW also sets them — the save and the rebuild.
 *
 *  #1498 — the save subtracted what the row sets by KEY, so a scene edit to a row-set field read as the row's own
 *  and was dropped. Both captures now subtract by VALUE (`subtractChainOverrides`), rotation as one orientation.
 *
 *  #1492 — Apply from the NESTED instance of a field the row also sets. Owner ruling (b): the source keeps the
 *  applied value as an ordinary override — listed, revertable to the ROW's value, durable. One predicate decides
 *  (`appliedFieldsToDrop`): keep an applied field only if dropping it would change what the instance resolves to,
 *  its template under the enclosing rows (`enclosingRowOverrides`), which the listing and Revert read too.
 *
 *  #1506 — that base is the enclosing layer WHOLE (`enclosingLayer`): a row's STRUCTURE is not the instance's own
 *  either (listed, Apply stripped a row's removed trait from every instance of P), and a reference node a template
 *  row authored has the node's channels as its layer, not nothing. #1513: also when the node hangs inside a plain added
 *  node's `children`.
 *
 *  #1511 — a SAVE writes a nested frame's structure per member only where it differs from what the rows apply, so a
 *  later template change to the rest still reaches the saved scene.
 *
 *  Driven through the real loader, the real capture and the real Apply. Each case names the mutation that turns
 *  it red. */


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
  setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, reparentEntity, deleteEntitiesWithUndo,
} from '@modoki/engine/editor';
import {
  setPrefabCache, rebaseStaleInstances, applyToPrefabSelective, revertOverridesSelective, getCachedPrefabSync, type PrefabFile,
  instantiatePrefab, setPrefabSource,
} from '../../packages/modoki/src/editor/scene/prefab';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { sameRotationScale } from '../../packages/modoki/src/runtime/scene/transformSpace';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { TemplateAddedKey } from '../../packages/modoki/src/runtime/core/templateIdentity';
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
const tfOf = (id: number) => readTraitData(id, meta('Transform')) as Record<string, number>;

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  writes.length = 0;
  prefabs.clear();
  clearKeptMemberOrphans(); // R2's kept rows are process state; one case's orphans must not reach the next
  // Apply repairs refs in other files after a re-parent; nothing else is on disk here.
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ files: [] }), text: async () => '' }));
});
afterAll(() => { for (const id of [P, O]) setPrefabCache(id, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

const saved = async () => {
  const s = await serializeScene() as unknown as SceneData;
  return { scene: s, entry: (s.entities as unknown as Array<Record<string, unknown>>).find((e) => e.prefab === O)! };
};
/** O whose row N overrides P's members with `ov` (localId-keyed, P's numbering: 1 = R, 2 = A). */
const oWith = (ov: Record<number, unknown>) => { const d = oDoc(); (d.entities[3] as Record<string, unknown>).overrides = ov; return d; };
const setTf = (id: number, field: string, v: number) => writeTraitFieldWithUndo(id, meta('Transform'), field, v);
/** The saved member row of P's `nodeGuid` inside row N. */
const rowOf = (entry: Record<string, unknown>, nodeGuid: string) =>
  (entry.members as Record<string, { traits?: Record<string, unknown> }>)[nodeGuid === gR ? `/${gN}` : `/${gN}/${nodeGuid}`];

describe('a scene edit to a field the row also sets is saved (#1498)', () => {
  it('on the nested root and on a member, beside a field the row does not set', async () => {
    // Mutation: subtract by KEY in `subtractChainOverrides` (drop its `valuesEqual`) — both x edits reload at 2.
    install(pDoc(), oWith({ 1: { Transform: { x: 2 } }, 2: { Transform: { x: 2 } } }));
    await load(scene(O, [ROOT1]));
    expect([x(inInstance(ROOT1, 'R')), x(inInstance(ROOT1, 'A'))]).toEqual([2, 2]); // precondition: the row applies
    setTf(inInstance(ROOT1, 'R'), 'x', 5);
    setTf(inInstance(ROOT1, 'A'), 'x', 5);
    setTf(inInstance(ROOT1, 'A'), 'y', 5);
    await load((await saved()).scene);
    expect([x(inInstance(ROOT1, 'R')), x(inInstance(ROOT1, 'A')), tfOf(inInstance(ROOT1, 'A')).y]).toEqual([5, 5, 5]);
  });

  it('a value EQUAL to the row\'s is not restated', async () => {
    // Mutation: drop the `valuesEqual` delete in `subtractChainOverrides` (keep every row-set field) — x is pinned.
    install(pDoc(), oWith({ 2: { Transform: { x: 2 } } }));
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'A'), 'x', 2); // marked, and equal to what the row gives it
    expect(rowOf((await saved()).entry, gA)?.traits).toBeUndefined();
  });

  it('ROTATION: one component edited on a row-rotated member reloads as the orientation the scene showed', async () => {
    // Mutation: subtract by KEY in `subtractChainOverrides` for rotation (delete rx/ry/rz whenever the chain sets
    // one) — the edit is dropped and reloads at rz 0.
    install(pDoc(), oWith({ 2: { Transform: { rx: 0, ry: Math.PI, rz: 0 } } }));
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'A'), 'rz', 0.5);
    const { entry, scene: s } = await saved();
    expect(Object.keys(rowOf(entry, gA)?.traits?.Transform as object).sort()).toEqual(['rx', 'ry', 'rz']);
    await load(s);
    const t = tfOf(inInstance(ROOT1, 'A'));
    expect([t.rx, t.ry, t.rz].map((v) => +v.toFixed(6))).toEqual([0, +Math.PI.toFixed(6), 0.5]);
  });

  it('ROTATION: a re-spelled rotation EQUAL to the row\'s writes nothing; a re-spelled different one reloads as shown', async () => {
    // `ry: π` held as `(-π, 0, -π)`. Mutation: compare rotation per field (drop the `chainTurns` block) — all three
    // differ from the row's spelling, so the equal case pins them.
    install(pDoc(), oWith({ 2: { Transform: { rx: 0, ry: Math.PI, rz: 0 } } }));
    await load(scene(O, [ROOT1]));
    const a = inInstance(ROOT1, 'A');
    for (const [k, v] of [['rx', -Math.PI], ['ry', 0], ['rz', -Math.PI]] as const) setTf(a, k, v);
    expect(rowOf((await saved()).entry, gA)?.traits).toBeUndefined();
    // …and the same spelling turned a little further about z: kept whole, so it reloads as the scene held it.
    setTf(a, 'rz', -Math.PI + 0.25);
    await load((await saved()).scene);
    const t = tfOf(inInstance(ROOT1, 'A'));
    expect([t.rx, t.ry, t.rz].map((v) => +v.toFixed(6))).toEqual([-Math.PI, 0, -Math.PI + 0.25].map((v) => +v.toFixed(6)));
  });

  it('a MIRRORED member moved out and back keeps its mirror: rotation and scale are one value (close-out review)', async () => {
    // The move's compensation re-spells `sz: -1` as `sx: -1` turned π about y; the capture keeps only the MARKED
    // component (`sz: 1`). Mutation: compare rotation and scale per field in `subtractChainOverrides` (make
    // `chainPoses` false) — the save pins `sz: 1`, and the reload loses the mirror.
    install(pDoc(), oWith({ 2: { Transform: { sz: -1 } } }));
    await load(scene(O, [ROOT1]));
    const a = inInstance(ROOT1, 'A');
    reparentEntity(a, inInstance(ROOT1, 'Slot2'));
    reparentEntity(inInstance(ROOT1, 'A'), inInstance(ROOT1, 'R'));
    const { entry, scene: s } = await saved();
    expect(rowOf(entry, gA)?.traits).toBeUndefined(); // the same pose as the row's: nothing pinned
    await load(s);
    expect(tfOf(inInstance(ROOT1, 'A'))).toMatchObject({ sx: 1, sy: 1, sz: -1 });
  });

  it('a row\'s member TOKEN is compared as the guid it names: an unchanged ref is not restated, a changed one is kept', async () => {
    // Mutation: drop the `baseTokenResolver` step in `captureNestedSceneDelta` — the unchanged ref never equals the
    // token and is pinned as a guid.
    install(pDoc(), oWith({ 1: { UIAction: { bindings: [{ target: '@member:2' }] } } }));
    await load(scene(O, [ROOT1]));
    const r = inInstance(ROOT1, 'R');
    const bindings = (readTraitData(r, meta('UIAction')) as { bindings: Array<Record<string, unknown>> }).bindings;
    const aGuid = getAllEntities().find((e) => e.id === inInstance(ROOT1, 'A'))!.guid;
    expect(bindings[0]!.target).toBe(aGuid); // precondition: the loader resolved the token to A
    writeTraitFieldWithUndo(r, meta('UIAction'), 'bindings', bindings.map((b) => ({ ...b })));
    expect(rowOf((await saved()).entry, gR)?.traits).toBeUndefined();
    const rGuid = getAllEntities().find((e) => e.id === r)!.guid;
    writeTraitFieldWithUndo(r, meta('UIAction'), 'bindings', bindings.map((b) => ({ ...b, target: rGuid })));
    await load((await saved()).scene);
    const after = (readTraitData(inInstance(ROOT1, 'R'), meta('UIAction')) as { bindings: Array<Record<string, unknown>> }).bindings;
    expect(after[0]!.target).toBe(getAllEntities().find((e) => e.id === inInstance(ROOT1, 'R'))!.guid);
  });
});

describe('a refresh under a user-added reference node (#1498 design)', () => {
  // The save subtracts against the CACHED chain, and a rebuild reaches that capture only through a user-added
  // reference node. The node's own frame is an instance of the refreshed source, so a refresh rebuilds it FIRST
  // (deepest first), and the outer capture reads a node that is already current. This pins that: the new row value
  // reaches the node, live and after a save. Driven through the rebase, which refreshes each stale frame in turn.
  it('the refreshed row value reaches the node, live and after a save', async () => {
    // Mutation: sort `rebaseStaleInstances` shallowest first — the outer rebuild runs first, its capture restates the
    // node's old x against the new row and respawns the node with it, the node's own rebuild never runs (1 rebuilt,
    // not 2), and it keeps 2.
    install(pDoc(), oWith({ 2: { Transform: { x: 2 } } }));
    await load(scene(O, [ROOT1, ROOT2]));
    reparentEntity(rootOf(ROOT2), inInstance(ROOT1, 'Slot2'));
    const inNode = () => inInstance(ROOT2, 'A');
    expect(x(inNode())).toBe(2);
    install(oWith({ 2: { Transform: { x: 3 } } })); // the file changed under the live tree
    expect(await rebaseStaleInstances()).toBe(2);
    expect(x(inNode())).toBe(3);
    await load((await saved()).scene);
    expect(x(inNode())).toBe(3);
  });
});

describe('Apply from a nested instance whose field the outer row also sets (#1492, owner ruling b)', () => {
  const nestedRoot = () => inInstance(ROOT1, 'R');
  const keysOf = (root: number) => collectInstanceOverrideKeys(root, getCachedPrefabSync(P) as PrefabFile).fields;
  const xKey = `${gA}.Transform.x`;
  /** Reload the saved scene over the P the Apply WROTE. */
  const reload = async () => {
    const { scene: sc } = await saved();
    install(writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((d) => d.id === P).pop()!);
    await load(sc);
  };
  /** O's row sets A.x = 3; the nested instance in ROOT1 sets A.x = 5 and A.y = 7, and applies both to P. */
  const applyBoth = async () => {
    install(pDoc(), oWith({ 2: { Transform: { x: 3 } } }));
    await load(scene(O, [ROOT1, ROOT2]));
    setTf(inInstance(ROOT1, 'A'), 'x', 5);
    setTf(inInstance(ROOT1, 'A'), 'y', 7);
    expect(keysOf(nestedRoot()).sort()).toEqual([xKey, `${gA}.Transform.y`]);
    expect((await applyToPrefabSelective(nestedRoot(), new Set(keysOf(nestedRoot())))).applied).toBe(true);
  };

  it('SHADOWED: the source keeps 5, listed, through a save and a reload; the other instance keeps the row\'s 3', async () => {
    // Mutation: make `appliedFieldsToDrop` drop every applied field (#1469 alone) — the source loses its override,
    // the listing is empty, and the reload reads the row's 3.
    await applyBoth();
    expect([x(inInstance(ROOT1, 'A')), x(inInstance(ROOT2, 'A'))]).toEqual([5, 3]);
    expect(keysOf(nestedRoot())).toEqual([xKey]);
    await reload();
    expect([x(inInstance(ROOT1, 'A')), x(inInstance(ROOT2, 'A'))]).toEqual([5, 3]);
    expect(keysOf(nestedRoot())).toEqual([xKey]);
  });

  it('NOT shadowed: the applied y is subtracted (#1469) — not listed, nothing in the file', async () => {
    // Mutation: make `appliedFieldsToDrop` keep every applied field — y is pinned on the source and listed.
    await applyBoth();
    expect(tfOf(inInstance(ROOT1, 'A')).y).toBe(7);
    expect(keysOf(nestedRoot())).not.toContain(`${gA}.Transform.y`);
    const row = (await saved()).entry.members as Record<string, { traits?: { Transform?: Record<string, unknown> } }>;
    expect(row[`/${gN}/${gA}`]?.traits?.Transform ?? {}).not.toHaveProperty('y');
  });

  it('Revert of the kept override gives the ROW\'s value, not the template\'s', async () => {
    // Mutation: drop the enclosing-row put-back in `revertOverridesSelective` — A reverts to P's 5.
    await applyBoth();
    await revertOverridesSelective(nestedRoot(), new Set([xKey]));
    expect(x(inInstance(ROOT1, 'A'))).toBe(3);
    expect(keysOf(nestedRoot())).toEqual([]);
    await reload();
    expect(x(inInstance(ROOT1, 'A'))).toBe(3);
  });

  it('the override list reads the nested instance against its template UNDER the row: the row\'s own value is not listed', async () => {
    // Mutation: diff against the bare template in `collectInstanceOverrideTree` (`prefab` for `base`) — the row's 3
    // is listed as this instance's override.
    install(pDoc(), oWith({ 2: { Transform: { x: 3 } } }));
    await load(scene(O, [ROOT1]));
    expect(x(inInstance(ROOT1, 'A'))).toBe(3);
    expect(keysOf(nestedRoot())).toEqual([]);
  });

  it('#1490\'s second half: after Apply of a MOVED nested root, the source saves no pose of its own, so a later row edit moves it', async () => {
    // Apply writes the pose into row N's overrides, so the save's by-VALUE subtraction (#1498) takes it off the
    // source. Mutation: never subtract an equal value in `subtractChainOverrides` — the pose is pinned in the scene
    // and the row edit does not move it.
    install(pDoc(), oDoc());
    await load(scene(O, [ROOT1]));
    reparentEntity(nestedRoot(), inInstance(ROOT1, 'Slot2'));
    setTf(nestedRoot(), 'x', 4);
    expect((await applyToPrefabSelective(rootOf(ROOT1), new Set([`~moved.${gN}`]))).applied).toBe(true);
    const { scene: s } = await saved();
    expect(rowOf(s.entities.find((e) => (e as { prefab?: string }).prefab === O) as never, gR)?.traits).toBeUndefined();
    const edited = JSON.parse(JSON.stringify(getCachedPrefabSync(O))) as { entities: Array<{ localId: number; overrides?: Record<number, { Transform?: Record<string, number> }> }> };
    edited.entities.find((e) => e.localId === 4)!.overrides![1]!.Transform!.x = 9;
    install(edited as never);
    await load(s);
    expect(x(nestedRoot())).toBe(9);
  });
});

describe('rotation and scale widen to ONE value only for a re-spelled pose (#1498 close-out, second review)', () => {
  // Writing all six whenever the row set any of them pinned axes the scene never touched: the row's own turn or
  // mirror, and on a rebuild an OLD row's scale over a refreshed one. Each case below was red with that rule.
  const pWithA = (aTf: Record<string, number>) => { const d = pDoc(); d.entities[1]!.traits.Transform = { ...d.entities[1]!.traits.Transform, ...aTf } as never; return d; };
  const aTf = () => tfOf(inInstance(ROOT1, 'A'));
  const loadWith = async (ov: Record<string, number>) => { install(pDoc(), oWith({ 2: { Transform: ov } })); await load(scene(O, [ROOT1])); };
  // Mutation for A–D and F: widen every time (make the re-spelled test `if (true)`).

  it('A: the row turns, the scene turns further — a later TEMPLATE scale edit still reaches the instance', async () => {
    await loadWith({ ry: 0.5 });
    setTf(inInstance(ROOT1, 'A'), 'rz', 0.3);
    const { scene: s } = await saved();
    install(pWithA({ sx: 2 }));
    await load(s);
    expect(aTf().sx).toBe(2);
    expect([aTf().ry, aTf().rz].map((v) => +v.toFixed(6))).toEqual([0.5, 0.3]);
  });

  it('B: the row mirrors, the scene turns — the row un-mirroring later reaches the instance', async () => {
    await loadWith({ sz: -1 });
    setTf(inInstance(ROOT1, 'A'), 'ry', 0.3);
    const { scene: s } = await saved();
    install(oWith({ 2: { Transform: { sz: 1 } } }));
    await load(s);
    expect([aTf().sz, +aTf().ry.toFixed(6)]).toEqual([1, 0.3]);
  });

  it('C: the row turns, the scene scales — the row turning further later reaches the instance', async () => {
    await loadWith({ ry: 0.5 });
    setTf(inInstance(ROOT1, 'A'), 'sx', 2);
    const { scene: s } = await saved();
    install(oWith({ 2: { Transform: { ry: 1 } } }));
    await load(s);
    expect([+aTf().ry.toFixed(6), aTf().sx]).toEqual([1, 2]);
  });

  it('D: the REBUILD keeps the refreshed row\'s scale (#1401\'s shape) under a scene turn', async () => {
    await loadWith({ sx: 2 });
    setTf(inInstance(ROOT1, 'A'), 'rz', 0.3);
    install(oWith({ 2: { Transform: { sx: 3 } } }));
    expect(await rebaseStaleInstances()).toBe(1);
    expect([aTf().sx, +aTf().rz.toFixed(6)]).toEqual([3, 0.3]);
  });

  it('F: a row that hides the member (scale 0) keeps the scene\'s turn, and does not pin the hidden scale', async () => {
    await loadWith({ sx: 0, sy: 0, sz: 0 });
    setTf(inInstance(ROOT1, 'A'), 'rz', 1);
    const { scene: s } = await saved();
    install(oWith({ 2: { Transform: { sx: 1, sy: 1, sz: 1 } } }));
    await load(s);
    expect([+aTf().rz.toFixed(6), aTf().sx]).toEqual([1, 1]);
  });


  it('I: a mirrored member moved out and back AND turned reloads as the pose shown', async () => {
    // Mutation: never widen (make the re-spelled test `if (false)`) — the marked components over the row reload as
    // another pose.
    await loadWith({ sz: -1 });
    reparentEntity(inInstance(ROOT1, 'A'), inInstance(ROOT1, 'Slot2'));
    reparentEntity(inInstance(ROOT1, 'A'), inInstance(ROOT1, 'R'));
    setTf(inInstance(ROOT1, 'A'), 'rz', (aTf().rz ?? 0) + 0.25);
    const before = aTf();
    await load((await saved()).scene);
    expect(sameRotationScale(before as never, aTf() as never)).toBe(true);
  });

  it('J: a TEMPLATE mirror under a row turn, moved out and back, reloads as shown and still takes a later row turn', async () => {
    // The live read re-spells the unmarked axes (`rz: -π`, the sign moved to `sx`) while the marked `ry` over the chain
    // still rebuilds the same matrix. Mutation: decide and write rotation from `livePose` in the per-component branch
    // (the pre-review-3 code) — the save writes `rz: -π` over the template's `sy: -1`, and it reloads turned 180°.
    install(pWithA({ sy: -1 }), oWith({ 2: { Transform: { ry: 0.5 } } }));
    await load(scene(O, [ROOT1]));
    reparentEntity(inInstance(ROOT1, 'A'), inInstance(ROOT1, 'Slot2'));
    reparentEntity(inInstance(ROOT1, 'A'), inInstance(ROOT1, 'R'));
    const before = aTf();
    const { scene: s } = await saved();
    await load(s);
    expect(sameRotationScale(before as never, aTf() as never)).toBe(true);
    // …and the rebuild: the row turns further on disk, and the rebase brings the turn in with the mirror intact.
    reparentEntity(inInstance(ROOT1, 'A'), inInstance(ROOT1, 'Slot2'));
    reparentEntity(inInstance(ROOT1, 'A'), inInstance(ROOT1, 'R'));
    install(oWith({ 2: { Transform: { ry: 0.8 } } }));
    expect(await rebaseStaleInstances()).toBe(1);
    expect(sameRotationScale(aTf() as never, { rx: 0, ry: 0.8, rz: 0, sx: 1, sy: -1, sz: 1 })).toBe(true);
  });

  it('sameRotationScale: a re-spelled mirror is equal; a change under a large scale on ANOTHER axis is not', () => {
    const I = { rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
    expect(sameRotationScale({ ...I, sz: -1 }, { ...I, ry: Math.PI, sx: -1 })).toBe(true);
    expect(sameRotationScale({ ...I, sx: 10000 }, { ...I, sx: 10000, rx: 0.005 })).toBe(false);
    expect(sameRotationScale({ ...I, sx: 1e6 }, { ...I, sx: 1e6, sy: 1.5 })).toBe(false);
    expect(sameRotationScale({ ...I, sx: 10000 }, { ...I, sx: 10000.000001 })).toBe(true);
  });
});

describe('a nested instance\'s base is its enclosing layer WHOLE: structure, and a template reference node (#1506)', () => {
  const P2 = 'cccccccc-0000-4000-8000-000000001506';
  const gR2 = 'eeeeeeee-0000-4000-8000-000000001506';
  const gXA = 'eeeeeeee-0000-4000-8000-000000001507';
  const gIn = 'eeeeeeee-0000-4000-8000-000000001508';
  const nestedRoot = () => inInstance(ROOT1, 'R');
  const keys = (root: number, src = P) => collectInstanceOverrideKeys(root, getCachedPrefabSync(src) as PrefabFile).all;
  /** P with UIAction on A (localId 2). */
  const pWithAction = () => { const d = pDoc(); (d.entities[1]!.traits as Record<string, unknown>).UIAction = {}; return d; };
  /** O whose row N carries `extra` (structure lists, beside or instead of `overrides`). */
  const oRow = (extra: Record<string, unknown>) => { const d = oDoc(); Object.assign(d.entities[3] as Record<string, unknown>, extra); return d; };
  const writtenP = () => writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((d) => d.id === P).pop();
  const aTraits = (doc: PrefabFile | undefined) => Object.keys(doc?.entities.find((e) => e.localId === 2)?.traits ?? {});

  it('a ROW\'s removed trait is not listed, and Apply of everything leaves it on P', async () => {
    // Mutation: list against the bare capture in `collectInstanceOverrideKeys` (`captureInstanceStructure` for
    // `ownInstanceStructure`) — `-trait.<A>.UIAction` is listed, and applying it strips UIAction from P.
    install(pWithAction(), oRow({ removedTraits: { 2: ['UIAction'] } }));
    await load(scene(O, [ROOT1]));
    expect(readTraitData(inInstance(ROOT1, 'A'), meta('UIAction'))).toBeFalsy(); // precondition: the row removes it
    expect(keys(nestedRoot())).toEqual([]);
    setTf(inInstance(ROOT1, 'A'), 'x', 9); // something to apply, so the apply writes P
    expect((await applyToPrefabSelective(nestedRoot(), new Set(keys(nestedRoot())))).applied).toBe(true);
    expect(aTraits(writtenP())).toContain('UIAction');
  });

  it('Apply REFUSES the row\'s removed trait from a caller that still holds its key, and says why', async () => {
    // Mutation: drop the enclosing-layer refusal in `applyToPrefabSelective` — P is written with A stripped.
    install(pWithAction(), oRow({ removedTraits: { 2: ['UIAction'] } }));
    await load(scene(O, [ROOT1]));
    const key = `-trait.${gA}.UIAction`;
    const r = await applyToPrefabSelective(nestedRoot(), new Set([key]));
    expect(r.skipped).toEqual([{ key, reason: expect.stringMatching(/enclosing/) }]);
    expect(aTraits(writtenP() ?? (getCachedPrefabSync(P) as PrefabFile))).toContain('UIAction');
  });

  it('a ROW\'s removed member and a ROW\'s added node are not listed', async () => {
    // Mutation: as the first case — `-removed.<A>` and `+added.<derived guid>` are listed.
    install(pDoc(), oRow({ removed: [2] }));
    await load(scene(O, [ROOT1]));
    expect(keys(nestedRoot())).toEqual([]);
    install(oRow({ added: [{ parentLocalId: 1, guid: '', key: 'k-extra', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0, guid: '' }, Transform: { x: 1, y: 0, z: 0 } }, children: [] }] }));
    await load(scene(O, [ROOT1]));
    inInstance(ROOT1, 'Extra'); // precondition: the row's node spawned
    expect(keys(nestedRoot())).toEqual([]);
  });

  it('a ROW\'s added node the scene EDITED is still not listed, and Apply of everything does not copy it into P', async () => {
    // Close-out review: `subtractChainStructure` keeps an edited chain node, so it was listed and Apply wrote it into P —
    // every other instance of O then showed Extra twice. Mutation: drop the `edited` filter in `ownInstanceStructure`.
    install(pDoc(), oRow({ added: [{ parentLocalId: 1, guid: '', key: 'k-extra', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0, guid: '' }, Transform: { x: 1, y: 0, z: 0 } }, children: [] }] }));
    await load(scene(O, [ROOT1, ROOT2]));
    setTf(inInstance(ROOT1, 'Extra'), 'x', 7);
    expect(keys(nestedRoot())).toEqual([]);
    setTf(inInstance(ROOT1, 'A'), 'x', 9); // something to apply, so the apply writes P
    expect((await applyToPrefabSelective(nestedRoot(), new Set(keys(nestedRoot())))).applied).toBe(true);
    expect(writtenP()!.entities.map((e) => e.name)).toEqual(['R', 'A']);
    expect(x(inInstance(ROOT2, 'Extra'))).toBe(1); // one copy, the row's
  });

  it('ACCEPT side of the edited-node filter: a node the SCENE added is listed beside an edited row node', async () => {
    // Scoped close-out review. Mutation: drop EVERY added node once one layer node is edited (`added: []` for the
    // `edited` filter in `ownInstanceStructure`) — the scene's own node goes unlisted.
    const MINE = 'eeeeeeee-0000-4000-8000-000000001509';
    install(pDoc(), oRow({ added: [{ parentLocalId: 1, guid: '', key: 'k-extra', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0, guid: '' }, Transform: { x: 1, y: 0, z: 0 } }, children: [] }] }));
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'Extra'), 'x', 7);
    const { scene: sc, entry } = await saved();
    // v17 (#1516): the scene's own node rides `own`, appended beside the row's; the edit to Extra is its node row.
    const rows = entry.members as Record<string, { own?: unknown[] }>;
    const rowR = (rows[`/${gN}`] ??= {});
    rowR.own = [...(rowR.own ?? []), { parentLocalId: 0, guid: MINE, name: 'Mine', traits: { EntityAttributes: { name: 'Mine', parentId: 0, guid: MINE }, Transform: { x: 2, y: 0, z: 0 } }, children: [] }];
    await load(sc);
    expect([x(inInstance(ROOT1, 'Extra')), x(inInstance(ROOT1, 'Mine'))]).toEqual([7, 2]); // precondition: both live
    expect(keys(nestedRoot())).toEqual([`+added.${MINE}`]);
  });

  it('Revert REFUSES the row\'s removed trait: the row\'s removal is what the instance shows with nothing of its own', async () => {
    // Scoped close-out review: a direct caller's revert of the key put UIAction back. Mutation: drop the
    // `layerAuthoredStructureKeys` loop in `revertOverridesSelective`.
    install(pWithAction(), oRow({ removedTraits: { 2: ['UIAction'] } }));
    await load(scene(O, [ROOT1]));
    await revertOverridesSelective(nestedRoot(), new Set([`-trait.${gA}.UIAction`]));
    expect(readTraitData(inInstance(ROOT1, 'A'), meta('UIAction'))).toBeFalsy();
  });

  it('ACCEPT side: what the SCENE changes on the nested instance is still listed, beside the row\'s own', async () => {
    // Mutation: subtract every captured list whole in `ownInstanceStructure` — the scene's own edits vanish too.
    const p = pWithAction();
    (p.entities[0]!.traits as Record<string, unknown>).UIAction = {};
    install(p, oRow({ removedTraits: { 2: ['UIAction'] } }));
    await load(scene(O, [ROOT1]));
    const rTrait = `-trait.${gR}.UIAction`;
    const scene1 = (await saved()).scene;
    // The scene removes R's UIAction (the row does not): hand-edit the saved scene's member row, then reload.
    const entry = (scene1.entities as unknown as Array<Record<string, unknown>>).find((e) => e.prefab === O)!;
    entry.members = { ...(entry.members as object), [`/${gN}`]: { removedTraits: ['UIAction'] } };
    await load(scene1);
    expect(readTraitData(inInstance(ROOT1, 'R'), meta('UIAction'))).toBeFalsy();
    expect(keys(nestedRoot())).toEqual([rTrait]);
  });

  describe('a reference node a TEMPLATE row authored', () => {
    /** P2: R2 → XA, and R2 → Inner (a row expanding P). */
    const p2Doc = () => ({ id: P2, version: 5, name: 'P2', rootLocalId: 1, entities: [
      row(1, 'R2', 0, gR2), row(2, 'XA', 1, gXA),
      { localId: 3, name: 'Inner', nodeGuid: gIn, prefab: P, traits: { EntityAttributes: { name: 'Inner', parentId: 1, guid: '' } } },
    ] });
    /** O's row N adds a reference node expanding P2 that sets XA.x = 3, and A.x = 4 inside P2's Inner row. */
    const refNode = (xv = 3) => ({
      parentLocalId: 1, guid: '', key: 'k-ref', name: 'Ref', prefab: P2, traits: {}, children: [],
      overrides: { 2: { Transform: { x: xv } } }, nestedOverrides: { 3: { 2: { Transform: { x: 4 } } } },
    });
    const withRefNode = (xv = 3) => oRow({ added: [refNode(xv)] });
    const xa = () => inInstance(ROOT1, 'XA');
    const refRoot = () => (readTraitData(xa(), meta('PrefabInstance')) as { rootInstanceId: number }).rootInstanceId;
    const xaKey = `${gXA}.Transform.x`;

    it('the node\'s own value is not listed; a scene edit over it is, and Revert gives the NODE\'s value', async () => {
      // Mutation: return null from `templateReferenceNode` — 3 is listed with nothing edited, and Revert gives P2's 0.
      // The reload half (#1511): Revert's target lasts past a save — the saved scene leaves the node to the template,
      // so a later change to the node reaches it. Mutation: return false from `sameReference` in `frameAddedDiff` —
      // the save restates the member's list whole and the reload shows 3.
      install(pDoc(), p2Doc(), withRefNode());
      await load(scene(O, [ROOT1]));
      expect(x(xa())).toBe(3); // precondition: the node applies
      expect(keys(refRoot(), P2)).toEqual([]);
      setTf(xa(), 'x', 5);
      expect(keys(refRoot(), P2)).toEqual([xaKey]);
      await revertOverridesSelective(refRoot(), new Set([xaKey]));
      expect(x(xa())).toBe(3);
      expect(keys(refRoot(), P2)).toEqual([]);
      const { scene: sc } = await saved();
      install(withRefNode(8));
      await load(sc);
      expect(x(xa())).toBe(8);
    });

    /** O's row N adds a plain Holder2 whose child is the reference node (#1513). */
    const withHeldRefNode = (node: Record<string, unknown> = refNode()) => oRow({ added: [{
      parentLocalId: 1, guid: '', key: 'k-holder', name: 'Holder2', children: [node],
      traits: { EntityAttributes: { name: 'Holder2', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
    }] });

    it('inside a plain added node\'s children (#1513): the node\'s value is not listed, and Revert gives the NODE\'s value', async () => {
      // Mutation: stop the climb in `templateReferenceNode` at the direct parent — `frame` is 0, 3 is listed with nothing
      // edited, and Revert gives P2's 0. Mutation 2: collect only the layer's top-level `added` — the same.
      install(pDoc(), p2Doc(), withHeldRefNode());
      await load(scene(O, [ROOT1]));
      expect(x(xa())).toBe(3); // precondition: the node applies
      expect(keys(refRoot(), P2)).toEqual([]);
      setTf(xa(), 'x', 5);
      expect(keys(refRoot(), P2)).toEqual([xaKey]);
      await revertOverridesSelective(refRoot(), new Set([xaKey]));
      expect(x(xa())).toBe(3);
    });

    it('inside a plain added node\'s children, a node that LOST its key marker is still found', async () => {
      // Mutation: drop the `recoverTemplateKey` fallback in `templateReferenceNode` — 3 is listed again.
      install(pDoc(), p2Doc(), withHeldRefNode());
      await load(scene(O, [ROOT1]));
      getCurrentWorld().entities.find((e) => e.id() === refRoot())!.remove(TemplateAddedKey);
      expect(keys(refRoot(), P2)).toEqual([]);
    });

    it('inside a plain added node\'s children, the node\'s own removed trait is not listed, and Revert refuses it', async () => {
      // Mutation: as the first #1513 case — `-trait.<XA>.UIAction` is listed, and Revert puts UIAction back.
      const p2 = p2Doc();
      (p2.entities[1]!.traits as Record<string, unknown>).UIAction = {};
      install(pDoc(), p2, withHeldRefNode({ ...refNode(), removedTraits: { 2: ['UIAction'] } }));
      await load(scene(O, [ROOT1]));
      expect(readTraitData(xa(), meta('UIAction'))).toBeFalsy(); // precondition: the node removes it
      expect(keys(refRoot(), P2)).toEqual([]);
      await revertOverridesSelective(refRoot(), new Set([`-trait.${gXA}.UIAction`]));
      expect(readTraitData(xa(), meta('UIAction'))).toBeFalsy();
    });

    it('ACCEPT side: an instance the SCENE put inside the template\'s plain node is its own — its edit is listed, and Revert gives the template', async () => {
      // Mutation: match any candidate when the root has no key (`candidates[0]`) in `templateReferenceNode` — the
      // scene's instance takes the row's node as its base, and its x = 3 edit is not listed.
      install(pDoc(), p2Doc(), withHeldRefNode());
      await load(scene(O, [ROOT1]));
      const holder = inInstance(ROOT1, 'Holder2');
      const mine = instantiatePrefab(getCachedPrefabSync(P2) as PrefabFile, holder);
      setPrefabSource(mine, P2);
      const mineXa = getAllEntities().find((e) => e.name === 'XA' && e.parentId === mine)!.id;
      setTf(mineXa, 'x', 3);
      expect(keys(mine, P2)).toEqual([xaKey]);
      await revertOverridesSelective(mine, new Set([xaKey]));
      expect(x(mineXa)).toBe(0);
    });

    it('a node that LOST its key marker (Play→Stop, an undo respawn) is still found, by the key its guid derives from', async () => {
      // Mutation: drop the `recoverTemplateKey` fallback in `templateReferenceNode` — the node's 3 is listed again.
      install(pDoc(), p2Doc(), withRefNode());
      await load(scene(O, [ROOT1]));
      const root = getCurrentWorld().entities.find((e) => e.id() === refRoot())!;
      expect(root.has(TemplateAddedKey)).toBe(true); // precondition: the loader stamped it
      root.remove(TemplateAddedKey);
      expect(keys(refRoot(), P2)).toEqual([]);
    });

    it('a row UNDER the node reads the node\'s nested STRUCTURE as its base', async () => {
      // Close-out review. Mutation: drop the `seed` of `resolveEffectivePrefabStructure` in `enclosingLayer` — the node's
      // removal is listed as the inner instance's own.
      const p = pWithAction();
      const node = (withRefNode().entities[3] as unknown as { added: Array<Record<string, unknown>> }).added[0]!;
      node.nestedStructure = { 3: { removedTraits: { 2: ['UIAction'] } } };
      install(p, p2Doc(), oRow({ added: [node] }));
      await load(scene(O, [ROOT1]));
      const pi = (id: number) => readTraitData(id, meta('PrefabInstance')) as { rootInstanceId: number; parentLocalId: number };
      const inner = getAllEntities().filter((e) => e.name === 'A').map((e) => e.id)
        .find((id) => pi(pi(id).rootInstanceId).parentLocalId === 3)!;
      expect(readTraitData(inner, meta('UIAction'))).toBeFalsy(); // precondition: the node removes it
      expect(keys(pi(inner).rootInstanceId)).toEqual([]);
    });

    it('a row UNDER the node reads the node\'s nested overrides as its base', async () => {
      // Mutation: drop the `seed` in `enclosingLayer`'s row branch — the node's A.x = 4 is listed as the inner
      // instance's own override.
      install(pDoc(), p2Doc(), withRefNode());
      await load(scene(O, [ROOT1]));
      // P's A twice: in row N's expansion, and in P2's Inner row (parentLocalId 3) under the node.
      const pi = (id: number) => readTraitData(id, meta('PrefabInstance')) as { rootInstanceId: number; parentLocalId: number };
      const inner = getAllEntities().filter((e) => e.name === 'A').map((e) => e.id)
        .find((id) => pi(pi(id).rootInstanceId).parentLocalId === 3)!;
      expect(x(inner)).toBe(4); // precondition: the node forwards into its row
      const innerRoot = pi(inner).rootInstanceId;
      expect(keys(innerRoot)).toEqual([]);
    });
  });
});

describe('a save leaves what a TEMPLATE row authors inside its nested frame to the row (#1511)', () => {
  // The scene wrote a statement for every member the row's structure touched, equal or not, and an explicit
  // statement replaces the row's (`foldMemberRowChannels`) — so a no-op save pinned the row, and a later template
  // change to it never reached the scene. Each case: save with nothing edited, change the template, reload.
  const oRow = (extra: Record<string, unknown>) => { const d = oDoc(); Object.assign(d.entities[3] as Record<string, unknown>, extra); return d; };
  const extra = (xv: number) => ({ parentLocalId: 1, guid: '', key: 'k-extra', name: 'Extra', children: [],
    traits: { EntityAttributes: { name: 'Extra', parentId: 0, guid: '' }, Transform: { x: xv, y: 0, z: 0 } } });
  const pWithAction = () => { const d = pDoc(); (d.entities[1]!.traits as Record<string, unknown>).UIAction = {}; return d; };
  const rows = (entry: Record<string, unknown>) => entry.members as Record<string, Record<string, unknown>>;
  const aRow = `/${gN}/${gA}`;
  /** Save, install `next` as the new template, reload the SAVED scene; the saved entry. */
  const reloadUnder = async (...next: Array<{ id?: string }>) => {
    const { scene: sc, entry } = await saved();
    install(...next);
    await load(sc);
    return entry;
  };
  const remove = (id: number) => {
    const world = getCurrentWorld();
    for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
  };

  it('an ADDED node: a later change to it reaches the saved scene', async () => {
    // Mutation: mark every anchor `whole` in `frameAddedDiff`'s result — R's row restates Extra and the reload shows 1.
    install(pDoc(), oRow({ added: [extra(1)] }));
    await load(scene(O, [ROOT1]));
    const entry = await reloadUnder(oRow({ added: [extra(8)] }));
    expect(rows(entry)[`/${gN}`]?.added).toBeUndefined();
    expect(x(inInstance(ROOT1, 'Extra'))).toBe(8);
  });

  it('a REMOVED member: the template dropping the removal brings it back', async () => {
    // Mutation: write `removed` whenever the chain touches the member (drop the `!==` test) — A stays removed.
    install(pDoc(), oRow({ removed: [2] }));
    await load(scene(O, [ROOT1]));
    const entry = await reloadUnder(oDoc());
    expect(rows(entry)[aRow]?.removed).toBeUndefined();
    inInstance(ROOT1, 'A'); // throws unless exactly one
  });

  it('a REMOVED TRAIT: the template dropping the removal brings it back', async () => {
    // Mutation: drop the `sameNames` test — A's row restates the removal and UIAction stays gone.
    install(pWithAction(), oRow({ removedTraits: { 2: ['UIAction'] } }));
    await load(scene(O, [ROOT1]));
    const entry = await reloadUnder(oDoc());
    expect(rows(entry)[aRow]?.removedTraits).toBeUndefined();
    expect(readTraitData(inInstance(ROOT1, 'A'), meta('UIAction'))).toBeTruthy();
  });

  it('ACCEPT side: the scene DELETING the row\'s node is saved, and the node stays deleted', async () => {
    // Mutation: drop the `{ removed: true }` row in `matchList` (nodeRowDiff.ts) — nothing states the deletion, and
    // Extra is back.
    install(pDoc(), oRow({ added: [extra(1)] }));
    await load(scene(O, [ROOT1]));
    remove(inInstance(ROOT1, 'Extra'));
    const entry = await reloadUnder(oRow({ added: [extra(8)] }));
    // v17 (#1516): the deletion is the node's own row, not an empty list over the member's.
    expect(rows(entry)[`/${gN}/a+k-extra`]).toEqual({ removed: true });
    expect(rows(entry)[`/${gN}`]?.added).toBeUndefined();
    expect(getAllEntities().filter((e) => e.name === 'Extra')).toEqual([]);
  });

  it('ACCEPT side: a node the scene put IN PLACE of the row\'s is saved', async () => {
    // The v16 `added` hand-written below still REPLACES the row's list on load. Mutation: drop the unmatched live nodes
    // in `matchList` (never push to `own`) — Mine is not saved.
    const MINE = 'eeeeeeee-0000-4000-8000-000000001511';
    install(pDoc(), oRow({ added: [extra(1)] }));
    await load(scene(O, [ROOT1]));
    const { scene: sc, entry } = await saved();
    rows(entry)[`/${gN}`]!.added = [{ parentLocalId: 1, guid: MINE, name: 'Mine', children: [],
      traits: { EntityAttributes: { name: 'Mine', parentId: 0, guid: MINE }, Transform: { x: 2, y: 0, z: 0 } } }];
    await load(sc);
    expect(getAllEntities().filter((e) => e.name === 'Extra')).toEqual([]); // precondition: the scene's list replaced the row's
    await reloadUnder(oRow({ added: [extra(8)] }));
    expect(x(inInstance(ROOT1, 'Mine'))).toBe(2);
  });

  it('ACCEPT side: the scene UN-removing a member the row removes is saved', async () => {
    // Mutation: never touch `removed` in `moveChannelsOntoRows` — the second save drops `removed: false` and A is gone.
    install(pDoc(), oRow({ removed: [2] }));
    await load(scene(O, [ROOT1]));
    const { scene: sc, entry } = await saved();
    rows(entry)[aRow] = { removed: false };
    await load(sc);
    inInstance(ROOT1, 'A'); // precondition: the scene brought it back
    const again = await reloadUnder(oRow({ removed: [2] }));
    expect(rows(again)[aRow]?.removed).toBe(false);
    inInstance(ROOT1, 'A');
  });

  it('a template REFERENCE node: a refresh delivers the template\'s change to it, and so does a saved scene', async () => {
    // A live capture of a reference node carries identity the template node does not (member rows' guid/name, a name no
    // spawn applies), so it compared EDITED everywhere. Mutation: compare the raw nodes in `subtractChainStructure`
    // (drop `withoutLiveIdentity`) — the rebuild respawns the old node (3), and the save restates it.
    const P2 = 'cccccccc-0000-4000-8000-000000001511';
    const gXA = 'eeeeeeee-0000-4000-8000-000000001512';
    const p2 = { id: P2, version: 5, name: 'P2', rootLocalId: 1, entities: [row(1, 'R2', 0, 'eeeeeeee-0000-4000-8000-000000001513'), row(2, 'XA', 1, gXA)] };
    const withNode = (xv: number) => oRow({ added: [{ parentLocalId: 1, guid: '', key: 'k-ref', name: 'Ref', prefab: P2, traits: {}, children: [], overrides: { 2: { Transform: { x: xv } } } }] });
    install(pDoc(), p2, withNode(3));
    await load(scene(O, [ROOT1]));
    const xa = () => inInstance(ROOT1, 'XA');
    expect(x(xa())).toBe(3); // precondition
    install(withNode(8));
    expect(await rebaseStaleInstances()).toBe(1);
    expect(x(xa())).toBe(8);
    const entry = await reloadUnder(withNode(9));
    expect(rows(entry)[`/${gN}`]?.added).toBeUndefined();
    expect(x(xa())).toBe(9);
  });

  it('a row node holding a member TOKEN is compared as the guid it names: not restated, and a template change reaches it', async () => {
    // Close-out review. Mutation: skip `resolveAddedNodeTokens` in `frameAddedDiff` — the live node holds A's guid
    // where the chain holds the token, so it reads as edited and is pinned.
    const withToken = (xv: number) => { const n = extra(xv); (n.traits as Record<string, unknown>).UIAction = { bindings: [{ target: '@member:2' }] }; return n; };
    install(pDoc(), oRow({ added: [withToken(1)] }));
    await load(scene(O, [ROOT1]));
    const target = (readTraitData(inInstance(ROOT1, 'Extra'), meta('UIAction')) as { bindings: Array<{ target: string }> }).bindings[0]!.target;
    expect(target).toBe(getAllEntities().find((e) => e.id === inInstance(ROOT1, 'A'))!.guid); // precondition: resolved
    const entry = await reloadUnder(oRow({ added: [withToken(8)] }));
    expect(rows(entry)[`/${gN}`]?.added).toBeUndefined();
    expect(Object.keys(rows(entry)).filter((k) => k.includes('/a+'))).toEqual([]); // not even the bindings (#1516)
    expect(x(inInstance(ROOT1, 'Extra'))).toBe(8);
  });

  describe('a template REFERENCE node\'s member identity (close-out review)', () => {
    const P4 = 'cccccccc-0000-4000-8000-000000001521';
    const gXA4 = 'eeeeeeee-0000-4000-8000-000000001522';
    const gXB4 = 'eeeeeeee-0000-4000-8000-000000001523';
    /** P4: R4 → XA, and XB under R4 — or under XA once the template MOVES it. */
    const p4 = (moved = false) => ({ id: P4, version: 5, name: 'P4', rootLocalId: 1, entities: [
      row(1, 'R4', 0, 'eeeeeeee-0000-4000-8000-000000001524'), row(2, 'XA', 1, gXA4), row(3, 'XB', moved ? 2 : 1, gXB4)] });
    const withNode4 = () => oRow({ added: [{ parentLocalId: 1, guid: '', key: 'k-ref4', name: 'Ref4', prefab: P4, traits: {}, children: [], overrides: { 2: { Transform: { x: 3 } } } }] });
    const guidOf = (name: string) => getAllEntities().find((e) => e.name === name)!.guid;

    it('a member guid the scene STORED, which the member no longer derives, is kept through a save the node is otherwise equal in', async () => {
      // Mutation: strip every member row's `guid` in `withoutLiveIdentity` — the node compares equal, the save leaves it
      // to the template, and XB re-derives a new guid under every scene ref into it.
      install(pDoc(), p4(), withNode4());
      await load(scene(O, [ROOT1]));
      setTf(inInstance(ROOT1, 'XA'), 'x', 5); // an edit, so the save restates the node with its members' guids
      await reloadUnder(p4(true)); // the template moves XB under XA: XB now derives a different guid
      const stored = guidOf('XB');
      setTf(inInstance(ROOT1, 'XA'), 'x', 3); // back to the node's value: only the stored identity differs now
      await reloadUnder(p4(true));
      expect(guidOf('XB')).toBe(stored);
    });

    it('an ORPHAN member row (the template dropped the member) does not pin the node', async () => {
      // Scoped close-out review. Mutation: also keep a row guid that NO live member holds in `withoutLiveIdentity` (the
      // first fix kept every guid not derived) — the orphan's guid pins the node on every save, and x = 7 never arrives.
      const p4NoXb = () => ({ ...p4(), entities: p4().entities.slice(0, 2) });
      const withX = (xv: number) => { const d = withNode4(); ((d.entities[3] as unknown as { added: Array<{ overrides: Record<number, unknown> }> }).added[0]!).overrides = { 2: { Transform: { x: xv } } }; return d; };
      install(pDoc(), p4(), withNode4());
      await load(scene(O, [ROOT1]));
      setTf(inInstance(ROOT1, 'XA'), 'x', 5); // an edit, so the save restates the node with rows for XA and XB
      await reloadUnder(p4NoXb()); // the template drops XB: its row is an orphan now
      setTf(inInstance(ROOT1, 'XA'), 'x', 3); // back to the node's value
      await reloadUnder(p4NoXb(), withX(7));
      expect(x(inInstance(ROOT1, 'XA'))).toBe(7);
    });

    it('a node whose nested slot omits a list is still the template\'s: not restated on a save', async () => {
      // Mutation: drop the slot fill in `withoutLiveIdentity` — the template's `{removedTraits}` never equals the live
      // capture's three lists, and the node is pinned.
      const P5 = 'cccccccc-0000-4000-8000-000000001525';
      const p5 = { id: P5, version: 5, name: 'P5', rootLocalId: 1, entities: [row(1, 'R5', 0, 'eeeeeeee-0000-4000-8000-000000001526'),
        { localId: 2, name: 'In5', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001527', prefab: P, traits: { EntityAttributes: { name: 'In5', parentId: 1, guid: '' } } }] };
      const pA = pDoc();
      (pA.entities[1]!.traits as Record<string, unknown>).UIAction = {};
      install(pA, p5, oRow({ added: [{ parentLocalId: 1, guid: '', key: 'k-ref5', name: 'Ref5', prefab: P5, traits: {}, children: [],
        nestedStructure: { 2: { removedTraits: { 2: ['UIAction'] } } } }] }));
      await load(scene(O, [ROOT1]));
      const inner = getAllEntities().filter((e) => e.name === 'A').find((e) => !readTraitData(e.id, meta('UIAction')));
      expect(inner).toBeTruthy(); // precondition: the node's slot removes the inner A's UIAction
      expect(rows((await saved()).entry)[`/${gN}`]?.added).toBeUndefined();
    });

    it('a member the scene MOVED inside the node is kept through a save', async () => {
      // Mutation: strip `parent` from member rows too in `withoutLiveIdentity` — the move reads as identity, the node
      // compares equal, and XB reloads under R4.
      install(pDoc(), p4(), withNode4());
      await load(scene(O, [ROOT1]));
      reparentEntity(inInstance(ROOT1, 'XB'), inInstance(ROOT1, 'XA'));
      await reloadUnder(p4());
      const byId = new Map(getAllEntities().map((e) => [e.id, e]));
      expect(byId.get(byId.get(inInstance(ROOT1, 'XB'))!.parentId)!.name).toBe('XA');
    });
  });

  it('the row\'s node keeps its guid through a save and a reload it is no longer restated in', async () => {
    // A scene ref into the node rode on the restated guid (`docs/scene-loading.md`); now the node re-derives it from
    // its key. Not a guard of the save change (a restated node keeps its guid too): it pins what a ref now rests on.
    // Mutation: re-key the node in the reloaded template (`k-extra` → `k-other`) — the guid moves.
    install(pDoc(), oRow({ added: [extra(1)] }));
    await load(scene(O, [ROOT1]));
    const before = getAllEntities().find((e) => e.name === 'Extra')!.guid;
    expect(before).toBeTruthy();
    await reloadUnder(oRow({ added: [extra(1)] }));
    expect(getAllEntities().find((e) => e.name === 'Extra')!.guid).toBe(before);
  });

  it('#1516: a scene edit to ONE of the row\'s nodes leaves its SIBLING to the row — a later change to the sibling reaches the scene', async () => {
    const extra2 = (xv: number) => ({ ...extra(xv), key: 'k-extra2', name: 'Extra2',
      traits: { EntityAttributes: { name: 'Extra2', parentId: 0, guid: '' }, Transform: { x: xv, y: 0, z: 0 } } });
    install(pDoc(), oRow({ added: [extra(1), extra2(1)] }));
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'Extra'), 'x', 5);
    await reloadUnder(oRow({ added: [extra(1), extra2(8)] }));
    expect(x(inInstance(ROOT1, 'Extra'))).toBe(5); // the scene's edit wins
    expect(x(inInstance(ROOT1, 'Extra2'))).toBe(8); // the untouched sibling follows the row
  });

  /** Row N adds Extra and Extra2 under R. */
  const extra2 = (xv: number) => ({ ...extra(xv), key: 'k-extra2', name: 'Extra2',
    traits: { EntityAttributes: { name: 'Extra2', parentId: 0, guid: '' }, Transform: { x: xv, y: 0, z: 0 } } });
  const twoRow = (a: number, b: number) => oRow({ added: [extra(a), extra2(b)] });
  const nodeRowKeys = (entry: Record<string, unknown>) => Object.keys(rows(entry)).filter((k) => k.includes('/a+'));

  it('#1516: a no-op save writes no node row, though the row authors default-valued fields', async () => {
    // `extra` states y: 0 and z: 0, which the live capture drops as schema defaults. Mutation: compare the raw bags in
    // `frameAddedDiff` (`compact` returning its input, `defaultOf` undefined) — both nodes read as edited.
    install(pDoc(), twoRow(1, 1));
    await load(scene(O, [ROOT1]));
    const { entry } = await saved();
    expect(nodeRowKeys(entry)).toEqual([]);
    expect([rows(entry)[`/${gN}`]?.added, rows(entry)[`/${gN}`]?.own]).toEqual([undefined, undefined]);
  });

  it('#1516: the scene\'s edit is ONE field on that node\'s row', async () => {
    install(pDoc(), twoRow(1, 1));
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'Extra'), 'x', 5);
    const { entry } = await saved();
    expect(rows(entry)[`/${gN}/a+k-extra`]).toEqual({ traits: { Transform: { x: 5 } } });
    expect(nodeRowKeys(entry)).toEqual([`/${gN}/a+k-extra`]);
  });

  it('#1516: a node field the scene sets BACK to its schema default is saved as the default', async () => {
    // The live capture drops a default-valued field, so the edit is an ABSENT field. Mutation: `defaultOf` returning
    // undefined in `frameAddedDiff` — the edit is skipped and the reload shows the row's 1.
    install(pDoc(), twoRow(1, 1));
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'Extra'), 'x', 0);
    const entry = await reloadUnder(twoRow(1, 1));
    expect(rows(entry)[`/${gN}/a+k-extra`]).toEqual({ traits: { Transform: { x: 0 } } });
    expect(x(inInstance(ROOT1, 'Extra'))).toBe(0);
  });

  it('#1516: re-parenting a template node under a prefab MEMBER unlinks that node only (owner, 2026-09-24)', async () => {
    // Mutation: match live nodes by key anywhere in the frame (`matchList`: drop `chainKeys.has(k)`) — Extra is lost.
    install(pDoc(), twoRow(1, 1));
    await load(scene(O, [ROOT1]));
    reparentEntity(inInstance(ROOT1, 'Extra'), inInstance(ROOT1, 'A'));
    const entry = await reloadUnder(twoRow(8, 8));
    expect(rows(entry)[`/${gN}/a+k-extra`]).toEqual({ removed: true });
    const byId = new Map(getAllEntities().map((e) => [e.id, e]));
    const ex = inInstance(ROOT1, 'Extra');
    expect(byId.get(byId.get(ex)!.parentId)!.name).toBe('A'); // where the scene put it
    expect(x(ex)).toBe(1); // unlinked: the template's 8 does not reach it
    expect(x(inInstance(ROOT1, 'Extra2'))).toBe(8); // its sibling still follows the row
  });

  it('#1516: re-parenting a template node under a SIBLING template node unlinks it the same way', async () => {
    install(pDoc(), twoRow(1, 1));
    await load(scene(O, [ROOT1]));
    reparentEntity(inInstance(ROOT1, 'Extra'), inInstance(ROOT1, 'Extra2'));
    const entry = await reloadUnder(twoRow(8, 8));
    expect(rows(entry)[`/${gN}/a+k-extra`]).toEqual({ removed: true });
    expect((rows(entry)[`/${gN}/a+k-extra2`]?.own as unknown[] | undefined)?.length).toBe(1);
    const byId = new Map(getAllEntities().map((e) => [e.id, e]));
    const ex = inInstance(ROOT1, 'Extra');
    expect(byId.get(byId.get(ex)!.parentId)!.name).toBe('Extra2');
    expect(x(ex)).toBe(1);
    expect(x(inInstance(ROOT1, 'Extra2'))).toBe(8);
  });

  it('#1516: a node the scene adds LIVE beside the row\'s rides `own`, and the row\'s nodes still follow the template', async () => {
    // Mutation: write `own` as `added` in `moveChannelsOntoRows` — the reload replaces the row's list and Extra is gone.
    const MINE = 'eeeeeeee-0000-4000-8000-000000001516';
    install(pDoc(), twoRow(1, 1));
    await load(scene(O, [ROOT1]));
    getCurrentWorld().spawn(
      meta('EntityAttributes').trait({ name: 'Mine', parentId: inInstance(ROOT1, 'R'), guid: MINE }),
      meta('Transform').trait({ x: 2 }),
    );
    const entry = await reloadUnder(twoRow(8, 8));
    expect((rows(entry)[`/${gN}`]?.own as Array<{ guid: string }>).map((n) => n.guid)).toEqual([MINE]);
    expect(rows(entry)[`/${gN}`]?.added).toBeUndefined();
    expect([x(inInstance(ROOT1, 'Extra')), x(inInstance(ROOT1, 'Extra2')), x(inInstance(ROOT1, 'Mine'))]).toEqual([8, 8, 2]);
  });

  it('#1516 rider, ACCEPT side: a scene RESTORING a trait the row removes is saved as `false`, and stays restored', async () => {
    // Mutation: drop the `false` half of `traitRemovalStatements` — nothing is saved and the reload removes it again.
    install(pWithAction(), oRow({ removedTraits: { 2: ['UIAction'] } }));
    await load(scene(O, [ROOT1]));
    getCurrentWorld().entities.find((e) => e.id() === inInstance(ROOT1, 'A'))!.add(meta('UIAction').trait());
    const entry = await reloadUnder(oRow({ removedTraits: { 2: ['UIAction'] } }));
    expect(rows(entry)[aRow]?.traitRemovals).toEqual({ UIAction: false });
    expect(readTraitData(inInstance(ROOT1, 'A'), meta('UIAction'))).toBeTruthy();
  });

  it('#1516 fork 2: the template dropping a node the scene edited drops the node, warns, and KEEPS the row across a save', async () => {
    // Mutation: drop the `knownKeys` test in R2 (`applyStoredMemberRows`) — no warning, and the next save loses the row,
    // so the template bringing the node back brings it back unedited.
    install(pDoc(), twoRow(1, 1));
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'Extra'), 'x', 5);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gone = await reloadUnder(oRow({ added: [extra2(1)] })); // the template drops Extra
    const warned = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    expect(rows(gone)[`/${gN}/a+k-extra`]).toEqual({ traits: { Transform: { x: 5 } } }); // precondition: it was saved
    expect(getAllEntities().filter((e) => e.name === 'Extra')).toEqual([]);
    expect(warned.some((m) => m.includes(`/${gN}/a+k-extra`))).toBe(true);
    await reloadUnder(twoRow(1, 1)); // saved without the node, then the template brings it back
    expect(x(inInstance(ROOT1, 'Extra'))).toBe(5);
  });

  /** Row N adds Extra (x, y) and Extra2 under R. */
  const xyRow = (ax: number, ay: number, b: number) => oRow({ added: [
    { ...extra(ax), traits: { EntityAttributes: { name: 'Extra', parentId: 0, guid: '' }, Transform: { x: ax, y: ay, z: 0 } } }, extra2(b)] });
  const y = (id: number) => (readTraitData(id, meta('Transform')) as { y: number }).y;

  it('#1516 Refresh: a template change reaches the edited node\'s OTHER fields and its sibling, and the edit stays', async () => {
    install(pDoc(), xyRow(1, 0, 1));
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'Extra'), 'x', 5);
    install(xyRow(1, 3, 8));
    expect(await rebaseStaleInstances()).toBe(1);
    expect([x(inInstance(ROOT1, 'Extra')), y(inInstance(ROOT1, 'Extra')), x(inInstance(ROOT1, 'Extra2'))]).toEqual([5, 3, 8]);
    // …and the save after it still states only the edit.
    const { entry } = await saved();
    expect(rows(entry)[`/${gN}/a+k-extra`]).toEqual({ traits: { Transform: { x: 5 } } });
  });

  it('#1516 Refresh: a template node the scene deleted stays deleted, and a save still says so', async () => {
    install(pDoc(), twoRow(1, 1));
    await load(scene(O, [ROOT1]));
    remove(inInstance(ROOT1, 'Extra'));
    install(twoRow(8, 8));
    expect(await rebaseStaleInstances()).toBe(1);
    expect(getAllEntities().filter((e) => e.name === 'Extra')).toEqual([]);
    expect(x(inInstance(ROOT1, 'Extra2'))).toBe(8);
    const { entry } = await saved();
    expect(rows(entry)[`/${gN}/a+k-extra`]).toEqual({ removed: true });
  });

  it('#1516 Refresh and reload: a child the scene put UNDER a template node stays there, and the node follows the template', async () => {
    // Mutation: skip `row.own` in `applyNodeRowsLive` — the Refresh loses Kid. Mutation 2: drop the node row's
    // `own` in `diffNode` (nodeRowDiff.ts) — nothing saves Kid.
    const KID = 'eeeeeeee-0000-4000-8000-000000001517';
    install(pDoc(), twoRow(1, 1));
    await load(scene(O, [ROOT1]));
    getCurrentWorld().spawn(
      meta('EntityAttributes').trait({ name: 'Kid', parentId: inInstance(ROOT1, 'Extra'), guid: KID }),
      meta('Transform').trait({ x: 4 }),
    );
    install(twoRow(8, 8));
    expect(await rebaseStaleInstances()).toBe(1);
    const parentName = () => { const byId = new Map(getAllEntities().map((e) => [e.id, e])); return byId.get(byId.get(inInstance(ROOT1, 'Kid'))!.parentId)!.name; };
    expect([parentName(), x(inInstance(ROOT1, 'Kid')), x(inInstance(ROOT1, 'Extra'))]).toEqual(['Extra', 4, 8]);
    const entry = await reloadUnder(twoRow(9, 9));
    expect((rows(entry)[`/${gN}/a+k-extra`]?.own as Array<{ guid: string }>).map((n) => n.guid)).toEqual([KID]);
    expect([parentName(), x(inInstance(ROOT1, 'Kid')), x(inInstance(ROOT1, 'Extra'))]).toEqual(['Extra', 4, 9]);
  });

  // ── Close-out review findings (#1516). ──

  it('#1516 fork 2 through a REFRESH: the template dropping an edited node keeps its row, and restoring it brings the edit back', async () => {
    // Close-out review F1. Mutation: drop the kept-orphan hand-off in `reapplyNestedInstanceOverrides` — the save
    // after the Refresh loses the row, and the restored node reloads unedited.
    install(pDoc(), twoRow(1, 1));
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'Extra'), 'x', 5);
    await reloadUnder(twoRow(1, 1)); // the edit is on disk
    install(oRow({ added: [extra2(1)] })); // the template drops Extra
    expect(await rebaseStaleInstances()).toBe(1);
    expect(getAllEntities().filter((e) => e.name === 'Extra')).toEqual([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kept = await reloadUnder(twoRow(1, 1)); // saved, then the template brings Extra back
    warn.mockRestore();
    expect(rows(kept)[`/${gN}/a+k-extra`]).toEqual({ traits: { Transform: { x: 5 } } });
    expect(x(inInstance(ROOT1, 'Extra'))).toBe(5);
  });

  it('#1516 fork 2: a REFRESH that brings a kept node back applies its edit — the editor shows what the save writes', async () => {
    // Close-out review F2. Mutation: skip merging the kept orphans into the capture's node rows — the Refresh shows 1
    // while the save writes 5.
    install(pDoc(), twoRow(1, 1));
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'Extra'), 'x', 5);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await reloadUnder(oRow({ added: [extra2(1)] })); // the template drops Extra: its row is a kept orphan
    warn.mockRestore();
    install(twoRow(1, 1)); // …and brings it back
    expect(await rebaseStaleInstances()).toBe(1);
    expect(x(inInstance(ROOT1, 'Extra'))).toBe(5);
    const { entry } = await saved();
    expect(rows(entry)[`/${gN}/a+k-extra`]).toEqual({ traits: { Transform: { x: 5 } } });
  });

  it('#1516: a template node whose anchor member is GONE re-anchors to the frame root, and a no-op save pins nothing', async () => {
    // Close-out review F3: the loader re-anchors it; the diff looked for it under the missing anchor and read the
    // re-anchor as a re-parent. Mutation: drop the re-anchor in `frameAddedDiff` — the save writes `removed` + `own`.
    const lost = (xv: number) => ({ ...extra(xv), parentLocalId: 7 });
    install(pDoc(), oRow({ added: [lost(1), extra2(1)] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await load(scene(O, [ROOT1]));
    const entry = await reloadUnder(oRow({ added: [lost(8), extra2(1)] }));
    warn.mockRestore();
    expect(nodeRowKeys(entry)).toEqual([]);
    expect(rows(entry)[`/${gN}`]?.own).toBeUndefined();
    expect(x(inInstance(ROOT1, 'Extra'))).toBe(8);
  });

  /** P with B under A (localId 3), B carrying UIAction. */
  const gB = 'eeeeeeee-0000-4000-8000-000000001516';
  const pWithB = () => {
    const d = pDoc();
    const b = row(3, 'B', 2, gB);
    (b.traits as Record<string, unknown>).UIAction = {};
    (d.entities as unknown[]).push(b);
    return d;
  };

  it('#1516: deleting a member leaves what the row says about members BELOW it to the row — no pin', async () => {
    // Close-out review F4(a): only the top-most removed member was skipped, so B read as live-but-changed, its row
    // needed a key it cannot have, and the frame fell back to the whole legacy slot. Mutation: skip only `liveRemoved`
    // (not every member with no live entity) in `moveChannelsOntoRows` — Extra2 stays at 1.
    install(pWithB(), oRow({ added: [extra(1), extra2(1)], removedTraits: { 3: ['UIAction'] } }));
    await load(scene(O, [ROOT1]));
    deleteEntitiesWithUndo([inInstance(ROOT1, 'A')]); // the editor's delete: A and everything below it
    setTf(inInstance(ROOT1, 'Extra'), 'x', 5);
    await reloadUnder(oRow({ added: [extra(1), extra2(8)], removedTraits: { 3: ['UIAction'] } }));
    expect([x(inInstance(ROOT1, 'Extra')), x(inInstance(ROOT1, 'Extra2'))]).toEqual([5, 8]);
  });

  it('#1516: a template node under a member BELOW a deleted one is not saved as deleted by the scene', async () => {
    // Close-out review F4(b). Mutation: as above — the save writes `/gN/a+k-extra: { removed: true }`.
    install(pWithB(), oRow({ added: [{ ...extra(1), parentLocalId: 3 }, extra2(1)] }));
    await load(scene(O, [ROOT1]));
    deleteEntitiesWithUndo([inInstance(ROOT1, 'A')]); // the editor's delete: A and everything below it
    const { entry } = await saved();
    expect(nodeRowKeys(entry)).toEqual([]);
  });

  it('#1516 fork 2: a node the template moved into ANOTHER row\'s frame orphans the scene\'s row for it — warned and kept', async () => {
    // Close-out review F5: the backed-key set was template-wide, so the row read as backed, applied nowhere, and was
    // dropped on the next save. Mutation: collect keys from every row of the template in `templateFrameKeys`.
    const gM = 'eeeeeeee-0000-4000-8000-000000001518';
    const withM = (nAdded: unknown[], mAdded: unknown[]) => {
      const d = oRow({ added: nAdded });
      (d.entities as unknown[]).push({ localId: 5, name: 'M', nodeGuid: gM, prefab: P, added: mAdded, traits: { EntityAttributes: { name: 'M', parentId: 3, guid: '' } } });
      return d;
    };
    install(pDoc(), withM([extra(1), extra2(1)], []));
    await load(scene(O, [ROOT1]));
    setTf(getAllEntities().find((e) => e.name === 'Extra')!.id, 'x', 5);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const moved = await reloadUnder(withM([extra2(1)], [extra(1)])); // Extra now belongs to M's frame
    const warned = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    expect(rows(moved)[`/${gN}/a+k-extra`]).toEqual({ traits: { Transform: { x: 5 } } });
    expect(warned.some((m) => m.includes(`/${gN}/a+k-extra`))).toBe(true);
    const { entry } = await saved();
    expect(rows(entry)[`/${gN}/a+k-extra`]).toEqual({ traits: { Transform: { x: 5 } } }); // still kept
  });

  it('#1516: a member the ROW removes, below one the scene deletes, is left to the row — no pin (re-review R1)', async () => {
    // The `removed` twin of F4: B read as un-removed, its statement was unkeyable, and the frame fell back to the
    // whole legacy slot. Mutation: drop the `liveLids` test from the `removed` loop in `moveChannelsOntoRows`.
    install(pWithB(), oRow({ added: [extra(1), extra2(1)], removed: [3] }));
    await load(scene(O, [ROOT1]));
    deleteEntitiesWithUndo([inInstance(ROOT1, 'A')]);
    const entry = await reloadUnder(oRow({ added: [extra(1), extra2(8)], removed: [3] }));
    expect(entry.nestedStructure).toBeUndefined();
    expect(x(inInstance(ROOT1, 'Extra2'))).toBe(8);
  });

  it('#1516 fork 2: a node the template moved into a CHILD frame\'s slot orphans the row that named it (re-review R2)', async () => {
    // `templateFrameKeys` counted every slot on the way down, so the node read as still backed in row N's frame.
    // Mutation: collect every slot of each row instead of the one addressing the frame.
    install(pDoc(), twoRow(1, 1));
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'Extra'), 'x', 5);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Extra now rides N's own slot for a (hypothetical) inner row 9 — a different frame from N's.
    const entry = await reloadUnder(oRow({ added: [extra2(1)], nestedStructure: { 9: { added: [extra(1)] } } }));
    const warned = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    expect(warned.some((m) => m.includes(`/${gN}/a+k-extra`))).toBe(true);
    expect(rows(entry)[`/${gN}/a+k-extra`]).toEqual({ traits: { Transform: { x: 5 } } });
    const { entry: again } = await saved();
    expect(rows(again)[`/${gN}/a+k-extra`]).toEqual({ traits: { Transform: { x: 5 } } }); // still kept
  });

  it('#1516 ACCEPT side of R2: a node N\'s SLOT adds one frame further down is backed there — its edit applies, unwarned', async () => {
    // Mutation: key the slot lookup in `templateFrameKeys` by the wrong path (the row's own localId) — the row reads as an
    // orphan and is warned about.
    const Q = 'cccccccc-0000-4000-8000-000000001522';
    const gM = 'eeeeeeee-0000-4000-8000-000000001523';
    const q = { id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000001524')] };
    const pWithM = () => { const d = pDoc(); (d.entities as unknown[]).push({ localId: 3, name: 'M', nodeGuid: gM, prefab: Q, traits: { EntityAttributes: { name: 'M', parentId: 2, guid: '' } } }); return d; };
    const deep = (xv: number) => ({ ...extra(xv), key: 'k-deep', name: 'Deep',
      traits: { EntityAttributes: { name: 'Deep', parentId: 0, guid: '' }, Transform: { x: xv, y: 0, z: 0 } } });
    const oSlot = (xv: number) => oRow({ nestedStructure: { 3: { added: [deep(xv)] } } });
    install(q, pWithM(), oSlot(1));
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'Deep'), 'x', 5);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entry = await reloadUnder(oSlot(1));
    const warned = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    expect(rows(entry)[`/${gN}/${gM}/a+k-deep`]).toEqual({ traits: { Transform: { x: 5 } } });
    expect(warned.filter((m) => m.includes('a+k-deep'))).toEqual([]);
    expect(x(inInstance(ROOT1, 'Deep'))).toBe(5);
  });

  it('#1516: a template REFERENCE node the scene deleted stays deleted across a Refresh, and is not kept as an orphan (re-review R3b)', async () => {
    // `applyNodeRowsLive` skipped every instance entity, so it never found a reference node: the Refresh brought it
    // back and handed its `removed` row to the kept store. Mutation: skip reference-node roots in `applyNodeRowsLive`.
    const P2 = 'cccccccc-0000-4000-8000-000000001519';
    const p2 = { id: P2, version: 5, name: 'P2', rootLocalId: 1, entities: [row(1, 'R2', 0, 'eeeeeeee-0000-4000-8000-000000001520'), row(2, 'XA', 1, 'eeeeeeee-0000-4000-8000-000000001521')] };
    const ref = { parentLocalId: 1, guid: '', key: 'k-ref', name: 'Ref', prefab: P2, traits: {}, children: [] };
    install(pDoc(), p2, oRow({ added: [ref, extra2(1)] }));
    await load(scene(O, [ROOT1]));
    const refRoot = (readTraitData(inInstance(ROOT1, 'XA'), meta('PrefabInstance')) as { rootInstanceId: number }).rootInstanceId;
    deleteEntitiesWithUndo([refRoot]);
    install(oRow({ added: [ref, extra2(8)] }));
    expect(await rebaseStaleInstances()).toBe(1);
    expect(getAllEntities().filter((e) => e.name === 'XA')).toEqual([]);
    const { entry } = await saved();
    expect(rows(entry)[`/${gN}/a+k-ref`]).toEqual({ removed: true });
    await load((await saved()).scene);
    expect(getAllEntities().filter((e) => e.name === 'XA')).toEqual([]);
    expect(x(inInstance(ROOT1, 'Extra2'))).toBe(8);
  });

  it('#1516 rider: a scene removing ANOTHER trait leaves the row\'s removed trait to the row', async () => {
    const pTwo = () => { const d = pWithAction(); (d.entities[1]!.traits as Record<string, unknown>).UIFocusable = {}; return d; };
    install(pTwo(), oRow({ removedTraits: { 2: ['UIAction'] } }));
    await load(scene(O, [ROOT1]));
    const a = getCurrentWorld().entities.find((e) => e.id() === inInstance(ROOT1, 'A'))!;
    a.remove(meta('UIFocusable').trait as never);
    expect(readTraitData(inInstance(ROOT1, 'A'), meta('UIFocusable'))).toBeFalsy(); // precondition
    await reloadUnder(oDoc());
    expect(readTraitData(inInstance(ROOT1, 'A'), meta('UIFocusable'))).toBeFalsy(); // the scene's removal wins
    expect(readTraitData(inInstance(ROOT1, 'A'), meta('UIAction'))).toBeTruthy(); // the row dropped its removal
  });
});
