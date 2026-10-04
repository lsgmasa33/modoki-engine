/** #2046 S7 close-out review: steps that work from records must not take a side from a record that does not state the
 *  tree as it stood, nor reproject a tree its records cannot place whole.
 *
 *  - A drag commit (gizmo, UI handle, collider points) takes its before-row AFTER the drag wrote live. A record
 *    re-seeded there captured the dragged value, so the undo put a row stating the value it was undoing (review F1).
 *  - A tree whose top record is stored can lack a nested one (a scene-added reference node's). A step taking the tree's
 *    records took that one as absent, then its own write re-seeded the tree: the undo dropped the record and rebuilt the
 *    node from the post-step capture (review F2).
 *  The records were STALE in those cases until #2001 S8b deleted the mark (no op set it any more); a MISSING record is
 *  what still reaches the same paths, so the cases drop it.
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
import { storedInstance, dropInstanceRecord, storedInstances } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { buildTransformUndoAction } from '../../packages/modoki/src/editor/scene/gizmoUndo';
import { commitUIHandleDrag } from '../../packages/modoki/src/editor/scene/uiHandleCommit';
import { makeLiveFieldEditAction } from '../../packages/modoki/src/editor/undo/overrideMarkWrites';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { revertOverridesWithUndo } from '../../packages/modoki/src/editor/undo/revertPrefabUndo';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { refreshInstances, captureEntrySide, rebuildEntrySide } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { NO_RECORD_TO_WRITE } from '../../packages/modoki/src/editor/instance/instanceRollback';
import { whyWorldNotAuthored } from '../../packages/modoki/src/editor/scene/authoredWorld';
/** No record for any instance: what a stale store once stood for (#2001 S8b deleted the mark). */
const dropAllRecords = (w: ReturnType<typeof getCurrentWorld>): void => { for (const g of [...storedInstances(w).keys()]) dropInstanceRecord(w, g); };

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
/** P1's record: missing (nothing claimed), or the value its rows state for `trait.field` on any row. */
function p1States(trait: string, field: string): { missing: boolean; values: unknown[] } {
  const s = storedInstance(getCurrentWorld(), p1Guid());
  const values = [...(s?.record.list.rows.values() ?? [])].map((r) => (r.traits?.[trait] as Record<string, unknown> | undefined)?.[field]).filter((v) => v !== undefined);
  return { missing: !s, values };
}

describe('a drag commit does not take its before-row from a re-seed of the dragged tree (review F1)', () => {
  // Mutation: `gizmoUndo.ts` takes the before side with `instanceEdits.rowsOf` again — the undo's record states x 7.
  it('gizmo: the undo of a drag on an overridden field, its record missing, leaves no record stating the dragged value', async () => {
    await startRun(be, async () => {}, 'f1-gizmo');
    const a = inP1('A');
    expect(writeTraitFieldWithUndo(a, meta('Transform'), 'x', 5)).toBeNull();
    dropAllRecords(getCurrentWorld());
    rawSet(a, 'Transform', { x: 7 }); // the drag's live writes
    pushAction(buildTransformUndoAction({
      label: 'Move', trait: meta('Transform').trait, resolve: () => a, findEntity: (id) => findEntity(id) as never,
      before: { x: 5 }, after: { x: 7 }, entityGuid: guidOf(a), markFields: ['x'],
    }));
    expect((await undoStep('undo')).did).toBe(true);
    expect(live(a, 'Transform', 'x')).toBe(5);
    const s = p1States('Transform', 'x');
    expect(s.missing || (s.values.includes(5) && !s.values.includes(7)), JSON.stringify(s)).toBe(true);
  });

  // Mutation: `uiHandleCommit.ts` takes `oldRows` with `instanceEdits.rowsOf` again — the undo's record states width 150.
  it('UI handle: the same for a resize of an overridden UIElement size', async () => {
    await startRun(be, async () => {}, 'f1-ui');
    const a = inP1('A');
    expect(addTraitToEntitiesWithUndo([a], meta('UIElement'))).toBeFalsy();
    expect(writeTraitFieldWithUndo(a, meta('UIElement'), 'width', 100)).toBeNull();
    dropAllRecords(getCurrentWorld());
    rawSet(a, 'UIElement', { width: 150 });
    commitUIHandleDrag(a, 'UIElement', { width: 100 }, { width: 150 }, 'Resize');
    expect((await undoStep('undo')).did).toBe(true);
    expect(live(a, 'UIElement', 'width')).toBe(100);
    const s = p1States('UIElement', 'width');
    expect(s.missing || (s.values.includes(100) && !s.values.includes(150)), JSON.stringify(s)).toBe(true);
  });

  // Mutation: `makeLiveFieldEditAction` takes `oldRows` with `instanceEdits.rowsOf` again — the undo's record states the
  // dragged points.
  it('collider points: the same for a points drag on an overridden Collider2D', async () => {
    await startRun(be, async () => {}, 'f1-points');
    const a = inP1('A');
    const [was, dragged] = ['[[0,0],[1,0],[0,1]]', '[[0,0],[2,0],[0,2]]'];
    expect(addTraitToEntitiesWithUndo([a], meta('Collider2D'))).toBeFalsy();
    expect(writeTraitFieldWithUndo(a, meta('Collider2D'), 'points', was)).toBeNull();
    dropAllRecords(getCurrentWorld());
    rawSet(a, 'Collider2D', { points: dragged });
    pushAction(makeLiveFieldEditAction(a, 'Collider2D', 'points', (id, v: string) => rawSet(id, 'Collider2D', { points: v }), was, dragged, 'Edit points'));
    expect((await undoStep('undo')).did).toBe(true);
    expect(live(a, 'Collider2D', 'points')).toBe(was);
    const s = p1States('Collider2D', 'points');
    expect(s.missing || (s.values.includes(was) && !s.values.includes(dragged)), JSON.stringify(s)).toBe(true);
  });
});

describe('a step takes a tree\'s records only once every record in it is stored (review F2)', () => {
  /** H placed under P1's A — a scene-added reference node, its own record — with x overridden at 5, and only ITS record
   *  missing (P1's stored). */
  async function setup(key: string): Promise<{ hn: number; hGuid: string; hPath: string }> {
    const f = await startRun(be, async () => {}, key);
    const hn = await placePrefabFromPath(f.prefabs.H.path, { tag: 'test', parentId: inP1('A') });
    expect(hn).toBeTruthy();
    await settle();
    const hGuid = guidOf(hn!);
    expect(writeTraitFieldWithUndo(hn!, meta('Transform'), 'x', 5)).toBeNull();
    dropInstanceRecord(getCurrentWorld(), hGuid);
    // Premise: the nested record missing, the top's stored.
    expect(storedInstance(getCurrentWorld(), p1Guid())).toBeDefined();
    return { hn: hn!, hGuid, hPath: f.prefabs.H.path };
  }
  const byGuid = (g: string) => authored().find((e) => e.guid === g)!.id;

  // #2001 S8b: no re-seed from the capture any more, so a Revert on a tree missing a record is refused before it
  // changes anything (records exact or refuse). H's own Revert is refused by its own list too (`instanceEdits.revert`
  // reads the frame's record); one on P1, whose record is stored, only by the tree's. Mutation: `prefabRevert.ts` checks
  // only the top's record (`storedRecord` of the top in place of `treeForWrite(top)`) — the second case red.
  it('Revert: a Revert on a nested instance whose record is missing is refused, and changes nothing', async () => {
    const { hn, hGuid } = await setup('f2-revert');
    expect(await revertOverridesWithUndo(hn, new Set(['1.Transform.x']))).toBeNull();
    await settle();
    expect(live(byGuid(hGuid), 'Transform', 'x')).toBe(5);
    expect(storedInstance(getCurrentWorld(), hGuid), 'nothing re-seeded it').toBeUndefined();
  });
  it('Revert: …and so is one on the tree\'s top, its own record stored', async () => {
    const { hGuid } = await setup('f2-revert-top');
    expect(await revertOverridesWithUndo(byGuid(p1Guid()), new Set(['1.Transform.x']))).toBeNull();
    expect(storedInstance(getCurrentWorld(), hGuid), 'nothing re-seeded it').toBeUndefined();
  });

  // Records exact or refuse (#2001 S8b): with H's record missing nothing states which of the tree's fields are its own (the
  // marks that did are gone), so the Apply is refused before it writes — as the Revert above is. (Before the marks went it
  // ran on the snapshot route, and its undo put the override back from them.) Mutation: drop the refusal in
  // `applyToPrefabWithUndo` (`!recordsBefore`) — the Apply writes P and this goes red.
  it('Apply: an Apply from a nested instance whose record is missing is refused, and changes nothing', async () => {
    const { hn, hGuid } = await setup('f2-apply');
    const r = await applyToPrefabWithUndo(hn, new Set(['1.Transform.x']));
    expect(r.applied).toBe(false);
    expect(r.refused).toMatch(/override list could not be read/);
    await settle();
    expect(live(byGuid(hGuid), 'Transform', 'x')).toBe(5);
    expect(storedInstance(getCurrentWorld(), hGuid), 'nothing re-seeded it').toBeUndefined();
  });
});

describe('a rename follows into every record naming a renamed guid (#2001 S8b; was marked stale, #2046 S7 close-out review)', () => {
  // Mutation: the `onGuidRemap('instanceStore', …)` listener removed — P1's record goes on naming the old guid.
  it('a field override naming a renamed node: after the rename the record states the new guid', async () => {
    await startRun(be, async () => {}, 'rename-ref');
    const a = inP1('A');
    const leaf = authored().find((e) => e.name === 'Leaf')!.guid!;
    expect(addTraitToEntitiesWithUndo([a], meta('Collider2D'))).toBeFalsy();
    expect(writeTraitFieldWithUndo(a, meta('Collider2D'), 'physicsLayer', leaf)).toBeNull();
    expect(p1States('Collider2D', 'physicsLayer')).toEqual({ missing: false, values: [leaf] }); // premise
    const renamed = `abcdef01${leaf.slice(8)}`;
    applyGuidRemap(new Map([[leaf, renamed]])); // what Create Prefab's renames run (`stampDerivedMemberGuids`, the unstamp)
    expect(live(a, 'Collider2D', 'physicsLayer')).toBe(renamed); // premise: the live ref followed
    expect(p1States('Collider2D', 'physicsLayer')).toEqual({ missing: false, values: [renamed] });
  });

  it('a renamed root keeps its record under the new guid; a swap swaps them', async () => {
    await startRun(be, async () => {}, 'rename-root');
    const world = getCurrentWorld();
    const p1 = p1Guid(), o1 = authored().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8001-'))!.guid!;
    const recP = storedInstance(world, p1)!.record, recO = storedInstance(world, o1)!.record;
    applyGuidRemap(new Map([[p1, o1], [o1, p1]]));
    expect(storedInstance(world, o1)?.record).toBe(recP);
    expect(storedInstance(world, p1)?.record).toBe(recO);
    expect(recP.rootGuid).toBe(o1);
    expect(recO.rootGuid).toBe(p1);
  });
});

describe('a rebuild leaves a tree with no record as it was, and blocks the save (#2001 S8b, hub ruling)', () => {
  /** P1 with A's x overridden at 5, then every record dropped: a state no gesture makes (the load and every placement
   *  record what they build), standing for a load that failed to. */
  async function setup(key: string): Promise<{ p1: number; a: number; source: string; hPath: string; warns: string[] }> {
    const f = await startRun(be, async () => {}, key);
    const a = inP1('A');
    expect(writeTraitFieldWithUndo(a, meta('Transform'), 'x', 5)).toBeNull();
    const p1 = authored().find((e) => e.guid === p1Guid())!.id;
    const warns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...m: unknown[]) => { warns.push(m.map(String).join(' ')); });
    return { p1, a, source: f.prefabs.P.guid, hPath: f.prefabs.H.path, warns };
  }
  const leftAsItWas = (p1: number, a: number, warns: string[]) => {
    expect(findEntity(p1)?.id(), 'P1 not respawned').toBe(p1);
    expect(findEntity(a)?.id(), 'A not respawned').toBe(a);
    expect(live(a, 'Transform', 'x')).toBe(5);
    expect(warns.some((w) => w.includes('has no instance record') && w.includes(`(${p1Guid()})`)), warns.join('\n')).toBe(true);
    expect(whyWorldNotAuthored()).toBe(NO_RECORD_TO_WRITE);
  };

  // Mutation: drop `leftRecordless` from `rebuildTargetsByEntry` — the refresh rebuilds P1 from its capture (counted 1,
  // respawned) and the world stays savable.
  it('a refresh of its prefab (what an Apply or a template write fans out) leaves it, says so, and marks the world', async () => {
    const { p1, a, source, warns } = await setup('rebuild-norec-refresh');
    dropAllRecords(getCurrentWorld());
    const doc = getCachedPrefabSync(source)!;
    expect(whyWorldNotAuthored(), 'premise: savable before').toBeNull();
    try {
      expect(refreshInstances(source, [p1], doc, structuredClone(doc))).toBe(0);
      leftAsItWas(p1, a, warns);
    } finally { vi.restoreAllMocks(); }
  });

  // Mutation: drop `leftRecordless` from `rebuildEntrySide` — the undo side's entry is loaded onto P1 (respawned), and the
  // world stays savable.
  it('an undo side rebuilt over it (a Revert\'s or an Apply\'s undo) leaves it, says so, and marks the world', async () => {
    const { p1, a, warns } = await setup('rebuild-norec-side');
    const side = captureEntrySide(p1)!;
    expect(side, 'premise: a side to rebuild').toBeTruthy();
    dropAllRecords(getCurrentWorld());
    try {
      expect(rebuildEntrySide(side)).toBe(0);
      leftAsItWas(p1, a, warns);
    } finally { vi.restoreAllMocks(); }
  });

  // A tree whose top record is stored and a nested one is not (H placed under A): its records cannot rebuild it, so it was
  // left already (`keepsRecord`); now the missing one is named and the world marked. Mutation: the refresh's kept branch
  // warns `KEPT_WHY` alone again (no `leftRecordless`) — the warning names nothing and the world stays savable.
  it('…and so does a refresh of a tree only a nested record of which is missing, naming that instance', async () => {
    const { p1, a, source, warns, hPath } = await setup('rebuild-norec-nested');
    const hn = await placePrefabFromPath(hPath, { tag: 'test', parentId: a });
    expect(hn).toBeTruthy();
    await settle();
    const hGuid = guidOf(hn!);
    dropInstanceRecord(getCurrentWorld(), hGuid);
    expect(storedInstance(getCurrentWorld(), p1Guid()), 'premise: the top record stored').toBeDefined();
    const doc = getCachedPrefabSync(source)!;
    try {
      expect(refreshInstances(source, [p1], doc, structuredClone(doc))).toBe(0);
      expect(findEntity(hn!)?.id(), 'H not respawned').toBe(hn);
      expect(warns.some((w) => w.includes('has no instance record') && w.includes(`(${hGuid}) in instance`)), warns.join('\n')).toBe(true);
      expect(whyWorldNotAuthored()).toBe(NO_RECORD_TO_WRITE);
    } finally { vi.restoreAllMocks(); }
  });
});

describe('a Transient instance owns no record (#2001 S8b)', () => {
  // A UIEntries pooled row is a prefab instance spawned in a system tick, every entity of it `Transient`, under a member
  // of an authored instance. The save skips it, so nothing records it — and counted as a stored root of the tree, its
  // missing record made the save refuse the whole tree and mark the world unsavable; a refresh left the tree the same
  // way. Mutation: `ownsRecord` (`instanceKeys.ts`) counts a Transient root again — the save throws, both red.
  async function withPooledRow(key: string): Promise<{ source: string; rowGuid: string }> {
    const f = await startRun(be, async () => {}, key);
    const { instantiatePrefab } = await import('../../packages/modoki/src/editor/scene/prefabInstantiate');
    const { setPrefabSource } = await import('../../packages/modoki/src/editor/scene/prefabCache');
    const { Transient } = await import('../../packages/modoki/src/runtime/core/traits/Transient');
    const row = instantiatePrefab(getCachedPrefabSync(f.prefabs.H.guid)! as never, inP1('A'));
    setPrefabSource(row, { id: f.prefabs.H.guid });
    const ids = new Set<number>([row]);
    for (let grew = true; grew;) { grew = false; for (const e of authored()) if (e.parentId && ids.has(e.parentId) && !ids.has(e.id)) { ids.add(e.id); grew = true; } }
    for (const id of ids) findEntity(id)!.add(Transient); // as `spawnEntity` tags every entity spawned in a tick
    return { source: f.prefabs.P.guid, rowGuid: guidOf(row) };
  }
  it('the save writes the tree a pooled row hangs in, without the row', async () => {
    const { rowGuid } = await withPooledRow('transient-row-save');
    expect(rowGuid, 'premise: the row has a guid to look for').toBeTruthy();
    const { serializeScene } = await import('../../packages/modoki/src/editor/scene/serialize');
    const saved = await serializeScene() as unknown as { entities: { name?: string }[] };
    expect(JSON.stringify(saved.entities)).not.toContain(rowGuid);
    expect(whyWorldNotAuthored()).toBeNull();
  });
  it('a refresh of the tree\'s prefab is not refused for it', async () => {
    const { source } = await withPooledRow('transient-row-refresh');
    const doc = getCachedPrefabSync(source)!;
    const p1 = authored().find((e) => e.guid === p1Guid())!.id;
    expect(refreshInstances(source, [p1], doc, structuredClone(doc))).toBe(1);
    expect(whyWorldNotAuthored()).toBeNull();
  });
});
