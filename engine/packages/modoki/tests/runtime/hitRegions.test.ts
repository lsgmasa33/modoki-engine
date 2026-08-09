/** Hit-region provider registry (#139).
 *
 *  The honesty rule this surface lives or dies by: **"no provider registered" and "the provider
 *  reported no regions" must never look alike.** They produce the same empty array, and collapsing
 *  them would let an overlay assert "there is nothing to hit here" about a game that simply never
 *  published its geometry — which is the exact substitution `pointerRecorder`'s three-way
 *  `resolved` was built to prevent, in the surface built to explain it. So the registry reports
 *  its provider NAMES, not just its output. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerHitRegionProvider, collectHitRegions, hitRegionProviders,
  isHitRegionOverlayVisible, setHitRegionOverlayVisible, subscribeHitRegionOverlay,
  hitShapeContains, hitShapeDistance, nearestRegionTo,
  __resetHitRegionsForTests, type HitRegion, type HitShape,
} from '../../src/runtime/rendering/hitRegions';

const circle = (id: string, x: number, y: number, r: number, over?: Partial<HitRegion>): HitRegion => ({
  id, kind: 'test', provider: 'p', shape: { type: 'circle', x, y, r }, ...over,
});

beforeEach(() => {
  __resetHitRegionsForTests();
});

describe('registration', () => {
  it('collects from every provider and reports who is registered', () => {
    registerHitRegionProvider('a', () => [circle('a:0', 10, 10, 5)]);
    registerHitRegionProvider('b', () => [circle('b:0', 20, 20, 5)]);
    expect(hitRegionProviders().sort()).toEqual(['a', 'b']);
    expect(collectHitRegions().map((r) => r.id).sort()).toEqual(['a:0', 'b:0']);
  });

  it('distinguishes "no provider" from "provider reported nothing"', () => {
    // The load-bearing assertion of the module. Both cases return [], so the ONLY thing that can
    // tell them apart is the provider list — and a consumer that reads the list can then say
    // "nobody could answer" instead of "there is nothing there".
    expect(collectHitRegions()).toEqual([]);
    expect(hitRegionProviders()).toEqual([]);
    registerHitRegionProvider('court', () => []);
    expect(collectHitRegions()).toEqual([]);
    expect(hitRegionProviders()).toEqual(['court']);
  });

  it('unregisters, and a stale unregister does not remove a replacement', () => {
    const off = registerHitRegionProvider('a', () => [circle('a:0', 0, 0, 1)]);
    registerHitRegionProvider('a', () => [circle('a:1', 0, 0, 1)]);   // Fast Refresh re-register
    off();  // the OLD closure's unregister — must be a no-op now
    expect(collectHitRegions().map((r) => r.id)).toEqual(['a:1']);
  });

  it('REPLACES a provider re-registered under the same name rather than doubling it', () => {
    // The `[]`-deps Fast-Refresh hazard from docs/editor-hmr.md. Keyed by identity instead of by
    // name, an edit would leave the stale closure registered and every region would appear twice.
    registerHitRegionProvider('court', () => [circle('court:0', 1, 1, 1)]);
    registerHitRegionProvider('court', () => [circle('court:0', 2, 2, 2)]);
    const out = collectHitRegions();
    expect(out).toHaveLength(1);
    expect(out[0].shape).toEqual({ type: 'circle', x: 2, y: 2, r: 2 });
  });

  it('skips a provider that throws instead of losing every other provider', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerHitRegionProvider('bad', () => { throw new Error('boom'); });
    registerHitRegionProvider('good', () => [circle('good:0', 0, 0, 1)]);
    expect(collectHitRegions().map((r) => r.id)).toEqual(['good:0']);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('drops a duplicate id and warns once, rather than drawing two shapes for one control', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerHitRegionProvider('a', () => [circle('dup', 0, 0, 1)]);
    registerHitRegionProvider('b', () => [circle('dup', 9, 9, 9)]);
    expect(collectHitRegions()).toHaveLength(1);
    collectHitRegions();
    collectHitRegions();
    expect(warn).toHaveBeenCalledTimes(1);   // once per id, not once per poll
    warn.mockRestore();
  });
});

describe('ordering and filtering', () => {
  it('sorts by hit-test precedence, so overlapping regions draw in the order they are checked', () => {
    // Court's (i) badge deliberately overlaps the tray badge beneath it and is checked FIRST.
    // Arbitrary order would make a designed overlap read as a bug.
    registerHitRegionProvider('a', () => [
      circle('tray', 0, 0, 10, { order: 1 }),
      circle('info', 0, 0, 4, { order: 0 }),
      circle('cell', 0, 0, 20),   // no order — sorts last
    ]);
    expect(collectHitRegions().map((r) => r.id)).toEqual(['info', 'tray', 'cell']);
  });

  it('filters by provider, kind and ids', () => {
    registerHitRegionProvider('a', () => [circle('a:0', 0, 0, 1), circle('a:1', 0, 0, 1, { kind: 'other' })]);
    registerHitRegionProvider('b', () => [circle('b:0', 0, 0, 1)]);
    expect(collectHitRegions({ provider: 'a' }).map((r) => r.id)).toEqual(['a:0', 'a:1']);
    expect(collectHitRegions({ kind: 'other' }).map((r) => r.id)).toEqual(['a:1']);
    expect(collectHitRegions({ ids: ['b:0'] }).map((r) => r.id)).toEqual(['b:0']);
  });
});

describe('a provider that returns malformed DATA (close-out review)', () => {
  // Guarding only the `fn()` call covers a provider that THROWS and misses one that returns bad
  // data — and reading `.kind` off an undefined element then threw from OUTSIDE the try, taking
  // down the overlay render and every other provider's regions with it. The exact opposite of the
  // isolation this function advertises.
  it('survives an undefined element and keeps the other providers', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerHitRegionProvider('bad', () => [circle('bad:0', 0, 0, 1), undefined as unknown as HitRegion]);
    registerHitRegionProvider('good', () => [circle('good:0', 5, 5, 1)]);
    const out = collectHitRegions();
    expect(out.map((r) => r.id).sort()).toEqual(['bad:0', 'good:0']);
    err.mockRestore();
  });

  it('skips ONLY the malformed element, not the rest of that provider\'s regions', () => {
    // The assertion above passes with the per-element guard removed — the try around the loop
    // already stops the throw escaping, it just abandons everything after the bad element. Putting
    // the hole in the MIDDLE is what distinguishes "contained the blast" from "skipped one entry".
    // (Found by mutation-testing the previous test, which did not fail without the guard.)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerHitRegionProvider('bad', () => [
      circle('bad:0', 0, 0, 1),
      undefined as unknown as HitRegion,
      circle('bad:2', 9, 9, 1),          // must still arrive
    ]);
    expect(collectHitRegions().map((r) => r.id).sort()).toEqual(['bad:0', 'bad:2']);
    err.mockRestore();
  });

  it('survives a provider that returns a non-array', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerHitRegionProvider('bad', () => ({}) as unknown as HitRegion[]);
    registerHitRegionProvider('good', () => [circle('good:0', 5, 5, 1)]);
    expect(collectHitRegions().map((r) => r.id)).toEqual(['good:0']);
    err.mockRestore();
  });
});

describe('provider identity has ONE source', () => {
  it('stamps `provider` from the registry key, so the filter and the field cannot disagree', () => {
    // Two sources for one fact: the key `collectHitRegions` filters on, and the field the caller
    // reads back. A game registered under one name stamping another made {provider:'court'}
    // return nothing while every returned region said 'court'.
    registerHitRegionProvider('court', () => [
      { id: 'x', kind: 'cell', provider: 'something-else', shape: { type: 'circle', x: 0, y: 0, r: 1 } },
    ]);
    const out = collectHitRegions();
    expect(out[0].provider).toBe('court');
    expect(collectHitRegions({ provider: 'court' })).toHaveLength(1);
  });
});

describe('shape geometry — one implementation, shared by the overlay and the op', () => {
  it('measures a poly by point-to-SEGMENT, not point-to-vertex', () => {
    // The defect this replaces did not merely round badly, it picked the WRONG REGION. A lane
    // with a press 5px below its top edge: nearest vertex is ~500px, nearest edge is 5px.
    const lane: HitShape = {
      type: 'poly',
      points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 10 }, { x: 0, y: 10 }],
    };
    expect(hitShapeDistance(lane, 500, 15)).toBeCloseTo(5, 6);
  });

  it('picks the genuinely nearest region, not the one with the nearest corner', () => {
    const lane: HitRegion = {
      id: 'lane', kind: 'lane', provider: 'p',
      shape: { type: 'poly', points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 10 }, { x: 0, y: 10 }] },
    };
    const far: HitRegion = { id: 'far', kind: 'dot', provider: 'p', shape: { type: 'circle', x: 500, y: 100, r: 10 } };
    // Vertex distance would score the lane at ~500 and hand this to `far` (75px).
    const near = nearestRegionTo([lane, far], 500, 15)!;
    expect(near.region.id).toBe('lane');
    expect(near.distance).toBeCloseTo(5, 6);
  });

  it('reports 0 distance inside every shape kind', () => {
    expect(hitShapeDistance({ type: 'circle', x: 0, y: 0, r: 10 }, 3, 3)).toBe(0);
    expect(hitShapeDistance({ type: 'rect', x: 0, y: 0, w: 10, h: 10 }, 1, 1)).toBe(0);
    const tri: HitShape = { type: 'poly', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }] };
    expect(hitShapeDistance(tri, 1, 1)).toBe(0);
  });

  it('returns null for a poly with no geometry rather than a number that could win', () => {
    expect(hitShapeDistance({ type: 'poly', points: [] }, 0, 0)).toBeNull();
    // …and such a region is skipped by nearestRegionTo rather than selected by landing first.
    const empty: HitRegion = { id: 'empty', kind: 'k', provider: 'p', shape: { type: 'poly', points: [] } };
    const real: HitRegion = { id: 'real', kind: 'k', provider: 'p', shape: { type: 'circle', x: 100, y: 0, r: 1 } };
    expect(nearestRegionTo([empty, real], 0, 0)!.region.id).toBe('real');
  });

  it('skips a NaN-coordinate region instead of letting it win by landing first', () => {
    const bad: HitRegion = { id: 'bad', kind: 'k', provider: 'p', shape: { type: 'circle', x: NaN, y: 0, r: 1 } };
    const real: HitRegion = { id: 'real', kind: 'k', provider: 'p', shape: { type: 'circle', x: 100, y: 0, r: 1 } };
    expect(nearestRegionTo([bad, real], 0, 0)!.region.id).toBe('real');
  });

  it('treats a rect x/y as its CENTRE with w/h the full extent', () => {
    const r: HitShape = { type: 'rect', x: 100, y: 100, w: 20, h: 10 };
    expect(hitShapeContains(r, 100, 100)).toBe(true);
    expect(hitShapeContains(r, 110, 105)).toBe(true);    // exactly on the corner — inside
    expect(hitShapeContains(r, 111, 100)).toBe(false);
    expect(hitShapeDistance(r, 115, 100)).toBeCloseTo(5, 6);
  });
});

describe('overlay toggle', () => {
  it('starts hidden and notifies subscribers on a real change only', () => {
    const fn = vi.fn();
    subscribeHitRegionOverlay(fn);
    expect(isHitRegionOverlayVisible()).toBe(false);
    setHitRegionOverlayVisible(true);
    expect(isHitRegionOverlayVisible()).toBe(true);
    setHitRegionOverlayVisible(true);   // no change — no notification
    expect(fn).toHaveBeenCalledTimes(1);
    setHitRegionOverlayVisible(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a throwing subscriber does not stop the others', () => {
    const good = vi.fn();
    subscribeHitRegionOverlay(() => { throw new Error('boom'); });
    subscribeHitRegionOverlay(good);
    setHitRegionOverlayVisible(true);
    expect(good).toHaveBeenCalled();
  });
});
