/** The Android 12+ system splash — the only launch surface Android will actually draw (#396).
 *
 *  ## Why the authored splash is not enough on Android
 *
 *  Measured on a Galaxy S22 (API 34): the 26 generated `drawable-*` splash buckets are NEVER
 *  SHOWN. The launch theme inherits `Theme.SplashScreen`, and from API 31 the platform draws its
 *  own splash and ignores `android:background` — so a player saw the app icon on a black field,
 *  and every one of those buckets was dead weight. Court's floor is `minSdkVersion 31`, so this is
 *  not an old-device edge case: it is every supported Android device.
 *
 *  ## And it cannot be fixed by drawing the art there
 *
 *  Google's splash-screen documentation is explicit — *"Set a single window background color with
 *  no transparency"*, *"The window background consists of a single opaque color"*. There is no
 *  documented way to opt out, `windowSplashScreenAnimatedIcon` is an ICON (circularly masked, 240
 *  or 288 dp), and the one image slot, `windowSplashScreenBrandingImage`, is 200x80 dp at the
 *  bottom and is recommended against. A full-bleed painted launch screen is not achievable as the
 *  SYSTEM splash on Android 12+, by platform design.
 *
 *  ## So the split is: colour here, art immediately after
 *
 *  This module makes the system splash Court-coloured instead of black, by sampling the splash
 *  master. The painted art then arrives from the WEB boot splash the moment the web view paints —
 *  which is why `App.tsx` hands the native splash over as soon as that is up, rather than holding
 *  it until the game is ready. The sequence becomes:
 *
 *      icon on the game's own colour  ->  the painted splash  ->  the game
 *
 *  matching what iOS does natively, instead of icon-on-black -> game.
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const STYLES = path.join('android', 'app', 'src', 'main', 'res', 'values', 'styles.xml');

/** Marks the block this module owns, so a rebuild replaces its own work and never touches a
 *  hand-authored line beside it. */
const BEGIN = '<!-- modoki:splash-begin — generated from app.splashSource -->';
const END = '<!-- modoki:splash-end -->';

/** The colour to put behind the icon: the mean of the master's EDGE RING.
 *
 *  The edge rather than the whole image, because the frame that follows this one is the splash
 *  cover-cropped to the screen — and what fills that frame's perimeter is the master's border. For
 *  Court that is the painted wood, not the cream page sitting in the middle of it. Sampling the
 *  whole image would average the page in and give a colour that appears nowhere. */
export async function splashEdgeColour(srcPath, ringFrac = 0.12) {
  const img = sharp(srcPath);
  const { width, height } = await img.metadata();
  const band = Math.max(1, Math.round(Math.min(width, height) * ringFrac));
  // Four strips rather than "whole image minus centre", which sharp cannot express directly.
  const strips = [
    { left: 0, top: 0, width, height: band },
    { left: 0, top: height - band, width, height: band },
    { left: 0, top: band, width: band, height: Math.max(1, height - band * 2) },
    { left: width - band, top: band, width: band, height: Math.max(1, height - band * 2) },
  ];
  let r = 0, g = 0, b = 0, weight = 0;
  for (const s of strips) {
    // ⚠️ `.extract(...).stats()` does NOT sample the extracted region — sharp's `stats()` reads the
    // INPUT image, so the crop is ignored and every strip returns the WHOLE image's mean. That
    // silently turned this function into "average the whole master", which is exactly what the
    // comment above says not to do: on Court it returned the wood averaged with the cream page,
    // a colour that appears nowhere, and the step at the handover was visible on device.
    // Materialising the region to a buffer first is what makes the crop real.
    const region = await sharp(srcPath).extract(s).toBuffer();
    const stats = await sharp(region).stats();
    const px = s.width * s.height;
    r += stats.channels[0].mean * px;
    g += stats.channels[1].mean * px;
    b += stats.channels[2].mean * px;
    weight += px;
  }
  const hex = (v) => Math.max(0, Math.min(255, Math.round(v / weight))).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** `styles.xml` with our generated block replaced (or added). Pure string work, and idempotent —
 *  it runs on every build, like the adaptive-icon XML edit.
 *
 *  Both spellings of the attribute are written: the unprefixed one is AndroidX
 *  `core-splashscreen`'s (the `Theme.SplashScreen` parent this theme already uses), and the
 *  `android:` one is the platform attribute the system reads directly from API 31. Writing both
 *  costs nothing and removes the question of which layer is in charge. */
export function withSplashTheme(xml, colour) {
  const block = `    ${BEGIN}\n`
    + `        <item name="windowSplashScreenBackground">${colour}</item>\n`
    + `        <item name="android:windowSplashScreenBackground">${colour}</item>\n`
    + `    ${END}\n`;

  // Drop any previous generated block first, so a colour change replaces rather than stacks.
  // ⚠️ Consume the block's own line ENDING only — not `\\s*`, which also swallowed the indentation
  // of the line after it. The result was semantically identical XML that differed byte-for-byte
  // every build, re-dirtying a tracked file on each run (#236's whole subject).
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = xml.replace(
    new RegExp(`[ \\t]*${esc(BEGIN)}[\\s\\S]*?${esc(END)}[ \\t]*\\n?`, 'g'),
    '',
  );

  // Insert inside the LAUNCH theme, which is the only one the system splash reads.
  const launch = /(<style\s+name="AppTheme\.NoActionBarLaunch"[^>]*>\n)/;
  if (!launch.test(stripped)) return stripped;
  return stripped.replace(launch, `$1${block}`);
}

/** Write the sampled colour into the launch theme. Returns `{changed, colour, notes}`. */
export async function applyAndroidSplashTheme({ projectRoot, splashSrcAbs }) {
  const notes = [];
  const file = path.join(projectRoot, STYLES);
  if (!splashSrcAbs || !fs.existsSync(splashSrcAbs)) return { changed: false, colour: null, notes };
  if (!fs.existsSync(file)) {
    notes.push('no android res/values/styles.xml — system splash colour not set');
    return { changed: false, colour: null, notes };
  }
  const colour = await splashEdgeColour(splashSrcAbs);
  const before = fs.readFileSync(file, 'utf8');
  const after = withSplashTheme(before, colour);
  if (after === before) return { changed: false, colour, notes };
  fs.writeFileSync(file, after);
  return { changed: true, colour, notes };
}
