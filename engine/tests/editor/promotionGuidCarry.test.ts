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
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData, writeTraitField,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { markOverride } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { setActionCallback, pushAction, clearHistory, createEntityWithUndo, ensureGuid, reparentEntity } from '@modoki/engine/editor';
import { isRuntimeGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import {
  setPrefabCache, applyToPrefabSelective, getCachedPrefabSync, instantiatePrefab, setPrefabSource, carryPromotedGuidsForTest,
  previewApply, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { templateKeyOf } from '../../packages/modoki/src/runtime/core/templateIdentity';
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
    setPrefabSource(qRoot, { id: Q });
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
    setPrefabSource(qRoot, { id: Q });
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

  it('#1736: a DRY RUN of that promotion (the dialog\'s preview) stamps no template key on the live node and writes nothing', async () => {
    // Mutation: pass `readOnly: false` for the promotion in `planApply` (drop `readOnly: dryRun`) — the preview's
    // template capture of the reference node stamps a key on Inner, a live change no undo records.
    install(pDoc(), qDoc());
    await load(scene());
    const qRoot = instantiatePrefab(getCachedPrefabSync(Q) as PrefabFile, idOf(ROOT1));
    setPrefabSource(qRoot, { id: Q });
    const qRootGuid = ensureGuid(qRoot);
    await load(await serializeScene() as unknown as SceneData);
    const inner = add('Add Inner', idOf(qRootGuid), [{ name: 'EntityAttributes', data: { name: 'Inner', parentId: idOf(qRootGuid) } }]);
    const entityOf = (id: number) => getCurrentWorld().entities.find((e) => e.id() === id);
    expect(templateKeyOf(entityOf(inner))).toBe(''); // precondition
    const r1 = idOf(ROOT1);
    const keys = collectInstanceOverrideKeys(r1, getCachedPrefabSync(P) as PrefabFile);
    const preview = await previewApply(r1, new Set(keys.added));
    expect(preview.effects.map((e) => e.effect.op)).toEqual(['addNode']);
    expect(templateKeyOf(entityOf(inner))).toBe('');
    expect(writes).toHaveLength(0);
    // A REFUSED Apply leaves no stamp either (#1736 review): the stale-preview refusal is decided on a dry plan before
    // the writing plan runs. Mutation: decide it on the writing plan (drop the dry pass in `applyToPrefabSelective`) —
    // refused, nothing written, and Inner carries a template key no undo records.
    const refused = await applyToPrefabSelective(r1, new Set(keys.added), undefined, { expect: 'not what was shown' });
    expect(refused.refused).toMatch(/changed since it was shown/);
    expect(templateKeyOf(entityOf(inner))).toBe('');
    expect(writes).toHaveLength(0);
  });

  it('#1736: a CONFLICT is refused on the dry plan — the promotion in the same Apply stamps nothing', async () => {
    // Mutation: drop \`if (dry.conflicts.length) return …\` in \`applyToPrefabSelective\` — the writing plan's own check still
    // refuses and writes nothing, but only after its promotion stamped a template key on Inner, which no undo records.
    // P2: R2 → N1 (Q), R2 → N2 (Q). QA.x = 5 under N1 and 9 under N2, both applied into Q: a conflict.
    const P2 = 'cccccccc-0000-4000-8000-000000017361';
    const ref = (localId: number, name: string, nodeGuid: string) => ({ localId, name, nodeGuid, prefab: Q, traits: { EntityAttributes: { name, parentId: 1, guid: '' } } });
    const p2 = { id: P2, version: 5, name: 'P2', rootLocalId: 1, entities: [
      row(1, 'R2', 0, 'eeeeeeee-0000-4000-8000-000000017361'), ref(2, 'N1', 'eeeeeeee-0000-4000-8000-000000017362'), ref(3, 'N2', 'eeeeeeee-0000-4000-8000-000000017363'),
    ] };
    install(pDoc(), qDoc(), p2);
    await load({ ...scene(), entities: [
      { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
      { id: 2, prefab: P2, guid: ROOT1, traits: { EntityAttributes: { name: 'Inst1', parentId: HOLDER } } },
    ] } as unknown as SceneData);
    const qRoot = instantiatePrefab(getCachedPrefabSync(Q) as PrefabFile, idOf(ROOT1));
    setPrefabSource(qRoot, { id: Q });
    const qRootGuid = ensureGuid(qRoot);
    await load(await serializeScene() as unknown as SceneData);
    const inner = add('Add Inner', idOf(qRootGuid), [{ name: 'EntityAttributes', data: { name: 'Inner', parentId: idOf(qRootGuid) } }]);
    const entityOf = (id: number) => getCurrentWorld().entities.find((e) => e.id() === id);
    const added = under(qRootGuid, 'QA');
    const [qa1, qa2] = getAllEntities().filter((e) => e.name === 'QA' && e.id !== added).map((e) => e.id);
    writeTraitField(qa1!, meta('Transform'), 'x', 5);
    markOverride(entityOf(qa1!)!, 'Transform', 'x');
    writeTraitField(qa2!, meta('Transform'), 'x', 9);
    markOverride(entityOf(qa2!)!, 'Transform', 'x');
    const r1 = idOf(ROOT1);
    const keys = collectInstanceOverrideKeys(r1, getCachedPrefabSync(P2) as PrefabFile);
    expect([keys.added.length, keys.nested.length]).toEqual([1, 2]); // precondition
    expect(templateKeyOf(entityOf(inner))).toBe(''); // precondition
    const res = await applyToPrefabSelective(r1, new Set([...keys.added, ...keys.nested]), { perKey: Object.fromEntries(keys.nested.map((k) => [k, Q])) });
    expect(res.conflicts).toHaveLength(1);
    expect(writes).toHaveLength(0);
    expect(templateKeyOf(entityOf(inner))).toBe('');
  });

  it('a node the author added INSIDE the promoted nested instance becomes template-keyed: its guid re-derives and the refs follow it', async () => {
    // The QA-PREFAB-0019 shape. The promotion writes the node into the row's `added` with a key — stamped on the live
    // node by that write, which is what lets the snapshot index it by the same step the refresh brings it back at.
    // A keyed node is never pinned (#1426), so it cannot be carried: the live refs follow its derived guid instead.
    install(pDoc(), qDoc());
    await load(scene());
    const qRoot = instantiatePrefab(getCachedPrefabSync(Q) as PrefabFile, idOf(ROOT1));
    setPrefabSource(qRoot, { id: Q });
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
    setPrefabSource(qRoot, { id: Q });
    const qRootGuid = ensureGuid(qRoot);
    const rRoot = instantiatePrefab(getCachedPrefabSync(R) as PrefabFile, under(qRootGuid, 'QA'));
    setPrefabSource(rRoot, { id: R });
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
    setPrefabSource(qRoot, { id: Q });
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

describe('#1682: Apply deletes the promoted node\'s IDENTITY subtree, not its live one', () => {
  /** P: R → A → B, and instance 1 moves member A under a node it added. */
  const moveIntoAdded = async () => {
    const p3 = { id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
      row(1, 'R', 0, 'eeeeeeee-0000-4000-8000-000000016611'), row(2, 'A', 1, 'eeeeeeee-0000-4000-8000-000000016612'),
      row(3, 'B', 2, 'eeeeeeee-0000-4000-8000-000000016613'),
    ] };
    install(p3);
    await load(scene());
    const r1 = idOf(ROOT1);
    const extra = add('Add Extra', r1, [{ name: 'EntityAttributes', data: { name: 'Extra', parentId: r1 } }]);
    const aGuid = guidOf(under(ROOT1, 'A'));
    reparentEntity(under(ROOT1, 'A'), extra);
    const holder = idOf(HOLDER);
    add('Add Outside', holder, [
      { name: 'EntityAttributes', data: { name: 'Outside', parentId: holder } },
      { name: 'UIFocusable', data: { navDown: aGuid } },
    ]);
    const keys = collectInstanceOverrideKeys(r1, getCachedPrefabSync(P) as PrefabFile);
    expect(keys.all).toEqual(expect.arrayContaining([expect.stringMatching(/^\+added\./), expect.stringMatching(/^~moved\./)])); // precondition
    return { r1, keys, aGuid };
  };
  const parentName = (id: number) => getAllEntities().find((e) => e.id === getAllEntities().find((x) => x.id === id)?.parentId)?.name;

  it('a member dragged INTO the promoted node survives the Apply and the reload (the move applied with it)', async () => {
    // Mutation: delete the promoted nodes' LIVE subtree again (`deleteEntities` over the live descendants) — A and B go
    // with Extra, and the refresh's capture saves A as removed: "0 entities named A".
    const { r1, keys } = await moveIntoAdded();
    await applyToPrefabSelective(r1, new Set([...keys.added, ...keys.moved]));
    takeWritten();
    for (const phase of ['after Apply', 'after reload']) {
      if (phase === 'after reload') await load(await serializeScene() as unknown as SceneData);
      expect(under(ROOT1, 'A')).toBeTruthy();
      expect(under(ROOT1, 'B')).toBeTruthy();
      expect(parentName(under(ROOT1, 'A'))).toBe('Extra');
      expect(idOf(nav(under(HOLDER, 'Outside')).navDown!)).toBe(under(ROOT1, 'A'));
      expect(duplicateGuids()).toEqual([]);
    }
  });

  it('…and when only the addition is applied, the member keeps its (still unapplied) move under the promoted node', async () => {
    // Mutation: drop the step that hangs a survivor back under its recorded live parent after the refresh — A survives
    // but falls back to its template parent R, losing the move the user made and did not apply.
    const { r1, keys } = await moveIntoAdded();
    await applyToPrefabSelective(r1, new Set(keys.added));
    takeWritten();
    for (const phase of ['after Apply', 'after reload']) {
      if (phase === 'after reload') await load(await serializeScene() as unknown as SceneData);
      expect(parentName(under(ROOT1, 'A'))).toBe('Extra');
      expect(under(ROOT1, 'B')).toBeTruthy();
      expect(idOf(nav(under(HOLDER, 'Outside')).navDown!)).toBe(under(ROOT1, 'A'));
      expect(duplicateGuids()).toEqual([]);
    }
  });

  it('a member dragged under a MEMBER of a promoted reference node is hung back under it', async () => {
    // The survivor's parent is inside the promoted node's nested frame, re-expanded as the nested row's member.
    // Mutation: drop `rehangPromotionSurvivors` — A stays at its template parent R.
    install(pDoc(), qDoc());
    await load(scene());
    const r1 = idOf(ROOT1);
    const qRoot = instantiatePrefab(getCachedPrefabSync(Q) as PrefabFile, r1);
    setPrefabSource(qRoot, { id: Q });
    const qRootGuid = ensureGuid(qRoot);
    reparentEntity(under(ROOT1, 'A'), under(qRootGuid, 'QA'));
    const keys = collectInstanceOverrideKeys(r1, getCachedPrefabSync(P) as PrefabFile);
    await applyToPrefabSelective(r1, new Set(keys.added));
    takeWritten();
    expect(parentName(under(ROOT1, 'A'))).toBe('QA');
    expect(duplicateGuids()).toEqual([]);
  });

  it('a nested member moved OUT of a promoted plain node is not left behind as a duplicate', async () => {
    // A plain Extra holds a dropped Q, and Q's member QB was moved out under R1.
    // Mutation: consult the members living outside only for a top-level REFERENCE node (the old `membersLivingOutside`
    // gate) — the original QB survives beside its re-expansion: 3 QBs across the two instances.
    install(pDoc(), qDoc());
    await load(scene());
    const extra = add('Add Extra', idOf(ROOT1), [{ name: 'EntityAttributes', data: { name: 'Extra', parentId: idOf(ROOT1) } }]);
    const qRoot = instantiatePrefab(getCachedPrefabSync(Q) as PrefabFile, extra);
    setPrefabSource(qRoot, { id: Q });
    const qRootGuid = ensureGuid(qRoot);
    await load(await serializeScene() as unknown as SceneData);
    const qbGuid = guidOf(under(qRootGuid, 'QB'));
    reparentEntity(idOf(qbGuid), idOf(ROOT1));
    const holder = idOf(HOLDER);
    add('Add Outside', holder, [
      { name: 'EntityAttributes', data: { name: 'Outside', parentId: holder } },
      { name: 'UIFocusable', data: { navDown: qbGuid } },
    ]);
    const keys = collectInstanceOverrideKeys(idOf(ROOT1), getCachedPrefabSync(P) as PrefabFile);
    await applyToPrefabSelective(idOf(ROOT1), new Set(keys.added));
    takeWritten();
    for (const phase of ['after Apply', 'after reload']) {
      if (phase === 'after reload') await load(await serializeScene() as unknown as SceneData);
      expect(getAllEntities().filter((e) => e.name === 'QB')).toHaveLength(2);
      expect(duplicateGuids()).toEqual([]);
      expect(idOf(nav(under(HOLDER, 'Outside')).navDown!)).toBe(under(ROOT1, 'QB')); // `under` throws on 2
    }
  });
});

describe('#1759: a promotion never takes a localId a removal in the SAME Apply frees', () => {
  it('delete A (the highest row) and add X, Apply both: X is written above A\'s old number, not into it', async () => {
    // A number freed by a removal handed to a new row gives that row the removed member's derived guid, and every ref
    // still naming the removed member silently lands on it (the #1759 class). Apply's promotion counts from the
    // document as it was BEFORE this Apply's removals (`nextLocalId` in `planApply`). Mutation: compute it after the
    // removal is applied (from the filtered `newPrefab.entities`) — X is written at 2.
    install(pDoc());
    await load(scene());
    const r1 = idOf(ROOT1);
    const { deleteEntitiesWithUndo } = await import('@modoki/engine/editor');
    deleteEntitiesWithUndo([under(ROOT1, 'A')]);
    add('Add X', r1, [{ name: 'EntityAttributes', data: { name: 'X', parentId: r1 } }]);
    const keys = collectInstanceOverrideKeys(r1, getCachedPrefabSync(P) as PrefabFile);
    expect(keys.removedEntities.length).toBe(1); // precondition: the removal is one of the keys applied
    const res = await applyToPrefabSelective(r1, new Set([...keys.removedEntities, ...keys.added]));
    expect(res.applied).toBe(true);
    const written = takeWritten();
    expect(written.entities.map((e) => [e.name, e.localId])).toEqual([['R', 1], ['X', 3]]);
  });
});
