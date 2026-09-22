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
