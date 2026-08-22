// @vitest-environment jsdom
/** Unit: `computeHandles` — the summary an agent reads BEFORE aiming.
 *
 *  The counts exist so "why did my tap do nothing?" is answerable in one query instead of a
 *  screenshot: the handle was scrolled out of view, or covered by a modal, or greyed out. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerHandleProvider, type InteractionHandle } from '@modoki/engine/runtime';
import { computeHandles } from '../../app/debug/handlesDump';

const unregisters: Array<() => void> = [];
function provide(...handles: InteractionHandle[]) {
  unregisters.push(registerHandleProvider(() => handles));
}
const h = (over: Partial<InteractionHandle>): InteractionHandle =>
  ({ id: 'h', kind: 'button', editor: 'chrome', x: 10, y: 10, ...over });

beforeEach(() => {
  while (unregisters.length) unregisters.pop()!();
  document.body.innerHTML = '';
  document.elementFromPoint = () => null as unknown as Element;
  window.innerWidth = 1600;
  window.innerHeight = 968;
});

describe('computeHandles', () => {
  it('summarises an all-clear set (owner-less handles are unchecked, not clean)', () => {
    provide(h({ id: 'a' }), h({ id: 'b', x: 20 }));
    expect(computeHandles()).toMatchObject({
      count: 2, editors: ['chrome'], offScreenCount: 0, occludedCount: 0,
      occlusionUnchecked: 2, disabledCount: 0,
      viewport: { w: 1600, h: 968 },
    });
  });

  it('counts an off-screen handle — scroll the panel before aiming at it', () => {
    provide(h({ id: 'visible' }), h({ id: 'below-fold', y: 2000 }));
    const r = computeHandles();
    expect(r.offScreenCount).toBe(1);
    expect(r.handles.find((x) => x.id === 'below-fold')!.onScreen).toBe(false);
    expect(r.handles.find((x) => x.id === 'visible')!.onScreen).toBe(true);
  });

  it('a handle carrying unrelated meta is not counted as disabled', () => {
    provide(h({ id: 'k', meta: { boneName: 'root' } }), h({ id: 'j', meta: { disabled: false } }));
    expect(computeHandles().disabledCount).toBe(0);
  });

  describe('occlusion is computed HERE, for every handle that names an owner', () => {
    // Being covered is a property of anything addressed by COORDINATE — a Dopesheet keyframe
    // under an open menu is as un-clickable as an Inspector button. It was briefly a
    // chrome-provider feature, which made `occludedCount` a chrome-only metric that read as
    // global.
    const el = (tag = 'div', cls = '') => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      document.body.appendChild(e);
      return e;
    };

    it('names what covers a handle, whatever editor produced it', () => {
      const canvas = el('canvas');
      const modal = el('div', 'modal');
      document.elementFromPoint = () => modal;
      provide(h({ id: 'dope:key:0', editor: 'dopesheet', owner: canvas }));

      const r = computeHandles();
      expect(r.handles[0].occludedBy).toBe('div.modal');
      expect(r).toMatchObject({ occludedCount: 1, occlusionUnchecked: 0 });
    });

    it('a descendant on top is not occlusion (the click still bubbles)', () => {
      const btn = el('button');
      const label = document.createElement('span');
      btn.appendChild(label);
      document.elementFromPoint = () => label;
      provide(h({ id: 'b', owner: btn }));
      expect(computeHandles().handles[0].occludedBy).toBeUndefined();
      expect(computeHandles().occludedCount).toBe(0);
    });

    it('nothing at the point is occlusion with a NON-NULL reason (falsy would be uncounted)', () => {
      const btn = el('button');
      document.elementFromPoint = () => null as unknown as Element;
      provide(h({ id: 'clipped', owner: btn }));
      const r = computeHandles();
      expect(r.handles[0].occludedBy).toMatch(/clipped or off-window/);
      expect(r.occludedCount).toBe(1);
    });

    it('REGRESSION: a handle with NO owner is occlusion-UNCHECKED, not known-clickable', () => {
      // occludedCount === 0 must not be read as "everything is clickable" while some
      // handles were never hit-tested at all. That silent half-truth is the bug.
      const covered = el('canvas');
      document.elementFromPoint = () => el('div', 'modal');
      provide(h({ id: 'canvas:no-owner', editor: 'skin' }), h({ id: 'chrome:owned', owner: covered }));

      const r = computeHandles();
      expect(r.occlusionUnchecked).toBe(1);
      expect(r.handles.find((x) => x.id === 'canvas:no-owner')!.occlusionChecked).toBe(false);
      expect(r.handles.find((x) => x.id === 'chrome:owned')!.occlusionChecked).toBe(true);
    });

    it('REGRESSION: the live DOM `owner` never reaches the JSON that crosses the bridge', () => {
      // An Element is circular; JSON.stringify would throw and the whole handles query
      // would fail with an opaque error.
      const btn = el('button');
      document.elementFromPoint = () => btn;
      provide(h({ id: 'x', owner: btn }));

      const r = computeHandles();
      expect('owner' in r.handles[0]).toBe(false);
      expect(() => JSON.stringify(r)).not.toThrow();
    });

    it('counts occluded and disabled separately — they need different fixes', () => {
      // Occluded: dismiss what's on top. Disabled: the control is inert; clicking is pointless.
      const a = el('button'), b = el('button'), modal = el('div', 'modal');
      // `a` is covered by the modal; `b` hit-tests to itself but is inert.
      document.elementFromPoint = (x: number) => (x === 10 ? modal : b) as Element;
      provide(h({ id: 'covered', x: 10, owner: a }), h({ id: 'greyed', x: 99, owner: b, meta: { disabled: true } }));
      expect(computeHandles()).toMatchObject({ count: 2, occludedCount: 1, disabledCount: 1 });
    });
  });

  describe('onScreen is judged against the owning panel\'s CLIP box, not just the window', () => {
    // testboard AceYUBoBXbcGtIIFmzGb: a gradient stop 800px down a docked panel's un-scrolled
    // content flow reports a y that IS inside the window but is hundreds of px below its own
    // panel — physically over a different panel. Window-only judging said onScreen:true and the
    // aim drove the Assets panel's context menu.
    const clipper = (rect: { x: number; y: number; w: number; h: number }) => {
      const box = document.createElement('div');
      box.style.overflow = 'hidden';
      box.getBoundingClientRect = () => ({
        left: rect.x, top: rect.y, right: rect.x + rect.w, bottom: rect.y + rect.h,
        width: rect.w, height: rect.h, x: rect.x, y: rect.y, toJSON: () => ({}),
      }) as DOMRect;
      document.body.appendChild(box);
      return box;
    };

    it('a handle scrolled out of its clipped panel is OFF-screen, though it is inside the window', () => {
      const panel = clipper({ x: 0, y: 0, w: 400, h: 260 });
      const inner = document.createElement('div');
      panel.appendChild(inner);
      provide(h({ id: 'particle:gradient:color:1', editor: 'particle', x: 200, y: 863, owner: inner }));

      const r = computeHandles();
      expect(r.handles[0].onScreen).toBe(false);
      expect(r.offScreenCount).toBe(1);
    });

    it('the same handle inside the clip box stays on-screen', () => {
      const panel = clipper({ x: 0, y: 0, w: 400, h: 260 });
      const inner = document.createElement('div');
      panel.appendChild(inner);
      provide(h({ id: 'particle:gradient:color:1', editor: 'particle', x: 200, y: 120, owner: inner }));
      expect(computeHandles().handles[0].onScreen).toBe(true);
    });

    it('the OWNER\'s own overflow counts — the Dopesheet hands out its own clipped container', () => {
      // DopesheetView/CurvesView register `owner: <their own overflow:hidden div>` and compute each
      // handle's x as `rect.left + timeToX(t)`, unclamped — so a keyframe panned out of the visible
      // time window sits beside the container, over the TrackList sidebar. Walking from the PARENT
      // saw only the panel's outer clip (wider than that) and called it aimable, reopening the
      // very bug this guard closes one level down.
      const own = clipper({ x: 400, y: 100, w: 300, h: 200 });
      provide(h({ id: 'dope:key:Transform.x:3', editor: 'dopesheet', x: 180, y: 150, owner: own }));
      const r = computeHandles();
      expect(r.handles[0].onScreen).toBe(false);
      expect(r.handles[0].clipped).toBe(true);
    });

    it('…and a handle inside that same container is still aimable', () => {
      const own = clipper({ x: 400, y: 100, w: 300, h: 200 });
      provide(h({ id: 'dope:key:Transform.x:4', editor: 'dopesheet', x: 500, y: 150, owner: own }));
      expect(computeHandles().handles[0].onScreen).toBe(true);
    });

    it('the ancestor walk runs ONCE per owner, not once per handle', () => {
      // A Dopesheet gives ~2000 keyframes the same container; without the per-call memo each one
      // re-walks an identical chain calling getComputedStyle per hop.
      const own = clipper({ x: 0, y: 0, w: 800, h: 600 });
      const spy = vi.spyOn(window, 'getComputedStyle');
      provide(...Array.from({ length: 50 }, (_, i) => h({ id: `dope:key:${i}`, x: 10 + i, y: 20, owner: own })));
      computeHandles();
      // One walk = one getComputedStyle per element in the chain (owner + its non-body ancestors),
      // so a handful — emphatically not 50x that.
      expect(spy.mock.calls.length).toBeLessThan(10);
      spy.mockRestore();
    });

    it('an owner with no clipping ancestor is judged by the window alone', () => {
      const loose = document.createElement('div');
      document.body.appendChild(loose);
      provide(h({ id: 'free', x: 200, y: 863, owner: loose }));
      expect(computeHandles().handles[0].onScreen).toBe(true);
    });
  });

  it('filters by editor, and reports only the surviving editors', () => {
    provide(h({ id: 'c1', editor: 'chrome' }), h({ id: 's1', editor: 'skin' }));
    expect(computeHandles({ editor: 'chrome' })).toMatchObject({ count: 1, editors: ['chrome'] });
    expect(computeHandles().editors).toEqual(['chrome', 'skin']);
  });

  it('a provider that throws is skipped, not fatal', () => {
    unregisters.push(registerHandleProvider(() => { throw new Error('panel exploded'); }));
    provide(h({ id: 'survivor' }));
    expect(computeHandles().handles.map((x) => x.id)).toEqual(['survivor']);
  });

  it('REGRESSION: a duplicate handle id is reported LOUDLY, not resolved silently', () => {
    // `resolveHandle` takes the first match, so a second handle sharing an id is simply
    // unreachable and tap_handle drives the wrong element. Canvas ids are unique by
    // construction; hand-authored `data-ui-id` strings are on the honour system.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    provide(h({ id: 'inspector.header.name' }), h({ id: 'inspector.header.name', x: 900 }));

    computeHandles();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('duplicate handle id "inspector.header.name"'));
    spy.mockRestore();
  });
});
