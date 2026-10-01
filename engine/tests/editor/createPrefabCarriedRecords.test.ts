/** #1932 (E7 round 4, area 4a, R4-L1 finding 1): Create Prefab moves the records of the tree's NESTED frames into the new
 *  document, so the connected instance no longer states them (`clearCarriedRecords` in prefabLink.ts).
 *
 *  The capture writes a nested member's records into the new document's rows. The tag cleared only the entities it
 *  relinked, so a nested member kept its records, the scene restated them on every save, and a later edit of the new
 *  prefab's nested copy never reached the instance, live or after a reload. A #1914 regression: R3 removed the save's
 *  depth ≥ 2 subtraction, which had dropped these records as equal to the row, and nothing replaced it for Create. Unity:
 *  the instance `SaveAsPrefabAssetAndConnect` connects starts with an EMPTY modification list (the outermost instance
 *  owns it).
 *
 *  The fixture (the fuzzer's): Plain gets a placed P (R → A → B, and C, a nested Q whose member is M), so in the new
 *  prefab P is a nested frame (A, depth 1) holding a nested-in-nested Q (M, depth 2). Driven through the real routes:
 *  the placement, the Inspector's writes, Delete, Add Component, Create Prefab, prefab edit, save and reload. */

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
import { boot, bridge, memoryStorage, startRun, settle, authored, type Fixture } from './prefabFuzz/harness';
import { pushAction } from '@modoki/engine/editor';
import { getTraitByName, readTraitData } from '@modoki/engine/runtime';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { writeTraitFieldWithUndo, deleteEntitiesWithUndo, addTraitToEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { getOverrideMarkSet } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
import { recordsOffBase } from '../../packages/modoki/src/editor/undo/overrideMarkWrites';
import { findEntityById as findEntity } from '../../packages/modoki/src/runtime/core/ecs/world';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const tf = () => getTraitByName('Transform')!;
const ea = () => getTraitByName('EntityAttributes')!;
/** The records the save reads (F7's implied root order included: a role's, on both sides of every comparison here). */
const records = (id: number) => [...(getOverrideMarkSet(findEntity(id) as never) ?? [])].sort();
const x = (id: number) => (readTraitData(id, tf()) as { x: number }).x;
const plainId = () => authored().find((e) => e.name === 'Plain')!.id;
/** The entity named `name` in Plain's tree (the fixture's own O1/P1 instances hold members of the same names). */
function under(name: string): number {
  const inTree = (id: number): boolean => { for (let at = id; at; at = authored().find((e) => e.id === at)?.parentId ?? 0) if (at === plainId()) return true; return false; };
  const hits = authored().filter((e) => e.name === name && inTree(e.id));
  expect(hits.map((e) => e.name)).toEqual([name]);
  return hits[0].id;
}
function treeIds(): number[] {
  const ids = new Set([plainId()]);
  for (let grew = true; grew;) { grew = false; for (const e of authored()) if (!ids.has(e.id) && ids.has(e.parentId)) { ids.add(e.id); grew = true; } }
  return [...ids];
}
/** Every entity of Plain's tree by guid → its record set. */
function treeRecords(): Record<string, string[]> {
  return Object.fromEntries(treeIds().map((id) => [authored().find((e) => e.id === id)!.guid!, records(id)]));
}
/** Every entity of Plain's tree by name → the values a dropped record would change (identity left out: guids, ids). */
function treeValues(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of treeIds()) {
    const read = (t: string) => { const d = readTraitData(id, getTraitByName(t)!); return d ? JSON.parse(JSON.stringify(d)) as Record<string, unknown> : null; };
    const attrs = read('EntityAttributes');
    if (attrs) { delete attrs.guid; delete attrs.parentId; }
    out[authored().find((a) => a.id === id)!.name] = { Transform: read('Transform'), Rotate3D: read('Rotate3D'), EntityAttributes: attrs };
  }
  return out;
}

/** Plain → P (placed), then the scene's records on the nested frames: A.x 11 (depth 1), M.x 7 and its editorFolder
 *  (depth 2), an added Rotate3D on A (a structural record), and member B deleted (a removed child). */
async function setup(key: string): Promise<{ f: Fixture; newPath: string }> {
  const f = await startRun(be, async (fx) => {
    await placePrefabFromPath(fx.prefabs.P.path, { tag: 'test', parentId: authored().find((e) => e.name === 'Plain')!.id });
    await settle();
  }, key);
  expect(writeTraitFieldWithUndo(under('A'), tf(), 'x', 11)).toBeNull();
  expect(writeTraitFieldWithUndo(under('M'), tf(), 'x', 7)).toBeNull();
  expect(addTraitToEntitiesWithUndo([under('A')], getTraitByName('Rotate3D')!)).toBeNull();
  deleteEntitiesWithUndo([under('B')]);
  expect(writeTraitFieldWithUndo(under('M'), ea(), 'editorFolder', 'Kept')).toBeNull();
  await settle();
  expect(records(under('A'))).toEqual(expect.arrayContaining(['Transform.x', 'Rotate3D.axis', 'Rotate3D.speed'])); // premise
  expect(records(under('M'))).toEqual(expect.arrayContaining(['Transform.x', 'EntityAttributes.editorFolder']));
  return { f, newPath: `${f.root}/prefabs/NewPlain.prefab.json` };
}

async function create(newPath: string): Promise<void> {
  const r = await createPrefabFromEntity(plainId(), newPath, 'Save prefab "Plain"', async () => false);
  if (!r || r === 'declined' || 'refused' in r) throw new Error(`create: ${r && r !== 'declined' ? r.refused : r}`);
  pushAction(r.action);
  await settle();
}

describe('Create Prefab moves the nested frames\' records into the new prefab (#1932 R4-L1 finding 1)', () => {
  // Mutation: `clearCarriedRecords` returns a no-op without clearing (today's `clearLinkedMarks`) — the records stay, the
  // scene restates x 7, and the instance shows 7 after the new prefab's edit to 9.
  it('every record the new document carries is cleared, and nothing it shows is lost; the new prefab\'s edits then reach the instance, live and after a reload', async () => {
    const { f, newPath } = await setup('carried-e2e');
    const shown = treeValues();
    await create(newPath);
    const doc = be.read(newPath) ?? '';
    // The new document's rows carry each value…
    expect(doc).toMatch(/"x":\s*11\b/);
    expect(doc).toMatch(/"x":\s*7\b/);
    expect(doc).toContain('"Rotate3D"');
    expect(doc).toContain('"Kept"');
    // …so the instance records none of them (each nested entity's set is empty: none is a scene root).
    for (const n of ['A', 'M']) expect(records(under(n)), n).toEqual([]);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const scene = be.read(f.scenePath) ?? '';
    expect(scene).not.toMatch(/"x":\s*(7|11)\b/);
    expect(scene).not.toContain('"Rotate3D"');
    expect(scene).not.toContain('"Kept"');
    // Caught, not dropped: a record cleared without its value reaching a row would reload at the template's value.
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(treeValues()).toEqual(shown);
    // The new prefab's edits of its nested copies.
    expect(await openPrefabForEditing({ path: newPath, name: 'NewPlain' }, { confirmDiscard: async () => true })).toBeFalsy();
    const inEdit = (name: string, v: number) => authored().find((e) => e.name === name && x(e.id) === v)!.id;
    expect(writeTraitFieldWithUndo(inEdit('M', 7), tf(), 'x', 9)).toBeNull();
    expect(writeTraitFieldWithUndo(inEdit('A', 11), tf(), 'x', 12)).toBeNull();
    expect((await savePrefabEditReport({})).saved).toBe(true);
    await exitPrefabEditing();
    await settle();
    expect([x(under('M')), x(under('A'))]).toEqual([9, 12]);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect([x(under('M')), x(under('A'))]).toEqual([9, 12]);
  });

  // Mutation: drop `undoCarried()` from the tag's undo — the undo leaves A and M without their records.
  it('undo of Create puts back every record set exactly, and redo clears them again', async () => {
    const { newPath } = await setup('carried-undo');
    const before = treeRecords();
    await create(newPath);
    const after = treeRecords();
    expect(after).not.toEqual(before); // premise: the create moved records
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(treeRecords()).toEqual(before);
    expect((await undoStep('redo')).did).toBe(true);
    await settle();
    expect(treeRecords()).toEqual(after);
  });

  // The predicate the sweep keeps a record by. ⚠️ No route found leaves a captured record's value out of the new document
  // (editorFolder, an added component and a removed child all reach a row), so the sweep's KEEP branch is defensive and the
  // end-to-end case above stays green with it removed; this pins what it decides on. Mutation: `recordsOffBase` reports
  // every record (or none) — red.
  it('recordsOffBase: a record off its base is reported, one put back on its base (kept by F3) is not', async () => {
    await startRun(be, async (fx) => {
      await placePrefabFromPath(fx.prefabs.P.path, { tag: 'test', parentId: authored().find((e) => e.name === 'Plain')!.id });
      await settle();
    }, 'carried-predicate');
    const m = under('M');
    const base = x(m); // P's row for C states M.x = 4
    expect(writeTraitFieldWithUndo(m, tf(), 'x', 7)).toBeNull();
    expect([...(recordsOffBase(m) ?? [])]).toEqual(['Transform.x']);
    expect(writeTraitFieldWithUndo(m, tf(), 'x', base)).toBeNull();
    expect(records(m)).toEqual(['Transform.x']); // F3: the record stays…
    expect([...(recordsOffBase(m) ?? [])]).toEqual([]); // …and the base now gives its value
  });

  // The tag branch's KEEP side (close-out re-review): a tag record whose base lacks the tag is the instance's own. A load
  // seeds the record. Mutation: the tag branch reports no tag record (drop every one) — red.
  it('recordsOffBase: a tag the base lacks is reported, so Create keeps it', async () => {
    const f = await startRun(be, async (fx) => {
      await placePrefabFromPath(fx.prefabs.P.path, { tag: 'test', parentId: authored().find((e) => e.name === 'Plain')!.id });
      await settle();
    }, 'carried-tag-keep');
    expect(addTraitToEntitiesWithUndo([under('M')], getTraitByName('Persistent')!)).toBeNull();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(records(under('M'))).toContain('Persistent.'); // premise: the load recorded it
    expect([...(recordsOffBase(under('M')) ?? [])]).toContain('Persistent.');
  });


  // A tag is a record too (the reviewer's close-out finding 1): the sweep kept every tag record, so the scene restated a
  // tag the new document carries and the new prefab's edit removing it never reached the instance. Mutation: the tag
  // branch of `recordsOffBase` reports every tag record (the pre-fix keep) — M keeps `Persistent.` and the tag stays.
  it('a tag the new document carries leaves the instance too; the new prefab removing it reaches the instance, live and after a reload', async () => {
    const { f, newPath } = await setup('carried-tag');
    const tag = getTraitByName('Persistent')!;
    expect(addTraitToEntitiesWithUndo([under('M')], tag)).toBeNull();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded'); // a load seeds the tag's record
    await settle();
    expect(records(under('M'))).toContain('Persistent.'); // premise
    await create(newPath);
    expect(be.read(newPath) ?? '').toContain('"Persistent"');
    expect(records(under('M'))).toEqual([]);
    expect(await openPrefabForEditing({ path: newPath, name: 'NewPlain' }, { confirmDiscard: async () => true })).toBeFalsy();
    const inEdit = authored().filter((e) => e.name === 'M').map((e) => e.id).find((id) => findEntity(id)?.has(tag.trait))!;
    findEntity(inEdit)!.remove(tag.trait);
    expect((await savePrefabEditReport({})).saved).toBe(true);
    expect(be.read(newPath) ?? '').not.toContain('"Persistent"');
    await exitPrefabEditing();
    await settle();
    expect(findEntity(under('M'))!.has(tag.trait)).toBe(false);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(findEntity(under('M'))!.has(tag.trait)).toBe(false);
  });
});
