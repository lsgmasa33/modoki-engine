/** Wiring-integrity check for every P7 provider slot: importing `loaders/registerProviders.ts`
 *  (which `runtime/index.ts` imports once, for side effect) must leave EVERY slot provided.
 *  Complements the per-slot unit coverage in `providerSlot.test.ts` — this is the "did we
 *  actually wire this one up" check the design's D-d note called for, so a future slot added
 *  without a `registerProviders.ts` registration fails loudly here instead of silently
 *  warn-once-returning-null in production. */

import { describe, it, expect } from 'vitest';
import '../../src/runtime/loaders/registerProviders';

import { particleDefProvider } from '../../src/runtime/particles/particleDefProvider';
import { textureProvider } from '../../src/runtime/core/textureProvider';
import { assetPlumbing } from '../../src/runtime/core/assetPlumbing';
import { animationAssetProvider } from '../../src/runtime/animation/assetProviders';
import { audioAssetProvider } from '../../src/runtime/audio/audioAssetProvider';
import { rig2dProvider } from '../../src/runtime/skinning/rig2dProvider';
import { materialProvider } from '../../src/runtime/rendering/materialProvider';
import { meshColliderProvider } from '../../src/runtime/physics/meshColliderProvider';
import { timelineAssetProvider } from '../../src/runtime/timeline/assetProvider';
import { domFontProvider } from '../../src/runtime/core/domFontProvider';

describe('registerProviders wiring', () => {
  it.each([
    ['particleDefProvider', particleDefProvider],
    ['textureProvider', textureProvider],
    ['assetPlumbing', assetPlumbing],
    ['animationAssetProvider', animationAssetProvider],
    ['audioAssetProvider', audioAssetProvider],
    ['rig2dProvider', rig2dProvider],
    ['materialProvider', materialProvider],
    ['meshColliderProvider', meshColliderProvider],
    ['timelineAssetProvider', timelineAssetProvider],
    // domFontProvider was missing from this list — deleting its registerProviders.ts.provide()
    // call reds nothing here today (#803's close reading of this suite's own claim to cover
    // "every P7 provider slot"). Without it, resolveUIFontFamily's GUID branch always warns and
    // falls through, silently, in production — the exact failure mode this suite exists to catch.
    ['domFontProvider', domFontProvider],
  ])('%s is provided once registerProviders.ts has run', (_name, slot) => {
    expect(slot.isProvided()).toBe(true);
    expect(slot.get()).not.toBeNull();
  });
});
