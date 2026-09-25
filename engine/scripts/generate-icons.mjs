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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_TOOL, iconColorArgs, bundledIconPath } from './iconAssets.mjs';
import { composeSplashOverlays } from './splashCompose.mjs';
import { writeIosIconVariants, writeAndroidIconVariants } from './iconVariants.mjs';
import { applyAndroidSplashTheme } from './androidSplashTheme.mjs';
import { writeAndroidNotificationIcon } from './notificationIcon.mjs';
import { isEntryPoint } from './entryPoint.mjs';
import { loadEnginePluginModuleResult } from './loadVendorPlugins.mjs';
import { resolveIconInputs, stampExtrasFrom } from './iconInputs.mjs';
import { claimProjectOrExit } from './cliBuildClaim.mjs';
import { toSpawn } from './winSpawn.mjs';

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

/** The repo root, from this file's own location (`<repo>/engine/scripts/`). Needed to reach the
 *  engine's TS modules and the engine-owned badge art.
 *
 *  ⚠️ `fileURLToPath`, NOT `new URL(import.meta.url).pathname` — which is what this line said when
 *  it was written, and is the one recipe this repo has already been burned by IN THIS FILE.
 *  `.pathname` is percent-encoded and keeps the URL's leading slash, so a clone path containing a
 *  space becomes `My%20Projects` and a Windows path becomes `/C:/…` — which `path.resolve` reads as
 *  drive-relative. Either way `existsSync` on the engine module goes false, the config load reports
 *  "not a source checkout", and every input silently falls back to nothing WITH EXIT 0. That is
 *  #904/#910's signature exactly (`docs/windows.md`, `pathIdentityIsShared.test.ts`): on Windows
 *  "the icon/splash step did nothing at all and reported success". */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Load the project's config, DEGRADING rather than failing (#1011).
 *
 *  ⚠️ This script is spawned by the PACKAGED editor too, which ships no devDependencies and so has no
 *  esbuild — so a hard `loadRequiredEngineModules` here would break icon generation for every packaged
 *  build. Follows `build-web.mjs`'s precedent: warn with WHICH cause it was, and carry on. The reason
 *  that file gives for naming the cause applies exactly: a silent `if (!cfg) return;` conflates "no
 *  source checkout" with "your install is broken", which is the #714 shape.
 *
 *  Returns `{ cfg: null }` when unavailable. ⚠️ `null` means UNKNOWN, not "empty config" — the caller
 *  must not read an absent config as "the author cleared every field", because the whole defect this
 *  fixes (facet B) is a missing input being read as a deliberate clearing. */
async function loadIconProjectConfig(projectRoot) {
  const { module: mod, reason } = await loadEnginePluginModuleResult(REPO_ROOT, path.join('plugins', 'load-project-config.ts'));
  if (!mod) {
    console.warn(`[icon] ⚠️ project.config.json was NOT read (${reason === 'no-esbuild'
      ? 'esbuild is absent — expected inside a packaged editor; on a source checkout run `npm install` at the repo root'
      : 'no engine/plugins/load-project-config.ts here, so this is not a source checkout'}). `
      + 'Only the flags passed on the command line will be used, and no staged art will be cleared.');
    // ⚠️ `malformed: false` on purpose. This is the PACKAGED editor's normal state, not a defect —
    // it ships no esbuild — so it must stay non-fatal even under `--strict`, or every packaged
    // build fails. `iconStep` always passes `--icon` there, so nothing is actually unknown.
    return { cfg: null, malformed: false };
  }
  try {
    // ⚠️ `loadProjectConfig` SWALLOWS a malformed file: its own docstring says "A missing file or
    // unparseable JSON falls back to the defaults", and it catches its own `JSON.parse` throw and
    // returns `mergeProjectConfig(null)`. So a non-null return does NOT mean the config was read —
    // and the `catch` below is unreachable for the malformed case, which is the one that matters.
    //
    // That is load-bearing rather than pedantic, because `cfg === null` is what gates the
    // bundled-icon default and the splash clear. A trailing comma in a hand-edited
    // `project.config.json` would otherwise arrive here as a clean config with an EMPTY
    // `iconSource`, and a native build would regenerate every icon from the bundled Modoki panda
    // over the project's committed art — then write the freshness stamp, so the next build reports
    // "already current". `readProjectConfigParseErrors` is the sanctioned way to ask the question
    // `loadProjectConfig` refuses to answer; it exists precisely because humans edit these files.
    const parseErrors = mod.readProjectConfigParseErrors?.(projectRoot) ?? [];
    const configError = parseErrors.find((e) => e.file === 'project.config.json');
    if (configError) {
      console.warn(`[icon] ⚠️ project.config.json EXISTS but does not parse (${configError.message}) — `
        + 'treating every input as UNKNOWN: no bundled-icon default, no staged art cleared, and nothing '
        + 'regenerated from a guess. Fix the JSON and re-run.');
      return { cfg: null, malformed: true };
    }
    // `loadProjectConfig` MERGES over DEFAULT_PROJECT_CONFIG, which is why a raw JSON.parse is wrong
    // here: `pruneProjectConfig` omits every field equal to its default, so an absent field means
    // DEFAULT, not "unset". Reading a pruned file directly is how "absent" becomes "cleared".
    return { cfg: mod.loadProjectConfig(projectRoot), malformed: false };
  } catch (e) {
    console.warn(`[icon] ⚠️ project.config.json could not be parsed (${e.message}) — using flags only, and clearing nothing.`);
    return { cfg: null, malformed: true };
  }
}

/** Decide the freshness stamp, and whether there is anything to do at all (#1011 facet A).
 *
 *  A caller that already made this decision passes `--stamp` and is obeyed verbatim — that is the
 *  editor's build plan, which checks `iconIsUpToDate` itself and skips the whole step. A caller that
 *  does NOT (the CLI native build) gets the check here, so it participates in the same gate instead of
 *  re-running `@capacitor/assets` on every build.
 *
 *  Degrades like the config load: with the TS side unreachable it GENERATES and writes no stamp —
 *  slower, never wrong. Skipping generation instead would be the #1011 defect all over again. */
async function resolveStamp(projectRoot, platform, inputs, args) {
  if (args.stamp) return { stamp: args.stamp, upToDate: false };
  const { module: mod } = await loadEnginePluginModuleResult(REPO_ROOT, path.join('plugins', 'iconAssets.ts'));
  if (!mod) return { stamp: undefined, upToDate: false };
  const extras = stampExtrasFrom(inputs, REPO_ROOT);
  if (mod.iconIsUpToDate(projectRoot, inputs.icon, platform, extras)) return { stamp: undefined, upToDate: true };
  return { stamp: mod.iconStampValue(inputs.icon, platform, extras), upToDate: false };
}

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
  // Validate BEFORE resolving: `path.resolve(undefined)` throws ERR_INVALID_ARG_TYPE, so a
  // missing --project used to crash with a stack trace instead of reaching this message.
  if (!args.project || (platform !== 'ios' && platform !== 'android')) {
    console.error('[icon] usage: generate-icons.mjs --project <dir> --platform ios|android --icon <file> [--stamp <value>]\n'
      + '                        [--splash <file>] [--splash-cleared true|false] [--splash-dark <file>]\n'
      + '                        [--title <file>]\n'
      + '                        [--title-width <pct>] [--title-offset <pct>] [--badge true|false]\n'
      + '                        [--badge-light <file>] [--badge-dark <file>] [--orientation portrait|landscape|any]\n'
      + '                        [--icon-dark <file>] [--icon-tinted <file>] [--icon-monochrome <file>]\n'
      + '                        [--notification-icon <file>] [--notification-icon-cleared true|false]\n'
      + '                        [--strict true|false]  every degraded outcome exits non-zero instead of 0.\n'
      + '                                               Set by the two BUILD callers; a hand run stays forgiving.');
    process.exit(2);
  }
  const projectRoot = path.resolve(args.project);
  // #1160: this rewrites `assets/` and, through `@capacitor/assets`, the project's `ios/`/`android/`,
  // so a hand run takes the build claim first. Spawned by a claimed build (build-web.mjs or the
  // editor's `/api/build` step), it inherits the parent's token and passes straight through. Held
  // for the rest of the run: `main` has a dozen return and exit paths, and the store's `exit` hook
  // releases the claim on every one of them, which a `finally` here could not.
  claimProjectOrExit(projectRoot, `generate ${platform} icons (CLI)`, 'icon');
  // #1011: every input now comes from the config unless a flag overrides it, so the CLI and the
  // editor's build plan cannot disagree about what the project authored.
  const { cfg, malformed } = await loadIconProjectConfig(projectRoot);
  const inputs = resolveIconInputs(args, projectRoot, cfg, REPO_ROOT);
  const iconSrc = inputs.icon;

  // The generator's input convention: <project>/assets/{icon,splash,splash-dark}.png. Staging a
  // splash is the whole of #396's generation half — `@capacitor/assets` has always read these
  // two filenames (its Project.loadInputAssets) and cover-crops them into every bucket; nothing ever put a
  // file there, so every project's splash was its icon by default rather than by design.
  // No icon anywhere — the project genuinely authors none. Non-fatal by design: an icon-less build
  // still ships, with the committed icons intact.
  if (!iconSrc) {
    // ⚠️ TWO different situations reach here and the operator must be told which. A config we READ
    // that names no icon is the ordinary "this project authors none" case. A config we could not
    // read names nothing because we cannot see it — the project may well have art configured.
    if (malformed) {
      console.error('[icon] nothing generated: project.config.json could not be read, so no input is known. '
        + 'Committed icons untouched. This is NOT "the project authors no icon".');
      // Under --strict this is a degraded outcome like any other, and build-web.mjs's promise
      // ("building on would ship the previously committed art") is exactly what would otherwise
      // happen. Non-strict keeps exit 0 so a hand run over a broken config is not a hard stop.
      if (inputs.strict) {
        console.error('[icon] --strict: refusing to build on art whose source could not be determined.');
        process.exit(1);
      }
      return;
    }
    console.log('[icon] no icon source in project.config.json and none passed — nothing to generate; committed icons untouched.');
    return;
  }
  // ⚠️ #1027. SAY which icon this is generating from. The default is silent in `iconStep` because
  // that caller had no alternative to be confused with; here it does — a config that was not read
  // (`cfg === null`) also produces no `iconSource`, and it deliberately does NOT default. So an
  // operator seeing generated art needs to know whether it came from their own file or from the
  // bundled panda, and "the icons regenerated" looking identical in both cases is how a project
  // ships the wrong mark without anyone noticing.
  if (iconSrc === bundledIconPath(REPO_ROOT)) {
    console.log('[icon] no icon source in project.config.json — using the BUNDLED Modoki icon, '
      + "the same default the editor's build plan applies. Set app.iconSource in Project Settings to ship your own.");
  }
  // Freshness gate. The editor's build plan does this itself and passes `--stamp`; a CLI run had no
  // gate at all, which is why facet A could not simply be "spawn it from build-web" without also
  // making every native build re-run @capacitor/assets.
  const { stamp, upToDate } = await resolveStamp(projectRoot, platform, inputs, args);
  if (upToDate) {
    console.log(`[icon] already current for ${platform} — nothing to regenerate.`);
    return;
  }

  // ⚠️ The two mkdirs belong INSIDE the try. They were lifted out of it when facet C made this
  // block fatal, which turned a staging failure that has nothing to do with the source path — say
  // `<project>/assets` already exists as a regular FILE — into an uncaught rejection printing a raw
  // stack, reached through `build-web.mjs`'s "fix the icon/splash source it named above" pointing at
  // nothing. Fatal is right; unhandled is not, and the message has to name what actually failed.
  let staging = 'the icon source';
  try {
    staging = 'the staging directories';
    fs.mkdirSync(path.join(projectRoot, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.cache'), { recursive: true });
    staging = 'the icon source';
    fs.copyFileSync(iconSrc, path.join(projectRoot, 'assets', 'icon.png'));
  } catch (e) {
    // ⚠️ FATAL, and that is the #1011 facet-C fix. Something DID ask for this icon — a flag, or a
    // non-empty `app.iconSource` — so an unreadable file is an operator error, not the "no icon
    // authored" case handled above. It used to `return` here, which meant a mistyped path regenerated
    // nothing and the shell reported SUCCESS; an operator's next conclusion is "that command does
    // nothing much", which is what made the destructive facet B hard to notice.
    console.error(`[icon] could not ${staging === 'the icon source' ? 'read the icon source' : 'create the staging directories'}: ${e.message}`);
    // ⚠️ Only the icon-source case gets the path/CWD triage. A staging failure has NOTHING to do
    // with where the icon lives — printing "resolved to <icon>" under an EEXIST on `<project>/assets`
    // sends the reader to inspect a file that is perfectly fine, which is the same wrong-error class
    // this branch was split to remove. Naming the right thing in line 1 and the wrong thing in lines
    // 2-4 is not an improvement.
    if (staging === 'the icon source') {
      console.error(`[icon]   resolved to  ${iconSrc}`);
      console.error(`[icon]   cwd          ${process.cwd()}`);
      console.error('[icon] Every asset path is resolved against the CWD unless absolute. Nothing was generated.');
    } else {
      console.error(`[icon]   staging dir  ${path.join(projectRoot, 'assets')}`);
      console.error('[icon] The generator stages its sources there before running. Nothing was generated.');
    }
    process.exit(1);
  }

  const stageSplash = (src, name) => {
    if (!src) return false;
    try {
      fs.copyFileSync(src, path.join(projectRoot, 'assets', name));
      return true;
    } catch (e) {
      // Loud, and NOT fatal by default: the icon-derived splash still ships. Silence here would
      // look exactly like "the author never set a splash".
      console.error(`[icon] could not stage ${name} from ${src}: ${e.message}`);
      // ⚠️ #1028. Under --strict this IS fatal, and the argument is facet C's word for word: an
      // authored splash silently replaced by an icon-derived one is exactly the "that command does
      // nothing much" degrade, and the operator does not go looking. Fatal HERE rather than after
      // the run, so a build that is going to fail does not first spend a minute in
      // @capacitor/assets and rewrite every bucket from the wrong source.
      if (inputs.strict) {
        console.error(`[icon] --strict: ${name} was requested and could not be read, so this build `
          + 'would ship a derived stand-in in place of the authored art. Not generating.');
        process.exit(1);
      }
      return false;
    }
  };
  // An unset dark splash reuses the light art rather than falling back to the ICON-derived
  // splash, which would make dark mode the only mode still showing the old panda-on-white.
  // ⚠️ ONE list, and every requested-but-unreadable input joins it. #1028's first cut fixed the
  // LIGHT splash alone and its comment claimed "the other four degrades already did exactly this" —
  // an enumeration that was wrong in both directions. Re-reviewed: there are FIVE more sites, all
  // the same mechanism, and three of them never tripped `--strict` at all:
  //
  //    splash-dark.png            staged here, return value was discarded
  //    iconDarkSource             iconVariants.mjs `overrideOrNull` — derives, notes, returns fine
  //    iconTintedSource           ditto
  //    iconMonochromeSource       ditto
  //
  // The shared mechanism, stated once so it does not have to be re-derived per site: **a REQUESTED
  // input that cannot be read degrades to a DERIVED substitute, and a derived substitute must never
  // be stamped current.** Deriving is the right degrade; stamping it is what makes it permanent,
  // because `iconIsUpToDate` then short-circuits every later build — including the `--strict` ones,
  // which is how one forgiving hand run disarms the flag for good.
  const requestedButMissing = [];
  const splashStaged = stageSplash(inputs.splash, 'splash.png');
  if (!splashStaged && inputs.splash) requestedButMissing.push(`splashSource: ${inputs.splash}`);
  if (splashStaged) {
    // ⚠️ Capture it. The dark splash falls back to the LIGHT art rather than to the icon-derived
    // one, so a broken `splashDarkSource` is invisible on a light-mode device and ships the wrong
    // mark only in dark mode — the case least likely to be the one you happen to test.
    const darkSrc = inputs.splashDark || inputs.splash;
    if (!stageSplash(darkSrc, 'splash-dark.png') && darkSrc) {
      requestedButMissing.push(`splashDarkSource: ${darkSrc}`);
    }
  }
  // ⚠️ `splashCleared`, NOT `!splashStaged` — the #1011 facet-B fix. These differ exactly where the
  // damage was: an operator who did not type `--splash` used to land here and have their staged art
  // deleted, then every splash bucket rebuilt from the ICON. Now only a config that positively has no
  // `splashSource` clears it; an unreadable config clears nothing.
  if (inputs.splashCleared) {
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

  // npx is `npx.cmd` on Windows — toSpawn resolves it and runs it through an escaped cmd.exe line (#1537).
  const npx = toSpawn('npx', ['--yes', ICON_TOOL, 'generate', `--${platform}`, ...iconColorArgs()]);
  const res = spawnSync(npx.command, npx.args, { ...npx.options, cwd: projectRoot, stdio: 'inherit' });

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
    // ⚠️ #1028, and this is the row that mattered most. `npx --yes @capacitor/assets@3.0.5` is a
    // NETWORK fetch, so this is by far the likeliest way generation fails in practice — and it was
    // the one `build-web.mjs`'s "not building; building on would ship the previously committed art"
    // did NOT cover, because facet C only made an unreadable icon SOURCE fatal. The rare failure (a
    // mistyped path) aborted the build; the common one did not.
    if (inputs.strict) {
      console.error(`[icon] --strict: ${ICON_TOOL} exited ${res.status}, so nothing was regenerated. `
        + 'Building on would ship the previously committed art. No freshness stamp written — fix the '
        + 'cause (usually network or registry) and re-run.');
      process.exit(1);
    }
    return; // non-fatal, and NO stamp — the next build retries.
  }
  if (failed.length) {
    // Loud, and NO stamp: the collateral is still on disk, so the next build must get another
    // go at it rather than being told the icons are current.
    console.error(`[icon] ⚠️  ${failed.length} file(s) the generator wrote outside ${PRODUCT_DIR[platform]} could NOT be put back:`);
    for (const f of failed) console.error(`[icon]   ${f}`);
    console.error('[icon] Check `git status` and revert them by hand. No freshness stamp written — the next build retries.');
    // ⚠️ #1028. Under --strict this is fatal because the tree is now KNOWN-DIRTY with collateral
    // the wrapper could not undo — #236's pbxproj/manifest mangling, sitting in the working tree of
    // whatever this build touched. Continuing would package that state and, under `demos/`, invite
    // it into a published snapshot.
    if (inputs.strict) {
      console.error(`[icon] --strict: ${failed.length} file(s) outside the product directory are still modified. Not building.`);
      process.exit(1);
    }
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
  // Named `postFailed` still, because that is what every later branch means by it: "something went
  // wrong, do not declare this current". `requestedButMissing` is folded in after the variant steps
  // run, since those are what discover three of the five entries.
  let postFailed = false;

  try {
    const variants = platform === 'ios'
      ? await writeIosIconVariants({
        projectRoot,
        iconSrcAbs: iconSrc,
        darkSrcAbs: inputs.iconDark,
        tintedSrcAbs: inputs.iconTinted,
      })
      : await writeAndroidIconVariants({
        projectRoot,
        iconSrcAbs: iconSrc,
        monochromeSrcAbs: inputs.iconMonochrome,
      });

    if (variants.written.length) console.log(`[icon] icon variants: ${variants.written.length} file(s)`);
    for (const n of variants.notes) console.log(`[icon] ${n}`);
    // The three override slots. `overrideOrNull` derives from the base icon and carries on, which
    // is the right DEGRADE — but the result must not be stamped current. See requestedButMissing.
    requestedButMissing.push(...(variants.missing ?? []));
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
    // Its own try for the same reason as the splash colour below: a failure has to name its own
    // subsystem. Opt-in, so for a project without `app.notificationIconSource` this only removes a
    // previously emitted icon, and there usually is none.
    try {
      const notif = await writeAndroidNotificationIcon({
        projectRoot, srcAbs: inputs.notificationIcon, cleared: inputs.notificationIconCleared,
      });
      if (notif.written.length) console.log(`[icon] notification small icon: ${notif.written.length} file(s)`);
      if (notif.removed.length) console.log(`[icon] notification small icon cleared: removed ${notif.removed.length} file(s)`);
      for (const n of notif.notes) console.log(`[icon] ${n}`);
      requestedButMissing.push(...notif.missing);
    } catch (e) {
      console.error(`[icon] notification small icon failed (${e.message}) — will retry next build`);
      postFailed = true;
    }
  }

  if (platform === 'android') {
    try {
      // The Android 12+ system splash is the only launch surface the platform actually draws —
      // the generated drawable buckets are never shown at minSdk 31+. See androidSplashTheme.mjs.
      const theme = await applyAndroidSplashTheme({ projectRoot, splashSrcAbs: inputs.splash });
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
      orientation: inputs.orientation,
      titleSrc: inputs.title,
      titleWidthPct: inputs.titleWidthPct,
      titleOffsetPct: inputs.titleOffsetPct,
      badge: inputs.badge,
      badgeLightArt: inputs.badgeLight,
      badgeDarkArt: inputs.badgeDark,
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

  // ⚠️ THE ONE PLACE the requested-but-missing rule is applied, deliberately after every step that
  // can discover an entry. Five sites feed this list; one branch acts on it. Patching each site
  // instead is how the first cut of #1028 fixed the light splash and left four siblings behind.
  if (requestedButMissing.length) {
    // Each entry names its own reason: most are an unreadable path, but the notification icon also
    // reports art that was READ and is unusable (nothing above the alpha floor, or fully opaque),
    // where the path is fine and the art is what needs fixing.
    console.error(`[icon] ⚠️  ${requestedButMissing.length} authored input(s) were REQUESTED and could not be used, `
      + 'so a derived stand-in or the previously committed art ships instead:');
    for (const m of requestedButMissing) console.error(`[icon]   ${m}`);
    if (inputs.strict) {
      console.error('[icon] --strict: not building on derived stand-ins or stale art for inputs somebody authored. '
        + 'Fix each input above as its line says, or clear the field(s) in Project Settings if the art is genuinely gone.');
      process.exit(1);
    }
    postFailed = true;   // no stamp: the next run re-attempts, so a repaired path self-heals
  }

  if (postFailed) {
    console.error('[icon] no freshness stamp written — the next build will re-run this step.');
    // ⚠️ #1028. Fatal under --strict, and this module's own header says why in stronger terms than
    // the other three: these steps write file-by-file, so a throw half way leaves a PARTIAL splash
    // or variant set, and a partial set "looks fine on the device you happen to test". Shipping
    // that behind one scrolled-past console line is the exact failure the no-stamp rule already
    // guards against for the NEXT build; --strict extends it to THIS one.
    if (inputs.strict) {
      console.error('[icon] --strict: post-processing failed, so the generated set may be partial. Not building.');
      process.exit(1);
    }
    return;
  }
  if (stamp) {
    try { fs.writeFileSync(path.join(projectRoot, '.cache', `icon-stamp-${platform}`), stamp); }
    catch (e) { console.log(`[icon] could not write the freshness stamp (${e.message}) — the next build will regenerate`); }
  }
}

// Importable for tests; only the CLI entry runs main().
if (isEntryPoint(import.meta.url)) await main();
