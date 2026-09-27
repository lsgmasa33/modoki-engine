/** #1665 — undo and redo of a Revert rebuild the instance onto the prefab as it is THEN, not as the Revert read it.
 *
 *  Revert's undo/redo used to rebuild from the document captured at Revert time. When the template changed in between
 *  (a prefab-edit save, an Apply from another instance), the undo undid that change on this one instance: a member the
 *  template had gained vanished, and the next save captured it as REMOVED by this instance — a permanent structural
 *  override nobody authored. Driven through the real `revertOverridesWithUndo`, the real undo manager and the real
 *  rebase; the template change is the cache swap + rebase every route that moves the cache runs.
 *
 *  Mutations (each goes red here, nothing else does):
 *  - `rebuildInstanceFromCapture`: rebuild onto `capturedFrom` instead of the cached copy → the first two cases.
 *  - drop the carried state's translation into the live frame's document → the renumbered case.
 *  - drop the stale-nested-frame refusal, or throw a plain Error instead of `UndoRefusedError` → the refusal case.
 *  - `rebuildInstanceFromCapture` with `live = capturedFrom` (the shape the design rejects: the Revert's document as
 *    the baseline) → the nested-addition case, which spawns the row's node twice.
 *  - drop `translateNestedMoveKeys` → the nested-move case.
 *  - `localIdTranslation`: map a keyed row to 0 when the other document holds its number unkeyed → the pre-v5 case.
 *  - `reattachDetachedInstance`: drop its rebase → both Detach cases; drop the reattach's frame-record put-back →
 *    the reload case, and keep a record of the same source → the Create Prefab Replace case; redo replays the first
 *    snapshot → the undo-redo-undo case. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, spawnEntity, EntityAttributes, Transform,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction } from '@modoki/engine/editor';
import { setRunMode } from '../../packages/modoki/src/runtime/core/playState';
import { markOverride } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
import {
  setPrefabCache, instantiatePrefab, setPrefabSource, rebaseStaleInstances, captureInstanceStructure,
  framesBuiltFromOtherRows, getCachedPrefabSync, detachPrefabInstance, reattachDetachedInstance, reattachPrefabInstance,
  tagEntityTreeAsInstance, untagEntityTreeAsInstance, unstampMemberGuids, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { revertOverridesWithUndo } from '../../packages/modoki/src/editor/undo/revertPrefabUndo';
import { detachPrefabInstanceWithUndo } from '../../packages/modoki/src/editor/undo/detachPrefabUndo';
import { ensureGuid } from '../../packages/modoki/src/editor/undo/entityRef';
import { nestedFrameMoves } from '../../packages/modoki/src/editor/scene/prefab';
import { undo, redo, canUndo, canRedo, swapHistory, _resetHistoryContexts, getEditVersion } from '../../packages/modoki/src/editor/undo/undoManager';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const SHIP = 'aaaaaaaa-0000-4000-8000-000000001665';
const MID = 'aaaaaaaa-0000-4000-8000-000000011665';
const G = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (localId: number, nodeGuid: string, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, nodeGuid, name, ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const doc = (id: string, name: string, entities: unknown[]) => ({ id, version: 6, name, rootLocalId: 1, entities }) as unknown as PrefabFile;
const shipV1 = () => doc(SHIP, 'Ship', [row(1, G(1), 'Ship', 0), row(2, G(2), 'Flame', 1)]);
/** v1 plus a member `Extra` — a child added in prefab edit and saved. */
const shipV2 = () => doc(SHIP, 'Ship', [row(1, G(1), 'Ship', 0), row(2, G(2), 'Flame', 1), row(3, G(3), 'Extra', 1)]);

const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};

const pi = () => getTraitByName('PrefabInstance')!;
const piOf = (id: number) => {
  for (const e of getCurrentWorld().entities) if (e.id() === id && e.has(pi().trait)) return e.get(pi().trait) as { source: string; localId: number; rootInstanceId: number };
  return null;
};
/** The live root of the (single) instance of `source`. */
const rootOf = (source: string) => getAllEntities().find((e) => { const p = piOf(e.id); return p?.source === source && p.rootInstanceId === e.id; })!.id;
/** The member of `root`'s instance named `name`, or 0. */
const member = (root: number, name: string) => getAllEntities().find((e) => e.name === name && piOf(e.id)?.rootInstanceId === root)?.id ?? 0;
const entity = (id: number) => { for (const e of getCurrentWorld().entities) if (e.id() === id) return e; throw new Error(`no entity ${id}`); };
const xOf = (id: number) => (entity(id).get(Transform) as { x: number }).x;
/** Override member `name`'s Transform.x to `x`, as an Inspector edit leaves it. */
const overrideX = (root: number, name: string, x: number) => {
  const e = entity(member(root, name));
  e.set(Transform, { ...(e.get(Transform) as object), x });
  markOverride(e, 'Transform', 'x');
};
/** What a save of the instance would record against the editor's copy of its prefab. */
const removedOnSave = (source: string) => captureInstanceStructure(rootOf(source), getCachedPrefabSync(source)!).removed;

beforeEach(() => {
  setRunMode('stopped');
  _resetHistoryContexts();
  swapHistory('');
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
});

/** A Ship instance with Flame overridden to x=5, then that override reverted (x back to 0). */
async function revertedShip() {
  setPrefabCache(SHIP, shipV1());
  const root = instantiatePrefab(shipV1());
  setPrefabSource(root, SHIP);
  overrideX(root, 'Flame', 5);
  const flameKey = `${piOf(member(root, 'Flame'))!.localId}.Transform.x`;
  const result = await quietly(() => revertOverridesWithUndo(root, new Set([flameKey])));
  expect(result).not.toBeNull(); // precondition
  expect(xOf(member(rootOf(SHIP), 'Flame'))).toBe(0);
}

/** The template changes outside this undo stack, and the path that moved the cache rebuilt the instance. */
async function templateChanges(to: PrefabFile) {
  setPrefabCache(SHIP, to);
  await quietly(() => rebaseStaleInstances());
  expect(framesBuiltFromOtherRows(rootOf(SHIP))).toEqual([]); // precondition: current against the new template
}

describe('Revert undo/redo after the template changed (#1665)', () => {
  it('undo puts the override back and keeps the member the template gained — nothing is saved as removed', async () => {
    await revertedShip();
    await templateChanges(shipV2());
    expect(member(rootOf(SHIP), 'Extra')).not.toBe(0); // precondition: the rebase brought it in

    await quietly(() => undo());
    const root = rootOf(SHIP);
    expect(xOf(member(root, 'Flame'))).toBe(5);
    expect(member(root, 'Extra')).not.toBe(0);
    expect(removedOnSave(SHIP)).toEqual([]);
    expect(framesBuiltFromOtherRows(root)).toEqual([]);
  });

  it('redo takes the override out again and still keeps the member', async () => {
    await revertedShip();
    await quietly(() => undo());
    await templateChanges(shipV2());
    expect(xOf(member(rootOf(SHIP), 'Flame'))).toBe(5); // precondition: the rebase kept the override

    await quietly(() => redo());
    const root = rootOf(SHIP);
    expect(xOf(member(root, 'Flame'))).toBe(0);
    expect(member(root, 'Extra')).not.toBe(0);
    expect(removedOnSave(SHIP)).toEqual([]);
  });

  it('a template re-save that RENUMBERED its rows: the override follows its member by nodeGuid', async () => {
    await revertedShip();
    // Same members, Flame now at localId 7: the Revert captured the override under 2.
    await templateChanges(doc(SHIP, 'Ship', [row(1, G(1), 'Ship', 0), row(7, G(2), 'Flame', 1), row(2, G(3), 'Extra', 1)]));

    await quietly(() => undo());
    const root = rootOf(SHIP);
    expect(xOf(member(root, 'Flame'))).toBe(5);
    expect(xOf(member(root, 'Extra'))).toBe(0); // the override did not land on the member that inherited localId 2
    expect(removedOnSave(SHIP)).toEqual([]);
  });

  it('a stale NESTED frame refuses the undo before anything is rebuilt, and the entry is dropped', async () => {
    const midV1 = doc(MID, 'Mid', [row(1, G(11), 'MidRoot', 0), row(2, G(12), 'Box', 1)]);
    setPrefabCache(MID, midV1);
    setPrefabCache(SHIP, doc(SHIP, 'Ship', [row(1, G(1), 'Ship', 0), row(2, G(2), 'Flame', 1), row(3, G(4), 'Mid', 1, { prefab: MID })]));
    const root = instantiatePrefab(getCachedPrefabSync(SHIP)!);
    setPrefabSource(root, SHIP);
    overrideX(root, 'Flame', 5);
    const flameKey = `${piOf(member(root, 'Flame'))!.localId}.Transform.x`;
    expect(await quietly(() => revertOverridesWithUndo(root, new Set([flameKey])))).not.toBeNull();
    // MID gains a row and nothing rebuilds the nested frame yet: it is built from rows the cache no longer holds.
    setPrefabCache(MID, doc(MID, 'Mid', [row(1, G(11), 'MidRoot', 0), row(2, G(12), 'Box', 1), row(3, G(13), 'Lid', 1)]));
    expect(framesBuiltFromOtherRows(rootOf(SHIP), { nestedOnly: true })).toEqual([MID]); // precondition

    const before = getAllEntities().map((e) => e.id).sort();
    const edits = getEditVersion();
    const toast = vi.spyOn(useEditorStore.getState(), 'showToast');
    await quietly(() => undo());
    // A REFUSAL, as Apply's undo refuses (#1664): nothing changed, so nothing is marked edited, and the toast says why.
    expect(getEditVersion()).toBe(edits);
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/refused: a prefab nested in this instance changed/), 'warn');
    toast.mockRestore();
    expect(xOf(member(rootOf(SHIP), 'Flame'))).toBe(0); // not put back over the stale frame
    expect(getAllEntities().map((e) => e.id).sort()).toEqual(before); // nothing rebuilt
    expect(canUndo()).toBe(false); // the entry was dropped, not moved to the redo stack
    expect(canRedo()).toBe(false);
  });
});

// The sibling #1665 named: Detach's undo (Hierarchy and the agent op both call `reattachDetachedInstance`) puts back
// links naming the document the instance was built from before the detach — observed as the same false removal.
describe('Detach undo after the template changed (#1665 sibling)', () => {
  it('the reattached instance is brought onto the current template — nothing is saved as removed', async () => {
    setPrefabCache(SHIP, shipV1());
    const root = instantiatePrefab(shipV1());
    setPrefabSource(root, SHIP);
    const snapshot = detachPrefabInstance(root);
    await templateChangesDetached(shipV2());

    expect(await quietly(() => reattachDetachedInstance(snapshot))).toBe(0);
    const live = rootOf(SHIP);
    expect(member(live, 'Extra')).not.toBe(0);
    expect(removedOnSave(SHIP)).toEqual([]);
    expect(framesBuiltFromOtherRows(live)).toEqual([]);
  });
});

/** The cache moves while the instance is detached; the rebase that follows passes over its plain entities. */

async function templateChangesDetached(to: PrefabFile) {
  setPrefabCache(SHIP, to);
  expect(await quietly(() => rebaseStaleInstances())).toBe(0); // precondition: nothing to rebuild while detached
}

describe('the review cases (#1665 close-out)', () => {
  it('a nested row`s ADDED node the template gained is not spawned twice by the undo', async () => {
    const KA = 'dddddddd-0000-4000-8000-000000001665';
    const midDoc = doc(MID, 'Mid', [row(1, G(11), 'MidRoot', 0), row(2, G(12), 'Box', 1)]);
    setPrefabCache(MID, midDoc);
    const ship = (lid: boolean) => {
      const d = doc(SHIP, 'Ship', [row(1, G(1), 'Ship', 0), row(2, G(2), 'Flame', 1), row(3, G(4), 'Mid', 1, { prefab: MID })]);
      if (lid) (d.entities[2] as unknown as Record<string, unknown>).added = [{ parentLocalId: 1, key: KA, guid: '', name: 'Lid', traits: { EntityAttributes: { name: 'Lid' }, Transform: { x: 0, y: 0, z: 0 } }, children: [] }];
      return d;
    };
    setPrefabCache(SHIP, ship(false));
    const root = instantiatePrefab(getCachedPrefabSync(SHIP)!);
    setPrefabSource(root, SHIP);
    overrideX(root, 'Flame', 5);
    expect(await quietly(() => revertOverridesWithUndo(root, new Set([`${piOf(member(root, 'Flame'))!.localId}.Transform.x`])))).not.toBeNull();
    await templateChanges(ship(true));
    const lids = () => getAllEntities().filter((e) => e.name === 'Lid').length;
    expect(lids()).toBe(1); // precondition: the rebase brought the row's node in

    await quietly(() => undo());
    expect(xOf(member(rootOf(SHIP), 'Flame'))).toBe(5);
    expect(lids()).toBe(1);
  });

  it('a nested move the Revert took back is set again by the undo after the rows were renumbered', async () => {
    const midDoc = doc(MID, 'Mid', [row(1, G(11), 'MidRoot', 0), row(2, G(12), 'Box', 1)]);
    setPrefabCache(MID, midDoc);
    setPrefabCache(SHIP, doc(SHIP, 'Ship', [row(1, G(1), 'Ship', 0), row(2, G(2), 'Flame', 1), row(3, G(4), 'Mid', 1, { prefab: MID })]));
    const root = instantiatePrefab(getCachedPrefabSync(SHIP)!);
    setPrefabSource(root, SHIP);
    const flame = member(root, 'Flame');
    const box = getAllEntities().find((e) => e.name === 'Box')!.id;
    // A move is recorded against the new parent's guid (`InstanceStructure.moved`), so both carry one.
    ensureGuid(flame); ensureGuid(box);
    entity(box).set(EntityAttributes, { ...(entity(box).get(EntityAttributes) as object), parentId: flame });
    const moves = nestedFrameMoves(root);
    expect(moves.map((m) => m.key)).toEqual(['~moved.3:2']); // precondition: the move is offered to the outer instance

    expect(await quietly(() => revertOverridesWithUndo(root, new Set([moves[0]!.key])))).not.toBeNull();
    const parentOfBox = () => getAllEntities().find((e) => e.name === 'Box')!.parentId;
    const nameOf = (id: number) => getAllEntities().find((e) => e.id === id)?.name;
    expect(nameOf(parentOfBox())).toBe('MidRoot'); // reverted
    // Same members, the Mid row now at localId 9.
    await templateChanges(doc(SHIP, 'Ship', [row(1, G(1), 'Ship', 0), row(2, G(2), 'Flame', 1), row(9, G(4), 'Mid', 1, { prefab: MID })]));

    await quietly(() => undo());
    expect(nameOf(parentOfBox())).toBe('Flame');
  });

  it('a template checked out to a pre-v5 copy (same rows, no nodeGuids): the override still comes back', async () => {
    await revertedShip();
    const unkeyed = (d: PrefabFile) => JSON.parse(JSON.stringify(d), (k, v) => (k === 'nodeGuid' ? undefined : v)) as PrefabFile;
    await templateChanges(unkeyed(shipV1()));

    await quietly(() => undo());
    expect(xOf(member(rootOf(SHIP), 'Flame'))).toBe(5);
  });

  it('Detach undo after the scene was RELOADED plain (the production route): brought onto the current template', async () => {
    setPrefabCache(SHIP, shipV1());
    const root = instantiatePrefab(shipV1());
    setPrefabSource(root, SHIP);
    detachPrefabInstanceWithUndo(root, 'Detach prefab "Ship"', '[test]');
    // The reload: the same plain entities, guids and parents, in a fresh world that recorded nothing.
    const plain = getAllEntities().map((e) => ({ id: e.id, name: e.name, parentId: e.parentId, guid: e.guid! }));
    expect(plain.every((p) => p.guid)).toBe(true); // precondition: detach left them addressable
    const prev = getCurrentWorld();
    setCurrentWorld(createWorld());
    prev?.destroy();
    const idOf = new Map<number, number>();
    for (const p of plain) idOf.set(p.id, spawnEntity(getCurrentWorld(), EntityAttributes({ name: p.name, parentId: 0, guid: p.guid }), Transform({ x: 0, y: 0, z: 0 })).id());
    for (const p of plain) if (p.parentId) entity(idOf.get(p.id)!).set(EntityAttributes, { ...(entity(idOf.get(p.id)!).get(EntityAttributes) as object), parentId: idOf.get(p.parentId) });
    setPrefabCache(SHIP, shipV2()); // saved in prefab edit while the scene was away

    await quietly(() => undo());
    const live = rootOf(SHIP);
    expect(member(live, 'Extra')).not.toBe(0);
    expect(removedOnSave(SHIP)).toEqual([]);
  });

  it('Detach undo → redo → undo: the member the first undo brought in is linked again, not left plain', async () => {
    setPrefabCache(SHIP, shipV1());
    const root = instantiatePrefab(shipV1());
    setPrefabSource(root, SHIP);
    detachPrefabInstanceWithUndo(root, 'Detach prefab "Ship"', '[test]');
    await templateChangesDetached(shipV2());
    await quietly(() => undo());
    expect(member(rootOf(SHIP), 'Extra')).not.toBe(0); // precondition

    await quietly(() => redo());
    await quietly(() => undo());
    const live = rootOf(SHIP);
    const extra = getAllEntities().filter((e) => e.name === 'Extra');
    expect(extra).toHaveLength(1);
    expect(piOf(extra[0]!.id)?.rootInstanceId).toBe(live);
    expect(removedOnSave(SHIP)).toEqual([]);
  });

  it('Create Prefab Replace undo: the restored links read their own document again, not the one that replaced it', async () => {
    setPrefabCache(SHIP, shipV1());
    const root = instantiatePrefab(shipV1());
    setPrefabSource(root, SHIP);
    const antenna = spawnEntity(getCurrentWorld(), EntityAttributes({ name: 'Antenna', parentId: root, guid: 'eeeeeeee-0000-4000-8000-000000011665' }), Transform({ x: 0, y: 0, z: 0 })).id();
    // Create Prefab → Replace Ship with this tree, the way assetOps does it: prior links snapshotted unstripped, the
    // new document cached, the tree retagged against it.
    const prior = detachPrefabInstance(root, { strip: false });
    const v2 = doc(SHIP, 'Ship', [row(1, G(1), 'Ship', 0), row(2, G(2), 'Flame', 1), row(3, G(5), 'Antenna', 1)]);
    setPrefabCache(SHIP, v2);
    const remap = tagEntityTreeAsInstance(root, SHIP, v2);
    expect(piOf(antenna)?.rootInstanceId).toBe(root); // precondition: the retag took the plain child in

    // …and its undo (assetOps' replace branch): the old document back in the cache, then unstamp, untag, reattach.
    setPrefabCache(SHIP, shipV1());
    unstampMemberGuids(remap);
    untagEntityTreeAsInstance(root, SHIP);
    reattachPrefabInstance(prior, { rootEcsId: root });
    expect(framesBuiltFromOtherRows(rootOf(SHIP))).toEqual([]);
    expect(removedOnSave(SHIP)).toEqual([]);
  });
});
