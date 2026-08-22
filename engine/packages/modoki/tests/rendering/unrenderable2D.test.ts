/** findUnrenderable2D — which 2D entities in a subtree route to no Canvas2D (QA-ASSET-0014).
 *
 *  Scene2D skips a Renderable2D with no Canvas2D ancestor and says nothing, so a 2D prefab
 *  instantiated at the world root (modoki_prefab's own default parent) came back ok:true and
 *  then reported screen:null / onScreen:false, with no error, warning, or hint anywhere.
 *  Measured on games/skin-test: moving it well inside the design resolution changed nothing;
 *  reparenting it under the Canvas2D host fixed it instantly. */

import { describe, it, expect, vi } from 'vitest';
import { findUnrenderable2D, Orphan2DTracker } from '../../src/runtime/rendering/canvas2DRouting';

type E = { id: number; name: string; parentId: number; traits: string[] };

const canvas = (id: number, parentId = 0): E => ({ id, name: '2D Canvas', parentId, traits: ['Canvas2D'] });
const sprite = (id: number, parentId: number, name = 'Bar'): E => ({ id, name, parentId, traits: ['Transform', 'Renderable2D'] });
const plain = (id: number, parentId: number, name = 'Group'): E => ({ id, name, parentId, traits: ['Transform'] });

describe('findUnrenderable2D', () => {
  it('flags a 2D entity spawned at the world root — the reported failure', () => {
    const world = [canvas(1), sprite(2, 0)];
    expect(findUnrenderable2D(world, 2)).toEqual([{ id: 2, name: 'Bar' }]);
  });

  it('says nothing when the entity is under the Canvas2D host', () => {
    const world = [canvas(1), sprite(2, 1)];
    expect(findUnrenderable2D(world, 2)).toEqual([]);
  });

  it('resolves through an intermediate non-canvas parent', () => {
    const world = [canvas(1), plain(2, 1), sprite(3, 2)];
    expect(findUnrenderable2D(world, 2)).toEqual([]);
  });

  it('reports the 2D DESCENDANTS of a root that is not itself 2D', () => {
    // The common prefab shape: a plain container root with 2D children under it.
    const world = [canvas(1), plain(9, 0, 'Rig'), sprite(10, 9, 'Bar'), sprite(11, 9, 'Baz')];
    expect(findUnrenderable2D(world, 9)).toEqual([
      { id: 10, name: 'Bar' }, { id: 11, name: 'Baz' },
    ]);
  });

  it('is scoped to the subtree — another orphan elsewhere is not this call\'s business', () => {
    const world = [canvas(1), sprite(2, 0, 'Mine'), sprite(3, 0, 'Someone else\'s')];
    expect(findUnrenderable2D(world, 2)).toEqual([{ id: 2, name: 'Mine' }]);
  });

  it('ignores non-2D entities in the subtree', () => {
    const world = [canvas(1), { id: 5, name: 'Cube', parentId: 0, traits: ['Transform', 'Renderable3D'] }];
    expect(findUnrenderable2D(world, 5)).toEqual([]);
  });

  it('treats a scene with NO Canvas2D at all as unrenderable, not as "fine"', () => {
    expect(findUnrenderable2D([sprite(2, 0)], 2)).toEqual([{ id: 2, name: 'Bar' }]);
  });

  it('covers SkinnedSprite2D and Text2D, not just Renderable2D', () => {
    // The reported entity was a SkinnedSprite2D and carries NO Renderable2D — keying the check
    // on that one trait made the whole report unreachable. Scene2D routes three passes through
    // a canvas, so all three count.
    const world: E[] = [
      canvas(1),
      { id: 2, name: 'Bar', parentId: 0, traits: ['Transform', 'SkinnedSprite2D'] },
      { id: 3, name: 'Score', parentId: 0, traits: ['Transform', 'Text2D'] },
    ];
    expect(findUnrenderable2D(world, 2)).toEqual([{ id: 2, name: 'Bar' }]);
    expect(findUnrenderable2D(world, 3)).toEqual([{ id: 3, name: 'Score' }]);
  });

  it('does not flag a 2D rig promoted into the 3D scene by a Billboard3D/FlatSprite3D', () => {
    // Scene2D's skinned pass skips these deliberately: they render through Three.js and need
    // no Canvas2D ancestor, so warning about them would be a false alarm on working content.
    const billboard: E = { id: 2, name: 'Rig', parentId: 0, traits: ['SkinnedSprite2D', 'Billboard3D'] };
    const flat: E = { id: 3, name: 'Shadow', parentId: 0, traits: ['SkinnedSprite2D', 'FlatSprite3D'] };
    expect(findUnrenderable2D([billboard, flat], 2)).toEqual([]);
    expect(findUnrenderable2D([billboard, flat], 3)).toEqual([]);
  });

  it('terminates on a malformed cyclic parent chain instead of hanging', () => {
    const world: E[] = [
      { id: 2, name: 'A', parentId: 3, traits: ['Renderable2D'] },
      { id: 3, name: 'B', parentId: 2, traits: [] },
    ];
    expect(findUnrenderable2D(world, 2)).toEqual([{ id: 2, name: 'A' }]);
  });
});

describe('Orphan2DTracker — warn once, but FORGET a recovery', () => {
  const KEY = 'guid-abc';

  it('reports the key exactly once, on the frame the count reaches the threshold', () => {
    const t = new Orphan2DTracker();
    expect(t.note(7, () => KEY, 2)).toBeNull();   // frame 1 — inside the grace window
    expect(t.note(7, () => KEY, 2)).toBe(KEY);    // frame 2 — report
    expect(t.note(7, () => KEY, 2)).toBeNull();   // frame 3+ — never again
    expect(t.note(7, () => KEY, 2)).toBeNull();
  });

  it('warns AGAIN after the entity recovers and breaks a second time', () => {
    // The gap this class exists to close: nothing dropped the warned key when an entity found a
    // canvas, so parenting an orphan under the host and back out again was silent the second
    // time — and the second time is the one nobody is watching for.
    const t = new Orphan2DTracker();
    expect(t.note(7, () => KEY, 1)).toBe(KEY);
    t.clear(7, () => KEY);                        // parented under the Canvas2D host
    expect(t.note(7, () => KEY, 1)).toBe(KEY);    // parented back out → warns again
  });

  it('stays silent for a re-orphaning that was never cleared', () => {
    const t = new Orphan2DTracker();
    expect(t.note(7, () => KEY, 1)).toBe(KEY);
    expect(t.note(7, () => KEY, 1)).toBeNull();   // still orphaned — not a new event
  });

  it('keeps the key lookup OFF the hot path — no call for an entity that never orphaned', () => {
    // This is the whole reason `key` is a callback: `clear()` runs for every drawn 2D entity
    // every frame, and the key comes from a trait read. A value parameter here would make a
    // healthy scene pay that read per entity per frame.
    const t = new Orphan2DTracker();
    const key = vi.fn(() => KEY);
    t.clear(1, key); t.clear(2, key); t.clear(3, key);
    expect(key).not.toHaveBeenCalled();

    t.note(7, () => KEY, 1);                      // 7 is now counted
    t.clear(9, key);                              // a DIFFERENT entity → still no lookup
    expect(key).not.toHaveBeenCalled();
    t.clear(7, key);                              // the orphan itself → exactly one lookup
    expect(key).toHaveBeenCalledTimes(1);
  });

  it('reset() forgets counts and keys alike', () => {
    const t = new Orphan2DTracker();
    expect(t.note(7, () => KEY, 1)).toBe(KEY);
    t.reset();
    expect(t.note(7, () => KEY, 1)).toBe(KEY);
  });
});
