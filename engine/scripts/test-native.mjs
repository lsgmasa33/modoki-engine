#!/usr/bin/env node
/**
 * The ON-DEMAND native gate: runs the test suites that `npm run verify` structurally cannot (#376).
 *
 *     npm run test:native            # run every leg that this machine can run
 *     npm run test:native -- --require-all   # a skipped leg is a FAILURE (CI/pre-release use)
 *
 * ── WHY A SEPARATE GATE ──────────────────────────────────────────────────────────────────
 * `npm run verify` is vitest. It cannot run XCTest, gradle, or a bare JVM. The device lease is
 * implemented three times — TS, Swift, Java — against one shared contract
 * (`capacitor-game-debug/test-vectors/lease-golden-vectors.json`), and until #376 only the TS
 * replay was ever executed: the Swift one had no test target at all, and the Java one had no
 * runner. Both had been sitting green-looking and dead, which is this repo's recurring shape —
 * a test that never runs looks exactly like a test that passes.
 *
 * So the two native replays are wired HERE, deliberately outside the default gate, and both files
 * now say so in their headers. Their silence during `npm run verify` is intentional; their silence
 * here is not, which is why a skip is printed as loudly as a failure and `--require-all` turns it
 * into one.
 *
 * The same sweep found capacitor-modoki-ota's Swift + Java replays in the same state for a weaker
 * reason: they HAD runnable commands, but only as two hand-typed recipes in docs/ota-updates.md, so
 * they ran when somebody remembered. They are legs here now.
 *
 * ── WHAT A GREEN RUN PROVES ──────────────────────────────────────────────────────────────
 * Per leg, and they differ — do not read one green summary as one claim:
 *   - OTA (both legs) test the SHIPPING code: OtaCore.swift / OtaCore.java are the real
 *     implementations, replayed against the shared vectors.
 *   - IAP (both legs, #971) test the SHIPPING code too: ModokiIapCore.IapClassification and
 *     IapCore.java are the real implementations, replayed against
 *     test-vectors/iap-classification-vectors.json. Before this the plugin's Swift and Java were
 *     compiled by NOTHING in this repo — not verify, not this gate, not CI — so #946 landed native
 *     changes on a green gate that could not have caught a mistake in them. Two caveats a green
 *     run does NOT cover: IapCore.RESPONSE_USER_CANCELED matching Play's own constant (that needs
 *     the billing library, and NOTHING checks it — a static comparison was tried and removed, see
 *     IapCore's header), and that the plugin still CALLS the core correctly on a real purchase —
 *     only a device cancel shows that.
 *   - The lease legs test PORTS of the spec that live inside the test files, while
 *     GameDebugPlugin keeps its own lease state behind a platform timer. Closing that gap means
 *     extracting a pure LeaseCore into the shipping sources — a behavioural native change needing
 *     device verification, out of scope for #376 and recorded in both test headers.
 *   - The `ios/class/*` legs (#981) COMPILE each plugin class, which nothing did before: they
 *     prove the Swift parses, resolves its imports and type-checks against the real Capacitor
 *     headers. The `android/class/*` legs (#992) do the same for the Java/Kotlin class against the
 *     real Capacitor core, AndroidX and the vendor SDK. Both prove NOTHING about behaviour — no test
 *     runs — and ⚠️ the Android ones cannot see a `@PluginMethod` defect at all (a missing or
 *     misplaced annotation compiles); `pluginMethodParity.test.ts` under `npm run verify` does.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT_DIRS } from './projectRoots.mjs';
import { loadEnginePluginModule } from './loadVendorPlugins.mjs';
import { buildZip } from './ota/zip.mjs';
import { PLUGIN_CLASS_LEGS, schemeFor, legLabel, networkFailureCause, joinCapturedStreams } from './nativePluginLegs.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pluginDir = path.join(repoRoot, 'engine', 'packages', 'capacitor-game-debug');
const requireAll = process.argv.slice(2).includes('--require-all');

/** A leg either RAN (pass/fail), was SKIPPED for a stated environmental reason, or is N/A. */
const results = [];
const skip = (name, reason) => results.push({ name, status: 'SKIP', reason });
/** N/A — this leg does not exist to be run, and no machine can change that.
 *
 *  ⚠️ The distinction from SKIP is the whole point and it is load-bearing for `--require-all`. A
 *  SKIP says "this runner could not check it" — install Xcode, provision a JDK, and it becomes a
 *  real result, so counting it as a failure under `--require-all` is right. An N/A says "there is
 *  nothing here to check", which is a fact about the PACKAGE (see the 'no-spm' shape in
 *  nativePluginLegs.mjs). Folding the two together would mean a pre-release run can never be green
 *  no matter what is installed, which is how `--require-all` stops being used at all.
 *
 *  ⚠️ It is not a quiet exemption either: it prints with its reason like every other row, and the
 *  premise behind each N/A row is asserted under `npm run verify` by
 *  `capacitorPlatformDeclarations.test.ts`, so a row that stops being true goes red there. */
const na = (name, reason) => results.push({ name, status: 'N/A', reason });
const record = (name, code) => results.push({ name, status: code === 0 ? 'PASS' : 'FAIL' });

/** Is this command runnable? An ABSOLUTE path is answered from the filesystem, not from
 *  `which`/`where`: Windows `where` takes a NAME or pattern and errors on a full path, which would
 *  have made the JVM legs SKIP on Windows with a provisioned JDK sitting right there. A bare name
 *  goes to the PATH lookup, adding `.exe` on Windows where a bare `javac` is not a file. */
function has(cmd) {
  if (path.isAbsolute(cmd)) {
    return fs.existsSync(cmd) || (process.platform === 'win32' && fs.existsSync(`${cmd}.exe`));
  }
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
}

/** `spawnable()` from engine/toolchain — the repo's ONE answer to "how do I spawn a resolved tool
 *  path on Windows": since CVE-2024-27980 (Node ≥18.20) spawning a `.cmd`/`.bat` WITHOUT
 *  `shell:true` throws `spawn EINVAL`, and with `shell:true` an unquoted path containing a space
 *  is split by the shell. Both apply here — the Android leg's command is `gradlew.bat` on Windows.
 *  Loaded through the same esbuild seam build-web.mjs uses, rather than re-implemented: a private
 *  copy of that rule is how it drifts. If the seam is unavailable (no esbuild), fall back to the
 *  bare spawn and SAY so, rather than silently spawning something Windows will reject. */
let spawnable = null;
try {
  ({ spawnable = null } = (await loadEnginePluginModule(repoRoot, path.join('toolchain', 'index.ts'))) ?? {});
} catch (e) {
  // NOT fatal. This is a top-level await, so an unhandled rejection here would kill the whole
  // gate before a single leg ran or a summary printed — turning "the shell helper is
  // unavailable" into "the native tests appear not to exist". loadEnginePluginModule catches a
  // missing esbuild but not a bundle failure, and its /tmp bundle marks packages external, so
  // the day anything under engine/toolchain imports a bare package this path is what runs.
  console.warn(`[test:native] could not load engine/toolchain (${e.message}) — falling back to a bare spawn`);
}
if (!spawnable && process.platform === 'win32') {
  console.warn('[test:native] no spawnable() — a .cmd/.bat command will likely fail with spawn EINVAL (CVE-2024-27980)');
}

function run(name, cmd, args, opts = {}) {
  const sp = spawnable ? spawnable(cmd, args) : { command: cmd, args, shell: false };
  console.log(`\n── ${name}: ${cmd} ${args.join(' ')}\n`);
  const r = spawnSync(sp.command, sp.args, { cwd: repoRoot, stdio: 'inherit', shell: sp.shell, ...opts });
  // spawnSync sets .error (not a code) when the binary itself could not be launched.
  record(name, r.error ? 1 : r.status ?? 1);
  if (r.error) console.error(`[test:native] ${name}: ${r.error.message}`);
}

// ── The legs ────────────────────────────────────────────────────────────────────────────
// One table, so adding a native suite is a row rather than another bespoke block — and so the
// summary can name every leg that exists, including the ones this machine could not run.
const otaDir = path.join(repoRoot, 'engine', 'packages', 'capacitor-modoki-ota');
const iapDir = path.join(repoRoot, 'engine', 'packages', 'capacitor-modoki-iap');

// The ios/ota-core leg's OtaZipTests.swift cross-checks OtaZip against a REAL zip built by the
// Node writer (engine/scripts/ota/zip.mjs) — that fixture used to be a hand-typed /tmp file
// nothing ever created, so the test silently XCTSkip'd forever (#565). Build it here and hand it
// to the leg via env rather than checking in a binary .zip.
let otaZipFixturePath = null;
let otaZipFixtureError = null;
try {
  const entries = [
    { path: 'index.html', data: Buffer.from('<html>hi</html>', 'utf8') },
    { path: 'assets/app.js', data: Buffer.from('console.log(1)'.repeat(50), 'utf8') },
    { path: 'assets/tiny.txt', data: Buffer.from('x', 'utf8') },
    { path: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-zip-fixture-'));
  otaZipFixturePath = path.join(fixtureDir, 'ota-test.zip');
  fs.writeFileSync(otaZipFixturePath, buildZip(entries));
  // ⚠️ The fixture has to outlive every leg that reads it, so it cannot be removed inline — but
  // without this it was removed NOWHERE, and the gate leaked one directory per run on every
  // platform since #992. Measured on `win` 2026-09-12 (#1079): four runs, four directories left
  // in %TEMP%. `exit` fires on a normal finish AND on process.exit(), and removeTempDir swallows
  // its own failure, so this cannot turn a cleanup problem into a gate failure.
  process.on('exit', () => removeTempDir(fixtureDir));
} catch (e) {
  // NOT environmental — this machine is fully capable of producing the fixture, so a failure
  // here is a FAIL for the leg that needs it, not a SKIP.
  otaZipFixtureError = e.message;
}

/** `swift test` legs: a package path that must carry its own Package.swift. Each leg may declare
 *  `env(fixturePath)` to pass leg-specific environment — a row, not a special case in the loop. */
const SWIFT_LEGS = [
  { name: 'ios/lease-parity', packagePath: path.join(pluginDir, 'ios', 'Tests') },
  {
    name: 'ios/ota-core',
    packagePath: path.join(otaDir, 'core'),
    env: () => ({ MODOKI_OTA_ZIP_FIXTURE: otaZipFixturePath }),
    // #565-class mutation guard: OtaZipTests.swift XCTSkips (exit 0) when
    // MODOKI_OTA_ZIP_FIXTURE is absent — the correct behavior for a human running `swift
    // test` standalone, but a silent false PASS if this leg's `env:` row above is ever
    // deleted from this table. `requiresFixture: true` makes the runner loop below verify a
    // fixture is actually WIRED for this leg (not just that the platform/tools are
    // available) and FAIL loudly if it isn't, rather than letting the Swift-side XCTSkip
    // stand in for a real result.
    requiresFixture: true,
  },
  // #971. Like ota-core this drives the SHIPPING classification (ModokiIapCore), not a port of it
  // living in the test — see IapClassification.swift's header for why importing StoreKit is fine
  // here while importing Capacitor is not.
  { name: 'ios/iap-core', packagePath: path.join(iapDir, 'iap-core') },
];

for (const leg of SWIFT_LEGS) {
  const rel = path.relative(repoRoot, leg.packagePath);
  // Environmental checks FIRST: on a machine that cannot run this leg at all, a fixture failure is
  // irrelevant and must stay a SKIP — reporting FAIL there would fire a false alarm under
  // --require-all on a non-macOS runner.
  if (process.platform !== 'darwin') skip(leg.name, `XCTest needs macOS (this is ${process.platform})`);
  else if (!has('swift')) skip(leg.name, 'no `swift` on PATH — install the Xcode command line tools');
  else if (!fs.existsSync(path.join(leg.packagePath, 'Package.swift'))) skip(leg.name, `no test package at ${rel}`);
  else if (leg.requiresFixture && !leg.env) {
    // The platform/tools ARE available — this is exactly the case where deleting the leg's
    // `env:` row would otherwise silently produce a false PASS (the Swift test would run
    // with MODOKI_OTA_ZIP_FIXTURE unset, hit XCTSkip, and exit 0). A leg that needs the
    // fixture but declares no way to supply it is a misconfigured leg, not an environmental
    // skip — fail it loudly instead.
    results.push({ name: leg.name, status: 'FAIL', reason: 'required fixture not available — leg misconfigured (its env: row is missing) or fixture build broken' });
  }
  else if (leg.env && otaZipFixtureError) {
    // NOT environmental — this runner is responsible for producing the fixture on a machine that
    // could otherwise run the leg, so failing to do so is a FAIL, not a SKIP.
    results.push({ name: leg.name, status: 'FAIL', reason: `could not build the OtaZip test fixture: ${otaZipFixtureError}` });
  }
  else if (leg.requiresFixture && leg.env && !leg.env().MODOKI_OTA_ZIP_FIXTURE) {
    // Belt-and-suspenders: env() exists but doesn't actually resolve to a fixture path (e.g.
    // narrowed rather than removed outright) — same "leg misconfigured" verdict as above.
    results.push({ name: leg.name, status: 'FAIL', reason: 'required fixture not available — leg misconfigured (env() did not produce MODOKI_OTA_ZIP_FIXTURE) or fixture build broken' });
  }
  else run(leg.name, 'swift', ['test', '--package-path', leg.packagePath], leg.env ? { env: { ...process.env, ...leg.env() } } : {});
}

// ── iOS: the plugin CLASS legs (#981) ───────────────────────────────────────────────────
/** The legs above compile the extracted CORES. NONE of them compiles a plugin CLASS — the
 *  `CAPPlugin` subclass Capacitor dispatches into — which is exactly where the annotation-level
 *  defects live (#971 found `@PluginMethod` on a private helper; a MISSING one on `products()`
 *  broke every Android shelf call from that plugin's first commit). The table, the two integration
 *  shapes and why the shapes cannot be collapsed: engine/scripts/nativePluginLegs.mjs.
 *
 *  ⚠️ A FRESH derivedDataPath per leg, for the same reason JAVA_LEGS uses a fresh classes dir: a
 *  leftover build product would let this pass against code that no longer compiles. The SPM
 *  *fetch* cache is global and unaffected, which is why the whole set is ~60s warm rather than
 *  minutes. */
for (const leg of PLUGIN_CLASS_LEGS) {
  const name = `ios/class/${legLabel(leg.dir)}`;
  const dir = path.join(repoRoot, leg.dir);
  // ⚠️ BEFORE the platform/toolchain gates, on purpose. A 'no-spm' row is a statement about the
  // PACKAGE, not about this machine — reporting it as SKIP on a Linux runner ("no xcodebuild")
  // would name the wrong cause and, worse, would make `--require-all` fail on something no
  // amount of tooling can satisfy. The answer is the same on every machine, so it is decided here.
  if (leg.shape === 'no-spm') { na(name, leg.reason ?? 'no reason declared — fix the row in nativePluginLegs.mjs'); continue; }
  if (process.platform !== 'darwin') { skip(name, `xcodebuild needs macOS (this is ${process.platform})`); continue; }
  if (!has('xcodebuild')) { skip(name, 'no `xcodebuild` on PATH — install Xcode'); continue; }
  if (!fs.existsSync(path.join(dir, 'Package.swift'))) { skip(name, `no package at ${leg.dir}`); continue; }

  let buildDir = dir;
  let scheme = schemeFor(dir);
  let tempRoot = null;

  if (leg.shape === 'flat') {
    // Synthesise the module the consuming APP actually compiles: plugin + core sources together,
    // no import between them. Building the package's own declared product instead reports a false
    // FAILURE here (`cannot find type 'OtaState' in scope`) on code that ships and works.
    const missing = (leg.flatSources ?? []).filter((rel) => !fs.existsSync(path.join(dir, rel)));
    if (!leg.flatSources?.length) { skip(name, 'flat leg declares no flatSources — misconfigured row'); continue; }
    if (missing.length) { skip(name, `flat source(s) missing: ${missing.join(', ')}`); continue; }

    // Reuse the REAL manifest's capacitor-swift-pm pin rather than writing a second one that can
    // drift. ⚠️ If the package declares any OTHER remote dependency, a synthesised single-target
    // package would not carry it — so SKIP loudly instead of building something that is not what
    // ships. Only `ota` is flat today and it declares exactly the one.
    const manifestSrc = fs.readFileSync(path.join(dir, 'Package.swift'), 'utf8');
    const remotes = [...manifestSrc.matchAll(/\.package\(\s*url:\s*"([^"]+)"[^)]*?from:\s*"([^"]+)"/g)];
    const capacitor = remotes.find(([, url]) => url.includes('capacitor-swift-pm'));
    if (!capacitor) { skip(name, 'flat leg: no capacitor-swift-pm dependency found in the real manifest'); continue; }
    if (remotes.length > 1) {
      skip(name, `flat leg: package declares ${remotes.length} remote dependencies and a synthesised single-target package would carry only capacitor-swift-pm — extend the synthesiser before trusting this leg`);
      continue;
    }

    // ⚠️ The synthesis FLATTENS by basename into one directory, so two sources sharing a basename
    // (a plausible `Plugin/Util.swift` + `Core/Util.swift` pairing) would silently overwrite each
    // other and the leg would compile a SMALLER set than the app does — and still report PASS. No
    // collision today; this is what stops the day there is one from being invisible.
    const bases = leg.flatSources.map((rel) => path.basename(rel));
    if (new Set(bases).size !== bases.length) {
      skip(name, `flat leg: two flatSources share a basename (${bases.join(', ')}) and the synthesis flattens into one directory — they would overwrite each other`);
      continue;
    }

    scheme = `Flat${path.basename(leg.dir).replace(/[^A-Za-z0-9]/g, '')}`;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-flat-plugin-'));
    const srcDir = path.join(tempRoot, 'Sources', 'Flat');
    fs.mkdirSync(srcDir, { recursive: true });
    for (const rel of leg.flatSources) fs.copyFileSync(path.join(dir, rel), path.join(srcDir, path.basename(rel)));
    fs.writeFileSync(path.join(tempRoot, 'Package.swift'), [
      '// swift-tools-version: 5.9',
      '// GENERATED by engine/scripts/test-native.mjs — models the flat app-target compilation.',
      'import PackageDescription',
      `let package = Package(`,
      `    name: "${scheme}",`,
      '    platforms: [.iOS(.v15)],',
      '    products: [.library(name: "Flat", targets: ["Flat"])],',
      `    dependencies: [.package(url: "${capacitor[1]}", from: "${capacitor[2]}")],`,
      '    targets: [.target(name: "Flat", dependencies: [',
      '        .product(name: "Capacitor", package: "capacitor-swift-pm"),',
      '        .product(name: "Cordova", package: "capacitor-swift-pm"),',
      '    ], path: "Sources/Flat")]',
      ')',
      '',
    ].join('\n'));
    buildDir = tempRoot;
  }

  if (!scheme) { skip(name, `could not read the package name from ${leg.dir}/Package.swift — that name IS the xcodebuild scheme`); continue; }

  const derived = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-plugin-class-dd-'));
  try {
    run(name, 'xcodebuild', ['-scheme', scheme, '-destination', 'generic/platform=iOS', '-derivedDataPath', derived, 'build'], { cwd: buildDir });
    // A leg that CANNOT pass yet (see `knownFail` in nativePluginLegs.mjs). Two rewrites, and the
    // second is the one that keeps this honest:
    //   FAIL -> KNOWN-FAIL, off the exit code, so the gate keeps a GREEN BASELINE and a later FAIL
    //           still means "a change broke something" rather than "read the summary carefully".
    //   PASS -> FAIL, because the marker is now STALE. That is what makes this expire by itself
    //           instead of becoming a standing exemption nobody revisits.
    if (leg.knownFail) {
      const r = results[results.length - 1];
      if (r?.name === name) {
        if (r.status === 'FAIL') { r.status = 'KNOWN-FAIL'; r.reason = `known failure, tracked as ${leg.knownFail}`; }
        else if (r.status === 'PASS') { r.status = 'FAIL'; r.reason = `PASSED while marked knownFail ${leg.knownFail} — the defect is fixed, so DELETE the knownFail marker in nativePluginLegs.mjs`; }
      }
    }
  } finally {
    fs.rmSync(derived, { recursive: true, force: true });
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** The toolchain's resolved paths, from the SAME resolver the editor and the CLI build use — never a
 *  fresh probe, and never `/usr/libexec/java_home -v 21`, which on this machine returns a JDK 25
 *  path with exit 0 (see print-toolchain-env.mjs). `androidHome` feeds the plugin-class legs (#992):
 *  neither ANDROID_HOME nor ANDROID_SDK_ROOT is set on the reference Mac, because the SDK lives
 *  under the Modoki toolchain directory instead. */
function toolchainEnv() {
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'engine', 'scripts', 'print-toolchain-env.mjs'), '--json'],
    { cwd: repoRoot, encoding: 'utf8' });
  try { return JSON.parse(r.stdout) ?? {}; } catch { return {}; }
}

const toolchain = toolchainEnv();
const javaHome = toolchain.javaHome ?? null;
if (javaHome) console.log(`[test:native] JAVA_HOME=${javaHome}`);
else console.warn('[test:native] no provisioned JDK found — the JVM legs will use the machine default, which on a JDK 25 default fails with "Unsupported class file major version 69"');
const javaBin = (tool) => (javaHome ? path.join(javaHome, 'bin', tool) : tool);
const javaEnv = { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) };

// ── Android: the plain-JVM gradle harness (lease parity) ────────────────────────────────
/** Any gradle we can drive: an explicit override, a system gradle, or a project's wrapper.
 *  The wrapper fallback exists because this Mac has no system gradle and committing a second
 *  wrapper jar into engine/ to run one JVM test is a poor trade — a wrapper only bootstraps the
 *  distribution named in its OWN properties file, so borrowing one is safe. Deterministic order,
 *  never "the first one readdir happened to yield". */
function findGradle() {
  if (process.env.MODOKI_GRADLE) return { cmd: process.env.MODOKI_GRADLE, from: 'MODOKI_GRADLE' };
  // The WRAPPER is preferred over a system gradle, and that order matters: every project wrapper
  // in this repo pins 8.14.3, while a Homebrew/scoop `gradle` is 9.x — so "whatever is on PATH"
  // makes the harness's gradle version a property of the developer's machine. A pinned, already
  // cached distribution is the reproducible choice.
  const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const candidates = [];
  for (const root of PROJECT_ROOT_DIRS) {
    const abs = path.join(repoRoot, root);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const gw = path.join(abs, entry.name, 'android', wrapper);
      if (fs.existsSync(gw)) candidates.push(gw);
    }
  }
  candidates.sort();
  if (candidates.length) return { cmd: candidates[0], from: path.relative(repoRoot, candidates[0]) };
  if (has('gradle')) return { cmd: 'gradle', from: 'PATH (no project wrapper found)' };
  return null;
}

const harness = path.join(pluginDir, 'android', 'test-harness');
const gradle = findGradle();
if (!gradle) {
  skip('android/lease-parity', 'no gradle: no project wrapper in the repo, none on PATH, MODOKI_GRADLE unset');
} else if (!fs.existsSync(path.join(harness, 'build.gradle'))) {
  skip('android/lease-parity', `no harness at ${path.relative(repoRoot, harness)}`);
} else {
  console.log(`[test:native] gradle: ${gradle.cmd} (${gradle.from})`);
  run('android/lease-parity', gradle.cmd, ['-p', harness, 'test'], { env: javaEnv });
}

// ── Android: the plugin CLASS legs (#992) ───────────────────────────────────────────────
/** The Android twin of `ios/class/*`: compile each plugin class against the REAL Capacitor core,
 *  AndroidX and the plugin's vendor SDK. Before this, a plugin class was compiled only inside some
 *  game's own native build.
 *
 *  ⚠️ WHAT THIS CANNOT CATCH — stated first, because the issue it closes assumed otherwise: neither
 *  `@PluginMethod` defect #971 found. Capacitor indexes plugin methods at RUNTIME
 *  (`PluginHandle` → `getMethods()` + the annotation), so javac accepts a MISSING annotation and one
 *  on a PRIVATE helper alike. Those are caught under `npm run verify`, for every package, by
 *  `engine/tests/architecture/pluginMethodParity.test.ts`. This leg catches what javac can see: API
 *  drift against Capacitor / AndroidX / a vendor SDK, a wrong import, a type error.
 *
 *  Shape: one throwaway Gradle project per leg, whose settings include `:capacitor-android` (from the
 *  root node_modules, as a game's `capacitor.settings.gradle` does) and `:plugin` (the package's own
 *  `android/`). No `rootProject.ext` is set — every build.gradle here falls back to its own defaults
 *  — and AGP is declared once at the root, at the version Capacitor's core pins, because two
 *  subprojects loading AGP into separate classloaders is a Gradle error.
 *
 *  ⚠️ Every subproject's build directory is REDIRECTED into the temp project. At Gradle's default,
 *  `:plugin` builds into the package's own `android/build` and `:capacitor-android` into
 *  node_modules — which the first probe of this design did.
 *
 *  ⚠️ SKIP vs FAIL. A missing prerequisite — no `android/build.gradle`, gradle, Android SDK or
 *  `@capacitor/android` — is a SKIP. After that, a failure is a SKIP ONLY when Gradle's own cause
 *  lines name a network failure (`networkFailureCause`, nativePluginLegs.mjs), because otherwise a
 *  laptop on a train reads as a broken plugin; every other failure is a FAIL. The dependency graph
 *  is resolved as its own step first, so the output of a resolution failure is not mixed with
 *  compiler output. A mistyped coordinate FAILs while the network is up ("Could not find"); offline,
 *  it cannot be told apart and SKIPs, which `--require-all` turns back into a failure. */
const capacitorCore = path.join(repoRoot, 'node_modules', '@capacitor', 'android', 'capacitor');
const androidHome = toolchain.androidHome ?? null;

/** A Groovy SINGLE-quoted string literal for a path. Forward slashes, because `\` is an escape in a
 *  Groovy string and java.io.File accepts `/` on Windows; single quotes, because a double-quoted
 *  Groovy string interpolates `$`. */
const groovyPath = (p) => `'${p.split(path.sep).join('/').replace(/\\/g, '/').replace(/'/g, "\\'")}'`;

/** Remove a temp dir without letting a failure escape. ⚠️ On Windows a Gradle or Kotlin daemon can
 *  still hold a handle under `build/`, `.gradle` or `.kotlin` when the leg ends, and `force` only
 *  swallows ENOENT — an EBUSY here would abort the loop before the summary prints (#992 review;
 *  unobserved, since it cannot be driven from a Mac). A leaked temp dir is the cheaper failure. */
function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.warn(`[test:native] could not remove ${dir} (${e.code ?? e.message}) — leaving it`);
  }
}

/** Run gradle CAPTURING its output — the SKIP/FAIL classification reads it — while still showing it. */
function gradleCapture(args) {
  const sp = spawnable ? spawnable(gradle.cmd, args) : { command: gradle.cmd, args, shell: false };
  console.log(`\n── ${gradle.cmd} ${args.join(' ')}\n`);
  const r = spawnSync(sp.command, sp.args, {
    cwd: repoRoot, encoding: 'utf8', shell: sp.shell, env: javaEnv, maxBuffer: 256 * 1024 * 1024,
  });
  // Joined on a line boundary, not glued — see joinCapturedStreams in nativePluginLegs.mjs for
  // why the `^`-anchored patterns depend on it (#1079 close-out review).
  const out = joinCapturedStreams(r.stdout, r.stderr);
  process.stdout.write(out);
  if (r.error) console.error(`[test:native] ${r.error.message}`);
  return { code: r.error ? 1 : r.status ?? 1, out };
}

let classBuildCache = null;
try {
  for (const leg of PLUGIN_CLASS_LEGS) {
    const name = `android/class/${legLabel(leg.dir)}`;
    const androidDir = path.join(repoRoot, leg.dir, 'android');
    // A fact about the PACKAGE first, as the iOS loop decides N/A before the toolchain gates.
    // `nativePluginLegCoverage.test.ts` asserts every row HAS one, so this is a stale-row message.
    if (!fs.existsSync(path.join(androidDir, 'build.gradle'))) { skip(name, `no android/build.gradle in ${leg.dir}`); continue; }
    if (!gradle) { skip(name, 'no gradle: no project wrapper in the repo, none on PATH, MODOKI_GRADLE unset'); continue; }
    if (!androidHome) { skip(name, 'no Android SDK: the Modoki toolchain has not provisioned one (engine/toolchain detect("android-sdk"))'); continue; }
    if (!fs.existsSync(path.join(capacitorCore, 'build.gradle'))) { skip(name, 'no @capacitor/android in the root node_modules: run npm install'); continue; }
    // AGP at the version Capacitor's core itself pins — read, not written here a second time.
    const agp = /com\.android\.tools\.build:gradle:([\w.-]+)/.exec(fs.readFileSync(path.join(capacitorCore, 'build.gradle'), 'utf8'))?.[1];
    if (!agp) {
      results.push({ name, status: 'FAIL', reason: "could not read the AGP version from @capacitor/android's build.gradle: the synthesiser needs updating" });
      continue;
    }

    classBuildCache ??= fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-plugin-class-cache-'));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-plugin-class-android-'));
    try {
      fs.writeFileSync(path.join(proj, 'settings.gradle'), [
        '// GENERATED by engine/scripts/test-native.mjs (#992): one plugin class against the real Capacitor core.',
        "rootProject.name = 'modoki-plugin-class'",
        "include ':capacitor-android'",
        `project(':capacitor-android').projectDir = new File(${groovyPath(capacitorCore)})`,
        "include ':plugin'",
        `project(':plugin').projectDir = new File(${groovyPath(androidDir)})`,
        // One cache for the whole run, so a later leg can reuse Capacitor core's compile outputs.
        `buildCache { local { directory = new File(${groovyPath(classBuildCache)}) } }`,
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(proj, 'build.gradle'), [
        'buildscript {',
        '  repositories { google(); mavenCentral() }',
        `  dependencies { classpath 'com.android.tools.build:gradle:${agp}' }`,
        '}',
        'allprojects { repositories { google(); mavenCentral() } }',
        'subprojects { sp ->',
        "  sp.layout.buildDirectory.set(new File(rootDir, 'build/' + sp.name))",
        // The dependency GRAPH only. ⚠️ Not `configuration.resolve()`: that selects ARTIFACT variants
        // without the `artifactType` AGP's own tasks ask for, and fails on Capacitor core's
        // android-classes-jar / android-lint ambiguity for every plugin (measured on the first run).
        "  sp.tasks.register('modokiResolveCompileClasspath') {",
        '    doLast {',
        "      def result = sp.configurations.getByName('releaseCompileClasspath').incoming.resolutionResult",
        '      def unresolved = result.allDependencies.findAll { it instanceof org.gradle.api.artifacts.result.UnresolvedDependencyResult }',
        '      if (!unresolved.isEmpty()) {',
        "        throw new GradleException('MODOKI-UNRESOLVED ' + unresolved.collect { d ->",
        '          def msgs = []; def t = d.failure; while (t != null) { msgs << t.message; t = t.cause }',
        "          d.requested.displayName + ': ' + msgs.join(' <- ')",
        "        }.join(' | '))",
        '      }',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'));
      // A .properties value: `\` and `:` must be escaped, or a Windows `C:\…` path is misread.
      fs.writeFileSync(path.join(proj, 'local.properties'), `sdk.dir=${androidHome.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`);
      fs.writeFileSync(path.join(proj, 'gradle.properties'), 'android.useAndroidX=true\norg.gradle.jvmargs=-Xmx2g\n');

      const common = ['-p', proj, '--console=plain', '--build-cache'];
      /** SKIP only when the output names a NETWORK failure; any other non-zero exit is a FAIL. Applied
       *  to both steps: the resolve step walks the graph (metadata), so an artifact that is cached as
       *  metadata but not as a file can still fail to download during the compile. */
      const classify = (step, { code, out }) => {
        if (code === 0) return true;
        const cause = networkFailureCause(out);
        if (cause) skip(name, `${step}: the network could not supply an artifact (offline, or not cached): ${cause}`);
        else results.push({ name, status: 'FAIL', reason: `${step} failed, and not on the network: see the output above` });
        return false;
      };
      if (!classify('resolving the compile classpath', gradleCapture([...common, ':plugin:modokiResolveCompileClasspath']))) continue;
      // The javac task for a Kotlin module too: KGP wires it to run after compileReleaseKotlin.
      if (classify('compiling', gradleCapture([...common, ':plugin:compileReleaseJavaWithJavac']))) record(name, 0);
    } finally {
      removeTempDir(proj);
    }
  }
} finally {
  if (classBuildCache) removeTempDir(classBuildCache);
}

// ── Android: the OTA self-test (javac + java, no gradle at all) ─────────────────────────
/** `javac` + `java` legs: a self-test `main()` that exits non-zero, compiled from a list of
 *  SHIPPING sources plus its test-only helpers. A row rather than a bespoke block, for the same
 *  reason SWIFT_LEGS is a table.
 *
 *  ⚠️ Both cores are dependency-free — no `android.*`, no vendor SDK — and that is LOAD-BEARING,
 *  not tidiness: it is the only reason these can be bare javac/java runs instead of gradle
 *  harnesses. Add one Android import to either core and its leg stops being runnable at all.
 *
 *  Each leg compiles the SHIPPING core (OtaCore.java / IapCore.java), so a green run is a claim
 *  about the code that ships — unlike `android/lease-parity`, which tests a port. The one part of
 *  IapCore's contract this cannot reach is its `RESPONSE_USER_CANCELED` matching Play's own
 *  constant, which needs the billing library. ⚠️ NOTHING checks it — a static comparison was
 *  written and removed because javac folds it away (see IapCore's header). A hand-edit of the
 *  value IS caught here; an upstream renumbering is caught nowhere.
 */
const JAVA_LEGS = [
  {
    name: 'android/ota-core',
    dir: otaDir,
    mainClass: 'com.modokiengine.capacitor.ota.OtaCoreSelfTest',
    sources: [
      'android/src/main/java/com/modokiengine/capacitor/ota/OtaCore.java',
      'android/src/test/java/com/modokiengine/capacitor/ota/MinimalJson.java',
      'android/src/test/java/com/modokiengine/capacitor/ota/OtaCoreSelfTest.java',
    ],
  },
  {
    name: 'android/iap-core',
    dir: iapDir,
    mainClass: 'com.modokiengine.capacitor.iap.IapCoreSelfTest',
    sources: [
      'android/src/main/java/com/modokiengine/capacitor/iap/IapCore.java',
      'android/src/test/java/com/modokiengine/capacitor/iap/MinimalJson.java',
      'android/src/test/java/com/modokiengine/capacitor/iap/IapCoreSelfTest.java',
    ],
  },
];

for (const leg of JAVA_LEGS) {
  const sources = leg.sources.map((rel) => path.join(leg.dir, rel));
  const missing = sources.filter((f) => !fs.existsSync(f));
  if (!has(javaBin('javac')) && !has('javac')) {
    skip(leg.name, 'no javac — no provisioned JDK and none on PATH');
  } else if (missing.length) {
    skip(leg.name, `missing source(s): ${missing.map((f) => path.relative(repoRoot, f)).join(', ')}`);
  } else {
    // A fresh classes dir per run: a leftover .class from an older source would let this pass
    // against code that no longer exists.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-java-selftest-'));
    try {
      const cc = spawnable ? spawnable(javaBin('javac'), ['-d', outDir, ...sources]) : { command: javaBin('javac'), args: ['-d', outDir, ...sources], shell: false };
      const c = spawnSync(cc.command, cc.args, { cwd: leg.dir, stdio: 'inherit', shell: cc.shell, env: javaEnv });
      if (c.error || c.status !== 0) { record(leg.name, 1); }
      // The self-tests resolve their vectors from the PACKAGE ROOT, so cwd matters.
      else run(leg.name, javaBin('java'), ['-cp', outDir, leg.mainClass], { cwd: leg.dir, env: javaEnv });
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────────────────
console.log('\n──────── native gate ────────');
for (const r of results) {
  console.log(`  ${r.status.padEnd(4)}  ${r.name}${r.reason ? `  — ${r.reason}` : ''}`);
}
const failed = results.filter((r) => r.status === 'FAIL');
const skipped = results.filter((r) => r.status === 'SKIP');
const known = results.filter((r) => r.status === 'KNOWN-FAIL');
const notApplicable = results.filter((r) => r.status === 'N/A');
if (notApplicable.length) {
  console.log(`\n${notApplicable.length} leg(s) are N/A — there is nothing to build, on any machine: ${notApplicable.map((r) => r.name).join(', ')}.`);
  console.log('Off the exit code even under --require-all, because no toolchain can satisfy them. Each one\'s premise is asserted by capacitorPlatformDeclarations.test.ts under `npm run verify`, so a row that goes stale fails THERE.');
}
if (skipped.length && !requireAll) {
  console.log(`\n${skipped.length} leg(s) SKIPPED — this run did NOT check them. Re-run with --require-all to treat that as a failure.`);
}
if (known.length) {
  console.log(`\n${known.length} leg(s) are KNOWN failures and did NOT fail this run: ${known.map((r) => `${r.name} (${r.reason})`).join(', ')}.`);
  console.log('They are off the exit code ON PURPOSE, so a FAIL here means a change broke something. --require-all counts them as failures.');
}
process.exit(failed.length || (requireAll && (skipped.length || known.length)) ? 1 : 0);
