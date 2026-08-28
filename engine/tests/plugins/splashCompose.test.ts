/** Compositing the title and the engine badge onto the generated splashes (#396).
 *
 *  `splashLayout.test.ts` covers WHERE an overlay goes; this covers the pass that puts it there —
 *  which files it finds, that it actually changes their pixels, and the two decisions it makes on
 *  its own: skipping catalog entries nobody references, and picking the badge colour by measuring
 *  the ground beneath it rather than assuming one. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { splashOutputs, composeSplashOverlays } from '../../scripts/splashCompose.mjs';

let root: string;
let titleSrc: string;
let badgeLight: string;
let badgeDark: string;

const IOS_SPLASH = path.join('ios', 'App', 'App', 'Assets.xcassets', 'Splash.imageset');
const RES = path.join('android', 'app', 'src', 'main', 'res');

async function solid(file: string, w: number, h: number, rgb: [number, number, number], alpha = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width: w, height: h, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha } } })
    .png().toFile(file);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-splash-'));
  titleSrc = path.join(root, 'title.png');
  badgeLight = path.join(root, 'badge-light.png');
  badgeDark = path.join(root, 'badge-dark.png');
  await solid(titleSrc, 600, 200, [255, 0, 0]);
  await solid(badgeLight, 900, 144, [253, 231, 217]);
  await solid(badgeDark, 900, 144, [26, 26, 46]);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('splashOutputs — finding what the generator wrote', () => {
  it('finds every drawable bucket on Android, discovered from disk not from a table', async () => {
    for (const d of ['drawable', 'drawable-port-hdpi', 'drawable-land-night-xxxhdpi']) {
      await solid(path.join(root, RES, d, 'splash.png'), 64, 64, [0, 0, 0]);
    }
    // A bucket the generator did not fill, and a non-splash image beside one that it did.
    fs.mkdirSync(path.join(root, RES, 'drawable-empty'), { recursive: true });
    await solid(path.join(root, RES, 'drawable-port-hdpi', 'other.png'), 8, 8, [0, 0, 0]);
    const found = splashOutputs(root, 'android').map((f) => path.basename(path.dirname(f)));
    expect(found.sort()).toEqual(['drawable', 'drawable-land-night-xxxhdpi', 'drawable-port-hdpi']);
  });

  it('takes only the iOS files the catalog REFERENCES, leaving the panda-era leftovers alone', async () => {
    // #396's housekeeping note: several projects track splash-2732x2732*.png that Contents.json
    // does not mention and Xcode never reads. Overlaying them would only make them look authored.
    for (const n of ['Default@1x~universal~anyany.png', 'Default@1x~universal~anyany-dark.png', 'splash-2732x2732.png']) {
      await solid(path.join(root, IOS_SPLASH, n), 64, 64, [0, 0, 0]);
    }
    fs.writeFileSync(path.join(root, IOS_SPLASH, 'Contents.json'), JSON.stringify({
      images: [
        { idiom: 'universal', scale: '1x', filename: 'Default@1x~universal~anyany.png' },
        { idiom: 'universal', scale: '1x', filename: 'Default@1x~universal~anyany-dark.png', appearances: [{ appearance: 'luminosity', value: 'dark' }] },
      ],
    }));
    const found = splashOutputs(root, 'ios').map((f) => path.basename(f));
    expect(found.sort()).toEqual(['Default@1x~universal~anyany-dark.png', 'Default@1x~universal~anyany.png']);
  });

  it('returns nothing rather than throwing when the platform was never generated', () => {
    expect(splashOutputs(root, 'ios')).toEqual([]);
    expect(splashOutputs(root, 'android')).toEqual([]);
  });
});

describe('composeSplashOverlays', () => {
  const bucket = () => path.join(root, RES, 'drawable-port-xhdpi', 'splash.png');

  beforeEach(async () => { await solid(bucket(), 720, 1280, [40, 30, 25]); });

  it('does nothing at all when neither overlay is configured — the common case must be free', async () => {
    const before = fs.readFileSync(bucket());
    const report = await composeSplashOverlays({ projectRoot: root, platform: 'android' });
    expect(report.files).toBe(0);
    expect(fs.readFileSync(bucket()).equals(before)).toBe(true);
  });

  it('composites the title and says how many images it touched', async () => {
    const before = fs.readFileSync(bucket());
    const report = await composeSplashOverlays({
      projectRoot: root, platform: 'android', orientation: 'portrait', titleSrc,
    });
    expect(report.files).toBe(1);
    expect(report.title).toBe(1);
    expect(fs.readFileSync(bucket()).equals(before)).toBe(false);
  });

  it('lands the title inside the crop-safe box, which is NOT the middle of the file', async () => {
    await composeSplashOverlays({
      projectRoot: root, platform: 'android', orientation: 'portrait', titleSrc, titleOffsetPct: 0,
    });
    const { data, info } = await sharp(bucket()).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    // The title is pure red; the ground is not. Centre is covered…
    expect(px(360, 640)[0]).toBeGreaterThan(200);
    // …and the extreme left edge, outside the safe box, is untouched ground.
    expect(px(2, 640)[0]).toBeLessThan(100);
  });

  it('picks the CREAM badge on a dark splash and the NAVY one on a light splash', async () => {
    const read = async () => {
      const { data, info } = await sharp(bucket()).raw().toBuffer({ resolveWithObject: true });
      // Sample inside the badge: bottom of the safe box (720x1280 portrait → safe h 960, y 160).
      const y = Math.round(160 + 960 - 960 * 0.06 - 20);
      const i = (y * info.width + 360) * info.channels;
      return (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
    };
    const opts = { projectRoot: root, platform: 'android' as const, orientation: 'portrait', badge: true, badgeLightArt: badgeLight, badgeDarkArt: badgeDark };

    await solid(bucket(), 720, 1280, [20, 18, 30]);      // dark ground
    await composeSplashOverlays(opts);
    expect(await read()).toBeGreaterThan(0.5);            // → cream badge

    await solid(bucket(), 720, 1280, [240, 235, 225]);    // light ground
    await composeSplashOverlays(opts);
    expect(await read()).toBeLessThan(0.5);               // → navy badge
  });

  it('THROWS on an unreadable title rather than quietly shipping a splash without one', async () => {
    // This is the precondition for the stamp guard in generate-icons.mjs: the caller catches,
    // sets `postFailed`, and WITHHOLDS the freshness stamp. If this resolved quietly instead, the
    // build would stamp a title-less splash as current and never retry — `iconStep` drops itself
    // from the plan on a stamp match, so "next build fixes it" is not true here.
    const corrupt = path.join(root, 'corrupt.png');
    fs.writeFileSync(corrupt, 'not actually a png');
    await expect(composeSplashOverlays({
      projectRoot: root, platform: 'android', orientation: 'portrait', titleSrc: corrupt,
    })).rejects.toThrow();
  });

  it('reports a clamped placement instead of silently moving the overlay', async () => {
    const report = await composeSplashOverlays({
      projectRoot: root, platform: 'android', orientation: 'portrait', titleSrc, titleOffsetPct: -95,
    });
    expect(report.clamped.length).toBe(1);
    expect(report.clamped[0]).toMatch(/title/);
  });

  it('keeps the output the same SIZE — an overlay must never resize the bucket', async () => {
    await composeSplashOverlays({
      projectRoot: root, platform: 'android', orientation: 'portrait', titleSrc, badge: true,
      badgeLightArt: badgeLight, badgeDarkArt: badgeDark,
    });
    const m = await sharp(bucket()).metadata();
    expect([m.width, m.height]).toEqual([720, 1280]);
  });

  it('scales one authored title across buckets of different shapes', async () => {
    // Same title, two very differently shaped buckets: each gets a width derived from its OWN
    // safe box, which is the whole reason widthPct is a share of the safe box and not of the image.
    await solid(path.join(root, RES, 'drawable-land-hdpi', 'splash.png'), 800, 480, [40, 30, 25]);
    const report = await composeSplashOverlays({
      projectRoot: root, platform: 'android', orientation: 'portrait', titleSrc, titleWidthPct: 60,
    });
    expect(report.files).toBe(2);
    expect(report.title).toBe(2);
  });
});
