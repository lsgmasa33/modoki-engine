/** #1877 S3: #1862 keeps a nested frame whose prefab is missing through a rebuild, but its keep asked no owner. In the
 *  #1484 shape — O: Root > QRow(Q) > ZRow(Z), Z's row hanging under Q's frame yet O's own — a rebuild of the inner Q
 *  frame with Z trashed KEPT O's Z frame, `seatKeptFrames` then looked for its row among the unexpanded rows of an owner
 *  the rebuild never re-expanded, found none and deleted it, and the save wrote O's Z row REMOVED: the frame and its edit
 *  lost for good, even once Z came back. A foreign frame is parked and re-seated, as it is when Z is there.
 *
 *  Driven through the real loader, rebuild and save (the rebuild's own harness shape, `rebuildNestedReapply.test.ts`). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction, clearHistory, serializeScene, writeTraitFieldWithUndo } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { refreshInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { legacyView } from './memberRowView';
import { readTraitData, deleteEntities } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { findEntityByGuid } from '../../packages/modoki/src/runtime/core/ecs/world';
import { frameRootDoc, noteFrameRootDoc } from '../../packages/modoki/src/runtime/core/ecs/identityParents';

registerAllTraits();
setActionCallback(pushAction);

let n = 0;
const ng = () => `dddddddd-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, nodeGuid: ng(), ...extra, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const O = 'aaaaaaaa-0000-4000-8000-0000001877b1';
const Q = 'aaaaaaaa-0000-4000-8000-0000001877b2';
const Z = 'aaaaaaaa-0000-4000-8000-0000001877b3';
const ROOT = 'bbbbbbbb-0000-4000-8000-0000001877c2';
/** The depth-2 shape (close-out review): Z is Q's OWN row, and O only nests Q. */
const Q2 = 'aaaaaaaa-0000-4000-8000-0000001877b4';
const O2 = 'aaaaaaaa-0000-4000-8000-0000001877b5';
const docs: Record<string, unknown> = {
  [Q]: { id: Q, rootLocalId: 1, entities: [row(1, 'QRoot', 0), row(2, 'QA', 1), row(3, 'QB', 2)] },
  [Z]: { id: Z, rootLocalId: 1, entities: [row(1, 'ZRoot', 0), row(2, 'ZLeaf', 1)] },
  // ZRow (3) hangs under QRow's frame (#1484): O's row, under a node O does not expand itself.
  [O]: { id: O, rootLocalId: 1, entities: [row(1, 'ORoot', 0), row(2, 'QRow', 1, { prefab: Q }), row(3, 'ZRow', 2, { prefab: Z }), row(4, 'Plain', 2)] },
  [Q2]: { id: Q2, rootLocalId: 1, entities: [row(1, 'QRoot', 0), row(2, 'QA', 1), row(3, 'QB', 2), row(4, 'ZRow', 2, { prefab: Z })] },
  [O2]: { id: O2, rootLocalId: 1, entities: [row(1, 'ORoot', 0), row(2, 'QRow', 1, { prefab: Q2 })] },
};

async function load(scene: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(scene)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id) => { const w = getCurrentWorld(); for (const e of w.entities) if (e.id() === id) { destroyEntity(e, w); break; } },
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure) => {
      const w = getCurrentWorld();
      const id = instantiatePrefabIntoWorld(w, prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
      if (id && rootGuid) for (const e of w.entities) if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid: rootGuid });
      return id ?? undefined;
    },
  });
}
const scene = (prefab = O) => ({ id: 's1877', version: 16, name: 'S', resources: [], entities: [
  { id: 1, prefab, guid: ROOT, traits: { EntityAttributes: { name: 'ORoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
] }) as unknown as SceneData;
const byName = (nm: string) => getAllEntities().filter((e) => e.name === nm);

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  clearKeptMemberOrphans();
  prefabs.clear();
  for (const [k, d] of Object.entries(docs)) { prefabs.set(k, d); setPrefabCache(k, d as never); }
  for (const k of ['log', 'warn', 'info'] as const) vi.spyOn(console, k).mockImplementation(() => {});
});

describe('#1877 S3: a rebuild of an inner frame keeps ANOTHER frame\'s row whose prefab is missing', () => {
  // `missing: false` is the control the #1484 park already covered. The mutation that reddened `missing: true` — drop
  // `!foreign(c)` from the teardown's keep (`prefabFrames.ts`) — leaves it green since #1880 F7d (measured): a rebuild of
  // Q is the load of O's whole entry, so O's Z frame is not foreign to the teardown. The case stays as the outcome.
  for (const missing of [false, true]) {
    it(`Z ${missing ? 'trashed' : 'present'}: O's Z frame and its edit stay live, and the save writes no removal of it`, async () => {
      await load(scene());
      expect(byName('ZRoot')).toHaveLength(1);
      expect(writeTraitFieldWithUndo(byName('ZLeaf')[0]!.id, getTraitByName('Transform')!, 'x', 7)).toBeFalsy();
      if (missing) { prefabs.delete(Z); setPrefabCache(Z, null); }
      const q = byName('QRoot')[0]!.id;
      const qDoc = docs[Q] as never;
      refreshInstances(Q, [q], qDoc, qDoc);
      expect(byName('ZRoot')).toHaveLength(1);
      expect(byName('ZLeaf')).toHaveLength(1);
      expect((readTraitData(byName('ZLeaf')[0]!.id, getTraitByName('Transform')!) as { x?: number } | null)?.x).toBe(7);
      const saved = await serializeScene() as unknown as { entities: Array<Record<string, unknown>> };
      const entry = saved.entities.find((e) => e.prefab === O)!;
      const view = legacyView(entry, (g) => prefabs.get(g) ?? docs[g]) as { removed?: number[] };
      expect(view.removed ?? []).not.toContain(3);
      expect(Object.values((entry.members ?? {}) as Record<string, { removed?: boolean }>).filter((r) => r.removed)).toEqual([]);
    });
  }
});

describe('#1877 close-out review: a frame two levels down whose prefab is missing is kept through a rebuild of the OUTER instance', () => {
  // O2: ORoot > QRow(Q2); Q2's OWN row ZRow expands Z. Rebuilding O2 tears down the Q2 frame, which owns the Z frame:
  // `foreign` parks it (its owner is not O2), and the fixpoint unparks it once Q2 is torn down. Mutation: the unpark
  // takes it regardless (drop the `unexpandable` keep in the fixpoint, `prefabFrames.ts`) — ZRoot and ZLeaf go, edit and all.
  it('Z trashed, a rebuild of O2 (a Revert or Apply on it): the Z frame and its edit stay live, and the save keeps them', async () => {
    await load(scene(O2));
    expect(byName('ZRoot')).toHaveLength(1);
    expect(writeTraitFieldWithUndo(byName('ZLeaf')[0]!.id, getTraitByName('Transform')!, 'x', 7)).toBeFalsy();
    prefabs.delete(Z);
    setPrefabCache(Z, null);
    const root = getAllEntities().find((e) => e.guid === ROOT)!.id;
    const oDoc = docs[O2] as never;
    refreshInstances(O2, [root], oDoc, oDoc);
    expect(byName('ZRoot')).toHaveLength(1);
    expect(byName('ZLeaf')).toHaveLength(1);
    expect((readTraitData(byName('ZLeaf')[0]!.id, getTraitByName('Transform')!) as { x?: number } | null)?.x).toBe(7);
    const saved = await serializeScene() as unknown as { entities: Array<Record<string, unknown>> };
    const entry = saved.entities.find((e) => e.prefab === O2)!;
    expect(Object.values((entry.members ?? {}) as Record<string, { removed?: boolean }>).filter((r) => r.removed)).toEqual([]);
  });
});

describe('#1880 F7a: an entry whose OWN prefab is trashed is loaded from its record', () => {
  // A rebuild of any frame is the load of its outermost entry. With the entry's prefab gone from the cache (a trash, the
  // frame kept live, #1862), the load reads the document the entry was built from — its record (`entryDocOf`). The old
  // per-frame rebuild was the fallback there until F7. Mutation: `entryDocOf` answers the cache only — the refresh of Q
  // rebuilds nothing, counts 0, and Q's new row never arrives.
  it('O trashed: a refresh of the Q frame inside it still lands, and O\'s own rows stay', async () => {
    await load(scene());
    prefabs.delete(O);
    setPrefabCache(O, null);
    const qDoc = docs[Q] as { entities: unknown[] };
    const qNext = { ...qDoc, entities: [...qDoc.entities, row(4, 'QC', 1)] };
    prefabs.set(Q, qNext); setPrefabCache(Q, qNext as never);
    expect(refreshInstances(Q, [byName('QRoot')[0]!.id], qDoc as never, qNext as never)).toBe(1);
    expect(byName('QC')).toHaveLength(1);
    for (const nm of ['ORoot', 'QRoot', 'QA', 'QB', 'Plain', 'ZRoot', 'ZLeaf']) expect(byName(nm), nm).toHaveLength(1);
  });
});

describe('#1880 F7d: a frame of a trashed prefab INSIDE an entry is expanded from its record, so a stale frame in it is rebuilt', () => {
  // O2 > QRow(Q2) > Q2's own row ZRow(Z). Q2 trashed, the Q2 frame is kept live (#1862); a refresh of Z is the load of O2's
  // entry, which reads Q2 from the Q2 frame's own record (`withFrameRecords`), as a reload with Q2 restored reads its file.
  // Kept whole instead (the teardown's `unexpandable`), the Z frame inside it was never re-expanded: Z's new row never
  // arrived, and the refresh still counted it (hunt seed 1042). Mutation: `withFrameRecords` returns `base` — ZC missing.
  it('Q2 trashed: a refresh of the Z frame two levels down lands, and the Q2 frame\'s rows stay', async () => {
    await load(scene(O2));
    prefabs.delete(Q2);
    setPrefabCache(Q2, null);
    const zDoc = docs[Z] as { entities: unknown[] };
    const zNext = { ...zDoc, entities: [...zDoc.entities, row(3, 'ZC', 1)] };
    prefabs.set(Z, zNext); setPrefabCache(Z, zNext as never);
    expect(refreshInstances(Z, [byName('ZRoot')[0]!.id], zDoc as never, zNext as never)).toBe(1);
    expect(byName('ZC')).toHaveLength(1);
    for (const nm of ['ORoot', 'QRoot', 'QA', 'QB', 'ZRoot', 'ZLeaf']) expect(byName(nm), nm).toHaveLength(1);
  });

  // The same through a scene-added reference node of Q2: a node of a prefab the load cannot read is KEPT live and its
  // statement skipped (`keptNodes`), so the teardown must ask the same reader as the respawn — asking the cache, it kept
  // the node whole and the Z frame inside it stale. Mutation: `rebuildTeardown`'s `unexpandable` reads the cache, not
  // `read` — one ZC, not two.
  it('Q2 trashed: the Z frame inside a scene-added Q2 node is refreshed too', async () => {
    const withNode = scene(O2) as unknown as { entities: Array<Record<string, unknown>> };
    withNode.entities[0]!.added = [{ parentLocalId: 1, guid: 'bbbbbbbb-0000-4000-8000-0000001880d1', name: 'QRoot', traits: {}, children: [], prefab: Q2 }];
    await load(withNode as unknown as SceneData);
    expect(byName('ZRoot')).toHaveLength(2);
    prefabs.delete(Q2);
    setPrefabCache(Q2, null);
    const zDoc = docs[Z] as { entities: unknown[] };
    const zNext = { ...zDoc, entities: [...zDoc.entities, row(3, 'ZC', 1)] };
    prefabs.set(Z, zNext); setPrefabCache(Z, zNext as never);
    expect(refreshInstances(Z, byName('ZRoot').map((e) => e.id), zDoc as never, zNext as never)).toBe(2);
    expect(byName('ZC')).toHaveLength(2);
    for (const nm of ['QRoot', 'QA', 'QB', 'ZRoot', 'ZLeaf']) expect(byName(nm), nm).toHaveLength(2);
  });

  // Two Q2 frames in ONE entry built from DIFFERENT Q2 documents (one from an older Q2, as a stale frame is): no one record
  // to expand Q2 from, so both stay kept live as they were, and a Z target inside them is not rebuilt — not counted, and
  // the warning says why (not "no scene entry"). Mutations: `withFrameRecords` answers the first record it meets (drop the
  // disagreement check) — both Q2 frames re-expand and ZC arrives; the count takes a target inside a kept frame (drop the
  // `keptLive` skip) — the refresh returns 2.
  it('Q2 trashed, its two frames in one entry on different documents: both are left as they were, and the Z refresh counts 0', async () => {
    const withNode = scene(O2) as unknown as { entities: Array<Record<string, unknown>> };
    withNode.entities[0]!.added = [{ parentLocalId: 1, guid: 'bbbbbbbb-0000-4000-8000-0000001880d1', name: 'QRoot', traits: {}, children: [], prefab: Q2 }];
    await load(withNode as unknown as SceneData);
    const node = findEntityByGuid('bbbbbbbb-0000-4000-8000-0000001880d1')!;
    const rec = frameRootDoc(getCurrentWorld(), node)!;
    const q2Doc = docs[Q2] as { entities: unknown[] };
    noteFrameRootDoc(getCurrentWorld(), node, { ...rec, doc: { ...q2Doc, entities: [...q2Doc.entities, row(5, 'QX', 1)] } as never });
    prefabs.delete(Q2);
    setPrefabCache(Q2, null);
    const zDoc = docs[Z] as { entities: unknown[] };
    const zNext = { ...zDoc, entities: [...zDoc.entities, row(3, 'ZC', 1)] };
    prefabs.set(Z, zNext); setPrefabCache(Z, zNext as never);
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    expect(refreshInstances(Z, byName('ZRoot').map((e) => e.id), zDoc as never, zNext as never)).toBe(0);
    expect(byName('ZC')).toHaveLength(0);
    expect(byName('QX')).toHaveLength(0);
    for (const nm of ['QRoot', 'ZRoot', 'ZLeaf']) expect(byName(nm), nm).toHaveLength(2);
    const said = warn.mock.calls.map((c) => String(c[0]));
    expect(said.some((w) => w.includes('2 instance frame(s) left as they were'))).toBe(true);
    expect(said.some((w) => w.includes('not refreshing'))).toBe(false);
  });

  // A row the world holds UNEXPANDED (a swap left it so, ruling R, #1849) stays so through a rebuild of its entry, though
  // another frame of the same prefab in the entry could lend a record — a no-op rebuild must not expand it. Here O2's own
  // QRow is recorded unexpanded, its frame gone, beside a live scene-added Q2 node. Mutation: `withFrameRecords` ignores
  // `unexpanded` — QRow re-expands (two QRoots).
  it('Q2 trashed: a row of it the entry holds unexpanded is not expanded from another frame\'s record', async () => {
    const withNode = scene(O2) as unknown as { entities: Array<Record<string, unknown>> };
    withNode.entities[0]!.added = [{ parentLocalId: 1, guid: 'bbbbbbbb-0000-4000-8000-0000001880d1', name: 'QRoot', traits: {}, children: [], prefab: Q2 }];
    await load(withNode as unknown as SceneData);
    const outer = findEntityByGuid(ROOT)!;
    const rec = frameRootDoc(getCurrentWorld(), outer)!;
    const rowFrame = byName('QRoot').find((e) => e.guid !== 'bbbbbbbb-0000-4000-8000-0000001880d1')!;
    deleteEntities([rowFrame.id]);
    noteFrameRootDoc(getCurrentWorld(), outer, { ...rec, unexpanded: [2] });
    expect(byName('QRoot')).toHaveLength(1);
    prefabs.delete(Q2);
    setPrefabCache(Q2, null);
    const zDoc = docs[Z] as { entities: unknown[] };
    const zNext = { ...zDoc, entities: [...zDoc.entities, row(3, 'ZC', 1)] };
    prefabs.set(Z, zNext); setPrefabCache(Z, zNext as never);
    expect(refreshInstances(Z, byName('ZRoot').map((e) => e.id), zDoc as never, zNext as never)).toBe(0);
    expect(byName('QRoot')).toHaveLength(1);
    expect(byName('ZC')).toHaveLength(0);
  });
});

describe('#1880 F7d close-out review: where the record reader must not reach, and what a kept frame refuses', () => {
  const NODE = 'bbbbbbbb-0000-4000-8000-0000001880d1';
  const inUnder = (top: number, nm: string) => {
    const all = getAllEntities();
    const under = (id: number): boolean => { const e = all.find((x) => x.id === id); return !!e && (e.id === top || under(e.parentId)); };
    return all.find((e) => e.name === nm && under(e.id))!;
  };

  // Review 3. O2' ADDS a row of the trashed Q2: a reload leaves it unexpanded (ruling D, #1790), so a refresh must too —
  // another Q2 frame's record is no document for a row it never expanded. Mutation: `withFrameRecords` skips the
  // backed-rows check — QRow2 is expanded from QRow's record (two QRoots, nothing unexpanded).
  it('a refresh adding a NEW row of a trashed prefab leaves that row unexpanded', async () => {
    await load(scene(O2));
    prefabs.delete(Q2);
    setPrefabCache(Q2, null);
    const oDoc = docs[O2] as { entities: unknown[] };
    const oNext = { ...oDoc, entities: [...oDoc.entities, row(3, 'QRow2', 1, { prefab: Q2 })] };
    prefabs.set(O2, oNext); setPrefabCache(O2, oNext as never);
    expect(refreshInstances(O2, [findEntityByGuid(ROOT)!.id()], oDoc as never, oNext as never)).toBe(1);
    expect(byName('QRoot')).toHaveLength(1);
    expect(frameRootDoc(getCurrentWorld(), findEntityByGuid(ROOT)!)?.unexpanded).toEqual([3]);
  });

  // Review 4. An owned Q2 frame moved OUT of O2 (a legacy `moved`, #1437), Q2 trashed: the teardown's reverse case took it
  // with nothing to respawn it — #1862's keep, flipped for a frame moved out. Mutation: drop the reverse case's
  // `unexpandable` keep (`prefabFrames.ts`) — QRoot and ZRoot go.
  it('an owned frame of a trashed prefab moved OUT of its entry is kept where it hangs', async () => {
    const H = 'bbbbbbbb-0000-4000-8000-0000001880e1';
    await load({ id: 's1877', version: 16, name: 'S', resources: [], entities: [
      { id: 1, prefab: O2, guid: ROOT, moved: { 2: H }, traits: { EntityAttributes: { name: 'ORoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      { id: 2, guid: H, traits: { EntityAttributes: { name: 'Holder', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    ] } as unknown as SceneData);
    const holder = findEntityByGuid(H)!.id();
    expect(byName('QRoot')[0]?.parentId).toBe(holder);
    prefabs.delete(Q2);
    setPrefabCache(Q2, null);
    const oDoc = docs[O2] as never;
    refreshInstances(O2, [findEntityByGuid(ROOT)!.id()], oDoc, oDoc);
    for (const nm of ['QRoot', 'ZRoot', 'ZLeaf']) expect(byName(nm), nm).toHaveLength(1);
    expect(byName('QRoot')[0]!.parentId).toBe(holder);
    expect(frameRootDoc(getCurrentWorld(), findEntityByGuid(ROOT)!)?.unexpanded ?? []).toEqual([]);
  });

  // Review 1. A Revert of a frame inside a frame its entry's rebuild keeps live (Q2 trashed, its two records disagree)
  // would change nothing: it is refused, and records no undo step. Mutation: drop the refusal in
  // `revertOverridesSelective` — the Revert "succeeds", ZLeaf.x stays 9, and an undo step is pushed.
  it('a Revert inside a kept frame is refused, not reported as done', async () => {
    const { revertOverridesWithUndo } = await import('../../packages/modoki/src/editor/undo/revertPrefabUndo');
    const { undoLabel } = await import('../../packages/modoki/src/editor/undo/undoManager');
    const withNode = scene(O2) as unknown as { entities: Array<Record<string, unknown>> };
    withNode.entities[0]!.added = [{ parentLocalId: 1, guid: NODE, name: 'QRoot', traits: {}, children: [], prefab: Q2 }];
    await load(withNode as unknown as SceneData);
    const node = findEntityByGuid(NODE)!;
    const rec = frameRootDoc(getCurrentWorld(), node)!;
    const q2Doc = docs[Q2] as { entities: unknown[] };
    noteFrameRootDoc(getCurrentWorld(), node, { ...rec, doc: { ...q2Doc, entities: [...q2Doc.entities, row(5, 'QX', 1)] } as never });
    prefabs.delete(Q2); setPrefabCache(Q2, null);
    const tfm = getTraitByName('Transform')!;
    writeTraitFieldWithUndo(inUnder(node.id(), 'ZLeaf').id, tfm, 'x', 9);
    const label = undoLabel();
    const lid = (readTraitData(inUnder(node.id(), 'ZLeaf').id, getTraitByName('PrefabInstance')!) as { localId: number }).localId;
    expect(await revertOverridesWithUndo(inUnder(node.id(), 'ZRoot').id, new Set([`${lid}.Transform.x`]))).toBeNull();
    expect((readTraitData(inUnder(node.id(), 'ZLeaf').id, tfm) as { x: number }).x).toBe(9);
    expect(undoLabel()).toBe(label);
  });

  // Review 2. An instance whose root is on a RUNTIME guid (#1210 — game code spawning into the editor world, a legacy
  // entry): the Revert of a NESTED frame mints the entry root's durable guid (F7c), and the frame kept its runtime guid,
  // which the rebuilt frame no longer carries — the Revert answered the entry's ROOT, and its undo was refused ("no longer
  // an instance of Z"). The frame's own guid is minted too now, and the entry pins it. Mutation: drop that mint in
  // `captureEntrySide` — the result is ORoot, and the undo leaves x at 0.
  it('a Revert of a nested frame in a runtime-guid instance answers that frame, and its undo puts the edit back', async () => {
    const { revertOverridesWithUndo } = await import('../../packages/modoki/src/editor/undo/revertPrefabUndo');
    const { undo } = await import('../../packages/modoki/src/editor/undo/undoManager');
    const { instantiatePrefab } = await import('@modoki/engine/editor');
    const { setPrefabSource } = await import('../../packages/modoki/src/editor/scene/prefabCache');
    const { isRuntimeGuid } = await import('../../packages/modoki/src/runtime/core/assetRefRules');
    const prev = getCurrentWorld();
    setCurrentWorld(createWorld());
    prev?.destroy();
    const root = instantiatePrefab(docs[O2] as never);
    setPrefabSource(root, { id: O2 } as never);
    expect(isRuntimeGuid(getAllEntities().find((e) => e.id === root)!.guid)).toBe(true);
    const tfm = getTraitByName('Transform')!;
    writeTraitFieldWithUndo(byName('ZLeaf')[0]!.id, tfm, 'x', 9);
    const lid = (readTraitData(byName('ZLeaf')[0]!.id, getTraitByName('PrefabInstance')!) as { localId: number }).localId;
    const res = await revertOverridesWithUndo(byName('ZRoot')[0]!.id, new Set([`${lid}.Transform.x`]));
    expect(getAllEntities().find((e) => e.id === res?.newRootId)?.name).toBe('ZRoot');
    expect((readTraitData(byName('ZLeaf')[0]!.id, tfm) as { x: number }).x).toBe(0);
    await undo();
    expect((readTraitData(byName('ZLeaf')[0]!.id, tfm) as { x: number }).x).toBe(9);
  });

  // Review 1, the undo side: a Revert done while Q2 was readable, then Q2 trashed with its two records disagreeing — the
  // undo's rebuild would keep the frame live and could not put the edit back, so it is refused before anything is rebuilt,
  // not reported as applied. Mutation: drop `rebuildFrameFromSide`'s `keptEnclosingSource` refusal — the undo "applies".
  it('the undo of a Revert whose frame now lies inside a kept frame is refused', async () => {
    const { revertOverridesWithUndo } = await import('../../packages/modoki/src/editor/undo/revertPrefabUndo');
    const { undoStep } = await import('../../packages/modoki/src/editor/undo/undoManager');
    const withNode = scene(O2) as unknown as { entities: Array<Record<string, unknown>> };
    withNode.entities[0]!.added = [{ parentLocalId: 1, guid: NODE, name: 'QRoot', traits: {}, children: [], prefab: Q2 }];
    await load(withNode as unknown as SceneData);
    const tfm = getTraitByName('Transform')!;
    const nodeId = () => findEntityByGuid(NODE)!.id();
    writeTraitFieldWithUndo(inUnder(nodeId(), 'ZLeaf').id, tfm, 'x', 9);
    const lid = (readTraitData(inUnder(nodeId(), 'ZLeaf').id, getTraitByName('PrefabInstance')!) as { localId: number }).localId;
    expect(await revertOverridesWithUndo(inUnder(nodeId(), 'ZRoot').id, new Set([`${lid}.Transform.x`]))).not.toBeNull();
    expect((readTraitData(inUnder(nodeId(), 'ZLeaf').id, tfm) as { x: number }).x).toBe(0);
    const node = findEntityByGuid(NODE)!;
    const rec = frameRootDoc(getCurrentWorld(), node)!;
    const q2Doc = docs[Q2] as { entities: unknown[] };
    noteFrameRootDoc(getCurrentWorld(), node, { ...rec, doc: { ...q2Doc, entities: [...q2Doc.entities, row(5, 'QX', 1)] } as never });
    prefabs.delete(Q2); setPrefabCache(Q2, null);
    const out = await undoStep('undo');
    expect(out.failed?.refused).toBe(true);
    expect((readTraitData(inUnder(nodeId(), 'ZLeaf').id, tfm) as { x: number }).x).toBe(0);
  });

  // Review 1, Apply: from a frame inside a kept frame, the Apply's own refresh would leave the instance as it is, the
  // applied field pinned on it as an override of the template it was written into — refused before anything is written.
  // Mutation: drop the `keptEnclosingSource` refusal in `applyToPrefabSelective` — the Apply goes through.
  it('an Apply from inside a kept frame is refused, and writes nothing', async () => {
    const { applyToPrefabSelective } = await import('../../packages/modoki/src/editor/scene/prefabApply');
    const withNode = scene(O2) as unknown as { entities: Array<Record<string, unknown>> };
    withNode.entities[0]!.added = [{ parentLocalId: 1, guid: NODE, name: 'QRoot', traits: {}, children: [], prefab: Q2 }];
    await load(withNode as unknown as SceneData);
    const node = findEntityByGuid(NODE)!;
    const rec = frameRootDoc(getCurrentWorld(), node)!;
    const q2Doc = docs[Q2] as { entities: unknown[] };
    noteFrameRootDoc(getCurrentWorld(), node, { ...rec, doc: { ...q2Doc, entities: [...q2Doc.entities, row(5, 'QX', 1)] } as never });
    prefabs.delete(Q2); setPrefabCache(Q2, null);
    const tfm = getTraitByName('Transform')!;
    writeTraitFieldWithUndo(inUnder(node.id(), 'ZLeaf').id, tfm, 'x', 9);
    const lid = (readTraitData(inUnder(node.id(), 'ZLeaf').id, getTraitByName('PrefabInstance')!) as { localId: number }).localId;
    const zBefore = prefabs.get(Z);
    const out = await applyToPrefabSelective(inUnder(node.id(), 'ZRoot').id, new Set([`${lid}.Transform.x`]));
    expect(out.applied).toBe(false);
    expect(String((out as { refused?: string }).refused)).toMatch(/inside an instance of/);
    expect(prefabs.get(Z)).toBe(zBefore);
  });

  // Re-review 3. The refreshed document RENUMBERS QRow (2 → 3, same nodeGuid) and adds a NEW Q2 row at the old number 2:
  // matched by number, the new row read as the live frame's and was expanded from its record. Mutation: match a row with a
  // nodeGuid by its number too (the `backed` localId key) — two QRoots.
  it('a new row of a trashed prefab on a renumbered row\'s old number is still left unexpanded', async () => {
    await load(scene(O2));
    prefabs.delete(Q2);
    setPrefabCache(Q2, null);
    const oDoc = docs[O2] as { entities: Array<Record<string, unknown>> };
    const moved = oDoc.entities.map((e) => (e.localId === 2 ? { ...e, localId: 3 } : e));
    const oNext = { ...oDoc, entities: [...moved, row(2, 'QRow2', 1, { prefab: Q2 })] };
    prefabs.set(O2, oNext); setPrefabCache(O2, oNext as never);
    refreshInstances(O2, [findEntityByGuid(ROOT)!.id()], oDoc as never, oNext as never);
    expect(byName('QRoot')).toHaveLength(1);
    expect(frameRootDoc(getCurrentWorld(), findEntityByGuid(ROOT)!)?.unexpanded).toEqual([2]);
  });

  // Re-review 4. A row the instance REMOVED is one its frame was built with, not a new one: it does not block the record,
  // so a stale Z frame inside the live Q2 frame is still rebuilt. Mutation: drop the built-with check in `withFrameRecords`
  // — the refresh counts 0 and ZC never arrives.
  it('a row of the trashed prefab the instance removed does not stop the live frame from being expanded from its record', async () => {
    const O3 = 'aaaaaaaa-0000-4000-8000-0000001880f3';
    const o3 = { id: O3, rootLocalId: 1, entities: [row(1, 'ORoot', 0), row(2, 'QRow', 1, { prefab: Q2 }), row(3, 'QRow2', 1, { prefab: Q2 })] };
    prefabs.set(O3, o3); setPrefabCache(O3, o3 as never);
    const sc = scene(O3) as unknown as { entities: Array<Record<string, unknown>> };
    sc.entities[0]!.removed = [3];
    await load(sc as unknown as SceneData);
    expect(byName('QRoot')).toHaveLength(1);
    prefabs.delete(Q2);
    setPrefabCache(Q2, null);
    const zDoc = docs[Z] as { entities: unknown[] };
    const zNext = { ...zDoc, entities: [...zDoc.entities, row(3, 'ZC', 1)] };
    prefabs.set(Z, zNext); setPrefabCache(Z, zNext as never);
    expect(refreshInstances(Z, byName('ZRoot').map((e) => e.id), zDoc as never, zNext as never)).toBe(1);
    expect(byName('ZC')).toHaveLength(1);
    expect(byName('QRoot')).toHaveLength(1);
  });

  // Re-review 2. The undo of a Revert whose OWN frame's prefab is trashed afterwards (its records disagreeing, so the load
  // keeps it live): refused, not reported as applied. Mutation: `keptEnclosingSource` skips the frame itself — the undo
  // "applies" and x stays 0.
  it('the undo of a Revert whose own frame is now kept is refused', async () => {
    const { revertOverridesWithUndo } = await import('../../packages/modoki/src/editor/undo/revertPrefabUndo');
    const { undoStep } = await import('../../packages/modoki/src/editor/undo/undoManager');
    const ZNODE = 'bbbbbbbb-0000-4000-8000-0000001880d7';
    const withNode = scene(O2) as unknown as { entities: Array<Record<string, unknown>> };
    withNode.entities[0]!.added = [{ parentLocalId: 1, guid: ZNODE, name: 'ZRoot', traits: {}, children: [], prefab: Z }];
    await load(withNode as unknown as SceneData);
    const tfm = getTraitByName('Transform')!;
    const owned = () => byName('ZRoot').find((e) => e.guid !== ZNODE)!;
    const leaf = () => inUnder(owned().id, 'ZLeaf');
    writeTraitFieldWithUndo(leaf().id, tfm, 'x', 9);
    const lid = (readTraitData(leaf().id, getTraitByName('PrefabInstance')!) as { localId: number }).localId;
    expect(await revertOverridesWithUndo(owned().id, new Set([`${lid}.Transform.x`]))).not.toBeNull();
    expect((readTraitData(leaf().id, tfm) as { x: number }).x).toBe(0);
    const node = findEntityByGuid(ZNODE)!;
    const rec = frameRootDoc(getCurrentWorld(), node)!;
    const zDoc = docs[Z] as { entities: unknown[] };
    noteFrameRootDoc(getCurrentWorld(), node, { ...rec, doc: { ...zDoc, entities: [...zDoc.entities, row(5, 'ZX', 1)] } as never });
    prefabs.delete(Z); setPrefabCache(Z, null);
    const out = await undoStep('undo');
    expect(out.failed?.refused).toBe(true);
    expect((readTraitData(leaf().id, tfm) as { x: number }).x).toBe(0);
  });

  // Re-review 1. O5: ARow (Q) moved OUT of the entry, and the Z frame of KRow re-parented under A's QA. Z trashed: the
  // reverse case keeps the Z frame where it hangs — under a frame it then takes, so the keep went with QA, and the raw id
  // it held was the respawn's (QB) by the time `seatKeptFrames` dropped it. Mutation: skip the re-check that turns such a
  // keep into a parked one (`prefabFrames.ts`) — QB, of the readable Q frame, is deleted.
  // NOT covered here, and not this fix's: the Z frame itself does not survive this layout (the respawn states KRow with a
  // bare ZRoot where the row should be unexpanded, and ZLeaf goes) — the same before #1880 F7 (close-out re-review 1,
  // measured at d0ba7314b); reported to the hub.
  it('a kept frame hanging under another moved-out frame of the entry does not take a member of a readable frame with it', async () => {
    const O5 = 'aaaaaaaa-0000-4000-8000-0000001880f5';
    const H = 'bbbbbbbb-0000-4000-8000-0000001880e5';
    const o5 = { id: O5, rootLocalId: 1, entities: [row(1, 'ORoot', 0), row(2, 'ARow', 1, { prefab: Q }), row(3, 'KRow', 1, { prefab: Z })] };
    prefabs.set(O5, o5); setPrefabCache(O5, o5 as never);
    await load({ id: 's1880', version: 16, name: 'S', resources: [], entities: [
      { id: 1, prefab: O5, guid: ROOT, moved: { 2: H }, traits: { EntityAttributes: { name: 'ORoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      { id: 2, guid: H, traits: { EntityAttributes: { name: 'Holder', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    ] } as unknown as SceneData);
    const ea = getTraitByName('EntityAttributes')!;
    const qaGuid = byName('QA')[0]!.guid;
    writeTraitFieldWithUndo(byName('ZRoot')[0]!.id, ea, 'parentId', byName('QA')[0]!.id);
    prefabs.delete(Z); setPrefabCache(Z, null);
    const oDoc = o5 as never;
    refreshInstances(O5, [findEntityByGuid(ROOT)!.id()], oDoc, oDoc);
    for (const nm of ['QRoot', 'QA', 'QB']) expect(byName(nm), nm).toHaveLength(1);
    expect(byName('QA')[0]!.guid).toBe(qaGuid);
  });
});
