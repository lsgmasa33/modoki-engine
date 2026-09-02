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
 *   - The lease legs test PORTS of the spec that live inside the test files, while
 *     GameDebugPlugin keeps its own lease state behind a platform timer. Closing that gap means
 *     extracting a pure LeaseCore into the shipping sources — a behavioural native change needing
 *     device verification, out of scope for #376 and recorded in both test headers.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT_DIRS } from './projectRoots.mjs';
import { loadEnginePluginModule } from './loadVendorPlugins.mjs';
import { buildZip } from './ota/zip.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pluginDir = path.join(repoRoot, 'engine', 'packages', 'capacitor-game-debug');
const requireAll = process.argv.slice(2).includes('--require-all');

/** A leg either RAN (pass/fail) or was SKIPPED for a stated environmental reason. */
const results = [];
const skip = (name, reason) => results.push({ name, status: 'SKIP', reason });
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

/** JAVA_HOME from the SAME resolver the editor and the CLI build use — never a fresh probe, and
 *  never `/usr/libexec/java_home -v 21`, which on this machine returns a JDK 25 path with exit 0
 *  (see print-toolchain-env.mjs). */
function toolchainJavaHome() {
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'engine', 'scripts', 'print-toolchain-env.mjs'), '--json'],
    { cwd: repoRoot, encoding: 'utf8' });
  try { return JSON.parse(r.stdout).javaHome ?? null; } catch { return null; }
}

const javaHome = toolchainJavaHome();
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

// ── Android: the OTA self-test (javac + java, no gradle at all) ─────────────────────────
// OtaCoreSelfTest is a `main()` that exits non-zero on a failed scenario — it needs only java.*
// plus a test-only MinimalJson, and it compiles the SHIPPING OtaCore.java. That is why it is a
// bare javac/java leg rather than a second gradle harness.
{
  const name = 'android/ota-core';
  const sources = [
    'android/src/main/java/com/modokiengine/capacitor/ota/OtaCore.java',
    'android/src/test/java/com/modokiengine/capacitor/ota/MinimalJson.java',
    'android/src/test/java/com/modokiengine/capacitor/ota/OtaCoreSelfTest.java',
  ].map((rel) => path.join(otaDir, rel));
  const missing = sources.filter((f) => !fs.existsSync(f));
  if (!has(javaBin('javac')) && !has('javac')) {
    skip(name, 'no javac — no provisioned JDK and none on PATH');
  } else if (missing.length) {
    skip(name, `missing source(s): ${missing.map((f) => path.relative(repoRoot, f)).join(', ')}`);
  } else {
    // A fresh classes dir per run: a leftover .class from an older source would let this pass
    // against code that no longer exists.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-selftest-'));
    try {
      const cc = spawnable ? spawnable(javaBin('javac'), ['-d', outDir, ...sources]) : { command: javaBin('javac'), args: ['-d', outDir, ...sources], shell: false };
      const c = spawnSync(cc.command, cc.args, { cwd: otaDir, stdio: 'inherit', shell: cc.shell, env: javaEnv });
      if (c.error || c.status !== 0) { record(name, 1); }
      // The self-test resolves its vectors from the PACKAGE ROOT, so cwd matters.
      else run(name, javaBin('java'), ['-cp', outDir, 'com.modokiengine.capacitor.ota.OtaCoreSelfTest'],
        { cwd: otaDir, env: javaEnv });
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
if (skipped.length && !requireAll) {
  console.log(`\n${skipped.length} leg(s) SKIPPED — this run did NOT check them. Re-run with --require-all to treat that as a failure.`);
}
process.exit(failed.length || (requireAll && skipped.length) ? 1 : 0);
