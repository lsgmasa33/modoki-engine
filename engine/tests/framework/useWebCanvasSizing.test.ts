/** useWebCanvasSizing — pins the BOOT ORDERING the shipped web build depends on.
 *
 *  The pure geometry (computeContainerBox) is covered by webCanvasSizing.test.ts;
 *  what this file guards is WHEN the hook reads it. A project's render settings are
 *  injected mid-boot (initWorldSync → setRenderSettings), which lands AFTER this
 *  hook's first run — so a mount-time-only read silently serves the engine defaults
 *  and a `fixed` project renders full-bleed until something fires a resize. Measured
 *  on the shipped games/sling build (issue #25); the `configReady` dependency is the
 *  fix, and these tests fail if it is ever dropped back to `[]`. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { setRenderSettings, resetRenderSettings } from '@modoki/engine/runtime';
import { useWebCanvasSizing } from '../../app/useWebCanvasSizing';

/** jsdom's window is 1024×768 by default; set a viewport wide enough that a
 *  portrait 9:16 box is letterboxed on the X axis. */
function setViewport(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { value: w, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: h, writable: true, configurable: true });
}

const PORTRAIT = { sizeMode: 'fixed' as const, width: 1080, height: 1920 };

beforeEach(() => {
  resetRenderSettings();
  setViewport(1600, 1200);
});

afterEach(() => {
  resetRenderSettings();
});

describe('useWebCanvasSizing', () => {
  it('picks up settings injected AFTER mount, on the configReady flip', () => {
    // Mount while the settings are still the engine defaults — exactly what the
    // shipped shell does, since it renders a "Loading..." pass before boot finishes.
    const { result, rerender } = renderHook(({ ready }) => useWebCanvasSizing(ready), {
      initialProps: { ready: false },
    });
    expect(result.current.letterboxed).toBe(false); // default `free` — nothing to letterbox

    // Boot injects the project's rendering config, THEN flips configReady.
    act(() => { setRenderSettings({ web: PORTRAIT }); });
    rerender({ ready: true });

    // The regression: with `[]` deps this stayed { letterboxed: false }.
    const scale = Math.min(1600 / 1080, 1200 / 1920);
    expect(result.current).toEqual({
      cssWidth: Math.round(1080 * scale),
      cssHeight: Math.round(1920 * scale),
      letterboxed: true,
    });
  });

  it('still recomputes on window resize', () => {
    setRenderSettings({ web: PORTRAIT });
    const { result } = renderHook(() => useWebCanvasSizing(true));
    const first = result.current.cssHeight;

    act(() => {
      setViewport(1600, 600);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.cssHeight).toBeLessThan(first);
    expect(result.current.letterboxed).toBe(true);
  });

  it('leaves a `free` project filling the viewport', () => {
    setRenderSettings({ web: { sizeMode: 'free', width: 1280, height: 720 } });
    const { result } = renderHook(() => useWebCanvasSizing(true));
    expect(result.current).toEqual({ cssWidth: 1600, cssHeight: 1200, letterboxed: false });
  });

  it('removes its resize listener on unmount', () => {
    setRenderSettings({ web: PORTRAIT });
    const { unmount } = renderHook(() => useWebCanvasSizing(true));
    unmount();
    // A resize after unmount must not update state (React would warn/throw).
    act(() => { setViewport(800, 800); window.dispatchEvent(new Event('resize')); });
  });
});
