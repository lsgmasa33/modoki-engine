/**
 * Convert a GPU render-target readback buffer into top-down, tightly-packed,
 * opaque RGBA pixels ready to drop into a canvas `ImageData`.
 *
 * This isolates two backend-specific quirks that each caused an offscreen-capture
 * bug (see `offscreenRender` in Scene3D.tsx) so they can be unit-tested without a
 * GPU:
 *
 *  1. Row stride. WebGPU readback pads each row up to a 256-byte multiple, but
 *     three.js leaves the LAST row unpadded — so the buffer length is
 *     `(h-1)*paddedStride + w*4`, which is NOT an exact multiple of the stride.
 *     Inferring the stride via `floor(buf.length / h)` underestimates it by a few
 *     bytes and the per-row offset drifts → regular horizontal banding. Compute
 *     the padded stride directly from `w` instead. WebGL fills a tightly-packed
 *     buffer we allocate, so its stride is exactly `w*4`.
 *
 *  2. Row order. WebGL framebuffers are bottom-up (origin bottom-left) and must
 *     be flipped; WebGPU textures are top-down (origin top-left) and must NOT be
 *     flipped (flipping turns the image upside down).
 *
 * Alpha is forced to 255: the scene is opaque, JPEG has no alpha, and a varying
 * RT alpha channel would otherwise composite low-alpha rows toward black.
 */
export type ReadbackBackend = 'webgpu' | 'webgl';

export function readbackToRGBA(
  buf: Uint8Array,
  w: number,
  h: number,
  backend: ReadbackBackend,
): Uint8ClampedArray {
  const dstRow = w * 4;
  const srcStride = backend === 'webgpu' ? Math.ceil(dstRow / 256) * 256 : dstRow;
  const flipY = backend === 'webgl';
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = (flipY ? (h - 1 - y) : y) * srcStride;
    out.set(buf.subarray(src, src + dstRow), y * dstRow);
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}
