/** The Pixi texture a 2D sprite draws from a resolved ref (`resolveSprite`). Shared by the Scene2D sprite pass and
 *  sprite batches; its own module so the trimmed-atlas path is testable without a renderer. */
import { Rectangle, Texture } from 'pixi.js';

import type { ResolvedSprite } from '../core/textureProvider';

/** Build the per-slot texture for a sprite: the base texture for a whole image, or a
 *  framed WRAPPER (sub-rect) for a sliced sprite / atlas frame. Source-px frames are
 *  scaled to the actually-loaded variant (which `maxSize` may have downscaled). */
export function frameTexture(base: Texture, r: ResolvedSprite): Texture {
  if (!r.frame) return base;
  let { x, y, w, h } = r.frame;
  let sx = 1, sy = 1;
  if (r.sheetW && r.sheetH && base.width > 0 && base.height > 0) {
    sx = base.width / r.sheetW; sy = base.height / r.sheetH;
    x *= sx; y *= sy; w *= sx; h *= sy;
  }
  // Clamp into the base texture so a slightly-off rect never throws on upload.
  x = Math.max(0, Math.min(x, base.width));
  y = Math.max(0, Math.min(y, base.height));
  w = Math.max(1, Math.min(w, base.width - x));
  h = Math.max(1, Math.min(h, base.height - y));
  const frame = new Rectangle(x, y, w, h);
  // A trimmed atlas member: the frame is its visible crop, drawn where it sat inside its full size, so size,
  // pivot and placement are those of the uncropped sprite (`AtlasSource.trim`).
  if (r.orig && r.trim) {
    return new Texture({
      source: base.source, frame,
      orig: new Rectangle(0, 0, r.orig.w * sx, r.orig.h * sy),
      trim: new Rectangle(r.trim.x * sx, r.trim.y * sy, w, h),
    });
  }
  return new Texture({ source: base.source, frame });
}

