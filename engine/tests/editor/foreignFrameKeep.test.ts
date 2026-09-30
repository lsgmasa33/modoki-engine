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
import { captureInstanceOverrides } from '../../packages/modoki/src/editor/scene/prefabInstanceOverrides';
import { captureInstanceStructure } from '../../packages/modoki/src/editor/scene/prefabCapture';
import { rebuildInstance } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { legacyView } from './memberRowView';
import { readTraitData } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';

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
  // `missing: false` is the control the #1484 park already covered. Mutation for `missing: true`: drop `!foreign(c)` from
  // the teardown's keep (`prefabFrames.ts`) — ZRoot/ZLeaf go, and the save writes O's row 3 removed.
  for (const missing of [false, true]) {
    it(`Z ${missing ? 'trashed' : 'present'}: O's Z frame and its edit stay live, and the save writes no removal of it`, async () => {
      await load(scene());
      expect(byName('ZRoot')).toHaveLength(1);
      expect(writeTraitFieldWithUndo(byName('ZLeaf')[0]!.id, getTraitByName('Transform')!, 'x', 7)).toBeFalsy();
      if (missing) { prefabs.delete(Z); setPrefabCache(Z, null); }
      const q = byName('QRoot')[0]!.id;
      const qDoc = docs[Q] as never;
      rebuildInstance(q, Q, qDoc, captureInstanceOverrides(q, qDoc), captureInstanceStructure(q, qDoc));
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
    rebuildInstance(root, O2, oDoc, captureInstanceOverrides(root, oDoc), captureInstanceStructure(root, oDoc));
    expect(byName('ZRoot')).toHaveLength(1);
    expect(byName('ZLeaf')).toHaveLength(1);
    expect((readTraitData(byName('ZLeaf')[0]!.id, getTraitByName('Transform')!) as { x?: number } | null)?.x).toBe(7);
    const saved = await serializeScene() as unknown as { entities: Array<Record<string, unknown>> };
    const entry = saved.entities.find((e) => e.prefab === O2)!;
    expect(Object.values((entry.members ?? {}) as Record<string, { removed?: boolean }>).filter((r) => r.removed)).toEqual([]);
  });
});
