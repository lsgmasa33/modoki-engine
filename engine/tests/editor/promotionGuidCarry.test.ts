/** Apply's promotion of an added node CARRIES the node's guid onto the member it becomes (#1660).
 *
 *  Promoting `+added.<guid>` writes the node into the template as a new row, deletes the live node and lets the
 *  refresh re-expand it. The re-expanded member derives a fresh guid from the instance's anchor, so before this
 *  fix every ref naming the added node — a UI nav link, a UIAction target, a joint — named nothing after the
 *  Apply, and `applyToPrefabWithUndo` then saved the scene with the dangling ref in it. The member now takes
 *  the old guid back, and the save states it on the member's v16 row, so the ref survives the reload as well —
 *  and so does a ref in ANOTHER file, which no remap of the live world could have reached.
 *
 *  Driven through the real loader, the real Apply and the real save. Each case names the mutation that turns it
 *  red. */

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
    // The file a later load reads — Apply's write, and an undo's reinstall of the document before it.
    const doc = JSON.parse(content) as { id?: string };
    if (doc.id && prefabs.has(doc.id)) prefabs.set(doc.id, doc);
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  },
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { setActionCallback, pushAction, clearHistory, createEntityWithUndo, ensureGuid } from '@modoki/engine/editor';
import { isRuntimeGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import {
  setPrefabCache, applyToPrefabSelective, getCachedPrefabSync, instantiatePrefab, setPrefabSource, carryPromotedGuidsForTest,
  type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { undo, redo } from '../../packages/modoki/src/editor/undo/undoManager';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000016601';
const Q = 'cccccccc-0000-4000-8000-000000016602';
const HOLDER = 'dddddddd-0000-4000-8000-000000016600';
const ROOT1 = 'dddddddd-0000-4000-8000-000000016601';
const ROOT2 = 'dddddddd-0000-4000-8000-000000016602';

const row = (localId: number, name: string, parentId: number, nodeGuid: string) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** P: R → A. */
const pDoc = () => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
  row(1, 'R', 0, 'eeeeeeee-0000-4000-8000-000000016611'), row(2, 'A', 1, 'eeeeeeee-0000-4000-8000-000000016612'),
] });
/** Q: QR → QA → QB — the prefab a user-added nested instance expands. */
const qDoc = () => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [
  row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000016621'), row(2, 'QA', 1, 'eeeeeeee-0000-4000-8000-000000016622'),
  row(3, 'QB', 2, 'eeeeeeee-0000-4000-8000-000000016623'),
] });
const install = (...docs: Array<{ id?: string }>) => { for (const d of docs) { prefabs.set(d.id!, d); setPrefabCache(d.id!, d as never); } };

/** Holder → two instances of P. */
const scene = (): SceneData => ({
  id: 'promotion-carry', version: 16, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
    ...[ROOT1, ROOT2].map((guid, i) => ({ id: 2 + i, prefab: P, guid, traits: { EntityAttributes: { name: `Inst${i + 1}`, parentId: HOLDER } } })),
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

const meta = (t: string) => getTraitByName(t)!;
const idOf = (guid: string) => getAllEntities().find((e) => e.guid === guid)?.id ?? 0;
const guidOf = (id: number) => getAllEntities().find((e) => e.id === id)?.guid ?? '';
/** The entity named `name` below the entity `guid` names (inclusive). */
const under = (guid: string, name: string): number => {
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const top = idOf(guid);
  const hits = all.filter((e) => {
    if (e.name !== name) return false;
    for (let cur: typeof e | undefined = e; cur; cur = byId.get(cur.parentId)) if (cur.id === top) return true;
    return false;
  });
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} entities named ${name} under ${guid}`);
  return hits[0]!.id;
};
const nav = (id: number) => readTraitData(id, meta('UIFocusable')) as { navUp?: string; navDown?: string; navLeft?: string };
/** The prefab file the Apply wrote, installed as the one every later load reads. */
const takeWritten = () => {
  const w = [...writes].reverse().find((x) => x.path.includes(P) || (JSON.parse(x.content) as { id?: string }).id === P);
  if (!w) throw new Error('fixture: the Apply wrote no prefab file');
  const doc = JSON.parse(w.content) as PrefabFile;
  prefabs.set(P, doc);
  return doc;
};
/** Every durable guid the world holds more than once. */
const duplicateGuids = () => {
  const seen = new Map<string, number>();
  for (const e of getAllEntities()) if (e.guid && !isRuntimeGuid(e.guid)) seen.set(e.guid, (seen.get(e.guid) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([g]) => g);
};
const add = (label: string, parent: number, traits: Array<{ name: string; data: Record<string, unknown> }>) =>
  createEntityWithUndo(label, parent, traits.some((t) => t.name === 'Transform') ? traits : [{ name: 'Transform', data: {} }, ...traits], () => {})!;

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  writes.length = 0;
  prefabs.clear();
  clearKeptMemberOrphans();
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ files: [] }), text: async () => '' }));
});
afterAll(() => { for (const id of [P, Q]) setPrefabCache(id, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

describe('promoting an added node keeps its guid (#1660)', () => {
  it('a plain added node and its child keep their guids, and a ref from outside the instance still resolves — after the Apply and after the reload', async () => {
    install(pDoc());
    await load(scene());
    const r1 = idOf(ROOT1);
    const extra = add('Add Extra', r1, [{ name: 'EntityAttributes', data: { name: 'Extra', parentId: r1 } }]);
    const kid = add('Add Kid', extra, [{ name: 'EntityAttributes', data: { name: 'Kid', parentId: extra } }]);
    const extraGuid = guidOf(extra);
    const kidGuid = guidOf(kid);
    const holder = idOf(HOLDER);
    add('Add Outside', holder, [
      { name: 'EntityAttributes', data: { name: 'Outside', parentId: holder } },
      { name: 'UIFocusable', data: { navUp: extraGuid, navDown: kidGuid } },
    ]);
    expect(extraGuid && kidGuid).toBeTruthy();

    const keys = collectInstanceOverrideKeys(r1, getCachedPrefabSync(P) as PrefabFile);
    const res = await applyToPrefabSelective(r1, new Set(keys.added));
    expect(res.applied).toBe(true);
    expect(res.promotedAdditions).toBe(1);
    const written = takeWritten();
    expect(written.entities.map((e) => e.name)).toEqual(expect.arrayContaining(['Extra', 'Kid'])); // precondition: promoted

    // Live, straight after the Apply: the promoted member IS the entity the ref names.
    // Mutation: drop the carry in `applyToPrefabSelective` — Extra/Kid re-derive, and both lookups miss.
    expect(under(ROOT1, 'Extra')).toBe(idOf(extraGuid));
    expect(under(ROOT1, 'Kid')).toBe(idOf(kidGuid));
    const outside = under(HOLDER, 'Outside');
    expect(nav(outside)).toMatchObject({ navUp: extraGuid, navDown: kidGuid });
    // The OTHER instance gains its own Extra, under its own identity — the carry is this instance's only.
    expect(guidOf(under(ROOT2, 'Extra'))).not.toBe(extraGuid);

    // Durable: the save states the carried guid on the member's row, so the reload pins it. (The pre-v5 case below is
    // the counter-case: with no row to state it, the reload re-derives, so that member is not carried at all.)
    await load(await serializeScene() as unknown as SceneData);
    expect(under(ROOT1, 'Extra')).toBe(idOf(extraGuid));
    expect(under(ROOT1, 'Kid')).toBe(idOf(kidGuid));
    expect(nav(under(HOLDER, 'Outside'))).toMatchObject({ navUp: extraGuid, navDown: kidGuid });
    expect(guidOf(under(ROOT2, 'Extra'))).not.toBe(extraGuid);
  });

  it('a user-added nested instance keeps its root guid and its members\' guids', async () => {
    install(pDoc(), qDoc());
    await load(scene());
    // Dropped, given its durable guid as the editor's drop gives it, and saved: from the reload on, its members
    // derive their durable guids from that root — the state a ref to one of them is authored against.
    const qRoot = instantiatePrefab(getCachedPrefabSync(Q) as PrefabFile, idOf(ROOT1));
    expect(qRoot).toBeTruthy();
    setPrefabSource(qRoot, Q);
    const qRootGuid = ensureGuid(qRoot);
    await load(await serializeScene() as unknown as SceneData);
    const r1 = idOf(ROOT1);
    const qbGuid = guidOf(under(qRootGuid, 'QB'));
    expect(isRuntimeGuid(qbGuid)).toBe(false); // precondition: a guid a ref can hold across a reload
    const holder = idOf(HOLDER);
    add('Add Outside', holder, [
      { name: 'EntityAttributes', data: { name: 'Outside', parentId: holder } },
      { name: 'UIFocusable', data: { navUp: qRootGuid, navDown: qbGuid } },
    ]);
    expect(qRootGuid && qbGuid).toBeTruthy();

    const keys = collectInstanceOverrideKeys(r1, getCachedPrefabSync(P) as PrefabFile);
    const res = await applyToPrefabSelective(r1, new Set(keys.added));
    expect(res.promotedAdditions).toBeGreaterThan(0);
    const written = takeWritten();
    expect(written.entities.some((e) => e.prefab === Q)).toBe(true); // precondition: promoted to a nested row

    // Mutation: drop the carry for a reference node — QR and QB derive from the outer anchor now.
    expect(under(ROOT1, 'QR')).toBe(idOf(qRootGuid));
    expect(under(ROOT1, 'QB')).toBe(idOf(qbGuid));
    expect(nav(under(HOLDER, 'Outside'))).toMatchObject({ navUp: qRootGuid, navDown: qbGuid });

    await load(await serializeScene() as unknown as SceneData);
    expect(under(ROOT1, 'QR')).toBe(idOf(qRootGuid));
    expect(under(ROOT1, 'QB')).toBe(idOf(qbGuid));
    expect(guidOf(under(ROOT2, 'QB'))).not.toBe(qbGuid);
  });

  it('a member no row can pin (a pre-v5 nested document) keeps its derived guid, and the refs follow it', async () => {
    // Q written before v5: its rows mint no `nodeGuid`, so a member of the promoted nested row has no row key and
    // the reload DERIVES its guid whatever the live world holds. Renaming it back would dangle on the reload; the
    // refs move to the derived guid instead. The nested root itself is keyed by P's row, so it still carries.
    const q4 = qDoc() as { version: number; entities: Array<{ nodeGuid?: string }> };
    q4.version = 4;
    for (const e of q4.entities) delete e.nodeGuid;
    install(pDoc(), q4 as never);
    await load(scene());
    const qRoot = instantiatePrefab(getCachedPrefabSync(Q) as PrefabFile, idOf(ROOT1));
    setPrefabSource(qRoot, Q);
    const qRootGuid = ensureGuid(qRoot);
    await load(await serializeScene() as unknown as SceneData);
    const r1 = idOf(ROOT1);
    const qbGuid = guidOf(under(qRootGuid, 'QB'));
    const holder = idOf(HOLDER);
    add('Add Outside', holder, [
      { name: 'EntityAttributes', data: { name: 'Outside', parentId: holder } },
      { name: 'UIFocusable', data: { navUp: qRootGuid, navDown: qbGuid } },
    ]);

    const keys = collectInstanceOverrideKeys(r1, getCachedPrefabSync(P) as PrefabFile);
    expect((await applyToPrefabSelective(r1, new Set(keys.added))).promotedAdditions).toBeGreaterThan(0);
    takeWritten();

    // Mutation: drop `remapWorldGuidRefs(follow)` — navDown keeps naming the deleted QB.
    const qb = under(ROOT1, 'QB');
    expect(guidOf(qb)).not.toBe(qbGuid); // precondition: QB could not be carried
    expect(nav(under(HOLDER, 'Outside'))).toMatchObject({ navUp: qRootGuid, navDown: guidOf(qb) });

    // Mutation: carry every pair regardless of `rowed` — QB is renamed back live, the reload re-derives it, and
    // navDown names nothing.
    await load(await serializeScene() as unknown as SceneData);
    const after = nav(under(HOLDER, 'Outside'));
    expect(after.navUp).toBe(qRootGuid);
    expect(idOf(after.navUp!)).toBe(under(ROOT1, 'QR'));
    expect(idOf(after.navDown!)).toBe(under(ROOT1, 'QB'));
  });

  it('undo and redo of the Apply keep the carried guid — before, after, and after again, with no guid twice', async () => {
    // Mutation: drop `carryPromotedGuids` — the Apply and the redo (its AFTER snapshot) both hold a derived Extra.
    install(pDoc());
    await load(scene());
    const r1 = idOf(ROOT1);
    const extra = add('Add Extra', r1, [{ name: 'EntityAttributes', data: { name: 'Extra', parentId: r1 } }]);
    const extraGuid = guidOf(extra);
    const holder = idOf(HOLDER);
    add('Add Outside', holder, [
      { name: 'EntityAttributes', data: { name: 'Outside', parentId: holder } },
      { name: 'UIFocusable', data: { navUp: extraGuid } },
    ]);
    const resolves = (promoted: boolean) => {
      const ex = under(ROOT1, 'Extra');
      expect(guidOf(ex)).toBe(extraGuid);
      expect(idOf(nav(under(HOLDER, 'Outside')).navUp!)).toBe(ex);
      expect(!!readTraitData(ex, meta('PrefabInstance'))).toBe(promoted); // a member after the Apply, added before it
      expect(duplicateGuids()).toEqual([]);
    };

    const keys = collectInstanceOverrideKeys(r1, getCachedPrefabSync(P) as PrefabFile);
    expect((await applyToPrefabWithUndo(r1, new Set(keys.added))).promotedAdditions).toBe(1);
    resolves(true);
    await undo();
    resolves(false);
    await redo();
    resolves(true);
  });

  it('two added siblings alike in name and traits each keep their OWN guid', async () => {
    // Paired by the row each was written to, never by what it looks like. Mutation: shift the snapshot's row key
    // (`out.plain.set(lid + 1, guid)`) — the first twin's guid lands on the second.
    install(pDoc());
    await load(scene());
    const r1 = idOf(ROOT1);
    const twin = (x: number) => add('Add Twin', r1, [
      { name: 'EntityAttributes', data: { name: 'Twin', parentId: r1 } }, { name: 'Transform', data: { x } },
    ]);
    const g1 = guidOf(twin(1));
    const g2 = guidOf(twin(2));
    const holder = idOf(HOLDER);
    add('Add Outside', holder, [
      { name: 'EntityAttributes', data: { name: 'Outside', parentId: holder } },
      { name: 'UIFocusable', data: { navUp: g1, navDown: g2 } },
    ]);
    const keys = collectInstanceOverrideKeys(r1, getCachedPrefabSync(P) as PrefabFile);
    expect((await applyToPrefabSelective(r1, new Set(keys.added))).promotedAdditions).toBe(2);
    takeWritten();
    const xOf = (g: string) => (readTraitData(idOf(g), meta('Transform')) as { x: number }).x;
    const check = () => {
      expect([xOf(g1), xOf(g2)]).toEqual([1, 2]);
      const { navUp, navDown } = nav(under(HOLDER, 'Outside'));
      expect([xOf(navUp!), xOf(navDown!)]).toEqual([1, 2]);
      expect(duplicateGuids()).toEqual([]);
    };
    check();
    await load(await serializeScene() as unknown as SceneData);
    check();
  });

  it('a pairing that is not unique carries nothing, and nothing takes a guid a live entity holds', async () => {
    // Not reachable through Apply (each row is written once), so the step is driven directly.
    install(pDoc());
    await load(scene());
    const r1 = idOf(ROOT1);
    const a = under(ROOT1, 'A');
    const aGuid = guidOf(a);
    const lidA = (readTraitData(a, meta('PrefabInstance')) as { localId: number }).localId;
    const OLD = 'ffffffff-0000-4000-8000-000000016600';

    // Mutation: drop the `claims.get(old) > 1` skip — A and its twin both become OLD. (Its twin clause, an entity two
    // originals answer to, has no fixture: `promotionPathIndex` names neither of two entities sharing a key, and the
    // plain and nested branches pair disjoint entities — it is a floor, not a tested path.)
    const twin = add('Add Twin', r1, [
      { name: 'EntityAttributes', data: { name: 'A', parentId: r1 } },
      { name: 'PrefabInstance', data: { ...(readTraitData(a, meta('PrefabInstance')) as object) } },
    ]);
    const twinGuid = guidOf(twin);
    carryPromotedGuidsForTest(ROOT1, { plain: new Map([[lidA, OLD]]), refs: new Map() });
    expect([guidOf(a), guidOf(twin)]).toEqual([aGuid, twinGuid]);
    expect(idOf(OLD)).toBe(0);
    destroyEntity([...getCurrentWorld().entities].find((e) => e.id() === twin)!, getCurrentWorld());

    // Mutation: drop the `localToEcsGuid(old)` skip — A takes the Holder's guid, and two entities hold it.
    carryPromotedGuidsForTest(ROOT1, { plain: new Map([[lidA, HOLDER]]), refs: new Map() });
    expect(guidOf(a)).toBe(aGuid);
    expect(duplicateGuids()).toEqual([]);
  });

  it('a node the author added INSIDE the promoted nested instance becomes template-keyed: its guid re-derives and the refs follow it', async () => {
    // The QA-PREFAB-0019 shape. The promotion writes the node into the row's `added` with a key — stamped on the live
    // node by that write, which is what lets the snapshot index it by the same step the refresh brings it back at.
    // A keyed node is never pinned (#1426), so it cannot be carried: the live refs follow its derived guid instead.
    install(pDoc(), qDoc());
    await load(scene());
    const qRoot = instantiatePrefab(getCachedPrefabSync(Q) as PrefabFile, idOf(ROOT1));
    setPrefabSource(qRoot, Q);
    const qRootGuid = ensureGuid(qRoot);
    await load(await serializeScene() as unknown as SceneData);
    const inner = add('Add Inner', idOf(qRootGuid), [{ name: 'EntityAttributes', data: { name: 'Inner', parentId: idOf(qRootGuid) } }]);
    const innerGuid = guidOf(inner);
    const holder = idOf(HOLDER);
    add('Add Outside', holder, [
      { name: 'EntityAttributes', data: { name: 'Outside', parentId: holder } },
      { name: 'UIFocusable', data: { navUp: innerGuid } },
    ]);
    const r1 = idOf(ROOT1);
    const keys = collectInstanceOverrideKeys(r1, getCachedPrefabSync(P) as PrefabFile);
    expect((await applyToPrefabSelective(r1, new Set(keys.added))).promotedAdditions).toBeGreaterThan(0);
    const written = takeWritten();
    const qRow = written.entities.find((e) => e.prefab === Q) as { added?: Array<{ key?: string; guid?: string }> } | undefined;
    expect(qRow?.added?.[0]).toMatchObject({ guid: '' }); // precondition: a template node…
    expect(qRow?.added?.[0]?.key).toBeTruthy(); // …with a key

    // Mutation: drop `remapWorldGuidRefs(follow)` — navUp keeps naming the deleted Inner.
    const now = under(ROOT1, 'Inner');
    expect(guidOf(now)).not.toBe(innerGuid); // precondition: keyed, so not carried
    expect(idOf(nav(under(HOLDER, 'Outside')).navUp!)).toBe(now);
    await load(await serializeScene() as unknown as SceneData);
    expect(idOf(nav(under(HOLDER, 'Outside')).navUp!)).toBe(under(ROOT1, 'Inner'));
    expect(duplicateGuids()).toEqual([]);
  });

  it('an instance the author dropped INSIDE the promoted nested instance: its root and its members keep resolving', async () => {
    // It becomes a template reference node of the row's `added`, so neither it nor its members can be pinned: every
    // ref follows their derived guids. Mutation: stop `promotionPathIndex` at a stored root (drop its recursion) —
    // RA is never paired, and navDown names nothing.
    const R = 'cccccccc-0000-4000-8000-000000016603';
    const rDoc = { id: R, version: 5, name: 'R', rootLocalId: 1, entities: [
      row(1, 'RR', 0, 'eeeeeeee-0000-4000-8000-000000016631'), row(2, 'RA', 1, 'eeeeeeee-0000-4000-8000-000000016632'),
    ] };
    install(pDoc(), qDoc(), rDoc);
    await load(scene());
    const qRoot = instantiatePrefab(getCachedPrefabSync(Q) as PrefabFile, idOf(ROOT1));
    setPrefabSource(qRoot, Q);
    const qRootGuid = ensureGuid(qRoot);
    const rRoot = instantiatePrefab(getCachedPrefabSync(R) as PrefabFile, under(qRootGuid, 'QA'));
    setPrefabSource(rRoot, R);
    const rRootGuid = ensureGuid(rRoot);
    await load(await serializeScene() as unknown as SceneData);
    const raGuid = guidOf(under(rRootGuid, 'RA'));
    const holder = idOf(HOLDER);
    add('Add Outside', holder, [
      { name: 'EntityAttributes', data: { name: 'Outside', parentId: holder } },
      { name: 'UIFocusable', data: { navUp: rRootGuid, navDown: raGuid } },
    ]);
    const r1 = idOf(ROOT1);
    const keys = collectInstanceOverrideKeys(r1, getCachedPrefabSync(P) as PrefabFile);
    expect((await applyToPrefabSelective(r1, new Set(keys.added))).promotedAdditions).toBeGreaterThan(0);
    takeWritten();
    const check = () => {
      const { navUp, navDown } = nav(under(HOLDER, 'Outside'));
      expect(idOf(navUp!)).toBe(under(ROOT1, 'RR'));
      expect(idOf(navDown!)).toBe(under(ROOT1, 'RA'));
      expect(duplicateGuids()).toEqual([]);
    };
    check();
    await load(await serializeScene() as unknown as SceneData);
    check();
  });

  it('Apply from an OWNED nested instance carries into the child prefab, stated on the OUTER instance\'s row', async () => {
    // The applied root derives its own guid, and the rows are written by the outermost instance (`rowWritingRoot`).
    // Mutations: stop `rowWritingRoot`'s walk at the applied root (a writer only when it is stored), or give up when the
    // root found again is an owned one — either way nothing is carried, Extra keeps its derived guid, and the ref follows.
    const pNested = () => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
      row(1, 'R', 0, 'eeeeeeee-0000-4000-8000-000000016611'), row(2, 'A', 1, 'eeeeeeee-0000-4000-8000-000000016612'),
      { ...row(3, 'QR', 2, 'eeeeeeee-0000-4000-8000-000000016613'), prefab: Q },
    ] });
    install(pNested(), qDoc());
    await load(scene());
    const qIn1 = under(ROOT1, 'QR');
    const qa = under(ROOT1, 'QA');
    const extraGuid = guidOf(add('Add Extra', qa, [{ name: 'EntityAttributes', data: { name: 'Extra', parentId: qa } }]));
    const holder = idOf(HOLDER);
    add('Add Outside', holder, [
      { name: 'EntityAttributes', data: { name: 'Outside', parentId: holder } },
      { name: 'UIFocusable', data: { navUp: extraGuid } },
    ]);
    const keys = collectInstanceOverrideKeys(qIn1, getCachedPrefabSync(Q) as PrefabFile);
    expect((await applyToPrefabSelective(qIn1, new Set(keys.added))).promotedAdditions).toBe(1);
    const q = [...writes].reverse().find((x) => (JSON.parse(x.content) as { id?: string }).id === Q);
    expect(q && (JSON.parse(q.content) as PrefabFile).entities.some((e) => e.name === 'Extra')).toBe(true); // precondition
    const check = () => {
      expect(guidOf(under(ROOT1, 'Extra'))).toBe(extraGuid);
      expect(idOf(nav(under(HOLDER, 'Outside')).navUp!)).toBe(under(ROOT1, 'Extra'));
      expect(duplicateGuids()).toEqual([]);
    };
    check();
    await load(await serializeScene() as unknown as SceneData);
    check();
  });

  it('a member still holding a RUNTIME guid is not carried: that guid is a per-session handle, and no row states one', async () => {
    // A nested instance dropped and applied in one session, never saved: its members hold runtime guids (#1210).
    // Mutation: drop `durableGuid(old)` from the carry condition — QB takes the runtime guid back, which no save writes.
    install(pDoc(), qDoc());
    await load(scene());
    const qRoot = instantiatePrefab(getCachedPrefabSync(Q) as PrefabFile, idOf(ROOT1));
    setPrefabSource(qRoot, Q);
    const qRootGuid = ensureGuid(qRoot);
    expect(isRuntimeGuid(guidOf(under(qRootGuid, 'QB')))).toBe(true); // precondition
    const r1 = idOf(ROOT1);
    const keys = collectInstanceOverrideKeys(r1, getCachedPrefabSync(P) as PrefabFile);
    expect((await applyToPrefabSelective(r1, new Set(keys.added))).promotedAdditions).toBeGreaterThan(0);
    takeWritten();
    expect(guidOf(under(ROOT1, 'QR'))).toBe(qRootGuid); // the durable root is carried
    expect(isRuntimeGuid(guidOf(under(ROOT1, 'QB')))).toBe(false);
  });
});
