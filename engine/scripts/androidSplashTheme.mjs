/** The Android 12+ system splash — the only launch surface Android will actually draw (#396).
 *
 *  ## Why the authored splash is not enough on Android
 *
 *  Measured on a Galaxy S22 (API 34): the 26 generated `drawable-*` splash buckets are NEVER
 *  SHOWN. The launch theme inherits `Theme.SplashScreen`, and from API 31 the platform draws its
 *  own splash and ignores `android:windowBackground` unless it is a single colour — so a player saw
 *  the app icon on a black field,
 *  and every one of those buckets was dead weight. Court's floor is `minSdkVersion 31`, so this is
 *  not an old-device edge case: it is every supported Android device.
 *
 *  (The `android:background` Capacitor's template sets on that theme is a VIEW attribute, and was
 *  never the window background — it was inert long before API 31 mattered. The buckets it names are
 *  dead either way; the platform simply makes it unambiguous.)
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
import { splashEdgeColour } from './splashCompose.mjs';

const STYLES = path.join('android', 'app', 'src', 'main', 'res', 'values', 'styles.xml');

/** Marks the block this module owns, so a rebuild replaces its own work and never touches a
 *  hand-authored line beside it. */
const BEGIN = '<!-- modoki:splash-begin — generated from app.splashSource -->';
const END = '<!-- modoki:splash-end -->';

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

export { splashEdgeColour };

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
  if (after === before) {
    // Two ways to land here, and they mean opposite things. Either the block is already correct
    // (a rebuild — the common case, silent by design), or `withSplashTheme` DECLINED: no
    // `AppTheme.NoActionBarLaunch` in this styles.xml, or its `>` is not followed by a bare `\n`
    // (CRLF). The decline used to be indistinguishable from success, so a renamed launch theme
    // left the system splash black with the build printing nothing at all.
    if (!/windowSplashScreenBackground/.test(after)) {
      notes.push(`could not find an AppTheme.NoActionBarLaunch style in ${STYLES} — system splash colour NOT set`);
    }
    return { changed: false, colour, notes };
  }
  fs.writeFileSync(file, after);
  return { changed: true, colour, notes };
}
