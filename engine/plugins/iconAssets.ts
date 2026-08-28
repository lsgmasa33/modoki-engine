/** App-icon / splash generation inputs and the freshness stamp that decides whether the
 *  generator needs to run at all.
 *
 *  Two problems this module exists to prevent, both of which shipped:
 *
 *  1. **An unpinned generator.** The build ran a bare `npx --yes @capacitor/assets` under a
 *     comment claiming it was "verified against 3.0.5" — but `npx --yes` installs LATEST, so
 *     the comment documented a version the build did not use. The generated icons are
 *     committed release artifacts, so the tool making them is pinned here.
 *     ⚠️ That fix also blamed the extra density buckets (`drawable-*-night-*`, `*-ldpi`,
 *     `mipmap-ldpi`) on the floating version. Measured 2026-08-19: the PINNED 3.0.5 emits
 *     them too — 21 paths on forest-camp that no project commits. Pinning stopped them
 *     changing, not appearing (#236).
 *
 *  2. **Unconditional regeneration.** The step ran on every native build, rewriting every
 *     tracked mipmap/splash PNG each time. Any game that had been built therefore had a
 *     permanently dirty working tree, and real changes were buried under re-encoded binaries
 *     (measured: 95 such files across two games in a single day).
 *
 *  Note the fix is deliberately NOT "gitignore the icons". Generation is non-fatal by design
 *  and needs `npx` to reach the network, so untracked icons would let an offline or
 *  upstream-broken build ship an app with no icon and no committed fallback. They stay in
 *  git; the build just stops rewriting them when nothing changed.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type IconPlatform = 'ios' | 'android';

/** PINNED — see (1) above. Bumping this invalidates every stamp, so the next build of each
 *  project regenerates its icons exactly once. Defined in `scripts/iconAssets.mjs` because the
 *  generator wrapper (`scripts/generate-icons.mjs`) is plain Node and cannot import this file;
 *  re-exported here so every existing consumer is unchanged. */
export { ICON_TOOL, ICON_COLORS } from '../scripts/iconAssets.mjs';
import { ICON_TOOL, ICON_COLORS } from '../scripts/iconAssets.mjs';

/** Stamp file, under the project's gitignored `.cache/`. Never committed. */
export function iconStampPath(projectRoot: string, plat: IconPlatform): string {
  return path.join(projectRoot, '.cache', `icon-stamp-${plat}`);
}

/** One generated output per platform, used to detect that the icons were deleted while the
 *  stamp survived — without it, a wiped `res/` would never be regenerated. */
export function iconSentinelPath(projectRoot: string, plat: IconPlatform): string {
  return path.join(
    projectRoot,
    plat === 'ios'
      ? 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'
      : 'android/app/src/main/res/mipmap-hdpi/ic_launcher.png',
  );
}

/** Bumped whenever OUR OWN post-processing changes what lands on disk — the splash overlay
 *  geometry, the icon-variant derivations, the badge artwork's placement. `ICON_TOOL` pins the
 *  upstream generator, but everything #396/#397 added runs after it and is ours; without a
 *  version in the stamp, improving a derivation would leave every already-built project on the
 *  old output until someone deleted `.cache/` by hand.
 *
 *  Bumped to '2' when the generated PNGs moved to `GENERATED_PNG`'s lossless settings — every
 *  already-built project must re-encode once to pick up the smaller files. */
export const SPLASH_PIPELINE_VERSION = '2';

/** The extra inputs #396/#397 added. All optional — an omitted field means "not configured",
 *  which is exactly the pre-#396 behaviour, so an existing caller's stamp is unaffected in
 *  meaning even though the digest itself changes once (a one-time regeneration per project). */
export interface IconStampExtras {
  splashSrcAbs?: string;
  splashDarkSrcAbs?: string;
  titleSrcAbs?: string;
  badgeArtAbs?: string;
  /** The DARK badge is a separate file used on light splashes; hashing only the light one meant
   *  re-cutting the dark mark alone produced an identical stamp and shipped the old art. */
  badgeDarkArtAbs?: string;
  iconDarkSrcAbs?: string;
  iconTintedSrcAbs?: string;
  iconMonochromeSrcAbs?: string;
  titleWidthPct?: number;
  titleOffsetPct?: number;
  badge?: boolean;
  /** Feeds the crop-safe box, so it changes WHERE the overlays land. A project flipped from
   *  portrait to unlocked must regenerate even though every source file is byte-identical. */
  orientation?: string;
}

/** Content hash of one optional source file. `absent` and `missing` are deliberately different
 *  strings: a field nobody configured must not collide with one pointing at a file that has
 *  gone away, or repairing a broken path would look like no change at all. */
function fileHash(abs: string | undefined): string {
  if (!abs) return 'absent';
  try { return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'); }
  catch { return 'missing'; }
}

/** Hash of everything that can change the generated output: the tool version, our own
 *  post-processing version, the platform, the colour flags, and the CONTENT of every source
 *  image (not its path or mtime — a project that repoints `iconSource` at a byte-identical file
 *  should not regenerate, and editing an image in place must), plus the placement numbers and
 *  the orientation that decide where the overlays go.
 *
 *  ⚠️ **Anything that changes the output and is NOT hashed here is a silent no-op**: `iconStep`
 *  drops itself from the build plan on a stamp match, so the build reports success and writes
 *  nothing. That is the failure mode both #396 and #397 called out by name. */
export function iconStampValue(
  iconSrcAbs: string,
  plat: IconPlatform,
  extras: IconStampExtras = {},
): string {
  let srcHash = 'missing';
  try { srcHash = crypto.createHash('sha256').update(fs.readFileSync(iconSrcAbs)).digest('hex'); }
  catch { /* unreadable source → 'missing', so the step runs and reports the failure itself */ }
  return crypto.createHash('sha256')
    .update([
      ICON_TOOL,
      SPLASH_PIPELINE_VERSION,
      plat,
      ICON_COLORS,
      srcHash,
      fileHash(extras.splashSrcAbs),
      fileHash(extras.splashDarkSrcAbs),
      fileHash(extras.titleSrcAbs),
      fileHash(extras.badgeArtAbs),
      fileHash(extras.badgeDarkArtAbs),
      fileHash(extras.iconDarkSrcAbs),
      fileHash(extras.iconTintedSrcAbs),
      fileHash(extras.iconMonochromeSrcAbs),
      String(extras.titleWidthPct ?? ''),
      String(extras.titleOffsetPct ?? ''),
      String(extras.badge ?? false),
      extras.orientation ?? '',
    ].join('\0'))
    .digest('hex');
}

/** True when generation can be skipped entirely. Conservative: ANY doubt (missing stamp,
 *  missing outputs, unreadable source) returns false and regenerates. */
export function iconIsUpToDate(
  projectRoot: string,
  iconSrcAbs: string,
  plat: IconPlatform,
  extras: IconStampExtras = {},
): boolean {
  try {
    if (!fs.existsSync(iconSentinelPath(projectRoot, plat))) return false;
    return fs.readFileSync(iconStampPath(projectRoot, plat), 'utf8').trim()
      === iconStampValue(iconSrcAbs, plat, extras);
  } catch {
    return false;
  }
}
