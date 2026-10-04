/** #2000 (I23): an UNTOUCHED instance of a prefab that adds a node AT a nested row states nothing about that node when
 *  saved. O's row N (a P) adds "Dup" under N's root; the scene's instance of O is never touched.
 *
 *  Filed from #1948 F10: the old capture diffed the live tree against the template and wrote `"/N/a+k-dup": {removed:
 *  true}` plus an `own` copy of the node, which nobody authored. Since #2001 S6/S8b the save writes the instance's record,
 *  and an untouched instance's record holds no row for the node, so this holds by construction (the hub's S6 acceptance
 *  case). Re-measured on main at 90f91476a: green in both forms the file can state the node in — the legacy row's
 *  `added` (the reviewer's shape), and the v10 `members` row prefab edit writes.
 *
 *  The accept side: a REAL delete of the node in the instance saves the removal, so "states nothing" is an observation
 *  that can fail, not one the save cannot make. Mutation (measured): putting the save back on the pre-S6 route (capture
 *  the live tree, parse it, write that) stays GREEN — today's capture no longer produces the defect either, so this pins
 *  the outcome, whatever writes it; the accept side is what shows the observation can go red. Driven through the prefab fuzzer's harness: the real backend route,
 *  SceneManager, both caches, prefab edit and the simulated watcher. */

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
import { boot, bridge, memoryStorage, startRun, settle, authored, flushWatcher, type Fixture } from './prefabFuzz/harness';
import { createEntityWithUndo, deleteEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

type Entry = { prefab?: string; members?: Record<string, { removed?: boolean; own?: unknown[] }> };
/** O1's entry as the scene file states it. */
const savedO1 = (f: Fixture): Entry => (JSON.parse(be.read(f.scenePath)!) as { entities: Entry[] }).entities.find((e) => e.prefab === f.prefabs.O.guid)!;
async function save(): Promise<void> { expect((await saveScene({ allowDialog: false })).saved).toBe(true); }
async function reload(f: Fixture): Promise<void> { expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded'); await settle(); }
/** The "Dup" nodes under the scene's O1. */
const dupsInO1 = () => {
  const or = authored().find((e) => e.name === 'OR' && e.guid?.startsWith('ffffffff-0000-4000-8001-'))!;
  const parent = new Map(authored().map((e) => [e.id, e.parentId]));
  const under = (id: number) => { for (let a = parent.get(id); a; a = parent.get(a)) if (a === or.id) return true; return false; };
  return authored().filter((e) => e.name === 'Dup' && under(e.id));
};

/** O's row N adds "Dup" under N's root in the legacy row form (`added`), written on disk through the watcher. */
async function addInLegacyForm(f: Fixture): Promise<void> {
  const doc = JSON.parse(be.read(f.prefabs.O.path)!) as { entities: Array<{ localId: number; added?: unknown[] }> };
  (doc.entities.find((e) => e.localId === 2)!.added ??= []).push({ parentLocalId: 1, guid: '', key: 'k-dup', name: 'Dup', traits: { EntityAttributes: { name: 'Dup', parentId: 0 }, Transform: { x: 1, y: 0, z: 0 } }, children: [] });
  const before = be.snapshot();
  be.write(f.prefabs.O.path, `${JSON.stringify(doc, null, 2)}\n`);
  await flushWatcher(be, before);
  await settle();
}

/** O's row N adds "Dup" under N's root through prefab edit: what the editor writes (the v10 `members` row). */
async function addInPrefabEdit(f: Fixture): Promise<void> {
  expect(await openPrefabForEditing({ path: f.prefabs.O.path, name: 'O' }, { confirmDiscard: async () => true })).toBeFalsy();
  const root = authored().find((e) => e.parentId === 0 && e.name === 'OR')!;
  const n = authored().find((e) => e.name === 'R' && e.parentId === root.id)!;
  expect(createEntityWithUndo('Add Dup', n.id, [{ name: 'EntityAttributes', data: { name: 'Dup', parentId: n.id } }, { name: 'Transform', data: { x: 1 } }], () => {})).not.toBeNull();
  await settle();
  expect((await savePrefabEditReport({})).saved).toBe(true);
  await exitPrefabEditing();
  await settle();
  const row = (JSON.parse(be.read(f.prefabs.O.path)!) as { entities: Array<{ localId: number; added?: unknown; members?: unknown }> }).entities.find((e) => e.localId === 2)!;
  expect(row.added, 'premise: the v10 row form, no legacy channel').toBeUndefined();
  expect(JSON.stringify(row.members), 'premise: N\'s row states Dup').toContain('"Dup"');
}

describe('an untouched instance of a prefab that adds a node at a nested row states nothing about it (#2000, I23)', () => {
  for (const [form, add] of [['the legacy row form (`added`)', addInLegacyForm], ['prefab edit (the v10 `members` row)', addInPrefabEdit]] as const) {
    it(`${form}: the saved entry is the untouched one, through a reload and a second save`, async () => {
      const f = await startRun(be, async () => {}, `untouched-nested-add-${form.length}`);
      await save();
      const untouched = savedO1(f);
      await add(f);
      await reload(f);
      expect(dupsInO1(), 'premise: the instance shows the template\'s node').toHaveLength(1);
      await save();
      expect(savedO1(f), 'no removal, no own copy: the entry the untouched instance saved before').toEqual(untouched);
      await reload(f);
      await save();
      expect(savedO1(f), 'and again').toEqual(untouched);
    });
  }

  it('the accept side: deleting the node in the instance DOES save its removal', async () => {
    const f = await startRun(be, async () => {}, 'untouched-nested-add-accept');
    await addInPrefabEdit(f);
    await reload(f);
    deleteEntitiesWithUndo(dupsInO1().map((e) => e.id));
    await settle();
    await save();
    const removed = Object.entries(savedO1(f).members ?? {}).filter(([, r]) => r.removed === true).map(([k]) => k);
    expect(removed, 'one removal, of the node at N').toHaveLength(1);
    expect(removed[0]).toMatch(/\/a\+[^/]+$/);
  });
});
