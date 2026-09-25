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
import { resolveDomPoint, resolveDomPointReport, describeElement, describeOccluder } from '../../app/debug/domResolve';
import { opReplyFor } from '../../app/debug/opRefusal';

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

/** #1016 — the SELECTOR path, which is the DEVICE path.
 *
 *  ⚠️ **This block exists because review found the device aim surface unwired and nothing here
 *  could see it.** Every case added for #1016 was on the ENTITY path (`entityResolve.test.ts`), and
 *  `bridge.ts` — `device_tap`/`device_drag`/`device_pointer` and the trusted CDP/WDA route — aims
 *  by SELECTOR. That is also the surface that runs against the shipped game, so it is the only one
 *  where a `minTapSize` zone authored by Court or wordweave actually exists. A whole aim surface
 *  was uncovered because the tests followed the code path the fix was written against. */
describe('#1016 — the selector path carries the gesture too', () => {
  const TAP_ZONE = 'data-tap-zone';
  const PRESS_ORIGIN = 'data-press-origin';

  /** The shipping shape: a swallowClicks panel holding two sibling controls, one whose tap zone
   *  overhangs the other. No `id`, no `className` — a UINode host has neither. */
  function mountOverlap() {
    const panel = document.createElement('div');
    panel.setAttribute(PRESS_ORIGIN, '');
    document.body.appendChild(panel);

    const target = document.createElement('div');
    target.setAttribute(PRESS_ORIGIN, '');
    target.setAttribute('data-entity-id', '42');
    panel.appendChild(target);
    stubRect(target, { left: 100, top: 60, width: 40, height: 40 });

    const sibling = document.createElement('div');
    sibling.setAttribute(PRESS_ORIGIN, '');
    sibling.setAttribute('data-entity-id', '31');
    panel.appendChild(sibling);

    const zone = document.createElement('div');
    zone.setAttribute(TAP_ZONE, '');
    sibling.appendChild(zone);

    document.elementFromPoint = () => zone;
    document.elementsFromPoint = () => [zone, target, panel, document.body];
    return { panel, target, sibling, zone };
  }

  const aim = (gesture?: string) => resolveDomPointReport(
    { selector: '[data-entity-id="42"]', ...(gesture ? { gesture } : {}) } as never,
  );

  it('a TAP by selector is not occluded by a zone that would lose the press to it', () => {
    mountOverlap();
    expect(aim('tap'), 'the reverted fix excused this path as "editor chrome only" — it is not')
      .toMatchObject({ ok: true, occluded: false });
  });

  it.each(['drag', 'press', 'hover', 'scroll'])(
    'a %s by selector is STILL occluded — device_drag must not begin on the zone host', (g) => {
      mountOverlap();
      expect(aim(g)).toMatchObject({ occluded: true });
    });

  it('a selector aim with NO gesture gets the strict answer', () => {
    mountOverlap();
    expect(aim()).toMatchObject({ occluded: true });
  });

  it('names the zone by the entity id an agent can aim at', () => {
    const { zone, sibling, panel } = mountOverlap();
    document.elementsFromPoint = () => [zone, sibling, panel, document.body];
    expect(String(aim('tap').hitTarget)).toContain('entity 31');
  });
});

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

  it('SCROLLED OUT of its own list is flagged `clipped`, not just "covered"', () => {
    // A Hierarchy row below the fold reports a real rect at its LAID-OUT position, so the centre
    // lands on whatever chrome owns those pixels — usually an anonymous splitter div. Naming that
    // div told the caller to "dismiss the menu/modal covering it", which is not what is wrong and
    // not a thing they can do. Measured by an independent sweep of this editor's live selectors on
    // 2026-08-19: 12 of 22 occluded hits were this class.
    const list = document.createElement('div');
    list.style.overflow = 'auto';
    stubRect(list, { left: 0, top: 0, width: 200, height: 462 });
    const row = document.createElement('div');
    row.setAttribute('data-ui-id', 'hierarchy.entity.abc');
    list.appendChild(row);
    document.body.appendChild(list);
    stubRect(row, { left: 0, top: 471, width: 200, height: 24 });   // scrolled past the clip
    const splitter = document.createElement('div');
    splitter.className = 'flexlayout__splitter';
    document.body.appendChild(splitter);
    stubTopmost(splitter);

    const r = resolveDomPointReport({ selector: '[data-ui-id="hierarchy.entity.abc"]' });
    expect(r.occluded).toBe(true);
    expect(r.clipped).toBe(true);
    expect(r.hitTarget).toContain('splitter');
  });

  it('…and a genuinely COVERED target is not flagged clipped — the two need different fixes', () => {
    const btn = document.createElement('button');
    btn.setAttribute('data-ui-id', 'inspector.kebab');
    document.body.appendChild(btn);
    stubRect(btn, { left: 300, top: 50, width: 14, height: 14 });
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    document.body.appendChild(menu);
    stubTopmost(menu);

    const r = resolveDomPointReport({ selector: '[data-ui-id="inspector.kebab"]' });
    expect(r.occluded).toBe(true);
    expect(r.clipped).toBeUndefined();
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


/** An occluder the caller cannot ACT on is barely better than none. `describeElement` bottoms out
 *  at the bare tag for a style-only element, and the editor's panel chrome is exactly that: the
 *  SceneView toolbar strip that covered a 2D gizmo handle (testboard 5jE5Tip6Qwp7s7YVAYoH) is an
 *  anonymous div, and "covered by div" is what the report said. */
describe('naming a cover that has nothing but a title', () => {
  it('falls back to `title` before the bare tag', () => {
    // Measured 2026-08-19 in a live editor: a tap at a game-ui entity while the sim is STOPPED is
    // correctly refused — the Game panel lays a full-panel shield over the game — but the cover was
    // reported as "div inside div.flexlayout__tab_moveable", which is true and unactionable. The
    // shield's own title is the remedy, so it belongs in the refusal.
    const shield = document.createElement('div');
    shield.setAttribute('title', 'Press Play to run the game and interact with its UI');
    document.body.appendChild(shield);
    expect(describeElement(shield)).toBe('div[title="Press Play to run the game and interact with its UI"]');
  });

  it('a class still wins over a title, and a long title is trimmed', () => {
    const named = document.createElement('div');
    named.className = 'context-menu';
    named.setAttribute('title', 'whatever');
    expect(describeElement(named)).toBe('div.context-menu');
    const wordy = document.createElement('div');
    wordy.setAttribute('title', 'x'.repeat(200));
    const d = describeElement(wordy)!;
    expect(d.length).toBeLessThan(100);
    expect(d.endsWith('…"]')).toBe(true);
  });
});

describe('describeOccluder', () => {
  it('keeps an already-identifiable description as-is', () => {
    document.body.innerHTML = '<div class="menu"><button data-ui-id="x.y"></button></div>';
    expect(describeOccluder(document.querySelector('button')!)).toBe('button[data-ui-id="x.y"]');
    expect(describeOccluder(document.querySelector('div')!)).toBe('div.menu');
  });

  it('names the PANEL an anonymous element sits in', () => {
    document.body.innerHTML = '<div data-editor-panel="scene"><div><div id="strip"></div></div></div>';
    document.getElementById('strip')!.removeAttribute('id');
    const anon = document.querySelector('[data-editor-panel] div div')!;
    expect(describeOccluder(anon)).toBe('div in the "scene" panel');
  });

  it('names a game UI node by its entity before walking to the chrome around it (#1570)', () => {
    // No world behind this DOM, so the entity is named by its id — the fallback for a node whose
    // entity is gone. The named form is covered in entityResolve.test.ts, which mocks the lookup.
    document.body.innerHTML = '<div class="flexlayout__tab_moveable"><div data-entity-id="13"><div></div></div></div>';
    expect(describeOccluder(document.querySelector('[data-entity-id] div')!)).toBe('entity 13');
    // Tagged editor chrome still names itself, wherever it sits.
    document.body.innerHTML = '<div data-entity-id="13"><button data-ui-id="x.y"></button></div>';
    expect(describeOccluder(document.querySelector('button')!)).toBe('button[data-ui-id="x.y"]');
  });

  it('falls back to the nearest NAMED ancestor when no panel is in the chain', () => {
    document.body.innerHTML = '<section class="overlay"><div><span></span></div></section>';
    // The intermediate div names nothing either, so the walk keeps going.
    expect(describeOccluder(document.querySelector('span')!)).toBe('span inside section.overlay');
  });

  it('answers null for no element at all', () => {
    expect(describeOccluder(null)).toBeNull();
  });
});

/** #1153 — the `label` aim's RULES. The population is the chrome handle set (so the real provider is
 *  registered), and only on-window candidates are counted. `inputRoutes.test.ts` pins what the
 *  routes do with each outcome. */
describe('label aim (#1153)', () => {
  let unregister: () => void;
  beforeEach(async () => {
    const [{ registerHandleProvider }, { chromeHandles }] = await Promise.all([
      import('@modoki/engine/runtime'), import('../../app/debug/chromeHandles'),
    ]);
    unregister = registerHandleProvider(chromeHandles);
    window.innerWidth = 1200;
    window.innerHeight = 800;
  });
  afterEach(() => { unregister(); });

  /** A tagged control with a rect, optionally inside a parent. */
  function control(uiId: string, text: string, rect: { left: number; top: number; width: number; height: number }, parent: Element = document.body) {
    const el = document.createElement('button');
    el.setAttribute('data-ui-id', uiId);
    el.textContent = text;
    parent.appendChild(el);
    stubRect(el, rect);
    return el;
  }

  it('resolves the ONE matching control to its centre, naming it and its data-ui-id', () => {
    const el = control('layout.tab.console', 'Console', { left: 300, top: 540, width: 60, height: 14 });
    control('layout.tab.assets', 'Assets', { left: 400, top: 540, width: 60, height: 14 });
    stubTopmost(el);
    expect(resolveDomPointReport({ label: 'Console', gesture: 'tap' })).toMatchObject({
      ok: true, x: 330, y: 547, uiId: 'layout.tab.console',
      matched: 'button[data-ui-id="layout.tab.console"]', occluded: false,
    });
  });

  it('matches whitespace-collapsed and case-insensitively', () => {
    const el = control('a.b.paste', 'Paste   Values', { left: 10, top: 10, width: 80, height: 20 });
    stubTopmost(el);
    expect(resolveDomPointReport({ label: '  paste values ' })).toMatchObject({ ok: true, uiId: 'a.b.paste' });
  });

  it('never matches a SUBSTRING — but a miss suggests the labels that contain it', () => {
    control('a.b.saveAll', 'Save All', { left: 10, top: 10, width: 80, height: 20 });
    const r = resolveDomPointReport({ label: 'Save' });
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(r.error).toContain('"Save All"');
  });

  it('two on-screen matches are AMBIGUOUS, naming both ids — never first-match', () => {
    control('inspector.footer.cancel', 'Cancel', { left: 10, top: 10, width: 80, height: 20 });
    control('dialog.saveAs.cancel', 'Cancel', { left: 500, top: 400, width: 80, height: 20 });
    const r = resolveDomPointReport({ label: 'Cancel' });
    expect(r).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
    expect(r.error).toContain('inspector.footer.cancel');
    expect(r.error).toContain('dialog.saveAs.cancel');
    expect(r.error).toContain('within');
  });

  it('`within` scopes the candidates to one container', () => {
    const dialog = document.createElement('div');
    dialog.className = 'save-as-dialog';
    document.body.appendChild(dialog);
    control('inspector.footer.cancel', 'Cancel', { left: 10, top: 10, width: 80, height: 20 });
    const inDialog = control('dialog.saveAs.cancel', 'Cancel', { left: 500, top: 400, width: 80, height: 20 }, dialog);
    stubTopmost(inDialog);
    expect(resolveDomPointReport({ label: 'Cancel', within: '.save-as-dialog' })).toMatchObject({ ok: true, uiId: 'dialog.saveAs.cancel' });
    expect(resolveDomPointReport({ label: 'Cancel', within: '.not-open' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(resolveDomPointReport({ label: 'Cancel', within: '[[bad' }).error).toMatch(/invalid CSS selector/);
  });

  it('an OFF-WINDOW twin is not a second candidate', () => {
    const real = control('assets.row.a', 'Grass', { left: 20, top: 300, width: 100, height: 18 });
    control('assets.row.b', 'Grass', { left: 20, top: 1500, width: 100, height: 18 }); // laid out below the window
    stubTopmost(real);
    expect(resolveDomPointReport({ label: 'Grass' })).toMatchObject({ ok: true, uiId: 'assets.row.a' });
  });

  it('matches that exist but are ALL off-window say so, rather than "no such label"', () => {
    control('assets.row.b', 'Grass', { left: 20, top: 1500, width: 100, height: 18 });
    const r = resolveDomPointReport({ label: 'Grass' });
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(r.error).toMatch(/none is inside the window/);
  });

  it('a match SCROLLED OUT of its list loses to a visible twin — and alone, is returned as clipped', () => {
    const list = document.createElement('div');
    list.style.overflow = 'hidden';
    document.body.appendChild(list);
    stubRect(list, { left: 0, top: 0, width: 300, height: 200 });
    const hidden = control('hierarchy.row.1', 'Player', { left: 10, top: 400, width: 100, height: 18 }, list);
    const chrome = document.createElement('div');
    chrome.className = 'flexlayout__splitter';
    document.body.appendChild(chrome);
    stubTopmost(chrome);
    // Alone: returned, so the route can refuse it as SCROLLED OUT instead of NOT_FOUND.
    expect(resolveDomPointReport({ label: 'Player', gesture: 'tap' })).toMatchObject({ ok: true, uiId: 'hierarchy.row.1', occluded: true, clipped: true });
    const visible = control('game.hud.player', 'Player', { left: 600, top: 100, width: 100, height: 18 });
    stubTopmost(visible);
    expect(resolveDomPointReport({ label: 'Player', gesture: 'tap' })).toMatchObject({ ok: true, uiId: 'game.hud.player' });
    void hidden;
  });

  it('a covered label target reports occluded, like a selector aim', () => {
    control('inspector.header.delete', 'Delete', { left: 10, top: 10, width: 80, height: 20 });
    const modal = document.createElement('div');
    modal.className = 'modal';
    document.body.appendChild(modal);
    stubTopmost(modal);
    expect(resolveDomPointReport({ label: 'Delete', gesture: 'tap' })).toMatchObject({ ok: true, occluded: true, hitTarget: 'div.modal' });
  });

  it('the THROWING resolver keeps the code through the relay — modoki_dnd answers AMBIGUOUS (#1556)', async () => {
    // Close-out review: `resolveDomPoint` threw a plain Error, `opReplyFor` keeps a code only for an
    // OpRefusal, so dnd's two addresses reached the agent as REFUSED_BY_OP. Through the real relay wrapper.
    const two = await opReplyFor(() => resolveDomPoint({ selector: '#x', x: 1, y: 1 }, 'from'));
    expect(two).toMatchObject({ result: { ok: false, code: 'AMBIGUOUS' } });
    expect((two as { result: { error: string } }).result.error).toMatch(/^from: give ONE of/);
    // An uncoded miss stays an uncoded error — the coded branch must not invent a code.
    const miss = await opReplyFor(() => resolveDomPoint({ selector: '#absent-1556' }, 'from'));
    expect(miss).toEqual({ error: expect.stringContaining('from: no element matches') });
  });

  it('label + selector is AMBIGUOUS, `within` alone is an error, an empty label matches nothing', () => {
    control('a.b.c', 'Go', { left: 10, top: 10, width: 80, height: 20 });
    expect(resolveDomPointReport({ label: 'Go', selector: '#x' })).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
    // #1556: selector + {x,y} too — `modoki_dnd`'s endpoint reaches here, and the selector used to win.
    expect(resolveDomPointReport({ selector: '[data-ui-id="a.b.c"]', x: 1, y: 1 })).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
    expect(resolveDomPointReport({ label: 'Go', x: 1, y: 1 })).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
    expect(resolveDomPointReport({ selector: '[data-ui-id="a.b.c"]', within: '.x' }).ok).toBe(false);
    // The empty-label guard, not the filter: without it '' "matches" nothing yet suggests EVERY label
    // (a substring of all of them) under a NOT_FOUND code. Asserting only ok:false could not tell.
    const empty = resolveDomPointReport({ label: '   ' });
    expect(empty).toMatchObject({ ok: false, error: 'label is empty — nothing to match' });
    expect(empty.code).toBeUndefined();
  });

  it('reports whether the resolved element is ADDRESSABLE by its data-ui-id — false when another shares it', () => {
    // Two crashed panels each render `panel-error.reload-panel`; focus re-finds by id (close-out).
    const hierarchy = document.createElement('div');
    hierarchy.setAttribute('data-panel-scope', 'hierarchy');
    const inspector = document.createElement('div');
    inspector.setAttribute('data-panel-scope', 'inspector');
    document.body.append(hierarchy, inspector);
    control('panel-error.reload-panel', 'Reload Panel', { left: 10, top: 10, width: 80, height: 20 }, hierarchy);
    const second = control('panel-error.reload-panel', 'Reload Panel', { left: 600, top: 10, width: 80, height: 20 }, inspector);
    stubTopmost(second);
    const r = resolveDomPointReport({ label: 'Reload Panel', within: '[data-panel-scope="inspector"]' });
    expect(r).toMatchObject({ ok: true, uiId: 'panel-error.reload-panel', uiIdAddressable: false });
    // …and unscoped, the AMBIGUOUS hint does not advise a selector that cannot separate them.
    const amb = resolveDomPointReport({ label: 'Reload Panel' });
    expect(amb.code).toBe('AMBIGUOUS');
    expect(amb.error).toMatch(/SHARE a data-ui-id/);
    expect(amb.error).not.toMatch(/aim by selector/);
  });

  it('addressability models focus\'s RAW lookup — a stamp copy that comes first makes the real tab unaddressable', () => {
    // `/api/input/focus` re-finds by a raw querySelector, so if a copy preceded the real element,
    // focus WOULD land on the copy. Reporting "addressable" there would be the false success.
    const stamps = document.createElement('div');
    stamps.className = 'flexlayout__layout_tab_stamps';
    document.body.appendChild(stamps);
    const copy = document.createElement('span');
    copy.setAttribute('data-ui-id', 'layout.tab.console');
    stamps.appendChild(copy);
    stubRect(copy, { left: 0, top: -9864, width: 60, height: 14 });
    const real = control('layout.tab.console', 'Console', { left: 300, top: 540, width: 60, height: 14 });
    stubTopmost(real);
    expect(resolveDomPointReport({ label: 'Console' })).toMatchObject({ ok: true, uiIdAddressable: false });
  });

  it('a uniquely-id\'d match is addressable', () => {
    const el = control('layout.tab.console', 'Console', { left: 300, top: 540, width: 60, height: 14 });
    stubTopmost(el);
    expect(resolveDomPointReport({ label: 'Console' })).toMatchObject({ ok: true, uiIdAddressable: true });
  });

  it('a label that exists only OUTSIDE `within` says so, rather than suggesting the label back', () => {
    control('layout.tab.console', 'Console', { left: 300, top: 540, width: 60, height: 14 });
    const assets = document.createElement('div');
    assets.setAttribute('data-panel-scope', 'assets');
    document.body.appendChild(assets);
    const r = resolveDomPointReport({ label: 'Console', within: '[data-panel-scope="assets"]' });
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(r.error).toMatch(/none is inside/);
    expect(r.error).not.toMatch(/Labels containing it/);
  });

  it('only CHROME handles are candidates — a canvas handle with the same label is not a DOM target', async () => {
    const { registerHandleProvider } = await import('@modoki/engine/runtime');
    // WITH an owner element, as every real canvas provider sets one (Dopesheet hands out its
    // container). An owner-less handle would be skipped by the Element check alone and could not
    // tell whether the `editor:'chrome'` scope is doing anything (mutation-checked).
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    stubRect(canvas, { left: 0, top: 0, width: 400, height: 300 });
    stubTopmost(canvas);
    const off = registerHandleProvider(() => [{ id: 'dope:key:0', kind: 'keyframe', editor: 'dopesheet', x: 50, y: 50, label: 'Console', owner: canvas }]);
    try {
      expect(resolveDomPointReport({ label: 'Console' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    } finally { off(); }
  });
});
