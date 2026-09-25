/**
 * The debug-build ad overrides (#1474, promoted in #1501, the mediation debugger #1500), over a FAKE
 * lifecycle: the wrapper decides only what reaches the lifecycle, so the fake records exactly that. The
 * wiring into each game's adapter is that game's `ads.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { bannerWanted, createAdDebug, DEBUG_PLACEMENT } from '../../../src/runtime/core/adDebug';
import type { AdLifecycle, FullscreenKind } from '../../../src/runtime/core/adLifecycle';

function fakeLifecycle(over: Partial<{ initialized: boolean; ready: boolean }> = {}) {
  const state = { initialized: over.initialized ?? true, ready: over.ready ?? true, showing: false };
  const life = {
    init: vi.fn(async () => {}),
    cleanup: vi.fn(),
    restoreAfterRealmSurvived: vi.fn(async () => {}),
    setBannerVisible: vi.fn((_v: boolean) => {}),
    showFullscreen: vi.fn(async (_k: FullscreenKind, _p: string) => true),
    isReady: vi.fn((_k: FullscreenKind) => state.ready),
    onRewardEarned: vi.fn(),
    isFullscreenShowing: vi.fn(() => state.showing),
    isInitialized: vi.fn(() => state.initialized),
    bannerFailures: vi.fn(() => 0),
  } satisfies AdLifecycle;
  return { life, state };
}

describe('adDebug — the defaults pass every game call through unchanged', () => {
  it('banner wish, show and readiness reach the lifecycle as asked', async () => {
    const { life } = fakeLifecycle();
    const d = createAdDebug(life);
    d.setBannerVisible(true);
    d.setBannerVisible(false);
    expect(life.setBannerVisible.mock.calls).toEqual([[true], [false]]);
    expect(await d.showFullscreen('interstitial', 'mid_level')).toBe(true);
    expect(life.showFullscreen).toHaveBeenCalledWith('interstitial', 'mid_level');
    expect(d.isReady('rewarded')).toBe(true);
  });

  it('readiness still follows the lifecycle — a kind not loaded is not ready', () => {
    const { life, state } = fakeLifecycle();
    const d = createAdDebug(life);
    state.ready = false;
    expect(d.isReady('interstitial')).toBe(false);
  });
});

describe('adDebug — a withheld kind', () => {
  it('reads not-ready and its game show never reaches the lifecycle, while Show now still does', async () => {
    const { life } = fakeLifecycle();
    const d = createAdDebug(life);
    d.setOverride({ interstitial: false });
    expect(d.isReady('interstitial')).toBe(false);
    expect(await d.showFullscreen('interstitial', 'mid_level')).toBe(false);
    expect(life.showFullscreen).not.toHaveBeenCalled();
    // The other kind is untouched.
    expect(d.isReady('rewarded')).toBe(true);
    // Loaded is the lifecycle's own answer, so the tab can still say an ad is there to show.
    expect(d.status().interstitialLoaded).toBe(true);

    expect(await d.showNow('interstitial')).toBe(true);
    expect(life.showFullscreen).toHaveBeenCalledWith('interstitial', DEBUG_PLACEMENT);
  });
});

describe('adDebug — the banner mode', () => {
  it('pins the game\'s wish either way, and a change applies without waiting for the game\'s next frame', () => {
    const { life } = fakeLifecycle();
    const d = createAdDebug(life);
    d.setBannerVisible(true);
    life.setBannerVisible.mockClear();

    d.setOverride({ banner: 'off' });
    expect(life.setBannerVisible).toHaveBeenLastCalledWith(false);
    d.setBannerVisible(true);
    expect(life.setBannerVisible).toHaveBeenLastCalledWith(false);

    d.setOverride({ banner: 'on' });
    d.setBannerVisible(false);
    expect(life.setBannerVisible).toHaveBeenLastCalledWith(true);
    expect(d.status().gameWantsBanner).toBe(false);

    // Back to auto re-applies the game's LAST wish at once — false here, not the forced true.
    d.setOverride({ banner: 'auto' });
    expect(life.setBannerVisible).toHaveBeenLastCalledWith(false);
  });

  it('bannerWanted', () => {
    expect([bannerWanted(true, 'auto'), bannerWanted(false, 'auto')]).toEqual([true, false]);
    expect([bannerWanted(false, 'on'), bannerWanted(true, 'off')]).toEqual([true, false]);
  });
});

describe('adDebug — one instance per game', () => {
  it('an override on one instance does not reach another', async () => {
    const a = fakeLifecycle();
    const b = fakeLifecycle();
    const da = createAdDebug(a.life);
    const db = createAdDebug(b.life);
    da.setOverride({ rewarded: false, banner: 'off' });
    expect(db.isReady('rewarded')).toBe(true);
    expect(await db.showFullscreen('rewarded', 'shortfall')).toBe(true);
    expect(db.status().override.banner).toBe('auto');
  });
});

describe('adDebug — the mediation debugger (#1500)', () => {
  it('opens through the hook once the SDK is initialized', async () => {
    const { life } = fakeLifecycle();
    const open = vi.fn(async () => ({ ok: true }));
    const d = createAdDebug(life, { openMediationDebugger: open });
    expect(d.hasMediationDebugger).toBe(true);
    expect(await d.openMediationDebugger()).toEqual({ opened: true, message: 'mediation debugger opened' });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('an uninitialized SDK — web, the editor, no key — says so and never calls the plugin', async () => {
    const { life } = fakeLifecycle({ initialized: false });
    const open = vi.fn(async () => ({ ok: true }));
    const d = createAdDebug(life, { openMediationDebugger: open });
    const r = await d.openMediationDebugger();
    expect(r.opened).toBe(false);
    expect(r.message).toMatch(/not initialized/);
    expect(open).not.toHaveBeenCalled();
  });

  it('a plugin that cannot, and one that throws, both resolve with the reason', async () => {
    const { life } = fakeLifecycle();
    const refused = createAdDebug(life, { openMediationDebugger: async () => ({ ok: false }) });
    expect(await refused.openMediationDebugger()).toEqual({ opened: false, message: 'the plugin could not open it on this platform' });
    const threw = createAdDebug(life, { openMediationDebugger: async () => { throw new Error('bridge gone'); } });
    expect(await threw.openMediationDebugger()).toEqual({ opened: false, message: 'mediation debugger failed: bridge gone' });
  });

  it('an SDK with no debugger hides the button and refuses the call', async () => {
    const { life } = fakeLifecycle();
    const d = createAdDebug(life);
    expect(d.hasMediationDebugger).toBe(false);
    expect((await d.openMediationDebugger()).opened).toBe(false);
  });
});
