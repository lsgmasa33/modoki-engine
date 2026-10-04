/** #2001 S8b: a user's node the load cannot place is HELD on its instance's record, and the save writes it from there.
 *  The user adds a node under member B, then B leaves the prefab: the reload does not spawn the node (its anchor is not
 *  projected), so the record is its only home (`held.heldOwn`, `holdUnspawnedOwn`). The save writes it back on B's row,
 *  and when B returns to the prefab the node shows under it again. Before, the content lived in the old capture's kept
 *  stores, and the save that reads the record alone dropped it.
 *
 *  A RE-SEED holds it the same way (`reseedFromCapture`): the record it parses from the old capture links the node, and
 *  without the hold states no content for it, so the save dropped it.
 *
 *  A held REFERENCE node (an instance the user dropped under B) is held in the written form: its list as its own record
 *  states it (`withWrittenList`), never the old capture's row channels a re-seed parsed it from (the format rule).
 *
 *  Mutation (measured): in `instanceLoad.ts`, drop the `holdUnspawnedOwn` call of the load — red: the record holds
 *  nothing, and (that assertion skipped) the save writes no `own` on B's row. (Holding the parsed node as it is, no
 *  `written`, leaves the reference-node case here green. The old channels come from a held placeholder's kept record,
 *  pinned in the fuzz's REGRESSIONS, hunt seed 9317, by `checkScene`'s format check.)
 *
 *  A tree whose record is STALE is saved from its legacy entry, converted (`instanceSave.ts`): nothing re-seeds the record
 *  from the capture since #2001 S8b, and the conversion still writes the held node. That route goes with the stale marks
 *  (step 6).
 *
 *  A COPY holds its own copy of a held node, on records, under a fresh guid: a copy of the instance (`copyRecordsOf`), and
 *  a copy of a nested frame whose member holds one (`promotedRecord`). Mutation (measured): `seatCopy` not remapping the
 *  held content — both copy cases red; `heldIsEmpty` counting `heldOwn` — both red (the copy goes off records); the
 *  promotion not carrying the held nodes — the frame case red; no record mints in `copyGuidMap` — the frame case red (a
 *  whole-instance copy still gets them from the legacy kept state's `keptGuidMints` until that goes, step 6). */
import { describe, it, expect, vi } from 'vitest';
import { getAllEntities } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, flushWatcher, type Fixture } from './prefabFuzz/harness';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { createEntityWithUndo, duplicateEntity } from '../../packages/modoki/src/editor/undo/entityActions';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';
import { storedRecord, dropInstanceRecord } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { whyWorldNotAuthored } from '../../packages/modoki/src/editor/scene/authoredWorld';
import { NO_RECORD_TO_WRITE } from '../../packages/modoki/src/editor/instance/instanceSave';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const p1 = (f: Fixture) => getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === x.id; })!;
const memberB = (f: Fixture) => getAllEntities().find((x) => x.name === 'B' && piOf(x.id)?.rootInstanceId === p1(f).id);
const mine = () => getAllEntities().find((x) => x.name === 'Mine');
type Row = { own?: Array<{ guid?: string; name?: string }> };
/** The `own` nodes the saved scene states on any row of P1's entry. */
function savedOwn(f: Fixture): string[] {
  const entry = (JSON.parse(be.read(f.scenePath)!) as { entities: Array<{ guid?: string; members?: Record<string, Row> }> }).entities.find((e) => e.guid === p1(f).guid)!;
  return Object.values(entry.members ?? {}).flatMap((r) => (r.own ?? []).map((n) => n.name ?? ''));
}
/** The saved "Mine" on root `rootGuid`'s entry, as [name, guid]. */
const savedMine = (f: Fixture, rootGuid: string) => savedOwnOf(f, rootGuid).find(([name]) => name === 'Mine');
async function reload(f: Fixture) { expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded'); await settle(); }
async function save() { expect((await saveScene({ allowDialog: false })).saved).toBe(true); }
/** A save of a tree holding no record is REFUSED (hub ruling, 2026-10-05): it names the instance, writes nothing, and
 *  leaves the world unsavable until a load replaces it. */
async function refusedSave(f: Fixture, name: string): Promise<void> {
  const file = be.read(f.scenePath);
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await saveScene({ allowDialog: false })).saved).toBe(false);
    expect(err.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(`instance "${name}"`) && m.includes('has no instance record to write'))).toHaveLength(1);
  } finally { err.mockRestore(); }
  expect(whyWorldNotAuthored()).toBe(NO_RECORD_TO_WRITE);
  expect(be.read(f.scenePath), 'nothing is written').toBe(file);
  expect((await saveScene({ allowDialog: false })).saved, 'and stays refused').toBe(false);
}

/** Add "Mine" under B, save, and take B out of P: the reload holds the node. */
async function heldUnderGoneB(f: Fixture): Promise<string> {
  const b = memberB(f)!.id;
  expect(createEntityWithUndo('Add Mine', b, [{ name: 'EntityAttributes', data: { name: 'Mine', parentId: b } }, { name: 'Transform', data: { x: 3 } }], () => {})).not.toBeNull();
  await settle();
  await save();
  const original = be.read(f.prefabs.P.path)!;
  const doc = JSON.parse(original) as { entities: Array<{ name?: string }> };
  doc.entities = doc.entities.filter((e) => e.name !== 'B');
  const before = be.snapshot();
  be.write(f.prefabs.P.path, JSON.stringify(doc));
  await flushWatcher(be, before); await settle(); await reload(f);
  expect(mine(), 'premise: nothing shows the node').toBeUndefined();
  return original;
}

const o1 = (f: Fixture) => getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.O.guid && pi.rootInstanceId === x.id; })!;
const rootsOf = (src: string) => getAllEntities().filter((x) => { const pi = piOf(x.id); return pi?.source === src && pi.rootInstanceId === x.id; });
/** Does `id` hang under `top`? */
function within(id: number, top: number): boolean {
  const parent = new Map(getAllEntities().map((x) => [x.id, x.parentId]));
  for (let a = parent.get(id), n = 0; a && n < 64; a = parent.get(a), n++) if (a === top) return true;
  return false;
}
/** The `own` nodes, name and guid, the saved scene states on the rows of the instance `rootGuid` names: a scene entry,
 *  or a reference node written inline under another instance's row. */
function savedOwnOf(f: Fixture, rootGuid: string): Array<[string, string]> {
  type Node = { guid?: string; name?: string; members?: Record<string, { own?: Node[] }> };
  const find = (v: unknown): Node | undefined => {
    if (Array.isArray(v)) { for (const x of v) { const hit = find(x); if (hit) return hit; } return undefined; }
    if (!v || typeof v !== 'object') return undefined;
    const n = v as Node;
    if (n.guid === rootGuid && n.members) return n;
    for (const x of Object.values(v)) { const hit = find(x); if (hit) return hit; }
    return undefined;
  };
  const entry = find((JSON.parse(be.read(f.scenePath)!) as { entities: unknown[] }).entities);
  return Object.values(entry?.members ?? {}).flatMap((r) => (r.own ?? []).map((n): [string, string] => [n.name ?? '', n.guid ?? '']));
}
/** Drop B from P on disk, through the watcher, and reload: P's text before, for putting it back. */
async function dropB(f: Fixture): Promise<string> {
  const original = be.read(f.prefabs.P.path)!;
  const doc = JSON.parse(original) as { entities: Array<{ name?: string }> };
  doc.entities = doc.entities.filter((e) => e.name !== 'B');
  const before = be.snapshot();
  be.write(f.prefabs.P.path, JSON.stringify(doc));
  await flushWatcher(be, before); await settle(); await reload(f);
  return original;
}
async function restoreP(f: Fixture, original: string) {
  const before = be.snapshot();
  be.write(f.prefabs.P.path, original);
  await flushWatcher(be, before); await settle(); await reload(f);
}

describe('#2001 S8b: a linked node the load cannot place is held on the record and saved from it', () => {
  it('a copy of an instance holding a node holds its own copy, on records, under a fresh guid', async () => {
    const f = await startRun(be, async () => {}, 'held-own-copy');
    const original = await heldUnderGoneB(f);
    const src = p1(f);
    const before = new Set(rootsOf(f.prefabs.P.guid).map((r) => r.guid));
    expect(duplicateEntity(src.id, () => {})).not.toBeNull();
    await settle();
    const copy = rootsOf(f.prefabs.P.guid).find((r) => r.parentId === 0 && !before.has(r.guid))!;
    expect(storedRecord(getCurrentWorld(), copy.guid!), 'the copy is on records').toBeDefined();
    await save();
    const mineSrc = savedMine(f, src.guid!), mineCopy = savedMine(f, copy.guid!);
    expect(mineSrc?.[0]).toBe('Mine');
    expect(mineCopy?.[0]).toBe('Mine');
    expect(mineCopy?.[1], 'the copy\'s node is its own').not.toBe(mineSrc?.[1]);
    await restoreP(f, original);
    expect(getAllEntities().filter((x) => x.name === 'Mine').map((x) => x.guid).sort()).toEqual([mineSrc![1], mineCopy![1]].sort());
  }, 60_000);

  it('a copy of a nested frame holding a node under its member carries the node on its own record', async () => {
    const f = await startRun(be, async () => {}, 'held-own-promote');
    const o = o1(f).id;
    const bInO = getAllEntities().find((x) => x.name === 'B' && within(x.id, o))!.id;
    expect(createEntityWithUndo('Add Mine', bInO, [{ name: 'EntityAttributes', data: { name: 'Mine', parentId: bInO } }, { name: 'Transform', data: { x: 3 } }], () => {})).not.toBeNull();
    await settle();
    await save();
    const original = await dropB(f);
    expect(mine(), 'premise: nothing shows the node').toBeUndefined();
    // N, P's frame in O (its root shows P's root's name).
    const n = getAllEntities().find((x) => x.parentId === o1(f).id && piOf(x.id)?.rootInstanceId === x.id)!;
    const before = new Set(getAllEntities().map((x) => x.guid));
    expect(duplicateEntity(n.id, () => {})).not.toBeNull();
    await settle();
    const copy = getAllEntities().find((x) => x.parentId === o1(f).id && !before.has(x.guid))!;
    const rec = storedRecord(getCurrentWorld(), copy.guid!);
    expect(rec, 'the copy is an instance of its own, on records').toBeDefined();
    expect([...(rec!.held.heldOwn?.values() ?? [])].flat().map((x) => x.name)).toEqual(['Mine']);
    await save();
    const mineO = savedMine(f, o1(f).guid!), mineCopy = savedMine(f, copy.guid!);
    expect(mineO?.[0]).toBe('Mine');
    expect(mineCopy?.[0]).toBe('Mine');
    expect(mineCopy?.[1], 'the copy\'s node is its own').not.toBe(mineO?.[1]);
    await restoreP(f, original);
    expect(getAllEntities().filter((x) => x.name === 'Mine').map((x) => x.guid).sort()).toEqual([mineO![1], mineCopy![1]].sort());
  }, 60_000);


  // Hub ruling (2026-10-05): a tree with no record is never saved from its live tree (that capture lost the held node,
  // the #2128 class). The record is dropped by hand here: no gesture or load leaves a live tree without one.
  it('a save of a tree whose record is missing is refused, and the held reference node stays in the file', async () => {
    const f = await startRun(be, async () => {}, 'held-own-ref-reseed');
    const b = memberB(f)!.id;
    expect(await placePrefabFromPath(f.prefabs.H.path, { tag: 'test', parentId: b })).toBeTruthy();
    await settle();
    await save();
    const original = be.read(f.prefabs.P.path)!;
    const doc = JSON.parse(original) as { entities: Array<{ name?: string }> };
    doc.entities = doc.entities.filter((e) => e.name !== 'B');
    const before = be.snapshot();
    be.write(f.prefabs.P.path, JSON.stringify(doc));
    await flushWatcher(be, before); await settle(); await reload(f);
    dropInstanceRecord(getCurrentWorld(), p1(f).guid!);
    await refusedSave(f, p1(f).name);
    const entry = (JSON.parse(be.read(f.scenePath)!) as { entities: Array<{ guid?: string; members?: Record<string, { own?: Array<Record<string, unknown>> }> }> }).entities.find((e) => e.guid === p1(f).guid)!;
    const nodes = Object.values(entry.members ?? {}).flatMap((r) => r.own ?? []).filter((n) => n.prefab === f.prefabs.H.guid);
    expect(nodes, 'the held reference node is still in the file').toHaveLength(1);
    await reload(f);
    expect(whyWorldNotAuthored(), 'a load replaces the unsavable world').toBeNull();
    await save();
    expect(nodes).toHaveLength(1);
  }, 60_000);

  it('a save of a tree whose record is missing is refused, re-seeds nothing, and the held node survives a reload', async () => {
    const f = await startRun(be, async () => {}, 'held-own-node-reseed');
    await heldUnderGoneB(f);
    dropInstanceRecord(getCurrentWorld(), p1(f).guid!);
    await refusedSave(f, p1(f).name);
    expect(storedRecord(getCurrentWorld(), p1(f).guid!), 'no re-seed from the capture (#2001 S8b)').toBeUndefined();
    expect(savedOwn(f)).toContain('Mine');
    await reload(f);
    await save();
    expect(savedOwn(f), 'the held node survives the refused save').toContain('Mine');
  }, 60_000);

  it('a node under a member the prefab drops is held, saved on its row, and shows again when the member returns', async () => {
    const f = await startRun(be, async () => {}, 'held-own-node');
    const b = memberB(f)!.id;
    expect(createEntityWithUndo('Add Mine', b, [{ name: 'EntityAttributes', data: { name: 'Mine', parentId: b } }, { name: 'Transform', data: { x: 3 } }], () => {})).not.toBeNull();
    await settle();
    await save();
    expect(savedOwn(f), 'premise: the node is linked under B').toContain('Mine');

    const original = be.read(f.prefabs.P.path)!;
    const doc = JSON.parse(original) as { entities: Array<{ name?: string }> };
    doc.entities = doc.entities.filter((e) => e.name !== 'B');
    let before = be.snapshot();
    be.write(f.prefabs.P.path, JSON.stringify(doc));
    await flushWatcher(be, before); await settle(); await reload(f);
    expect(memberB(f), 'premise: B left the prefab').toBeUndefined();
    expect(mine(), 'premise: nothing shows the node').toBeUndefined();
    const held = storedRecord(getCurrentWorld(), p1(f).guid!)?.held.heldOwn;
    expect([...(held?.values() ?? [])].flat().map((n) => n.name)).toEqual(['Mine']);

    await save();
    expect(savedOwn(f)).toContain('Mine');

    before = be.snapshot();
    be.write(f.prefabs.P.path, original);
    await flushWatcher(be, before); await settle(); await reload(f);
    expect(mine()?.parentId, 'the node is back under B').toBe(memberB(f)?.id);
  }, 60_000);
});
