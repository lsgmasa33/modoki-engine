#!/usr/bin/env node
/**
 * Assert an ALREADY-BUILT packaged .app applies its PROD Content-Security-Policy
 * correctly — the CSP analog of assert-app-renders.sh (render gate). Does NOT
 * build; point it at the .app you want to gate (so release.yml can check the
 * signed artifact it just produced, and smoke-packaged.sh can chain it after its
 * render assertions on the app it built).
 *
 * WHY a dedicated gate: the prod CSP is applied ONLY in the packaged app
 * (app.isPackaged) — dev sets none — so a wrong policy ships silently and only
 * breaks a real install. The render gate can't see it (a CSP-blocked CDN script
 * doesn't blank the editor). Concrete regression this guards: `script-src` once
 * lacked `https:`, CSP-blocking MediaPipe's GenAI wasm loader `<script>` (chess /
 * llm-test on-device LLM, from jsdelivr) → "Resource load error:
 * genai_wasm_internal.js" and the game never loaded. Its static twin is
 * engine/tests/electron/cspContract.test.ts (asserts the source policy); THIS
 * asserts the SHIPPED binary actually enforces it — the layer that would have
 * caught DMG 0.2.0, whose binary predated the source fix.
 *
 * Method (needs CDP — a script-injection probe is the faithful check): boot the
 * binary with --remote-debugging-port, wait for the renderer, then FROM the page
 *   B1. inject MediaPipe's real CDN wasm-loader <script> → must LOAD, no CSP violation
 *   B2. inject a bare http: <script> → must be BLOCKED (proves the policy is present
 *       + enforced, not merely absent — a missing CSP would pass B1 but fail B2)
 *
 *   node engine/scripts/assert-app-csp.mjs <app-path> [project-dir]
 * Exit 0 = CSP correct; non-zero = a shipped-CSP regression (details printed).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { binInAppDir, killPackaged } from './packagedAppPaths.mjs';
import { clonePort } from './clonePort.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = process.argv[2];
if (!app) { console.error('usage: assert-app-csp.mjs <app-path> [project-dir]'); process.exit(1); }
const PROJECT = path.resolve(process.argv[3] ?? path.join(REPO, 'games/3d-test'));
const BOOT_TIMEOUT_MS = 120_000;

// This leg used to spawn the app with NO backend port pinned, so it took main.ts's
// sticky-then-scan path and bound whatever was free — measured: **5179**, i.e. the MAIN
// clone's editor port (and its dev server landed on 5173, likewise the main clone's).
// Two consequences, both bad and neither loud:
//   1. A throwaway smoke app squats the port an agent's `MODOKI_BACKEND` points at, so a
//      `modoki_*` call aimed at the main clone's editor can hit THIS app instead — the
//      exact silent cross-clone failure the root CLAUDE.md's "which editor is this?"
//      gotcha is about, and the reason every other harness here derives a per-clone port.
//   2. It confounds #68: the leg's environment depended on whether a sibling clone
//      happened to hold 5179, which is not something a flake hunt should have to guess at.
// So pin it, per clone, like smoke-packaged.sh's render leg already does. A DIFFERENT
// block from that leg's 38600-38799 on purpose — the two legs run seconds apart against
// the same clone, and reusing one block would hand the CSP boot the port a just-killed
// render instance may still be releasing. A pinned port also makes main.ts take its
// fail-loud path (E6) if it IS taken, which is what we want here: loud beats silent.
const BACKEND_PORT = Number(process.env.CSP_BACKEND_PORT) || clonePort(REPO, 38800, 200);

// `app` is the unpacked app dir — a `.app` bundle on macOS, `win-unpacked` on Windows —
// so the executable inside it is resolved per-platform (packagedAppPaths.mjs), not by
// assuming the mac `Contents/MacOS/<name>` layout.
const bin = binInAppDir(app);
if (!existsSync(bin)) { console.error(`[csp] FAIL: no executable at ${bin}`); process.exit(1); }

let failed = false;
const log = (...a) => console.log('[csp]', ...a);
const fail = (msg) => { console.error('[csp] FAIL:', msg); failed = true; };

/** A free loopback TCP port, so the CDP endpoint can't collide with a leftover. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// The packaged app force-opens Chromium's CDP port ITSELF (engine/electron/cdp.ts),
// honoring MODOKI_CDP_PORT — and Chromium's --remote-debugging-port fails SILENTLY when
// the port is already taken. The render smoke that runs just before opens the app's
// default CDP (9222) and can leave it briefly held, so this smoke's app then can't bind
// it (and looked at a different port than the app actually opened). Fix: (1) kill any
// leftover app instance, (2) pick a guaranteed-free port, (3) tell the app that port via
// MODOKI_CDP_PORT — do NOT also pass --remote-debugging-port (the app appends it; a
// duplicate/mismatched flag was the bug).
killPackaged(app);
await new Promise((r) => setTimeout(r, 1500)); // let the OS release the old CDP port
const CDP_PORT = Number(process.env.CSP_CDP_PORT) || (await freePort());

const userData = mkdtempSync(path.join(tmpdir(), 'modoki-csp-ud-'));
const bootStart = Date.now();

// A clean-exit failure ("app exited early (code 0)") used to tell us NOTHING about why —
// stdio was only ever `inherit`ed, so once the run scrolled past there was no way to look
// back, and the app's OWN main.log (under this run's fresh --user-data-dir) was never even
// checked. Capture a rolling tail of the child's stdout/stderr here (still inherited live,
// so a human watching the terminal sees the same thing as before) and print it — plus the
// app's main.log tail and how long it survived — on ANY failure, so the next flake is
// diagnosable from this output alone, no re-run required.
const MAX_CAPTURED_LINES = 200;
const outputLines = [];
function capture(chunk) {
  for (const line of chunk.toString().split('\n')) {
    outputLines.push(line);
    if (outputLines.length > MAX_CAPTURED_LINES) outputLines.shift();
  }
}
const child = spawn(bin, [`--user-data-dir=${userData}`], {
  env: {
    ...process.env,
    MODOKI_NO_AUTOUPDATE: '1',
    MODOKI_PROJECT: PROJECT,
    MODOKI_CDP_PORT: String(CDP_PORT),
    MODOKI_BACKEND_PORT: String(BACKEND_PORT),   // per-clone — see the note above
    // Same reasoning, weaker stakes: unpinned, this leg's dev server took 5173 — the main
    // clone's editor PAGE port. MODOKI_VITE_PORT only seeds a PREFERENCE (findFreePort still
    // runs, main.ts:339), so this cannot fail the leg if the port is busy; it just stops a
    // throwaway smoke boot from sitting on a port a human's editor announces.
    MODOKI_VITE_PORT: String(BACKEND_PORT + 1),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => { process.stdout.write(d); capture(d); });
child.stderr.on('data', (d) => { process.stderr.write(d); capture(d); });
const cleanup = () => {
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  killPackaged(app);
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

/** Dump everything needed to diagnose a failure without a re-run: how long the app
 *  survived, its exit code/signal, its captured stdout/stderr tail, and the tail of its
 *  OWN main.log (fileLog.ts — `<userData>/logs/main.log`, findable because THIS run's
 *  --user-data-dir is a fresh, known dir). Called once, from the finally block, so
 *  multiple fail() calls in one run don't each reprint it. */
function dumpDiagnostics() {
  const survivedSec = ((Date.now() - bootStart) / 1000).toFixed(1);
  // The ports are part of the diagnosis, not decoration: #68's whole difficulty was that a
  // clean `code 0` said nothing about the environment the boot actually got.
  log(`diagnostics — survived ${survivedSec}s, exitCode=${child.exitCode}, signal=${child.signalCode}, backendPort=${BACKEND_PORT}, cdpPort=${CDP_PORT}`);
  if (outputLines.length) {
    log(`captured app stdout/stderr (last ${Math.min(50, outputLines.length)} of ${outputLines.length} lines):`);
    for (const l of outputLines.slice(-50)) console.error('    ' + l);
  } else {
    log('captured app stdout/stderr: (nothing captured)');
  }
  const mainLogPath = path.join(userData, 'logs', 'main.log');
  try {
    const tail = readFileSync(mainLogPath, 'utf8').split('\n').slice(-50);
    log(`tail of ${mainLogPath}:`);
    for (const l of tail) console.error('    ' + l);
  } catch (e) {
    log(`could not read ${mainLogPath}: ${e?.message ?? e}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function editorPage() {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    return targets.find((t) => t.type === 'page' && String(t.url).includes('/editor'));
  } catch { return null; }
}
function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } };
  const ready = new Promise((r) => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate threw');
    return r?.result?.value;
  };
  return { ready, send, evaluate, close: () => ws.close() };
}

try {
  log(`waiting for the editor page (up to ${BOOT_TIMEOUT_MS / 1000}s)…`);
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let page = null;
  while (Date.now() < deadline) {
    page = await editorPage();
    if (page?.webSocketDebuggerUrl) break;
    if (child.exitCode !== null) { fail(`app exited early (code ${child.exitCode})`); break; }
    await sleep(1000);
  }
  if (!page?.webSocketDebuggerUrl) {
    fail('editor page never appeared — cannot probe CSP');
  } else {
    const s = cdpSession(page.webSocketDebuggerUrl);
    await s.ready;
    await s.send('Runtime.enable');
    // Wait until the document is live enough to inject into (the render gate owns
    // the deeper mount assertion).
    const mountDeadline = Date.now() + 45_000;
    while (Date.now() < mountDeadline) {
      if (await s.evaluate(`!!document.getElementById('root')`)) break;
      await sleep(1000);
    }

    // The probe injects two scripts and awaits their load/error/timeout — a ~20s async op over CDP
    // plus a live CDN fetch. It occasionally comes back `undefined` (a transient CDP/serialization
    // hiccup on that long await), and JSON.parse(undefined) then throws — a FALSE failure. A real
    // CSP regression reproduces on every attempt; a flake does not. So retry a few times and only
    // fail on the verdict (or a persistently empty probe). A genuine network-down shows up as a
    // parseable TIMEOUT/ERRORED result, caught by the B1 check below — not as this retry.
    const probeExpr = `(async () => {
      const inject = (url) => new Promise((res) => {
        const violations = [];
        const onV = (e) => violations.push(e.violatedDirective);
        document.addEventListener('securitypolicyviolation', onV);
        const el = document.createElement('script');
        el.src = url;
        const done = (result) => { document.removeEventListener('securitypolicyviolation', onV); res({ result, violations }); };
        el.onload = () => done('LOADED');
        el.onerror = () => done('ERRORED');
        document.head.appendChild(el);
        setTimeout(() => done('TIMEOUT'), 10000);
      });
      const cdn = await inject('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai/wasm/genai_wasm_internal.js');
      const bad = await inject('http://example.com/blocked.js');
      return JSON.stringify({ cdn, bad });
    })()`;
    let csp = null;
    for (let attempt = 1; attempt <= 3 && !csp; attempt++) {
      const raw = await s.evaluate(probeExpr);
      if (typeof raw === 'string') { try { csp = JSON.parse(raw); } catch { /* non-JSON → retry */ } }
      if (!csp && attempt < 3) { log(`CSP probe returned no result (attempt ${attempt}/3) — transient CDP/network hiccup, retrying…`); await sleep(2000); }
    }
    if (!csp) {
      fail('CSP probe returned no parseable result after 3 attempts — the injection eval kept coming back empty (a CDP/network flake, NOT a CSP verdict). Re-run; if it persists, check network egress to the CDN.');
    } else {
      if (csp.cdn.result === 'LOADED' && csp.cdn.violations.length === 0) {
        log('PASS B1 — MediaPipe CDN wasm-loader script permitted by CSP');
      } else {
        fail(`B1 — MediaPipe CDN script was ${csp.cdn.result} (violations: ${csp.cdn.violations.join(',') || 'none'}). The prod CSP likely dropped https: from script-src.`);
      }
      if (csp.bad.violations.some((v) => v.startsWith('script-src'))) {
        log('PASS B2 — bare http: script blocked (CSP present + enforced)');
      } else {
        fail(`B2 — a bare http: script was NOT blocked (violations: ${csp.bad.violations.join(',') || 'none'}). The prod CSP may be absent entirely.`);
      }
    }
    s.close();
  }
} catch (e) {
  fail(String(e?.stack ?? e));
} finally {
  if (failed) dumpDiagnostics();
  cleanup();
  process.removeAllListeners('exit');
  if (failed) console.error('[csp] FAILED ❌');
  else console.log('[csp] PASS ✅');
  process.exit(failed ? 1 : 0);
}
