/** Unit tests for the canonical asset-type order (assetTypeIcons.tsx) — the
 *  SINGLE source of truth shared by the Assets panel's category (list) view
 *  section order AND the type-filter dropdown, so the two never drift. */

import { describe, it, expect } from 'vitest';
import { ASSET_TYPE_ORDER, compareAssetTypes, ASSET_TYPE_COLORS } from '../../src/editor/panels/assetTypeIcons';

describe('compareAssetTypes', () => {
  it('sorts known types by canonical pipeline order, not alphabetically', () => {
    // 'scene' precedes 'model' precedes 'texture' precedes 'script' in ASSET_TYPE_ORDER,
    // which is NOT alphabetical (a plain sort would put material < model < scene < script < texture).
    const input = ['texture', 'script', 'scene', 'model'];
    expect([...input].sort(compareAssetTypes)).toEqual(['scene', 'model', 'texture', 'script']);
  });

  it('matches the declared ASSET_TYPE_ORDER when the full set is sorted', () => {
    const shuffled = [...ASSET_TYPE_ORDER].reverse();
    expect(shuffled.sort(compareAssetTypes)).toEqual([...ASSET_TYPE_ORDER]);
  });

  it('sorts unknown types last', () => {
    expect(compareAssetTypes('scene', 'zzz-unknown')).toBeLessThan(0);
    expect(compareAssetTypes('zzz-unknown', 'script')).toBeGreaterThan(0);
  });

  it('falls back to alphabetical for two unknown types', () => {
    expect(compareAssetTypes('banana', 'apple')).toBeGreaterThan(0);
    expect(compareAssetTypes('apple', 'banana')).toBeLessThan(0);
  });

  it('is a stable comparator (equal types compare to 0)', () => {
    expect(compareAssetTypes('material', 'material')).toBe(0);
    expect(compareAssetTypes('unknown', 'unknown')).toBe(0);
  });
});

describe('ASSET_TYPE_ORDER / ASSET_TYPE_COLORS coherence', () => {
  it('every canonical type has a badge color (kept in sync)', () => {
    for (const type of ASSET_TYPE_ORDER) {
      expect(ASSET_TYPE_COLORS[type], `missing color for "${type}"`).toBeDefined();
    }
  });

  it('has no duplicate entries', () => {
    expect(new Set(ASSET_TYPE_ORDER).size).toBe(ASSET_TYPE_ORDER.length);
  });
});
