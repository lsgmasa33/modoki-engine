/**
 * The plugin-CLASS leg table for `npm run test:native` (#981), and the discovery that keeps it
 * honest.
 *
 * ── WHY THIS FILE IS SEPARATE FROM test-native.mjs ───────────────────────────────────────
 * `test-native.mjs` RUNS the legs at import time — it is a CLI body, not a module. A guard test
 * that imported it to read the table would execute the whole native gate as a side effect of
 * `npm run verify`. So the table lives here, as data with no side effects, and both the runner
 * and `engine/tests/architecture/nativePluginLegCoverage.test.ts` import it.
 *
 * ── WHAT THESE LEGS ADD OVER THE CORE LEGS ───────────────────────────────────────────────
 * `SWIFT_LEGS`/`JAVA_LEGS` in test-native.mjs compile the extracted, dependency-free CORES
 * (OtaCore, IapCore). They do not compile a single plugin CLASS — the `CAPPlugin` subclass that
 * Capacitor actually dispatches into. That gap is not academic: #971 found `@PluginMethod` sitting
 * on a PRIVATE helper in `ModokiIapPlugin.java` (fixed in `2d711ee05`), and the mirror-image bug —
 * a MISSING `@PluginMethod` on `products()`, which broke every Android shelf call from that
 * plugin's first commit — is recorded in that same file's comments. Both are compile/annotation
 * level defects in files no gate compiled.
 *
 * ── ⚠️ THREE INTEGRATION SHAPES, AND THE LEG MUST MATCH THE PACKAGE'S OWN ────────────────
 * The obvious design — one `xcodebuild -scheme` per package — is WRONG, and measurably so
 * (2026-09-09): it reports a false FAILURE on `capacitor-modoki-ota`, whose plugin is correct.
 *
 *   'spm'  The package's own manifest is how it links. `OtaPlugin`'s sibling `IapPlugin.swift`
 *          really does `import ModokiIapCore`, so building the declared product is a faithful
 *          test. Six of the eight packages are this shape.
 *
 *   'flat' The plugin ships as LOOSE pbxproj file references compiled directly into the
 *          consuming app's target, so its sources and its core's land in ONE flat module and the
 *          plugin deliberately carries NO `import` of the core — see `OtaPlugin.swift`'s own note
 *          and `Package.swift`'s header, which says the manifest exists "for package
 *          resolution/documentation … NOT how it's actually linked into an app". Building the
 *          declared product therefore fails with `cannot find type 'OtaState' in scope` on code
 *          that ships and works. This leg instead SYNTHESISES a package whose single target holds
 *          `flatSources` together, which is what the app really compiles.
 *
 *   'no-spm'
 *          The package is NOT an SPM package and this repo has decided it must not become one —
 *          so there is no iOS class leg to run, and pretending there is produces a permanently
 *          red line that reads as noise. The leg reports **N/A** with its `reason`, which is off
 *          the exit code even under `--require-all` (a machine cannot install its way out of a
 *          structural decision, which is exactly what separates N/A from SKIP).
 *          ⚠️ An N/A row is only honest while its premise holds, so the premise is ASSERTED by
 *          `capacitorPlatformDeclarations.test.ts` — under `npm run verify`, not under this gate.
 *          One row today: `capacitor-litert-lm`, whose comment carries the whole argument.
 *
 * ⚠️ `iap` and `ota` made OPPOSITE choices for the identical problem and nothing records why. The
 * gate models both rather than changing a device-verified shipping path to make a test tidier
 * (owner, 2026-09-09). If they are ever converged, `ota` becomes a plain 'spm' row and
 * `flatSources` goes away.
 *
 * ── SCHEME NAMES ARE DERIVED, NOT LISTED ─────────────────────────────────────────────────
 * `xcodebuild`'s scheme for an SPM package is the PACKAGE name from `Package.swift` (measured —
 * it is not the product name; a package named `FlatOta` exporting a library `Flat` has exactly one
 * scheme, `FlatOta`). Reading it from the manifest rather than writing it in this table keeps the
 * table from being a second copy that drifts green.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT_DIRS } from './projectRoots.mjs';

/** Repo-relative, forward-slashed — the key both the table and the guard compare on, so the
 *  comparison does not become a Windows path-separator question. */
export const relKey = (repoRoot, abs) => path.relative(repoRoot, abs).split(path.sep).join('/');

/**
 * The leg's name in the gate summary.
 *
 * ⚠️ NOT `path.basename(dir)`. Two copies of `capacitor-applovin-max` exist — court's and
 * 3d-test's — so the basename produced TWO legs called `ios/class/capacitor-applovin-max` in one
 * summary, and a FAIL on either was unattributable. Measured on the first real run of this gate.
 * An engine plugin keeps its bare name; a project-owned one is prefixed with its project, which is
 * the only thing that distinguishes the two copies.
 *
 * The project roots come from PROJECT_ROOT_DIRS rather than a `games|demos` literal here — that
 * list is authored in ONE place and a second copy of it would drift the day a root is added.
 */
export function legLabel(dir) {
  const enginePrefix = 'engine/packages/';
  if (dir.startsWith(enginePrefix)) return dir.slice(enginePrefix.length);
  for (const root of PROJECT_ROOT_DIRS) {
    const m = new RegExp(`^${root}/([^/]+)/packages/(.+)$`).exec(dir);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return dir;
}

/**
 * Every Capacitor plugin package that exists on disk, found by GLOB.
 *
 * ⚠️ Derived, never listed. #981's own table enumerated seven packages by hand and missed
 * `games/3d-test/packages/capacitor-applovin-max` — a second copy of court's, identical but for
 * build artifacts. A hand-maintained list is a second copy of the filesystem and drifts silently;
 * this is what lets `nativePluginLegCoverage.test.ts` fail when a package is added with no leg.
 *
 * A package counts if it carries a `Package.swift`. That is the manifest every one of them has,
 * and it is what the iOS legs need.
 */
export function discoverPluginPackages(repoRoot) {
  const found = [];
  const scan = (parentAbs) => {
    if (!fs.existsSync(parentAbs)) return;
    for (const entry of fs.readdirSync(parentAbs, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('capacitor-')) continue;
      const abs = path.join(parentAbs, entry.name);
      if (fs.existsSync(path.join(abs, 'Package.swift'))) found.push(abs);
    }
  };
  // Engine-owned plugins.
  scan(path.join(repoRoot, 'engine', 'packages'));
  // Project-owned plugins: <root>/<project>/packages/capacitor-*. PROJECT_ROOT_DIRS is the one
  // authored table of where projects live (games/, demos/) — never a second literal here.
  for (const root of PROJECT_ROOT_DIRS) {
    const rootAbs = path.join(repoRoot, root);
    if (!fs.existsSync(rootAbs)) continue;
    for (const project of fs.readdirSync(rootAbs, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      scan(path.join(rootAbs, project.name, 'packages'));
    }
  }
  found.sort();
  return found;
}

/** The package name from a `Package.swift` — which IS the xcodebuild scheme. Returns null rather
 *  than guessing, so a caller SKIPs with a stated reason instead of building the wrong thing. */
export function schemeFor(packageDir) {
  const manifest = path.join(packageDir, 'Package.swift');
  if (!fs.existsSync(manifest)) return null;
  // The FIRST `name:` in the manifest is the package's own — product and target names come later,
  // inside `products:`/`targets:`. Anchored to a line start so a `name:` inside a comment or a
  // nested literal on the same line as something else cannot win.
  const m = /^\s*name:\s*"([^"]+)"/m.exec(fs.readFileSync(manifest, 'utf8'));
  return m ? m[1] : null;
}

/**
 * ⚠️ One row per package that `discoverPluginPackages()` finds — enforced by
 * `nativePluginLegCoverage.test.ts` in BOTH directions, so a new plugin package fails the gate
 * until somebody decides its shape, and a deleted one fails until its row goes.
 *
 * `dir` is the repo-relative key. `shape` is 'spm', 'flat' or 'no-spm' (see the header).
 * `flatSources` is required for, and only for, 'flat': every `.swift` the consuming app compiles
 * into its own target for this plugin. `reason` is required for, and only for, 'no-spm'.
 *
 * ⚠️ `knownFail: '#N'` — a leg that runs and is expected to fail — is still supported by the runner
 * but has NO row today, and reaching for it should be rare. The one row that had it (litert-lm) was
 * not a broken SPM leg at all; it was a package that is not an SPM package, and saying so with
 * 'no-spm' is both more honest and better checked. Before adding a `knownFail`, ask whether the leg
 * is genuinely a temporarily-broken build of something this repo intends to build.
 */
export const PLUGIN_CLASS_LEGS = [
  { dir: 'engine/packages/capacitor-appsflyer', shape: 'spm' },
  { dir: 'engine/packages/capacitor-game-debug', shape: 'spm' },
  {
    dir: 'engine/packages/capacitor-litert-lm',
    shape: 'no-spm',
    // ⚠️ #991. This was a 'spm' row carrying `knownFail: '#991'`, and that was the wrong shape for
    // the wrong reason — it modelled the package as "an SPM leg that is temporarily broken" when it
    // is not an SPM package at all:
    //
    //   · `package.json` declares `capacitor: { android: … }` and nothing else, so `cap sync ios`
    //     never registers this plugin in ANY consuming app.
    //   · It is compiled into no App target — `capacitorPlatformDeclarations.test.ts` says so in
    //     its own docblock, which is why that file needed a SECOND rule to reach this package.
    //   · That second rule exists specifically to FORBID this package declaring `ios` until
    //     `Package.swift` gains the podspec's `MediaPipeTasksGenAI` + `MediaPipeTasksGenAIC`.
    //
    // So an iOS SPM leg here compiled a configuration the repo deliberately outlaws, for a platform
    // the package does not claim. Google publishes no SPM distribution of MediaPipeTasksGenAI (the
    // pods are prebuilt binaries built internally; google-ai-edge/mediapipe#5464 is open and
    // unanswered), so the one-line fix has nothing to point at and never will on its own.
    //
    // ⚠️ THE SELF-EXPIRY IS NOT LOST, it MOVED AND GOT BETTER. `knownFail` expired by flipping to
    // FAIL if the leg ever passed — but only on a machine with macOS + Xcode running `test:native`,
    // which is rare. The premise of THIS row is asserted by `capacitorPlatformDeclarations.test.ts`
    // instead: the moment `Package.swift` declares the podspec's dependencies, or `package.json`
    // declares `ios`, that guard goes red and names this row. `npm run verify` runs everywhere, on
    // every push, with no Xcode — so the stale-row check now fires on the machine that made it
    // stale, in the gate that actually runs.
    //
    // ⚠️ `reason` is REQUIRED on this shape and is printed in the gate summary. A silent N/A is the
    // exemption-nobody-revisits this row exists to avoid.
    reason: 'declares capacitor.android only and is compiled into no App target; Package.swift '
      + 'cannot declare the podspec\'s MediaPipe dependencies because Google ships no SPM '
      + 'distribution of them (#991)',
  },
  { dir: 'engine/packages/capacitor-modoki-iap', shape: 'spm' },
  {
    dir: 'engine/packages/capacitor-modoki-ota',
    shape: 'flat',
    // Exactly what MyViewController's target compiles: the plugin plus the core it reaches
    // WITHOUT an import. Keep in step with the pbxproj file references that vendor this plugin —
    // a core file added here but not there (or vice versa) means the gate and the app are
    // compiling different sets.
    flatSources: [
      'ios/Sources/ModokiOtaPlugin/OtaPlugin.swift',
      'core/Sources/ModokiOtaCore/OtaCore.swift',
      'core/Sources/ModokiOtaCore/OtaZip.swift',
    ],
  },
  // ⚠️ TWO copies of applovin-max exist — court's and 3d-test's, identical but for build
  // artifacts. Both get a leg because both are on disk and both would ship. #931 proposes
  // promoting one into engine/packages/, which collapses these two rows into one.
  { dir: 'games/3d-test/packages/capacitor-adjust', shape: 'spm' },
  { dir: 'games/3d-test/packages/capacitor-applovin-max', shape: 'spm' },
  { dir: 'games/court/packages/capacitor-applovin-max', shape: 'spm' },
];
