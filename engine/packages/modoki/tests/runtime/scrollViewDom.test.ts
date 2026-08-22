import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { UIScrollView, NO_SCROLL_REQUEST } from '../../src/runtime/traits/UIScrollView';

const dirtySpy = vi.fn();
let testWorld: ReturnType<typeof createWorld>;

vi.mock('../../src/runtime/core/uiDirty', () => ({
  markUIDirty: () => dirtySpy(),
  isUIDirty: () => false,
  clearUIDirty: () => {},
}));
vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  findEntityByGuid: (guid: string) => {
    let found: any;
    testWorld.query(UIScrollView).updateEach((_t: any[], e: any) => { if (!found) found = e; });
    return guid === 'view-guid' ? found : undefined;
  },
}));
vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getTraitByName: (n: string) => (n === 'UIScrollView' ? { name: n, trait: UIScrollView } : undefined),
}));

import { scrollViewStyle, scrollSnapChildStyle, pendingScrollTo, clearScrollRequest, type ScrollViewNodeData } from '../../src/runtime/ui/scrollViewDom';

const base = (over: Partial<ScrollViewNodeData> = {}): ScrollViewNodeData => ({
  axis: 'y', snap: 'none', snapStop: 'normal', overscroll: 'auto', scrollbar: 'auto',
  scrollToX: NO_SCROLL_REQUEST, scrollToY: NO_SCROLL_REQUEST, scrollBehavior: 'instant', ...over,
});

describe('scrollViewStyle', () => {
  it('does NOT set overflow — that stays UIElement.overflow, one owner per visible consequence', () => {
    expect(scrollViewStyle(base())).not.toHaveProperty('overflow');
  });

  it('emits no snap type while snap is none', () => {
    expect(scrollViewStyle(base())).not.toHaveProperty('scrollSnapType');
  });

  it('maps each axis onto the matching snap axis', () => {
    expect(scrollViewStyle(base({ snap: 'start', axis: 'y' })).scrollSnapType).toBe('y mandatory');
    expect(scrollViewStyle(base({ snap: 'start', axis: 'x' })).scrollSnapType).toBe('x mandatory');
    expect(scrollViewStyle(base({ snap: 'start', axis: 'both' })).scrollSnapType).toBe('both mandatory');
  });

  it('always carries overscroll-behavior', () => {
    expect(scrollViewStyle(base({ overscroll: 'contain' })).overscrollBehavior).toBe('contain');
    expect(scrollViewStyle(base({ overscroll: 'none' })).overscrollBehavior).toBe('none');
  });

  it('hides the classic scrollbar when scrollbar is hidden', () => {
    expect(scrollViewStyle(base({ scrollbar: 'hidden' })).scrollbarWidth).toBe('none');
  });

  it('emits no scrollbar-width at all under the "auto" default — a classic scrollbar is left alone', () => {
    expect(scrollViewStyle(base())).not.toHaveProperty('scrollbarWidth');
  });
});

describe('scrollSnapChildStyle', () => {
  it('is empty when snapping is off, so a non-snapping view puts no CSS on every entry', () => {
    expect(scrollSnapChildStyle(base())).toEqual({});
  });

  it('carries align and stop onto the TARGET, not the box', () => {
    expect(scrollSnapChildStyle(base({ snap: 'center', snapStop: 'always' })))
      .toEqual({ scrollSnapAlign: 'center', scrollSnapStop: 'always' });
  });
});

describe('pendingScrollTo', () => {
  it('is null when neither axis is requested', () => {
    expect(pendingScrollTo(base())).toBeNull();
  });

  it('treats 0 as a REAL request — the sentinel is -1, not falsiness', () => {
    // Guards the classic bug: `if (scrollToY)` would silently refuse "scroll to the top".
    expect(pendingScrollTo(base({ scrollToY: 0 }))).toEqual({ top: 0, behavior: 'instant' });
  });

  it('requests each axis independently', () => {
    expect(pendingScrollTo(base({ scrollToX: 120 }))).toEqual({ left: 120, behavior: 'instant' });
    const both = pendingScrollTo(base({ scrollToX: 5, scrollToY: 9 }));
    expect(both).toEqual({ left: 5, top: 9, behavior: 'instant' });
  });

  it('passes smooth through and defaults anything else to instant', () => {
    expect(pendingScrollTo(base({ scrollToY: 1, scrollBehavior: 'smooth' }))!.behavior).toBe('smooth');
    expect(pendingScrollTo(base({ scrollToY: 1, scrollBehavior: 'nonsense' }))!.behavior).toBe('instant');
  });
});

describe('clearScrollRequest', () => {
  beforeEach(() => { testWorld = createWorld(); dirtySpy.mockClear(); });

  it('DIRTIES the tree, so a second request for the same offset is not swallowed', () => {
    // `UINode`'s one-shot effect is keyed on the request VALUES. If the tree never observes the
    // `-1`, a repeat request compares equal to the stale value and never re-fires. The
    // declarative `ui.scrollTo` path hides this (bindings.ts dirties for its own reasons); a
    // game calling scrollToEntry() directly gets no such rescue.
    testWorld.spawn(UIScrollView({ scrollToY: 4800 }));
    clearScrollRequest('view-guid');
    let sv: any;
    testWorld.query(UIScrollView).updateEach(([v]: any[]) => { sv = v; });
    expect(sv.scrollToY).toBe(NO_SCROLL_REQUEST);
    expect(dirtySpy).toHaveBeenCalled();
  });

  it('does nothing — and does NOT dirty — when there is no request pending', () => {
    testWorld.spawn(UIScrollView({}));
    clearScrollRequest('view-guid');
    expect(dirtySpy).not.toHaveBeenCalled();   // a scroll frame with no request stays free
  });

  // ⚠️ This REVERSES an older assertion ("clears only the axis asked for"), which pinned a real
  // defect. `pendingScrollTo` builds ONE `Element.scrollTo` call from whatever is set on either
  // axis, so both are consumed together — clearing one leaves a request that is applied on every
  // subsequent rebuild and can never be cleared. Court hit it: `{x: page, y: 0}` on an `axis:'x'`
  // view left `scrollToY: 0` stuck, and the resulting per-rebuild `scrollTo({top: 0})` (no `left`,
  // so the CURRENT left is kept) cancelled the in-flight smooth scroll ~20ms in. The arrows moved
  // nothing while the trait read a clean `scrollToX: -1`.
  it('clears BOTH axes — a request the view does not scroll must not survive', () => {
    testWorld.spawn(UIScrollView({ axis: 'x', scrollToX: 120, scrollToY: 0 }));
    clearScrollRequest('view-guid');
    let sv: any;
    testWorld.query(UIScrollView).updateEach(([v]: any[]) => { sv = v; });
    expect(sv.scrollToX).toBe(NO_SCROLL_REQUEST);
    // 0 is a REAL request (scroll to the top), not the sentinel — which is what made it stick.
    expect(sv.scrollToY).toBe(NO_SCROLL_REQUEST);
  });
});
