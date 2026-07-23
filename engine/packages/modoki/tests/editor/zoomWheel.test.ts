// @vitest-environment jsdom
/** forwardZoomWheel — the app UI-zoom Ctrl/Cmd+wheel decision. Pins: the modifier gate, the
 *  preventDefault+stopPropagation, the send payload, and (the regression fix) that a surface
 *  marked data-modki-wheel-zoom (the animation Curve Editor's value-axis zoom) is NOT hijacked. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { forwardZoomWheel } from '../../src/editor/input/zoomWheel';

afterEach(() => { document.body.innerHTML = ''; });

/** Dispatch a wheel on `target` through a capture-phase listener that runs the forwarder,
 *  mirroring how EditorApp attaches it. Returns the send spy + whether default was prevented. */
function fire(target: Element, opts: { deltaY?: number; ctrl?: boolean; meta?: boolean }) {
  const bridge = { send: vi.fn() };
  const handler = (e: Event) => forwardZoomWheel(e as WheelEvent, bridge);
  window.addEventListener('wheel', handler, { capture: true });
  const e = new WheelEvent('wheel', {
    deltaY: opts.deltaY ?? -120, ctrlKey: !!opts.ctrl, metaKey: !!opts.meta, bubbles: true, cancelable: true,
  });
  target.dispatchEvent(e);
  window.removeEventListener('wheel', handler, { capture: true } as EventListenerOptions);
  return { send: bridge.send, defaultPrevented: e.defaultPrevented };
}

describe('forwardZoomWheel', () => {
  it('forwards a Ctrl+wheel as a zoom intent and consumes the event', () => {
    const el = document.body.appendChild(document.createElement('div'));
    const { send, defaultPrevented } = fire(el, { ctrl: true, deltaY: -120 });
    expect(send).toHaveBeenCalledWith('zoom', { deltaY: -120 });
    expect(defaultPrevented).toBe(true);
  });

  it('forwards a Cmd(meta)+wheel too', () => {
    const el = document.body.appendChild(document.createElement('div'));
    const { send } = fire(el, { meta: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ignores a plain (unmodified) wheel — panels keep their own scroll/dolly', () => {
    const el = document.body.appendChild(document.createElement('div'));
    const { send, defaultPrevented } = fire(el, { ctrl: false, meta: false });
    expect(send).not.toHaveBeenCalled();
    expect(defaultPrevented).toBe(false);
  });

  it('does NOT hijack a surface that owns modified-wheel (data-modki-wheel-zoom)', () => {
    const owner = document.body.appendChild(document.createElement('div'));
    owner.setAttribute('data-modki-wheel-zoom', '');
    const child = owner.appendChild(document.createElement('canvas')); // the curve canvas
    const { send, defaultPrevented } = fire(child, { ctrl: true });
    expect(send).not.toHaveBeenCalled();   // left for the Curve Editor's value-axis zoom
    expect(defaultPrevented).toBe(false);
  });
});
