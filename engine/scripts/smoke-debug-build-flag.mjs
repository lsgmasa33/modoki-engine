/** Bundle-content A/B for `build.debugBuild` (#112 Phase 3) — the half a static guard can't reach.
 *
 *  `engine/tests/architecture/debugBuildGates.test.ts` proves the flag governs every NATIVE
 *  surface. It cannot prove the same of the JS bundle, because that needs a real vite build. This
 *  script does: it builds ONE project twice — flag off, then flag on — and asserts the debug
 *  markers vanish from `dist/` in the off build and are present in the on build.
 *
 *  The flag-ON leg is not decoration, it is the CONTROL. Without it a green run means only "the
 *  grep found nothing", which is also what a typo'd marker, a renamed chunk, or a build that
 *  silently produced nothing looks like. Every marker must be demonstrably findable before its
 *  absence means anything.
 *
 *  Why this matters more than it sounds: the JS bridge carries `handleEval` — arbitrary JS
 *  execution on the device. And this exact invariant HAS drifted before; `engine/app/main.tsx:42`
 *  records it: "Previously this was ungated on native, so a RELEASE build shipped the eval-capable
 *  server."
 *
 *  Usage:  node engine/scripts/smoke-debug-build-flag.mjs [games/<id>]   (default: games/sling)
 *          npm run smoke:debug-flag
 *  Exits non-zero on any failed check. ~2 builds, so it is NOT in `npm run verify` — run it after
 *  touching the gating in engine/app/main.tsx, engine/app/App.tsx, or vite.config.ts's define.
 *
 *  It restores the project's original `project.config.json` on every exit path, including a crash
 *  or Ctrl-C — leaving a repo file flipped would be a far worse outcome than a failed check.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const project = process.argv[2] || 'games/sling';
const projectDir = path.join(REPO_ROOT, project);
const configPath = path.join(projectDir, 'project.config.json');
const distDir = path.join(projectDir, 'dist');

/** Substrings that must appear in the built JS iff the flag is on. Deliberately drawn from the
 *  bridge's own wire protocol + module identity rather than from a variable name a minifier could
 *  rename — a marker that mangles is a marker that reports a false clean. */
const MARKERS = [
  'app-identity',   // a debug-bridge protocol message type
  'GameDebug',      // the Capacitor plugin name the bridge calls through
];

if (!fs.existsSync(configPath)) {
  console.error(`[smoke-debug-flag] no project.config.json at ${configPath}`);
  process.exit(1);
}

const original = fs.readFileSync(configPath, 'utf8');
let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  fs.writeFileSync(configPath, original);
};
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restore(); process.exit(130); });

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

/** Build `project` with `build.debugBuild = flag` and return every marker's hit count in dist/. */
function buildAndCount(flag) {
  const cfg = JSON.parse(original);
  cfg.build = { ...(cfg.build ?? {}), debugBuild: flag };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');

  fs.rmSync(distDir, { recursive: true, force: true });
  console.log(`[smoke-debug-flag] building ${project} with debugBuild=${flag}…`);
  execFileSync('node', ['engine/scripts/build-web.mjs', '--target', 'web'], {
    cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, MODOKI_PROJECT: project },
  });

  const counts = Object.fromEntries(MARKERS.map((m) => [m, 0]));
  let bytes = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|html)$/.test(e.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      bytes += text.length;
      for (const m of MARKERS) counts[m] += text.split(m).length - 1;
    }
  };
  if (!fs.existsSync(distDir)) { console.error(`[smoke-debug-flag] no dist/ after the build`); process.exit(1); }
  walk(distDir);
  // A build that emitted nothing scannable would make every "0 hits" meaningless.
  if (bytes === 0) { console.error('[smoke-debug-flag] scanned 0 bytes of JS/HTML — the build produced nothing'); process.exit(1); }
  console.log(`[smoke-debug-flag] debugBuild=${flag}: scanned ${(bytes / 1e6).toFixed(1)}MB — ${JSON.stringify(counts)}`);
  return counts;
}

const off = buildAndCount(false);
const on = buildAndCount(true);
restore();

for (const m of MARKERS) {
  // The control FIRST: if the marker never appears even with the flag on, its absence in the
  // off build proves nothing about the gate — it proves the marker is wrong.
  ok(`control: "${m}" is present with debugBuild ON`, on[m] > 0,
    on[m] > 0 ? `${on[m]} hits` : 'never found — this marker cannot detect a leak, fix the marker');
  ok(`"${m}" is stripped with debugBuild OFF`, off[m] === 0,
    off[m] === 0 ? '0 hits' : `${off[m]} hits LEAKED into a release bundle`);
}

console.log(failures ? `\n[smoke-debug-flag] ${failures} check(s) FAILED` : '\n[smoke-debug-flag] all checks passed');
process.exit(failures ? 1 : 0);
