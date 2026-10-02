/** A user node shown at a missing nested row's placeholder (#2001 S5, ruling D, #2018) is written ONCE by the save
 *  (#2028 review F1). The load's kept rows restate it at its own anchor, and the capture saw it live under the
 *  placeholder: both were written, and once the prefab returned both expanded — the node twice, one guid. Now a kept
 *  node that is live is written only where it lives, with its live content (an edit made while the prefab was missing is
 *  kept, and a node moved away is not written back at the row). Driven through the real editor over the fuzzer's in-process
 *  backend (#1707's fixture: P is R → A → B plus row QR expanding Q (QR → M)), as `copyReaderPerLoad.test.ts` is.
 *
 *  Mutation (`editor/scene/prefabMembers.ts` `withoutLiveNodes`): keep every kept node — the first three cases red (two nodes). */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { getAllEntities, getTraitByName } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, flushWatcher, type Fixture } from './prefabFuzz/harness';
import { deleteAssetFiles, deletionPathsFor } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { emptySpecs } from '../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { writeTraitFieldWithUndo, reparentEntity, deleteEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { rowPlaceholderOf } from '../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { prefabEditRefusal, PrefabEditRefusalError } from '../../packages/modoki/src/editor/scene/prefabEditRefusal';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);
const noNest = async () => {};

function p1(f: Fixture): number {
  const e = getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === x.id; });
  return e!.id;
}
function under(root: number): Set<number> {
  const all = getAllEntities();
  const s = new Set<number>([root]);
  for (let grew = true; grew;) { grew = false; for (const e of all) if (!s.has(e.id) && s.has(e.parentId)) { s.add(e.id); grew = true; } }
  return s;
}
async function trash(f: Fixture, which: 'Q' | 'P' | 'H'): Promise<string> {
  const path = f.prefabs[which].path;
  const saved = be.read(path)!;
  const before = be.snapshot();
  const del = await deleteAssetFiles(deletionPathsFor(path, 'prefab', null));
  if (!del.ok) throw new Error('trash failed');
  unbindDeletedAssetEditors([path]);
  await flushWatcher(be, before);
  await settle();
  return saved;
}
function create(name: string, parent: number) {
  const { specs } = emptySpecs(parent);
  createEntityWithUndo('Create ' + name, parent, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name } } : s)), () => {});
}
const count = (n: string) => getAllEntities().filter((e) => e.name === n).length;
const parentNames = (n: string) => getAllEntities().filter((e) => e.name === n).map((e) => getAllEntities().find((x) => x.id === e.parentId)?.name ?? '-');

async function restore(f: Fixture, text: string) {
  const before = be.snapshot();
  be.write(f.prefabs.Q.path, text);
  await flushWatcher(be, before);
  await settle();
}
async function reload(f: Fixture) { expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded'); await settle(); }
async function save() { expect((await saveScene({ allowDialog: false })).saved).toBe(true); }
/** U created under `at` in P1, saved; Q trashed; the scene reloaded with Q missing. Returns Q's saved text. */
async function userNodeThenMissing(f: Fixture, at: 'QR' | 'M'): Promise<string> {
  const host = getAllEntities().find((x) => under(p1(f)).has(x.id) && x.name === at)!.id;
  create('U', host);
  await settle(); await save();
  const q = await trash(f, 'Q');
  await reload(f);
  return q;
}

describe('a user node at a missing nested row\'s placeholder is written once (#2028 review F1)', () => {
  it('shown at the placeholder, saved while missing: one node when the prefab returns, in place and after a reload', async () => {
    const f = await startRun(be, noNest, 'held-once');
    const q = await userNodeThenMissing(f, 'QR');
    expect(count('U')).toBe(1);
    await save();
    await restore(f, q);
    expect(count('U')).toBe(1);
    await save(); await reload(f);
    expect(count('U')).toBe(1);
    expect(parentNames('U')).toEqual(['QR']);
  });

  it('an edit made to it while the prefab is missing is kept', async () => {
    const f = await startRun(be, noNest, 'held-edit');
    const q = await userNodeThenMissing(f, 'QR');
    const u = getAllEntities().find((e) => e.name === 'U')!.id;
    writeTraitFieldWithUndo(u, getTraitByName('EntityAttributes')!, 'name', 'U2');
    await settle(); await save();
    await restore(f, q); await save(); await reload(f);
    expect([count('U'), count('U2')]).toEqual([0, 1]);
    expect(parentNames('U2')).toEqual(['QR']);
  });

  it('moved out of the instance while the prefab is missing: stated only where it lives', async () => {
    const f = await startRun(be, noNest, 'held-moved');
    const q = await userNodeThenMissing(f, 'QR');
    reparentEntity(getAllEntities().find((e) => e.name === 'U')!.id, 0);
    await settle(); await save();
    await restore(f, q); await save(); await reload(f);
    expect(count('U')).toBe(1);
    expect(parentNames('U')).toEqual(['-']);
  });

  it('hung under a member INSIDE the missing frame: back under that member, once', async () => {
    const f = await startRun(be, noNest, 'held-inner');
    const q = await userNodeThenMissing(f, 'M');
    await save();
    await restore(f, q); await save(); await reload(f);
    expect(count('U')).toBe(1);
    expect(parentNames('U')).toEqual(['M']);
  });
});

// A missing nested row's placeholder takes no edit while its prefab is missing (#2028 review F2; rule 9: an edit the list
// cannot hold is refused, I21). Its writer saves nothing from it, so a rename, a delete or a move showed live and came
// back on reload. A delete is refused as a prefab-edit refusal (`prefabEditRefusal` 'missing-prefab-row'), asked up front
// by every delete route: the panels toast it, the agent ops refuse before minting or naming (close-out re-review).
// Mutations: drop the row check in `placeholderWriteRefusal` (rename red); make `missingRowDelete` answer false (both
// delete-refused cases red); drop its roots-only skip (the ancestor case red); drop its kept-rows test, refusing any
// node under the placeholder (the added-node case red); drop the row branch of `supplierOf` (move red).
describe('a missing nested row\'s placeholder refuses edits its save cannot keep (#2028 review F2)', () => {
  const rowPlaceholder = (f: Fixture) => getAllEntities().find((x) => under(p1(f)).has(x.id) && rowPlaceholderOf(findEntity(x.id) as never))!;
  async function missing(tag: string): Promise<{ f: Fixture; q: string }> {
    const f = await startRun(be, noNest, tag);
    await save();
    const q = await trash(f, 'Q');
    await reload(f);
    return { f, q };
  }
  async function afterRoundTrip(f: Fixture, q: string) {
    await save(); await reload(f);
    expect(rowPlaceholder(f).name).toBe('QR');
    await save(); await restore(f, q); await reload(f);
    expect(getAllEntities().filter((x) => under(p1(f)).has(x.id) && x.name === 'QR')).toHaveLength(1);
  }

  it('a rename is refused', async () => {
    const { f, q } = await missing('row-rename');
    const ph = rowPlaceholder(f);
    writeTraitFieldWithUndo(ph.id, getTraitByName('EntityAttributes')!, 'name', 'Renamed');
    await settle();
    expect(rowPlaceholder(f).name).toBe('QR');
    await afterRoundTrip(f, q);
  });

  it('a delete is refused', async () => {
    const { f, q } = await missing('row-delete');
    const ph = rowPlaceholder(f);
    expect(() => deleteEntitiesWithUndo([ph.id])).toThrow(PrefabEditRefusalError);
    expect(prefabEditRefusal({ kind: 'delete', ids: [ph.id] })?.reason).toBe('missing-prefab-row');
    expect(rowPlaceholder(f).id).toBe(ph.id);
    await afterRoundTrip(f, q);
  });

  it('a move out of its member is refused', async () => {
    const { f, q } = await missing('row-move');
    const ph = rowPlaceholder(f);
    expect(reparentEntity(ph.id, 0)).toBe(false);
    expect(rowPlaceholder(f).parentId).toBe(ph.parentId);
    await afterRoundTrip(f, q);
  });

  it('deleting the instance with its placeholder in the selection deletes both', async () => {
    const { f } = await missing('row-ancestor');
    const root = p1(f), ph = rowPlaceholder(f);
    const gone = new Set([root, ph.id].map((id) => getAllEntities().find((e) => e.id === id)!.guid));
    deleteEntitiesWithUndo([root, ph.id]);
    await settle();
    expect(getAllEntities().filter((e) => gone.has(e.guid))).toEqual([]);
    await save(); await reload(f);
    expect(getAllEntities().filter((e) => gone.has(e.guid))).toEqual([]);
  });

  it('a user node the kept row states, shown at the placeholder, refuses a delete (it came back on reload)', async () => {
    const f = await startRun(be, noNest, 'row-kept-delete');
    const q = await userNodeThenMissing(f, 'QR');
    const u = getAllEntities().find((e) => e.name === 'U')!.id;
    expect(() => deleteEntitiesWithUndo([u])).toThrow(PrefabEditRefusalError);
    expect(count('U')).toBe(1);
    await save(); await restore(f, q); await save(); await reload(f);
    expect(count('U')).toBe(1);
  });

  it('a node added under the placeholder this session still deletes, and stays deleted', async () => {
    const { f, q } = await missing('row-added-delete');
    create('V', rowPlaceholder(f).id);
    await settle(); await save(); await reload(f);
    expect(count('V')).toBe(1);
    // Saved once and reloaded, V is now the kept row's: only a V the session added is free to go.
    create('W', rowPlaceholder(f).id);
    await settle();
    deleteEntitiesWithUndo([getAllEntities().find((e) => e.name === 'W')!.id]);
    await settle(); await save(); await reload(f);
    expect(count('W')).toBe(0);
    await restore(f, q); await save(); await reload(f);
    expect([count('V'), count('W')]).toEqual([1, 0]);
  });
});
