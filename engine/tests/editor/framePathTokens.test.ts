/** #1876 S1/L1: ONE walker (`walkFramePath`, `templateKeyRecovery.ts`) reads a written member path through the frames
 *  it passes — a nested row (or a keyed reference node) enters its frame, `@` (FRAME_STEP, #1484) leaves it — for the
 *  prefab-edit world's token and `moved` mapping (`editGuidAt`), the flat respelling of a path written before #1809
 *  (`flatKeyedSteps`), and `memberPathLookup`'s respell.
 *
 *  Before it, `editGuidAt` derived everything past the first nested row from that row's sentinel, and
 *  `flatKeyedSteps` never left a frame at `@`: a token whose path passes a `@` mapped to a guid no edit-world entity
 *  holds, and the save wrote that guid back RAW over the token — dead in every instance after a no-op open → save
 *  (S1). And `memberPathLookup` guessed the flat spelling by prefixes, so a key a deeper frame also used took the ref
 *  (L1). Driven through the real loader, prefab-edit world and save. Each case names the mutation that turns it red. */

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
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction, clearHistory } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { buildPrefabEditScene, serializePrefabEditWorld, applyEditWorldMoves, _resetPrefabEditSessionRows } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { baseTokenResolver } from '../../packages/modoki/src/editor/scene/prefabTokens';
import { prefabMoveTargets } from '../../packages/modoki/src/editor/scene/prefabMembers';
import { memberPathIndex, identityTree } from '../../packages/modoki/src/runtime/core/ecs/memberHome';
import { flatKeyedSteps } from '../../packages/modoki/src/runtime/loaders/templateKeyRecovery';
import { memberPathSteps } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const Z = 'cccccccc-0000-4000-8000-000000018781';
const P = 'cccccccc-0000-4000-8000-000000018782';
const O = 'cccccccc-0000-4000-8000-000000018783';
const ROOT = 'dddddddd-0000-4000-8000-000000018781';
const K = 'aaaaaaaa-0000-4000-8000-0000000187b1';
const KW = 'aaaaaaaa-0000-4000-8000-0000000187b2';

const row = (localId: number, name: string, parentId: number, nodeGuid: string, extra: Record<string, unknown> = {}) => ({
  localId, name, nodeGuid, ...extra, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const withNav = (r: ReturnType<typeof row>, token?: string) => (token ? { ...r, traits: { ...r.traits, UIFocusable: { navUp: token } } } : r);
const zDoc = () => ({ id: Z, version: 9, name: 'Z', rootLocalId: 1, nextLocalId: 3, entities: [
  row(1, 'ZR', 0, 'eeeeeeee-0000-4000-8000-0000000187f1'), row(2, 'ZM', 1, 'eeeeeeee-0000-4000-8000-0000000187f2'),
] });
/** P: R ← A (a nested Z row) ← B (a plain P row hung under the nested row, #1484) and ← C (a nested Z row under A: a
 *  nested row under a nested row, which the prefab-edit save writes). `withY`: A's row adds Y, keyed K, into A's frame.
 *  `token`: PanelP's navUp. `moved`: P's own legacy moves. */
const pDoc = (opts: { withY?: boolean; token?: string; moved?: Record<string, string> } = {}) => ({
  id: P, version: 9, name: 'P', rootLocalId: 1, nextLocalId: 6, ...(opts.moved ? { moved: opts.moved } : {}), entities: [
    row(1, 'R', 0, 'eeeeeeee-0000-4000-8000-0000000187e1'),
    row(2, 'A', 1, 'eeeeeeee-0000-4000-8000-0000000187e2', { prefab: Z,
      ...(opts.withY ? { added: [{ parentLocalId: 1, guid: '', key: K, name: 'Y', traits: { EntityAttributes: { name: 'Y', parentId: 0 } }, children: [] }] } : {}) }),
    row(3, 'B', 2, 'eeeeeeee-0000-4000-8000-0000000187e3'),
    row(4, 'C', 2, 'eeeeeeee-0000-4000-8000-0000000187e4', { prefab: Z }),
    withNav(row(5, 'PanelP', 1, 'eeeeeeee-0000-4000-8000-0000000187e5'), opts.token),
  ] });
/** O: OR ← N (a P row adding X, keyed K, under B — so X's frame is N's — and W, keyed KW, into C's frame) ← Panel. */
const oDoc = (token?: string, version = 9) => ({ id: O, version, name: 'O', rootLocalId: 1, nextLocalId: 4, entities: [
  row(1, 'OR', 0, 'eeeeeeee-0000-4000-8000-0000000187d1'),
  row(2, 'N', 1, 'eeeeeeee-0000-4000-8000-0000000187d2', { prefab: P,
    added: [{ parentLocalId: 3, guid: '', key: K, name: 'X', traits: { EntityAttributes: { name: 'X', parentId: 0 } }, children: [] }],
    nestedStructure: { '4': { added: [{ parentLocalId: 2, guid: '', key: KW, name: 'W', traits: { EntityAttributes: { name: 'W', parentId: 0 } }, children: [] }] } } }),
  withNav(row(3, 'Panel', 1, 'eeeeeeee-0000-4000-8000-0000000187d3'), token),
] });
const install = (...docs: Array<{ id?: string }>) => { for (const d of docs) { prefabs.set(d.id!, d); setPrefabCache(d.id!, d as never); } };

async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id: number) => { const w = getCurrentWorld(); for (const e of w.entities) if (e.id() === id) { destroyEntity(e, w); break; } },
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure) => {
      const id = instantiatePrefabIntoWorld(getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
      if (id && rootGuid) for (const e of getCurrentWorld().entities) if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), guid: rootGuid });
      return id ?? undefined;
    },
  });
}
const scene = (): SceneData => ({ id: 's', version: 18, name: 'S', resources: [],
  entities: [{ id: 1, prefab: O, guid: ROOT, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } } }] } as unknown as SceneData);
const named = (name: string) => { const h = getAllEntities().filter((e) => e.name === name); if (h.length !== 1) throw new Error(`${h.length} ${name}`); return h[0]!; };
const navUpOf = (panel: string) => (readTraitData(named(panel).id, getTraitByName('UIFocusable')!) as { navUp: string }).navUp;
/** `name`'s member path in the frame of the scene instance root, under today's rule or the legacy one. */
const pathOf = (name: string, legacy = false): string => {
  const w = getCurrentWorld();
  const root = getAllEntities().find((e) => e.guid === ROOT)!.id;
  const index = memberPathIndex(w, root, legacy ? identityTree(w, undefined, { legacyKeyedParent: true }) : undefined);
  const hits = [...index].filter(([, e]) => e?.id() === named(name).id).map(([k]) => k);
  if (hits.length !== 1) throw new Error(`${hits.length} paths for ${name}`);
  return hits[0]!;
};

/** Open `id` in the prefab-edit world, check `panel`'s ref lands on `target`, save; reopen the saved document, check
 *  again, save again. Returns both saves. */
async function editRoundTrip(id: string, panel: string, target: string): Promise<{ s1: PrefabFile; s2: PrefabFile }> {
  await load(buildPrefabEditScene(prefabs.get(id) as PrefabFile) as SceneData);
  expect(navUpOf(panel)).toBe(named(target).guid);
  const s1 = serializePrefabEditWorld(id);
  if ('error' in s1) throw new Error(s1.error);
  install(s1.prefab);
  await load(buildPrefabEditScene(s1.prefab) as SceneData);
  expect(navUpOf(panel)).toBe(named(target).guid);
  const s2 = serializePrefabEditWorld(id);
  if ('error' in s2) throw new Error(s2.error);
  return { s1: s1.prefab, s2: s2.prefab };
}
const tokenIn = (doc: PrefabFile, panel: string) => ((doc.entities.find((e) => e.name === panel)!.traits as Record<string, { navUp?: string }>).UIFocusable?.navUp);

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  _resetPrefabEditSessionRows();
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ files: [] }), text: async () => '' }));
});
afterAll(() => { for (const id of [Z, P, O]) setPrefabCache(id, null); getCurrentWorld()?.destroy(); });

describe('a no-op prefab-edit open → save → reopen → save keeps a ref whose path passes a `@` (#1876 S1)', () => {
  // Mutation: `editGuidAt` derives the rest of the path from the first nested row's sentinel (the old loop) — every case
  // maps the token to a guid nobody holds, and the save writes that guid raw.
  it('unkeyed: PanelP → B, P\'s own row hung under its nested row A (`@member:2.@.3`)', async () => {
    install(zDoc(), pDoc({ token: '@member:2.@.3' }));
    const { s1, s2 } = await editRoundTrip(P, 'PanelP', 'B');
    expect(tokenIn(s1, 'PanelP')).toBe('@member:2.@.3');
    expect(JSON.stringify(s2)).toBe(JSON.stringify(s1));
  });

  it('unkeyed at depth 2: Panel → B inside N\'s instance, through A\'s frame and out (`@member:2.2.@.3`)', async () => {
    install(zDoc(), pDoc(), oDoc('@member:2.2.@.3'));
    const { s1, s2 } = await editRoundTrip(O, 'Panel', 'B');
    expect(tokenIn(s1, 'Panel')).toBe('@member:2.2.@.3');
    expect(JSON.stringify(s2)).toBe(JSON.stringify(s1));
  });

  it('keyed, v9 flat token: Panel → W, keyed into C\'s frame — a nested row under a nested row, at depth 2', async () => {
    install(zDoc(), pDoc(), oDoc());
    await load(scene());
    const flat = pathOf('W');
    expect(flat).toBe(`2.2.@.4.+${KW}`); // premise: the path leaves A's frame at `@` and enters C's
    install(oDoc(`@member:${flat}`));
    const { s1, s2 } = await editRoundTrip(O, 'Panel', 'W');
    expect(tokenIn(s1, 'Panel')).toBe(`@member:${flat}`);
    expect(JSON.stringify(s2)).toBe(JSON.stringify(s1));
  });

  it('keyed, v8 old-form token: Panel → X through its anchor B (`2.2.@.3.+K`) — the first save writes it flat', async () => {
    install(zDoc(), pDoc(), oDoc());
    await load(scene());
    const old = pathOf('X', true);
    expect(old).toBe(`2.2.@.3.+${K}`); // premise: the old rule's path through the anchor B
    expect(pathOf('X')).toBe(`2.+${K}`); // …and today's: N's frame plus the key
    install(oDoc(`@member:${old}`, 8));
    const { s1, s2 } = await editRoundTrip(O, 'Panel', 'X');
    expect(tokenIn(s1, 'Panel')).toBe(`@member:2.+${K}`);
    expect(JSON.stringify(s2)).toBe(JSON.stringify(s1));
  });

  it('a `moved` target through `@`: P\'s legacy move of ZM under B is SHOWN in the edit world', async () => {
    // The same mapping (`applyEditWorldMoves` → `editGuidAt`): the target named nothing, and the move was "not shown".
    install(zDoc(), pDoc({ moved: { '2.2': '@member:2.@.3' } }));
    await load(buildPrefabEditScene(prefabs.get(P) as PrefabFile) as SceneData);
    const zms = () => getAllEntities().filter((e) => e.name === 'ZM').map((e) => e.parentId);
    expect(zms()).not.toContain(named('B').id); // premise: loaded unmoved (A's and C's)
    applyEditWorldMoves(prefabs.get(P) as PrefabFile);
    expect(zms()).toContain(named('B').id);
  });
});

describe('flatKeyedSteps walks the frames a path passes (#1876 S1)', () => {
  // Mutation: `@` does not leave the frame (the old walk) — `2.2.@.3.+K` comes back `2.2.+K`, and `3.5.+A` style
  // paths still flatten.
  const read = (g: string) => prefabs.get(g) as never;
  it('an old path through a row under a nested row comes back as its frame plus its key; a flat one unchanged', () => {
    install(zDoc(), pDoc(), oDoc());
    const o = prefabs.get(O) as never;
    expect(flatKeyedSteps(memberPathSteps(`2.2.@.3.+${K}`), o, read).join('.')).toBe(`2.+${K}`);
    expect(flatKeyedSteps(memberPathSteps(`2.+${K}`), o, read).join('.')).toBe(`2.+${K}`);
    expect(flatKeyedSteps(memberPathSteps(`2.2.@.4.+${KW}`), o, read).join('.')).toBe(`2.2.@.4.+${KW}`);
    expect(flatKeyedSteps(memberPathSteps(`2.3.+${K}.+${KW}`), o, read).join('.')).toBe(`2.+${KW}`); // a keyed parent is dropped
  });
  it('a path whose document cannot be read comes back as written, never guessed', () => {
    install(pDoc(), oDoc()); // Z missing
    expect(flatKeyedSteps(memberPathSteps(`2.2.@.3.+${K}`), prefabs.get(O) as never, read).join('.')).toBe(`2.2.@.3.+${K}`);
  });
});

describe('an old-form token never lands on another node that shares its key (#1876 L1)', () => {
  // Y (key K) in A's frame and X (key K) in N's: the old prefix guess tried `2.2.@.+K`, then `2.2.+K` — Y. The lookup
  // now respells through the documents: `2.+K`, X. Mutation: `memberPathLookup` falls back to the prefix guess — navUp
  // lands on Y.
  it('on a scene load of the v8 document', async () => {
    install(zDoc(), pDoc({ withY: true }), oDoc());
    await load(scene());
    const old = pathOf('X', true);
    expect(pathOf('Y')).toBe(`2.2.+${K}`); // premise: Y is on the path's prefix
    install(oDoc(`@member:${old}`, 8));
    await load(scene());
    expect(navUpOf('Panel')).toBe(named('X').guid);
  });
});

describe('the editor\'s readers of a v8 path find the node through the respell (#1876, the prefix guess deleted)', () => {
  // O v8 names X by its OLD path twice: Panel's token, and the target of a legacy `moved` that puts P's PanelP (a plain
  // member of N's frame) under X. Mutation per case: that reader passes no respell to `memberPathLookup` — the old path
  // names nothing. (A moved keyed REFERENCE root is not used: its live frame and the guid its load derived disagree,
  // #1876's N2, so a move key naming one fails before any respell.)
  const U = 'cccccccc-0000-4000-8000-000000018784';
  const OLD_X = `2.2.@.3.+${K}`;
  const oV8 = () => ({ ...oDoc(`@member:${OLD_X}`, 8), moved: { '2.5': `@member:${OLD_X}` } });
  const uDoc = () => ({ id: U, version: 9, name: 'U', rootLocalId: 1, nextLocalId: 3, entities: [
    row(1, 'UR', 0, 'eeeeeeee-0000-4000-8000-0000000187c1'), row(2, 'Oi', 1, 'eeeeeeee-0000-4000-8000-0000000187c2', { prefab: O }),
  ] });
  const rootOf = () => getAllEntities().find((e) => e.guid === ROOT)!.id;

  it('premise: the loader reads both (the drain and the token resolve respell too)', async () => {
    install(zDoc(), pDoc(), oV8());
    await load(scene());
    expect(named('PanelP').parentId).toBe(named('X').id);
    expect(navUpOf('Panel')).toBe(named('X').guid);
  });
  it('baseTokenResolver (the base value a Revert / an Apply compares against)', async () => {
    install(zDoc(), pDoc(), oV8());
    await load(scene());
    expect(baseTokenResolver(rootOf())(`@member:${OLD_X}`)).toBe(named('X').guid);
  });
  it('prefabMoveTargets (where the prefab\'s own moves put a member)', async () => {
    install(zDoc(), pDoc(), oV8());
    await load(scene());
    expect(prefabMoveTargets(rootOf(), prefabs.get(O) as PrefabFile)(named('PanelP').id)).toBe(named('X').guid);
  });
  it('templateMoves (an outer prefab\'s save over O): O\'s own move is its BASE, so a no-op save of U writes no move', async () => {
    install(zDoc(), pDoc(), oV8(), uDoc());
    await load(buildPrefabEditScene(prefabs.get(U) as PrefabFile) as SceneData);
    expect(named('PanelP').parentId).toBe(named('X').id); // premise: O's move is shown
    const saved = serializePrefabEditWorld(U);
    if ('error' in saved) throw new Error(saved.error);
    expect(saved.prefab.moved).toBeUndefined();
  });
});
