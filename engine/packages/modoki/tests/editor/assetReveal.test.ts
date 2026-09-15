/** How the Assets panel follows an external selection (#1143).
 *
 *  Two points. (1) Re-selecting the SAME asset must still reveal its row: the reveal used to ride
 *  a path guard, so `modoki_set_selection` — the documented way for a QA case to make a row exist —
 *  did nothing on exactly the profile that needed it. (2) The panel's OWN publishes (clicks, Cmd+A,
 *  a rename) also create new selection objects, and they must neither expand nor scroll: a first
 *  identity-only fix re-opened collapsed groups on every click. */

import { describe, it, expect } from 'vitest';
import { createStoreSelectionTracker, revealKeysFor } from '../../src/editor/panels/assetReveal';
import { ASSETS_SECTION, visibleOrder } from '../../src/editor/panels/assetListing';

const PATH = '/assets/particles/star-burst.particle.json';
const asset = (path = PATH, type = 'particle') => ({ path, type, name: 'x' });
const hidden = () => false;
const rendered = () => true;

describe('createStoreSelectionTracker', () => {
  it('EXPANDS a re-selection of the already-selected, now-hidden asset — a new object, the same path (#1143)', () => {
    const t = createStoreSelectionTracker();
    t.next(asset(), null, hidden);
    expect(t.next(asset(), PATH, hidden)).toEqual({ syncLocal: false, expand: true, scroll: true });
  });

  it('does NOTHING for an object the panel itself published — a click, or Cmd+A republishing its lead', () => {
    // activate(): setSelected(path) + selectAsset(new object) land in one render. Cmd+A: the multi-select
    // effect republishes a fresh lead object while the panel is scrolled away from it (scrollTo: null).
    const t = createStoreSelectionTracker();
    t.next(asset('/assets/a.json'), '/assets/a.json', rendered);
    const mine = asset();
    t.markOwn([mine]);
    expect(t.next(mine, PATH, hidden)).toEqual({ syncLocal: false, expand: false, scroll: false });
  });

  it('an own object RESTORED later (undo/redo) is fresh again — the mark is spent on first sight', () => {
    // applySelection stores the panel's object as-is, and undo puts that SAME reference back.
    const t = createStoreSelectionTracker();
    const a = asset('/assets/a.json');
    t.markOwn([a]);
    t.next(a, '/assets/a.json', rendered);
    t.next(asset(), PATH, rendered);                 // the human clicks something else (external here)
    expect(t.next(a, PATH, hidden)).toEqual({ syncLocal: true, expand: true, scroll: true });
  });

  it('an unmarked new object with the same path IS fresh — own-marking is per object, not per path', () => {
    const t = createStoreSelectionTracker();
    t.markOwn([asset()]);
    expect(t.next(asset(), PATH, hidden).expand).toBe(true);
  });

  it('does NOTHING when the store republishes the SAME object — an unrelated update must not re-expand or scroll', () => {
    const t = createStoreSelectionTracker();
    const a = asset();
    t.next(a, null, hidden);
    expect(t.next(a, PATH, hidden)).toEqual({ syncLocal: false, expand: false, scroll: false });
  });

  it('adopts, expands and scrolls an external selection of a different, hidden asset', () => {
    const t = createStoreSelectionTracker();
    t.next(asset('/assets/particles/comet.particle.json'), '/assets/particles/comet.particle.json', rendered);
    expect(t.next(asset(), '/assets/particles/comet.particle.json', hidden)).toEqual({ syncLocal: true, expand: true, scroll: true });
  });

  it('scrolls but does not expand an external selection whose row is already rendered', () => {
    const t = createStoreSelectionTracker();
    expect(t.next(asset(), '/assets/other.json', rendered)).toEqual({ syncLocal: true, expand: false, scroll: true });
  });

  it('does not collapse a multi-select when its lead is republished as a new object with the local path', () => {
    const t = createStoreSelectionTracker();
    t.next(asset(), PATH, rendered);
    expect(t.next(asset(), PATH, rendered).syncLocal).toBe(false);
  });

  it('remembers what it saw even for a cleared selection, so the next select of the old object is fresh', () => {
    const t = createStoreSelectionTracker();
    const a = asset();
    t.next(a, null, hidden);
    expect(t.next(null, PATH, hidden)).toEqual({ syncLocal: false, expand: false, scroll: false });
    expect(t.next(a, null, hidden).expand).toBe(true);
  });

  it('asks the row predicate about the SELECTED path, not something else', () => {
    const t = createStoreSelectionTracker();
    const asked: string[] = [];
    t.next(asset(), null, (p) => { asked.push(p); return false; });
    expect(asked).toEqual([PATH]);
  });
});

describe('revealKeysFor', () => {
  it('opens the type group, the top Assets section, every ancestor folder and root', () => {
    expect(revealKeysFor(asset())).toEqual(['particle', ASSETS_SECTION, '/assets', '/assets/particles', '/']);
  });

  it('makes the row VISIBLE in folder view from a fully collapsed set — the section key is load-bearing', () => {
    // A two-level tree like the real one: the render root is /assets, with a particles folder.
    const file = { path: PATH, name: 'star-burst', type: 'particle' };
    const particles = { path: '/assets/particles', name: 'particles', children: [], files: [file] };
    const assetsRoot = { path: '/assets', name: 'assets', children: [particles], files: [] };
    const order = visibleOrder({
      viewMode: 'folder', grouped: new Map(), assetsRoot: assetsRoot as never,
      expanded: new Set(revealKeysFor(asset())),
    });
    expect(order).toContain(PATH);
  });

  it('makes the row VISIBLE in category view from a fully collapsed set', () => {
    const order = visibleOrder({
      viewMode: 'category', grouped: new Map([['particle', [asset() as never]]]),
      assetsRoot: { path: '/assets', name: 'assets', children: [], files: [] } as never,
      expanded: new Set(revealKeysFor(asset())),
    });
    expect(order).toContain(PATH);
  });

  it('an ENGINE asset gets no project keys — the Engine section reveals itself', () => {
    expect(revealKeysFor({ path: '/modoki/assets/fonts/inter.ttf', type: 'font' })).toEqual([]);
  });

  it('a `#` in a NON-sprite path is part of the path, not a slice suffix', () => {
    expect(revealKeysFor({ path: '/assets/lvl#1/a.scene.json', type: 'scene' }))
      .toEqual(['scene', ASSETS_SECTION, '/assets', '/assets/lvl#1', '/']);
  });

  it('a sprite under a `#` folder splits at the LAST `#`, where the slice guid starts', () => {
    expect(revealKeysFor({ path: '/assets/lvl#1/sheet.png#abcd', type: 'sprite' }))
      .toEqual(['texture', '/assets/lvl#1/sheet.png', ASSETS_SECTION, '/assets', '/assets/lvl#1', '/']);
  });

  it('a sliced sprite opens its parent TEXTURE row and the texture group, not a "sprite" group', () => {
    const keys = revealKeysFor({ path: '/assets/textures/zombie/head.png#1234-guid', type: 'sprite' });
    expect(keys).toEqual(['texture', '/assets/textures/zombie/head.png', ASSETS_SECTION, '/assets', '/assets/textures', '/assets/textures/zombie', '/']);
  });

  it('a sprite the list shows as its OWN row opens the sprite group instead — no texture row holds it (#1249)', () => {
    // The sprite chip (or a search) lists sprites flat; expanding the `texture` group, which the chip hides,
    // left the row unrendered and scrollIntoView found nothing.
    const keys = revealKeysFor({ path: '/assets/textures/zombie/head.png#1234-guid', type: 'sprite' }, { spriteRow: true });
    expect(keys).toEqual(['sprite', ASSETS_SECTION, '/assets', '/assets/textures', '/assets/textures/zombie', '/']);
  });
});
