/** Guard: the Inspector offers an action for EVERY asset kind (#132).
 *
 *  Selecting an asset whose type is missing from `ASSET_TYPES_WITH_ACTIONS` drops the user on
 *  "No actions for <type> assets" — a dead end for a kind that, in every case so far, had a
 *  perfectly working editor behind it. That has now happened three times, each found by a
 *  human reading the type union rather than by anything failing:
 *
 *    - `video`    (#130) — backend + import settings, no Inspector view at all.
 *    - `timeline` (#132) — a dockable Timeline Editor with no door into it.
 *    - `shader`   — the inverse: `ShaderAssetView` rendered, and the stale list ALSO printed
 *                   "No actions for shader assets" underneath it.
 *
 *  The shader case is why this test asserts a two-way equality rather than mere coverage: a
 *  list that has drifted in either direction is wrong, and only one of those directions shows
 *  up as an empty panel.
 *
 *  What this canNOT see: whether the branch a listed type renders is any GOOD — only that the
 *  Inspector claims to handle it. A type could be listed here with an empty branch and pass.
 *  The e2e suite is where a real click is exercised. */
import { describe, it, expect } from 'vitest';
import { ASSET_TYPES } from '../../src/runtime/loaders/assetManifest';
import { ASSET_TYPES_WITH_ACTIONS } from '../../src/editor/panels/assetViews/assetActions';

describe('Inspector asset-type coverage (#132)', () => {
  it('every AssetType has an Inspector action', () => {
    const missing = ASSET_TYPES.filter((t) => !ASSET_TYPES_WITH_ACTIONS.includes(t));
    expect(
      missing,
      'these asset kinds fall through to "No actions for … assets" — add a branch in '
        + 'Inspector.tsx and list the type in ASSET_TYPES_WITH_ACTIONS',
    ).toEqual([]);
  });

  it('lists no asset kind that is not a real AssetType', () => {
    const bogus = ASSET_TYPES_WITH_ACTIONS.filter((t) => !(ASSET_TYPES as readonly string[]).includes(t));
    expect(
      bogus,
      'a listed type that no longer exists suppresses nothing and hides a rename',
    ).toEqual([]);
  });
});
