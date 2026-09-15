/** Icon + splash generation INPUTS, resolved in ONE place for every caller (#827, #1011, #1027).
 *
 *  Two entry points generate icons: the editor's build plan (`iconStep`, `vite-asset-scanner.ts`) and
 *  `generate-icons.mjs` run by `build-web.mjs --target native`. Until #827 the editor resolved every
 *  input from the config by hand and the script resolved them again here, each "mirroring" the
 *  other's trim and path rules — and the two had already disagreed once (#1027, an empty
 *  `iconSource`). Now the editor calls {@link resolveIconInputs} in-process with the config
 *  it already parsed, and hands the script the result as flags ({@link iconInputsToArgs}); the script
 *  calls the same function on its own read. So a new input, or a changed default, is one edit.
 *
 *  Why flags at all, rather than letting the script read the config itself: the PACKAGED editor
 *  ships no esbuild, so the spawned script cannot load the `.ts` config reader there and sees
 *  `cfg === null`. The editor's in-process resolution is the only one that knows the answer in the
 *  build that ships — so it must pass everything, and the round trip must be lossless
 *  (`resolveIconInputs(argsOf(iconInputsToArgs(x)), root, null, engine)` equals `x`).
 *
 *  Pure, and free of `import.meta.url`: the editor imports this into the Vite config bundle, where a
 *  module-relative repo root would point at the bundle, so the engine root is always a parameter. */

import path from 'node:path';
import { bundledIconPath } from './iconAssets.mjs';

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
 *  @param {any|null} cfg the merged ProjectConfig, or null when it could not be read
 *  @param {string} engineRoot the engine checkout the bundled icon and badge art are read from */
export function resolveIconInputs(args, projectRoot, cfg, engineRoot) {
  // Project-relative unless already absolute.
  // ⚠️ `.trim()` is load-bearing, not tidiness. `ProjectSettingsDialog` stores what was typed, so
  // without it `"art/icon.png "` is an unreadable path — and since #1011 made an unreadable
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
  for (const [flag, raw] of [['badge', args.badge], ['splash-cleared', args['splash-cleared']], ['notification-icon-cleared', args['notification-icon-cleared']], ['strict', args.strict]]) {
    if (raw !== undefined && raw !== 'true' && raw !== 'false') {
      console.warn(`[icon] ⚠️ --${flag} expects true|false, got ${JSON.stringify(raw)} — reading it as false. `
        + 'A boolean flag with no value (or a trailing flag) parses this way.');
    }
  }

  return {
    // ⚠️ FACET A's REMAINDER (#1027). A flag wins; then the config; then — and only then — the
    // bundled Modoki icon, which is what `iconStep` has always fallen back to. Without this the
    // editor's build plan and the CLI native build gave DIFFERENT answers for the same project:
    // the editor generated from `build/icon.png`, the CLI reported "nothing to generate" and left
    // 22 native projects' committed art maintained by exactly one of the two callers.
    //
    // ⚠️ `cfg !== null` is NOT belt-and-braces, it is the whole safety of this line, and it is the
    // same distinction facet B already had to learn below. `cfg === null` does not mean "no icon
    // authored" — it means the config could not be READ (no esbuild in the packaged editor, or an
    // unparseable file), which is precisely when a project MIGHT have real icon art configured.
    // Falling back there would overwrite that project's authored icon with the panda, i.e. destroy
    // art, on the one build that ships. Only a config we positively read and found empty may
    // default. The packaged editor is unaffected either way: `iconStep` always passes `--icon`.
    icon: pick('icon', app?.iconSource) ?? (cfg !== null ? bundledIconPath(engineRoot) : undefined),
    splash: pick('splash', app?.splashSource),
    splashDark: pick('splash-dark', app?.splashDarkSource),
    title: pick('title', app?.splashTitleSource),
    titleWidthPct: num('title-width', app?.splashTitleWidthPct, 55),
    titleOffsetPct: num('title-offset', app?.splashTitleOffsetPct, -8),
    badge,
    // Engine-owned art, not project art — the editor's build plan passes these from `engine/assets`,
    // so deriving them here is what stops a hand run silently producing a badge-less splash.
    badgeLight: badge ? (args['badge-light'] ?? path.join(engineRoot, 'engine', 'assets', 'splash-badge-light.png')) : undefined,
    badgeDark: badge ? (args['badge-dark'] ?? path.join(engineRoot, 'engine', 'assets', 'splash-badge-dark.png')) : undefined,
    // `undefined` lets `composeSplashOverlays` apply its own default; `'auto'` normalises to `'any'`
    // downstream, exactly as the editor path behaves.
    orientation: args.orientation ?? cfg?.capacitor?.orientation,
    iconDark: pick('icon-dark', app?.iconDarkSource),
    iconTinted: pick('icon-tinted', app?.iconTintedSource),
    iconMonochrome: pick('icon-monochrome', app?.iconMonochromeSource),
    // Android's notification small icon (#1203). No derivation and no default: unset means the
    // project emits none. Whether an earlier build's output is REMOVED is the next field's call.
    notificationIcon: pick('notification-icon', app?.notificationIconSource),
    // The same two ways to know as `splashCleared` below, for the same reason (#1203 review): an
    // unreadable config names no source because it cannot see one, and removing the committed
    // drawables there destroys art. The packaged editor states it with the flag.
    notificationIconCleared: args['notification-icon-cleared'] !== undefined
      ? args['notification-icon-cleared'] === 'true'
      : args['notification-icon'] === undefined && cfg !== null && !cfgSet(app?.notificationIconSource),
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
    // ⚠️ #1028. NOT a generation input — it changes nothing about the art — but it belongs here so
    // it gets the same malformed-boolean warning as the two above, and so every caller-supplied
    // value is resolved in ONE place. Deliberately absent from `stampExtrasFrom`: a flag that does
    // not change the OUTPUT must not change the stamp, or flipping it would rewrite ~60 committed
    // PNGs in every project for no reason (see that function's own note on the same trap).
    //
    // Default FALSE, i.e. a bare hand run stays forgiving. That is a deliberate property of this
    // script, not an oversight: `npm run build -- --target native` and the editor's build plan both
    // pass `--strict true`, because those two PRINT a promise about shipping stale art and this is
    // what makes the promise true. A human poking at the generator gets the old behaviour.
    strict: args.strict === 'true',
  };
}

/** The freshness-stamp inputs, derived from {@link resolveIconInputs}' output.
 *
 *  Called by BOTH stamp owners — `iconStep` (`engine/plugins/vite-asset-scanner.ts`) and
 *  `generate-icons.mjs`'s own freshness check — from `inputs` rather than from `cfg`, so there is ONE
 *  place that decides what an input is, and this is only a re-shaping of it.
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
    // `notificationIconCleared` is left out for the same reason, since its source hash separates set
    // from unset. One difference: these drawables are COMMITTED, while the staged splash is local
    // scratch. So git can bring in the icons while this machine's stamp stays at an older "unset"
    // (build at C0 with it unset, then pull C1 which opts in and C2 which clears it without committing
    // the deletions). That build is skipped and the icons stay. Same recovery: delete the stamp.
    // ⚠️ NOT re-gated on `inputs.badge` here. `resolveIconInputs` already returns these as undefined
    // when the badge is off, and a second copy of that rule is a redundant property: a test written
    // against it passes whether or not the gate exists, because the other mechanism already produced
    // the value it asserts (docs/falsifiable-tests.md). One place decides; this one carries.
    badgeArtAbs: inputs.badgeLight,
    badgeDarkArtAbs: inputs.badgeDark,
    iconDarkSrcAbs: inputs.iconDark,
    iconTintedSrcAbs: inputs.iconTinted,
    iconMonochromeSrcAbs: inputs.iconMonochrome,
    notificationIconSrcAbs: inputs.notificationIcon,
    titleWidthPct: inputs.titleWidthPct,
    titleOffsetPct: inputs.titleOffsetPct,
    badge: inputs.badge,
    orientation: inputs.orientation,
    engineRootAbs,
  };
}

/** {@link resolveIconInputs}' output as `generate-icons.mjs` flags — its exact inverse, so a script
 *  that could not read the config (`cfg === null`, the packaged editor) resolves the same inputs from
 *  these alone. Returns `[flag, value]` pairs WITHOUT the leading `--`; the caller quotes them for its
 *  shell. An undefined input emits no flag (absent means unset on the way back in); a boolean always
 *  emits, because for `badge`, `splash-cleared`, `notification-icon-cleared` and `strict` an absent flag does NOT mean false once
 *  the config is unreadable.
 *
 *  @param {ReturnType<typeof resolveIconInputs>} inputs
 *  @returns {Array<[string, string]>} */
export function iconInputsToArgs(inputs) {
  /** @type {Array<[string, string]>} */
  const out = [];
  const str = (flag, v) => { if (v !== undefined) out.push([flag, String(v)]); };
  str('icon', inputs.icon);
  str('splash', inputs.splash);
  out.push(['splash-cleared', inputs.splashCleared ? 'true' : 'false']);
  out.push(['strict', inputs.strict ? 'true' : 'false']);
  str('splash-dark', inputs.splashDark);
  str('title', inputs.title);
  str('title-width', inputs.titleWidthPct);
  str('title-offset', inputs.titleOffsetPct);
  out.push(['badge', inputs.badge ? 'true' : 'false']);
  str('badge-light', inputs.badgeLight);
  str('badge-dark', inputs.badgeDark);
  str('orientation', inputs.orientation);
  str('icon-dark', inputs.iconDark);
  str('icon-tinted', inputs.iconTinted);
  str('icon-monochrome', inputs.iconMonochrome);
  str('notification-icon', inputs.notificationIcon);
  out.push(['notification-icon-cleared', inputs.notificationIconCleared ? 'true' : 'false']);
  return out;
}
