/** Composite the title wordmark and the "Made by Modoki Engine" badge onto the generated splash
 *  images (#396).
 *
 *  Runs AFTER `@capacitor/assets`, over its own output, one pass per generated bucket. That
 *  ordering is deliberate and is what makes the geometry tractable: the tool has already
 *  cover-cropped the master into each bucket's shape, so every file this touches is exactly the
 *  shape it will be shown at, and each overlay can be placed against that file's own crop-safe
 *  box (`splashLayout.mjs`) rather than against a master that is cropped differently everywhere.
 *
 *  Painting the title in at generation time rather than into the art has a second reason beyond
 *  geometry: the title is the one element on a launch screen that must be perfect, and an image
 *  generator mangles lettering often enough that it cannot be trusted with it.
 *
 *  **The badge picks its own colour.** It ships as two committed PNGs — cream for a dark ground,
 *  navy for a light one — and the variant is chosen by MEASURING the mean luminance of the
 *  region it is about to cover, per bucket. A fixed colour would be invisible on half the
 *  splashes it lands on, and dark-mode buckets are generated from different art than light ones,
 *  so the answer genuinely differs file to file.
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { safeBox, overlayRect, badgeRect } from './splashLayout.mjs';
import { GENERATED_PNG } from './iconAssets.mjs';

/** Where each platform's generated splashes live, relative to the project root. */
const IOS_SPLASH_DIR = path.join('ios', 'App', 'App', 'Assets.xcassets', 'Splash.imageset');
const ANDROID_RES_DIR = path.join('android', 'app', 'src', 'main', 'res');

/** Every generated splash PNG for `platform`, absolute.
 *
 *  Discovered from disk rather than from a table of bucket names: `@capacitor/assets` emits 26
 *  Android buckets today and has changed that set between versions, and a hardcoded list would
 *  silently stop overlaying the ones it did not know about — a partial splash set is worse than
 *  none, because it looks fine on the device you happen to test. */
export function splashOutputs(projectRoot, platform) {
  const out = [];
  if (platform === 'ios') {
    const dir = path.join(projectRoot, IOS_SPLASH_DIR);
    let names;
    try { names = fs.readdirSync(dir); } catch { return out; }
    // Only the files the catalog actually references. The imageset also carries panda-era
    // `splash-2732x2732*.png` leftovers in some projects, which Xcode never reads and which
    // overlaying would only make look authored.
    let referenced = new Set();
    try {
      const contents = JSON.parse(fs.readFileSync(path.join(dir, 'Contents.json'), 'utf8'));
      referenced = new Set((contents.images ?? []).map((i) => i.filename).filter(Boolean));
    } catch { /* no catalog → fall through to the extension filter below */ }
    for (const n of names) {
      if (!n.endsWith('.png')) continue;
      if (referenced.size && !referenced.has(n)) continue;
      out.push(path.join(dir, n));
    }
    return out;
  }
  const res = path.join(projectRoot, ANDROID_RES_DIR);
  let dirs;
  try { dirs = fs.readdirSync(res, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || !d.name.startsWith('drawable')) continue;
    const f = path.join(res, d.name, 'splash.png');
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

/** Mean luminance (0..1) of `rect` within `src` (a path or a buffer — sharp takes either).
 *  Used to choose the badge variant. */
async function regionLuminanceOf(src, rect) {
  const { width, height } = await sharp(src).metadata();
  const left = Math.max(0, Math.min(width - 1, rect.x));
  const top = Math.max(0, Math.min(height - 1, rect.y));
  const w = Math.max(1, Math.min(width - left, rect.w));
  const h = Math.max(1, Math.min(height - top, rect.h));
  const stats = await sharp(src).extract({ left, top, width: w, height: h }).stats();
  // `stats.channels` is [r,g,b,(a)] means in 0..255. Rec.709 on the means is close enough for a
  // light/dark decision and far cheaper than a per-pixel pass over 26 buckets.
  const [r, g, b] = stats.channels;
  return (r.mean * 0.2126 + g.mean * 0.7152 + b.mean * 0.0722) / 255;
}

/** The luminance above which a splash region counts as LIGHT, and so takes the navy badge.
 *  0.5 sits at mid-grey; Court's painted wood measures well below it and a white splash well
 *  above, so nothing real lands near the boundary. */
const LIGHT_GROUND_THRESHOLD = 0.5;

/** PNG settings for a splash. The measurements and the reasoning live with the constant
 *  (`iconAssets.mjs` § GENERATED_PNG) rather than being restated here — the same options apply to
 *  the icon variants, and two copies of a rationale drift.
 *
 *  What is specific to a splash: it is opaque by definition, so `encodeSplash` also FLATTENS away
 *  the alpha channel compositing introduces. An all-255 alpha plane is pure waste. */
const SPLASH_PNG = GENERATED_PNG;

/** Re-encode one splash efficiently, flattening the alpha compositing introduces. */
function encodeSplash(pipeline) {
  return pipeline.flatten({ background: '#000000' }).png(SPLASH_PNG).toBuffer();
}

/** The overlay layers for one base image of `width` x `height`.
 *
 *  Shared by the native pass below and the WEB boot splash (`bootSplash.mjs`), so the launch
 *  screen a player sees before the web view boots and the one they see after it are composed by
 *  the same code at the same proportions. They are different files at different resolutions; if
 *  the geometry were stated twice they would drift, and the drift would show as the title jumping
 *  at the exact moment the native splash hands over. */
export async function overlayLayersFor({
  base, width, height, orientation = 'any',
  titleSrc = '', titleWidthPct = 55, titleOffsetPct = -8,
  badge = false, badgeLightArt = '', badgeDarkArt = '',
}) {
  const safe = safeBox(width, height, orientation);
  const layers = [];
  const clamped = [];

  if (titleSrc) {
    const meta = await sharp(titleSrc).metadata();
    const aspect = meta.width / meta.height;
    if (aspect > 0) {
      const r = overlayRect(safe, { widthPct: titleWidthPct, offsetPct: titleOffsetPct, aspect });
      if (r.clamped) clamped.push('title');
      layers.push({ input: await sharp(titleSrc).resize(r.w, r.h, { fit: 'fill' }).png().toBuffer(), left: r.x, top: r.y });
    }
  }

  if (badge && badgeLightArt) {
    const meta = await sharp(badgeLightArt).metadata();
    const aspect = meta.width / meta.height;
    if (aspect > 0) {
      const r = badgeRect(safe, aspect);
      if (r.clamped) clamped.push('badge');
      const art = (await regionLuminanceOf(base, r)) > LIGHT_GROUND_THRESHOLD ? badgeDarkArt : badgeLightArt;
      layers.push({ input: await sharp(art).resize(r.w, r.h, { fit: 'fill' }).png().toBuffer(), left: r.x, top: r.y });
    }
  }
  return { layers, clamped };
}

/** Composite the overlays onto an arbitrary image and return it as a WEB image (WebP).
 *
 *  This is the boot splash the browser shows: the same art and the same placement as the native
 *  launch screen, at a size and codec that suit a page load rather than an app bundle. */
export async function composeWebSplash({ srcPath, size = 1440, ...opts }) {
  const base = await sharp(srcPath).resize(size, size, { fit: 'cover' }).png().toBuffer();
  const { layers, clamped } = await overlayLayersFor({ base, width: size, height: size, ...opts });
  const out = layers.length ? sharp(base).composite(layers) : sharp(base);
  return {
    buffer: await out.flatten({ background: '#000000' }).webp({ quality: 82 }).toBuffer(),
    clamped,
  };
}

/** Composite the configured overlays onto every generated splash for one platform.
 *
 *  Returns a report rather than logging directly, so the caller owns the build output and the
 *  tests can assert on the decisions: `{files, title, badge, clamped}`. */
export async function composeSplashOverlays({
  projectRoot,
  platform,
  orientation = 'any',
  titleSrc = '',
  titleWidthPct = 55,
  titleOffsetPct = -8,
  badge = false,
  badgeLightArt = '',
  badgeDarkArt = '',
  optimise = false,
}) {
  const report = { files: 0, title: 0, badge: 0, clamped: [], bytesSaved: 0 };
  // `optimise` covers the project that authors a splash but no overlays: its images are just as
  // oversized, and without this they would never be re-encoded at all.
  if (!titleSrc && !badge && !optimise) return report;

  for (const file of splashOutputs(projectRoot, platform)) {
    const { width, height } = await sharp(file).metadata();
    if (!width || !height) continue;
    const { layers, clamped } = await overlayLayersFor({
      base: file, width, height, orientation,
      titleSrc, titleWidthPct, titleOffsetPct, badge, badgeLightArt, badgeDarkArt,
    });
    const where = `${path.basename(path.dirname(file))}/${path.basename(file)}`;
    for (const what of clamped) report.clamped.push(`${where} (${what})`);
    if (titleSrc) report.title++;
    if (badge && badgeLightArt) report.badge++;

    if (!layers.length && !optimise) continue;
    // sharp cannot read and write the same file in one pipeline, so compose to a buffer first.
    const before = fs.statSync(file).size;
    const composed = await encodeSplash(layers.length ? sharp(file).composite(layers) : sharp(file));
    fs.writeFileSync(file, composed);
    report.bytesSaved += before - composed.length;
    report.files++;
  }
  return report;
}
