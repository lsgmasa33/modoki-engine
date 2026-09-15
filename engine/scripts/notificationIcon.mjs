/** Android's notification SMALL ICON — the glyph in the status bar and the shade (#1203).
 *
 *  `@capacitor/local-notifications` looks the icon up by drawable NAME: first
 *  `capacitor.config.json` `plugins.LocalNotifications.smallIcon`, then the per-notification
 *  `smallIcon`, and when neither resolves it falls back to a FRAMEWORK drawable
 *  (`LocalNotificationManager.getDefaultSmallIcon`). On a device that is a generic white "i" in a
 *  circle, `dumpsys notification` shows `icon=… id=0x0108009b`, and the `0x01` prefix is the tell.
 *  `@capacitor/assets` emits nothing for this slot, so no project had one.
 *
 *  Android renders a small icon from its ALPHA alone. Colour in the art is discarded, and a
 *  full-colour launcher icon becomes a solid white square. So the source has to be a silhouette,
 *  and the one a project already authors for the themed launcher (`app.iconMonochromeSource`) is
 *  usually the right file. It is still a SEPARATE setting (`app.notificationIconSource`), for two
 *  reasons:
 *   - **Opt-in keeps 24 projects' native dirs still.** Emitting for every project would commit
 *     five new PNGs into each, for a plugin almost none of them include.
 *   - **The two slots can want different art.** The launcher layer is 108dp. This is 24dp, where
 *     detail that reads on a home screen turns to mush.
 *
 *  Unlike the launcher variants there is NO derivation. A silhouette recovered from a painting is
 *  the fallback #397 warns about, and at 24dp it would be a smudge where Android's own "i" is at
 *  least legible.
 *
 *  Runs after the #236 restore, like `iconVariants.mjs`: the `drawable-*` buckets it writes are
 *  inside the Android product directory, so the snapshot never held them. */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { GENERATED_PNG } from './iconAssets.mjs';

const ANDROID_RES_DIR = path.join('android', 'app', 'src', 'main', 'res');

/** The drawable's resource name. The engine owns it, so a project's `capacitor.config.json`
 *  `plugins.LocalNotifications.smallIcon` must say exactly this. A game that sets
 *  `notificationIconSource` should pin that match in a test, since nothing at build time can see
 *  the plugin's lookup fail. */
export const ANDROID_NOTIFICATION_ICON = 'ic_stat_notification';

/** Material's status-bar icon is a 24dp canvas, and these are its pixel sizes per density. It is a
 *  PLATFORM spec, not a tuning knob. (The launcher variants size off the foreground beside them
 *  instead, but there is nothing beside a drawable to size off.) `ldpi` is omitted, as it is from
 *  every modern template: Android scales mdpi down for the few devices that still report it. */
export const NOTIFICATION_ICON_SIZES = /** @type {const} */ ({
  'drawable-mdpi': 24,
  'drawable-hdpi': 36,
  'drawable-xhdpi': 48,
  'drawable-xxhdpi': 72,
  'drawable-xxxhdpi': 96,
});

/** Material's live area is 22dp of the 24dp canvas. The mark is fitted inside it, centred, so a
 *  status bar does not butt it against the next icon. */
const LIVE_AREA = 22 / 24;

/** Alpha below this is haze, not mark. A brush silhouette carries a faint wash out to its canvas
 *  edge. Measured on Weaveling's master, cropping at alpha >= 16 keeps 19..1011 of 1024, which
 *  leaves the mark the size it already is. At >= 64 the grid itself is 81..943. Cropping to the
 *  haze would shrink the mark by a fifth for pixels nobody can see at 24dp. */
const MARK_ALPHA_FLOOR = 64;

/** The silhouette as a white, alpha-only small icon of `size` px. Returns `null` when the source
 *  has no pixel above the haze floor, i.e. nothing to draw. */
export async function renderNotificationIcon(srcAbs, size) {
  const { data, info } = await sharp(srcAbs).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  // RGB forced to white and the source's alpha kept. Android ignores the RGB anyway, but a
  // committed artifact whose colour says something the device will not show is a trap for the
  // next reader.
  const white = Buffer.alloc(w * h * 4, 255);
  for (let p = 0; p < w * h; p++) {
    const a = data[p * 4 + 3];
    white[p * 4 + 3] = a;
    if (a < MARK_ALPHA_FLOOR) continue;
    const x = p % w, y = (p - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const live = Math.round(size * LIVE_AREA);
  const mark = await sharp(white, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
    .resize(live, live, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toBuffer();
  const lead = Math.floor((size - live) / 2);
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } })
    .composite([{ input: mark, left: lead, top: lead }])
    .png(GENERATED_PNG)
    .toBuffer();
}

/** True when every pixel is fully opaque, which Android draws as a solid square.
 *
 *  ⚠️ libvips' own `isOpaque`, not a channel read. Indexing `stats().channels[3]` threw on an RGB PNG
 *  or a JPEG, which have no fourth channel, and `--strict` made that a failed native build. Reading
 *  the last channel's `min === 255` then missed 16-bit art, whose opaque alpha is 65535. `isOpaque`
 *  covers no-alpha, grey+alpha, palette and 16-bit inputs in one place. */
async function isFullyOpaque(srcAbs) {
  return (await sharp(srcAbs).stats()).isOpaque;
}

/** Emit `drawable-<density>/ic_stat_notification.png` from `srcAbs`, or remove it when the setting
 *  was positively cleared. Returns `{ written, removed, notes, missing }`, where `missing` means an
 *  input was requested and nothing usable came of it, which joins the caller's no-stamp list (#1028).
 *
 *  `cleared` is not implied by an absent `srcAbs`, and the difference is the splash's facet-B lesson
 *  (`iconInputs.mjs`). A hand run over a config it could not read has no source because it cannot
 *  SEE one. Removing there would delete a game's committed icons behind a banner saying "clearing
 *  nothing". */
export async function writeAndroidNotificationIcon({ projectRoot, srcAbs, cleared = false }) {
  const res = path.join(projectRoot, ANDROID_RES_DIR);
  const written = [];
  const removed = [];
  const notes = [];
  const missing = [];
  if (!fs.existsSync(res)) {
    notes.push('no android res/ — skipped the notification icon');
    return { written, removed, notes, missing };
  }
  const file = `${ANDROID_NOTIFICATION_ICON}.png`;

  if (!srcAbs) {
    if (!cleared) return { written, removed, notes, missing };
    // Clearing the setting has to clear its output. Otherwise the last build's icon keeps shipping
    // and "remove the notification icon" appears to do nothing, which is the splash's #236 lesson.
    for (const bucket of Object.keys(NOTIFICATION_ICON_SIZES)) {
      const abs = path.join(res, bucket, file);
      if (!fs.existsSync(abs)) continue;
      fs.rmSync(abs);
      removed.push(path.join(bucket, file));
    }
    return { written, removed, notes, missing };
  }

  if (!fs.existsSync(srcAbs)) {
    // No derivation to degrade to, so the committed icon (if any) stays and the run is not stamped.
    notes.push(`notificationIconSource not found, notification icon left as it was: ${srcAbs}`);
    missing.push(`notificationIconSource: ${srcAbs}`);
    return { written, removed, notes, missing };
  }
  if (await isFullyOpaque(srcAbs)) {
    // Degraded, not just warned about: five white squares are never what anyone meant (usually the
    // colour app icon picked by mistake), and writing them would overwrite a good silhouette and pass
    // --strict behind one note. Same treatment as a source with nothing to draw.
    notes.push(`⚠️ notificationIconSource has no transparency, so Android would draw it as a solid square — not emitted: ${srcAbs}`);
    missing.push(`notificationIconSource (fully opaque, would be a solid square): ${srcAbs}`);
    return { written, removed, notes, missing };
  }

  for (const [bucket, size] of Object.entries(NOTIFICATION_ICON_SIZES)) {
    const buf = await renderNotificationIcon(srcAbs, size);
    if (!buf) {
      // Requested, and nothing usable came of it, so this joins `missing` like an unreadable path.
      // Stamped, it would be a green build whose reminder shows the framework "i" (first opt-in) or
      // keeps the previous art (a re-cut), behind one log line.
      notes.push(`⚠️ notificationIconSource has no pixel at alpha >= ${MARK_ALPHA_FLOOR}, so there is nothing to draw: ${srcAbs}`);
      missing.push(`notificationIconSource (nothing above the alpha floor): ${srcAbs}`);
      return { written, removed, notes, missing };
    }
    fs.mkdirSync(path.join(res, bucket), { recursive: true });
    fs.writeFileSync(path.join(res, bucket, file), buf);
    written.push(path.join(bucket, file));
  }
  return { written, removed, notes, missing };
}
