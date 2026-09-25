/** #1468 Phase 2B — `memberRowKeysIn`: which live member owns which member row key.
 *
 *  The module's docblock lists four things that get NO row. That list is a CLAIM, and a claim about
 *  a guard is wrong in two directions: a floor that is not real reads as permission, and a real floor
 *  left unstated reads as coverage (#1468 Phase 1's close-out found one of each, one pass apart).
 *  So there is a test per line here, asserting the exclusion actually happens rather than that the
 *  docblock says it does.
 *
 *  Driven at the walk directly rather than through a save, because these are properties of the walk:
 *  a scene-level test would prove them only for the shapes a scene happens to build. */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';
import { getCurrentWorld, setCurrentWorld, getTraitByName, spawnEntity } from '@modoki/engine/runtime';
import { memberRowKeysIn } from '../../packages/modoki/src/runtime/core/ecs/memberRows';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const G = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Pi = { source?: string; localId?: number; nodeGuid?: string; rootInstanceId?: number; parentLocalId?: number; parentNodeGuid?: string; ownerGuid?: string };

/** Spawn one entity; `pi` absent = a plain node (an added subtree's node). */
function node(name: string, parentId: number, pi?: Pi, guid = ''): number {
  const ea = getTraitByName('EntityAttributes')!;
  const piMeta = getTraitByName('PrefabInstance')!;
  const world = getCurrentWorld();
  const args: unknown[] = [ea.trait({ name, parentId, guid })];
  if (pi) args.push(piMeta.trait({ source: 'P', localId: 0, nodeGuid: '', rootInstanceId: 0, parentLocalId: 0, parentNodeGuid: '', ownerGuid: '', ...pi }));
  return spawnEntity(world, ...(args as Parameters<typeof world.spawn>)).id();
}

/** The instance root: its own `rootInstanceId`, no row parent — `isStoredRoot`. */
function instanceRoot(name: string, parentId = 0): number {
  const ea = getTraitByName('EntityAttributes')!;
  const piMeta = getTraitByName('PrefabInstance')!;
  const e = spawnEntity(getCurrentWorld(), ea.trait({ name, parentId, guid: G(999) }), piMeta.trait({ source: 'P', localId: 1, nodeGuid: G(1), rootInstanceId: 0, parentLocalId: 0, parentNodeGuid: '', ownerGuid: '' }));
  e.set(piMeta.trait, { ...(e.get(piMeta.trait) as Record<string, unknown>), rootInstanceId: e.id() });
  return e.id();
}

const keysByName = (rootId: number): Record<string, string> => {
  const ea = getTraitByName('EntityAttributes')!;
  const out: Record<string, string> = {};
  for (const [id, key] of memberRowKeysIn(rootId)) {
    for (const e of getCurrentWorld().entities) {
      if (e.id() === id) out[(e.get(ea.trait) as { name: string }).name] = key;
    }
  }
  return out;
};

beforeEach(() => { const p = getCurrentWorld(); setCurrentWorld(createWorld()); p?.destroy(); });
afterAll(() => { getCurrentWorld()?.destroy(); });

describe('memberRowKeysIn — the keyed members of an instance', () => {
  it('keys a member by its own minted identity, flat within the frame', () => {
    const root = instanceRoot('Root');
    const panel = node('Panel', root, { localId: 2, nodeGuid: G(2), rootInstanceId: root });
    node('Deep', panel, { localId: 3, nodeGuid: G(3), rootInstanceId: root });
    // `Deep` hangs under `Panel`, and its key does NOT mention Panel — that is D1(a): flat within a
    // frame, so re-parenting a member inside its instance re-keys nothing.
    expect(keysByName(root)).toEqual({ Panel: `/${G(2)}`, Deep: `/${G(3)}` });
  });

  it('opens a new frame at an OWNED nested root, keyed by which OUTER row produced it', () => {
    const root = instanceRoot('Root');
    const nested = node('Nested', root, { source: 'CHILD', localId: 1, nodeGuid: G(50), parentLocalId: 4, parentNodeGuid: G(4) });
    const piMeta = getTraitByName('PrefabInstance')!;
    for (const e of getCurrentWorld().entities) {
      if (e.id() === nested) e.set(piMeta.trait, { ...(e.get(piMeta.trait) as Record<string, unknown>), rootInstanceId: nested });
    }
    node('Inner', nested, { source: 'CHILD', localId: 2, nodeGuid: G(51), rootInstanceId: nested });
    // The nested root is keyed by `parentNodeGuid` (the OUTER row), never by its own `nodeGuid`
    // (which belongs to the child document) — and its member's key chains through it.
    expect(keysByName(root)).toEqual({ Nested: `/${G(4)}`, Inner: `/${G(4)}/${G(51)}` });
  });

  it('gives the instance root itself no row — it IS the scene entry', () => {
    const root = instanceRoot('Root');
    node('Panel', root, { localId: 2, nodeGuid: G(2), rootInstanceId: root });
    expect(Object.keys(keysByName(root))).toEqual(['Panel']);
  });

  it('gives a user-added nested instance and its members no rows — it anchors its own walk (#1349)', () => {
    const root = instanceRoot('Root');
    const added = instanceRoot('AddedInstance', root);   // stored root: rootInstanceId self, no row parent
    node('AddedMember', added, { source: 'OTHER', localId: 2, nodeGuid: G(60), rootInstanceId: added });
    expect(keysByName(root)).toEqual({});
  });

  it('gives an ADDED NODE no row, but keeps the row of a member that merely sits under one', () => {
    const root = instanceRoot('Root');
    const plain = node('AddedNode', root);               // no PrefabInstance at all
    node('Below', plain, { source: 'P', localId: 9, nodeGuid: G(70), rootInstanceId: root });
    // Two different questions. The added node has no identity of this instance's to carry, so no row.
    // `Below` DOES — it is a member of this instance that was dragged under the added node, which
    // `planMoveUnlinks` keeps linked (#1437) — so its key must not change just because it moved.
    expect(keysByName(root)).toEqual({ Below: `/${G(70)}` });
  });

  it('gives a member of a DIFFERENT instance no row, wherever it physically sits (R8)', () => {
    // The illegal state #1468 design record D1's third accepted cost warns about: path-addressing could not express
    // "member of X living outside X", identity-addressing can, and the save path is what has to
    // refuse it. Here the foreign member sits right inside our subtree and still gets no key,
    // because its frame chain never reaches our root.
    const root = instanceRoot('Root');
    const mine = node('Mine', root, { localId: 2, nodeGuid: G(2), rootInstanceId: root });
    const foreignRoot = instanceRoot('Foreign', 0);
    node('Theirs', mine, { source: 'OTHER', localId: 5, nodeGuid: G(90), rootInstanceId: foreignRoot });
    expect(keysByName(root)).toEqual({ Mine: `/${G(2)}` });
  });

  it('keeps a member`s key when it is moved BESIDE its frame, into a nested instance`s subtree', () => {
    // D1(a)'s promise, and the case an ECS-descent walk breaks: this member belongs to the OUTER
    // instance and is dragged under a member of the nested one. Its frame is still the outer one, so
    // its key must be unchanged — re-keying it into the nested frame would dangle its stored guid
    // and silently re-derive it, which is the failure the flat key exists to prevent.
    const root = instanceRoot('Root');
    const nested = node('Nested', root, { source: 'CHILD', localId: 1, nodeGuid: G(50), parentLocalId: 4, parentNodeGuid: G(4) });
    const piMeta = getTraitByName('PrefabInstance')!;
    for (const e of getCurrentWorld().entities) {
      if (e.id() === nested) e.set(piMeta.trait, { ...(e.get(piMeta.trait) as Record<string, unknown>), rootInstanceId: nested });
    }
    const inner = node('Inner', nested, { source: 'CHILD', localId: 2, nodeGuid: G(51), rootInstanceId: nested });
    node('Wanderer', inner, { localId: 7, nodeGuid: G(7), rootInstanceId: root });
    expect(keysByName(root)).toEqual({ Nested: `/${G(4)}`, Inner: `/${G(4)}/${G(51)}`, Wanderer: `/${G(7)}` });
  });

  it('gives a member of a pre-v5 template no row — it minted no identity', () => {
    const root = instanceRoot('Root');
    node('Old', root, { localId: 2, nodeGuid: '', rootInstanceId: root });
    node('New', root, { localId: 3, nodeGuid: G(80), rootInstanceId: root });
    // Absent, not present-and-empty: a row written under '' would collide with every sibling.
    expect(keysByName(root)).toEqual({ New: `/${G(80)}` });
  });

  it('follows an owned nested root`s OWNER link, so moving it inside its instance keeps its frame', () => {
    // #1468 design record R8, at the frame level: a move INSIDE an instance keeps the link, so the frame a
    // moved owned root belongs to is the one its ROW is in — not the one it now hangs under. Since
    // #1468 Phase 6 that is `PrefabInstance.ownerGuid` (its HOME parent's frame, before).
    // Reading the live parent instead is only wrong when the two are in different frames, which is
    // why the obvious fixture (moved beside a sibling) proves nothing: both answers agree there.
    const root = instanceRoot('Root');
    const HOME = 'aaaaaaaa-0000-4000-8000-00000000cafe';
    node('Home', root, { localId: 2, nodeGuid: G(2), rootInstanceId: root }, HOME);
    const nested1 = node('Nested1', root, { source: 'CHILD', localId: 1, nodeGuid: G(50), parentLocalId: 4, parentNodeGuid: G(4) });
    const piMeta = getTraitByName('PrefabInstance')!;
    const selfRoot = (id: number) => {
      for (const e of getCurrentWorld().entities) {
        if (e.id() === id) e.set(piMeta.trait, { ...(e.get(piMeta.trait) as Record<string, unknown>), rootInstanceId: id });
      }
    };
    selfRoot(nested1);
    const inner = node('Inner', nested1, { source: 'CHILD', localId: 2, nodeGuid: G(51), rootInstanceId: nested1 });
    // Nested2 is a row of the OUTER prefab, dragged under a member of the nested instance.
    const nested2 = node('Nested2', inner, { source: 'CHILD2', localId: 1, nodeGuid: G(60), parentLocalId: 6, parentNodeGuid: G(6), ownerGuid: G(999) });
    selfRoot(nested2);
    node('Deep', nested2, { source: 'CHILD2', localId: 2, nodeGuid: G(61), rootInstanceId: nested2 });
    expect(keysByName(root)).toEqual({
      Home: `/${G(2)}`,
      Nested1: `/${G(4)}`,
      Inner: `/${G(4)}/${G(51)}`,
      Nested2: `/${G(6)}`,                 // still a row of the OUTER frame, not of Nested1's
      Deep: `/${G(6)}/${G(61)}`,
    });
  });

  it('separates KEYED from "a row will be written" — a keyed member with no durable guid gets none', async () => {
    // ⚠️ Two predicates that have to agree, and did not. `memberRowKeysIn` answers "which key does
    // this member own" and cannot require a durable guid, because the LOAD side uses it to find the
    // members to PIN and every member's guid is still empty at that moment. The SAVE additionally
    // needs something to write. The two stampers skip a member on the strength of *a row existing
    // for it*, so they must ask the narrower question — skipping a keyed-but-unstorable member
    // reopens #1461's window for exactly the members neither mechanism covers.
    const { memberRowsToWrite } = await import('../../packages/modoki/src/runtime/core/ecs/memberRows');
    const root = instanceRoot('Root');
    const durable = node('Durable', root, { localId: 2, nodeGuid: G(2), rootInstanceId: root }, 'aaaaaaaa-0000-4000-8000-0000000000d1');
    const bare = node('Bare', root, { localId: 3, nodeGuid: G(3), rootInstanceId: root });   // guid ''
    expect([...memberRowKeysIn(root).keys()].sort()).toEqual([durable, bare].sort());
    expect([...memberRowsToWrite(root).keys()]).toEqual([durable]);
  });

  it('is unbothered by a parent cycle, because it does not walk the parent chain at all', () => {
    // ⚠️ **This test`s history is the finding, and the current walk makes it nearly vacuous — said
    // plainly rather than left as a claim of coverage.** It was written against an earlier,
    // ECS-DESCENT version of `memberRowKeysIn`, where a parent cycle really could recurse forever
    // and the stored-root line was what stopped it. The shipped walk iterates `world.entities` once
    // and takes a single identity-parent hop (the owner, since #1468 Phase 6), so no parent cycle can recurse and deleting any one
    // line leaves this green (measured, in the Phase 2B close-out review — the comment here claimed
    // otherwise until then).
    //
    // Kept because the SHAPE is still worth a regression test: a damaged parent chain must not make
    // the walk hang or throw, and every member must still be keyed by identity. The real cycle guard
    // is `chains.set(id, null)` on entry in `frameChain`, and that guards a FRAME cycle — a different
    // thing, where `null` is the correct answer for every member in it.
    // Root → A → B, and Root's own parent is B, so the parent chain loops.
    const root = instanceRoot('Root');
    const a = node('A', root, { localId: 2, nodeGuid: G(2), rootInstanceId: root });
    const b = node('B', a, { localId: 3, nodeGuid: G(3), rootInstanceId: root });
    const ea = getTraitByName('EntityAttributes')!;
    for (const e of getCurrentWorld().entities) {
      if (e.id() === root) e.set(ea.trait, { ...(e.get(ea.trait) as Record<string, unknown>), parentId: b });
    }
    expect(keysByName(root)).toEqual({ A: `/${G(2)}`, B: `/${G(3)}` });
  });
});
