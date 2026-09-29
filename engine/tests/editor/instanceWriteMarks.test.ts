/** Editor writes to a prefab-instance field survive a save + reload (#1709, #1677).
 *
 *  The save keeps a member's field only when it is override-marked (`captureInstanceOverrides`' mark gate). These
 *  gestures wrote without marking, so the save dropped them: the UI resize/move handles, every `sortOrder` rewrite
 *  (reorder, sibling renumber, duplicate, paste, scene move — the last is in crossSceneReparent.test.ts), and
 *  re-adding a trait the template defines. Undo had the opposite gap: it restored the value and kept the mark, so an
 *  undone edit was saved pinned at the old value and stopped following the template. The marks now go through
 *  `editor/undo/overrideMarkWrites.ts`.
 *
 *  Each case is: load, edit, save, reload, driven through the real loader and the real capture, and names the
 *  mutation that turns it red. */

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
import {
  setActionCallback, pushAction, clearHistory, undo, redo, writeTraitFieldWithUndo, reparentEntity, duplicateEntity,
  addTraitToEntitiesWithUndo, removeTraitFromEntitiesWithUndo,
} from '@modoki/engine/editor';
import {
  pasteTraitAsNewWithUndo, pasteTraitValuesWithUndo, writeTraitFieldMultiWithUndo, writeTraitFieldPerEntityWithUndo,
} from '../../packages/modoki/src/editor/undo/entityActions';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { writeUIHandleValues, commitUIHandleDrag } from '../../packages/modoki/src/editor/scene/uiHandleCommit';
import { makeSortOrderRenumberAction } from '../../packages/modoki/src/editor/undo/overrideMarkWrites';
import { buildTransformUndoAction } from '../../packages/modoki/src/editor/scene/gizmoUndo';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { entityRef } from '../../packages/modoki/src/editor/undo/entityRef';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000001709';
const ROOT1 = 'dddddddd-0000-4000-8000-000000001709';
const OTHER = 'dddddddd-0000-4000-8000-000000001710';
const g = (n: number) => `eeeeeeee-0000-4000-8000-00000000170${n}`;

/** P: R → A, B, C, D (sortOrder 0, 10, 20, 30), U (a UI element, sortOrder 40). A authors Rotate3D. */
const pDoc = (patch: (d: ReturnType<typeof baseDoc>) => void = () => {}) => { const d = baseDoc(); patch(d); return d; };
const baseDoc = () => {
  const row = (localId: number, name: string, parentId: number, sortOrder: number, traits: Record<string, unknown> = {}) => ({
    localId, name, nodeGuid: g(localId),
    traits: { EntityAttributes: { name, parentId, guid: '', sortOrder }, Transform: { x: 0, y: 0, z: 0 }, ...traits },
  });
  return {
    id: P, version: 5, name: 'P', rootLocalId: 1,
    entities: [
      row(1, 'R', 0, 0),
      row(2, 'A', 1, 0, { Rotate3D: { axis: 'x', speed: 3 } }),
      row(3, 'B', 1, 10), row(4, 'C', 1, 20), row(5, 'D', 1, 30),
      row(6, 'U', 1, 40, { UIElement: { width: 100, height: 50 }, UIAnchor: { top: 5, left: 5, right: 0, bottom: 0 } }),
    ],
  };
};
const install = (d: { id: string }) => { prefabs.set(d.id, d); setPrefabCache(d.id, d as never); };

/** One top-level instance of P beside a plain entity at sortOrder 3. */
const scene = (): SceneData => ({
  id: 's1709', version: 14, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Other', parentId: 0, guid: OTHER, sortOrder: 3 } } },
    { id: 2, prefab: P, guid: ROOT1, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } } },
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
const rootId = () => getAllEntities().find((e) => e.guid === ROOT1)!.id;
/** The member named `name` of the instance (the root is 'R'). */
const member = (name: string): number => {
  const root = rootId();
  if (name === 'R') return root;
  const hits = getAllEntities().filter((e) => e.name === name && e.parentId === root);
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} members named ${name}`);
  return hits[0]!.id;
};
const field = (id: number, trait: string, f: string) => (readTraitData(id, meta(trait)) as Record<string, unknown>)[f];
const sortOf = (name: string) => field(member(name), 'EntityAttributes', 'sortOrder');
const saved = async () => serializeScene() as unknown as Promise<SceneData>;
/** Save, then reload what was saved: what the user gets back. */
const saveAndReload = async () => { const s = await saved(); await load(s); return s; };

beforeEach(async () => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  clearKeptMemberOrphans();
  install(pDoc());
  await load(scene());
});
afterAll(() => { setPrefabCache(P, null); getCurrentWorld()?.destroy(); });

describe('the UI resize/move handles on an instance member (#1709)', () => {
  const dragUI = (trait: 'UIElement' | 'UIAnchor', to: Record<string, unknown>) => {
    const u = member('U');
    const before = { ...(readTraitData(u, meta(trait)) as Record<string, unknown>) };
    writeUIHandleValues(u, trait, to); // the drag's live frames
    commitUIHandleDrag(u, trait, before, { ...(readTraitData(u, meta(trait)) as Record<string, unknown>) }, 'drag');
  };

  // Mutation: drop the `reconcileOverrideMarks` call in commitUIHandleDrag — both reload at the template's values.
  it('a resize survives save + reload', async () => {
    dragUI('UIElement', { width: 200 });
    await saveAndReload();
    expect([field(member('U'), 'UIElement', 'width'), field(member('U'), 'UIElement', 'height')]).toEqual([200, 50]);
  });

  it('a move survives save + reload', async () => {
    dragUI('UIAnchor', { top: 25, left: 30 });
    await saveAndReload();
    expect([field(member('U'), 'UIAnchor', 'top'), field(member('U'), 'UIAnchor', 'left')]).toEqual([25, 30]);
  });

  // Mutation: drop `putMarkState(id, trait, oldMarks)` from commitUIHandleDrag's undo — the undone width stays
  // marked, is saved at 100, and the template's later 120 never reaches the instance.
  it('an undone resize is not saved as an override: the instance still follows the template', async () => {
    dragUI('UIElement', { width: 200 });
    await undo();
    const s = await saved();
    install(pDoc((d) => { (d.entities[5]!.traits as Record<string, Record<string, unknown>>).UIElement!.width = 120; }));
    await load(s);
    expect(field(member('U'), 'UIElement', 'width')).toBe(120);
  });

  // Mutation: make reconcileOverrideMarks mark unconditionally, or drop its unmark branch — the second drag, back onto
  // the base, leaves the width marked at 100.
  it('a drag that ends back on the base pins nothing', async () => {
    dragUI('UIElement', { width: 200 });
    dragUI('UIElement', { width: 100 });
    const s = await saved();
    install(pDoc((d) => { (d.entities[5]!.traits as Record<string, Record<string, unknown>>).UIElement!.width = 120; }));
    await load(s);
    expect(field(member('U'), 'UIElement', 'width')).toBe(120);
  });
});

describe('sortOrder rewrites on an instance (#1709)', () => {
  // A member is not reordered any more (#1869: the prefab supplies its place), so the reorder these pin is the instance
  // ROOT's, among the scene's own entities: its sortOrder is an override on the root row (I21), and the template's root
  // row is its base. `rootSort` reads it; `rootRow` patches the template's.
  const rootSort = () => field(rootId(), 'EntityAttributes', 'sortOrder');
  const rootRow = (sortOrder: number) => (d: ReturnType<typeof baseDoc>) => { (d.entities[0]!.traits.EntityAttributes as Record<string, unknown>).sortOrder = sortOrder; };

  // Mutation A: make `writeTraitFieldMarked` a raw write (drop its reconcile) — the root reloads at the template's 20.
  it('a reordered instance root keeps its place over a later template change', async () => {
    reparentEntity(rootId(), 0, 5);
    const s = await saved();
    install(pDoc(rootRow(20)));
    await load(s);
    expect(rootSort()).toBe(5);
  });

  // Mutation: drop the `unmarkOverride` branch of reconcileOverrideMarks — the root, reordered back onto its base 0,
  // stays marked and ignores the template's later 40.
  it('a reorder that puts the root back on its base unmarks it', async () => {
    reparentEntity(rootId(), 0, 7);
    reparentEntity(rootId(), 0, 0);
    const s = await saved();
    install(pDoc(rootRow(40)));
    await load(s);
    expect(rootSort()).toBe(40);
  });

  // #1709 close-out review: reparentEntity took its undo's mark snapshot AFTER its own marked sortOrder write, so the
  // undo put the new mark back and the old order was saved pinned. Mutation: move `const oldMarks = captureMarks(entityId)`
  // in reparentEntity back below the writes — the root stays marked at 0 and ignores the template's 40.
  it('an undone reorder is not saved as an override', async () => {
    reparentEntity(rootId(), 0, 5);
    await undo();
    expect(rootSort()).toBe(0);
    const s = await saved();
    install(pDoc(rootRow(40)));
    await load(s);
    expect(rootSort()).toBe(40);
  });

  // The renumber's undo puts back the marks it found, snapshotted before it ran (`makeSortOrderRenumberAction`, the
  // Hierarchy's builder). B carries a stored override equal to its base (marked before, stays marked); C has none
  // (the renumber marks it, the undo must unmark it). After the undo the template moves both: B keeps its override,
  // C follows.
  // Mutation A: drop `putMarkState` in restorableSortOrderWrite — C stays marked at 20 and ignores the template's 25.
  // Mutation B: snapshot after the renumber (build restorableSortOrderWrite at undo time) — the same.
  // Mutation C: pass no revert (the undo re-reconciles) — B is unmarked and follows the template's 15.
  it('an undone renumber restores every sibling\'s mark as it was', async () => {
    writeTraitFieldWithUndo(member('B'), meta('EntityAttributes'), 'sortOrder', 10); // marked, equal to the base
    await load(await saved());
    clearHistory();
    const renumber = makeSortOrderRenumberAction([
      { id: member('B'), oldSort: 10, newSort: 1 }, { id: member('C'), oldSort: 20, newSort: 5 },
    ])!;
    renumber.redo(); pushAction(renumber);
    await undo();
    const s = await saved();
    install(pDoc((d) => {
      (d.entities[2]!.traits.EntityAttributes as Record<string, unknown>).sortOrder = 15;
      (d.entities[3]!.traits.EntityAttributes as Record<string, unknown>).sortOrder = 25;
    }));
    await load(s);
    expect([sortOf('B'), sortOf('C')]).toEqual([10, 25]);
  });

  // A reparent that sets no sortOrder must not touch the mark on redo either (close-out re-review: the redo wrote the
  // unchanged value through the marking writer, re-reconciling a stored override away). The root, moved under Other.
  // Mutation: make the redo call `writeTraitFieldMarked(..., 'sortOrder', ...)` unconditionally with the old value.
  it('an undone + redone reparent with no sortOrder keeps a stored override', async () => {
    writeTraitFieldWithUndo(rootId(), meta('EntityAttributes'), 'sortOrder', 0); // marked, equal to the base
    await load(await saved());
    clearHistory();
    const other = getAllEntities().find((e) => e.guid === OTHER)!.id;
    expect(reparentEntity(rootId(), other)).toBe(true);
    await undo();
    await redo();
    const s = await saved();
    install(pDoc(rootRow(15)));
    await load(s);
    expect(rootSort()).toBe(0);
  });

  // Mutation: make `assignFreshSortOrder` write raw (`writeTraitField`) — the copy's root reloads at the template's 0.
  // (Paste Entity calls the same function.)
  it('a duplicated instance root keeps its place after a save + reload', async () => {
    duplicateEntity(rootId(), () => {});
    const copies = () => getAllEntities().filter((e) => e.parentId === 0 && e.guid !== ROOT1 && e.guid !== OTHER);
    expect(copies().map((e) => e.sortOrder)).toEqual([4]); // after Other (3)
    await saveAndReload();
    expect(copies().map((e) => e.sortOrder)).toEqual([4]);
  });
});

describe('re-adding a component the template defines (#1677)', () => {
  // Mutation: drop the `reconcileOverrideMarks(id, meta)` call in addTraitToEntitiesWithUndo — the reload shows the
  // template's {x, 3} instead of the defaults on screen.
  it('Add Component after a Remove saves what the screen shows', async () => {
    removeTraitFromEntitiesWithUndo([member('A')], meta('Rotate3D'));
    addTraitToEntitiesWithUndo([member('A')], meta('Rotate3D'));
    const shown = { ...(readTraitData(member('A'), meta('Rotate3D')) as Record<string, unknown>) };
    expect(shown).toMatchObject({ axis: 'y', speed: 1 }); // precondition: schema defaults, not the template's
    await saveAndReload();
    expect(readTraitData(member('A'), meta('Rotate3D'))).toMatchObject(shown);
  });

  it('Paste Component As New after a Remove saves the pasted values', async () => {
    removeTraitFromEntitiesWithUndo([member('A')], meta('Rotate3D'));
    pasteTraitAsNewWithUndo([member('A')], meta('Rotate3D'), { axis: 'z', speed: 7 });
    await saveAndReload();
    expect(readTraitData(member('A'), meta('Rotate3D'))).toMatchObject({ axis: 'z', speed: 7 });
  });
});

describe('undo takes back the mark its write added (#1709)', () => {
  // Mutation: drop `putMarkState(id, meta.name, oldMarks)` from writeTraitFieldWithUndo's undo — the undone x stays
  // marked, is saved at 0, and the template's later 3 never reaches the instance.
  it('an undone Inspector edit is not saved as an override', async () => {
    writeTraitFieldWithUndo(member('B'), meta('Transform'), 'x', 5);
    await undo();
    const s = await saved();
    install(pDoc((d) => { (d.entities[2]!.traits.Transform as Record<string, unknown>).x = 3; }));
    await load(s);
    expect(field(member('B'), 'Transform', 'x')).toBe(3);
  });

  // The other side: a mark that was there BEFORE the edit (a loaded override) survives the undo.
  // Mutation: make putMarkState unmark every key it is given — the loaded override is dropped and reloads at 0.
  it('an override the scene already had survives an edit + undo', async () => {
    writeTraitFieldWithUndo(member('B'), meta('Transform'), 'x', 5);
    await load(await saved()); // B.x = 5 is now a loaded override
    clearHistory(); // or the next edit coalesces into the one before the reload
    writeTraitFieldWithUndo(member('B'), meta('Transform'), 'x', 9);
    await undo();
    await saveAndReload();
    expect(field(member('B'), 'Transform', 'x')).toBe(5);
  });

  /** Edit B.x through `edit`, undo it, save, move the template's B.x to 3, reload: B must follow the template. */
  const undoneFollowsTemplate = async (edit: () => void) => {
    edit();
    await undo();
    const s = await saved();
    install(pDoc((d) => { (d.entities[2]!.traits.Transform as Record<string, unknown>).x = 3; }));
    await load(s);
    return field(member('B'), 'Transform', 'x');
  };

  // Mutation: drop `putMarkState(id, meta.name, oldMarks[i]!)` from writeTraitFieldMultiWithUndo's undo.
  it('an undone multi-select edit is not saved as an override', async () => {
    expect(await undoneFollowsTemplate(() => writeTraitFieldMultiWithUndo([member('B'), member('C')], meta('Transform'), 'x', 5))).toBe(3);
  });

  // Mutation: drop `putMarkState(id, meta.name, oldMarks)` from writeTraitFieldPerEntityWithUndo's undo.
  it('an undone per-entity edit is not saved as an override', async () => {
    expect(await undoneFollowsTemplate(() => writeTraitFieldPerEntityWithUndo([member('B')], meta('Transform'), 'x', () => 5, 'nudge'))).toBe(3);
  });

  // Paste Values goes through writeTraitFieldsPerEntityWithUndo, whose undo used to write the old values through
  // the MARKING writer. Mutation: put `writeMany(id, oldValues)` back as its undo.
  it('an undone Paste Values is not saved as an override', async () => {
    expect(await undoneFollowsTemplate(() => pasteTraitValuesWithUndo([member('B')], meta('Transform'), { x: 5 }))).toBe(3);
  });

  /** A gizmo drag on B: the live write, then the one undo step SceneView builds at drag end. */
  const gizmoDrag = (x: number) => {
    const b = member('B');
    const before = { x: field(b, 'Transform', 'x') as number };
    const tf = meta('Transform');
    findEntity(b)!.set(tf.trait, { ...(findEntity(b)!.get(tf.trait) as object), x });
    const ref = entityRef(b);
    pushAction(buildTransformUndoAction({
      label: 'drag', trait: tf.trait, resolve: () => ref.resolve(), findEntity: findEntity as never,
      before, after: { x }, markFields: ['x'],
    }));
  };

  // Mutation: drop the `markOverrideIfInstance` loop in buildTransformUndoAction — the drag reloads at 0.
  it('a gizmo drag survives save + reload', async () => {
    gizmoDrag(5);
    await saveAndReload();
    expect(field(member('B'), 'Transform', 'x')).toBe(5);
  });

  // Mutation: drop `putMarkState` from buildTransformUndoAction's apply — the undone drag stays marked.
  it('an undone gizmo drag is not saved as an override', async () => {
    expect(await undoneFollowsTemplate(() => gizmoDrag(5))).toBe(3);
  });
});
