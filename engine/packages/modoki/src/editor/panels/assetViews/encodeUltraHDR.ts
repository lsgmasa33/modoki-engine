/** Browser-side UltraHDR (gainmap JPEG) encode of a source Radiance `.hdr`.
 *
 *  @monogrid/gainmap-js's encoder runs on a WebGLRenderer (+ needs createImageBitmap),
 *  so it CAN'T run in the Node build — hence this is editor-only and the resulting
 *  `~ultrahdr.jpg` is committed next to the source. gainmap-js is dynamic-imported so
 *  it (and its libultrahdr WASM) never lands in a shipped GAME bundle; the runtime
 *  DECODES with three's UltraHDRLoader, not this. */

import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

/** Encode a source `.hdr` (served URL) to UltraHDR JPEG bytes. Throws if WebGL /
 *  createImageBitmap is unavailable (the caller surfaces it). */
export async function encodeUltraHDR(sourceUrl: string): Promise<Uint8Array> {
  const { encodeAndCompress, findTextureMinMax } = await import('@monogrid/gainmap-js/encode');
  const { encodeJPEGMetadata } = await import('@monogrid/gainmap-js/libultrahdr');

  const loader = new HDRLoader();
  // FloatType (not HalfFloat): a super-bright pixel (sun disk > 65504) clips to Infinity
  // in half-float → maxContentBoost = Infinity → degenerate gainmap metadata. Float32
  // keeps it finite (and matches the inspector preview's decode type).
  loader.setDataType(THREE.FloatType);
  const image = await loader.loadAsync(sourceUrl);
  try {
    // maxContentBoost = the image's raw max radiance (how much brighter HDR can go vs SDR).
    const finite = (v: number) => (Number.isFinite(v) ? v : 1);
    const maxRgb = findTextureMinMax(image);
    const maxContentBoost = Math.max(1.0001, finite(maxRgb[0]), finite(maxRgb[1]), finite(maxRgb[2]));
    // encodeAndCompress auto-creates + disposes its own WebGLRenderer when none is passed.
    const encoded = await encodeAndCompress({ image, maxContentBoost, mimeType: 'image/jpeg' });
    // Mux the SDR JPEG + gain map + metadata into a single UltraHDR JPEG (libultrahdr WASM).
    return encodeJPEGMetadata({ ...encoded, sdr: encoded.sdr, gainMap: encoded.gainMap });
  } finally {
    image.dispose();
  }
}

/** Small deterministic content hash (FNV-style 2-lane mix, 16-hex) of the encoded
 *  bytes — cache-busts the committed `~ultrahdr.jpg` variant URL (`?v=<hash>` in prod),
 *  like the Node content hashes. Changes iff the bytes change. */
export function hashBytes(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < bytes.length; i++) {
    h1 = (Math.imul(h1 ^ bytes[i], 0x01000193)) >>> 0;
    h2 = (Math.imul(h2 + bytes[i], 0x85ebca6b)) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

/** Base64-encode bytes for the /api/write-file `encoding:'base64'` binary write. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000; // avoid String.fromCharCode arg-count limits on large buffers
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
