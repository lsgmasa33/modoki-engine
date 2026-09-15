/** Hierarchy collapse follows its entity inside a world (#1221, #1222 phase 2).
 *
 *  The collapsed set is a `Set<number>` of koota ids; a collapsed parent that a system destroys and
 *  replaces on the same index (a board rebuilt during Play) used to show the NEWCOMER collapsed.
 *  `holdCollapsed` keeps holds (and parks gone entities that have a durable guid) whenever the set
 *  changes; `reconcileCollapsed` re-resolves them before the tree rebuild. Each case names the
 *  mutation that turns it red. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { createTestWorld, type TestWorld } from '../../packages/modoki/src/runtime/harness/createTestWorld';
import { Transform } from '../../packages/modoki/src/runtime/core/traits/Transform';
import { EntityAttributes } from '../../packages/modoki/src/runtime/core/traits/EntityAttributes';
import { destroyEntity, spawnEntity } from '../../packages/modoki/src/runtime/core/ecs/world';
import {
  holdCollapsed, reconcileCollapsed, persistableCollapsedGuids, NO_COLLAPSE_HOLDS, type CollapseHolds,
} from '../../packages/modoki/src/editor/panels/hierarchyCollapse';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const G = 'e1221000-0000-4000-8000-0000000000c1';
const H = 'e1221000-0000-4000-8000-0000000000c2';

let tw: TestWorld | undefined;
afterEach(() => { tw?.dispose(); tw = undefined; });

/** The panel's loop: reconcile (the settled refresh), then re-hold for the new set (the effect). */
function refresh(collapsed: Set<number>, holds: CollapseHolds, world = tw!.world): { collapsed: Set<number>; holds: CollapseHolds } {
  const next = reconcileCollapsed(collapsed, holds, world) ?? collapsed;
  return { collapsed: next, holds: next === collapsed ? holds : holdCollapsed(next, holds, world) };
}

describe('collapse holds (#1221)', () => {
  // Mutation: `reconcileCollapsed` keeping an unresolved id (`else next.add(id)`).
  it('a collapsed node replaced on its index leaves the set; its untouched sibling stays', () => {
    tw = createTestWorld({});
    const board = tw.spawn(Transform(), EntityAttributes({ name: 'Board' }));
    const tray = tw.spawn(Transform(), EntityAttributes({ name: 'Tray' }));
    const collapsed = new Set([board.id(), tray.id()]);
    const holds = holdCollapsed(collapsed, NO_COLLAPSE_HOLDS, tw.world);
    destroyEntity(board);
    const rebuilt = tw.spawn(Transform(), EntityAttributes({ name: 'Board' }));
    expect(rebuilt.id()).toBe(board.id()); // precondition: the index was reclaimed
    expect([...reconcileCollapsed(collapsed, holds, tw.world)!]).toEqual([tray.id()]);
  });

  // Mutation: `resolveHeld` not following a guid.
  it('a replacement carrying the collapsed node\'s guid stays collapsed', () => {
    tw = createTestWorld({});
    tw.spawn(Transform(), EntityAttributes({ name: 'Filler' }));
    const a = tw.spawn(Transform(), EntityAttributes({ name: 'Group', guid: G }));
    const collapsed = new Set([a.id()]);
    const holds = holdCollapsed(collapsed, NO_COLLAPSE_HOLDS, tw.world);
    destroyEntity(a);
    tw.spawn(Transform(), EntityAttributes({ name: 'Squatter' })); // takes a's index
    const b = tw.spawn(Transform(), EntityAttributes({ name: 'Group', guid: G }));
    expect(b.id()).not.toBe(a.id());
    expect([...reconcileCollapsed(collapsed, holds, tw.world)!]).toEqual([b.id()]);
  });

  // The live check's defect: React runs the panel's updater twice. Mutation: make reconcile consume
  // its holds (e.g. delete from `holds.held`).
  it('is pure: a second call on the same inputs returns the same set', () => {
    tw = createTestWorld({});
    const a = tw.spawn(Transform(), EntityAttributes({ name: 'A' }));
    const collapsed = new Set([a.id()]);
    const holds = holdCollapsed(collapsed, NO_COLLAPSE_HOLDS, tw.world);
    destroyEntity(a);
    tw.spawn(Transform(), EntityAttributes({ name: 'Newcomer' }));
    expect([...reconcileCollapsed(collapsed, holds, tw.world)!]).toEqual([]);
    expect([...reconcileCollapsed(collapsed, holds, tw.world)!]).toEqual([]);
  });

  it('nothing moved → null (the panel skips the state write)', () => {
    tw = createTestWorld({});
    const a = tw.spawn(Transform(), EntityAttributes({ name: 'A' }));
    const collapsed = new Set([a.id()]);
    const holds = holdCollapsed(collapsed, NO_COLLAPSE_HOLDS, tw.world);
    tw.spawn(Transform(), EntityAttributes({ name: 'Unrelated' }));
    expect(reconcileCollapsed(collapsed, holds, tw.world)).toBeNull();
  });

  // Review finding 2. Mutation: `holdCollapsed` keeping `prior` without the packed check.
  it('a follow that lands on another collapsed entity\'s old index stays collapsed through later refreshes', () => {
    tw = createTestWorld({});
    const a = tw.spawn(Transform(), EntityAttributes({ name: 'A', guid: G }));
    const b = tw.spawn(Transform(), EntityAttributes({ name: 'B' }));
    let state = { collapsed: new Set([a.id(), b.id()]), holds: holdCollapsed(new Set([a.id(), b.id()]), NO_COLLAPSE_HOLDS, tw.world) };
    destroyEntity(a);
    destroyEntity(b); // b's index is now on top of the free list
    const a2 = tw.spawn(Transform(), EntityAttributes({ name: 'A', guid: G }));
    expect(a2.id()).toBe(b.id()); // precondition: the follow lands on B's old index
    state = refresh(state.collapsed, state.holds);
    expect([...state.collapsed]).toEqual([a2.id()]);
    tw.spawn(Transform(), EntityAttributes({ name: 'Unrelated' }));
    // Settled: nothing moves. Without the packed check the stale hold drops the id and parking puts it
    // straight back — the set LOOKS right while every refresh rewrites the panel state and re-saves.
    expect(reconcileCollapsed(state.collapsed, state.holds, tw.world)).toBeNull();
    state = refresh(state.collapsed, state.holds);
    expect([...state.collapsed]).toEqual([a2.id()]);
  });

  // Review finding 4. Mutations: drop the parking in `holdCollapsed`; drop the parked loop in
  // `reconcileCollapsed`.
  it('a collapsed entity deleted and later respawned with its guid (an undo) comes back collapsed', () => {
    tw = createTestWorld({});
    const a = tw.spawn(Transform(), EntityAttributes({ name: 'A', guid: G }));
    let state = { collapsed: new Set([a.id()]), holds: holdCollapsed(new Set([a.id()]), NO_COLLAPSE_HOLDS, tw.world) };
    destroyEntity(a);
    state = refresh(state.collapsed, state.holds);
    expect([...state.collapsed]).toEqual([]);
    expect(state.holds.parked.map((h) => h.guid)).toEqual([G]);
    tw.spawn(Transform(), EntityAttributes({ name: 'Later' }));
    state = refresh(state.collapsed, state.holds); // an unrelated refresh keeps it parked
    const back = tw.spawn(Transform(), EntityAttributes({ name: 'A', guid: G }));
    state = refresh(state.collapsed, state.holds);
    expect([...state.collapsed]).toEqual([back.id()]);
    expect(state.holds.parked).toEqual([]);
  });

  it('expanding a live node forgets it; it is not parked', () => {
    tw = createTestWorld({});
    const a = tw.spawn(Transform(), EntityAttributes({ name: 'A', guid: G }));
    const holds = holdCollapsed(new Set([a.id()]), NO_COLLAPSE_HOLDS, tw.world);
    const after = holdCollapsed(new Set(), holds, tw.world);
    expect(after.parked).toEqual([]);
  });

  // Review finding 4, the persistence half. Mutation: `persistableCollapsedGuids` ignoring parked.
  it('a parked durable guid is still persisted, so Stop restores it collapsed; a runtime guid is not parked', () => {
    tw = createTestWorld({});
    const a = tw.spawn(Transform(), EntityAttributes({ name: 'A', guid: G }));
    const live = tw.spawn(Transform(), EntityAttributes({ name: 'Live', guid: H }));
    const shot = tw.spawn(Transform(), EntityAttributes({ name: 'Shot' })); // runtime guid
    let state = { collapsed: new Set([a.id(), live.id(), shot.id()]), holds: holdCollapsed(new Set([a.id(), live.id(), shot.id()]), NO_COLLAPSE_HOLDS, tw.world) };
    destroyEntity(a);
    destroyEntity(shot);
    state = refresh(state.collapsed, state.holds);
    expect(state.holds.parked.map((h) => h.guid)).toEqual([G]);
    const flat = [{ id: live.id(), parentId: 0, guid: H }];
    expect(persistableCollapsedGuids(flat, state.collapsed, state.holds).sort()).toEqual([G, H].sort());
  });

  it('a hold from another world is re-taken for the same number, not kept', () => {
    tw = createTestWorld({});
    const other = createWorld();
    try {
      const old = spawnEntity(other, Transform(), EntityAttributes({ name: 'Old' }));
      const stale = holdCollapsed(new Set([old.id()]), NO_COLLAPSE_HOLDS, other);
      const fresh = tw.spawn(Transform(), EntityAttributes({ name: 'Fresh' }));
      const id = fresh.id();
      const staleForId: CollapseHolds = { held: new Map([[id, stale.held.get(old.id())!]]), parked: [] };
      const holds = holdCollapsed(new Set([id]), staleForId, tw.world);
      expect(holds.held.get(id)!.world).toBe(tw.world);
      expect(holds.held.get(id)!.packed).toBe(fresh.valueOf());
    } finally {
      other.destroy();
    }
  });
});
