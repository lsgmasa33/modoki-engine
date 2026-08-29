#!/usr/bin/env node
/** Contact sheet for judging generated app icons and splashes (#397).
 *
 *      node engine/scripts/review-icons.mjs --project games/court [--out <file.jpg>]
 *
 *  An icon cannot be judged at 1024. Court's first four app-icon candidates were all rejected
 *  at **40 px over a light wallpaper**, where three of them turned out to have no silhouette at
 *  all — a comparison that looks like a formality until it throws away a whole round of art.
 *  The same is true of everything else here: the adaptive mask eats the corners, the tinted
 *  variant collapses if its greyscale has no range, and a splash overlay that reads perfectly in
 *  the file can be cropped off the screen.
 *
 *  So this sheet composites, from the REAL generated output:
 *
 *    1. the iOS icon at 180 / 120 / 60 / 40 / 29 px over BOTH a light and a dark ground;
 *    2. the iOS **dark** and **tinted** variants at the same sizes (tinted shown under a tint,
 *       which is the only way its contrast is visible);
 *    3. the Android **adaptive** result, simulated at the real inset, and the **monochrome**
 *       layer as a themed launcher would tint it;
 *    4. each splash **as a device will crop it** — the phone and tablet shapes, cover-filled.
 *
 *  ⚠️ The adaptive simulation is the part that was got wrong twice, in opposite directions,
 *  before the numbers came out right. The derivation, worth copying rather than re-deriving:
 *  **canvas 108, both layers inset 16.7% to a centred 72-wide box, mask circle diameter 72
 *  inscribed in that box.** It is a simulation and can only be CONFIRMED on hardware. */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const LIGHT_GROUND = '#dcdcdc';
const DARK_GROUND = '#1c1c1e';
const TINT = { r: 90, g: 160, b: 255 };
const ICON_SIZES = [180, 120, 60, 40, 29];
const PAD = 18;
const LABEL_H = 22;

/** Adaptive-icon geometry. Android insets each layer by 16.7% of a 108-unit canvas, and the
 *  circular mask's diameter equals the width of the resulting box — so the mask is inscribed in
 *  the ART, not in the canvas, and it cuts the diagonals of anything drawn full-bleed. */
const ADAPTIVE_CANVAS = 108;
const ADAPTIVE_INSET_PCT = 16.7;

export function adaptiveGeometry(renderPx = 432) {
  const scale = renderPx / ADAPTIVE_CANVAS;
  const inset = (ADAPTIVE_CANVAS * ADAPTIVE_INSET_PCT) / 100; // 18.036 units per side
  const box = ADAPTIVE_CANVAS - inset * 2;                    // ≈71.9 units
  return {
    canvas: renderPx,
    boxPx: Math.round(box * scale),
    offsetPx: Math.round(inset * scale),
    maskDiameterPx: Math.round(box * scale),
  };
}

const label = (text, w) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${LABEL_H}">`
  + `<text x="0" y="${LABEL_H - 6}" font-family="Helvetica, Arial, sans-serif" font-size="13"`
  + ` fill="#b8b8b8">${text}</text></svg>`,
);

/** One row: an image at each of ICON_SIZES over `ground`. */
async function sizeRow(buf, ground, rowLabel, width) {
  const h = Math.max(...ICON_SIZES) + PAD * 2;
  const layers = [];
  let x = PAD;
  for (const s of ICON_SIZES) {
    layers.push({
      input: await sharp(buf).resize(s, s, { fit: 'cover' }).png().toBuffer(),
      left: x,
      top: PAD + (h - PAD * 2 - s),
    });
    x += s + PAD;
  }
  const tile = await sharp({ create: { width, height: h, channels: 4, background: ground } })
    .composite(layers).png().toBuffer();
  return { tile, height: h, rowLabel };
}

/** The adaptive result: both layers inset into the 72-box, then circularly masked. */
async function adaptiveSim(foreground, background, renderPx = 432) {
  const g = adaptiveGeometry(renderPx);
  const layers = [];
  for (const src of [background, foreground]) {
    if (!src || !fs.existsSync(src)) continue;
    layers.push({
      input: await sharp(src).resize(g.boxPx, g.boxPx, { fit: 'cover' }).png().toBuffer(),
      left: g.offsetPx,
      top: g.offsetPx,
    });
  }
  if (!layers.length) return null;
  const flat = await sharp({ create: { width: g.canvas, height: g.canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers).png().toBuffer();
  const r = g.maskDiameterPx / 2;
  const c = g.canvas / 2;
  const mask = Buffer.from(`<svg width="${g.canvas}" height="${g.canvas}"><circle cx="${c}" cy="${c}" r="${r}" fill="#fff"/></svg>`);
  return sharp(flat)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png().toBuffer();
}

/** The monochrome layer as a themed launcher shows it: the silhouette tinted, on a tinted ground. */
async function themedSim(monochrome, renderPx = 432) {
  if (!monochrome || !fs.existsSync(monochrome)) return null;
  const g = adaptiveGeometry(renderPx);
  const tinted = await sharp(monochrome)
    .resize(g.boxPx, g.boxPx, { fit: 'cover' })
    // The launcher paints the silhouette in ONE colour and keeps its alpha.
    .composite([{
      input: { create: { width: g.boxPx, height: g.boxPx, channels: 3, background: { r: 22, g: 30, b: 52 } } },
      blend: 'in',
    }])
    .png().toBuffer();
  const ground = { create: { width: g.canvas, height: g.canvas, channels: 4, background: TINT } };
  const flat = await sharp(ground).composite([{ input: tinted, left: g.offsetPx, top: g.offsetPx }]).png().toBuffer();
  const r = g.maskDiameterPx / 2;
  const c = g.canvas / 2;
  const mask = Buffer.from(`<svg width="${g.canvas}" height="${g.canvas}"><circle cx="${c}" cy="${c}" r="${r}" fill="#fff"/></svg>`);
  return sharp(flat).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

/** A tinted preview of the iOS tinted variant — its greyscale under a tint, which is how iOS
 *  actually shows it and the only view in which "flat and unreadable" is visible. */
async function tintedPreview(buf) {
  const size = 256;
  const grey = await sharp(buf).resize(size, size, { fit: 'cover' }).greyscale().toColourspace('b-w').raw().toBuffer();
  const out = Buffer.alloc(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    const l = grey[p] / 255;
    out[p * 4] = Math.round(TINT.r * l);
    out[p * 4 + 1] = Math.round(TINT.g * l);
    out[p * 4 + 2] = Math.round(TINT.b * l);
    out[p * 4 + 3] = 255;
  }
  return sharp(out, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

/** Each splash as a real device crops it. */
const DEVICE_SHAPES = [
  ['phone 19.5:9', 300, 650],
  ['tablet 3:4', 420, 560],
];

async function splashRow(file, width) {
  const shots = [];
  for (const [, w, h] of DEVICE_SHAPES) {
    shots.push({ buf: await sharp(file).resize(w, h, { fit: 'cover' }).png().toBuffer(), w, h });
  }
  const H = Math.max(...shots.map((s) => s.h)) + PAD * 2;
  let x = PAD;
  const layers = [];
  for (const s of shots) { layers.push({ input: s.buf, left: x, top: PAD }); x += s.w + PAD; }
  return {
    tile: await sharp({ create: { width, height: H, channels: 4, background: '#141414' } })
      .composite(layers).png().toBuffer(),
    height: H,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) {
    console.error('[review] usage: review-icons.mjs --project <dir> [--out <file.jpg>]');
    process.exit(2);
  }
  const root = path.resolve(args.project);
  const out = args.out ? path.resolve(args.out) : path.join(root, 'icon-review.jpg');

  const appicon = path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset');
  const res = path.join(root, 'android/app/src/main/res');
  const width = PAD * (ICON_SIZES.length + 1) + ICON_SIZES.reduce((a, b) => a + b, 0);
  const sheetWidth = Math.max(width, 980);

  const rows = [];
  const push = async (tile, height, text) => {
    rows.push({ tile, height, text });
  };

  const base = path.join(appicon, 'AppIcon-512@2x.png');
  if (fs.existsSync(base)) {
    const buf = fs.readFileSync(base);
    const light = await sizeRow(buf, LIGHT_GROUND, '', sheetWidth);
    await push(light.tile, light.height, 'iOS icon — 180/120/60/40/29 px on a LIGHT ground');
    const dark = await sizeRow(buf, DARK_GROUND, '', sheetWidth);
    await push(dark.tile, dark.height, 'iOS icon — same sizes on a DARK ground (a pale icon can vanish on one and not the other)');
  }
  for (const [file, text] of [
    ['AppIcon-1024-dark.png', 'iOS DARK variant (18+) on a dark ground'],
    ['AppIcon-1024-tinted.png', 'iOS TINTED variant (18+) — the raw greyscale iOS will tint'],
  ]) {
    const p = path.join(appicon, file);
    if (!fs.existsSync(p)) continue;
    const row = await sizeRow(fs.readFileSync(p), DARK_GROUND, '', sheetWidth);
    await push(row.tile, row.height, text);
  }
  const tintedFile = path.join(appicon, 'AppIcon-1024-tinted.png');
  if (fs.existsSync(tintedFile)) {
    const prev = await tintedPreview(fs.readFileSync(tintedFile));
    const h = 256 + PAD * 2;
    const tile = await sharp({ create: { width: sheetWidth, height: h, channels: 4, background: DARK_GROUND } })
      .composite([{ input: prev, left: PAD, top: PAD }]).png().toBuffer();
    await push(tile, h, 'iOS tinted, under a system tint — this is where a flat greyscale shows as a smudge');
  }

  const density = ['xxxhdpi', 'xxhdpi', 'xhdpi', 'hdpi'].find((d) => fs.existsSync(path.join(res, `mipmap-${d}`, 'ic_launcher_foreground.png')));
  if (density) {
    const dir = path.join(res, `mipmap-${density}`);
    const adaptive = await adaptiveSim(path.join(dir, 'ic_launcher_foreground.png'), path.join(dir, 'ic_launcher_background.png'));
    const themed = await themedSim(path.join(dir, 'ic_launcher_monochrome.png'));
    const tiles = [adaptive, themed].filter(Boolean);
    if (tiles.length) {
      const h = 432 + PAD * 2;
      let x = PAD;
      const layers = [];
      for (const t of tiles) { layers.push({ input: t, left: x, top: PAD }); x += 432 + PAD; }
      const tile = await sharp({ create: { width: sheetWidth, height: h, channels: 4, background: LIGHT_GROUND } })
        .composite(layers).png().toBuffer();
      await push(tile, h, `Android adaptive (masked, 16.7% inset) and the MONOCHROME layer as a themed launcher tints it — ${density}`);
    }
  }

  const splash = ['drawable-port-xxxhdpi', 'drawable-port-xhdpi', 'drawable']
    .map((d) => path.join(res, d, 'splash.png')).find((p) => fs.existsSync(p));
  if (splash) {
    const row = await splashRow(splash, sheetWidth);
    await push(row.tile, row.height, `Splash as a device CROPS it — phone and tablet (${path.basename(path.dirname(splash))})`);
  }

  if (!rows.length) {
    console.error(`[review] nothing generated to review under ${root} — build the project first`);
    process.exit(1);
  }

  const totalH = rows.reduce((a, r) => a + r.height + LABEL_H, 0) + PAD;
  const layers = [];
  let y = 0;
  for (const r of rows) {
    layers.push({ input: label(r.text, sheetWidth), left: PAD, top: y + 2 });
    layers.push({ input: r.tile, left: 0, top: y + LABEL_H });
    y += r.height + LABEL_H;
  }
  await sharp({ create: { width: sheetWidth, height: totalH, channels: 4, background: '#0d0d0d' } })
    .composite(layers).jpeg({ quality: 86 }).toFile(out);
  console.log(`[review] ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
