// @vitest-environment jsdom
/** forwardZoomWheel — the app UI-zoom Ctrl/Cmd+wheel decision. Pins: the modifier gate, the
 *  preventDefault+stopPropagation, the send payload, and (the regression fix) that a surface
 *  marked data-modki-wheel-zoom (the animation Curve Editor's value-axis zoom) is NOT hijacked. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { forwardZoomWheel } from '../../src/editor/input/zoomWheel';

afterEach(() => { document.body.innerHTML = ''; });

/** Dispatch a wheel on `target` through a capture-phase listener that runs the forwarder,
 *  mirroring how EditorApp attaches it. Returns the send spy + whether default was prevented.
 *
 *  `passive: false` is LOAD-BEARING and must match EditorApp.tsx:891. A `wheel` listener on
 *  window/document/body is passive BY DEFAULT (per the DOM spec, and in every real browser), and
 *  `preventDefault()` from a passive listener is silently ignored — which would let the browser
 *  page-zoom on Ctrl+wheel instead of the editor's UI zoom. jsdom 26 did not implement the passive
 *  default, so this helper omitted the flag and the `defaultPrevented` assertion below passed
 *  anyway; jsdom 30 does implement it, which is what exposed the drift. The production code was
 *  always right — the test simply was not mirroring it, despite this comment saying it did. */
function fire(target: Element, opts: { deltaY?: number; ctrl?: boolean; meta?: boolean }) {
  const bridge = { send: vi.fn() };
  const handler = (e: Event) => forwardZoomWheel(e as WheelEvent, bridge);
  window.addEventListener('wheel', handler, { capture: true, passive: false });
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

  /** The tests above attach their OWN listener, so they pin `forwardZoomWheel`'s behaviour but
   *  CANNOT see how EditorApp attaches it — dropping `passive: false` there would break Ctrl+wheel
   *  zoom in the real editor with every test above still green. That gap is exactly what jsdom 30
   *  exposed (see `fire`), so pin the attach site itself. A source scan rather than a mount:
   *  EditorApp is a large component whose effect needs an electronBridge, and the invariant is one
   *  line of options. */
  it('EditorApp attaches the wheel listener non-passively (else preventDefault is ignored)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/editor/EditorApp.tsx'),
      'utf8',
    );
    const attach = src.match(/addEventListener\(\s*'wheel'[^)]*\)/)?.[0];
    expect(attach, "EditorApp no longer attaches a 'wheel' listener — has the zoom moved?").toBeDefined();
    expect(attach, 'a wheel listener on window is passive BY DEFAULT; without an explicit ' +
      "`passive: false` its preventDefault() is ignored and the browser page-zooms instead").toContain('passive: false');
  });
});
