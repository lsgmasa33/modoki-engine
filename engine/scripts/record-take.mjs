/** Render a recorded TAKE to video — the gameplay recorder's offline half (#1479).
 *
 *  Usage:
 *    npm run record -- <take.json> [--out <dir>] [--fps 30] [--scale 2] [--prores]
 *                      [--keep-frames] [--project games/<id>] [--url http://localhost:<port>]
 *                      [--ndjson] [--watch-stdin]
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
 *  Output goes in a folder named after the take, inside `--out` (default: the take's own folder), so
 *  two takes never share one — a folder chosen once and reused would otherwise have every render
 *  overwrite the last (review of #1488). The video is encoded under a temporary name and renamed
 *  into place only when the encode succeeds, so a failed or cancelled re-render leaves the previous
 *  video of the same take intact.
 *
 *  Without `--url` it starts its own Vite dev server for the project on a free port and stops it at
 *  the end, so it never touches an editor that is running.
 *
 *  **Driven by the editor (#1488).** The editor's render job runs this with `--ndjson`: stdout then
 *  carries one JSON object per line (`start`, `server`, `boot`, `frames`, `encode`, then `done`,
 *  `error` or `cancelled`) and the human text moves to stderr. `--watch-stdin` treats stdin closing
 *  as a cancel, so a backend that dies takes its render with it.
 *
 *  **Cancel is SIGTERM (or SIGINT), and this script tears down what it started.** A process-group
 *  kill from the parent is not enough: Playwright launches Chromium DETACHED, in a group of its own,
 *  so it survives a kill aimed at ours. On a cancel the script closes the browser, stops its Vite,
 *  kills a running encode, and deletes its partial output (the whole output folder when this run
 *  created it; otherwise `frames/` and the video it had started writing). The take is never touched. */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { loadRequiredEngineModules } from './loadVendorPlugins.mjs';
import { defaultToolchainDir } from './toolchainHome.mjs';
import { bootWithReloadRetry, failedAttemptReloaded, pageReloaded } from './recordTakeBoot.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAG = '[record-take]';

// ── args ────────────────────────────────────────────────────────────────────────────────────────
const USAGE = 'usage: npm run record -- <take.json> [--out <dir>] [--fps 30] [--scale 2] [--prores] '
  + '[--keep-frames] [--project games/<id>] [--url http://localhost:<port>] [--ndjson] [--watch-stdin]';
const argv = process.argv.slice(2);
const opts = { fps: 30, scale: 2, prores: false, keepFrames: false, out: null, project: null, url: null, ndjson: false, watchStdin: false };
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
  else if (a === '--ndjson') opts.ndjson = true;
  else if (a === '--watch-stdin') opts.watchStdin = true;
  else if (a.startsWith('--')) fail(`unknown option ${a}`);
  else positional.push(a);
}
if (positional.length !== 1) fail(USAGE);

/** Refuse before the render starts. Callers rely on it not returning, so the exit is synchronous —
 *  and so is the one progress line, written straight to fd 1 (nothing else is queued yet). */
function fail(msg) {
  if (opts.ndjson) fs.writeSync(1, `${JSON.stringify({ stage: 'error', message: msg })}\n`);
  console.error(`${TAG} ${msg}`);
  process.exit(2);
}

/** Exit once everything written to stdout has left the process. A pipe's writes are ASYNC on
 *  macOS, so a bare `process.exit` right after the last progress line can drop it — and that line
 *  (`done`, `error`, `cancelled`) is the one the editor's job acts on. The empty write's callback
 *  runs after every earlier write has flushed, because writes complete in order. */
function exitAfterFlush(code) {
  if (outputGone) process.exit(code);
  process.stdout.write('', () => process.exit(code));
}

/** One machine-readable progress line on stdout — only with `--ndjson` (the editor's render job). */
function emit(line) { if (opts.ndjson && !outputGone) process.stdout.write(`${JSON.stringify(line)}\n`); }
/** Human output. With `--ndjson` it goes to stderr, so stdout stays one JSON object per line. */
function say(msg) { if (!outputGone) (opts.ndjson ? process.stderr : process.stdout).write(`${msg}\n`); }

/** Set once stdout or stderr can no longer be written: the reader is gone. */
let outputGone = false;
// ⚠️ When the editor's backend dies, the pipes it read lose their reader, and the next write raises
// EPIPE. Unhandled, that killed the CLI inside `cancel`'s first log line — before the browser, the
// dev server and the partial output were dealt with (review of #1488 observed it). A reader that is
// gone is the same signal as stdin closing: cancel, quietly.
// Not once the video is in place: from the rename on, the rest of the run is bookkeeping, and a
// cancel there would delete a finished render (review of #1488 simulated it).
const onOutputGone = () => { if (outputGone) return; outputGone = true; if (!finished) void cancel('output closed'); };
/** Set once the finished video has been renamed into place — nothing may cancel it after that. */
let finished = false;
process.stdout.on('error', onOutputGone);
process.stderr.on('error', onOutputGone);

process.env.MODOKI_TOOLCHAIN_DIR ??= defaultToolchainDir();
const [takeMod, renderOptionsMod, ffmpegMod, prefsKeyMod, takeAssetsMod] = await loadRequiredEngineModules(REPO_ROOT, [
  path.join('packages', 'modoki', 'src', 'editor', 'recorder', 'take.ts'),
  path.join('packages', 'modoki', 'src', 'editor', 'recorder', 'renderOptions.ts'),
  path.join('plugins', 'ffmpeg-tool.ts'),
  path.join('packages', 'modoki', 'src', 'runtime', 'storage', 'prefsKey.ts'),
  path.join('plugins', 'takeAssets.ts'),
], 'record-take.mjs');

// ⚠️ 30 is a FLOOR, not a default: `timeSystem` clamps every frame's delta to 1/30 s (so a GC pause
// cannot teleport the sim), and a step longer than that would advance the sim by less than a video
// frame — 24 fps would play the game at 0.8x and never reach the last fifth of the take. The bounds
// are `renderOptions.ts`'s, the same ones the editor's render dialog enforces.
const { RENDER_FPS_MIN, RENDER_FPS_MAX, RENDER_SCALE_MAX } = renderOptionsMod;
if (!(opts.fps >= RENDER_FPS_MIN && opts.fps <= RENDER_FPS_MAX)) fail(`--fps must be in [${RENDER_FPS_MIN}, ${RENDER_FPS_MAX}] (got ${opts.fps}) — the engine clamps a frame to 1/30 s`);
if (!(opts.scale > 0 && opts.scale <= RENDER_SCALE_MAX)) fail(`--scale must be in (0, ${RENDER_SCALE_MAX}] (got ${opts.scale})`);

const takePath = path.resolve(positional[0]);
const take = takeMod.parseTake(JSON.parse(fs.readFileSync(takePath, 'utf8')));
const project = opts.project ?? findProject(take.game);
const takeStem = path.basename(takePath).replace(/\.take\.json$|\.json$/, '');
const outDir = path.join(path.resolve(opts.out ?? path.dirname(takePath)), takeStem);
const framesDir = path.join(outDir, 'frames');
const ext = opts.prores ? 'mov' : 'mp4';
const video = path.join(outDir, `${takeStem}.${ext}`);
// Encoded here, renamed to `video` only once the encode succeeded (see the header).
const videoPartial = path.join(outDir, `${takeStem}.rendering.${ext}`);
// A cancel deletes the whole folder only when this run made it — an existing one may hold an
// earlier render's deliverables.
const createdOutDir = !fs.existsSync(outDir);
fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });
const total = takeMod.frameCountFor(take, opts.fps);
// The editor's render dialog shows this same arithmetic before the render starts.
const size = renderOptionsMod.outputSize(take.viewport, opts.scale, opts.prores ? 'mov' : 'mp4');
emit({ stage: 'start', total, size, fps: opts.fps, video, takeSeconds: take.duration });

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

/** The dev server this run spawned, from the moment it is spawned. */
let devChild = null;
function stopDevChild() { if (devChild && devChild.exitCode === null && devChild.signalCode === null) devChild.kill('SIGTERM'); }
// A backstop for any exit that skipped `cancel` (an uncaught error): the dev server is not detached,
// but it is not in a group anyone else signals either, and an idle Vite never writes to find out.
process.on('exit', stopDevChild);

/** Start `vite` for the project and resolve with its base URL once it says it is listening. */
async function startDevServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [
    path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config', path.join('engine', 'vite.config.ts'), '--port', String(port), '--strictPort',
  ], { cwd: REPO_ROOT, env: { ...process.env, MODOKI_PROJECT: project }, stdio: ['ignore', 'pipe', 'pipe'] });
  // Held from the spawn, not from "ready": a cancel during the start must stop it too.
  devChild = child;
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

// ── cancel ──────────────────────────────────────────────────────────────────────────────────────
// Everything a cancel must stop, as the run creates it. See the header for why the script, not the
// parent, has to do this.
let server = null;
let browser = null;
let encoder = null;
let encodeStarted = false;
let cancelling = false;
/** The render + encode, once started — a cancel waits for it to unwind (see `cancel`). */
let run = null;

/** Thrown at the points where a cancel may have landed during an await that created something
 *  (the dev server, the browser), so `render`'s `finally` tears that down too. */
function checkCancelled() { if (cancelling) throw new Error('cancelled'); }

/** Stop everything this run started, delete its partial output, and exit. Idempotent: a second
 *  signal while the first cancel is still closing the browser does nothing.
 *
 *  It closes what exists NOW, then waits for the run to unwind: a cancel that lands while
 *  `chromium.launch` or the dev server's start is still pending has nothing to close yet, and the
 *  run's own `checkCancelled` + `finally` close it once it exists. Bounded, so a wedged run cannot
 *  keep a cancelled render alive. */
async function cancel(signal) {
  if (cancelling) return;
  cancelling = true;
  say(`${TAG} cancelled (${signal}) — stopping the browser and the dev server`);
  try { encoder?.kill('SIGKILL'); } catch { /* gone */ }
  try { await browser?.close(); } catch { /* already gone */ }
  server?.stop();
  stopDevChild();
  if (run) await Promise.race([run.catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
  if (createdOutDir) {
    fs.rmSync(outDir, { recursive: true, force: true });
  } else {
    fs.rmSync(framesDir, { recursive: true, force: true });
    if (encodeStarted) fs.rmSync(videoPartial, { force: true });
  }
  emit({ stage: 'cancelled' });
  exitAfterFlush(signal === 'SIGINT' ? 130 : 143);
}
process.on('SIGTERM', () => { void cancel('SIGTERM'); });
process.on('SIGINT', () => { void cancel('SIGINT'); });
if (opts.watchStdin) {
  // The editor's backend holds stdin open for the render's lifetime. EOF means it went away — an
  // editor that quit or crashed — and a render nobody can see or cancel must not run on.
  process.stdin.on('end', () => { if (!finished) void cancel('stdin closed'); });
  process.stdin.on('error', () => { if (!finished) void cancel('stdin closed'); });
  process.stdin.resume();
}

// ── render ──────────────────────────────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

/** Replay the take and screenshot every frame. Returns the render report. */
async function render() {
  try {
    emit({ stage: 'server' });
    server = opts.url ? { url: opts.url, stop: () => {} } : await startDevServer();
    checkCancelled();
    // `--enable-gpu`: without it the headless shell renders WebGL on SwiftShader, a CPU rasteriser —
    // correct but several times slower per frame. WebGPU has no adapter in headless Chromium on a Mac
    // either way; the engine falls back to WebGL.
    // `handleSIG*: false`: Playwright's own handlers would close the browser and exit on a signal
    // before `cancel` could stop the dev server and delete the partial output.
    browser = await chromium.launch({
      headless: true, args: ['--enable-gpu', '--enable-unsafe-webgpu'],
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    });
    checkCancelled();
    emit({ stage: 'boot' });
    // A page that reloads during boot is thrown away with its context and booted again (#1518) —
    // `recordTakeBoot.mjs` has the policy and why a fresh context rather than the same page.
    const { value: booted, reloads: bootReloads } = await bootWithReloadRetry(bootAttempt, {
      discard: async (outcome) => { try { await outcome.context?.close(); } catch { /* browser gone */ } },
      onReload: (n) => say(`${TAG} the game page reloaded during boot (attempt ${n}) — booting again in a fresh context. `
        + 'On a cold dependency cache this is Vite re-optimising (#1520).'),
    });
    const { page, pageErrors, navigations, root } = booted;
    let { state } = booted;
    checkCancelled();
    const loaded = state.scene.split('/').pop();
    if (loaded !== take.scene) {
      throw new Error(`the game booted scene "${loaded}", but the take was played in "${take.scene}" `
        + '(an unknown ?scene= falls back to the default) — the replay would not match the take');
    }
    const bootSteps = state.steps;
    // The scene the take starts in. Read HERE, not after the loop: by then `state.scene` is wherever
    // the take ended, and a level change makes that another scene (#1509 review).
    const bootScene = state.scene;
    // From here a reload is fatal: the take's frames are being stepped in the page it would replace.
    const reloadedMidTake = (e) => (pageReloaded(navigations(), e)
      ? new Error(`the game page reloaded mid-take, after ${state.steps - bootSteps} frame(s) — the render cannot continue in a new page (${e.message})`)
      : e);

    if (Math.abs(root.width - take.viewport.width) > 1 || Math.abs(root.height - take.viewport.height) > 1) {
      console.warn(`${TAG} ⚠️ the game root laid out at ${root.width}x${root.height}, the take was played at `
        + `${take.viewport.width}x${take.viewport.height} — pointer positions will not line up`);
    }
    const at = (ev) => [root.left + ev.x * root.scale, root.top + ev.y * root.scale];

    const cursor = new takeMod.TakeCursor(take.events);
    const started = Date.now();
    for (let f = 0; f < total; f++) {
      checkCancelled();
      // Events due by NOW go in before the step that processes them — the live run queued them the
      // same way, one frame ahead of the sample that read them.
      for (const ev of cursor.due(state.takeTime)) {
        await page.mouse.move(...at(ev));
        if (ev.kind === 'down') await page.mouse.down();
        else if (ev.kind === 'up') await page.mouse.up();
      }
      // A reload that committed between two steps throws nothing — the next `step` would run in a
      // fresh, un-booted document. Refuse it before stepping.
      if (navigations() > 1) throw reloadedMidTake(new Error('the main frame navigated'));
      state = await page.evaluate(() => window.__modokiCapture.step(1)).catch((e) => { throw reloadedMidTake(e); });
      await page.clock.setFixedTime(take.epochMs + Math.round(state.takeTime * 1000));
      await page.screenshot({ path: path.join(framesDir, `${String(f).padStart(6, '0')}.png`) });
      emit({ stage: 'frames', frame: f + 1, total });
      if (!opts.ndjson && f % 60 === 59) process.stdout.write(`${TAG} ${f + 1}/${total} frames\r`);
    }
    if (!opts.ndjson) process.stdout.write('\n');

    // Step s drew video frame s - bootSteps. The timeline starts at frame 0, but the replay check
    // covers the boot steps too — `replayEvents` says why (#1524).
    const allEvents = await page.evaluate(() => window.__modokiCapture.events());
    // `?.()`: a `--url` server with an older capture driver has no such call, and a render whose
    // frames are done must not fail on the check — it compares without the skip instead.
    const appLifetime = await page.evaluate(() => window.__modokiCapture.appLifetimeTypes?.() ?? []);
    // `ForTake`: whether the take's events carry app-lifetime marks is read off the take (#1527).
    const { timeline: events, replay } = takeMod.replayEventsForTake(take, allEvents, bootSteps, opts.fps, appLifetime);
    // One entry per give-up of the settle gate. From its frame on, frames may lack that content — a
    // give-up during boot (videoFrame 0, `duringBoot`) means the whole video may.
    const unsettled = (await page.evaluate(() => window.__modokiCapture.unsettled()))
      .map((u) => ({ videoFrame: Math.max(0, u.step - bootSteps), duringBoot: u.step < bootSteps, pending: u.pending }));
    const stillGivenUp = await page.evaluate(() => window.__modokiCapture.givenUp());
    const gameEvents = events.filter((e) => e.type !== '@audio');
    // The render used the project's assets as they are NOW — on purpose, so an art change is a
    // re-render (#1509). Name the ones this take uses that changed since it was recorded: the
    // scene it booted plus every scene loaded or swapped to, followed through their GUID references.
    // Never throws: a failure reads `unchecked` rather than failing a render whose frames are done.
    const assets = await takeAssetsMod.checkTakeAssets(path.resolve(REPO_ROOT, project), take.assets,
      takeAssetsMod.takeSceneUrls(bootScene, allEvents));
    return {
      take: path.relative(outDir, takePath), scene: loaded, frames: total, fps: opts.fps, size,
      takeSeconds: state.takeTime, renderSeconds: (Date.now() - started) / 1000,
      undispatchedEvents: cursor.remaining,
      settleSeconds: state.settleMs / 1000,
      // Each time the settle gate gave up and drew anyway — every frame from `videoFrame` on may be
      // missing that content — and what it had still given up on when the render ended.
      unsettled,
      stillGivenUp,
      // Did the replay do what the owner played? The game's own events, in order, against the ones the
      // editor recorded while the take was played (#1488). Timing is not compared: pointer input is
      // quantised to the video's frame rate.
      replay,
      // The take's assets that changed between recording and this render (#1509). A report, never
      // a refusal: the change is usually the art update the re-render is for.
      assets,
      // Phase 2's audio track is built from these: every sound the game played, on the video frame
      // whose step played it.
      audio: events.filter((e) => e.type === '@audio'),
      // Everything else kept from the journal — the game's own events, cues, scene loads.
      gameEvents,
      // Only the page the frames came from: a discarded boot attempt's errors (a module fetch the
      // reload cut off) are not this render's.
      pageErrors,
      // Boot attempts thrown away because the page reloaded under them (#1518). Non-zero on the first
      // render after a dependency change, until #1520 stops Vite from reloading.
      bootReloads,
    };
  } finally {
    // Each in its own guard, so a browser that fails to close still lets the dev server go.
    try { await browser?.close(); } catch { /* already gone */ }
    server?.stop();
  }
}

/** One boot, from a fresh browser context to the game on screen (#1518). Resolves the page and its
 *  final boot state, or the error — with whether the page reloaded first, which decides whether
 *  `bootWithReloadRetry` tries again. A fresh CONTEXT each time, so no attempt inherits another's
 *  `localStorage`. */
async function bootAttempt() {
  checkCancelled();
  const pageErrors = [];
  let context = null;
  // Main-frame navigations, for `pageReloaded` — which says why the error text matters more.
  let navigations = 0;
  try {
    context = await browser.newContext({
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
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++; });
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
    // timed frame into a boot step. The loop stops with the take clock still at 0. The deadline is per
    // attempt: a boot after a reload starts over, and may be the cold one.
    const bootDeadline = Date.now() + 60_000;
    let state = await page.evaluate(() => window.__modokiCapture.state());
    while (!state.ready) {
      if (Date.now() > bootDeadline) throw new Error(`game did not finish loading: ${JSON.stringify(state)}`);
      checkCancelled();
      state = await page.evaluate(() => window.__modokiCapture.bootStep());
      await page.waitForTimeout(5);
    }
    if (state.takeTime !== 0) throw new Error(`the take clock ran during boot (${state.takeTime}s) — frames would be off by that much`);

    // Where the game root sits in THIS page, so a layout point lands on the same thing it did in the
    // editor. Measured inside the attempt: it is the last evaluate before the take's first frame, and
    // a reload that lands on it is as safe to retry as one during `bootStep` (review of #1518).
    const root = await page.evaluate(() => {
      const el = document.querySelector('[data-modoki-ui-root="runtime"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, scale: el.offsetWidth ? r.width / el.offsetWidth : 1, width: el.offsetWidth, height: el.offsetHeight };
    });
    if (!root) throw new Error('no [data-modoki-ui-root="runtime"] on the game page — nothing to aim the take at');
    return { reloaded: pageReloaded(navigations), context, value: { page, pageErrors, state, root, navigations: () => navigations } };
  } catch (error) {
    return { reloaded: failedAttemptReloaded({ navigations, error, cancelling }), context, error };
  }
}

// ── encode ──────────────────────────────────────────────────────────────────────────────────────
/** Encode `frames/` into the video. Async (not `execFileSync`) so a cancel can kill it: a blocked
 *  event loop never runs the SIGTERM handler. `-progress pipe:1` reports the frame being encoded. */
function encode() {
  // Chroma subsampling needs even dimensions — both for 4:2:0 H.264, the width for 4:2:2 ProRes — so an
  // odd one is padded by a pixel rather than failing the encode (a 375×667 preset at ×1 did).
  const codec = opts.prores
    ? ['-vf', 'pad=ceil(iw/2)*2:ih', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le']
    : ['-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  emit({ stage: 'encode', frame: 0, total });
  encodeStarted = true;
  return new Promise((resolve, reject) => {
    encoder = spawn(ffmpegMod.ensureFfmpeg(), [
      '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-framerate', String(opts.fps),
      '-i', path.join(framesDir, '%06d.png'), ...codec, videoPartial,
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    encoder.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = /^frame=(\d+)/.exec(line);
        if (m) emit({ stage: 'encode', frame: Math.min(Number(m[1]), total), total });
      }
    });
    encoder.once('error', reject);
    encoder.once('close', (code, signal) => {
      encoder = null;
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${signal ?? `exit ${code}`})`));
    });
  });
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const report = await render();
  checkCancelled();
  await encode();
  // A cancel can land after ffmpeg exited 0 but before its 'close' — too late for its kill. It
  // must not then replace the previous video.
  checkCancelled();
  fs.renameSync(videoPartial, video);
  finished = true;
  if (!opts.keepFrames) fs.rmSync(framesDir, { recursive: true, force: true });
  // The take is NOT copied in: it embeds the save it was played from (progress, purchases, a signed-in
  // account), and this folder holds deliverables that get shared. `render.json` names it by path.
  const reportFile = path.join(outDir, 'render.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  say(`${TAG} ${report.frames} frames at ${report.fps} fps, ${report.size.width}x${report.size.height} → ${video}`);
  if (report.undispatchedEvents) console.warn(`${TAG} ⚠️ ${report.undispatchedEvents} input event(s) fell after the last frame`);
  for (const u of report.unsettled) {
    console.warn(`${TAG} ⚠️ gave up waiting ${u.duringBoot ? 'during boot' : `at frame ${u.videoFrame}`} for ${u.pending.join(', ')}`
      + ' — frames from there on may be missing it (render.json: unsettled)');
  }
  if (report.pageErrors.length) console.warn(`${TAG} ⚠️ ${report.pageErrors.length} page error(s) — see render.json`);
  if (report.replay.status === 'diverged' || report.replay.status === 'differs') {
    console.warn(`${TAG} ⚠️ the replay ${report.replay.status === 'diverged' ? 'DIVERGED from' : 'differs in detail from'} the take — `
      + [...report.replay.counts.map((c) => `"${c.type}" ${c.played}x played, ${c.replayed}x replayed`),
        ...report.replay.details.map((d) => `"${d.type}" ${d.fields.map((f) => f.path).join(', ')}`)].join('; ')
      + ' (render.json: replay)');
  }
  if (report.assets.status === 'changed') {
    console.warn(`${TAG} ⚠️ ${report.assets.changed.length + report.assets.added.length} asset(s) this take uses changed since it was recorded — `
      + 'the video shows them as they are now: '
      + [...report.assets.changed, ...report.assets.added.map((a) => `${a} (new)`)].slice(0, 8).join(', ')
      + ' (render.json: assets)');
  }
  // What the editor's progress card shows — the full lists stay in render.json.
  emit({
    stage: 'done', video, reportFile, size: report.size, frames: report.frames, fps: report.fps,
    renderSeconds: report.renderSeconds, undispatchedEvents: report.undispatchedEvents,
    unsettled: report.unsettled, pageErrors: report.pageErrors.length, pageErrorSample: report.pageErrors.slice(0, 3),
    replay: report.replay,
    assets: report.assets,
  });
}

run = main();
// Stop reading stdin once the render is done: the watch keeps the event loop alive, and the parent
// holds stdin open until this process exits — without this, a finished render never exits.
run.then(() => { if (opts.watchStdin) process.stdin.destroy(); }, () => {});
run.catch((err) => {
  // A cancel closes the browser under a step in flight, which throws here — `cancel` owns the exit.
  if (cancelling) return;
  // A failed encode (disk full, codec error) must not leave a truncated video beside a good one.
  if (encodeStarted) fs.rmSync(videoPartial, { force: true });
  const message = err instanceof Error ? err.message : String(err);
  emit({ stage: 'error', message });
  console.error(`${TAG} ${message}`);
  exitAfterFlush(1);
});
