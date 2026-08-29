/** The per-platform icon variants `@capacitor/assets@3.0.5` does not emit (#397).
 *
 *  The derivations themselves are image work and are checked by eye at true size; what CAN
 *  silently regress is the wiring around them — the adaptive XML edit that has to be idempotent
 *  because it runs on every build, the catalog entries that must be replaced rather than
 *  appended, and an override that must be reported rather than swallowed when its path is wrong.
 *  Those are what these tests hold. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  withMonochromeLayer,
  writeIosIconVariants,
  writeAndroidIconVariants,
  IOS_DARK_FILE,
  IOS_TINTED_FILE,
  ANDROID_MONOCHROME_FILE,
} from '../../scripts/iconVariants.mjs';

const ADAPTIVE_XML = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background>
        <inset android:drawable="@mipmap/ic_launcher_background" android:inset="16.7%" />
    </background>
    <foreground>
        <inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="16.7%" />
    </foreground>
</adaptive-icon>
`;

let root: string;
let master: string;

const RES = path.join('android', 'app', 'src', 'main', 'res');
const APPICON = path.join('ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');

const write = (rel: string, body: string) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};

/** A master with a light subject on a dark ground — the shape every derivation assumes. */
async function makeMaster(file: string, size = 128) {
  const half = Math.floor(size / 2);
  const buf = await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 20, g: 20, b: 40, alpha: 1 } },
  })
    .composite([{
      input: {
        create: { width: half, height: half, channels: 4, background: { r: 250, g: 235, b: 220, alpha: 1 } },
      },
      left: Math.floor(size / 4),
      top: Math.floor(size / 4),
    }])
    .png()
    .toBuffer();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-variants-'));
  master = path.join(root, 'master.png');
  await makeMaster(master);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('withMonochromeLayer — the adaptive XML edit', () => {
  it('adds a monochrome layer inset to match the foreground', () => {
    const out = withMonochromeLayer(ADAPTIVE_XML);
    expect(out).toMatch(/<monochrome>/);
    expect(out).toMatch(/@mipmap\/ic_launcher_monochrome/);
    // Same inset as <foreground>: the layers must line up or the silhouette sits proud of the art.
    expect(out).toMatch(/ic_launcher_monochrome" android:inset="16\.7%"/);
    expect(out.trimEnd().endsWith('</adaptive-icon>')).toBe(true);
  });

  it('is IDEMPOTENT — it runs on every build, and a second pass must not stack layers', () => {
    const once = withMonochromeLayer(ADAPTIVE_XML);
    const twice = withMonochromeLayer(once);
    expect(twice).toBe(once);
    expect(twice.match(/<monochrome>/g)).toHaveLength(1);
  });

  it('leaves the background and foreground layers untouched', () => {
    const out = withMonochromeLayer(ADAPTIVE_XML);
    expect(out).toContain('<inset android:drawable="@mipmap/ic_launcher_background" android:inset="16.7%" />');
    expect(out).toContain('<inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="16.7%" />');
  });

  it('is idempotent against the SELF-CLOSING form Android\'s own docs use', () => {
    // Found in review. The strip only matched <monochrome>…</monochrome>, so a project that had
    // hand-authored `<monochrome android:drawable="@drawable/x"/>` gained a SECOND layer on every
    // build. The original test fed the paired form back in, so it passed either way.
    const handAuthored = ADAPTIVE_XML.replace(
      '</adaptive-icon>',
      '    <monochrome android:drawable="@drawable/my_own" />\n</adaptive-icon>',
    );
    const out = withMonochromeLayer(handAuthored);
    expect(out.match(/<monochrome/g)).toHaveLength(1);
    expect(out).toContain('@mipmap/ic_launcher_monochrome');
    expect(out).not.toContain('@drawable/my_own');
    expect(withMonochromeLayer(out)).toBe(out);
  });

  it('returns a document it does not recognise unchanged rather than corrupting it', () => {
    expect(withMonochromeLayer('<not-an-adaptive-icon/>')).toBe('<not-an-adaptive-icon/>');
  });
});

describe('writeAndroidIconVariants', () => {
  const densities = ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xxxhdpi'];

  beforeEach(async () => {
    for (const d of densities) await makeMaster(path.join(root, RES, d, 'ic_launcher_foreground.png'), 48);
    write(path.join(RES, 'mipmap-anydpi-v26', 'ic_launcher.xml'), ADAPTIVE_XML);
    write(path.join(RES, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), ADAPTIVE_XML);
  });

  it('emits one monochrome PNG per density that has a foreground, and patches BOTH XMLs', async () => {
    const { written } = await writeAndroidIconVariants({ projectRoot: root, iconSrcAbs: master });
    for (const d of densities) {
      expect(fs.existsSync(path.join(root, RES, d, ANDROID_MONOCHROME_FILE))).toBe(true);
    }
    expect(written).toContain(path.join('mipmap-anydpi-v26', 'ic_launcher.xml'));
    expect(written).toContain(path.join('mipmap-anydpi-v26', 'ic_launcher_round.xml'));
    // #397 flagged ic_launcher_round.xml as the one an implementation forgets — both or neither.
    for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
      expect(fs.readFileSync(path.join(root, RES, 'mipmap-anydpi-v26', name), 'utf8')).toMatch(/<monochrome>/);
    }
  });

  it('sizes each monochrome layer off the FOREGROUND beside it, not off a table of densities', async () => {
    await makeMaster(path.join(root, RES, 'mipmap-hdpi', 'ic_launcher_foreground.png'), 72);
    await writeAndroidIconVariants({ projectRoot: root, iconSrcAbs: master });
    const mono = await sharp(path.join(root, RES, 'mipmap-hdpi', ANDROID_MONOCHROME_FILE)).metadata();
    expect(mono.width).toBe(72);
    const other = await sharp(path.join(root, RES, 'mipmap-mdpi', ANDROID_MONOCHROME_FILE)).metadata();
    expect(other.width).toBe(48);
  });

  it('derives the silhouette from LUMINANCE — the light subject becomes opaque, the dark ground clear', async () => {
    await writeAndroidIconVariants({ projectRoot: root, iconSrcAbs: master });
    const file = path.join(root, RES, 'mipmap-mdpi', ANDROID_MONOCHROME_FILE);
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    expect(at(info.width >> 1, info.height >> 1)).toBeGreaterThan(200); // centre = the light square
    expect(at(1, 1)).toBeLessThan(60);                                  // corner = the dark ground
  });

  it('uses an authored override in place of the derivation', async () => {
    // A fully-opaque white override: nothing the luminance derivation would ever produce from
    // a master with a dark ground, so this distinguishes "read the override" from "derived".
    const override = path.join(root, 'mono.png');
    await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
      .png().toFile(override);
    await writeAndroidIconVariants({ projectRoot: root, iconSrcAbs: master, monochromeSrcAbs: override });
    const { data, info } = await sharp(path.join(root, RES, 'mipmap-mdpi', ANDROID_MONOCHROME_FILE))
      .raw().toBuffer({ resolveWithObject: true });
    expect(data[(0 * info.width + 0) * info.channels + 3]).toBeGreaterThan(200); // opaque corner
  });

  it('REPORTS an override whose path is wrong instead of silently deriving', async () => {
    const { notes } = await writeAndroidIconVariants({
      projectRoot: root,
      iconSrcAbs: master,
      monochromeSrcAbs: path.join(root, 'does-not-exist.png'),
    });
    expect(notes.join(' ')).toMatch(/iconMonochromeSource override not found/);
    // …and still emits the derived fallback, so the build does not lose the layer entirely.
    expect(fs.existsSync(path.join(root, RES, 'mipmap-mdpi', ANDROID_MONOCHROME_FILE))).toBe(true);
  });

  it('says so, rather than throwing, when there is no android project', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-bare-'));
    const { written, notes } = await writeAndroidIconVariants({ projectRoot: bare, iconSrcAbs: master });
    expect(written).toEqual([]);
    expect(notes.join(' ')).toMatch(/no android res/);
    fs.rmSync(bare, { recursive: true, force: true });
  });
});

describe('writeIosIconVariants', () => {
  const CONTENTS = JSON.stringify({
    images: [{ idiom: 'universal', size: '1024x1024', filename: 'AppIcon-512@2x.png', platform: 'ios' }],
    info: { author: 'xcode', version: 1 },
  }, null, 2);

  beforeEach(() => { write(path.join(APPICON, 'Contents.json'), CONTENTS); });

  it('writes both variant images and registers them with the right appearances', async () => {
    await writeIosIconVariants({ projectRoot: root, iconSrcAbs: master });
    expect(fs.existsSync(path.join(root, APPICON, IOS_DARK_FILE))).toBe(true);
    expect(fs.existsSync(path.join(root, APPICON, IOS_TINTED_FILE))).toBe(true);
    const json = JSON.parse(fs.readFileSync(path.join(root, APPICON, 'Contents.json'), 'utf8'));
    const dark = json.images.find((i: { filename?: string }) => i.filename === IOS_DARK_FILE);
    const tinted = json.images.find((i: { filename?: string }) => i.filename === IOS_TINTED_FILE);
    expect(dark.appearances).toEqual([{ appearance: 'luminosity', value: 'dark' }]);
    expect(tinted.appearances).toEqual([{ appearance: 'luminosity', value: 'tinted' }]);
    // The base entry survives — a dark icon must not cost the light one.
    expect(json.images.some((i: { filename?: string }) => i.filename === 'AppIcon-512@2x.png')).toBe(true);
  });

  it('REPLACES its entries on a rebuild rather than growing the catalog every time', async () => {
    await writeIosIconVariants({ projectRoot: root, iconSrcAbs: master });
    await writeIosIconVariants({ projectRoot: root, iconSrcAbs: master });
    await writeIosIconVariants({ projectRoot: root, iconSrcAbs: master });
    const json = JSON.parse(fs.readFileSync(path.join(root, APPICON, 'Contents.json'), 'utf8'));
    expect(json.images).toHaveLength(3);
  });

  it('emits the variants at 1024, the size the catalog entry declares', async () => {
    await writeIosIconVariants({ projectRoot: root, iconSrcAbs: master });
    for (const f of [IOS_DARK_FILE, IOS_TINTED_FILE]) {
      const m = await sharp(path.join(root, APPICON, f)).metadata();
      expect([m.width, m.height]).toEqual([1024, 1024]);
    }
  });

  it('makes the tinted variant GREYSCALE — iOS tints its luminance, so colour there is a bug', async () => {
    await writeIosIconVariants({ projectRoot: root, iconSrcAbs: master });
    const { data, info } = await sharp(path.join(root, APPICON, IOS_TINTED_FILE))
      .raw().toBuffer({ resolveWithObject: true });
    for (const p of [0, 500, 12345, 99999]) {
      const i = p * info.channels;
      expect(data[i]).toBe(data[i + 1]);
      expect(data[i + 1]).toBe(data[i + 2]);
    }
  });

  it('encodes the variants for a COMMITTED artifact, not with sharp\'s encode-speed defaults', async () => {
    // These files are committed and shipped in every app bundle, so the trade sharp defaults to
    // is the wrong one. Court's real dark variant measured 2.58 MB under the defaults and 0.75 MB
    // under GENERATED_PNG — losslessly. Asserted as a MEASUREMENT rather than by grepping for the
    // constant: a source-level check passes just as happily on a call site that imports the
    // constant and then ignores it.
    const noisy = path.join(root, 'noisy.png');
    const size = 512;
    const raw = Buffer.alloc(size * size * 3);
    // Deterministic pseudo-noise: photographic-ish, which is the case PNG defaults handle worst.
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) % 256;
    await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toFile(noisy);

    await writeIosIconVariants({ projectRoot: root, iconSrcAbs: noisy });
    const written = fs.statSync(path.join(root, APPICON, IOS_DARK_FILE)).size;
    // The same pixels through sharp's default encoder, as the baseline to beat.
    const baseline = (await sharp(noisy).resize(1024, 1024, { fit: 'cover' })
      .flatten({ background: '#111111' }).linear(0.85, 0).png().toBuffer()).length;
    expect(written).toBeLessThan(baseline);
  });

  it('says so, rather than throwing, when there is no asset catalog', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-bare-ios-'));
    const { written, notes } = await writeIosIconVariants({ projectRoot: bare, iconSrcAbs: master });
    expect(written).toEqual([]);
    expect(notes.join(' ')).toMatch(/no AppIcon\.appiconset/);
    fs.rmSync(bare, { recursive: true, force: true });
  });
});
