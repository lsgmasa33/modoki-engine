/** SpriteEditor's pure slicing/handle helpers (#105 Phase 4).
 *
 *  Already pure and at module scope, merely unexported — so exports plus a test
 *  file, no refactor. These decide where a drag-created slice LANDS and how a
 *  resize handle behaves, and a mistake in them produces an off-by-one sprite
 *  rect: invisible in the editor, visible as a one-pixel seam in the shipped game. */

import { describe, it, expect } from 'vitest';
import {
  baseName, clamp, rectFromPoints, roundRect, handlePos, opposite, upsertPreview,
  type Handle,
} from '../../src/editor/panels/SpriteEditor';
import type { SpriteRect, SpriteSlice } from '../../src/runtime/loaders/spriteSheet';

const R = (x: number, y: number, w: number, h: number): SpriteRect => ({ x, y, w, h });

describe('baseName — deriving a slice name from a file name', () => {
  it('drops the extension and lowercases', () => {
    expect(baseName('Hero.PNG')).toBe('hero');
  });

  it('drops only the LAST extension segment', () => {
    expect(baseName('hero.sheet.png')).toBe('hero.sheet');
  });

  it('replaces whitespace runs with a single underscore', () => {
    expect(baseName('my   hero.png')).toBe('my_hero');
  });

  it('falls back to "sprite" rather than producing an empty name', () => {
    // An empty name would make every generated slice collide on the empty string.
    expect(baseName('.png')).toBe('sprite');
    expect(baseName('')).toBe('sprite');
  });

  it('leaves an extensionless name alone', () => {
    expect(baseName('hero')).toBe('hero');
  });
});

describe('clamp', () => {
  it('bounds on both sides and passes through in range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('honours the HIGH bound when the range is inverted', () => {
    // Math.max(lo, Math.min(v, hi)) — documents which wins, rather than assuming.
    expect(clamp(5, 10, 0)).toBe(10);
  });
});

describe('rectFromPoints — a drag becomes a rect', () => {
  it('normalizes a top-left to bottom-right drag', () => {
    expect(rectFromPoints(10, 20, 30, 50)).toEqual(R(10, 20, 20, 30));
  });

  it('gives the SAME rect when dragged from the opposite corner', () => {
    // Users drag in all four directions; a negative-extent rect would slice nothing.
    expect(rectFromPoints(30, 50, 10, 20)).toEqual(R(10, 20, 20, 30));
    expect(rectFromPoints(30, 20, 10, 50)).toEqual(R(10, 20, 20, 30));
  });

  it('yields a zero-extent rect for a click without travel', () => {
    expect(rectFromPoints(7, 7, 7, 7)).toEqual(R(7, 7, 0, 0));
  });
});

describe('roundRect — snapping a slice to whole pixels', () => {
  it('rounds position and size to integers', () => {
    expect(roundRect({ x: 1.4, y: 2.6, w: 10.5, h: 20.4 })).toEqual(R(1, 3, 11, 20));
  });

  it('never produces a ZERO-size slice', () => {
    // A 0x0 rect is an invisible, unselectable sprite — the min-1 guard is what
    // makes a tiny drag still yield something the user can see and adjust.
    expect(roundRect({ x: 0, y: 0, w: 0, h: 0 })).toEqual(R(0, 0, 1, 1));
    expect(roundRect({ x: 0, y: 0, w: 0.2, h: 0.4 })).toEqual(R(0, 0, 1, 1));
  });

  it('keeps a negative origin (a slice may start off-canvas)', () => {
    expect(roundRect({ x: -3.5, y: -2.4, w: 5, h: 5 })).toMatchObject({ y: -2 });
  });
});

describe('handlePos — where each resize handle sits', () => {
  const r = R(10, 20, 100, 60);

  it('places the four corners', () => {
    expect(handlePos(r, 'nw')).toEqual({ x: 10, y: 20 });
    expect(handlePos(r, 'ne')).toEqual({ x: 110, y: 20 });
    expect(handlePos(r, 'sw')).toEqual({ x: 10, y: 80 });
    expect(handlePos(r, 'se')).toEqual({ x: 110, y: 80 });
  });

  it('places the four edge midpoints', () => {
    expect(handlePos(r, 'n')).toEqual({ x: 60, y: 20 });
    expect(handlePos(r, 's')).toEqual({ x: 60, y: 80 });
    expect(handlePos(r, 'w')).toEqual({ x: 10, y: 50 });
    expect(handlePos(r, 'e')).toEqual({ x: 110, y: 50 });
  });

  it('collapses every handle onto the same point for a zero-size rect', () => {
    const z = R(5, 5, 0, 0);
    const all: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    for (const h of all) expect(handlePos(z, h)).toEqual({ x: 5, y: 5 });
  });
});

describe('opposite — the anchor a resize drags against', () => {
  it('maps every handle to its diagonal or facing partner', () => {
    const pairs: [Handle, Handle][] = [['nw', 'se'], ['n', 's'], ['ne', 'sw'], ['e', 'w']];
    for (const [a, b] of pairs) {
      expect(opposite(a)).toBe(b);
      expect(opposite(b)).toBe(a);
    }
  });

  it('is an involution for every handle — opposite(opposite(h)) === h', () => {
    // If this ever failed, resizing from one handle would anchor against the wrong
    // corner and the rect would drift across the texture.
    const all: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    for (const h of all) expect(opposite(opposite(h))).toBe(h);
  });

  it('never maps a handle to itself', () => {
    const all: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    for (const h of all) expect(opposite(h)).not.toBe(h);
  });
});

describe('upsertPreview — the live in-progress slice', () => {
  const existing: SpriteSlice[] = [
    { guid: 'a', name: 'one', rect: R(0, 0, 4, 4), pivot: { x: 0.5, y: 0.5 } },
    { guid: 'b', name: 'two', rect: R(4, 0, 4, 4), pivot: { x: 0.5, y: 0.5 } },
  ] as SpriteSlice[];

  it('appends a new preview without disturbing existing slices', () => {
    const out = upsertPreview(existing, 'c', R(8, 0, 4, 4));
    expect(out).toHaveLength(3);
    expect(out.slice(0, 2).map((s) => s.guid)).toEqual(['a', 'b']);
  });

  it('REPLACES the preview for a guid rather than accumulating one per frame', () => {
    // This runs on every pointermove of a drag. Appending instead of replacing
    // would add hundreds of stale slices in a single gesture.
    let out = upsertPreview(existing, 'c', R(8, 0, 4, 4));
    out = upsertPreview(out, 'c', R(8, 0, 9, 9));
    expect(out).toHaveLength(3);
    expect(out[out.length - 1].rect).toEqual(R(8, 0, 9, 9));
  });

  it('moves the replaced preview to the END, so it draws on top', () => {
    const out = upsertPreview(existing, 'a', R(1, 1, 2, 2));
    expect(out.map((s) => s.guid)).toEqual(['b', 'a']);
  });

  it('rounds the preview rect to whole pixels, like a committed slice', () => {
    const out = upsertPreview([], 'c', { x: 1.6, y: 1.2, w: 3.7, h: 0.1 });
    expect(out[0].rect).toEqual(R(2, 1, 4, 1));
  });

  it('does not mutate the input array', () => {
    const before = [...existing];
    upsertPreview(existing, 'c', R(0, 0, 1, 1));
    expect(existing).toEqual(before);
  });

  it('gives the preview its own pivot object, not a shared reference', () => {
    const a = upsertPreview([], 'c', R(0, 0, 1, 1))[0];
    const b = upsertPreview([], 'd', R(0, 0, 1, 1))[0];
    expect(a.pivot).not.toBe(b.pivot);
  });
});
