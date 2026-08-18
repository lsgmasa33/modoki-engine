// @vitest-environment jsdom
/** A project with no 3D surface resolves a quality tier, and calibrates live (#203).
 *
 *  ⚠️ **THE DEFECT THESE PIN IS NOT A CRASH — IT IS SILENCE.** `chess`, `audio-demo` and
 *  `space-invader` each carry a full `rendering.three.tiers` config and each behaved as though it
 *  had none, because `resolveActiveTier` ran only from `makeWebGPURenderer` and they build no
 *  renderer. Nothing errored, the Inspector showed every field, and the tier did nothing. So the
 *  assertions below are deliberately about a tier EXISTING and a callback being REGISTERED, which
 *  is exactly the "mechanism that cannot fire" shape this repo keeps producing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveTierForNo3DProject, resolveTierBeforeSceneLoad, startTierCalibrationForNo3DProject,
  stopTierCalibrationForNo3DProject,
} from '../../src/runtime/rendering/tierBoot';
import {
  getActiveQualityTier, setRenderSettings, getRenderSettings, getActiveTierOverrides,
} from '../../src/runtime/rendering/renderSettings';
import { __resetFrameDriverForTests, stepOneFrame } from '../../src/runtime/rendering/frameDriver';
import * as calibration from '../../src/runtime/rendering/tierCalibration';
import { resetDeviceCaps } from '../../src/runtime/rendering/deviceCaps';

const BASE = getRenderSettings();

/** Two configs, so the `single-config` short-circuit does not answer instead of the resolver —
 *  that gate returns `high` for "nothing to choose between", which would make every assertion here
 *  pass without the tier ever being decided. */
const TWO_CONFIGS = {
  low: { pixelRatioCap: 1, shadows: false, antialias: false },
  mid: { pixelRatioCap: 1.5, shadows: true, antialias: false },
};

beforeEach(() => {
  resetDeviceCaps();
  __resetFrameDriverForTests();
  setRenderSettings({
    ...BASE,
    three: { ...BASE.three, qualityTier: 'auto', tiers: TWO_CONFIGS as never },
  });
});

afterEach(() => {
  stopTierCalibrationForNo3DProject();
  __resetFrameDriverForTests();
  setRenderSettings(BASE);
  vi.restoreAllMocks();
});

describe('resolveTierForNo3DProject', () => {
  it('⭐ resolves a tier where a 2D project previously resolved NONE', async () => {
    // jsdom has no WebGL2 and no GameDebug plugin, so identity cannot answer and the probe cannot
    // run — i.e. the WORST case, and still the tier must exist. Before this change the answer here
    // was `null`, forever, and `getActiveTierOverrides()` returned the unclamped default.
    await resolveTierForNo3DProject();

    const tier = getActiveQualityTier();
    expect(tier).not.toBeNull();
    expect(tier!.tier).toBeDefined();
    // And the reason is populated, because this is the value `diagnose` shows a human who is
    // asking why their phone looks like that.
    expect(typeof tier!.reason).toBe('string');
    expect(tier!.reason.length).toBeGreaterThan(0);
  });

  it('the resolved tier actually reaches the runtime overrides', async () => {
    // Resolving without applying is the #202 defect exactly: `setActiveQualityTier` records a tier
    // and applies nothing, which was invisible while a tier only clamped Three knobs that happened
    // to be read on the next line. A tier that is decided and not applied is the same as no tier.
    await resolveTierForNo3DProject();
    expect(getActiveTierOverrides()).toBeDefined();
  });

  it('⭐ STARTS the calibration loop as part of booting — not merely offering to', async () => {
    // Caught by mutation: deleting `startTierCalibrationForNo3DProject()` from the boot function
    // left every other test in this file green, because they all called it directly. The boot path
    // is the only caller in production, so the wiring between the two IS the feature — a resolver
    // that hands back a tier and no way to correct it is the half-fix this module rejects.
    const tick = vi.spyOn(calibration, 'tickTierCalibration');
    stepOneFrame();
    expect(tick).not.toHaveBeenCalled();

    await resolveTierForNo3DProject();
    stepOneFrame();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second call does not re-resolve or throw', async () => {
    await resolveTierForNo3DProject();
    const first = getActiveQualityTier();
    await resolveTierForNo3DProject();
    expect(getActiveQualityTier()).toEqual(first);
  });
});

describe('⚠️ resolving before the project\'s tiers are loaded — the ordering trap', () => {
  it('whatever it decides against an empty config is STICKY for the session', async () => {
    // FOUND ON DEVICE, not here: the boot call sat one block ahead of `initWorldSync()` in
    // `App.tsx`, which is where `setRenderSettings(projectConfig.rendering)` runs. With settings
    // still at their defaults `three.tiers` is empty, the resolver's "one config ⇒ nothing to
    // choose between" gate fires, and the project ships UNCLAMPED — on a Galaxy A23 running
    // space-invader that showed up as not one probe line across a wiped launch.
    //
    // This test does not assert the fix (the ordering lives in the app shell). It pins the HAZARD,
    // so that anyone moving that call has the failure spelled out rather than having to rediscover
    // it on hardware.
    setRenderSettings({ ...BASE, three: { ...BASE.three, qualityTier: 'auto', tiers: {} as never } });
    await resolveTierForNo3DProject();
    const early = getActiveQualityTier();
    expect(early).not.toBeNull();

    // Now the project's real configs arrive, as they would one block later in `App.tsx`. NOTHING
    // RE-RESOLVES — that is the whole hazard, and it is why the ordering is load-bearing rather
    // than untidy. Whatever was decided against the empty config is what the session ships with.
    setRenderSettings({ ...BASE, three: { ...BASE.three, qualityTier: 'auto', tiers: TWO_CONFIGS as never } });
    await resolveTierForNo3DProject();
    expect(getActiveQualityTier()).toEqual(early);
  });
});

describe('live calibration on a project with no Scene3D', () => {
  it('⭐ TICKS the calibration loop — the half of #203 the issue did not record', () => {
    // `tickTierCalibration` is called from `Scene3D.tsx:358` and nowhere else, so a 2D project had
    // no live calibration in EITHER direction: it could not be demoted when it dropped frames and
    // could not be promoted when it had headroom. Resolving a tier at boot without this would buy
    // a first guess with no way to correct it.
    //
    // Asserted by DRIVING A FRAME, not by checking that something was registered: a callback in a
    // map proves registration, and registration under a key the driver never visits is precisely
    // the unreachable-mechanism failure this test exists to rule out.
    const tick = vi.spyOn(calibration, 'tickTierCalibration');
    const apply = vi.spyOn(calibration, 'applyPendingTierPromotion');

    stepOneFrame();
    expect(tick).not.toHaveBeenCalled();   // non-vacuity: nothing ticks before the loop starts

    startTierCalibrationForNo3DProject();
    stepOneFrame();
    expect(tick).toHaveBeenCalledTimes(1);
    // ⚠️ AND IT MUST NOT APPLY A QUEUED PROMOTION PER FRAME (#227). This assertion used to be
    // `expect(apply).toHaveBeenCalledTimes(1)`, justified as "a no-op unless one is queued" — true
    // of the empty case and false of the one that matters: with a promotion queued, a per-frame
    // call applied it on the NEXT FRAME, mid-play and uncovered, which is exactly what deferring
    // to a scene boundary exists to prevent. A 2D project's boundary is the world swap
    // (`onWorldSwap` in tierCalibration.ts); a deliberate mid-play application goes behind the
    // tier-switch overlay instead.
    expect(apply).not.toHaveBeenCalled();

    // Registering twice must REPLACE, not duplicate: the boot path is idempotent and a game swap
    // re-enters it. Two callbacks would double-count nothing here, but they would leak one.
    startTierCalibrationForNo3DProject();
    stepOneFrame();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('stop() removes it, so a game swap cannot leak a callback into the next game', () => {
    const tick = vi.spyOn(calibration, 'tickTierCalibration');
    startTierCalibrationForNo3DProject();
    stepOneFrame();
    expect(tick).toHaveBeenCalledTimes(1);

    stopTierCalibrationForNo3DProject();
    stepOneFrame();
    expect(tick).toHaveBeenCalledTimes(1);   // unchanged — the loop really is gone

    // Unregistering something already gone is a no-op, not an error: the teardown runs on paths
    // where the loop was never started.
    expect(() => stopTierCalibrationForNo3DProject()).not.toThrow();
  });
});

describe('resolveTierBeforeSceneLoad (#212 — the ORDERING fix)', () => {
  it('⭐ resolves a tier for a 3D project, before any renderer exists', async () => {
    // The defect it fixes is invisible in this test's own assertion and worth naming: a 3D project
    // used to resolve ONLY inside `makeWebGPURenderer`, so a tier knob read by the ASSET path
    // (`textureMaxSize`, #212) arrived after the scene's textures had already picked their URLs.
    // Measured on a Galaxy A23 pinned `low`: 0 of 21 textures fetched the capped variant.
    await resolveTierBeforeSceneLoad();
    expect(getActiveQualityTier()).not.toBeNull();
  });

  it('does NOT start the calibration loop — Scene3D owns that on a 3D project', async () => {
    // Starting it here would double-drive `tickTierCalibration` once Scene3D registers its own.
    const tick = vi.spyOn(calibration, 'tickTierCalibration');
    await resolveTierBeforeSceneLoad();
    stepOneFrame();
    expect(tick).not.toHaveBeenCalled();
  });

  it('is idempotent with the renderer-side resolve — whichever runs first wins', async () => {
    await resolveTierBeforeSceneLoad();
    const first = getActiveQualityTier();
    await resolveTierBeforeSceneLoad();
    expect(getActiveQualityTier()).toBe(first);
  });
});
