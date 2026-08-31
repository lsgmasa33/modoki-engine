// @vitest-environment jsdom
/** A playable ad never runs the boot ramp probe (#221 W2 item 5).
 *
 *  ⚠️ **THE PLAN CALLED THIS "make it explicit", AND THE GAP THAT PHRASE HIDES IS THE TEST.** Its
 *  reasoning was "one config ⇒ no probe covers most of it" — but that short-circuit is a PROJECT's
 *  choice (it fires only when exactly one tier config is authored, and the scaffolder's default is
 *  two), and it is not even consulted on the measure-and-log path, which runs the whole probe for
 *  EVIDENCE whenever `areDebugHandlesEnabled()`. Ten projects ship `build.debugBuild: true`, so the
 *  likely playable is precisely the one that pays.
 *
 *  Both call sites are therefore asserted separately. Testing only the `calibrating` one would have
 *  passed while the expensive path stayed open.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ProbeMeasurement } from '../../src/runtime/rendering/rampProbe';
import { probeVerdictStore, type CachedProbeVerdict } from '../../src/runtime/core/probeVerdictStore';
import {
  setRenderSettings, getRenderSettings, resetRenderSettings, getActiveQualityTier,
} from '../../src/runtime/rendering/renderSettings';
import { setBootProbeAllowed, isBootProbeAllowed } from '../../src/runtime/core/bootProbeAllowed';
import { setDebugHandlesEnabled } from '../../src/runtime/core/debugHandles';
import { resetProbeInFlightForTest } from '../../src/runtime/rendering/probeReentrancy';
import { resetDeviceCaps } from '../../src/runtime/rendering/deviceCaps';

const runBootRampProbe = vi.hoisted(() => vi.fn());
vi.mock('../../src/runtime/rendering/rampProbeRunner', () => ({ runBootRampProbe }));

const { resolveActiveTierForNo3D } = await import('../../src/runtime/rendering/tierResolve');

const BASE = getRenderSettings();

/** Two configs, so the single-config short-circuit does not answer instead of the resolver — which
 *  is exactly the case the plan's "one config ⇒ no probe" reasoning does not cover. */
const TWO_CONFIGS = {
  low: { pixelRatioCap: 1, shadows: false, antialias: false },
  mid: { pixelRatioCap: 1.5, shadows: true, antialias: false },
};

function fakeMeasurement(): ProbeMeasurement {
  const ramp = (kind: 'fill' | 'cpu', unitsPerMs: number) => ({
    kind, status: 'escaped' as const, unitsPerMs, bound: 'measured' as const, peakLoad: 8192,
    steps: [{ load: 4096, frameMs: 25 }, { load: 8192, frameMs: 55 }],
  });
  return {
    intervalMs: 16.7, clockKind: 'webgl2', axes: '2d',
    fill: ramp('fill', 2.81), cpu: ramp('cpu', 9_000),
    totalMs: 500, rendererMs: 0, compileMs: 5, shadeCompileMs: 0,
    bufferPixels: 1_000_000, shadeRegionPixels: 0,
  } as ProbeMeasurement;
}

beforeEach(() => {
  resetProbeInFlightForTest();
  resetDeviceCaps();
  resetRenderSettings();
  runBootRampProbe.mockReset();
  runBootRampProbe.mockResolvedValue(fakeMeasurement());
  probeVerdictStore.provide({
    read: () => null,
    write: vi.fn<(v: CachedProbeVerdict | null) => void>(),
    session: () => undefined,
  });
  setRenderSettings({
    ...BASE,
    three: { ...BASE.three, qualityTier: 'auto', tiers: TWO_CONFIGS as never },
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setBootProbeAllowed(true);
  setDebugHandlesEnabled(false);
  resetProbeInFlightForTest();
  probeVerdictStore.provide(null as never);
  setRenderSettings(BASE);
  vi.restoreAllMocks();
});

describe('setBootProbeAllowed (#221 W2 item 5)', () => {
  it('defaults to TRUE — a build that never sets it behaves as it always did', () => {
    // The opposite default fails silently and expensively: every unrecognised device would sit on
    // `calibrating` forever and nothing would error.
    expect(isBootProbeAllowed()).toBe(true);
  });

  it('⭐ refused: the probe does not run on the CALIBRATING path', async () => {
    setBootProbeAllowed(false);
    await resolveActiveTierForNo3D();
    expect(runBootRampProbe).not.toHaveBeenCalled();
  });

  it('⭐ refused: nor on the measure-and-log EVIDENCE path, which is the expensive one', async () => {
    // This is the call site the flag exists for. `debugBuild: true` ships on ten projects, and a
    // playable exported from one of them ran the full probe purely to log a verdict it discarded.
    setDebugHandlesEnabled(true);
    setBootProbeAllowed(false);
    await resolveActiveTierForNo3D();
    expect(runBootRampProbe).not.toHaveBeenCalled();
  });

  it('⚠️ a refused build still RESOLVES a tier — it is not left null', async () => {
    // The failure worth guarding against is not "it probed anyway", it is "it returned early and
    // published nothing" — which is #203's defect exactly: no tier, and `getActiveTierOverrides()`
    // unclamped for the whole process.
    setBootProbeAllowed(false);
    await resolveActiveTierForNo3D();

    const tier = getActiveQualityTier();
    expect(tier).not.toBeNull();
    expect(tier!.tier).toBeDefined();
    expect(tier!.reason.length).toBeGreaterThan(0);
  });

  it('allowed (the default): the probe DOES run on the same setup', async () => {
    // Non-vacuous control. Without it every assertion above would also pass on a build where the
    // probe could never run for an unrelated reason.
    await resolveActiveTierForNo3D();
    expect(runBootRampProbe).toHaveBeenCalled();
  });
});
