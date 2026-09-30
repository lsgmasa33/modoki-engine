/** A nested instance's fields, where the enclosing prefab's ROW also sets them — the save and the rebuild.
 *
 *  #1498 — the save subtracted what the row sets by KEY, so a scene edit to a row-set field read as the row's own
 *  and was dropped. Both captures now subtract by VALUE (`subtractChainOverrides`), rotation as one orientation.
 *
 *  #1492 — Apply from the NESTED instance of a field the row also sets. Since #1693 (U13, superseding owner ruling
 *  (b)): the row's override of it is REVERTED with the Apply, so every instance of the outer prefab shows the applied
 *  value and the source keeps nothing. The listing and Revert still read the instance against its template under the
 *  enclosing rows (`enclosingRowOverrides`).
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
import { clearKeptMemberOrphans, keptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import {
  setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, reparentEntity, deleteEntitiesWithUndo,
} from '@modoki/engine/editor';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import {
  setPrefabCache, getCachedPrefabSync, setPrefabSource,
} from '../../packages/modoki/src/editor/scene/prefabCache';
import { collectComparableTraits } from '../../packages/modoki/src/editor/scene/prefabInstanceOverrides';
import { memberOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabChain';
import { instantiatePrefab } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { rebaseStaleInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { applyToPrefabSelective } from '../../packages/modoki/src/editor/scene/prefabApply';
import { revertOverridesSelective } from '../../packages/modoki/src/editor/scene/prefabRevert';
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

describe('Apply from a nested instance whose field the outer row also sets (#1492; U13 supersedes ruling b, #1693)', () => {
  const nestedRoot = () => inInstance(ROOT1, 'R');
  const keysOf = (root: number) => collectInstanceOverrideKeys(root, getCachedPrefabSync(P) as PrefabFile).fields;
  const xKey = `${gA}.Transform.x`;
  /** Reload the saved scene over the P and O the Apply WROTE. */
  const reload = async () => {
    const { scene: sc } = await saved();
    for (const id of [P, O]) {
      const last = writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((d) => d.id === id).pop();
      if (last) install(last);
    }
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

  it('U13: the row\'s override of the applied x is REVERTED too — every instance of O shows 5, and the source keeps nothing', async () => {
    // Unity: "if Apply to Prefab 'Vase' is chosen and the 'Table' Prefab has an override of the value, this override in
    // the 'Table' Prefab is reverted at the same time" (owner, 2026-09-28; supersedes #1492 ruling b). Mutation: skip
    // U13's drop in `planApply` — O keeps its row's 3, ROOT2 still shows 3, and O is not written.
    await applyBoth();
    const oWritten = writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((d) => d.id === O).pop();
    expect(oWritten?.entities.find((e) => e.localId === 4)?.overrides?.[2]?.Transform).toBeUndefined();
    expect([x(inInstance(ROOT1, 'A')), x(inInstance(ROOT2, 'A'))]).toEqual([5, 5]);
    expect(keysOf(nestedRoot())).toEqual([]);
    await reload();
    expect([x(inInstance(ROOT1, 'A')), x(inInstance(ROOT2, 'A'))]).toEqual([5, 5]);
    expect(keysOf(nestedRoot())).toEqual([]);
  });

  it('NOT shadowed: the applied y is subtracted (#1469) — not listed, nothing in the file', async () => {
    // Mutation: drop `refreshInstances`' `subtractFieldOverrides(captured, from.fields)` — y is pinned on the source and listed.
    await applyBoth();
    expect(tfOf(inInstance(ROOT1, 'A')).y).toBe(7);
    expect(keysOf(nestedRoot())).not.toContain(`${gA}.Transform.y`);
    const row = (await saved()).entry.members as Record<string, { traits?: { Transform?: Record<string, unknown> } }>;
    expect(row[`/${gN}/${gA}`]?.traits?.Transform ?? {}).not.toHaveProperty('y');
  });

  it('Revert of a scene override of a field the row sets gives the ROW\'s value, not the template\'s', async () => {
    // Mutation: drop the enclosing-row put-back in `revertOverridesSelective` — A reverts to P's 0.
    install(pDoc(), oWith({ 2: { Transform: { x: 3 } } }));
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'A'), 'x', 5);
    await revertOverridesSelective(nestedRoot(), new Set([xKey]));
    expect(x(inInstance(ROOT1, 'A'))).toBe(3);
    expect(keysOf(nestedRoot())).toEqual([]);
    await load((await saved()).scene);
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
      setPrefabSource(mine, { id: P2 });
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
      // Close-out review. Mutation: drop `frameBase`'s node seed (`nodeForward(node, …)` → undefined, prefabBase.ts) — the
      // node's removal is listed as the inner instance's own.
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
      // Mutation: drop `frameBase`'s node seed (`nodeForward(node, …)` → undefined, prefabBase.ts) — the node's A.x = 4 is
      // listed as the inner instance's own override.
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
    // Close-out review F1. Mutation (since #1535, where the settle owns it): skip the `before` loop in
    // `captureRowsForSettle` — the save after the Refresh loses the row, and the restored node reloads unedited.
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

  describe('#1536: a template REFERENCE node\'s own traits and children are read by no spawn, so they are not an edit', () => {
    const P2 = 'cccccccc-0000-4000-8000-000000001536';
    const p2 = { id: P2, version: 5, name: 'P2', rootLocalId: 1, entities: [row(1, 'R2', 0, 'eeeeeeee-0000-4000-8000-000000001537'), row(2, 'XA', 1, 'eeeeeeee-0000-4000-8000-000000001538')] };
    /** A hand- or agent-written node: the live capture writes `traits: {}` and `children: []`, this one states both. */
    const ref = { parentLocalId: 1, guid: '', key: 'k-ref', name: 'Ref', prefab: P2, children: [{ ...extra(4), key: 'k-inert', name: 'Inert' }],
      traits: { EntityAttributes: { name: 'Ref', parentId: 0, guid: '' }, Transform: { x: 2, y: 0, z: 0 } } };

    it('a no-edit save leaves the node to the row, before and after a Refresh', async () => {
      // Mutation: keep `traits` (or, separately, `children`) in `withoutLiveIdentity`'s reference branch — the node never
      // equals its live capture, and `/gN` restates the whole list, pinning Extra2 beside it.
      install(pDoc(), p2, oRow({ added: [ref, extra2(1)] }));
      await load(scene(O, [ROOT1]));
      expect(rows((await saved()).entry)[`/${gN}`]?.added).toBeUndefined();
      install(oRow({ added: [ref, extra2(8)] }));
      expect(await rebaseStaleInstances()).toBe(1);
      const { entry } = await saved();
      expect(rows(entry)[`/${gN}`]?.added).toBeUndefined();
      expect(nodeRowKeys(entry)).toEqual([]);
      expect(x(inInstance(ROOT1, 'Extra2'))).toBe(8);
    });

    it('ACCEPT side: a scene edit inside the node still restates it, and reloads', async () => {
      install(pDoc(), p2, oRow({ added: [ref, extra2(1)] }));
      await load(scene(O, [ROOT1]));
      setTf(inInstance(ROOT1, 'XA'), 'x', 5);
      const entry = await reloadUnder(oRow({ added: [ref, extra2(1)] }));
      expect(rows(entry)[`/${gN}`]?.added).toBeDefined();
      expect(x(inInstance(ROOT1, 'XA'))).toBe(5);
    });
  });

  describe('#1535: a rebuild leaves the kept-orphan store as a reload would — both directions, any depth', () => {
    /** O without row N (P's instance), and P without A. */
    const oNoN = () => { const d = oDoc(); d.entities = d.entities.slice(0, 3); return d; };
    const pNoA = () => { const d = pDoc(); d.entities = d.entities.slice(0, 1); return d; };
    const entryOf = async (source: string) => ((await serializeScene()) as unknown as SceneData).entities
      .find((e) => (e as { prefab?: string }).prefab === source) as unknown as Record<string, unknown>;
    const withN = () => oRow({ added: [extra(1)] });
    /** The scene edits R (N's root), A inside N, and the row's node Extra. */
    const editN = () => {
      setTf(inInstance(ROOT1, 'R'), 'x', 7);
      setTf(inInstance(ROOT1, 'A'), 'x', 6);
      setTf(inInstance(ROOT1, 'Extra'), 'x', 5);
    };
    const shown = () => [x(inInstance(ROOT1, 'R')), x(inInstance(ROOT1, 'A')), x(inInstance(ROOT1, 'Extra'))];

    it('a frame the Refresh spawns WHOLE gets its kept member, root and node rows back, live and on disk', async () => {
      // Mutations: skip `replayRowsLive` in the settle (every row stays kept) — the editor shows 0, 0, 1 while the
      // file reloads as 7, 6, 5; skip the forwarded root rows — R alone shows 0.
      install(pDoc(), withN());
      await load(scene(O, [ROOT1]));
      editN();
      await reloadUnder(oNoN()); // the template drops N: its rows are orphans now
      install(withN());
      expect(await rebaseStaleInstances()).toBe(1);
      expect(shown()).toEqual([7, 6, 5]);
      await reloadUnder(withN());
      expect(shown()).toEqual([7, 6, 5]);
    });

    it('depth 0: a direct member the template dropped and restored keeps its edit through the Refresh', async () => {
      install(pDoc());
      await load(scene(P, [ROOT1]));
      setTf(inInstance(ROOT1, 'A'), 'x', 6);
      const { scene: sc } = { scene: (await serializeScene()) as unknown as SceneData };
      install(pNoA());
      await load(sc);
      install(pDoc());
      expect(await rebaseStaleInstances()).toBe(1);
      expect(x(inInstance(ROOT1, 'A'))).toBe(6);
      expect((rows(await entryOf(P))[`/${gA}`] as { traits?: unknown }).traits).toEqual({ Transform: { x: 6 } });
    });

    it('a frame the rebuild CAPTURED: its member dropped and restored by the inner template keeps its edit', async () => {
      install(pDoc(), oDoc());
      await load(scene(O, [ROOT1]));
      setTf(inInstance(ROOT1, 'A'), 'x', 6);
      await reloadUnder(pNoA());
      install(pDoc());
      expect(await rebaseStaleInstances()).toBe(1);
      expect(x(inInstance(ROOT1, 'A'))).toBe(6);
      expect(rowOf((await saved()).entry, gA)?.traits).toEqual({ Transform: { x: 6 } });
    });

    it('a Refresh that DROPS a member keeps its row, and a Refresh restoring it (an undo) brings the edit back', async () => {
      // Mutation: skip the `before` loop in the settle — the dropped member's row is thrown away, the save loses it,
      // and the restore shows 0.
      install(pDoc());
      await load(scene(P, [ROOT1]));
      setTf(inInstance(ROOT1, 'A'), 'x', 6);
      install(pNoA());
      expect(await rebaseStaleInstances()).toBe(1);
      expect((rows(await entryOf(P))[`/${gA}`] as { traits?: unknown }).traits).toEqual({ Transform: { x: 6 } });
      install(pDoc());
      expect(await rebaseStaleInstances()).toBe(1);
      expect(x(inInstance(ROOT1, 'A'))).toBe(6);
    });

    it('a Refresh that drops a whole nested ROW keeps every row inside it, and one restoring it brings them back', async () => {
      install(pDoc(), withN());
      await load(scene(O, [ROOT1]));
      editN();
      install(oNoN());
      expect(await rebaseStaleInstances()).toBe(1);
      const kept = rows((await saved()).entry);
      expect(kept[`/${gN}/${gA}`]?.traits).toEqual({ Transform: { x: 6 } });
      expect(kept[`/${gN}/a+k-extra`]).toEqual({ traits: { Transform: { x: 5 } } });
      install(withN());
      expect(await rebaseStaleInstances()).toBe(1);
      expect(shown()).toEqual([7, 6, 5]);
    });

    it('a replayed row leaves the store: an edit back to the template value after the Refresh is saved as no edit', async () => {
      // Mutation: keep the replayed rows in the store — the save re-emits `/gN/a+k-extra: {x: 5}`, and the reload shows 5.
      install(pDoc(), withN());
      await load(scene(O, [ROOT1]));
      editN();
      await reloadUnder(oNoN());
      install(withN());
      await rebaseStaleInstances();
      setTf(inInstance(ROOT1, 'Extra'), 'x', 1);
      const entry = await reloadUnder(withN());
      expect(rows(entry)[`/${gN}/a+k-extra`]).toBeUndefined();
      expect(x(inInstance(ROOT1, 'Extra'))).toBe(1);
    });

    it('ACCEPT side: a Refresh that does not bring the member back leaves its kept rows kept', async () => {
      install(pDoc(), withN());
      await load(scene(O, [ROOT1]));
      editN();
      await reloadUnder(oNoN());
      const moved = oNoN(); (moved.entities[1]!.traits as { Transform: { x: number } }).Transform.x = 3; // an unrelated change
      install(moved);
      expect(await rebaseStaleInstances()).toBe(1);
      const kept = rows((await saved()).entry);
      expect(kept[`/${gN}/${gA}`]?.traits).toEqual({ Transform: { x: 6 } });
      expect(kept[`/${gN}/a+k-extra`]).toEqual({ traits: { Transform: { x: 5 } } });
    });

    it('two rows of one prefab refreshed in turn: neither reads the other against the old document (`torn`)', async () => {
      // P's own nested row Q3 adds Deep. Mutation: drop the `torn` filter in `captureRowsForSettle` — the second rebuild
      // reads the first (rebuilt without Deep) against the old P, sees Deep as `removed`, and keeps that as an orphan,
      // which the restore then replays as a deletion.
      const Q = 'cccccccc-0000-4000-8000-000000001540';
      const gQ3 = 'eeeeeeee-0000-4000-8000-000000001541';
      const gN2 = 'eeeeeeee-0000-4000-8000-000000001542';
      const q = { id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000001543')] };
      const deep = { ...extra(1), key: 'k-deep', name: 'Deep', traits: { EntityAttributes: { name: 'Deep', parentId: 0, guid: '' }, Transform: { x: 1, y: 0, z: 0 } } };
      const pQ = (withDeep: boolean) => { const d = pDoc(); (d.entities as unknown[]).push({ localId: 3, name: 'Q3', nodeGuid: gQ3, prefab: Q, added: withDeep ? [deep] : [], traits: { EntityAttributes: { name: 'Q3', parentId: 2, guid: '' } } }); return d; };
      const twoRows = () => { const d = oDoc(); (d.entities as unknown[]).push({ localId: 5, name: 'N2', nodeGuid: gN2, prefab: P, traits: { EntityAttributes: { name: 'N2', parentId: 3, guid: '' } } }); return d; };
      const deeps = () => getAllEntities().filter((e) => e.name === 'Deep').length;
      install(q, pQ(true), twoRows());
      await load(scene(O, [ROOT1]));
      expect(deeps()).toBe(2);
      install(pQ(false));
      expect(await rebaseStaleInstances()).toBe(2);
      expect(deeps()).toBe(0);
      install(pQ(true));
      expect(await rebaseStaleInstances()).toBe(2);
      expect(deeps()).toBe(2);
      await load((await saved()).scene);
      expect(deeps()).toBe(2);
    });

    /** A scene whose instance of O carries `members` while O has no row N — so every row is an orphan at load. */
    const orphanedScene = (members: Record<string, unknown>) => {
      const sc = scene(O, [ROOT1]) as unknown as { entities: Array<Record<string, unknown>> };
      sc.entities[1]!.members = members;
      return sc as unknown as SceneData;
    };
    const hasAction = () => !!readTraitData(inInstance(ROOT1, 'A'), meta('UIAction'));

    it('a kept `false` in traitRemovals restores the trait the row removes, live and on disk', async () => {
      // Mutation: skip the `restored` add-back in `replayRowsLive` — the fold has nothing to take the name out of, the
      // trait stays removed, and the row leaves the store: the save writes the chain's state and the restore is lost.
      const removes = () => oRow({ removedTraits: { 2: ['UIAction'] } });
      install(pWithAction(), oNoN());
      await load(orphanedScene({ [`/${gN}/${gA}`]: { traitRemovals: { UIAction: false } } }));
      install(removes());
      expect(await rebaseStaleInstances()).toBe(1);
      expect(hasAction()).toBe(true);
      await reloadUnder(removes());
      expect(hasAction()).toBe(true);
    });

    it('a kept `removed: false` stays kept through the Refresh and applies on the next load (not replayed live)', async () => {
      // Pins the documented gap: the chain already cut the member, so there is no live target, and the row is not lost.
      const removesA = () => oRow({ removed: [2] });
      install(pDoc(), oNoN());
      await load(orphanedScene({ [`/${gN}/${gA}`]: { removed: false } }));
      install(removesA());
      expect(await rebaseStaleInstances()).toBe(1);
      expect(getAllEntities().filter((e) => e.name === 'A')).toEqual([]);
      const entry = await reloadUnder(removesA());
      expect(rows(entry)[`/${gN}/${gA}`]).toEqual({ removed: false });
      expect(getAllEntities().filter((e) => e.name === 'A')).toHaveLength(1);
    });

    it('a scene-ADDED node under a member a Refresh drops VANISHES with it, kept in its row, and comes back ONCE (review F1, #1880 F3a B′)', async () => {
      // Flipped by #1880 F3a (hub ruling B′, 2026-09-30): R2 / fork 2 (owner, 2026-09-24) — what the scene hung under a
      // member the template drops vanishes with it and returns with it. The rebuild used to RE-HOME X at the instance root
      // while a reload of the same scene kept it in the orphan row (rebuild ≠ reload, hunt seed 1127); review F1's point
      // stands — X is never spawned twice. Mutations: re-anchor in the respawn (skip `withoutGoneMemberNodes`) — X is live
      // after the drop; keep the row whole in the settle AND re-home — the restore spawns a second X with the same guid.
      const gX = 'ffffffff-0000-4000-8000-000000001535';
      const xNode = { parentLocalId: 0, guid: gX, name: 'X', children: [],
        traits: { EntityAttributes: { name: 'X', parentId: 0, guid: gX }, Transform: { x: 3, y: 0, z: 0 } } };
      const sc = scene(P, [ROOT1]) as unknown as { entities: Array<Record<string, unknown>> };
      sc.entities[1]!.members = { [`/${gA}`]: { added: [xNode] } };
      const xs = () => getAllEntities().filter((e) => e.name === 'X');
      install(pDoc());
      await load(sc as unknown as SceneData);
      install(pNoA());
      expect(await rebaseStaleInstances()).toBe(1);
      expect(xs()).toHaveLength(0); // gone with A…
      const dropped = await entryOf(P);
      expect(JSON.stringify(rows(dropped)[`/${gA}`])).toContain(gX); // …and kept in A's row, not lost
      // A reload of what the Refresh left agrees: rebuild ≡ reload.
      await load((await serializeScene()) as unknown as SceneData);
      expect(xs()).toHaveLength(0);
      install(pDoc());
      expect(await rebaseStaleInstances()).toBe(1);
      expect(xs()).toHaveLength(1);
      expect(getAllEntities().filter((e) => e.guid === gX)).toHaveLength(1);
      await load((await serializeScene()) as unknown as SceneData);
      expect(xs()).toHaveLength(1);
    });

    it('a reference node whose prefab went MISSING, under a member a Refresh drops, vanishes into its row too, and comes back once (#1880 F3a review 1)', async () => {
      // Y is a live instance of S when S is trashed, so the teardown KEEPS its frame for a moment (`rebuildTeardown`'s
      // unexpandable keep): the settle read it as live and stripped it from the row, and `seatKeptFrames` then deleted it
      // as unnamed — gone from the world AND the row. Mutation: count dropped guids as live in the settle (`liveGuids`
      // without the `dropped` exclusion) — Y is in neither after the drop.
      const S = 'cccccccc-0000-4000-8000-000000001536';
      const sDoc = { id: S, version: 6, name: 'S', rootLocalId: 1, entities: [
        { localId: 1, name: 'SR', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001536', traits: { EntityAttributes: { name: 'SR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
      ] };
      const gY = 'ffffffff-0000-4000-8000-000000001536';
      const yNode = { parentLocalId: 0, guid: gY, name: 'SR', prefab: S, traits: {}, children: [] };
      const sc = scene(P, [ROOT1]) as unknown as { entities: Array<Record<string, unknown>> };
      sc.entities[1]!.members = { [`/${gA}`]: { added: [yNode] } };
      const ys = () => getAllEntities().filter((e) => e.guid === gY);
      install(pDoc(), sDoc);
      await load(sc as unknown as SceneData);
      expect(ys(), 'premise: Y is a live instance of S').toHaveLength(1);
      prefabs.delete(S); setPrefabCache(S, null); // S is trashed
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
      install(pNoA());
      expect(await rebaseStaleInstances()).toBe(1);
      expect(ys()).toHaveLength(0);
      expect(JSON.stringify(rows(await entryOf(P))[`/${gA}`])).toContain(gY);
      install(pDoc());
      expect(await rebaseStaleInstances()).toBe(1);
      expect(ys()).toHaveLength(1);
      await load((await serializeScene()) as unknown as SceneData);
      expect(ys()).toHaveLength(1);
      } finally { warn.mockRestore(); err.mockRestore(); }
    });

    it('a kept `false` on an owned nested ROOT restores the trait the row removes from it (review F2)', async () => {
      // Mutation: target the member's frame document for a nested root (not its child document) — nothing is restored,
      // and the row leaves the store.
      const pRootAction = () => { const d = pDoc(); (d.entities[0]!.traits as Record<string, unknown>).UIAction = {}; return d; };
      const removes = () => oRow({ removedTraits: { 1: ['UIAction'] } });
      const rHas = () => !!readTraitData(inInstance(ROOT1, 'R'), meta('UIAction'));
      install(pRootAction(), oNoN());
      await load(orphanedScene({ [`/${gN}`]: { traitRemovals: { UIAction: false } } }));
      install(removes());
      expect(await rebaseStaleInstances()).toBe(1);
      expect(rHas()).toBe(true);
      await reloadUnder(removes());
      expect(rHas()).toBe(true);
    });

    it('a kept v16 `removedTraits` list restores what it leaves out of the row\'s removals (review F3)', async () => {
      // Mutation: restore only `false` statements (ignore the list form) — A keeps the row's removal, and the row is lost.
      const removes = () => oRow({ removedTraits: { 2: ['UIAction'] } });
      install(pWithAction(), oNoN());
      await load(orphanedScene({ [`/${gN}/${gA}`]: { removedTraits: [] } }));
      install(removes());
      expect(await rebaseStaleInstances()).toBe(1);
      expect(hasAction()).toBe(true);
      await reloadUnder(removes());
      expect(hasAction()).toBe(true);
    });

    it('a load of an entry with NO member rows leaves nothing kept for its root — no stale row to replay (review F4)', async () => {
      // Mutation: push only entries with `members` in the loader (as before) — the kept Extra edit from the first world
      // survives the second load, and the next Refresh replays it onto an Extra the scene never edited.
      install(pDoc(), oNoN());
      await load(orphanedScene({ [`/${gN}/a+k-extra`]: { traits: { Transform: { x: 5 } } } }));
      install(pDoc(), withN());
      await load(scene(O, [ROOT1])); // the same root guid, a file with no rows at all
      const moved = withN(); (moved.entities[1]!.traits as { Transform: { x: number } }).Transform.x = 3; // an unrelated change
      install(moved);
      expect(await rebaseStaleInstances()).toBe(1);
      expect(x(inInstance(ROOT1, 'Extra'))).toBe(1);
    });

    it('a nested row that keeps its guid but expands ANOTHER prefab keeps the scene edit inside the old one (re-review 1)', async () => {
      // A document-only "does anything become unbacked" early-out missed the row's `prefab` ref. Mutation: skip the
      // capture whenever nothing is kept (drop `prefab === baseline` from the early-out) — `/gN/gA` is lost.
      const P2 = 'cccccccc-0000-4000-8000-000000001544';
      const p2 = { id: P2, version: 5, name: 'P2', rootLocalId: 1, entities: [row(1, 'R2', 0, 'eeeeeeee-0000-4000-8000-000000001545'), row(2, 'B2', 1, 'eeeeeeee-0000-4000-8000-000000001546')] };
      const swapped = () => { const d = oDoc(); (d.entities[3] as Record<string, unknown>).prefab = P2; return d; };
      install(pDoc(), p2, oDoc());
      await load(scene(O, [ROOT1]));
      setTf(inInstance(ROOT1, 'A'), 'x', 6);
      install(swapped());
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await rebaseStaleInstances()).toBe(1);
      warn.mockRestore();
      expect(rowOf((await saved()).entry, gA)?.traits).toEqual({ Transform: { x: 6 } });
      // …and the edit is NOT re-applied onto P2's member that holds A's old number (#1767): this assertion was missing,
      // and the case stayed green while the rebuild wrote A's x onto B2. Mutation: drop the translation in
      // `reapplyNestedInstanceOverrides` — B2 shows 6.
      expect(x(inInstance(ROOT1, 'B2'))).toBe(0);
    });

    it('a scene node under a member of a nested row RE-POINTED to another prefab vanishes into the member\'s row, as a reload keeps it (#1880 close-out re-review 1)', async () => {
      // The frame now expands P2, which has no A: the node the scene hung under A goes with A (R2, fork 2). Judged against
      // the frame's OLD source it was re-homed at P2's root and lost from the row (rebuild != reload). Mutation: filter
      // the nested capture against `getCachedPrefabSync(cap.source)` instead of the frame's document now — X is live.
      const P2 = 'cccccccc-0000-4000-8000-000000001544';
      const p2 = { id: P2, version: 5, name: 'P2', rootLocalId: 1, entities: [row(1, 'R2', 0, 'eeeeeeee-0000-4000-8000-000000001545'), row(2, 'B2', 1, 'eeeeeeee-0000-4000-8000-000000001546')] };
      const swapped = () => { const d = oDoc(); (d.entities[3] as Record<string, unknown>).prefab = P2; return d; };
      const gX = 'ffffffff-0000-4000-8000-000000001537';
      const xNode = { parentLocalId: 0, guid: gX, name: 'X', children: [], traits: { EntityAttributes: { name: 'X', parentId: 0, guid: gX }, Transform: { x: 3, y: 0, z: 0 } } };
      const sc = scene(O, [ROOT1]) as unknown as { entities: Array<Record<string, unknown>> };
      sc.entities[1]!.members = { [`/${gN}/${gA}`]: { added: [xNode] } };
      const xs = () => getAllEntities().filter((e) => e.guid === gX);
      install(pDoc(), p2, oDoc());
      await load(sc as unknown as SceneData);
      expect(xs(), 'premise: X hangs under A').toHaveLength(1);
      install(swapped());
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(await rebaseStaleInstances()).toBe(1);
        expect(xs()).toHaveLength(0);
        expect(JSON.stringify(rows((await saved()).entry)[`/${gN}/${gA}`])).toContain(gX);
        await load((await serializeScene()) as unknown as SceneData);
        expect(xs()).toHaveLength(0);
      } finally { warn.mockRestore(); }
    });

    it('a Refresh dropping a node from row N\'s nestedStructure SLOT keeps the scene edit to it (re-review 3)', async () => {
      // Mutation: as above — the slot's node row is lost, and the restore shows the template's 1.
      const Q = 'cccccccc-0000-4000-8000-000000001547';
      const gM = 'eeeeeeee-0000-4000-8000-000000001548';
      const q = { id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000001549')] };
      const pWithM = () => { const d = pDoc(); (d.entities as unknown[]).push({ localId: 3, name: 'M', nodeGuid: gM, prefab: Q, traits: { EntityAttributes: { name: 'M', parentId: 2, guid: '' } } }); return d; };
      const deep = { ...extra(1), key: 'k-deep', name: 'Deep', traits: { EntityAttributes: { name: 'Deep', parentId: 0, guid: '' }, Transform: { x: 1, y: 0, z: 0 } } };
      const oSlot = () => oRow({ nestedStructure: { 3: { added: [deep] } } });
      install(q, pWithM(), oSlot());
      await load(scene(O, [ROOT1]));
      setTf(inInstance(ROOT1, 'Deep'), 'x', 5);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      install(oRow({}));
      expect(await rebaseStaleInstances()).toBe(1);
      expect(rows((await saved()).entry)[`/${gN}/${gM}/a+k-deep`]).toEqual({ traits: { Transform: { x: 5 } } });
      install(oSlot());
      expect(await rebaseStaleInstances()).toBe(1);
      warn.mockRestore();
      expect(x(inInstance(ROOT1, 'Deep'))).toBe(5);
    });

    it('a load of a REFERENCE node with no rows leaves nothing kept for it — no stale row back on disk (re-review 2)', async () => {
      // Mutation: collect only reference nodes WITH `members` in `collectReferenceNodeRows` — the Ghost row kept by the
      // first load is written back by the save of the second.
      const gRef = 'dddddddd-0000-4000-8000-000000001550';
      const ghost = 'eeeeeeee-0000-4000-8000-000000001551';
      const refNode = (members?: Record<string, unknown>) => ({ parentLocalId: 1, guid: gRef, name: 'Ref', prefab: P, children: [],
        traits: {}, ...(members ? { members } : {}) });
      const sceneWith = (members?: Record<string, unknown>) => {
        const sc = scene(P, [ROOT1]) as unknown as { entities: Array<Record<string, unknown>> };
        sc.entities[1]!.added = [refNode(members)];
        return sc as unknown as SceneData;
      };
      install(pDoc());
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await load(sceneWith({ [`/${ghost}`]: { guid: 'ffffffff-0000-4000-8000-000000001552', name: 'Ghost', traits: { Transform: { x: 9 } } } }));
      await load(sceneWith());
      warn.mockRestore();
      expect(JSON.stringify(((await serializeScene()) as unknown as SceneData).entities)).not.toContain(ghost);
    });

    it('the loader\'s ORDER: a kept `added: []` on N\'s root takes the template\'s nodes away before its node rows look for them', async () => {
      // Mutation: skip the fresh-template-node deletion for a row's v16 `added` in `replayRowsLive` — Extra stays.
      install(pDoc(), oNoN());
      const sc = scene(O, [ROOT1]) as unknown as { entities: Array<Record<string, unknown>> };
      sc.entities[1]!.members = { [`/${gN}`]: { added: [] }, [`/${gN}/a+k-extra`]: { traits: { Transform: { x: 5 } } } };
      await load(sc as unknown as SceneData); // no N in the template: both rows are orphans
      install(withN());
      expect(await rebaseStaleInstances()).toBe(1);
      expect(getAllEntities().filter((e) => e.name === 'Extra')).toEqual([]);
      await reloadUnder(withN());
      expect(getAllEntities().filter((e) => e.name === 'Extra')).toEqual([]); // what a reload shows too
    });
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

describe('#1771: a saved member reference is read against the document its frame expands NOW (I4)', () => {
  // The rare trigger both issues share: a template row keeps its nodeGuid (gN) while the prefab it expands changes.
  const P2 = 'cccccccc-0000-4000-8000-000000001771';
  const gB = 'eeeeeeee-0000-4000-8000-000000001772';
  const gN2 = 'eeeeeeee-0000-4000-8000-000000001773';
  /** P with a second member: R → A (2), B (3). */
  const pAB = () => { const d = pDoc(); (d.entities as unknown[]).push(row(3, 'B', 1, gB)); return d; };
  /** P2: R2 → B2 (2), C2 (3) — numbered like P, so reading P's localIds against it lands on B2 and C2 one for one. */
  const p2 = () => ({ id: P2, version: 5, name: 'P2', rootLocalId: 1, entities: [
    row(1, 'R2', 0, 'eeeeeeee-0000-4000-8000-000000001774'), row(2, 'B2', 1, 'eeeeeeee-0000-4000-8000-000000001775'),
    row(3, 'C2', 1, 'eeeeeeee-0000-4000-8000-000000001776'),
  ] });
  /** O whose row N keeps gN but expands P2. `keepP`: a second row N2 (under Slot2) still expands P, so P's nodes are still
   *  in O's tree — which is what the template-wide backed test read as "backed". */
  const swapped = (keepP = false) => {
    const d = oDoc();
    (d.entities[3] as Record<string, unknown>).prefab = P2;
    if (keepP) (d.entities as unknown[]).push({ localId: 5, name: 'N2', nodeGuid: gN2, prefab: P, traits: { EntityAttributes: { name: 'N2', parentId: 3, guid: '' } } });
    return d;
  };
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
  const rowKeys = (entry: Record<string, unknown>) => Object.keys((entry.members ?? {}) as Record<string, unknown>);
  /** A's x in row N's frame (N2's A is under Slot2, so N's is the one under Slot). */
  const nA = () => {
    const slot = inInstance(ROOT1, 'Slot');
    const all = getAllEntities();
    const byId = new Map(all.map((e) => [e.id, e]));
    const hit = all.filter((e) => e.name === 'A' && [...(function* () { for (let c = byId.get(e.parentId); c; c = byId.get(c.parentId)) yield c.id; })()].includes(slot));
    if (hit.length !== 1) throw new Error(`fixture: ${hit.length} A under Slot`);
    return x(hit[0]!.id);
  };

  it('#1767: a Refresh re-applies nothing of the old prefab onto the new one, and equals a reload of the same file', async () => {
    // Mutation: drop the `translateLocalIds` call in `reapplyNestedInstanceOverrides` — B2 shows 6 and C2 is deleted,
    // and the save persists both.
    install(pAB(), p2(), oDoc());
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'A'), 'x', 6);
    deleteEntitiesWithUndo([inInstance(ROOT1, 'B')]);
    install(swapped());
    const warn = quiet();
    expect(await rebaseStaleInstances()).toBe(1);
    const refreshed = [x(inInstance(ROOT1, 'B2')), getAllEntities().filter((e) => e.name === 'C2').length];
    expect(refreshed).toEqual([0, 1]);
    const { scene: sc, entry } = await saved();
    // Every member keeps an identity row (its guid and name); what must not be there is an EDIT of B2 or C2.
    const members = (entry.members ?? {}) as Record<string, Record<string, unknown>>;
    expect(members[`/${gN}/eeeeeeee-0000-4000-8000-000000001775`]?.traits).toBeUndefined();
    expect(members[`/${gN}/eeeeeeee-0000-4000-8000-000000001776`]?.removed).toBeUndefined();
    await load(sc);
    warn.mockRestore();
    expect([x(inInstance(ROOT1, 'B2')), getAllEntities().filter((e) => e.name === 'C2').length]).toEqual(refreshed);
  });

  it('#1766 reload: a row whose chain is gone is KEPT although its node is still in the template elsewhere', async () => {
    // Mutation: back a member-row key by the template-wide guid set again (`parts.every((c) => known.has(c))` in
    // `rowBackedTest`) — the row reads as backed, applies nowhere, and the save drops it: A reloads at 0.
    install(pAB(), p2(), oDoc());
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'A'), 'x', 6);
    const { scene: first } = await saved();
    install(swapped(true));
    const warn = quiet();
    await load(first);
    const { scene: second, entry } = await saved();
    expect(rowKeys(entry)).toContain(`/${gN}/${gA}`);
    install(oDoc());
    await load(second);
    warn.mockRestore();
    expect(nA()).toBe(6);
  });

  it('#1766 Refresh: the settle keeps the same row, as the reload does', async () => {
    // Mutation: as above — the settle drops the row, and A comes back at 0.
    install(pAB(), p2(), oDoc());
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'A'), 'x', 6);
    install(swapped(true));
    const warn = quiet();
    expect(await rebaseStaleInstances()).toBe(1);
    const { scene: sc, entry } = await saved();
    expect(rowKeys(entry)).toContain(`/${gN}/${gA}`);
    install(oDoc());
    await load(sc);
    warn.mockRestore();
    expect(nA()).toBe(6);
  });

  it('#1767 one frame deeper: a capture inside a nested row of the re-pointed prefab finds its link by identity (review F3)', async () => {
    // P: R → A, M (3, nests Q); P2: R2 → B2, M2 (3, nests Q, ANOTHER nodeGuid). The scene edits QA inside N/M. Mutation:
    // follow the capture's chain by number again in `reapplyNestedInstanceOverrides` — M2 holds M's number, and its QA
    // shows 6 after the Refresh while a reload of the same file shows 0.
    const Q = 'cccccccc-0000-4000-8000-000000177110';
    const q = { id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [
      row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000177111'), row(2, 'QA', 1, 'eeeeeeee-0000-4000-8000-000000177112')] };
    const nestQ = <D extends { entities: unknown[] }>(d: D, name: string, nodeGuid: string): D => {
      d.entities.push({ localId: 3, name, nodeGuid, prefab: Q, traits: { EntityAttributes: { name, parentId: 1, guid: '' } } });
      return d;
    };
    // p2() has C2 at 3: dropped, so M2 takes that number — the collision this case is about.
    const p2m = p2(); p2m.entities = p2m.entities.slice(0, 2);
    install(q, nestQ(pDoc(), 'M', 'eeeeeeee-0000-4000-8000-000000177113'), nestQ(p2m, 'M2', 'eeeeeeee-0000-4000-8000-000000177114'), oDoc());
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'QA'), 'x', 6);
    install(swapped());
    const warn = quiet();
    expect(await rebaseStaleInstances()).toBe(1);
    const refreshed = x(inInstance(ROOT1, 'QA'));
    const { scene: sc } = await saved();
    await load(sc);
    warn.mockRestore();
    expect(refreshed).toBe(0);
    expect(x(inInstance(ROOT1, 'QA'))).toBe(0);
  });

  it('#1767 into a PRE-v5 prefab: nothing is matched by number across two prefabs (review F4)', async () => {
    // P2 with no nodeGuid anywhere. Mutation: drop `acrossPrefabs` at the re-apply — the unkeyed fallback matches A's 2
    // onto B2's 2, and B2 shows 6.
    const bare = p2();
    for (const e of bare.entities) delete (e as { nodeGuid?: string }).nodeGuid;
    install(pAB(), bare, oDoc());
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'A'), 'x', 6);
    install(swapped());
    const warn = quiet();
    expect(await rebaseStaleInstances()).toBe(1);
    warn.mockRestore();
    expect(x(inInstance(ROOT1, 'B2'))).toBe(0);
  });

  it('#1767 accept side: across two prefabs that SHARE a nodeGuid, the edit carries — as a reload carries it (review)', async () => {
    // A duplicated prefab keeps its nodeGuids; a template row re-pointed at the copy reaches the same members by identity.
    // Mutation: map every keyed row to 0 under `acrossPrefabs` in `translateLocalIds` — A's x is dropped on the Refresh.
    const COPY = 'cccccccc-0000-4000-8000-000000177120';
    const copy = { ...pAB(), id: COPY, name: 'P copy' };
    const toCopy = () => { const d = oDoc(); (d.entities[3] as Record<string, unknown>).prefab = COPY; return d; };
    install(pAB(), copy, oDoc());
    await load(scene(O, [ROOT1]));
    setTf(inInstance(ROOT1, 'A'), 'x', 6);
    install(toCopy());
    const warn = quiet();
    expect(await rebaseStaleInstances()).toBe(1);
    const refreshed = x(inInstance(ROOT1, 'A'));
    await load((await saved()).scene);
    warn.mockRestore();
    expect([refreshed, x(inInstance(ROOT1, 'A'))]).toEqual([6, 6]);
  });

  it('accept side: a row whose chain still exists through the new template is backed — not kept as an orphan', async () => {
    // The fold applies a row whether or not it is backed, so the value alone cannot tell; the kept store can. Mutation:
    // answer "not backed" for every member-row key in `rowBackedTest` — `/gN2/gA` is kept too, and a later Refresh
    // would replay it over whatever the scene does to that member next.
    install(pAB(), p2(), swapped(true));
    await load(scene(O, [ROOT1]));
    const sc = JSON.parse(JSON.stringify((await saved()).scene)) as { entities: Array<Record<string, unknown>> };
    const entry = sc.entities.find((e) => e.prefab === O)!;
    entry.members = { ...(entry.members as object), [`/${gN2}/${gA}`]: { traits: { Transform: { x: 6 } } } };
    await load(sc as unknown as SceneData);
    expect(Object.keys(keptMemberOrphans(ROOT1) ?? {})).not.toContain(`/${gN2}/${gA}`);
  });
});

// ── #1717 close-out review: the fold-in is excluded PER FIELD under an enclosing row ─────────────────────────────────
describe("a nested member's marked value equal to its base is listed unless the enclosing row states that field (#1717)", () => {
  // The save folds a marked value in and subtracts a field the chain states, per field (`captureNestedSceneDelta` →
  // `subtractChainOverrides`). The list skipped the whole fold-in whenever the row stated ANY field, so a pinned
  // override on another field was saved and listed nowhere: it could be neither reverted nor applied.
  // Mutation: skip the fold-in for the whole instance when the row states anything (the `base === prefab` rule) — A's x
  // is not listed. Always fold (drop `layerStates`) — R's y, the row's own marked value, is listed as the instance's.
  it('A.x (marked, equal to P) is listed and highlighted; R.y (the row states it) is not', async () => {
    install(pDoc(), oWith({ 1: { Transform: { y: 4 } } }));
    await load(scene(O, [ROOT1]));
    const a = inInstance(ROOT1, 'A');
    setTf(a, 'x', 7);
    setTf(a, 'x', 0); // back to P's own value, and still marked: a recorded override
    const nested = inInstance(ROOT1, 'R');
    const fields = collectInstanceOverrideKeys(nested, getCachedPrefabSync(P) as PrefabFile).fields;
    expect(fields.filter((k) => k.endsWith('Transform.x'))).toHaveLength(1);
    expect(fields.some((k) => k.endsWith('Transform.y'))).toBe(false);
    const tf = [meta('Transform')];
    expect(memberOverrideKeys(a, 2, collectComparableTraits(a, tf), getCachedPrefabSync(P) as PrefabFile, nested).has('Transform.x')).toBe(true);
    expect(memberOverrideKeys(nested, 1, collectComparableTraits(nested, tf), getCachedPrefabSync(P) as PrefabFile, nested).has('Transform.y')).toBe(false);
    // …and the save keeps what the list shows.
    const { entry } = await saved();
    expect(JSON.stringify(entry)).toContain('"x":0');
  });
});
