/** #2046 S7 close-out review: steps that work from records must not take a side from a record that does not state the
 *  tree as it stood, nor reproject a tree its records cannot place whole.
 *
 *  - A drag commit (gizmo, UI handle, collider points) takes its before-row AFTER the drag wrote live. A stale record
 *    re-seeded there captures the dragged value, so the undo put a row stating the value it was undoing (review F1).
 *  - A tree whose top record is fresh can hold a stale nested one (a scene-added reference node: a reparent of a member it
 *    supplies marks only its own record; a reload's bank leaves a record whose fold changed). A step taking the tree's
 *    records took that one as absent, then its own write re-seeded the tree: the undo dropped the record and rebuilt the
 *    node from the post-step capture (review F2).
 *  The fixture is the fuzzer's: O1, P1, H1 placed, Plain plain. Driven through the real routes where one exists. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored } from './prefabFuzz/harness';
import { pushAction } from '@modoki/engine/editor';
import { getCurrentWorld, getTraitByName } from '@modoki/engine/runtime';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { applyGuidRemap } from '../../packages/modoki/src/runtime/core/ecs/memberHome';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import {
  writeTraitFieldWithUndo, addTraitToEntitiesWithUndo,
} from '../../packages/modoki/src/editor/undo/entityActions';
import { markStale, storedInstance } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { buildTransformUndoAction } from '../../packages/modoki/src/editor/scene/gizmoUndo';
import { commitUIHandleDrag } from '../../packages/modoki/src/editor/scene/uiHandleCommit';
import { makeLiveFieldEditAction } from '../../packages/modoki/src/editor/undo/overrideMarkWrites';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { revertOverridesWithUndo } from '../../packages/modoki/src/editor/undo/revertPrefabUndo';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const meta = (name: string) => getTraitByName(name)!;
const p1Guid = () => authored().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8002-'))!.guid!;
/** The entity named `name` under P1. */
function inP1(name: string): number {
  const topId = authored().find((e) => e.guid === p1Guid())!.id;
  const inTree = (id: number): boolean => { for (let at = id; at; at = authored().find((e) => e.id === at)?.parentId ?? 0) if (at === topId) return true; return false; };
  const hits = authored().filter((e) => e.name === name && inTree(e.id));
  expect(hits, name).toHaveLength(1);
  return hits[0].id;
}
const guidOf = (id: number) => authored().find((e) => e.id === id)!.guid!;
const live = (id: number, trait: string, field: string) => (findEntity(id)!.get(meta(trait).trait) as Record<string, unknown>)[field];
const rawSet = (id: number, trait: string, values: Record<string, unknown>) => {
  const e = findEntity(id)!;
  e.set(meta(trait).trait, { ...(e.get(meta(trait).trait) as Record<string, unknown>), ...values });
};
/** P1's record: stale (nothing claimed), or the value its rows state for `trait.field` on any row. */
function p1States(trait: string, field: string): { stale: boolean; values: unknown[] } {
  const s = storedInstance(getCurrentWorld(), p1Guid())!;
  const values = [...s.record.list.rows.values()].map((r) => (r.traits?.[trait] as Record<string, unknown> | undefined)?.[field]).filter((v) => v !== undefined);
  return { stale: !!s.stale, values };
}

describe('a drag commit does not take its before-row from a re-seed of the dragged tree (review F1)', () => {
  // Mutation: `gizmoUndo.ts` takes the before side with `instanceEdits.rowsOf` again — the undo's record states x 7.
  it('gizmo: the undo of a drag on an overridden field, its record stale, leaves no record stating the dragged value', async () => {
    await startRun(be, async () => {}, 'f1-gizmo');
    const a = inP1('A');
    expect(writeTraitFieldWithUndo(a, meta('Transform'), 'x', 5)).toBeNull();
    markStale(getCurrentWorld(), 'test'); // what a step that does not maintain the records leaves (`undoStep`)
    rawSet(a, 'Transform', { x: 7 }); // the drag's live writes
    pushAction(buildTransformUndoAction({
      label: 'Move', trait: meta('Transform').trait, resolve: () => a, findEntity: (id) => findEntity(id) as never,
      before: { x: 5 }, after: { x: 7 }, entityGuid: guidOf(a), markFields: ['x'],
    }));
    expect((await undoStep('undo')).did).toBe(true);
    expect(live(a, 'Transform', 'x')).toBe(5);
    const s = p1States('Transform', 'x');
    expect(s.stale || (s.values.includes(5) && !s.values.includes(7)), JSON.stringify(s)).toBe(true);
  });

  // Mutation: `uiHandleCommit.ts` takes `oldRows` with `instanceEdits.rowsOf` again — the undo's record states width 150.
  it('UI handle: the same for a resize of an overridden UIElement size', async () => {
    await startRun(be, async () => {}, 'f1-ui');
    const a = inP1('A');
    expect(addTraitToEntitiesWithUndo([a], meta('UIElement'))).toBeFalsy();
    expect(writeTraitFieldWithUndo(a, meta('UIElement'), 'width', 100)).toBeNull();
    markStale(getCurrentWorld(), 'test');
    rawSet(a, 'UIElement', { width: 150 });
    commitUIHandleDrag(a, 'UIElement', { width: 100 }, { width: 150 }, 'Resize');
    expect((await undoStep('undo')).did).toBe(true);
    expect(live(a, 'UIElement', 'width')).toBe(100);
    const s = p1States('UIElement', 'width');
    expect(s.stale || (s.values.includes(100) && !s.values.includes(150)), JSON.stringify(s)).toBe(true);
  });

  // Mutation: `makeLiveFieldEditAction` takes `oldRows` with `instanceEdits.rowsOf` again — the undo's record states the
  // dragged points.
  it('collider points: the same for a points drag on an overridden Collider2D', async () => {
    await startRun(be, async () => {}, 'f1-points');
    const a = inP1('A');
    const [was, dragged] = ['[[0,0],[1,0],[0,1]]', '[[0,0],[2,0],[0,2]]'];
    expect(addTraitToEntitiesWithUndo([a], meta('Collider2D'))).toBeFalsy();
    expect(writeTraitFieldWithUndo(a, meta('Collider2D'), 'points', was)).toBeNull();
    markStale(getCurrentWorld(), 'test');
    rawSet(a, 'Collider2D', { points: dragged });
    pushAction(makeLiveFieldEditAction(a, 'Collider2D', 'points', (id, v: string) => rawSet(id, 'Collider2D', { points: v }), was, dragged, 'Edit points'));
    expect((await undoStep('undo')).did).toBe(true);
    expect(live(a, 'Collider2D', 'points')).toBe(was);
    const s = p1States('Collider2D', 'points');
    expect(s.stale || (s.values.includes(was) && !s.values.includes(dragged)), JSON.stringify(s)).toBe(true);
  });
});

describe('a step takes a tree\'s records only once every record in it is fresh (review F2)', () => {
  /** H placed under P1's A — a scene-added reference node, its own record — with x overridden at 5, and only ITS record
   *  stale (P1's fresh). */
  async function setup(key: string): Promise<{ hn: number; hGuid: string; hPath: string }> {
    const f = await startRun(be, async () => {}, key);
    const hn = await placePrefabFromPath(f.prefabs.H.path, { tag: 'test', parentId: inP1('A') });
    expect(hn).toBeTruthy();
    await settle();
    const hGuid = guidOf(hn!);
    expect(writeTraitFieldWithUndo(hn!, meta('Transform'), 'x', 5)).toBeNull();
    markStale(getCurrentWorld(), 'test', [hGuid]);
    // Premise: the nested record stale, the top's fresh.
    expect(storedInstance(getCurrentWorld(), hGuid)?.stale).toBe('test');
    expect(storedInstance(getCurrentWorld(), p1Guid())?.stale).toBeUndefined();
    return { hn: hn!, hGuid, hPath: f.prefabs.H.path };
  }
  const byGuid = (g: string) => authored().find((e) => e.guid === g)!.id;

  // Mutation: `prefabRevert.ts` checks only the top's record (`recordForWrite(top, topGuid)`) — the undo leaves x at 0.
  it('Revert: the undo of a Revert on a nested instance whose record was stale puts its override back', async () => {
    const { hn, hGuid } = await setup('f2-revert');
    expect(await revertOverridesWithUndo(hn, new Set(['1.Transform.x']))).not.toBeNull();
    await settle();
    expect(live(byGuid(hGuid), 'Transform', 'x')).toBe(0);
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(live(byGuid(hGuid), 'Transform', 'x')).toBe(5);
  });

  // Mutation: `takeTreeRecords` AND `reseedEveryTree` check only the top's record — the undo restores H's document and
  // drops the override. Either one alone is covered by the other: the Apply re-seeds every tree before it takes them.
  it('Apply: the undo of an Apply from a nested instance whose record was stale puts its override back', async () => {
    const { hn, hGuid } = await setup('f2-apply');
    const r = await applyToPrefabWithUndo(hn, new Set(['1.Transform.x']));
    expect(r.refused, r.refused).toBeUndefined();
    expect(r.applied).toBeTruthy();
    await settle();
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(live(byGuid(hGuid), 'Transform', 'x')).toBe(5);
  });
});

describe('a rename marks stale every record naming a renamed guid (#2046 S7 close-out review)', () => {
  // Mutation: the `onGuidRemap('instanceStore', …)` listener removed — P1's record goes on naming the old guid, fresh.
  it('a field override naming a renamed node: after the rename the record is stale, not stating the old guid', async () => {
    await startRun(be, async () => {}, 'rename-ref');
    const a = inP1('A');
    const leaf = authored().find((e) => e.name === 'Leaf')!.guid!;
    expect(addTraitToEntitiesWithUndo([a], meta('Collider2D'))).toBeFalsy();
    expect(writeTraitFieldWithUndo(a, meta('Collider2D'), 'physicsLayer', leaf)).toBeNull();
    expect(p1States('Collider2D', 'physicsLayer')).toEqual({ stale: false, values: [leaf] }); // premise
    const renamed = `abcdef01${leaf.slice(8)}`;
    applyGuidRemap(new Map([[leaf, renamed]])); // what Create Prefab's renames run (`stampDerivedMemberGuids`, the unstamp)
    expect(live(a, 'Collider2D', 'physicsLayer')).toBe(renamed); // premise: the live ref followed
    expect(p1States('Collider2D', 'physicsLayer').stale).toBe(true);
  });
});
