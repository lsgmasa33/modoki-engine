/** Render a recorded TAKE to video — the gameplay recorder's offline half (#1479).
 *
 *  Usage:
 *    npm run record -- <take.json> [--out <dir>] [--fps 30] [--scale 2] [--prores]
 *                      [--keep-frames] [--project games/<id>] [--url http://localhost:<port>]
 *
 *  The take (recorded in the editor's GameView, format in `editor/recorder/take.ts`) is replayed in
 *  a headless Chromium on the game route, at a FIXED dt: the page's frame loop is held, and every
 *  video frame is one `__modokiCapture.step()` followed by one compositor screenshot. So:
 *    - the output size is the take's layout size × `--scale`, whatever screen this runs on;
 *    - no frame is ever dropped — a slow screenshot only makes the render slower;
 *    - the same take renders the same frames again, so an art change is a re-render, not a re-shoot.
 *
 *  ⚠️ **Why a compositor screenshot and not an in-page readback.** The 3D canvas is WebGPU and
 *  premultiplied, so every in-page read of it returns transparent black; and the 2D layer is not
 *  one canvas but a pooled canvas per `Canvas2D` entity, mounted INSIDE the DOM UI tree. Only the
 *  browser's compositor flattens 3D + 2D + UI into one frame (docs/plans/ad-video-pipeline-plan.md).
 *
 *  Without `--url` it starts its own Vite dev server for the project on a free port and stops it at
 *  the end, so it never touches an editor that is running. */

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { loadRequiredEngineModules } from './loadVendorPlugins.mjs';
import { defaultToolchainDir } from './toolchainHome.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAG = '[record-take]';

// ── args ────────────────────────────────────────────────────────────────────────────────────────
const USAGE = 'usage: npm run record -- <take.json> [--out <dir>] [--fps 30] [--scale 2] [--prores] '
  + '[--keep-frames] [--project games/<id>] [--url http://localhost:<port>]';
const argv = process.argv.slice(2);
const opts = { fps: 30, scale: 2, prores: false, keepFrames: false, out: null, project: null, url: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => { const v = argv[++i]; if (v === undefined) fail(`${a} needs a value`); return v; };
  if (a === '--fps') opts.fps = Number(val());
  else if (a === '--scale') opts.scale = Number(val());
  else if (a === '--out') opts.out = val();
  else if (a === '--project') opts.project = val();
  else if (a === '--url') opts.url = val().replace(/\/+$/, '');
  else if (a === '--prores') opts.prores = true;
  else if (a === '--keep-frames') opts.keepFrames = true;
  else if (a.startsWith('--')) fail(`unknown option ${a}`);
  else positional.push(a);
}
if (positional.length !== 1) fail(USAGE);
// ⚠️ 30 is a FLOOR, not a default: `timeSystem` clamps every frame's delta to 1/30 s (so a GC pause
// cannot teleport the sim), and a step longer than that would advance the sim by less than a video
// frame — 24 fps would play the game at 0.8x and never reach the last fifth of the take.
if (!(opts.fps >= 30 && opts.fps <= 120)) fail(`--fps must be in [30, 120] (got ${opts.fps}) — the engine clamps a frame to 1/30 s`);
if (!(opts.scale > 0 && opts.scale <= 4)) fail(`--scale must be in (0, 4] (got ${opts.scale})`);

function fail(msg) { console.error(`${TAG} ${msg}`); process.exit(2); }

process.env.MODOKI_TOOLCHAIN_DIR ??= defaultToolchainDir();
const [takeMod, ffmpegMod, prefsKeyMod] = await loadRequiredEngineModules(REPO_ROOT, [
  path.join('packages', 'modoki', 'src', 'editor', 'recorder', 'take.ts'),
  path.join('plugins', 'ffmpeg-tool.ts'),
  path.join('packages', 'modoki', 'src', 'runtime', 'storage', 'prefsKey.ts'),
], 'record-take.mjs');

const takePath = path.resolve(positional[0]);
const take = takeMod.parseTake(JSON.parse(fs.readFileSync(takePath, 'utf8')));
const project = opts.project ?? findProject(take.game);
const outDir = path.resolve(opts.out ?? path.join(path.dirname(takePath), path.basename(takePath).replace(/\.take\.json$|\.json$/, '')));
const framesDir = path.join(outDir, 'frames');
fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });

/** `games/<id>` or `demos/<id>`, whichever has a project.config.json. */
function findProject(gameId) {
  for (const root of ['games', 'demos']) {
    const rel = path.join(root, gameId);
    if (fs.existsSync(path.join(REPO_ROOT, rel, 'project.config.json'))) return rel;
  }
  fail(`no project for game "${gameId}" under games/ or demos/ — pass --project`);
}

// ── dev server ──────────────────────────────────────────────────────────────────────────────────
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/** Start `vite` for the project and resolve with its base URL once it says it is listening. */
async function startDevServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [
    path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config', path.join('engine', 'vite.config.ts'), '--port', String(port), '--strictPort',
  ], { cwd: REPO_ROOT, env: { ...process.env, MODOKI_PROJECT: project }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`dev server did not start in 60s:\n${log.slice(-2000)}`));
    }, 60_000);
    const onData = (d) => {
      log += d;
      if (/ready in/.test(log)) { clearTimeout(timer); resolve(`http://localhost:${port}`); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`dev server exited (${code}):\n${log.slice(-2000)}`)); });
  });
  return { url, stop: () => { if (child.exitCode === null) child.kill('SIGTERM'); } };
}

// ── render ──────────────────────────────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const pageErrors = [];
let report;
let server = null;
let browser = null;
try {
  server = opts.url ? { url: opts.url, stop: () => {} } : await startDevServer();
  // `--enable-gpu`: without it the headless shell renders WebGL on SwiftShader, a CPU rasteriser —
  // correct but several times slower per frame. WebGPU has no adapter in headless Chromium on a Mac
  // either way; the engine falls back to WebGL.
  browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--enable-unsafe-webgpu'] });
  const context = await browser.newContext({
    viewport: take.viewport, deviceScaleFactor: opts.scale,
    timezoneId: take.timezone, locale: take.locale,
  });
  // The take's starting state goes in BEFORE any app script runs, so the game boots into it:
  // the saved data under the game's RUNTIME namespace (the editor keeps its own, `<game>@editor`),
  // and the preset's safe-area insets as the same `--ui-sa-*` variables the editor sets.
  await context.addInitScript(({ prefs, prefix, safeArea }) => {
    for (const [key, raw] of Object.entries(prefs)) localStorage.setItem(prefix + key, raw);
    const css = Object.entries(safeArea).map(([edge, px]) => `--ui-sa-${edge}: ${px}px;`).join(' ');
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = `:root { ${css} }`;
      document.head.appendChild(style);
    });
  }, { prefs: take.prefs, prefix: prefsKeyMod.prefsKeyPrefix(take.game), safeArea: take.safeArea });
  const page = await context.newPage();
  // Games read the wall clock directly (Court's daily puzzle keys off today's local date). Pinned to
  // when the take was played, and advanced by the take clock below, so a take replays into its own day.
  await page.clock.setFixedTime(take.epochMs);
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`);
    else if (m.type() === 'warning' && m.text().startsWith('[GameShell]')) pageErrors.push(`console.warn: ${m.text()}`);
  });

  const dtMs = 1000 / opts.fps;
  const q = new URLSearchParams({ capture: '1', dt: String(dtMs), seed: String(take.seed), scene: take.scene });
  // `#/game/<id>`, not `#/`: the bare route boots whichever game the server lists first, which with
  // `--url` pointed at another project's server is not this take's game.
  await page.goto(`${server.url}/?${q}#/game/${encodeURIComponent(take.game)}`);
  await page.waitForFunction(() => window.__modokiCapture?.state().steps >= 0, null, { timeout: 60_000 });

  // Boot: step until the game is on screen. `bootStep` settles, then steps ONLY if the game is still
  // not on screen — checked after its own await, so a hold that releases mid-settle (GameShell lets go
  // from a raw rAF wait, which keeps firing while the frame loop is held) cannot turn the take's first
  // timed frame into a boot step. The loop stops with the take clock still at 0.
  const bootDeadline = Date.now() + 60_000;
  let state = await page.evaluate(() => window.__modokiCapture.state());
  while (!state.ready) {
    if (Date.now() > bootDeadline) throw new Error(`game did not finish loading: ${JSON.stringify(state)}`);
    state = await page.evaluate(() => window.__modokiCapture.bootStep());
    await page.waitForTimeout(5);
  }
  if (state.takeTime !== 0) throw new Error(`the take clock ran during boot (${state.takeTime}s) — frames would be off by that much`);
  const loaded = state.scene.split('/').pop();
  if (loaded !== take.scene) {
    throw new Error(`the game booted scene "${loaded}", but the take was played in "${take.scene}" `
      + '(an unknown ?scene= falls back to the default) — the replay would not match the take');
  }
  const bootSteps = state.steps;

  // Where the game root sits in THIS page, so a layout point lands on the same thing it did in the
  // editor. A size mismatch means the game laid out differently and the take's points are off.
  const root = await page.evaluate(() => {
    const el = document.querySelector('[data-modoki-ui-root="runtime"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, scale: el.offsetWidth ? r.width / el.offsetWidth : 1, width: el.offsetWidth, height: el.offsetHeight };
  });
  if (!root) throw new Error('no [data-modoki-ui-root="runtime"] on the game page — nothing to aim the take at');
  if (Math.abs(root.width - take.viewport.width) > 1 || Math.abs(root.height - take.viewport.height) > 1) {
    console.warn(`${TAG} ⚠️ the game root laid out at ${root.width}x${root.height}, the take was played at `
      + `${take.viewport.width}x${take.viewport.height} — pointer positions will not line up`);
  }
  const at = (ev) => [root.left + ev.x * root.scale, root.top + ev.y * root.scale];

  const total = takeMod.frameCountFor(take, opts.fps);
  const cursor = new takeMod.TakeCursor(take.events);
  const started = Date.now();
  for (let f = 0; f < total; f++) {
    // Events due by NOW go in before the step that processes them — the live run queued them the
    // same way, one frame ahead of the sample that read them.
    for (const ev of cursor.due(state.takeTime)) {
      await page.mouse.move(...at(ev));
      if (ev.kind === 'down') await page.mouse.down();
      else if (ev.kind === 'up') await page.mouse.up();
    }
    state = await page.evaluate(() => window.__modokiCapture.step(1));
    await page.clock.setFixedTime(take.epochMs + Math.round(state.takeTime * 1000));
    await page.screenshot({ path: path.join(framesDir, `${String(f).padStart(6, '0')}.png`) });
    if (f % 60 === 59) process.stdout.write(`${TAG} ${f + 1}/${total} frames\r`);
  }
  process.stdout.write('\n');

  // Step s drew video frame s - bootSteps; events from boot steps predate the take and are dropped.
  const onVideo = (e) => ({ videoFrame: e.step - bootSteps, seconds: (e.step - bootSteps) / opts.fps, ...e });
  const events = (await page.evaluate(() => window.__modokiCapture.events()))
    .filter((e) => e.step >= bootSteps).map(onVideo);
  // One entry per give-up of the settle gate. From its frame on, frames may lack that content — a
  // give-up during boot (videoFrame 0, `duringBoot`) means the whole video may.
  const unsettled = (await page.evaluate(() => window.__modokiCapture.unsettled()))
    .map((u) => ({ videoFrame: Math.max(0, u.step - bootSteps), duringBoot: u.step < bootSteps, pending: u.pending }));
  const stillGivenUp = await page.evaluate(() => window.__modokiCapture.givenUp());
  report = {
    take: path.relative(outDir, takePath), scene: loaded, frames: total, fps: opts.fps,
    size: { width: Math.round(take.viewport.width * opts.scale), height: Math.round(take.viewport.height * opts.scale) },
    takeSeconds: state.takeTime, renderSeconds: (Date.now() - started) / 1000,
    undispatchedEvents: cursor.remaining,
    settleSeconds: state.settleMs / 1000,
    // Each time the settle gate gave up and drew anyway — every frame from `videoFrame` on may be
    // missing that content — and what it had still given up on when the render ended.
    unsettled,
    stillGivenUp,
    // Phase 2's audio track is built from these: every sound the game played, on the video frame
    // whose step played it.
    audio: events.filter((e) => e.type === '@audio'),
    // Everything else kept from the journal — the game's own events, cues, scene loads — to compare
    // against the editor's journal for the same take.
    gameEvents: events.filter((e) => e.type !== '@audio'),
    pageErrors,
  };
} finally {
  // Each in its own guard, so a browser that fails to close still lets the dev server go.
  try { await browser?.close(); } catch { /* already gone */ }
  server?.stop();
}

// ── encode ──────────────────────────────────────────────────────────────────────────────────────
const video = path.join(outDir, `${path.basename(outDir)}.${opts.prores ? 'mov' : 'mp4'}`);
const codec = opts.prores
  ? ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le']
  : ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
execFileSync(ffmpegMod.ensureFfmpeg(), [
  '-y', '-loglevel', 'error', '-framerate', String(opts.fps),
  '-i', path.join(framesDir, '%06d.png'), ...codec, video,
], { stdio: 'inherit' });
if (!opts.keepFrames) fs.rmSync(framesDir, { recursive: true, force: true });
// The take is NOT copied in: it embeds the save it was played from (progress, purchases, a signed-in
// account), and this folder holds deliverables that get shared. `render.json` names it by path.
fs.writeFileSync(path.join(outDir, 'render.json'), JSON.stringify(report, null, 2));

console.log(`${TAG} ${report.frames} frames at ${report.fps} fps, ${report.size.width}x${report.size.height} → ${video}`);
if (report.undispatchedEvents) console.warn(`${TAG} ⚠️ ${report.undispatchedEvents} input event(s) fell after the last frame`);
for (const u of report.unsettled) {
  console.warn(`${TAG} ⚠️ gave up waiting ${u.duringBoot ? 'during boot' : `at frame ${u.videoFrame}`} for ${u.pending.join(', ')}`
    + ' — frames from there on may be missing it (render.json: unsettled)');
}
if (pageErrors.length) console.warn(`${TAG} ⚠️ ${pageErrors.length} page error(s) — see render.json`);
