/** #2046 S7.6: Stop and a prefab edit's leave reload a world the editor held from its own text, and take back the exact
 *  records it held (`recordBank.ts`) where the reloaded entry is unchanged and the fold matches the parse.
 *
 *  Before S7.6 each marked the whole store stale, so every instance re-seeded its record from a capture on its next write.
 *  To tell the banked record from the parse of the same text, each test marks a record with what no reader of the text
 *  could restore: `held.unparsed` (a value in a shape no reader takes — the fold ignores it, and the save never writes it),
 *  or a placement name the live root does not show (which the fold does read). The fixture is the fuzzer's: O1, P1, H1
 *  placed, Plain plain. Driven through the real routes: Play and Stop, prefab edit's open and Exit, the Inspector's write. */

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
import { getCurrentWorld, getTraitByName } from '@modoki/engine/runtime';
import { enterPlay, stopPlay } from '../../packages/modoki/src/editor/scene/playMode';
import { openPrefabForEditing, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { writeTraitFieldWithUndo, createEntityWithUndo, reparentEntity } from '../../packages/modoki/src/editor/undo/entityActions';
import { emptySpecs } from '../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { storedInstance } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { takeRecordBank, bankInstanceRecords } from '../../packages/modoki/src/runtime/prefab/recordBank';
import { notePrefabFileChanged } from '../../packages/modoki/src/editor/scene/prefabRead';
import { captureAuthoredSnapshot } from '../../packages/modoki/src/editor/scene/authoredSnapshot';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

/** The root guid `startRun` mints for the fixture's scene entry `k` (1 O1, 2 P1, 3 H1). */
const rootGuid = (k: number) => authored().find((e) => e.guid?.startsWith(`ffffffff-0000-4000-8${k.toString(16).padStart(3, '0')}-`))!.guid!;
const stored = (k: number) => storedInstance(getCurrentWorld(), rootGuid(k));
/** Mark entry `k`'s record with a value no reader of the scene text restores, and the fold does not read: a property the
 *  record's type does not have. (Not `held.unparsed`, as before #2001 S6: the save writes the list, held values too, so
 *  that marker reached the text, and a reload from the FILE then rightly read a different entry.) */
type Marked = { s76?: string };
function markHeld(k: number): void {
  const s = stored(k)!;
  (s.record as unknown as Marked).s76 = 'banked';
}
const held = (k: number) => { const m = (stored(k)?.record as unknown as Marked | undefined)?.s76; return m ? { s76: m } : undefined; };
function under(k: number, name: string): number {
  const topId = authored().find((e) => e.guid === rootGuid(k))!.id;
  const inTree = (id: number): boolean => { for (let at = id; at; at = authored().find((e) => e.id === at)?.parentId ?? 0) if (at === topId) return true; return false; };
  return authored().find((e) => e.name === name && inTree(e.id))!.id;
}

async function playStop(): Promise<void> {
  expect((await enterPlay()).kind).toBe('started');
  await settle();
  expect(await stopPlay()).toMatchObject({ kind: 'stopped', reverted: true });
  await settle();
}

async function editAndLeave(f: Fixture, opts: { discardUnsaved?: boolean; whileAway?: () => void } = {}): Promise<void> {
  expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' }, { confirmDiscard: async () => true, discardUnsaved: opts.discardUnsaved })).toBeFalsy();
  await settle();
  opts.whileAway?.();
  expect(await exitPrefabEditing()).toBe(f.scenePath);
  await settle();
}

describe('a reload of a world the editor held takes back its exact records (#2046 S7.6)', () => {
  // Mutation: the restore banks nothing (`bankInstanceRecords` call removed in `authoredSnapshot.ts`) — the marker is lost.
  it('Stop: every record comes back exact and fresh', async () => {
    await startRun(be, async () => {}, 'reload-stop');
    markHeld(2);
    await playStop();
    expect(held(2)).toEqual({ s76: 'banked' });
  });

  // Mutation: `foldText` compares the links under each anchor in link order (the sort removed in `recordBank.ts`) — P1's
  // record is left as the parse, stale (hunt seed 9306). The save writes a row's own nodes in sibling order, so two nodes
  // the user made under P1 and then reordered come back from the banked text in the other order than the record links them.
  it('Stop: a record whose own links are not in sibling order comes back exact and fresh', async () => {
    await startRun(be, async () => {}, 'reload-own-order');
    const p1 = authored().find((e) => e.guid === rootGuid(2))!.id;
    const make = (name: string) => {
      const { specs } = emptySpecs(p1);
      return createEntityWithUndo(`Create ${name}`, p1, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name } } : s)), () => {})!;
    };
    const [x, y] = [make('X'), make('Y')];
    const sortOf = (id: number) => authored().find((e) => e.id === id)!.sortOrder;
    expect(reparentEntity(y, p1, sortOf(x) - 1)).toBe(true); // Y before X among P1's children
    const [gx, gy] = [x, y].map((id) => authored().find((e) => e.id === id)!.guid!); // read here: Stop's reload renumbers
    const links = () => (stored(2)!.record.list.rows.get('/')?.own ?? []).map((o) => o.guid);
    expect(links(), 'premise: linked X first').toEqual([gx, gy]);
    expect(sortOf(y)).toBeLessThan(sortOf(x)); // premise: the save writes Y first
    markHeld(2);
    await playStop();
    expect(held(2)).toEqual({ s76: 'banked' });
    expect(links()).toEqual([gx, gy]);
  });

  // Mutation: `adoptBankedRecords` skips the fold comparison — O1 comes back naming its root "Bogus", which it does not show.
  // The BANKED record is changed while away (the bank re-made with it): since #2001 S6 the banked text is written from
  // the records, so a record changed before the bank is made is what the text states too, and is rightly seated.
  it('a prefab edit\'s Exit: a banked record whose fold differs from the parse is not seated — the parse stays, fresh', async () => {
    const f = await startRun(be, async () => {}, 'reload-fold');
    const shown = stored(1)!.record.placement.name;
    const g1 = rootGuid(1);
    await editAndLeave(f, { whileAway: () => {
      const bank = takeRecordBank(f.scenePath)!;
      expect(bank, 'premise: the open banked the scene').toBeTruthy();
      bank.stored.get(g1)!.record.placement.name = 'Bogus';
      bankInstanceRecords(f.scenePath, bank.stored, [...bank.entries.values()].map((t) => JSON.parse(t) as never));
    } });
    expect(stored(1)!.record.placement.name).toBe(shown);
  });

  // Mutation: the prefab edit's open banks nothing (`bankSceneRecords` returns at once) — the marker is lost.
  it('a prefab edit\'s Exit: the return scene\'s records come back exact and fresh', async () => {
    const f = await startRun(be, async () => {}, 'reload-leave');
    markHeld(2);
    await editAndLeave(f);
    expect(held(2)).toEqual({ s76: 'banked' });
  });

  // Mutation: `adoptBankedRecords` skips the entry comparison — P1 takes back a record stating an edit its file never got.
  it('a prefab edit\'s Exit: an entry the file does not state as banked (an edit the open discarded) keeps its parse', async () => {
    const f = await startRun(be, async () => {}, 'reload-discard');
    markHeld(1);
    expect(writeTraitFieldWithUndo(under(2, 'A'), getTraitByName('Transform')!, 'x', 42)).toBeNull();
    markHeld(2);
    await editAndLeave(f, { discardUnsaved: true });
    expect(held(1)).toEqual({ s76: 'banked' }); // O1's entry is the file's: banked
    expect(held(2)).toBeUndefined(); // P1's is not: the discarded edit's record is not taken back
    expect(JSON.stringify([...stored(2)!.record.list.rows.values()])).not.toContain('42');
  });

  // Mutation: `adoptBankedRecords` skips the entry comparison — P1 takes back its banked record over what the file now says.
  it('a prefab edit\'s Exit: an entry rewritten outside while away keeps its parse, even where the fold cannot tell', async () => {
    const f = await startRun(be, async () => {}, 'reload-outside');
    markHeld(1);
    markHeld(2);
    const p1 = rootGuid(2); // read here: in prefab edit the scene's entities are not live
    await editAndLeave(f, {
      // A value in a shape no reader takes, which the parse holds (`unparsed`) and the fold does not read: only the entry
      // text tells this file from the one the open saved.
      whileAway: () => {
        const scene = JSON.parse(be.read(f.scenePath)!) as { entities: { guid?: string; templateMoved?: unknown }[] };
        scene.entities.find((e) => e.guid === p1)!.templateMoved = 5;
        be.write(f.scenePath, `${JSON.stringify(scene, null, 2)}\n`);
      },
    });
    expect(held(1)).toEqual({ s76: 'banked' });
    expect(held(2)).toBeUndefined();
    expect(stored(2)!.record.held.unparsed).toEqual({ templateMoved: 5 }); // the file's, not the bank's
  });

  // Mutation: the open drops no bank it did not use (the `dropRecordBank` call removed from `openPrefabForEditing`) — the
  // bank stays for whichever load of the scene comes next.
  it('a prefab edit\'s open refused after it banked leaves no bank behind', async () => {
    const f = await startRun(be, async () => {}, 'reload-refused-open');
    expect(writeTraitFieldWithUndo(under(2, 'A'), getTraitByName('Transform')!, 'x', 42)).toBeNull(); // unsaved, so the open asks
    const r = await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' }, {
      discardUnsaved: true,
      // The prefab file changed while the human's dialog was up: the open refuses after it banked (#1752).
      confirmDiscard: async () => { notePrefabFileChanged(f.prefabs.H.path); return true; },
    });
    expect(r && 'refused' in r ? r.refused : r).toMatch(/saved while it was opening/);
    expect(takeRecordBank(f.scenePath)).toBeUndefined();
  });

  // Mutation: the capture banks the store as it stands after the serialize (`steadyRecords` bypassed in
  // `captureAuthoredSnapshot`) — P1's record, changed while the serialize awaited, is banked with the change.
  it('Play\'s capture banks no record that changed while it serialized', async () => {
    await startRun(be, async () => {}, 'reload-steady');
    const capture = captureAuthoredSnapshot();
    queueMicrotask(() => { stored(2)!.record.held.unparsed = { landed: 'mid-capture' }; }); // an edit landing during its awaits
    const snap = await capture;
    expect(stored(2)!.record.held.unparsed).toEqual({ landed: 'mid-capture' }); // premise: it landed
    expect(snap.records?.has(rootGuid(2))).toBe(false);
    expect(snap.records?.has(rootGuid(1))).toBe(true);
  });

  // Mutation: the swap seats no carried record (the `carriedRecords` loop in `SceneManager.ts` removed) — P1 arrives with no
  // record, to be re-seeded from a capture.
  it('a world swap that keeps a base carries its instances\' exact records', async () => {
    const f = await startRun(be, async () => {}, 'reload-kept-base');
    // Two levels on the fixture's scene as their base: a switch from one to the other keeps the base, carried.
    const level = (n: number) => {
      const path = f.scenePath.replace(/Fuzz\.json$/, `Level${n}.json`);
      const guid = f.sceneGuid.replace(/^.{8}/, `abab${String(n).padStart(4, '0')}`);
      be.write(path, `${JSON.stringify({ id: guid, version: SCENE_FORMAT_VERSION, name: `Level${n}`, createdAt: '2026-01-01T00:00:00.000Z', resources: [], baseScene: f.sceneGuid, entities: [] }, null, 2)}\n`);
      registerAsset(guid, path, 'scene');
      return path;
    };
    const [l1, l2] = [level(1), level(2)];
    be.marked.clear();
    expect((await loadSceneReporting(l1)).outcome).toBe('loaded');
    await settle();
    markHeld(2);
    expect((await loadSceneReporting(l2)).outcome).toBe('loaded');
    await settle();
    expect(held(2)).toEqual({ s76: 'banked' });
  });
});
