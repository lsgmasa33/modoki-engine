/** The app-icon generator's collateral cleanup (#236).
 *
 *  `@capacitor/assets` does not stay inside the platform it is given: measured on
 *  `demos/forest-camp` with the pinned 3.0.5, `generate --android` also rewrites
 *  `ios/App/App.xcodeproj/project.pbxproj` (`LastUpgradeCheck = 0920` → `920`) and
 *  re-serializes `AndroidManifest.xml`. Roughly half the repo's projects already carry the
 *  mangled `920` in a commit, and `demos/` is the PUBLISHABLE tree — so the wrapper
 *  (`engine/scripts/generate-icons.mjs`) puts back everything written outside the running
 *  platform's product directory.
 *
 *  These tests drive that logic directly rather than invoking the generator: the real thing
 *  needs `npx` and the network, and what can regress here is the SCOPE RULE, not the tool. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collect, newFilesOutsideScope, restoreSnapshot, resolveIconInputs, stampExtrasFrom } from '../../scripts/generate-icons.mjs';
import { ICON_COLORS, iconColorArgs } from '../../scripts/iconAssets.mjs';
import { DEFAULT_PROJECT_CONFIG } from '../../project-config';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';

let root: string;
const PRODUCT = path.join('android', 'app', 'src', 'main', 'res');

const write = (rel: string, body: string) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-icons-'));
  write(path.join(PRODUCT, 'mipmap-hdpi', 'ic_launcher.png'), 'product-image');
  write(path.join(PRODUCT, 'mipmap-anydpi-v26', 'ic_launcher.xml'), '<adaptive-icon/>');
  write(path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml'), '<manifest>\n\n</manifest>');
  write(path.join('ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'LastUpgradeCheck = 0920;');
  write(path.join('ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json'), '{}');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const snapshotFor = (plat: 'android' | 'ios') => {
  const product = path.join(root, plat === 'android' ? PRODUCT : path.join('ios', 'App', 'App', 'Assets.xcassets'));
  return new Map([
    ...collect(path.join(root, 'ios'), product),
    ...collect(path.join(root, 'android'), product),
  ]);
};

describe('icon-generator collateral scope', () => {
  it('protects the project files, and NOT the running platform\'s product directory', () => {
    const snap = snapshotFor('android');
    const rel = [...snap.keys()].map((f) => path.relative(root, f)).sort();
    expect(rel).toContain(path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml'));
    expect(rel).toContain(path.join('ios', 'App', 'App.xcodeproj', 'project.pbxproj'));
    // The generator legitimately rewrites this one — repointing the adaptive icon's background
    // at the PNG it just made. An earlier cut of the rule restored it and orphaned the PNGs.
    expect(rel).not.toContain(path.join(PRODUCT, 'mipmap-anydpi-v26', 'ic_launcher.xml'));
    expect(rel).not.toContain(path.join(PRODUCT, 'mipmap-hdpi', 'ic_launcher.png'));
  });

  it('an --android run still protects the iOS icon assets (it was not asked for them)', () => {
    const rel = [...snapshotFor('android').keys()].map((f) => path.relative(root, f));
    expect(rel).toContain(path.join('ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json'));
  });

  it('an --ios run leaves the iOS icon assets writable and still protects android', () => {
    const rel = [...snapshotFor('ios').keys()].map((f) => path.relative(root, f));
    expect(rel).not.toContain(path.join('ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json'));
    expect(rel).toContain(path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml'));
  });
});

describe('restoring what the generator wrote outside its scope', () => {
  it('puts back a mangled pbxproj and reports it', () => {
    const snap = snapshotFor('android');
    const pbx = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    fs.writeFileSync(pbx, 'LastUpgradeCheck = 920;'); // the real mangling, byte for byte
    const { restored, failed } = restoreSnapshot(snap, root);
    expect(fs.readFileSync(pbx, 'utf8')).toBe('LastUpgradeCheck = 0920;');
    expect(restored).toEqual([path.join('ios', 'App', 'App.xcodeproj', 'project.pbxproj')]);
    expect(failed).toEqual([]);
  });

  it('puts back a file the generator DELETED', () => {
    const snap = snapshotFor('android');
    const manifest = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
    fs.rmSync(manifest);
    restoreSnapshot(snap, root);
    expect(fs.readFileSync(manifest, 'utf8')).toBe('<manifest>\n\n</manifest>');
  });

  it('reports nothing when the generator stayed in its lane', () => {
    const snap = snapshotFor('android');
    fs.writeFileSync(path.join(root, PRODUCT, 'mipmap-hdpi', 'ic_launcher.png'), 'regenerated');
    expect(restoreSnapshot(snap, root).restored).toEqual([]);
  });

  it('finds a file created outside the product directory', () => {
    const snap = snapshotFor('android');
    write(path.join('ios', 'App', 'stray.txt'), 'not asked for');
    write(path.join(PRODUCT, 'mipmap-ldpi', 'ic_launcher.png'), 'legitimate new product');
    const created = newFilesOutsideScope(path.join(root, 'ios'), path.join(root, PRODUCT), snap)
      .concat(newFilesOutsideScope(path.join(root, 'android'), path.join(root, PRODUCT), snap))
      .map((f) => path.relative(root, f));
    expect(created).toEqual([path.join('ios', 'App', 'stray.txt')]);
  });
  // Close-out finding: a restore that THREW was logged and swallowed. The caller then wrote the
  // freshness stamp anyway, so `iconIsUpToDate` returned true forever and the mangled file was
  // permanent behind one buried console line — the exact damage the wrapper exists to undo.
  it('reports a restore it could NOT perform, so the caller can withhold the stamp', () => {
    const snap = snapshotFor('android');
    const pbx = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    fs.writeFileSync(pbx, 'LastUpgradeCheck = 920;'); // the generator's damage
    fs.chmodSync(pbx, 0o444);                         // ...and it cannot be put back
    try {
      const { restored, failed } = restoreSnapshot(snap, root);
      expect(restored).toEqual([]);
      expect(failed).toEqual([path.join('ios', 'App', 'App.xcodeproj', 'project.pbxproj')]);
      expect(fs.readFileSync(pbx, 'utf8')).toBe('LastUpgradeCheck = 920;'); // still damaged
    } finally {
      fs.chmodSync(pbx, 0o644);
    }
  });

});

describe('generator flags', () => {
  // ICON_COLORS is hashed into every project's freshness stamp, so its TEXT is a wire format —
  // changing it rewrites ~60 committed PNGs in every project. The argv form must stay derived.
  it('tokenizes into the exact flags the shell form used to pass', () => {
    expect(iconColorArgs()).toEqual([
      '--iconBackgroundColor', '#ffffff',
      '--iconBackgroundColorDark', '#111111',
      '--splashBackgroundColor', '#ffffff',
      '--splashBackgroundColorDark', '#111111',
    ]);
    expect(ICON_COLORS).not.toMatch(/\n/); // one line: it is spliced into a hash, not formatted
  });
});

// ── #1011: the script reads project.config.json, and flags are OVERRIDES ──
//
// It used to take its ENTIRE input from flags, with iconStep in vite-asset-scanner.ts the only caller
// that supplied them from the config. Four measured symptoms of that one seam, one test each below.
describe('resolveIconInputs (#1011)', () => {
  const ROOT = path.join(path.sep, 'proj');
  const cfgWith = (app: Record<string, unknown> = {}, capacitor: Record<string, unknown> = {}) =>
    ({ app, capacitor });

  it('derives every asset input from the config when no flag is passed', () => {
    const r = resolveIconInputs({}, ROOT, cfgWith({
      iconSource: 'art/icon.png',
      splashSource: 'art/splash.png',
      splashDarkSource: 'art/splash-dark.png',
      splashTitleSource: 'art/title.png',
      iconMonochromeSource: 'art/mono.png',
    }));
    expect(r.icon).toBe(path.join(ROOT, 'art/icon.png'));
    expect(r.splash).toBe(path.join(ROOT, 'art/splash.png'));
    expect(r.splashDark).toBe(path.join(ROOT, 'art/splash-dark.png'));
    expect(r.title).toBe(path.join(ROOT, 'art/title.png'));
    expect(r.iconMonochrome).toBe(path.join(ROOT, 'art/mono.png'));
  });

  it('lets a FLAG override the config — the precedence that makes these overrides, not defaults', () => {
    const r = resolveIconInputs({ icon: '/abs/override.png' }, ROOT, cfgWith({ iconSource: 'art/icon.png' }));
    expect(r.icon).toBe('/abs/override.png');
  });

  it('leaves an absolute config path alone', () => {
    const r = resolveIconInputs({}, ROOT, cfgWith({ iconSource: path.join(path.sep, 'elsewhere', 'i.png') }));
    expect(r.icon).toBe(path.join(path.sep, 'elsewhere', 'i.png'));
  });

  // FACET D — the divergence that had already SHIPPED. iconStep always passes --orientation from
  // cfg.capacitor.orientation; the CLI defaulted to 'any', which takes the UNION safe box and moves the
  // composited wordmark. wordweave's launch screen carried the wrong placement for a day because of it.
  it('takes orientation from capacitor.orientation when no flag says otherwise (facet D)', () => {
    expect(resolveIconInputs({}, ROOT, cfgWith({}, { orientation: 'portrait' })).orientation).toBe('portrait');
    expect(resolveIconInputs({ orientation: 'landscape' }, ROOT, cfgWith({}, { orientation: 'portrait' })).orientation).toBe('landscape');
    // No config at all → undefined, so composeSplashOverlays applies its own default rather than
    // this function inventing one.
    expect(resolveIconInputs({}, ROOT, null).orientation).toBeUndefined();
  });

  it('takes the title/badge numbers from the config, and falls back only when neither says', () => {
    const r = resolveIconInputs({}, ROOT, cfgWith({ splashTitleWidthPct: 40, splashTitleOffsetPct: 12, splashBadge: true }));
    expect(r.titleWidthPct).toBe(40);
    expect(r.titleOffsetPct).toBe(12);
    expect(r.badge).toBe(true);
    const bare = resolveIconInputs({}, ROOT, cfgWith({}));
    expect(bare.titleWidthPct).toBe(55);
    expect(bare.titleOffsetPct).toBe(-8);
    expect(bare.badge).toBe(false);
  });

  it('supplies the engine-owned badge art only when the badge is on', () => {
    // A hand run that passed --badge true but not the art produced a badge-less splash, silently:
    // composeSplashOverlays gates on badgeLightArt being present.
    expect(resolveIconInputs({ badge: 'true' }, ROOT, null).badgeLight).toMatch(/splash-badge-light\.png$/);
    expect(resolveIconInputs({ badge: 'false' }, ROOT, null).badgeLight).toBeUndefined();
  });

  // ⚠️ FACET B — the destructive one, and the reason this issue exists. An absent --splash used to
  // delete the staged splash and rebuild all 26 Android buckets from the ICON. These three cases are
  // the whole rule: only a config that positively has no splashSource may clear.
  describe('splashCleared — the facet B rule', () => {
    it('does NOT clear when the config HAS a splash and the flag was simply not typed', () => {
      const r = resolveIconInputs({}, ROOT, cfgWith({ splashSource: 'art/splash.png' }));
      expect(r.splashCleared).toBe(false);
      expect(r.splash).toBe(path.join(ROOT, 'art/splash.png'));
    });

    it('DOES clear when the config positively has no splashSource — that is a cleared setting', () => {
      // #236's reason for the delete, preserved: the staging dir is gitignored scratch that survives
      // between builds, so clearing the setting has to clear its input.
      expect(resolveIconInputs({}, ROOT, cfgWith({ splashSource: '' })).splashCleared).toBe(true);
    });

    it('does NOT clear when the config could not be read — absent is not cleared', () => {
      // The packaged editor ships no esbuild, so `cfg` is legitimately null there. Reading that as
      // "the author cleared every field" is the same conflation the whole issue is about, and here it
      // would DESTROY art. The safe direction is to keep it.
      expect(resolveIconInputs({}, ROOT, null).splashCleared).toBe(false);
    });

    it('does NOT clear when the flag WAS passed', () => {
      expect(resolveIconInputs({ splash: '/abs/s.png' }, ROOT, cfgWith({ splashSource: '' })).splashCleared).toBe(false);
    });
  });

  it('its no-config fallbacks are the REAL config defaults, not a second copy of them', () => {
    // `resolveIconInputs` hard-codes 55 / -8 for the case where there is no config to read at all
    // (a hand run on a non-source checkout). That is a genuine fallback — a .mjs script cannot
    // import the .ts that owns these — but it is still a code constant SHADOWING a config value,
    // which CLAUDE.md's single-source-of-truth table says will go stale. It cannot be single-sourced
    // here, so it is pinned instead: change the real defaults and this fails, naming the copy.
    const noCfg = resolveIconInputs({}, '/p', null);
    expect(noCfg.titleWidthPct).toBe(DEFAULT_PROJECT_CONFIG.app.splashTitleWidthPct);
    expect(noCfg.titleOffsetPct).toBe(DEFAULT_PROJECT_CONFIG.app.splashTitleOffsetPct);
    expect(noCfg.badge).toBe(DEFAULT_PROJECT_CONFIG.app.splashBadge);
  });

  it('reports no icon at all when neither flag nor config names one', () => {
    // Distinct from an unreadable one: this is the legitimate "project authors no icon" case, which
    // must stay a quiet skip rather than the facet-C failure.
    expect(resolveIconInputs({}, ROOT, cfgWith({ iconSource: '' })).icon).toBeUndefined();
    expect(resolveIconInputs({}, ROOT, null).icon).toBeUndefined();
  });
});

describe('stampExtrasFrom (#1011)', () => {
  it('re-shapes the resolved inputs, gating the badge art on the badge being on', () => {
    const inputs = resolveIconInputs({}, path.join(path.sep, 'proj'),
      { app: { splashSource: 'a.png', splashBadge: true, splashTitleWidthPct: 33 }, capacitor: { orientation: 'portrait' } });
    const extras = stampExtrasFrom(inputs, path.join(path.sep, 'engine-root'));
    expect(extras.splashSrcAbs).toBe(inputs.splash);
    expect(extras.orientation).toBe('portrait');
    expect(extras.titleWidthPct).toBe(33);
    expect(extras.badgeArtAbs).toBe(inputs.badgeLight);
    expect(extras.engineRootAbs).toBe(path.join(path.sep, 'engine-root'));
  });

  it('drops the badge art from the stamp when the badge is off, so it cannot change the hash', () => {
    const inputs = resolveIconInputs({ badge: 'false' }, path.join(path.sep, 'proj'), null);
    expect(stampExtrasFrom(inputs, 'x').badgeArtAbs).toBeUndefined();
    expect(stampExtrasFrom(inputs, 'x').badgeDarkArtAbs).toBeUndefined();
  });
});

// ⚠️ FACET C, and it needs a REAL subprocess: the defect was an EXIT CODE, which no in-process call can
// observe. Both cases below return before `npx @capacitor/assets` is ever spawned, so neither needs the
// network — which is what makes an exit-code test affordable here at all (see this file's header).
describe('generate-icons CLI exit codes (#1011 facet C)', () => {
  const SCRIPT = path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'generate-icons.mjs');
  const run = (args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: path.join(SCRIPT, '..', '..', '..') });

  it('FAILS, loudly, when something asked for an icon that cannot be read', () => {
    // It used to `return` here: nothing was regenerated and the shell reported SUCCESS. An operator
    // whose mental model becomes "that command does nothing much" is exactly who does not notice the
    // destructive facet B, which is why this one is a hard failure now.
    const res = run(['--project', root, '--platform', 'android', '--icon', 'no/such/icon.png']);
    expect(res.status).not.toBe(0);
    expect(`${res.stderr}${res.stdout}`).toMatch(/could not read the icon source/);
    expect(`${res.stderr}${res.stdout}`).toMatch(/resolved to/);      // names the absolute path it tried
    expect(`${res.stderr}${res.stdout}`).toMatch(/cwd/);              // and the CWD it resolved against
  });

  it('succeeds quietly when NO icon is named anywhere — that is not an error', () => {
    // The other side of the same branch, and the reason facet C could not just be "always fail": a
    // project that authors no icon must still build, with its committed icons untouched.
    const res = run(['--project', root, '--platform', 'android']);
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/no icon source/);
  });

  it('still refuses a missing --project with the usage message', () => {
    expect(run(['--platform', 'android']).status).toBe(2);
  });
});

/** #1011 facet A — the CLI native build must actually RUN the generator.
 *
 *  Before this, `engine/scripts/build-web.mjs` contained no icon step at all (grep: zero
 *  occurrences of `icon`). It ran `validateProjectConfig → healNativeProject` and went straight to
 *  the web build, so the CLI native recipe CLAUDE.md documents regenerated NOTHING and shipped the
 *  previously committed art with every gate green.
 *
 *  ⚠️ These read the SOURCE rather than driving it, and that is a deliberate, stated limit. Driving
 *  it means a real `--target native` run, which first executes `healNativeProject` — three heals
 *  that write into a project's tracked native tree and can trigger a dependency install. That is
 *  not something the gate can own. What CAN regress here is the wiring, and the wiring is exactly
 *  what was missing: delete the call, or re-open the fourteen-flag command line, and these go red. */
describe('the CLI native build runs the generator (#1011 facet A)', () => {
  const BUILD_WEB = path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'build-web.mjs');
  // ⚠️ COMMENTS STRIPPED, and this is the whole difference between a guard and a decoration. The
  // first version of this block read the raw text — so `// await generateNativeIcons();` left all
  // four assertions green, and commenting a line out is how anyone actually disables it. Worse, the
  // `body` slice below opens with a 12-line docblock that NAMES `res.status !== 0`, so half these
  // regexes were satisfiable by prose alone. `stripComments` is length- and line-preserving, which
  // `assertScanIsSane` then proves — a regex stripper silently eats source and every count taken
  // from it is meaningless.
  const raw = fs.readFileSync(BUILD_WEB, 'utf8');
  const src = stripComments(raw);
  assertScanIsSane(raw, src, 'build-web.mjs', ['generateNativeIcons', 'healNativeProject']);

  /** The function body alone — so an assertion about what it passes cannot be satisfied by a
   *  comment, or by some unrelated spawn elsewhere in a 600-line script. */
  const body = (() => {
    const start = src.indexOf('async function generateNativeIcons()');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nasync function ', start + 1);
    return src.slice(start, end === -1 ? undefined : end);
  })();

  it('calls it in the main flow, AFTER the heal that may create the platform directory', () => {
    // Ordering is load-bearing, not tidiness: `ensureCapacitorDeps` can create the very `ios/` or
    // `android/` directory this writes into, and `generateNativeIcons` skips a platform that is not
    // on disk — so running it first would silently generate nothing on a fresh native target.
    const call = src.indexOf('await generateNativeIcons()');
    const heal = src.indexOf('await healNativeProject()');
    expect(call).toBeGreaterThan(-1);
    expect(heal).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(heal);
  });

  it('spawns generate-icons.mjs, passing ONLY the project and the platform', () => {
    // The point of the fix: the script resolves its own inputs from project.config.json now. If a
    // future author re-derives the editor's fourteen-flag command line here, that is a second copy
    // of `iconStep` and the two will drift — which is the whole of #1011. So pin the absence.
    expect(body).toMatch(/generate-icons\.mjs/);
    expect(body).toMatch(/'--project'/);
    expect(body).toMatch(/'--platform'/);
    for (const flag of ['--icon', '--splash', '--title', '--badge', '--orientation', '--stamp']) {
      expect(body).not.toContain(`'${flag}'`);
    }
  });

  it('FAILS the build on a non-zero exit rather than building on over stale art', () => {
    expect(body).toMatch(/res\.status !== 0/);
    expect(body).toMatch(/process\.exit\(1\)/);
  });

  it('tells "the generator would not start" apart from "your icon source is bad"', () => {
    // `status` is null when the child never ran or died on a signal — no node on PATH, OOM, an
    // abort. Folding that into the non-zero branch sends the operator to inspect an icon file that
    // is perfectly fine, which is the most expensive kind of wrong error message.
    expect(body).toMatch(/res\.error \|\| res\.status === null/);
    expect(body).toMatch(/not a problem with the icon source/);
  });

  it('is skipped entirely for a non-native target, and for a project with no platform dir', () => {
    expect(body).toMatch(/target !== 'native'/);
    expect(body).toMatch(/if \(!platforms\.length\) return;/);
  });
});

/** #1011 at the SEAM — the script really reading `project.config.json`, driven end to end.
 *
 *  ⚠️ Why this block exists: every other test above drives `resolveIconInputs`/`stampExtrasFrom`
 *  directly, or runs the CLI against a temp dir with NO config. So all of them passed identically
 *  under the OLD flags-only resolution — and the close-out's review proved it, by putting the
 *  destructive facet-B bug back (`if (inputs.splashCleared)` → `if (!splashStaged)`) and by cutting
 *  the config off at the call (`resolveIconInputs(args, projectRoot, null)`). Both mutations left
 *  the suite 29/29 green. A change whose whole claim is "it reads the config now" needs a test that
 *  fails when it stops.
 *
 *  The fake `npx`: these drive `main()` for real, and the real generator is a pinned NETWORK
 *  download. A non-zero `npx` makes the script log "generation skipped" and exit 0 — after the
 *  staging, the config resolution and the facet-B delete have all already happened, which is the
 *  whole of what these assert. The mechanism under test is never the thing being faked. */
describe('generate-icons reads project.config.json (#1011, at the seam)', () => {
  const SCRIPT2 = path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'generate-icons.mjs');
  const REPO = path.join(SCRIPT2, '..', '..', '..');
  let binDir: string;

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-fakebin-'));
    fs.writeFileSync(path.join(binDir, 'npx'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    // ⚠️ The `.cmd` sibling is not belt-and-braces. `generate-icons.mjs` spawns with
    // `shell: process.platform === 'win32'`, so cmd.exe resolves by PATHEXT and skips an
    // EXTENSIONLESS `npx` entirely — falling through to the REAL one. These tests would then
    // download `@capacitor/assets@3.0.5` from inside the gate, on every run. Their assertions would
    // still pass (the staging and the facet-B delete both happen before the spawn), so it would
    // never show up as a failure — just a networked, slow test nobody could explain. `engine/tests`
    // ships in the OSS snapshot and the free public CI runs a windows leg, so this is a live path.
    fs.writeFileSync(path.join(binDir, 'npx.cmd'), '@echo off\r\nexit /b 1\r\n');
  });
  afterEach(() => { fs.rmSync(binDir, { recursive: true, force: true }); });

  const runIn = (args: string[]) => spawnSync(process.execPath, [SCRIPT2, ...args], {
    encoding: 'utf8',
    cwd: REPO,
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  const writeConfig = (app: Record<string, unknown>) =>
    write('project.config.json', JSON.stringify({ app }, null, 2));
  /** A file the generator can actually copy — its bytes are never decoded on this path. */
  const sourceArt = (rel: string) => write(rel, 'PNG-ish bytes');

  it('resolves app.iconSource from the config, project-relative, with no --icon flag', () => {
    // The mutation this kills: passing `null` where `cfg` goes. Then nothing names an icon, the
    // script reports "no icon source ... nothing to generate" and exits 0 — the opposite outcome.
    writeConfig({ iconSource: 'art/nope.png' });
    const res = runIn(['--project', root, '--platform', 'android']);
    expect(res.status).toBe(1);
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toMatch(/could not read the icon source/);
    // Project-relative, resolved against the PROJECT and not the CWD it was invoked from.
    expect(out).toContain(path.join(root, 'art', 'nope.png'));
  });

  it('keeps a staged splash when the config NAMES one that cannot be read (facet B)', () => {
    // The exact shape the old `!splashStaged` test destroyed: staging fails, so the old code
    // concluded "no splash wanted" and deleted the operator's art. The config positively names a
    // splash, so "cleared" is false and the previous build's staged art must survive.
    writeConfig({ iconSource: 'art/icon.png', splashSource: 'art/typo-splash.png' });
    sourceArt('art/icon.png');
    const staged = write(path.join('assets', 'splash.png'), 'PRECIOUS-STAGED-ART');
    runIn(['--project', root, '--platform', 'android']);
    expect(fs.existsSync(staged)).toBe(true);
    expect(fs.readFileSync(staged, 'utf8')).toBe('PRECIOUS-STAGED-ART');
  });

  it('DOES clear the staged splash when the config positively has none (#236)', () => {
    // The other side of the same branch — without this, "not deleting" would pass by doing nothing.
    writeConfig({ iconSource: 'art/icon.png' });
    sourceArt('art/icon.png');
    const staged = write(path.join('assets', 'splash.png'), 'STALE-FROM-A-PREVIOUS-BUILD');
    runIn(['--project', root, '--platform', 'android']);
    expect(fs.existsSync(staged)).toBe(false);
  });

  /** `--splash-cleared` is the PACKAGED editor's channel: it ships no esbuild, so `cfg` is null there
   *  and the script cannot see the config the editor has already parsed. Inferring "cleared" from an
   *  absent `--splash` is right for that caller and destructive for a hand run, so the caller states
   *  it. Both directions, because a flag only read in one is a flag that can be ignored in the other.
   *
   *  ⚠️ Note what the fixture does NOT do: it does not omit `project.config.json` to simulate the
   *  packaged editor. `loadProjectConfig` MERGES over the defaults, so a missing file still yields a
   *  config object with an empty `splashSource` — i.e. "this project has no splash", which SHOULD
   *  clear. `cfg === null` means the loader module itself was unavailable, which is not something a
   *  fixture can produce on a source checkout. Writing that test the obvious way asserts the wrong
   *  thing and goes red for the right reason; this is what it turned into. */
  it('obeys --splash-cleared true, clearing art the config would not have cleared', () => {
    writeConfig({ iconSource: 'art/icon.png', splashSource: 'art/splash.png' });
    sourceArt('art/icon.png');
    sourceArt('art/splash.png');
    const staged = write(path.join('assets', 'splash.png'), 'STALE');
    runIn(['--project', root, '--platform', 'android', '--splash-cleared', 'true']);
    expect(fs.existsSync(staged)).toBe(false);
  });

  it('obeys --splash-cleared false, keeping art the config WOULD have cleared', () => {
    writeConfig({ iconSource: 'art/icon.png' });   // no splashSource — the config says "cleared"
    sourceArt('art/icon.png');
    const staged = write(path.join('assets', 'splash.png'), 'PRECIOUS');
    runIn(['--project', root, '--platform', 'android', '--splash-cleared', 'false']);
    expect(fs.existsSync(staged)).toBe(true);
    expect(fs.readFileSync(staged, 'utf8')).toBe('PRECIOUS');
  });

  it('WARNS rather than silently degrading when a boolean flag has no usable value', () => {
    // `parseArgs` is a naive pairwise loop, so `--splash-cleared` passed last lands as undefined and
    // `--splash-cleared TRUE` reads as false. Neither is reachable from `iconStep`, which always
    // emits a value — but "the caller states it positively" quietly becoming "the caller said
    // nothing" is the exact silent-degrade shape #1011 exists to remove.
    sourceArt('art/icon.png');
    const res = runIn(['--project', root, '--platform', 'android',
      '--icon', path.join(root, 'art', 'icon.png'), '--splash-cleared', 'TRUE']);
    expect(`${res.stdout}${res.stderr}`).toMatch(/--splash-cleared expects true\|false/);
  });

  it('trims a config path, so a trailing space is not a fatal build failure', () => {
    // The editor trims on the way out (`cfg.app.iconSource.trim()`), ProjectSettingsDialog stores
    // what was typed, and #1011 made an unreadable requested icon FATAL — so without the trim here
    // one trailing space in Project Settings fails the whole CLI native build and no other path.
    writeConfig({ iconSource: 'art/icon.png   ' });
    sourceArt('art/icon.png');
    const res = runIn(['--project', root, '--platform', 'android']);
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/could not read/);
  });

  it('reports a STAGING failure as itself, not as an unreadable icon source', () => {
    // `<project>/assets` as a regular FILE — the mkdir cannot proceed, and this has nothing to do
    // with the icon path. When facet C made this block fatal the two mkdirs were lifted out of the
    // try, so this became an uncaught rejection printing a raw stack, surfaced through build-web's
    // "fix the icon/splash source it named above" pointing at a file that is perfectly fine.
    writeConfig({ iconSource: 'art/icon.png' });
    sourceArt('art/icon.png');
    write('assets', 'I am a file, not a directory');
    const res = runIn(['--project', root, '--platform', 'android']);
    expect(res.status).toBe(1);
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toMatch(/could not create the staging directories/);
    expect(out).not.toMatch(/^\s*at .*generate-icons\.mjs/m);   // a message, not a stack
    // ⚠️ And it must NOT print the icon-source triage. Naming the right thing in line 1 and then
    // sending the reader to inspect a perfectly good icon path in lines 2-4 is the same wrong-error
    // class this branch was split to remove — the first version of this fix did exactly that, and
    // this test passed anyway because it only ever read line 1.
    expect(out).not.toMatch(/resolved to/);
    expect(out).not.toMatch(/resolved against the CWD/);
  });

  it('treats a whitespace-only source as UNSET, not as a path', () => {
    writeConfig({ iconSource: '   ' });
    const res = runIn(['--project', root, '--platform', 'android']);
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/no icon source/);
  });
});

/** #1011 — the PRODUCER side. `generate-icons.mjs` is thoroughly tested above; the code that decides
 *  what to TELL it was not tested at all, and that is the half where a wrong edit is destructive.
 *
 *  The mutation that made this block necessary: flip `iconStep`'s polarity to
 *  `splashSrcAbs ? 'true' : 'false'`. A packaged-editor build of a project that HAS an authored
 *  splash then sends `--splash-cleared true`; the script stages the splash and immediately deletes
 *  it, and all 26 Android buckets are rebuilt from the icon. Facet B restored, on the one build that
 *  ships, with the whole suite green. Deleting either `MODOKI_ICONS_HANDLED` was likewise invisible.
 *
 *  ⚠️ These read SOURCE, and the reason is worth stating rather than apologising for: `iconStep` and
 *  the two runners are closures inside a 3,000-line Vite plugin bound to a live request, so there is
 *  nothing importable to call. Extracting them is a real refactor and this is a finishing pass. What
 *  a source assertion CAN catch is exactly the two mutations above — a flipped constant and a
 *  deleted property. What it cannot catch is a change that keeps the spelling and breaks the
 *  meaning. Comments are stripped first, so prose cannot satisfy any of it. */
describe('the editor tells the generator what only it knows (#1011, producer side)', () => {
  const SCANNER = path.join(path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', 'plugins', 'vite-asset-scanner.ts');
  const rawScanner = fs.readFileSync(SCANNER, 'utf8');
  const scanner = stripComments(rawScanner);
  assertScanIsSane(rawScanner, scanner, 'vite-asset-scanner.ts', ['iconStep', 'splash-cleared']);

  it('passes --splash-cleared with the polarity that means what it says', () => {
    // A splash source PRESENT means NOT cleared. Inverting this is a one-token edit that destroys
    // authored art on the packaged editor, which is the build no test in this repo can drive.
    expect(scanner).toContain("--splash-cleared ${splashSrcAbs ? 'false' : 'true'}");
  });

  it('tells build-web to stand down on EVERY route that runs it during a native build', () => {
    // Three entries, and the two scaffold ones were missed on the first pass: the build plan's own
    // prefix steps (x2), /api/add-native-target's runShell, and the auto-scaffold's runScaffoldShell
    // — the last of which matters most, because the build then shifts the flag-carrying step away.
    const planSteps = scanner.match(/build-web\.mjs --target native', env: \{ MODOKI_ICONS_HANDLED: '1' \}/g) ?? [];
    expect(planSteps.length, 'both the iOS and Android prefix steps must carry it').toBe(2);
    const runners = scanner.match(/env: \{ \.\.\.buildEnv, MODOKI_ICONS_HANDLED: '1' \}/g) ?? [];
    expect(runners.length, 'both scaffold runners must carry it').toBe(2);
  });

  it('does not leave a bare build-web native step behind — that step would generate twice', () => {
    // The failure this guards: someone adds a third native entry point and copies the OLD line.
    const bare = scanner.match(/'node engine\/scripts\/build-web\.mjs --target native', cwd:/g) ?? [];
    expect(bare, 'a --target native build-web step with no MODOKI_ICONS_HANDLED').toHaveLength(0);
  });
});
