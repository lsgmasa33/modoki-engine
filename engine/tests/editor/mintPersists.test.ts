/** #1937 C-A, the hub's condition on the content-seeded mint (2026-10-01): the key a seat mints for a keyless template node
 *  is PERSISTED by the prefab's first editor save, so a later editor edit of that node never re-keys it and a scene's
 *  overrides on it keep applying. Only a hand or agent edit of the node BEFORE that save gives it a new key (the
 *  accepted risk, docs/prefabs.md): its scene rows are then kept as unused, never moved onto another node.
 *
 *  Driven through the prefab fuzzer's harness: the real backend route, SceneManager, both caches, prefab edit and the
 *  simulated watcher. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

// The OS trash, stubbed to delete from the scratch directory, as prefabFuzz.test.ts does.
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { getTraitByName, readTraitData } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored, flushWatcher } from './prefabFuzz/harness';
import { writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const tf = () => getTraitByName('Transform')!;
const xy = (id: number) => { const t = readTraitData(id, tf()) as { x: number; y: number }; return [t.x, t.y]; };
/** Loose under the fixture O instance's N (its scene guid `ffffffff-…-8001-…`), at P's A. */
const looseInScene = () => {
  const or = authored().find((e) => e.name === 'OR' && e.guid?.startsWith('ffffffff-0000-4000-8001-'))!;
  const n = authored().find((e) => e.name === 'R' && e.parentId === or.id)!;
  const a = authored().find((e) => e.name === 'A' && e.parentId === n.id)!;
  return authored().find((e) => e.name === 'Loose' && e.parentId === a.id)!;
};
type ODoc = { entities: Array<{ localId: number; added?: Array<{ name: string; key?: string }> }> };
const looseIn = (text: string) => (JSON.parse(text) as ODoc).entities.find((e) => e.localId === 2)!.added!.find((n) => n.name === 'Loose')!;

describe('a minted key is persisted by the prefab\'s first editor save (#1937 C-A)', () => {
  // Mutation: the editor's seats take the RAW document (`fetchPrefabSource` and `seatEditorEntry` skip the admitted copy)
  // — prefab edit spawns Loose keyless, its save writes no key, the next load mints one from the edited content, and the
  // scene's x = 7 lands nowhere: [0, 3].
  it('mint, then an editor save of the prefab that edits the node itself: the scene\'s override still applies', async () => {
    const f = await startRun(be, async () => {}, 'mint-persists');
    // O's row N gains a keyless, guid-less node — what a hand edit or an agent's write can make; no editor writes one.
    const doc = JSON.parse(be.read(f.prefabs.O.path)!) as ODoc & { entities: Array<{ added?: unknown[] }> };
    (doc.entities.find((e) => e.localId === 2)!.added as unknown[]).push({
      parentLocalId: 2, guid: '', name: 'Loose', traits: { EntityAttributes: { name: 'Loose', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } }, children: [],
    });
    const before = be.snapshot();
    be.write(f.prefabs.O.path, `${JSON.stringify(doc, null, 2)}\n`);
    await flushWatcher(be, before);
    await settle();
    expect(looseIn(be.read(f.prefabs.O.path)!).key, 'premise: the file states no key').toBeUndefined();
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(writeTraitFieldWithUndo(looseInScene().id, tf(), 'x', 7)).toBeFalsy();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);

    // The prefab's first editor save, editing the node itself: content that would re-key an unpersisted mint.
    expect(await openPrefabForEditing({ path: f.prefabs.O.path, name: 'O' }, { confirmDiscard: async () => true })).toBeFalsy();
    expect(writeTraitFieldWithUndo(authored().find((e) => e.name === 'Loose')!.id, tf(), 'y', 3)).toBeFalsy();
    expect((await savePrefabEditReport({})).saved).toBe(true);
    await exitPrefabEditing();
    await settle();
    expect(looseIn(be.read(f.prefabs.O.path)!).key, 'the save wrote the minted key').toMatch(/^[0-9a-f-]{36}$/);

    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(xy(looseInScene().id), 'the scene\'s x on the prefab\'s y').toEqual([7, 3]);
  });
});
