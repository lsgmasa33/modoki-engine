/** #1876 S2: the scene v18 upgrade (#1809) renames every keyed node a v17 file names by the old rule. The loader also
 *  HOLDS raw file guids across that rename, read only after it: a queued move's new parent (a member row's `parent`, a
 *  legacy `moved`) and a pass-2 parent retried once every expansion has spawned (a child of a missing keyed reference node). They
 *  go through ONE registry and ONE `onGuidRemap` listener (`holdFileGuid`, `loadSceneFile.ts`). Before it, each of them
 *  still named the OLD guid after the rename: the member stayed at its row, the child fell to the scene root, and
 *  the next save wrote that loss for good.
 *
 *  Driven through the real loader, on files the new build writes then rewrites into what v0.7.3 wrote (the same shape,
 *  old-rule guids, version 17), and through a scene duplicate (`remintSceneEntityGuids`), whose copy stays v17. Every
 *  v17 case turns red with the listener's body emptied; the v18 controls stay green. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async () => ({ ok: true, json: async () => ({}), text: async () => '' }) as Response,
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode,
  loadSceneFile, instantiatePrefabIntoWorld, writeTraitField, destroyEntity, spawnEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction, clearHistory, serializeScene } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { deriveMemberGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { remintSceneEntityGuids } from '../../plugins/asset-fs-ops';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000018761';
const Q = 'cccccccc-0000-4000-8000-000000018762';
const O = 'cccccccc-0000-4000-8000-000000018763';
const ROOT = 'dddddddd-0000-4000-8000-000000018761';
const STORED = 'dddddddd-0000-4000-8000-000000018768';
const KX = 'aaaaaaaa-0000-4000-8000-0000000187a1';
const KK = 'aaaaaaaa-0000-4000-8000-0000000187a2';
const KR = 'aaaaaaaa-0000-4000-8000-0000000187a3';
const MINE = 'dddddddd-0000-4000-8000-0000000187aa';

const row = (localId: number, name: string, parentId: number, nodeGuid: string, extra: Record<string, unknown> = {}) => ({
  localId, name, nodeGuid, ...extra, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
// P: R ← A ← B. O: OR ← N (a P row, which adds Extra under P's B — so Extra's anchor is NOT its frame root, the case
// where the two rules give different guids — and Kid under Extra), and OR ← Panel.
const pDoc = { id: P, version: 9, name: 'P', rootLocalId: 1, nextLocalId: 4, entities: [
  row(1, 'R', 0, 'eeeeeeee-0000-4000-8000-0000000187e1'), row(2, 'A', 1, 'eeeeeeee-0000-4000-8000-0000000187e3'), row(3, 'B', 2, 'eeeeeeee-0000-4000-8000-0000000187e4'),
] };
const qDoc = { id: Q, version: 9, name: 'Q', rootLocalId: 1, nextLocalId: 3, entities: [
  row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-0000000187f1'), row(2, 'QM', 1, 'eeeeeeee-0000-4000-8000-0000000187f2'),
] };
const oDoc = { id: O, version: 9, name: 'O', rootLocalId: 1, nextLocalId: 4, entities: [
  row(1, 'OR', 0, 'eeeeeeee-0000-4000-8000-0000000187d1'),
  row(2, 'N', 1, 'eeeeeeee-0000-4000-8000-0000000187e2', {
    prefab: P,
    added: [
      { parentLocalId: 3, guid: '', key: KX, name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 6 } },
        children: [{ parentLocalId: 0, guid: '', key: KK, name: 'Kid', traits: { EntityAttributes: { name: 'Kid', parentId: 0 } }, children: [] }] },
    ],
  }),
  row(3, 'Panel', 1, 'eeeeeeee-0000-4000-8000-0000000187d3'),
] };
/** O with a keyed REFERENCE node Ref (a Q instance) beside Extra, under B. */
const oDocWithRef = { ...oDoc, entities: oDoc.entities.map((e) => (e.localId !== 2 ? e : { ...e, added: [
  { parentLocalId: 3, guid: '', key: KR, name: 'Ref', prefab: Q, traits: { EntityAttributes: { name: 'Ref', parentId: 0 } }, children: [] },
  ...(e as unknown as { added: unknown[] }).added,
] })) };
const install = (o: object = oDoc): void => { for (const d of [pDoc, qDoc, o] as Array<{ id: string }>) { prefabs.set(d.id, d); setPrefabCache(d.id, d as never); } };

const scene = (version: number): SceneData => ({
  id: 'keyed-pending', version, name: 'S', resources: [],
  entities: [{ id: 1, prefab: O, guid: ROOT, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } } }],
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
const named = (name: string) => {
  const hits = getAllEntities().filter((e) => e.name === name);
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} entities named ${name}`);
  return hits[0]!;
};

/** Each rule's guids for Extra and Kid below `root`: today's (the frame N plus the key) and v17's (through B and Extra). */
const rule = (root: string) => ({ extra: deriveMemberGuid(root, [2, `+${KX}`]), kid: deriveMemberGuid(root, [2, `+${KK}`]), ref: deriveMemberGuid(root, [2, `+${KR}`]) });
const legacy = (root: string) => ({ extra: deriveMemberGuid(root, [2, 2, 3, `+${KX}`]), kid: deriveMemberGuid(root, [2, 2, 3, `+${KX}`, `+${KK}`]), ref: deriveMemberGuid(root, [2, 2, 3, `+${KR}`]) });
const RULE = rule(ROOT);
const OLD = legacy(ROOT);

/** What v0.7.3 wrote for the scene this build saved as `saved`: the same shape, keyed nodes by their old-rule guids, v17. */
const asV17 = (saved: unknown): SceneData => {
  let text = JSON.stringify(saved);
  for (const k of ['extra', 'kid', 'ref'] as const) text = text.split(RULE[k]).join(OLD[k]);
  const out = JSON.parse(text) as { version: number };
  out.version = 17;
  return out as unknown as SceneData;
};

/** The saved scene with Panel (an O member) moved under `under`, a keyed node. */
async function savedWithPanelUnder(under: 'Extra' | 'Kid'): Promise<unknown> {
  await load(scene(18));
  writeTraitField(named('Panel').id, getTraitByName('EntityAttributes')!, 'parentId', named(under).id);
  return serializeScene();
}
beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  install();
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ files: [] }), text: async () => '' }));
});
afterAll(() => { for (const id of [P, Q, O]) setPrefabCache(id, null); getCurrentWorld()?.destroy(); });

describe('a v17 member MOVE under a keyed node survives the v18 upgrade (#1876 S2)', () => {
  for (const under of ['Extra', 'Kid'] as const) {
    it(`a member row's parent names ${under} by its old guid: kept on load, and the next save writes the new one`, async () => {
      const saved = await savedWithPanelUnder(under);
      await load(saved as SceneData);
      expect(named('Panel').parentId).toBe(named(under).id); // control: the v18 file
      const v17 = asV17(saved);
      expect(JSON.stringify(v17)).toContain(OLD[under === 'Extra' ? 'extra' : 'kid']); // premise: the old guid is what it names
      await load(v17);
      expect(named(under).guid).toBe(RULE[under === 'Extra' ? 'extra' : 'kid']); // premise: the upgrade renamed it
      expect(named('Panel').parentId).toBe(named(under).id);
      // The next save states the move with today's guid, and a reload keeps it.
      const resaved = await serializeScene();
      expect(JSON.stringify(resaved)).toContain(RULE[under === 'Extra' ? 'extra' : 'kid']);
      await load(resaved as SceneData);
      expect(named('Panel').parentId).toBe(named(under).id);
    });
  }

  it('a legacy `moved` map naming Extra by its old guid: kept', async () => {
    const s = scene(17) as unknown as { entities: Record<string, unknown>[] };
    s.entities[0]!.moved = { '3': OLD.extra };
    await load(s as unknown as SceneData);
    expect(named('Extra').guid).toBe(RULE.extra);
    expect(named('Panel').parentId).toBe(named('Extra').id);
  });

  it('a DUPLICATE of the v17 file (the copy stays v17): its move is kept too', async () => {
    const v17 = asV17(await savedWithPanelUnder('Extra'));
    const NEW_ROOT = 'dddddddd-0000-4000-8000-0000000187ff';
    let n = 0;
    const copy = remintSceneEntityGuids(v17 as never, () => (n++ === 0 ? NEW_ROOT : `dddddddd-0000-4000-8000-0000000188${String(n).padStart(2, '0')}`), (g) => prefabs.get(g) as never) as unknown as SceneData;
    await load(copy);
    expect(named('Extra').guid).toBe(rule(NEW_ROOT).extra);
    expect(named('Panel').parentId).toBe(named('Extra').id);
  });
});

describe('a v17 child of a MISSING keyed reference node survives the v18 upgrade (#1876 S2, the pass-2 retry)', () => {
  // A child the scene put under a keyed reference node whose prefab is missing is written TOP-LEVEL, its parent named
  // by the node's guid (#1738), and the loader retries that parent once every expansion has spawned the placeholder —
  // after the v18 rename. A v17 file names the node's OLD guid there.
  async function savedWithChildUnderMissingRef(): Promise<SceneData> {
    install(oDocWithRef);
    prefabs.delete(Q); setPrefabCache(Q, null);
    await load(scene(18));
    spawnEntity(getCurrentWorld(), getTraitByName('Transform')!.trait({ x: 1 }),
      getTraitByName('EntityAttributes')!.trait({ name: 'Mine', parentId: named('Ref').id, guid: MINE }));
    const saved = await serializeScene() as unknown as { entities: Array<{ traits?: { EntityAttributes?: { parentId?: unknown } } }> };
    // Premise: the child is top-level, naming Ref by its guid — the shape the retry exists for.
    expect(saved.entities.some((e) => e.traits?.EntityAttributes?.parentId === RULE.ref)).toBe(true);
    return saved as unknown as SceneData;
  }

  it('a top-level child whose parent guid is the missing Ref\'s old one: under Ref, not at the scene root', async () => {
    const saved = await savedWithChildUnderMissingRef();
    await load(saved);
    expect(named('Mine').parentId).toBe(named('Ref').id); // control: the v18 file
    await load(asV17(saved));
    expect(named('Ref').guid).toBe(RULE.ref); // premise: the upgrade renamed the placeholder
    expect(named('Mine').parentId).toBe(named('Ref').id);
    await load(await serializeScene() as unknown as SceneData);
    expect(named('Mine').parentId).toBe(named('Ref').id);
  });

  it('a DUPLICATE, v18 too: the file walk gives the missing node its path, so the copy re-points the child (memberPaths)', async () => {
    // Not the upgrade: `memberPathRecords` skipped a keyed reference node whose prefab it could not read, though its
    // guid needs only its frame and key, so the copy's child still named the ORIGINAL's guid.
    const saved = await savedWithChildUnderMissingRef();
    let n = 0;
    const copy = remintSceneEntityGuids(saved as never, () => (n++ === 0 ? 'dddddddd-0000-4000-8000-0000000187fd' : `dddddddd-0000-4000-8000-0000000190${String(n).padStart(2, '0')}`), (g) => prefabs.get(g) as never) as unknown as SceneData;
    await load(copy);
    expect(named('Ref').guid).toBe(rule('dddddddd-0000-4000-8000-0000000187fd').ref);
    expect(named('Mine').parentId).toBe(named('Ref').id);
  });

  it('and in a DUPLICATE of that v17 file', async () => {
    const v17 = asV17(await savedWithChildUnderMissingRef());
    let n = 0;
    const copy = remintSceneEntityGuids(v17 as never, () => (n++ === 0 ? 'dddddddd-0000-4000-8000-0000000187fe' : `dddddddd-0000-4000-8000-0000000189${String(n).padStart(2, '0')}`), (g) => prefabs.get(g) as never) as unknown as SceneData;
    await load(copy);
    expect(named('Mine').parentId).toBe(named('Ref').id);
  });
});

describe('a v17 STORED root under a keyed node is not a held guid (control)', () => {
  it('the save writes it in the keyed node\'s own node row, by KEY, so the upgrade has nothing to reach', async () => {
    await load(scene(18));
    const id = instantiatePrefabIntoWorld(getCurrentWorld(), qDoc as never, named('Extra').id, undefined, Q);
    const eaMeta = getTraitByName('EntityAttributes')!;
    for (const e of getCurrentWorld().entities) {
      if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), guid: STORED });
    }
    const saved = await serializeScene();
    expect(JSON.stringify(saved)).toContain(`/a+${KX}`); // premise: the node row, keyed
    await load(asV17(saved));
    expect(named('QR').parentId).toBe(named('Extra').id);
  });
});
