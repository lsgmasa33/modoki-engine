/** UltraHDR encode in Node (#1314) — the CPU port of gainmap-js's two WebGL passes, and the
 *  reimport handler that is now every entry point's way to it.
 *
 *  The oracle is REAL GPU output, not a re-derivation: `fixtures/ultrahdr/gradient-sun.hdr` is a
 *  synthetic 64×32 env (a bright sky that drifts in hue, a dim warm ground, a 2000-nit sun), and
 *  `gradient-sun.webgl-ultrahdr.jpg` is what the retired browser encoder (`encodeUltraHDR.ts`,
 *  gainmap-js on a WebGLRenderer in the Electron editor) produced from it on 2026-09-17. The bytes
 *  cannot match — that side's JPEG coder was Chrome's canvas — so the planes are compared decoded,
 *  within JPEG noise.
 *
 *  ⚠️ **The fixture is UPSIDE DOWN, and the Node output deliberately is not.** The GPU encoder
 *  stored its planes bottom row first, which UltraHDRLoader renders inverted — a real bug that
 *  shipped unseen because no project ever committed an UltraHDR env (#1314, found with a mirror
 *  probe). So the planes are compared against the fixture ROW-FLIPPED, and against it as-is to
 *  prove the orientation is not accidental. */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { decodeHDR } from '../../plugins/env-convert';
import { encodeUltraHdrJpeg, hashBytes } from '../../plugins/env-ultrahdr';
import { environmentReimportHandler } from '../../plugins/reimport-environment';
import { ULTRAHDR_VARIANT_SUFFIX } from '../../packages/modoki/src/runtime/core/environmentSettings';

const FIX = path.resolve(__dirname, '../fixtures/ultrahdr');
const SOURCE = path.join(FIX, 'gradient-sun.hdr');
const WEBGL = path.join(FIX, 'gradient-sun.webgl-ultrahdr.jpg');

/** Split an UltraHDR JPEG into [primary SDR, gain map] at the first EOI→SOI boundary. */
function splitUltraHdr(buf: Buffer): [Buffer, Buffer] {
  for (let i = 2; i < buf.length - 3; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9 && buf[i + 2] === 0xff && buf[i + 3] === 0xd8) {
      return [buf.subarray(0, i + 2), buf.subarray(i + 2)];
    }
  }
  throw new Error('not an UltraHDR JPEG: no second image');
}

const hdrgm = (buf: Buffer) => Object.fromEntries(
  [...buf.toString('latin1').matchAll(/hdrgm:(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
);

async function rgb(jpeg: Buffer) {
  const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

/** Mean |Δ| per channel between two same-size RGB planes; `flip` compares a against b upside down. */
function meanAbs(a: Buffer, b: Buffer, w: number, h: number, flip = false): number {
  let sum = 0;
  for (let y = 0; y < h; y++) {
    const by = flip ? h - 1 - y : y;
    for (let x = 0; x < w * 3; x++) sum += Math.abs(a[y * w * 3 + x] - b[by * w * 3 + x]);
  }
  return sum / (w * h * 3);
}

async function encodeFixture(): Promise<Buffer> {
  const { data, width, height } = await decodeHDR(fs.readFileSync(SOURCE));
  return Buffer.from(await encodeUltraHdrJpeg(data, width, height));
}

/** Measured on THIS fixture 2026-09-17: the Node output's mean |Δ| against the row-flipped GPU
 *  fixture was 0.32 (SDR) and 0.25 (gain); against it as stored, 160 and 17. (docs/textures.md
 *  § ultrahdr reports the same comparison on a real 2K env.) The bounds leave room for a different libjpeg-turbo
 *  build, not for a wrong formula — a re-flipped plane or a swapped ACES matrix lands far above. */
const TOLERANCE: Record<string, number> = { 'SDR rendition': 1.0, 'gain map': 1.0 };

describe('encodeUltraHdrJpeg matches the WebGL encoder it replaced', () => {
  it('writes the same gainmap metadata', async () => {
    const node = hdrgm(await encodeFixture());
    const gpu = hdrgm(fs.readFileSync(WEBGL));
    expect(Object.keys(gpu).length).toBeGreaterThan(5);
    expect(node).toEqual(gpu);
  });

  // Both planes, same test shape: close to the GPU output turned the right way up, and FAR from
  // it as stored — the second half is what fails if the old bottom-row-first layout comes back.
  for (const [name, index] of [['SDR rendition', 0], ['gain map', 1]] as const) {
    it(`the ${name} matches the GPU pass within JPEG noise, the right way up`, async () => {
      const node = await rgb(splitUltraHdr(await encodeFixture())[index]);
      const gpu = await rgb(splitUltraHdr(fs.readFileSync(WEBGL))[index]);
      expect([node.w, node.h]).toEqual([gpu.w, gpu.h]);
      const upright = meanAbs(node.data, gpu.data, gpu.w, gpu.h, true);
      const asStored = meanAbs(node.data, gpu.data, gpu.w, gpu.h);
      expect(upright).toBeLessThan(TOLERANCE[name]);
      expect(asStored).toBeGreaterThan(upright * 5);
    });
  }
});

describe('hashBytes', () => {
  it('is deterministic + 16 hex chars', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    expect(hashBytes(a)).toBe(hashBytes(new Uint8Array([1, 2, 3, 4, 5])));
    expect(hashBytes(a)).toMatch(/^[0-9a-f]{16}$/);
  });
  it('changes when the bytes change', () => {
    expect(hashBytes(new Uint8Array([1, 2, 3]))).not.toBe(hashBytes(new Uint8Array([1, 2, 4])));
    expect(hashBytes(new Uint8Array([1, 2, 3]))).not.toBe(hashBytes(new Uint8Array([1, 2, 3, 0])));
  });
});

describe('environmentReimportHandler honours the format (#1314)', () => {
  /** A project with one environment whose sidecar still carries a previous `hdr` conversion. */
  function project(format: 'hdr' | 'ultrahdr') {
    const dir = makeScratchDir('env-ultrahdr-');
    const abs = path.join(dir, 'assets', 'sky.hdr');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(SOURCE, abs);
    const stale = { hash: '0000000000000000', width: 32, height: 16, srcWidth: 64, srcHeight: 32 };
    fs.writeFileSync(abs + '.meta.json', JSON.stringify({
      version: 2, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      environment: { format, maxSize: 256 }, environmentCache: stale,
    }, null, 2) + '\n');
    const committed = () => JSON.parse(fs.readFileSync(abs + '.meta.json', 'utf-8'));
    const local = () => JSON.parse(fs.readFileSync(abs + '.meta.local.json', 'utf-8'));
    const run = () => environmentReimportHandler('/assets/sky.hdr', abs, {
      projectRoot: dir, resolveAssetPath: () => abs,
    });
    return { dir, abs, committed, local, run };
  }

  it('ultrahdr: writes the committed ~ultrahdr.jpg and a block describing THAT file', async () => {
    const p = project('ultrahdr');
    await p.run();
    const variant = fs.readFileSync(p.abs + ULTRAHDR_VARIANT_SUFFIX);
    expect(Object.keys(hdrgm(variant)).length).toBeGreaterThan(5);
    const meta = p.committed();
    expect(meta.id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    // The whole block is replaced: the stale hdr dims must not survive to describe a JPEG.
    expect(meta.environmentCache).toEqual({ hash: hashBytes(variant) });
    expect(p.local().environmentCache).toEqual({ bytes: variant.length });
    // …and nothing went through the hdr downscale.
    expect(fs.existsSync(path.join(p.dir, '.cache', 'modoki-env'))).toBe(false);
  });

  it('refuses a too-new sidecar BEFORE touching the committed variant', async () => {
    const p = project('ultrahdr');
    const variantPath = p.abs + ULTRAHDR_VARIANT_SUFFIX;
    fs.writeFileSync(variantPath, 'PREVIOUS-COMMITTED-BYTES');
    const doc = p.committed();
    fs.writeFileSync(p.abs + '.meta.json', JSON.stringify({ ...doc, version: 999 }, null, 2) + '\n');
    await expect(p.run()).rejects.toThrow(/newer than this build/);
    expect(fs.readFileSync(variantPath, 'utf-8')).toBe('PREVIOUS-COMMITTED-BYTES');
  });

  it('hdr: still downscales into the cache and records the variant dims', async () => {
    const p = project('hdr');
    await p.run();
    const meta = p.committed();
    expect(meta.environmentCache).toMatchObject({ width: 64, height: 32, srcWidth: 64, srcHeight: 32 });
    expect(meta.environmentCache.hash).not.toBe('0000000000000000');
    expect(fs.existsSync(p.abs + ULTRAHDR_VARIANT_SUFFIX)).toBe(false);
    expect(fs.existsSync(path.join(p.dir, '.cache', 'modoki-env'))).toBe(true);
  });
});
