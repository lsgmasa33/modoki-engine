// @vitest-environment jsdom
/** Unit: the `[data-ui-id]` → InteractionHandle walker (Enact Phase 2).
 *
 *  Editor chrome joins the EXISTING handle registry rather than getting a parallel system,
 *  so `modoki_tap_handle {id}` drives a panel button with zero new input tools. What this
 *  file pins is the part that makes a handle trustworthy: a handle you cannot actually
 *  click must never be offered as if you could.
 *
 *  jsdom has no layout (every rect is zero) and no real `elementFromPoint`, so both are
 *  stubbed. The arithmetic and the guards are what's under test; occlusion under REAL
 *  layout is Electron-verified, per the plan's working agreements. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chromeHandles } from '../../app/debug/chromeHandles';

function stubRect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () => ({
    left: r.left, top: r.top, width: r.width, height: r.height,
    right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => ({}),
  }) as DOMRect;
}

/** elementFromPoint returns the element registered as topmost at that exact point. */
function stubHitTest(at: Array<{ x: number; y: number; el: Element | null }>) {
  document.elementFromPoint = (x: number, y: number) => (at.find((h) => h.x === x && h.y === y)?.el ?? null) as Element;
}

/** Add a tagged element with a real-looking rect that hit-tests to itself. */
function tag(uiId: string, opts: { tag?: string; rect?: { left: number; top: number; width: number; height: number }; attrs?: Record<string, string>; text?: string } = {}) {
  const el = document.createElement(opts.tag ?? 'button');
  el.setAttribute('data-ui-id', uiId);
  for (const [k, v] of Object.entries(opts.attrs ?? {})) el.setAttribute(k, v);
  if (opts.text) el.textContent = opts.text;
  document.body.appendChild(el);
  const r = opts.rect ?? { left: 100, top: 50, width: 20, height: 10 };
  stubRect(el, r);
  return { el, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
}

const byId = (id: string) => chromeHandles().find((h) => h.id === id);

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { vi.restoreAllMocks(); });

describe('chromeHandles', () => {
  it('returns nothing when no element is tagged', () => {
    document.body.appendChild(document.createElement('button'));
    expect(chromeHandles()).toEqual([]);
  });

  it('reports a tagged element as a chrome handle with centre, rect, and its owning element', () => {
    const { el, cx, cy } = tag('inspector.health.menu', { rect: { left: 300, top: 40, width: 14, height: 14 } });
    stubHitTest([{ x: cx, y: cy, el }]);

    expect(chromeHandles()).toEqual([{
      id: 'inspector.health.menu',
      kind: 'button',
      editor: 'chrome',
      x: 307, y: 47,
      rect: { x: 300, y: 40, w: 14, h: 14 },
      owner: el, // computeHandles hit-tests this, then strips it before serialization
    }]);
  });

  it('does NOT compute occlusion itself — that belongs to the registry, for EVERY handle', () => {
    // Occlusion is a property of anything addressed by coordinate, not a DOM-chrome
    // feature. Computing it here made `occludedCount` a chrome-only metric that read as
    // global, so a canvas keyframe under a modal looked clickable.
    const { el, cx, cy } = tag('inspector.health.menu');
    const menu = document.createElement('div');
    document.body.appendChild(menu);
    stubHitTest([{ x: cx, y: cy, el: menu }]); // something covers it
    expect(byId('inspector.health.menu')!.occludedBy).toBeUndefined();
    expect(byId('inspector.health.menu')!.owner).toBe(el);
  });

  it('rect is present so an agent can compute overlap and aim off-centre', () => {
    const { el, cx, cy } = tag('a.b.c', { rect: { left: 10, top: 20, width: 100, height: 30 } });
    stubHitTest([{ x: cx, y: cy, el }]);
    expect(byId('a.b.c')!.rect).toEqual({ x: 10, y: 20, w: 100, h: 30 });
  });

  it('REGRESSION: a zero-rect (collapsed panel / unmounted tab) element is NOT offered', () => {
    // Reporting it would give it coordinates (0,0), and tap_handle would click the window
    // corner — exactly the silent miss the whole phase exists to eliminate. An empty
    // `handles` result is the correct signal to open the panel first.
    tag('assets.toolbar.reimport', { rect: { left: 0, top: 0, width: 0, height: 0 } });
    stubHitTest([]);
    expect(chromeHandles()).toEqual([]);
  });




  describe('disabled — a greyed control is DATA, not a shade of grey in a JPEG', () => {
    it('detects a real disabled <button>', () => {
      const { el, cx, cy } = tag('inspector.health.paste');
      (el as HTMLButtonElement).disabled = true;
      stubHitTest([{ x: cx, y: cy, el }]);
      expect(byId('inspector.health.paste')!.meta).toEqual({ disabled: true });
    });

    it('detects aria-disabled and the data-ui-disabled escape hatch for styled divs', () => {
      const a = tag('m.a.x', { attrs: { 'aria-disabled': 'true' } });
      const b = tag('m.b.x', { tag: 'div', attrs: { 'data-ui-disabled': 'true' }, rect: { left: 0, top: 200, width: 10, height: 10 } });
      stubHitTest([{ x: a.cx, y: a.cy, el: a.el }, { x: b.cx, y: b.cy, el: b.el }]);
      expect(byId('m.a.x')!.meta).toEqual({ disabled: true });
      expect(byId('m.b.x')!.meta).toEqual({ disabled: true });
    });

    it('an ENABLED control carries no disabled meta (absence is the common case)', () => {
      const { el, cx, cy } = tag('m.c.x', { attrs: { 'aria-disabled': 'false' } });
      stubHitTest([{ x: cx, y: cy, el }]);
      expect(byId('m.c.x')!.meta).toBeUndefined();
    });
  });

  describe('kind and label', () => {
    it('kind defaults to the tag name, and data-ui-kind overrides it', () => {
      const a = tag('p.r.a');
      const b = tag('p.r.b', { tag: 'div', attrs: { 'data-ui-kind': 'menu-item' }, rect: { left: 0, top: 300, width: 10, height: 10 } });
      stubHitTest([{ x: a.cx, y: a.cy, el: a.el }, { x: b.cx, y: b.cy, el: b.el }]);
      expect(byId('p.r.a')!.kind).toBe('button');
      expect(byId('p.r.b')!.kind).toBe('menu-item');
    });

    it('label prefers data-ui-label, then the element text, then title', () => {
      const a = tag('p.r.a', { text: 'Copy Component', attrs: { 'data-ui-label': 'Copy' } });
      const b = tag('p.r.b', { text: '  Paste   Values  ', rect: { left: 0, top: 300, width: 10, height: 10 } });
      const c = tag('p.r.c', { attrs: { title: 'Health options' }, rect: { left: 0, top: 400, width: 10, height: 10 } });
      stubHitTest([{ x: a.cx, y: a.cy, el: a.el }, { x: b.cx, y: b.cy, el: b.el }, { x: c.cx, y: c.cy, el: c.el }]);
      expect(byId('p.r.a')!.label).toBe('Copy');
      expect(byId('p.r.b')!.label).toBe('Paste Values'); // whitespace collapsed
      expect(byId('p.r.c')!.label).toBe('Health options');
    });

    it('truncates a runaway label rather than dumping a panel of text into the result', () => {
      const { el, cx, cy } = tag('p.r.long', { text: 'x'.repeat(200) });
      stubHitTest([{ x: cx, y: cy, el }]);
      expect(byId('p.r.long')!.label!.length).toBe(58); // 57 + ellipsis
      expect(byId('p.r.long')!.label!.endsWith('…')).toBe(true);
    });
  });

  it('skips an element whose data-ui-id is empty', () => {
    tag('', {});
    expect(chromeHandles()).toEqual([]);
  });

  it('reports every tagged element, in document order', () => {
    const a = tag('one', { rect: { left: 0, top: 0, width: 10, height: 10 } });
    const b = tag('two', { rect: { left: 0, top: 100, width: 10, height: 10 } });
    stubHitTest([{ x: a.cx, y: a.cy, el: a.el }, { x: b.cx, y: b.cy, el: b.el }]);
    expect(chromeHandles().map((h) => h.id)).toEqual(['one', 'two']);
  });
});
