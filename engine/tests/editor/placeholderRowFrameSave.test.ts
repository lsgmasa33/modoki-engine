/** A frame holding a missing nested row's placeholder keeps its row records on save (#2059, #2058 hunt seeds 7315/7393).
 *
 *  O1 is an instance of O, whose row N nests P; P's row C nests Q (QR → M). The user hangs U at O1's QR, trashes Q (its
 *  frame is kept live, #1862), and edits a member of N's frame: removes the Rotate3D that O's row N adds to A (7393), or adds
 *  one to Extra, the node O's row N adds under A (7315). Entering and leaving a prefab edit rebuilds the instance, and QR
 *  comes back as a Missing Prefab ROW placeholder (#2001 S5, ruling D), which has no PrefabInstance. The save could not key
 *  U's statement at that row, so it wrote N's whole frame as a legacy `nestedStructure` slot instead of rows, and A's row
 *  record (`traitRemovals`, or Extra's node row) left the file. The reload lost the edit. Now the placeholder stands for
 *  its row (`moveChannelsOntoRows`' `keyFor`), and the frame stays on rows.
 *
 *  Driven through the real editor over the fuzzer's in-process backend (#1707's fixture), as `rowPlaceholderUserNodes.test.ts` is.
 *
 *  Mutation (`editor/scene/prefabCapture.ts` `moveChannelsOntoRows`): drop the placeholder clause from `keyFor`'s live test
 *  (`if (live) return ''` again): every case goes red (the template case on Extra staying at x 6). */
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
import { boot, bridge, memoryStorage, startRun, settle, piOf, flushWatcher, editing, type Fixture } from './prefabFuzz/harness';
import { deleteAssetFiles, deletionPathsFor } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { createEntityWithUndo, addTraitToEntitiesWithUndo, removeTraitFromEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { emptySpecs } from '../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { openPrefabForEditing, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { rowPlaceholderOf } from '../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { findEntity, readTraitData } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import type { SceneEntityEntry } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);
const noNest = async () => {};

function o1(f: Fixture): number {
  return getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.O.guid && pi.rootInstanceId === x.id; })!.id;
}
function under(root: number): Set<number> {
  const all = getAllEntities();
  const s = new Set<number>([root]);
  for (let grew = true; grew;) { grew = false; for (const e of all) if (!s.has(e.id) && s.has(e.parentId)) { s.add(e.id); grew = true; } }
  return s;
}
/** The one entity named `name` inside O1. */
const inO1 = (f: Fixture, name: string) => {
  const found = getAllEntities().filter((x) => under(o1(f)).has(x.id) && x.name === name);
  expect(found.map((x) => x.name)).toEqual([name]);
  return found[0]!;
};
async function trashQ(f: Fixture): Promise<void> {
  const before = be.snapshot();
  const del = await deleteAssetFiles(deletionPathsFor(f.prefabs.Q.path, 'prefab', null));
  if (!del.ok) throw new Error('trash failed');
  unbindDeletedAssetEditors([f.prefabs.Q.path]);
  await flushWatcher(be, before);
  await settle();
}
async function save() { expect((await saveScene({ allowDialog: false })).saved).toBe(true); }
async function reload(f: Fixture) { expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded'); await settle(); }
/** Enter a prefab edit of H (no instance of it is under O1) and leave it: the leave rebuilds the scene's instances. */
async function enterAndLeave(f: Fixture) {
  expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' }, { confirmDiscard: async () => true })).toBeFalsy();
  expect(editing()).toBe(true);
  await exitPrefabEditing();
  await settle();
  expect(editing()).toBe(false);
}
/** O1's entry as the scene file holds it. */
const o1Entry = (f: Fixture): SceneEntityEntry =>
  (JSON.parse(be.read(f.scenePath)!) as { entities: SceneEntityEntry[] }).entities.find((e) => e.prefab === f.prefabs.O.guid)!;
const has = (id: number, trait: string) => getAllEntities().find((e) => e.id === id)!.traits.includes(trait);

/** U at O1's QR, saved; Q trashed; then `edit`, a prefab edit entered and left, and a save. */
async function editThenLeave(tag: string, edit: (f: Fixture) => void): Promise<Fixture> {
  const f = await startRun(be, noNest, tag);
  const { specs } = emptySpecs(inO1(f, 'QR').id);
  createEntityWithUndo('Create U', inO1(f, 'QR').id, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name: 'U' } } : s)), () => {});
  await settle(); await save();
  await trashQ(f);
  edit(f);
  await settle();
  await enterAndLeave(f);
  // The precondition the bug needs: the leave's rebuild made QR a row placeholder.
  expect(rowPlaceholderOf(findEntity(inO1(f, 'QR').id) as never), 'QR is not a Missing Prefab row placeholder after the leave').toBeTruthy();
  await save();
  return f;
}

describe('a member edit beside a missing nested row\'s placeholder survives a prefab-edit leave, save and reload (#2059)', () => {
  it('a component removed from a member (7393): the row keeps its removal, and the reload has it', async () => {
    const f = await editThenLeave('row-frame-remove', (f) => {
      const a = inO1(f, 'A');
      expect(has(a.id, 'Rotate3D')).toBe(true);
      expect(removeTraitFromEntitiesWithUndo([a.id], getTraitByName('Rotate3D')!)).toBeFalsy();
    });
    const entry = o1Entry(f);
    expect(entry.nestedStructure, 'N\'s frame fell back to a whole legacy slot').toBeUndefined();
    const rowOfA = Object.values(entry.members ?? {}).find((r) => r.name === 'A' && r.guid === inO1(f, 'A').guid);
    expect(rowOfA?.traitRemovals).toEqual({ Rotate3D: true });
    await reload(f);
    expect(has(inO1(f, 'A').id, 'Rotate3D')).toBe(false);
    // And it round-trips: the save after the reload writes the same entry.
    await save();
    expect(o1Entry(f)).toEqual(entry);
  });

  it('a component added to a template-added node (7315): its node row keeps it, and the reload has it', async () => {
    const f = await editThenLeave('row-frame-add', (f) => {
      const extra = inO1(f, 'Extra');
      expect(has(extra.id, 'Rotate3D')).toBe(false);
      expect(addTraitToEntitiesWithUndo([extra.id], getTraitByName('Rotate3D')!)).toBeFalsy();
    });
    const entry = o1Entry(f);
    expect(entry.nestedStructure, 'N\'s frame fell back to a whole legacy slot').toBeUndefined();
    const nodeRow = Object.entries(entry.members ?? {}).find(([k]) => k.endsWith('/a+k-extra'))?.[1];
    expect(Object.keys(nodeRow?.traits ?? {})).toContain('Rotate3D');
    await reload(f);
    expect(has(inO1(f, 'Extra').id, 'Rotate3D')).toBe(true);
    await save();
    expect(o1Entry(f)).toEqual(entry);
  });

  // What the whole slot cost in practice: it restated O's row N's lists in the scene (the #1516 pin), so a later change to
  // O never reached O1. Observed: Extra stayed at x 6 after O moved it to 9.
  it('a later change to O\'s row N still reaches O1 (the slot no longer pins it)', async () => {
    const f = await editThenLeave('row-frame-template', (f) => {
      expect(removeTraitFromEntitiesWithUndo([inO1(f, 'A').id], getTraitByName('Rotate3D')!)).toBeFalsy();
    });
    const o = JSON.parse(be.read(f.prefabs.O.path)!) as { entities: { added?: { traits: { Transform: { x: number } } }[] }[] };
    o.entities[1]!.added![0]!.traits.Transform.x = 9;
    const before = be.snapshot();
    be.write(f.prefabs.O.path, `${JSON.stringify(o, null, 2)}\n`);
    await flushWatcher(be, before); await settle();
    await reload(f);
    expect((readTraitData(inO1(f, 'Extra').id, getTraitByName('Transform')!) as { x: number }).x).toBe(9);
    expect(has(inO1(f, 'A').id, 'Rotate3D')).toBe(false);
  });

  // The TOP frame keeps the legacy per-node channel for a node at a placeholder (close-out review of #2059): keyed onto
  // the row, it went into the top-frame loop's whole-list `added`, which replaced every node the chain anchors at Q's root
  // once Q returned. Here P's row C anchors CX there; it was deleted, and the next save stated the deletion. Mutation:
  // drop `frameRoot !== rootId` from `keyFor`'s placeholder clause — red (no CX).
  it('top frame: a node at P1\'s placeholder leaves the template\'s nodes at Q\'s root alone when Q returns', async () => {
    const f = await startRun(be, noNest, 'row-frame-top');
    const qText = be.read(f.prefabs.Q.path)!;
    const p1 = () => getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === x.id; })!.id;
    const inP1 = (name: string) => getAllEntities().filter((x) => under(p1()).has(x.id) && x.name === name);
    const outside = async (path: string, text: string) => { const before = be.snapshot(); be.write(path, text); await flushWatcher(be, before); await settle(); };
    const pDoc = JSON.parse(be.read(f.prefabs.P.path)!) as { entities: { added?: unknown[] }[] };
    pDoc.entities[3]!.added = [{ parentLocalId: 1, guid: '', key: 'k-cx', name: 'CX', traits: { EntityAttributes: { name: 'CX', parentId: 0 }, Transform: { x: 2, y: 0, z: 0 } }, children: [] }];
    await outside(f.prefabs.P.path, `${JSON.stringify(pDoc, null, 2)}\n`);
    await reload(f);
    expect(inP1('CX')).toHaveLength(1);
    const qr = inP1('QR')[0]!.id;
    const { specs } = emptySpecs(qr);
    createEntityWithUndo('Create U', qr, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name: 'U' } } : s)), () => {});
    await settle(); await save();
    await trashQ(f);
    expect(addTraitToEntitiesWithUndo([inP1('A')[0]!.id], getTraitByName('Rotate3D')!)).toBeFalsy();
    await settle();
    await enterAndLeave(f);
    expect(rowPlaceholderOf(findEntity(inP1('QR')[0]!.id) as never)).toBeTruthy();
    await save(); await reload(f); await save();
    await outside(f.prefabs.Q.path, qText);
    await reload(f); await save(); await reload(f);
    expect([inP1('U').length, inP1('CX').length]).toEqual([1, 1]);
    expect(has(inP1('A')[0]!.id, 'Rotate3D')).toBe(true);
  });

  it('U, hung at the placeholder, stays on its row\'s own list', async () => {
    const f = await editThenLeave('row-frame-own', () => {});
    const qrRow = Object.values(o1Entry(f).members ?? {}).find((r) => r.name === 'QR');
    expect((qrRow?.own ?? []).map((n) => n.name)).toEqual(['U']);
    expect(o1Entry(f).nestedStructure).toBeUndefined();
  });
});
