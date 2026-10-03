/** Unused overrides (#1914 R4, owner ruling F5, docs/prefabs.md § I18): a record whose target the template no longer
 *  gives — a field no schema declares, a trait nothing registers, a removal of a component the member's base lacks, a
 *  localId the template dropped — is ignored at load and written back by every save, in the channel the file held it in,
 *  until an explicit Remove. recordedOverrideList.test.ts pins the four F5 cases in the legacy localId form; these pin the
 *  other carriers: a member ROW, a scene-added reference node, the legacy structure channels, and a prefab-edit save. */

import { preV5NodeGuid } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { ownNodes, rowsOf } from './v10Rows';
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
import { setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo } from '@modoki/engine/editor';
import { addTraitToEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { setPrefabCache, getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { serializePrefab } from '../../packages/modoki/src/editor/scene/prefabSerialize';
import { buildPrefabEditScene, serializePrefabEditWorld, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { applyToPrefabSelective, previewApply } from '../../packages/modoki/src/editor/scene/prefabApply';
import { registerTrait } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import { trait as kootaTrait } from 'koota';
import { clearMissingComponents } from '../../packages/modoki/src/runtime/core/ecs/missingComponents';
import { unusedOverridesLine } from '../../packages/modoki/src/editor/panels/applyDialogModel';
import { localIdCounter, clearReservedLocalIds } from '../../packages/modoki/src/runtime/core/localIdCounter';
import { createEntityWithUndo, deleteEntitiesWithUndo, removeMissingComponentWithUndo, duplicateEntity } from '../../packages/modoki/src/editor/undo/entityActions';
import { liveMissingSource, missingComponentRows } from '../../packages/modoki/src/editor/panels/missingComponentRows';
import { templateKeyOf } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { damagedPrefabReason } from '../../packages/modoki/src/runtime/core/damagedPrefabs';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { instanceUnusedOverrides } from '../../packages/modoki/src/editor/scene/unusedOverrides';
import { validateSceneData } from '../../packages/modoki/src/runtime/loaders/sceneValidation';
import { collectInstanceOverrideListing } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { refreshInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
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

/** `vetted`: what the load's own fetch serves in place of a cached document — the state when a nested file changed after
 *  the load checked it (a rebuild's window), so the expansion reads another document than the check did. */
async function load(data: SceneData, vetted: ReadonlyMap<string, unknown> = new Map()): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => ((vetted.get(ref) ?? prefabs.get(ref)) as object) ?? null,
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

/** `fn` with console.warn silenced (an expected refusal's warning). */
const quietly = <T,>(fn: () => T): T => { const w = vi.spyOn(console, 'warn').mockImplementation(() => {}); try { return fn(); } finally { w.mockRestore(); } };
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
  clearReservedLocalIds();
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
  // a component its row never had goes with the first save. The statement is pinned as a REMOVAL: a bare "mentions
  // Rotate3D" stayed green for a restore (`traitRemovals: {Rotate3D: false}`), the opposite statement (#1933).
  it('a removal of a component the member\'s document row does not define (B has no Rotate3D)', async () => {
    const s = await twoSaves(scene({ removedTraits: { 3: ['Rotate3D'] } }));
    // Scene v20 (#2001 S6): one form — the kept removal is the row's `traitRemovals` record.
    expect(rowOf(s, 3).traitRemovals).toEqual({ Rotate3D: true });
    expect(rowOf(s, 3).removedTraits).toBeUndefined();
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
    // Prefab v10 (#2001 S6): stated as a `parent` record on N's row for the node, the token one frame up.
    const out = serializePrefab(root, O, { keptMoves: { '2.+k-extra': '@member:2' } })!;
    expect(out.moved).toBeUndefined();
    expect(rowsOf(out.entities.find((e) => e.prefab === P))['/a+k-extra']).toEqual({ parent: '@member:^.2' });
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

  // The dialog's line (ApplyPrefabDialog renders exactly what this returns, and nothing when it is null). Mutations: show
  // the line at 0 (drop the `count > 0` test) — the first expect; lose the plural — the third.
  it('the dialog states the count as one read-only line, and shows none when nothing is kept', async () => {
    await load(scene({ removed: [9] }));
    expect(unusedOverridesLine(0)).toBeNull();
    expect(unusedOverridesLine(count())).toBe('1 unused override (kept)');
    expect(unusedOverridesLine(3)).toBe('3 unused overrides (kept)');
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

  // Where the copy stood in (the scene states a row under N, as a frame live at the save did), the frame was reached:
  // A took the channel's x and the save moved it onto A's row. Ruling B (#2001 S5, #2028): the copy is ignored, N shows a
  // Missing Prefab placeholder, and every record under it is held verbatim (rule 9) — the channel whole, and the row.
  it("where the copy stood in (a row under N): ruling B holds the channel and the row verbatim", async () => {
    install(oDoc({}));
    prefabs.delete(P);
    setPrefabCache(P, null);
    const channel = { 2: { 2: { Transform: { x: 5 } }, 9: { Transform: { x: 9 } } } };
    const s = { ...scene({ members: { [`/${g(8)}/${g(3)}`]: { traits: { Transform: { y: 4 } } } },
      nestedOverrides: channel }, O), version: 19, embeddedPrefabs: { [P]: pDoc() } } as SceneData;
    await load(s);
    const first = await saved();
    expect(entryOf(first).nestedOverrides).toEqual(channel);
    expect((entryOf(first).members as Record<string, { traits?: unknown }>)[`/${g(8)}/${g(3)}`]?.traits).toEqual({ Transform: { y: 4 } });
    expect((entryOf(first).members as Record<string, { traits?: unknown }>)[`/${g(8)}/${g(2)}`]?.traits).toBeUndefined();
  });
});

// #1933 (E7 round 4, area 4b): three carriers the #1914 close-out left with no test. Each was read correct by the review
// and is pinned here, with the mutation that turns it red.
describe('the #1914 close-out\'s untested carriers (#1933)', () => {
  // Gap 1: a template REFERENCE node's `templateMoved` (#1543) — a prefab-edit save regenerates the node's moves from the
  // live world, and a LEGACY move of a keyed node (#1883 ruling C) is applied nowhere, so no capture sees it:
  // `finishTemplateReferenceNode` lays the statement's keyed moves under the capture.
  // Fixture: O's row N (a PL) adds the reference node T (a P); P's row K (a P2) adds the keyed node Extra under X.
  const h = (n: number) => `eeeeeeee-0000-4000-8000-0000001933${String(n).padStart(2, '0')}`;
  const [PL, PT, P2, OT] = [1, 2, 3, 4].map((n) => `cccccccc-0000-4000-8000-0000001933${String(n).padStart(2, '0')}`) as [string, string, string, string];
  const ea = (name: string, parentId: number) => ({ EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } });
  const chain = () => {
    install({ id: P2, version: 9, name: 'P2', rootLocalId: 1, nextLocalId: 4, entities: [
      { localId: 1, name: 'R2', nodeGuid: h(1), traits: ea('R2', 0) }, { localId: 2, name: 'X', nodeGuid: h(2), traits: ea('X', 1) },
      { localId: 3, name: 'Y', nodeGuid: h(3), traits: ea('Y', 1) }] } as never);
    install({ id: PT, version: 9, name: 'PT', rootLocalId: 1, nextLocalId: 5, entities: [
      { localId: 1, name: 'RT', nodeGuid: h(11), traits: ea('RT', 0) }, { localId: 2, name: 'AT', nodeGuid: h(12), traits: ea('AT', 1) },
      { localId: 3, name: 'BT', nodeGuid: h(13), traits: ea('BT', 1) },
      { localId: 4, name: 'K', nodeGuid: h(14), prefab: P2, traits: { EntityAttributes: { name: 'K', parentId: 1, guid: '' } },
        added: [{ parentLocalId: 2, key: 'k-extra', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 6, y: 0, z: 0 } }, children: [] }] }] } as never);
    install({ id: PL, version: 9, name: 'PL', rootLocalId: 1, nextLocalId: 3, entities: [
      { localId: 1, name: 'LR', nodeGuid: h(21), traits: ea('LR', 0) }, { localId: 2, name: 'L', nodeGuid: h(22), traits: ea('L', 1) }] } as never);
  };
  const oWithT = (templateMoved: Record<string, string>) => ({ id: OT, version: 9, name: 'OT', rootLocalId: 1, nextLocalId: 3, entities: [
    { localId: 1, name: 'OR', nodeGuid: h(31), traits: ea('OR', 0) },
    { localId: 2, name: 'N', nodeGuid: h(32), prefab: PL, traits: { EntityAttributes: { name: 'N', parentId: 1, guid: '' } },
      added: [{ parentLocalId: 2, key: 'k-T', name: 'T', prefab: PT, traits: {}, children: [], templateMoved }] }] }) as unknown as PrefabFile;
  const parentOf = (n: string) => { const e = getAllEntities().find((x) => x.name === n)!; return getAllEntities().find((x) => x.id === e.parentId)?.name; };
  const editSave = async (doc: PrefabFile): Promise<PrefabFile> => {
    install(doc);
    await load(buildPrefabEditScene(doc) as SceneData);
    const out = serializePrefabEditWorld(OT);
    if ('error' in out) throw new Error(out.error);
    return out.prefab;
  };
  /** The moves the reference node T states (prefab v10: `parent` records on its own rows), by row key. */
  const tMoved = (doc: PrefabFile) => Object.fromEntries(Object.entries(rowsOf(ownNodes(doc.entities.find((e) => e.prefab === PL))[0])).filter(([, r]) => r.parent !== undefined).map(([k, r]) => [k, r.parent]));

  // Mutation: `templateMoved = captured` in `finishTemplateReferenceNode` (prefabCapture.ts) — the keyed-only statement
  // saves as undefined, and the mixed one loses its keyed half.
  // And for the second save, which reads the v10 node (#2001 S6): drop `keepKeyedNodeParents` from
  // `serializePrefabEditWorld` — the keyed move goes from both (measured).
  for (const [label, moved] of [
    ['a keyed legacy move alone', { '4.+k-extra': '@member:3' }],
    ['a keyed legacy move beside a live plain move', { '4.+k-extra': '@member:3', 3: '@member:2' }],
  ] as const) {
    it(`gap 1: ${label} on a template reference node survives two prefab-edit saves`, async () => {
      chain();
      const first = await editSave(oWithT(moved));
      // The keyed move applies nowhere (Extra at its template place), and a plain one is live.
      expect(parentOf('Extra')).toBe('X');
      if ('3' in moved) expect(parentOf('BT')).toBe('AT');
      // Prefab v10 (#2001 S6): each move is a `parent` record on the node's own row for the member, keyed by identity.
      const want = { [`/${h(14)}/a+k-extra`]: '@member:3', ...('3' in moved ? { [`/${h(13)}`]: '@member:2' } : {}) };
      expect(tMoved(first)).toEqual(want);
      expect(tMoved(await editSave(JSON.parse(JSON.stringify(first)) as PrefabFile))).toEqual(want);
    });
  }

  // A SCENE instance of OT once OT is v10 (#2001 S6 close-out): the node T states its move of BT as a `parent` on its own
  // row, not as `templateMoved`, and the frame record the old capture reads its template moves from (`noteNodeMoves`)
  // took only `templateMoved`. So a capture of the instance (every save here; a stale record's re-seed in the editor)
  // restated the template's move as the instance's own `parent` row, pinning BT under AT for good.
  // Mutation: note only `templateMoved` again (`templateNodeRowMoves` out of `noteFrames`, projectInstance.ts) — the v10
  // case red, nothing else. (A SCENE reference node, which `spawnReferenceNode` notes, is the next two cases.)
  for (const form of ['v9', 'v10'] as const) {
    it(`a scene instance of a ${form} OT does not restate T's template move as its own`, async () => {
      chain();
      const legacy = oWithT({ 3: '@member:2' });
      install(form === 'v9' ? legacy : await editSave(legacy));
      await load(scene({}, OT));
      expect(parentOf('BT')).toBe('AT');
      const rows = Object.entries((entryOf(await saved()).members ?? {}) as Record<string, { parent?: unknown }>);
      expect(rows.filter(([, r]) => r.parent !== undefined)).toEqual([]);
    });
  }

  // The same for a SCENE reference node (close-out re-review): a member token on its row is its converted
  // `templateMoved`, a template move (`foldInstance`, #2007 item 8), and only a guid there is the scene's own move. Once
  // a v20 save writes the node, `templateMoved` is gone, so `spawnReferenceNode` noted no move, and a no-edit save
  // rewrote BT's token as AT's guid: the template's move pinned as the scene's.
  // Mutation: drop `templateNodeRowMoves` from `spawnReferenceNode`'s note — s2's row states a guid.
  it('a scene reference node\'s template move stays a template move across two saves', async () => {
    chain();
    install(oWithT({}));
    await load(scene({ added: [{ guid: 'ffffffff-0000-4000-8000-000000193377', name: 'T', prefab: PT, parentLocalId: 1, traits: {}, children: [], templateMoved: { 3: '@member:2' } }] }, PL));
    expect(parentOf('BT')).toBe('AT');
    const btRow = (s: SceneData) => Object.entries((entryOf(s).members ?? {}) as Record<string, { own?: Array<{ members?: Record<string, { parent?: unknown }> }> }>)
      .flatMap(([, r]) => r.own ?? []).map((n) => n.members?.[`/${h(13)}`]?.parent);
    const s1 = await saved();
    expect(btRow(s1)).toEqual(['@member:2']);
    await load(s1);
    expect(parentOf('BT')).toBe('AT');
    expect(btRow(await saved())).toEqual(['@member:2']);
  });

  // ...and a guid on that row is the scene's OWN move, which must survive the capture as the scene's. A behaviour pin, not
  // the falsifier of the token filter in `templateNodeRowMoves`: with that filter off this stays green (measured), since
  // the frame record's readers parse only member tokens and skip a guid there anyway.
  it('a scene reference node\'s own move (a guid parent) is kept across a save', async () => {
    chain();
    install(oWithT({}));
    await load(scene({ added: [{ guid: 'ffffffff-0000-4000-8000-000000193377', name: 'T', prefab: PT, parentLocalId: 1, traits: {}, children: [], templateMoved: { 3: '@member:2' } }] }, PL));
    const s1 = JSON.parse(JSON.stringify(await saved())) as SceneData;
    const node = Object.values((entryOf(s1).members ?? {}) as Record<string, { own?: Array<{ members: Record<string, { parent?: unknown }> }> }>).flatMap((r) => r.own ?? [])[0]!;
    node.members[`/${h(13)}`] = { ...node.members[`/${h(13)}`], parent: OTHER };
    await load(s1);
    expect(parentOf('BT')).toBe('Other');
    const again = Object.values((entryOf(await saved()).members ?? {}) as Record<string, { own?: Array<{ members?: Record<string, { parent?: unknown }> }> }>).flatMap((r) => r.own ?? []);
    expect(again.map((n) => n.members?.[`/${h(13)}`]?.parent)).toEqual([OTHER]);
  });

  // Gap 2: `withKeptLegacy`'s `nestedOverrides` merge (#1914 R4) — a pre-v5 P has no nodeGuid, so N's members keep the
  // legacy path channel, and a live capture of N's frame meets the record the load kept as unused in that same frame.
  // Mutation: merge path-level (`{ ...kept.nestedOverrides, ...channels.nestedOverrides }`) — B's retiredField and
  // localId 9 go once B is edited. (Which side wins a leaf is not observable here: the kept part holds only what no live
  // capture can state, so the two never meet on one field.)
  it('gap 2: a live edit and a kept unused record in one legacy nested frame merge leaf by leaf', async () => {
    const pre = pDoc();
    (pre as { version: number }).version = 4;
    for (const e of pre.entities) delete (e as { nodeGuid?: string }).nodeGuid;
    install(pre);
    install(oDoc({}));
    const channel = { 2: { 3: { Transform: { x: 5, retiredField: 7 } }, 9: { Transform: { x: 9 } } } };
    await load(scene({ nestedOverrides: channel }, O));
    // Scene v20 (#2001 S6): the record a member takes is its row (keyed through N by the pre-v5 member's derived guid),
    // unknown field and all; the record of a localId the frame does not have stays held in the legacy channel.
    const bRow = (s: SceneData) => (entryOf(s).members as Record<string, Record<string, unknown>>)[`/${g(8)}/${preV5NodeGuid(P, 3)}`];
    const s1 = await saved();
    expect(bRow(s1)).toEqual({ traits: { Transform: { x: 5, retiredField: 7 } } });
    expect(entryOf(s1).nestedOverrides).toEqual({ 2: { 9: { Transform: { x: 9 } } } });
    writeTraitFieldWithUndo(getAllEntities().find((e) => e.name === 'B')!.id, getTraitByName('Transform')!, 'x', 6);
    const s2 = await saved();
    expect(bRow(s2)).toEqual({ traits: { Transform: { x: 6, retiredField: 7 } } });
    expect(entryOf(s2).nestedOverrides).toEqual({ 2: { 9: { Transform: { x: 9 } } } });
  });

  // Gap 3: Apply's filter of the prefab's own `moved` (prefabApply.ts) drops a move whose member or parent the apply
  // removed, but a legacy move of a KEYED node names nothing by design (#1883 ruling C) and is kept as the file holds it.
  // The node must be GONE (or the target): a present keyed node's path is listed by `memberPathRecords`, so the filter
  // keeps it either way. Mutation: drop `if (isKeyedMoveKey(k)) return true;` — both keyed moves go; the plain move of a
  // gone member goes either way (the control: the filter ran).
  it('gap 3: an Apply into O keeps its legacy keyed moves whose node or target is gone, and drops a plain one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response));
    try {
      const extra = { parentLocalId: 2, key: 'k-extra', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 6, y: 0, z: 0 } }, children: [] };
      const keyed = { '2.+k-gone': '@member:1', '2.+k-extra': '@member:9' };
      install({ ...oDoc({ added: [extra] }), moved: { ...keyed, 9: '@member:1' } } as unknown as PrefabFile);
      await load(scene({}, O));
      const root = getAllEntities().find((e) => e.guid === ROOT1)!.id;
      writeTraitFieldWithUndo(root, getTraitByName('Transform')!, 'x', 4);
      expect((await applyToPrefabSelective(root, new Set([`${g(7)}.Transform.x`]))).applied).toBe(true);
      // Prefab v10 (#2001 S6): the move of a node the row still adds is its row's `parent` record; one whose node is gone
      // names no member, and stays on the document as the file held it.
      const after = getCachedPrefabSync(O) as unknown as PrefabFile;
      expect(after.moved).toEqual({ '2.+k-gone': '@member:1' });
      expect(rowsOf(after.entities.find((e) => e.prefab === P))['/a+k-extra']).toEqual({ parent: '@member:^.9' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// #1933 S5 (hub ruling A): F5 keeps a legacy record of a localId the template dropped, and a document written before the
// mark (#1774) derives its mark from its rows, so a freed TOP number read as free: the next member added to P took 4, and
// the scene's kept `overrides[4]` landed on it. A loaded record now reserves the number it names.
describe('a localId a kept legacy record names is never handed out again (#1933 S5)', () => {
  // P (v5, no `nextLocalId`) once had member 4; the scene still states it.
  const withGoneFour = () => scene({ overrides: { 4: { Transform: { x: 9 } } } });

  // Mutation: drop the reservation in `unusedLocalRecords`' `has` — the counter reads 4.
  it('the counter mints past it once a scene stating it is loaded', async () => {
    expect(localIdCounter(prefabs.get(P) as PrefabFile)).toBe(4);
    await load(withGoneFour());
    expect(localIdCounter(prefabs.get(P) as PrefabFile)).toBe(5);
  });

  // The PATH-keyed channels (#1933 close-out review): a `nestedOverrides` key naming a frame row O no longer has is kept
  // whole, and its number reserved too, or a new reference row at 3 would expand a frame the record lands in. Mutation:
  // drop the reservation in `legacyPathDoc` — the counter stays 3.
  it('a nested channel naming a gone frame row reserves that row\'s number', async () => {
    const o = oDoc({}) as unknown as { version: number; entities: unknown[] };
    o.version = 4; // before the mark: rows 1 and 2 only, so the counter derives 3
    install(o as never);
    expect(localIdCounter(o as never)).toBe(3);
    await load(scene({ nestedOverrides: { 3: { 3: { Transform: { x: 9 } } } } }, O));
    expect(entryOf(await saved()).nestedOverrides).toEqual({ 3: { 3: { Transform: { x: 9 } } } });
    expect(localIdCounter(o as never)).toBe(4);
  });

  // The same mutation: Fresh is numbered 4, and the reload hands it the scene's x = 9.
  it('a member added in prefab edit after that load takes a new number, and the record stays unused', async () => {
    await load(withGoneFour());
    const s = await saved();
    await load(buildPrefabEditScene(pDoc() as unknown as PrefabFile) as SceneData);
    const root = getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!.id;
    expect(createEntityWithUndo('Fresh', root, [{ name: 'EntityAttributes', data: { name: 'Fresh', parentId: root } }, { name: 'Transform' }], () => {})).not.toBeNull();
    const out = serializePrefabEditWorld(P);
    if ('error' in out) throw new Error(out.error);
    const fresh = out.prefab.entities.find((e) => e.name === 'Fresh')!;
    expect(fresh.localId).toBe(5);
    expect((out.prefab as { nextLocalId?: number }).nextLocalId).toBeGreaterThanOrEqual(6);
    install(out.prefab);
    await load(s);
    expect((readTraitData(getAllEntities().find((e) => e.name === 'Fresh')!.id, getTraitByName('Transform')!) as { x: number }).x).toBe(0);
    expect(collectInstanceOverrideListing(getAllEntities().find((e) => e.guid === ROOT1)!.id, out.prefab).unusedOverrides).toBe(1);
  });
});

/** #1933 N1 / #1938 C-B step 1 (`overrideFate.ts`): a component this build registers no trait for is never spawned, so its
 *  absence from a live member is no removal. Every save used to write `removedTraits` (depth 1) or `traitRemovals`
 *  (deeper) for it, the listing offered it, and Apply deleted it from the prefab. A removal the FILE states is kept as an
 *  unused record instead, so it is still there when the trait registers again. Each test names its own trait: the
 *  registry has no unregister, and two of them register theirs. */
describe('a component whose trait is not registered is neither removed nor lost (#1933 N1, #1938 C-B step 1)', () => {
  const Q = 'cccccccc-0000-4000-8000-000000001943';
  const withOn3 = (name: string, data: Record<string, unknown>) => pDoc((d) => { (d.entities[2]!.traits as Record<string, unknown>)[name] = data; });
  const qDoc = (): PrefabFile => ({
    id: Q, version: 6, name: 'Q', rootLocalId: 1,
    entities: [
      { localId: 1, name: 'QR', nodeGuid: g(5), traits: { EntityAttributes: { name: 'QR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
      { localId: 2, name: 'M', nodeGuid: g(6), prefab: O, traits: { EntityAttributes: { name: 'M', parentId: 1, guid: '' } } },
    ],
  } as unknown as PrefabFile);
  const rootId = () => getAllEntities().find((e) => e.guid === ROOT1)!.id;
  const listedKeys = (doc: string) => {
    const l = collectInstanceOverrideListing(rootId(), prefabs.get(doc) as PrefabFile);
    return [...l.removedTraits.map((n) => n.key), ...l.nested];
  };
  const late = (name: string) => registerTrait({ name, trait: kootaTrait({ speed: 0 }), category: 'component', fields: { speed: { type: 'number' } } } as never);
  const bOf = () => getAllEntities().find((e) => e.name === 'B')!;

  // Mutation: drop `absenceIsRemoval(n)` from the capture's removal diff (prefabCapture.ts) — save1 states a removal at
  // every depth, the listing offers it, and Apply would remove the component.
  for (const depth of [1, 2, 3]) {
    it(`an untouched instance at depth ${depth}: no removal saved, none listed, none applied, and the save is stable`, async () => {
      install(withOn3('RetiredTraitN1a', { speed: 2 })); install(oDoc({})); install(qDoc());
      const top = depth === 1 ? P : depth === 2 ? O : Q;
      await load(scene({}, top));
      const keys = listedKeys(top);
      expect(keys.filter((k) => k.includes('RetiredTraitN1a'))).toEqual([]);
      const preview = await previewApply(rootId(), new Set(keys));
      expect(JSON.stringify(preview.effects)).not.toContain('RetiredTraitN1a');
      const s1 = await saved();
      expect(JSON.stringify(entryOf(s1))).not.toContain('RetiredTraitN1a');
      await load(s1);
      expect(JSON.stringify(entryOf(await saved()))).toBe(JSON.stringify(entryOf(s1)));
    });
  }

  // N1-a′, a component an ENCLOSING layer adds (O's row on B), which reaches the diff as a layer trait. Mutation: the same.
  it('a component an enclosing prefab layer adds to the member is not saved as removed either', async () => {
    install(oDoc({ members: { [`/${g(3)}`]: { traits: { RetiredTraitN1aa: { speed: 5 } } } } }));
    await load(scene({}, O));
    expect(JSON.stringify(entryOf(await saved()))).not.toContain('RetiredTraitN1aa');
  });

  // N1-b. Mutation: drop the unknown-component clause in `removalFate` (`takes ? 'used' : 'unused'`) — the fold reads the
  // removal as used, nothing keeps it, the capture cannot restate it, and the save drops it.
  it('a removal the file states is kept, counted, and takes effect once the trait registers', async () => {
    install(withOn3('LateTraitN1b', { speed: 2 })); install(oDoc({}));
    const depth1 = await twoSaves(scene({ members: { [`/${g(3)}`]: { removedTraits: ['LateTraitN1b'] } } }));
    expect(rowOf(depth1, 3).traitRemovals).toEqual({ LateTraitN1b: true });
    expect(collectInstanceOverrideListing(rootId(), prefabs.get(P) as PrefabFile).unusedOverrides).toBe(1);
    const depth2 = await twoSaves(scene({ members: { [`/${g(8)}/${g(3)}`]: { traitRemovals: { LateTraitN1b: true } } } }, O));
    expect((entryOf(depth2).members as Record<string, Record<string, unknown>>)[`/${g(8)}/${g(3)}`]!.traitRemovals).toEqual({ LateTraitN1b: true });
    late('LateTraitN1b');
    await load(depth1);
    expect(bOf().traits).not.toContain('LateTraitN1b');
    await load(scene());
    expect(bOf().traits, 'premise: an untouched instance spawns it now').toContain('LateTraitN1b');
  });

  // N1-c. Mutation: the capture's diff without `absenceIsRemoval` — save1 states the removal, and the registered trait
  // never comes back.
  it('an untouched save, then the trait registers: the member carries the template\'s data', async () => {
    install(withOn3('LateTraitN1c', { speed: 2 }));
    await load(scene());
    const s1 = await saved();
    late('LateTraitN1c');
    await load(s1);
    expect(readTraitData(bOf().id, getTraitByName('LateTraitN1c')!)).toMatchObject({ speed: 2 });
  });

  // N1-d. Mutation: the same — O's row on N states a removal of P's component.
  it('a prefab-edit save of a prefab whose nested child carries one writes no removal into the prefab', async () => {
    install(withOn3('RetiredTraitN1d', { speed: 2 }));
    install(oDoc({}));
    await load(buildPrefabEditScene(oDoc({}) as never) as SceneData);
    const out = serializePrefab(getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!.id, O)!;
    expect(JSON.stringify(out)).not.toContain('RetiredTraitN1d');
  });

  // The defensive half: no capture lists such a key now, so it is named directly. Mutation: drop the refusal at Apply's
  // top-level `-trait.` branch (prefabApply.ts) — the preview removes the component from P.
  it('Apply refuses a removal key for an unregistered component, and says why', async () => {
    install(withOn3('RetiredTraitN1e', { speed: 2 }));
    await load(scene());
    const preview = await previewApply(rootId(), new Set(['-trait.3.RetiredTraitN1e']));
    expect(preview.effects.map((e) => e.effect.op)).toEqual(['notApplied']);
    expect(preview.skipped.map((s) => s.reason).join()).toContain('not registered in this build');
  });

  // The keys the depth-2 and depth-3 listings offered before step 1 (read off the capture with its check removed), sent to
  // the instance's prefab (an override on its nested row) and to the nested frame's OWN template. Mutations: drop the
  // refusal in Apply's override writer (the slot `-trait.` branch) — the instance-target cases go red; drop it in the
  // template writer (`writeTemplate`) — the frame-target case goes red.
  for (const [depth, key, target] of [
    [2, `-trait.${g(8)}:${g(3)}.RetiredTraitN1f`, 'instance'],
    [3, `-trait.${g(6)}.${g(8)}:${g(3)}.RetiredTraitN1f`, 'instance'],
    [2, `-trait.${g(8)}:${g(3)}.RetiredTraitN1f`, 'frame'],
  ] as const) {
    it(`Apply refuses the depth-${depth} key too, applied to the ${target}'s prefab`, async () => {
      install(withOn3('RetiredTraitN1f', { speed: 2 })); install(oDoc({})); install(qDoc());
      await load(scene({}, depth === 2 ? O : Q));
      const preview = await previewApply(rootId(), new Set([key]), { perKey: { [key]: target } });
      expect(preview.effects.map((e) => e.effect.op)).toEqual(['notApplied']);
      expect(preview.skipped.map((s) => s.reason).join()).toContain('not registered in this build');
    });
  }
});

/** #1933 L2: a field recorded on a trait that is a TAG (a component that became one) persists nowhere, so it is unused
 *  data: kept, written back and counted, while the tag itself still applies. */
describe('a field recorded on a tag is kept as unused (#1933 L2)', () => {
  const count = () => collectInstanceOverrideListing(getAllEntities().find((e) => e.guid === ROOT1)!.id, prefabs.get(P) as PrefabFile).unusedOverrides;
  const bHasPersistent = () => getAllEntities().find((e) => e.name === 'B')!.traits.includes('Persistent');

  // Mutation: restore the tag skip in `unusedTraitsPart` (`if (meta.category === 'tag') continue;`) — both forms drop x.
  it('on a member row', async () => {
    const s = await twoSaves(scene({ members: { [`/${g(3)}`]: { traits: { Persistent: { x: 4242 } } } } }));
    expect(rowOf(s, 3).traits).toMatchObject({ Persistent: { x: 4242 } });
    expect(bHasPersistent()).toBe(true);
    expect(count()).toBe(1);
  });

  it('in the legacy localId form', async () => {
    const s = await twoSaves(scene({ overrides: { 3: { Persistent: { x: 4242 } } } }));
    expect(JSON.stringify(entryOf(s))).toContain('4242');
    expect(bHasPersistent()).toBe(true);
    expect(count()).toBe(1);
  });
});

/** #1933 L1 / #1938 C-B step 3: the dialog's count reads the save's own projection (`unusedForSave`), so a kept legacy
 *  removal the member carries the component of again is neither written nor counted. */
describe('the count states what the save writes: a kept legacy removal of a component the member carries again (#1933 L1)', () => {
  const count = () => collectInstanceOverrideListing(getAllEntities().find((e) => e.guid === ROOT1)!.id, prefabs.get(P) as PrefabFile).unusedOverrides;
  // Mutations: the count reads the legacy store raw (`legacyRecords(keptLegacyChannels(rootGuid))`) — red on the count
  // after Add Component; drop the carried filter from `unusedForSave` — red on the count AND on the save.
  for (const version of [5, 4]) {
    it(`v${version} prefab: after Add Component the count is 0, the save writes no removal, and a reload counts 0`, async () => {
      install(pDoc((d) => { d.version = version; }));
      await load(scene({ removedTraits: { 3: ['Rotate3D'] } }));
      expect(count(), 'premise: B lacks Rotate3D, so the removal is kept unused').toBe(1);
      addTraitToEntitiesWithUndo([getAllEntities().find((e) => e.name === 'B')!.id], getTraitByName('Rotate3D')!);
      expect(count()).toBe(0);
      const s = await saved();
      expect(JSON.stringify(entryOf(s))).not.toMatch(/removedTraits|traitRemovals/);
      await load(s);
      expect(count()).toBe(0);
    });
  }
});

/** #1933 N1b / #1938 F-CB3's data half (owner ruling 2026-10-01: build the data, park the Inspector row): a component
 *  whose trait this build does not register is kept for its entity, verbatim, and written back by every writer that
 *  builds an entity's traits from the live world. Before it, a save silently erased the data. */
describe('an unregistered component on an ordinary entity survives a save (#1933 N1b)', () => {
  const PLAIN = 'dddddddd-0000-4000-8000-000000001944';
  const NEWNODE = 'dddddddd-0000-4000-8000-000000001945';
  const plainScene = (extra: Record<string, unknown> | null) => ({
    id: 's1933', version: 19, name: 'S', resources: [],
    entities: [{ id: 1, traits: { EntityAttributes: { name: 'Plain', parentId: 0, guid: PLAIN }, Transform: { x: 1, y: 0, z: 0 }, ...(extra ?? {}) } }],
  } as unknown as SceneData);
  const plainOf = (s: SceneData) => (s.entities as unknown as Array<{ traits: Record<string, unknown> }>).find((e) => (e.traits.EntityAttributes as { guid?: string })?.guid === PLAIN)!;
  beforeEach(() => clearMissingComponents());

  // Mutations: drop the merge in `serializeScene` — save1 lacks it; record nothing at the plain spawn (loadSceneFile) — the
  // same.
  it('a plain entity: written back verbatim, and save -> reload -> save is byte-identical', async () => {
    await load(plainScene({ RetiredTraitN1bA: { speed: 3, nested: { k: [1, 2] } } }));
    const s1 = await saved();
    expect(plainOf(s1).traits.RetiredTraitN1bA).toEqual({ speed: 3, nested: { k: [1, 2] } });
    await load(s1);
    expect(JSON.stringify((await saved()).entities), 'the scene id is minted per save outside the scene manager').toBe(JSON.stringify(s1.entities));
  });

  // Mutation: record only a non-empty bag (skip the delete in `setMissingComponents`) — the component comes back.
  it('a reload of the file without it clears the record: a component taken out outside the editor stays out', async () => {
    await load(plainScene({ RetiredTraitN1bB: { speed: 3 } }));
    await load(plainScene(null));
    expect(plainOf(await saved()).traits.RetiredTraitN1bB).toBeUndefined();
  });

  // Mutation: drop the merge in `serializePrefabBody` (prefabSerialize.ts) — the row loses it.
  it('a prefab-edit save keeps it on the prefab\'s own row', async () => {
    const doc = pDoc((d) => { (d.entities[2]!.traits as Record<string, unknown>).RetiredTraitN1bC = { speed: 4 }; }) as unknown as PrefabFile;
    install(doc);
    await load(buildPrefabEditScene(doc) as SceneData);
    const out = serializePrefabEditWorld(P);
    if ('error' in out) throw new Error(out.error);
    expect(out.prefab.entities.find((e) => e.localId === 3)!.traits.RetiredTraitN1bC).toEqual({ speed: 4 });
  });

  // Mutations: drop the merge in `snapshotAddedTraits` (prefabCapture.ts) — the node loses it; record nothing at the
  // added-node spawn (loadSceneFile) — the same.
  it('a node the scene added inside an instance keeps it', async () => {
    const node = { parentLocalId: 1, guid: NEWNODE, name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0, guid: NEWNODE }, Transform: { x: 0, y: 0, z: 0 }, RetiredTraitN1bD: { speed: 5 } }, children: [] };
    const s1 = await twoSaves(scene({ added: [node] }));
    expect(JSON.stringify(entryOf(s1))).toContain('"RetiredTraitN1bD":{"speed":5}');
  });

  // #1948 F2: a TEMPLATE node (keyed, no guid of its own) in a prefab's own `added` — the prefab-edit save rebuilds it from
  // the live world, so "its prefab keeps it" was false there. Mutations: record nothing for a guid-less node at the spawn
  // (`if (!meta) { if (node.guid) …`) — the node loses it; drop the drain's record loop — the same.
  const tNode = (traits: Record<string, unknown> = {}) => ({ parentLocalId: 2, guid: '', key: 'k-t', name: 'TNode', traits: { EntityAttributes: { name: 'TNode', parentId: 0 }, Transform: { x: 1, y: 0, z: 0 }, ...traits }, children: [] });
  const tNodeOf = (out: ReturnType<typeof serializePrefabEditWorld>) => {
    if ('error' in out) throw new Error(out.error);
    return ownNodes(out.prefab.entities.find((e) => e.localId === 2)).find((n) => n.key === 'k-t') as { key?: string; traits: Record<string, unknown> };
  };
  // ── #1944, the UI half: the Inspector row and its Remove — the one deliberate act that drops the data. ──
  // Mutations: removeMissingComponent leaves the name in the bag — save 1 keeps it; the undo's restore is a no-op — the
  // undone save lacks it; no _pushAction — nothing to undo, and the scene does not read as unsaved.
  it('#1944: the row shows it, Remove drops it from the next save, undo puts it back verbatim, redo drops it again', async () => {
    await load(plainScene({ RetiredTraitN1bR: { speed: 3, nested: { k: [1] } } }));
    const id = getAllEntities().find((e) => e.name === 'Plain')!.id;
    expect(missingComponentRows([id], liveMissingSource)).toEqual([{ name: 'RetiredTraitN1bR', removeRefusal: null }]);

    expect(removeMissingComponentWithUndo([id], 'RetiredTraitN1bR')).toBeNull();
    expect(missingComponentRows([id], liveMissingSource)).toEqual([]);
    const { peekUndo } = await import('../../packages/modoki/src/editor/undo/undoManager');
    expect(peekUndo()?.label, 'one undo entry — what marks the scene as owing a save').toBe('Remove Missing RetiredTraitN1bR');
    expect(plainOf(await saved()).traits.RetiredTraitN1bR).toBeUndefined();

    const { undo, redo } = await import('../../packages/modoki/src/editor/undo/undoManager');
    await undo();
    expect(plainOf(await saved()).traits.RetiredTraitN1bR).toEqual({ speed: 3, nested: { k: [1] } });
    await redo();
    expect(plainOf(await saved()).traits.RetiredTraitN1bR).toBeUndefined();
  });

  // Mutations: drop `missing` from snapshotEntity — the copy has no row and saves without it; record nothing in
  // respawnFromSnapshot — the same; keep the source's guid on the copy's record — the copy's entry lacks it.
  it('#1944: a duplicate carries its missing components under its own guid, and the original keeps them', async () => {
    await load(plainScene({ RetiredTraitDup: { speed: 4 } }));
    const id = getAllEntities().find((e) => e.name === 'Plain')!.id;
    const copy = duplicateEntity(id, () => {})!;
    expect(copy).not.toBe(id);
    expect(missingComponentRows([copy], liveMissingSource).map((r) => r.name)).toEqual(['RetiredTraitDup']);
    const ents = (await saved()).entities as unknown as Array<{ traits: Record<string, unknown> }>;
    expect(ents).toHaveLength(2);
    const guids = ents.map((e) => (e.traits.EntityAttributes as { guid: string }).guid);
    expect(new Set(guids).size, 'premise: the copy has its own guid').toBe(2);
    for (const e of ents) expect(e.traits.RetiredTraitDup, (e.traits.EntityAttributes as { guid: string }).guid).toEqual({ speed: 4 });
    // Its own record, not a shared one: removing it from the copy leaves the original's.
    removeMissingComponentWithUndo([copy], 'RetiredTraitDup');
    expect(plainOf(await saved()).traits.RetiredTraitDup).toEqual({ speed: 4 });
  });

  // Mutation: isTemplateMember answers true for the root (drop `t.rootId !== id`) — the root's Remove is refused.
  it('#1944: an instance ROOT\'s extra component is the scene entry\'s own, so Remove runs and the save drops it', async () => {
    await load(scene({ traits: { EntityAttributes: { name: 'Inst', parentId: 0 }, RetiredTraitRootR: { speed: 9 } } }));
    const root = getAllEntities().find((e) => (e as { guid?: string }).guid === ROOT1)!.id;
    expect(missingComponentRows([root], liveMissingSource)).toEqual([{ name: 'RetiredTraitRootR', removeRefusal: null }]);
    expect(removeMissingComponentWithUndo([root], 'RetiredTraitRootR')).toBeNull();
    expect((entryOf(await saved()).traits as Record<string, unknown>).RetiredTraitRootR).toBeUndefined();
  });

  // The refuse side. Mutation: liveMissingSource.isTemplateMember always false — the Remove runs and reports nothing.
  it('#1944: a TEMPLATE node of an instance (its prefab holds the component) refuses Remove and keeps the record', async () => {
    install(oDoc({ added: [tNode({ RetiredTraitTplR: { speed: 6 } })] }));
    await load(scene({}, O));
    const t = getAllEntities().find((e) => e.name === 'TNode')!.id;
    const rows = missingComponentRows([t], liveMissingSource);
    expect(rows.map((r) => r.name), 'premise: the template node carries the record').toEqual(['RetiredTraitTplR']);
    expect(rows[0]!.removeRefusal).toMatch(/Prefab Mode/);
    const refused = quietly(() => { const e = vi.spyOn(console, 'error').mockImplementation(() => {}); try { return removeMissingComponentWithUndo([t], 'RetiredTraitTplR'); } finally { e.mockRestore(); } });
    expect(refused).toMatch(/Prefab Mode/);
    expect(missingComponentRows([t], liveMissingSource).map((r) => r.name)).toEqual(['RetiredTraitTplR']);
  });

  it('a template node in a prefab\'s own `added` keeps it through a prefab-edit save, and the next save is the same', async () => {
    const doc = oDoc({ added: [tNode({ RetiredTraitN1bE: { speed: 6 } })] });
    install(doc);
    await load(buildPrefabEditScene(doc) as SceneData);
    const saved1 = serializePrefabEditWorld(O);
    const first = tNodeOf(saved1);
    expect(first.traits.RetiredTraitN1bE).toEqual({ speed: 6 });
    // The second save reads what the first wrote: the node in the row's `own` (prefab v10, #2001 S6).
    const again = JSON.parse(JSON.stringify((saved1 as { prefab: PrefabFile }).prefab)) as PrefabFile;
    install(again);
    await load(buildPrefabEditScene(again) as SceneData);
    expect(JSON.stringify(tNodeOf(serializePrefabEditWorld(O)))).toBe(JSON.stringify(first));
  });

  // #1948 close-out R1: a template node destroyed later in the load (its anchor N removed by the instance) frees its id;
  // a scene-added node spawned after takes it. Queued by bare id, the drain recorded TNode's bag onto that node, over its
  // own. Mutation: resolve the queued entry by id at the drain (`findEntityById(entity.id())`, no handle check) — SN1
  // carries RetiredTraitRecycle and loses RetiredTraitSN.
  it('a template node destroyed in the load: its component lands on no other entity, and that entity keeps its own', async () => {
    install(oDoc({ added: [tNode({ RetiredTraitRecycle: { speed: 6 } })] }));
    const sn = (i: number, traits: Record<string, unknown> = {}) => ({ parentLocalId: 1, guid: `dddddddd-0000-4000-8000-00000019485${i}`, name: `SN${i}`, traits: { EntityAttributes: { name: `SN${i}`, parentId: 0, guid: `dddddddd-0000-4000-8000-00000019485${i}` }, Transform: { x: i, y: 0, z: 0 }, ...traits }, children: [] });
    const s = await twoSaves(scene({ members: { [`/${g(8)}`]: { removed: true } }, added: [sn(1, { RetiredTraitSN: { speed: 1 } }), sn(2), sn(3)] }, O));
    expect(JSON.stringify(s), 'TNode\'s component reaches no entity').not.toContain('RetiredTraitRecycle');
    const sn1 = ((entryOf(s).members as Record<string, { own?: Array<{ name: string; traits: Record<string, unknown> }> }>)['/']!.own!).find((n) => n.name === 'SN1')!;
    expect(sn1.traits.RetiredTraitSN).toEqual({ speed: 1 });
  });

  // The clear side: the derived guid is the same at every load, so a record left from the last one would put back a
  // component the file no longer holds. Mutation: queue only a node that HAS missing components — it comes back.
  it('a template node reloaded without it: the component stays out', async () => {
    const withIt = oDoc({ added: [tNode({ RetiredTraitN1bF: { speed: 6 } })] });
    install(withIt);
    await load(buildPrefabEditScene(withIt) as SceneData);
    const without = oDoc({ added: [tNode()] });
    install(without);
    await load(buildPrefabEditScene(without) as SceneData);
    expect(tNodeOf(serializePrefabEditWorld(O)).traits.RetiredTraitN1bF).toBeUndefined();
  });

  // On an INSTANCE of O the node is the template's, and the scene save states nothing about it. Red under both mutations
  // above: unrecorded, the live node lacks the component its template states, and the save wrote a spurious
  // `traitRemovals: { RetiredTraitN1bG: true }` on `/N/a+k-t` (#1933 N1's class, on a template node).
  it('an untouched instance of a prefab whose template node carries it: the scene save writes nothing of it', async () => {
    install(oDoc({ added: [tNode({ RetiredTraitN1bG: { speed: 6 } })] }));
    const s = await twoSaves(scene({}, O));
    expect(JSON.stringify(s)).not.toContain('RetiredTraitN1bG');
  });
});

/** #1933 S3 / #1938 C-B step 2 (owner ruling F-CB1 (a)): a value of a shape no reader takes is split off at the file
 *  boundary, kept verbatim, warned about once, counted, and written back where the save states nothing there. Before, one
 *  (`removed` not an array) crashed the load, and the rest were dropped silently (the design battery's E2–E7, B6, B3a). */
describe('a value in a shape no reader takes is kept as written (#1933 S3)', () => {
  const at = (o: unknown, path: string[]) => path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);
  const B = `/${g(3)}`;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());
  const warnings = (part: string) => warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes(part));
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ['E8 legacy removed "x"', { removed: 'x4242' }, ['removed']],
    ['B6 legacy removedTraits entry not a list', { removedTraits: { 3: 'RetiredTraitZ' } }, ['removedTraits', '3']],
    ['E7 legacy overrides entry not a bag', { overrides: { 3: 'x4242' } }, ['overrides', '3']],
    ['legacy nestedStructure slot not a record', { nestedStructure: { 5: 'x4242' } }, ['nestedStructure', '5']],
    ['E3 member row traits a number', { members: { [B]: { traits: 4242 } } }, ['members', B, 'traits']],
    ['B3a member row trait data a number', { members: { [B]: { traits: { Transform: 4242 } } } }, ['members', B, 'traits', 'Transform']],
    ['E4 member row removedTraits a string', { members: { [B]: { removedTraits: 'RetiredTraitZ' } } }, ['members', B, 'removedTraits']],
    ['E5 member row added a record', { members: { [B]: { added: { x: 4242 } } } }, ['members', B, 'added']],
    ['E6 member row removed a string', { members: { [B]: { removed: 'yes4242' } } }, ['members', B, 'removed']],
    // Close-out review #2: these crashed the expansion, which read the entry unsplit.
    ['entry added a string', { added: 'xy4242' }, ['added']],
    ['entry added a node that is no record', { added: [4242] }, ['added']],
    ['entry added a node with no traits', { added: [{ parentLocalId: 1, guid: NODE, name: 'Bare', children: [] }] }, ['added']],
  ];
  // Mutations: hand the entry to the settle unsplit (`entryRowsOf` keeps `entry`) — E8 crashes the load, the rest drop;
  // keep nothing (`keepUnusedLegacy` drops `malformed`) — every case drops; never write it back (`withMalformedBack`
  // returns the owner) — every case drops.
  for (const [name, extra, path] of cases) {
    it(`${name}: kept verbatim, warned once, counted, and byte-stable`, async () => {
      await load(scene(extra));
      const warned = warnings('in a shape no reader takes');
      expect(warned.length, 'one warning').toBe(1);
      expect(warned[0]).toContain(path.join('.'));
      const root = getAllEntities().find((e) => e.guid === ROOT1)!.id;
      expect(instanceUnusedOverrides(root), 'counted as an unused (kept) override').toBeGreaterThanOrEqual(1);
      const s1 = await saved();
      expect(at(entryOf(s1), path)).toEqual(at(extra, path));
      await load(s1);
      const s2 = await saved();
      expect(JSON.stringify(s2.entities)).toBe(JSON.stringify(s1.entities));
    });
  }

  // E2: a member row that is no record cannot sit beside the identity row the save writes for every keyed member (its
  // guid and name), so the save's row wins and the value is reported — not dropped unsaid.
  it('E2 member row a string: the save\'s identity row wins, and the value is reported', async () => {
    await load(scene({ members: { [B]: 'oops4242' } }));
    expect(warnings('in a shape no reader takes').join()).toContain(`members.${B}`);
    const s = await saved();
    expect(typeof at(entryOf(s), ['members', B])).toBe('object');
    expect(warnings('not written back').join()).toContain(`members.${B}`);
  });

  // Mutation: drop the split in the settle's reference-node loop — the node's `removed` crashes the load.
  it('a scene-added reference node\'s own malformed value: kept on the node', async () => {
    const node = { parentLocalId: 1, guid: NODE, prefab: P, name: 'Ref', traits: { EntityAttributes: { name: 'Ref', parentId: 0, guid: NODE } }, children: [], removed: 'x4242' };
    const s = await twoSaves(scene({ added: [node] }));
    expect(JSON.stringify(entryOf(s))).toContain('"removed":"x4242"');
  });

  // Close-out review #2. Mutations: hand the expansion the entry unsplit (`onInstantiatePrefab` gets `entry`'s channels) —
  // the load crashes, and `removed` removes B; the same in `spawnReferenceNode` — the node's `added` crashes the load.
  it('the expansion reads the split channels: a nested slot\'s added, a reference node\'s own added, a mixed removed', async () => {
    install(oDoc({}));
    const s1 = await twoSaves(scene({ nestedStructure: { 2: { added: 'xy4242' } } }, O));
    expect(at(entryOf(s1), ['nestedStructure', '2', 'added'])).toBe('xy4242');
    const node = { parentLocalId: 1, guid: NODE, prefab: P, name: 'Ref', traits: { EntityAttributes: { name: 'Ref', parentId: 0, guid: NODE } }, children: [], added: 'xy4242' };
    const s2 = await twoSaves(scene({ added: [node] }));
    expect(JSON.stringify(entryOf(s2))).toContain('"added":"xy4242"');
    await load(scene({ removed: [3, 'x4242'] }));
    expect(getAllEntities().some((e) => e.name === 'B'), 'a removal kept as malformed is not applied').toBe(true);
    expect(entryOf(await saved()).removed).toEqual([3, 'x4242']);
  });

  // Re-review A: a node that states no `children` is a leaf — well formed (`isNodeList` admits it), so the spawner must
  // take it. Mutation: iterate `node.children` unguarded in the spawner — the load throws.
  it('a node stating no children spawns as a leaf, as an entry\'s node and a member row\'s own node', async () => {
    const leaf = (guid: string, name: string) => ({ parentLocalId: 1, guid, name, traits: { EntityAttributes: { name, parentId: 0, guid }, Transform: { x: 0, y: 0, z: 0 } } });
    const OWNED = 'dddddddd-0000-4000-8000-000000001948';
    await load(scene({ added: [leaf(NODE, 'Leaf')], members: { [B]: { own: [{ ...leaf(OWNED, 'OwnLeaf'), parentLocalId: 3 }] } } }));
    expect(getAllEntities().filter((e) => e.name === 'Leaf' || e.name === 'OwnLeaf').map((e) => e.name).sort()).toEqual(['Leaf', 'OwnLeaf']);
    expect(warnings('in a shape no reader takes')).toEqual([]);
  });

  // Mutation: write the kept value over the save's own (`restoreMalformed` ignores what is there) — the delete is undone.
  it('a value the save now states its own in place of is not written back: the user\'s delete wins', async () => {
    await load(scene({ members: { [B]: { removed: 'yes4242' } } }));
    const b = getAllEntities().find((e) => e.name === 'B')!.id;
    deleteEntitiesWithUndo([b]);
    const s = await saved();
    expect(at(entryOf(s), ['members', B, 'removed'])).toBe(true);
    expect(warnings('not written back').join()).toContain(`members.${B}.removed`);
  });

  // Mutation: drop the validator's split — no warning.
  it('the validator warns about it, as the load does', () => {
    const { warnings } = validateSceneData(scene({ removed: 'x4242' }));
    expect(warnings.some((x) => x.includes('shape no reader takes') && x.includes('removed'))).toBe(true);
  });
});

/** #1933 S4 (owner ruling F-CB2 (a)): inside a REACHED frame, a legacy `nestedStructure` slot's records with no target —
 *  a removal of a localId the template has since deleted, a removedTraits entry of one — were dropped by the first save,
 *  where the `nestedOverrides` twin kept them. They are kept now, and merged into the frame's live slot before the move
 *  onto rows, so that frame stays one whole slot: its live lists plus the record (a bare kept slot would replace the
 *  frame's lists — a slot owns all three). */
describe('a reached slot\'s records with no target are kept (#1933 S4)', () => {
  const slotOf = (s: SceneData) => (entryOf(s).nestedStructure as Record<string, { removed?: number[]; removedTraits?: Record<string, string[]> }> | undefined)?.['2'];
  const named = (n: string) => getAllEntities().filter((e) => e.name === n);
  const ROT_REMOVED_ON_A = { removedTraits: { 2: ['Rotate3D'] } };

  // Mutation: keep nothing of a reached slot in `unusedLegacy` (the pre-fix `continue`) — 9 is gone after the first save.
  it('a mixed slot (B removed, 9 gone): B stays removed, 9 is kept, counted and byte-stable', async () => {
    install(oDoc({}));
    await load(scene({ nestedStructure: { 2: { removed: [3, 9] } } }, O));
    expect(named('B').length, 'premise: B removed').toBe(0);
    const root = getAllEntities().find((e) => e.guid === ROOT1)!.id;
    expect(instanceUnusedOverrides(root)).toBeGreaterThanOrEqual(1);
    const s1 = await saved();
    expect(slotOf(s1)?.removed).toContain(9);
    await load(s1);
    expect(named('B').length).toBe(0);
    const s2 = await saved();
    expect(JSON.stringify(s2.entities)).toBe(JSON.stringify(s1.entities));
  });

  // Mutation: no merge before the move onto rows (`withKeptSlots` returns the live slots, nothing merged) — the kept slot
  // goes in bare after it, replaces the frame's lists, and A gets back the Rotate3D O's row removes.
  it('a kept-only record beside the row\'s own removedTraits: A keeps its removal across save and reload', async () => {
    install(oDoc(ROT_REMOVED_ON_A));
    await load(scene({ nestedStructure: { 2: { removed: [9], ...ROT_REMOVED_ON_A } } }, O));
    expect(named('A')[0]!.traits, 'premise').not.toContain('Rotate3D');
    const s1 = await saved();
    expect(slotOf(s1)?.removed).toContain(9);
    await load(s1);
    expect(named('A')[0]!.traits).not.toContain('Rotate3D');
    const s2 = await saved();
    expect(JSON.stringify(s2.entities)).toBe(JSON.stringify(s1.entities));
  });

  // Mutation: merge a kept slot SHALLOW (`mergeSlot` returns the live slot) — the gone localId's entry is dropped.
  it('a removedTraits entry of a gone localId is kept beside the live slot\'s own', async () => {
    install(oDoc(ROT_REMOVED_ON_A));
    await load(scene({ nestedStructure: { 2: { removedTraits: { 2: ['Rotate3D'], 9: ['Rotate3D'] } } } }, O));
    const s1 = await saved();
    expect(slotOf(s1)?.removedTraits?.['9']).toEqual(['Rotate3D']);
    await load(s1);
    expect(slotOf(await saved())?.removedTraits?.['9']).toEqual(['Rotate3D']);
  });
});

/** #1937 C-A step 3, T6: a key one frame's nodes repeat names NEITHER node, and every reader asks the one index
 *  (`frameKeyIndex`) for that verdict. The repeat a seat cannot refuse is the scene's own root frame — an entry's `added`
 *  is not a prefab document — where a hand edit or merge can give two nodes one key. `applyNodeRows` applied the row to
 *  neither while the load's own map (`templateFrameNodes`, last wins) called it backed, so it was neither applied nor kept,
 *  and the first save dropped it. (O adding a node AT a nested row whose own row declares the key, L5, is not this:
 *  there the layers' lists are separate, the row applies to the one its list names, and the load agrees.) */
describe('a row on a key the frame repeats is kept as unused (#1937 T6)', () => {
  const node = (name: string, guid: string, x: number) => ({ parentLocalId: 1, guid, key: 'k1', name, traits: { EntityAttributes: { name, parentId: 0, guid }, Transform: { x, y: 0, z: 0 } }, children: [] });
  const ROW = '/a+k1';
  const members = { [ROW]: { traits: { Transform: { x: 55 } } } };
  const xOf = (name: string) => getAllEntities().filter((e) => e.name === name).map((e) => (readTraitData(e.id, getTraitByName('Transform')!) as { x: number }).x);
  const added = (twice: boolean) => [node('K1', 'aaaaaaaa-0000-4000-8000-000000019371', 1), ...(twice ? [node('K2', 'aaaaaaaa-0000-4000-8000-000000019372', 2)] : [])];

  it('control: one node holds the key — the row applies to it, and is not unused', async () => {
    await load(scene({ added: added(false), members }));
    expect(xOf('K1')).toEqual([55]);
    expect(instanceUnusedOverrides(getAllEntities().find((e) => e.guid === ROOT1)!.id)).toBe(0);
  });

  // Mutation: `templateFrameNodes` keeps its own last-wins map (no `frameKeyIndex`) — the row reads as backed, applies to
  // neither node, and the save drops it.
  it('two nodes hold it: neither takes the row; it is kept, counted, and byte-stable', async () => {
    await load(scene({ added: added(true), members }));
    expect([...xOf('K1'), ...xOf('K2')], 'neither node takes it').toEqual([1, 2]);
    expect(instanceUnusedOverrides(getAllEntities().find((e) => e.guid === ROOT1)!.id)).toBeGreaterThanOrEqual(1);
    const s1 = await saved();
    expect((entryOf(s1).members as Record<string, unknown> | undefined)?.[ROW]).toEqual(members[ROW]);
    await load(s1);
    const s2 = await saved();
    expect(JSON.stringify(s2.entities)).toBe(JSON.stringify(s1.entities));
  });
});

/** #1937 C-A step 4, T7 (#1933 S2, cross-document): a frame whose chain repeats a key across two documents (L5: O adds
 *  Dup1 AT nested row QA under the key PN's row QA gives Dup9) stated EVERY anchor of the frame as a whole list on the
 *  first save of an untouched instance, pinning the template's lists (I23). The diff now states nothing about the
 *  repeated nodes and the rest node by node: an untouched instance writes no `members`. */
describe('an untouched instance whose frame repeats a key across two documents writes nothing (#1937 T7)', () => {
  const PN = 'cccccccc-0000-4000-8000-000000001946';
  const dupNode = (x: number) => ({ parentLocalId: 2, guid: '', key: 'k-dup', name: `Dup${x}`, traits: { EntityAttributes: { name: `Dup${x}`, parentId: 0 }, Transform: { x, y: 0, z: 0 } }, children: [] });
  const keep = { parentLocalId: 3, guid: '', key: 'k-keep', name: 'Keep', traits: { EntityAttributes: { name: 'Keep', parentId: 0 }, Transform: { x: 4, y: 0, z: 0 } }, children: [] };
  /** PN: QR → QA, a P row whose layer adds Dup9 (k-dup) under P's A and Keep under P's B. */
  const pnDoc = () => ({ id: PN, version: 9, name: 'PN', rootLocalId: 1, entities: [
    { localId: 1, name: 'QR', nodeGuid: g(5), traits: { EntityAttributes: { name: 'QR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
    { localId: 2, name: 'QA', nodeGuid: g(6), prefab: P, traits: { EntityAttributes: { name: 'QA', parentId: 1, guid: '' } }, added: [dupNode(9), keep] },
  ] });
  /** O: OR → N, a PN row whose member row on P's A (inside QA) adds Dup1 under the same key: both in one frame's chain,
   *  at one anchor, from two documents. */
  const o = () => ({ id: O, version: 9, name: 'O', rootLocalId: 1, entities: [
    { localId: 1, name: 'OR', nodeGuid: g(7), traits: { EntityAttributes: { name: 'OR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
    { localId: 2, name: 'N', nodeGuid: g(8), prefab: PN, traits: { EntityAttributes: { name: 'N', parentId: 1, guid: '' } },
      members: { [`/${g(6)}/${g(2)}`]: { own: [{ ...dupNode(1), parentLocalId: 0 }] } } },
  ] });
  /** The load's check reads PN with Dup9 on a key of its own; the expansion reads the repeating PN — a nested file
   *  changed after the check (#1933 L5 refuses this shape at the load, so only a rebuild's window reaches it). */
  const vetted = () => new Map<string, unknown>([[PN, { ...pnDoc(), entities: pnDoc().entities.map((e) => (e.localId === 2 ? { ...e, added: [{ ...dupNode(9), key: 'k-vetted' }, keep] } : e)) }]]);
  /** Statement rows: a member row beyond the identity (guid, name) every keyed member gets. */
  const statements = (s: SceneData) => Object.fromEntries(Object.entries((entryOf(s).members ?? {}) as Record<string, Record<string, unknown>>)
    .filter(([k, r]) => k !== '/' && Object.keys(r).some((x) => x !== 'guid' && x !== 'name'))); // the `"/"` row names the root (v20)

  // Mutation: restore the `twice` branch (every anchor of the frame whole) — the save writes N/QA's lists.
  it('saved untouched: no members, and a reload saves the same', async () => {
    install(pnDoc()); install(o());
    await load(scene({}, O), vetted());
    expect(getAllEntities().filter((e) => e.name.startsWith('Dup')).length, 'premise: both nodes spawned').toBe(2);
    const s1 = await saved();
    expect(statements(s1)).toEqual({});
    expect(entryOf(s1).nestedStructure).toBeUndefined();
    await load(s1, vetted());
    expect(JSON.stringify((await saved()).entities)).toBe(JSON.stringify(s1.entities));
  });

  // T16. Mutation: `repeatedTemplateKeyRefusal` returns null — the write goes through, and the save drops it unsaid.
  it('an edit to either repeated node is refused with the reason; the frame\'s other keyed node is not', async () => {
    install(pnDoc()); install(o());
    await load(scene({}, O), vetted());
    const tf = getTraitByName('Transform')!;
    for (const d of getAllEntities().filter((e) => e.name.startsWith('Dup'))) {
      expect(writeTraitFieldWithUndo(d.id, tf, 'x', 31), d.name).toMatch(/key k-dup in one place/);
      expect((readTraitData(d.id, tf) as { x: number }).x).not.toBe(31);
    }
    // The accept side, the gate's other half: the frame's other keyed node takes its edit.
    expect(writeTraitFieldWithUndo(getAllEntities().find((e) => e.name === 'Keep')!.id, tf, 'x', 31)).toBeFalsy();
  });

  // The accept side for the repeated key itself: the same key in ANOTHER frame, where it is unique, is a node of its own
  // (#1809: keys are per frame). Mutation: refuse every node carrying a key the document repeats anywhere (drop the
  // derivation check) — Dup5 is refused.
  it('the same key in another frame, held once there, is not refused', async () => {
    const pn = pnDoc() as { entities: Array<Record<string, unknown>> };
    pn.entities.push({ localId: 3, name: 'QB', nodeGuid: g(4), prefab: P, traits: { EntityAttributes: { name: 'QB', parentId: 1, guid: '' } }, added: [dupNode(5)] });
    install(pn as never); install(o());
    await load(scene({}, O), vetted());
    const d5 = getAllEntities().find((e) => e.name === 'Dup5')!;
    expect(templateKeyOf(findEntity(d5.id)), 'premise: it carries the key').toBe('k-dup');
    expect(writeTraitFieldWithUndo(d5.id, getTraitByName('Transform')!, 'x', 31)).toBeFalsy();
  });

  // The accept side: the frame's other node is still stated node by node. Mutation: skip every chain node in
  // `matchList` (not only a repeated key's) — Keep's edit is not written.
  it('an edit to the frame\'s other node is stated on its own row', async () => {
    install(pnDoc()); install(o());
    await load(scene({}, O), vetted());
    const k = getAllEntities().find((e) => e.name === 'Keep')!;
    expect(writeTraitFieldWithUndo(k.id, getTraitByName('Transform')!, 'x', 77)).toBeFalsy();
    const s1 = await saved();
    const rows = Object.entries((entryOf(s1).members ?? {}) as Record<string, { traits?: { Transform?: { x?: number } } }>);
    expect(rows.filter(([, r]) => r.traits?.Transform?.x === 77).map(([key]) => key)).toEqual([`/${g(8)}/${g(6)}/a+k-keep`]);
    await load(s1, vetted());
    expect((readTraitData(getAllEntities().find((e) => e.name === 'Keep')!.id, getTraitByName('Transform')!) as { x: number }).x).toBe(77);
  });
});

/** #1933 L5 (hub ruling 2026-10-01): O adds a node AT nested row QA under the key PN's row QA gives its own node. Each
 *  file admits alone, both nodes derive one guid, and an untouched save turned one into the other (measured before the
 *  fix: load Dup1 + Dup9, every reload Dup9 twice). The load now refuses O as a seat refuses a repeat inside one file: a
 *  Damaged Prefab placeholder that keeps the entry verbatim. */
describe('a key two prefab files give one frame refuses the instance (#1933 L5)', () => {
  const PN = 'cccccccc-0000-4000-8000-000000001946';
  const dupNode = (x: number) => ({ parentLocalId: 2, guid: '', key: 'k-dup', name: `Dup${x}`, traits: { EntityAttributes: { name: `Dup${x}`, parentId: 0 }, Transform: { x, y: 0, z: 0 } }, children: [] });
  const pnDoc = (key = 'k-dup') => ({ id: PN, version: 9, name: 'PN', rootLocalId: 1, entities: [
    { localId: 1, name: 'QR', nodeGuid: g(5), traits: { EntityAttributes: { name: 'QR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
    { localId: 2, name: 'QA', nodeGuid: g(6), prefab: P, traits: { EntityAttributes: { name: 'QA', parentId: 1, guid: '' } }, added: [{ ...dupNode(9), key }] },
  ] });
  const oDocL5 = () => ({ id: O, version: 9, name: 'O', rootLocalId: 1, entities: [
    { localId: 1, name: 'OR', nodeGuid: g(7), traits: { EntityAttributes: { name: 'OR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
    { localId: 2, name: 'N', nodeGuid: g(8), prefab: PN, traits: { EntityAttributes: { name: 'N', parentId: 1, guid: '' } }, added: [dupNode(1)] },
  ] });
  const entry = { members: { [`/${g(8)}`]: { traits: { Transform: { x: 3 } } } } };

  // Mutation: drop the load's `frameRepeatRefusal` — O expands, and the save rewrites Dup1 as Dup9.
  it('refused: a Damaged Prefab placeholder naming the key, its entry written back verbatim, byte-stable', async () => {
    install(pnDoc()); install(oDocL5());
    await load(scene(entry, O));
    const placeholder = getAllEntities().find((e) => e.missingPrefab);
    expect(placeholder?.damagedPrefab).toMatch(/template key k-dup to two nodes in one frame/);
    expect(getAllEntities().some((e) => e.name.startsWith('Dup'))).toBe(false);
    const s1 = await saved();
    expect(entryOf(s1).members).toEqual({ '/': { traits: { EntityAttributes: { name: 'Inst' } } }, ...entry.members });
    await load(s1);
    expect(JSON.stringify((await saved()).entities)).toBe(JSON.stringify(s1.entities));
  });

  // The accept side, and the label's clearing. Mutation: refuse whenever O nests anything (`repeats` ignored) — the
  // fixed files stay refused; never forget the reason — the label outlives the fix.
  it('the files fixed (PN gives its node its own key): O expands, both nodes, and no label is left', async () => {
    install(pnDoc()); install(oDocL5());
    await load(scene(entry, O));
    install(pnDoc('k-own'));
    await load(scene(entry, O));
    expect(getAllEntities().some((e) => e.missingPrefab)).toBe(false);
    expect(getAllEntities().filter((e) => e.name.startsWith('Dup')).map((e) => e.name).sort()).toEqual(['Dup1', 'Dup9']);
    expect(damagedPrefabReason(O)).toBeUndefined();
  });

  // Close-out review #1 (the hypothesis it named): a rebuild after PN is changed to give O's key leaves the live frame as
  // it was, as one that expands to no root is — re-expanded, Dup1 and Dup9 derive one guid. Mutation: drop the rebuild's
  // `frameRepeatRefusal` gate (both sites in prefabRebuild.ts) — the two Dups share a guid.
  it('a rebuild after a nested file gains the key leaves the frame as it was', async () => {
    install(pnDoc('k-own')); install(oDocL5());
    await load(scene(entry, O));
    const dupGuids = () => getAllEntities().filter((e) => e.name.startsWith('Dup')).map((e) => e.guid);
    const before = dupGuids();
    expect(new Set(before).size, 'premise: two Dups, two guids').toBe(2);
    const oldPn = pnDoc('k-own');
    install(pnDoc());
    const pnRoot = getAllEntities().find((e) => e.name === 'QR')!.id; // PN's frame root, under O's row N
    quietly(() => refreshInstances(PN, [pnRoot], oldPn as unknown as PrefabFile, pnDoc() as unknown as PrefabFile));
    expect(dupGuids().sort()).toEqual([...before].sort());
  });

  // Close-out review #1: O placed as a scene-added REFERENCE NODE (under an instance of P) was expanded, and an untouched
  // save rewrote Dup1 as Dup9. Mutation: drop the refusal in `spawnReferenceNode` — Dup1 and Dup9 spawn, and save 2 differs.
  it('a reference node of O is refused the same way: a placeholder carrying the node, byte-stable', async () => {
    install(pnDoc()); install(oDocL5());
    const node = { parentLocalId: 1, guid: NODE, prefab: O, name: 'Ref', traits: { EntityAttributes: { name: 'Ref', parentId: 0, guid: NODE } }, children: [] };
    await load(scene({ added: [node] }));
    expect(getAllEntities().some((e) => e.name.startsWith('Dup'))).toBe(false);
    expect(getAllEntities().find((e) => e.missingPrefab)?.damagedPrefab).toMatch(/template key k-dup/);
    const s1 = await saved();
    // Scene v20 (#2001 S6): the node is inline on the root's `"/"` row, and states its own root row (the name its
    // expansion shows is the template root's, #2028; the placeholder shows the node's).
    expect((entryOf(s1).members as Record<string, { own?: unknown[] }>)['/']!.own).toEqual([{ ...node, parentLocalId: 0, members: { '/': { traits: { EntityAttributes: { name: 'OR', sortOrder: 0 } } } } }]);
    await load(s1);
    expect(JSON.stringify((await saved()).entities)).toBe(JSON.stringify(s1.entities));
  });
});

/** Close-out review #4 and #10 (#1933 N1b): an unregistered component's record, per entity. */
describe('an unregistered component stays on its own entity (close-out review #4, #10)', () => {
  const TWIN = 'dddddddd-0000-4000-8000-000000001947';
  const plain = (name: string, extra: Record<string, unknown> = {}) => ({ traits: { EntityAttributes: { name, parentId: 0, guid: TWIN }, Transform: { x: 0, y: 0, z: 0 }, ...extra } });
  const twins = (order: 'carrier-first' | 'carrier-second') => {
    const a = plain('A', { RetiredTraitTwin: { speed: 7 } });
    const b = plain('B');
    const list = order === 'carrier-first' ? [a, b] : [b, a];
    return { id: 's1933', version: 19, name: 'S', resources: [], entities: list.map((e, i) => ({ id: i + 1, ...e })) } as unknown as SceneData;
  };
  const byName = (s: SceneData, name: string) => (s.entities as unknown as Array<{ traits: Record<string, { name?: string }> }>).find((e) => e.traits.EntityAttributes?.name === name)!;
  beforeEach(() => clearMissingComponents());

  // Two entities on one guid (a file breaking the per-file rule; refusing it is C-A step 5, parked). Mutations: key the
  // record by guid alone (writers ignore `owner`) — B gains the component; let a twin's clear take this load's record — A
  // loses it.
  for (const order of ['carrier-first', 'carrier-second'] as const) {
    it(`two entities on one guid (${order}): the component stays on A only, byte-stable`, async () => {
      await load(twins(order));
      const s1 = await saved();
      expect(byName(s1, 'A').traits.RetiredTraitTwin).toEqual({ speed: 7 });
      expect(byName(s1, 'B').traits.RetiredTraitTwin).toBeUndefined();
      await load(s1);
      expect(JSON.stringify((await saved()).entities)).toBe(JSON.stringify(s1.entities));
    });
  }

  // The owner check's other side: a delete and its undo respawn the entity under a new id, the same guid. Mutation: the
  // writer requires `owner === id` — the restored entity loses it.
  it('a delete and its undo keep it', async () => {
    await load(twins('carrier-first'));
    const a = getAllEntities().find((e) => e.name === 'A')!.id;
    deleteEntitiesWithUndo([a]);
    getCurrentWorld().spawn(); // takes the freed id, so the undo respawns A under a NEW one
    const { undo } = await import('../../packages/modoki/src/editor/undo/undoManager');
    await undo();
    expect(getAllEntities().find((e) => e.name === 'A')!.id, 'premise: A came back under another id').not.toBe(a);
    expect(byName(await saved(), 'A').traits.RetiredTraitTwin).toEqual({ speed: 7 });
  });

  // #10: a legacy instance root's extra component (an entry's `traits` beside PrefabInstance). Mutation: skip the merge
  // for a captured root (`!prefabRootCaptured &&`) — save 1 drops it.
  it('a prefab instance root\'s unregistered extra component is written back, byte-stable', async () => {
    const s1 = await twoSaves(scene({ traits: { EntityAttributes: { name: 'Inst', parentId: 0 }, RetiredTraitRoot: { speed: 9 } } }));
    expect((entryOf(s1).members as Record<string, { traits: Record<string, unknown> }>)['/']!.traits.RetiredTraitRoot).toEqual({ speed: 9 });
  });
});
