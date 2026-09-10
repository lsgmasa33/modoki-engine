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
import { ICON_TOOL, iconColorArgs } from './iconAssets.mjs';
import { composeSplashOverlays } from './splashCompose.mjs';
import { writeIosIconVariants, writeAndroidIconVariants } from './iconVariants.mjs';
import { applyAndroidSplashTheme } from './androidSplashTheme.mjs';
import { isEntryPoint } from './entryPoint.mjs';
import { loadEnginePluginModuleResult } from './loadVendorPlugins.mjs';

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
    return { cfg: null };
  }
  try {
    // `loadProjectConfig` MERGES over DEFAULT_PROJECT_CONFIG, which is why a raw JSON.parse is wrong
    // here: `pruneProjectConfig` omits every field equal to its default, so an absent field means
    // DEFAULT, not "unset". Reading a pruned file directly is how "absent" becomes "cleared".
    return { cfg: mod.loadProjectConfig(projectRoot) };
  } catch (e) {
    console.warn(`[icon] ⚠️ project.config.json could not be parsed (${e.message}) — using flags only, and clearing nothing.`);
    return { cfg: null };
  }
}

/** Resolve every generation input: a FLAG WINS, otherwise the value comes from `project.config.json`.
 *
 *  This is the whole of #1011. The script used to take its entire input from flags, and `iconStep` in
 *  `engine/plugins/vite-asset-scanner.ts` was the only caller that supplied them from the config — so
 *  every other invocation path either generated nothing (stale art shipped) or regenerated from the
 *  script's own defaults, which differ from the config's. Four measured symptoms of that one seam:
 *
 *    A  never run          → the CLI native path generated nothing; committed art shipped stale
 *    B  run partially      → an absent `--splash` DELETED the staged splash and rebuilt all 26
 *                            Android buckets from the icon, destroying an authored launch screen
 *    C  wrong path         → nothing happened and the shell reported success (exit 0)
 *    D  flags disagree     → `--orientation` absent defaults to `'any'` while the config says
 *                            `portrait`, so the two paths composed the wordmark in different places
 *
 *  Pure and exported so the precedence rule is testable without spawning anything.
 *
 *  @param {Record<string,string|undefined>} args parsed CLI flags
 *  @param {string} projectRoot absolute project directory
 *  @param {any|null} cfg the merged ProjectConfig, or null when it could not be read */
export function resolveIconInputs(args, projectRoot, cfg) {
  // Project-relative unless already absolute — mirrors `projectFile` in the editor's build plan, so
  // a config path means the same thing to both callers.
  // ⚠️ `.trim()` is part of that mirroring, not tidiness. `ProjectSettingsDialog` stores what was
  // typed, and the editor trims on the way out (`vite-asset-scanner.ts`, `cfg.app.iconSource.trim()`).
  // Without it here, `"art/icon.png "` is an unreadable path — and since #1011 made an unreadable
  // REQUESTED icon fatal, a trailing space in Project Settings would fail the whole native build on
  // the CLI while the editor built it fine. `"   "` has to read as UNSET for the same reason, and so
  // that a splash cleared to whitespace still counts as cleared below.
  const fromCfg = (v) => {
    const t = typeof v === 'string' ? v.trim() : v;
    return t ? (path.isAbsolute(t) ? t : path.join(projectRoot, t)) : undefined;
  };
  const cfgSet = (v) => (typeof v === 'string' ? v.trim() : v) ? true : false;
  const app = cfg?.app;
  const pick = (flagName, cfgValue) => args[flagName] ?? fromCfg(cfgValue);
  const num = (flagName, cfgValue, fallback) => {
    const raw = args[flagName] ?? cfgValue;
    const n = Number(raw);
    return raw === undefined || Number.isNaN(n) ? fallback : n;
  };

  const badge = args.badge !== undefined ? args.badge === 'true' : app?.splashBadge === true;
  // ⚠️ A boolean flag whose value is neither 'true' nor 'false' is an operator error, and silently
  // reading it as false is the same silent-degrade this whole issue is about — `--splash-cleared`
  // exists precisely so a caller can state something the script cannot infer, so it must not
  // quietly stop stating it. `parseArgs` is a naive pairwise loop, so a flag passed LAST with no
  // value lands here as `undefined` too.
  for (const [flag, raw] of [['badge', args.badge], ['splash-cleared', args['splash-cleared']]]) {
    if (raw !== undefined && raw !== 'true' && raw !== 'false') {
      console.warn(`[icon] ⚠️ --${flag} expects true|false, got ${JSON.stringify(raw)} — reading it as false. `
        + 'A boolean flag with no value (or a trailing flag) parses this way.');
    }
  }

  return {
    icon: pick('icon', app?.iconSource),
    splash: pick('splash', app?.splashSource),
    splashDark: pick('splash-dark', app?.splashDarkSource),
    title: pick('title', app?.splashTitleSource),
    titleWidthPct: num('title-width', app?.splashTitleWidthPct, 55),
    titleOffsetPct: num('title-offset', app?.splashTitleOffsetPct, -8),
    badge,
    // Engine-owned art, not project art — the editor's build plan passes these from `engine/assets`,
    // so deriving them here is what stops a hand run silently producing a badge-less splash.
    badgeLight: badge ? (args['badge-light'] ?? path.join(REPO_ROOT, 'engine', 'assets', 'splash-badge-light.png')) : undefined,
    badgeDark: badge ? (args['badge-dark'] ?? path.join(REPO_ROOT, 'engine', 'assets', 'splash-badge-dark.png')) : undefined,
    // `undefined` lets `composeSplashOverlays` apply its own default; `'auto'` normalises to `'any'`
    // downstream, exactly as the editor path behaves.
    orientation: args.orientation ?? cfg?.capacitor?.orientation,
    iconDark: pick('icon-dark', app?.iconDarkSource),
    iconTinted: pick('icon-tinted', app?.iconTintedSource),
    iconMonochrome: pick('icon-monochrome', app?.iconMonochromeSource),
    // ⚠️ FACET B. Deleting the staged splash is only correct when the CONFIG says there is no custom
    // splash — "the author cleared `splashSource`". It is wrong when the operator merely did not type
    // the flag, and it was wrong for every hand run because the two were indistinguishable here.
    //
    // Two ways to know, and the second one is load-bearing:
    //  1. we read the config ourselves and it has no `splashSource`;
    //  2. the CALLER read it for us and says so with `--splash-cleared`.
    //
    // ⚠️ (2) exists because (1) alone SILENTLY DROPPED #236's cleanup in the packaged editor, which is
    // the one build that ships. The packaged editor has no esbuild, so `cfg` is legitimately null
    // there — the degrade this whole seam is built around — and a `cfg !== null` test therefore reads
    // "unknown" for the one caller that positively knows. Clearing "Splash (source PNG)" in Project
    // Settings would then leave the previous build's staged `assets/splash.png` in place (gitignored
    // scratch that survives between builds), cover-crop the OLD splash into all 26 Android buckets,
    // and stamp the result CURRENT — so it never self-heals. `iconStep` passes the flag from the
    // config it has already parsed, which is exactly the knowledge `cfg === null` destroys.
    splashCleared: args['splash-cleared'] !== undefined
      ? args['splash-cleared'] === 'true'
      : args.splash === undefined && cfg !== null && !cfgSet(app?.splashSource),
  };
}

/** The freshness-stamp inputs, derived from {@link resolveIconInputs}' output.
 *
 *  Mirrors what `iconStep` (`engine/plugins/vite-asset-scanner.ts`) assembles, but from `inputs`
 *  rather than from `cfg` directly — so there is ONE place that decides what an input is, and this is
 *  only a re-shaping of it. Exported for the same reason as the resolver: testable without spawning.
 *
 *  ⚠️ `engineRootAbs` anchors the post-processing-source hash (see `splashPipelineVersion`). The editor
 *  passes its build cwd; the CLI passes the repo root. If those ever differ the stamp differs and the
 *  icons regenerate — the safe direction. */
export function stampExtrasFrom(inputs, engineRootAbs) {
  return {
    splashSrcAbs: inputs.splash,
    splashDarkSrcAbs: inputs.splashDark,
    titleSrcAbs: inputs.title,
    // ⚠️ `splashCleared` is deliberately NOT in the stamp, and this is a REASONED omission rather
    // than an oversight. Adding any field to `extras` changes `iconStampValue` for every project at
    // once — `ICON_COLORS`' own docblock spells out what that costs: "the next build of every
    // project rewrite[s] ~60 committed PNGs", i.e. #236's churn, deliberately triggered. Against
    // that: neither real caller can reach the stale case. The editor derives the flag from
    // `splashSrcAbs`, which IS hashed, so its two states already produce different stamps;
    // `build-web.mjs` never passes the flag at all. The reachable-but-unreached case is a hand run
    // that flips `--splash-cleared` while changing nothing else — where the clear is skipped as
    // "already current". Deleting `.cache/icon-stamp-<platform>` is the recovery, and the cost of
    // the alternative is paid by every project on every machine.
    // ⚠️ NOT re-gated on `inputs.badge` here. `resolveIconInputs` already returns these as undefined
    // when the badge is off, and a second copy of that rule is a redundant property: a test written
    // against it passes whether or not the gate exists, because the other mechanism already produced
    // the value it asserts (docs/falsifiable-tests.md). One place decides; this one carries.
    badgeArtAbs: inputs.badgeLight,
    badgeDarkArtAbs: inputs.badgeDark,
    iconDarkSrcAbs: inputs.iconDark,
    iconTintedSrcAbs: inputs.iconTinted,
    iconMonochromeSrcAbs: inputs.iconMonochrome,
    titleWidthPct: inputs.titleWidthPct,
    titleOffsetPct: inputs.titleOffsetPct,
    badge: inputs.badge,
    orientation: inputs.orientation,
    engineRootAbs,
  };
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
      + '                        [--icon-dark <file>] [--icon-tinted <file>] [--icon-monochrome <file>]');
    process.exit(2);
  }
  const projectRoot = path.resolve(args.project);
  // #1011: every input now comes from the config unless a flag overrides it, so the CLI and the
  // editor's build plan cannot disagree about what the project authored.
  const { cfg } = await loadIconProjectConfig(projectRoot);
  const inputs = resolveIconInputs(args, projectRoot, cfg);
  const iconSrc = inputs.icon;

  // The generator's input convention: <project>/assets/{icon,splash,splash-dark}.png. Staging a
  // splash is the whole of #396's generation half — `@capacitor/assets` has always read these
  // two filenames (project.js:45-54) and cover-crops them into every bucket; nothing ever put a
  // file there, so every project's splash was its icon by default rather than by design.
  // No icon anywhere — the project genuinely authors none. Non-fatal by design: an icon-less build
  // still ships, with the committed icons intact.
  if (!iconSrc) {
    console.log('[icon] no icon source in project.config.json and none passed — nothing to generate; committed icons untouched.');
    return;
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
      // Loud, and NOT fatal: the icon-derived splash still ships. Silence here would look
      // exactly like "the author never set a splash".
      console.error(`[icon] could not stage ${name} from ${src}: ${e.message}`);
      return false;
    }
  };
  // An unset dark splash reuses the light art rather than falling back to the ICON-derived
  // splash, which would make dark mode the only mode still showing the old panda-on-white.
  const splashStaged = stageSplash(inputs.splash, 'splash.png');
  if (splashStaged) stageSplash(inputs.splashDark || inputs.splash, 'splash-dark.png');
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

  if (postFailed) {
    console.error('[icon] no freshness stamp written — the next build will re-run this step.');
    return;
  }
  if (stamp) {
    try { fs.writeFileSync(path.join(projectRoot, '.cache', `icon-stamp-${platform}`), stamp); }
    catch (e) { console.log(`[icon] could not write the freshness stamp (${e.message}) — the next build will regenerate`); }
  }
}

// Importable for tests; only the CLI entry runs main().
if (isEntryPoint(import.meta.url)) await main();
