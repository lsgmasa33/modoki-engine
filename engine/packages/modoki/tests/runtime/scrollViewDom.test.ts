import { describe, it, expect } from 'vitest';
import { scrollViewStyle, scrollSnapChildStyle, pendingScrollTo, type ScrollViewNodeData } from '../../src/runtime/ui/scrollViewDom';
import { NO_SCROLL_REQUEST } from '../../src/runtime/traits/UIScrollView';

const base = (over: Partial<ScrollViewNodeData> = {}): ScrollViewNodeData => ({
  axis: 'y', snap: 'none', snapStop: 'normal', overscroll: 'auto',
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
