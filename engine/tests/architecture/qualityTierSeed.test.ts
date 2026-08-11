/** The quality-tier SEED cannot drift from the engine's measured tables.
 *
 *  `engine/scripts/seed-quality-tiers.mjs` writes `rendering.three.tiers` into a project, and it
 *  is a `.mjs` script so it cannot import the engine's TypeScript — its values are a hand-copy of
 *  `TIER_SETTINGS`. A copy that can drift from its source is the code-shadows-the-source-of-truth
 *  failure this repo warns about repeatedly, so this pins them together: change a measured value
 *  in the engine without changing the seeder and this goes red.
 *
 *  ⚠️ **THE GUARD IS ON THE SEED, NOT ON THE PROJECTS, AND THAT IS THE WHOLE POINT.** It would be
 *  easy — and wrong — to assert that every project's authored `tiers` still equals `TIER_SETTINGS`.
 *  That would forbid the one thing the authored-tiers feature exists for: a project tuning its own
 *  degradation (docs/rendering.md § "Quality tiers"). Seeded values are a STARTING POINT;
 *  the moment an author changes one, this test must stay quiet. */

import { describe, it, expect } from 'vitest';
import { TIER_SETTINGS } from '@modoki/engine/runtime';
// @ts-expect-error — a plain .mjs script with no type declarations; only its data is used here.
import { SEED, needsSeed, backfillTiers } from '../../scripts/seed-quality-tiers.mjs';

describe('the quality-tier seed mirrors the engine tables', () => {
  it('seeds `mid` exactly as the engine measured it', () => {
    expect(SEED.mid).toEqual(TIER_SETTINGS.mid);
  });

  it('seeds `low` exactly as the engine measured it', () => {
    expect(SEED.low).toEqual(TIER_SETTINGS.low);
  });

  it('does NOT seed a `default`/`high` entry — the default is the ABSENCE of clamping', () => {
    // Plan §2.1. A stored `high` config would be a second, redundant source for "no clamping"
    // and the first thing to drift from `UNCLAMPED_OVERRIDES`.
    expect(Object.keys(SEED).sort()).toEqual(['low', 'mid']);
  });
});

describe('which projects the seeder touches', () => {
  const three = (over: Record<string, unknown> = {}) => ({ rendering: { three: { qualityTier: 'auto', ...over } } });

  it('seeds a project relying on auto', () => {
    expect(needsSeed(three())).toBe(true);
    expect(needsSeed({ rendering: { three: {} } })).toBe(true);   // absent qualityTier means auto
  });

  it('leaves a project that already authors tiers ALONE — it may have been tuned', () => {
    expect(needsSeed(three({ tiers: { low: { pixelRatioCap: 1 } } }))).toBe(false);
  });

  it('leaves a PINNED project alone — it already made the decision', () => {
    // A seeded ladder it never consults would be noise in the config file.
    expect(needsSeed(three({ qualityTier: 'high' }))).toBe(false);
    expect(needsSeed(three({ qualityTier: 'low' }))).toBe(false);
  });

  it('is idempotent: a project it just seeded is skipped on a second run', () => {
    const cfg = three() as { rendering: { three: Record<string, unknown> } };
    expect(needsSeed(cfg)).toBe(true);
    cfg.rendering.three.tiers = structuredClone(SEED);
    expect(needsSeed(cfg)).toBe(false);
  });
});

describe('backfilling fields a project seeded before they existed', () => {
  it('adds an absent key without touching a value the project already tuned', () => {
    const mid = { ...structuredClone(SEED.mid), targetFps: 15 };
    delete (mid as Partial<typeof SEED.mid>).pixiAntialias;
    const tiers = { mid, low: structuredClone(SEED.low) };

    const added = backfillTiers(tiers);

    expect(added).toEqual(['mid.pixiAntialias']);
    expect(tiers.mid.targetFps).toBe(15);                        // tuned value left alone
    expect(tiers.mid.pixiAntialias).toBe(SEED.mid.pixiAntialias); // absent key filled from SEED
  });

  it('only backfills a tier the project actually authored', () => {
    const mid = structuredClone(SEED.mid);
    delete (mid as Partial<typeof SEED.mid>).targetFps;
    const tiers = { mid };                                        // no `low` authored at all

    const added = backfillTiers(tiers);

    expect(added).toEqual(['mid.targetFps']);
    expect(tiers).not.toHaveProperty('low');                      // not manufactured here
  });

  it('is a no-op on a config already carrying every SEED key — idempotent', () => {
    const tiers = { mid: structuredClone(SEED.mid), low: structuredClone(SEED.low) };
    expect(backfillTiers(tiers)).toEqual([]);
  });
});
