/** The per-platform app-icon VARIANTS that `@capacitor/assets@3.0.5` does not emit (#397).
 *
 *  The pinned generator fans one master out to the density buckets, and that part it does well.
 *  What it writes is one `universal` 1024 entry with no `appearances` key, and an
 *  `ic_launcher.xml` carrying `<background>` + `<foreground>` only. So on current hardware:
 *
 *    | Variant   | Platform  | Without this module                                        |
 *    |-----------|-----------|------------------------------------------------------------|
 *    | dark      | iOS 18+   | the light icon is used unchanged in dark mode               |
 *    | tinted    | iOS 18+   | iOS derives its own greyscale, and does it poorly           |
 *    | monochrome| Android 13+| themed icons fall back to treating the full-colour art     |
 *
 *  The Android one is not cosmetic: with no `<monochrome>` layer, a launcher with themed icons
 *  on flattens Court's pale-cream-on-painted-wood to a low-contrast blob.
 *
 *  ## Why the derivations are fallbacks and the overrides are the real answer
 *
 *  Every derivation here takes a finished PAINTING and tries to recover a mark from it, which is
 *  the wrong direction: a monochrome layer wants a silhouette that was designed as one. The
 *  derived output is emitted so no project ships nothing, and
 *  `app.icon{Dark,Tinted,Monochrome}Source` exists so any project whose icon is a painting can
 *  replace it with art that was drawn for the job. Court is exactly that case.
 *
 *  ## Why this can write where the wrapper forbids writing
 *
 *  `generate-icons.mjs` snapshots and restores everything the generator touches OUTSIDE the
 *  running platform's product directory (#236). Both files this module edits — the iOS
 *  `AppIcon.appiconset/Contents.json` and Android's `mipmap-anydpi-v26/ic_launcher*.xml` — are
 *  INSIDE those product directories, so the restore never sees them. #397 anticipated a fight
 *  with the restore over the adaptive XML; there is none, provided this keeps running after the
 *  restore rather than before it.
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { GENERATED_PNG } from './iconAssets.mjs';

const IOS_APPICON_DIR = path.join('ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
const ANDROID_RES_DIR = path.join('android', 'app', 'src', 'main', 'res');

export const IOS_DARK_FILE = 'AppIcon-1024-dark.png';
export const IOS_TINTED_FILE = 'AppIcon-1024-tinted.png';
export const ANDROID_MONOCHROME_FILE = 'ic_launcher_monochrome.png';

/** The size the catalog entry declares. Both the derived and the authored paths resize to it —
 *  a variant whose pixel size contradicts its `Contents.json` entry is a broken asset catalog,
 *  and a master smaller than 1024 is the case that finds it. */
const IOS_ICON_SIZE = 1024;

/** iOS DARK fallback: the master flattened onto the dark background colour (so a master with
 *  alpha does not composite onto white) and taken down ~15% in luminance, which is what stops an
 *  otherwise identical file being emitted for an already-opaque master. Mild on purpose — a
 *  heavier curve starts inventing art direction the author did not ask for. */
async function deriveDark(srcAbs, darkHex) {
  return sharp(srcAbs)
    .resize(IOS_ICON_SIZE, IOS_ICON_SIZE, { fit: 'cover' })
    .flatten({ background: darkHex })
    .linear(0.85, 0)
    .png(GENERATED_PNG)
    .toBuffer();
}

/** iOS TINTED fallback: greyscale, then normalised so the range actually spans the histogram.
 *  iOS applies the user's tint to the LUMINANCE of this image, so a low-contrast greyscale
 *  becomes a flat, unreadable chip — normalising is the difference between a mark and a smudge. */
async function deriveTinted(srcAbs, darkHex) {
  return sharp(srcAbs)
    .resize(IOS_ICON_SIZE, IOS_ICON_SIZE, { fit: 'cover' })
    .flatten({ background: darkHex })
    .greyscale()
    .normalise()
    .png(GENERATED_PNG)
    .toBuffer();
}

/** Android MONOCHROME fallback: white, with the master's own LUMINANCE as the alpha channel —
 *  bright subject matter becomes the silhouette, dark ground becomes transparent.
 *
 *  ⚠️ This is the derivation #397 warns about, and the warning is correct: it works when the
 *  icon is a light mark on a dark ground and produces mush otherwise. It exists so that a
 *  themed launcher has SOMETHING to tint rather than falling back to the full-colour art. */
async function deriveMonochrome(srcAbs, size) {
  const { data, info } = await sharp(srcAbs)
    .resize(size, size, { fit: 'cover' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const out = Buffer.alloc(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const i = p * ch;
    const lum = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
    const srcA = ch === 4 ? data[i + 3] / 255 : 1;
    out[p * 4] = 255; out[p * 4 + 1] = 255; out[p * 4 + 2] = 255;
    out[p * 4 + 3] = Math.round(lum * srcA * 255);
  }
  return sharp(out, { raw: { width: w, height: h, channels: 4 } }).png(GENERATED_PNG).toBuffer();
}

/** Read an override if one is configured and readable; otherwise `null` so the caller derives.
 *  An unreadable override is reported, never silently swapped for a derivation — a typo'd path
 *  that quietly falls back is how an authored variant goes missing without a single log line. */
function overrideOrNull(srcAbs, label, notes) {
  if (!srcAbs) return null;
  if (fs.existsSync(srcAbs)) return srcAbs;
  notes.push(`${label} override not found, derived instead: ${srcAbs}`);
  return null;
}

/** Emit the iOS dark + tinted entries into `AppIcon.appiconset` and register them in
 *  `Contents.json`. Returns `{written, notes}`. */
export async function writeIosIconVariants({ projectRoot, iconSrcAbs, darkSrcAbs, tintedSrcAbs, darkHex = '#111111' }) {
  const dir = path.join(projectRoot, IOS_APPICON_DIR);
  const notes = [];
  const written = [];
  const contentsPath = path.join(dir, 'Contents.json');
  if (!fs.existsSync(contentsPath)) {
    notes.push('no AppIcon.appiconset/Contents.json — skipped the iOS icon variants');
    return { written, notes };
  }

  const darkOverride = overrideOrNull(darkSrcAbs, 'iconDarkSource', notes);
  const tintedOverride = overrideOrNull(tintedSrcAbs, 'iconTintedSource', notes);

  const dark = darkOverride
    ? await sharp(darkOverride).resize(IOS_ICON_SIZE, IOS_ICON_SIZE, { fit: 'cover' }).png(GENERATED_PNG).toBuffer()
    : await deriveDark(iconSrcAbs, darkHex);
  const tinted = tintedOverride
    ? await sharp(tintedOverride).resize(IOS_ICON_SIZE, IOS_ICON_SIZE, { fit: 'cover' }).greyscale().png(GENERATED_PNG).toBuffer()
    : await deriveTinted(iconSrcAbs, darkHex);

  fs.writeFileSync(path.join(dir, IOS_DARK_FILE), dark);
  fs.writeFileSync(path.join(dir, IOS_TINTED_FILE), tinted);
  written.push(IOS_DARK_FILE, IOS_TINTED_FILE);

  const contents = JSON.parse(fs.readFileSync(contentsPath, 'utf8'));
  const images = Array.isArray(contents.images) ? contents.images : [];
  const base = images.find((i) => !i.appearances) ?? { idiom: 'universal', size: '1024x1024', platform: 'ios' };
  const entry = (filename, value) => ({
    idiom: base.idiom ?? 'universal',
    size: base.size ?? '1024x1024',
    ...(base.platform ? { platform: base.platform } : {}),
    filename,
    appearances: [{ appearance: 'luminosity', value }],
  });
  // Replace rather than append: re-running the build must not grow the catalog every time.
  const kept = images.filter((i) => !(i.appearances ?? []).some((a) => a.value === 'dark' || a.value === 'tinted'));
  contents.images = [...kept, entry(IOS_DARK_FILE, 'dark'), entry(IOS_TINTED_FILE, 'tinted')];
  fs.writeFileSync(contentsPath, `${JSON.stringify(contents, null, 2)}\n`);
  return { written, notes };
}

/** The adaptive-icon XML with a `<monochrome>` layer added, inset to match `<foreground>`.
 *
 *  Pure string work on purpose — the file is a four-line document the generator itself writes
 *  from a template, and parsing it into a DOM to re-serialize would reformat every line and put
 *  this back into the churn business #236 got the build out of. Idempotent: an existing
 *  `<monochrome>` block is replaced, not duplicated. */
export function withMonochromeLayer(xml, drawable = '@mipmap/ic_launcher_monochrome', inset = '16.7%') {
  const layer = `    <monochrome>\n`
    + `        <inset android:drawable="${drawable}" android:inset="${inset}" />\n`
    + `    </monochrome>\n`;
  // Both spellings: the paired form this writes, and the SELF-CLOSING form Android's own
  // docs use — stripping only the former appended a second <monochrome> on every build of a
  // project that had hand-authored one.
  const stripped = xml
    .replace(/[ \t]*<monochrome>[\s\S]*?<\/monochrome>\s*/g, '')
    .replace(/[ \t]*<monochrome\b[^>]*\/>\s*/g, '');
  if (!/<\/adaptive-icon>/.test(stripped)) return stripped;
  return stripped.replace(/([ \t]*)<\/adaptive-icon>/, `${layer}$1</adaptive-icon>`);
}

/** Emit `ic_launcher_monochrome.png` per density and add the `<monochrome>` layer to both
 *  adaptive-icon XMLs. Returns `{written, notes}`. */
export async function writeAndroidIconVariants({ projectRoot, iconSrcAbs, monochromeSrcAbs }) {
  const res = path.join(projectRoot, ANDROID_RES_DIR);
  const notes = [];
  const written = [];
  if (!fs.existsSync(res)) {
    notes.push('no android res/ — skipped the monochrome layer');
    return { written, notes };
  }
  const override = overrideOrNull(monochromeSrcAbs, 'iconMonochromeSource', notes);

  let emitted = 0;
  for (const d of fs.readdirSync(res, { withFileTypes: true })) {
    if (!d.isDirectory() || !d.name.startsWith('mipmap-') || d.name === 'mipmap-anydpi-v26') continue;
    // Size it off the foreground the generator just wrote for this density, so the monochrome
    // layer lines up with the layer it sits beside — rather than a table of density pixel sizes
    // kept in sync by hand.
    const foreground = path.join(res, d.name, 'ic_launcher_foreground.png');
    if (!fs.existsSync(foreground)) continue;
    const { width } = await sharp(foreground).metadata();
    if (!width) continue;
    const buf = override
      ? await sharp(override).resize(width, width, { fit: 'cover' }).png(GENERATED_PNG).toBuffer()
      : await deriveMonochrome(iconSrcAbs, width);
    fs.writeFileSync(path.join(res, d.name, ANDROID_MONOCHROME_FILE), buf);
    written.push(path.join(d.name, ANDROID_MONOCHROME_FILE));
    emitted++;
  }
  if (!emitted) {
    notes.push('no mipmap-*/ic_launcher_foreground.png found — monochrome PNGs not emitted');
    return { written, notes };
  }

  for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const p = path.join(res, 'mipmap-anydpi-v26', name);
    if (!fs.existsSync(p)) continue;
    const before = fs.readFileSync(p, 'utf8');
    const after = withMonochromeLayer(before);
    if (after !== before) {
      fs.writeFileSync(p, after);
      written.push(path.join('mipmap-anydpi-v26', name));
    }
  }
  return { written, notes };
}
