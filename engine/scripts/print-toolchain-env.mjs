#!/usr/bin/env node
/**
 * Print `JAVA_HOME` / `ANDROID_HOME` for a CLI native build, resolved by the SAME code the
 * editor's build path uses (#159).
 *
 *     eval "$(node engine/scripts/print-toolchain-env.mjs)"
 *     games/<id>/android/gradlew -p games/<id>/android assembleDebug
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────
 * The editor provisions a PINNED Temurin JDK 21 + Android SDK under `MODOKI_TOOLCHAIN_DIR` and
 * resolves them provisioned-first (`engine/toolchain/index.ts`). A terminal `./gradlew` inherits
 * none of that, so `docs/build.md` used to tell you to set `JAVA_HOME=$(/usr/libexec/java_home -v 21)`
 * — which on a machine with no SYSTEM JDK 21 registered does not fail. It returns the newest JDK
 * it knows (measured: 25.0.3), and gradle then dies with `Unsupported class file major version 69`,
 * which reads as an AGP bug rather than "your recipe picked the wrong Java". Meanwhile the correct
 * JDK 21 is sitting in the toolchain dir, invisible to `java_home` because it is not a system install.
 *
 * ── IT MUST DELEGATE, NEVER RE-DETECT ────────────────────────────────────────────────────
 * The one rule for this file. `engine/toolchain/index.ts` is documented as "the SINGLE candidate
 * list — it replaces the two previously divergent Android-SDK probes"; a third probe here would
 * undo that consolidation, and would do it in the file whose job is to prevent exactly this drift.
 * So the toolchain module is BUNDLED and imported, not reimplemented — that is why esbuild appears
 * in a script this small. (Direct `import()` is not an option: the module uses extensionless
 * specifiers that Node's ESM resolver rejects.)
 *
 * ── THE ONE THING IT SETS ITSELF ─────────────────────────────────────────────────────────
 * `MODOKI_TOOLCHAIN_DIR`, when unset — mirroring `engine/electron/main.ts`, which does
 * `process.env.MODOKI_TOOLCHAIN_DIR ??= resolveToolchainDir(app.getPath('appData'))` in dev AND
 * packaged alike. Without it `detect()` skips its bundled candidates entirely and falls straight
 * through to the machine's SDKs, i.e. reproduces the bug this script exists to fix.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Electron's `app.getPath('appData')` without Electron. Mirrors `appSupportRoot()` in
 *  `clean-packaged-cache.mjs` — same three platforms, same order, deliberately duplicated
 *  rather than shared because both are standalone scripts run without a bundler. */
function appDataRoot() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
}

// `SHARED_DIR` from engine/electron/userDataDir.ts — the toolchain is MACHINE-level, shared by
// every clone, which is why it is not under a per-clone profile dir.
process.env.MODOKI_TOOLCHAIN_DIR ??= path.join(appDataRoot(), 'Modoki', 'toolchain');

/** Bundle `engine/toolchain/index.ts` to a temp ESM file and import it. */
async function loadToolchain() {
  const outfile = path.join(os.tmpdir(), `modoki-toolchain-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, 'engine', 'toolchain', 'index.ts')],
    outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20',
    // Node built-ins only — the toolchain module has no third-party deps, and marking them
    // external keeps a stray one a loud failure rather than a silently inlined copy.
    packages: 'external', logLevel: 'silent',
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    try { fs.unlinkSync(outfile); } catch { /* best effort */ }
  }
}

const shellQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');

const { detect } = await loadToolchain();

const java = detect('java');
const sdk = detect('android-sdk');

if (asJson) {
  console.log(JSON.stringify({
    toolchainDir: process.env.MODOKI_TOOLCHAIN_DIR,
    javaHome: java.path ?? null,
    androidHome: sdk.path ?? null,
  }, null, 2));
} else {
  // Emitted on STDOUT so the whole output is `eval`-able; anything diagnostic goes to STDERR,
  // or a warning would be evaluated as a command.
  if (java.path) console.log(`export JAVA_HOME=${shellQuote(java.path)}`);
  if (sdk.path) console.log(`export ANDROID_HOME=${shellQuote(sdk.path)}`);
}

const missing = [!java.path && 'JDK 21 (java)', !sdk.path && 'Android SDK'].filter(Boolean);
if (missing.length) {
  console.error(
    `[toolchain] NOT FOUND: ${missing.join(', ')}.\n`
    + `  Looked under MODOKI_TOOLCHAIN_DIR=${process.env.MODOKI_TOOLCHAIN_DIR} first, then the machine.\n`
    + `  Install from the editor: Build → Build Support…  (this is the same resolution the editor build uses)\n`
    + `  NOTE a system JDK 25 does not count: detect('java') is version-strict because Gradle/AGP cannot read newer bytecode.`,
  );
  process.exit(1);
}
