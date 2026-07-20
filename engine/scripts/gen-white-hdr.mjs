/**
 * Procedurally generate `white.hdr` — a tiny, uniformly-white equirectangular
 * Radiance HDR used as the DEFAULT environment for freshly-created scenes (see
 * `newScene()` in editor/scene/serialize.ts). A flat white env gives a new scene
 * neutral image-based lighting + soft reflections out of the box; the user swaps
 * in a real HDR via the Environment inspector.
 *
 * Output is a valid new-format (RLE) RGBE file so three's RGBELoader decodes it
 * on every platform. The image is uniform, so 16×8 is plenty (PMREM prefilters
 * it anyway). Also writes the `.meta.json` GUID sidecar with the STABLE id the
 * engine references (WHITE_HDR_GUID) so the ref resolves in every project.
 *
 * Run: `node engine/scripts/gen-white-hdr.mjs` (idempotent — safe to re-run).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '../packages/modoki/src/runtime/assets');
const OUT_HDR = path.join(OUT_DIR, 'white.hdr');
const OUT_META = path.join(OUT_DIR, 'white.hdr.meta.json');

// The GUID's single source of truth is the runtime const WHITE_HDR_GUID
// (packages/modoki/src/runtime/assets/builtinAssets.ts). This build script can't
// import a .ts module (it runs under plain `node`), so it PRESERVES the id from
// the existing sidecar when present (the committed authority) and only falls back
// to the literal below on a first-ever generation. whiteHdr.test.ts asserts the
// on-disk sidecar equals the runtime const, catching any drift.
const FALLBACK_GUID = 'beef0000-0000-4000-8000-000000000001';
const WHITE_HDR_GUID = (() => {
  try { return JSON.parse(fs.readFileSync(OUT_META, 'utf8')).id || FALLBACK_GUID; }
  catch { return FALLBACK_GUID; }
})();

const W = 16, H = 8;
// White at intensity ~1.0 in RGBE: max component 1.0 → mantissa 128, exponent 129.
const PIXEL = [128, 128, 128, 129];

const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${H} +X ${W}\n`;
const bytes = [...header].map((c) => c.charCodeAt(0));
for (let y = 0; y < H; y++) {
  bytes.push(2, 2, (W >> 8) & 0xff, W & 0xff); // new-format scanline marker
  // Four component passes (R,G,B,E), each a single RLE run of W identical bytes
  // (W ≤ 127, so one run byte `128+W` per component). three reads count>128 as a run.
  for (const v of PIXEL) bytes.push(128 + W, v);
}

fs.writeFileSync(OUT_HDR, Buffer.from(bytes));
fs.writeFileSync(OUT_META, JSON.stringify({ version: 2, id: WHITE_HDR_GUID }, null, 2) + '\n');
console.log(`wrote ${OUT_HDR} (${bytes.length} bytes) + meta id=${WHITE_HDR_GUID}`);
