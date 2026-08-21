/** QA-INSP-0011 — the SpritePicker's per-texture "whole" shortcut used to assign
 *  `deriveGuid('sprite:' + texGuid)` for EVERY texture group, but the asset scanner emits
 *  that whole-image sprite only for a texture with NO explicit slices. On a sliced sheet the
 *  button therefore committed a GUID with no manifest entry — a dead ref, silently.
 *
 *  These tests pin the gate: offer the shortcut iff the whole-image sprite is actually in the
 *  listing. The sliced case is the regression; the unsliced case guards against over-fixing
 *  it into "never offer the shortcut at all". */

import { describe, it, expect } from 'vitest';
import { groupSpritesByTexture, wholeImageSpriteGuid, wholeImageSpriteRef, sortGroupsByName } from '../../src/editor/panels/spritePickerGroups';
import type { AssetEntry } from '../../src/runtime/loaders/assetManifest';

const TEX = 'aaaaaaaa-1111-4111-8111-111111111111';
const rect = { x: 0, y: 0, w: 8, h: 8 };

const sprite = (guid: string, name: string, texture = TEX): AssetEntry => ({
  guid, path: `/assets/sheet.png#${guid}`, name, type: 'sprite',
  sprite: { texture, name, rect, pivot: { x: 0.5, y: 0.5 } },
} as AssetEntry);

describe('groupSpritesByTexture', () => {
  it('offers no "whole" shortcut for a texture that only has explicit slices', () => {
    const groups = groupSpritesByTexture([sprite('s1', 'slime_0'), sprite('s2', 'slime_1')]);
    const g = groups.get(TEX)!;
    expect(g.sprites).toHaveLength(2);
    // The regression: this used to be the derived guid regardless, and nothing backed it.
    expect(g.wholeGuid).toBeUndefined();
  });

  it('offers the shortcut when the manifest really carries the whole-image sprite', () => {
    const whole = wholeImageSpriteGuid(TEX);
    const groups = groupSpritesByTexture([sprite(whole, 'sheet')]);
    expect(groups.get(TEX)!.wholeGuid).toBe(whole);
  });

  it('groups per texture and ignores non-sprite / guid-less entries', () => {
    const other = 'bbbbbbbb-2222-4222-8222-222222222222';
    const groups = groupSpritesByTexture([
      sprite('s1', 'a'),
      sprite(wholeImageSpriteGuid(other), 'b', other),
      { path: '/assets/sheet.png', name: 'sheet', type: 'texture', guid: TEX } as AssetEntry,
      { path: '/x#1', name: 'x', type: 'sprite', sprite: { texture: TEX, name: 'x', rect, pivot: { x: 0, y: 0 } } } as unknown as AssetEntry, // no guid — the shape the guard exists for
    ]);
    expect([...groups.keys()].sort()).toEqual([TEX, other].sort());
    expect(groups.get(TEX)!.sprites).toHaveLength(1);
    expect(groups.get(TEX)!.wholeGuid).toBeUndefined();
    expect(groups.get(other)!.wholeGuid).toBe(wholeImageSpriteGuid(other));
  });
});

describe('wholeImageSpriteRef', () => {
  // SkinEditor's drag-drop asks the same question the picker does — a dropped TEXTURE must
  // become a sprite ref. It used to derive the guid unconditionally, so dropping a sliced
  // spritesheet wrote a dead `parts[].sprite`. Both sites share this one implementation now.
  const whole = wholeImageSpriteGuid(TEX);

  it('resolves when the manifest carries the whole-image sprite', () => {
    expect(wholeImageSpriteRef(TEX, (g) => (g === whole ? { type: 'sprite' } : undefined))).toBe(whole);
  });

  it('is undefined for a sliced sheet — the caller must NOT fall back to the texture guid', () => {
    // Returning the texture guid instead would trade a dead ref for a sprites-only violation.
    expect(wholeImageSpriteRef(TEX, () => undefined)).toBeUndefined();
  });
});

describe('sortGroupsByName', () => {
  const g = (n: number) => ({ sprites: [], wholeGuid: undefined, tag: n });

  it('orders groups by display name, not by map insertion order', () => {
    // Insertion order here is what a LIVE manifest update produces: existing guids keep
    // their slot and the newly imported one is appended last. Without sorting, "atest"
    // renders at the bottom of the picker.
    const groups = new Map([['t-wall', g(1)], ['t-bishop', g(2)], ['t-atest', g(3)]]);
    const names: Record<string, string> = { 't-wall': 'wall', 't-bishop': 'bishop', 't-atest': 'atest' };
    expect(sortGroupsByName(groups, (k) => names[k]).map(([k]) => k))
      .toEqual(['t-atest', 't-bishop', 't-wall']);
  });

  it('is case-insensitive, so a capitalised import does not sort into its own block', () => {
    const groups = new Map([['a', g(1)], ['b', g(2)], ['c', g(3)]]);
    const names: Record<string, string> = { a: 'Zebra', b: 'apple', c: 'Banana' };
    expect(sortGroupsByName(groups, (k) => names[k]).map(([k]) => k)).toEqual(['b', 'c', 'a']);
  });

  // An unresolvable name is rendered by the picker as a guid prefix. Sorting it as ''
  // would float it to the TOP, which is the opposite of what it deserves.
  it('sorts unresolvable names last, keeping their relative order', () => {
    const groups = new Map([['x', g(1)], ['named', g(2)], ['y', g(3)]]);
    const names: Record<string, string | undefined> = { x: undefined, named: 'mid', y: undefined };
    expect(sortGroupsByName(groups, (k) => names[k]).map(([k]) => k)).toEqual(['named', 'x', 'y']);
  });

  it('is stable for equal names', () => {
    const groups = new Map([['first', g(1)], ['second', g(2)]]);
    expect(sortGroupsByName(groups, () => 'same').map(([k]) => k)).toEqual(['first', 'second']);
  });
});
