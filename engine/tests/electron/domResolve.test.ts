// @vitest-environment jsdom
/** Unit: `domResolve` — turning a CSS selector into a point, and reporting who is
 *  actually AT that point.
 *
 *  jsdom gives every element a zero rect and has no real `elementFromPoint`, so both are
 *  stubbed. That is not a cheat: the resolver's job is pure arithmetic over a rect plus a
 *  hit-test lookup, and stubbing those inputs is the only way to assert the arithmetic
 *  without a browser. The *behaviour under real layout* (an open menu covering its own
 *  button) is what Electron verification is for — see the plan's working agreements. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveDomPoint, resolveDomPointReport, describeElement } from '../../app/debug/domResolve';

/** Give `el` a real-looking rect. jsdom reports all zeroes otherwise. */
function stubRect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () => ({
    left: r.left, top: r.top, width: r.width, height: r.height,
    right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => ({}),
  }) as DOMRect;
}

/** Stub the hit-test: whatever element we say is topmost at any point. */
function stubTopmost(el: Element | null) {
  document.elementFromPoint = () => el as Element;
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { vi.restoreAllMocks(); });

describe('describeElement', () => {
  it('prefers the Enact tagging attribute over id and class', () => {
    const el = document.createElement('button');
    el.id = 'save';
    el.className = 'btn primary';
    el.setAttribute('data-ui-id', 'inspector.header.kebab');
    expect(describeElement(el)).toBe('button[data-ui-id="inspector.header.kebab"]');
  });

  it('falls back to id, then to the first two classes, then the bare tag', () => {
    const withId = document.createElement('div');
    withId.id = 'root';
    withId.className = 'a b';
    expect(describeElement(withId)).toBe('div#root');

    const withClasses = document.createElement('div');
    withClasses.className = 'a b c';
    expect(describeElement(withClasses)).toBe('div.a.b');

    expect(describeElement(document.createElement('span'))).toBe('span');
  });

  it('survives an SVG element, whose className is not a string', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    expect(() => describeElement(svg)).not.toThrow();
    expect(describeElement(svg)).toBe('circle');
  });

  it('returns null for nothing', () => {
    expect(describeElement(null)).toBeNull();
    expect(describeElement(undefined)).toBeNull();
  });
});

describe('resolveDomPoint (throwing — the DnD path)', () => {
  it('resolves a selector to the element centre', () => {
    const el = document.createElement('div');
    el.id = 'target';
    document.body.appendChild(el);
    stubRect(el, { left: 100, top: 40, width: 60, height: 20 });

    const hit = resolveDomPoint({ selector: '#target' });
    expect(hit.el).toBe(el);
    expect([hit.x, hit.y]).toEqual([130, 50]);
  });

  it('throws, naming the endpoint, when the selector matches nothing', () => {
    expect(() => resolveDomPoint({ selector: '#nope' }, 'from')).toThrow(/from: no element matches selector "#nope"/);
  });

  it('throws when neither a selector nor coordinates were given', () => {
    expect(() => resolveDomPoint({}, 'to')).toThrow(/to: provide a selector or \{x,y\}/);
  });

  it('passes coordinates through, resolving the element under them', () => {
    const el = document.createElement('div');
    stubTopmost(el);
    const hit = resolveDomPoint({ x: 7, y: 9 });
    expect([hit.x, hit.y]).toEqual([7, 9]);
    expect(hit.el).toBe(el);
  });

  it('throws when nothing is at the given coordinates', () => {
    stubTopmost(null);
    expect(() => resolveDomPoint({ x: 7, y: 9 }, 'from')).toThrow(/from: no element at \(7, 9\)/);
  });

  it('REGRESSION: refuses a zero-size rect, so a DROP cannot land at the window corner', () => {
    // The DnD path shares the resolver precisely so it inherits this guard. Without it a
    // hidden element's "centre" is (0,0), and a Hierarchy reparent or Assets file-move
    // would fire dragstart/drop at the top-left of the window — a destructive silent miss.
    const el = document.createElement('div');
    el.id = 'hidden';
    document.body.appendChild(el); // jsdom rect is all zeroes
    expect(() => resolveDomPoint({ selector: '#hidden' }, 'from')).toThrow(/from: .*zero-size rect/);
  });

  it('turns an invalid CSS selector into a clean error, not a raw DOMException', () => {
    expect(() => resolveDomPoint({ selector: '###' }, 'to')).toThrow(/to: invalid CSS selector "###"/);
  });
});

describe('resolveDomPointReport (serializable — the trusted-input path)', () => {
  it('never throws on a bad selector; reports the failure as data', () => {
    const r = resolveDomPointReport({ selector: '#missing' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no element matches selector "#missing"/);
    expect(r.x).toBeUndefined();
  });

  it('refuses a zero-size rect rather than silently aiming at (0,0)', () => {
    // A display:none or not-yet-laid-out element reports an all-zero rect. Aiming at its
    // "centre" would click the top-left corner of the window — a wrong click that looks
    // like a successful one.
    const el = document.createElement('div');
    el.id = 'hidden';
    document.body.appendChild(el); // jsdom rect is already all zeroes

    const r = resolveDomPointReport({ selector: '#hidden' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/zero-size rect/);
    expect(r.matched).toBe('div#hidden');
  });

  it('reports the centre, the matched element, and a clean hit', () => {
    const el = document.createElement('button');
    el.setAttribute('data-ui-id', 'inspector.kebab');
    document.body.appendChild(el);
    stubRect(el, { left: 200, top: 100, width: 20, height: 20 });
    stubTopmost(el);

    const r = resolveDomPointReport({ selector: '[data-ui-id="inspector.kebab"]' });
    expect(r).toMatchObject({
      ok: true, x: 210, y: 110,
      matched: 'button[data-ui-id="inspector.kebab"]',
      hitTarget: 'button[data-ui-id="inspector.kebab"]',
      occluded: false,
    });
  });

  it('a DESCENDANT on top is not occlusion — the click still reaches the target', () => {
    // Aiming at a container whose centre lands on its own label: the event bubbles, so
    // the container's handler runs. Flagging this would cry wolf on every button.
    const btn = document.createElement('button');
    const label = document.createElement('span');
    btn.appendChild(label);
    document.body.appendChild(btn);
    stubRect(btn, { left: 0, top: 0, width: 100, height: 30 });
    stubTopmost(label);

    const r = resolveDomPointReport({ selector: 'button' });
    expect(r.occluded).toBe(false);
    expect(r.hitTarget).toBe('span');
  });

  it('REGRESSION: an unrelated element on top IS occlusion, and it is named', () => {
    // The bug this whole field exists for: the `⋮` menu opened anchored at the cursor,
    // covering the `⋮` itself, so the next trusted click hit the menu. Silent in a
    // screenshot; one field here.
    const kebab = document.createElement('button');
    kebab.setAttribute('data-ui-id', 'inspector.kebab');
    document.body.appendChild(kebab);
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    document.body.appendChild(menu);
    stubRect(kebab, { left: 300, top: 50, width: 14, height: 14 });
    stubTopmost(menu); // the menu sits over the kebab's centre

    const r = resolveDomPointReport({ selector: '[data-ui-id="inspector.kebab"]' });
    expect(r.ok).toBe(true);
    expect(r.occluded).toBe(true);
    expect(r.matched).toBe('button[data-ui-id="inspector.kebab"]');
    expect(r.hitTarget).toBe('div.context-menu');
  });

  it('occlusion is true when nothing is at the point at all (off-screen)', () => {
    const el = document.createElement('div');
    el.id = 'far';
    document.body.appendChild(el);
    stubRect(el, { left: -500, top: -500, width: 10, height: 10 });
    stubTopmost(null);

    const r = resolveDomPointReport({ selector: '#far' });
    expect(r.occluded).toBe(true);
    expect(r.hitTarget).toBeNull();
  });

  it('a coordinate spec passes through and reports only what is under it', () => {
    const el = document.createElement('canvas');
    stubTopmost(el);
    const r = resolveDomPointReport({ x: 769, y: 310 });
    expect(r).toMatchObject({ ok: true, x: 769, y: 310, hitTarget: 'canvas' });
    // Nothing was "matched", so there is nothing to be occluded relative to.
    expect(r.matched).toBeUndefined();
    expect(r.occluded).toBeUndefined();
  });

  it('rejects an empty spec', () => {
    expect(resolveDomPointReport({})).toMatchObject({ ok: false, error: 'provide a selector or {x,y}' });
  });

  it('an invalid selector is an error result, not a thrown DOMException', () => {
    // `document.querySelector('###')` throws. This function is called across the bridge
    // and its contract is "never throws", so the DOMException must be caught.
    expect(() => resolveDomPointReport({ selector: '###' })).not.toThrow();
    expect(resolveDomPointReport({ selector: '###' })).toMatchObject({ ok: false, error: 'invalid CSS selector "###"' });
  });

  it('reports nothing at the coordinates as a failure rather than aiming blindly', () => {
    stubTopmost(null);
    expect(resolveDomPointReport({ x: 5, y: 5 })).toMatchObject({ ok: false, error: 'no element at (5, 5)' });
  });
});
