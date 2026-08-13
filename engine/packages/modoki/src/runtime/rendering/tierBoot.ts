/** Resolving a quality tier on a project that never mounts `Scene3D` (#203).
 *
 *  ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *  `resolveActiveTier` ran from exactly ONE place: `makeWebGPURenderer`. So a project with
 *  `disable3D: true` (`games/chess`, `games/audio-demo`) or `build.modules.render3d: false`
 *  (`games/space-invader`) built no renderer, resolved no tier, and left
 *  `getActiveQualityTier()` null for the whole process — with `getActiveTierOverrides()` returning
 *  `UNCLAMPED_OVERRIDES`. Every one of those projects was seeded with `rendering.three.tiers` by
 *  A4, and **every field in those configs has done nothing since.** #202 made it consequential by
 *  giving tiers a 2D DPR cap and a frame cap: the first two fields those projects would actually
 *  have benefited from.
 *
 *  It has a second half that the issue did not record, and it is the worse one:
 *  **`tickTierCalibration` is called from `Scene3D.tsx` and nowhere else.** So a 2D project has no
 *  live calibration either — it cannot be demoted when it drops frames, and it cannot be promoted
 *  when it turns out to have headroom. Resolving a tier at boot without fixing that would buy a
 *  first guess and no way to correct it, which on the unrecognised tail is the worse half.
 *
 *  ── WHY THIS IS CHEAP NOW, AND WAS NOT BEFORE ─────────────────────────────────────────────
 *  #203 was filed as needing "an explicit decision rather than a default", because the only Android
 *  classifier BUILT A THREE RENDERER — so a 2D project had to choose between a launch-blocking
 *  probe it had no use for and falling through to `low` forever. Two changes removed that fork:
 *    - **#210**: GPU identity answers for recognised hardware from a string, with no renderer, no
 *      probe and no frame. `getDeviceCaps` needs only a throwaway 1x1 WebGL2 context, which it
 *      already creates on every device.
 *    - **`rampWorkloadGL`**: the probe itself no longer needs Three, so the fallback is available
 *      to a 2D project too — with the FILL ramp as its deciding axis, since `pixiPixelRatioCap` is
 *      the only GPU knob a 2D tier moves and it is fill-rate bound.
 *
 *  ⚠️ **This module must NOT be imported by `Scene3D`'s path.** A 3D project resolves its tier
 *  exactly where it always did — inside `makeWebGPURenderer`, before the first drawing buffer is
 *  allocated — because `antialias` is a constructor option and a tier decided later cannot apply
 *  it. Resolving earlier from here would be harmless but pointless; resolving in BOTH places is
 *  merely idempotent (`resolveActiveTier` early-outs on an existing tier). What matters is that
 *  the 3D ordering is not disturbed. */

import { resolveActiveTierForNo3D } from './tierResolve';
import { registerFrameCallback, unregisterFrameCallback, PRIORITY_RENDER_2D } from './frameDriver';
import { tickTierCalibration, applyPendingTierPromotion } from './tierCalibration';

const CALIBRATION_KEY = 'tier-calibration-2d';

/** Resolve the tier for a project that will never mount a 3D surface, and start the live
 *  calibration loop that `Scene3D` would otherwise own.
 *
 *  Idempotent and safe to call unconditionally: `resolveActiveTier` early-outs once a tier exists,
 *  and re-registering the frame callback under the same key replaces rather than duplicates.
 *
 *  ⚠️ **Awaited at boot, deliberately.** The 2D backing-buffer scale is applied from the resolved
 *  tier, and a tier that arrives after `Canvas2DMount` has sized its first buffer would leave the
 *  first frames at the unclamped resolution — visible as a resolution pop on exactly the weak
 *  hardware the clamp exists for. The cost is ~0 ms for a recognised device (a string lookup) and
 *  the probe only for the unrecognised tail. */
export async function resolveTierForNo3DProject(): Promise<void> {
  // ⚠️ From `tierResolve`, NEVER from `scene3DSync` — that module imports `three/webgpu`, which is
  // the exact dependency `build.modules.render3d: false` removes and this whole change exists to
  // stop needing. A static import of it here would silently put the 3D renderer back into a 2D
  // bundle.
  await resolveActiveTierForNo3D();
  startTierCalibrationForNo3DProject();
}

/** Drive `tickTierCalibration` on a project with no `Scene3D` to drive it.
 *
 *  ⚠️ **`PRIORITY_RENDER_2D`, and it must not be `PRIORITY_ECS`.** The tick judges the frame
 *  profile, and the profile for a frame is only complete once that frame's work has been done —
 *  running it at ECS priority would judge the PREVIOUS frame while claiming to judge this one.
 *  `Scene3D` ticks it at the top of its own render callback for the same reason: what it reads is
 *  the profile as of the last completed frame either way, and the ordering only decides which
 *  frame that is.
 *
 *  ⚠️ The promotion is applied at a SCENE BOUNDARY, not here — see `applyPendingTierPromotion`.
 *  Calling it every frame is correct and cheap: it is a no-op unless something is queued. */
export function startTierCalibrationForNo3DProject(): void {
  registerFrameCallback(CALIBRATION_KEY, () => {
    tickTierCalibration();
    applyPendingTierPromotion();
  }, PRIORITY_RENDER_2D);
}

/** Tear the loop down — for a game swap, and for tests, which must not leak a callback into the
 *  next test's frame driver. */
export function stopTierCalibrationForNo3DProject(): void {
  unregisterFrameCallback(CALIBRATION_KEY);
}
