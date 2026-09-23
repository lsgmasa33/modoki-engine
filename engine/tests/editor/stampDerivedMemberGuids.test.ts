/** #1461 — the contract of `stampDerivedMemberGuids` itself, at the level its two guards live at.
 *
 *  The round-trip cases (Create Prefab → save → reload) are in `createPrefabMemberIdentity.test.ts`.
 *  This file exists because one guard is invisible from there: a STORED root inside the tree must keep
 *  its guid, and building a depth-2 instance through the loader harness costs more fixture than it
 *  proves. Here the world is stated directly, so what the walk does and does not touch is the subject. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestWorld, type TestWorld, setPlayState, Transform, EntityAttributes, PrefabInstance,
  getCurrentWorld, UIAction,
} from '@modoki/engine/runtime';
import { stampDerivedMemberGuids } from '../../packages/modoki/src/runtime/core/ecs/memberHome';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const OUTER = 'eeeeeeee-0000-4000-8000-0000000000a1';
const INNER = 'eeeeeeee-0000-4000-8000-0000000000a2';

let game: TestWorld | undefined;
beforeEach(() => { game = createTestWorld({}); setPlayState('stopped'); });
afterEach(() => { game?.dispose(); game = undefined; });

const guidOf = (e: { get: (t: typeof EntityAttributes) => unknown }) =>
  (e.get(EntityAttributes) as { guid: string }).guid;

/** R (the instance root / anchor) ── A (a member) ── D (a STORED root: an instance of another prefab,
 *  which this one does not claim) ── L (D's own member, below the walk's floor). */
function tree() {
  const r = game!.spawn(Transform(), EntityAttributes({ name: 'R', guid: 'g-r' }));
  const a = game!.spawn(Transform(), EntityAttributes({ name: 'A', parentId: r.id(), guid: 'g-a' }));
  const d = game!.spawn(Transform(), EntityAttributes({ name: 'D', parentId: a.id(), guid: 'g-d' }));
  const l = game!.spawn(Transform(), EntityAttributes({ name: 'L', parentId: d.id(), guid: 'g-l' }));
  r.add(PrefabInstance({ source: OUTER, localId: 1, rootInstanceId: r.id() }));
  a.add(PrefabInstance({ source: OUTER, localId: 2, rootInstanceId: r.id() }));
  d.add(PrefabInstance({ source: INNER, localId: 1, rootInstanceId: d.id() })); // parentLocalId 0 → stored
  l.add(PrefabInstance({ source: INNER, localId: 2, rootInstanceId: d.id() }));
  return { r, a, d, l };
}

describe('stampDerivedMemberGuids (#1461)', () => {
  it('renames a member, and leaves the anchor, a stored root and that root\'s own members alone', () => {
    const { r, a, d, l } = tree();

    const remap = stampDerivedMemberGuids(r.id(), getCurrentWorld());

    expect(guidOf(a), 'a member takes the guid the reload derives').not.toBe('g-a');
    expect(remap.get('g-a')).toBe(guidOf(a));
    expect(guidOf(r), 'the anchor keeps its guid — everything derives FROM it').toBe('g-r');
    // Mutation: drop the `stored root keeps its stored guid` skip. D is an anchor in its own right and
    // ITS members (L) are below this walk's floor, so renaming D re-derives them on the next reload
    // while the live world still holds the old guids — #1349's shape.
    expect(guidOf(d), 'a stored root keeps its guid').toBe('g-d');
    expect(guidOf(l), "and its own members are not this walk's to touch").toBe('g-l');
    expect([...remap.keys()]).toEqual(['g-a']);
  });

  /** ⚠️ The input that distinguishes KEYED from "a row will be written" (#1468 Phase 2B).
   *
   *  The skip's premise is *"a stored row states this member's guid, so the reload will not derive
   *  one"*. A member can be keyed — its template minted a `nodeGuid` — and still get NO row, because
   *  `captureInstanceMembers` writes only a DURABLE guid: a runtime guid (#1210) is a per-session
   *  handle, not an identity to write down. Skipping such a member leaves it with a guid the reload
   *  will not reproduce and no row to state it, which is #1461's window reopened for exactly the
   *  members neither mechanism covers.
   *
   *  A guid-LESS member cannot show this — the stamp leaves one alone anyway (`old &&`) — so the
   *  fixture uses a runtime guid, which is truthy and not durable. Every other fixture in the suite
   *  gives its members durable guids, so this is the one place the two predicates disagree. */
  it('renames a keyed member whose guid is a RUNTIME guid — no row will state it', () => {
    const r = game!.spawn(Transform(), EntityAttributes({ name: 'R', guid: 'g-rt-r' }));
    // ⚠️ Spawned with NO guid, then read back — the engine assigns the entity its own runtime guid
    // (#1210), and passing one in is overwritten. A literal would have made the assertions below
    // compare against a value the entity never held.
    const m = game!.spawn(Transform(), EntityAttributes({ name: 'M', parentId: r.id() }));
    r.add(PrefabInstance({ source: OUTER, localId: 1, nodeGuid: 'aaaaaaaa-0000-4000-8000-0000000000f1', rootInstanceId: r.id() }));
    m.add(PrefabInstance({ source: OUTER, localId: 2, nodeGuid: 'aaaaaaaa-0000-4000-8000-0000000000f2', rootInstanceId: r.id() }));

    const RUNTIME = guidOf(m);
    expect(RUNTIME, 'fixture: the member must hold a RUNTIME guid, or the two predicates agree').toMatch(/^00000000-/);

    const remap = stampDerivedMemberGuids(r.id(), getCurrentWorld());

    expect(guidOf(m), 'a keyed member with no DURABLE guid still gets the derived one').not.toBe(RUNTIME);
    expect(remap.get(RUNTIME)).toBe(guidOf(m));
  });

  it('carries every ref onto the new guid', () => {
    const { r, a } = tree();
    const x = game!.spawn(Transform(), EntityAttributes({ name: 'X', guid: 'g-x' }),
      UIAction({ bindings: [{ event: 'click', kind: 'call' as const, action: 'noop', target: 'g-a' }] }));

    stampDerivedMemberGuids(r.id(), getCurrentWorld());

    expect(((x.get(UIAction) as { bindings: { target: string }[] }).bindings)[0].target).toBe(guidOf(a));
  });

  /** A RUNTIME guid (#1210) is not an anchor: it dies with its world, so members derived from it would
   *  reload as something else — this fix's own defect, one level up. Production never reaches here
   *  (both callers mint a durable guid before tagging), which is exactly why the floor is worth pinning:
   *  nothing else would fail if it went away. Mutation: drop the `durableGuid` call on the anchor. */
  it('refuses to derive from a runtime guid — that is not an anchor', () => {
    const r = game!.spawn(Transform(), EntityAttributes({ name: 'R' })); // spawn assigns a RUNTIME guid
    const a = game!.spawn(Transform(), EntityAttributes({ name: 'A', parentId: r.id(), guid: 'g-a' }));
    r.add(PrefabInstance({ source: OUTER, localId: 1, rootInstanceId: r.id() }));
    a.add(PrefabInstance({ source: OUTER, localId: 2, rootInstanceId: r.id() }));

    expect(guidOf(r)).toMatch(/^00000000-0000-/); // the runtime shape, as spawn leaves it
    expect(stampDerivedMemberGuids(r.id(), getCurrentWorld()).size).toBe(0);
    expect(guidOf(a)).toBe('g-a');
  });
});
