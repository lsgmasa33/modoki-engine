/** #1809 (owner ruling 2026-09-30, the Unity way): a template-KEYED node's guid is its FRAME's path plus its key — never
 *  the anchor it hangs under, nor a keyed parent. So a template change that drops or moves its anchor row leaves the guid
 *  where it was, and every ref to it keeps resolving. A v17 scene (the old rule) is renamed once on load (scene v18), and
 *  a prefab's member token in the old spelling still reads (prefab v9).
 *
 *  Driven through the real loader. Each case names the mutation that turns it red. */

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
import { setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { deriveMemberGuid, isRuntimeGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { templateKeyOf } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { reloadDerivedGuids } from '../../packages/modoki/src/runtime/core/ecs/memberHome';
import { memberPathRecords, deriveMemberChain } from '../../packages/modoki/src/runtime/loaders/memberPaths';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { buildPrefabEditScene } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { remintSceneEntityGuids } from '../../plugins/asset-fs-ops';
import { getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyToPrefabSelective } from '../../packages/modoki/src/editor/scene/prefabApply';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000018091';
const Q = 'cccccccc-0000-4000-8000-000000018092';
const O = 'cccccccc-0000-4000-8000-000000018093';
const ROOT = 'dddddddd-0000-4000-8000-000000018091';
const ROOT2 = 'dddddddd-0000-4000-8000-000000018092';
const OUTSIDE = 'dddddddd-0000-4000-8000-000000018099';
const KX = 'aaaaaaaa-0000-4000-8000-0000000180a1';
const KK = 'aaaaaaaa-0000-4000-8000-0000000180a2';
const KR = 'aaaaaaaa-0000-4000-8000-0000000180a3';
const gN = 'eeeeeeee-0000-4000-8000-0000000180e2';
const gA = 'eeeeeeee-0000-4000-8000-0000000180e3';
const gB = 'eeeeeeee-0000-4000-8000-0000000180e4';

const row = (localId: number, name: string, parentId: number, nodeGuid: string, extra: Record<string, unknown> = {}) => ({
  localId, name, nodeGuid, ...extra, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** P: R → A → B. `bParent` re-parents B in the template; `drop` removes rows A and B. */
const pDoc = (opts: { drop?: boolean; bParent?: number } = {}) => ({ id: P, version: 9, name: 'P', rootLocalId: 1, nextLocalId: 4, entities: [
  row(1, 'R', 0, 'eeeeeeee-0000-4000-8000-0000000180e1'),
  ...(opts.drop ? [] : [row(2, 'A', 1, gA), row(3, 'B', opts.bParent ?? 2, gB)]),
] });
/** Q: QR → QM — what the keyed reference node expands. */
const qDoc = () => ({ id: Q, version: 9, name: 'Q', rootLocalId: 1, nextLocalId: 3, entities: [
  row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-0000000180f1'), row(2, 'QM', 1, 'eeeeeeee-0000-4000-8000-0000000180f2'),
] });
/** O: OR → N (a P row) and Panel. N's layer adds, anchored at P's B (localId 3): Extra (with a keyed child Kid) and a
 *  keyed REFERENCE node Ref expanding Q. `panelRef`: Panel's UIFocusable.navUp, a member token. */
const oDoc = (panelRef?: string, moved?: Record<string, string>) => ({ id: O, version: 9, name: 'O', rootLocalId: 1, nextLocalId: 4, ...(moved ? { moved } : {}), entities: [
  row(1, 'OR', 0, 'eeeeeeee-0000-4000-8000-0000000180d1'),
  row(2, 'N', 1, gN, {
    prefab: P,
    added: [
      { parentLocalId: 3, guid: '', key: KX, name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 6 } },
        children: [{ parentLocalId: 0, guid: '', key: KK, name: 'Kid', traits: { EntityAttributes: { name: 'Kid', parentId: 0 } }, children: [] }] },
      { parentLocalId: 3, guid: '', key: KR, name: 'Ref', prefab: Q, traits: { EntityAttributes: { name: 'Ref', parentId: 0 } }, children: [] },
    ],
  }),
  { ...row(3, 'Panel', 1, 'eeeeeeee-0000-4000-8000-0000000180d3'), ...(panelRef ? { traits: { EntityAttributes: { name: 'Panel', parentId: 1, guid: '' }, UIFocusable: { navUp: panelRef } } } : {}) },
] });
const install = (...docs: Array<{ id?: string }>) => { for (const d of docs) { prefabs.set(d.id!, d); setPrefabCache(d.id!, d as never); } };

/** One instance of O on ROOT (a second on ROOT2 when `two`), and — when `refs` is given — an Outside entity whose
 *  UIFocusable names those guids. */
const scene = (version: number, refs?: { navUp?: string; navDown?: string; navLeft?: string; navRight?: string }, two = false): SceneData => ({
  id: 'keyed-frame', version, name: 'S', resources: [],
  entities: [
    { id: 1, prefab: O, guid: ROOT, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } } },
    ...(two ? [{ id: 2, prefab: O, guid: ROOT2, traits: { EntityAttributes: { name: 'Inst2', parentId: 0 } } }] : []),
    ...(refs ? [{ id: 3, traits: { EntityAttributes: { name: 'Outside', parentId: 0, guid: OUTSIDE }, UIFocusable: refs } }] : []),
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

const named = (name: string, root = ROOT) => {
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const top = all.find((e) => e.guid === root)!.id;
  const hits = all.filter((e) => {
    if (e.name !== name) return false;
    for (let cur: typeof e | undefined = e; cur; cur = byId.get(cur.parentId)) if (cur.id === top) return true;
    return false;
  });
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} entities named ${name} under ${root}`);
  return hits[0]!;
};
/** The reference node's root is Q's root row, spawned under the node's key. */
const guids = (root = ROOT) => ({ extra: named('Extra', root).guid!, kid: named('Kid', root).guid!, ref: named('QR', root).guid!, qm: named('QM', root).guid! });
const rootId = (guid = ROOT) => getAllEntities().find((e) => e.guid === guid)!.id;
const nav = () => readTraitData(getAllEntities().find((e) => e.guid === OUTSIDE)!.id, getTraitByName('UIFocusable')!) as Record<string, string>;
const handleOf = (id: number) => [...getCurrentWorld().entities].find((e) => e.id() === id)!;

/** N steps by its row localId (2); a keyed node then by its key alone. */
const RULE = {
  extra: deriveMemberGuid(ROOT, [2, `+${KX}`]),
  kid: deriveMemberGuid(ROOT, [2, `+${KK}`]),
  ref: deriveMemberGuid(ROOT, [2, `+${KR}`]),
};
/** The guids the rule before #1809 gave: through B's chain (A 2, B 3), and Kid through Extra. */
const OLD = {
  extra: deriveMemberGuid(ROOT, [2, 2, 3, `+${KX}`]),
  kid: deriveMemberGuid(ROOT, [2, 2, 3, `+${KX}`, `+${KK}`]),
  ref: deriveMemberGuid(ROOT, [2, 2, 3, `+${KR}`]),
};

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  writes.length = 0;
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ files: [] }), text: async () => '' }));
});
afterAll(() => { for (const id of [P, Q, O]) setPrefabCache(id, null); getCurrentWorld()?.destroy(); });

describe('a template-keyed node derives from its frame root (#1809)', () => {
  // Mutation: `keyedFrameRoot` answering 0 (the old rule) — every expectation below reads the OLD column instead.
  it('Extra, its keyed child and a keyed reference root derive their frame path plus their key; the reference root\'s member follows it', async () => {
    install(pDoc(), qDoc(), oDoc());
    await load(scene(SCENE_FORMAT_VERSION));
    const g = guids();
    expect(g.extra).toBe(RULE.extra);
    expect(g.kid).toBe(RULE.kid); // flat: not through Extra's key
    expect(g.ref).toBe(RULE.ref);
    expect(g.qm).toBe(deriveMemberGuid(RULE.ref, [2]));
    expect(templateKeyOf(handleOf(named('Kid').id))).toBe(KK);
  });

  // The #1809 symptom at the loader: the template drops A and B (an Apply of a delete does exactly this), the nodes
  // re-anchor to N's root, and not one guid moves. Mutation: the old rule — every one changes.
  it('dropping the anchor row AND its parent row changes no guid: the nodes re-anchor to the frame root and keep it', async () => {
    install(pDoc(), qDoc(), oDoc());
    await load(scene(SCENE_FORMAT_VERSION));
    const before = guids();
    install(pDoc({ drop: true }));
    await load(scene(SCENE_FORMAT_VERSION));
    expect(named('Extra').parentId).toBe(named('R').id); // premise: re-anchored
    expect(guids()).toEqual(before);
  });

  it('moving the anchor row in the template (B under R) changes no guid', async () => {
    install(pDoc(), qDoc(), oDoc());
    await load(scene(SCENE_FORMAT_VERSION));
    const before = guids();
    install(pDoc({ bParent: 1 }));
    await load(scene(SCENE_FORMAT_VERSION));
    expect(named('B').parentId).toBe(named('R').id); // premise: B moved
    expect(guids()).toEqual(before);
  });

  // I7 across two instances of one prefab: every keyed node is distinct, instance by instance.
  it('two instances give every keyed node and member its own guid', async () => {
    install(pDoc(), qDoc(), oDoc());
    await load(scene(SCENE_FORMAT_VERSION, undefined, true));
    const all = [...Object.values(guids(ROOT)), ...Object.values(guids(ROOT2))];
    expect(new Set(all).size).toBe(all.length);
    const durable = getAllEntities().map((e) => e.guid).filter((x): x is string => !!x && !isRuntimeGuid(x));
    expect(new Set(durable).size).toBe(durable.length);
  });

  // Every walk that predicts a keyed guid agrees with the loader (I7's "derives it the same way"): the reload walk
  // (`memberPathIndex` → `reloadDerivedGuids`) and the scene-file walk (`memberPathRecords`, a duplicate's remint).
  // Mutation: memberPaths' `flat` false (it hangs the node at its anchor's base) — the file walk names the old path.
  it('the reload walk and the file walk predict the loader\'s guids', async () => {
    install(pDoc(), qDoc(), oDoc());
    await load(scene(SCENE_FORMAT_VERSION));
    const live = guids();
    const reload = reloadDerivedGuids(getCurrentWorld(), rootId(), ROOT);
    const byName = new Map([...reload].map(([e, g]) => [(e.get(getTraitByName('EntityAttributes')!.trait) as { name: string }).name, g]));
    expect([byName.get('Extra'), byName.get('Kid'), byName.get('QR')]).toEqual([live.extra, live.kid, live.ref]);
    const file = [...memberPathRecords({ prefab: O }, (g) => (prefabs.get(g) as never) ?? null).self.keys()].map((k) => deriveMemberChain(ROOT, k));
    expect(file).toEqual(expect.arrayContaining([live.extra, live.kid, live.ref, live.qm]));
  });
});

describe('a v17 scene is renamed once on load (scene v18)', () => {
  const OLD_REFS = () => ({ navUp: OLD.extra, navDown: OLD.kid, navLeft: OLD.ref, navRight: deriveMemberGuid(OLD.ref, [2]) });

  // Keyed nodes shipped in v0.7.2 and v0.7.3, so a v17 file's refs name old-rule guids. Mutation: skip
  // `applyGuidRemap(keyedGuidUpgrade(world))` in `deriveMemberGuidsAfterPins` — every ref stays on the old guid.
  it('every ref a v17 file holds to a keyed node, a keyed child, a keyed reference root and its member lands on the new guid', async () => {
    install(pDoc(), qDoc(), oDoc());
    await load(scene(17, OLD_REFS()));
    const g = guids();
    expect(nav()).toEqual({ ...nav(), navUp: g.extra, navDown: g.kid, navLeft: g.ref, navRight: g.qm });
    expect(g.extra).toBe(RULE.extra); // and the nodes themselves derive by today's rule
  });

  // The legacy rule runs ONLY below 18. A v18 file's ref that names an old-rule guid names nothing (a ref already
  // broken stays broken, the owner's accepted cost), and the load leaves it as written. Mutation: run the upgrade for a
  // v18 file too (`fromSceneVersion` below 99) — the ref is rewritten.
  it('a v18 file is not renamed', async () => {
    install(pDoc(), qDoc(), oDoc());
    await load(scene(SCENE_FORMAT_VERSION, OLD_REFS()));
    expect(nav().navUp).toBe(OLD.extra);
    expect(nav().navDown).toBe(OLD.kid);
  });
});

describe('a prefab member token in the spelling before #1809 still reads (prefab v9)', () => {
  // v8 wrote a keyed node's token through its anchor (N 2, A 2, B 3). Mutation: `memberPathLookup` without its
  // prefix fallback — the token is left unresolved.
  it('an old-form token through the anchor steps resolves to the node, and so does the flat one', async () => {
    install(pDoc(), qDoc(), oDoc(`@member:2.2.3.+${KX}`));
    await load(scene(SCENE_FORMAT_VERSION));
    const panel = named('Panel');
    expect((readTraitData(panel.id, getTraitByName('UIFocusable')!) as { navUp: string }).navUp).toBe(guids().extra);
    install(oDoc(`@member:2.+${KX}`));
    await load(scene(SCENE_FORMAT_VERSION));
    expect((readTraitData(named('Panel').id, getTraitByName('UIFocusable')!) as { navUp: string }).navUp).toBe(guids().extra);
  });

  // The prefab-edit world maps a root-relative token to an edit-world guid BEFORE anything spawns (`editGuidAt`), so it
  // cannot ask the lookup: it respells the path through the documents (`flatKeyedSteps`). Derived as written, the old
  // spelling named no entity, and the edit's save wrote that dangling guid back over the token. Mutation: pass
  // `path.slice(i + 1)` to `deriveMemberGuid` as it is — Panel names nothing.
  it('in the prefab-edit world an old-form token maps to the guid the edit world derives for the node', async () => {
    install(pDoc(), qDoc(), oDoc(`@member:2.2.3.+${KX}`));
    await load(buildPrefabEditScene(prefabs.get(O) as PrefabFile) as SceneData);
    const all = getAllEntities();
    const panel = all.find((e) => e.name === 'Panel')!;
    const extra = all.find((e) => e.name === 'Extra')!;
    expect(extra.guid).toBeTruthy();
    expect((readTraitData(panel.id, getTraitByName('UIFocusable')!) as { navUp: string }).navUp).toBe(extra.guid);
  });

  // #1883 ruling C (owner 2026-10-01, #1914 R4): a legacy move of a KEYED node is an unused record, ignored at load in
  // either spelling — the node stays at its template place — and kept by the writers (keyedLegacyMove.test.ts). This
  // case pinned the opposite until R4: the drain then moved the keyed reference root, and every identity reader met it
  // out of its frame (#1883's N2). Mutation: `appliedMoves(moved)` → `moved` in `queuePrefabMoves` — Ref goes under Panel.
  it('a legacy `moved` of the keyed reference root is ignored, in the old spelling and the flat one', async () => {
    install(pDoc(), qDoc(), oDoc(undefined, { [`2.2.3.+${KR}`]: '@member:3' }));
    await load(scene(SCENE_FORMAT_VERSION));
    expect(named('QR').parentId).not.toBe(named('Panel').id);
    expect(named('QR').parentId).toBe(named('B').id);
    install(oDoc(undefined, { [`2.+${KR}`]: '@member:3' }));
    await load(scene(SCENE_FORMAT_VERSION));
    expect(named('QR').parentId).toBe(named('B').id);
  });

  // Apply's filter of the prefab's own `moved` drops an entry whose key or target names nothing, and deletes it from the
  // file. A key in the spelling before #1809 names its node through the lookup (close-out re-review: only the drain was
  // pinned). Since #1883 R4 a keyed move key is also kept outright (`isKeyedMoveKey`), so the property is held twice.
  // Mutation: drop that early return AND use `paths.has(k)` for the key — an Apply of anything deletes the move from O;
  // either alone stays green. The edit goes through the door, so the Apply's records name it (#2001 S8b).
  it('an Apply keeps a `moved` entry whose key is in the spelling before #1809', async () => {
    const moved = { [`2.2.3.+${KR}`]: '@member:3' };
    install(pDoc(), qDoc(), oDoc(undefined, moved));
    await load(scene(SCENE_FORMAT_VERSION));
    const panel = named('Panel');
    writeTraitFieldWithUndo(panel.id, getTraitByName('Transform')!, 'x', 5);
    const keys = collectInstanceOverrideKeys(rootId(), getCachedPrefabSync(O) as PrefabFile).fields.filter((k) => k.endsWith('Transform.x'));
    expect(keys).toHaveLength(1); // premise
    await applyToPrefabSelective(rootId(), new Set(keys));
    const written = writes.map((w) => JSON.parse(w.content) as { id?: string; moved?: Record<string, string> }).filter((d) => d.id === O).pop()!;
    expect(written).toBeDefined(); // premise: the Apply wrote O
    expect(written.moved).toEqual(moved);
  });
});

describe('the key heal and the file walks under the frame-root rule', () => {
  // A scene save writes keyed nodes in scene form (their guids, no keys), so a reload spawns Extra AND Kid unmarked.
  // Kid's recovery used to stop at its unmarked parent (close-out review) and try Extra's path. Mutation: restore
  // `if (!p.key) return 0` in `keyedFrameRoot` — Kid stays unkeyed and the token naming it stays literal.
  it('a keyed child whose keyed parent also lost its marker heals, and a token naming it resolves', async () => {
    install(pDoc(), qDoc(), oDoc(`@member:2.+${KK}`));
    const sceneForm = scene(SCENE_FORMAT_VERSION);
    (sceneForm.entities[0] as unknown as Record<string, unknown>).nestedStructure = { '2': { added: [
      { parentLocalId: 3, guid: RULE.extra, name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0, guid: RULE.extra }, Transform: { x: 6 } },
        children: [{ guid: RULE.kid, name: 'Kid', traits: { EntityAttributes: { name: 'Kid', parentId: 0, guid: RULE.kid } }, children: [] }] },
      { parentLocalId: 3, guid: RULE.ref, name: 'Ref', prefab: Q, traits: { EntityAttributes: { name: 'Ref', parentId: 0, guid: RULE.ref } }, children: [] },
    ] } };
    await load(sceneForm);
    expect(named('Kid').guid).toBe(RULE.kid); // premise: the scene form pinned it
    expect(templateKeyOf(handleOf(named('Kid').id))).toBe(KK);
    expect((readTraitData(named('Panel').id, getTraitByName('UIFocusable')!) as { navUp: string }).navUp).toBe(RULE.kid);
  });

  // A duplicate of a v17 scene FILE (`remintSceneEntityGuids`, no load) stays v17, so its carries must map old-rule guids
  // to old-rule guids; its own first load then upgrades them. Mutation: drop `legacy` from `sceneMemberAnchors` — every
  // ref in the copy names the ORIGINAL's old guid, which nothing holds.
  it('a duplicate of a v17 scene file keeps every ref to a keyed node, a keyed child, a reference root and its member', async () => {
    install(pDoc(), qDoc(), oDoc());
    const NEW_ROOT = 'dddddddd-0000-4000-8000-0000000180ff';
    const original = scene(17, { navUp: OLD.extra, navDown: OLD.kid, navLeft: OLD.ref, navRight: deriveMemberGuid(OLD.ref, [2]) });
    const copy = remintSceneEntityGuids(JSON.parse(JSON.stringify(original)), (() => { const q = [NEW_ROOT, 'dddddddd-0000-4000-8000-0000000180fe']; return () => q.shift()!; })(), (g) => prefabs.get(g) as never) as unknown as SceneData;
    await load(copy);
    const g = guids(NEW_ROOT);
    const n = readTraitData(getAllEntities().find((e) => e.name === 'Outside')!.id, getTraitByName('UIFocusable')!) as Record<string, string>;
    expect([n.navUp, n.navDown, n.navLeft, n.navRight]).toEqual([g.extra, g.kid, g.ref, g.qm]);
  });

  // A node anchored AT a nested row hangs at that row's root, so the live rule gives it that nested frame; the file walk
  // (a duplicate's remint) must give it the same (close-out review). Mutation: the file walk's `rows.get(at)?.prefab`
  // test — it names the declaring frame's path and the two disagree.
  it('a node anchored at a nested row: the file walk predicts the loader', async () => {
    const P3 = 'cccccccc-0000-4000-8000-000000018094';
    const O3 = 'cccccccc-0000-4000-8000-000000018095';
    const KZ = 'aaaaaaaa-0000-4000-8000-0000000180a4';
    const p3 = { id: P3, version: 9, name: 'P3', rootLocalId: 1, nextLocalId: 3, entities: [
      row(1, 'R3', 0, 'eeeeeeee-0000-4000-8000-0000000180c1'), row(2, 'QN', 1, 'eeeeeeee-0000-4000-8000-0000000180c2', { prefab: Q }),
    ] };
    const o3 = { id: O3, version: 9, name: 'O3', rootLocalId: 1, nextLocalId: 3, entities: [
      row(1, 'OR3', 0, 'eeeeeeee-0000-4000-8000-0000000180b1'),
      row(2, 'N3', 1, 'eeeeeeee-0000-4000-8000-0000000180b2', { prefab: P3, added: [
        { parentLocalId: 2, guid: '', key: KZ, name: 'Z', traits: { EntityAttributes: { name: 'Z', parentId: 0 } }, children: [] },
      ] }),
    ] };
    install(qDoc(), p3, o3);
    await load({ id: 's3', version: SCENE_FORMAT_VERSION, name: 'S', resources: [],
      entities: [{ id: 1, prefab: O3, guid: ROOT, traits: { EntityAttributes: { name: 'I3', parentId: 0 } } }] } as unknown as SceneData);
    const z = named('Z').guid!;
    const file = [...memberPathRecords({ prefab: O3 }, (g) => (prefabs.get(g) as never) ?? null).self.keys()].map((k) => deriveMemberChain(ROOT, k));
    expect(file).toContain(z);
  });
});
