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
 *  needs `npx` and the network, and what can regress here is the SCOPE RULE, not the tool.
 *
 *  ⚠️ Where a test DOES have to spawn the CLI (the exit-code and config-seam blocks), it runs with
 *  a fake `npx` on PATH. Nothing in this file may reach the registry: `engine/tests` ships in the
 *  OSS snapshot and the free public CI runs a Windows leg, so a networked test here is a networked
 *  test for everyone. #1027 broke that property silently — a default that resolved where none had
 *  before turned two early-returning tests into full generator runs — which is the shape to watch
 *  for when adding a fixture that suddenly has more to do than it used to. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collect, newFilesOutsideScope, restoreSnapshot, resolveIconInputs, stampExtrasFrom } from '../../scripts/generate-icons.mjs';
import { ICON_COLORS, iconColorArgs, bundledIconPath, BUNDLED_ICON_REL } from '../../scripts/iconAssets.mjs';
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

  it('reports no icon only when the config could not be READ (#1027 narrowed this)', () => {
    // ⚠️ This test used to assert BOTH of these were undefined, and #1027 deliberately split them.
    // An empty `iconSource` in a config we successfully read is "authors no icon of its own", which
    // now takes the bundled default — the same one `iconStep` has always applied, which is the
    // whole point of that issue. A `null` cfg is "we could not read it", which must NOT default,
    // because the project may have real art configured and defaulting would overwrite it.
    // Kept as one test so the two cases stay visibly adjacent; the full argument is in the
    // '#1027' describe block below.
    expect(resolveIconInputs({}, ROOT, cfgWith({ iconSource: '' })).icon).toBeTruthy();
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
// observe. Neither case reaches the network — the fatal one returns before the generator is spawned,
// and the other spawns a FAKE `npx` installed below. That sentence used to say "both cases return
// before `npx @capacitor/assets` is ever spawned"; #1027's bundled-icon default made the second one
// run the whole path, so the claim went stale in the same commit that broke it.
describe('generate-icons CLI exit codes (#1011 facet C)', () => {
  const SCRIPT = path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'generate-icons.mjs');
  // ⚠️ A fake `npx` that exits 1, exactly as the seam block below installs one, and #1027 is why
  // this block needs it too. The two tests here used to return at `if (!iconSrc)` before any
  // spawn — which is what the comment above claimed and what made an exit-code test affordable.
  // Once the bundled-icon default landed, "no icon named anywhere" started RESOLVING one, so both
  // tests ran the full path and reached for `@capacitor/assets@3.0.5` over the network from inside
  // `npm test`. Worse than slow: a failed fetch exits non-zero, the non-strict path returns 0, and
  // both tests still pass — so the dependency is invisible until it is the thing making CI hang.
  // The `.cmd` sibling is load-bearing on Windows for the reason the seam block spells out.
  let binDir: string;
  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-fakebin-exit-'));
    fs.writeFileSync(path.join(binDir, 'npx'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'npx.cmd'), '@echo off\r\nexit /b 1\r\n');
  });
  afterEach(() => { fs.rmSync(binDir, { recursive: true, force: true }); });
  const run = (args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      cwd: path.join(SCRIPT, '..', '..', '..'),
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
    });

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

  it('succeeds when NO icon is named anywhere, and says it used the bundled default (#1027)', () => {
    // The other side of the same branch, and the reason facet C could not just be "always fail": a
    // project that authors no icon must still build.
    //
    // ⚠️ #1027 changed what "still build" MEANS here. This used to assert the run skipped
    // generation entirely — which was the defect, because the editor's build plan generated from
    // the bundled icon for the very same project. Now both callers generate, so the assertion is
    // that it ran AND announced which icon it used. The announcement is the part that matters: the
    // `cfg === null` path also names no icon and deliberately does not default, so "generated
    // something" alone cannot tell an operator whether they shipped their mark or the panda.
    const res = run(['--project', root, '--platform', 'android']);
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/using the BUNDLED Modoki icon/);
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
  /** Make the fake `npx` SUCCEED (doing nothing) for the rest of this test.
   *
   *  ⚠️ Needed by any test whose subject is downstream of the generator spawn — the freshness
   *  stamp, the post-processing steps, the restore. The default fake exits 1, so those tests
   *  otherwise return at `if (res.status !== 0)` and assert against a code path that never ran.
   *  That is not hypothetical: the F2 stamp test below passed with its own mechanism deleted until
   *  this existed, because "no stamp" was true for the wrong reason. Still no network — the point
   *  of the fake is only ever which exit code the generator sees. */
  const npxSucceeds = () => {
    fs.writeFileSync(path.join(binDir, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'npx.cmd'), '@echo off\r\nexit /b 0\r\n');
  };
  const writeConfig = (app: Record<string, unknown>) =>
    write('project.config.json', JSON.stringify({ app }, null, 2));
  /** A file the generator can actually copy — its bytes are never decoded on this path. */
  const sourceArt = (rel: string) => write(rel, 'PNG-ish bytes');
  /** A REAL PNG, for any test whose subject is downstream of sharp.
   *
   *  ⚠️ `sourceArt`'s placeholder makes the post-processing steps THROW, which sets `postFailed`
   *  and withholds the stamp for a reason that has nothing to do with the test. Two stamp tests
   *  passed with their own mechanism deleted before this existed. */
  const realPng = (rel: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'engine', 'assets', 'app-icon-default.png'), abs);
    return abs;
  };

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
    // Still the same rule, still for the same reason — `"art/icon.png "` must not become an
    // unreadable path and (post-#1011 facet C) a FATAL build. What UNSET now RESOLVES to is the
    // bundled default rather than nothing (#1027), so the observable proof moved from "it skipped"
    // to "it used the default" — but a whitespace source reaching the generator as a path would
    // still fail this, which is what the test is for.
    writeConfig({ iconSource: '   ' });
    const res = runIn(['--project', root, '--platform', 'android']);
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/using the BUNDLED Modoki icon/);
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/could not read the icon source/);
  });

  // ── #1028: --strict turns the remaining exit-0 degrades into failures ────────────────────
  //
  // #1011 facet C made an unreadable ICON source fatal and stopped there, so `build-web.mjs`'s
  // promise — "not building; building on would ship the previously committed art" — covered one of
  // five failure modes. The other four exited 0.
  //
  // ⚠️ Only the SPLASH row is driven end-to-end here, and that is a deliberate limit rather than an
  // oversight: it is the one degrade that happens BEFORE `npx @capacitor/assets` is spawned, so it
  // costs no network. The other three (a non-zero npx, an unrestorable collateral write, a
  // post-processing throw) all sit after a real generator run, and faking one would mock away the
  // mechanism under test — the shape docs/falsifiable-tests.md exists to stop. What IS pinned for
  // all four is that both BUILD callers pass the flag, in the producer-side block below; that is
  // the half a regression would silently revert.
  it('--strict makes an unreadable splash source FATAL', () => {
    writeConfig({ iconSource: 'art/icon.png', splashSource: 'art/no-such-splash.png' });
    sourceArt('art/icon.png');
    const res = runIn(['--project', root, '--platform', 'android', '--strict', 'true']);
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/could not stage splash\.png/);
    expect(`${res.stdout}${res.stderr}`).toMatch(/--strict: splash\.png was requested and could not be read/);
  });

  it('WITHOUT --strict the same run still succeeds — the hand run stays forgiving', () => {
    // ⚠️ The accept side, and CLAUDE.md requires it: a guard tested only on the reject side cannot
    // distinguish "fails when it should" from "fails always". It also pins the actual DECISION here
    // — the owner chose a flag over making the splash case unconditionally fatal (#1028 option b)
    // precisely so a mistyped `splashSource` does not fail somebody poking at the script by hand.
    writeConfig({ iconSource: 'art/icon.png', splashSource: 'art/no-such-splash.png' });
    sourceArt('art/icon.png');
    const res = runIn(['--project', root, '--platform', 'android']);
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/could not stage splash\.png/);   // still LOUD
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/--strict:/);
  });

  // ── close-out findings F1 and F2: both were wrong in the COMMENTS before they were wrong in
  // the code, which is why each gets a test that drives the real CLI rather than the resolver.
  it('a MALFORMED project.config.json defaults nothing — it is UNKNOWN, not empty (F1)', () => {
    // ⚠️ The art-destroying case #1027's own docblock swore was impossible. `loadProjectConfig`
    // CATCHES its own JSON.parse throw and returns merged defaults (its docstring: "A missing file
    // or unparseable JSON falls back to the defaults"), so `cfg !== null` never meant "was read".
    // A trailing comma in a hand-edited config therefore arrived as a clean config with an empty
    // `iconSource`, and a native build regenerated every icon from the bundled panda over the
    // project's committed art — then stamped it current.
    fs.writeFileSync(path.join(root, 'project.config.json'),
      '{ "app": { "iconSource": "art/icon.png", } }');   // trailing comma
    sourceArt('art/icon.png');
    const res = runIn(['--project', root, '--platform', 'android']);
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/EXISTS but does not parse/);
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/using the BUNDLED Modoki icon/);
  });

  it('a requested-but-unstageable splash writes NO stamp, so --strict stays reachable (F2)', () => {
    // ⚠️ Every --strict check sits downstream of the `upToDate` early return, and this was the one
    // degrade of five that fell through to the stamp write. So one forgiving hand run over a
    // renamed `splashSource` would stamp the icon-derived splash as current, and every later
    // build — --strict or not — would exit 0 on "already current" without reaching a strict branch.
    // The flag would be passed and never execute. Withholding the stamp makes it self-healing.
    // ⚠️ A REAL PNG, not `sourceArt`'s `'PNG-ish bytes'` placeholder — and that is the difference
    // between this test working and this test being decorative. With the placeholder, sharp throws
    // in `writeAndroidIconVariants`, `postFailed` is set for THAT reason, and no stamp is written
    // whatever this fix does: the assertion below passes identically with the mechanism deleted.
    // Found by mutation-checking, which is the only thing that could have found it.
    writeConfig({ iconSource: 'art/icon.png', splashSource: 'art/no-such-splash.png' });
    realPng('art/icon.png');
    npxSucceeds();   // the stamp write is DOWNSTREAM of the spawn — see the helper's note
    const res = runIn(['--project', root, '--platform', 'android']);
    expect(res.status).toBe(0);                                    // forgiving, as designed
    expect(`${res.stdout}${res.stderr}`).toMatch(/could not stage splash\.png/);
    // The assertion that matters: nothing was declared current.
    expect(fs.existsSync(path.join(root, '.cache', 'icon-stamp-android')),
      'a stamp here re-arms the "already current" short-circuit and disarms --strict forever').toBe(false);
    // And the run that follows it must therefore still reach the strict branch.
    const strict = runIn(['--project', root, '--platform', 'android', '--strict', 'true']);
    expect(strict.status).not.toBe(0);
    expect(`${strict.stdout}${strict.stderr}`).toMatch(/--strict: splash\.png was requested and could not be read/);
  });

  // ⚠️ The three SIBLINGS the first cut of #1028 missed, and the reason its comment claiming "the
  // other four degrades already did exactly this" was an enumeration nobody had counted. All five
  // share one mechanism — a REQUESTED input that cannot be read degrades to a DERIVED substitute —
  // and the fix is one rule applied once, not five patches. One test per site, against that rule.
  it('a broken splashDarkSource withholds the stamp too — the light-splash fix missed its twin', () => {
    // The nastiest of the five to notice: the dark splash falls back to the LIGHT art, not to the
    // icon-derived one, so the wrong mark ships only in dark mode — the case least likely to be
    // the one you happen to test.
    writeConfig({ iconSource: 'art/icon.png', splashSource: 'art/splash.png', splashDarkSource: 'art/no-such-dark.png' });
    realPng('art/icon.png');
    realPng('art/splash.png');
    npxSucceeds();
    const res = runIn(['--project', root, '--platform', 'android']);
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/splashDarkSource/);
    expect(fs.existsSync(path.join(root, '.cache', 'icon-stamp-android'))).toBe(false);
  });

  it('a broken icon-variant override withholds the stamp — and is FATAL under --strict', () => {
    // `overrideOrNull` derives from the base icon and returns normally, so this trio never set
    // `postFailed` at all: not merely disarmable like the splash pair, but never firing under
    // --strict even on a first run.
    writeConfig({ iconSource: 'art/icon.png', iconMonochromeSource: 'art/no-such-mono.png' });
    realPng('art/icon.png');
    npxSucceeds();
    const forgiving = runIn(['--project', root, '--platform', 'android']);
    expect(forgiving.status).toBe(0);
    expect(`${forgiving.stdout}${forgiving.stderr}`).toMatch(/iconMonochromeSource/);
    expect(fs.existsSync(path.join(root, '.cache', 'icon-stamp-android'))).toBe(false);

    const strict = runIn(['--project', root, '--platform', 'android', '--strict', 'true']);
    expect(strict.status).not.toBe(0);
    expect(`${strict.stdout}${strict.stderr}`).toMatch(/not building on derived stand-ins/);
  });

  it('a malformed config is FATAL under --strict instead of exiting 0 on stale art', () => {
    // F1's first fix stopped the panda overwriting authored art, but left the run exiting 0 — so
    // `build-web.mjs` saw success and built on, shipping the previously committed art under the
    // very flag that exists to prevent exactly that.
    fs.writeFileSync(path.join(root, 'project.config.json'), '{ "app": { "iconSource": "art/icon.png", } }');
    realPng('art/icon.png');
    const res = runIn(['--project', root, '--platform', 'android', '--strict', 'true']);
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/refusing to build on art whose source could not be determined/);
    // ...and NOT fatal without the flag, so a hand run over a broken config is not a hard stop.
    expect(runIn(['--project', root, '--platform', 'android']).status).toBe(0);
  });

  it('warns on a malformed --strict rather than silently reading it as false', () => {
    // Same reasoning as `--splash-cleared` above, and it matters more here: silently reading a
    // BUILD caller's `--strict` as false restores exactly the shipping-stale-art behaviour the
    // flag was added to remove, with nothing on screen to say so.
    sourceArt('art/icon.png');
    const res = runIn(['--project', root, '--platform', 'android',
      '--icon', path.join(root, 'art', 'icon.png'), '--strict', 'TRUE']);
    expect(`${res.stdout}${res.stderr}`).toMatch(/--strict expects true\|false/);
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

  it('BOTH build paths pass --strict, which is the whole of #1028', () => {
    // ⚠️ The decision this pins is the owner's, not the code's: a degraded generation must stop a
    // BUILD, while a bare hand run of the script stays forgiving. That splits cleanly only if both
    // build callers actually set the flag — drop it from either and that path silently returns to
    // shipping the previously committed art with exit 0, which is the defect, restored, invisibly.
    expect(scanner, "iconStep must pass --strict").toContain('--strict true');
    const rawBuildWeb = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
      '..', '..', 'scripts', 'build-web.mjs'), 'utf8');
    const buildWeb = stripComments(rawBuildWeb);
    assertScanIsSane(rawBuildWeb, buildWeb, 'build-web.mjs', ['generate-icons']);
    expect(buildWeb, 'build-web.mjs must pass --strict to generate-icons').toMatch(/'--strict',\s*'true'/);
  });

  it('does not leave a bare build-web native step behind — that step would generate twice', () => {
    // The failure this guards: someone adds a third native entry point and copies the OLD line.
    const bare = scanner.match(/'node engine\/scripts\/build-web\.mjs --target native', cwd:/g) ?? [];
    expect(bare, 'a --target native build-web step with no MODOKI_ICONS_HANDLED').toHaveLength(0);
  });
});

// ── #1027: the ONE input the #1011 resolver did not own ──────────────────────────────────
//
// #1011 moved every generation input into `resolveIconInputs` — except the bundled-icon default,
// which stayed in `iconStep` (`engine/plugins/vite-asset-scanner.ts`). So for the 22 native projects
// that author no `iconSource`, the EDITOR's build plan generated from `build/icon.png` and the CLI
// native build reported "nothing to generate; committed icons untouched". Same project, same
// config, two answers — `family/one-entry-point` (#827).
describe('resolveIconInputs — the bundled-icon default (#1027)', () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const PROJ = path.join(path.sep, 'proj');
  const cfgWith = (app: Record<string, unknown> = {}) => ({ app, capacitor: {} });

  it('falls back to the bundled icon when the config authors none', () => {
    // The defect exactly: this returned `undefined` and main() printed "nothing to generate".
    expect(resolveIconInputs({}, PROJ, cfgWith({})).icon).toBe(bundledIconPath(REPO_ROOT));
    expect(resolveIconInputs({}, PROJ, cfgWith({ iconSource: '' })).icon).toBe(bundledIconPath(REPO_ROOT));
    // Whitespace has to read as unset too — `resolveIconInputs` trims to mirror what the editor
    // stores, and a config of "   " must not become an unreadable path and (post-#1011 facet C)
    // a FATAL build.
    expect(resolveIconInputs({}, PROJ, cfgWith({ iconSource: '   ' })).icon).toBe(bundledIconPath(REPO_ROOT));
  });

  it('does NOT fall back when the config could not be read — the art-destroying case', () => {
    // ⚠️ The single most important assertion here. `cfg === null` means UNKNOWN, not "authors no
    // icon": the packaged editor ships no esbuild, and an unparseable file lands here too. A
    // project in that state may well have real icon art configured, so defaulting would overwrite
    // it with the Modoki panda — destroying authored art on the one build that ships. This is the
    // same distinction facet B had to learn for `splashCleared`, and it was learned the hard way.
    expect(resolveIconInputs({}, PROJ, null).icon).toBeUndefined();
  });

  it('keeps the flag and the config ahead of the default', () => {
    // The default is a LAST resort — it must not outrank the two things that state an intent.
    expect(resolveIconInputs({ icon: '/abs/override.png' }, PROJ, cfgWith({})).icon).toBe('/abs/override.png');
    expect(resolveIconInputs({}, PROJ, cfgWith({ iconSource: 'art/icon.png' })).icon)
      .toBe(path.join(PROJ, 'art/icon.png'));
    // And a flag still beats a config that DOES author one, which is #1011's precedence rule —
    // restated here because the `??` added for this issue sits on that same expression and could
    // have broken it.
    expect(resolveIconInputs({ icon: '/abs/o.png' }, PROJ, cfgWith({ iconSource: 'art/icon.png' })).icon)
      .toBe('/abs/o.png');
  });

  it('reports the bundled icon as absent rather than returning a path that does not resolve', () => {
    // #1011 facet C makes an unreadable REQUESTED icon fatal, so a default that pointed at a
    // missing file would turn "this checkout has no build/icon.png" into a failed build for every
    // project that authors no icon. Absent must stay absent.
    expect(bundledIconPath(path.join(os.tmpdir(), 'modoki-no-such-root-ever'))).toBeUndefined();
    expect(bundledIconPath(REPO_ROOT)).toBeTruthy();
  });

  it('is defined in ONE place — neither caller rebuilds the path', () => {
    // ⚠️ The shadowing-constant shape this repo has scars from, and the reason #1027 existed at
    // all: the default lived in `iconStep` and nowhere else. A second literal in either caller
    // would silently re-open the divergence the moment one of them changed.
    //
    // Comments are STRIPPED before matching, on purpose: the fix's own explanatory comments
    // discuss the bundled icon by name, and a guard matching raw text would be satisfied by the
    // prose documenting the rule — the exact way `missingSpmDeps` was disarmed once (#812).
    // ⚠️ Matched against BUNDLED_ICON_REL, never a hard-coded string. This guard was written as
    // `.not.toContain('build/icon.png')` and the close-out's own `git mv` then made it VACUOUS —
    // that literal exists nowhere now, so the assertion was satisfied by construction. Proven, not
    // assumed: inlining `path.join(buildCwd, 'engine/assets/app-icon-default.png')` back into
    // `iconStep` — the exact divergence #1027 was filed to close — left the whole file green. A
    // guard that names the value it is protecting follows it when it moves; one that names today's
    // spelling protects only today.
    for (const rel of ['plugins/vite-asset-scanner.ts', 'scripts/generate-icons.mjs']) {
      const raw = fs.readFileSync(path.join(REPO_ROOT, 'engine', rel), 'utf8');
      const code = stripComments(raw);
      assertScanIsSane(raw, code, rel);
      expect(code, `${rel} rebuilds the bundled-icon path instead of importing bundledIconPath()`)
        .not.toContain(BUNDLED_ICON_REL);
    }
    // And the constant must still be somewhere, or the two assertions above pass on an empty
    // needle — `''` is contained in everything, so a blanked constant would flip this guard from
    // vacuous-true to always-false, but a MISSING one would be silent.
    expect(BUNDLED_ICON_REL.length).toBeGreaterThan(5);
  });
});
