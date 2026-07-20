/** Sprite alpha sampling for 2D-skinning mesh tessellation ("drop vertex by alpha").
 *
 *  Loads a sprite image (optionally a sub-rect from an atlas sheet), downscales it to a
 *  small coverage grid, and returns a UV-space `isInside(u, v)` predicate that
 *  `generateGridMesh` / `autoRig2D` use to cull fully-transparent cells so the deformable
 *  mesh hugs the opaque shape instead of the full rectangle.
 *
 *  Editor-only (uses Image + a 2D canvas) — never imported by runtime/**. */

export interface AlphaMask {
  /** Downscaled coverage-grid dimensions. */
  w: number;
  h: number;
  /** Row-major 1 = opaque, 0 = transparent (length w*h). */
  data: Uint8Array;
  /** Coverage test in the sprite's UV space (0..1). Out-of-range → false. */
  isInside: (u: number, v: number) => boolean;
}

export interface AlphaMaskOptions {
  /** alpha > threshold (0..255) counts as opaque. Default 8. */
  threshold?: number;
  /** Sub-region of the source image to sample (atlas sprites). Omit = whole image. */
  rect?: { x: number; y: number; w: number; h: number };
  /** Max coverage-grid dimension. Default 256 — fine detail isn't needed for cell culling. */
  cap?: number;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Load + downscale a sprite's alpha into a coverage mask with a UV `isInside` predicate.
 *  Returns null if the image can't be loaded / read (caller falls back to no cull). */
export async function loadSpriteAlphaMask(url: string, opts: AlphaMaskOptions = {}): Promise<AlphaMask | null> {
  const img = await loadImage(url);
  if (!img) return null;
  const threshold = opts.threshold ?? 8;
  const cap = opts.cap ?? 256;

  // Source region: the atlas rect, or the whole image.
  const sx = opts.rect?.x ?? 0, sy = opts.rect?.y ?? 0;
  const sw = opts.rect?.w ?? img.naturalWidth, sh = opts.rect?.h ?? img.naturalHeight;
  if (sw < 1 || sh < 1) return null;

  const scale = Math.min(1, cap / Math.max(sw, sh));
  const mw = Math.max(1, Math.round(sw * scale)), mh = Math.max(1, Math.round(sh * scale));
  const cv = document.createElement('canvas');
  cv.width = mw; cv.height = mh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  // Draw only the sub-rect, scaled into the mask canvas → mask UV 0..1 == sprite region.
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, mw, mh);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, mw, mh).data;
  } catch {
    return null; // tainted canvas (cross-origin) — bail rather than throw
  }
  const mask = new Uint8Array(mw * mh);
  for (let i = 0; i < mw * mh; i++) mask[i] = data[i * 4 + 3] > threshold ? 1 : 0;

  const isInside = (u: number, v: number): boolean => {
    if (u < 0 || u > 1 || v < 0 || v > 1) return false;
    const x = Math.min(mw - 1, Math.max(0, Math.floor(u * mw)));
    const y = Math.min(mh - 1, Math.max(0, Math.floor(v * mh)));
    return mask[y * mw + x] === 1;
  };
  return { w: mw, h: mh, data: mask, isInside };
}
