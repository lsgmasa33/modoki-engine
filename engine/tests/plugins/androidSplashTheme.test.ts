/** The Android 12+ system splash colour (#396, found on hardware).
 *
 *  The generated `drawable-*` splash buckets are never drawn at `minSdkVersion 31` — the platform
 *  draws its own splash and ignores `android:background`. Measured on a Galaxy S22 (API 34): the
 *  player saw the app icon on BLACK. The platform allows only a solid colour there, so the fix is
 *  to sample one from the splash master and let the painted art arrive from the web boot splash.
 *
 *  What is pinned here is the theme edit — it runs on every build and rewrites a tracked,
 *  hand-editable file, so it has to be idempotent and it has to leave everything else alone. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { withSplashTheme, splashEdgeColour, applyAndroidSplashTheme } from '../../scripts/androidSplashTheme.mjs';

const STYLES_REL = path.join('android', 'app', 'src', 'main', 'res', 'values', 'styles.xml');

const STYLES = `<?xml version="1.0" encoding="utf-8"?>
<resources>

    <style name="AppTheme" parent="Theme.AppCompat.Light.DarkActionBar">
        <item name="colorPrimary">@color/colorPrimary</item>
    </style>

    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="windowActionBar">false</item>
    </style>

    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@drawable/splash</item>
    </style>
</resources>
`;

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-splashtheme-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('withSplashTheme', () => {
  it('writes the colour into the LAUNCH theme, which is the only one the system splash reads', () => {
    const out = withSplashTheme(STYLES, '#76502c');
    const launchBlock = out.slice(out.indexOf('AppTheme.NoActionBarLaunch'));
    expect(launchBlock).toContain('<item name="windowSplashScreenBackground">#76502c</item>');
    // NOT in the other themes.
    const beforeLaunch = out.slice(0, out.indexOf('AppTheme.NoActionBarLaunch'));
    expect(beforeLaunch).not.toContain('windowSplashScreenBackground');
  });

  it('writes BOTH spellings — the AndroidX compat attr and the platform one', () => {
    const out = withSplashTheme(STYLES, '#76502c');
    expect(out).toContain('<item name="windowSplashScreenBackground">#76502c</item>');
    expect(out).toContain('<item name="android:windowSplashScreenBackground">#76502c</item>');
  });

  it('is IDEMPOTENT — it runs on every build and must not stack blocks', () => {
    const once = withSplashTheme(STYLES, '#76502c');
    expect(withSplashTheme(once, '#76502c')).toBe(once);
    expect(once.match(/windowSplashScreenBackground/g)).toHaveLength(2); // the two spellings, once each
  });

  it('REPLACES its own block when the colour changes, rather than appending a second', () => {
    const first = withSplashTheme(STYLES, '#76502c');
    const second = withSplashTheme(first, '#112233');
    expect(second).toContain('#112233');
    expect(second).not.toContain('#76502c');
    expect(second.match(/windowSplashScreenBackground/g)).toHaveLength(2);
  });

  it('leaves every hand-authored line intact — this is a tracked file', () => {
    const out = withSplashTheme(STYLES, '#76502c');
    expect(out).toContain('<item name="colorPrimary">@color/colorPrimary</item>');
    expect(out).toContain('<item name="windowActionBar">false</item>');
    expect(out).toContain('<item name="android:background">@drawable/splash</item>');
    expect(out).toContain('parent="Theme.SplashScreen"');
  });

  it('returns a styles.xml with no launch theme unchanged rather than corrupting it', () => {
    const noLaunch = STYLES.replace(/<style name="AppTheme\.NoActionBarLaunch"[\s\S]*?<\/style>/, '');
    expect(withSplashTheme(noLaunch, '#76502c')).toBe(noLaunch);
  });
});

describe('splashEdgeColour', () => {
  /** A master shaped like Court's: a bright block in the middle, a dark border around it. */
  async function master(file: string, edge: [number, number, number], centre: [number, number, number]) {
    const size = 400;
    const buf = await sharp({ create: { width: size, height: size, channels: 3, background: { r: edge[0], g: edge[1], b: edge[2] } } })
      .composite([{
        input: { create: { width: 240, height: 240, channels: 3, background: { r: centre[0], g: centre[1], b: centre[2] } } },
        left: 80, top: 80,
      }])
      .png().toBuffer();
    fs.writeFileSync(file, buf);
  }

  it('samples the EDGE, not the whole image — the centre must not drag the colour', async () => {
    // Court's case exactly: dark wood border, big cream page in the middle. Averaging the whole
    // image would return a colour that appears nowhere on screen.
    const f = path.join(root, 'm.png');
    await master(f, [118, 80, 44], [250, 245, 225]);
    const hex = await splashEdgeColour(f);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(100); expect(r).toBeLessThan(140);
    expect(g).toBeGreaterThan(60); expect(g).toBeLessThan(100);
    expect(b).toBeGreaterThan(25); expect(b).toBeLessThan(65);
  });

  it('returns a well-formed 6-digit hex an Android theme can take verbatim', async () => {
    const f = path.join(root, 'm2.png');
    await master(f, [0, 0, 0], [255, 255, 255]);
    expect(await splashEdgeColour(f)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('applyAndroidSplashTheme', () => {
  const write = (rel: string, body: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };

  it('does nothing when the project has authored no splash', async () => {
    write(STYLES_REL, STYLES);
    const res = await applyAndroidSplashTheme({ projectRoot: root, splashSrcAbs: undefined });
    expect(res.changed).toBe(false);
    expect(fs.readFileSync(path.join(root, STYLES_REL), 'utf8')).toBe(STYLES);
  });

  it('says so, rather than throwing, when there is no styles.xml', async () => {
    const src = path.join(root, 's.png');
    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#333' } }).png().toFile(src);
    const res = await applyAndroidSplashTheme({ projectRoot: root, splashSrcAbs: src });
    expect(res.changed).toBe(false);
    expect(res.notes.join(' ')).toMatch(/styles\.xml/);
  });

  it('writes the sampled colour, and reports no change on a rebuild', async () => {
    write(STYLES_REL, STYLES);
    const src = path.join(root, 's.png');
    await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 118, g: 80, b: 44 } } }).png().toFile(src);

    const first = await applyAndroidSplashTheme({ projectRoot: root, splashSrcAbs: src });
    expect(first.changed).toBe(true);
    expect(first.colour).toMatch(/^#[0-9a-f]{6}$/);
    expect(fs.readFileSync(path.join(root, STYLES_REL), 'utf8')).toContain(first.colour!);

    // A rebuild must be a no-op — otherwise every build dirties a tracked file (#236's whole point).
    const second = await applyAndroidSplashTheme({ projectRoot: root, splashSrcAbs: src });
    expect(second.changed).toBe(false);
  });
});
