/** Unit tests for the canonical asset-type order (assetTypeIcons.tsx) — the
 *  SINGLE source of truth shared by the Assets panel's category (list) view
 *  section order AND the type-filter dropdown, so the two never drift. */

import { describe, it, expect } from 'vitest';
import { ASSET_TYPE_ORDER, compareAssetTypes, ASSET_TYPE_COLORS } from '../../src/editor/panels/assetTypeIcons';
import { JSON_ASSET_SUFFIX_TYPE, BINARY_EXT_TYPE } from '../../src/runtime/loaders/assetTypeClassifier';

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

/** ASSET_TYPE_ORDER's docstring claims to be the "SINGLE source of truth" for asset types, but
 *  self-coherence checks above (ORDER ⊆ COLORS, no dupes) never related either list back to what
 *  the classifier (`loaders/assetTypeClassifier.ts`) actually PRODUCES — which is how `audio`,
 *  `video`, `level`, `wave`, `timeline` and `court-level` silently fell through: real asset types
 *  that rendered grey ('#888', the unknown-type fallback) with no glyph and sorted last (#417). */
describe('ASSET_TYPE_ORDER / ASSET_TYPE_COLORS cover every classifier-produced type (#417)', () => {
  /** Types the classifier can produce that ARE deliberately absent from ORDER/COLORS. Empty
   *  today — add a type here, with a reason, only when leaving it out is an intentional
   *  decision, not the same oversight this guard exists to catch. */
  const DELIBERATELY_UNCOVERED = new Set<string>();

  const producedTypes = [...new Set<string>([
    ...JSON_ASSET_SUFFIX_TYPE.map(([, type]) => type),
    ...Object.values(BINARY_EXT_TYPE),
  ])].filter((type) => !DELIBERATELY_UNCOVERED.has(type));

  it('every produced type appears in ASSET_TYPE_ORDER', () => {
    const missing = producedTypes.filter((type) => !ASSET_TYPE_ORDER.includes(type));
    expect(
      missing,
      'These asset types are produced by the classifier (loaders/assetTypeClassifier.ts) but '
        + 'missing from ASSET_TYPE_ORDER in editor/panels/assetTypeIcons.tsx — they sort last '
        + 'with no declared display position. Add them to ASSET_TYPE_ORDER, or list them in this '
        + 'test\'s DELIBERATELY_UNCOVERED with a reason.',
    ).toEqual([]);
  });

  it('every produced type has a badge color in ASSET_TYPE_COLORS', () => {
    const missing = producedTypes.filter((type) => !(type in ASSET_TYPE_COLORS));
    expect(
      missing,
      'These asset types are produced by the classifier but missing from ASSET_TYPE_COLORS in '
        + 'editor/panels/assetTypeIcons.tsx — they render grey (\'#888\', the unknown-type '
        + 'fallback) in the Assets panel. Add them to ASSET_TYPE_COLORS, or list them in this '
        + 'test\'s DELIBERATELY_UNCOVERED with a reason.',
    ).toEqual([]);
  });
});
