/** Unused overrides (#1914 R4, owner ruling F5, docs/prefabs.md § I18): a record whose target the template no longer
 *  gives — a field no schema declares, a trait nothing registers, a removal of a component the member's base lacks, a
 *  localId the template dropped — is ignored at load and written back by every save, in the channel the file held it in,
 *  until an explicit Remove. recordedOverrideList.test.ts pins the four F5 cases in the legacy localId form; these pin the
 *  other carriers: a member ROW, a scene-added reference node, the legacy structure channels, and a prefab-edit save. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { setActionCallback, pushAction, clearHistory } from '@modoki/engine/editor';
import { addTraitToEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { serializePrefab } from '../../packages/modoki/src/editor/scene/prefabSerialize';
import { buildPrefabEditScene, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { collectInstanceOverrideListing } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import type { PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000001941';
const O = 'cccccccc-0000-4000-8000-000000001942';
const ROOT1 = 'dddddddd-0000-4000-8000-000000001941';
const NODE = 'dddddddd-0000-4000-8000-000000001942';
const OTHER = 'dddddddd-0000-4000-8000-000000001943';
const g = (n: number) => `eeeeeeee-0000-4000-8000-00000000194${n}`;

/** P: R → A (authors Rotate3D), B. */
const pDoc = (patch: (d: ReturnType<typeof baseDoc>) => void = () => {}) => { const d = baseDoc(); patch(d); return d; };
const baseDoc = () => {
  const row = (localId: number, name: string, parentId: number, traits: Record<string, unknown> = {}) => ({
    localId, name, nodeGuid: g(localId),
    traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 }, ...traits },
  });
  return {
    id: P, version: 5, name: 'P', rootLocalId: 1,
    entities: [row(1, 'R', 0), row(2, 'A', 1, { Rotate3D: { axis: 'x', speed: 3 } }), row(3, 'B', 1)],
  };
};
/** O: OR → N, a reference row expanding P, stating `row` on N. */
const oDoc = (row: Record<string, unknown>): PrefabFile => ({
  id: O, version: 6, name: 'O', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'OR', nodeGuid: g(7), traits: { EntityAttributes: { name: 'OR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
    { localId: 2, name: 'N', nodeGuid: g(8), prefab: P, traits: { EntityAttributes: { name: 'N', parentId: 1, guid: '' } }, ...row },
  ],
} as unknown as PrefabFile);
const install = (d: { id?: string }) => { prefabs.set(d.id!, d); setPrefabCache(d.id!, d as never); };

/** One top-level instance of `prefab` (P by default; its entry patched by `extra`) beside a plain entity. */
const scene = (extra: Record<string, unknown> = {}, prefab = P): SceneData => ({
  id: 's1914', version: 14, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Other', parentId: 0, guid: OTHER } } },
    { id: 2, prefab, guid: ROOT1, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } }, ...extra },
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

const saved = async () => serializeScene() as unknown as Promise<SceneData>;
const entryOf = (s: SceneData) => (s.entities as unknown as Array<Record<string, unknown>>).find((e) => e.guid === ROOT1)!;
const rowOf = (s: SceneData, lid: number) => (entryOf(s).members as Record<string, Record<string, unknown>>)[`/${g(lid)}`]!;
/** Load `s`, save, load what was saved, save again: the second save, which only a kept record can reach. */
const twoSaves = async (s: SceneData) => { await load(s); const s1 = await saved(); await load(s1); return saved(); };

beforeEach(async () => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  clearKeptMemberOrphans();
  install(pDoc());
});
afterAll(() => { setPrefabCache(P, null); setPrefabCache(O, null); getCurrentWorld()?.destroy(); });

describe('a member ROW\'s unused records are written back (#1914 R4)', () => {
  // Mutation: keep no unused part of a live member's row (`unusedRowPart` returns undefined) — both go.
  it('a field no schema declares and a trait nothing registers, on B\'s row', async () => {
    const s = await twoSaves(scene({ members: { [`/${g(3)}`]: { traits: { Transform: { retiredField: 7 }, RetiredTrait: { speed: 2 } } } } }));
    expect(rowOf(s, 3).traits).toMatchObject({ Transform: { retiredField: 7 }, RetiredTrait: { speed: 2 } });
  });

  // Mutation: in `noteUnusedRemovals`, never record (`unusedRemovals.delete(src)` only) — the save re-derives B's removals
  // from the live member, finds none, and the statement goes.
  it('a removal statement of a component B\'s template never had', async () => {
    const s = await twoSaves(scene({ members: { [`/${g(3)}`]: { traitRemovals: { Rotate3D: true } } } }));
    expect(rowOf(s, 3).traitRemovals).toEqual({ Rotate3D: true });
  });

  // Mutation: drop the live check in `withUnusedPart` (`if (on && carried(t)) continue;`) — A's kept removal is written
  // beside the component it now adds, and the reload removes the component the user just added.
  it('a kept removal goes once the member carries the component again (Add Component after the template dropped it)', async () => {
    const s0 = (await (async () => { await load(scene({ members: { [`/${g(2)}`]: { removedTraits: ['Rotate3D'] } } })); return saved(); })());
    install(pDoc((d) => { delete (d.entities[1]!.traits as Record<string, unknown>).Rotate3D; }));
    await load(s0);
    const a = getAllEntities().find((e) => e.name === 'A')!.id;
    addTraitToEntitiesWithUndo([a], getTraitByName('Rotate3D')!);
    const s = await saved();
    expect(rowOf(s, 2).removedTraits).toBeUndefined();
    await load(s);
    expect(getAllEntities().find((e) => e.name === 'A')!.traits).toContain('Rotate3D');
  });
});

describe('the legacy structure channels\' unused records are written back (#1914 R4)', () => {
  // Mutation: in `unusedLocalRecords`, keep no `removed` (or no `moved`) — that channel's gone localId goes.
  it('a removal and a move of a localId the template no longer has', async () => {
    const s = await twoSaves(scene({ removed: [9], moved: { 9: OTHER } }));
    expect(entryOf(s).removed).toEqual([9]);
    expect(entryOf(s).moved).toEqual({ 9: OTHER });
  });

  // Mutation: in `unusedLocalRecords`, measure no removal of a live localId (`gone = !row ? names : []`) — B's removal of
  // a component its row never had goes with the first save.
  it('a removal of a component the member\'s document row does not define (B has no Rotate3D)', async () => {
    const s = await twoSaves(scene({ removedTraits: { 3: ['Rotate3D'] } }));
    expect(JSON.stringify(rowOf(s, 3))).toContain('Rotate3D');
  });

  // Mutation: in `unusedLegacy`, keep nothing inside a REACHED frame (drop `if (inner) nestedOverrides[key] = inner;`) — the
  // channel names N's frame, which O expands, so R2's reach test alone let it go.
  it('a nested frame\'s override of a localId that frame\'s document does not have', async () => {
    install(oDoc({}));
    const s = await twoSaves(scene({ nestedOverrides: { 2: { 9: { Transform: { x: 9 } } } } }, O));
    expect(entryOf(s).nestedOverrides).toMatchObject({ 2: { 9: { Transform: { x: 9 } } } });
  });
});

describe('a row whose member a TEMPLATE layer removed is written back (#1914 R4)', () => {
  // Mutation: in `noteUntargeted`, never mark (`untargetedRows.add(row)` → delete) — B's node is still in P, so R2's
  // document test calls the row backed, nothing spawns B, and the first save drops its record.
  it('O\'s row N removes P\'s B; the scene\'s edit of N\'s B survives, and applies again once O stops removing it', async () => {
    const edit = { [`/${g(8)}/${g(3)}`]: { traits: { Transform: { x: 5 } } } };
    install(oDoc({ members: { [`/${g(3)}`]: { removed: true } } }));
    const s = await twoSaves(scene({ members: edit }, O));
    expect((entryOf(s).members as Record<string, unknown>)[`/${g(8)}/${g(3)}`]).toMatchObject({ traits: { Transform: { x: 5 } } });
    install(oDoc({}));
    await load(s);
    const b = getAllEntities().find((e) => e.name === 'B')!.id;
    expect((readTraitData(b, getTraitByName('Transform')!) as { x: number }).x).toBe(5);
  });
});

describe('a scene-added reference node\'s unused records are written back (#1914 R4)', () => {
  // Mutation: in `captureInstanceReference`, merge nothing kept (`keptFrom` always '') — the node's record of localId 9 goes.
  it('a legacy override of a localId its template does not have', async () => {
    const node = { parentLocalId: 1, guid: NODE, name: 'Nested', prefab: P, traits: {}, children: [], overrides: { 9: { Transform: { x: 9 } } } };
    const s = await twoSaves(scene({ added: [node] }));
    const out = JSON.stringify(entryOf(s).added ?? entryOf(s).members);
    expect(out).toContain('"9":{"Transform":{"x":9}}');
  });
});

describe('a prefab-edit save writes a reference ROW\'s unused records back (#1914 R4)', () => {
  const openInEditor = async (doc: PrefabFile): Promise<number> => {
    install(doc);
    await load(buildPrefabEditScene(doc) as SceneData);
    return getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!.id;
  };
  const nRow = (p: PrefabFile) => p.entities.find((e) => e.prefab === P)! as unknown as Record<string, unknown>;

  // Mutation: in `captureRowChannels`, merge no unused part (drop the `withKeptUnused` line) — N's row loses B's field.
  it('a field no schema declares on a member row of N', async () => {
    const root = await openInEditor(oDoc({ members: { [`/${g(3)}`]: { traits: { Transform: { retiredField: 7 } } } } }));
    const out = serializePrefab(root, O)!;
    expect((nRow(out).members as Record<string, { traits?: unknown }>)[`/${g(3)}`]?.traits).toMatchObject({ Transform: { retiredField: 7 } });
  });

  // Mutation: in `captureInstanceReference`, merge nothing kept (`keptFrom` always '') — N's record of localId 9 goes.
  it('a legacy override of a localId P does not have', async () => {
    const root = await openInEditor(oDoc({ overrides: { 9: { Transform: { x: 9 } } } }));
    const out = serializePrefab(root, O)!;
    expect(nRow(out).overrides).toMatchObject({ 9: { Transform: { x: 9 } } });
  });
});

describe('a legacy move of a KEYED node is ignored at load and kept by every save (#1883 ruling C, #1914 R4)', () => {
  // O's row N adds the keyed node Extra under P's A; O's own legacy `moved` takes it out of N's frame, under OR.
  const extra = { parentLocalId: 2, guid: '', key: 'k-extra', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 6, y: 0, z: 0 } }, children: [] };
  const withMove = (): PrefabFile => ({ ...oDoc({ added: [extra] }), moved: { '2.+k-extra': '@member:2' } } as unknown as PrefabFile);
  const parentName = () => {
    const e = getAllEntities().find((x) => x.name === 'Extra')!;
    return getAllEntities().find((x) => x.id === e.parentId)?.name;
  };

  // ⚠️ NOT a falsifier of the load's filter: with `appliedMoves` taken out of `queuePrefabMoves` (and out of
  // `frameMovesOf`, and the capture's base) this stays green — the drain finds no member under such a key in this shape.
  // It pins the OUTCOME the ruling asks for. The filter's falsifier is keyedFrameIdentity.test.ts ("a legacy `moved` of
  // the keyed reference root is ignored"), whose keyed reference root the drain DOES move without it.
  it('a scene instance shows the node at its template place, and its save states no move of its own', async () => {
    install(withMove());
    await load(scene({}, O));
    expect(parentName()).toBe('A');
    const s = await saved();
    expect(JSON.stringify(entryOf(s))).not.toContain('"parent"');
  });

  // The writer's half: `keptMoves` merges under the capture. Its plumbing from the prefab-edit save is
  // keyedLegacyMove.test.ts. Mutation: `opts?.keptMoves ? … : captured` → `captured` — the move goes.
  it('serializePrefab writes the kept keyed moves back as it found them', async () => {
    install(withMove());
    await load(buildPrefabEditScene(withMove()) as SceneData);
    const root = getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!.id;
    expect(serializePrefab(root, O, { keptMoves: { '2.+k-extra': '@member:2' } })!.moved).toEqual({ '2.+k-extra': '@member:2' });
  });
});


describe('the Apply/Revert dialog counts the unused overrides an instance keeps (#1914 R5, owner ruling F6)', () => {
  const rootId = () => getAllEntities().find((e) => e.guid === ROOT1)!.id;
  const count = () => collectInstanceOverrideListing(rootId(), prefabs.get(P) as PrefabFile).unusedOverrides;

  // Mutations: count a row's `guid` and `name` (`rowRecords` skips them) — 8; count no legacy channel (`legacyRecords`
  // returns 0) — 4; count no orphan row — 5.
  it('one per statement, of every kept kind; a row\'s identity is not an override', async () => {
    await load(scene({
      members: {
        // B's unused part: 2 fields (one in a trait nothing registers) and a removal of a component B never had.
        [`/${g(3)}`]: { traits: { Transform: { retiredField: 7 }, RetiredTrait: { speed: 2 } }, traitRemovals: { Rotate3D: true } },
        // An R2 orphan (P declares no node 9): its identity, and one field.
        [`/${g(9)}`]: { guid: 'ffffffff-0000-4000-8000-000000001949', name: 'Gone', traits: { Transform: { x: 1 } } },
      },
      // Two legacy records of a localId P does not have.
      removed: [9], moved: { 9: OTHER },
    }));
    expect(count()).toBe(6);
  });

  // Mutation: count every kept part (`liveKeptUnused` keeps the part of a member that is not live) — 3.
  it('a member the instance deleted takes its records with it', async () => {
    await load(scene({ members: { [`/${g(3)}`]: { traits: { RetiredTrait: { speed: 2 } }, traitRemovals: { Rotate3D: true } } } }));
    expect(count()).toBe(2);
    const world = getCurrentWorld();
    const b = getAllEntities().find((e) => e.name === 'B')!.id;
    for (const e of world.entities) if (e.id() === b) { destroyEntity(e, world); break; }
    expect(count()).toBe(0);
  });

  // Mutation: count a removal of a component the member carries again (`carried` → false) — stays 1.
  it('a kept removal of a component the member carries again is not counted, as the save does not write it', async () => {
    const s0 = (await (async () => { await load(scene({ members: { [`/${g(2)}`]: { removedTraits: ['Rotate3D'] } } })); return saved(); })());
    install(pDoc((d) => { delete (d.entities[1]!.traits as Record<string, unknown>).Rotate3D; }));
    await load(s0);
    expect(count()).toBe(1);
    addTraitToEntitiesWithUndo([getAllEntities().find((e) => e.name === 'A')!.id], getTraitByName('Rotate3D')!);
    expect(count()).toBe(0);
  });
});

// #1914 close-out review 3: the load judged a legacy channel's frame reached through the scene's COPIES (#1867), while the
// expansion lets a copy stand in only where the scene states rows under the frame (`copyStandsIn`). A channel for a frame
// the copy did NOT expand (no rows: a frame left unexpanded at the save, beside a copy carried for another one) read as
// reached, so only its unused sliver was kept and the save dropped the rest. Mutations: drop the copy test in
// `legacyPathDoc` — the copied case red; let a copy never stand in there — the accept case below red.
describe("a scene's copy that does not stand in for a frame leaves the frame's legacy channel kept (#1914 close-out review 3)", () => {
  for (const copied of [false, true]) {
    it(`N's prefab missing${copied ? ', with the scene carrying a copy of it' : ''}: the channel survives two saves`, async () => {
      install(oDoc({}));
      prefabs.delete(P);
      setPrefabCache(P, null);
      const channel = { 2: { 2: { Transform: { x: 5 } } } };
      const s = { ...scene({ nestedOverrides: channel }, O), version: 19, ...(copied ? { embeddedPrefabs: { [P]: pDoc() } } : {}) } as SceneData;
      await load(s);
      const first = await saved();
      expect(entryOf(first).nestedOverrides).toEqual(channel);
      await load(first);
      expect(entryOf(await saved()).nestedOverrides).toEqual(channel);
    });
  }

  // ACCEPT side: where the copy DOES stand in (the scene states a row under N, as a frame live at the save does), the frame
  // is reached: A takes the channel's x, the save states it as A's row, and only the record of a localId P lacks (9) stays.
  it("where the copy stands in (a row under N), the frame is reached: only the unused record stays a channel", async () => {
    install(oDoc({}));
    prefabs.delete(P);
    setPrefabCache(P, null);
    const s = { ...scene({ members: { [`/${g(8)}/${g(3)}`]: { traits: { Transform: { y: 4 } } } },
      nestedOverrides: { 2: { 2: { Transform: { x: 5 } }, 9: { Transform: { x: 9 } } } } }, O), version: 19, embeddedPrefabs: { [P]: pDoc() } } as SceneData;
    await load(s);
    const first = await saved();
    expect(entryOf(first).nestedOverrides).toEqual({ 2: { 9: { Transform: { x: 9 } } } });
    expect((entryOf(first).members as Record<string, { traits?: unknown }>)[`/${g(8)}/${g(2)}`]?.traits).toEqual({ Transform: { x: 5 } });
  });
});
