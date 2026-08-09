#!/usr/bin/env node
/**
 * Add native targets to one or more projects from the terminal.
 *
 *     node engine/scripts/add-native-targets.mjs demos/forest-camp games/skin-test
 *     node engine/scripts/add-native-targets.mjs --platform android games/text_demo
 *     node engine/scripts/add-native-targets.mjs --all-missing --dry-run
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────
 * The scaffolder was reachable only through the editor's `/api/add-native-target` and
 * `/api/build` SSE routes, and both act on the project the editor has OPEN. Bringing N
 * projects onto mobile therefore meant opening N projects by hand, and a terminal (or a
 * future CI job) had no way in at all.
 *
 * ── IT DELEGATES, IT DOES NOT RE-IMPLEMENT ───────────────────────────────────────────────
 * `scaffoldNativeTarget` lives in `engine/plugins/addNativeTarget.ts` and is imported here,
 * bundled with esbuild — the same pattern, for the same reason, as
 * `print-toolchain-env.mjs` (#159): a script that re-ran the five steps itself would be a
 * second implementation of a sequence that must not diverge from the one that ships. If this
 * file ever grows its own `cap add` call, that divergence has happened.
 *
 * ⚠️ NOT idempotent-by-omission: a project that already has the platform folder is SKIPPED
 * rather than re-scaffolded, because `cap add` on an existing target overwrites hand-healed
 * native config. Use `--force` only when you mean to regenerate.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const DRY = flag('--dry-run');
const FORCE = flag('--force');
const ALL = flag('--all-missing');
// ⚠️ Guard the -1: `indexOf` returns -1 when the flag is absent, and `argv[-1 + 1]` is argv[0]
// — the FIRST POSITIONAL. An earlier version computed this unconditionally, so
// `add-native-targets.mjs games/text_demo games/timeline-demo` silently scaffolded only the
// second one: text_demo was mistaken for the --platform value and filtered out of `specs`.
// Silently doing less than asked is worse than failing.
const platIdx = argv.indexOf('--platform');
const platArg = platIdx >= 0 ? argv[platIdx + 1] : undefined;
const PLATFORMS = platIdx >= 0 ? [platArg] : ['android', 'ios'];
for (const p of PLATFORMS) {
  if (p !== 'ios' && p !== 'android') { console.error(`unknown platform: ${p}`); process.exit(2); }
}

/** Engine test fixtures, not shipped games — excluded from `--all-missing` so a sweep does not
 *  generate native projects nobody will ever run. Name them explicitly to add one anyway. */
const FIXTURES = new Set(['anim-bug', 'ota-test', 'ota-subgame-test', 'video-test']);

function discoverMissing() {
  const out = [];
  for (const root of ['games', 'demos']) {
    const dir = path.join(repoRoot, root);
    if (!fs.existsSync(dir)) continue;
    for (const id of fs.readdirSync(dir).sort()) {
      if (FIXTURES.has(id)) continue;
      const proj = path.join(dir, id);
      if (!fs.existsSync(path.join(proj, 'project.config.json'))) continue;
      if (PLATFORMS.some((p) => !fs.existsSync(path.join(proj, p)))) out.push(`${root}/${id}`);
    }
  }
  return out;
}

const specs = ALL ? discoverMissing() : argv.filter((a) => !a.startsWith('--') && a !== platArg);
if (!specs.length) {
  console.error('usage: add-native-targets.mjs [--platform ios|android] [--dry-run] [--force] <project…> | --all-missing');
  process.exit(2);
}

/** Bundle the plugin modules and import them — TypeScript with extensionless specifiers, which
 *  Node's ESM resolver rejects outright. Same approach as print-toolchain-env.mjs.
 *
 *  `loadProjectConfig` is bundled alongside the scaffolder for a reason worth keeping: it MERGES
 *  a project's file with `DEFAULT_PROJECT_CONFIG`, and the scaffolder reads fields (`capacitor.webDir`
 *  and friends) that most projects never spell out. The first version of this script did
 *  `JSON.parse(project.config.json)` instead and every scaffold died on
 *  `Cannot read properties of undefined (reading 'webDir')` — a raw config is not a ProjectConfig,
 *  it is the SPARSE OVERRIDE of one. */
async function loadPluginModules() {
  const stamp = `${process.pid}-${specs.length}`;
  const load = async (rel, name) => {
    const outfile = path.join(os.tmpdir(), `modoki-${name}-${stamp}.mjs`);
    await build({
      entryPoints: [path.join(repoRoot, ...rel)],
      outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20',
      packages: 'external', logLevel: 'silent',
    });
    try { return await import(pathToFileURL(outfile).href); }
    finally { try { fs.unlinkSync(outfile); } catch { /* best effort */ } }
  };
  return {
    ...(await load(['engine', 'plugins', 'addNativeTarget.ts'], 'add-native')),
    ...(await load(['engine', 'plugins', 'load-project-config.ts'], 'load-cfg')),
  };
}

/** The CLI's spawn wrapper — the transport-specific half `scaffoldNativeTarget` asks for.
 *  Inherits stdio so a 4-minute `npm install` shows progress instead of looking hung.
 *
 *  ⚠️ `MODOKI_PROJECT` is NOT optional. Step 3 runs the web build from the REPO root, and since
 *  the per-game teardown (#29) a repo-root build with no `MODOKI_PROJECT` fails fast by design
 *  ("the repo root is not a buildable game"). The editor's own wrapper sets it via
 *  `buildStepEnv({ MODOKI_PROJECT: projectRoot })`; omitting it here failed all 18 scaffolds. */
const makeRunShell = (projectRoot) => (label, cmd, cwd) => new Promise((resolve) => {
  console.log(`\n── ${label} ──  (${cwd})`);
  const proc = spawn(cmd, {
    cwd, shell: true, stdio: 'inherit',
    env: { ...process.env, MODOKI_PROJECT: projectRoot },
  });
  proc.on('close', (code) => resolve(code === 0));
  proc.on('error', (e) => { console.error(`ERROR: ${e.message}`); resolve(false); });
});

const { scaffoldNativeTarget, loadProjectConfig } = await loadPluginModules();

const results = [];
for (const spec of specs) {
  const projectRoot = path.join(repoRoot, spec);
  const cfgPath = path.join(projectRoot, 'project.config.json');
  if (!fs.existsSync(cfgPath)) { results.push([spec, '-', 'SKIP: no project.config.json']); continue; }
  // The MERGED config, not the raw file — see loadPluginModules().
  const cfg = loadProjectConfig(projectRoot);
  for (const platform of PLATFORMS) {
    if (fs.existsSync(path.join(projectRoot, platform)) && !FORCE) {
      results.push([spec, platform, 'skip: already present']);
      continue;
    }
    if (DRY) { results.push([spec, platform, 'WOULD SCAFFOLD']); continue; }
    console.log(`\n═══ ${spec} → ${platform}  (appId ${cfg.app?.appId ?? '(none)'}) ═══`);
    try {
      const { warnings } = await scaffoldNativeTarget({
        projectRoot, platform, buildCwd: repoRoot, cfg,
        send: (m) => console.log(m), runShell: makeRunShell(projectRoot),
      });
      for (const w of warnings) console.log(`⚠️  ${w}`);
      results.push([spec, platform, warnings.length ? `ok (${warnings.length} warning(s))` : 'ok']);
    } catch (e) {
      results.push([spec, platform, `FAILED: ${e instanceof Error ? e.message : String(e)}`]);
    }
  }
}

console.log('\n═══ summary ═══');
for (const [spec, platform, status] of results) {
  console.log(`  ${spec.padEnd(26)} ${String(platform).padEnd(8)} ${status}`);
}
if (results.some(([, , s]) => s.startsWith('FAILED'))) process.exitCode = 1;
