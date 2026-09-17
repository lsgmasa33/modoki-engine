/** UltraHDR (gainmap JPEG) encode of a source Radiance `.hdr`, in Node — #1314.
 *
 *  This is the ONE UltraHDR encoder. It used to live in the editor renderer
 *  (`encodeUltraHDR.ts`, @monogrid/gainmap-js on a WebGLRenderer), which left the two
 *  Node entry points — the Assets-panel re-import and `modoki_reimport_asset` — with no
 *  ultrahdr branch at all: they ran the `~env.hdr` downscale and stamped its stats into
 *  `environmentCache`. Now every entry point reaches this through
 *  `environmentReimportHandler`, so they cannot disagree.
 *
 *  gainmap-js needs WebGL for exactly two shader passes, ported here to the CPU with the
 *  library's defaults (gainmap-js 3.4 `encode()`):
 *   1. SDR rendition — `ACESFilmicToneMapping` (exposure 1, brightness/contrast/saturation
 *      neutral) into an `SRGBColorSpace` UnsignedByte target, i.e. the GPU's sRGB OETF on
 *      write → {@link sdrRendition}.
 *   2. Gain map — `(log2((hdr+offsetHdr)/(sdr+offsetSdr)) - minLog2)/(maxLog2-minLog2)`,
 *      saturated, `pow(gamma)`, into a linear UnsignedByte target, where `sdr` is the
 *      QUANTIZED rendition sampled back through the sRGB decode → {@link gainMapPlane}.
 *  Both planes are then JPEG-compressed (`sharp`, quality 90 = gainmap-js's canvas
 *  default) and muxed by `@monogrid/gainmap-js/libultrahdr`'s `encodeJPEGMetadata`, which
 *  in 3.4 is pure JS (MPF + XMP assembly — no WASM, no DOM), so it runs here unchanged.
 *
 *  The output is not byte-identical to what the browser produced (Chrome's canvas JPEG
 *  encoder is not libjpeg-turbo-with-sharp's settings), and doesn't need to be: there is
 *  no second encoder left to agree with. The planes themselves match the GPU pass to
 *  within JPEG noise, EXCEPT that they are stored the right way up — see envUltraHdr.test.ts. */

import fs from 'fs';
import { nativeDynamicImport } from './native-dynamic-import';
import { decodeHDR } from './env-convert';

/** gainmap-js's encoder defaults — the metadata written into the XMP must be the values
 *  the gain plane was computed with, so both read from here. */
const OFFSET = 1 / 64;
const MIN_CONTENT_BOOST = 1;
const GAMMA = 1;
/** gainmap-js `compress()` quality default (0.9), on sharp's 1–100 scale. */
const JPEG_QUALITY = 90;

/** three's ACES fit, exactly as gainmap-js's SDRMaterial writes it (no 1/0.6 exposure
 *  pre-scale — that lives in three's renderer chunk, not in this shader). The GLSL
 *  `mat3(vec3,…)` constructors are column-major; the rows below are already transposed. */
export function acesFilmic(r: number, g: number, b: number): [number, number, number] {
  const ir = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const ig = 0.07600 * r + 0.90834 * g + 0.01566 * b;
  const ib = 0.02840 * r + 0.13383 * g + 0.83777 * b;
  const fit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
  const fr = fit(ir), fg = fit(ig), fb = fit(ib);
  const sat = (v: number) => (v > 1 ? 1 : v > 0 ? v : 0);
  return [
    sat(1.60475 * fr - 0.53108 * fg - 0.07367 * fb),
    sat(-0.10208 * fr + 1.10813 * fg - 0.00605 * fb),
    sat(-0.00327 * fr - 0.07276 * fg + 1.07602 * fb),
  ];
}

/** Linear [0,1] → 8-bit sRGB, the hardware SRGB8_ALPHA8 write. */
export function linearToSrgb8(v: number): number {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
}

/** 8-bit sRGB → linear, the hardware decode when the gain pass samples the SDR target. */
const SRGB8_TO_LINEAR = (() => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const s = i / 255;
    t[i] = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/** The per-image max radiance the browser encoder fed in as `maxContentBoost`:
 *  per-channel max over RGB (a non-finite channel counts as 1), floored at 1.0001. */
export function maxContentBoostOf(data: Float32Array): number {
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > mr) mr = data[i];
    if (data[i + 1] > mg) mg = data[i + 1];
    if (data[i + 2] > mb) mb = data[i + 2];
  }
  const finite = (v: number) => (Number.isFinite(v) ? v : 1);
  return Math.max(1.0001, finite(mr), finite(mg), finite(mb));
}

/** Pass 1: RGBA float (linear) → RGB 8-bit sRGB. */
export function sdrRendition(data: Float32Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  for (let p = 0, i = 0; p < out.length; p += 3, i += 4) {
    const [r, g, b] = acesFilmic(data[i], data[i + 1], data[i + 2]);
    out[p] = linearToSrgb8(r);
    out[p + 1] = linearToSrgb8(g);
    out[p + 2] = linearToSrgb8(b);
  }
  return out;
}

/** Pass 2: HDR + the QUANTIZED SDR rendition → RGB 8-bit gain map. */
export function gainMapPlane(data: Float32Array, sdr: Uint8Array, maxContentBoost: number): Uint8Array {
  const minLog2 = Math.log2(MIN_CONTENT_BOOST);
  const maxLog2 = Math.log2(Math.max(maxContentBoost, 1.0001));
  const out = new Uint8Array(sdr.length);
  for (let p = 0, i = 0; p < out.length; p += 3, i += 4) {
    for (let c = 0; c < 3; c++) {
      const gain = (data[i + c] + OFFSET) / (SRGB8_TO_LINEAR[sdr[p + c]] + OFFSET);
      const rec = (Math.log2(gain) - minLog2) / (maxLog2 - minLog2);
      // NaN (a NaN radiance) saturates to 0, as GLSL clamp() does on the GPUs we target.
      const clamped = rec > 1 ? 1 : rec > 0 ? rec : 0;
      out[p + c] = Math.round(Math.pow(clamped, GAMMA) * 255);
    }
  }
  return out;
}

/** Encode decoded HDR pixels (RGBA float, top row first — three's HDRLoader order) to
 *  UltraHDR JPEG bytes, in the same row order. */
export async function encodeUltraHdrJpeg(data: Float32Array, width: number, height: number): Promise<Uint8Array> {
  const maxContentBoost = maxContentBoostOf(data);
  const sdr = sdrRendition(data, width, height);
  const gain = gainMapPlane(data, sdr, maxContentBoost);
  // ⚠️ Planes stay TOP ROW FIRST — an ordinary JPEG, which is what three's UltraHDRLoader
  // (`flipY = true`) renders upright. The browser encoder this replaced wrote them bottom row
  // first (a flipY'd texture read back through `readPixels`), and every env it produced
  // rendered UPSIDE DOWN; nothing had ever committed one, so nobody saw it (#1314, measured
  // with a mirror probe against the same env as `hdr`). Do not "match the old encoder" here.

  const sharp = ((await nativeDynamicImport('sharp')) as typeof import('sharp')).default;
  const jpeg = (plane: Uint8Array) => sharp(plane, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  const [sdrJpeg, gainJpeg] = await Promise.all([jpeg(sdr), jpeg(gain)]);

  const { encodeJPEGMetadata } = (await nativeDynamicImport('@monogrid/gainmap-js/libultrahdr')) as typeof import('@monogrid/gainmap-js/libultrahdr');
  const maxLog2 = Math.log2(maxContentBoost);
  const minLog2 = Math.log2(MIN_CONTENT_BOOST);
  return encodeJPEGMetadata({
    sdr: { data: new Uint8Array(sdrJpeg), mimeType: 'image/jpeg', width, height },
    gainMap: { data: new Uint8Array(gainJpeg), mimeType: 'image/jpeg', width, height },
    gainMapMin: [minLog2, minLog2, minLog2],
    gainMapMax: [maxLog2, maxLog2, maxLog2],
    gamma: [GAMMA, GAMMA, GAMMA],
    offsetSdr: [OFFSET, OFFSET, OFFSET],
    offsetHdr: [OFFSET, OFFSET, OFFSET],
    hdrCapacityMin: Math.max(0, minLog2),
    hdrCapacityMax: Math.max(0, maxLog2),
  } as Parameters<typeof encodeJPEGMetadata>[0]);
}

/** Small deterministic content hash (FNV-style 2-lane mix, 16-hex) of the encoded
 *  bytes — cache-busts the committed `~ultrahdr.jpg` variant URL (`?v=<hash>`, in dev as
 *  well as prod since #1022). Changes iff the bytes change. */
export function hashBytes(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < bytes.length; i++) {
    h1 = (Math.imul(h1 ^ bytes[i], 0x01000193)) >>> 0;
    h2 = (Math.imul(h2 + bytes[i], 0x85ebca6b)) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

/** Encode `absSource` and return the bytes + their hash. Full source resolution:
 *  `maxSize` applies to the `hdr` format only (the Inspector hides it for ultrahdr). */
export async function convertEnvironmentUltraHdr(absSource: string): Promise<{ bytes: Uint8Array; hash: string }> {
  const { data, width, height } = await decodeHDR(fs.readFileSync(absSource));
  const bytes = await encodeUltraHdrJpeg(data, width, height);
  return { bytes, hash: hashBytes(bytes) };
}
