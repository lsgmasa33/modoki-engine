/** frameTexture — the Pixi texture a 2D sprite (or sprite batch) draws from a resolved ref. Pins the trimmed-atlas
 *  case (`AtlasSource.trim`): the crop draws at the member's FULL size, offset to where it sat, so a sprite's size
 *  and pivot are those of the uncropped image. */
import { describe, expect, it } from 'vitest';
import { Texture, TextureSource } from 'pixi.js';

import { frameTexture } from '../../src/runtime/rendering/frameTexture';

const page = () => new Texture({ source: new TextureSource({ width: 64, height: 64 }) });

describe('frameTexture', () => {
  it('a trimmed member is as big as its full frame, with the crop placed inside it', () => {
    const t = frameTexture(page(), {
      url: 'u', frame: { x: 2, y: 2, w: 10, h: 6 }, pivot: { x: 0.5, y: 0.5 }, sheetW: 64, sheetH: 64,
      orig: { w: 32, h: 32 }, trim: { x: 5, y: 20, w: 10, h: 6 },
    });
    expect([t.width, t.height]).toEqual([32, 32]);
    expect([t.frame.x, t.frame.y, t.frame.width, t.frame.height]).toEqual([2, 2, 10, 6]);
    expect([t.trim!.x, t.trim!.y, t.trim!.width, t.trim!.height]).toEqual([5, 20, 10, 6]);
  });

  it('an untrimmed frame is its own size, with no trim', () => {
    const t = frameTexture(page(), { url: 'u', frame: { x: 2, y: 2, w: 10, h: 6 }, pivot: null, sheetW: 64, sheetH: 64 });
    expect([t.width, t.height]).toEqual([10, 6]);
    expect(t.trim).toBeFalsy();
  });

  it('scales a trimmed member with a downscaled page, as it does the frame', () => {
    const half = new Texture({ source: new TextureSource({ width: 32, height: 32 }) });
    const t = frameTexture(half, {
      url: 'u', frame: { x: 2, y: 2, w: 10, h: 6 }, pivot: null, sheetW: 64, sheetH: 64,
      orig: { w: 32, h: 32 }, trim: { x: 6, y: 20, w: 10, h: 6 },
    });
    expect([t.width, t.height]).toEqual([16, 16]);
    expect([t.trim!.x, t.trim!.y]).toEqual([3, 10]);
  });
});
