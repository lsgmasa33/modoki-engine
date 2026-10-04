/** #2001 S8b: an Apply that promotes the user's added nodes into the applying frame's own document keeps the records
 *  (`promoteAdded`). The tree's record stops linking the promoted node and pins each new member to the guid the node had;
 *  a promoted REFERENCE node's own record goes (its list is the new row's, baked) and its members keep their guids under
 *  that row's key. The record stays fresh, so nothing re-seeds it from the capture, and save → reload keeps every guid.
 *
 *  Mutation (measured), `promoteAdded`: refusing always — both red (the Apply was marked stale; now it is refused); keeping the link —
 *  both red; no pins — both red (the record no longer states what the saved file gives back); keeping the reference
 *  node's own record — the reference case red; neither of the reference node's pin sources (its record's pins, its live
 *  members) — the reference case red. Either alone is GREEN here: Q's record pins M, which is also live; the record's
 *  pins exist for a member that is not live (an orphan the template dropped), which this fixture has none of.
 *  The third case (a reference node holding a user's node and an instance): refusing a node whose record links an own
 *  node — red; dropping only the node's record, not the one inside it — red. Refusing on `storedRootsUnder` is GREEN:
 *  the plan's capture has keyed the instance inside as the row's template node by then, so it no longer counts.
 *  The fourth case (a node written on an ENCLOSING prefab's row, #1715, hunt seed 9409): the caller keeping a no-frame
 *  Apply off records — red (then marked stale, now refused); `promoteAdded` keeping a keyed top's link — red. Nothing else red
 *  in either. */
import { describe, it, expect, vi } from 'vitest';
import { getAllEntities, getTraitByName } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, type Fixture } from './prefabFuzz/harness';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { applyToPrefabSelective } from '../../packages/modoki/src/editor/scene/prefabApply';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';
import { storedRecord, storedInstance } from '../../packages/modoki/src/runtime/prefab/instanceStore';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const p1 = (f: Fixture) => getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === x.id; })!;
const memberA = (f: Fixture) => getAllEntities().find((x) => x.name === 'A' && piOf(x.id)?.rootInstanceId === p1(f).id)!;
const byGuid = (g: string) => getAllEntities().find((x) => x.guid === g);
/** Every `own` link P1's record states. */
const links = (f: Fixture) => [...(storedRecord(getCurrentWorld(), p1(f).guid!)?.list.rows.values() ?? [])].flatMap((r) => (r.own ?? []).map((o) => o.guid));
/** P1's record as it stands: the Apply left it unmarked (no re-seed from the capture), and its list in a stable form. */
function p1Record(f: Fixture): string {
  const st = storedInstance(getCurrentWorld(), p1(f).guid!);
  return JSON.stringify([...st!.record.list.rows].sort(([a], [b]) => (a < b ? -1 : 1)));
}
async function saveReload(f: Fixture) {
  expect((await saveScene({ allowDialog: false })).saved).toBe(true);
  expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
  await settle();
}

describe('#2001 S8b: an Apply that promotes added nodes keeps the records', () => {
  it('a plain node becomes a member under the guid it had, on a fresh record', async () => {
    const f = await startRun(be, async () => {}, 'apply-promote-plain');
    const a = memberA(f).id;
    expect(createEntityWithUndo('Add Mine', a, [{ name: 'EntityAttributes', data: { name: 'Mine', parentId: a } }, { name: 'Transform', data: { x: 3 } }], () => {})).not.toBeNull();
    await settle();
    const g = getAllEntities().find((x) => x.name === 'Mine')!.guid!;
    expect(links(f), 'premise: the node is linked').toContain(g);
    expect((await applyToPrefabSelective(p1(f).id, new Set([`+added.${g}`]))).applied).toBe(true);
    await settle();
    const rec = p1Record(f);
    expect(links(f)).not.toContain(g);
    expect(piOf(byGuid(g)!.id)?.rootInstanceId, 'a member of P1 now').toBe(p1(f).id);
    // Once in the template, every instance of P shows it (O's nested P frame too): one under P1's A.
    expect(getAllEntities().filter((x) => x.name === 'Mine' && x.parentId === memberA(f).id)).toHaveLength(1);
    await saveReload(f);
    expect(piOf(byGuid(g)!.id)?.rootInstanceId).toBe(p1(f).id);
    expect(p1Record(f), 'the record states what the saved file gives back (the new member\'s pin included)').toBe(rec);
  }, 60_000);

  it('a reference node becomes a nested row; its record goes and its members keep their guids', async () => {
    const f = await startRun(be, async () => {}, 'apply-promote-ref');
    const a = memberA(f).id;
    // Q: QR with member M, so the nested row has a member to pin.
    expect(await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: a })).toBeTruthy();
    await settle();
    const q = getAllEntities().find((x) => x.parentId === a && piOf(x.id)?.source === f.prefabs.Q.guid)!;
    const g = q.guid!;
    const m = getAllEntities().find((x) => x.name === 'M' && x.parentId === q.id)!.guid!;
    expect(storedInstance(getCurrentWorld(), g), 'premise: the node has a record of its own').toBeDefined();
    expect((await applyToPrefabSelective(p1(f).id, new Set([`+added.${g}`]))).applied).toBe(true);
    await settle();
    const rec = p1Record(f);
    expect(storedInstance(getCurrentWorld(), g), 'its own record went').toBeUndefined();
    expect(links(f)).not.toContain(g);
    expect(byGuid(g)?.parentId, 'its guid stays').toBe(memberA(f).id);
    expect(byGuid(m)?.parentId, 'and its member\'s').toBe(byGuid(g)?.id);
    await saveReload(f);
    expect(byGuid(m)?.parentId).toBe(byGuid(g)?.id);
    expect(p1Record(f), 'the record states what the saved file gives back (the nested row\'s pins included)').toBe(rec);
  }, 60_000);

  it('a reference node holding a user\'s node and an instance takes both into its row; their records go with it', async () => {
    const f = await startRun(be, async () => {}, 'apply-promote-ref-holding');
    const a = memberA(f).id;
    expect(await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: a })).toBeTruthy();
    await settle();
    const q = getAllEntities().find((x) => x.parentId === a && piOf(x.id)?.source === f.prefabs.Q.guid)!;
    const g = q.guid!;
    // Inside Q: the user's node under its member M (an own link of Q's record), and an H instance under its root.
    const m = getAllEntities().find((x) => x.name === 'M' && x.parentId === q.id)!.id;
    expect(createEntityWithUndo('Add Mine', m, [{ name: 'EntityAttributes', data: { name: 'Mine', parentId: m } }, { name: 'Transform', data: { x: 3 } }], () => {})).not.toBeNull();
    expect(await placePrefabFromPath(f.prefabs.H.path, { tag: 'test', parentId: q.id })).toBeTruthy();
    await settle();
    const h = getAllEntities().find((x) => x.parentId === byGuid(g)!.id && piOf(x.id)?.source === f.prefabs.H.guid)!.guid!;
    expect(storedInstance(getCurrentWorld(), h), 'premise: the instance inside has a record of its own').toBeDefined();
    expect((await applyToPrefabSelective(p1(f).id, new Set([`+added.${g}`]))).applied).toBe(true);
    await settle();
    const rec = p1Record(f);
    expect(storedInstance(getCurrentWorld(), g), 'Q\'s record went').toBeUndefined();
    expect(storedInstance(getCurrentWorld(), h), 'and the record of the instance inside it').toBeUndefined();
    // Both are template nodes of the row now, shown once each where the user put them.
    const qNow = byGuid(g)!;
    const mNow = getAllEntities().find((x) => x.name === 'M' && x.parentId === qNow.id)!;
    expect(getAllEntities().filter((x) => x.name === 'Mine' && x.parentId === mNow.id)).toHaveLength(1);
    expect(getAllEntities().filter((x) => x.name === 'HR' && x.parentId === qNow.id)).toHaveLength(1);
    await saveReload(f);
    expect(getAllEntities().filter((x) => x.name === 'Mine' && x.parentId === getAllEntities().find((y) => y.name === 'M' && y.parentId === byGuid(g)!.id)!.id)).toHaveLength(1);
    expect(p1Record(f), 'the record states what the saved file gives back').toBe(rec);
  }, 60_000);

  /** P1's nested Q frame (row C): its root QR. */
  const nestedQR = (f: Fixture) => getAllEntities().find((x) => x.name === 'QR' && x.parentId === p1(f).id)!;
  /** Add a node under P1's nested QR and Apply it to P, the ENCLOSING prefab (#1715): written as a template node on P's
   *  row C, not into Q. */
  async function applyToEnclosing(f: Fixture): Promise<string> {
    const qr = nestedQR(f).id;
    expect(createEntityWithUndo('Add Mine', qr, [{ name: 'EntityAttributes', data: { name: 'Mine', parentId: qr } }, { name: 'Transform', data: { x: 3 } }], () => {})).not.toBeNull();
    await settle();
    const g = getAllEntities().find((x) => x.name === 'Mine')!.guid!;
    expect(links(f), 'premise: the node is linked on P1\'s record').toContain(g);
    const key = `+added.${g}`;
    const r = await applyToPrefabSelective(nestedQR(f).id, new Set([key]), { perKey: { [key]: f.prefabs.P.guid } });
    expect(r.applied, JSON.stringify({ refused: r.refused, skipped: r.skipped })).toBe(true);
    expect(r.writes?.map((w) => w.source), 'premise: only P was written, not Q').toEqual([f.prefabs.P.guid]);
    await settle();
    return g;
  }
  const minesUnderQR = (f: Fixture) => getAllEntities().filter((x) => x.name === 'Mine' && x.parentId === nestedQR(f).id);

  it('a node written on an enclosing prefab\'s row leaves the record\'s links, on a fresh record (hunt seed 9409)', async () => {
    const f = await startRun(be, async () => {}, 'apply-promote-enclosing');
    const g = await applyToEnclosing(f);
    const rec = p1Record(f);
    expect(links(f)).not.toContain(g);
    // A template-keyed node of P now: its guid derives (refs follow it, `carryPromotedGuids`), shown once.
    expect(minesUnderQR(f)).toHaveLength(1);
    expect(byGuid(g), 'its guid derives, as a keyed template node\'s does').toBeUndefined();
    const derived = minesUnderQR(f)[0]!.guid;
    await saveReload(f);
    expect(minesUnderQR(f).map((x) => x.guid)).toEqual([derived]);
    expect(p1Record(f), 'the record states what the saved file gives back').toBe(rec);
  }, 60_000);

  it('an added node the record does not link is refused before any file is written', async () => {
    const f = await startRun(be, async () => {}, 'apply-promote-unlinked');
    const a = memberA(f).id;
    // Moved under A by a write that went around the door, so P1's record does not link it and cannot say what a promotion
    // leaves. Before, the Apply wrote P and marked the record stale, for a re-seed from the live tree.
    expect(createEntityWithUndo('Add Loose', 0, [{ name: 'EntityAttributes', data: { name: 'Loose', parentId: 0 } }, { name: 'Transform', data: { x: 3 } }], () => {})).not.toBeNull();
    await settle();
    const loose = getAllEntities().find((x) => x.name === 'Loose')!;
    const ea = getTraitByName('EntityAttributes')!;
    const handle = [...getCurrentWorld().entities].find((e) => e.id() === loose.id)!;
    handle.set(ea.trait, { ...(handle.get(ea.trait) as object), parentId: a });
    expect(links(f), 'premise: the record does not link it').not.toContain(loose.guid);
    const rec = p1Record(f);
    const files = be.snapshot();
    const r = await applyToPrefabSelective(p1(f).id, new Set([`+added.${loose.guid}`]));
    // MUTATION TARGET: drop the `canPromoteAdded` refusal and the Apply writes P, then throws and rolls back.
    expect(r.applied).toBe(false);
    expect(r.refused).toMatch(/added node could not be applied/);
    expect(be.snapshot(), 'no file was written').toEqual(files);
    expect(p1Record(f), 'the record is as it was, unmarked').toBe(rec);
    expect(byGuid(loose.guid!)?.parentId, 'the node is where it was').toBe(memberA(f).id);
  }, 60_000);
});
