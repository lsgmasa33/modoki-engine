/** The shared post-FX trait enumeration (#324b) — `postfx/postFXTraitScan.ts`.
 *
 *  Two consumers read this module: `Scene3D`'s `buildReq` (which stages does the live stack run)
 *  and `prewarmShadersForWorld` (is a stack coming, so should the placeholder walk be skipped).
 *  The whole reason the module exists is that those two must never grow separate trait lists, so
 *  the guard at the bottom of this file asserts the enumeration is exhaustive rather than trusting
 *  a comment. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWorld, universe } from 'koota';
import { scanPostFXTraits, worldWillUseStack } from '../../src/runtime/rendering/postfx/postFXTraitScan';
import { NPRPostFX } from '../../src/runtime/traits/NPRPostFX';
import { BloomPostFX } from '../../src/runtime/traits/BloomPostFX';
import { VignettePostFX } from '../../src/runtime/traits/VignettePostFX';
import { DepthOfFieldPostFX } from '../../src/runtime/traits/DepthOfFieldPostFX';
import { AmbientOcclusionPostFX } from '../../src/runtime/traits/AmbientOcclusionPostFX';
import { setActiveQualityTier, setRenderSettings } from '../../src/runtime/rendering/renderSettings';
import { TIER_SETTINGS } from '../../src/runtime/rendering/qualityTier';

beforeEach(() => {
  // koota caps a process at 16 worlds and this file builds one per test — same reason
  // prewarmShaders.test.ts resets the registry.
  universe.reset();
});
afterEach(() => {
  setActiveQualityTier(null);
  setRenderSettings({});
});

const GPU = { isWebGPU: true };

/** Every post-FX trait, with a spawner. The list the tests iterate — if a trait is added to the
 *  scan and not here, the exhaustiveness guard at the bottom fails. */
const TRAITS = [
  { name: 'npr', spawn: (w: ReturnType<typeof createWorld>, enabled: boolean) => w.spawn(NPRPostFX({ enabled })) },
  { name: 'bloom', spawn: (w: ReturnType<typeof createWorld>, enabled: boolean) => w.spawn(BloomPostFX({ enabled })) },
  { name: 'vignette', spawn: (w: ReturnType<typeof createWorld>, enabled: boolean) => w.spawn(VignettePostFX({ enabled })) },
  { name: 'dof', spawn: (w: ReturnType<typeof createWorld>, enabled: boolean) => w.spawn(DepthOfFieldPostFX({ enabled })) },
  { name: 'ao', spawn: (w: ReturnType<typeof createWorld>, enabled: boolean) => w.spawn(AmbientOcclusionPostFX({ enabled })) },
] as const;

describe('worldWillUseStack — one post-FX trait at a time', () => {
  it('is false for a world with no post-FX trait at all', () => {
    expect(worldWillUseStack(createWorld(), GPU)).toBe(false);
  });

  for (const { name, spawn } of TRAITS) {
    it(`is true for an ENABLED ${name}`, () => {
      const w = createWorld();
      spawn(w, true);
      expect(worldWillUseStack(w, GPU)).toBe(true);
    });

    /** ⚠️ The load-bearing case, and the one an `enabled`-based predicate got wrong.
     *  `demos/postfx-demo` authors all five traits DISABLED and enables them from the Director's
     *  tour — which runs after the world swap, i.e. after this predicate is asked. Keying on
     *  `enabled` made the whole optimisation inert on the only project it exists for (measured:
     *  the prewarm still built its 9 wasted canvas-context node states). Presence is the strongest
     *  thing knowable before the swap. */
    it(`is true for a PRESENT-but-disabled ${name} — enabled is runtime state, presence is authored`, () => {
      const w = createWorld();
      spawn(w, false);
      expect(worldWillUseStack(w, GPU)).toBe(true);
    });
  }
});

describe('worldWillUseStack — the gates that can still say "no stack"', () => {
  it('is false on a WebGL2 fallback, where Scene3D never builds a stack', () => {
    const w = createWorld();
    w.spawn(BloomPostFX({ enabled: true }));
    expect(worldWillUseStack(w, { isWebGPU: false })).toBe(false);
  });

  it('is false when the active tier masks the only requested effect away', () => {
    // Author something for `low` to clamp with — the default tier table is a no-op (see
    // docs/rendering.md § "Quality tiers"), so without this the mask has nothing to do.
    setRenderSettings({ three: { tiers: { low: TIER_SETTINGS.low } } } as never);
    setActiveQualityTier({ tier: 'low', source: 'test', reason: 'test' } as never);
    const w = createWorld();
    w.spawn(NPRPostFX({ enabled: true }));
    expect(
      worldWillUseStack(w, GPU),
      'the low tier drops NPR, so the canvas-context prewarm is CORRECT there and must not be skipped',
    ).toBe(false);
  });

  it('is true on the tier that keeps the effect — the same world, the other arm', () => {
    setRenderSettings({ three: { tiers: { low: TIER_SETTINGS.low } } } as never);
    setActiveQualityTier({ tier: 'high', source: 'test', reason: 'test' } as never);
    const w = createWorld();
    w.spawn(NPRPostFX({ enabled: true }));
    expect(worldWillUseStack(w, GPU)).toBe(true);
  });
});

describe('scanPostFXTraits — what the live path reads', () => {
  it('reports an enabled trait as both present and configured', () => {
    const w = createWorld();
    w.spawn(BloomPostFX({ enabled: true, strength: 0.5, radius: 0.25, threshold: 0.75 }));
    const scan = scanPostFXTraits(w);
    expect(scan.present.bloom).toBe(true);
    expect(scan.bloom).toEqual({ strength: 0.5, radius: 0.25, threshold: 0.75 });
  });

  it('reports a disabled trait as present but NOT configured — the two halves are independent', () => {
    const w = createWorld();
    w.spawn(BloomPostFX({ enabled: false, strength: 0.5, radius: 0.25, threshold: 0.75 }));
    const scan = scanPostFXTraits(w);
    expect(scan.present.bloom).toBe(true);
    expect(scan.bloom).toBeNull();
  });

  it('is a SNAPSHOT — koota reuses the row object, so the scan must not alias it', () => {
    const w = createWorld();
    const e = w.spawn(BloomPostFX({ enabled: true, strength: 0.5, radius: 0.25, threshold: 0.75 }));
    const scan = scanPostFXTraits(w);
    e.set(BloomPostFX, { ...e.get(BloomPostFX)!, strength: 999 });
    expect(scan.bloom!.strength).toBe(0.5);
  });

  it('keeps the singleton rule — the FIRST entity carrying a trait wins, disabled or not', () => {
    const w = createWorld();
    w.spawn(BloomPostFX({ enabled: false }));
    w.spawn(BloomPostFX({ enabled: true, strength: 9 }));
    expect(scanPostFXTraits(w).bloom, 'a second entity is authoring error; silently preferring it would hide that').toBeNull();
  });
});

/** ⚠️ **THE SINGLE-SOURCE-OF-TRUTH GUARD.** `Scene3D.tsx`'s `buildReq` is not testable in
 *  isolation — it closes over the renderer, the active camera, the backend flag and a supersample
 *  debouncer, all of which only exist inside a mounted `useEffect`. So this asserts the property
 *  that actually matters instead: **`Scene3D.tsx` must not query a post-FX trait itself.** Every
 *  post-FX trait read goes through `scanPostFXTraits`, so the prewarm's predicate and the live
 *  request cannot drift.
 *
 *  If this fails, do NOT add the trait to a second list in `Scene3D.tsx` or in `scene3DSync.ts` —
 *  add it to `postFXTraitScan.ts` and let both consumers pick it up. A hand-maintained second
 *  enumeration is the exact failure this module was created to prevent (docs/rendering.md
 *  § "Shader prewarm and the first-frame compile"). */
describe('the trait enumeration lives in ONE place', () => {
  const TRAIT_NAMES = ['NPRPostFX', 'BloomPostFX', 'VignettePostFX', 'DepthOfFieldPostFX', 'AmbientOcclusionPostFX'];

  it('lists every post-FX trait the scan knows about', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/runtime/rendering/postfx/postFXTraitScan.ts', import.meta.url)),
      'utf8',
    );
    for (const t of TRAIT_NAMES) expect(src, `${t} must be scanned here`).toContain(`world.query(${t})`);
    // And the presence record must carry one key per trait, so a new trait cannot be scanned
    // without `worldWillUseStack` being forced to decide what it means.
    expect(Object.keys(scanPostFXTraits(createWorld()).present)).toHaveLength(TRAIT_NAMES.length);
  });

  it('is the only place Scene3D reads a post-FX trait from the world', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/runtime/rendering/Scene3D.tsx', import.meta.url)),
      'utf8',
    );
    for (const t of TRAIT_NAMES) {
      expect(src, `Scene3D must read ${t} through scanPostFXTraits, not with its own query`).not.toContain(`world.query(${t})`);
    }
    expect(src).toContain('scanPostFXTraits(world)');
  });

  it('is the only place the shader prewarm reads one either', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/runtime/rendering/scene3DSync.ts', import.meta.url)),
      'utf8',
    );
    for (const t of TRAIT_NAMES) {
      expect(src, `the prewarm must ask worldWillUseStack, not query ${t} itself`).not.toContain(`world.query(${t})`);
    }
    expect(src).toContain('worldWillUseStack(world');
  });
});
