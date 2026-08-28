#!/usr/bin/env node
/** App-icon / splash generation, wrapped so the generator can only write IMAGES.
 *
 *  `@capacitor/assets` does not stay inside the platform it is given (#236, measured on
 *  forest-camp with the pinned 3.0.5): a `generate --android` run also opens and REWRITES
 *  `ios/App/App.xcodeproj/project.pbxproj`, stripping the leading zero off
 *  `LastUpgradeCheck = 0920` → `920` — an iOS file mangled by an Android build — and
 *  re-serializes `AndroidManifest.xml` (blank lines dropped, `<?xml … ?>` respaced,
 *  `<meta-data …></meta-data>` collapsed to self-closing). None of it is a semantic change;
 *  all of it lands in `git status` as plausible-looking native churn. Roughly half the repo's
 *  projects already carry the mangled `920` in a commit, which is how quietly it travels.
 *
 *  That matters most under `demos/`, which is the PUBLISHABLE tree: 60+ generated paths
 *  appearing there is exactly what a broad `git add` sweeps into a snapshot. CLAUDE.md's #18
 *  rule ("never `git add -A`") was written for the editor writing behind your back; this is the
 *  same hazard from the build, and the pre-commit hook that would have caught it was declined.
 *
 *  So the rule this script enforces is narrow and MEASURED rather than guessed. The generator's
 *  actual product is one directory per platform — verified by running each mode against
 *  forest-camp and listing every path it touched:
 *
 *    generate --android  → writes `android/app/src/main/res/**` … and nothing else it should
 *                          (collateral: AndroidManifest.xml, ios/…/project.pbxproj)
 *    generate --ios      → writes `ios/App/App/Assets.xcassets/**` … and nothing else at all
 *
 *  **Inside the running platform's product directory the generator is left completely alone;
 *  everything else it modifies, deletes or creates under `ios/`+`android/` is put back, and the
 *  restore is reported.** A project that genuinely needs an edit outside that scope therefore
 *  sees a line every build rather than silence — discoverable, not lost.
 *
 *  The scope is a PATH, not a file type, and that distinction is load-bearing: an earlier cut of
 *  this restored every non-image file, which also reverted
 *  `res/mipmap-anydpi-v26/ic_launcher.xml` — where the generator legitimately repoints the
 *  adaptive icon's background from `@color/ic_launcher_background` to the `@mipmap/…` PNG it
 *  just made. That is the generator's own product, and reverting it would have orphaned the
 *  backgrounds while looking like it worked.
 *
 *  What this deliberately does NOT do is decide whether the generator's brand-new density
 *  buckets (`drawable-*-night-*`, `*-ldpi`, `mipmap-<dpi>/ic_launcher_background.png` — 21 paths
 *  on forest-camp) should be committed or gitignored. They are real product, inside the scope,
 *  the projects build without them today, and that is an owner call rather than a cleanup. */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ICON_TOOL, iconColorArgs } from './iconAssets.mjs';
import { composeSplashOverlays } from './splashCompose.mjs';
import { writeIosIconVariants, writeAndroidIconVariants } from './iconVariants.mjs';
import { applyAndroidSplashTheme } from './androidSplashTheme.mjs';

/** The one directory each platform's run owns. Everything the generator writes here is its
 *  product and is kept; everything it writes elsewhere is collateral and is undone. Measured,
 *  not assumed — see the header. */
const PRODUCT_DIR = {
  android: path.join('android', 'app', 'src', 'main', 'res'),
  ios: path.join('ios', 'App', 'App', 'Assets.xcassets'),
};

/** Never walked: build output and dependency trees. Large, regenerated constantly, and nothing
 *  in them is a committed file worth protecting. */
const SKIP_DIRS = new Set(['node_modules', 'build', 'Pods', '.gradle', '.git', 'DerivedData', 'dist', '.cache']);

/** Files bigger than this are not snapshotted, and so are not protected. A project config file
 *  this large does not exist; an ASSET might, but an asset outside the product directory is not
 *  something the generator has ever been seen to touch. */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

/** Every protectable file under `dir`: anything outside the running platform's product
 *  directory that is small enough to hold in memory. `skipPrefix` is that product directory,
 *  absolute. */
export function collect(dir, skipPrefix, out = new Map()) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (skipPrefix && (full === skipPrefix || full.startsWith(skipPrefix + path.sep))) continue;
    if (e.isDirectory()) { collect(full, skipPrefix, out); continue; }
    if (!e.isFile()) continue;
    try {
      if (fs.statSync(full).size > MAX_SNAPSHOT_BYTES) continue;
      out.set(full, fs.readFileSync(full));
    } catch { continue; }
  }
  return out;
}

/** Files that exist now, outside the product directory, which were NOT there before — the
 *  generator creating something it was not asked to. Returned so they can be removed. */
export function newFilesOutsideScope(dir, skipPrefix, snapshot) {
  const created = [];
  const now = collect(dir, skipPrefix);
  for (const file of now.keys()) if (!snapshot.has(file)) created.push(file);
  return created;
}

/** Put back every snapshotted file the generator changed or removed.
 *
 *  Returns `{restored, failed}` — both, because they mean opposite things to the caller. A
 *  restore that THREW (the file is read-only, or Xcode holds `project.pbxproj` open) leaves the
 *  generator's damage on disk, and the caller must then withhold the freshness stamp: with the
 *  stamp written, `iconIsUpToDate` returns true forever, the step never runs again, and the
 *  mangled file is permanent behind one buried console line. That is the exact failure the
 *  wrapper exists to prevent, so it cannot be the one it swallows. */
export function restoreSnapshot(snapshot, projectRoot) {
  const restored = [];
  const failed = [];
  for (const [file, original] of snapshot) {
    let current = null;
    try { current = fs.readFileSync(file); } catch { /* deleted by the generator */ }
    if (current && current.equals(original)) continue;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, original);
      restored.push(path.relative(projectRoot, file));
    } catch (e) {
      console.error(`[icon] could not restore ${path.relative(projectRoot, file)}: ${e.message}`);
      failed.push(path.relative(projectRoot, file));
    }
  }
  return { restored, failed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = args.platform;
  const iconSrc = args.icon;
  // Validate BEFORE resolving: `path.resolve(undefined)` throws ERR_INVALID_ARG_TYPE, so a
  // missing --project used to crash with a stack trace instead of reaching this message.
  if (!args.project || (platform !== 'ios' && platform !== 'android')) {
    console.error('[icon] usage: generate-icons.mjs --project <dir> --platform ios|android --icon <file> [--stamp <value>]\n'
      + '                        [--splash <file>] [--splash-dark <file>] [--title <file>]\n'
      + '                        [--title-width <pct>] [--title-offset <pct>] [--badge true|false]\n'
      + '                        [--badge-light <file>] [--badge-dark <file>] [--orientation portrait|landscape|any]\n'
      + '                        [--icon-dark <file>] [--icon-tinted <file>] [--icon-monochrome <file>]');
    process.exit(2);
  }
  const projectRoot = path.resolve(args.project);

  // The generator's input convention: <project>/assets/{icon,splash,splash-dark}.png. Staging a
  // splash is the whole of #396's generation half — `@capacitor/assets` has always read these
  // two filenames (project.js:45-54) and cover-crops them into every bucket; nothing ever put a
  // file there, so every project's splash was its icon by default rather than by design.
  try {
    fs.mkdirSync(path.join(projectRoot, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.cache'), { recursive: true });
    fs.copyFileSync(iconSrc, path.join(projectRoot, 'assets', 'icon.png'));
  } catch (e) {
    // Non-fatal by design: an icon-less build still ships, with the committed icons intact.
    console.log(`[icon] generation skipped — could not stage the source image (${e.message})`);
    return;
  }

  const stageSplash = (src, name) => {
    if (!src) return false;
    try {
      fs.copyFileSync(src, path.join(projectRoot, 'assets', name));
      return true;
    } catch (e) {
      // Loud, and NOT fatal: the icon-derived splash still ships. Silence here would look
      // exactly like "the author never set a splash".
      console.error(`[icon] could not stage ${name} from ${src}: ${e.message}`);
      return false;
    }
  };
  // An unset dark splash reuses the light art rather than falling back to the ICON-derived
  // splash, which would make dark mode the only mode still showing the old panda-on-white.
  const splashStaged = stageSplash(args.splash, 'splash.png');
  if (splashStaged) stageSplash(args['splash-dark'] || args.splash, 'splash-dark.png');
  if (!splashStaged) {
    // ⚠️ The staging directory is gitignored SCRATCH that survives between builds, so a splash
    // left there by an earlier build would keep being picked up after `splashSource` was
    // cleared — "remove the custom splash" would appear to do nothing. Clearing a setting has
    // to clear its input.
    for (const stale of ['splash.png', 'splash-dark.png']) {
      try { fs.rmSync(path.join(projectRoot, 'assets', stale), { force: true }); } catch { /* nothing staged */ }
    }
  }

  const productAbs = path.join(projectRoot, PRODUCT_DIR[platform]);
  const nativeDirs = [path.join(projectRoot, 'ios'), path.join(projectRoot, 'android')];
  const snapshot = new Map(nativeDirs.flatMap((d) => [...collect(d, productAbs)]));

  const res = spawnSync('npx', ['--yes', ICON_TOOL, 'generate', `--${platform}`, ...iconColorArgs()], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32', // npx on Windows is a .cmd
  });

  const { restored, failed } = restoreSnapshot(snapshot, projectRoot);
  for (const d of nativeDirs) {
    for (const created of newFilesOutsideScope(d, productAbs, snapshot)) {
      try { fs.rmSync(created); restored.push(path.relative(projectRoot, created)); }
      catch (e) {
        console.error(`[icon] could not remove ${path.relative(projectRoot, created)}: ${e.message}`);
        failed.push(path.relative(projectRoot, created));
      }
    }
  }
  if (restored.length) {
    console.log(`[icon] undid ${restored.length} write(s) outside ${PRODUCT_DIR[platform]} (the generator's product dir):`);
    for (const r of restored) console.log(`[icon]   ${r}`);
  }

  if (res.status !== 0) {
    console.log('[icon] generation skipped (source missing or @capacitor/assets error)');
    return; // non-fatal, and NO stamp — the next build retries.
  }
  if (failed.length) {
    // Loud, and NO stamp: the collateral is still on disk, so the next build must get another
    // go at it rather than being told the icons are current.
    console.error(`[icon] ⚠️  ${failed.length} file(s) the generator wrote outside ${PRODUCT_DIR[platform]} could NOT be put back:`);
    for (const f of failed) console.error(`[icon]   ${f}`);
    console.error('[icon] Check `git status` and revert them by hand. No freshness stamp written — the next build retries.');
    return;
  }
  // Everything below runs AFTER the restore, on purpose (#397): the files it edits — the iOS
  // `AppIcon.appiconset/Contents.json` and Android's `mipmap-anydpi-v26/ic_launcher*.xml` — sit
  // INSIDE the running platform's product directory, so the snapshot never held them and the
  // restore cannot undo this work. Run before the restore and it would.
  // ⚠️ A step that FAILED must not be stamped. `restoreSnapshot`'s docstring states the rule for
  // the restore path — "with the stamp written, `iconIsUpToDate` returns true forever, the step
  // never runs again" — and it applies just as hard to everything below: these steps write
  // file-by-file, so a throw half way leaves a PARTIAL splash set, and this module's own header
  // says a partial set is worse than none because it looks fine on the device you happen to test.
  // Stamping that is how it becomes permanent behind one scrolled-past console line.
  let postFailed = false;

  try {
    const variants = platform === 'ios'
      ? await writeIosIconVariants({
        projectRoot,
        iconSrcAbs: iconSrc,
        darkSrcAbs: args['icon-dark'],
        tintedSrcAbs: args['icon-tinted'],
      })
      : await writeAndroidIconVariants({
        projectRoot,
        iconSrcAbs: iconSrc,
        monochromeSrcAbs: args['icon-monochrome'],
      });

    if (variants.written.length) console.log(`[icon] icon variants: ${variants.written.length} file(s)`);
    for (const n of variants.notes) console.log(`[icon] ${n}`);
  } catch (e) {
    // Non-fatal for the BUILD — the base icons are already generated and committed, and a missing
    // variant degrades to the OS's own fallback — but NOT stamped, so the next build retries.
    console.error(`[icon] icon variants failed (${e.message}) — base icons are unaffected, will retry next build`);
    postFailed = true;
  }

  // Its OWN try, so a failure here is not reported as "icon variants failed" — it is reachable
  // (`splashEdgeColour` throws `extract_area: bad extract area` on a master 1 px in either
  // dimension) and an operator told the wrong subsystem failed looks in the wrong place.
  if (platform === 'android') {
    try {
      // The Android 12+ system splash is the only launch surface the platform actually draws —
      // the generated drawable buckets are never shown at minSdk 31+. See androidSplashTheme.mjs.
      const theme = await applyAndroidSplashTheme({ projectRoot, splashSrcAbs: args.splash });
      if (theme.changed) console.log(`[icon] system splash colour ${theme.colour} (sampled from the splash master)`);
      for (const n of theme.notes) console.log(`[icon] ${n}`);
    } catch (e) {
      console.error(`[icon] system splash colour failed (${e.message}) — will retry next build`);
      postFailed = true;
    }
  }

  try {
    const overlays = await composeSplashOverlays({
      projectRoot,
      platform,
      orientation: args.orientation,
      titleSrc: args.title,
      titleWidthPct: Number(args['title-width'] ?? 55),
      titleOffsetPct: Number(args['title-offset'] ?? -8),
      badge: args.badge === 'true',
      badgeLightArt: args['badge-light'],
      badgeDarkArt: args['badge-dark'],
      // A custom splash is re-encoded whether or not it carries overlays — see SPLASH_PNG.
      optimise: splashStaged,
    });
    if (overlays.files) {
      console.log(`[icon] splash pass over ${overlays.files} image(s)`
        + `${overlays.title ? ` — title x${overlays.title}` : ''}`
        + `${overlays.badge ? `, badge x${overlays.badge}` : ''}`
        + `${overlays.bytesSaved > 0 ? `, re-encoded ${(overlays.bytesSaved / 1048576).toFixed(1)} MB smaller` : ''}`);
    }
    // Clamping means an authored placement did not fit the crop-safe region. Reported rather
    // than silently corrected: the overlay IS on screen, but not where it was asked to be.
    for (const c of overlays.clamped) console.log(`[icon] ⚠️  overlay clamped into the crop-safe box: ${c}`);
  } catch (e) {
    console.error(`[icon] splash overlays failed (${e.message}) — will retry next build`);
    postFailed = true;
  }

  if (postFailed) {
    console.error('[icon] no freshness stamp written — the next build will re-run this step.');
    return;
  }
  if (args.stamp) {
    try { fs.writeFileSync(path.join(projectRoot, '.cache', `icon-stamp-${platform}`), args.stamp); }
    catch (e) { console.log(`[icon] could not write the freshness stamp (${e.message}) — the next build will regenerate`); }
  }
}

// Importable for tests; only the CLI entry runs main().
if (import.meta.url === `file://${process.argv[1]}`) await main();
