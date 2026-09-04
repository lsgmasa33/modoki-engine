/** Declarative quality-tier control — `registerQualityControls`'s `quality.set` UIAction
 *  (runtime/actions/qualityControls.ts). Mirrors audioDeclarative.test.ts's shape: register the
 *  built-in action, dispatch it in a bare koota world, and assert on the resulting state — here
 *  that's `getPlayerQualityTier()`, backed by the `playerTierStore` provider slot (mirrors the
 *  install pattern in playerQualityTier.test.ts; unprovided it reads null and every assertion
 *  would pass vacuously). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `onRendererLost` is required — frameDriver.ts subscribes to it UNCONDITIONALLY at module load
// (the GPU-fault latch for #590 defect 3/6), so an incomplete mock throws "No onRendererLost
// export" the moment anything here transitively imports frameDriver.
vi.mock('../../src/runtime/core/activeRenderer', () => ({ getActiveRenderer: () => null, onRendererLost: () => () => {} }));
vi.mock('../../src/runtime/rendering/resizeBus', () => ({ forceResizeAllSurfaces: () => {} }));
vi.mock('../../src/runtime/core/frameProfiler', async (orig) => {
  const actual = await orig<typeof import('../../src/runtime/core/frameProfiler')>();
  return { ...actual, getFrameProfile: () => mockProfile };
});

import { createWorld } from 'koota';
import { playerTierStore } from '../../src/runtime/core/playerTierStore';
import { getPlayerQualityTier, setPlayerQualityTier } from '../../src/runtime/rendering/playerQualityTier';
import { resetRenderSettings } from '../../src/runtime/rendering/renderSettings';
import { resetTierCalibration } from '../../src/runtime/rendering/tierCalibration';
import { registerQualityControls } from '../../src/runtime/actions/qualityControls';
import { dispatchUIAction, type UIActionPayload } from '../../src/runtime/core/actionRegistry';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { getPlayState, setPlayState } from '../../src/runtime/core/playState';
import { BUDGET_30FPS_MS, type FrameProfile } from '../../src/runtime/core/frameProfiler';

let stored: 'low' | 'mid' | 'high' | null = null;
const stat = (v: number) => ({ median: v, p95: v, min: v, max: v });
const mockProfile: FrameProfile = {
  samples: 120, frameMs: stat(10), cpuMs: stat(4), restMs: stat(6), fps: 100,
  vsyncBound: false, overBudget: false, budgetMs: BUDGET_30FPS_MS, discontinuities: 0, worstStallMs: 0,
};

const prevState = getPlayState();

beforeEach(() => {
  stored = null;
  playerTierStore.reset();
  playerTierStore.provide({ read: () => stored, write: (t) => { stored = t; } });
  resetRenderSettings();
  resetTierCalibration();
  registerQualityControls(); // idempotent — registerUIAction just overwrites the entry
  setCurrentWorld(createWorld());
  setPlayState('playing'); // dispatchUIAction is inert unless the sim is running
});

afterEach(() => {
  setPlayState(prevState);
});

/** ⚠️ THE TWO DISPATCH SHAPES ARE THE TWO AUTHORINGS, and testing only one would leave half the
 *  action unreachable from a scene without any test noticing.
 *
 *  `UIActionPayload` is `string | number`, so an OBJECT can never reach a handler from authored
 *  scene JSON — `ui/bindings.ts` routes a binding's `params` to `ctx.params` and puts only the live
 *  event value (or a single authored `params.payload`) in `ctx.payload`. A handler reading
 *  `payload.tier` would therefore be dead on every real binding while passing a test that hands it
 *  an object directly. So these mirror what `bindings.ts` actually delivers, nothing else. */
const byParams = (tier: unknown) => dispatchUIAction('quality.set', { params: { tier } });
const byPayload = (v: UIActionPayload) => dispatchUIAction('quality.set', { payload: v });

describe('quality.set', () => {
  it('a real tier persists AND applies — a button per tier, `params: { tier }`', () => {
    byParams('mid');
    expect(getPlayerQualityTier()).toBe('mid');
  });

  it('takes the tier from `payload` too — one picker emitting `$value`', () => {
    // `{ tier: '$value' }` resolves to the live event value, which bindings.ts delivers as
    // ctx.payload rather than ctx.params. Same control, same action, different arrival.
    byPayload('high');
    expect(getPlayerQualityTier()).toBe('high');
  });

  it("'auto' clears the override, from either authoring", () => {
    setPlayerQualityTier('high');
    byParams('auto');
    expect(getPlayerQualityTier()).toBeNull();

    setPlayerQualityTier('high');
    byPayload('auto');
    expect(getPlayerQualityTier()).toBeNull();
  });

  it.each<[string, unknown]>([
    ['an unrecognised tier string', 'ultra'],
    ['nothing at all', undefined],
    ['the wrong type', 7],
    ["the OBJECT shape that cannot be authored", { tier: 'low' }],
  ])('a garbage value (%s) leaves the previous choice unchanged', (_label, value) => {
    setPlayerQualityTier('mid');
    byParams(value);
    expect(getPlayerQualityTier()).toBe('mid');
  });
});
