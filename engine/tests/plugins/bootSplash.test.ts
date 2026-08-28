/** The WEB boot splash (#396 follow-on).
 *
 *  The plugin's image work is covered by `splashCompose.test.ts` (it shares `overlayLayersFor`
 *  with the native pass, which is the point). What is pinned here is the part that can regress
 *  silently: the markup that has to cover the boot, and the z-order that decides whether an error
 *  or an OTA download can be seen underneath it.
 *
 *  The dismissal itself is DOM behaviour and lives in `engine/app/ui/bootSplash.ts`; it is
 *  exercised here against jsdom because it is nine lines of element handling whose failure mode —
 *  a launch image that never goes away — is the worst outcome this feature can have, and it is
 *  what a build actually got wrong in review. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootSplashMarkup, BOOT_SPLASH_FILE } from '../../plugins/bootSplash';

describe('bootSplashMarkup', () => {
  const html = bootSplashMarkup('/boot-splash.webp', '#0a0a1a');

  it('covers the whole viewport, fixed, so a scrolled page cannot reveal what is under it', () => {
    expect(html).toContain('position:fixed');
    expect(html).toContain('inset:0');
  });

  it('paints a background COLOUR as well as the image — the image has not decoded on first paint', () => {
    expect(html).toContain('background-color:#0a0a1a');
    expect(html).toContain("background-image:url('/boot-splash.webp')");
  });

  it('uses cover, which is how both platforms show their own launch image', () => {
    expect(html).toContain('background-size:cover');
    expect(html).toContain('background-position:center');
  });

  it('outranks the loading overlay (1000) and the OTA restart gate (1100)', () => {
    const z = Number(/z-index:(\d+)/.exec(html)?.[1]);
    expect(z).toBeGreaterThan(1100);
  });

  it('never swallows input — the game may already be interactive underneath', () => {
    expect(html).toContain('pointer-events:none');
  });

  it('carries the id the app dismisses it by, and a transition to dismiss it with', () => {
    expect(html).toContain('id="modoki-boot-splash"');
    expect(html).toContain('transition:opacity');
  });

  it('is a single self-contained element — no stylesheet, which would be another round trip', () => {
    expect(html.startsWith('<div')).toBe(true);
    expect(html.endsWith('</div>')).toBe(true);
    expect(html).not.toContain('<style');
    expect(html).not.toContain('<link');
  });

  it('names the asset the plugin emits', () => {
    expect(BOOT_SPLASH_FILE).toBe('boot-splash.webp');
  });
});

describe('dismissBootSplash', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    document.body.innerHTML = bootSplashMarkup('/boot-splash.webp', '#0a0a1a');
  });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

  const load = async () => import('../../app/ui/bootSplash');

  it('fades the element out and then REMOVES it', async () => {
    const { dismissBootSplash } = await load();
    dismissBootSplash();
    const el = document.getElementById('modoki-boot-splash');
    expect(el?.style.opacity).toBe('0');
    // Still present during the fade — removing it instantly would cut rather than dissolve.
    expect(document.getElementById('modoki-boot-splash')).not.toBeNull();
    vi.runAllTimers();
    expect(document.getElementById('modoki-boot-splash')).toBeNull();
  });

  it('is safe to call when there is no boot splash at all (dev, editor, no splashSource)', async () => {
    document.body.innerHTML = '';
    const { dismissBootSplash } = await load();
    expect(() => dismissBootSplash()).not.toThrow();
  });

  it('is idempotent — several boot paths call it and none may throw on the second', async () => {
    const { dismissBootSplash } = await load();
    dismissBootSplash();
    vi.runAllTimers();
    expect(() => dismissBootSplash()).not.toThrow();
    expect(document.getElementById('modoki-boot-splash')).toBeNull();
  });

  it('has a backstop DEADLINE — the paths that strand it are the ones nobody enumerates', async () => {
    // Found in review: `<ErrorBoundary>`'s fallback renders INSIDE GameShell, i.e. underneath a
    // z-1500 element, and the boot path awaits rAFs that never fire in a backgrounded tab. Both
    // end with a user staring at a launch image that means "crashed". App.tsx arms this on mount.
    const { BOOT_SPLASH_TIMEOUT_MS } = await load();
    expect(BOOT_SPLASH_TIMEOUT_MS).toBeGreaterThan(5_000);  // a slow cold install must not trip it
    expect(BOOT_SPLASH_TIMEOUT_MS).toBeLessThanOrEqual(30_000); // …but it must actually fire
  });

  it('reports whether a boot splash is on screen, and stops reporting once dismissed', async () => {
    const { dismissBootSplash, hasBootSplash } = await load();
    expect(hasBootSplash()).toBe(true);
    dismissBootSplash();
    expect(hasBootSplash()).toBe(false);
  });
});
