#!/usr/bin/env node
/** Rebuild the committed "Made by Modoki Engine" splash badge artwork (#396).
 *
 *      node engine/scripts/make-splash-badge.mjs
 *      → engine/assets/splash-badge-light.png   (cream, for a dark splash)
 *      → engine/assets/splash-badge-dark.png    (navy,  for a light splash)
 *
 *  ⚠️ **The OUTPUT is committed and the build reads that, never this script.** The text is
 *  typeset here through librsvg, which resolves `font-family` against the SYSTEM's fonts — so
 *  running this on another machine, or in CI, produces different metrics and a differently
 *  shaped badge. Baking it once and committing the PNG is what makes every project's splash
 *  identical on a Mac, on Windows and on the public runner. Re-run this only to change the
 *  mark deliberately, and commit what it writes.
 *
 *  The panda is keyed out of `build/icon.png` (the editor's own icon: cream #fde7d9 subject on
 *  navy #1a1a2e) by a soft LUMINANCE ramp rather than a hard threshold — the logo is hand-drawn
 *  and a threshold strips the antialiasing off every stroke, which at badge size reads as a
 *  ragged edge. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The Modoki palette, sampled from `build/icon.png` rather than remembered. */
export const MODOKI_CREAM = '#fde7d9';
export const MODOKI_NAVY = '#1a1a2e';

const GLYPH_H = 128;   // panda height; the text is sized against it, not the other way round
const GAP = 34;
const TEXT_PX = 60;
const PAD = 8;
const LABEL = 'Made by Modoki Engine';

/** The panda, recoloured to one flat `hex` on transparency. */
async function panda(hex) {
  const { data, info } = await sharp(path.join(REPO, 'build', 'icon.png'))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const out = Buffer.alloc(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const i = p * ch;
    const srcA = ch === 4 ? data[i + 3] : 255;
    const lum = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
    const t = Math.max(0, Math.min(1, (lum - 0.35) / 0.30)); // soft ramp, see the header
    out[p * 4] = r; out[p * 4 + 1] = g; out[p * 4 + 2] = b;
    out[p * 4 + 3] = Math.round(t * (srcA / 255) * 255);
  }
  const flat = await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return sharp(flat).trim({ threshold: 1 }).resize({ height: GLYPH_H, fit: 'inside' }).png().toBuffer();
}

async function build(hex, outFile) {
  const glyph = await panda(hex);
  const gm = await sharp(glyph).metadata();

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="${TEXT_PX * 2}">`
    + `<text x="0" y="${TEXT_PX}" font-family="Avenir Next, Helvetica Neue, Helvetica, Arial, sans-serif"`
    + ` font-size="${TEXT_PX}" font-weight="600" letter-spacing="1.5" fill="${hex}">${LABEL}</text></svg>`;
  const rendered = await sharp(Buffer.from(svg)).png().toBuffer();
  const text = await sharp(rendered).trim({ threshold: 1 }).png().toBuffer();
  const tm = await sharp(text).metadata();

  const W = PAD + gm.width + GAP + tm.width + PAD;
  const H = PAD + Math.max(gm.height, tm.height) + PAD;
  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: glyph, left: PAD, top: Math.round((H - gm.height) / 2) },
      { input: text, left: PAD + gm.width + GAP, top: Math.round((H - tm.height) / 2) },
    ])
    .png()
    .toFile(outFile);
  console.log(`[badge] ${path.relative(REPO, outFile)} — ${W}x${H} (aspect ${(W / H).toFixed(3)})`);
}

async function main() {
  await build(MODOKI_CREAM, path.join(REPO, 'engine', 'assets', 'splash-badge-light.png'));
  await build(MODOKI_NAVY, path.join(REPO, 'engine', 'assets', 'splash-badge-dark.png'));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
