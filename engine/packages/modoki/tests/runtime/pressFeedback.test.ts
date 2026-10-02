// @vitest-environment jsdom
/** Press feedback (#2011) — a held UI button grows, and settles back on release.
 *
 *  Two layers: `resolvePress` (the per-button override against the scene default) and the
 *  document-level tracker that writes the CSS `scale` property (and its drift-correcting
 *  `translate`) on the press's own `[data-press-origin]` target, when that target is stamped. */
import { describe, it, expect, afterEach } from 'vitest';
import {
  resolvePress, pressTranslate, parseCssMatrix, installPressFeedback, UI_PRESS_SCALE_ATTR, UI_PRESS_MS_ATTR,
} from '../../src/runtime/ui/pressFeedback';

describe('resolvePress', () => {
  it('inherits the scene default when the button does not override it', () => {
    // Absent is what a scene-loaded UIAction carries; 0 is what the Inspector shows for it.
    expect(resolvePress(undefined, 1.08, 90)).toEqual({ scale: 1.08, ms: 90 });
    expect(resolvePress(0, 1.08, 90)).toEqual({ scale: 1.08, ms: 90 });
    expect(resolvePress(-1, 1.08, 90)).toEqual({ scale: 1.08, ms: 90 });
  });
  it('a per-button value wins over the scene default, both ways', () => {
    expect(resolvePress(1.2, 1.08, 90)).toEqual({ scale: 1.2, ms: 90 });
    expect(resolvePress(1.2, 1, 90)).toEqual({ scale: 1.2, ms: 90 });
  });
  it('1 is off, per button and scene-wide', () => {
    expect(resolvePress(1, 1.08, 90)).toBeNull();
    expect(resolvePress(undefined, 1, 90)).toBeNull();
  });
  it('a scene scale that would make the button vanish or is not a number is off', () => {
    expect(resolvePress(undefined, 0, 90)).toBeNull();
    expect(resolvePress(undefined, Number.NaN, 90)).toBeNull();
  });
  it('a game may shrink instead of grow', () => {
    expect(resolvePress(undefined, 0.92, 90)).toEqual({ scale: 0.92, ms: 90 });
  });
  it('a negative or non-finite duration is instant', () => {
    expect(resolvePress(-1, 1.08, -5)).toEqual({ scale: 1.08, ms: 0 });
  });
});

describe('pressTranslate — the visible centre stays put', () => {
  // A 200x100 box, scaled 1.08 about the default origin (its centre). The review measured a bare
  // `scale` moving a centred-pivot button's centre by (-8, -4) and a bottom-right one by (-16, -8).
  const s = 1.08;
  const close = (v: { x: number; y: number }, x: number, y: number) => {
    expect(v.x).toBeCloseTo(x, 6); expect(v.y).toBeCloseTo(y, 6);
  };
  it('no transform → no correction', () => {
    close(pressTranslate([1, 0, 0, 1, 0, 0], 100, 50, 200, 100, s), 0, 0);
  });
  it('a centred pivot (translate -50% -50%) is corrected by exactly the measured drift', () => {
    close(pressTranslate([1, 0, 0, 1, -100, -50], 100, 50, 200, 100, s), 8, 4);
  });
  it('a bottom-right pivot (translate -100% -100%)', () => {
    close(pressTranslate([1, 0, 0, 1, -200, -100], 100, 50, 200, 100, s), 16, 8);
  });
  it('a UIElement.scale about the pivot origin is folded in', () => {
    // translate(-50%,-50%) scale(2), origin at the pivot (= the centre here): v = (-100, -50).
    close(pressTranslate([2, 0, 0, 2, -100, -50], 100, 50, 200, 100, s), 8, 4);
    // Origin at the top-left (pivot 0,0 with a UIElement.scale of 2): the centre sits at 2x its
    // offset from the origin, so it needs twice the correction of an unscaled box.
    close(pressTranslate([2, 0, 0, 2, 0, 0], 0, 0, 200, 100, s), -16, -8);
  });
  it('the correction makes centre(pressed) == centre(unpressed) for an arbitrary matrix', () => {
    const m = [0.8, 0.6, -0.6, 0.8, -37, 12];   // a rotation plus a translate
    const [ox, oy, w, h] = [30, 20, 120, 80];
    const t = pressTranslate(m, ox, oy, w, h, s);
    const dx = w / 2 - ox, dy = h / 2 - oy;
    const v = { x: m[0] * dx + m[2] * dy + m[4], y: m[1] * dx + m[3] * dy + m[5] };
    close({ x: s * v.x + t.x, y: s * v.y + t.y }, v.x, v.y);
  });
});

describe('parseCssMatrix', () => {
  it('reads matrix(), keeps the 2D part of matrix3d(), and treats anything else as identity', () => {
    expect(parseCssMatrix('matrix(1, 0, 0, 1, -100, -50)')).toEqual([1, 0, 0, 1, -100, -50]);
    expect(parseCssMatrix('matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1)')).toEqual([2, 0, 0, 2, 5, 6]);
    expect(parseCssMatrix('none')).toEqual([1, 0, 0, 1, 0, 0]);
    expect(parseCssMatrix('')).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

function pointer(type: string, target: Element, isPrimary = true, button = 0) {
  // jsdom has no PointerEvent constructor; the tracker reads `isPrimary`, `button`, the target
  // and the client point.
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, button });
  Object.defineProperty(e, 'isPrimary', { value: isPrimary });
  target.dispatchEvent(e);
}

describe('installPressFeedback', () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.(); dispose = null; document.body.innerHTML = '';
    delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  const STAMP = `data-press-origin ${UI_PRESS_SCALE_ATTR}="1.1" ${UI_PRESS_MS_ATTR}="90"`;

  function mount() {
    document.body.innerHTML = `
      <div id="root">
        <div id="button" ${STAMP}><span id="label">Go</span></div>
        <div id="plain"></div>
      </div>`;
    dispose = installPressFeedback(document.getElementById('root')!);
    return {
      button: document.getElementById('button') as HTMLElement,
      label: document.getElementById('label')!,
      plain: document.getElementById('plain')!,
    };
  }

  it("a press on a child grows the press's own target, and release clears it", () => {
    const { button, label } = mount();
    pointer('pointerdown', label);
    expect(button.style.getPropertyValue('scale')).toBe('1.1');
    expect(button.style.getPropertyValue('transition')).toContain('90ms');
    pointer('pointerup', label);
    expect(button.style.getPropertyValue('scale')).toBe('');
  });

  it('a cancelled press (a touch that became a scroll) releases too', () => {
    const { button, label } = mount();
    pointer('pointerdown', label);
    pointer('pointercancel', label);
    expect(button.style.getPropertyValue('scale')).toBe('');
  });

  it('a second finger neither presses nor releases the held button', () => {
    const { button, label, plain } = mount();
    pointer('pointerdown', label);
    pointer('pointerdown', plain, false);
    pointer('pointerup', plain, false);
    expect(button.style.getPropertyValue('scale')).toBe('1.1');
  });

  it('a press on an unstamped element scales nothing', () => {
    const { button, plain } = mount();
    pointer('pointerdown', plain);
    expect(button.style.getPropertyValue('scale')).toBe('');
    expect(plain.style.getPropertyValue('scale')).toBe('');
  });

  it('a non-primary mouse button (a right-click) does not press', () => {
    const { button, label } = mount();
    pointer('pointerdown', label, true, 2);
    expect(button.style.getPropertyValue('scale')).toBe('');
  });

  it('a press on a control INSIDE a stamped element grows nothing — that control takes the press', () => {
    // A slider/toggle/swallow panel carries the press-origin marker and no press scale. Walking
    // past it to the stamped scrim behind grew a whole dialog for a volume drag (review).
    document.body.innerHTML = `
      <div id="root">
        <div id="scrim" ${STAMP}><div id="panel" data-press-origin><input id="slider" type="range"></div></div>
      </div>`;
    dispose = installPressFeedback(document.getElementById('root')!);
    pointer('pointerdown', document.getElementById('slider')!);
    expect(document.getElementById('scrim')!.style.getPropertyValue('scale')).toBe('');
  });

  it('a tap-zone press vetoed to a neighbour grows the NEIGHBOUR, the one that gets the click', () => {
    document.body.innerHTML = `
      <div id="root">
        <div id="a" ${STAMP}><div id="zone" data-tap-zone></div></div>
        <div id="b" ${STAMP}></div>
      </div>`;
    dispose = installPressFeedback(document.getElementById('root')!);
    const zone = document.getElementById('zone')!;
    const b = document.getElementById('b')!;
    // The hit stack under the overlap: the zone on top, the sibling button beneath it.
    (document as { elementsFromPoint?: unknown }).elementsFromPoint = () => [zone, b];
    pointer('pointerdown', zone);
    expect(b.style.getPropertyValue('scale')).toBe('1.1');
    expect(document.getElementById('a')!.style.getPropertyValue('scale')).toBe('');
  });

  it('a pressable covering half the UI root or more is a backdrop and never grows', () => {
    const { button, label } = mount();
    // Layout size (offsetWidth/Height), which jsdom reports as 0 unless told.
    const size = (el: HTMLElement, w: number, h: number) => {
      Object.defineProperty(el, 'offsetWidth', { configurable: true, value: w });
      Object.defineProperty(el, 'offsetHeight', { configurable: true, value: h });
    };
    size(document.getElementById('root')!, 400, 800);
    size(button, 400, 800);
    pointer('pointerdown', label);
    expect(button.style.getPropertyValue('scale')).toBe('');
    // A catcher in flow under a top bar: full width, 83% of the height (Court's HintCatcher).
    pointer('pointerup', label);
    size(button, 400, 664);
    pointer('pointerdown', label);
    expect(button.style.getPropertyValue('scale')).toBe('');
    // ...while the same element at button size does grow.
    pointer('pointerup', label);
    size(button, 60, 60);
    pointer('pointerdown', label);
    expect(button.style.getPropertyValue('scale')).toBe('1.1');
  });

  it('a second install keeps the listeners AND the backdrop rule alive when the first is disposed', () => {
    const { button, label } = mount();
    const root = document.getElementById('root')!;
    const second = installPressFeedback(root);
    dispose!(); dispose = second;
    pointer('pointerdown', label);
    expect(button.style.getPropertyValue('scale')).toBe('1.1');
    pointer('pointerup', label);
    // The root is still registered, so a backdrop is still recognised.
    for (const el of [root, button]) {
      Object.defineProperty(el, 'offsetWidth', { configurable: true, value: 400 });
      Object.defineProperty(el, 'offsetHeight', { configurable: true, value: 800 });
    }
    pointer('pointerdown', label);
    expect(button.style.getPropertyValue('scale')).toBe('');
  });

  it('writes the drift-correcting translate from the resolved transform, and clears it on release', () => {
    // jsdom resolves neither the matrix nor the origin, so the computed style is stubbed with what
    // a browser returns for a 200x100 button anchored with a centred pivot.
    const { button, label } = mount();
    Object.defineProperty(button, 'offsetWidth', { configurable: true, value: 200 });
    Object.defineProperty(button, 'offsetHeight', { configurable: true, value: 100 });
    const real = window.getComputedStyle;
    window.getComputedStyle = ((el: Element) => (el === button
      ? { transform: 'matrix(1, 0, 0, 1, -100, -50)', transformOrigin: '100px 50px 0px' }
      : real(el))) as typeof window.getComputedStyle;
    try {
      pointer('pointerdown', label);
      const [tx, ty] = button.style.getPropertyValue('translate').split(' ').map(parseFloat);
      // scale 1.1 here: (1.1 - 1) x (100, 50) = (10, 5).
      expect(tx).toBeCloseTo(10, 6);
      expect(ty).toBeCloseTo(5, 6);
      pointer('pointerup', label);
      expect(button.style.getPropertyValue('translate')).toBe('');
    } finally { window.getComputedStyle = real; }
  });

  it('disposing the last install releases a press still held', () => {
    const { button, label } = mount();
    pointer('pointerdown', label);
    dispose!(); dispose = null;
    expect(button.style.getPropertyValue('scale')).toBe('');
  });
});
