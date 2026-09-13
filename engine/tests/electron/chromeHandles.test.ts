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

  describe('state — which segment of a tri-state control is active is DATA too', () => {
    it('reports data-ui-state as meta.state', () => {
      const { el, cx, cy } = tag('module-toggles.physics3d.off', { attrs: { 'data-ui-state': 'selected' } });
      stubHitTest([{ x: cx, y: cy, el }]);
      expect(byId('module-toggles.physics3d.off')!.meta).toEqual({ state: 'selected' });
    });

    it('an UNSET state carries no meta (the unselected segments are the common case)', () => {
      const { el, cx, cy } = tag('module-toggles.physics3d.auto');
      stubHitTest([{ x: cx, y: cy, el }]);
      expect(byId('module-toggles.physics3d.auto')!.meta).toBeUndefined();
    });

    it('state and disabled COMPOSE — one does not shadow the other', () => {
      // They shared one `meta` object, so whichever spread ran last used to win outright.
      const { el, cx, cy } = tag('m.seg.x', { attrs: { 'data-ui-state': 'selected', 'aria-disabled': 'true' } });
      stubHitTest([{ x: cx, y: cy, el }]);
      expect(byId('m.seg.x')!.meta).toEqual({ disabled: true, state: 'selected' });
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

    it('does NOT cap the label — the label aim/filter match the full text, the REPORT caps it (#1153)', () => {
      // The 60-char cap used to live here, which would make a long label unmatchable by its own
      // text. It moved to `computeHandles` (handlesDump.test.ts pins it there).
      const { el, cx, cy } = tag('p.r.long', { text: 'x'.repeat(200) });
      stubHitTest([{ x: cx, y: cy, el }]);
      expect(byId('p.r.long')!.label).toBe('x'.repeat(200));
    });
  });

  describe('live form state — read from the element, not an opt-in attribute (#1152)', () => {
    const field = (uiId: string, html: string) => {
      const wrap = document.createElement('div');
      wrap.innerHTML = html;
      const el = wrap.firstElementChild!;
      el.setAttribute('data-ui-id', uiId);
      document.body.appendChild(el);
      stubRect(el, { left: 10, top: 10 + document.body.children.length * 30, width: 50, height: 20 });
      return el;
    };

    it('reports an input\'s CURRENT value, including one typed after render', () => {
      const el = field('inspector.transform.x', '<input type="number" value="1">') as HTMLInputElement;
      el.value = '42.5'; // the live property, not the `value` attribute
      expect(byId('inspector.transform.x')!.meta).toEqual({ value: '42.5' });
    });

    it('reports a select\'s and a textarea\'s value', () => {
      field('ps.a.mode', '<select><option value="a">A</option><option value="b" selected>B</option></select>');
      const ta = field('ps.a.notes', '<textarea></textarea>') as HTMLTextAreaElement;
      ta.value = 'hello';
      expect(byId('ps.a.mode')!.meta).toEqual({ value: 'b' });
      expect(byId('ps.a.notes')!.meta).toEqual({ value: 'hello' });
    });

    it('a checkbox reports `checked`, not its constant form value', () => {
      const cb = field('ps.a.flag', '<input type="checkbox" value="on">') as HTMLInputElement;
      cb.checked = true;
      expect(byId('ps.a.flag')!.meta).toEqual({ checked: true });
    });

    it('a MIXED multi-select checkbox reports mixed, never a definite checked:false (close-out)', () => {
      // Inspector renders a differing bool as checked={false} + indeterminate.
      const cb = field('inspector.field.UIAnchor.safeArea', '<input type="checkbox">') as HTMLInputElement;
      cb.checked = false;
      cb.indeterminate = true;
      expect(byId('inspector.field.UIAnchor.safeArea')!.meta).toEqual({ mixed: true });
    });

    it('a MIXED text/number field is recognised by the placeholder it RENDERS — no marker needed (close-out)', () => {
      field('inspector.field.Transform.x', '<input type="text" placeholder="----">');
      field('inspector.field.Light.intensity', '<input type="number" placeholder="----">');
      field('inspector.field.Text2D.text', '<textarea placeholder="----"></textarea>');
      expect(byId('inspector.field.Transform.x')!.meta).toEqual({ mixed: true, value: '' });
      expect(byId('inspector.field.Light.intensity')!.meta).toEqual({ mixed: true, value: '' });
      expect(byId('inspector.field.Text2D.text')!.meta).toEqual({ mixed: true, value: '' });
    });

    it('…but an empty field with any OTHER placeholder, or a mixed one the agent has typed into, is not mixed', () => {
      field('hierarchy.toolbar.search', '<input type="text" placeholder="Search entities...">');
      const typed = field('inspector.field.Transform.y', '<input type="text" placeholder="----">') as HTMLInputElement;
      typed.value = '3';
      expect(byId('hierarchy.toolbar.search')!.meta).toEqual({ value: '' });
      expect(byId('inspector.field.Transform.y')!.meta).toEqual({ value: '3' });
    });

    it('a MIXED select is recognised by its selected placeholder option', () => {
      // TextureBatchView / MiniSelect: value '' with a MIXED_PLACEHOLDER option.
      field('assetView.texture.format', '<select><option value="" selected>----</option><option value="webp">WebP</option></select>');
      field('p.q.empty', '<select><option value="" selected>(none)</option><option value="a">A</option></select>');
      expect(byId('assetView.texture.format')!.meta).toEqual({ mixed: true, value: '' });
      expect(byId('p.q.empty')!.meta).toEqual({ value: '' });
    });

    it('a control that cannot show a placeholder (a range slider) says so with data-ui-mixed', () => {
      field('inspector.field.Light.intensity.slider', '<input type="range" min="0" max="10" value="0" data-ui-mixed="true">');
      expect(byId('inspector.field.Light.intensity.slider')!.meta).toEqual({ mixed: true, value: '0' });
    });

    it('a password is MASKED — the report lands in a transcript', () => {
      const pw = field('ai.settings.key', '<input type="password">') as HTMLInputElement;
      pw.value = 'sk-secret';
      expect(byId('ai.settings.key')!.meta).toEqual({ value: '•••' });
      expect(JSON.stringify(chromeHandles().map(({ owner: _o, ...h }) => h))).not.toContain('sk-secret');
    });

    it('caps a runaway value', () => {
      const ta = field('script.body.text', '<textarea></textarea>') as HTMLTextAreaElement;
      ta.value = 'y'.repeat(1000);
      expect((byId('script.body.text')!.meta!.value as string).length).toBe(200);
    });

    it('reports aria-expanded as a boolean, and composes with state/disabled', () => {
      field('assets.tree.folder', '<button aria-expanded="false" data-ui-state="closed" disabled>Folder</button>');
      expect(byId('assets.tree.folder')!.meta).toEqual({ disabled: true, state: 'closed', expanded: false });
    });

    it('a select is labelled by title/aria-label, never by its options run together', () => {
      // Measured live: the SceneView mode select labelled itself "3D2D" — its two options' text.
      field('sceneView.toolbar.mode', '<select title="View mode"><option>3D</option><option>2D</option></select>');
      field('p.q.bare', '<select><option>A</option><option>B</option></select>');
      expect(byId('sceneView.toolbar.mode')!.label).toBe('View mode');
      expect(byId('p.q.bare')!.label).toBeUndefined();
    });

    it('a plain button still carries NO meta — absence stays the common case', () => {
      field('inspector.header.delete', '<button>Delete</button>');
      expect(byId('inspector.header.delete')!.meta).toBeUndefined();
    });
  });

  it('REGRESSION: a FlexLayout tab STAMP (an offscreen rendered copy) is not a second handle (#1152)', () => {
    // FlexLayout renders every tab through onRenderTab twice: the real button, and a stamp inside
    // `.flexlayout__layout_tab_stamps` at y≈-9960. Measured live: every layout.tab.* id doubled.
    const real = tag('layout.tab.console', { tag: 'span', text: 'Console', rect: { left: 300, top: 540, width: 60, height: 14 } });
    const stamps = document.createElement('div');
    stamps.className = 'flexlayout__layout_tab_stamps';
    const copy = document.createElement('span');
    copy.setAttribute('data-ui-id', 'layout.tab.console');
    copy.textContent = 'Console';
    stamps.appendChild(copy);
    document.body.appendChild(stamps);
    stubRect(copy, { left: 0, top: -9864, width: 60, height: 14 });
    stubHitTest([{ x: real.cx, y: real.cy, el: real.el }]);
    const hits = chromeHandles().filter((h) => h.id === 'layout.tab.console');
    expect(hits).toHaveLength(1);
    expect(hits[0].owner).toBe(real.el);
  });

  it('…nor is a hidden tab\'s row in the OPEN overflow menu (close-out)', () => {
    const real = tag('layout.tab.skin-editor', { tag: 'span', text: '2D Skin', rect: { left: 562, top: 2, width: 56, height: 14 } });
    const menu = document.createElement('div');
    menu.setAttribute('data-layout-path', '/popup-menu');
    const row = document.createElement('div');
    row.setAttribute('data-layout-path', '/popup-menu/tb0');
    const copy = document.createElement('span');
    copy.setAttribute('data-ui-id', 'layout.tab.skin-editor');
    copy.textContent = '2D Skin';
    row.appendChild(copy);
    menu.appendChild(row);
    document.body.appendChild(menu);
    stubRect(copy, { left: 540, top: 30, width: 80, height: 18 }); // ON screen — the menu is open
    stubHitTest([{ x: real.cx, y: real.cy, el: real.el }]);
    expect(chromeHandles().filter((h) => h.id === 'layout.tab.skin-editor').map((h) => h.owner)).toEqual([real.el]);
  });

  it('…nor is the drag image FlexLayout mounts for one tick during a tab drag', () => {
    const real = tag('layout.tab.game', { tag: 'span', text: 'Game', rect: { left: 200, top: 540, width: 60, height: 14 } });
    const dragImage = document.createElement('div');
    dragImage.setAttribute('data-layout-path', '/drag-rectangle');
    const copy = document.createElement('span');
    copy.setAttribute('data-ui-id', 'layout.tab.game');
    dragImage.appendChild(copy);
    document.body.appendChild(dragImage);
    stubRect(copy, { left: -10000, top: -10000, width: 60, height: 14 });
    stubHitTest([{ x: real.cx, y: real.cy, el: real.el }]);
    expect(chromeHandles().filter((h) => h.id === 'layout.tab.game').map((h) => h.owner)).toEqual([real.el]);
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
