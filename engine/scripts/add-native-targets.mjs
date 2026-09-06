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
 * ⚠️ NOT idempotent-by-omission: a project whose platform folder is already a COMPLETE target
 * is SKIPPED rather than re-scaffolded, because `cap add` on an existing target overwrites
 * hand-healed native config. An INCOMPLETE folder (left by an interrupted earlier scaffold,
 * #581) is NOT skipped — it's removed and re-scaffolded automatically, same as the editor's
 * "Add Native Target" action. Use `--force` only when you mean to regenerate a genuinely
 * complete target.
 *
 * Before scaffolding, each project runs the SAME project-settings validation the editor's
 * `/api/add-native-target` route runs (#589) — a hand-edited `project.config.json` the route
 * would refuse is skipped here too, not scaffolded with a bad `appId`/`appleTeamId`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { acquireBuildClaim } from './buildClaimsStore.mjs';

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
if (ALL && FORCE) {
  console.error(
    '--force cannot be combined with --all-missing: --all-missing discovers projects by which ' +
    'platform is MISSING, and --force would then also regenerate any OTHER, already-complete ' +
    'platform on each discovered project — e.g. a project missing only ios/ would have its ' +
    'complete android/ force-removed too, though nobody asked for that. Pass explicit project ' +
    'paths with --force instead of --all-missing.',
  );
  process.exit(2);
}

/** Engine test fixtures, not shipped games — excluded from `--all-missing` so a sweep does not
 *  generate native projects nobody will ever run. Name them explicitly to add one anyway. */
const FIXTURES = new Set(['anim-bug', 'ota-test', 'ota-subgame-test']);

function discoverMissing() {
  const out = [];
  for (const root of ['games', 'demos']) {
    const dir = path.join(repoRoot, root);
    if (!fs.existsSync(dir)) continue;
    for (const id of fs.readdirSync(dir).sort()) {
      if (FIXTURES.has(id)) continue;
      const proj = path.join(dir, id);
      if (!fs.existsSync(path.join(proj, 'project.config.json'))) continue;
      if (PLATFORMS.some((p) => !isNativeTargetScaffolded(proj, p))) out.push(`${root}/${id}`);
    }
  }
  return out;
}

const {
  scaffoldNativeTarget, loadProjectConfig, isNativeTargetScaffolded,
  loadProjectUserConfig, validateBuildConfig, projectConfigUnionErrors,
} = await loadPluginModules();
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
  const stamp = `${process.pid}`;
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

const results = [];
for (const spec of specs) {
  const projectRoot = path.join(repoRoot, spec);

  // Cross-process build claim (#650), one per project — this script can scaffold several
  // projects in one invocation, and each has its OWN <project>/dist to protect, not one shared
  // between them. Acquired EARLY, before even the config-existence check below: the editor's
  // `/api/add-native-target` takes its slot before any preflight for the same reason (a refused
  // scaffold must do nothing at all), and here that includes `scaffoldNativeTarget`'s own heals,
  // which mutate the project just like build-web.mjs's do. REFUSES AND EXITS this project's
  // loop iteration (not the whole batch — a busy project skips; the others still run) rather
  // than waiting: a scripted scaffold must not hang on an interactive editor.
  //
  // Skipped entirely in `--dry-run`: a dry run makes no mutation at all (it only ever reports
  // what WOULD happen), so there is nothing here for a claim to protect.
  let claim = null;
  if (!DRY) {
    // `acquireBuildClaim` can THROW rather than refuse (e.g. `~/.modoki` is uncreatable, or its
    // lock is genuinely wedged past its deadline). Uncaught here it would crash the whole batch
    // with a raw stack trace instead of the per-project `REFUSED`/`FAILED` reporting every other
    // failure in this loop gets — catch it and treat it the same way a held-elsewhere refusal is
    // treated: skip this project, keep going with the rest of the batch.
    try {
      const claimed = acquireBuildClaim(projectRoot, `native scaffold (CLI): ${PLATFORMS.join('/')}`, { kind: 'cli' });
      if (!claimed.ok) {
        console.error(`\n═══ ${spec} — ${claimed.message} ═══`);
        results.push([spec, '-', 'REFUSED: build claim held elsewhere']);
        continue;
      }
      claim = claimed;
    } catch (e) {
      console.error(`\n═══ ${spec} — ${e instanceof Error ? e.message : String(e)} ═══`);
      results.push([spec, '-', 'REFUSED: could not take the build claim']);
      continue;
    }
  }
  try {
    const cfgPath = path.join(projectRoot, 'project.config.json');
    if (!fs.existsSync(cfgPath)) { results.push([spec, '-', 'SKIP: no project.config.json']); continue; }
    // The MERGED config, not the raw file — see loadPluginModules().
    const cfg = loadProjectConfig(projectRoot);
    // The SAME two-part check the editor's /api/add-native-target route runs (#589) — this script
    // reaches the identical scaffoldNativeTarget with no validation of its own, so a hand-edited
    // project.config.json the route would refuse (a space in appId, an empty required field) sailed
    // straight through the CLI and into capacitor.config.json, then the iOS bundle identifier /
    // Android applicationId. The union-errors pass is SEPARATE from validateBuildConfig because
    // validateBuildConfig sees the already-RESOLVED config, where a bad value has been coerced to
    // its default and is no longer there to complain about (#39). What this guards is artifact
    // IDENTITY (app.appId → bundle id / applicationId, build.appleTeamId → DEVELOPMENT_TEAM), not
    // HTTP hygiene — which is why a CLI needs it exactly as much as a route does. Runs BEFORE the
    // platform loop (and so before the `if (DRY)` branch below) so `--dry-run` reports the same
    // verdict the real run would give — sibling of #582, same class: a guard the route enforces
    // before spawning a CLI that the CLI itself lacked. No `--force` override, by design: bypassing
    // this is an owner call, not a flag.
    const cfgErrors = [...projectConfigUnionErrors(projectRoot), ...validateBuildConfig(cfg, loadProjectUserConfig(projectRoot))];
    if (cfgErrors.length) {
      console.error(`\n═══ ${spec} — INVALID project settings, not scaffolded ═══\n${cfgErrors.map((e) => `  • ${e}`).join('\n')}`);
      results.push([spec, '-', `SKIP: invalid project settings (${cfgErrors.length})`]);
      continue;
    }
    for (const platform of PLATFORMS) {
      const complete = isNativeTargetScaffolded(projectRoot, platform);
      if (complete && !FORCE) {
        results.push([spec, platform, 'skip: already present']);
        continue;
      }
      if (DRY) {
        results.push([spec, platform, complete ? 'WOULD FORCE-REMOVE + RESCAFFOLD' : 'WOULD SCAFFOLD']);
        continue;
      }
      console.log(`\n═══ ${spec} → ${platform}  (appId ${cfg.app?.appId ?? '(none)'}) ═══`);
      try {
        // `force` here just tells scaffoldNativeTarget it's allowed to remove an ALREADY-complete
        // folder (not just an incomplete leftover) — the removal itself, and the Firebase-survivor
        // guard around it, live entirely inside scaffoldNativeTarget now (not duplicated here), so
        // --force goes through the exact same code path as the automatic incomplete-folder repair.
        const { warnings } = await scaffoldNativeTarget({
          projectRoot, platform, buildCwd: repoRoot, cfg,
          send: (m) => console.log(m), runShell: makeRunShell(projectRoot),
          force: FORCE,
        });
        for (const w of warnings) console.log(`⚠️  ${w}`);
        results.push([spec, platform, warnings.length ? `ok (${warnings.length} warning(s))` : 'ok']);
      } catch (e) {
        results.push([spec, platform, `FAILED: ${e instanceof Error ? e.message : String(e)}`]);
      }
    }
  } finally {
    // Released on every path out of the block above, `continue` included (a `continue` inside a
    // `try` still runs its `finally` before moving the outer loop on) — so the SKIP branches
    // release just as reliably as a real scaffold does.
    claim?.release();
  }
}

console.log('\n═══ summary ═══');
for (const [spec, platform, status] of results) {
  console.log(`  ${spec.padEnd(26)} ${String(platform).padEnd(8)} ${status}`);
}
if (results.some(([, , s]) => s.startsWith('FAILED') || s.startsWith('REFUSED'))) process.exitCode = 1;
