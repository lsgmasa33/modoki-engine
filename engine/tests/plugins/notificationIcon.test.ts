/** Android's notification small icon (#1203).
 *
 *  What the device does with the icon (the status-bar look, whether the plugin finds it) is checked on
 *  a phone, with `dumpsys notification` reading back an app resource id instead of the framework's
 *  `0x01…`. What CAN silently regress here is the artifact: the density sizes, the alpha-only white
 *  that Android requires, the crop that keeps a brush silhouette's haze from shrinking the mark, and
 *  the lifecycle (a cleared setting removes its output, an unreadable one leaves it and says so). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  ANDROID_NOTIFICATION_ICON,
  NOTIFICATION_ICON_SIZES,
  renderNotificationIcon,
  writeAndroidNotificationIcon,
} from '../../scripts/notificationIcon.mjs';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const RES = path.join('android', 'app', 'src', 'main', 'res');
const FILE = `${ANDROID_NOTIFICATION_ICON}.png`;

let root: string;
let glyph: string;

/** A 200px silhouette: a faint full-canvas haze (alpha 20) with an opaque 100x50 bar centred in it.
 *  Coloured red on purpose, so "the output is white" cannot be the input showing through. */
async function makeGlyph(file: string, { haze = 20, opaque = false } = {}) {
  const bar = await sharp({ create: { width: 100, height: 50, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } })
    .png().toBuffer();
  await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 200, g: 30, b: 30, alpha: opaque ? 1 : haze / 255 } } })
    .composite([{ input: bar, left: 50, top: 75 }])
    .png()
    .toFile(file);
}

/** Bounding box of pixels with alpha >= `floor`. */
async function alphaBox(buf: Buffer, floor = 128) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] < floor) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return { x0, y0, x1, y1, info, data };
}

beforeEach(async () => {
  root = makeScratchDir('modoki-notif-');
  fs.mkdirSync(path.join(root, RES), { recursive: true });
  glyph = path.join(root, 'glyph.png');
  await makeGlyph(glyph);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('renderNotificationIcon', () => {
  it('is WHITE wherever it is visible, whatever colour the source was drawn in', async () => {
    const buf = (await renderNotificationIcon(glyph, 96))!;
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    let visible = 0;
    for (let p = 0; p < info.width * info.height; p++) {
      if (data[p * 4 + 3] === 0) continue;
      visible++;
      expect([data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]).toEqual([255, 255, 255]);
    }
    expect(visible).toBeGreaterThan(0);
  });

  it('crops to the MARK, not the haze, and fits it to the 22dp live area with a 1dp margin', async () => {
    // 96px = 24dp at xxxhdpi: the live area is 88px, i.e. a 4px margin. The bar is 2:1, so fitted it
    // spans the full 88px width. Cropping to the haze (the whole 200px canvas) would leave it 44px wide.
    const buf = (await renderNotificationIcon(glyph, 96))!;
    const { x0, x1, y0, y1, info } = await alphaBox(buf);
    expect(info.width).toBe(96);
    expect(x0).toBe(4);
    expect(x1).toBe(91);
    expect(y1 - y0 + 1).toBeGreaterThanOrEqual(43);
    expect(y1 - y0 + 1).toBeLessThanOrEqual(45);
    // Centred vertically inside the canvas.
    expect(Math.abs((y0 + y1) / 2 - 47.5)).toBeLessThanOrEqual(1);
  });

  it('drops the sub-floor haze rather than carrying it into the icon', async () => {
    const buf = (await renderNotificationIcon(glyph, 96))!;
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    // A corner pixel sits in the haze in the source, and outside the cropped mark in the output.
    expect(data[(1 * info.width + 1) * 4 + 3]).toBe(0);
  });

  it('returns null for a source with nothing above the haze floor', async () => {
    const empty = path.join(root, 'empty.png');
    await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 10 / 255 } } })
      .png().toFile(empty);
    expect(await renderNotificationIcon(empty, 24)).toBeNull();
  });
});

describe('writeAndroidNotificationIcon', () => {
  it('emits one icon per density bucket at the 24dp pixel size for that density', async () => {
    const { written, missing } = await writeAndroidNotificationIcon({ projectRoot: root, srcAbs: glyph });
    expect(missing).toEqual([]);
    expect(Object.entries(NOTIFICATION_ICON_SIZES)).toEqual([
      ['drawable-mdpi', 24], ['drawable-hdpi', 36], ['drawable-xhdpi', 48], ['drawable-xxhdpi', 72], ['drawable-xxxhdpi', 96],
    ]);
    for (const [bucket, size] of Object.entries(NOTIFICATION_ICON_SIZES)) {
      const meta = await sharp(path.join(root, RES, bucket, FILE)).metadata();
      expect([bucket, meta.width, meta.height]).toEqual([bucket, size, size]);
      expect(written).toContain(path.join(bucket, FILE));
    }
  });

  it('keeps a previously emitted icon when there is no source but the setting was NOT positively cleared', async () => {
    // An unreadable config names no source because it cannot see one (#1203 review).
    await writeAndroidNotificationIcon({ projectRoot: root, srcAbs: glyph });
    const { removed } = await writeAndroidNotificationIcon({ projectRoot: root, srcAbs: undefined });
    expect(removed).toEqual([]);
    expect(fs.existsSync(path.join(root, RES, 'drawable-mdpi', FILE))).toBe(true);
  });

  it('REMOVES a previously emitted icon when the setting is cleared', async () => {
    await writeAndroidNotificationIcon({ projectRoot: root, srcAbs: glyph });
    const { written, removed } = await writeAndroidNotificationIcon({ projectRoot: root, srcAbs: undefined, cleared: true });
    expect(written).toEqual([]);
    expect(removed).toHaveLength(Object.keys(NOTIFICATION_ICON_SIZES).length);
    for (const bucket of Object.keys(NOTIFICATION_ICON_SIZES)) {
      expect(fs.existsSync(path.join(root, RES, bucket, FILE))).toBe(false);
    }
  });

  it('touches nothing in a project that never set it, including leaving other drawables alone', async () => {
    fs.mkdirSync(path.join(root, RES, 'drawable-mdpi'), { recursive: true });
    fs.writeFileSync(path.join(root, RES, 'drawable-mdpi', 'splash.png'), 'keep');
    const { written, removed, notes } = await writeAndroidNotificationIcon({ projectRoot: root });
    expect([written, removed, notes]).toEqual([[], [], []]);
    expect(fs.readFileSync(path.join(root, RES, 'drawable-mdpi', 'splash.png'), 'utf8')).toBe('keep');
  });

  it('REPORTS an unreadable source as missing and leaves the committed icon in place', async () => {
    await writeAndroidNotificationIcon({ projectRoot: root, srcAbs: glyph });
    const before = fs.readFileSync(path.join(root, RES, 'drawable-mdpi', FILE));
    const { written, missing, notes } = await writeAndroidNotificationIcon({
      projectRoot: root, srcAbs: path.join(root, 'no-such.png'),
    });
    expect(written).toEqual([]);
    expect(missing.join(' ')).toMatch(/notificationIconSource/);
    expect(notes.join(' ')).toMatch(/not found/);
    expect(fs.readFileSync(path.join(root, RES, 'drawable-mdpi', FILE))).toEqual(before);
  });

  it('does NOT emit a fully opaque source, which would be a solid square, and withholds the stamp', async () => {
    // Degraded rather than warned (#1203 review): writing it would overwrite a good silhouette with
    // five white squares and pass --strict behind one note.
    await writeAndroidNotificationIcon({ projectRoot: root, srcAbs: glyph });
    const before = fs.readFileSync(path.join(root, RES, 'drawable-mdpi', FILE));
    const opaque = path.join(root, 'opaque.png');
    await makeGlyph(opaque, { opaque: true });
    const { notes, written, missing } = await writeAndroidNotificationIcon({ projectRoot: root, srcAbs: opaque });
    expect(notes.join(' ')).toMatch(/solid square/);
    expect(written).toEqual([]);
    expect(missing.join(' ')).toMatch(/fully opaque/);
    expect(fs.readFileSync(path.join(root, RES, 'drawable-mdpi', FILE))).toEqual(before);
  });

  it('recognises a 16-bit opaque source as opaque — its alpha maximum is 65535, not 255 (#1203 review)', async () => {
    const deep = path.join(root, 'opaque16.png');
    await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
      .toColourspace('rgb16').png().toFile(deep);
    expect((await sharp(deep).metadata()).depth).toBe('ushort');
    const { missing } = await writeAndroidNotificationIcon({ projectRoot: root, srcAbs: deep });
    expect(missing.join(' ')).toMatch(/fully opaque/);
  });

  it('refuses, rather than THROWING, a source with no alpha channel at all (#1203 review)', async () => {
    // `stats()` reports the input's own channels, so an RGB file has no fourth one to index. Under
    // --strict that TypeError failed the whole native build for the exact input the warning is for.
    const rgb = path.join(root, 'rgb.png');
    await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(rgb);
    const { notes, missing } = await writeAndroidNotificationIcon({ projectRoot: root, srcAbs: rgb });
    expect(notes.join(' ')).toMatch(/solid square/);
    expect(missing.join(' ')).toMatch(/fully opaque/);
  });

  it('reports a source with nothing above the haze floor as MISSING, so the run is not stamped (#1203 review)', async () => {
    await writeAndroidNotificationIcon({ projectRoot: root, srcAbs: glyph });
    const faint = path.join(root, 'faint.png');
    await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 40 / 255 } } })
      .png().toFile(faint);
    const { written, missing } = await writeAndroidNotificationIcon({ projectRoot: root, srcAbs: faint });
    expect(written).toEqual([]);
    expect(missing.join(' ')).toMatch(/alpha floor/);
  });

  it('says so, rather than throwing, when there is no android project', async () => {
    const bare = makeScratchDir('modoki-notif-bare-');
    const { written, notes } = await writeAndroidNotificationIcon({ projectRoot: bare, srcAbs: glyph });
    expect(written).toEqual([]);
    expect(notes.join(' ')).toMatch(/no android res/);
    fs.rmSync(bare, { recursive: true, force: true });
  });
});
