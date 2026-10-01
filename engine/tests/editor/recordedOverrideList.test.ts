/** The recorded override list (#1914): the owner's rulings F2–F7 (2026-10-01), pinned before the build.
 *
 *  An instance's overrides are an explicit list, changed only by explicit acts (an edit adds what it made differ;
 *  Revert and Apply remove), never re-derived from values, and a record whose target no longer resolves is kept as an
 *  UNUSED override: ignored at load, written back by every save (Unity: UnusedOverrides.html; staff on equal values,
 *  "We can't assume that an override should be removed just because it has the same value as in the Prefab Asset").
 *  docs/prefabs.md § I2, I18, I23.
 *
 *  Every case is behavioural: edit, save, change the template, reload, and look at what the user gets. Each is
 *  `it.fails` until the #1914 step named on it builds the rule, and flips to `it` there. F1 (depth ≥ 2) is in
 *  nestedRowFieldSave.test.ts, F8 (#1867's embedded document) in missingNestedFrameKeep.test.ts, F6 (the dialog's
 *  unused count) is pinned with its build (R5). */

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
import { setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, removeTraitFromEntitiesWithUndo } from '@modoki/engine/editor';
import { pasteTraitValuesWithUndo, writeTraitFieldMultiWithUndo, writeTraitFieldPerEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { undo, redo, _setUndoClock } from '../../packages/modoki/src/editor/undo/undoManager';
import { inFieldGesture } from '../../packages/modoki/src/editor/undo/fieldGesture';
import { getOverrideMarkSet } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { writeUIHandleValues, commitUIHandleDrag } from '../../packages/modoki/src/editor/scene/uiHandleCommit';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { onEditorDirty } from '../../packages/modoki/src/runtime/core/uiDirty';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000001914';
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
const scene = (extra: Record<string, unknown> = {}): SceneData => ({
  id: 's1709', version: 14, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Other', parentId: 0, guid: OTHER, sortOrder: 3 } } },
    { id: 2, prefab: P, guid: ROOT1, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } }, ...extra },
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
const saved = async () => serializeScene() as unknown as Promise<SceneData>;

beforeEach(async () => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  clearKeptMemberOrphans();
  install(pDoc());
  await load(scene());
});
afterAll(() => { setPrefabCache(P, null); getCurrentWorld()?.destroy(); });

const entryOf = (s: SceneData) => (s.entities as unknown as Array<Record<string, unknown>>).find((e) => e.guid === ROOT1)!;
/** Put a changed template in the cache, then reload `s` under it. */
const reloadUnder = async (s: SceneData, patch: (d: ReturnType<typeof baseDoc>) => void) => { install(pDoc(patch)); await load(s); };
const tfOf = (d: ReturnType<typeof baseDoc>, i: number) => d.entities[i]!.traits.Transform as Record<string, unknown>;

describe('F2: typing the prefab\'s own value into a field with no override records nothing (#1914 R2)', () => {
  // Mutation: make `recordOverridesByDiff` record every field it is given (drop the `off.has(f)` test) — x is recorded
  // at 0 and the reload keeps it over the template's 3.
  it('B.x typed as 0 (its base) follows a later template change', async () => {
    writeTraitFieldWithUndo(member('B'), meta('Transform'), 'x', 0);
    await reloadUnder(await saved(), (d) => { tfOf(d, 2).x = 3; });
    expect(field(member('B'), 'Transform', 'x')).toBe(3);
  });
});

// The hub's #1922 finding: an Inspector number field commits on every keystroke (#242), so retyping 100 over a base of
// 100 wrote 1 and 10 first, each different from the base, and F3 kept the record they left. Unity commits a typed field
// on Enter/blur, so the retype records nothing. One field SESSION is one recording gesture (`fieldGesture.ts`).
describe('F2 by keystrokes: an Inspector field session records what its FINAL value differs in (#1914, #1922)', () => {
  let now = 0;
  beforeEach(() => { now = 0; _setUndoClock(() => now); });
  afterAll(() => _setUndoClock(() => performance.now()));
  /** The Inspector's write (`write` → `writeTraitFieldMultiWithUndo`) for each keystroke, inside field session `token`,
   *  `gap` ms apart. */
  const type = (token: string | null, values: number[], gap = 1000) => {
    for (const v of values) {
      now += gap;
      const write = () => writeTraitFieldMultiWithUndo([member('U')], meta('UIElement'), 'width', v);
      if (token) inFieldGesture(token, write); else write();
    }
  };
  const widthAfterTemplate120 = async () => {
    await reloadUnder(await saved(), (d) => { (d.entities[5]!.traits as Record<string, Record<string, unknown>>).UIElement!.width = 120; });
    return field(member('U'), 'UIElement', 'width');
  };
  const recorded = () => !!getOverrideMarkSet(findEntity(member('U'))!)?.has('UIElement.width');

  // Mutation: drop `resumeGesture`'s put-back — 1 and 10 leave the record, and the reload keeps 100 over the 120.
  it('100 retyped over its base by a SLOW typist (keystrokes past the undo window) records nothing', async () => {
    type('f:1', [1, 10, 100]);
    expect(recorded()).toBe(false);
    expect(await widthAfterTemplate120()).toBe(120);
  });

  // F3 across sessions. Mutation: drop the session comparison in `resumeGesture` — the second session continues the
  // first, the record goes back to the first's start, and the reload shows 120.
  it('a SECOND session retyping the base keeps the record the first left (F3)', async () => {
    type('f:1', [1, 15, 150]);
    type('f:2', [1, 10, 100]);
    expect(await widthAfterTemplate120()).toBe(100);
  });

  // A missed blur (#242) joins two typings of one session; an edit between them still ends the gesture. Mutation: drop
  // the `gesture.top === peekUndo()` test — the handle drag between does not end it, and the record goes.
  it('another edit between two typings of ONE session ends the gesture (a missed blur), so F3 holds', async () => {
    type('f:1', [1, 15, 150]);
    const u = member('U');
    const before = { ...(readTraitData(u, meta('UIElement')) as Record<string, unknown>) };
    writeUIHandleValues(u, 'UIElement', { height: 70 });
    commitUIHandleDrag(u, 'UIElement', before, { ...(readTraitData(u, meta('UIElement')) as Record<string, unknown>) }, 'drag');
    type('f:1', [1, 10, 100]);
    expect(await widthAfterTemplate120()).toBe(100);
  });

  // work-qa's live run on R3 (finding A): each slow keystroke is its own undo entry, and the redo re-recorded each one by
  // diff, so undo×3 → redo×3 left 100 (the base) recorded. Mutation: the redo re-records
  // (`markFieldOverrideIfInstance` in place of `putMarkState(…, newMarks[i])` in `writeTraitFieldMultiWithUndo`) — red.
  it('undo×3 then redo×3 of a slow retype leaves the record the typing left: none (finding A)', async () => {
    type('f:1', [1, 10, 100]);
    for (let i = 0; i < 3; i++) await undo();
    expect([field(member('U'), 'UIElement', 'width'), recorded()]).toEqual([100, false]);
    for (let i = 0; i < 3; i++) await redo();
    expect([field(member('U'), 'UIElement', 'width'), recorded()]).toEqual([100, false]);
  });

  // The single-entity writer's twin. Mutation: its redo re-records (`markFieldOverrideIfInstance` in place of
  // `putMarkState(id, meta.name, newMarks)` in `writeTraitFieldWithUndo`) — red.
  it('the same through the single-entity writer', async () => {
    for (const v of [1, 10, 100]) {
      now += 1000;
      inFieldGesture('f:1', () => writeTraitFieldWithUndo(member('U'), meta('UIElement'), 'width', v));
    }
    for (let i = 0; i < 3; i++) await undo();
    for (let i = 0; i < 3; i++) await redo();
    expect([field(member('U'), 'UIElement', 'width'), recorded()]).toEqual([100, false]);
  });

  it('the gesture\'s undo gives back the record it began with, and its redo the one it ended with', async () => {
    type('f:1', [1, 15, 150], 100); // inside the undo window: one entry
    await undo();
    expect([field(member('U'), 'UIElement', 'width'), recorded()]).toEqual([100, false]);
    await redo();
    expect([field(member('U'), 'UIElement', 'width'), recorded()]).toEqual([150, true]);
  });

  // The redo half above cannot tell a restored record from a re-derived one (150 is off the base either way; #1932 R4-L2).
  // They differ only once the base moves to the typed value between the undo and the redo: the redo must put back the
  // record the gesture ended with, as Unity's redo restores the recorded state. Mutation: the redo re-records
  // (`markFieldOverrideIfInstance` in place of `putMarkState(…, newMarks[i]!)` in `writeTraitFieldMultiWithUndo`) — red.
  it('the gesture\'s redo puts back its record even after the base moved to the typed value', async () => {
    type('f:1', [1, 15, 150], 100); // inside the undo window: one entry
    await undo();
    await reloadUnder(await saved(), (d) => { (d.entities[5]!.traits as Record<string, Record<string, unknown>>).UIElement!.width = 150; });
    await redo();
    expect([field(member('U'), 'UIElement', 'width'), recorded()]).toEqual([150, true]);
    expect(await widthAfterTemplate120()).toBe(150);
  });

  // Outside a field session (an agent's writes, a scrub's frames) each write is its own gesture, F3 for each, even inside
  // the undo window that merges them into one Cmd-Z. Mutation: let a write with no session continue the gesture
  // (`session === null` out of `resumeGesture`'s early return) — the second write drops the first's record.
  it('outside a field session, every write is its own gesture, inside the undo window too (F3)', async () => {
    type(null, [150, 100], 10);
    expect(recorded()).toBe(true);
    expect(await widthAfterTemplate120()).toBe(100);
  });

  // The per-entity writer (#1932, R4-L1 finding 2): a composite sub-field's `BufferedNumberInput` (a binding's value, a
  // material override's constant, an anim bank's numbers) commits on every keystroke through it, and it took no gesture.
  const typePerEntity = (values: number[]) => {
    for (const v of values) {
      now += 1000;
      inFieldGesture('f:1', () => writeTraitFieldPerEntityWithUndo([member('U')], meta('UIElement'), 'width', () => v, 'Edit width'));
    }
  };
  // Mutation: drop `resumeGesture` from `writeTraitFieldPerEntityWithUndo` — 1 and 10 leave the record, and the reload
  // keeps 100 over the template's 120.
  it('the per-entity writer: 100 retyped over its base records nothing', async () => {
    typePerEntity([1, 10, 100]);
    expect(recorded()).toBe(false);
    expect(await widthAfterTemplate120()).toBe(120);
  });

  // Mutation: its redo re-records (`markFieldOverrideIfInstance` in place of `putMarkState(…, newMarks[i]!)`) — red.
  it('the per-entity writer: undo×3 then redo×3 of the retype leaves no record', async () => {
    typePerEntity([1, 10, 100]);
    for (let i = 0; i < 3; i++) await undo();
    expect([field(member('U'), 'UIElement', 'width'), recorded()]).toEqual([100, false]);
    for (let i = 0; i < 3; i++) await redo();
    expect([field(member('U'), 'UIElement', 'width'), recorded()]).toEqual([100, false]);
  });
});

// work-qa's live run on R3 (finding B): a handle drag records on pointer-up, after its last live frame's dirty signal was
// consumed, so the Inspector's accent (read on that signal) stayed off until the selection changed.
describe('a handle drag\'s record signals the editor (#1914, finding B)', () => {
  // Mutation: drop `markUIDirty()` from `recordOverridesByDiff` — no signal follows the record.
  it('commitUIHandleDrag notifies the editor-dirty subscribers after it records', () => {
    const u = member('U');
    const before = { ...(readTraitData(u, meta('UIElement')) as Record<string, unknown>) };
    writeUIHandleValues(u, 'UIElement', { width: 140 });
    let seen = false;
    const off = onEditorDirty(() => { seen = !!getOverrideMarkSet(findEntity(u)!)?.has('UIElement.width'); });
    try {
      commitUIHandleDrag(u, 'UIElement', before, { ...(readTraitData(u, meta('UIElement')) as Record<string, unknown>) }, 'drag');
    } finally { off(); }
    expect(seen).toBe(true);
  });
});

describe('F3: a write that lands back on the base KEEPS an earlier override (#1914 R2)', () => {
  // Mutation: give `recordOverridesByDiff` back its unmark branch (unmark a field equal to its base) — the drag back
  // takes the record off and the reload shows the template's 120.
  it('width typed 150, then dragged back to 100 (its base): 100 stays the instance\'s own', async () => {
    writeTraitFieldWithUndo(member('U'), meta('UIElement'), 'width', 150);
    const u = member('U');
    const before = { ...(readTraitData(u, meta('UIElement')) as Record<string, unknown>) };
    writeUIHandleValues(u, 'UIElement', { width: 100 });
    commitUIHandleDrag(u, 'UIElement', before, { ...(readTraitData(u, meta('UIElement')) as Record<string, unknown>) }, 'drag');
    await reloadUnder(await saved(), (d) => { (d.entities[5]!.traits as Record<string, Record<string, unknown>>).UIElement!.width = 120; });
    expect(field(member('U'), 'UIElement', 'width')).toBe(100);
  });
});

// Built in R2, not R5 as the study planned: the paste writes through `markOverrideIfInstance`, which IS the recorder.
describe('F4: Paste Component Values records only what it changed (#1914 R2)', () => {
  // Mutation: as F2's — every pasted field is recorded, x at 0, and the reload ignores the template's 3.
  it('pasting B\'s own base values leaves it following the template', async () => {
    pasteTraitValuesWithUndo([member('B')], meta('Transform'), { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    await reloadUnder(await saved(), (d) => { tfOf(d, 2).x = 3; });
    expect(field(member('B'), 'Transform', 'x')).toBe(3);
  });
});

describe('F5: a record whose target is gone is kept as an unused override (#1914 R4)', () => {
  it('a legacy localId override for a row the template no longer has is written back', async () => {
    await load(scene({ overrides: { 9: { Transform: { x: 9 } } } }));
    expect(JSON.stringify(entryOf(await saved()))).toContain('"9"');
  });

  it('an override of a field the schema no longer declares is written back', async () => {
    await load(scene({ overrides: { 3: { Transform: { retiredField: 7 } } } }));
    expect(JSON.stringify(entryOf(await saved()))).toContain('"retiredField":7');
  });

  it('an override of a trait that is not registered is written back', async () => {
    await load(scene({ overrides: { 3: { RetiredTrait: { speed: 7 } } } }));
    expect(JSON.stringify(entryOf(await saved()))).toContain('"RetiredTrait"');
  });

  it('a removed component the template stopped defining is kept, and holds once the template defines it again', async () => {
    removeTraitFromEntitiesWithUndo([member('A')], meta('Rotate3D'));
    await reloadUnder(await saved(), (d) => { delete (d.entities[1]!.traits as Record<string, unknown>).Rotate3D; });
    const s2 = await saved();
    expect(JSON.stringify(entryOf(s2))).toContain('Rotate3D');
    await reloadUnder(s2, () => {});
    expect(findEntity(member('A'))!.has(meta('Rotate3D').trait)).toBe(false);
  });
});

describe('F7: every instance records its root sortOrder, Unity\'s rootOrder (#1914 R6)', () => {
  // Mutation: `getOverrideMarkSet` never adds the implicit record (`recordsRootOrder` unconsulted) — the reload takes the
  // template root's new order, 2. Its exclusions (the prefab-edit world, a template's copy by key or by its lost marker, a
  // root with no durable guid) are pinned elsewhere; the key and the lost-marker tests are twins, red only together.
  it('an untouched instance keeps its place when the template root\'s sortOrder changes', async () => {
    await reloadUnder(scene(), (d) => { (d.entities[0]!.traits.EntityAttributes as Record<string, unknown>).sortOrder = 7; });
    expect(field(rootId(), 'EntityAttributes', 'sortOrder')).toBe(7); // precondition: the root shows the template's order
    await reloadUnder(await saved(), (d) => { (d.entities[0]!.traits.EntityAttributes as Record<string, unknown>).sortOrder = 2; });
    expect(field(rootId(), 'EntityAttributes', 'sortOrder')).toBe(7);
  });
});
