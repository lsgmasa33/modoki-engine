/** #293 — a texture imported with the default `format: 'ktx2-uastc'` resolves to
 *  `textureType: '3d'`, and the asset scanner only auto-emits the whole-image
 *  `#default` sprite for a `2d`/`ui` texture. So a freshly imported PNG has NO
 *  sprite and the SpritePicker used to render nothing for it at all. These tests
 *  pin the gate: a texture is "spriteless" iff no sprite entry names it. */

import { describe, it, expect } from 'vitest';
import { spritelessTextures, filterSpriteless, type SpritelessTexture } from '../../src/editor/panels/spritelessTextures';
import type { AssetEntry } from '../../src/runtime/loaders/assetManifest';

const rect = { x: 0, y: 0, w: 8, h: 8 };

const texture = (guid: string, path: string, textureType?: '3d' | '2d' | 'ui'): AssetEntry => ({
  guid, path, type: 'texture', textureType,
} as AssetEntry);

const sprite = (guid: string, name: string, textureGuid: string): AssetEntry => ({
  guid, path: `${textureGuid}#${guid}`, name, type: 'sprite',
  sprite: { texture: textureGuid, name, rect, pivot: { x: 0.5, y: 0.5 } },
} as AssetEntry);

describe('spritelessTextures', () => {
  it('returns a 3D texture with no sprite entry', () => {
    const tex = texture('t1', '/assets/rock.png', '3d');
    const out = spritelessTextures([tex]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ guid: 't1', path: '/assets/rock.png', textureType: '3d' });
  });

  it('excludes a 2D texture that has a #default whole-image sprite', () => {
    const tex = texture('t2', '/assets/icon.png', '2d');
    const whole = sprite('t2-default', 'icon', 't2');
    const out = spritelessTextures([tex, whole]);
    expect(out).toHaveLength(0);
  });

  it('excludes a sliced sheet (texture + several sprites, no #default)', () => {
    const tex = texture('t3', '/assets/sheet.png', '2d');
    const slices = [sprite('s1', 'slime_0', 't3'), sprite('s2', 'slime_1', 't3')];
    const out = spritelessTextures([tex, ...slices]);
    expect(out).toHaveLength(0);
  });

  it('skips a texture entry with no guid', () => {
    const tex = { path: '/assets/noguid.png', type: 'texture', textureType: '3d' } as AssetEntry;
    const out = spritelessTextures([tex]);
    expect(out).toHaveLength(0);
  });

  it('defaults textureType to 3d when the entry has no textureType field', () => {
    const tex = texture('t4', '/assets/legacy.png');
    const out = spritelessTextures([tex]);
    expect(out).toHaveLength(1);
    expect(out[0].textureType).toBe('3d');
  });

  it('sorts results by name', () => {
    const out = spritelessTextures([
      texture('tb', '/assets/bravo.png', '3d'),
      texture('ta', '/assets/alpha.png', '3d'),
      texture('tc', '/assets/charlie.png', '3d'),
    ]);
    expect(out.map((t) => t.name)).toEqual(['alpha.png', 'bravo.png', 'charlie.png']);
  });

  it('does NOT cap a large project — capping is a view concern, not this module\'s', () => {
    // Measured on demos/forest-camp: 130 images, none typed 2d/ui. This module must
    // return the whole list; the SpritePicker's `filterSpriteless` is what caps it.
    const textures = Array.from({ length: 40 }, (_, i) =>
      texture(`t${i}`, `/assets/tex${String(i).padStart(2, '0')}.png`, '3d'));
    const out = spritelessTextures(textures);
    expect(out).toHaveLength(40);
  });
});

describe('filterSpriteless', () => {
  const list: SpritelessTexture[] = Array.from({ length: 35 }, (_, i) => ({
    guid: `g${i}`, path: `/assets/tex${String(i).padStart(2, '0')}.png`,
    name: `tex${String(i).padStart(2, '0')}.png`, textureType: '3d',
  }));

  it('shows everything (up to the cap) with an empty query', () => {
    const { shown, hidden } = filterSpriteless(list, '', 30);
    expect(shown).toHaveLength(30);
    expect(hidden).toBe(5);
  });

  it('matches case-insensitively by substring', () => {
    const { shown, hidden } = filterSpriteless(list, 'TEX0', 30);
    // tex00..tex09 = 10 matches, all under the cap.
    expect(shown).toHaveLength(10);
    expect(hidden).toBe(0);
    expect(shown.every((t) => t.name.includes('tex0'))).toBe(true);
  });

  it('returns an empty shown list and zero hidden on no match', () => {
    const { shown, hidden } = filterSpriteless(list, 'nope', 30);
    expect(shown).toHaveLength(0);
    expect(hidden).toBe(0);
  });

  it('caps exactly at the boundary — 30 items, cap 30, none hidden', () => {
    const exact = list.slice(0, 30);
    const { shown, hidden } = filterSpriteless(exact, '', 30);
    expect(shown).toHaveLength(30);
    expect(hidden).toBe(0);
  });

  it('reports the correct hidden count above the cap', () => {
    const { shown, hidden } = filterSpriteless(list, '', 30);
    expect(shown.length + hidden).toBe(list.length);
  });
});
