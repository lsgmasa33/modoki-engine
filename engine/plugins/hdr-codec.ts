/** Dependency-free Radiance HDR (.hdr / RGBE) encode + area-average downscale, for
 *  the environment-map conversion pipeline. Decode reuses three's HDRLoader.parse
 *  (robust, handles RLE + flat) in env-convert; here we only ENCODE (the easy
 *  direction) + downscale, so the converter needs no ImageMagick / native tool.
 *
 *  Downscaling averages in LINEAR radiance space (HDR data is already linear — no
 *  gamma), which is the correct high-quality box filter for an equirect env that
 *  feeds a blurred PMREM. Encoding writes canonical new-RLE scanlines with literal
 *  (uncompressed) runs — a valid, unambiguous RGBE layout HDRLoader always parses
 *  (no fragile old-flat/RLE detection). Pure + unit-tested. */

/** frexp: split `value` into mantissa ∈ [0.5, 1) and exponent so value = m·2^e. */
function frexp(value: number): [number, number] {
  if (value === 0 || !Number.isFinite(value)) return [value, 0];
  const data = new DataView(new ArrayBuffer(8));
  data.setFloat64(0, value);
  let bits = (data.getUint32(0) >>> 20) & 0x7ff;
  if (bits === 0) {
    // Subnormal — scale up, re-read, adjust.
    data.setFloat64(0, value * 2 ** 64);
    bits = ((data.getUint32(0) >>> 20) & 0x7ff) - 64;
  }
  const exponent = bits - 1022;
  const mantissa = value / 2 ** exponent;
  return [mantissa, exponent];
}

/** One RGB float triple → 4 RGBE bytes (shared exponent). Classic Radiance encoding. */
export function floatToRgbe(r: number, g: number, b: number): [number, number, number, number] {
  const v = Math.max(r, g, b);
  if (!(v >= 1e-32)) return [0, 0, 0, 0]; // also catches NaN/≤0
  const [mant, e] = frexp(v);
  const scale = (mant * 256) / v;
  const clamp = (x: number) => Math.max(0, Math.min(255, Math.floor(x * scale)));
  // Clamp the exponent byte to 0..255 — a radiance ≥ 2^127 would otherwise overflow
  // (e+128 > 255 wraps in a Uint8Array → catastrophically wrong pixel). Unreachable
  // after a downscale-average of real HDR, but robust against a pathological source.
  return [clamp(r), clamp(g), clamp(b), Math.max(0, Math.min(255, e + 128))];
}

/** Parse ONLY the dimensions from a Radiance `.hdr` header (the `-Y H +X W`
 *  resolution line) without decoding pixels — cheap, for a cache-hit fast path.
 *  Returns null if no resolution line is found in the header prefix. */
export function readHdrHeaderDims(buf: Buffer): { width: number; height: number } | null {
  // The header is ASCII and ends at the resolution line — a 512-byte prefix covers it.
  const text = buf.subarray(0, Math.min(buf.length, 512)).toString('latin1');
  const m = text.match(/([-+][XY])\s+(\d+)\s+([-+][XY])\s+(\d+)/);
  if (!m) return null;
  const dims: Record<string, number> = {};
  dims[m[1][1]] = parseInt(m[2], 10);
  dims[m[3][1]] = parseInt(m[4], 10);
  if (dims.X == null || dims.Y == null) return null;
  return { width: dims.X, height: dims.Y };
}

/** Target dims: scale to fit `maxSize` on the longest edge (never upscale). */
export function envTargetDims(srcW: number, srcH: number, maxSize: number): { width: number; height: number } {
  const scale = Math.min(maxSize / srcW, maxSize / srcH, 1);
  return { width: Math.max(1, Math.round(srcW * scale)), height: Math.max(1, Math.round(srcH * scale)) };
}

/** Area-average downscale of an RGBA Float32Array (linear radiance). Each target
 *  pixel averages the source region it covers — a proper box filter for downscaling.
 *  Returns RGBA (alpha carried through / defaulted to 1). */
export function downscaleRGBA(src: Float32Array, srcW: number, srcH: number, dstW: number, dstH: number): Float32Array {
  if (dstW === srcW && dstH === srcH) return src;
  const out = new Float32Array(dstW * dstH * 4);
  const sxRatio = srcW / dstW;
  const syRatio = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = Math.floor(dy * syRatio);
    const sy1 = Math.max(sy0 + 1, Math.floor((dy + 1) * syRatio));
    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = Math.floor(dx * sxRatio);
      const sx1 = Math.max(sx0 + 1, Math.floor((dx + 1) * sxRatio));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < srcH; sy++) {
        for (let sx = sx0; sx < sx1 && sx < srcW; sx++) {
          const i = (sy * srcW + sx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      }
      const o = (dy * dstW + dx) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = n ? a / n : 1;
    }
  }
  return out;
}

/** Encode an RGBA Float32Array as a Radiance `.hdr` Buffer (new-RLE, literal runs).
 *  `width` must be in [8, 32767] for the new-RLE scanline format (env maxSize ≥ 256
 *  guarantees it). Rows are written top-to-bottom (`-Y H +X W`). */
export function encodeHDR(rgba: Float32Array, width: number, height: number): Buffer {
  // New-RLE scanlines are only unambiguous for width in [8, 32767]: HDRLoader treats a
  // width < 8 as the OLD flat format and misreads our `[2,2,…]` header as pixels →
  // silent corruption. A real 2:1 equirect at maxSize ≥ 256 never hits this; guard
  // loudly so a pathological narrow HDR fails the convert (→ source fallback) instead.
  if (width < 8 || width > 32767) {
    throw new Error(`encodeHDR: width ${width} outside the new-RLE range [8, 32767] (not a normal equirect HDR)`);
  }
  const header = Buffer.from(
    `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`,
    'ascii',
  );
  // Per scanline: [2,2, W>>8, W&0xff] then 4 channel passes, each literal-run encoded.
  const rowChan = new Uint8Array(width); // one channel of RGBE bytes for the row
  const body: number[] = [];
  for (let y = 0; y < height; y++) {
    body.push(2, 2, (width >> 8) & 0xff, width & 0xff);
    // Compute RGBE bytes for the row once, then emit channel-by-channel.
    const rowRgbe = new Uint8Array(width * 4);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [rr, gg, bb, ee] = floatToRgbe(rgba[i], rgba[i + 1], rgba[i + 2]);
      const o = x * 4;
      rowRgbe[o] = rr; rowRgbe[o + 1] = gg; rowRgbe[o + 2] = bb; rowRgbe[o + 3] = ee;
    }
    for (let c = 0; c < 4; c++) {
      for (let x = 0; x < width; x++) rowChan[x] = rowRgbe[x * 4 + c];
      // Literal-only new-RLE: chunks of ≤128 bytes, count byte then the literals.
      let x = 0;
      while (x < width) {
        const n = Math.min(128, width - x);
        body.push(n); // 1..128 ⇒ literal run
        for (let k = 0; k < n; k++) body.push(rowChan[x + k]);
        x += n;
      }
    }
  }
  return Buffer.concat([header, Buffer.from(body)]);
}
